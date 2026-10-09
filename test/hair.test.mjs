import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { readCustomItem, writeCustomItem, recategorize } from '../src/formats/vroidCustomItem.js';
import { decodeHair, hairStrandsHeadSpace, extractStrands, rebuildHairItem, findAttachments, setAttachmentBone, hairPreview } from '../src/formats/vroidHair.js';

const load = (n) => readCustomItem(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

test('reads the real hairstyle and hat items', () => {
  const hair = load('HairstyleExample.vroidcustomitem');
  assert.equal(hair.category.key, 'all-hair');
  const hat = load('MCHelm.vroidcustomitem');
  assert.equal(hat.category.key, 'hat');
  assert.equal(hat.category.family, 'accessory');
});

test('decodes VRoid brush hair strands into a head-sized shape', () => {
  const d = decodeHair(load('HairstyleExample.vroidcustomitem'));
  assert.equal(d.groups.length, 23);
  const strands = hairStrandsHeadSpace(d);
  assert.equal(strands.length, d.groups.reduce((a, g) => a + g.strands.length, 0));
  const box = new THREE.Box3();
  for (const s of strands) for (const p of s) box.expandByPoint(p);
  assert.ok(box.max.x < 0.2 && box.min.x > -0.2 && box.max.y < 0.3 && box.min.y > -0.4, `bounds ${box.min.toArray()} ${box.max.toArray()}`);
  assert.ok(hairPreview(d).children.length > 50);
});

test('rebuilds a hair item from mesh strands and the template', () => {
  const head = new THREE.Matrix4().makeTranslation(0, 1.4, 0);
  // eight separate hair "cards" hanging around the head
  const g = new THREE.Group();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.25, 1, 8));
    card.position.set(Math.sin(a) * 0.11, 1.4 + 0.05, Math.cos(a) * 0.11);
    card.lookAt(0, 1.45, 0);
    card.rotateY(Math.PI / 2);
    g.add(card);
  }
  const lines = extractStrands(g, new THREE.Vector3(0, 1.48, 0), { pointsPerStrand: 8 });
  assert.equal(lines.length, 8);
  for (const l of lines) assert.ok(l[0].y > l[l.length - 1].y, 'root at the top');

  const item = load('HairstyleExample.vroidcustomitem');
  const res = rebuildHairItem(item, lines, head, { strandsPerGroup: 4 });
  assert.equal(res.strands, 8);
  assert.equal(res.groups, 2);
  const back = readCustomItem(writeCustomItem(item));
  const d = decodeHair(back);
  assert.equal(d.groups.length, 2);
  const strands = hairStrandsHeadSpace(d);
  assert.equal(strands.length, 8);
  // head-space points match the input lines
  const headInv = head.clone().invert();
  for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) {
    assert.ok(strands[i][k].distanceTo(lines[i][k].clone().applyMatrix4(headInv)) < 1e-4, `strand ${i} point ${k}`);
  }
  // IDs are unique per new group/strand
  const tf = new TextDecoder().decode(back.files[back.order.find((n) => n.includes('transferables/'))]);
  const strandIds = d.groups.flatMap((x) => x.id);
  assert.equal(new Set(strandIds).size, 2);
  assert.ok(tf.includes('Brush Hair Strand 8'));
  assert.equal(back.category.key, 'all-hair');
  recategorize(back, 'hair-back');
});

test('finds and changes the parent bone of an accessory, keeping its placement', () => {
  const hat = load('MCHelm.vroidcustomitem');
  const atts = findAttachments(hat);
  assert.equal(atts.length, 1);
  assert.equal(atts[0].bone, 'J_Bip_C_Head');
  const rest = { J_Bip_C_Head: new THREE.Vector3(0, 1.4, 0), J_Bip_C_Neck: new THREE.Vector3(0, 1.33, 0) };
  const after = setAttachmentBone(hat, 'J_Bip_C_Neck', { boneRest: (n) => rest[n] });
  assert.equal(after[0].bone, 'J_Bip_C_Neck');
  assert.ok(Math.abs(after[0].position[1] - (atts[0].position[1] + 0.07)) < 1e-5, 'offset adjusted by the bone distance');
  const back = readCustomItem(writeCustomItem(hat));
  assert.equal(findAttachments(back)[0].bone, 'J_Bip_C_Neck');
  assert.equal(back.category.key, 'hat');
});
