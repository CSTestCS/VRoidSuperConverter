// VRoid Studio pose files (.vroidpose, JSON). VRoid Studio runs on Unity, so bone rotations are
// stored per Unity humanoid bone in Unity's left-handed space. Our scene is right-handed with the
// character facing +Z, which maps to Unity by mirroring X.
//
// NOTE: VRoid Studio's pose format is not publicly documented. The layout below follows the
// files VRoid Studio writes (BoneDefinition / HipsHeight / BlendShapeProxyValues); unknown
// extra keys found on import are preserved so a round trip does not lose data.
import * as THREE from 'three';

/** Humanoid key (ours) -> Unity HumanBodyBones name */
export const UNITY_BONE = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', upperChest: 'UpperChest', neck: 'Neck', head: 'Head',
  leftEye: 'LeftEye', rightEye: 'RightEye', jaw: 'Jaw',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftUpperArm', leftLowerArm: 'LeftLowerArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightUpperArm', rightLowerArm: 'RightLowerArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpperLeg', leftLowerLeg: 'LeftLowerLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToes',
  rightUpperLeg: 'RightUpperLeg', rightLowerLeg: 'RightLowerLeg', rightFoot: 'RightFoot', rightToes: 'RightToes',
  leftThumbMetacarpal: 'LeftThumbProximal', leftThumbProximal: 'LeftThumbIntermediate', leftThumbDistal: 'LeftThumbDistal',
  rightThumbMetacarpal: 'RightThumbProximal', rightThumbProximal: 'RightThumbIntermediate', rightThumbDistal: 'RightThumbDistal',
};
for (const s of ['left', 'right']) for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
  UNITY_BONE[`${s}${f}${seg}`] = `${s === 'left' ? 'Left' : 'Right'}${f}${seg}`;
}
const FROM_UNITY = Object.fromEntries(Object.entries(UNITY_BONE).map(([k, v]) => [v, k]));

const toUnityQ = (q) => ({ x: q.x, y: -q.y, z: -q.z, w: q.w });
const fromUnityQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
const toUnityV = (v) => ({ x: -v.x, y: v.y, z: v.z });
const fromUnityV = (v) => new THREE.Vector3(-v.x, v.y, v.z);

/**
 * Pose rotations relative to the rest pose (VRoid rest bones have identity rotation, so for a
 * VRoid-converted model this equals the local rotation).
 */
export function exportVRoidPose(model, { morphs = true } = {}) {
  const H = model.userData.humanoid;
  const rest = model.userData.restLocal ?? {};
  model.updateMatrixWorld(true);
  const BoneDefinition = {};
  for (const [h, unity] of Object.entries(UNITY_BONE)) {
    const b = H[h];
    if (!b) continue;
    const r = rest[b.name]?.q ?? new THREE.Quaternion();
    const q = r.clone().invert().multiply(b.quaternion);
    const entry = { Rotation: toUnityQ(q) };
    if (h === 'hips') {
      const restP = rest[b.name]?.p ?? b.position;
      entry.Position = toUnityV(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
      entry.LocalPositionDelta = toUnityV(b.position.clone().sub(restP));
    }
    BoneDefinition[unity] = entry;
  }
  const BlendShapeProxyValues = {};
  if (morphs) {
    model.traverse((m) => {
      if (!m.isMesh || !m.morphTargetDictionary) return;
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
        const v = m.morphTargetInfluences[i];
        if (v > 1e-4) BlendShapeProxyValues[name] = Math.max(BlendShapeProxyValues[name] ?? 0, v);
      }
    });
  }
  const hips = H.hips ? new THREE.Vector3().setFromMatrixPosition(H.hips.matrixWorld).y : 0;
  return { FormatVersion: 1, HipsHeight: hips, BoneDefinition, BlendShapeProxyValues };
}

/** Apply a .vroidpose (object) to a VRoid-rigged model. Returns names of unknown bones. */
export function applyVRoidPose(model, pose) {
  const H = model.userData.humanoid;
  const rest = model.userData.restLocal ?? {};
  const unknown = [];
  const defs = pose.BoneDefinition ?? pose.Bones ?? {};
  for (const [unity, entry] of Object.entries(defs)) {
    const h = FROM_UNITY[unity];
    const b = h ? H[h] : null;
    if (!b) { unknown.push(unity); continue; }
    const rot = entry.Rotation ?? entry.rotation;
    if (rot) b.quaternion.copy((rest[b.name]?.q ?? new THREE.Quaternion()).clone().multiply(fromUnityQ(rot)));
    if (h === 'hips') {
      const restP = rest[b.name]?.p ?? b.position.clone();
      if (entry.LocalPositionDelta) b.position.copy(restP.clone().add(fromUnityV(entry.LocalPositionDelta)));
      else if (pose.HipsHeight != null && H.hips) {
        // VRoid stores the hip height in metres; keep x/z from the rest pose
        model.updateMatrixWorld(true);
        const w = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
        const dy = pose.HipsHeight - w.y;
        b.position.y += dy;
      }
    }
  }
  const morphs = pose.BlendShapeProxyValues ?? {};
  model.traverse((m) => {
    if (!m.isMesh || !m.morphTargetDictionary) return;
    for (const [name, v] of Object.entries(morphs)) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = v;
    }
  });
  model.updateMatrixWorld(true);
  return unknown;
}

/** Remember the rest pose (call once after conversion). */
export function storeRestPose(model) {
  const restLocal = {};
  model.traverse((o) => { if (o.isBone) restLocal[o.name] = { q: o.quaternion.clone(), p: o.position.clone() }; });
  model.userData.restLocal = restLocal;
}
