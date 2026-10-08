// Automatic rigging of unrigged bipedal meshes: estimates joint positions from the mesh
// silhouette (horizontal slicing), builds a VRoid skeleton, and computes smooth skin
// weights (segment-distance envelopes + region constraints + Laplacian smoothing).
import * as THREE from 'three';
import { meshesOf } from './skinning.js';
import { convertToVRoid } from './retarget.js';

/** Dense, area-weighted surface samples (plus vertices) in world space, so slicing works on low-poly meshes. */
export function gatherSurfacePoints(root, target = 60000) {
  root.updateMatrixWorld(true);
  const tris = [];
  let total = 0;
  const pts = [];
  for (const m of meshesOf(root)) {
    const pos = m.geometry.attributes.position;
    const index = m.geometry.index;
    const v = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
    for (let i = 0; i < pos.count; i++) { const p = v(i); pts.push(p.x, p.y, p.z); }
    const n = index ? index.count : pos.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const a = v(index ? index.getX(t) : t), b = v(index ? index.getX(t + 1) : t + 1), c = v(index ? index.getX(t + 2) : t + 2);
      const area = b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
      if (area <= 0) continue;
      tris.push([a, b, c, area]);
      total += area;
    }
  }
  // deterministic stratified sampling
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [a, b, c, area] of tris) {
    const k = Math.floor((area / total) * target + rnd());
    for (let i = 0; i < k; i++) {
      let u = rnd(), w = rnd();
      if (u + w > 1) { u = 1 - u; w = 1 - w; }
      const p = a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), w);
      pts.push(p.x, p.y, p.z);
    }
  }
  return new Float32Array(pts);
}

function clusters(xs, gap) {
  if (!xs.length) return [];
  xs.sort((a, b) => a - b);
  const out = [[xs[0], xs[0], 1]];
  for (let i = 1; i < xs.length; i++) {
    const c = out[out.length - 1];
    if (xs[i] - c[1] > gap) out.push([xs[i], xs[i], 1]); else { c[1] = xs[i]; c[2]++; }
  }
  return out;
}

/**
 * Estimate humanoid joint world positions from a static mesh (Y up, facing +Z).
 * @returns {Record<string, THREE.Vector3>}
 */
export function estimateJoints(points, opts = {}) {
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, cz = 0;
  const n = points.length / 3;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1];
    minY = Math.min(minY, y); maxY = Math.max(maxY, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    cz += points[i * 3 + 2];
  }
  cz /= n;
  const H = maxY - minY;
  const cx = opts.centerX ?? 0;
  const BINS = 120;
  const bins = Array.from({ length: BINS }, () => []);
  for (let i = 0; i < n; i++) {
    const b = Math.min(BINS - 1, Math.floor(((points[i * 3 + 1] - minY) / H) * BINS));
    bins[b].push(i);
  }
  const yOf = (b) => minY + ((b + 0.5) / BINS) * H;
  const binOf = (y) => Math.max(0, Math.min(BINS - 1, Math.floor(((y - minY) / H) * BINS)));
  const gap = H * 0.012;
  const sliceClusters = (b) => clusters(bins[b].map((i) => points[i * 3]), gap);
  const central = (b) => sliceClusters(b).find((c) => c[0] <= cx + gap && c[1] >= cx - gap);

  // Crotch: highest slice in the lower 60% whose central gap separates the legs
  let crotchBin = Math.floor(BINS * 0.45);
  for (let b = Math.floor(BINS * 0.08); b < Math.floor(BINS * 0.62); b++) {
    const cs = sliceClusters(b).filter((c) => Math.abs((c[0] + c[1]) / 2 - cx) < H * 0.25);
    const hasGap = cs.length >= 2 && cs.some((c) => c[1] < cx) && cs.some((c) => c[0] > cx) && !cs.some((c) => c[0] < cx && c[1] > cx);
    if (hasGap) crotchBin = b;
  }
  const crotchY = yOf(crotchBin);

  // Neck: narrowest central slice between 75% and 93% height
  let neckBin = Math.floor(BINS * 0.85), best = Infinity;
  for (let b = Math.floor(BINS * 0.74); b < Math.floor(BINS * 0.93); b++) {
    const c = central(b);
    if (!c) continue;
    const w = c[1] - c[0];
    if (w < best) { best = w; neckBin = b; }
  }
  const neckY = yOf(neckBin);
  const shoulderY = neckY - H * 0.035;
  const chestBin = binOf(shoulderY - H * 0.08);
  const chestC = central(chestBin);
  const torsoHalf = chestC ? Math.min(Math.abs(chestC[1] - cx), Math.abs(cx - chestC[0])) : H * 0.1;
  const zAt = (y, filter = () => true) => {
    const idx = bins[binOf(y)].filter((i) => filter(points[i * 3]));
    if (!idx.length) return cz;
    let lo = Infinity, hi = -Infinity;
    for (const i of idx) { lo = Math.min(lo, points[i * 3 + 2]); hi = Math.max(hi, points[i * 3 + 2]); }
    return (lo + hi) / 2;
  };

  const J = {};
  J.hips = new THREE.Vector3(cx, crotchY + H * 0.055, zAt(crotchY + H * 0.055));
  J.neck = new THREE.Vector3(cx, neckY - H * 0.01, zAt(neckY, (x) => Math.abs(x - cx) < torsoHalf));
  J.head = new THREE.Vector3(cx, neckY + H * 0.025, zAt(neckY + H * 0.03, (x) => Math.abs(x - cx) < torsoHalf));
  const sp = (t) => J.hips.clone().lerp(J.neck, t);
  J.spine = sp(0.12); J.chest = sp(0.4); J.upperChest = sp(0.68);
  for (const k of ['spine', 'chest', 'upperChest']) J[k].z = zAt(J[k].y, (x) => Math.abs(x - cx) < torsoHalf);
  // head front for eyes
  let headFront = -Infinity;
  for (const i of bins[binOf(neckY + H * 0.07)]) if (Math.abs(points[i * 3] - cx) < torsoHalf) headFront = Math.max(headFront, points[i * 3 + 2]);
  if (!Number.isFinite(headFront)) headFront = J.head.z + H * 0.05;

  for (const side of ['left', 'right']) {
    const sgn = side === 'left' ? 1 : -1;
    const S = (k) => `${side}${k}`;
    // arm tip: most lateral vertex above the crotch
    let tip = null;
    for (let i = 0; i < n; i++) {
      const x = points[i * 3], y = points[i * 3 + 1];
      if (y < crotchY) continue;
      if (!tip || sgn * x > sgn * tip.x) tip = new THREE.Vector3(x, y, points[i * 3 + 2]);
    }
    J[S('Shoulder')] = new THREE.Vector3(cx + sgn * torsoHalf * 0.25, shoulderY, J.upperChest.z);
    J[S('UpperArm')] = new THREE.Vector3(cx + sgn * torsoHalf * 0.85, shoulderY, J.upperChest.z);
    const armDir = tip.clone().sub(J[S('UpperArm')]);
    const armLen = armDir.length();
    armDir.normalize();
    J[S('Hand')] = J[S('UpperArm')].clone().addScaledVector(armDir, armLen * 0.8);
    J[S('LowerArm')] = J[S('UpperArm')].clone().addScaledVector(armDir, armLen * 0.42);
    J[S('HandTip')] = tip;
    // legs: cluster centroid below the crotch
    const legX = (y) => {
      const cs = sliceClusters(binOf(y)).filter((c) => sgn * ((c[0] + c[1]) / 2 - cx) > 0 && Math.abs((c[0] + c[1]) / 2 - cx) < H * 0.25);
      if (!cs.length) return cx + sgn * torsoHalf * 0.5;
      const c = cs.sort((a, b) => b[2] - a[2])[0];
      return (c[0] + c[1]) / 2;
    };
    const ankleY = minY + H * 0.045;
    const hipX = legX(crotchY - H * 0.06);
    J[S('UpperLeg')] = new THREE.Vector3(hipX, crotchY + H * 0.015, J.hips.z);
    const footIdx = bins[binOf(minY + H * 0.01)].concat(bins[binOf(minY + H * 0.025)]).filter((i) => sgn * (points[i * 3] - cx) > 0);
    let fz0 = Infinity, fz1 = -Infinity, fx = 0;
    for (const i of footIdx) { fz0 = Math.min(fz0, points[i * 3 + 2]); fz1 = Math.max(fz1, points[i * 3 + 2]); fx += points[i * 3]; }
    if (!footIdx.length) { fz0 = J.hips.z - H * 0.03; fz1 = J.hips.z + H * 0.1; fx = hipX; } else fx /= footIdx.length;
    const footLen = fz1 - fz0;
    J[S('Foot')] = new THREE.Vector3(legX(ankleY + H * 0.02), ankleY, fz0 + footLen * 0.25);
    J[S('LowerLeg')] = J[S('UpperLeg')].clone().lerp(J[S('Foot')], 0.5);
    J[S('LowerLeg')].z += H * 0.005;
    J[S('Toes')] = new THREE.Vector3(fx, minY + H * 0.012, fz0 + footLen * 0.72);
    J[S('Eye')] = new THREE.Vector3(cx + sgn * H * 0.02, neckY + H * 0.07, headFront - H * 0.015);
  }
  J.headTop = new THREE.Vector3(cx, maxY, J.head.z);
  J._meta = { height: H, minY, crotchY, neckY, torsoHalf, aPose: (() => {
    const d = J.leftHandTip.clone().sub(J.leftUpperArm).normalize();
    return Math.asin(Math.max(-1, Math.min(1, -d.y))) * 180 / Math.PI;
  })() };
  return J;
}

const SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['neck', 'head'], ['head', 'headTop'],
  ['leftShoulder', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['leftHand', 'leftHandTip'],
  ['rightShoulder', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'], ['rightHand', 'rightHandTip'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['leftFoot', 'leftToes'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'], ['rightFoot', 'rightToes'],
];

function segDist(p, a, b) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(1e-12, ab.lengthSq())));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * Auto-rig a static model. Returns a VRoid-rigged group (same structure as convertToVRoid output).
 * @param {THREE.Object3D} source
 * @param {{smoothIterations?: number, falloff?: number, tPose?: boolean, targetHeight?: number|null, joints?: Record<string, THREE.Vector3>}} opts
 */
export function autoRig(source, opts = {}) {
  source.updateMatrixWorld(true);
  const pts = gatherSurfacePoints(source);
  const J = opts.joints ?? estimateJoints(pts);
  const H = J._meta.height;

  // Temporary rig built in the source's world space, then converted with convertToVRoid.
  const temp = new THREE.Group();
  temp.name = 'AutoRig';
  const order = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
  const parent = { spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', leftEye: 'head', rightEye: 'head',
    leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
    rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
    leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
    rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot' };
  const bones = {};
  for (const h of order) {
    const b = new THREE.Bone();
    b.name = h;
    const p = parent[h] ? bones[parent[h]] : null;
    b.position.copy(J[h]).sub(p ? J[parent[h]] : new THREE.Vector3());
    (p ?? temp).add(b);
    bones[h] = b;
  }
  temp.updateMatrixWorld(true);
  const boneList = order.map((h) => bones[h]);
  const idx = new Map(order.map((h, i) => [h, i]));
  const segs = SEGMENTS.map(([a, b]) => ({ bone: a, a: J[a], b: J[b] }));
  const falloff = opts.falloff ?? 4;
  const iterations = opts.smoothIterations ?? 6;
  const meta = J._meta;

  for (const mesh of meshesOf(source)) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const count = pos.count;
    const perVertex = new Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const side = v.x >= 0 ? 'left' : 'right';
      const lateral = Math.abs(v.x) > meta.torsoHalf * 1.05 && v.y > meta.crotchY;
      const belowCrotch = v.y < meta.crotchY - H * 0.01;
      const cands = segs.filter((s) => {
        const isArm = /Shoulder|Arm|Hand/.test(s.bone), isLeg = /Leg|Foot|Toes/.test(s.bone);
        const sideOk = !(s.bone.startsWith('left') || s.bone.startsWith('right')) || s.bone.startsWith(side);
        if (!sideOk) return false;
        if (lateral) return isArm || /upperChest/.test(s.bone);
        if (belowCrotch) return isLeg || s.bone === 'hips';
        return true;
      });
      const ds = cands.map((s) => ({ bone: s.bone, d: Math.max(segDist(v, s.a, s.b), H * 0.004) })).sort((a, b) => a.d - b.d).slice(0, 4);
      const acc = new Map();
      const d0 = ds[0].d;
      for (const { bone, d } of ds) {
        if (d > d0 * 2.2) continue;
        acc.set(idx.get(bone), (acc.get(idx.get(bone)) ?? 0) + Math.pow(d0 / d, falloff));
      }
      perVertex[i] = acc;
    }
    smoothWeights(geo, perVertex, iterations);
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const top = [...perVertex[i].entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
      top.forEach(([b, w], k) => { indices[i * 4 + k] = b; weights[i * 4 + k] = w / sum; });
      if (!top.length) weights[i * 4] = 1;
    }
    const g = geo.clone();
    g.applyMatrix4(mesh.matrixWorld);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const sk = new THREE.SkinnedMesh(g, mesh.material);
    sk.name = mesh.name || 'Mesh';
    if (mesh.morphTargetDictionary) { sk.morphTargetDictionary = { ...mesh.morphTargetDictionary }; sk.morphTargetInfluences = [...mesh.morphTargetInfluences]; }
    temp.add(sk);
  }
  temp.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(boneList);
  temp.traverse((o) => { if (o.isSkinnedMesh) o.bind(skeleton, new THREE.Matrix4()); });
  const humanoid = { bones: bones, facing: 1, height: H, unmapped: [], method: {} };
  const out = convertToVRoid(temp, { humanoid, keepExtraBones: false, tPose: opts.tPose ?? true, targetHeight: opts.targetHeight ?? null });
  out.userData.autoRigJoints = J;
  return out;
}

/** Laplacian smoothing of sparse per-vertex weights over mesh connectivity (coincident vertices welded). */
export function smoothWeights(geo, perVertex, iterations) {
  if (iterations <= 0) return;
  const pos = geo.attributes.position;
  const count = pos.count;
  // weld coincident vertices for adjacency
  const key = new Map();
  const rep = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    if (!key.has(k)) key.set(k, i);
    rep[i] = key.get(k);
  }
  const nbr = Array.from({ length: count }, () => new Set());
  const index = geo.index ? geo.index.array : Array.from({ length: count }, (_, i) => i);
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = rep[index[t]], b = rep[index[t + 1]], c = rep[index[t + 2]];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Array(count);
    for (let i = 0; i < count; i++) {
      if (rep[i] !== i) continue;
      const acc = new Map();
      const add = (m, f) => {
        const s = [...m.values()].reduce((x, y) => x + y, 0) || 1;
        for (const [b, w] of m) acc.set(b, (acc.get(b) ?? 0) + (w / s) * f);
      };
      add(perVertex[i], 1);
      const ns = [...nbr[i]];
      for (const j of ns) add(perVertex[j], 1 / Math.max(1, ns.length));
      next[i] = acc;
    }
    for (let i = 0; i < count; i++) if (rep[i] === i) perVertex[i] = next[i];
  }
  for (let i = 0; i < count; i++) if (rep[i] !== i) perVertex[i] = perVertex[rep[i]];
}
