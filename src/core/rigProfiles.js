// Target rig profiles. A profile lists bones with their parent and where their rest position
// comes from (a humanoid joint, or an interpolation between two joints). Profiles can also be
// loaded from JSON files with the same shape.
//
// Tower Unite's modern player-model skeleton follows the Unreal Engine 4 mannequin naming. If you
// have the official skeleton file, load it with "Convert to provided rig" instead to match its
// exact bone orientations.

const side = (s) => (s === 'left' ? 'l' : 'r');

function ueMannequin(id, name, { ik = true, twist = true } = {}) {
  const bones = [
    { name: 'root', parent: null, at: 'origin' },
    { name: 'pelvis', parent: 'root', humanoid: 'hips' },
    { name: 'spine_01', parent: 'pelvis', humanoid: 'spine' },
    { name: 'spine_02', parent: 'spine_01', humanoid: 'chest' },
    { name: 'spine_03', parent: 'spine_02', humanoid: 'upperChest' },
    { name: 'neck_01', parent: 'spine_03', humanoid: 'neck' },
    { name: 'head', parent: 'neck_01', humanoid: 'head' },
  ];
  for (const s of ['left', 'right']) {
    const x = side(s);
    bones.push(
      { name: `clavicle_${x}`, parent: 'spine_03', humanoid: `${s}Shoulder` },
      { name: `upperarm_${x}`, parent: `clavicle_${x}`, humanoid: `${s}UpperArm` },
      { name: `lowerarm_${x}`, parent: `upperarm_${x}`, humanoid: `${s}LowerArm` },
      { name: `hand_${x}`, parent: `lowerarm_${x}`, humanoid: `${s}Hand` },
      { name: `thigh_${x}`, parent: 'pelvis', humanoid: `${s}UpperLeg` },
      { name: `calf_${x}`, parent: `thigh_${x}`, humanoid: `${s}LowerLeg` },
      { name: `foot_${x}`, parent: `calf_${x}`, humanoid: `${s}Foot` },
      { name: `ball_${x}`, parent: `foot_${x}`, humanoid: `${s}Toes` },
    );
    const fingers = { thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
      middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], ring: ['RingProximal', 'RingIntermediate', 'RingDistal'], pinky: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] };
    for (const [f, segs] of Object.entries(fingers)) {
      segs.forEach((seg, i) => bones.push({ name: `${f}_0${i + 1}_${x}`, parent: i ? `${f}_0${i}_${x}` : `hand_${x}`, humanoid: `${s}${seg}` }));
    }
    if (twist) {
      bones.push(
        { name: `upperarm_twist_01_${x}`, parent: `upperarm_${x}`, lerp: [`${s}UpperArm`, `${s}LowerArm`, 0.5], twistOf: `${s}UpperArm` },
        { name: `lowerarm_twist_01_${x}`, parent: `lowerarm_${x}`, lerp: [`${s}LowerArm`, `${s}Hand`, 0.6], twistOf: `${s}LowerArm` },
        { name: `thigh_twist_01_${x}`, parent: `thigh_${x}`, lerp: [`${s}UpperLeg`, `${s}LowerLeg`, 0.5], twistOf: `${s}UpperLeg` },
        { name: `calf_twist_01_${x}`, parent: `calf_${x}`, lerp: [`${s}LowerLeg`, `${s}Foot`, 0.5], twistOf: `${s}LowerLeg` },
      );
    }
  }
  if (ik) {
    bones.push(
      { name: 'ik_foot_root', parent: 'root', at: 'origin' },
      { name: 'ik_foot_l', parent: 'ik_foot_root', humanoid: 'leftFoot', helper: true },
      { name: 'ik_foot_r', parent: 'ik_foot_root', humanoid: 'rightFoot', helper: true },
      { name: 'ik_hand_root', parent: 'root', at: 'origin' },
      { name: 'ik_hand_gun', parent: 'ik_hand_root', humanoid: 'rightHand', helper: true },
      { name: 'ik_hand_l', parent: 'ik_hand_gun', humanoid: 'leftHand', helper: true },
      { name: 'ik_hand_r', parent: 'ik_hand_gun', humanoid: 'rightHand', helper: true },
    );
  }
  return { id, name, units: 'cm', bones };
}

function mixamo() {
  const map = {
    hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head',
  };
  const bones = [
    { name: 'mixamorig:Hips', parent: null, humanoid: 'hips' },
    { name: 'mixamorig:Spine', parent: 'mixamorig:Hips', humanoid: 'spine' },
    { name: 'mixamorig:Spine1', parent: 'mixamorig:Spine', humanoid: 'chest' },
    { name: 'mixamorig:Spine2', parent: 'mixamorig:Spine1', humanoid: 'upperChest' },
    { name: 'mixamorig:Neck', parent: 'mixamorig:Spine2', humanoid: 'neck' },
    { name: 'mixamorig:Head', parent: 'mixamorig:Neck', humanoid: 'head' },
    { name: 'mixamorig:HeadTop_End', parent: 'mixamorig:Head', at: 'headTop' },
  ];
  void map;
  for (const s of ['left', 'right']) {
    const S = s === 'left' ? 'Left' : 'Right';
    const p = (n) => `mixamorig:${S}${n}`;
    bones.push(
      { name: p('Shoulder'), parent: 'mixamorig:Spine2', humanoid: `${s}Shoulder` },
      { name: p('Arm'), parent: p('Shoulder'), humanoid: `${s}UpperArm` },
      { name: p('ForeArm'), parent: p('Arm'), humanoid: `${s}LowerArm` },
      { name: p('Hand'), parent: p('ForeArm'), humanoid: `${s}Hand` },
      { name: p('UpLeg'), parent: 'mixamorig:Hips', humanoid: `${s}UpperLeg` },
      { name: p('Leg'), parent: p('UpLeg'), humanoid: `${s}LowerLeg` },
      { name: p('Foot'), parent: p('Leg'), humanoid: `${s}Foot` },
      { name: p('ToeBase'), parent: p('Foot'), humanoid: `${s}Toes` },
    );
    const fingers = { Thumb: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], Index: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
      Middle: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], Ring: ['RingProximal', 'RingIntermediate', 'RingDistal'], Pinky: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] };
    for (const [f, segs] of Object.entries(fingers)) {
      segs.forEach((seg, i) => bones.push({ name: p(`Hand${f}${i + 1}`), parent: i ? p(`Hand${f}${i}`) : p('Hand'), humanoid: `${s}${seg}` }));
    }
  }
  return { id: 'mixamo', name: 'Mixamo', units: 'cm', bones };
}

function mmd() {
  const bones = [
    { name: '全ての親', parent: null, at: 'origin' },
    { name: 'センター', parent: '全ての親', lerp: ['hips', 'hips', 0], offset: [0, -0.1, 0] },
    { name: '上半身', parent: 'センター', humanoid: 'spine' },
    { name: '上半身2', parent: '上半身', humanoid: 'chest' },
    { name: '首', parent: '上半身2', humanoid: 'neck' },
    { name: '頭', parent: '首', humanoid: 'head' },
    { name: '下半身', parent: 'センター', humanoid: 'hips' },
    { name: '左目', parent: '頭', humanoid: 'leftEye' },
    { name: '右目', parent: '頭', humanoid: 'rightEye' },
  ];
  for (const s of ['left', 'right']) {
    const J = s === 'left' ? '左' : '右';
    bones.push(
      { name: `${J}肩`, parent: '上半身2', humanoid: `${s}Shoulder` },
      { name: `${J}腕`, parent: `${J}肩`, humanoid: `${s}UpperArm` },
      { name: `${J}ひじ`, parent: `${J}腕`, humanoid: `${s}LowerArm` },
      { name: `${J}手首`, parent: `${J}ひじ`, humanoid: `${s}Hand` },
      { name: `${J}足`, parent: '下半身', humanoid: `${s}UpperLeg` },
      { name: `${J}ひざ`, parent: `${J}足`, humanoid: `${s}LowerLeg` },
      { name: `${J}足首`, parent: `${J}ひざ`, humanoid: `${s}Foot` },
      { name: `${J}つま先`, parent: `${J}足首`, humanoid: `${s}Toes` },
      { name: `${J}足ＩＫ`, parent: '全ての親', humanoid: `${s}Foot`, helper: true },
      { name: `${J}つま先ＩＫ`, parent: `${J}足ＩＫ`, humanoid: `${s}Toes`, helper: true },
    );
    const fingers = { 親指: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'], 人指: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'],
      中指: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'], 薬指: ['RingProximal', 'RingIntermediate', 'RingDistal'], 小指: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] };
    const digits = { 親指: ['０', '１', '２'], default: ['１', '２', '３'] };
    for (const [f, segs] of Object.entries(fingers)) {
      const d = digits[f] ?? digits.default;
      segs.forEach((seg, i) => bones.push({ name: `${J}${f}${d[i]}`, parent: i ? `${J}${f}${d[i - 1]}` : `${J}手首`, humanoid: `${s}${seg}` }));
    }
  }
  return { id: 'mmd', name: 'MikuMikuDance (PMX standard bones)', units: 'm', bones };
}

function unityHumanoid() {
  const bones = [{ name: 'Root', parent: null, at: 'origin' }];
  const names = {};
  const order = ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye',
    'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes'];
  const parent = { hips: 'Root', spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck', leftEye: 'head', rightEye: 'head',
    leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
    rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
    leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
    rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot' };
  for (const h of order) {
    names[h] = h[0].toUpperCase() + h.slice(1);
    bones.push({ name: names[h], parent: parent[h] === 'Root' ? 'Root' : names[parent[h]], humanoid: h });
  }
  return { id: 'unity', name: 'Unity Humanoid (generic names)', units: 'm', bones };
}

export const RIG_PROFILES = [
  ueMannequin('tower-unite', 'Tower Unite (modern, UE4 mannequin naming)'),
  ueMannequin('ue4-mannequin', 'Unreal Engine 4 Mannequin'),
  ueMannequin('ue5-manny-basic', 'Unreal Engine 5 Manny (core bones)', { ik: true, twist: true }),
  mixamo(),
  mmd(),
  unityHumanoid(),
];

export function getProfile(id) {
  return RIG_PROFILES.find((p) => p.id === id) ?? null;
}

/** Validate a user profile JSON object. */
export function parseProfile(json) {
  const p = typeof json === 'string' ? JSON.parse(json) : json;
  if (!p || !Array.isArray(p.bones)) throw new Error('Rig profile must have a "bones" array');
  const names = new Set();
  for (const b of p.bones) {
    if (!b.name) throw new Error('Every bone needs a name');
    if (names.has(b.name)) throw new Error(`Duplicate bone ${b.name}`);
    if (b.parent && !names.has(b.parent)) throw new Error(`Bone ${b.name}: parent ${b.parent} must appear earlier`);
    names.add(b.name);
  }
  return { id: p.id ?? 'custom', name: p.name ?? 'Custom rig', units: p.units ?? 'm', bones: p.bones };
}
