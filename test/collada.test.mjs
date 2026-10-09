import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DOMParser } from '@xmldom/xmldom';
import { skinnedPerson, mixamoSpec } from './helpers.mjs';
import { convertToVRoid, worldPos } from '../src/core/retarget.js';
import { exportCollada } from '../src/formats/colladaExporter.js';

globalThis.DOMParser ??= DOMParser;
const { ColladaLoader } = await import('three/examples/jsm/loaders/ColladaLoader.js');

test('COLLADA export loads back with skeleton, skin and animation', async () => {
  const m = convertToVRoid(skinnedPerson(mixamoSpec('mixamorig')).root);
  const H = m.userData.humanoid;
  const clip = new THREE.AnimationClip('Wave', 1, [new THREE.QuaternionKeyframeTrack(`${H.leftUpperArm.name}.quaternion`, [0, 1], [0, 0, 0, 1, ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1).toArray()])]);
  const { dae } = await exportCollada(m, { clips: [clip], name: 'test' });
  const log = console.log; console.log = () => {};
  const r = new ColladaLoader().parse(dae, '');
  console.log = log;
  let sk = null;
  r.scene.traverse((o) => { if (o.isSkinnedMesh) sk = o; });
  assert.ok(sk, 'skinned mesh');
  assert.ok(sk.skeleton.bones.length > 50);
  assert.equal(r.scene.animations.length, 1);
  r.scene.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(r.scene);
  const a = mixer.clipAction(r.scene.animations[0]); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
  mixer.setTime(1);
  r.scene.updateMatrixWorld(true);
  const ua = r.scene.getObjectByName('J_Bip_L_UpperArm'), la = r.scene.getObjectByName('J_Bip_L_LowerArm');
  const dir = worldPos(la).sub(worldPos(ua)).normalize();
  assert.ok(Math.abs(dir.x - Math.cos(1)) < 0.02 && Math.abs(dir.y - Math.sin(1)) < 0.02, `arm follows the animation (${dir.toArray()})`);
});
