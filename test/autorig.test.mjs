import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { autoRig, estimateJoints, gatherSurfacePoints } from '../src/core/autoRig.js';
import { worldPos } from '../src/core/retarget.js';

export function boxPerson() {
  const parts = [
    [0.3, 0.5, 0.18, 0, 1.1, 0], // torso
    [0.12, 0.08, 0.1, 0, 1.39, 0], // neck
    [0.22, 0.24, 0.22, 0, 1.55, 0], // head
    [0.62, 0.08, 0.08, 0.46, 1.27, 0], // left arm (T-pose)
    [0.62, 0.08, 0.08, -0.46, 1.27, 0],
    [0.12, 0.84, 0.12, 0.08, 0.44, 0], // left leg
    [0.12, 0.84, 0.12, -0.08, 0.44, 0],
    [0.1, 0.05, 0.22, 0.08, 0.025, 0.05], // feet
    [0.1, 0.05, 0.22, -0.08, 0.025, 0.05],
    [0.3, 0.12, 0.18, 0, 0.9, 0], // pelvis
  ];
  const geos = parts.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d, Math.max(1, Math.round(w / 0.04)), Math.max(1, Math.round(h / 0.04)), 2).translate(x, y, z));
  const geo = mergeGeometries(geos.map((g) => g.toNonIndexed()).map((g) => { g.deleteAttribute('uv'); return g; }));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

test('estimates joints on an unrigged T-pose mesh', () => {
  const g = boxPerson();
  const J = estimateJoints(gatherSurfacePoints(g));
  assert.ok(J.leftUpperLeg.x > 0.03 && J.rightUpperLeg.x < -0.03, 'legs on the right sides');
  assert.ok(Math.abs(J._meta.crotchY - 0.86) < 0.06, `crotch ${J._meta.crotchY}`);
  assert.ok(J.leftHand.x > 0.5 && J.leftHand.x < 0.75, `hand ${J.leftHand.x}`);
  assert.ok(Math.abs(J.neck.y - 1.38) < 0.08, `neck ${J.neck.y}`);
  assert.ok(Math.abs(J._meta.aPose) < 10, 'T-pose detected');
});

test('auto-rigs into a skinned VRoid model whose arm follows the arm bone', () => {
  const out = autoRig(boxPerson(), { tPose: false });
  const H = out.userData.humanoid;
  assert.equal(H.leftLowerArm.name, 'J_Bip_L_LowerArm');
  const mesh = out.children.find((c) => c.isSkinnedMesh);
  // rotate the left upper arm down 90 degrees and check the arm tip moves down
  H.leftUpperArm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  out.updateMatrixWorld(true);
  const pos = mesh.geometry.attributes.position;
  let tipIndex = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getX(i) > pos.getX(tipIndex)) tipIndex = i;
  const v = new THREE.Vector3();
  mesh.getVertexPosition(tipIndex, v);
  v.applyMatrix4(mesh.matrixWorld);
  assert.ok(v.y < 0.95, `tip moved down (y=${v.y.toFixed(2)})`);
  // a foot vertex must not move
  let footIndex = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < pos.getY(footIndex)) footIndex = i;
  const f0 = new THREE.Vector3().fromBufferAttribute(pos, footIndex);
  mesh.getVertexPosition(footIndex, v);
  assert.ok(v.distanceTo(f0) < 1e-4);
  assert.ok(worldPos(H.head).y > 1.3);
});
