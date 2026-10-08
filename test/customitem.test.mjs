import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { zipSync, strToU8 } from 'fflate';
import { readCustomItem, writeCustomItem, recategorize, replaceImage, regenerateIds, setName, parseFields, describeCustomItem } from '../src/formats/vroidCustomItem.js';
import { bakeAppearance } from '../src/core/textureBake.js';

const te = new TextEncoder();
function varint(v) { const o = []; while (v > 0x7f) { o.push((v & 0x7f) | 0x80); v >>>= 7; } o.push(v); return Uint8Array.from(o); }
const cat = (...p) => { const n = p.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of p) { o.set(x, k); k += x.length; } return o; };
const fld = (num, bytes) => cat(varint(num * 8 + 2), varint(bytes.length), bytes);
const str = (num, s) => fld(num, te.encode(s));
const PNG = (fill) => cat(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(40).fill(fill));

function sampleItem() {
  const tid = 'a'.repeat(31) + '1', gid = 'b'.repeat(31) + '2';
  const group = cat(str(2, 'TransferableGroupType.N00.Level1.Tops'), str(3, 'TransferableGroupEditType.Cloth'), fld(4, cat(str(1, 'Template'), str(2, tid))));
  const imageRecord = cat(str(1, 'c'.repeat(32)), fld(2, PNG(7)));
  const store = cat(fld(1, str(1, 'img')), fld(6, imageRecord));
  const transferable = cat(str(2, 'TransferableType.N00.Tops'), fld(3, fld(2, store)));
  const base = cat(str(2, 'TransferableType.Common.Base'), fld(3, fld(6, fld(1, cat(str(1, 'd'.repeat(32)), fld(2, PNG(9)))))));
  return zipSync({
    'meta.json': strToU8(JSON.stringify({ version: 1 })),
    'thumbnails/thumbnail.png': PNG(1),
    'v1customitem/meta.json': strToU8(JSON.stringify({ rootTransferableGroupTypeId: 'TransferableGroupType.N00.Level1.Tops', name: 'My Top', id: gid })),
    'v1customitem/basetransferable.basetransferable': base,
    [`v1customitem/transferablegroups/${gid}.transferablegroup`]: group,
    [`v1customitem/transferables/${tid}.transferable`]: transferable,
  });
}

test('reads, recategorizes, replaces images and regenerates ids', () => {
  const item = readCustomItem(sampleItem());
  assert.equal(item.category.key, 'tops');
  assert.equal(item.images.length, 2);
  assert.ok(item.rootGroup.transferableEntry);
  recategorize(item, 'onepiece');
  assert.throws(() => recategorize(item, 'hair-front'), /family/);
  const newPng = PNG(42);
  replaceImage(item, item.images.find((i) => i.entry.includes('transferables/')).id, cat(newPng, new Uint8Array(100)));
  setName(item, 'Renamed');
  const back = readCustomItem(writeCustomItem(item));
  assert.equal(back.category.key, 'onepiece');
  assert.equal(back.meta.name, 'Renamed');
  const tf = parseFields(back.files[back.rootGroup.transferableEntry]);
  assert.equal(new TextDecoder().decode(tf.find((f) => f.number === 2).value), 'TransferableType.N00.Onepiece');
  const img = back.images.find((i) => i.entry.includes('transferables/'));
  assert.equal(img.size, 148);
  assert.equal(img.bytes[8], 42);
  const fresh = regenerateIds(back, (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })());
  assert.notEqual(fresh.meta.id, back.meta.id);
  assert.ok(fresh.rootGroup.transferableEntry, 'references still resolve after new ids');
  assert.equal(describeCustomItem(fresh).category, 'Dresses / one-piece');
});

test('bakes a textured model onto another mesh UV layout', () => {
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set([255, 0, 0, 255], i * 4);
  const tex = new THREE.DataTexture(data, 4, 4);
  const src = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0, 0.01), new THREE.MeshBasicMaterial({ map: tex }));
  const g = new THREE.Group(); g.add(src);
  const target = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  const out = bakeAppearance(g, target, { size: 32, maxDistance: 0.05, background: [0, 0, 255, 255], dilate: 0 });
  const at = (x, y) => Array.from(out.data.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 3));
  assert.deepEqual(at(16, 16), [255, 0, 0], 'centre covered by the source');
  assert.deepEqual(at(1, 1), [0, 0, 255], 'corner outside the source keeps background');
  assert.ok(out.coverage > 0.2 && out.coverage < 0.35);
});
