// Build three.js preview meshes for Project DIVA object sets (static, bind pose).
import * as THREE from 'three';
import { triangleIndices } from './objset.js';
import { decodeTexture } from './texset.js';

export function texturesById(source, objSetEntry) {
  const base = objSetEntry.entryName.slice(0, -8).toLowerCase();
  const ts = source.textureSets.get(base) ?? (source.textureSets.size === 1 ? [...source.textureSets.values()][0] : null);
  const map = new Map();
  if (!ts) return map;
  objSetEntry.set.textureIds.forEach((id, i) => { if (ts.textures[i]) map.set(id, ts.textures[i]); });
  return map;
}

const texCache = new WeakMap();
function threeTexture(tex) {
  if (texCache.has(tex)) return texCache.get(tex);
  let t = null;
  try {
    const img = decodeTexture(tex);
    t = new THREE.DataTexture(new Uint8Array(img.data.buffer), img.width, img.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.flipY = false;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.needsUpdate = true;
  } catch { t = null; }
  texCache.set(tex, t);
  return t;
}

/** Group with one THREE.Mesh per sub-mesh; mesh.userData links back to the DIVA records. */
export function buildDivaPreview(source) {
  const group = new THREE.Group();
  group.name = source.fileName;
  for (const os of source.objectSets) {
    const texMap = texturesById(source, os);
    for (const obj of os.set.objects) {
      const og = new THREE.Group();
      og.name = obj.name;
      og.userData.divaObject = obj;
      for (const m of obj.meshes) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
        if (m.normals) geo.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
        if (m.uv0) geo.setAttribute('uv', new THREE.BufferAttribute(m.uv0, 2));
        m.subMeshes.forEach((sm, si) => {
          const g = geo.clone();
          g.setIndex(Array.from(triangleIndices(sm)));
          if (!m.normals) g.computeVertexNormals();
          const mat = obj.materials[sm.materialIndex];
          const tex = mat ? texMap.get(mat.textureIds[0]) : null;
          const material = new THREE.MeshStandardMaterial({
            color: mat ? new THREE.Color(mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]) : 0xcccccc,
            map: tex ? threeTexture(tex) : null, side: THREE.DoubleSide, roughness: 0.8, alphaTest: 0.3, transparent: false,
          });
          const mesh = new THREE.Mesh(g, material);
          mesh.name = `${m.name} [${si}]`;
          mesh.userData = { divaObject: obj, divaMesh: m, divaSubMesh: sm };
          og.add(mesh);
        });
      }
      group.add(og);
    }
  }
  return group;
}

export function refreshDivaVisibility(group) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    const { divaObject, divaMesh, divaSubMesh } = o.userData;
    o.visible = divaObject.enabled !== false && divaMesh.enabled !== false && divaSubMesh.enabled !== false;
  });
}
