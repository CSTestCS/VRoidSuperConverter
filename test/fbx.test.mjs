import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { skinnedPerson, mixamoSpec } from './helpers.mjs';
import { convertToVRoid, worldPos } from '../src/core/retarget.js';
import { exportFBX, parseFBXBinary } from '../src/formats/fbxExporter.js';

test('FBX export loads back with skeleton, skin, blend shapes and animation', async () => {
  const model = convertToVRoid(skinnedPerson(mixamoSpec('mixamorig')).root);
  const mesh = model.children.find((c) => c.isSkinnedMesh);
  // add a morph target
  const n = mesh.geometry.attributes.position.count;
  const d = new Float32Array(n * 3); for (let i = 0; i < n; i++) d[i * 3 + 1] = 0.1;
  mesh.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(d, 3)];
  mesh.geometry.morphTargetsRelative = true;
  mesh.morphTargetDictionary = { Fcl_MTH_A: 0 }; mesh.morphTargetInfluences = [0];
  const H = model.userData.humanoid;
  const clip = new THREE.AnimationClip('Wave', 1, [
    new THREE.QuaternionKeyframeTrack(`${H.leftUpperArm.name}.quaternion`, [0, 1], [0, 0, 0, 1, ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1).toArray()]),
    new THREE.NumberKeyframeTrack(`${mesh.uuid}.morphTargetInfluences[Fcl_MTH_A]`, [0, 1], [0, 1]),
  ]);
  const bytes = await exportFBX(model, { clips: [clip], units: 'cm' });
  const parsed = parseFBXBinary(bytes);
  assert.equal(parsed.version, 7400);
  const objects = parsed.nodes.find((x) => x.name === 'Objects');
  assert.ok(objects.children.filter((c) => c.name === 'Deformer' && c.props[2] === 'Cluster').length > 20);

  const loaded = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  let sk = null;
  loaded.traverse((o) => { if (o.isSkinnedMesh) sk = o; });
  assert.ok(sk, 'skinned mesh loaded');
  assert.ok(sk.skeleton.bones.some((b) => b.name === 'J_Bip_L_UpperArm'));
  assert.ok(sk.morphTargetDictionary && 'Fcl_MTH_A' in sk.morphTargetDictionary, 'blend shape loaded');
  assert.equal(loaded.animations.length, 1);
  loaded.updateMatrixWorld(true);
  // units: centimetres in file; hand at ~54cm from centre
  const hand = loaded.getObjectByName('J_Bip_L_Hand');
  const hp = worldPos(hand);
  assert.ok(Math.abs(hp.x - 54) < 2 && Math.abs(hp.y - 129) < 3, `hand at ${hp.toArray()}`);
  // animation reproduces the arm rotation
  const mixer = new THREE.AnimationMixer(loaded);
  const a = mixer.clipAction(loaded.animations[0]); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play();
  mixer.setTime(1); loaded.updateMatrixWorld(true);
  const ua = loaded.getObjectByName('J_Bip_L_UpperArm'), la = loaded.getObjectByName('J_Bip_L_LowerArm');
  const dir = worldPos(la).sub(worldPos(ua)).normalize();
  assert.ok(Math.abs(dir.x - Math.cos(1)) < 0.02 && Math.abs(dir.y - Math.sin(1)) < 0.02, `arm dir ${dir.toArray()}`);
  // skinning in the loaded file deforms the hand vertices consistently
  const v = new THREE.Vector3(); let maxY = -Infinity;
  for (let i = 0; i < sk.geometry.attributes.position.count; i++) { sk.getVertexPosition(i, v); v.applyMatrix4(sk.matrixWorld); maxY = Math.max(maxY, v.y); }
  assert.ok(maxY > 150, `raised arm geometry reaches up (${maxY})`);
});
