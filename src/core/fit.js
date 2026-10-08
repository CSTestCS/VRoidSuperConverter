// Shape one model to another: clothing refit (shrink-wrap with offset, tightness, smoothing,
// collision) + skin weight transfer, and proportion transfer between two humanoid models.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { meshesOf, skinnedMeshesOf, writeWeights } from './skinning.js';
import { HUMANOID_CHILD, VROID_BONES } from './vroidSkeleton.js';

export const DEFAULT_FIT_SETTINGS = {
  offset: 0.004,          // m between skin and cloth
  tightness: 0.5,         // 0 = only push out, 1 = shrink-wrap fully
  maxPullDistance: 0.05,  // vertices farther than this from the body are not pulled in (skirts, capes)
  pushOutOnly: false,
  smoothingIterations: 4,
  smoothingStrength: 0.6, // 0 keeps raw per-vertex displacement, 1 uses the smoothed field
  collisionPasses: 2,
  autoAlign: true,        // align bounding boxes before fitting
  scale: [1, 1, 1],
  translate: [0, 0, 0],
  rotateY: 0,             // degrees
  regionOffsets: { torso: 0, arms: 0, legs: 0, head: 0, feet: 0 }, // extra offset per body region (m)
  transferWeights: true,
  weightSmoothing: 2,
};

const REGION_OF = (name) => {
  if (/Head|Neck|Eye/.test(name)) return 'head';
  if (/Foot|Toe/.test(name)) return 'feet';
  if (/Leg/.test(name)) return 'legs';
  if (/Shoulder|Arm|Hand|Thumb|Index|Middle|Ring|Little/.test(name)) return 'arms';
  return 'torso';
};

/** Merge all meshes of a (rest pose) body into one world-space geometry with per-vertex skin data. */
export function buildBodyField(body) {
  body.updateMatrixWorld(true);
  const positions = [], normals = [], skinIndex = [], skinWeight = [], indices = [], boneNames = [];
  const boneIdx = new Map();
  let base = 0;
  for (const mesh of meshesOf(body)) {
    if (mesh.userData.isClothing) continue;
    const g = mesh.geometry;
    const pos = g.attributes.position, nor = g.attributes.normal;
    const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); positions.push(v.x, v.y, v.z);
      if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); normals.push(v.x, v.y, v.z); } else normals.push(0, 1, 0);
      for (let k = 0; k < 4; k++) {
        let bi = 0, w = 0;
        if (mesh.isSkinnedMesh) {
          const bone = mesh.skeleton.bones[g.attributes.skinIndex.getComponent(i, k)];
          w = g.attributes.skinWeight.getComponent(i, k);
          if (bone) {
            if (!boneIdx.has(bone)) { boneIdx.set(bone, boneNames.length); boneNames.push(bone); }
            bi = boneIdx.get(bone);
          }
        }
        skinIndex.push(bi); skinWeight.push(w);
      }
    }
    const n = g.index ? g.index.count : pos.count;
    for (let t = 0; t < n; t++) indices.push(base + (g.index ? g.index.getX(t) : t));
    base += pos.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  const bvh = new MeshBVH(geo);
  return { geo, bvh, skinIndex: Uint16Array.from(skinIndex), skinWeight: Float32Array.from(skinWeight), bones: boneNames };
}

const _tri = new THREE.Triangle();
const _bary = new THREE.Vector3();
/** Closest point on body with interpolated normal, skin weights and region. */
export function queryBody(field, p, maxDistance = Infinity) {
  const hit = field.bvh.closestPointToPoint(p, {}, 0, maxDistance);
  if (!hit || hit.distance > maxDistance) return null;
  const idx = field.geo.index;
  const pos = field.geo.attributes.position, nor = field.geo.attributes.normal;
  const a = idx.getX(hit.faceIndex * 3), b = idx.getX(hit.faceIndex * 3 + 1), c = idx.getX(hit.faceIndex * 3 + 2);
  _tri.setFromAttributeAndIndices(pos, a, b, c);
  _tri.getBarycoord(hit.point, _bary);
  const n = new THREE.Vector3()
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, a), _bary.x)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, b), _bary.y)
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, c), _bary.z);
  if (n.lengthSq() < 1e-12) _tri.getNormal(n); else n.normalize();
  const weights = new Map();
  [[a, _bary.x], [b, _bary.y], [c, _bary.z]].forEach(([v, f]) => {
    for (let k = 0; k < 4; k++) {
      const w = field.skinWeight[v * 4 + k] * f;
      if (w > 0) { const bi = field.skinIndex[v * 4 + k]; weights.set(bi, (weights.get(bi) ?? 0) + w); }
    }
  });
  let topBone = null, topW = -1;
  for (const [bi, w] of weights) if (w > topW) { topW = w; topBone = field.bones[bi]; }
  return { point: hit.point.clone(), normal: n, distance: hit.distance, weights, region: topBone ? REGION_OF(topBone.name) : 'torso' };
}

function adjacency(geo) {
  const pos = geo.attributes.position;
  const count = pos.count;
  const key = new Map();
  const rep = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    if (!key.has(k)) key.set(k, i);
    rep[i] = key.get(k);
  }
  const nbr = Array.from({ length: count }, () => []);
  const n = geo.index ? geo.index.count : count;
  const at = (t) => rep[geo.index ? geo.index.getX(t) : t];
  for (let t = 0; t + 2 < n; t += 3) {
    const a = at(t), b = at(t + 1), c = at(t + 2);
    nbr[a].push(b, c); nbr[b].push(a, c); nbr[c].push(a, b);
  }
  return { rep, nbr };
}

/**
 * Refit clothing meshes onto a body.
 * @param {THREE.Object3D} clothing  group with meshes (rigged or not)
 * @param {THREE.Object3D} body      VRoid model in rest pose
 * @param {Partial<typeof DEFAULT_FIT_SETTINGS>} settings
 * @returns {{meshes: THREE.SkinnedMesh[], stats: object}} new meshes in body space, skinned to the body skeleton if requested
 */
export function refitClothing(clothing, body, settings = {}) {
  const s = { ...DEFAULT_FIT_SETTINGS, ...settings, regionOffsets: { ...DEFAULT_FIT_SETTINGS.regionOffsets, ...(settings.regionOffsets ?? {}) } };
  const field = buildBodyField(body);
  clothing.updateMatrixWorld(true);

  // Pre-transform (manual adjustments + optional bounding-box alignment)
  const pre = new THREE.Matrix4();
  if (s.autoAlign) {
    const cb = new THREE.Box3().setFromObject(clothing), bb = new THREE.Box3().setFromObject(body);
    const cc = cb.getCenter(new THREE.Vector3()), bc = bb.getCenter(new THREE.Vector3());
    pre.makeTranslation(bc.x - cc.x, 0, bc.z - cc.z);
  }
  const user = new THREE.Matrix4().compose(new THREE.Vector3(...s.translate),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (s.rotateY * Math.PI) / 180), new THREE.Vector3(...s.scale));
  pre.premultiply(user);

  const out = [];
  let pushed = 0, pulled = 0, total = 0;
  for (const mesh of meshesOf(clothing)) {
    const geo = mesh.geometry.clone();
    for (const k of Object.keys(geo.attributes)) if (k === 'skinIndex' || k === 'skinWeight') geo.deleteAttribute(k);
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(pre, mesh.matrixWorld));
    const pos = geo.attributes.position;
    const count = pos.count;
    const disp = new Float32Array(count * 3);
    const hits = new Array(count);
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(pos, i);
      const h = queryBody(field, p);
      hits[i] = h;
      if (!h) continue;
      const signed = p.clone().sub(h.point).dot(h.normal);
      const target = s.offset + (s.regionOffsets[h.region] ?? 0);
      const goal = h.point.clone().addScaledVector(h.normal, target);
      let d = new THREE.Vector3();
      if (signed < target) { d = goal.sub(p); pushed++; }
      else if (!s.pushOutOnly && signed - target < s.maxPullDistance) {
        // full strength inside 75% of the pull range, fading out over the last quarter
        const fall = Math.min(1, (s.maxPullDistance - (signed - target)) / (0.25 * s.maxPullDistance));
        d = goal.sub(p).multiplyScalar(s.tightness * fall); pulled++;
      }
      disp.set([d.x, d.y, d.z], i * 3);
    }
    total += count;
    // Smooth the displacement field (keeps cloth detail, avoids jagged results)
    const { rep, nbr } = adjacency(geo);
    let field2 = disp;
    for (let it = 0; it < s.smoothingIterations; it++) {
      const next = new Float32Array(field2);
      for (let i = 0; i < count; i++) {
        if (rep[i] !== i || !nbr[i].length) continue;
        let x = 0, y = 0, z = 0;
        for (const j of nbr[i]) { x += field2[j * 3]; y += field2[j * 3 + 1]; z += field2[j * 3 + 2]; }
        const m = 1 / nbr[i].length;
        next[i * 3] = (field2[i * 3] + x * m) / 2; next[i * 3 + 1] = (field2[i * 3 + 1] + y * m) / 2; next[i * 3 + 2] = (field2[i * 3 + 2] + z * m) / 2;
      }
      for (let i = 0; i < count; i++) if (rep[i] !== i) next.set(next.subarray(rep[i] * 3, rep[i] * 3 + 3), i * 3);
      field2 = next;
    }
    for (let i = 0; i < count; i++) {
      const f = s.smoothingStrength;
      pos.setXYZ(i,
        pos.getX(i) + disp[i * 3] * (1 - f) + field2[i * 3] * f,
        pos.getY(i) + disp[i * 3 + 1] * (1 - f) + field2[i * 3 + 1] * f,
        pos.getZ(i) + disp[i * 3 + 2] * (1 - f) + field2[i * 3 + 2] * f);
    }
    // Collision passes: nothing may end up inside the body
    for (let pass = 0; pass < s.collisionPasses; pass++) {
      for (let i = 0; i < count; i++) {
        p.fromBufferAttribute(pos, i);
        const h = queryBody(field, p, 0.2);
        if (!h) continue;
        hits[i] = h;
        const target = s.offset + (s.regionOffsets[h.region] ?? 0);
        const signed = p.clone().sub(h.point).dot(h.normal);
        if (signed < target * 0.999) {
          const g = h.point.clone().addScaledVector(h.normal, target);
          pos.setXYZ(i, g.x, g.y, g.z);
        }
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    let result;
    if (s.transferWeights && field.bones.length) {
      const perVertex = hits.map((h) => h?.weights ?? new Map([[0, 1]]));
      for (let it = 0; it < s.weightSmoothing; it++) {
        const next = perVertex.map((m, i) => {
          if (rep[i] !== i) return m;
          const acc = new Map(m);
          for (const j of nbr[i]) for (const [b, w] of perVertex[j]) acc.set(b, (acc.get(b) ?? 0) + w / nbr[i].length);
          return acc;
        });
        for (let i = 0; i < count; i++) perVertex[i] = next[rep[i]];
      }
      const skeleton = skinnedMeshesOf(body)[0]?.skeleton;
      const idx = new Map(skeleton.bones.map((b, i) => [b, i]));
      const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const acc = new Map();
        for (const [bi, w] of perVertex[i]) { const si = idx.get(field.bones[bi]); if (si !== undefined) acc.set(si, (acc.get(si) ?? 0) + w); }
        writeWeights(acc, indices, weights, i);
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
      result = new THREE.SkinnedMesh(geo, mesh.material);
      result.userData.bindTo = skeleton;
    } else {
      result = new THREE.Mesh(geo, mesh.material);
    }
    result.name = mesh.name || 'Clothing';
    result.userData.isClothing = true;
    if (mesh.morphTargetDictionary) { result.morphTargetDictionary = { ...mesh.morphTargetDictionary }; result.morphTargetInfluences = [...mesh.morphTargetInfluences]; }
    out.push(result);
  }
  return { meshes: out, stats: { vertices: total, pushedOut: pushed, pulledIn: pulled } };
}

/** Attach refit meshes to a body (binds them to the body's skeleton). */
export function attachClothing(body, meshes) {
  body.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
  for (const m of meshes) {
    m.geometry.applyMatrix4(inv);
    body.add(m);
    m.updateMatrixWorld(true);
    if (m.isSkinnedMesh && m.userData.bindTo) { m.bind(m.userData.bindTo, m.matrixWorld.clone()); delete m.userData.bindTo; }
  }
}

// ----------------------------------------------------------------- proportions
function wpos(o) { return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); }

/** Average distance of strongly weighted vertices to each bone segment ("girth"). */
export function boneGirth(model) {
  model.updateMatrixWorld(true);
  const H = model.userData.humanoid;
  const sums = new Map();
  for (const mesh of skinnedMeshesOf(model)) {
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i += 3) {
      if (sw.getComponent(i, 0) < 0.6) continue;
      const bone = mesh.skeleton.bones[si.getComponent(i, 0)];
      const h = Object.keys(H).find((k) => H[k] === bone);
      if (!h || !H[HUMANOID_CHILD[h]]) continue;
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const a = wpos(bone), b = wpos(H[HUMANOID_CHILD[h]]);
      const line = new THREE.Line3(a, b);
      const d = line.closestPointToPoint(v, true, new THREE.Vector3()).distanceTo(v);
      const s = sums.get(h) ?? [0, 0];
      s[0] += d; s[1]++;
      sums.set(h, s);
    }
  }
  return Object.fromEntries([...sums].map(([h, [d, n]]) => [h, d / n]));
}

/**
 * Make `model` adopt the proportions of `reference` (both VRoid-converted, rest pose).
 * Bone lengths (and optionally limb girth) are blended by `strength`; the mesh is deformed with
 * per-bone affine maps blended by skin weights, then re-bound.
 */
export function matchProportions(model, reference, { strength = 1, girth = 0, matchHeight = true } = {}) {
  model.updateMatrixWorld(true);
  reference.updateMatrixWorld(true);
  const A = model.userData.humanoid, B = reference.userData.humanoid;
  const newPos = new Map();
  const transforms = new Map();
  const gA = girth ? boneGirth(model) : {}, gB = girth ? boneGirth(reference) : {};
  const order = VROID_BONES.map((b) => b[0]).filter((h) => A[h]);
  for (const h of order) {
    const bone = A[h];
    const parentH = (() => { let p = bone.parent; while (p) { const k = order.find((x) => A[x] === p); if (k) return k; p = p.parent; } return null; })();
    const pa = wpos(bone);
    if (!parentH) {
      const target = pa.clone();
      if (matchHeight && B[h]) target.y = THREE.MathUtils.lerp(pa.y, wpos(B[h]).y, strength);
      newPos.set(h, target);
      continue;
    }
    const parentOld = wpos(A[parentH]);
    const seg = pa.clone().sub(parentOld);
    let len = seg.length();
    if (B[h] && B[parentH]) len = THREE.MathUtils.lerp(len, wpos(B[h]).distanceTo(wpos(B[parentH])), strength);
    newPos.set(h, newPos.get(parentH).clone().add(seg.normalize().multiplyScalar(len)));
  }
  // Per-bone affine: segment (a->b) maps onto (a'->b'), stretching along the axis, girth across it.
  for (const h of order) {
    const a = wpos(A[h]), a2 = newPos.get(h);
    const c = HUMANOID_CHILD[h];
    const T = new THREE.Matrix4().makeTranslation(-a.x, -a.y, -a.z);
    let S = new THREE.Matrix4();
    if (c && A[c] && newPos.has(c)) {
      const b = wpos(A[c]), b2 = newPos.get(c);
      const axis = b.clone().sub(a);
      const along = b2.distanceTo(a2) / Math.max(1e-9, axis.length());
      axis.normalize();
      const across = girth && gA[h] && gB[h] ? THREE.MathUtils.lerp(1, gB[h] / gA[h], girth * strength) : 1;
      // S = across*I + (along - across) * axis*axis^T
      const m = new THREE.Matrix3().set(
        across + (along - across) * axis.x * axis.x, (along - across) * axis.x * axis.y, (along - across) * axis.x * axis.z,
        (along - across) * axis.y * axis.x, across + (along - across) * axis.y * axis.y, (along - across) * axis.y * axis.z,
        (along - across) * axis.z * axis.x, (along - across) * axis.z * axis.y, across + (along - across) * axis.z * axis.z);
      // keep the direction change (if any) as a rotation
      const rot = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(axis, b2.clone().sub(a2).normalize()));
      S = rot.multiply(new THREE.Matrix4().setFromMatrix3(m));
    }
    transforms.set(A[h], new THREE.Matrix4().makeTranslation(a2.x, a2.y, a2.z).multiply(S).multiply(T));
  }
  // Non-humanoid bones follow their nearest humanoid ancestor rigidly
  const resolve = (bone) => { for (let p = bone; p; p = p.parent) if (transforms.has(p)) return transforms.get(p); return new THREE.Matrix4(); };
  for (const mesh of skinnedMeshesOf(model)) {
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const toWorld = mesh.matrixWorld, toLocal = mesh.matrixWorld.clone().invert();
    const v = new THREE.Vector3(), acc = new THREE.Vector3(), t = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toWorld);
      acc.set(0, 0, 0);
      let wsum = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        acc.addScaledVector(t.copy(v).applyMatrix4(resolve(mesh.skeleton.bones[si.getComponent(i, k)])), w);
        wsum += w;
      }
      if (wsum > 0) { acc.multiplyScalar(1 / wsum).applyMatrix4(toLocal); pos.setXYZ(i, acc.x, acc.y, acc.z); }
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }
  // Move bones (world rotation stays as is); extra bones follow their ancestor's transform
  const allBones = [];
  model.traverse((o) => { if (o.isBone) allBones.push(o); });
  const targetWorld = new Map(allBones.map((b) => [b, wpos(b).applyMatrix4(resolve(b))]));
  for (const h of order) targetWorld.set(A[h], newPos.get(h));
  for (const b of allBones) {
    const parentInv = b.parent.matrixWorld.clone().invert();
    b.position.copy(targetWorld.get(b)).applyMatrix4(parentInv);
    b.updateMatrixWorld(true);
  }
  for (const mesh of skinnedMeshesOf(model)) mesh.skeleton.calculateInverses();
}
