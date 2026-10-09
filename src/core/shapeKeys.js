// Shape key (morph target) tools: intuitive renaming of VRoid "Fcl_*" names and generation of
// left/right asymmetric variants for every shape key.
import * as THREE from 'three';
import { VROID_SHAPE_KEYS } from './vroidSkeleton.js';
import { meshesOf } from './skinning.js';

/** Split VRoid's optional mesh prefix: "Face_Blendshape.Fcl_EYE_Close" -> ["Face_Blendshape.", "Fcl_EYE_Close"]. */
export function splitShapeKeyName(name) {
  const i = name.search(/(^|\.)Fcl_/);
  if (i > 0) return [name.slice(0, i + 1), name.slice(i + 1)];
  const dot = name.lastIndexOf('.');
  if (dot > 0 && /blend ?shape/i.test(name.slice(0, dot))) return [name.slice(0, dot + 1), name.slice(dot + 1)];
  return ['', name];
}

/** Turn an unknown Fcl_XXX_Name into a readable name. */
export function readableShapeKeyName(name) {
  const [, base] = splitShapeKeyName(name);
  if (VROID_SHAPE_KEYS[base]) return VROID_SHAPE_KEYS[base];
  const m = base.match(/^Fcl_([A-Z]+)_(.+)$/);
  if (!m) return name;
  const region = { ALL: 'Face', BRW: 'Brows', EYE: 'Eyes', MTH: 'Mouth', HA: 'Teeth' }[m[1]] ?? m[1];
  return `${region}.${m[2].replace(/_/g, '.')}`;
}

const READABLE_TO_VROID = Object.fromEntries(Object.entries(VROID_SHAPE_KEYS).map(([k, v]) => [v, k]));
export function vroidShapeKeyName(name) {
  const [, base] = splitShapeKeyName(name);
  if (READABLE_TO_VROID[base]) return READABLE_TO_VROID[base];
  const m = base.match(/^(Face|Brows|Eyes|Mouth|Teeth)\.(.+)$/);
  if (!m || base.startsWith('Fcl_')) return base;
  const region = { Face: 'ALL', Brows: 'BRW', Eyes: 'EYE', Mouth: 'MTH', Teeth: 'HA' }[m[1]];
  return `Fcl_${region}_${m[2].replace(/\./g, '_')}`;
}

/** Replace a key in place (same morph index, new name). Returns the name actually used. */
function renameKey(mesh, from, to) {
  const dict = mesh.morphTargetDictionary;
  if (!dict || dict[from] === undefined || from === to) return null;
  const i = dict[from];
  let name = to;
  for (let k = 2; dict[name] !== undefined && dict[name] !== i; k++) name = `${to}.${k}`;
  // rebuild the dictionary so the order stays by index and the old key is gone
  const entries = Object.entries(dict).filter(([n]) => n !== from);
  entries.push([name, i]);
  entries.sort((x, y) => x[1] - y[1]);
  for (const k of Object.keys(dict)) delete dict[k];
  for (const [n, idx] of entries) dict[n] = idx;
  for (const list of Object.values(mesh.geometry.morphAttributes)) if (list[i]) list[i].name = name;
  return name;
}

/**
 * Rename shape keys on every mesh, replacing the old names. Returns the mapping applied
 * (old -> new), which can be used to rename animation tracks with renameClipShapeKeys.
 * @param {'readable'|'vroid'|Record<string,string>} style
 */
export function renameShapeKeys(model, style = 'readable') {
  const applied = {};
  for (const mesh of meshesOf(model)) {
    if (!mesh.morphTargetDictionary) continue;
    for (const name of Object.keys(mesh.morphTargetDictionary)) {
      let to;
      if (style === 'readable') to = readableShapeKeyName(name);
      else if (style === 'vroid') to = vroidShapeKeyName(name);
      else to = style[name] ?? name;
      const used = renameKey(mesh, name, to);
      if (used) applied[name] = used;
    }
  }
  return applied;
}

/** All shape key names in a model with every (mesh, index) that carries them. */
export function listShapeKeys(model) {
  const out = new Map();
  model.traverse((m) => {
    if (!m.isMesh || !m.morphTargetDictionary) return;
    for (const [n, i] of Object.entries(m.morphTargetDictionary)) {
      if (!out.has(n)) out.set(n, []);
      out.get(n).push({ mesh: m, index: i });
    }
  });
  return out;
}

/** Set a shape key weight on every mesh that has it. */
export function setShapeKeyWeight(model, name, weight) {
  for (const { mesh, index } of listShapeKeys(model).get(name) ?? []) mesh.morphTargetInfluences[index] = weight;
}

export function renameClipShapeKeys(clip, mapping) {
  for (const t of clip.tracks) {
    t.name = t.name.replace(/morphTargetInfluences\[([^\]]+)\]/, (all, key) => (mapping[key] ? `morphTargetInfluences[${mapping[key]}]` : all));
  }
  return clip;
}

const isSided = (name) => /([._ -](L|R|Left|Right))$|_(L|R)$/i.test(splitShapeKeyName(name)[1]);

/**
 * Add a left and right version of every shape key. The split uses the X coordinate with a
 * smooth blend zone of width `blend` around the centre line (character's left = +X).
 */
export function addAsymmetricShapeKeys(model, { blend = 0.02, centerX = 0, leftSuffix = '.L', rightSuffix = '.R', skipSided = true, only = null } = {}) {
  const added = [];
  for (const mesh of meshesOf(model)) {
    const geo = mesh.geometry;
    const dict = mesh.morphTargetDictionary;
    const morphs = geo.morphAttributes.position;
    if (!dict || !morphs) continue;
    const pos = geo.attributes.position;
    const toWorldX = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).x;
    const leftW = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = toWorldX(i) - centerX;
      const t = Math.min(1, Math.max(0, (x + blend / 2) / Math.max(1e-9, blend)));
      leftW[i] = t * t * (3 - 2 * t);
    }
    const names = Object.entries(dict).sort((a, b) => a[1] - b[1]).map(([n]) => n);
    for (const name of names) {
      if (skipSided && isSided(name)) continue;
      if (only && !only.includes(name)) continue;
      const i = dict[name];
      for (const [side, suffix] of [['L', leftSuffix], ['R', rightSuffix]]) {
        const newName = `${name}${suffix}`;
        if (dict[newName] !== undefined) continue;
        const idx = morphs.length;
        for (const [attrName, list] of Object.entries(geo.morphAttributes)) {
          const src = list[i];
          const arr = new Float32Array(src.array.length);
          const relative = geo.morphTargetsRelative || attrName !== 'position';
          for (let v = 0; v < src.count; v++) {
            const w = side === 'L' ? leftW[v] : 1 - leftW[v];
            for (let c = 0; c < src.itemSize; c++) {
              const val = src.array[v * src.itemSize + c];
              if (relative) arr[v * src.itemSize + c] = val * w;
              else {
                const base = geo.attributes[attrName].array[v * src.itemSize + c];
                arr[v * src.itemSize + c] = base + (val - base) * w;
              }
            }
          }
          const attr = new THREE.BufferAttribute(arr, src.itemSize);
          attr.name = newName;
          list.push(attr);
        }
        dict[newName] = idx;
        mesh.morphTargetInfluences.push(0);
        added.push(`${mesh.name}:${newName}`);
      }
    }
  }
  return added;
}
