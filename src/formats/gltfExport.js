// glTF / GLB / VRM (0.x and 1.0) export via three.js GLTFExporter plus a VRM extension plugin.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { VRM0_NAME, VROID_SHAPE_KEYS } from '../core/vroidSkeleton.js';
import { skinnedMeshesOf, meshesOf } from '../core/skinning.js';

// expression preset -> candidate morph names (VRoid "Fcl" names and our readable aliases)
const EXPRESSIONS = {
  aa: ['Fcl_MTH_A'], ih: ['Fcl_MTH_I'], ou: ['Fcl_MTH_U'], ee: ['Fcl_MTH_E'], oh: ['Fcl_MTH_O'],
  blink: ['Fcl_EYE_Close'], blinkLeft: ['Fcl_EYE_Close_L'], blinkRight: ['Fcl_EYE_Close_R'],
  happy: ['Fcl_ALL_Joy'], angry: ['Fcl_ALL_Angry'], sad: ['Fcl_ALL_Sorrow'], relaxed: ['Fcl_ALL_Fun'], surprised: ['Fcl_ALL_Surprised'],
};
const VRM0_PRESET = { aa: 'a', ih: 'i', ou: 'u', ee: 'e', oh: 'o', blink: 'blink', blinkLeft: 'blink_l', blinkRight: 'blink_r', happy: 'joy', angry: 'angry', sad: 'sorrow', relaxed: 'fun', surprised: 'unknown' };
for (const list of Object.values(EXPRESSIONS)) for (const n of [...list]) if (VROID_SHAPE_KEYS[n]) list.push(VROID_SHAPE_KEYS[n]);

/** Replace materials GLTFExporter cannot write (MToon / ShaderMaterial) with unlit equivalents. */
function exportableMaterials(root) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const conv = (m) => {
      if (m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshPhysicalMaterial) return m;
      if (cache.has(m)) return cache.get(m);
      const b = new THREE.MeshBasicMaterial({
        name: m.name, map: m.map ?? m.uniforms?.map?.value ?? null,
        color: m.color ?? m.uniforms?.litFactor?.value ?? new THREE.Color(1, 1, 1),
        transparent: m.transparent, alphaTest: m.alphaTest ?? 0, side: m.side, opacity: m.opacity ?? 1,
      });
      cache.set(m, b);
      return b;
    };
    o.material = Array.isArray(o.material) ? o.material.map(conv) : conv(o.material);
  });
}

/** Rotate a rigged model 180° about Y in its rest pose (VRM 0.x models face -Z). */
export function rotateModel180(model) {
  const R = new THREE.Matrix4().makeRotationY(Math.PI);
  const Rq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  model.updateMatrixWorld(true);
  const modelInv = model.matrixWorld.clone().invert();
  const bones = [];
  model.traverse((o) => { if (o.isBone) bones.push(o); });
  const targets = new Map(bones.map((b) => {
    const m = new THREE.Matrix4().multiplyMatrices(modelInv, b.matrixWorld);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    return [b, { p: p.applyMatrix4(R), q: Rq.clone().multiply(q) }];
  }));
  for (const mesh of meshesOf(model)) {
    const toModel = new THREE.Matrix4().multiplyMatrices(modelInv, mesh.matrixWorld);
    const M = toModel.clone().invert().multiply(R).multiply(toModel);
    mesh.geometry = mesh.geometry.clone();
    mesh.geometry.applyMatrix4(M);
    const lin = new THREE.Matrix3().setFromMatrix4(M);
    for (const list of Object.values(mesh.geometry.morphAttributes)) for (const a of list) {
      const v = new THREE.Vector3();
      for (let i = 0; i < a.count; i++) { v.fromBufferAttribute(a, i); if (mesh.geometry.morphTargetsRelative) v.applyMatrix3(lin); else v.applyMatrix4(M); a.setXYZ(i, v.x, v.y, v.z); }
    }
  }
  for (const b of bones) {
    const t = targets.get(b);
    const parent = b.parent;
    const parentM = new THREE.Matrix4().multiplyMatrices(modelInv, parent.matrixWorld);
    const pInv = parentM.clone().invert();
    const pq = new THREE.Quaternion(); parentM.decompose(new THREE.Vector3(), pq, new THREE.Vector3());
    b.position.copy(t.p).applyMatrix4(pInv);
    b.quaternion.copy(pq.invert().multiply(t.q));
    b.updateMatrixWorld(true);
  }
  for (const m of skinnedMeshesOf(model)) m.skeleton.calculateInverses();
  return model;
}

function vrmPlugin(model, version, meta) {
  return (writer) => ({
    afterParse() {
      const H = model.userData.humanoid ?? {};
      const nodeOf = (o) => writer.nodeMap.get(o);
      const json = writer.json;
      json.extensions ??= {};
      const morphBinds = (names) => {
        const out = [];
        model.traverse((m) => {
          if (!m.isMesh || !m.morphTargetDictionary) return;
          const n = nodeOf(m);
          if (n === undefined) return;
          for (const name of names) if (m.morphTargetDictionary[name] !== undefined) { out.push({ node: n, mesh: json.nodes[n].mesh, index: m.morphTargetDictionary[name] }); break; }
        });
        return out;
      };
      const title = meta?.title ?? meta?.name ?? model.name ?? 'Avatar';
      const author = meta?.author ?? (meta?.authors?.[0]) ?? 'Unknown';
      if (version === 1) {
        const humanBones = {};
        for (const [h, b] of Object.entries(H)) { const n = nodeOf(b); if (n !== undefined) humanBones[h] = { node: n }; }
        const preset = {};
        for (const [p, names] of Object.entries(EXPRESSIONS)) {
          const binds = morphBinds(names);
          if (binds.length) preset[p] = { morphTargetBinds: binds.map((x) => ({ node: x.node, index: x.index, weight: 1 })), isBinary: false, overrideBlink: 'none', overrideLookAt: 'none', overrideMouth: 'none' };
        }
        json.extensions.VRMC_vrm = {
          specVersion: '1.0',
          meta: { name: title, version: meta?.version ?? '1.0', authors: [author], licenseUrl: 'https://vrm.dev/licenses/1.0/', avatarPermission: 'onlyAuthor',
            allowExcessivelyViolentUsage: false, allowExcessivelySexualUsage: false, commercialUsage: 'personalNonProfit', allowPoliticalOrReligiousUsage: false,
            allowAntisocialOrHateUsage: false, creditNotation: 'required', allowRedistribution: false, modification: 'prohibited' },
          humanoid: { humanBones },
          expressions: { preset, custom: {} },
          lookAt: { type: 'bone', offsetFromHeadBone: [0, 0.06, 0],
            rangeMapHorizontalInner: { inputMaxValue: 90, outputScale: 10 }, rangeMapHorizontalOuter: { inputMaxValue: 90, outputScale: 10 },
            rangeMapVerticalDown: { inputMaxValue: 90, outputScale: 10 }, rangeMapVerticalUp: { inputMaxValue: 90, outputScale: 10 } },
          firstPerson: { meshAnnotations: [] },
        };
        writer.extensionsUsed.VRMC_vrm = true;
      } else {
        const humanBones = [];
        for (const [h, b] of Object.entries(H)) { const n = nodeOf(b); if (n !== undefined) humanBones.push({ bone: VRM0_NAME[h] ?? h, node: n, useDefaultValues: true }); }
        const groups = [];
        for (const [p, names] of Object.entries(EXPRESSIONS)) {
          const binds = morphBinds(names);
          if (binds.length) groups.push({ name: p, presetName: VRM0_PRESET[p], binds: binds.map((x) => ({ mesh: x.mesh, index: x.index, weight: 100 })), materialValues: [], isBinary: false });
        }
        groups.push({ name: 'Neutral', presetName: 'neutral', binds: [], materialValues: [], isBinary: false });
        const curve = [0, 0, 0, 1, 1, 1, 1, 0];
        json.extensions.VRM = {
          exporterVersion: 'VRoidSuperConverter-0.1', specVersion: '0.0',
          meta: { title, version: meta?.version ?? '1.0', author, contactInformation: '', reference: '', allowedUserName: 'OnlyAuthor',
            violentUssageName: 'Disallow', sexualUssageName: 'Disallow', commercialUssageName: 'Disallow', otherPermissionUrl: '', licenseName: 'Redistribution_Prohibited', otherLicenseUrl: '' },
          humanoid: { humanBones, armStretch: 0.05, legStretch: 0.05, upperArmTwist: 0.5, lowerArmTwist: 0.5, upperLegTwist: 0.5, lowerLegTwist: 0.5, feetSpacing: 0, hasTranslationDoF: false },
          firstPerson: { firstPersonBone: H.head ? nodeOf(H.head) : -1, firstPersonBoneOffset: { x: 0, y: 0.06, z: 0 }, meshAnnotations: [], lookAtTypeName: 'Bone',
            lookAtHorizontalInner: { curve, xRange: 90, yRange: 10 }, lookAtHorizontalOuter: { curve, xRange: 90, yRange: 10 },
            lookAtVerticalDown: { curve, xRange: 90, yRange: 10 }, lookAtVerticalUp: { curve, xRange: 90, yRange: 10 } },
          blendShapeMaster: { blendShapeGroups: groups },
          secondaryAnimation: { boneGroups: [], colliderGroups: [] },
          materialProperties: (json.materials ?? []).map((m) => ({ name: m.name ?? '', shader: 'VRM_USE_GLTFSHADER', renderQueue: 2000, floatProperties: {}, vectorProperties: {}, textureProperties: {}, keywordMap: {}, tagMap: {} })),
        };
        writer.extensionsUsed.VRM = true;
      }
    },
  });
}

/**
 * @param {THREE.Object3D} model
 * @param {{format?: 'glb'|'gltf'|'vrm0'|'vrm1', clips?: THREE.AnimationClip[], meta?: object}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function exportGLTF(model, opts = {}) {
  const format = opts.format ?? 'glb';
  const copy = cloneSkeleton(model);
  copy.userData = { ...model.userData };
  let uuidMap = null;
  // Re-point humanoid references at the cloned bones
  if (model.userData.humanoid) {
    const map = new Map();
    const a = [], b = [];
    model.traverse((o) => a.push(o)); copy.traverse((o) => b.push(o));
    a.forEach((o, i) => map.set(o, b[i]));
    copy.userData.humanoid = Object.fromEntries(Object.entries(model.userData.humanoid).map(([k, v]) => [k, map.get(v)]).filter(([, v]) => v));
    // clips may reference meshes by uuid
    uuidMap = new Map(a.map((o, i) => [o.uuid, b[i].name || b[i].uuid]));
  }
  copy.position.set(0, 0, 0); copy.quaternion.identity(); copy.scale.set(1, 1, 1);
  exportableMaterials(copy);
  if (format === 'vrm0') rotateModel180(copy);
  const clips = (opts.clips ?? []).map((c) => {
    const cc = c.clone();
    for (const t of cc.tracks) {
      const p = THREE.PropertyBinding.parseTrackName(t.name);
      if (uuidMap?.has(p.nodeName)) t.name = t.name.replace(p.nodeName, uuidMap.get(p.nodeName));
    }
    return cc;
  });
  const exporter = new GLTFExporter();
  if (format === 'vrm0' || format === 'vrm1') exporter.register(vrmPlugin(copy, format === 'vrm1' ? 1 : 0, opts.meta));
  const result = await exporter.parseAsync(copy, { binary: format !== 'gltf', animations: format === 'vrm0' ? [] : clips, onlyVisible: false });
  return result instanceof ArrayBuffer ? new Uint8Array(result) : new TextEncoder().encode(JSON.stringify(result, null, 1));
}
