// Rig conversion (any humanoid rig -> VRoid skeleton) and animation retargeting.
import * as THREE from 'three';
import { VROID_BONES, VROID_NAME, VROID_ROOT_NAME, HUMANOID_CHILD, HUMANOID_PARENT } from './vroidSkeleton.js';
import { detectHumanoid } from './humanoid.js';
import { skinnedMeshesOf, meshesOf, writeWeights, bakePoseIntoBind } from './skinning.js';

const Y180 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

function worldPos(o) { return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); }
function worldQuat(o) { return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(o.matrixWorld)); }
function worldQuatExact(o) { const q = new THREE.Quaternion(); o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; }

/** Put every skinned mesh of `root` into its bind pose. */
export function resetToBindPose(root) {
  for (const m of skinnedMeshesOf(root)) m.skeleton.pose();
  root.updateMatrixWorld(true);
}

/**
 * Synthesise world positions for humanoid bones the source rig does not have.
 * @param {Record<string, THREE.Vector3>} p  humanoid -> world position (mutated)
 */
function fillMissingPositions(p, height) {
  const lerp = (a, b, t) => a.clone().lerp(b, t);
  if (!p.spine && p.hips && (p.chest || p.neck)) p.spine = lerp(p.hips, p.chest ?? p.neck, 0.3);
  if (!p.chest && p.spine && p.neck) p.chest = lerp(p.spine, p.neck, 0.35);
  if (!p.upperChest && p.chest && p.neck) p.upperChest = lerp(p.chest, p.neck, 0.45);
  if (!p.neck && p.upperChest && p.head) p.neck = lerp(p.upperChest, p.head, 0.6);
  for (const s of ['left', 'right']) {
    const S = (n) => `${s}${n}`;
    if (!p[S('Shoulder')] && p.upperChest && p[S('UpperArm')]) {
      const sh = lerp(p.upperChest, p[S('UpperArm')], 0.25);
      sh.y = p[S('UpperArm')].y;
      p[S('Shoulder')] = sh;
    }
    if (!p[S('Toes')] && p[S('Foot')]) p[S('Toes')] = p[S('Foot')].clone().add(new THREE.Vector3(0, -p[S('Foot')].y * 0.7, height * 0.07));
    if (!p[S('Eye')] && p.head) p[S('Eye')] = p.head.clone().add(new THREE.Vector3(s === 'left' ? 0.02 : -0.02, height * 0.045, height * 0.03).multiplyScalar(1));
  }
  return p;
}

/**
 * Convert any rigged humanoid (or an auto-rigged one) to the VRoid skeleton.
 * Builds a new, clean hierarchy: Root -> J_Bip_C_Hips -> ... with identity rest rotations
 * (the "normalized" bone orientation VRoid exports), remaps skin weights, and returns a new Group.
 *
 * @param {THREE.Object3D} source
 * @param {{
 *   humanoid?: ReturnType<typeof detectHumanoid>, keepExtraBones?: boolean, targetHeight?: number|null,
 *   tPose?: boolean, groundToZero?: boolean, name?: string,
 * }} opts
 */
export function convertToVRoid(source, opts = {}) {
  resetToBindPose(source);
  const humanoid = opts.humanoid ?? detectHumanoid(source);
  const keepExtra = opts.keepExtraBones ?? true;

  // World transform correction: facing, scale, grounding
  const box = new THREE.Box3().setFromObject(source);
  const rawHeight = Math.max(1e-6, box.max.y - box.min.y);
  let scale = 1;
  if (opts.targetHeight) scale = opts.targetHeight / rawHeight;
  else if (rawHeight > 20) scale = 0.01; // centimetres
  else if (rawHeight > 3.5) scale = 0.1;
  const M = new THREE.Matrix4();
  if (humanoid.facing === -1) M.makeRotationY(Math.PI);
  M.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  const hipsW = humanoid.bones.hips ? worldPos(humanoid.bones.hips).applyMatrix4(M) : new THREE.Vector3();
  const minY = box.clone().applyMatrix4(M).min.y;
  M.premultiply(new THREE.Matrix4().makeTranslation(-hipsW.x, (opts.groundToZero ?? true) ? -minY : 0, -hipsW.z));
  const height = rawHeight * scale;

  // Target bone positions
  const P = {};
  for (const [h, b] of Object.entries(humanoid.bones)) P[h] = worldPos(b).applyMatrix4(M);
  fillMissingPositions(P, height);

  const out = new THREE.Group();
  out.name = opts.name ?? 'VRoidModel';
  const root = new THREE.Bone();
  root.name = VROID_ROOT_NAME;
  out.add(root);
  const newByHumanoid = {};
  const newWorld = new Map([[root, new THREE.Vector3()]]);
  const addBone = (name, world, parent) => {
    const b = new THREE.Bone();
    b.name = name;
    b.position.copy(world).sub(newWorld.get(parent));
    parent.add(b);
    newWorld.set(b, world.clone());
    return b;
  };
  for (const [h, parent] of VROID_BONES.map((x) => [x[0], x[1]])) {
    if (!P[h]) continue;
    let par = parent;
    while (par && !newByHumanoid[par]) par = HUMANOID_PARENT[par];
    newByHumanoid[h] = addBone(VROID_NAME[h], P[h], par ? newByHumanoid[par] : root);
  }

  // Map old bones -> new bones
  const oldToNew = new Map();
  for (const [h, b] of Object.entries(humanoid.bones)) oldToNew.set(b, newByHumanoid[h]);
  const usedNames = new Set([...newWorld.keys()].map((b) => b.name));
  const resolveAncestor = (old) => {
    for (let p = old; p; p = p.parent) if (oldToNew.has(p)) return oldToNew.get(p);
    return newByHumanoid.hips ?? root;
  };
  if (keepExtra) {
    // Depth-first so parents are created before children
    const extras = [];
    source.traverse((o) => { if ((o.isBone) && !oldToNew.has(o)) extras.push(o); });
    for (const old of extras) {
      const parentNew = old.parent ? resolveAncestor(old.parent) : root;
      let name = THREE.PropertyBinding.sanitizeNodeName(old.name || 'Bone') || 'Bone';
      while (usedNames.has(name)) name += '_';
      usedNames.add(name);
      const nb = addBone(name, worldPos(old).applyMatrix4(M), parentNew);
      nb.userData.sourceName = old.name;
      oldToNew.set(old, nb);
    }
  }
  out.updateMatrixWorld(true);
  const allNew = [];
  root.traverse((o) => { if (o.isBone) allNew.push(o); });
  const newIndex = new Map(allNew.map((b, i) => [b, i]));
  const mapOld = (old) => oldToNew.get(old) ?? resolveAncestor(old);

  // Meshes
  const meshes = meshesOf(source);
  for (const mesh of meshes) {
    const geo = mesh.geometry.clone();
    const world = new THREE.Matrix4().multiplyMatrices(M, mesh.matrixWorld);
    geo.applyMatrix4(world);
    if (geo.morphAttributes.position) {
      const lin = new THREE.Matrix3().setFromMatrix4(world);
      for (const m of geo.morphAttributes.position) {
        const v = new THREE.Vector3();
        for (let i = 0; i < m.count; i++) {
          v.fromBufferAttribute(m, i);
          if (geo.morphTargetsRelative) v.applyMatrix3(lin); else v.applyMatrix4(world);
          m.setXYZ(i, v.x, v.y, v.z);
        }
      }
    }
    const count = geo.attributes.position.count;
    const indices = new Uint16Array(count * 4);
    const weights = new Float32Array(count * 4);
    if (mesh.isSkinnedMesh) {
      const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
      for (let i = 0; i < count; i++) {
        const acc = new Map();
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (!w) continue;
          const nb = mapOld(mesh.skeleton.bones[si.getComponent(i, k)]);
          const ni = newIndex.get(nb);
          if (ni !== undefined) acc.set(ni, (acc.get(ni) ?? 0) + w);
        }
        writeWeights(acc, indices, weights, i);
      }
    } else {
      const nb = mesh.parent ? resolveAncestor(mesh.parent) : newByHumanoid.hips;
      const ni = newIndex.get(nb) ?? 0;
      for (let i = 0; i < count; i++) { indices[i * 4] = ni; weights[i * 4] = 1; }
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const sk = new THREE.SkinnedMesh(geo, mesh.material);
    sk.name = mesh.name || 'Mesh';
    if (mesh.morphTargetDictionary) {
      sk.morphTargetDictionary = { ...mesh.morphTargetDictionary };
      sk.morphTargetInfluences = new Array(mesh.morphTargetInfluences.length).fill(0);
    }
    sk.userData = { ...mesh.userData };
    out.add(sk);
  }
  out.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(allNew);
  for (const m of skinnedMeshesOf(out)) m.bind(skeleton, new THREE.Matrix4());

  out.userData.humanoid = newByHumanoid;
  out.userData.isVRoidRig = true;
  if (opts.tPose ?? true) normalizeToTPose(out);
  return out;
}

/** Rotate arms/legs into a VRoid T-pose, bake the mesh, and re-zero bone rotations. */
export function normalizeToTPose(model, { arms = true, legs = true, fingers = false } = {}) {
  const H = model.userData.humanoid;
  model.updateMatrixWorld(true);
  const aim = (h, dir) => {
    const b = H[h];
    const c = H[HUMANOID_CHILD[h]];
    if (!b || !c) return;
    model.updateMatrixWorld(true);
    const cur = worldPos(c).sub(worldPos(b)).normalize();
    if (cur.lengthSq() < 1e-10) return;
    const q = new THREE.Quaternion().setFromUnitVectors(cur, dir.clone().normalize());
    // apply world rotation q to bone b: local' = parentWorld^-1 * q * world
    const pw = worldQuatExact(b.parent);
    const w = worldQuatExact(b);
    b.quaternion.copy(pw.clone().invert().multiply(q).multiply(w));
    b.updateMatrixWorld(true);
  };
  if (arms) for (const s of ['left', 'right']) {
    const x = new THREE.Vector3(s === 'left' ? 1 : -1, 0, 0);
    aim(`${s}UpperArm`, x); aim(`${s}LowerArm`, x); aim(`${s}Hand`, x);
    if (fingers) for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const seg of ['Proximal', 'Intermediate']) aim(`${s}${f}${seg}`, x);
  }
  if (legs) for (const s of ['left', 'right']) {
    const down = new THREE.Vector3(0, -1, 0);
    aim(`${s}UpperLeg`, down); aim(`${s}LowerLeg`, down);
  }
  bakePoseIntoBind(model);
  zeroBoneRotations(model);
}

/** Give every bone an identity world rotation while keeping world positions (geometry unchanged). */
export function zeroBoneRotations(model) {
  model.updateMatrixWorld(true);
  const bones = [];
  model.traverse((o) => { if (o.isBone) bones.push(o); });
  const worlds = new Map(bones.map((b) => [b, worldPos(b)]));
  const parentWorldMatrix = (b) => b.parent ? b.parent.matrixWorld : new THREE.Matrix4();
  for (const b of bones) {
    // parents are processed first (traverse order), so their world rotation is already identity
    const pInv = parentWorldMatrix(b).clone().invert();
    b.position.copy(worlds.get(b)).applyMatrix4(pInv);
    b.quaternion.copy(worldQuatExact(b.parent ?? model).invert());
    b.scale.set(1, 1, 1);
    b.updateMatrixWorld(true);
  }
  for (const m of skinnedMeshesOf(model)) m.skeleton.calculateInverses();
}

// ------------------------------------------------------------------------- animation
/**
 * Build a rest-pose snapshot for a rig. Must be called while the rig is in its rest pose.
 */
export function captureRest(root, bones) {
  root.updateMatrixWorld(true);
  const rest = {};
  for (const [h, b] of Object.entries(bones)) {
    rest[h] = { q: worldQuatExact(b), p: worldPos(b), local: b.quaternion.clone(), localPos: b.position.clone() };
  }
  return rest;
}

function restDirection(rest, h) {
  const c = HUMANOID_CHILD[h];
  if (!c || !rest[c] || !rest[h]) return null;
  const d = rest[c].p.clone().sub(rest[h].p);
  return d.lengthSq() > 1e-12 ? d.normalize() : null;
}

/**
 * Retarget an animation clip from a source humanoid rig to a target humanoid rig.
 * @param {THREE.AnimationClip} clip
 * @param {{root: THREE.Object3D, bones: Record<string, THREE.Object3D>, facing?: number, rest?: object}} src
 * @param {{root: THREE.Object3D, bones: Record<string, THREE.Object3D>, rest?: object}} tgt
 * @param {{fps?: number, alignRestPose?: boolean, translateHips?: boolean, inPlace?: boolean, name?: string}} opts
 */
export function retargetClip(clip, src, tgt, opts = {}) {
  const fps = opts.fps ?? 30;
  const align = opts.alignRestPose ?? true;
  const F = src.facing === -1 ? Y180.clone() : new THREE.Quaternion();
  const Finv = F.clone().invert();

  const srcRest = src.rest ?? captureRest(src.root, src.bones);
  const tgtRest = tgt.rest ?? captureRest(tgt.root, tgt.bones);
  const humanoids = Object.keys(tgt.bones).filter((h) => src.bones[h]);

  // Alignment per bone: rotation taking the target rest direction onto the source rest direction
  const A = {};
  for (const h of humanoids) {
    A[h] = new THREE.Quaternion();
    if (!align) continue;
    const ds = restDirection(srcRest, h)?.applyQuaternion(F);
    const dt = restDirection(tgtRest, h);
    if (ds && dt && src.bones[HUMANOID_CHILD[h]]) A[h].setFromUnitVectors(dt, ds);
  }

  const srcHipH = Math.max(1e-6, srcRest.hips?.p.y ?? 1);
  const tgtHipH = Math.max(1e-6, tgtRest.hips?.p.y ?? 1);
  const hipScale = tgtHipH / srcHipH;

  // Target bones in hierarchy order
  const tgtOrder = [];
  tgt.root.traverse((o) => { if (o.isBone || Object.values(tgt.bones).includes(o)) tgtOrder.push(o); });
  const hOf = new Map(Object.entries(tgt.bones).map(([h, b]) => [b, h]));
  const restLocal = new Map(tgtOrder.map((b) => [b, { q: b.quaternion.clone(), p: b.position.clone() }]));

  const snapshot = [];
  src.root.traverse((o) => snapshot.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(src.root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const duration = Math.max(clip.duration, 1 / fps);
  const frames = Math.max(2, Math.round(duration * fps) + 1);
  const times = new Float32Array(frames);
  const qTracks = new Map();
  const hipsPos = [];

  for (let f = 0; f < frames; f++) {
    const t = Math.min(duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    src.root.updateMatrixWorld(true);
    const desired = new Map();
    for (const h of humanoids) {
      const ws = worldQuatExact(src.bones[h]);
      const delta = ws.multiply(srcRest[h].q.clone().invert());
      const d2 = F.clone().multiply(delta).multiply(Finv);
      desired.set(tgt.bones[h], d2.multiply(A[h]).multiply(tgtRest[h].q));
    }
    // Resolve locals top-down
    const worldQ = new Map();
    for (const b of tgtOrder) {
      const parentQ = b.parent && worldQ.has(b.parent) ? worldQ.get(b.parent) : worldQuatExact(b.parent ?? tgt.root);
      let local;
      if (desired.has(b)) {
        local = parentQ.clone().invert().multiply(desired.get(b));
        worldQ.set(b, desired.get(b));
      } else {
        local = restLocal.get(b).q.clone();
        worldQ.set(b, parentQ.clone().multiply(local));
      }
      if (hOf.has(b) || desired.has(b)) {
        let arr = qTracks.get(b);
        if (!arr) { arr = []; qTracks.set(b, arr); }
        const prev = arr.length ? arr[arr.length - 1] : null;
        if (prev && prev.dot(local) < 0) local.set(-local.x, -local.y, -local.z, -local.w);
        arr.push(local);
      }
    }
    if (src.bones.hips && tgt.bones.hips && (opts.translateHips ?? true)) {
      const d = worldPos(src.bones.hips).sub(srcRest.hips.p).applyQuaternion(F).multiplyScalar(hipScale);
      if (opts.inPlace) { d.x = 0; d.z = 0; }
      const w = tgtRest.hips.p.clone().add(d);
      const parent = tgt.bones.hips.parent;
      const local = parent ? w.applyMatrix4(parent.matrixWorld.clone().invert()) : w;
      hipsPos.push(local);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(src.root);
  // restore source rest
  for (const [o, p, q, sc] of snapshot) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
  src.root.updateMatrixWorld(true);

  const tracks = [];
  for (const [b, arr] of qTracks) {
    const values = new Float32Array(arr.length * 4);
    arr.forEach((q, i) => values.set([q.x, q.y, q.z, q.w], i * 4));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values));
  }
  if (hipsPos.length) {
    const values = new Float32Array(hipsPos.length * 3);
    hipsPos.forEach((p, i) => values.set([p.x, p.y, p.z], i * 3));
    tracks.push(new THREE.VectorKeyframeTrack(`${tgt.bones.hips.name}.position`, times, values));
  }
  return new THREE.AnimationClip(opts.name ?? clip.name ?? 'Retargeted', duration, tracks);
}

/** Sample a clip on a rig and return per-frame local quaternions per bone name (for pose export / editing). */
export function sampleClip(root, clip, t) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(t);
  root.updateMatrixWorld(true);
  const out = {};
  root.traverse((o) => { if (o.isBone) out[o.name] = { q: o.quaternion.clone(), p: o.position.clone() }; });
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  return out;
}

export { worldPos, worldQuatExact };
