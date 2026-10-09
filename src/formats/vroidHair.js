// VRoid Studio hair custom items: decode brush-hair strands for preview, rebuild a hair item
// from an arbitrary hair mesh (using an existing hair item as the template), and set the parent
// bone of accessory items.
//
// Layout (reverse-engineered from VRoid Studio 2.14 exports; protobuf field numbers):
//   transferable.#3 payload
//     payload.#2  object store: #8 entries {#1 id, ...} (StrandCurve definitions, editor curves)
//     payload.#4  hair data
//       hairData.#1 hair joints (physics bones)
//       hairData.#2 hair store
//         store.#3  hair bone groups (physics groups referencing joints + strands)
//         store.#4  brush hair groups: {#1 group{#1 id, #3 parent bone, #4 params, #5 strands[], #6 {#1/#2 guide, #3 transform}}}
//           strand: {#1 id, #3 {#1 strandData{#1 id, #3 params, #4 control points[], #6, #7 name}}}
//           control point: {#1 position vec3, #2 orientation vec3, #3 vec2 (u, t along strand)}
// Positions are in the group's local space (transform #6.#3: position, rotation, scale) relative to
// the parent bone (J_Bip_C_Head) in Unity space (left-handed; X is mirrored relative to ours).
import * as THREE from 'three';
import { parseFields, encodeField, concat, textOf } from './vroidCustomItem.js';
import { meshesOf } from '../core/skinning.js';

const te = new TextEncoder();
const td = new TextDecoder();
const f32 = (b) => new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
const f32b = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };
const fieldsOf = (bytes, n) => parseFields(bytes).filter((f) => f.number === n).map((f) => f.value);
const first = (bytes, n) => fieldsOf(bytes, n)[0];
function vec(bytes, n) {
  const out = new Array(n).fill(0);
  if (!bytes) return out;
  for (const f of parseFields(bytes)) if (f.wire === 5 && f.number >= 1 && f.number <= n) out[f.number - 1] = f32(f.value);
  return out;
}
function encVec(values) {
  return concat(values.map((v, i) => (v === 0 ? new Uint8Array(0) : encodeField(i + 1, 5, f32b(v)))));
}
const msg = (fields) => concat(fields.map((f) => f.raw ?? encodeField(f.number, f.wire, f.value)));
const replaceFields = (bytes, number, newValues) => {
  const fs = parseFields(bytes);
  const out = [];
  let inserted = false;
  for (const f of fs) {
    if (f.number === number) { if (!inserted) { for (const v of newValues) out.push({ number, wire: 2, value: v }); inserted = true; } continue; }
    out.push(f);
  }
  if (!inserted) for (const v of newValues) out.push({ number, wire: 2, value: v });
  return msg(out);
};
const toUnity = (v) => new THREE.Vector3(-v.x, v.y, v.z);
const fromUnity = (a) => new THREE.Vector3(-a[0], a[1], a[2]);
const qFromUnity = (q) => new THREE.Quaternion(q[0], -q[1], -q[2], q[3]);

function hairEntry(item) {
  return item.order.find((n) => n.startsWith('v1customitem/transferables/'));
}

function locate(item) {
  const entry = hairEntry(item);
  if (!entry) throw new Error('No transferable in this item');
  const tf = item.files[entry];
  const payload = first(tf, 3);
  const hairData = payload && first(payload, 4);
  const store = hairData && first(hairData, 2);
  if (!store || !fieldsOf(store, 4).length) throw new Error('This item has no brush hair strands (not a hair item?)');
  return { entry, tf, payload, hairData, store };
}

/** Decode all strands to {groups:[{transform, strands:[{points:[{p,n,uv}]}]}]} (Unity head space). */
export function decodeHair(item) {
  const { store } = locate(item);
  const groups = [];
  for (const g of fieldsOf(store, 4)) {
    const gm = first(g, 1);
    const six = first(gm, 6);
    const T = six ? first(six, 3) : null;
    const transform = {
      position: vec(T && first(T, 1), 3),
      rotation: (() => { const r = vec(T && first(T, 2), 4); return T && first(T, 2) ? r : [0, 0, 0, 1]; })(),
      scale: T && first(T, 3) ? vec(first(T, 3), 3) : [1, 1, 1],
    };
    const bone = fieldsOf(gm, 3).map((v) => td.decode(v))[0] ?? 'J_Bip_C_Head';
    const strands = [];
    for (const s of fieldsOf(gm, 5)) for (const inner of fieldsOf(s, 3)) for (const sd of fieldsOf(inner, 1)) {
      const points = fieldsOf(sd, 4).map((cp) => ({ p: vec(first(cp, 1), 3), n: vec(first(cp, 2), 3), uv: vec(first(cp, 3), 2) }));
      if (points.length) strands.push({ points });
    }
    groups.push({ id: td.decode(first(gm, 1) ?? new Uint8Array()), bone, transform, strands });
  }
  return { groups };
}

/** Head-local (our space) points of every strand. */
export function hairStrandsHeadSpace(decoded) {
  const out = [];
  for (const g of decoded.groups) {
    const pos = new THREE.Vector3(...g.transform.position), rot = new THREE.Quaternion(...g.transform.rotation), sc = new THREE.Vector3(...g.transform.scale);
    const m = new THREE.Matrix4().compose(pos, rot, sc);
    for (const s of g.strands) out.push(s.points.map((cp) => fromUnity(new THREE.Vector3(...cp.p).applyMatrix4(m).toArray())));
  }
  return out;
}

/** Preview tubes for the strands, placed on a head bone (world matrix). */
export function hairPreview(decoded, headWorld = new THREE.Matrix4(), { radius = 0.004, color = 0xc08060 } = {}) {
  const group = new THREE.Group();
  group.name = 'VRoid hair preview';
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  for (const pts of hairStrandsHeadSpace(decoded)) {
    if (pts.length < 2) continue;
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => p.clone().applyMatrix4(headWorld)));
    group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(8, pts.length * 4), radius, 5, false), mat));
  }
  return group;
}

// ------------------------------------------------------------------ strand extraction from a mesh
function weldedTriangles(root) {
  root.updateMatrixWorld(true);
  const pos = [], tris = [];
  const key = new Map();
  const v = new THREE.Vector3();
  for (const m of meshesOf(root)) {
    const p = m.geometry.attributes.position, idx = m.geometry.index;
    const remap = new Int32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      if (m.isSkinnedMesh) m.getVertexPosition(i, v); else v.fromBufferAttribute(p, i);
      v.applyMatrix4(m.matrixWorld);
      const k = `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
      let id = key.get(k);
      if (id === undefined) { id = pos.length; key.set(k, id); pos.push(v.clone()); }
      remap[i] = id;
    }
    const n = idx ? idx.count : p.count;
    for (let t = 0; t + 2 < n; t += 3) tris.push([remap[idx ? idx.getX(t) : t], remap[idx ? idx.getX(t + 1) : t + 1], remap[idx ? idx.getX(t + 2) : t + 2]]);
  }
  return { pos, tris };
}

function components(pos, tris) {
  const parent = Int32Array.from(pos, (_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (const [a, b, c] of tris) { parent[find(b)] = find(a); parent[find(c)] = find(a); }
  const groups = new Map();
  pos.forEach((_, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  return [...groups.values()];
}

function resample(points, count) {
  if (points.length < 2) return points;
  const d = [0];
  for (let i = 1; i < points.length; i++) d.push(d[i - 1] + points[i].distanceTo(points[i - 1]));
  const total = d[d.length - 1] || 1;
  const out = [];
  for (let k = 0; k < count; k++) {
    const t = (k / (count - 1)) * total;
    let i = 1;
    while (i < d.length - 1 && d[i] < t) i++;
    const u = (t - d[i - 1]) / Math.max(1e-9, d[i] - d[i - 1]);
    out.push(points[i - 1].clone().lerp(points[i], Math.min(1, Math.max(0, u))));
  }
  return out;
}

/** Centre line of one strand-like component, ordered from the scalp (nearest the head centre) outwards. */
function componentCenterline(pos, ids, adjacency, headCenter, bins) {
  let root = ids[0];
  for (const i of ids) if (pos[i].distanceTo(headCenter) < pos[root].distanceTo(headCenter)) root = i;
  // geodesic distance from the root over mesh edges (Dijkstra, small graphs)
  const dist = new Map(ids.map((i) => [i, Infinity]));
  dist.set(root, 0);
  const queue = [root];
  while (queue.length) {
    let bi = 0;
    for (let k = 1; k < queue.length; k++) if (dist.get(queue[k]) < dist.get(queue[bi])) bi = k;
    const u = queue.splice(bi, 1)[0];
    for (const w of adjacency.get(u) ?? []) {
      const nd = dist.get(u) + pos[u].distanceTo(pos[w]);
      if (nd < dist.get(w)) { if (dist.get(w) === Infinity) queue.push(w); dist.set(w, nd); }
    }
  }
  const max = Math.max(...[...dist.values()].filter(Number.isFinite));
  if (!(max > 0)) return null;
  const sums = Array.from({ length: bins }, () => [new THREE.Vector3(), 0]);
  for (const i of ids) {
    const d = dist.get(i);
    if (!Number.isFinite(d)) continue;
    const b = Math.min(bins - 1, Math.floor((d / max) * bins));
    sums[b][0].add(pos[i]); sums[b][1]++;
  }
  return sums.filter(([, n]) => n > 0).map(([s, n]) => s.multiplyScalar(1 / n));
}

/**
 * Extract strand centre lines (world space) from a hair mesh.
 * Separate hair cards/strands become one strand each; a single solid hair mesh is combed into
 * `sectors` strands around the head.
 */
export function extractStrands(root, headCenter, { maxStrands = 120, pointsPerStrand = 10, sectors = 36, minLength = 0.02 } = {}) {
  const { pos, tris } = weldedTriangles(root);
  const adjacency = new Map();
  for (const [a, b, c] of tris) for (const [x, y] of [[a, b], [b, c], [c, a]]) {
    if (!adjacency.has(x)) adjacency.set(x, []);
    if (!adjacency.has(y)) adjacency.set(y, []);
    adjacency.get(x).push(y); adjacency.get(y).push(x);
  }
  const comps = components(pos, tris).filter((c) => c.length >= 6).sort((a, b) => b.length - a.length);
  let lines = [];
  if (comps.length >= 3) {
    for (const c of comps.slice(0, maxStrands)) {
      const cl = componentCenterline(pos, c, adjacency, headCenter, pointsPerStrand * 2);
      if (cl && cl.length >= 2) lines.push(cl);
    }
  } else {
    // Comb a solid hair shell: per azimuth sector, outer-shell centroid per height slice, top to bottom.
    const ids = comps.flat();
    let minY = Infinity, maxY = -Infinity;
    for (const i of ids) { minY = Math.min(minY, pos[i].y); maxY = Math.max(maxY, pos[i].y); }
    const slices = pointsPerStrand * 2;
    for (let s = 0; s < Math.min(sectors, maxStrands); s++) {
      const a0 = (s / sectors) * Math.PI * 2 - Math.PI, a1 = ((s + 1) / sectors) * Math.PI * 2 - Math.PI;
      const pts = [];
      for (let k = 0; k < slices; k++) {
        const y1 = maxY - ((maxY - minY) * k) / slices, y0 = maxY - ((maxY - minY) * (k + 1)) / slices;
        const inSlice = ids.filter((i) => {
          const p = pos[i];
          const a = Math.atan2(p.x - headCenter.x, p.z - headCenter.z);
          return p.y <= y1 && p.y >= y0 && a >= a0 && a < a1;
        });
        if (!inSlice.length) continue;
        const r = inSlice.map((i) => Math.hypot(pos[i].x - headCenter.x, pos[i].z - headCenter.z)).sort((x, y) => x - y);
        const cut = r[Math.floor(r.length * 0.6)];
        const outer = inSlice.filter((i) => Math.hypot(pos[i].x - headCenter.x, pos[i].z - headCenter.z) >= cut);
        const c = new THREE.Vector3();
        for (const i of outer) c.add(pos[i]);
        pts.push(c.multiplyScalar(1 / outer.length));
      }
      if (pts.length >= 2) lines.push(pts);
    }
  }
  lines = lines.map((l) => resample(l, pointsPerStrand)).filter((l) => l[0].distanceTo(l[l.length - 1]) >= minLength);
  return lines;
}

// ------------------------------------------------------------------ rebuild
const HEX = /[0-9a-f]{32}/g;
function randomHex(rnd) { let s = ''; for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(rnd() * 16)]; return s; }
function countIn(bytes, idBytes) {
  let n = 0;
  outer: for (let i = 0; i + idBytes.length <= bytes.length; i++) {
    for (let k = 0; k < idBytes.length; k++) if (bytes[i + k] !== idBytes[k]) continue outer;
    n++;
  }
  return n;
}
function replaceAll(bytes, from, to) {
  const f = te.encode(from), t = te.encode(to);
  let out = bytes;
  outer: for (let i = 0; i + f.length <= out.length; i++) {
    for (let k = 0; k < f.length; k++) if (out[i + k] !== f[k]) continue outer;
    if (out === bytes) out = bytes.slice();
    out.set(t, i);
    i += f.length - 1;
  }
  return out;
}

/**
 * Clone an object message with fresh IDs: IDs owned by the object (not referenced elsewhere in
 * `context`) are renamed; IDs of store entries (curves) get the entry cloned under a new ID.
 */
function cloneWithIds(bytes, context, entries, newEntries, rnd) {
  let out = bytes;
  const ids = new Set(td.decode(bytes).match(HEX) ?? []);
  for (const id of ids) {
    const idb = te.encode(id);
    if (entries.has(id)) {
      const nid = randomHex(rnd);
      newEntries.push(replaceAll(entries.get(id), id, nid));
      out = replaceAll(out, id, nid);
    } else if (countIn(context, idb) === countIn(bytes, idb)) {
      out = replaceAll(out, id, randomHex(rnd));
    }
  }
  return out;
}

/**
 * Rebuild a hair item from strand lines (world space) using an existing hair item as template.
 * @param {object} item  readCustomItem() result of a hair item (modified in place and returned)
 * @param {THREE.Vector3[][]} lines  strand centre lines in world space, root first
 * @param {THREE.Matrix4} headWorld  world matrix of the VRoid head bone (rest pose)
 * @param {{templateGroup?: number, strandsPerGroup?: number, seed?: number}} opts
 */
export function rebuildHairItem(item, lines, headWorld, opts = {}) {
  const rnd = (() => { let s = (opts.seed ?? 12345) >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();
  const { entry, tf, payload, hairData, store } = locate(item);
  const groups = fieldsOf(store, 4);
  const tIndex = Math.min(groups.length - 1, Math.max(0, opts.templateGroup ?? pickTemplateGroup(groups)));
  const templateGroup = groups[tIndex];
  const gm = first(templateGroup, 1);
  const templateStrand = fieldsOf(gm, 5)[0];
  if (!templateStrand) throw new Error('Template group has no strands');
  const six = first(gm, 6);
  const T = six ? first(six, 3) : null;
  const gPos = new THREE.Vector3(...vec(T && first(T, 1), 3));
  const gRot = T && first(T, 2) ? new THREE.Quaternion(...vec(first(T, 2), 4)) : new THREE.Quaternion();
  const gScale = T && first(T, 3) ? new THREE.Vector3(...vec(first(T, 3), 3)) : new THREE.Vector3(1, 1, 1);
  const toGroup = new THREE.Matrix4().compose(gPos, gRot, gScale).invert();
  const headInv = headWorld.clone().invert();
  const headCenterUnity = new THREE.Vector3(0, 0.1, 0);

  // Store entries (curves etc.) by id
  const entries = new Map();
  for (const e of fieldsOf(payload, 2).flatMap((p2) => fieldsOf(p2, 8))) {
    const id = textOf(parseFields(e)[0]);
    if (id) entries.set(id, e);
  }
  const p2 = first(payload, 2) ?? new Uint8Array();
  // ID ownership is decided without the physics data we are about to drop
  const context = concat([p2, ...groups]);
  const newEntries = [];

  const strandMsgs = lines.map((line, si) => {
    let s = cloneWithIds(templateStrand, context, entries, newEntries, rnd);
    const inner = first(s, 3), sd = first(inner, 1);
    const unityPts = line.map((p) => toUnity(p.clone().applyMatrix4(headInv)));
    let acc = 0;
    const lens = [0];
    for (let i = 1; i < unityPts.length; i++) { acc += unityPts[i].distanceTo(unityPts[i - 1]); lens.push(acc); }
    const cps = unityPts.map((p, i) => {
      const local = p.clone().applyMatrix4(toGroup);
      const n = p.clone().sub(headCenterUnity).normalize();
      const u = 0.5 + Math.atan2(p.x, p.z) / (2 * Math.PI);
      return concat([encodeField(1, 2, encVec(local.toArray())), encodeField(2, 2, encVec(n.toArray())), encodeField(3, 2, encVec([u, acc ? lens[i] / acc : 0]))]);
    });
    let newSd = replaceFields(sd, 4, cps);
    newSd = replaceFields(newSd, 7, [concat([encodeField(2, 2, encodeField(1, 2, te.encode(`Model.HairEditor.BrushHairStrandIndexed:${si + 1}`))), encodeField(4, 2, te.encode(`Brush Hair Strand ${si + 1}`))])]);
    s = replaceFields(s, 3, [replaceFields(inner, 1, [newSd])]);
    return s;
  });

  const per = Math.max(1, opts.strandsPerGroup ?? 16);
  const newGroups = [];
  for (let k = 0; k < strandMsgs.length; k += per) {
    let g = cloneWithIds(templateGroup, context, entries, newEntries, rnd);
    const ngm = first(g, 1);
    g = replaceFields(g, 1, [replaceFields(ngm, 5, strandMsgs.slice(k, k + per))]);
    newGroups.push(g);
  }

  // Hair physics (bone groups + joints) reference the old strands, so they are removed; add hair
  // bounce again in VRoid Studio's hair editor.
  const newStore = replaceFields(replaceFields(store, 4, newGroups), 3, []);
  const newHairData = replaceFields(replaceFields(hairData, 2, [newStore]), 1, [new Uint8Array(0)]);
  let newP2 = p2;
  if (newEntries.length) newP2 = concat([p2, ...newEntries.map((e) => encodeField(8, 2, e))]);
  let newPayload = replaceFields(payload, 4, [newHairData]);
  newPayload = replaceFields(newPayload, 2, [newP2]);
  item.files[entry] = replaceFields(tf, 3, [newPayload]);
  return { strands: strandMsgs.length, groups: newGroups.length, templateGroup: tIndex };
}

function pickTemplateGroup(groups) {
  // Prefer a group with an unscaled, upright transform and a medium strand count
  let best = 0, bestScore = -Infinity;
  groups.forEach((g, i) => {
    try {
      const gm = first(g, 1);
      const T = first(first(gm, 6), 3);
      const sc = T && first(T, 3) ? vec(first(T, 3), 3) : [1, 1, 1];
      const n = fieldsOf(gm, 5).length;
      const score = -Math.abs(sc[0] - 1) - Math.abs(sc[1] - 1) - Math.abs(sc[2] - 1) + Math.min(n, 4) * 0.1;
      if (score > bestScore) { bestScore = score; best = i; }
    } catch { /* skip */ }
  });
  return best;
}

// ------------------------------------------------------------------ accessories: parent bone
const BONE_RE = /^J_(Bip|Adj|Sec)_[A-Za-z0-9_]+$/;

/** Find accessory attachments: messages {#1 bone name, #2 {#1 pos, #2 rot, #3 scale}}. */
export function findAttachments(item) {
  const entry = hairEntry(item);
  const out = [];
  const walk = (bytes, path, depth) => {
    let fs;
    try { fs = parseFields(bytes); } catch { return; }
    const nameF = fs.find((f) => f.number === 1 && f.wire === 2);
    const name = nameF && textOf(nameF);
    if (name && BONE_RE.test(name)) {
      const t = fs.find((f) => f.number === 2 && f.wire === 2);
      if (t) {
        try {
          const position = vec(first(t.value, 1), 3);
          const rotation = first(t.value, 2) ? vec(first(t.value, 2), 4) : [0, 0, 0, 1];
          out.push({ path, bone: name, position, rotation });
          return;
        } catch { /* not a transform */ }
      }
    }
    if (depth > 12) return;
    fs.forEach((f, i) => { if (f.wire === 2 && f.value.length > 2 && textOf(f) === null) walk(f.value, [...path, i], depth + 1); });
  };
  if (entry) walk(item.files[entry], [], 0);
  return out.map((a) => ({ ...a, entry }));
}

function rewriteAt(bytes, path, fn) {
  const fs = parseFields(bytes);
  if (!path.length) return fn(bytes);
  const [i, ...rest] = path;
  return msg(fs.map((f, k) => (k === i ? { number: f.number, wire: 2, value: rewriteAt(f.value, rest, fn) } : f)));
}

/**
 * Re-parent an accessory to another VRoid bone. With `keepWorld`, the local offset is adjusted so
 * the accessory stays where it was (uses rest positions in our space: boneRest(name) -> Vector3).
 */
export function setAttachmentBone(item, newBone, { keepWorld = true, boneRest = null } = {}) {
  if (!BONE_RE.test(newBone)) throw new Error(`Not a VRoid bone name: ${newBone}`);
  const atts = findAttachments(item);
  if (!atts.length) throw new Error('No parent bone attachment found in this item');
  for (const a of atts.sort((x, y) => y.path.length - x.path.length)) {
    item.files[a.entry] = rewriteAt(item.files[a.entry], a.path, (bytes) => {
      const fs = parseFields(bytes);
      return msg(fs.map((f) => {
        if (f.number === 1 && f.wire === 2 && BONE_RE.test(textOf(f) ?? '')) return { number: 1, wire: 2, value: te.encode(newBone) };
        if (f.number === 2 && f.wire === 2 && keepWorld && boneRest) {
          const oldRest = boneRest(a.bone), newRest = boneRest(newBone);
          if (!oldRest || !newRest) return f;
          const delta = toUnity(oldRest.clone().sub(newRest));
          const pos = new THREE.Vector3(...a.position).add(delta);
          return { number: 2, wire: 2, value: replaceFields(f.value, 1, [encVec(pos.toArray())]) };
        }
        return f;
      }));
    });
  }
  return findAttachments(item);
}

export const VROID_ATTACH_BONES = ['J_Bip_C_Head', 'J_Bip_C_Neck', 'J_Bip_C_UpperChest', 'J_Bip_C_Chest', 'J_Bip_C_Spine', 'J_Bip_C_Hips',
  'J_Bip_L_Shoulder', 'J_Bip_L_UpperArm', 'J_Bip_L_LowerArm', 'J_Bip_L_Hand', 'J_Bip_R_Shoulder', 'J_Bip_R_UpperArm', 'J_Bip_R_LowerArm', 'J_Bip_R_Hand',
  'J_Bip_L_UpperLeg', 'J_Bip_L_LowerLeg', 'J_Bip_L_Foot', 'J_Bip_R_UpperLeg', 'J_Bip_R_LowerLeg', 'J_Bip_R_Foot', 'J_Adj_L_FaceEye', 'J_Adj_R_FaceEye'];

export { qFromUnity };
