import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { autoRig } from '../src/core/autoRig.js';
import { refitClothing, attachClothing, buildBodyField, queryBody, matchProportions } from '../src/core/fit.js';
import { worldPos } from '../src/core/retarget.js';
import { boxPerson } from './helpers.mjs';

test('refits a loose and a too-tight tube onto the torso and binds it to the skeleton', () => {
  const body = autoRig(boxPerson(), { tPose: false });
  const field = buildBodyField(body);
  for (const r of [0.3, 0.12]) {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 24, 6, true).translate(0, 1.1, 0));
    const g = new THREE.Group(); g.add(tube);
    const { meshes, stats } = refitClothing(g, body, { tightness: 1, maxPullDistance: 0.5, offset: 0.01, smoothingIterations: 0 });
    const pos = meshes[0].geometry.attributes.position;
    let worst = 0, worstP = null;
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      const h = queryBody(field, p);
      const signed = p.clone().sub(h.point).dot(h.normal);
      assert.ok(signed > 0.0095, `vertex not inside the body (r=${r}, signed=${signed})`);
      if (Math.abs(signed - 0.01) > worst) { worst = Math.abs(signed - 0.01); worstP = p.clone(); }
    }
    assert.ok(worst < 0.03, `tube hugs the body (r=${r}, worst=${worst} at ${worstP?.toArray()})`);
    assert.ok(meshes[0].isSkinnedMesh);
    assert.ok(stats.vertices > 0);
    attachClothing(body, meshes);
  }
  // clothing follows the body when the spine bends
  const H = body.userData.humanoid;
  const cloth = body.children.find((c) => c.userData.isClothing);
  const v0 = new THREE.Vector3(); cloth.getVertexPosition(0, v0);
  H.spine.rotation.z = 0.5; body.updateMatrixWorld(true);
  const v1 = new THREE.Vector3(); cloth.getVertexPosition(0, v1);
  assert.ok(v0.distanceTo(v1) > 0.01);
});

test('matches proportions: legs take the reference length', () => {
  const model = autoRig(boxPerson(), { tPose: false });
  const tall = boxPerson();
  tall.children[0].geometry.applyMatrix4(new THREE.Matrix4().makeScale(1, 1.2, 1));
  const reference = autoRig(tall, { tPose: false });
  const len = (m) => worldPos(m.userData.humanoid.leftUpperLeg).distanceTo(worldPos(m.userData.humanoid.leftLowerLeg));
  const before = len(model), target = len(reference);
  matchProportions(model, reference, { strength: 1 });
  model.updateMatrixWorld(true);
  assert.ok(Math.abs(len(model) - target) < 1e-4, `${before} -> ${len(model)} (target ${target})`);
  const box = new THREE.Box3().setFromObject(model.children.find((c) => c.isSkinnedMesh));
  const rbox = new THREE.Box3().setFromObject(reference.children.find((c) => c.isSkinnedMesh));
  assert.ok(Math.abs((box.max.y - box.min.y) - (rbox.max.y - rbox.min.y)) < 0.08, 'overall height follows');
});
