// Undo / redo: snapshots of the editable scene state (models are deep-cloned, including
// geometry, so in-place edits such as welding, proportion matching or shape key edits can be
// reverted). References in userData (humanoid maps, IK rig) are re-pointed at the clones.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { writeCustomItem } from '../formats/vroidCustomItem.js';

function remapValue(v, map, seen = new Map()) {
  if (v && typeof v === 'object') {
    if (v.isObject3D) return map.get(v) ?? v;
    if (v.isVector3 || v.isQuaternion || v.isMatrix4 || v.isColor) return v.clone();
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) { const out = []; seen.set(v, out); for (const x of v) out.push(remapValue(x, map, seen)); return out; }
    if (Object.getPrototypeOf(v) === Object.prototype) {
      const out = {}; seen.set(v, out);
      for (const [k, x] of Object.entries(v)) out[k] = remapValue(x, map, seen);
      return out;
    }
  }
  return v;
}

/** Deep clone a model: bones, skinning, geometry (incl. morphs) and userData references. */
export function cloneModel(root) {
  return cloneModelWithMap(root).copy;
}

export function cloneModelWithMap(root) {
  if (!root) return { copy: null, map: new Map() };
  const copy = skeletonClone(root);
  const a = [], b = [];
  root.traverse((o) => a.push(o));
  copy.traverse((o) => b.push(o));
  const map = new Map(a.map((o, i) => [o, b[i]]));
  b.forEach((o, i) => {
    if (o.isMesh) {
      o.geometry = a[i].geometry.clone();
      if (a[i].morphTargetDictionary) o.morphTargetDictionary = { ...a[i].morphTargetDictionary };
      if (a[i].morphTargetInfluences) o.morphTargetInfluences = [...a[i].morphTargetInfluences];
    }
    o.userData = remapValue(a[i].userData, map);
  });
  return { copy, map };
}

export class History {
  constructor(limit = 12) { this.limit = limit; this.undoStack = []; this.redoStack = []; }

  /** Capture a snapshot of the state before a change. */
  push(snapshot) {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  undo(current) {
    if (!this.undoStack.length) return null;
    this.redoStack.push(current);
    return this.undoStack.pop();
  }

  redo(current) {
    if (!this.redoStack.length) return null;
    this.undoStack.push(current);
    return this.redoStack.pop();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
}

/** Snapshot the parts of the app state that edits can change. */
export function snapshotState(state) {
  const slot = (s) => (s ? { ...s, root: cloneModel(s.root) } : null);
  return {
    vroid: slot(state.vroid),
    other: (() => {
      const o = state.other;
      if (!o) return null;
      const { copy, map } = cloneModelWithMap(o.root);
      const loaded = o.loaded ? { ...o.loaded, root: o.loaded.root === o.root ? copy : o.loaded.root } : o.loaded;
      return { ...o, root: copy, loaded, humanoid: remapValue(o.humanoid, map) };
    })(),
    clips: state.clips.map((c) => ({ name: c.name, clip: c.clip.clone() })),
    activeIndex: state.clips.indexOf(state.active),
    item: state.item ? { name: state.item.name, bytes: writeCustomItem(state.item.item) } : null,
    divaFlags: state.diva.sources.map((src) => src.objectSets.map((os) => os.set.objects.map((o) => [o.enabled, o.meshes.map((m) => [m.enabled, m.subMeshes.map((s) => s.enabled)])]))),
  };
}

export function restoreDivaFlags(state, flags) {
  state.diva.sources.forEach((src, i) => src.objectSets.forEach((os, j) => os.set.objects.forEach((o, k) => {
    const f = flags?.[i]?.[j]?.[k];
    if (!f) return;
    o.enabled = f[0];
    o.meshes.forEach((m, mi) => { m.enabled = f[1][mi][0]; m.subMeshes.forEach((s, si) => { s.enabled = f[1][mi][1][si]; }); });
  })));
}

export { THREE };
