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

test('glTF/VRM UVs (top-left origin) are written bottom-left in FBX; FBX-sourced UVs are untouched', async () => {
  const { markTopLeftUVs } = await import('../src/core/uv.js');
  const { unzlibSync } = await import('fflate');
  const make = (name) => {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.attributes.uv.setXY(0, 0.25, 0.1); // distinctive, not symmetric
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial()); m.name = name; return m;
  };
  const g = new THREE.Group();
  const fromGltf = make('FromGltf'), fromFbx = make('FromFbx');
  const wrap = new THREE.Group(); wrap.add(fromGltf); markTopLeftUVs(wrap);
  g.add(wrap, fromFbx);
  const bytes = await exportFBX(g);
  const objects = parseFBXBinary(bytes).nodes.find((x) => x.name === 'Objects');
  const uvOf = (name) => {
    const geo = objects.children.find((c) => c.name === 'Geometry' && String(c.props[1]).startsWith(name));
    const p = geo.children.find((c) => c.name === 'LayerElementUV').children.find((c) => c.name === 'UV').props[0];
    const raw = new Uint8Array(p.encoding ? unzlibSync(p.bytes) : p.bytes);
    return new Float64Array(raw.buffer, raw.byteOffset, p.length);
  };
  assert.ok(Math.abs(uvOf('FromGltf')[1] - 0.9) < 1e-6, 'glTF v flipped to 1 - v');
  assert.ok(Math.abs(uvOf('FromFbx')[1] - 0.1) < 1e-6, 'bottom-left UVs unchanged');
  // DAE uses the same convention
  const { exportCollada } = await import('../src/formats/colladaExporter.js');
  const { dae } = await exportCollada(g);
  const uvArrays = [...dae.matchAll(/<float_array id="([^"]+)-uvs-array" count="\d+">([^<]+)</g)].map((m) => [m[1], m[2].split(' ').map(Number)]);
  assert.equal(uvArrays.find(([id]) => id.startsWith('FromGltf'))[1][1], 0.9);
  assert.equal(uvArrays.find(([id]) => id.startsWith('FromFbx'))[1][1], 0.1);
});
