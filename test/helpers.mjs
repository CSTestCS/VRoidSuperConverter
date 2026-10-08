import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VROID_BONES } from '../src/core/vroidSkeleton.js';

/** Build a bone hierarchy from [name, parentName, worldPos] entries. */
export function buildSkeleton(spec, scale = 1) {
  const root = new THREE.Group();
  root.name = 'Armature';
  const bones = new Map();
  for (const [name, parent, p] of spec) {
    const b = new THREE.Bone();
    b.name = name;
    const world = new THREE.Vector3(...p).multiplyScalar(scale);
    const par = parent ? bones.get(parent) : null;
    const parentWorld = par ? par.userData.world : new THREE.Vector3();
    b.position.copy(world.clone().sub(parentWorld));
    b.userData.world = world;
    (par ?? root).add(b);
    bones.set(name, b);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

const MIXAMO = {
  hips: 'Hips', spine: 'Spine', chest: 'Spine1', upperChest: 'Spine2', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftArm', leftLowerArm: 'LeftForeArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightArm', rightLowerArm: 'RightForeArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpLeg', leftLowerLeg: 'LeftLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToeBase',
  rightUpperLeg: 'RightUpLeg', rightLowerLeg: 'RightLeg', rightFoot: 'RightFoot', rightToes: 'RightToeBase',
};
const MIXAMO_FINGER = { Thumb: 'Thumb', Index: 'Index', Middle: 'Middle', Ring: 'Ring', Little: 'Pinky' };

export function mixamoSpec(prefix = 'mixamorig:') {
  const names = {};
  for (const [h] of VROID_BONES) {
    if (MIXAMO[h]) names[h] = MIXAMO[h];
    const m = h.match(/^(left|right)(Thumb|Index|Middle|Ring|Little)(Metacarpal|Proximal|Intermediate|Distal)$/);
    if (m) {
      const n = { Metacarpal: 1, Proximal: m[2] === 'Thumb' ? 2 : 1, Intermediate: 2, Distal: 3 }[m[3]];
      names[h] = `${m[1] === 'left' ? 'Left' : 'Right'}Hand${MIXAMO_FINGER[m[2]]}${n}`;
    }
  }
  const spec = [];
  for (const [h, parent, , p] of VROID_BONES) {
    if (!names[h]) continue;
    spec.push([prefix + names[h], parent ? prefix + names[parent] : null, p]);
  }
  spec.push([prefix + 'HeadTop_End', prefix + 'Head', [0, 1.6, 0]]);
  return spec;
}

export function vroidSpec() {
  const spec = [['Root', null, [0, 0, 0]]];
  for (const [, parent, name, p] of VROID_BONES) spec.push([name, parent ? VROID_BONES.find((b) => b[0] === parent)[2] : 'Root', p]);
  return spec;
}

/** A skinned box-person mesh bound to a given skeleton spec (one cylinder-ish segment per bone). */
export function skinnedPerson(spec) {
  const { root, bones } = buildSkeleton(spec);
  const list = [...bones.values()];
  const positions = [], skinIndex = [], skinWeight = [], indices = [];
  list.forEach((b, bi) => {
    const p = b.userData.world;
    const base = positions.length / 3;
    for (const [dx, dy, dz] of [[-0.02, -0.02, -0.02], [0.02, -0.02, -0.02], [0.02, 0.02, -0.02], [-0.02, 0.02, -0.02], [-0.02, -0.02, 0.02], [0.02, -0.02, 0.02], [0.02, 0.02, 0.02], [-0.02, 0.02, 0.02]]) {
      positions.push(p.x + dx, p.y + dy, p.z + dz);
      skinIndex.push(bi, 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
    const q = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]];
    for (const t of q) indices.push(base + t[0], base + t[1], base + t[2]);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = 'Body';
  const skeleton = new THREE.Skeleton(list);
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);
  return { root, bones, mesh };
}

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

