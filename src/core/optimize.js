// Mesh optimisation: weld vertices that share a position within the same material, and drop
// degenerate / duplicate triangles. Skin weights, morph targets, normals and UVs are carried.
import * as THREE from 'three';
import { meshesOf } from './skinning.js';

export const DEFAULT_OPTIMIZE = {
  tolerance: 1e-5,        // metres
  requireSameUV: false,   // true keeps UV seams (safer for textures); false welds every coincident vertex
  requireSameNormal: false,
  removeDegenerate: true,
  removeDuplicateFaces: true,
};

/**
 * @returns {{before: number, after: number, removedTriangles: number}}
 */
export function weldGeometry(geo, opts = {}) {
  const o = { ...DEFAULT_OPTIMIZE, ...opts };
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const nor = geo.attributes.normal;
  const count = pos.count;
  const index = geo.index ? Array.from(geo.index.array) : Array.from({ length: count }, (_, i) => i);
  const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
  const q = (v) => Math.round(v / o.tolerance);

  // newVertex -> list of source vertex indices; key per (material, position[, uv, normal])
  const map = new Map();
  const sources = [];
  const newIndex = [];
  const newGroups = [];
  let removed = 0;
  const faceKeys = new Set();
  for (const g of groups) {
    const start = newIndex.length;
    for (let t = g.start; t + 2 < g.start + g.count; t += 3) {
      const tri = [];
      for (let k = 0; k < 3; k++) {
        const vi = index[t + k];
        let key = `${g.materialIndex}|${q(pos.getX(vi))},${q(pos.getY(vi))},${q(pos.getZ(vi))}`;
        if (o.requireSameUV && uv) key += `|${uv.getX(vi).toFixed(5)},${uv.getY(vi).toFixed(5)}`;
        if (o.requireSameNormal && nor) key += `|${nor.getX(vi).toFixed(3)},${nor.getY(vi).toFixed(3)},${nor.getZ(vi).toFixed(3)}`;
        let ni = map.get(key);
        if (ni === undefined) { ni = sources.length; map.set(key, ni); sources.push([vi]); }
        else if (!sources[ni].includes(vi)) sources[ni].push(vi);
        tri.push(ni);
      }
      if (o.removeDegenerate && (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2])) { removed++; continue; }
      if (o.removeDuplicateFaces) {
        const fk = `${g.materialIndex}|${[...tri].sort((a, b) => a - b).join(',')}`;
        if (faceKeys.has(fk)) { removed++; continue; }
        faceKeys.add(fk);
      }
      newIndex.push(...tri);
    }
    newGroups.push({ start, count: newIndex.length - start, materialIndex: g.materialIndex });
  }

  const out = new THREE.BufferGeometry();
  const average = (attr, normalize) => {
    const size = attr.itemSize;
    const arr = new (attr.array.constructor)(sources.length * size);
    for (let n = 0; n < sources.length; n++) {
      const src = sources[n];
      for (let c = 0; c < size; c++) {
        // UVs and integer attributes take the first source; floats are averaged
        if (normalize === 'first') { arr[n * size + c] = attr.array[src[0] * size + c]; continue; }
        let s = 0;
        for (const v of src) s += attr.array[v * size + c];
        arr[n * size + c] = s / src.length;
      }
      if (normalize === 'unit') {
        let l = 0;
        for (let c = 0; c < 3; c++) l += arr[n * size + c] ** 2;
        l = Math.sqrt(l) || 1;
        for (let c = 0; c < 3; c++) arr[n * size + c] /= l;
      }
    }
    return new THREE.BufferAttribute(arr, size, attr.normalized);
  };
  for (const [name, attr] of Object.entries(geo.attributes)) {
    if (name === 'skinIndex' || name === 'skinWeight') continue;
    out.setAttribute(name, average(attr, name === 'normal' ? 'unit' : (name.startsWith('uv') || name === 'color') ? 'first' : 'avg'));
  }
  if (geo.attributes.skinIndex) {
    // Merge weights of all welded sources
    const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
    const idx = new Uint16Array(sources.length * 4), wts = new Float32Array(sources.length * 4);
    sources.forEach((src, n) => {
      const acc = new Map();
      for (const v of src) for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(v, k);
        if (w) acc.set(si.getComponent(v, k), (acc.get(si.getComponent(v, k)) ?? 0) + w / src.length);
      }
      const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
      const sum = top.reduce((s, [, w]) => s + w, 0) || 1;
      top.forEach(([b, w], k) => { idx[n * 4 + k] = b; wts[n * 4 + k] = w / sum; });
      if (!top.length) wts[n * 4] = 1;
    });
    out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
    out.setAttribute('skinWeight', new THREE.Float32BufferAttribute(wts, 4));
  }
  for (const [name, list] of Object.entries(geo.morphAttributes)) {
    out.morphAttributes[name] = list.map((m) => { const a = average(m, 'avg'); a.name = m.name; return a; });
  }
  out.morphTargetsRelative = geo.morphTargetsRelative;
  out.setIndex(newIndex);
  for (const g of newGroups) if (geo.groups.length) out.addGroup(g.start, g.count, g.materialIndex);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return { geometry: out, before: count, after: sources.length, removedTriangles: removed };
}

/** Weld every mesh in a model in place. */
export function optimizeModel(model, opts = {}) {
  const report = [];
  for (const mesh of meshesOf(model)) {
    const r = weldGeometry(mesh.geometry, opts);
    mesh.geometry.dispose();
    mesh.geometry = r.geometry;
    report.push({ mesh: mesh.name, before: r.before, after: r.after, removedTriangles: r.removedTriangles });
  }
  return report;
}
