import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { skinnedPerson, mixamoSpec } from './helpers.mjs';
import { detectHumanoid } from '../src/core/humanoid.js';
import { convertToVRoid, retargetClip, worldPos } from '../src/core/retarget.js';
import { VROID_NAME } from '../src/core/vroidSkeleton.js';

function aPoseMixamoInCm() {
  // Mixamo-style, centimetres, arms lowered 45° (A-pose)
  const spec = mixamoSpec('mixamorig').map(([n, p, pos]) => {
    let [x, y, z] = pos;
    if (Math.abs(x) > 0.1 && y > 1.1) { // arm chain below shoulder
      const sx = Math.sign(x), dx = Math.abs(x) - 0.09;
      x = sx * (0.09 + dx * Math.SQRT1_2); y = 1.29 - dx * Math.SQRT1_2;
    }
    return [n, p, [x * 100, y * 100, z * 100]];
  });
  return skinnedPerson(spec);
}

test('converts a centimetre A-pose Mixamo rig into a T-posed VRoid skeleton', () => {
  const { root } = aPoseMixamoInCm();
  const out = convertToVRoid(root, { keepExtraBones: true });
  const H = out.userData.humanoid;
  for (const k of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftHand', 'rightFoot', 'leftIndexDistal']) assert.equal(H[k].name, VROID_NAME[k]);
  assert.ok(H.leftEye, 'eyes synthesised');
  out.updateMatrixWorld(true);
  const ua = worldPos(H.leftUpperArm), hand = worldPos(H.leftHand);
  assert.ok(Math.abs(ua.y - hand.y) < 1e-3, 'arm horizontal after T-pose');
  assert.ok(hand.x > ua.x + 0.4, 'arm points to +X (left side)');
  assert.ok(Math.abs(worldPos(H.hips).y - 0.92) < 0.05, 'converted to metres');
  // all bone world rotations are identity
  out.traverse((o) => { if (o.isBone) { const q = new THREE.Quaternion(); o.matrixWorld.decompose(new THREE.Vector3(), q, new THREE.Vector3()); assert.ok(Math.abs(q.w) > 0.9999, o.name); } });
  // mesh vertices of the hand cube followed the arm
  const mesh = out.children.find((c) => c.isSkinnedMesh);
  const pos = mesh.geometry.attributes.position;
  let maxX = -Infinity;
  for (let i = 0; i < pos.count; i++) maxX = Math.max(maxX, pos.getX(i));
  assert.ok(maxX > 0.6, `hand geometry moved out to the T-pose (maxX=${maxX})`);
  assert.ok(out.getObjectByName('mixamorigHeadTop_End'), 'extra bones kept');
});

test('retargets a Mixamo animation onto the VRoid rig (A-pose source, T-pose target)', () => {
  const { root } = aPoseMixamoInCm();
  const srcH = detectHumanoid(root);
  const target = convertToVRoid(skinnedPerson(mixamoSpec()).root);
  const tgtH = { root: target, bones: target.userData.humanoid };
  // Source animation: raise left upper arm to horizontal (rotate +45° about Z in source world) and translate hips
  const ua = srcH.bones.leftUpperArm;
  const q0 = ua.quaternion.clone();
  const q1 = q0.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4));
  const hipsP = srcH.bones.hips.position;
  const clip = new THREE.AnimationClip('raise', 1, [
    new THREE.QuaternionKeyframeTrack(`${ua.name}.quaternion`, [0, 1], [...q0.toArray(), ...q1.toArray()]),
    new THREE.VectorKeyframeTrack(`${srcH.bones.hips.name}.position`, [0, 1], [hipsP.x, hipsP.y, hipsP.z, hipsP.x, hipsP.y + 10, hipsP.z]),
  ]);
  const out = retargetClip(clip, { root, bones: srcH.bones, facing: srcH.facing }, tgtH, { fps: 10 });
  const mixer = new THREE.AnimationMixer(target);
  const act = mixer.clipAction(out); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.play();
  mixer.setTime(0);
  target.updateMatrixWorld(true);
  const B = target.userData.humanoid;
  let d = worldPos(B.leftLowerArm).sub(worldPos(B.leftUpperArm)).normalize();
  assert.ok(d.y < -0.6, `frame 0: target arm is lowered like the A-pose source (dir.y=${d.y.toFixed(2)})`);
  mixer.setTime(1);
  target.updateMatrixWorld(true);
  d = worldPos(B.leftLowerArm).sub(worldPos(B.leftUpperArm)).normalize();
  assert.ok(d.x > 0.99, `frame end: target arm horizontal (dir=${d.toArray().map((v) => v.toFixed(2))})`);
  const hy = worldPos(B.hips).y;
  assert.ok(Math.abs(hy - (0.92 + 0.1)) < 0.02, `hips moved up 10cm scaled to metres (y=${hy})`);
});
