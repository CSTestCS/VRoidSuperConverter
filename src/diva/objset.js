// Project DIVA classic object set (*_obj.bin) reader/writer, including skin and
// ExData (osage / expression / motion / constraint / cloth) blocks.
// Layout reference: MikuMikuLibrary (MIT, Skyth). Classic (DT/F/FT/MM+) format only.
import { BinReader, BinWriter } from './binary.js';

export const OBJSET_SIGNATURE = 0x5062500;
export const MATERIAL_SIZE = 0x4b0;

const ATTR = {
  Position: 1 << 0, Normal: 1 << 1, Tangent: 1 << 2,
  TexCoord0: 1 << 4, TexCoord1: 1 << 5, TexCoord2: 1 << 6, TexCoord3: 1 << 7,
  Color0: 1 << 8, Color1: 1 << 9, BlendWeight: 1 << 10, BlendIndices: 1 << 11,
  Modern: 1 << 31,
};
const ATTR_FIELDS = [
  [ATTR.Position, 'positions', 3], [ATTR.Normal, 'normals', 3], [ATTR.Tangent, 'tangents', 4],
  [ATTR.TexCoord0, 'uv0', 2], [ATTR.TexCoord1, 'uv1', 2], [ATTR.TexCoord2, 'uv2', 2], [ATTR.TexCoord3, 'uv3', 2],
  [ATTR.Color0, 'colors0', 4], [ATTR.Color1, 'colors1', 4],
];

// ---------------------------------------------------------------- string set
class StringSet {
  constructor(strings = []) { this.strings = strings; }
  static read(r, offset, count) {
    const strings = [];
    r.at(offset, () => { for (let i = 0; i < count; i++) strings.push(r.strOffset()); });
    return new StringSet(strings);
  }
  readString(r) {
    const index = r.i32();
    return (index & 0x8000) === 0 ? null : this.strings[index & 0x7fff] ?? null;
  }
  id(value) {
    const index = this.strings.indexOf(value);
    return index !== -1 ? (0x8000 | index) >>> 0 : 0;
  }
  write(w, value) { w.u32(this.id(value)); }
  add(value) { if (value && !this.strings.includes(value)) this.strings.push(value); }

  static fromSkin(skin) {
    const s = new StringSet();
    for (const b of skin.blocks) {
      switch (b.type) {
        case 'CNS':
          s.add(b.name); s.add(b.sourceNodeName);
          if (b.data.upVector) s.add(b.data.upVector.name);
          break;
        case 'EXP': s.add(b.name); break;
        case 'MOT': for (const n of b.nodes) s.add(n.name); break;
        case 'OSG':
          s.add(b.externalName);
          for (const n of b.nodes) { s.add(n.name); s.add(n.siblingName); }
          s.add(b.name);
          break;
      }
    }
    for (const bone of skin.bones) if (bone.isEx) s.add(bone.name);
    return s;
  }
}

// ---------------------------------------------------------------- blocks
function readNodeHeader(r, block) {
  block.parentName = r.strOffset();
  block.position = r.vec(3);
  block.rotation = r.vec(3);
  block.scale = r.vec(3);
}
function writeNodeHeader(w, b) {
  w.strOffset(b.parentName);
  w.vec(b.position ?? [0, 0, 0]);
  w.vec(b.rotation ?? [0, 0, 0]);
  w.vec(b.scale ?? [1, 1, 1]);
}

function readInternalSkinParam(r) {
  r.skip(4);
  const p = {
    force: r.f32(), forceGain: r.f32(), airResistance: r.f32(), rotationY: r.f32(), rotationZ: r.f32(),
    hingeY: r.f32(), hingeZ: r.f32(), name: r.strOffset(), collisions: [],
  };
  r.readOffset(() => {
    for (let guard = 0; guard < 4096; guard++) {
      const c = { type: r.i32(), head: r.u32(), tail: r.u32(), radius: r.f32(), headPosition: r.vec(3), tailPosition: r.vec(3) };
      if (c.type === 0) break;
      p.collisions.push(c);
    }
  });
  p.collisionRadius = r.f32();
  p.friction = r.f32();
  p.windAffection = r.f32();
  return p;
}
function writeInternalSkinParam(w, p) {
  w.nulls(4);
  w.f32(p.force); w.f32(p.forceGain); w.f32(p.airResistance); w.f32(p.rotationY); w.f32(p.rotationZ);
  w.f32(p.hingeY); w.f32(p.hingeZ);
  w.strOffset(p.name);
  w.offset(16, 'left', () => {
    for (const c of [...p.collisions, { type: 0, head: 0, tail: 0, radius: 0, headPosition: [0, 0, 0], tailPosition: [0, 0, 0] }]) {
      w.i32(c.type); w.u32(c.head); w.u32(c.tail); w.f32(c.radius); w.vec(c.headPosition); w.vec(c.tailPosition);
    }
  });
  w.f32(p.collisionRadius); w.f32(p.friction); w.f32(p.windAffection);
}

function readUpVector(r) {
  return { active: r.i32() !== 0, roll: r.f32(), affectedAxis: r.vec(3), pointAt: r.vec(3), name: r.strOffset() };
}
function writeUpVector(w, u) {
  w.i32(u.active ? 1 : 0); w.f32(u.roll); w.vec(u.affectedAxis); w.vec(u.pointAt); w.strOffset(u.name);
}
function readAttach(r) { return { byOrientation: r.i32() !== 0, byScaling: r.i32() !== 0, offset: r.vec(3) }; }
function writeAttach(w, a) { w.i32(a.byOrientation ? 1 : 0); w.i32(a.byScaling ? 1 : 0); w.vec(a.offset); }

const BLOCK_READERS = {
  OSG(r, ss) {
    const b = { type: 'OSG' };
    readNodeHeader(r, b);
    b.startIndex = r.i32();
    b.count = r.i32();
    b.externalName = ss.readString(r);
    b.name = ss.readString(r);
    b.nodes = Array.from({ length: b.count }, () => ({ name: null, length: 0, rotation: [0, 0, 0], siblingName: null, siblingMaxDistance: 0 }));
    r.readOffset(() => {
      const start = r.pos;
      if (r.u32() === 0) {
        r.seek(start);
        b.internalSkinParam = readInternalSkinParam(r);
      } else {
        r.seek(start);
        for (const n of b.nodes) { n.name = ss.readString(r); n.length = r.f32(); n.rotation = r.vec(3); }
      }
    });
    r.skip(20);
    return b;
  },
  EXP(r) {
    const b = { type: 'EXP' };
    readNodeHeader(r, b);
    b.name = r.strOffset();
    const count = r.i32();
    b.expressions = [];
    for (let i = 0; i < count; i++) b.expressions.push(r.strOffset());
    return b;
  },
  MOT(r, ss) {
    const b = { type: 'MOT' };
    readNodeHeader(r, b);
    const nameOffset = r.offset();
    const count = r.i32();
    const namesOffset = r.offset();
    const matricesOffset = r.offset();
    b.name = r.at(nameOffset, () => r.cstr()) ?? null;
    b.nodes = [];
    r.at(namesOffset, () => { for (let i = 0; i < count; i++) b.nodes.push({ name: ss.readString(r), transform: null }); });
    r.at(matricesOffset, () => { for (let i = 0; i < count; i++) b.nodes[i].transform = r.f32s(16); });
    return b;
  },
  CNS(r) {
    const b = { type: 'CNS' };
    readNodeHeader(r, b);
    const kind = r.strOffset();
    b.name = r.strOffset();
    b.coupling = r.i32();
    b.sourceNodeName = r.strOffset();
    b.data = { kind };
    switch (kind) {
      case 'Orientation': b.data.offset = r.vec(3); break;
      case 'Direction': b.data.upVector = readUpVector(r); b.data.alignAxis = r.vec(3); b.data.targetOffset = r.vec(3); break;
      case 'Position': b.data.upVector = readUpVector(r); b.data.constrained = readAttach(r); b.data.constraining = readAttach(r); break;
      case 'Distance': b.data.upVector = readUpVector(r); b.data.distance = r.f32(); b.data.constrained = readAttach(r); b.data.constraining = readAttach(r); break;
      default: throw new Error(`Unknown constraint type ${kind}`);
    }
    return b;
  },
  CLS(r) {
    const b = { type: 'CLS' };
    b.name = r.strOffset();
    b.backFaceName = r.strOffset();
    b.field08 = r.u32();
    const count = r.i32();
    b.field10 = r.u32();
    b.field14 = r.u32();
    b.matrices = new Array(32).fill(null);
    r.readOffset(() => { for (let i = 0; i < 32; i++) if (b.field10 & (1 << i)) b.matrices[i] = r.f32s(16); });
    b.field1C = [];
    r.readOffset(() => {
      for (let i = 0; i < count; i++) {
        const d = { floats: r.f32s(7), u: [r.u32(), r.u32(), r.u32()], sub: [] };
        for (let j = 0; j < 4; j++) d.sub.push({ name: r.strOffset(), f: r.f32(), a: r.u32(), b: r.u32() });
        b.field1C.push(d);
      }
    });
    b.field20 = [];
    r.readOffset(() => {
      for (let i = 0; i < count; i++) {
        const d = [];
        for (let j = 0; j < 10; j++) d.push({ u: r.u32(), f: r.f32s(10) });
        b.field20.push(d);
      }
    });
    r.readOffset(() => { b.field24 = r.u16s(r.u16()); });
    r.readOffset(() => { b.field28 = r.u16s(r.u16()); });
    r.readOffset(() => { b.internalSkinParam = readInternalSkinParam(r); });
    b.field30 = r.u32();
    return b;
  },
};

const BLOCK_WRITERS = {
  OSG(w, b, ss, format) {
    writeNodeHeader(w, b);
    w.i32(b.startIndex);
    w.i32(b.nodes.length);
    ss.write(w, b.externalName);
    ss.write(w, b.name);
    const hasRotation = b.nodes.some((n) => n.rotation && n.rotation.some((v) => Math.abs(v) > 0));
    if (format === 'FT') {
      w.offset(4, 'left', () => {
        for (const n of b.nodes) { ss.write(w, n.name); w.f32(n.length); w.vec(n.rotation ?? [0, 0, 0]); }
      }, { condition: hasRotation });
    } else {
      w.offset(16, 'left', () => writeInternalSkinParam(w, b.internalSkinParam), { condition: !!b.internalSkinParam });
    }
    w.nulls(20);
  },
  EXP(w, b) {
    writeNodeHeader(w, b);
    w.strOffset(b.name);
    w.i32(b.expressions.length);
    for (const e of b.expressions) w.strOffset(e);
    w.nulls((9 - b.expressions.length) * 4);
  },
  MOT(w, b, ss) {
    writeNodeHeader(w, b);
    w.strOffset(b.name);
    w.i32(b.nodes.length);
    w.offset(16, 'left', () => { for (const n of b.nodes) ss.write(w, n.name); });
    w.offset(16, 'left', () => { for (const n of b.nodes) w.f32s(n.transform ?? IDENTITY); });
  },
  CNS(w, b) {
    writeNodeHeader(w, b);
    w.strOffset(b.data.kind);
    w.strOffset(b.name);
    w.i32(b.coupling);
    w.strOffset(b.sourceNodeName);
    const d = b.data;
    switch (d.kind) {
      case 'Orientation': w.vec(d.offset); break;
      case 'Direction': writeUpVector(w, d.upVector); w.vec(d.alignAxis); w.vec(d.targetOffset); break;
      case 'Position': writeUpVector(w, d.upVector); writeAttach(w, d.constrained); writeAttach(w, d.constraining); break;
      case 'Distance': writeUpVector(w, d.upVector); w.f32(d.distance); writeAttach(w, d.constrained); writeAttach(w, d.constraining); break;
    }
  },
  CLS(w, b) {
    w.strOffset(b.name);
    w.strOffset(b.backFaceName);
    w.u32(b.field08);
    w.i32(b.field1C.length);
    w.u32(b.field10);
    w.u32(b.field14);
    w.offset(16, 'left', () => { for (let i = 0; i < 32; i++) if (b.field10 & (1 << i)) w.f32s(b.matrices[i] ?? IDENTITY); });
    w.offset(16, 'left', () => {
      for (const d of b.field1C) {
        w.f32s(d.floats); for (const u of d.u) w.u32(u);
        for (const s of d.sub) { w.strOffset(s.name); w.f32(s.f); w.u32(s.a); w.u32(s.b); }
      }
    });
    w.offset(16, 'left', () => { for (const d of b.field20) for (const s of d) { w.u32(s.u); w.f32s(s.f); } });
    w.offset(16, 'left', () => { w.u16(b.field24?.length ?? 0); w.u16s(b.field24 ?? []); });
    w.offset(16, 'left', () => { w.u16(b.field28?.length ?? 0); w.u16s(b.field28 ?? []); });
    w.offset(16, 'left', () => writeInternalSkinParam(w, b.internalSkinParam), { condition: !!b.internalSkinParam });
    w.u32(b.field30);
  },
};

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// ---------------------------------------------------------------- skin
function readSkin(r) {
  const boneIdsOffset = r.offset();
  const boneMatricesOffset = r.offset();
  const boneNamesOffset = r.offset();
  const exDataOffset = r.offset();
  const boneCount = r.i32();
  const boneParentIdsOffset = r.offset();
  const skin = { bones: [], blocks: [] };

  r.at(boneIdsOffset, () => {
    for (let i = 0; i < boneCount; i++) {
      const id = r.u32();
      skin.bones.push({ id, isEx: (id & 0x8000) !== 0, name: null, ibm: null, parentName: null });
    }
  });
  r.at(boneMatricesOffset, () => { for (const b of skin.bones) b.ibm = r.f32s(16); });
  r.at(boneNamesOffset, () => { for (const b of skin.bones) b.name = r.strOffset(); });

  r.at(exDataOffset, () => {
    r.i32(); // osage count
    const osageNodeCount = r.i32();
    r.skip(4);
    const osageNodesOffset = r.offset();
    r.offset(); // osage names
    const blocksOffset = r.offset();
    const stringCount = r.i32();
    const stringsOffset = r.offset();
    const siblingOffset = r.offset();
    r.i32(); // cloth count
    const ss = StringSet.read(r, stringsOffset, stringCount);
    const osageNodes = [];
    r.at(osageNodesOffset, () => {
      for (let i = 0; i < osageNodeCount; i++) {
        osageNodes.push({ name: ss.readString(r), length: r.f32() });
        r.skip(4);
      }
    });
    r.at(blocksOffset, () => {
      for (let guard = 0; guard < 100000; guard++) {
        const sig = r.strOffset();
        const off = r.offset();
        if (off === 0) break;
        r.at(off, () => {
          const reader = BLOCK_READERS[sig];
          if (!reader) { skin.blocks.push({ type: 'UNKNOWN', signature: sig }); return; }
          skin.blocks.push(reader(r, ss));
        });
      }
    });
    const siblings = [];
    r.at(siblingOffset, () => {
      for (let guard = 0; guard < 100000; guard++) {
        const boneName = ss.readString(r);
        if (boneName == null) break;
        siblings.push({ boneName, siblingName: ss.readString(r), distance: r.f32() });
      }
    });
    for (const b of skin.blocks) {
      if (b.type !== 'OSG') continue;
      for (let i = 0; i < b.count; i++) {
        const donor = osageNodes[b.startIndex + i];
        if (!donor) continue;
        b.nodes[i].name = donor.name;
        b.nodes[i].length = donor.length;
      }
      for (const n of b.nodes) {
        const s = siblings.find((x) => x.boneName === n.name);
        if (s) { n.siblingName = s.siblingName; n.siblingMaxDistance = s.distance; }
      }
    }
    skin.blocks = skin.blocks.filter((b) => b.type !== 'UNKNOWN');
  });

  r.at(boneParentIdsOffset, () => {
    const ids = [];
    for (let i = 0; i < skin.bones.length; i++) ids.push(r.u32());
    for (let i = 0; i < skin.bones.length; i++) {
      if (ids[i] === 0xffffffff) continue;
      const p = skin.bones.find((b) => b.id === ids[i]);
      skin.bones[i].parentName = p ? p.name : null;
    }
  });
  return skin;
}

function writeSkin(w, skin, format) {
  const ss = StringSet.fromSkin(skin);
  for (const b of skin.bones) if (b.isEx) b.id = ss.id(b.name);
  const idByName = new Map(skin.bones.map((b) => [b.name, b.id]));

  w.offset(16, 'center', () => { for (const b of skin.bones) w.u32(b.id); });
  w.offset(16, 'center', () => { for (const b of skin.bones) w.f32s(b.ibm ?? IDENTITY); });
  w.offset(16, 'center', () => { for (const b of skin.bones) w.strOffset(b.name); w.nulls(4); });
  w.offset(16, 'center', () => {
    const osageNames = [];
    const osageNodes = [];
    const clothNames = [];
    for (const b of skin.blocks) {
      if (b.type === 'OSG') { b.startIndex = osageNodes.length; osageNodes.push(...b.nodes); osageNames.push(b.externalName); }
      else if (b.type === 'CLS') clothNames.push(b.name);
    }
    w.i32(osageNames.length);
    w.i32(osageNodes.length);
    w.nulls(4);
    w.offset(4, 'left', () => {
      for (const n of osageNodes) {
        const id = ss.id(n.name);
        w.u32(id); w.f32(n.length); w.u32(id & 0x7fff);
      }
      w.nulls(12);
    });
    w.offset(16, 'left', () => {
      for (const v of osageNames) w.strOffset(v);
      for (const v of clothNames) w.strOffset(v);
      w.nulls(4);
    });
    w.offset(16, 'left', () => {
      for (const b of skin.blocks) {
        w.strOffset(b.type);
        w.offset(8, 'left', () => BLOCK_WRITERS[b.type](w, b, ss, format));
      }
      w.nulls(8);
    });
    w.i32(ss.strings.length);
    w.offset(16, 'left', () => { for (const v of ss.strings) w.strOffset(v); w.nulls(4); });
    w.offset(16, 'left', () => {
      for (const n of osageNodes) {
        if (!n.siblingName) continue;
        ss.write(w, n.name); ss.write(w, n.siblingName); w.f32(n.siblingMaxDistance ?? 0);
      }
      w.nulls(12);
    });
    w.i32(clothNames.length);
    w.nulls(28);
  }, { condition: ss.strings.length > 0 || skin.blocks.length > 0 });
  w.i32(skin.bones.length);
  w.offset(16, 'center', () => {
    for (const b of skin.bones) w.u32(b.parentName != null && idByName.has(b.parentName) ? idByName.get(b.parentName) : 0xffffffff);
  }, { condition: skin.bones.some((b) => b.parentName != null) });
  w.nulls(12);
}

// ---------------------------------------------------------------- mesh / submesh / object
function readSubMesh(r) {
  r.skip(4);
  const sm = {};
  sm.boundingSphere = r.vec(4);
  sm.materialIndex = r.u32();
  sm.texCoordIndices = r.bytesN(8);
  const boneIndexCount = r.i32();
  const boneIndicesOffset = r.offset();
  sm.bonesPerVertex = r.u32();
  sm.primitiveType = r.u32();
  sm.indexFormat = r.i32();
  const indexCount = r.i32();
  const indicesOffset = r.offset();
  sm.flags = r.i32();
  r.skip(24);
  sm.indexOffset = r.u32();
  sm.boneIndices = sm.bonesPerVertex === 4 ? r.at(boneIndicesOffset, () => r.u16s(boneIndexCount)) ?? null : null;
  sm.indices = r.at(indicesOffset, () => {
    const out = new Uint32Array(indexCount);
    for (let i = 0; i < indexCount; i++) {
      if (sm.indexFormat === 0) { const v = r.u8(); out[i] = v === 0xff ? 0xffffffff : v; }
      else if (sm.indexFormat === 1) { const v = r.u16(); out[i] = v === 0xffff ? 0xffffffff : v; }
      else out[i] = r.u32();
    }
    return out;
  }) ?? new Uint32Array(0);
  return sm;
}

function writeSubMesh(w, sm) {
  w.u32(0);
  w.vec(sm.boundingSphere);
  w.u32(sm.materialIndex);
  w.bytes(sm.texCoordIndices?.length === 8 ? sm.texCoordIndices : new Uint8Array(8));
  w.i32(sm.boneIndices?.length ?? 0);
  w.offset(4, 'left', () => w.u16s(sm.boneIndices), { condition: !!sm.boneIndices });
  w.u32(sm.bonesPerVertex);
  w.u32(sm.primitiveType);
  w.i32(sm.indexFormat);
  w.i32(sm.indices.length);
  w.offset(8, 'left', () => {
    for (const idx of sm.indices) {
      if (sm.indexFormat === 0) w.u8(idx === 0xffffffff ? 0xff : idx);
      else if (sm.indexFormat === 1) w.u16(idx === 0xffffffff ? 0xffff : idx);
      else w.u32(idx);
    }
  }, { priority: 1 });
  w.i32(sm.flags);
  w.nulls(24);
  w.u32(sm.indexOffset ?? 0);
}

function readMesh(r) {
  r.skip(4);
  const m = { subMeshes: [] };
  m.boundingSphere = r.vec(4);
  const subMeshCount = r.i32();
  const subMeshesOffset = r.offset();
  const vertexFormat = r.u32();
  r.i32(); // vertex size
  const vertexCount = r.i32();
  const attributeOffsets = [];
  for (let i = 0; i < 20; i++) attributeOffsets.push(r.offset());
  m.flags = r.i32();
  r.u32(); // vertex format index (modern)
  r.skip(24);
  m.name = r.fixedStr(64);
  m.vertexCount = vertexCount;
  if (vertexFormat & ATTR.Modern) throw new Error('Modern (F2nd/X) object sets are not supported; use MM+/FT/DT _obj.bin files.');
  r.at(subMeshesOffset, () => { for (let i = 0; i < subMeshCount; i++) m.subMeshes.push(readSubMesh(r)); });
  for (const [bit, key, comps] of ATTR_FIELDS) {
    const i = Math.log2(bit);
    if (vertexFormat & bit) m[key] = r.at(attributeOffsets[i], () => r.f32s(vertexCount * comps)) ?? null;
  }
  if ((vertexFormat & ATTR.BlendWeight) && (vertexFormat & ATTR.BlendIndices)) {
    const weights = r.at(attributeOffsets[10], () => r.f32s(vertexCount * 4));
    const raw = r.at(attributeOffsets[11], () => r.f32s(vertexCount * 4));
    if (weights && raw) {
      const idx = new Int16Array(vertexCount * 4);
      for (let v = 0; v < vertexCount; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += weights[v * 4 + k];
        for (let k = 0; k < 4; k++) {
          if (sum > 0) weights[v * 4 + k] /= sum;
          const wv = weights[v * 4 + k];
          const iv = raw[v * 4 + k];
          idx[v * 4 + k] = wv > 0 && iv >= 0 ? Math.floor(iv / 3 + 0.5) : -1;
        }
      }
      m.blendWeights = weights;
      m.blendIndices = idx;
    }
  }
  return m;
}

function writeMesh(w, m) {
  w.u32(0);
  w.vec(m.boundingSphere);
  w.i32(m.subMeshes.length);
  w.offset(8, 'left', () => { for (const sm of m.subMeshes) writeSubMesh(w, sm); });
  let format = 0, size = 0;
  for (const [bit, key, comps] of ATTR_FIELDS) if (m[key]) { format |= bit; size += comps * 4; }
  if (m.blendWeights) { format |= ATTR.BlendWeight | ATTR.BlendIndices; size += 32; }
  const vertexCount = m.positions.length / 3;
  w.u32(format);
  w.i32(size);
  w.i32(vertexCount);
  for (let i = 0; i < 20; i++) {
    const bit = 1 << i;
    const field = ATTR_FIELDS.find((f) => f[0] === bit);
    const cond = (format & bit) !== 0;
    w.offset(4, 'left', () => {
      if (field) w.f32s(m[field[1]]);
      else if (bit === ATTR.BlendWeight) w.f32s(m.blendWeights);
      else if (bit === ATTR.BlendIndices) {
        for (const iv of m.blendIndices) w.f32(iv < 0 ? -1 : iv * 3);
      }
    }, { condition: cond, priority: bit + 1 });
  }
  w.i32(m.flags ?? 0);
  w.u32(0);
  w.nulls(24);
  w.fixedStr(m.name ?? '', 64);
}

// Material layout (0x4B0 bytes): header(20) + 8 textures(120 each) + blend(4) + colours(64)
// + shininess/intensity(8) + sphere(16) + name(64) + bump(4) + reserved(60).
function readMaterial(r) {
  const start = r.pos;
  const raw = r.bytesN(MATERIAL_SIZE);
  const textureIds = [];
  for (let i = 0; i < 8; i++) { r.seek(start + 20 + i * 120 + 4); textureIds.push(r.u32()); }
  r.seek(start + 20 + 960 + 4);
  const diffuse = r.vec(4);
  r.seek(start + 1072);
  const name = r.fixedStr(64);
  r.seek(start + MATERIAL_SIZE);
  return { raw, textureIds, diffuse, name };
}

function readObject(r) {
  r.u32(); // signature 0x10000
  r.skip(4);
  const obj = { meshes: [], materials: [] };
  obj.boundingSphere = r.vec(4);
  const meshCount = r.i32();
  const meshesOffset = r.offset();
  const materialCount = r.i32();
  const materialsOffset = r.offset();
  r.skip(40);
  for (let i = 0; i < meshCount; i++) obj.meshes.push(r.at(meshesOffset + i * 0xd8, () => readMesh(r)));
  for (let i = 0; i < materialCount; i++) obj.materials.push(r.at(materialsOffset + i * MATERIAL_SIZE, () => readMaterial(r)));
  return obj;
}

function writeObject(w, obj) {
  w.u32(0x10000);
  w.u32(0);
  w.vec(obj.boundingSphere);
  w.i32(obj.meshes.length);
  w.offset(8, 'left', () => { for (const m of obj.meshes) writeMesh(w, m); });
  w.i32(obj.materials.length);
  w.offset(8, 'left', () => { for (const mat of obj.materials) w.bytes(mat.raw); });
  w.nulls(40);
}

// ---------------------------------------------------------------- object set
export function readObjectSet(bytes) {
  const r = new BinReader(bytes, true);
  const sig = r.u32();
  if (sig !== 0x5062500 && sig !== 0x5062501) throw new Error('Not a classic Project DIVA object set (_obj.bin)');
  const objectCount = r.i32();
  r.i32();
  const objectsOffset = r.offset();
  const skinsOffset = r.offset();
  const namesOffset = r.offset();
  const idsOffset = r.offset();
  const texIdsOffset = r.offset();
  const texIdCount = r.i32();
  const set = { objects: [], textureIds: [], format: 'DT' };
  r.at(objectsOffset, () => {
    for (let i = 0; i < objectCount; i++) {
      const off = r.offset();
      r.at(off, () => { r.pushBase(); set.objects.push(readObject(r)); r.popBase(); });
    }
  });
  r.at(skinsOffset, () => {
    for (const obj of set.objects) {
      obj.skin = r.readOffset(() => readSkin(r)) ?? null;
      for (const b of obj.skin?.blocks ?? []) {
        if (b.type === 'OSG' && b.nodes.some((n) => n.rotation.some((v) => Math.abs(v) > 0))) set.format = 'FT';
      }
    }
  });
  r.at(namesOffset, () => { for (const obj of set.objects) obj.name = r.strOffset(); });
  r.at(idsOffset, () => { for (const obj of set.objects) obj.id = r.u32(); });
  r.at(texIdsOffset, () => { for (let i = 0; i < texIdCount; i++) set.textureIds.push(r.u32()); });
  return set;
}

export function writeObjectSet(set, format = set.format ?? 'FT') {
  const w = new BinWriter(true);
  w.pushStringTable(16, 'center');
  w.u32(OBJSET_SIGNATURE);
  w.i32(set.objects.length);
  w.u32(0x39393939);
  w.offset(16, 'center', () => {
    for (const obj of set.objects) {
      w.offset(4, 'center', () => { w.pushBase(); writeObject(w, obj); w.popBase(); });
    }
  });
  w.offset(16, 'center', () => {
    for (const obj of set.objects) w.offset(16, 'left', () => writeSkin(w, obj.skin, format), { condition: !!obj.skin });
  });
  w.offset(16, 'center', () => { for (const obj of set.objects) w.offset(16, 'left', () => w.cstr(obj.name)); });
  w.offset(16, 'center', () => { for (const obj of set.objects) w.u32(obj.id >>> 0); });
  w.offset(16, 'center', () => { for (const id of set.textureIds) w.u32(id); });
  w.i32(set.textureIds.length);
  w.performScheduledWrites();
  w.popStringTable();
  return w.toBytes();
}

// ---------------------------------------------------------------- helpers
export function triangleIndices(sm) {
  if (sm.primitiveType === 4) return sm.indices.filter((i) => i !== 0xffffffff);
  if (sm.primitiveType !== 5) return new Uint32Array(0);
  const out = [];
  let a = null, b = null, flip = false;
  for (const idx of sm.indices) {
    if (idx === 0xffffffff) { a = b = null; flip = false; continue; }
    if (a === null) { a = idx; continue; }
    if (b === null) { b = idx; continue; }
    if (a !== b && b !== idx && a !== idx) out.push(...(flip ? [b, a, idx] : [a, b, idx]));
    a = b; b = idx; flip = !flip;
  }
  return Uint32Array.from(out);
}

export function computeBoundingSphere(positions, indices = null) {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const visit = (i) => {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  };
  if (indices) { for (const i of indices) if (i !== 0xffffffff) visit(i); }
  else for (let i = 0; i < positions.length / 3; i++) visit(i);
  if (minX === Infinity) return [0, 0, 0, 0];
  const c = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let r2 = 0;
  const check = (i) => {
    const dx = positions[i * 3] - c[0], dy = positions[i * 3 + 1] - c[1], dz = positions[i * 3 + 2] - c[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  };
  if (indices) { for (const i of indices) if (i !== 0xffffffff) check(i); }
  else for (let i = 0; i < positions.length / 3; i++) check(i);
  return [c[0], c[1], c[2], Math.sqrt(r2)];
}
