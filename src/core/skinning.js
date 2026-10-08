// Skinned-mesh utilities: baking a pose into the bind pose, re-binding, weight transfer.
import * as THREE from 'three';

export function skinnedMeshesOf(root) {
  const out = [];
  root.traverse((o) => { if (o.isSkinnedMesh) out.push(o); });
  return out;
}

export function meshesOf(root) {
  const out = [];
  root.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}

/**
 * Bake the current skeleton pose (and current morph influences, optionally) into the
 * geometry so that the current pose becomes the new rest/bind pose.
 */
export function bakePoseIntoBind(root, { bakeMorphs = false } = {}) {
  root.updateMatrixWorld(true);
  const meshes = skinnedMeshesOf(root);
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const nor = geo.attributes.normal;
    const newPos = new Float32Array(pos.count * 3);
    const newNor = nor ? new Float32Array(nor.count * 3) : null;
    const bindInv = mesh.bindMatrixInverse;
    const normalMat = new THREE.Matrix3();
    const skinMat = new THREE.Matrix4();
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const morphTargets = geo.morphAttributes.position;
    const morphRel = geo.morphTargetsRelative;
    // Also transform morph deltas so blend shapes keep working after the bake
    const newMorphs = morphTargets ? morphTargets.map((m) => new Float32Array(m.count * 3)) : null;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (bakeMorphs && morphTargets && mesh.morphTargetInfluences) {
        morphTargets.forEach((m, k) => {
          const w = mesh.morphTargetInfluences[k];
          if (!w) return;
          const d = new THREE.Vector3().fromBufferAttribute(m, i);
          if (!morphRel) d.sub(new THREE.Vector3().fromBufferAttribute(pos, i));
          v.addScaledVector(d, w);
        });
      }
      // skin matrix = bindInv * sum(w * boneWorld * boneInverse) * bind
      skinMat.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const b = si.getComponent(i, k);
        const bone = mesh.skeleton.bones[b];
        if (!bone) continue;
        const m = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, mesh.skeleton.boneInverses[b]);
        for (let e = 0; e < 16; e++) skinMat.elements[e] += m.elements[e] * w;
      }
      const full = new THREE.Matrix4().multiplyMatrices(bindInv, skinMat).multiply(mesh.bindMatrix);
      const p = v.clone().applyMatrix4(full);
      newPos.set([p.x, p.y, p.z], i * 3);
      normalMat.getNormalMatrix(full);
      if (nor) { n.fromBufferAttribute(nor, i).applyMatrix3(normalMat).normalize(); newNor.set([n.x, n.y, n.z], i * 3); }
      if (newMorphs) {
        morphTargets.forEach((m, k) => {
          const d = new THREE.Vector3().fromBufferAttribute(m, i);
          if (!morphRel) d.sub(new THREE.Vector3().fromBufferAttribute(pos, i));
          const lin = new THREE.Matrix3().setFromMatrix4(full);
          d.applyMatrix3(lin);
          if (!morphRel) d.add(p);
          newMorphs[k].set([d.x, d.y, d.z], i * 3);
        });
      }
    }
    pos.array.set(newPos);
    pos.needsUpdate = true;
    if (nor) { nor.array.set(newNor); nor.needsUpdate = true; }
    if (newMorphs) morphTargets.forEach((m, k) => { m.array.set(newMorphs[k]); m.needsUpdate = true; });
    if (bakeMorphs && mesh.morphTargetInfluences) mesh.morphTargetInfluences.fill(0);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  }
  // In three.js the skinned position is B^-1 * sum(w * W * Inv) * B * v, so the current pose
  // becomes the rest pose when every bone inverse equals the inverse of its world matrix.
  for (const mesh of meshes) mesh.skeleton.calculateInverses();
}

/** Rebuild boneInverses from the current pose without touching the geometry (only valid when pose == bind). */
export function rebindToCurrentPose(root) {
  root.updateMatrixWorld(true);
  for (const mesh of skinnedMeshesOf(root)) mesh.skeleton.calculateInverses();
}

/**
 * Replace a skeleton's bone list, remapping skin indices. `remap(oldBone) -> newBone` must
 * return a bone in `newBones`.
 */
export function remapSkin(mesh, newBones, remap) {
  const old = mesh.skeleton.bones;
  const idx = new Map(newBones.map((b, i) => [b, i]));
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const indices = new Uint16Array(si.count * 4);
  const weights = new Float32Array(si.count * 4);
  for (let i = 0; i < si.count; i++) {
    const acc = new Map();
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (!w) continue;
      const nb = remap(old[si.getComponent(i, k)]);
      const ni = idx.get(nb);
      if (ni === undefined) continue;
      acc.set(ni, (acc.get(ni) ?? 0) + w);
    }
    writeWeights(acc, indices, weights, i);
  }
  mesh.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  mesh.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  mesh.updateMatrixWorld(true);
  const inverses = newBones.map((b) => new THREE.Matrix4().copy(b.matrixWorld).invert());
  mesh.bind(new THREE.Skeleton(newBones, inverses), mesh.bindMatrix);
}

/** Keep the four largest weights and normalise. */
export function writeWeights(acc, indices, weights, i) {
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
  for (let k = 0; k < 4; k++) {
    indices[i * 4 + k] = top[k]?.[0] ?? 0;
    weights[i * 4 + k] = top[k] ? top[k][1] / sum : 0;
  }
  if (!top.length) weights[i * 4] = 1;
}

/** Convert a static mesh into a skinned mesh bound to `bones` with the given per-vertex weights. */
export function makeSkinned(mesh, bones, perVertex) {
  const geo = mesh.geometry.clone();
  const count = geo.attributes.position.count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) writeWeights(perVertex[i], indices, weights, i);
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const sk = new THREE.SkinnedMesh(geo, mesh.material);
  sk.name = mesh.name;
  sk.morphTargetDictionary = mesh.morphTargetDictionary;
  sk.morphTargetInfluences = mesh.morphTargetInfluences;
  sk.castShadow = mesh.castShadow;
  return sk;
}
