import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFarc, writeFarc } from '../src/diva/farc.js';
import { readObjectSet, writeObjectSet, MATERIAL_SIZE, triangleIndices } from '../src/diva/objset.js';
import { readTextureSet, writeTextureSet, decodeTexture } from '../src/diva/texset.js';
import { readSkinParams, writeSkinParams } from '../src/diva/skinParam.js';
import { loadDivaSource, mergeDivaSources, readObjectDatabase, mostSimilarParam } from '../src/diva/divaMerge.js';
import { readFileSync } from 'node:fs';
import { aesDecryptEcb, aesDecryptCbc, aesEncryptEcb } from '../src/diva/aes.js';
import { BinWriter } from '../src/diva/binary.js';

function material(name, texId) {
  const raw = new Uint8Array(MATERIAL_SIZE);
  const dv = new DataView(raw.buffer);
  dv.setUint32(0, 1, true);
  for (let i = 0; i < 8; i++) dv.setUint32(20 + i * 120 + 4, i === 0 ? texId : 0xffffffff, true);
  dv.setFloat32(20 + 960 + 4, 1, true);
  raw.set(new TextEncoder().encode(name), 1072);
  return { raw, textureIds: [texId, ...Array(7).fill(0xffffffff)], diffuse: [1, 1, 1, 1], name };
}

function quadMesh(name, x, boneCount) {
  const positions = new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x + 2, 0, 0, x + 2, 1, 0]);
  const n = positions.length / 3;
  return {
    name, flags: 0, boundingSphere: [0, 0, 0, 1], vertexCount: n, positions,
    normals: new Float32Array(n * 3).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    uv0: new Float32Array(n * 2),
    blendWeights: new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)),
    blendIndices: new Int16Array(n * 4).map((_, i) => (i % 4 === 0 ? 0 : -1)),
    subMeshes: [
      { boundingSphere: [0, 0, 0, 1], materialIndex: 0, texCoordIndices: new Uint8Array(8), boneIndices: Uint16Array.from({ length: boneCount }, (_, i) => i), bonesPerVertex: 4, primitiveType: 4, indexFormat: 1, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]), flags: 0, indexOffset: 0 },
      { boundingSphere: [0, 0, 0, 1], materialIndex: 0, texCoordIndices: new Uint8Array(8), boneIndices: Uint16Array.from({ length: boneCount }, (_, i) => i), bonesPerVertex: 4, primitiveType: 5, indexFormat: 1, indices: Uint32Array.from([1, 4, 2, 5]), flags: 0, indexOffset: 0 },
    ],
  };
}

function osage(ext, nodes) {
  return {
    type: 'OSG', parentName: 'j_kao_wj', position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    externalName: ext, name: ext.replace('_osg', ''),
    nodes: nodes.map((n, i) => ({ name: n, length: 0.1, rotation: [0, 0.1 * (i + 1), 0], siblingName: null, siblingMaxDistance: 0 })),
  };
}

function texture(w, h, fill) {
  const tw = new BinWriter(true);
  tw.u32(0x04505854); tw.i32(1); tw.i32(0x01010101); tw.u32(16);
  tw.u32(0x02505854); tw.i32(w); tw.i32(h); tw.i32(2); tw.i32(0); tw.i32(w * h * 4);
  tw.bytes(new Uint8Array(w * h * 4).fill(fill));
  return { raw: tw.toBytes() };
}

function makeSet(objName, boneNames, exBone, osg, texId) {
  const bones = boneNames.map((name, i) => ({ id: i, isEx: false, name, ibm: new Float32Array([1, 0, 0, -i, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), parentName: i ? boneNames[i - 1] : null }));
  bones.push({ id: 0, isEx: true, name: exBone, ibm: new Float32Array(16), parentName: boneNames[0] });
  return {
    format: 'FT', textureIds: [texId],
    objects: [{
      name: objName, id: 7, boundingSphere: [0, 0, 0, 2],
      meshes: [quadMesh(`${objName}_body`, 0, bones.length)],
      materials: [material(`${objName}_mat`, texId)],
      skin: { bones, blocks: [osg, { type: 'EXP', parentName: 'j_kao_wj', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], name: `${exBone}_exp`, expressions: ['= 0 v 0'] }] },
    }],
  };
}

test('AES matches node crypto', () => {
  const key = crypto.randomBytes(16), iv = crypto.randomBytes(16), data = crypto.randomBytes(64);
  const c = crypto.createCipheriv('aes-128-ecb', key, null); c.setAutoPadding(false);
  const ecb = Buffer.concat([c.update(data), c.final()]);
  assert.deepEqual(Buffer.from(aesDecryptEcb(key, ecb)), data);
  assert.deepEqual(Buffer.from(aesEncryptEcb(key, data)), ecb);
  const c2 = crypto.createCipheriv('aes-128-cbc', key, iv); c2.setAutoPadding(false);
  const cbc = Buffer.concat([c2.update(data), c2.final()]);
  assert.deepEqual(Buffer.from(aesDecryptCbc(key, iv, cbc)), data);
});

test('FARC round trip (compressed and stored)', () => {
  const entries = [{ name: 'b.bin', data: new Uint8Array([1, 2, 3, 4, 5]) }, { name: 'a.txt', data: new TextEncoder().encode('hello farc') }];
  for (const compress of [true, false]) {
    const out = readFarc(writeFarc(entries, { compress }));
    assert.equal(out.entries.length, 2);
    assert.equal(out.entries[0].name, 'a.txt');
    assert.equal(new TextDecoder().decode(out.entries[0].data), 'hello farc');
    assert.deepEqual([...out.entries[1].data], [1, 2, 3, 4, 5]);
  }
});

test('Encrypted DT-style FARC is readable', () => {
  // Build FARC header with flags=4 (encrypted), power-of-two alignment (DT style)
  const key = new TextEncoder().encode('project_diva.bin');
  const payload = new TextEncoder().encode('secret entry data!');
  const enc = aesEncryptEcb(key, payload);
  const w = new BinWriter(false);
  w.bytes(new TextEncoder().encode('FARC'));
  const hs = w.pos; w.u32(0);
  w.u32(4); w.u32(0); w.u32(16); w.u32(0); w.u32(0);
  w.cstr('x.txt'); const f = w.pos; w.u32(0); w.u32(payload.length); w.u32(payload.length);
  w.patchU32(hs, w.pos - 8);
  w.align(16); w.patchU32(f, w.pos); w.bytes(enc);
  const out = readFarc(w.toBytes());
  assert.equal(new TextDecoder().decode(out.entries[0].data), 'secret entry data!');
});

test('Object set round trip keeps geometry, skin and blocks', () => {
  const set = makeSet('TESTA', ['n_hara_cp', 'kl_mune_b_wj', 'j_kao_wj'], 'e_hair_a', osage('c_hair_a_osg', ['j_hair_a_000', 'j_hair_a_001']), 100);
  const bin = writeObjectSet(set, 'FT');
  const back = readObjectSet(bin);
  assert.equal(back.format, 'FT');
  assert.equal(back.objects.length, 1);
  const o = back.objects[0];
  assert.equal(o.name, 'TESTA');
  assert.equal(o.id, 7);
  assert.equal(o.meshes[0].name, 'TESTA_body');
  assert.deepEqual([...o.meshes[0].positions], [...set.objects[0].meshes[0].positions]);
  assert.deepEqual([...o.meshes[0].subMeshes[0].indices], [0, 1, 2, 0, 2, 3]);
  assert.equal(triangleIndices(o.meshes[0].subMeshes[1]).length, 6);
  assert.deepEqual([...o.meshes[0].blendIndices.slice(0, 4)], [0, -1, -1, -1]);
  assert.equal(o.materials[0].name, 'TESTA_mat');
  assert.equal(o.materials[0].textureIds[0], 100);
  assert.deepEqual(o.skin.bones.map((b) => b.name), ['n_hara_cp', 'kl_mune_b_wj', 'j_kao_wj', 'e_hair_a']);
  assert.equal(o.skin.bones[3].isEx, true);
  assert.equal(o.skin.bones[3].parentName, 'n_hara_cp');
  assert.equal(o.skin.bones[2].parentName, 'kl_mune_b_wj');
  const osg = o.skin.blocks.find((b) => b.type === 'OSG');
  assert.equal(osg.externalName, 'c_hair_a_osg');
  assert.deepEqual(osg.nodes.map((n) => n.name), ['j_hair_a_000', 'j_hair_a_001']);
  assert.ok(Math.abs(osg.nodes[1].rotation[1] - 0.2) < 1e-6);
  assert.equal(osg.parentName, 'j_kao_wj');
  const exp = o.skin.blocks.find((b) => b.type === 'EXP');
  assert.deepEqual(exp.expressions, ['= 0 v 0']);
  assert.deepEqual(back.textureIds, [100]);
  // Re-writing what we read must be byte-identical (layout is deterministic)
  assert.deepEqual(writeObjectSet(back, 'FT'), bin);
});

test('Skin params parse/write round trip', () => {
  const text = writeSkinParams([{ name: 'c_hair_a_osg', force: 0.05, forceGain: 0.4, airResistance: 0.5, rotationY: 0, rotationZ: 0, friction: 1, windAffection: 0.5, collisionType: 0, hingeY: 90, hingeZ: 90, collisionRadius: 0.03, stiffness: 0, moveCancel: 0, collisions: [{ type: 1, radius: 0.1, bone0: { name: 'j_kao_wj', position: [0, 0.1, 0] }, bone1: { name: '', position: [0, 0, 0] } }], bocs: [], nodes: [{ hingeYMin: -90, hingeYMax: 90, hingeZMin: -90, hingeZMax: 90, radius: 0.03, weight: 1, inertialCancel: 0 }] }]);
  assert.match(text, /c_hair_a_osg\.node\.length=1/);
  assert.match(text, /c_hair_a_osg\.root\.coli\.0\.bone\.0\.name=j_kao_wj/);
  const p = readSkinParams(text).get('c_hair_a_osg');
  assert.equal(p.nodes.length, 1);
  assert.equal(p.collisions[0].bone0.name, 'j_kao_wj');
  assert.ok(Math.abs(p.force - 0.05) < 1e-6);
});

test('Merging two farcs with sub-mesh removal unifies bones, blocks, textures and skin params', () => {
  const a = makeSet('MIKITM001', ['n_hara_cp', 'kl_mune_b_wj', 'j_kao_wj'], 'e_hair_a', osage('c_hair_a_osg', ['j_hair_a_000']), 100);
  const b = makeSet('MIKITM002', ['n_hara_cp', 'j_kao_wj', 'j_te_l_wj'], 'e_skirt', osage('c_skirt_osg', ['j_skirt_000', 'j_skirt_001']), 200);
  const farcA = writeFarc([{ name: 'mikitm001_obj.bin', data: writeObjectSet(a) }, { name: 'mikitm001_tex.bin', data: writeTextureSet([texture(4, 4, 10)]) }]);
  const farcB = writeFarc([{ name: 'mikitm002_obj.bin', data: writeObjectSet(b) }, { name: 'mikitm002_tex.bin', data: writeTextureSet([texture(4, 4, 20)]) }]);
  const sa = loadDivaSource('mikitm001.farc', farcA);
  const sb = loadDivaSource('mikitm002.farc', farcB);
  sb.skinParams.set('c_skirt_osg', { ...readSkinParams(writeSkinParams([{ name: 'c_skirt_osg', force: 0.2, forceGain: 0.1, airResistance: 1, rotationY: 0, rotationZ: 0, friction: 1, windAffection: 1, collisionType: 0, hingeY: 45, hingeZ: 45, collisionRadius: 0.02, collisions: [], bocs: [], nodes: [{ hingeYMin: -45, hingeYMax: 45, hingeZMin: -45, hingeZMax: 45, radius: 0.02, weight: 1, inertialCancel: 0 }] }])).get('c_skirt_osg') });
  // Remove the strip sub-mesh of the second model
  sb.objectSets[0].set.objects[0].meshes[0].subMeshes[1].enabled = false;

  const res = mergeDivaSources([sa, sb], { outputName: 'mikitm901', objectName: 'MIKITM901', objectId: 901, objectSetId: 3901, textureIdBase: 50000 });
  const farc = readFarc(res.farc);
  assert.deepEqual(farc.entries.map((e) => e.name).sort(), ['mikitm901_obj.bin', 'mikitm901_tex.bin']);
  const set = readObjectSet(farc.entries.find((e) => e.name.endsWith('_obj.bin')).data);
  assert.equal(set.objects.length, 1);
  const o = set.objects[0];
  assert.equal(o.name, 'MIKITM901');
  assert.equal(o.meshes.length, 2);
  assert.equal(o.meshes[1].subMeshes.length, 1);
  assert.equal(o.meshes[1].positions.length / 3, 4, 'unused vertices compacted');
  assert.equal(o.materials.length, 2);
  assert.equal(o.meshes[1].subMeshes[0].materialIndex, 1);
  const names = o.skin.bones.map((x) => x.name);
  assert.deepEqual(names, ['n_hara_cp', 'kl_mune_b_wj', 'j_kao_wj', 'e_hair_a', 'j_te_l_wj', 'e_skirt']);
  // Second model's palette [0..3] = n_hara_cp, j_kao_wj, j_te_l_wj, e_skirt -> merged indices
  assert.deepEqual([...o.meshes[1].subMeshes[0].boneIndices], [0, 2, 4, 5]);
  assert.deepEqual(o.skin.blocks.filter((x) => x.type === 'OSG').map((x) => x.externalName), ['c_hair_a_osg', 'c_skirt_osg']);
  assert.deepEqual(set.textureIds, [50000, 50001]);
  assert.equal(o.materials[1].textureIds[0], 50001);
  const tex = readTextureSet(farc.entries.find((e) => e.name.endsWith('_tex.bin')).data);
  assert.equal(tex.textures.length, 2);
  assert.equal(decodeTexture(tex.textures[1]).data[0], 20);
  const skp = readSkinParams(res.skinParamText);
  assert.equal(skp.get('c_skirt_osg').hingeY, 45);
  assert.equal(skp.get('c_hair_a_osg').nodes.length, 1);
  assert.equal(res.skinParamName, 'ext_skp_mikitm901__divskn.txt');
  const db = readObjectDatabase(res.objDb);
  assert.equal(db[0].fileName, 'mikitm901_obj.bin');
  assert.deepEqual(db[0].objects, [{ id: 901, name: 'MIKITM901' }]);
  assert.ok(res.texDb.length > 0);
});

test('real Mega Mix+ skin param file round-trips byte for byte and fills missing params from a template', () => {
  const text = readFileSync(new URL('./fixtures/ext_skp_mikitm001_joha_outer_01__divskn.txt', import.meta.url), 'utf8');
  const params = readSkinParams(text);
  assert.equal(params.size, 43);
  assert.equal(writeSkinParams(params.values()), text);
  assert.equal(params.get('c_belt_osg').collisions[0].bone0.name, 'j_momo_l_wj');
  assert.equal(mostSimilarParam('c_skirt_l_03_osg', [...params.keys()]), 'c_skirt_l_03_osg');
  assert.equal(mostSimilarParam('c_skirt_b_osg', [...params.keys()]).startsWith('c_skirt'), true);
  assert.equal(mostSimilarParam('c_hair_osg', ['c_belt_osg']), null);

  const a = makeSet('MIKITM001', ['n_hara_cp', 'kl_mune_b_wj', 'j_kao_wj'], 'e_hair_a', osage('c_skirt_l_02_osg', ['j_s_000', 'j_s_001', 'j_s_002']), 100);
  const src = loadDivaSource('a.farc', writeFarc([{ name: 'mikitm001_obj.bin', data: writeObjectSet(a) }]));
  const res = mergeDivaSources([src], { outputName: 'x', objectName: 'X', skinParamTemplate: params });
  const out = readSkinParams(res.skinParamText).get('c_skirt_l_02_osg');
  assert.equal(out.nodes.length, 3, 'node count follows the osage block');
  assert.ok(out.collisions.length > 0, 'body collisions copied from the template');
});
