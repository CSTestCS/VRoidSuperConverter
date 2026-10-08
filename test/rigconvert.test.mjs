import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skinnedPerson, mixamoSpec, boxPerson } from './helpers.mjs';
import { autoRig } from '../src/core/autoRig.js';
import { convertToVRoid, worldPos } from '../src/core/retarget.js';
import { convertToProfile, convertToProvidedRig } from '../src/core/rigConvert.js';
import { getProfile, RIG_PROFILES, parseProfile } from '../src/core/rigProfiles.js';

const vroid = () => convertToVRoid(skinnedPerson(mixamoSpec('mixamorig')).root);

test('every built-in profile is valid', () => { for (const p of RIG_PROFILES) parseProfile(p); });

test('converts a VRoid model to the Tower Unite (UE4 mannequin) rig', () => {
  const out = convertToProfile(autoRig(boxPerson()), getProfile('tower-unite'));
  for (const n of ['root', 'pelvis', 'spine_03', 'upperarm_l', 'lowerarm_twist_01_r', 'ball_l', 'ik_foot_l']) assert.ok(out.getObjectByName(n), n);
  assert.ok(convertToProfile(vroid(), getProfile('tower-unite')).getObjectByName('index_03_l'), 'fingers when the model has them');
  const mesh = out.children.find((c) => c.isSkinnedMesh);
  assert.ok(mesh);
  const names = new Set(mesh.skeleton.bones.map((b) => b.name));
  assert.ok(!names.has('J_Bip_C_Hips'));
  // twist bone receives some weight
  const ti = mesh.skeleton.bones.findIndex((b) => b.name === 'upperarm_twist_01_l');
  const sw = mesh.geometry.attributes.skinWeight, si = mesh.geometry.attributes.skinIndex;
  let tw = 0; for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === ti) tw += sw.getComponent(i, k);
  assert.ok(tw > 0);
  // posing the new rig deforms the mesh
  out.getObjectByName('thigh_l').rotation.x = 1; out.updateMatrixWorld(true);
  { const bb = new THREE.Box3().setFromObject(mesh, true); assert.ok(Math.max(bb.max.z, -bb.min.z) > 0.3, 'leg swings'); }
});

test('converts to a provided rig in centimetres facing -Z, keeping its bone names', () => {
  const target = skinnedPerson(mixamoSpec('rig_').map(([n, p, pos]) => [n, p, [-pos[0] * 100, pos[1] * 100, -pos[2] * 100]])).root;
  const out = convertToProvidedRig(vroid(), target, { proportions: 'target' });
  out.updateMatrixWorld(true);
  const H = out.userData.humanoid;
  assert.equal(H.leftHand.name, 'rig_LeftHand');
  const mesh = out.userData.exportRoot.children.find((c) => c.isSkinnedMesh);
  assert.ok(mesh.skeleton.bones.includes(H.leftHand));
  // left hand of the converted model is on the rig's left hand (+X in our space)
  assert.ok(worldPos(H.leftHand).x > 0.4, `${worldPos(H.leftHand).x}`);
});
