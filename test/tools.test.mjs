import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skinnedPerson, mixamoSpec } from './helpers.mjs';
import { convertToVRoid, worldPos } from '../src/core/retarget.js';
import { editHeadMotion } from '../src/core/headControl.js';
import { weldGeometry } from '../src/core/optimize.js';
import { addAsymmetricShapeKeys, renameShapeKeys, readableShapeKeyName, listShapeKeys, setShapeKeyWeight } from '../src/core/shapeKeys.js';
import { solveTwoBone, addIKRig, solveModelIK, bakeIKToClip } from '../src/core/ik.js';
import { analyzeLipSync, formants, lipSyncClip, isolateVoice } from '../src/core/lipsync.js';
import { exportVRoidPose, applyVRoidPose, storeRestPose, stringifyVRoidPose } from '../src/formats/vroidPose.js';

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

test('vroidpose matches the VRoid Studio layout and round-trips a real pose file', async () => {
  const { readFileSync } = await import('node:fs');
  const real = JSON.parse(readFileSync(new URL('./fixtures/MikuPose.vroidpose', import.meta.url), 'utf8'));
  const m = vroid();
  const unknown = applyVRoidPose(m, real);
  assert.deepEqual(unknown, []);
  const out = exportVRoidPose(m, { leftHand: real.LeftHandAnimationName, rightHand: real.RightHandAnimationName });
  assert.equal(out.Version, 1);
  assert.equal(out.LeftHandAnimationName, 'L_Open');
  for (const [k, q] of Object.entries(real.BoneDefinition)) {
    if (k === 'SpineControlPointDeltaPosition') continue;
    const o = out.BoneDefinition[k];
    assert.ok(o, k);
    if (k === 'HipsPosition') { for (const c of ['x', 'y', 'z']) assert.ok(Math.abs(o[c] - q[c]) < 1e-4, `${k}.${c}`); continue; }
    const a = new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize(), b = new THREE.Quaternion(o.x, o.y, o.z, o.w);
    assert.ok(a.angleTo(b) < 1e-3, `${k} rotation round-trips`);
    assert.equal(o.Rotation, undefined, 'quaternions are stored directly, not wrapped');
  }
  // Same keys as VRoid writes
  for (const k of Object.keys(real.BoneDefinition)) assert.ok(k in out.BoneDefinition, `has ${k}`);
  const text = stringifyVRoidPose(out);
  assert.match(text, /"LeftHandAnimationWeight":1\.0/);
  // left arm lowering in our space (rotation about -Z) is stored with +z like VRoid's A-stance
  const m2 = vroid();
  m2.userData.humanoid.leftUpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.8);
  assert.ok(exportVRoidPose(m2).BoneDefinition.LeftUpperArm.z > 0);
});

test('lip sync voice focus ignores panned music and noise between words', () => {
  const rate = 16000;
  const a = vowel(850, 1400, rate, 0.4);
  const gap = new Float32Array(Math.round(rate * 0.4));
  const voice = Float32Array.from([...a, ...gap, ...a]);
  const n = voice.length;
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const music = 0.25 * Math.sign(Math.sin(2 * Math.PI * 330 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t)); // square-ish synth, hard left
    L[i] = voice[i] + music + 0.05 * rnd();
    R[i] = voice[i] + 0.05 * rnd();
  }
  const at = (frames, sec) => frames[Math.round(sec * 30)];
  const plain = analyzeLipSync({ channels: [L, R], sampleRate: rate }, { attack: 1, release: 1 });
  const focused = analyzeLipSync({ channels: [L, R], sampleRate: rate }, { attack: 1, release: 1, voiceFocus: 'isolate', voicingThreshold: 0.5 });
  const open = (f) => f.A + f.I + f.U + f.E + f.O;
  assert.ok(open(at(plain, 0.6)) > 0.2, 'without voice focus the music opens the mouth in the gap');
  assert.ok(open(at(focused, 0.6)) < 0.05, `with voice focus the gap stays closed (${open(at(focused, 0.6))})`);
  assert.ok(at(focused, 0.2).A > 0.4, `vowel still detected (${JSON.stringify(at(focused, 0.2))})`);
  assert.ok(isolateVoice([L, R], rate, { voiceFocus: 'isolate', noiseReduction: 0.6, voiceLowHz: 90, voiceHighHz: 4000, centerFocus: 0.8 }).length === n);
});

test('shape key rename replaces prefixed VRoid names on every primitive; grouped preview drives all meshes', () => {
  const g = new THREE.Group();
  for (let k = 0; k < 3; k++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    m.morphTargetDictionary = { 'Face_Blendshape.Fcl_EYE_Close': 0, 'Face_Blendshape.Fcl_MTH_A': 1 };
    m.morphTargetInfluences = [0, 0];
    g.add(m);
  }
  const map = renameShapeKeys(g, 'readable');
  assert.equal(map['Face_Blendshape.Fcl_EYE_Close'], 'Eyes.Blink');
  for (const m of g.children) assert.deepEqual(Object.keys(m.morphTargetDictionary), ['Eyes.Blink', 'Viseme.A']);
  const keys = listShapeKeys(g);
  assert.deepEqual([...keys.keys()], ['Eyes.Blink', 'Viseme.A']);
  assert.equal(keys.get('Eyes.Blink').length, 3);
  setShapeKeyWeight(g, 'Eyes.Blink', 0.7);
  for (const m of g.children) assert.equal(m.morphTargetInfluences[0], 0.7);
  renameShapeKeys(g, 'vroid');
  assert.deepEqual(Object.keys(g.children[0].morphTargetDictionary), ['Fcl_EYE_Close', 'Fcl_MTH_A']);
});
