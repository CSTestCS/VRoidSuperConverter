// Shape key (morph target) tools: intuitive renaming of VRoid "Fcl_*" names and generation of
// left/right asymmetric variants for every shape key.
import * as THREE from 'three';
import { VROID_SHAPE_KEYS } from './vroidSkeleton.js';
import { meshesOf } from './skinning.js';

/** Turn an unknown Fcl_XXX_Name into a readable name. */
export function readableShapeKeyName(name) {
  if (VROID_SHAPE_KEYS[name]) return VROID_SHAPE_KEYS[name];
  const m = name.match(/^Fcl_([A-Z]+)_(.+)$/);
  if (!m) return name;
  const region = { ALL: 'Face', BRW: 'Brows', EYE: 'Eyes', MTH: 'Mouth', HA: 'Teeth' }[m[1]] ?? m[1];
  return `${region}.${m[2].replace(/_/g, '.')}`;
}

function renameKey(mesh, from, to) {
  const dict = mesh.morphTargetDictionary;
  if (!dict || dict[from] === undefined || from === to) return false;
  const i = dict[from];
  delete dict[from];
  dict[to] = i;
  for (const list of Object.values(mesh.geometry.morphAttributes)) if (list[i]) list[i].name = to;
  return true;
}

/**
 * Rename shape keys on every mesh. Returns the mapping applied (old -> new), which can be used
 * to rename animation tracks with renameClipShapeKeys.
 * @param {'readable'|'vroid'|Record<string,string>} style
 */
export function renameShapeKeys(model, style = 'readable') {
  const applied = {};
  const reverse = Object.fromEntries(Object.entries(VROID_SHAPE_KEYS).map(([k, v]) => [v, k]));
  for (const mesh of meshesOf(model)) {
    for (const name of Object.keys(mesh.morphTargetDictionary ?? {})) {
      let to;
      if (style === 'readable') to = readableShapeKeyName(name);
      else if (style === 'vroid') to = reverse[name] ?? name;
      else to = style[name] ?? name;
      if (to !== name && mesh.morphTargetDictionary[to] === undefined && renameKey(mesh, name, to)) applied[name] = to;
    }
  }
  return applied;
}

export function renameClipShapeKeys(clip, mapping) {
  for (const t of clip.tracks) {
    t.name = t.name.replace(/morphTargetInfluences\[([^\]]+)\]/, (all, key) => (mapping[key] ? `morphTargetInfluences[${mapping[key]}]` : all));
  }
  return clip;
}

const isSided = (name) => /([._ -](L|R|Left|Right))$|_(L|R)$/i.test(name);

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
