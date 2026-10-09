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

// Bones VRoid Studio writes in BoneDefinition (fingers come from the hand animation presets).
const POSE_BONES = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head', 'LeftShoulder', 'LeftUpperArm', 'LeftLowerArm', 'LeftHand',
  'RightShoulder', 'RightUpperArm', 'RightLowerArm', 'RightHand', 'LeftUpperLeg', 'LeftLowerLeg', 'LeftFoot', 'LeftToes',
  'RightUpperLeg', 'RightLowerLeg', 'RightFoot', 'RightToes'];

export const DEFAULT_POSE_OPTIONS = {
  leftHand: 'L_Natural', rightHand: 'R_Natural', leftHandWeight: 1, rightHandWeight: 1,
  includeFingers: false, // VRoid drives fingers from the hand presets; enable to also write finger bones
  morphs: false,
};

const round = (v) => Math.fround(v);
const q4 = (q) => ({ x: round(q.x), y: round(q.y), z: round(q.z), w: round(q.w) });
const v3 = (v) => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

/**
 * Export the model's current pose in VRoid Studio's .vroidpose layout:
 * { Version, Left/RightHandAnimationName/Weight, BoneDefinition: { HipsPosition, <UnityBone>: quaternion, ...,
 *   SpineControlPointDeltaPosition } }. Rotations are local rotations relative to the T-pose rest, in Unity space.
 */
export function exportVRoidPose(model, options = {}) {
  const o = { ...DEFAULT_POSE_OPTIONS, ...options };
  const H = model.userData.humanoid;
  const rest = model.userData.restLocal ?? {};
  model.updateMatrixWorld(true);
  const BoneDefinition = {};
  if (H.hips) {
    const root = H.hips.parent;
    const hipsLocal = new THREE.Vector3().setFromMatrixPosition(H.hips.matrixWorld);
    // relative to the model origin (VRoid's avatar root sits at the feet)
    hipsLocal.applyMatrix4(model.matrixWorld.clone().invert());
    void root;
    BoneDefinition.HipsPosition = v3(toUnityV(hipsLocal));
  }
  const unityToH = Object.fromEntries(Object.entries(UNITY_BONE).map(([h, u]) => [u, h]));
  const names = o.includeFingers ? Object.values(UNITY_BONE).filter((n) => !/Eye|Jaw/.test(n)) : POSE_BONES;
  for (const unity of names) {
    const b = H[unityToH[unity]];
    if (!b) continue;
    const r = rest[b.name]?.q ?? new THREE.Quaternion();
    const q = r.clone().invert().multiply(b.quaternion).normalize();
    BoneDefinition[unity] = q4(toUnityQ(q));
  }
  BoneDefinition.SpineControlPointDeltaPosition = { x: 0, y: 0, z: 0 };
  const pose = {
    Version: 1,
    LeftHandAnimationName: o.leftHand, LeftHandAnimationWeight: o.leftHandWeight,
    RightHandAnimationName: o.rightHand, RightHandAnimationWeight: o.rightHandWeight,
    BoneDefinition,
  };
  if (o.morphs) {
    const values = {};
    model.traverse((m) => {
      if (!m.isMesh || !m.morphTargetDictionary) return;
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) if (m.morphTargetInfluences[i] > 1e-4) values[name] = m.morphTargetInfluences[i];
    });
    pose.BlendShapeProxyValues = values;
  }
  return pose;
}

/** Serialise like VRoid Studio (compact JSON, floats always with a decimal point for weights). */
export function stringifyVRoidPose(pose) {
  return JSON.stringify(pose, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(9)) : v))
    .replace(/"(LeftHandAnimationWeight|RightHandAnimationWeight)":(\d+)([,}])/g, '"$1":$2.0$3');
}

function readQuat(entry) {
  if (!entry) return null;
  const q = entry.Rotation ?? entry.rotation ?? entry;
  if (q.w === undefined) return null;
  return q;
}

/** Apply a .vroidpose (object) to a VRoid-rigged model. Returns names of unknown bones. */
export function applyVRoidPose(model, pose) {
  const H = model.userData.humanoid;
  const rest = model.userData.restLocal ?? {};
  const unknown = [];
  const defs = pose.BoneDefinition ?? pose.Bones ?? {};
  for (const [unity, entry] of Object.entries(defs)) {
    if (unity === 'HipsPosition' || unity === 'SpineControlPointDeltaPosition') continue;
    const h = FROM_UNITY[unity];
    const b = h ? H[h] : null;
    const rot = readQuat(entry);
    if (!b || !rot) { unknown.push(unity); continue; }
    b.quaternion.copy((rest[b.name]?.q ?? new THREE.Quaternion()).clone().multiply(fromUnityQ(rot)).normalize());
  }
  const hp = defs.HipsPosition ?? defs.Hips?.Position;
  if (hp && H.hips) {
    model.updateMatrixWorld(true);
    const target = fromUnityV(hp).applyMatrix4(model.matrixWorld);
    H.hips.position.copy(target.applyMatrix4(H.hips.parent.matrixWorld.clone().invert()));
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
