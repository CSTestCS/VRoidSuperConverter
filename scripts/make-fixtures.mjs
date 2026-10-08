// Generates sample input files (Mixamo-style FBX model + animation, BVH, OBJ, DIVA farc) for smoke tests.
import { writeFile, mkdir } from 'node:fs/promises';
import * as THREE from 'three';
import { skinnedPerson, mixamoSpec, boxPerson } from '../test/helpers.mjs';
import { exportFBX } from '../src/formats/fbxExporter.js';
import { writeFarc } from '../src/diva/farc.js';
import { writeObjectSet, MATERIAL_SIZE } from '../src/diva/objset.js';
import { writeTextureSet } from '../src/diva/texset.js';
import { BinWriter } from '../src/diva/binary.js';

const out = process.argv[2] ?? 'fixtures';
await mkdir(out, { recursive: true });

// 1. rigged Mixamo-like model (cm) with a waving animation
const { root } = skinnedPerson(mixamoSpec('mixamorig'));
const ua = root.getObjectByName('mixamorigLeftArm');
const q = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a).toArray();
const wave = new THREE.AnimationClip('Wave', 2, [new THREE.QuaternionKeyframeTrack(`${ua.name}.quaternion`, [0, 1, 2], [...q(0), ...q(1.2), ...q(0)])]);
await writeFile(`${out}/mixamo_wave.fbx`, await exportFBX(root, { clips: [wave], units: 'cm' }));

// 2. unrigged box person (OBJ)
const g = boxPerson();
const pos = g.children[0].geometry.attributes.position;
let obj = '';
for (let i = 0; i < pos.count; i++) obj += `v ${pos.getX(i)} ${pos.getY(i)} ${pos.getZ(i)}\n`;
for (let i = 0; i < pos.count; i += 3) obj += `f ${i + 1} ${i + 2} ${i + 3}\n`;
await writeFile(`${out}/box_person.obj`, obj);

// 3. BVH animation (centimetres, raises the left arm)
const tree = ['Hips', [0, 92, 0], [
  ['Spine', [0, 8, 0], [['Neck', [0, 33, 0], [['Head', [0, 7, 0], [], [0, 20, 0]]]],
    ['LeftShoulder', [2, 30, 0], [['LeftArm', [7, 0, 0], [['LeftForeArm', [23, 0, 0], [['LeftHand', [22, 0, 0], [], [8, 0, 0]]]]]]]],
    ['RightShoulder', [-2, 30, 0], [['RightArm', [-7, 0, 0], [['RightForeArm', [-23, 0, 0], [['RightHand', [-22, 0, 0], [], [-8, 0, 0]]]]]]]]]],
  ['LeftUpLeg', [8, -6, 0], [['LeftLeg', [0, -38, 0], [['LeftFoot', [0, -40, 0], [], [0, -6, 11]]]]]],
  ['RightUpLeg', [-8, -6, 0], [['RightLeg', [0, -38, 0], [['RightFoot', [0, -40, 0], [], [0, -6, 11]]]]]],
]];
const order = [];
const emit = ([name, off, kids, end], depth, root) => {
  const pad = '  '.repeat(depth);
  order.push(name);
  let t = `${pad}${root ? 'ROOT' : 'JOINT'} ${name}\n${pad}{\n${pad}  OFFSET ${off.join(' ')}\n${pad}  CHANNELS ${root ? '6 Xposition Yposition Zposition ' : '3 '}Zrotation Xrotation Yrotation\n`;
  for (const k of kids) t += emit(k, depth + 1, false);
  if (end) t += `${pad}  End Site\n${pad}  {\n${pad}    OFFSET ${end.join(' ')}\n${pad}  }\n`;
  return `${t}${pad}}\n`;
};
const hier = emit(tree, 0, true);
const frames = [0, 45, 0].map((a) => order.map((nm) => (nm === 'Hips' ? '0 92 0 0 0 0' : nm === 'LeftArm' ? `${a} 0 0` : '0 0 0')).join(' '));
await writeFile(`${out}/arm_raise.bvh`, `HIERARCHY\n${hier}MOTION\nFrames: ${frames.length}\nFrame Time: 0.5\n${frames.join('\n')}\n`);

// 4. DIVA farc with one object
const mat = new Uint8Array(MATERIAL_SIZE);
new DataView(mat.buffer).setUint32(20 + 4, 77, true);
for (let i = 1; i < 8; i++) new DataView(mat.buffer).setUint32(20 + i * 120 + 4, 0xffffffff, true);
new DataView(mat.buffer).setFloat32(20 + 960 + 4, 1, true); new DataView(mat.buffer).setFloat32(20 + 960 + 8, 0.5, true); new DataView(mat.buffer).setFloat32(20 + 960 + 12, 0.5, true);
const box = new THREE.BoxGeometry(0.3, 0.3, 0.3).toNonIndexed();
const n = box.attributes.position.count;
const set = { format: 'FT', textureIds: [77], objects: [{ name: 'MIKITM001', id: 1, boundingSphere: [0, 0, 0, 1], materials: [{ raw: mat, textureIds: [77], diffuse: [1, 0.5, 0.5, 1], name: 'm' }],
  meshes: [{ name: 'box', flags: 0, boundingSphere: [0, 0, 0, 1], positions: Float32Array.from(box.attributes.position.array), normals: Float32Array.from(box.attributes.normal.array), uv0: Float32Array.from(box.attributes.uv.array),
    subMeshes: [0, 1].map((k) => ({ boundingSphere: [0, 0, 0, 1], materialIndex: 0, texCoordIndices: new Uint8Array(8), boneIndices: null, bonesPerVertex: 0, primitiveType: 4, indexFormat: 1, indices: Uint32Array.from({ length: n / 2 }, (_, i) => i + k * n / 2), flags: 0, indexOffset: 0 })) }],
  skin: { bones: [{ id: 0, isEx: false, name: 'n_hara_cp', ibm: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), parentName: null }], blocks: [] } }] };
const tw = new BinWriter(true);
tw.u32(0x04505854); tw.i32(1); tw.i32(0x01010101); tw.u32(16);
tw.u32(0x02505854); tw.i32(4); tw.i32(4); tw.i32(2); tw.i32(0); tw.i32(64); tw.bytes(new Uint8Array(64).fill(200));
await writeFile(`${out}/mikitm001.farc`, writeFarc([{ name: 'mikitm001_obj.bin', data: writeObjectSet(set) }, { name: 'mikitm001_tex.bin', data: writeTextureSet([{ raw: tw.toBytes() }]) }]));

// 5. audio: vowel-like WAV
const rate = 16000, secs = 1.2, N = Math.round(rate * secs);
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) { const t = i / rate; const env = t < 0.5 || t > 0.7 ? 1 : 0; pcm[i] = env * 8000 * (Math.sin(2 * Math.PI * 850 * t) * 0.6 + Math.sin(2 * Math.PI * 1400 * t) * 0.4) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 180 * t)); }
const wav = new DataView(new ArrayBuffer(44 + N * 2));
const s = (o, str) => [...str].forEach((c, i) => wav.setUint8(o + i, c.charCodeAt(0)));
s(0, 'RIFF'); wav.setUint32(4, 36 + N * 2, true); s(8, 'WAVE'); s(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true); wav.setUint16(22, 1, true);
wav.setUint32(24, rate, true); wav.setUint32(28, rate * 2, true); wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); s(36, 'data'); wav.setUint32(40, N * 2, true);
pcm.forEach((v, i) => wav.setInt16(44 + i * 2, v, true));
await writeFile(`${out}/voice.wav`, new Uint8Array(wav.buffer));
console.log('fixtures written to', out);
