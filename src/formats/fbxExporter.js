// Binary FBX 7.4 writer: meshes (multi-material), skeleton (LimbNodes), skin clusters,
// bind pose, blend shapes, materials with embedded textures, and skeletal + blend shape
// animation. Output loads in Blender, Unity, Unreal and Autodesk tools.
import * as THREE from 'three';
import { zlibSync } from 'fflate';

const enc = new TextEncoder();
const KTIME = 46186158000n;
const FOOT_ID = [0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e];
const FILE_ID = [0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1];
const FOOT_MAGIC = [0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b];

// ------------------------------------------------------------------ node model
class N {
  constructor(name, props = [], children = []) { this.name = name; this.props = props; this.children = children; }
  add(...c) { this.children.push(...c); return this; }
}
const S = (v) => ({ t: 'S', v: String(v) });
const I = (v) => ({ t: 'I', v });
const L = (v) => ({ t: 'L', v: BigInt(v) });
const D = (v) => ({ t: 'D', v });
const F = (v) => ({ t: 'F', v });
const C = (v) => ({ t: 'C', v: !!v });
const R = (v) => ({ t: 'R', v });
const Ad = (v) => ({ t: 'd', v: Float64Array.from(v) });
const Af = (v) => ({ t: 'f', v: Float32Array.from(v) });
const Ai = (v) => ({ t: 'i', v: Int32Array.from(v) });
const Al = (v) => ({ t: 'l', v: BigInt64Array.from(v, (x) => BigInt(x)) });
const P = (name, type, label, flags, ...vals) => new N('P', [S(name), S(type), S(label), S(flags), ...vals]);
const P70 = (...ps) => new N('Properties70', [], ps);
const cls = (name, klass) => `${name}\u0000\u0001${klass}`;

class Out {
  constructor() { this.buf = new Uint8Array(1 << 20); this.len = 0; }
  ensure(n) { if (this.len + n > this.buf.length) { let s = this.buf.length; while (s < this.len + n) s *= 2; const b = new Uint8Array(s); b.set(this.buf.subarray(0, this.len)); this.buf = b; } }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.len); this.len += b.length; }
  u8(v) { this.ensure(1); this.buf[this.len++] = v; }
  u32(v) { this.ensure(4); new DataView(this.buf.buffer).setUint32(this.len, v >>> 0, true); this.len += 4; }
  i32(v) { this.ensure(4); new DataView(this.buf.buffer).setInt32(this.len, v, true); this.len += 4; }
  i16(v) { this.ensure(2); new DataView(this.buf.buffer).setInt16(this.len, v, true); this.len += 2; }
  i64(v) { this.ensure(8); new DataView(this.buf.buffer).setBigInt64(this.len, BigInt(v), true); this.len += 8; }
  f32(v) { this.ensure(4); new DataView(this.buf.buffer).setFloat32(this.len, v, true); this.len += 4; }
  f64(v) { this.ensure(8); new DataView(this.buf.buffer).setFloat64(this.len, v, true); this.len += 8; }
  patch32(at, v) { new DataView(this.buf.buffer).setUint32(at, v >>> 0, true); }
}

function writeProp(o, p) {
  o.u8(p.t.charCodeAt(0));
  switch (p.t) {
    case 'S': case 'R': { const b = p.t === 'S' ? enc.encode(p.v) : p.v; o.u32(b.length); o.bytes(b); break; }
    case 'I': o.i32(p.v); break;
    case 'L': o.i64(p.v); break;
    case 'D': o.f64(p.v); break;
    case 'F': o.f32(p.v); break;
    case 'C': o.u8(p.v ? 1 : 0); break;
    case 'Y': o.i16(p.v); break;
    default: { // arrays
      const raw = new Uint8Array(p.v.buffer, p.v.byteOffset, p.v.byteLength);
      const compress = raw.length > 128;
      const data = compress ? zlibSync(raw) : raw;
      o.u32(p.v.length); o.u32(compress ? 1 : 0); o.u32(data.length); o.bytes(data);
    }
  }
}

function writeNode(o, n) {
  const start = o.len;
  o.u32(0); o.u32(n.props.length); o.u32(0);
  const nameBytes = enc.encode(n.name);
  o.u8(nameBytes.length); o.bytes(nameBytes);
  const propStart = o.len;
  for (const p of n.props) writeProp(o, p);
  o.patch32(start + 8, o.len - propStart);
  if (n.children.length) { for (const c of n.children) writeNode(o, c); o.bytes(new Uint8Array(13)); }
  else if (!n.props.length) o.bytes(new Uint8Array(13));
  o.patch32(start, o.len);
}

export function serializeFBX(nodes, version = 7400) {
  const o = new Out();
  o.bytes(enc.encode('Kaydara FBX Binary  \u0000'));
  o.u8(0x1a); o.u8(0x00);
  o.u32(version);
  for (const n of nodes) writeNode(o, n);
  o.bytes(new Uint8Array(13));
  o.bytes(Uint8Array.from(FOOT_ID));
  o.bytes(new Uint8Array(4));
  let pad = ((o.len + 15) & ~15) - o.len;
  if (pad === 0) pad = 16;
  o.bytes(new Uint8Array(pad));
  o.u32(version);
  o.bytes(new Uint8Array(120));
  o.bytes(Uint8Array.from(FOOT_MAGIC));
  return o.buf.slice(0, o.len);
}

// ------------------------------------------------------------------ scene conversion
let nextId = 1000000;
const uid = () => nextId++;
const DEG = 180 / Math.PI;

function eulerDeg(q) {
  // FBX XYZ rotation order (X applied first) == three.js 'ZYX'
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  return [e.x * DEG, e.y * DEG, e.z * DEG];
}
const m4 = (m) => Array.from(m.elements); // column-major, matches FBX

function exportName(o) { return o.userData?.exportName ?? o.name ?? 'Object'; }

async function imageBytes(texture) {
  const img = texture?.image;
  if (!img) return null;
  if (texture.userData?.sourceBytes) return { bytes: texture.userData.sourceBytes, ext: texture.userData.sourceExt ?? 'png' };
  if (typeof document !== 'undefined' && (img.width || img.videoWidth)) {
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (img.data) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    else ctx.drawImage(img, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png' };
  }
  return null;
}

/**
 * Export a model (and optional clips) to binary FBX.
 * @param {THREE.Object3D} root   export root (its own transform is not written)
 * @param {{clips?: THREE.AnimationClip[], units?: 'cm'|'m', fps?: number, embedTextures?: boolean, name?: string}} opts
 * @returns {Promise<Uint8Array>}
 */
export async function exportFBX(root, opts = {}) {
  const unitScale = (opts.units ?? 'cm') === 'cm' ? 100 : 1;
  const fps = opts.fps ?? 30;
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rel = (o) => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
  const scaleM = (m) => { const c = m.clone(); c.elements[12] *= unitScale; c.elements[13] *= unitScale; c.elements[14] *= unitScale; return c; };

  const objects = new N('Objects');
  const connections = new N('Connections');
  const conn = (child, parent, prop) => connections.add(new N('C', prop ? [S('OP'), L(child), L(parent), S(prop)] : [S('OO'), L(child), L(parent)]));
  const counts = {};
  const count = (t) => { counts[t] = (counts[t] ?? 0) + 1; };

  // ---- bones / nodes
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  const boneId = new Map();
  const restLocal = new Map();
  for (const b of bones) {
    const id = uid();
    boneId.set(b, id);
    const parentRel = b.parent && b.parent !== root ? rel(b.parent) : new THREE.Matrix4();
    const local = new THREE.Matrix4().multiplyMatrices(parentRel.clone().invert(), rel(b));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    local.decompose(p, q, s);
    restLocal.set(b, { p, q, s });
    const attr = uid();
    objects.add(new N('NodeAttribute', [L(attr), S(cls(exportName(b), 'NodeAttribute')), S('LimbNode')], [new N('TypeFlags', [S('Skeleton')])]));
    count('NodeAttribute');
    objects.add(new N('Model', [L(id), S(cls(exportName(b), 'Model')), S('LimbNode')], [
      new N('Version', [I(232)]),
      P70(
        P('Lcl Translation', 'Lcl Translation', '', 'A', D(p.x * unitScale), D(p.y * unitScale), D(p.z * unitScale)),
        P('Lcl Rotation', 'Lcl Rotation', '', 'A', ...eulerDeg(q).map(D)),
        P('Lcl Scaling', 'Lcl Scaling', '', 'A', D(s.x), D(s.y), D(s.z)),
        P('InheritType', 'enum', '', '', I(1)),
        P('DefaultAttributeIndex', 'int', 'Integer', '', I(0)),
      ),
      new N('Shading', [C(true)]), new N('Culling', [S('CullingOff')]),
    ]));
    count('Model');
    conn(attr, id);
  }
  for (const b of bones) {
    let p = b.parent;
    while (p && p !== root && !boneId.has(p)) p = p.parent;
    conn(boneId.get(b), p && p !== root ? boneId.get(p) : 0);
  }

  // ---- materials (shared)
  const matId = new Map();
  const textureId = new Map();
  const materialNode = async (mat) => {
    if (matId.has(mat)) return matId.get(mat);
    const id = uid();
    matId.set(mat, id);
    const c = mat.color ?? new THREE.Color(1, 1, 1);
    objects.add(new N('Material', [L(id), S(cls(mat.name || 'Material', 'Material')), S('')], [
      new N('Version', [I(102)]), new N('ShadingModel', [S('phong')]), new N('MultiLayer', [I(0)]),
      P70(
        P('DiffuseColor', 'Color', '', 'A', D(c.r), D(c.g), D(c.b)),
        P('Diffuse', 'Vector3D', 'Vector', '', D(c.r), D(c.g), D(c.b)),
        P('Opacity', 'double', 'Number', '', D(mat.opacity ?? 1)),
        P('TransparencyFactor', 'Number', '', 'A', D(1 - (mat.opacity ?? 1))),
      ),
    ]));
    count('Material');
    const map = mat.map;
    if (map && opts.embedTextures !== false) {
      let tid = textureId.get(map);
      if (!tid) {
        const img = await imageBytes(map);
        tid = uid();
        textureId.set(map, tid);
        const fname = `${(map.name || mat.name || 'texture').replace(/[^\w.-]/g, '_')}_${tid}.${img?.ext ?? 'png'}`;
        const vid = uid();
        objects.add(new N('Video', [L(vid), S(cls(fname, 'Video')), S('Clip')], [
          new N('Type', [S('Clip')]), P70(P('Path', 'KString', 'XRefUrl', '', S(fname))),
          new N('UseMipMap', [I(0)]), new N('Filename', [S(fname)]), new N('RelativeFilename', [S(fname)]),
          ...(img ? [new N('Content', [R(img.bytes)])] : []),
        ]));
        count('Video');
        objects.add(new N('Texture', [L(tid), S(cls(fname, 'Texture')), S('')], [
          new N('Type', [S('TextureVideoClip')]), new N('Version', [I(202)]), new N('TextureName', [S(cls(fname, 'Texture'))]),
          P70(P('UseMaterial', 'bool', '', '', I(1))),
          new N('Media', [S(cls(fname, 'Video'))]), new N('FileName', [S(fname)]), new N('RelativeFilename', [S(fname)]),
          new N('ModelUVTranslation', [D(0), D(0)]), new N('ModelUVScaling', [D(1), D(1)]),
          new N('Texture_Alpha_Source', [S('None')]), new N('Cropping', [I(0), I(0), I(0), I(0)]),
        ]));
        count('Texture');
        conn(vid, tid);
      }
      conn(tid, id, 'DiffuseColor');
    }
    return id;
  };

  // ---- meshes
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const poseNodes = [];
  const morphChannels = new Map(); // mesh -> name -> channel id
  for (const mesh of meshes) {
    const geo = mesh.geometry.index ? mesh.geometry : mesh.geometry.clone().setIndex([...Array(mesh.geometry.attributes.position.count).keys()]);
    const M = rel(mesh);
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    const verts = new Float64Array(pos.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(M).multiplyScalar(unitScale); verts.set([v.x, v.y, v.z], i * 3); }
    const idx = geo.index.array;
    const polys = new Int32Array(idx.length);
    for (let t = 0; t < idx.length; t += 3) { polys[t] = idx[t]; polys[t + 1] = idx[t + 1]; polys[t + 2] = ~idx[t + 2]; }
    const normals = new Float64Array(idx.length * 3);
    if (nor) for (let k = 0; k < idx.length; k++) { v.fromBufferAttribute(nor, idx[k]).applyMatrix3(nm).normalize(); normals.set([v.x, v.y, v.z], k * 3); }
    const layers = [];
    const geoChildren = [
      new N('Vertices', [Ad(verts)]), new N('PolygonVertexIndex', [Ai(polys)]), new N('GeometryVersion', [I(124)]),
    ];
    if (nor) {
      geoChildren.push(new N('LayerElementNormal', [I(0)], [new N('Version', [I(101)]), new N('Name', [S('')]),
        new N('MappingInformationType', [S('ByPolygonVertex')]), new N('ReferenceInformationType', [S('Direct')]), new N('Normals', [Ad(normals)])]));
      layers.push('LayerElementNormal');
    }
    if (uv) {
      const uvs = new Float64Array(uv.count * 2);
      for (let i = 0; i < uv.count; i++) { uvs[i * 2] = uv.getX(i); uvs[i * 2 + 1] = uv.getY(i); }
      geoChildren.push(new N('LayerElementUV', [I(0)], [new N('Version', [I(101)]), new N('Name', [S('UVMap')]),
        new N('MappingInformationType', [S('ByPolygonVertex')]), new N('ReferenceInformationType', [S('IndexToDirect')]),
        new N('UV', [Ad(uvs)]), new N('UVIndex', [Ai(idx)])]));
      layers.push('LayerElementUV');
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const polyMat = new Int32Array(idx.length / 3);
    if (geo.groups.length) for (const g of geo.groups) for (let t = g.start / 3; t < (g.start + g.count) / 3; t++) polyMat[t] = Math.min(g.materialIndex ?? 0, mats.length - 1);
    geoChildren.push(new N('LayerElementMaterial', [I(0)], [new N('Version', [I(101)]), new N('Name', [S('')]),
      new N('MappingInformationType', [S(mats.length > 1 ? 'ByPolygon' : 'AllSame')]), new N('ReferenceInformationType', [S('IndexToDirect')]),
      new N('Materials', [Ai(mats.length > 1 ? polyMat : [0])])]));
    layers.push('LayerElementMaterial');
    geoChildren.push(new N('Layer', [I(0)], [new N('Version', [I(100)]), ...layers.map((t) => new N('LayerElement', [], [new N('Type', [S(t)]), new N('TypedIndex', [I(0)])]))]));
    const gid = uid(), mid = uid();
    const name = exportName(mesh);
    objects.add(new N('Geometry', [L(gid), S(cls(name, 'Geometry')), S('Mesh')], geoChildren));
    count('Geometry');
    objects.add(new N('Model', [L(mid), S(cls(name, 'Model')), S('Mesh')], [
      new N('Version', [I(232)]),
      P70(P('Lcl Translation', 'Lcl Translation', '', 'A', D(0), D(0), D(0)), P('Lcl Rotation', 'Lcl Rotation', '', 'A', D(0), D(0), D(0)),
        P('Lcl Scaling', 'Lcl Scaling', '', 'A', D(1), D(1), D(1)), P('DefaultAttributeIndex', 'int', 'Integer', '', I(0))),
      new N('Shading', [C(true)]), new N('Culling', [S('CullingOff')]),
    ]));
    count('Model');
    conn(gid, mid);
    conn(mid, 0);
    for (const mat of mats) conn(await materialNode(mat), mid);
    poseNodes.push([mid, new THREE.Matrix4()]);

    // blend shapes
    const morphs = geo.morphAttributes.position;
    if (morphs?.length && mesh.morphTargetDictionary) {
      const bsId = uid();
      objects.add(new N('Deformer', [L(bsId), S(cls(name, 'Deformer')), S('BlendShape')], [new N('Version', [I(100)])]));
      count('Deformer');
      conn(bsId, gid);
      const lin = new THREE.Matrix3().setFromMatrix4(M);
      const channels = new Map();
      for (const [mname, mi] of Object.entries(mesh.morphTargetDictionary)) {
        const m = morphs[mi];
        if (!m) continue;
        const ids = [], deltas = [];
        for (let i = 0; i < m.count; i++) {
          v.fromBufferAttribute(m, i);
          if (!geo.morphTargetsRelative) v.sub(new THREE.Vector3().fromBufferAttribute(pos, i));
          v.applyMatrix3(lin).multiplyScalar(unitScale);
          if (v.lengthSq() > 1e-14) { ids.push(i); deltas.push(v.x, v.y, v.z); }
        }
        const shapeId = uid(), chId = uid();
        objects.add(new N('Geometry', [L(shapeId), S(cls(mname, 'Geometry')), S('Shape')], [
          new N('Version', [I(100)]), new N('Indexes', [Ai(ids.length ? ids : [0])]), new N('Vertices', [Ad(deltas.length ? deltas : [0, 0, 0])]),
        ]));
        objects.add(new N('Deformer', [L(chId), S(cls(mname, 'SubDeformer')), S('BlendShapeChannel')], [
          new N('Version', [I(100)]), new N('DeformPercent', [D((mesh.morphTargetInfluences?.[mi] ?? 0) * 100)]), new N('FullWeights', [Ad([100])]),
        ]));
        count('Geometry'); count('Deformer');
        conn(shapeId, chId);
        conn(chId, bsId);
        channels.set(mname, chId);
      }
      morphChannels.set(mesh, channels);
    }

    // skin
    if (mesh.isSkinnedMesh) {
      const skinId = uid();
      objects.add(new N('Deformer', [L(skinId), S(cls(name, 'Deformer')), S('Skin')], [new N('Version', [I(101)]), new N('Link_DeformAcuracy', [D(50)])]));
      count('Deformer');
      conn(skinId, gid);
      const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
      const per = new Map();
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w <= 0) continue;
        const b = si.getComponent(i, k);
        let e = per.get(b); if (!e) { e = [[], []]; per.set(b, e); }
        e[0].push(i); e[1].push(w);
      }
      mesh.skeleton.bones.forEach((bone, bi) => {
        if (!boneId.has(bone)) return;
        const e = per.get(bi) ?? [[], []];
        // bone bind matrix (relative to the export root) = inverse(boneInverse) in mesh-bind space
        const bindWorld = new THREE.Matrix4().copy(mesh.skeleton.boneInverses[bi]).invert().premultiply(mesh.bindMatrix.clone().invert()).premultiply(mesh.matrixWorld);
        const link = scaleM(new THREE.Matrix4().multiplyMatrices(rootInv, bindWorld));
        const transform = link.clone().invert();
        const cid = uid();
        objects.add(new N('Deformer', [L(cid), S(cls(exportName(bone), 'SubDeformer')), S('Cluster')], [
          new N('Version', [I(100)]), new N('UserData', [S(''), S('')]),
          new N('Indexes', [Ai(e[0])]), new N('Weights', [Ad(e[1])]),
          new N('Transform', [Ad(m4(transform))]), new N('TransformLink', [Ad(m4(link))]),
        ]));
        count('Deformer');
        conn(cid, skinId);
        conn(boneId.get(bone), cid);
      });
    }
  }
  for (const b of bones) poseNodes.push([boneId.get(b), scaleM(rel(b))]);
  const poseId = uid();
  objects.add(new N('Pose', [L(poseId), S(cls('BindPose', 'Pose')), S('BindPose')], [
    new N('Type', [S('BindPose')]), new N('Version', [I(100)]), new N('NbPoseNodes', [I(poseNodes.length)]),
    ...poseNodes.map(([id, m]) => new N('PoseNode', [], [new N('Node', [L(id)]), new N('Matrix', [Ad(m4(m))])])),
  ]));
  count('Pose');

  // ---- animation
  const clips = opts.clips ?? [];
  let maxTime = 0;
  const takes = [];
  const byName = new Map();
  root.traverse((o) => { byName.set(o.name, o); byName.set(o.uuid, o); });
  for (const clip of clips) {
    const stackId = uid(), layerId = uid();
    const stop = BigInt(Math.round(clip.duration * Number(KTIME)));
    maxTime = Math.max(maxTime, clip.duration);
    objects.add(new N('AnimationStack', [L(stackId), S(cls(clip.name || 'Take', 'AnimStack')), S('')], [P70(
      P('LocalStop', 'KTime', 'Time', '', L(stop)), P('ReferenceStop', 'KTime', 'Time', '', L(stop)))]));
    objects.add(new N('AnimationLayer', [L(layerId), S(cls('BaseLayer', 'AnimLayer')), S('')], []));
    count('AnimationStack'); count('AnimationLayer');
    conn(layerId, stackId);
    takes.push(new N('Take', [S(clip.name || 'Take')], [new N('FileName', [S(`${clip.name || 'Take'}.tak`)]),
      new N('LocalTime', [L(0), L(stop)]), new N('ReferenceTime', [L(0), L(stop)])]));

    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = Array.from({ length: frames }, (_, f) => Math.min(clip.duration, f / fps));
    const ktimes = times.map((t) => BigInt(Math.round(t * Number(KTIME))));
    const addCurve = (values, nodeId, channel) => {
      const cid = uid();
      objects.add(new N('AnimationCurve', [L(cid), S(cls('', 'AnimCurve')), S('')], [
        new N('Default', [D(values[0] ?? 0)]), new N('KeyVer', [I(4008)]), new N('KeyTime', [Al(ktimes)]),
        new N('KeyValueFloat', [Af(values)]), new N('KeyAttrFlags', [Ai([8452])]),
        new N('KeyAttrDataFloat', [Af([0, 0, 9.419963346924634e-30, 0])]), new N('KeyAttrRefCount', [Ai([values.length])]),
      ]));
      count('AnimationCurve');
      conn(cid, nodeId, channel);
    };
    const curveNode = (kind, target, prop, vals, channels = ['X', 'Y', 'Z']) => {
      const id = uid();
      objects.add(new N('AnimationCurveNode', [L(id), S(cls(kind, 'AnimCurveNode')), S('')], [P70(
        ...channels.map((c, i) => P(`d|${c}`, 'Number', '', 'A', D(vals[i][0] ?? 0))))]));
      count('AnimationCurveNode');
      conn(id, layerId);
      conn(id, target, prop);
      channels.forEach((c, i) => addCurve(vals[i], id, `d|${c}`));
    };
    // Sample with a mixer so every track type/interpolation is handled exactly
    const snapshot = [];
    root.traverse((x) => snapshot.push([x, x.position.clone(), x.quaternion.clone(), x.scale.clone(), x.morphTargetInfluences?.slice()]));
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const animatedBones = new Set();
    const morphTracks = new Map();
    for (const t of clip.tracks) {
      const parsed = THREE.PropertyBinding.parseTrackName(t.name);
      const node = byName.get(parsed.nodeName);
      if (!node) continue;
      if (node.isBone && boneId.has(node)) animatedBones.add(node);
      if (parsed.propertyName === 'morphTargetInfluences' && morphChannels.has(node)) {
        const ch = morphChannels.get(node).get(parsed.propertyIndex);
        if (ch) morphTracks.set(`${node.uuid}|${parsed.propertyIndex}`, { mesh: node, key: parsed.propertyIndex, ch });
      }
    }
    const series = new Map([...animatedBones].map((b) => [b, { t: [[], [], []], r: [[], [], []], s: [[], [], []] }]));
    const morphSeries = new Map([...morphTracks.keys()].map((k) => [k, []]));
    const prevEuler = new Map();
    for (const t of times) {
      mixer.setTime(t);
      root.updateMatrixWorld(true);
      for (const b of animatedBones) {
        const sr = series.get(b);
        sr.t.forEach((arr, i) => arr.push(b.position.getComponent(i) * unitScale));
        let e = eulerDeg(b.quaternion);
        const prev = prevEuler.get(b);
        if (prev) e = e.map((v, i) => { let x = v; while (x - prev[i] > 180) x -= 360; while (x - prev[i] < -180) x += 360; return x; });
        prevEuler.set(b, e);
        sr.r.forEach((arr, i) => arr.push(e[i]));
        sr.s.forEach((arr, i) => arr.push(b.scale.getComponent(i)));
      }
      for (const [k, m] of morphTracks) morphSeries.get(k).push((m.mesh.morphTargetInfluences[m.mesh.morphTargetDictionary[m.key]] ?? 0) * 100);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(root);
    for (const [x, p, q, sc, mi] of snapshot) { x.position.copy(p); x.quaternion.copy(q); x.scale.copy(sc); if (mi) x.morphTargetInfluences.splice(0, mi.length, ...mi); }
    for (const [b, sr] of series) {
      curveNode('T', boneId.get(b), 'Lcl Translation', sr.t);
      curveNode('R', boneId.get(b), 'Lcl Rotation', sr.r);
      curveNode('S', boneId.get(b), 'Lcl Scaling', sr.s);
    }
    for (const [k, m] of morphTracks) curveNode('DeformPercent', m.ch, 'DeformPercent', [morphSeries.get(k)], ['DeformPercent']);
  }
  root.updateMatrixWorld(true);

  // ---- assemble
  const now = new Date();
  const header = new N('FBXHeaderExtension', [], [
    new N('FBXHeaderVersion', [I(1003)]), new N('FBXVersion', [I(7400)]), new N('EncryptionType', [I(0)]),
    new N('CreationTimeStamp', [], [new N('Version', [I(1000)]), new N('Year', [I(now.getFullYear())]), new N('Month', [I(now.getMonth() + 1)]),
      new N('Day', [I(now.getDate())]), new N('Hour', [I(now.getHours())]), new N('Minute', [I(now.getMinutes())]), new N('Second', [I(now.getSeconds())]), new N('Millisecond', [I(0)])]),
    new N('Creator', [S('VRoid Super Converter')]),
  ]);
  const stop = BigInt(Math.round(maxTime * Number(KTIME)));
  const globals = new N('GlobalSettings', [], [new N('Version', [I(1000)]), P70(
    P('UpAxis', 'int', 'Integer', '', I(1)), P('UpAxisSign', 'int', 'Integer', '', I(1)),
    P('FrontAxis', 'int', 'Integer', '', I(2)), P('FrontAxisSign', 'int', 'Integer', '', I(1)),
    P('CoordAxis', 'int', 'Integer', '', I(0)), P('CoordAxisSign', 'int', 'Integer', '', I(1)),
    P('OriginalUpAxis', 'int', 'Integer', '', I(1)), P('OriginalUpAxisSign', 'int', 'Integer', '', I(1)),
    P('UnitScaleFactor', 'double', 'Number', '', D(100 / unitScale)), P('OriginalUnitScaleFactor', 'double', 'Number', '', D(100 / unitScale)),
    P('AmbientColor', 'ColorRGB', 'Color', '', D(0), D(0), D(0)), P('DefaultCamera', 'KString', '', '', S('Producer Perspective')),
    P('TimeMode', 'enum', '', '', I(fps === 60 ? 3 : fps === 24 ? 11 : 6)), P('TimeProtocol', 'enum', '', '', I(2)), P('SnapOnFrameMode', 'enum', '', '', I(0)),
    P('TimeSpanStart', 'KTime', 'Time', '', L(0)), P('TimeSpanStop', 'KTime', 'Time', '', L(stop || KTIME)),
    P('CustomFrameRate', 'double', 'Number', '', D(fps)),
  )]);
  const docId = uid();
  const documents = new N('Documents', [], [new N('Count', [I(1)]), new N('Document', [L(docId), S(''), S('Scene')], [
    P70(P('SourceObject', 'object', '', ''), P('ActiveAnimStackName', 'KString', '', '', S(clips[0]?.name ?? ''))), new N('RootNode', [L(0)])])]);
  const definitions = new N('Definitions', [], [new N('Version', [I(100)]), new N('Count', [I(Object.keys(counts).length + 1)]),
    new N('ObjectType', [S('GlobalSettings')], [new N('Count', [I(1)])]),
    ...Object.entries(counts).map(([t, n]) => new N('ObjectType', [S(t)], [new N('Count', [I(n)])]))]);
  const takesNode = new N('Takes', [], [new N('Current', [S(clips[0]?.name ?? '')]), ...takes]);
  return serializeFBX([
    header,
    new N('FileId', [R(Uint8Array.from(FILE_ID))]),
    new N('CreationTime', [S('1970-01-01 10:00:00:000')]),
    new N('Creator', [S('VRoid Super Converter')]),
    globals, documents, new N('References'), definitions, objects, connections, takesNode,
  ]);
}

// ------------------------------------------------------------------ minimal reader (used by tests / validation)
export function parseFBXBinary(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  if (dec.decode(bytes.subarray(0, 18)) !== 'Kaydara FBX Binary') throw new Error('Not a binary FBX');
  const version = dv.getUint32(23, true);
  let pos = 27;
  const readNode = () => {
    const end = dv.getUint32(pos, true), np = dv.getUint32(pos + 4, true);
    const nameLen = bytes[pos + 12];
    if (end === 0) { pos += 13; return null; }
    const name = dec.decode(bytes.subarray(pos + 13, pos + 13 + nameLen));
    pos += 13 + nameLen;
    const props = [];
    for (let i = 0; i < np; i++) {
      const t = String.fromCharCode(bytes[pos++]);
      switch (t) {
        case 'S': case 'R': { const n = dv.getUint32(pos, true); const b = bytes.subarray(pos + 4, pos + 4 + n); props.push(t === 'S' ? dec.decode(b) : b); pos += 4 + n; break; }
        case 'I': props.push(dv.getInt32(pos, true)); pos += 4; break;
        case 'L': props.push(dv.getBigInt64(pos, true)); pos += 8; break;
        case 'D': props.push(dv.getFloat64(pos, true)); pos += 8; break;
        case 'F': props.push(dv.getFloat32(pos, true)); pos += 4; break;
        case 'C': props.push(!!bytes[pos]); pos += 1; break;
        case 'Y': props.push(dv.getInt16(pos, true)); pos += 2; break;
        default: { const n = dv.getUint32(pos, true), e = dv.getUint32(pos + 4, true), cl = dv.getUint32(pos + 8, true); props.push({ array: t, length: n, encoding: e, bytes: bytes.subarray(pos + 12, pos + 12 + cl) }); pos += 12 + cl; }
      }
    }
    const children = [];
    while (pos < end) { const c = readNode(); if (c) children.push(c); }
    pos = end;
    return { name, props, children };
  };
  const nodes = [];
  for (;;) { const n = readNode(); if (!n) break; nodes.push(n); }
  return { version, nodes };
}
