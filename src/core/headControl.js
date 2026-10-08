// Add, remove or change head and eye motion in a VRoid animation clip.
import * as THREE from 'three';

export const DEFAULT_HEAD_OPTIONS = {
  head: {
    mode: 'keep',          // keep | remove | lookAround | fixed
    space: 'local',        // fixed: local (relative to chest) | world (keeps facing a world direction)
    yaw: 0, pitch: 0, roll: 0, // degrees, for fixed
    amplitudeYaw: 35, amplitudePitch: 15, // degrees, for lookAround
    speed: 0.25,           // look-around changes per second
    holdTime: 1.2,         // seconds a look-around target is held
    neckShare: 0.35,       // fraction of the rotation given to the neck
    additive: false,       // lookAround on top of the original motion
    blend: 1,              // 0 = original, 1 = fully replaced
    seed: 1,
  },
  eyes: {
    mode: 'keep',          // keep | none | lookAround | fixed | followHead
    yaw: 0, pitch: 0,      // degrees, for fixed
    amplitudeYaw: 12, amplitudePitch: 8,
    saccadeInterval: 0.9,  // average seconds between saccades
    saccadeTime: 0.05,     // seconds per saccade
    seed: 7,
  },
  fps: 30,
};

function rng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const ease = (t) => t * t * (3 - 2 * t);
const D2R = Math.PI / 180;

/** Piecewise "look at a point, hold, move on" target generator. Returns f(t) -> [yaw, pitch] in degrees. */
export function lookAroundPath(duration, { amplitudeYaw, amplitudePitch, holdTime, speed, seed }) {
  const r = rng(seed);
  const keys = [{ t: 0, y: 0, p: 0 }];
  let t = 0;
  while (t < duration + 2) {
    const move = 1 / Math.max(0.05, speed) * (0.4 + r() * 0.6);
    const hold = holdTime * (0.5 + r());
    t += move;
    keys.push({ t, y: (r() * 2 - 1) * amplitudeYaw, p: (r() * 2 - 1) * amplitudePitch, hold });
    t += hold;
    keys.push({ t, y: keys[keys.length - 1].y, p: keys[keys.length - 1].p });
  }
  return (time) => {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t < time) i++;
    const a = keys[i], b = keys[i + 1];
    const u = ease(Math.min(1, Math.max(0, (time - a.t) / Math.max(1e-6, b.t - a.t))));
    return [a.y + (b.y - a.y) * u, a.p + (b.p - a.p) * u];
  };
}

/** Saccadic eye targets: quick jumps between fixation points. */
export function saccadePath(duration, { amplitudeYaw, amplitudePitch, saccadeInterval, saccadeTime, seed }) {
  const r = rng(seed);
  const keys = [{ t: 0, y: 0, p: 0 }];
  let t = 0;
  while (t < duration + 2) {
    t += saccadeInterval * (0.3 + r() * 1.4);
    const prev = keys[keys.length - 1];
    keys.push({ t, y: prev.y, p: prev.p });
    keys.push({ t: t + saccadeTime, y: (r() * 2 - 1) * amplitudeYaw, p: (r() * 2 - 1) * amplitudePitch });
    t += saccadeTime;
  }
  return (time) => {
    let i = 0;
    while (i < keys.length - 2 && keys[i + 1].t < time) i++;
    const a = keys[i], b = keys[i + 1];
    const u = Math.min(1, Math.max(0, (time - a.t) / Math.max(1e-6, b.t - a.t)));
    return [a.y + (b.y - a.y) * u, a.p + (b.p - a.p) * u];
  };
}

function eulerQ(yaw, pitch, roll = 0) {
  // Character faces +Z. yaw > 0 turns toward the character's left (+X), pitch > 0 looks up, roll about +Z.
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-pitch * D2R, yaw * D2R, roll * D2R, 'YXZ'));
}

/**
 * Rewrite head / neck / eye tracks of a clip for a VRoid-rigged model.
 * @param {THREE.AnimationClip} clip
 * @param {THREE.Object3D} model  VRoid model (userData.humanoid)
 * @param {Partial<typeof DEFAULT_HEAD_OPTIONS>} options
 */
export function editHeadMotion(clip, model, options = {}) {
  const o = {
    ...DEFAULT_HEAD_OPTIONS, ...options,
    head: { ...DEFAULT_HEAD_OPTIONS.head, ...(options.head ?? {}) },
    eyes: { ...DEFAULT_HEAD_OPTIONS.eyes, ...(options.eyes ?? {}) },
  };
  const H = model.userData.humanoid;
  const neck = H.neck, head = H.head, eyeL = H.leftEye, eyeR = H.rightEye;
  const fps = o.fps;
  const duration = Math.max(clip.duration, 1 / fps);
  const frames = Math.round(duration * fps) + 1;
  const times = new Float32Array(frames);
  const touched = new Set();
  const out = { neck: [], head: [], eyeL: [], eyeR: [] };

  const lookPath = lookAroundPath(duration, o.head);
  const eyePath = saccadePath(duration, o.eyes);
  const rest = new Map([[neck, neck?.quaternion.clone()], [head, head?.quaternion.clone()], [eyeL, eyeL?.quaternion.clone()], [eyeR, eyeR?.quaternion.clone()]]);

  const snapshot = [];
  model.traverse((x) => snapshot.push([x, x.position.clone(), x.quaternion.clone(), x.scale.clone()]));
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  for (let f = 0; f < frames; f++) {
    const t = Math.min(duration, f / fps);
    times[f] = t;
    mixer.setTime(t);
    model.updateMatrixWorld(true);
    const origNeck = neck?.quaternion.clone(), origHead = head?.quaternion.clone();
    let newNeck = origNeck, newHead = origHead;
    const h = o.head;
    if (neck && head && h.mode !== 'keep') {
      let target = null; // desired combined neck*head local rotation (relative to upper chest)
      if (h.mode === 'remove') { newNeck = rest.get(neck).clone(); newHead = rest.get(head).clone(); }
      else if (h.mode === 'lookAround') {
        const [yaw, pitch] = lookPath(t);
        target = eulerQ(yaw, pitch);
        if (h.additive) target = origNeck.clone().multiply(origHead).multiply(target);
      } else if (h.mode === 'fixed') {
        target = eulerQ(h.yaw, h.pitch, h.roll);
        if (h.space === 'world') {
          // Desired head world rotation (model space) -> express in the neck's parent frame
          const parentW = new THREE.Quaternion();
          neck.parent.matrixWorld.decompose(new THREE.Vector3(), parentW, new THREE.Vector3());
          const modelW = new THREE.Quaternion();
          model.matrixWorld.decompose(new THREE.Vector3(), modelW, new THREE.Vector3());
          target = parentW.invert().multiply(modelW).multiply(target);
        }
      }
      if (target) {
        const share = h.neckShare;
        newNeck = rest.get(neck).clone().multiply(new THREE.Quaternion().slerp(target, share));
        // head = neck^-1 * target  (so neck*head == target)
        newHead = newNeck.clone().invert().multiply(target);
      }
      newNeck = origNeck.clone().slerp(newNeck, h.blend);
      newHead = origHead.clone().slerp(newHead, h.blend);
      touched.add(neck); touched.add(head);
    }
    out.neck.push(newNeck); out.head.push(newHead);

    const e = o.eyes;
    if (eyeL && eyeR && e.mode !== 'keep') {
      let q;
      if (e.mode === 'none') q = rest.get(eyeL).clone();
      else if (e.mode === 'fixed') q = eulerQ(e.yaw, e.pitch);
      else if (e.mode === 'lookAround') { const [y, p] = eyePath(t); q = eulerQ(y, p); }
      else if (e.mode === 'followHead') {
        // eyes lead the head: look slightly further in the direction the head is turning
        const [y, p] = lookPath(Math.min(duration, t + 0.25));
        const [y0, p0] = lookPath(t);
        q = eulerQ(Math.max(-e.amplitudeYaw, Math.min(e.amplitudeYaw, (y - y0) * 1.5)), Math.max(-e.amplitudePitch, Math.min(e.amplitudePitch, (p - p0) * 1.5)));
      }
      out.eyeL.push(q); out.eyeR.push(q.clone());
      touched.add(eyeL); touched.add(eyeR);
    } else {
      out.eyeL.push(eyeL?.quaternion.clone()); out.eyeR.push(eyeR?.quaternion.clone());
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  for (const [x, p, q, s] of snapshot) { x.position.copy(p); x.quaternion.copy(q); x.scale.copy(s); }
  model.updateMatrixWorld(true);

  const replaced = new Set([...touched].map((b) => `${b.name}.quaternion`));
  const tracks = clip.tracks.filter((tr) => !replaced.has(tr.name)).map((tr) => tr.clone());
  const pushTrack = (bone, arr) => {
    if (!bone || !touched.has(bone)) return;
    const v = new Float32Array(arr.length * 4);
    let prev = null;
    arr.forEach((q, i) => { if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); v.set(q.toArray(), i * 4); prev = q; });
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, times, v));
  };
  pushTrack(neck, out.neck); pushTrack(head, out.head); pushTrack(eyeL, out.eyeL); pushTrack(eyeR, out.eyeR);
  return new THREE.AnimationClip(clip.name, duration, tracks);
}
