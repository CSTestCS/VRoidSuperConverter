import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skinnedPerson, mixamoSpec } from './helpers.mjs';
import { convertToVRoid, worldPos } from '../src/core/retarget.js';
import { editHeadMotion } from '../src/core/headControl.js';
import { weldGeometry } from '../src/core/optimize.js';
import { addAsymmetricShapeKeys, renameShapeKeys, readableShapeKeyName } from '../src/core/shapeKeys.js';
import { solveTwoBone, addIKRig, solveModelIK, bakeIKToClip } from '../src/core/ik.js';
import { analyzeLipSync, formants, lipSyncClip } from '../src/core/lipsync.js';
import { exportVRoidPose, applyVRoidPose, storeRestPose } from '../src/formats/vroidPose.js';

const vroid = () => { const m = convertToVRoid(skinnedPerson(mixamoSpec('mixamorig')).root); storeRestPose(m); return m; };
const play = (model, clip, t) => {
  const mixer = new THREE.AnimationMixer(model);
  const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
  mixer.setTime(t); model.updateMatrixWorld(true); return mixer;
};
const headForward = (m) => new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m.userData.humanoid.head.matrixWorld)));

test('head control: fixed direction, removal and eye look-around', () => {
  const m = vroid();
  const H = m.userData.humanoid;
  const nod = new THREE.QuaternionKeyframeTrack(`${H.head.name}.quaternion`, [0, 1], [...new THREE.Quaternion().toArray(), ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5).toArray()]);
  const spineTurn = new THREE.QuaternionKeyframeTrack(`${H.spine.name}.quaternion`, [0, 1], [0, 0, 0, 1, ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6).toArray()]);
  const clip = new THREE.AnimationClip('c', 1, [nod, spineTurn]);

  const fixed = editHeadMotion(clip, m, { head: { mode: 'fixed', yaw: 30, pitch: 0, space: 'world' } });
  play(m, fixed, 1);
  const f = headForward(m);
  assert.ok(Math.abs(Math.atan2(f.x, f.z) * 180 / Math.PI - 30) < 1, `world-fixed yaw holds at 30° despite spine turn (${Math.atan2(f.x, f.z) * 180 / Math.PI})`);

  const removed = editHeadMotion(clip, m, { head: { mode: 'remove' } });
  play(vroid(), removed, 1);
  const m2 = vroid(); play(m2, removed, 1);
  const f2 = headForward(m2);
  assert.ok(Math.abs(f2.y) < 1e-3, 'nod removed');

  const eyes = editHeadMotion(clip, m, { eyes: { mode: 'lookAround', seed: 3, saccadeInterval: 0.15 } });
  assert.ok(eyes.tracks.some((t) => t.name === `${H.leftEye.name}.quaternion`));
  const tr = eyes.tracks.find((t) => t.name === `${H.leftEye.name}.quaternion`);
  const distinct = new Set(Array.from(tr.values).map((v) => v.toFixed(3)));
  assert.ok(distinct.size > 4, 'eyes move');
});

test('optimize welds coincident same-material vertices', () => {
  const geo = new THREE.BoxGeometry(1, 1, 1); // 24 verts, 8 positions
  geo.clearGroups();
  const r = weldGeometry(geo, { requireSameUV: false });
  assert.equal(r.before, 24);
  assert.equal(r.after, 8);
  assert.equal(r.geometry.index.count, 36);
  const seams = weldGeometry(geo, { requireSameUV: true });
  assert.ok(seams.after > 8);
  // different materials never weld
  const g2 = new THREE.BoxGeometry(1, 1, 1);
  g2.clearGroups(); g2.addGroup(0, 18, 0); g2.addGroup(18, 18, 1);
  assert.ok(weldGeometry(g2).after > 8);
});

test('asymmetric shape keys split left and right; readable rename', () => {
  const geo = new THREE.PlaneGeometry(2, 1, 10, 1);
  const delta = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) delta[i * 3 + 2] = 1;
  geo.morphAttributes.position = [new THREE.Float32BufferAttribute(delta, 3)];
  geo.morphTargetsRelative = true;
  const mesh = new THREE.Mesh(geo);
  mesh.morphTargetDictionary = { Fcl_EYE_Close: 0 };
  mesh.morphTargetInfluences = [0];
  const g = new THREE.Group(); g.add(mesh); g.updateMatrixWorld(true);
  const added = addAsymmetricShapeKeys(g, { blend: 0.1 });
  assert.equal(added.length, 2);
  const L = geo.morphAttributes.position[mesh.morphTargetDictionary['Fcl_EYE_Close.L']];
  const R = geo.morphAttributes.position[mesh.morphTargetDictionary['Fcl_EYE_Close.R']];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    assert.ok(Math.abs(L.getZ(i) + R.getZ(i) - 1) < 1e-6, 'L + R = original');
    if (pos.getX(i) > 0.1) assert.equal(L.getZ(i), 1);
    if (pos.getX(i) < -0.1) assert.equal(L.getZ(i), 0);
  }
  const map = renameShapeKeys(g, 'readable');
  assert.equal(map.Fcl_EYE_Close, 'Eyes.Blink');
  assert.ok(mesh.morphTargetDictionary['Eyes.Blink'] === 0);
  assert.equal(readableShapeKeyName('Fcl_MTH_Foo_Bar'), 'Mouth.Foo.Bar');
});

test('two-bone IK reaches the target and bends toward the pole; foot lock clamps to floor', () => {
  const m = vroid();
  const H = m.userData.humanoid;
  m.updateMatrixWorld(true);
  const target = worldPos(H.leftHand).add(new THREE.Vector3(-0.15, -0.2, 0.1));
  const pole = worldPos(H.leftLowerArm).add(new THREE.Vector3(0, 0, -1));
  solveTwoBone(H.leftUpperArm, H.leftLowerArm, H.leftHand, target, pole);
  m.updateMatrixWorld(true);
  assert.ok(worldPos(H.leftHand).distanceTo(target) < 1e-4);
  assert.ok(worldPos(H.leftLowerArm).z < worldPos(H.leftUpperArm).z, 'elbow bends toward the pole (-Z)');

  const m2 = vroid();
  addIKRig(m2);
  const t = m2.getObjectByName('IK_Foot_L');
  t.position.y += 0.2; t.position.z += 0.1;
  solveModelIK(m2);
  m2.updateMatrixWorld(true);
  assert.ok(worldPos(m2.userData.humanoid.leftFoot).distanceTo(worldPos(t)) < 1e-4);

  const m3 = vroid();
  const H3 = m3.userData.humanoid;
  const sink = new THREE.VectorKeyframeTrack(`${H3.hips.name}.position`, [0, 1], [...H3.hips.position.toArray(), H3.hips.position.x, H3.hips.position.y - 0.1, H3.hips.position.z]);
  const baked = bakeIKToClip(m3, new THREE.AnimationClip('sink', 1, [sink]), { footLock: false });
  play(m3, baked, 1);
  assert.ok(worldPos(H3.leftFoot).y > 0.07, 'foot stays above floor');
});

function vowel(f1, f2, rate = 16000, seconds = 0.4) {
  // glottal pulse train through two resonators
  const n = Math.round(rate * seconds), out = new Float32Array(n);
  const res = (f, bw) => { const r = Math.exp(-Math.PI * bw / rate); return [2 * r * Math.cos(2 * Math.PI * f / rate), -r * r]; };
  const [a1, b1] = res(f1, 80), [a2, b2] = res(f2, 100);
  let y1 = 0, y11 = 0, z1 = 0, z11 = 0;
  for (let i = 0; i < n; i++) {
    const x = i % Math.round(rate / 180) === 0 ? 1 : 0;
    const v1 = x + a1 * y1 + b1 * y11; y11 = y1; y1 = v1;
    const v2 = v1 + a2 * z1 + b2 * z11; z11 = z1; z1 = v2;
    out[i] = v2 * 0.01;
  }
  let mx = 0; for (const s of out) mx = Math.max(mx, Math.abs(s));
  for (let i = 0; i < n; i++) out[i] *= 0.3 / mx;
  return out;
}

test('lip sync detects formants and classifies vowels', () => {
  const a = vowel(850, 1400), i = vowel(320, 2700);
  const fa = formants(a.subarray(2000, 2400).filter((_, k) => k % 1 === 0), 16000);
  assert.ok(fa && Math.abs(fa[0] - 850) < 150, `F1 ${fa}`);
  const silence = new Float32Array(3200);
  const audio = { channels: [Float32Array.from([...a, ...silence, ...i])], sampleRate: 16000 };
  const frames = analyzeLipSync(audio, { fps: 30, attack: 1, release: 1 });
  const at = (sec) => frames[Math.round(sec * 30)];
  assert.ok(at(0.2).A > 0.5, `A frame ${JSON.stringify(at(0.2))}`);
  assert.ok(at(0.5).A + at(0.5).I < 0.05, 'silence closes the mouth');
  assert.ok(at(0.8).I > 0.5, `I frame ${JSON.stringify(at(0.8))}`);
  const m = new THREE.Mesh(new THREE.BufferGeometry());
  m.morphTargetDictionary = { Fcl_MTH_A: 0, Fcl_MTH_I: 1 }; m.morphTargetInfluences = [0, 0];
  const clip = lipSyncClip(m, frames);
  assert.equal(clip.tracks.length, 2);
});

test('vroidpose export/import round trip', () => {
  const m = vroid();
  const H = m.userData.humanoid;
  H.leftUpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.8);
  H.hips.position.y -= 0.05;
  m.updateMatrixWorld(true);
  const pose = JSON.parse(JSON.stringify(exportVRoidPose(m)));
  assert.ok(pose.BoneDefinition.LeftUpperArm.Rotation);
  // mirrored into Unity space: z rotation flips sign
  assert.ok(pose.BoneDefinition.LeftUpperArm.Rotation.z > 0);
  const m2 = vroid();
  applyVRoidPose(m2, pose);
  assert.ok(m2.userData.humanoid.leftUpperArm.quaternion.angleTo(H.leftUpperArm.quaternion) < 1e-5);
  assert.ok(Math.abs(m2.userData.humanoid.hips.position.y - H.hips.position.y) < 1e-5);
});
