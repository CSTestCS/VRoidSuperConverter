// Merge meshes/sub-meshes from several Project DIVA Mega Mix+ .farc files into one
// object set, with unified skin (bones + osage/cloth/constraint blocks) and a regenerated
// external skin parameter file so physics keeps working in game.
import { readFarc, writeFarc } from './farc.js';
import { readObjectSet, writeObjectSet, computeBoundingSphere, triangleIndices } from './objset.js';
import { readTextureSet, writeTextureSet } from './texset.js';
import { readSkinParams, writeSkinParams, skinParamFromOsageBlock } from './skinParam.js';
import { BinWriter, BinReader } from './binary.js';

let sourceCounter = 0;

/**
 * Load one .farc (or a loose _obj.bin / _tex.bin / ext_skp txt) into a source record.
 * @param {string} fileName
 * @param {Uint8Array} bytes
 */
export function loadDivaSource(fileName, bytes) {
  const source = { id: `src${++sourceCounter}`, fileName, objectSets: [], textureSets: new Map(), skinParams: new Map(), otherEntries: [] };
  const lower = fileName.toLowerCase();
  let entries;
  if (lower.endsWith('.farc')) entries = readFarc(bytes).entries;
  else entries = [{ name: fileName.split(/[\\/]/).pop(), data: bytes }];
  for (const e of entries) {
    const n = e.name.toLowerCase();
    try {
      if (n.endsWith('_obj.bin')) source.objectSets.push({ entryName: e.name, set: readObjectSet(e.data) });
      else if (n.endsWith('_tex.bin')) source.textureSets.set(e.name.slice(0, -8).toLowerCase(), readTextureSet(e.data));
      else if (n.endsWith('.txt') && n.includes('skp')) for (const [k, v] of readSkinParams(new TextDecoder().decode(e.data))) source.skinParams.set(k, v);
      else source.otherEntries.push(e);
    } catch (err) {
      source.otherEntries.push({ ...e, error: String(err.message ?? err) });
    }
  }
  // Every object/mesh/submesh starts enabled.
  for (const os of source.objectSets) for (const obj of os.set.objects) {
    obj.enabled = true;
    for (const m of obj.meshes) { m.enabled = true; for (const sm of m.subMeshes) sm.enabled = true; }
  }
  return source;
}

/** Add skin parameters from a loose ext_skp_*.txt to a source. */
export function addSkinParamText(source, text) {
  for (const [k, v] of readSkinParams(text)) source.skinParams.set(k, v);
}

/** Texture blobs for an object set, in the order of its textureIds. */
function texturesFor(source, objSetEntry) {
  const base = objSetEntry.entryName.slice(0, -8).toLowerCase();
  const ts = source.textureSets.get(base) ?? (source.textureSets.size === 1 ? [...source.textureSets.values()][0] : null);
  const out = new Map();
  if (ts && ts.textures.length === objSetEntry.set.textureIds.length) {
    objSetEntry.set.textureIds.forEach((id, i) => out.set(id, ts.textures[i]));
  }
  return out;
}

// ------------------------------------------------------------- mesh filtering
function cloneMeshFiltered(mesh, compact) {
  const subs = mesh.subMeshes.filter((s) => s.enabled !== false).map((s) => ({ ...s, indices: s.indices.slice(), boneIndices: s.boneIndices?.slice() ?? null }));
  if (!subs.length) return null;
  const m = { ...mesh, subMeshes: subs };
  if (!compact) return m;
  const vcount = mesh.positions.length / 3;
  const used = new Int32Array(vcount).fill(-1);
  let next = 0;
  for (const s of subs) for (const i of s.indices) if (i !== 0xffffffff && used[i] < 0) used[i] = next++;
  if (next === vcount) return m;
  // Keep vertex order stable
  next = 0;
  for (let i = 0; i < vcount; i++) if (used[i] >= 0) used[i] = next++;
  const remapAttr = (arr, comps) => {
    if (!arr) return arr;
    const out = new arr.constructor(next * comps);
    for (let i = 0; i < vcount; i++) if (used[i] >= 0) for (let c = 0; c < comps; c++) out[used[i] * comps + c] = arr[i * comps + c];
    return out;
  };
  for (const [key, comps] of [['positions', 3], ['normals', 3], ['tangents', 4], ['uv0', 2], ['uv1', 2], ['uv2', 2], ['uv3', 2], ['colors0', 4], ['colors1', 4], ['blendWeights', 4], ['blendIndices', 4]]) {
    m[key] = remapAttr(mesh[key], comps);
  }
  for (const s of subs) {
    s.indices = s.indices.map((i) => (i === 0xffffffff ? i : used[i]));
    const max = s.indices.reduce((a, i) => (i !== 0xffffffff && i > a ? i : a), 0);
    if (s.indexFormat === 0 && max >= 0xff) s.indexFormat = 1;
    if (s.indexFormat === 1 && max >= 0xffff) s.indexFormat = 2;
  }
  m.vertexCount = next;
  return m;
}

function blockKey(b) {
  return `${b.type}:${b.type === 'OSG' ? b.externalName : b.name}`;
}

function cloneSkin(skin) {
  return skin ? structuredClone(skin) : { bones: [], blocks: [] };
}

/**
 * Build the merged object set.
 * @param {ReturnType<typeof loadDivaSource>[]} sources
 * @param {{
 *   outputName: string, objectName?: string, objectId?: number, singleObject?: boolean,
 *   compactVertices?: boolean, textureIdBase?: number|null, objectSetId?: number,
 *   includeSkinParamInFarc?: boolean, physicsDefaults?: object, compress?: boolean,
 * }} opts
 */
export function mergeDivaSources(sources, opts) {
  const outputName = (opts.outputName || 'merged').toLowerCase();
  const objectName = (opts.objectName || outputName).toUpperCase();
  const singleObject = opts.singleObject ?? true;
  const compact = opts.compactVertices ?? true;
  const report = [];

  const pieces = [];
  const textureBlobs = new Map();
  const textureIds = [];
  let format = 'FT';

  for (const src of sources) {
    for (const os of src.objectSets) {
      if (os.set.format === 'DT') format = 'DT';
      const texMap = texturesFor(src, os);
      for (const obj of os.set.objects) {
        if (obj.enabled === false) continue;
        const meshes = obj.meshes.filter((m) => m.enabled !== false).map((m) => cloneMeshFiltered(m, compact)).filter(Boolean);
        if (!meshes.length) continue;
        // Drop unused materials and remap material indices
        const usedMats = [...new Set(meshes.flatMap((m) => m.subMeshes.map((s) => s.materialIndex)))].sort((a, b) => a - b);
        const matRemap = new Map(usedMats.map((mi, i) => [mi, i]));
        const materials = usedMats.map((mi) => obj.materials[mi]).filter(Boolean);
        for (const m of meshes) for (const s of m.subMeshes) s.materialIndex = matRemap.get(s.materialIndex) ?? 0;
        for (const mat of materials) for (const tid of mat.textureIds) {
          if (tid === 0xffffffff || textureIds.includes(tid)) continue;
          textureIds.push(tid);
          if (texMap.has(tid)) textureBlobs.set(tid, texMap.get(tid));
        }
        pieces.push({ src, obj, meshes, materials, skin: cloneSkin(obj.skin) });
        report.push(`+ ${src.fileName} / ${obj.name}: ${meshes.length} mesh(es), ${meshes.reduce((a, m) => a + m.subMeshes.length, 0)} sub-mesh(es)`);
      }
    }
  }
  if (!pieces.length) throw new Error('Nothing selected to merge.');

  let objects;
  if (singleObject) {
    const merged = { name: objectName, id: opts.objectId ?? 0, meshes: [], materials: [], skin: { bones: [], blocks: [] } };
    const boneIndexByName = new Map();
    const blockKeys = new Set();
    for (const p of pieces) {
      const matBase = merged.materials.length;
      merged.materials.push(...p.materials);
      // Union skin bones; remap sub-mesh bone palettes
      const remap = p.skin.bones.map((b) => {
        if (boneIndexByName.has(b.name)) return boneIndexByName.get(b.name);
        const idx = merged.skin.bones.length;
        merged.skin.bones.push({ ...b });
        boneIndexByName.set(b.name, idx);
        return idx;
      });
      for (const m of p.meshes) {
        for (const s of m.subMeshes) {
          s.materialIndex += matBase;
          if (s.boneIndices) s.boneIndices = Uint16Array.from(s.boneIndices, (bi) => remap[bi] ?? 0);
        }
        // Avoid duplicate mesh names inside one object
        let name = m.name || 'mesh';
        let k = 1;
        while (merged.meshes.some((x) => x.name === name)) name = `${m.name}_${k++}`;
        m.name = name;
        merged.meshes.push(m);
      }
      for (const b of p.skin.blocks) {
        const key = blockKey(b);
        if (blockKeys.has(key)) { report.push(`  skipped duplicate ${key}`); continue; }
        blockKeys.add(key);
        merged.skin.blocks.push(b);
      }
    }
    if (!merged.skin.bones.length && !merged.skin.blocks.length) merged.skin = null;
    objects = [merged];
  } else {
    const names = new Set();
    objects = pieces.map((p, i) => {
      let name = p.obj.name;
      while (names.has(name)) name = `${p.obj.name}_${i}`;
      names.add(name);
      return { name, id: p.obj.id, meshes: p.meshes, materials: p.materials, skin: p.skin.bones.length ? p.skin : null };
    });
  }

  for (const obj of objects) {
    for (const m of obj.meshes) {
      m.boundingSphere = computeBoundingSphere(m.positions);
      for (const s of m.subMeshes) s.boundingSphere = computeBoundingSphere(m.positions, s.indices);
    }
    const all = obj.meshes.flatMap((m) => [m.boundingSphere]);
    obj.boundingSphere = mergeSpheres(all);
  }

  // Optional new texture IDs (for a mod_tex_db.bin)
  let texIdRemap = null;
  if (opts.textureIdBase != null && Number.isFinite(opts.textureIdBase)) {
    texIdRemap = new Map(textureIds.map((id, i) => [id, (opts.textureIdBase + i) >>> 0]));
    for (const obj of objects) for (const mat of obj.materials) {
      mat.raw = mat.raw.slice();
      const dv = new DataView(mat.raw.buffer, mat.raw.byteOffset, mat.raw.byteLength);
      mat.textureIds = mat.textureIds.map((tid, i) => {
        const n = texIdRemap.get(tid);
        if (n == null) return tid;
        dv.setUint32(20 + i * 120 + 4, n, true);
        return n;
      });
    }
  }
  const finalTexIds = textureIds.map((id) => texIdRemap?.get(id) ?? id);
  const missingTex = textureIds.filter((id) => !textureBlobs.has(id));
  if (missingTex.length) report.push(`! ${missingTex.length} texture(s) referenced but not found in any _tex.bin; they are expected to come from the game's own texture sets.`);
  const texList = textureIds.filter((id) => textureBlobs.has(id));
  const set = { objects, textureIds: texList.map((id) => texIdRemap?.get(id) ?? id), format };

  // Skin parameters: imported ext_skp files first (case-insensitive), then the template file
  // (exact name, then the most similar osage name), then defaults derived from the block.
  const imported = new Map();
  for (const src of sources) for (const [k, v] of src.skinParams) if (!imported.has(k.toLowerCase())) imported.set(k.toLowerCase(), v);
  const template = opts.skinParamTemplate ?? null; // Map from readSkinParams
  const params = [];
  let generated = 0;
  for (const obj of objects) {
    for (const b of obj.skin?.blocks ?? []) {
      if (b.type !== 'OSG' && b.type !== 'CLS') continue;
      const key = b.type === 'OSG' ? b.externalName : b.name;
      if (!key) continue;
      let p = imported.get(key.toLowerCase()) ? structuredClone(imported.get(key.toLowerCase())) : null;
      if (!p && template?.size) {
        const exact = [...template.keys()].find((k) => k.toLowerCase() === key.toLowerCase());
        const similar = exact ?? mostSimilarParam(key, [...template.keys()]);
        if (similar) { p = structuredClone(template.get(similar)); report.push(`  skin_param for ${key} taken from template entry ${similar}`); }
      }
      if (!p && b.type === 'OSG') { p = skinParamFromOsageBlock(b, opts.physicsDefaults); generated++; report.push(`  generated default skin_param for ${key}`); }
      if (!p && b.type === 'CLS') { p = { ...skinParamFromOsageBlock({ externalName: key, nodes: [], internalSkinParam: b.internalSkinParam }, opts.physicsDefaults) }; generated++; }
      if (p) { p.name = key; if (b.type === 'OSG' && p.nodes.length !== b.nodes.length) p.nodes = resizeNodes(p.nodes, b.nodes.length); params.push(p); }
    }
  }
  if (generated) report.push(`! ${generated} skin parameter(s) had no source and use defaults without body collisions. Import the original ext_skp_*.txt files (or a template) for correct physics.`);
  const skinParamText = writeSkinParams(params);
  const skinParamName = opts.skinParamFileName || `ext_skp_${objects[0].name.toLowerCase()}__divskn.txt`;

  const objBin = writeObjectSet(set, format);
  const texBin = writeTextureSet(texList.map((id) => textureBlobs.get(id)));
  const entries = [
    { name: `${outputName}_obj.bin`, data: objBin },
    { name: `${outputName}_tex.bin`, data: texBin },
  ];
  if (opts.includeSkinParamInFarc) entries.push({ name: skinParamName, data: new TextEncoder().encode(skinParamText) });
  const farc = writeFarc(entries, { compress: opts.compress ?? true });

  const objDb = writeObjectDatabase([{
    name: outputName.toUpperCase(), id: opts.objectSetId ?? 0, fileName: `${outputName}_obj.bin`,
    textureFileName: `${outputName}_tex.bin`, archiveFileName: `${outputName}.farc`,
    objects: objects.map((o) => ({ name: o.name, id: o.id })),
  }]);
  const texDb = texIdRemap ? writeTextureDatabase(texList.map((id, i) => ({ id: texIdRemap.get(id), name: `${outputName.toUpperCase()}_TEX${String(i).padStart(3, '0')}` }))) : null;

  report.push(`= ${objects.length} object(s), ${objects.reduce((a, o) => a + o.meshes.length, 0)} mesh(es), ${set.textureIds.length} texture(s), ${params.length} skin parameter(s)`);
  return { farc, farcName: `${outputName}.farc`, objBin, texBin, skinParamText, skinParamName, objDb, texDb, set, report, finalTexIds };
}

/** Pick the template osage name most similar to `name` (same prefix family, side and index preferred). */
export function mostSimilarParam(name, candidates) {
  const tok = (n) => n.toLowerCase().replace(/_osg$/, '').replace(/^c_/, '').split(/[_\d]+/).filter((t) => t.length > 1);
  const side = (n) => (/_l(_|\d|$)/i.test(n) ? 'l' : /_r(_|\d|$)/i.test(n) ? 'r' : '');
  const num = (n) => Number((n.match(/(\d+)(?!.*\d)/) ?? [])[1] ?? -1);
  const a = tok(name);
  let best = null, bestScore = 0;
  for (const c of candidates) {
    const b = tok(c);
    let score = a.filter((t) => b.includes(t)).length * 3 - Math.abs(a.length - b.length);
    if (side(c) === side(name)) score += 1;
    if (num(c) === num(name)) score += 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 3 ? best : null;
}

function resizeNodes(nodes, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ ...(nodes[Math.min(i, nodes.length - 1)] ?? { hingeYMin: -90, hingeYMax: 90, hingeZMin: -90, hingeZMax: 90, radius: 0.03, weight: 1, inertialCancel: 0 }) });
  return out;
}

function mergeSpheres(spheres) {
  if (!spheres.length) return [0, 0, 0, 0];
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of spheres) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], s[i] - s[3]); max[i] = Math.max(max[i], s[i] + s[3]); }
  const c = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
  let r = 0;
  for (const s of spheres) r = Math.max(r, Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) + s[3]);
  return [...c, r];
}

/** Classic obj_db.bin (mod_obj_db.bin) writer. */
export function writeObjectDatabase(objectSets) {
  const w = new BinWriter(true);
  w.pushStringTable(16, 'center');
  w.i32(objectSets.length);
  w.u32(Math.max(0, ...objectSets.map((s) => s.id)));
  w.offset(16, 'left', () => {
    for (const s of objectSets) {
      w.strOffset(s.name); w.u32(s.id); w.strOffset(s.fileName); w.strOffset(s.textureFileName); w.strOffset(s.archiveFileName);
      w.nulls(16);
    }
  });
  w.i32(objectSets.reduce((a, s) => a + s.objects.length, 0));
  w.offset(16, 'left', () => {
    for (const s of objectSets) for (const o of s.objects) { w.u16(o.id); w.u16(s.id); w.strOffset(o.name); }
  });
  w.performScheduledWrites();
  w.popStringTable();
  return w.toBytes();
}

/** Classic tex_db.bin (mod_tex_db.bin) writer. */
export function writeTextureDatabase(textures) {
  const w = new BinWriter(true);
  w.pushStringTable(16, 'center');
  w.i32(textures.length);
  w.offset(16, 'left', () => { for (const t of textures) { w.u32(t.id); w.strOffset(t.name ?? ''); } });
  w.performScheduledWrites();
  w.popStringTable();
  return w.toBytes();
}

export function readObjectDatabase(bytes) {
  const r = new BinReader(bytes, true);
  const count = r.i32(); r.u32();
  const setsOff = r.offset();
  const objCount = r.i32();
  const objsOff = r.offset();
  const sets = [];
  r.at(setsOff, () => {
    for (let i = 0; i < count; i++) {
      sets.push({ name: r.strOffset(), id: r.u32(), fileName: r.strOffset(), textureFileName: r.strOffset(), archiveFileName: r.strOffset(), objects: [] });
      r.skip(16);
    }
  });
  r.at(objsOff, () => {
    for (let i = 0; i < objCount; i++) {
      const id = r.u16(), setId = r.u16(), name = r.strOffset();
      sets.find((s) => s.id === setId)?.objects.push({ id, name });
    }
  });
  return sets;
}

/** Summary tree used by the UI. */
export function describeSource(src) {
  return src.objectSets.flatMap((os) => os.set.objects.map((obj) => ({
    obj, entryName: os.entryName,
    meshes: obj.meshes.map((m) => ({
      mesh: m, name: m.name, vertexCount: m.positions.length / 3,
      subMeshes: m.subMeshes.map((s, i) => ({ sm: s, index: i, triangles: triangleIndices(s).length / 3, material: obj.materials[s.materialIndex]?.name ?? '?' })),
    })),
    boneCount: obj.skin?.bones.length ?? 0,
    osageCount: obj.skin?.blocks.filter((b) => b.type === 'OSG').length ?? 0,
  })));
}
