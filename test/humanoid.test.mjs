import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHumanoid, parseBoneName, validateHumanoid } from '../src/core/humanoid.js';
import { buildSkeleton, mixamoSpec, vroidSpec } from './helpers.mjs';
import { VROID_BONES } from '../src/core/vroidSkeleton.js';

test('parses common naming conventions', () => {
  const cases = [
    ['mixamorig:LeftUpLeg', 'left', 'upperLeg'], ['mixamorig:RightForeArm', 'right', 'lowerArm'],
    ['ValveBiped.Bip01_L_Thigh', 'left', 'upperLeg'], ['Bip01 R Calf', 'right', 'lowerLeg'],
    ['upperarm_l', 'left', 'upperArm'], ['thigh_r', 'right', 'upperLeg'], ['clavicle_l', 'left', 'shoulder'],
    ['UpperArm.L', 'left', 'upperArm'], ['Left elbow', 'left', 'lowerArm'],
    ['左腕', 'left', 'upperArm'], ['右ひざ', 'right', 'lowerLeg'], ['左足首', 'left', 'foot'], ['左足', 'left', 'upperLeg'],
    ['Hips', null, 'hips'], ['pelvis', null, 'hips'], ['neck_01', null, 'neck'], ['頭', null, 'head'],
  ];
  for (const [name, side, part] of cases) {
    const p = parseBoneName(name);
    assert.equal(p.part, part, name);
    assert.equal(p.side, side, name);
  }
  assert.equal(parseBoneName('upperarm_twist_01_l').part, null);
  assert.equal(parseBoneName('mixamorig:HeadTop_End').part, null);
  assert.equal(parseBoneName('mixamorig:LeftHandIndex2').finger, 'Index');
  assert.equal(parseBoneName('J_Bip_L_UpperArm').humanoid, 'leftUpperArm');
});

test('detects a Mixamo rig fully', () => {
  const { root } = buildSkeleton(mixamoSpec());
  const h = detectHumanoid(root);
  assert.equal(h.bones.hips.name, 'mixamorig:Hips');
  assert.equal(h.bones.spine.name, 'mixamorig:Spine');
  assert.equal(h.bones.chest.name, 'mixamorig:Spine1');
  assert.equal(h.bones.upperChest.name, 'mixamorig:Spine2');
  assert.equal(h.bones.leftLowerArm.name, 'mixamorig:LeftForeArm');
  assert.equal(h.bones.rightToes.name, 'mixamorig:RightToeBase');
  assert.equal(h.bones.leftIndexDistal.name, 'mixamorig:LeftHandIndex3');
  assert.equal(h.bones.leftThumbMetacarpal.name, 'mixamorig:LeftHandThumb1');
  assert.equal(h.facing, 1);
  assert.ok(validateHumanoid(h).ok);
});

test('detects a VRoid rig by exact names', () => {
  const { root } = buildSkeleton(vroidSpec());
  const h = detectHumanoid(root);
  for (const [k, , name] of VROID_BONES) assert.equal(h.bones[k]?.name, name, k);
});

test('detects an unnamed rig from topology alone', () => {
  // rename every bone to an opaque id
  const spec = mixamoSpec('').map(([n, p, pos]) => [n, p, pos]);
  const ids = new Map(spec.map(([n], i) => [n, `bone_${String(i).padStart(3, '0')}`]));
  const anon = spec.map(([n, p, pos]) => [ids.get(n), p ? ids.get(p) : null, pos]);
  const { root } = buildSkeleton(anon);
  const h = detectHumanoid(root);
  const expect = (k, mixName) => assert.equal(h.bones[k]?.name, ids.get(mixName), `${k}`);
  expect('hips', 'Hips');
  expect('head', 'Head');
  expect('neck', 'Neck');
  expect('spine', 'Spine');
  expect('leftUpperLeg', 'LeftUpLeg');
  expect('leftLowerLeg', 'LeftLeg');
  expect('leftFoot', 'LeftFoot');
  expect('rightHand', 'RightHand');
  expect('rightLowerArm', 'RightForeArm');
  expect('rightUpperArm', 'RightArm');
  expect('leftShoulder', 'LeftShoulder');
  assert.ok(validateHumanoid(h).ok, JSON.stringify(validateHumanoid(h).missing));
});

test('detects an MMD-style rig (upper body sibling of lower body)', () => {
  const spec = [
    ['全ての親', null, [0, 0, 0]], ['センター', '全ての親', [0, 0.8, 0]],
    ['上半身', 'センター', [0, 0.95, 0]], ['上半身2', '上半身', [0, 1.1, 0]], ['首', '上半身2', [0, 1.33, 0]], ['頭', '首', [0, 1.4, 0]],
    ['左肩', '上半身2', [0.03, 1.29, 0]], ['左腕', '左肩', [0.09, 1.29, 0]], ['左ひじ', '左腕', [0.32, 1.29, 0]], ['左手首', '左ひじ', [0.54, 1.29, 0]],
    ['右肩', '上半身2', [-0.03, 1.29, 0]], ['右腕', '右肩', [-0.09, 1.29, 0]], ['右ひじ', '右腕', [-0.32, 1.29, 0]], ['右手首', '右ひじ', [-0.54, 1.29, 0]],
    ['下半身', 'センター', [0, 0.92, 0]],
    ['左足', '下半身', [0.08, 0.86, 0]], ['左ひざ', '左足', [0.08, 0.48, 0]], ['左足首', '左ひざ', [0.08, 0.08, 0]], ['左つま先', '左足首', [0.08, 0.02, 0.1]],
    ['右足', '下半身', [-0.08, 0.86, 0]], ['右ひざ', '右足', [-0.08, 0.48, 0]], ['右足首', '右ひざ', [-0.08, 0.08, 0]], ['右つま先', '右足首', [-0.08, 0.02, 0.1]],
    ['左足ＩＫ', '全ての親', [0.08, 0.08, 0]],
  ];
  const { root } = buildSkeleton(spec);
  const h = detectHumanoid(root);
  assert.equal(h.bones.hips.name, '下半身');
  assert.equal(h.bones.spine.name, '上半身');
  assert.equal(h.bones.chest.name, '上半身2');
  assert.equal(h.bones.leftFoot.name, '左足首');
  assert.equal(h.bones.rightToes.name, '右つま先');
  assert.ok(validateHumanoid(h).ok);
  assert.ok(validateHumanoid(h).warnings.some((w) => w.startsWith('spine')));
});
