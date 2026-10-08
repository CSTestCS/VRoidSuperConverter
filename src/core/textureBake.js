// Bake the appearance of one model onto the UV layout of another mesh (e.g. bake a clothing
// model onto a VRoid outfit's texture so it can be used in VRoid Studio / a custom item).
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { meshesOf } from './skinning.js';

/** RGBA pixels of a texture (DataTexture or browser image). */
export function texturePixels(tex) {
  const img = tex?.image;
  if (!img) return null;
  if (img.data && img.width) return { width: img.width, height: img.height, data: img.data, flipY: tex.flipY };
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data, flipY: tex.flipY };
}

function sample(px, u, v) {
  u = u - Math.floor(u); v = v - Math.floor(v);
  const x = Math.min(px.width - 1, Math.floor(u * px.width));
  const y = Math.min(px.height - 1, Math.floor((px.flipY === false ? v : 1 - v) * px.height));
  const i = (y * px.width + x) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
}

/** World-space merged geometry of a model with per-triangle material colour/texture lookup. */
function buildSource(source) {
  source.updateMatrixWorld(true);
  const positions = [], uvs = [], tri = [];
  let base = 0;
  const materials = [];
  for (const mesh of meshesOf(source)) {
    const g = mesh.geometry;
    const pos = g.attributes.position, uv = g.attributes.uv;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
      uvs.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const matBase = materials.length;
    for (const m of mats) materials.push({ color: m.color ? [m.color.r * 255, m.color.g * 255, m.color.b * 255] : [255, 255, 255], px: m.map ? texturePixels(m.map) : null, opacity: m.opacity ?? 1 });
    const n = g.index ? g.index.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
    for (const gr of groups) for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      for (let k = 0; k < 3; k++) tri.push(base + (g.index ? g.index.getX(t + k) : t + k));
      materials.triMat ??= [];
      materials.triMat.push(matBase + Math.min(gr.materialIndex ?? 0, mats.length - 1));
    }
    base += pos.count;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(tri);
  // MeshBVH reorders the index buffer; keep the original triangle order for material lookup
  const originalIndex = Uint32Array.from(tri);
  const bvh = new MeshBVH(geo);
  return { geo, bvh, uvs: Float32Array.from(uvs), materials, originalIndex };
}

/**
 * @param {THREE.Object3D} source model whose appearance is baked
 * @param {THREE.Mesh} target mesh whose UV layout receives the bake
 * @param {{size?: number, maxDistance?: number, materialIndex?: number|null, background?: number[], dilate?: number, base?: {width:number,height:number,data:Uint8ClampedArray}|null}} opts
 * @returns {{width: number, height: number, data: Uint8ClampedArray, coverage: number}}
 */
export function bakeAppearance(source, target, opts = {}) {
  const size = opts.size ?? 1024;
  const maxDistance = opts.maxDistance ?? 0.05;
  const src = buildSource(source);
  const out = new Uint8ClampedArray(size * size * 4);
  const filled = new Uint8Array(size * size);
  if (opts.base) {
    // start from the existing texture, resampled
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const c = sample({ ...opts.base, flipY: false }, (x + 0.5) / size, (y + 0.5) / size);
      out.set(c, (y * size + x) * 4);
    }
  } else if (opts.background) for (let i = 0; i < size * size; i++) out.set(opts.background, i * 4);

  target.updateMatrixWorld(true);
  const g = target.geometry;
  const pos = g.attributes.position, uv = g.attributes.uv;
  if (!uv) throw new Error('Target mesh has no UVs');
  const n = g.index ? g.index.count : pos.count;
  const groups = g.groups.length ? g.groups : [{ start: 0, count: n, materialIndex: 0 }];
  const P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const U = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  const tri = new THREE.Triangle();
  const bary = new THREE.Vector3();
  const p = new THREE.Vector3();
  let hits = 0, total = 0;
  for (const gr of groups) {
    if (opts.materialIndex != null && gr.materialIndex !== opts.materialIndex) continue;
    for (let t = gr.start; t < gr.start + gr.count; t += 3) {
      for (let k = 0; k < 3; k++) {
        const vi = g.index ? g.index.getX(t + k) : t + k;
        if (target.isSkinnedMesh) target.getVertexPosition(vi, P[k]); else P[k].fromBufferAttribute(pos, vi);
        P[k].applyMatrix4(target.matrixWorld);
        U[k].fromBufferAttribute(uv, vi);
      }
      // texel bbox (v flipped: image row 0 = top = v 1)
      const xs = U.map((u) => u.x * size), ys = U.map((u) => (1 - u.y) * size);
      const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(size - 1, Math.ceil(Math.max(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(size - 1, Math.ceil(Math.max(...ys)));
      const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
      if (Math.abs(area) < 1e-12) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / area;
        const w1 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        total++;
        p.set(0, 0, 0).addScaledVector(P[0], w0).addScaledVector(P[1], w1).addScaledVector(P[2], w2);
        const hit = src.bvh.closestPointToPoint(p, {}, 0, maxDistance);
        if (!hit || hit.distance > maxDistance) continue;
        // hit.faceIndex refers to the BVH's (reordered) index; recover the original triangle
        const ia = src.geo.index.getX(hit.faceIndex * 3), ib = src.geo.index.getX(hit.faceIndex * 3 + 1), ic = src.geo.index.getX(hit.faceIndex * 3 + 2);
        tri.setFromAttributeAndIndices(src.geo.attributes.position, ia, ib, ic);
        tri.getBarycoord(hit.point, bary);
        const su = src.uvs[ia * 2] * bary.x + src.uvs[ib * 2] * bary.y + src.uvs[ic * 2] * bary.z;
        const sv = src.uvs[ia * 2 + 1] * bary.x + src.uvs[ib * 2 + 1] * bary.y + src.uvs[ic * 2 + 1] * bary.z;
        const mat = src.materials[materialOfTriangle(src, ia, ib, ic)] ?? src.materials[0];
        let c = mat.px ? sample(mat.px, su, sv) : [...mat.color, 255];
        if (mat.px) c = [c[0] * mat.color[0] / 255, c[1] * mat.color[1] / 255, c[2] * mat.color[2] / 255, c[3]];
        const i = (y * size + x) * 4;
        const a = (c[3] / 255) * mat.opacity;
        out[i] = c[0] * a + out[i] * (1 - a);
        out[i + 1] = c[1] * a + out[i + 1] * (1 - a);
        out[i + 2] = c[2] * a + out[i + 2] * (1 - a);
        out[i + 3] = Math.max(out[i + 3], c[3] * mat.opacity);
        filled[y * size + x] = 1;
        hits++;
      }
    }
  }
  dilate(out, filled, size, opts.dilate ?? 4);
  return { width: size, height: size, data: out, coverage: total ? hits / total : 0 };
}

const triMatCache = new WeakMap();
function materialOfTriangle(src, a, b, c) {
  let map = triMatCache.get(src);
  if (!map) {
    map = new Map();
    const idx = src.originalIndex;
    for (let t = 0; t < idx.length; t += 3) map.set(`${idx[t]},${idx[t + 1]},${idx[t + 2]}`, src.materials.triMat[t / 3]);
    triMatCache.set(src, map);
  }
  return map.get(`${a},${b},${c}`) ?? 0;
}

function dilate(data, filled, size, passes) {
  for (let p = 0; p < passes; p++) {
    const add = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (filled[y * size + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size || !filled[ny * size + nx]) continue;
        add.push([y * size + x, ny * size + nx]);
        break;
      }
    }
    for (const [to, from] of add) { data.copyWithin(to * 4, from * 4, from * 4 + 4); filled[to] = 1; }
  }
}

/** Encode RGBA pixels as PNG (browser only). */
export async function encodePng({ width, height, data }) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
