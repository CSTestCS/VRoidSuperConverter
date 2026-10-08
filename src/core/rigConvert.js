// Convert a VRoid-rigged model to another rig: a built-in profile (Tower Unite / UE mannequin,
// Mixamo, MMD, Unity) or any user-provided rig file (exact bone names and rest orientations).
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { HUMANOID_CHILD } from './vroidSkeleton.js';
import { detectHumanoid } from './humanoid.js';
import { skinnedMeshesOf, writeWeights, bakePoseIntoBind } from './skinning.js';
import { matchProportions } from './fit.js';
import { resetToBindPose } from './retarget.js';

const wpos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
const wquat = (o) => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; };
const SAFE = (name) => THREE.PropertyBinding.sanitizeNodeName(name);

/** Map every bone of the VRoid model to a bone of the new rig. */
function buildRemap(model, humanoidToNew, keepExtra, attachExtra) {
  const H = model.userData.humanoid;
  const vroidToNew = new Map();
  for (const [h, b] of Object.entries(H)) if (humanoidToNew[h]) vroidToNew.set(b, humanoidToNew[h]);
  const nearest = (b) => { for (let p = b; p; p = p.parent) if (vroidToNew.has(p)) return vroidToNew.get(p); return humanoidToNew.hips; };
  if (keepExtra) {
    const extras = [];
    model.traverse((o) => { if (o.isBone && !vroidToNew.has(o) && !Object.values(H).includes(o) && o.name !== 'Root' && !/^IK_/.test(o.name)) extras.push(o); });
    for (const e of extras) {
      // Only keep extras that actually carry weights or have weighted descendants (hair, skirt...)
      const parentNew = nearest(e.parent);
      const nb = attachExtra(e, parentNew);
      vroidToNew.set(e, nb);
    }
  }
  return (b) => vroidToNew.get(b) ?? nearest(b);
}

function rebindMeshes(model, group, bones, remap, twist = []) {
  const idx = new Map(bones.map((b, i) => [b, i]));
  group.updateMatrixWorld(true);
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const out = [];
  for (const mesh of skinnedMeshesOf(model)) {
    const geo = mesh.geometry.clone();
    geo.applyMatrix4(new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld));
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const count = si.count;
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const acc = new Map();
      v.fromBufferAttribute(mesh.geometry.attributes.position, i).applyMatrix4(mesh.matrixWorld);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const nb = remap(mesh.skeleton.bones[si.getComponent(i, k)]);
        let wMain = w;
        // Distribute part of a limb's weight onto its twist bone
        for (const t of twist) {
          if (t.of !== nb) continue;
          const a = wpos(t.of), b = wpos(t.end);
          const ab = b.clone().sub(a);
          const s = THREE.MathUtils.clamp(v.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq()), 0, 1);
          const frac = THREE.MathUtils.clamp((s - (t.t - 0.35)) / 0.7, 0, 1) * 0.6;
          const ti = idx.get(t.bone);
          acc.set(ti, (acc.get(ti) ?? 0) + w * frac);
          wMain = w * (1 - frac);
        }
        const ni = idx.get(nb);
        if (ni !== undefined) acc.set(ni, (acc.get(ni) ?? 0) + wMain);
      }
      writeWeights(acc, indices, weights, i);
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const sk = new THREE.SkinnedMesh(geo, mesh.material);
    sk.name = mesh.name;
    if (mesh.morphTargetDictionary) { sk.morphTargetDictionary = { ...mesh.morphTargetDictionary }; sk.morphTargetInfluences = [...mesh.morphTargetInfluences]; }
    group.add(sk);
    out.push(sk);
  }
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  for (const m of out) m.bind(skeleton, m.matrixWorld.clone());
  return out;
}

/**
 * Convert to a built-in / JSON rig profile. Bone positions come from the model's joints.
 * @param {THREE.Object3D} model VRoid-rigged model (userData.humanoid)
 */
export function convertToProfile(model, profile, { keepExtraBones = true, distributeTwist = true } = {}) {
  resetToBindPose(model);
  model.updateMatrixWorld(true);
  const H = model.userData.humanoid;
  const J = {};
  for (const [h, b] of Object.entries(H)) J[h] = wpos(b);
  if (H.head) J.headTop = J.head.clone().add(new THREE.Vector3(0, 0.2, 0));
  const group = new THREE.Group();
  group.name = profile.name;
  const byName = new Map();
  const humanoidToNew = {};
  const twist = [];
  const worldOf = new Map();
  for (const spec of profile.bones) {
    let p;
    if (spec.at === 'origin') p = new THREE.Vector3();
    else if (spec.at === 'headTop') p = J.headTop?.clone();
    else if (spec.humanoid) p = J[spec.humanoid]?.clone();
    else if (spec.lerp) { const [a, b, t] = spec.lerp; p = J[a] && J[b] ? J[a].clone().lerp(J[b], t) : null; }
    if (!p) continue; // the model lacks this joint
    if (spec.offset) p.add(new THREE.Vector3(...spec.offset));
    const bone = new THREE.Bone();
    bone.name = SAFE(spec.name);
    bone.userData.exportName = spec.name;
    const parent = spec.parent ? byName.get(spec.parent) : null;
    bone.position.copy(p).sub(parent ? worldOf.get(parent) : new THREE.Vector3());
    (parent ?? group).add(bone);
    byName.set(spec.name, bone);
    worldOf.set(bone, p);
    if (spec.humanoid && !spec.helper && !humanoidToNew[spec.humanoid]) humanoidToNew[spec.humanoid] = bone;
    if (spec.twistOf && distributeTwist) twist.push({ bone, ofH: spec.twistOf, t: spec.lerp?.[2] ?? 0.5 });
  }
  group.updateMatrixWorld(true);
  for (const t of twist) { t.of = humanoidToNew[t.ofH]; t.end = humanoidToNew[HUMANOID_CHILD[t.ofH]]; }
  const remap = buildRemap(model, humanoidToNew, keepExtraBones, (e, parentNew) => {
    const nb = new THREE.Bone();
    nb.name = SAFE(e.name);
    nb.userData.exportName = e.userData.sourceName ?? e.name;
    parentNew.add(nb);
    nb.position.copy(wpos(e)).applyMatrix4(parentNew.matrixWorld.clone().invert());
    nb.updateMatrixWorld(true);
    return nb;
  });
  const bones = [];
  group.traverse((o) => { if (o.isBone) bones.push(o); });
  rebindMeshes(model, group, bones, remap, twist.filter((t) => t.of && t.end));
  group.userData.humanoid = humanoidToNew;
  group.userData.rigProfile = profile.id;
  group.userData.exportUnits = profile.units;
  return group;
}

/**
 * Convert to a rig provided as a file (e.g. the official Tower Unite skeleton FBX).
 * @param {THREE.Object3D} model VRoid model
 * @param {THREE.Object3D} target loaded rig (any units/orientation)
 * @param {{proportions?: 'model'|'target', matchRestPose?: boolean, keepExtraBones?: boolean}} opts
 */
export function convertToProvidedRig(model, target, opts = {}) {
  const proportions = opts.proportions ?? 'model';
  resetToBindPose(model);
  const rig = cloneSkeleton(target);
  rig.traverse((o) => { if (o.isSkinnedMesh) o.skeleton.pose(); });
  // Drop the rig's own meshes; keep bones
  const toRemove = [];
  rig.traverse((o) => { if (o.isMesh) toRemove.push(o); });
  for (const m of toRemove) m.parent.remove(m);
  rig.updateMatrixWorld(true);
  const th = detectHumanoid(rig);
  if (!th.bones.hips) throw new Error('Could not find the hips of the provided rig');

  // Display/working transform: rig native space -> our space (metres, +Z facing, grounded)
  const box = new THREE.Box3();
  rig.traverse((o) => { if (o.isBone) box.expandByPoint(wpos(o)); });
  const h = box.max.y - box.min.y;
  const s = h > 20 ? 0.01 : h > 3.5 ? 0.1 : 1;
  const holder = new THREE.Group();
  holder.name = `${target.name || 'Rig'} (converted)`;
  holder.scale.setScalar(s);
  if (th.facing === -1) holder.rotation.y = Math.PI;
  holder.add(rig);
  holder.updateMatrixWorld(true);
  const H = model.userData.humanoid;

  if (opts.matchRestPose ?? true) {
    // Aim the model's limbs along the target rig's rest directions, then make that the bind pose.
    for (const hName of Object.keys(HUMANOID_CHILD)) {
      const c = HUMANOID_CHILD[hName];
      if (!H[hName] || !H[c] || !th.bones[hName] || !th.bones[c]) continue;
      if (!/Arm|Leg|Hand|Shoulder|Proximal|Intermediate|Metacarpal/.test(hName)) continue;
      model.updateMatrixWorld(true);
      const cur = wpos(H[c]).sub(wpos(H[hName])).normalize();
      const want = wpos(th.bones[c]).sub(wpos(th.bones[hName])).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(cur, want);
      const b = H[hName];
      b.quaternion.copy(wquat(b.parent).invert().multiply(q).multiply(wquat(b)));
      b.updateMatrixWorld(true);
    }
    bakePoseIntoBind(model);
  }
  model.updateMatrixWorld(true);
  if (proportions === 'target') {
    matchProportions(model, { updateMatrixWorld: () => holder.updateMatrixWorld(true), userData: { humanoid: th.bones } }, { strength: 1 });
  } else {
    // Move rig joints onto the model joints (keep the rig's bone orientations)
    const order = [];
    rig.traverse((o) => { if (o.isBone) order.push(o); });
    const hOf = new Map(Object.entries(th.bones).map(([k, b]) => [b, k]));
    const targetWorld = new Map();
    for (const b of order) {
      const hk = hOf.get(b);
      if (hk && H[hk]) targetWorld.set(b, wpos(H[hk]));
    }
    // unmapped bones keep their offset relative to the nearest mapped ancestor
    for (const b of order) {
      if (targetWorld.has(b)) continue;
      let anc = b.parent;
      while (anc && !targetWorld.has(anc)) anc = anc.parent;
      if (anc) targetWorld.set(b, wpos(b).sub(wpos(anc)).add(targetWorld.get(anc)));
    }
    for (const b of order) {
      if (!targetWorld.has(b)) continue;
      b.position.copy(targetWorld.get(b)).applyMatrix4(b.parent.matrixWorld.clone().invert());
      b.updateMatrixWorld(true);
    }
  }
  const humanoidToNew = { ...th.bones };
  const remap = buildRemap(model, humanoidToNew, opts.keepExtraBones ?? true, (e, parentNew) => {
    const nb = new THREE.Bone();
    nb.name = SAFE(e.name);
    parentNew.add(nb);
    nb.position.copy(wpos(e)).applyMatrix4(parentNew.matrixWorld.clone().invert());
    nb.quaternion.copy(wquat(parentNew).invert());
    nb.updateMatrixWorld(true);
    return nb;
  });
  const bones = [];
  rig.traverse((o) => { if (o.isBone) bones.push(o); });
  rebindMeshes(model, rig, bones, remap);
  holder.userData.humanoid = humanoidToNew;
  holder.userData.exportRoot = rig;
  holder.userData.exportUnits = s === 0.01 ? 'cm' : 'm';
  return holder;
}
