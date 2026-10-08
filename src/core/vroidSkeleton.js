// VRoid Studio skeleton definition (bone names as exported by VRoid Studio to VRM).
// Coordinates: Y up, metres, the character faces +Z and its left side is +X.

/** Humanoid bones in parent-before-child order: [humanoid, parent humanoid, VRoid bone name, default rest position] */
export const VROID_BONES = [
  ['hips', null, 'J_Bip_C_Hips', [0, 0.92, 0]],
  ['spine', 'hips', 'J_Bip_C_Spine', [0, 0.99, 0]],
  ['chest', 'spine', 'J_Bip_C_Chest', [0, 1.09, 0]],
  ['upperChest', 'chest', 'J_Bip_C_UpperChest', [0, 1.19, 0]],
  ['neck', 'upperChest', 'J_Bip_C_Neck', [0, 1.33, 0]],
  ['head', 'neck', 'J_Bip_C_Head', [0, 1.40, 0]],
  ['leftEye', 'head', 'J_Adj_L_FaceEye', [0.032, 1.47, 0.045]],
  ['rightEye', 'head', 'J_Adj_R_FaceEye', [-0.032, 1.47, 0.045]],
  ['leftShoulder', 'upperChest', 'J_Bip_L_Shoulder', [0.02, 1.29, 0]],
  ['leftUpperArm', 'leftShoulder', 'J_Bip_L_UpperArm', [0.09, 1.29, 0]],
  ['leftLowerArm', 'leftUpperArm', 'J_Bip_L_LowerArm', [0.32, 1.29, 0]],
  ['leftHand', 'leftLowerArm', 'J_Bip_L_Hand', [0.54, 1.29, 0]],
  ['leftThumbMetacarpal', 'leftHand', 'J_Bip_L_Thumb1', [0.56, 1.28, 0.02]],
  ['leftThumbProximal', 'leftThumbMetacarpal', 'J_Bip_L_Thumb2', [0.585, 1.275, 0.04]],
  ['leftThumbDistal', 'leftThumbProximal', 'J_Bip_L_Thumb3', [0.61, 1.27, 0.052]],
  ['leftIndexProximal', 'leftHand', 'J_Bip_L_Index1', [0.625, 1.29, 0.025]],
  ['leftIndexIntermediate', 'leftIndexProximal', 'J_Bip_L_Index2', [0.66, 1.29, 0.027]],
  ['leftIndexDistal', 'leftIndexIntermediate', 'J_Bip_L_Index3', [0.682, 1.29, 0.028]],
  ['leftMiddleProximal', 'leftHand', 'J_Bip_L_Middle1', [0.63, 1.29, 0.004]],
  ['leftMiddleIntermediate', 'leftMiddleProximal', 'J_Bip_L_Middle2', [0.668, 1.29, 0.004]],
  ['leftMiddleDistal', 'leftMiddleIntermediate', 'J_Bip_L_Middle3', [0.692, 1.29, 0.004]],
  ['leftRingProximal', 'leftHand', 'J_Bip_L_Ring1', [0.625, 1.29, -0.015]],
  ['leftRingIntermediate', 'leftRingProximal', 'J_Bip_L_Ring2', [0.658, 1.29, -0.016]],
  ['leftRingDistal', 'leftRingIntermediate', 'J_Bip_L_Ring3', [0.68, 1.29, -0.017]],
  ['leftLittleProximal', 'leftHand', 'J_Bip_L_Little1', [0.615, 1.287, -0.032]],
  ['leftLittleIntermediate', 'leftLittleProximal', 'J_Bip_L_Little2', [0.64, 1.287, -0.034]],
  ['leftLittleDistal', 'leftLittleIntermediate', 'J_Bip_L_Little3', [0.657, 1.287, -0.035]],
  ['rightShoulder', 'upperChest', 'J_Bip_R_Shoulder', [-0.02, 1.29, 0]],
  ['rightUpperArm', 'rightShoulder', 'J_Bip_R_UpperArm', [-0.09, 1.29, 0]],
  ['rightLowerArm', 'rightUpperArm', 'J_Bip_R_LowerArm', [-0.32, 1.29, 0]],
  ['rightHand', 'rightLowerArm', 'J_Bip_R_Hand', [-0.54, 1.29, 0]],
  ['rightThumbMetacarpal', 'rightHand', 'J_Bip_R_Thumb1', [-0.56, 1.28, 0.02]],
  ['rightThumbProximal', 'rightThumbMetacarpal', 'J_Bip_R_Thumb2', [-0.585, 1.275, 0.04]],
  ['rightThumbDistal', 'rightThumbProximal', 'J_Bip_R_Thumb3', [-0.61, 1.27, 0.052]],
  ['rightIndexProximal', 'rightHand', 'J_Bip_R_Index1', [-0.625, 1.29, 0.025]],
  ['rightIndexIntermediate', 'rightIndexProximal', 'J_Bip_R_Index2', [-0.66, 1.29, 0.027]],
  ['rightIndexDistal', 'rightIndexIntermediate', 'J_Bip_R_Index3', [-0.682, 1.29, 0.028]],
  ['rightMiddleProximal', 'rightHand', 'J_Bip_R_Middle1', [-0.63, 1.29, 0.004]],
  ['rightMiddleIntermediate', 'rightMiddleProximal', 'J_Bip_R_Middle2', [-0.668, 1.29, 0.004]],
  ['rightMiddleDistal', 'rightMiddleIntermediate', 'J_Bip_R_Middle3', [-0.692, 1.29, 0.004]],
  ['rightRingProximal', 'rightHand', 'J_Bip_R_Ring1', [-0.625, 1.29, -0.015]],
  ['rightRingIntermediate', 'rightRingProximal', 'J_Bip_R_Ring2', [-0.658, 1.29, -0.016]],
  ['rightRingDistal', 'rightRingIntermediate', 'J_Bip_R_Ring3', [-0.68, 1.29, -0.017]],
  ['rightLittleProximal', 'rightHand', 'J_Bip_R_Little1', [-0.615, 1.287, -0.032]],
  ['rightLittleIntermediate', 'rightLittleProximal', 'J_Bip_R_Little2', [-0.64, 1.287, -0.034]],
  ['rightLittleDistal', 'rightLittleIntermediate', 'J_Bip_R_Little3', [-0.657, 1.287, -0.035]],
  ['leftUpperLeg', 'hips', 'J_Bip_L_UpperLeg', [0.08, 0.86, 0]],
  ['leftLowerLeg', 'leftUpperLeg', 'J_Bip_L_LowerLeg', [0.08, 0.48, 0.0]],
  ['leftFoot', 'leftLowerLeg', 'J_Bip_L_Foot', [0.08, 0.08, -0.01]],
  ['leftToes', 'leftFoot', 'J_Bip_L_ToeBase', [0.08, 0.02, 0.11]],
  ['rightUpperLeg', 'hips', 'J_Bip_R_UpperLeg', [-0.08, 0.86, 0]],
  ['rightLowerLeg', 'rightUpperLeg', 'J_Bip_R_LowerLeg', [-0.08, 0.48, 0.0]],
  ['rightFoot', 'rightLowerLeg', 'J_Bip_R_Foot', [-0.08, 0.08, -0.01]],
  ['rightToes', 'rightFoot', 'J_Bip_R_ToeBase', [-0.08, 0.02, 0.11]],
];

export const HUMANOID_NAMES = VROID_BONES.map((b) => b[0]);
export const HUMANOID_PARENT = Object.fromEntries(VROID_BONES.map((b) => [b[0], b[1]]));
export const VROID_NAME = Object.fromEntries(VROID_BONES.map((b) => [b[0], b[2]]));
export const HUMANOID_FROM_VROID = Object.fromEntries(VROID_BONES.map((b) => [b[2], b[0]]));
export const VROID_REST = Object.fromEntries(VROID_BONES.map((b) => [b[0], b[3]]));
export const VROID_ROOT_NAME = 'Root';

/** Bones VRM requires for a valid humanoid. */
export const REQUIRED_HUMANOID = [
  'hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
];

/** VRM 0.x humanoid names differ for thumbs. */
export const VRM0_NAME = {
  leftThumbMetacarpal: 'leftThumbProximal', leftThumbProximal: 'leftThumbIntermediate', leftThumbDistal: 'leftThumbDistal',
  rightThumbMetacarpal: 'rightThumbProximal', rightThumbProximal: 'rightThumbIntermediate', rightThumbDistal: 'rightThumbDistal',
};

/** The "next" bone used to find a bone's pointing direction. */
export const HUMANOID_CHILD = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck', neck: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', leftHand: 'leftMiddleProximal',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', rightHand: 'rightMiddleProximal',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
};
for (const side of ['left', 'right']) {
  for (const f of ['Index', 'Middle', 'Ring', 'Little']) {
    HUMANOID_CHILD[`${side}${f}Proximal`] = `${side}${f}Intermediate`;
    HUMANOID_CHILD[`${side}${f}Intermediate`] = `${side}${f}Distal`;
  }
  HUMANOID_CHILD[`${side}ThumbMetacarpal`] = `${side}ThumbProximal`;
  HUMANOID_CHILD[`${side}ThumbProximal`] = `${side}ThumbDistal`;
}

/** VRoid Studio face blend shape (morph target) names and readable aliases. */
export const VROID_SHAPE_KEYS = {
  Fcl_ALL_Neutral: 'Face.Neutral', Fcl_ALL_Angry: 'Face.Angry', Fcl_ALL_Fun: 'Face.Fun', Fcl_ALL_Joy: 'Face.Joy',
  Fcl_ALL_Sorrow: 'Face.Sorrow', Fcl_ALL_Surprised: 'Face.Surprised',
  Fcl_BRW_Angry: 'Brows.Angry', Fcl_BRW_Fun: 'Brows.Fun', Fcl_BRW_Joy: 'Brows.Joy', Fcl_BRW_Sorrow: 'Brows.Sorrow', Fcl_BRW_Surprised: 'Brows.Surprised',
  Fcl_EYE_Natural: 'Eyes.Natural', Fcl_EYE_Angry: 'Eyes.Angry', Fcl_EYE_Close: 'Eyes.Blink', Fcl_EYE_Close_R: 'Eyes.Blink.R', Fcl_EYE_Close_L: 'Eyes.Blink.L',
  Fcl_EYE_Fun: 'Eyes.Fun', Fcl_EYE_Joy: 'Eyes.Joy', Fcl_EYE_Joy_R: 'Eyes.Joy.R', Fcl_EYE_Joy_L: 'Eyes.Joy.L', Fcl_EYE_Sorrow: 'Eyes.Sorrow',
  Fcl_EYE_Surprised: 'Eyes.Surprised', Fcl_EYE_Spread: 'Eyes.Wide', Fcl_EYE_Iris_Hide: 'Eyes.IrisHide', Fcl_EYE_Highlight_Hide: 'Eyes.HighlightHide',
  Fcl_MTH_Close: 'Mouth.Close', Fcl_MTH_Up: 'Mouth.Up', Fcl_MTH_Down: 'Mouth.Down', Fcl_MTH_Angry: 'Mouth.Angry', Fcl_MTH_Small: 'Mouth.Small',
  Fcl_MTH_Large: 'Mouth.Large', Fcl_MTH_Neutral: 'Mouth.Neutral', Fcl_MTH_Fun: 'Mouth.Fun', Fcl_MTH_Joy: 'Mouth.Joy', Fcl_MTH_Sorrow: 'Mouth.Sorrow',
  Fcl_MTH_Surprised: 'Mouth.Surprised', Fcl_MTH_SkinFung: 'Mouth.Fang.Skin', Fcl_MTH_SkinFung_R: 'Mouth.Fang.Skin.R', Fcl_MTH_SkinFung_L: 'Mouth.Fang.Skin.L',
  Fcl_MTH_A: 'Viseme.A', Fcl_MTH_I: 'Viseme.I', Fcl_MTH_U: 'Viseme.U', Fcl_MTH_E: 'Viseme.E', Fcl_MTH_O: 'Viseme.O',
  Fcl_HA_Hide: 'Teeth.Hide', Fcl_HA_Fung1: 'Teeth.Fang', Fcl_HA_Fung1_Low: 'Teeth.Fang.Lower', Fcl_HA_Fung1_Up: 'Teeth.Fang.Upper',
  Fcl_HA_Fung2: 'Teeth.Fang2', Fcl_HA_Fung2_Low: 'Teeth.Fang2.Lower', Fcl_HA_Fung2_Up: 'Teeth.Fang2.Upper', Fcl_HA_Fung3: 'Teeth.Fang3',
  Fcl_HA_Fung3_Low: 'Teeth.Fang3.Lower', Fcl_HA_Fung3_Up: 'Teeth.Fang3.Upper', Fcl_HA_Short: 'Teeth.Short', Fcl_HA_Short_Low: 'Teeth.Short.Lower', Fcl_HA_Short_Up: 'Teeth.Short.Upper',
};

/** VRoid viseme morph names used for lip sync. */
export const VROID_VISEMES = { A: 'Fcl_MTH_A', I: 'Fcl_MTH_I', U: 'Fcl_MTH_U', E: 'Fcl_MTH_E', O: 'Fcl_MTH_O' };
