// COLLADA 1.4.1 (.dae) writer: meshes with multiple materials, diffuse textures (written as
// separate image files), skeleton, skin controllers and sampled skeletal animation.
import * as THREE from 'three';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ident = (s, used) => {
  let base = String(s || 'node').replace(/[^A-Za-z0-9_\-.]/g, '_');
  if (/^[^A-Za-z_]/.test(base)) base = `_${base}`;
  let id = base;
  for (let k = 1; used.has(id); k++) id = `${base}_${k}`;
  used.add(id);
  return id;
};
const num = (v) => (Math.abs(v) < 1e-9 ? '0' : Number(v.toPrecision(7)).toString());
const rowMajor = (m) => { const e = m.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]].map(num).join(' '); };

async function pngBytes(texture) {
  if (texture.userData?.sourceBytes) return { bytes: texture.userData.sourceBytes, ext: texture.userData.sourceExt ?? 'png' };
  const img = texture.image;
  if (!img || typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  if (img.data) ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  else ctx.drawImage(img, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: 'png' };
}

/**
 * @param {THREE.Object3D} root export root (its own transform is not written)
 * @param {{clips?: THREE.AnimationClip[], fps?: number, name?: string}} opts
 * @returns {Promise<{dae: string, files: {name: string, bytes: Uint8Array}[]}>}
 */
export async function exportCollada(root, opts = {}) {
  const fps = opts.fps ?? 30;
  const baseName = (opts.name ?? 'model').replace(/[^\w.-]/g, '_');
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const rel = (o) => new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
  const used = new Set();
  const files = [];
  const images = [], effects = [], materials = [], geometries = [], controllers = [], animations = [];

  // ---- materials
  const matIds = new Map();
  const texIds = new Map();
  const materialId = async (mat) => {
    if (matIds.has(mat)) return matIds.get(mat);
    const id = ident(`${mat.name || 'material'}-material`, used);
    const fx = ident(`${mat.name || 'material'}-effect`, used);
    matIds.set(mat, id);
    const c = mat.color ?? new THREE.Color(1, 1, 1);
    let diffuse = `<color sid="diffuse">${num(c.r)} ${num(c.g)} ${num(c.b)} ${num(mat.opacity ?? 1)}</color>`;
    let newparams = '';
    if (mat.map) {
      let img = texIds.get(mat.map);
      if (!img) {
        const data = await pngBytes(mat.map);
        if (data) {
          img = ident(`${mat.map.name || mat.name || 'texture'}-image`, used);
          const file = `${baseName}_${img}.${data.ext}`;
          files.push({ name: file, bytes: data.bytes });
          images.push(`<image id="${img}" name="${img}"><init_from>${esc(file)}</init_from></image>`);
          texIds.set(mat.map, img);
        }
      }
      if (img) {
        newparams = `<newparam sid="${img}-surface"><surface type="2D"><init_from>${img}</init_from></surface></newparam>`
          + `<newparam sid="${img}-sampler"><sampler2D><source>${img}-surface</source></sampler2D></newparam>`;
        diffuse = `<texture texture="${img}-sampler" texcoord="UVMap"/>`;
      }
    }
    effects.push(`<effect id="${fx}"><profile_COMMON>${newparams}<technique sid="common"><lambert><diffuse>${diffuse}</diffuse>`
      + `${mat.transparent ? `<transparent opaque="A_ONE"><color>1 1 1 ${num(mat.opacity ?? 1)}</color></transparent>` : ''}</lambert></technique></profile_COMMON></effect>`);
    materials.push(`<material id="${id}" name="${esc(mat.name || id)}"><instance_effect url="#${fx}"/></material>`);
    return id;
  };

  // ---- skeleton nodes
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  const boneId = new Map(bones.map((b) => [b, ident(b.userData?.exportName ?? b.name ?? 'bone', used)]));
  const localOf = (b) => {
    const parentRel = b.parent && b.parent !== root && boneId.has(b.parent) ? rel(b.parent) : new THREE.Matrix4();
    return new THREE.Matrix4().multiplyMatrices(parentRel.clone().invert(), rel(b));
  };
  const nodeXml = (b) => `<node id="${boneId.get(b)}" name="${esc(b.userData?.exportName ?? b.name)}" sid="${boneId.get(b)}" type="JOINT"><matrix sid="transform">${rowMajor(localOf(b))}</matrix>`
    + b.children.filter((c) => boneId.has(c)).map(nodeXml).join('') + '</node>';
  const topBones = bones.filter((b) => !boneId.has(b.parent));

  // ---- meshes
  const instances = [];
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const M = rel(mesh);
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    const gid = ident(`${mesh.name || 'mesh'}-mesh`, used);
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    const v = new THREE.Vector3();
    const P = [], N = [], T = [];
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(M); P.push(num(v.x), num(v.y), num(v.z));
      if (nor) { v.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize(); N.push(num(v.x), num(v.y), num(v.z)); }
      if (uv) T.push(num(uv.getX(i)), num(uv.getY(i)));
    }
    const index = geo.index ? geo.index.array : Uint32Array.from({ length: pos.count }, (_, i) => i);
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index.length, materialIndex: 0 }];
    const inputs = [`<input semantic="VERTEX" source="#${gid}-vertices" offset="0"/>`];
    if (nor) inputs.push(`<input semantic="NORMAL" source="#${gid}-normals" offset="0"/>`);
    if (uv) inputs.push(`<input semantic="TEXCOORD" source="#${gid}-uvs" offset="0" set="0"/>`);
    const tris = [];
    const bindMats = [];
    for (const g of groups) {
      const mat = mats[Math.min(g.materialIndex ?? 0, mats.length - 1)];
      const mid = await materialId(mat);
      const sym = `${mid}-sym${g.materialIndex ?? 0}`;
      const ids = Array.from(index.subarray(g.start, g.start + g.count));
      tris.push(`<triangles material="${sym}" count="${ids.length / 3}">${inputs.join('')}<p>${ids.join(' ')}</p></triangles>`);
      bindMats.push(`<instance_material symbol="${sym}" target="#${mid}"><bind_vertex_input semantic="UVMap" input_semantic="TEXCOORD" input_set="0"/></instance_material>`);
    }
    const src = (id, arr, stride, params) => `<source id="${id}"><float_array id="${id}-array" count="${arr.length}">${arr.join(' ')}</float_array>`
      + `<technique_common><accessor source="#${id}-array" count="${arr.length / stride}" stride="${stride}">${params.map((p) => `<param name="${p}" type="float"/>`).join('')}</accessor></technique_common></source>`;
    geometries.push(`<geometry id="${gid}" name="${esc(mesh.name)}"><mesh>${src(`${gid}-positions`, P, 3, ['X', 'Y', 'Z'])}`
      + `${nor ? src(`${gid}-normals`, N, 3, ['X', 'Y', 'Z']) : ''}${uv ? src(`${gid}-uvs`, T, 2, ['S', 'T']) : ''}`
      + `<vertices id="${gid}-vertices"><input semantic="POSITION" source="#${gid}-positions"/></vertices>${tris.join('')}</mesh></geometry>`);
    const bind = `<bind_material><technique_common>${[...new Set(bindMats)].join('')}</technique_common></bind_material>`;
    const nodeId = ident(mesh.name || 'mesh', used);

    if (mesh.isSkinnedMesh) {
      const cid = ident(`${mesh.name || 'mesh'}-skin`, used);
      const skBones = mesh.skeleton.bones;
      const jointNames = skBones.map((b) => boneId.get(b) ?? ident('missing', used));
      const inv = skBones.map((b, bi) => {
        const bindWorld = new THREE.Matrix4().copy(mesh.skeleton.boneInverses[bi]).invert().premultiply(mesh.bindMatrix.clone().invert()).premultiply(mesh.matrixWorld);
        return rowMajor(new THREE.Matrix4().multiplyMatrices(rootInv, bindWorld).invert());
      });
      const si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
      const weights = [], vcount = [], vlist = [];
      for (let i = 0; i < si.count; i++) {
        let n = 0;
        for (let k = 0; k < 4; k++) {
          const w = sw.getComponent(i, k);
          if (w <= 0) continue;
          vlist.push(si.getComponent(i, k), weights.length);
          weights.push(num(w));
          n++;
        }
        vcount.push(n);
      }
      controllers.push(`<controller id="${cid}"><skin source="#${gid}"><bind_shape_matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</bind_shape_matrix>`
        + `<source id="${cid}-joints"><Name_array id="${cid}-joints-array" count="${jointNames.length}">${jointNames.join(' ')}</Name_array><technique_common><accessor source="#${cid}-joints-array" count="${jointNames.length}" stride="1"><param name="JOINT" type="name"/></accessor></technique_common></source>`
        + `<source id="${cid}-bind_poses"><float_array id="${cid}-bind_poses-array" count="${inv.length * 16}">${inv.join(' ')}</float_array><technique_common><accessor source="#${cid}-bind_poses-array" count="${inv.length}" stride="16"><param name="TRANSFORM" type="float4x4"/></accessor></technique_common></source>`
        + `<source id="${cid}-weights"><float_array id="${cid}-weights-array" count="${weights.length}">${weights.join(' ')}</float_array><technique_common><accessor source="#${cid}-weights-array" count="${weights.length}" stride="1"><param name="WEIGHT" type="float"/></accessor></technique_common></source>`
        + `<joints><input semantic="JOINT" source="#${cid}-joints"/><input semantic="INV_BIND_MATRIX" source="#${cid}-bind_poses"/></joints>`
        + `<vertex_weights count="${vcount.length}"><input semantic="JOINT" source="#${cid}-joints" offset="0"/><input semantic="WEIGHT" source="#${cid}-weights" offset="1"/>`
        + `<vcount>${vcount.join(' ')}</vcount><v>${vlist.join(' ')}</v></vertex_weights></skin></controller>`);
      const skeletons = [...new Set(skBones.map((b) => { let t = b; while (boneId.has(t.parent)) t = t.parent; return boneId.get(t); }))];
      instances.push(`<node id="${nodeId}" name="${esc(mesh.name)}" type="NODE"><instance_controller url="#${cid}">${skeletons.map((s) => `<skeleton>#${s}</skeleton>`).join('')}${bind}</instance_controller></node>`);
    } else {
      instances.push(`<node id="${nodeId}" name="${esc(mesh.name)}" type="NODE"><instance_geometry url="#${gid}">${bind}</instance_geometry></node>`);
    }
  }

  // ---- animation (sampled local matrices)
  for (const clip of opts.clips ?? []) {
    const snapshot = [];
    root.traverse((x) => snapshot.push([x, x.position.clone(), x.quaternion.clone(), x.scale.clone()]));
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const frames = Math.max(2, Math.round(clip.duration * fps) + 1);
    const times = Array.from({ length: frames }, (_, f) => Math.min(clip.duration, f / fps));
    const animated = new Set();
    for (const t of clip.tracks) {
      const node = THREE.PropertyBinding.findNode(root, THREE.PropertyBinding.parseTrackName(t.name).nodeName);
      if (node && boneId.has(node)) animated.add(node);
    }
    const samples = new Map([...animated].map((b) => [b, []]));
    for (const t of times) {
      mixer.setTime(t);
      root.updateMatrixWorld(true);
      for (const b of animated) samples.get(b).push(rowMajor(localOf(b)));
    }
    mixer.stopAllAction(); mixer.uncacheRoot(root);
    for (const [x, p, q, s] of snapshot) { x.position.copy(p); x.quaternion.copy(q); x.scale.copy(s); }
    root.updateMatrixWorld(true);
    const clipId = ident(clip.name || 'animation', used);
    const parts = [];
    for (const [b, mats] of samples) {
      const aid = ident(`${clipId}-${boneId.get(b)}`, used);
      parts.push(`<animation id="${aid}">`
        + `<source id="${aid}-input"><float_array id="${aid}-input-array" count="${times.length}">${times.map(num).join(' ')}</float_array><technique_common><accessor source="#${aid}-input-array" count="${times.length}" stride="1"><param name="TIME" type="float"/></accessor></technique_common></source>`
        + `<source id="${aid}-output"><float_array id="${aid}-output-array" count="${times.length * 16}">${mats.join(' ')}</float_array><technique_common><accessor source="#${aid}-output-array" count="${times.length}" stride="16"><param name="TRANSFORM" type="float4x4"/></accessor></technique_common></source>`
        + `<source id="${aid}-interpolation"><Name_array id="${aid}-interpolation-array" count="${times.length}">${times.map(() => 'LINEAR').join(' ')}</Name_array><technique_common><accessor source="#${aid}-interpolation-array" count="${times.length}" stride="1"><param name="INTERPOLATION" type="name"/></accessor></technique_common></source>`
        + `<sampler id="${aid}-sampler"><input semantic="INPUT" source="#${aid}-input"/><input semantic="OUTPUT" source="#${aid}-output"/><input semantic="INTERPOLATION" source="#${aid}-interpolation"/></sampler>`
        + `<channel source="#${aid}-sampler" target="${boneId.get(b)}/transform"/></animation>`);
    }
    if (parts.length) animations.push(`<animation id="${clipId}" name="${esc(clip.name)}">${parts.join('')}</animation>`);
  }

  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  const lib = (name, items) => (items.length ? `<${name}>${items.join('')}</${name}>` : '');
  const dae = `<?xml version="1.0" encoding="utf-8"?>\n<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">`
    + `<asset><contributor><authoring_tool>VRoid Super Converter</authoring_tool></contributor><created>${now}</created><modified>${now}</modified><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>`
    + lib('library_images', images) + lib('library_effects', effects) + lib('library_materials', materials) + lib('library_geometries', geometries)
    + lib('library_controllers', controllers) + lib('library_animations', animations)
    + `<library_visual_scenes><visual_scene id="Scene" name="Scene">${topBones.map(nodeXml).join('')}${instances.join('')}</visual_scene></library_visual_scenes>`
    + '<scene><instance_visual_scene url="#Scene"/></scene></COLLADA>\n';
  return { dae, files };
}
