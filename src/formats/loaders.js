// File import: models, animations, audio, Project DIVA archives and VRoid custom items.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { detectHumanoid } from '../core/humanoid.js';
import { HUMANOID_FROM_VROID } from '../core/vroidSkeleton.js';
import { skinnedMeshesOf, meshesOf } from '../core/skinning.js';

export const MODEL_EXTENSIONS = ['vrm', 'glb', 'gltf', 'fbx', 'obj', 'dae', 'bvh', 'vrma'];
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'webm'];
export const ext = (name) => name.split('.').pop().toLowerCase();

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Resolve sibling files (textures referenced by FBX/OBJ/glTF) from a provided map name -> Uint8Array. */
function makeManager(siblings) {
  const urls = new Map();
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const base = decodeURIComponent(url.split(/[\\/]/).pop());
    const bytes = siblings?.get(base) ?? siblings?.get(base.toLowerCase());
    if (!bytes) return url;
    if (!urls.has(base)) urls.set(base, URL.createObjectURL(new Blob([bytes])));
    return urls.get(base);
  });
  return manager;
}

/**
 * Load any supported model/animation file.
 * @returns {Promise<{kind: 'model'|'animation', root: THREE.Object3D, clips: THREE.AnimationClip[], humanoid: object|null, rigged: boolean, isVRoid: boolean, vrm?: object, meta?: object}>}
 */
export async function loadModelFile(name, bytes, siblings = null) {
  const e = ext(name);
  const manager = makeManager(siblings);
  let root, clips = [], vrm = null, meta = null, vrmaHumanoid = null;
  switch (e) {
    case 'vrm': case 'glb': case 'gltf': case 'vrma': {
      const loader = new GLTFLoader(manager);
      loader.register((p) => new VRMLoaderPlugin(p, { autoUpdateHumanBones: false }));
      loader.register((p) => new VRMAnimationLoaderPlugin(p));
      const gltf = await new Promise((res, rej) => loader.parse(e === 'gltf' ? new TextDecoder().decode(bytes) : toArrayBuffer(bytes), '', res, rej));
      vrm = gltf.userData.vrm ?? null;
      root = vrm ? vrm.scene : gltf.scene;
      clips = gltf.animations ?? [];
      if (vrm) {
        meta = vrm.meta;
        VRMUtils.rotateVRM0(vrm);
        VRMUtils.combineSkeletons?.(root);
      }
      const ext2 = gltf.parser.json.extensions?.VRMC_vrm_animation;
      if (ext2?.humanoid?.humanBones) {
        vrmaHumanoid = {};
        for (const [h, { node }] of Object.entries(ext2.humanoid.humanBones)) vrmaHumanoid[h] = await gltf.parser.getDependency('node', node);
      }
      break;
    }
    case 'fbx': {
      root = new FBXLoader(manager).parse(toArrayBuffer(bytes), '');
      clips = root.animations ?? [];
      break;
    }
    case 'bvh': {
      const r = new BVHLoader().parse(new TextDecoder().decode(bytes));
      root = new THREE.Group();
      root.add(r.skeleton.bones[0]);
      clips = [r.clip];
      root.userData.skeleton = r.skeleton;
      break;
    }
    case 'obj': {
      root = new OBJLoader(manager).parse(new TextDecoder().decode(bytes));
      break;
    }
    case 'dae': {
      const r = new ColladaLoader(manager).parse(new TextDecoder().decode(bytes), '');
      root = r.scene;
      clips = r.animations ?? [];
      break;
    }
    default:
      throw new Error(`Unsupported file type .${e}`);
  }
  root.name ||= name;
  root.updateMatrixWorld(true);
  const meshes = meshesOf(root);
  const rigged = skinnedMeshesOf(root).length > 0;
  let bonesExist = false;
  root.traverse((o) => { if (o.isBone) bonesExist = true; });
  const kind = meshes.length === 0 && (clips.length > 0 || bonesExist) ? 'animation' : 'model';
  let humanoid = null;
  if (vrmaHumanoid) humanoid = { bones: vrmaHumanoid, facing: 1, height: 1.6, unmapped: [], method: {} };
  else if (vrm?.humanoid) {
    const bones = {};
    for (const h of Object.keys(vrm.humanoid.humanBones)) {
      const n = vrm.humanoid.getRawBoneNode(h);
      if (n) bones[h] = n;
    }
    humanoid = { bones, facing: 1, height: 1.6, unmapped: [], method: {} };
  } else if (bonesExist || kind === 'animation') humanoid = detectHumanoid(root);
  let isVRoid = false;
  root.traverse((o) => { if (o.isBone && HUMANOID_FROM_VROID[o.name] === 'hips') isVRoid = true; });
  for (const c of clips) c.name ||= name;
  return { kind, root, clips, humanoid, rigged, isVRoid, vrm, meta, fileName: name };
}

/** Decode an audio file to PCM channels. */
export async function loadAudioFile(bytes) {
  const Ctx = globalThis.OfflineAudioContext ?? globalThis.AudioContext;
  const ctx = new Ctx(1, 1, 44100);
  const buf = await ctx.decodeAudioData(toArrayBuffer(bytes));
  const channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c));
  return { channels, sampleRate: buf.sampleRate, duration: buf.duration, buffer: buf };
}
