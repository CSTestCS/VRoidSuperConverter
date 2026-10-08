// Inverse kinematics for VRoid models: IK target/pole bones, an analytic two-bone solver for
// arms and legs, a CCD solver for arbitrary chains, look-at, and baking IK into FK clips
// (with optional foot locking to the floor).
import * as THREE from 'three';
import { VROID_ROOT_NAME } from './vroidSkeleton.js';
import { skinnedMeshesOf } from './skinning.js';

const wpos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
const wquat = (o) => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; };

export const IK_CHAINS = [
  { name: 'LeftLeg', root: 'leftUpperLeg', mid: 'leftLowerLeg', end: 'leftFoot', pole: [0, 0, 1], target: 'IK_Foot_L', poleBone: 'IK_Knee_L' },
  { name: 'RightLeg', root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot', pole: [0, 0, 1], target: 'IK_Foot_R', poleBone: 'IK_Knee_R' },
  { name: 'LeftArm', root: 'leftUpperArm', mid: 'leftLowerArm', end: 'leftHand', pole: [0, 0, -1], target: 'IK_Hand_L', poleBone: 'IK_Elbow_L' },
  { name: 'RightArm', root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand', pole: [0, 0, -1], target: 'IK_Hand_R', poleBone: 'IK_Elbow_R' },
];

function setWorldQuat(bone, q) {
  const pw = wquat(bone.parent);
  bone.quaternion.copy(pw.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
function setWorldPos(obj, p) {
  obj.position.copy(p).applyMatrix4(obj.parent.matrixWorld.clone().invert());
  obj.updateMatrixWorld(true);
}

/**
 * Add IK target and pole bones (unweighted helper bones under Root, like MMD/Unity IK rigs).
 * They are exported with the skeleton so other tools can drive them.
 */
export function addIKRig(model, { poleDistance = 0.4, lookAt = true } = {}) {
  const H = model.userData.humanoid;
  const root = model.getObjectByName(VROID_ROOT_NAME) ?? H.hips.parent;
  model.updateMatrixWorld(true);
  const created = [];
  const make = (name, p) => {
    let b = model.getObjectByName(name);
    if (!b) {
      b = new THREE.Bone();
      b.name = name;
      root.add(b);
      created.push(b);
    }
    setWorldPos(b, p);
    return b;
  };
  const chains = [];
  for (const c of IK_CHAINS) {
    if (!H[c.root] || !H[c.mid] || !H[c.end]) continue;
    const target = make(c.target, wpos(H[c.end]));
    const pole = make(c.poleBone, wpos(H[c.mid]).add(new THREE.Vector3(...c.pole).multiplyScalar(poleDistance)));
    chains.push({ ...c, targetBone: target, poleBoneObj: pole, enabled: true });
  }
  let look = null;
  if (lookAt && H.head) look = make('IK_LookAt', wpos(H.head).add(new THREE.Vector3(0, 0, 1)));
  // Helper bones join every skeleton so they export (they carry no weights).
  for (const mesh of skinnedMeshesOf(model)) {
    const bones = mesh.skeleton.bones.slice();
    const inv = mesh.skeleton.boneInverses.slice();
    for (const b of created) { bones.push(b); inv.push(new THREE.Matrix4().copy(b.matrixWorld).invert()); }
    mesh.skeleton = new THREE.Skeleton(bones, inv);
  }
  model.userData.ik = { chains, lookAt: look, lookAtEnabled: !!look, lookAtWeight: 1 };
  return model.userData.ik;
}

/**
 * Analytic two-bone IK. Rotates root and mid so that `end` reaches `target`, with the joint
 * (knee/elbow) bending toward `pole`. Works in world space for any rest orientation.
 */
export function solveTwoBone(rootB, midB, endB, target, pole, weight = 1) {
  rootB.updateMatrixWorld(true);
  const a = wpos(rootB), b = wpos(midB), c = wpos(endB);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  const toT = target.clone().sub(a);
  const dist = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-5, (l1 + l2) * 0.99999);
  const dir = toT.lengthSq() > 1e-12 ? toT.normalize() : c.clone().sub(a).normalize();
  let perp = pole.clone().sub(a).projectOnPlane(dir);
  if (perp.lengthSq() < 1e-10) perp = b.clone().sub(a).projectOnPlane(dir);
  if (perp.lengthSq() < 1e-10) perp = new THREE.Vector3(0, 0, 1).projectOnPlane(dir);
  perp.normalize();
  // law of cosines: distance along dir to the joint, and its offset toward the pole
  const x = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const y = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  const midTarget = a.clone().addScaledVector(dir, x).addScaledVector(perp, y);
  const endTarget = a.clone().addScaledVector(dir, dist);
  const r1 = new THREE.Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), midTarget.clone().sub(a).normalize());
  const rootW = wquat(rootB);
  setWorldQuat(rootB, rootW.clone().slerp(r1.multiply(rootW), weight));
  const b2 = wpos(midB), c2 = wpos(endB);
  const r2 = new THREE.Quaternion().setFromUnitVectors(c2.clone().sub(b2).normalize(), endTarget.clone().sub(b2).normalize());
  const midW = wquat(midB);
  setWorldQuat(midB, midW.clone().slerp(r2.multiply(midW), weight));
}

/** Cyclic coordinate descent for an arbitrary chain (bones ordered root -> tip). */
export function solveCCD(chain, effector, target, { iterations = 12, tolerance = 1e-4 } = {}) {
  for (let it = 0; it < iterations; it++) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      const bp = wpos(bone), ep = wpos(effector);
      const toE = ep.sub(bp).normalize(), toT = target.clone().sub(bp).normalize();
      if (toE.lengthSq() < 1e-12 || toT.lengthSq() < 1e-12) continue;
      const q = new THREE.Quaternion().setFromUnitVectors(toE, toT);
      setWorldQuat(bone, q.multiply(wquat(bone)));
    }
    if (wpos(effector).distanceTo(target) < tolerance) break;
  }
}

/** Rotate the neck/head so the face looks at a world point. */
export function solveLookAt(model, point, { weight = 1, neckShare = 0.3 } = {}) {
  const H = model.userData.humanoid;
  if (!H.head) return;
  model.updateMatrixWorld(true);
  const headPos = wpos(H.head);
  const modelQ = wquat(model);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(modelQ);
  const dir = point.clone().sub(headPos).normalize();
  const full = new THREE.Quaternion().setFromUnitVectors(forward, dir);
  const apply = (bone, share) => {
    if (!bone) return;
    const part = new THREE.Quaternion().slerp(full, share * weight);
    const w = wquat(bone);
    setWorldQuat(bone, part.multiply(w));
  };
  apply(H.neck, neckShare);
  apply(H.head, 1 - neckShare);
}

/** Solve all enabled IK chains of a model (call after posing / each frame). */
export function solveModelIK(model) {
  const ik = model.userData.ik;
  if (!ik) return;
  const H = model.userData.humanoid;
  model.updateMatrixWorld(true);
  for (const c of ik.chains) {
    if (!c.enabled) continue;
    solveTwoBone(H[c.root], H[c.mid], H[c.end], wpos(c.targetBone), wpos(c.poleBoneObj), c.weight ?? 1);
    // keep the foot/hand orientation of the target bone
    if (c.matchRotation) setWorldQuat(H[c.end], wquat(c.targetBone));
  }
  if (ik.lookAt && ik.lookAtEnabled) solveLookAt(model, wpos(ik.lookAt), { weight: ik.lookAtWeight });
}

/**
 * Bake IK into a clip: plays `clip`, optionally locks feet (keeps them above the floor and
 * planted while in contact), solves IK, and records FK rotations for the affected bones.
 */
export function bakeIKToClip(model, clip, { fps = 30, floorY = 0, footLock = true, contactHeight = 0.03, chains = ['LeftLeg', 'RightLeg'] } = {}) {
  const H = model.userData.humanoid;
  const ik = model.userData.ik ?? addIKRig(model);
  const duration = Math.max(clip.duration, 1 / fps);
  const frames = Math.round(duration * fps) + 1;
  const times = new Float32Array(frames);
  const snapshot = [];
  model.traverse((x) => snapshot.push([x, x.position.clone(), x.quaternion.clone()]));
  model.updateMatrixWorld(true);
  const ankleRest = Object.fromEntries(ik.chains.map((c) => [c.name, wpos(H[c.end]).y - floorY]));
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const bones = new Set();
  for (const c of ik.chains) if (chains.includes(c.name)) { bones.add(H[c.root]); bones.add(H[c.mid]); bones.add(H[c.end]); }
  const values = new Map([...bones].map((b) => [b, []]));
  const planted = {};
  for (let f = 0; f < frames; f++) {
    const t = Math.min(duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    model.updateMatrixWorld(true);
    for (const c of ik.chains) {
      if (!chains.includes(c.name)) continue;
      const end = H[c.end];
      const p = wpos(end);
      const minY = floorY + ankleRest[c.name];
      let target = p.clone();
      if (target.y < minY) target.y = minY;
      if (footLock) {
        const inContact = p.y - minY < contactHeight;
        if (inContact) { planted[c.name] ??= target.clone(); target = planted[c.name].clone(); target.y = Math.max(target.y, minY); }
        else planted[c.name] = null;
      }
      const mid = wpos(H[c.mid]);
      const pole = mid.clone().add(mid.clone().sub(wpos(H[c.root]).lerp(p, 0.5)).normalize().multiplyScalar(0.3));
      const endQ = wquat(end);
      solveTwoBone(H[c.root], H[c.mid], end, target, pole, 1);
      setWorldQuat(end, endQ);
    }
    for (const b of bones) {
      const arr = values.get(b);
      const q = b.quaternion.clone();
      const prev = arr[arr.length - 1];
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      arr.push(q);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  for (const [x, p, q] of snapshot) { x.position.copy(p); x.quaternion.copy(q); }
  model.updateMatrixWorld(true);
  const names = new Set([...bones].map((b) => `${b.name}.quaternion`));
  const tracks = clip.tracks.filter((tr) => !names.has(tr.name)).map((tr) => tr.clone());
  for (const [b, arr] of values) {
    const v = new Float32Array(arr.length * 4);
    arr.forEach((q, i) => v.set(q.toArray(), i * 4));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, v));
  }
  return new THREE.AnimationClip(clip.name, duration, tracks);
}
