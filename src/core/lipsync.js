// Audio-driven lip sync for VRoid models. Each analysis frame is classified into the five
// VRoid mouth visemes (Fcl_MTH_A/I/U/E/O) from LPC formants (F1/F2) and loudness.
import * as THREE from 'three';
import { VROID_VISEMES } from './vroidSkeleton.js';

export const DEFAULT_LIPSYNC = {
  fps: 30,
  gain: 1.0,              // output scale
  silenceDb: -45,         // frames quieter than this are closed
  fullDb: -18,            // loudness for full mouth opening
  formantScale: 1.0,      // >1 for higher voices (children/anime), <1 for deeper voices
  attack: 0.5,            // smoothing (0..1, higher = faster)
  release: 0.35,
  maxWeight: 1.0,
  closeMouthBetweenWords: true,
};

// Reference vowel formants (Hz) for an adult female voice, Japanese vowels.
const VOWELS = { A: [850, 1400], I: [320, 2700], U: [380, 1500], E: [550, 2250], O: [520, 950] };

/** Mix to mono and resample to ~11 kHz for formant analysis. */
function prepare(channels, sampleRate) {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) mono[i] += ch[i] / channels.length;
  const factor = Math.max(1, Math.floor(sampleRate / 11025));
  const out = new Float32Array(Math.floor(n / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += mono[i * factor + k];
    out[i] = s / factor;
  }
  return { data: out, rate: sampleRate / factor };
}

function levinson(r, order) {
  const a = new Float64Array(order + 1);
  a[0] = 1;
  let e = r[0];
  if (e <= 0) return null;
  for (let i = 1; i <= order; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) return null;
  }
  return a;
}

/** Complex roots of a real polynomial (coefficients highest power first) via Durand–Kerner. */
function polyRoots(coeffs) {
  const n = coeffs.length - 1;
  const c = coeffs.map((v) => v / coeffs[0]);
  let re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { const ang = (2 * Math.PI * i) / n + 0.4; re[i] = 0.9 * Math.cos(ang); im[i] = 0.9 * Math.sin(ang); }
  for (let iter = 0; iter < 200; iter++) {
    let delta = 0;
    for (let i = 0; i < n; i++) {
      // evaluate p(z)
      let pr = 1, pi = 0;
      for (let k = 1; k <= n; k++) { const tr = pr * re[i] - pi * im[i] + c[k]; pi = pr * im[i] + pi * re[i]; pr = tr; }
      // denominator prod (z_i - z_j)
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const xr = re[i] - re[j], xi = im[i] - im[j];
        const tr = dr * xr - di * xi; di = dr * xi + di * xr; dr = tr;
      }
      const den = dr * dr + di * di || 1e-30;
      const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
      re[i] -= qr; im[i] -= qi;
      delta = Math.max(delta, Math.abs(qr) + Math.abs(qi));
    }
    if (delta < 1e-10) break;
  }
  return Array.from({ length: n }, (_, i) => [re[i], im[i]]);
}

/** Estimate the first two formants of a frame. */
export function formants(frame, rate) {
  const n = frame.length;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pre = frame[i] - 0.63 * (i ? frame[i - 1] : 0);
    x[i] = pre * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const order = Math.min(14, Math.round(2 + rate / 1000));
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) { let s = 0; for (let i = lag; i < n; i++) s += x[i] * x[i - lag]; r[lag] = s; }
  r[0] *= 1.0001;
  const a = levinson(r, order);
  if (!a) return null;
  const roots = polyRoots(Array.from(a));
  const f = [];
  for (const [re, im] of roots) {
    if (im <= 0) continue;
    const freq = (Math.atan2(im, re) * rate) / (2 * Math.PI);
    const bw = (-Math.log(Math.hypot(re, im)) * rate) / Math.PI;
    if (freq > 200 && freq < rate / 2 - 100 && bw < 500) f.push(freq);
  }
  f.sort((p, q) => p - q);
  return f.length >= 2 ? [f[0], f[1]] : null;
}

/** Map formants to soft vowel weights. */
export function vowelWeights(f1, f2, scale = 1) {
  const out = {};
  let sum = 0;
  for (const [v, [r1, r2]] of Object.entries(VOWELS)) {
    const d1 = Math.log(f1 / (r1 * scale)), d2 = Math.log(f2 / (r2 * scale));
    const d = d1 * d1 * 1.6 + d2 * d2;
    out[v] = Math.exp(-d / 0.05);
    sum += out[v];
  }
  for (const v of Object.keys(out)) out[v] = sum > 0 ? out[v] / sum : 0;
  return out;
}

/**
 * Analyse audio and produce per-frame viseme weights.
 * @param {{channels: Float32Array[], sampleRate: number}} audio
 */
export function analyzeLipSync(audio, options = {}) {
  const o = { ...DEFAULT_LIPSYNC, ...options };
  const { data, rate } = prepare(audio.channels, audio.sampleRate);
  const hop = rate / o.fps;
  const win = Math.round(rate * 0.03);
  const frames = Math.max(1, Math.ceil(data.length / hop));
  const result = [];
  const smooth = { A: 0, I: 0, U: 0, E: 0, O: 0 };
  let last = { A: 1, I: 0, U: 0, E: 0, O: 0 };
  for (let f = 0; f < frames; f++) {
    const center = Math.round(f * hop);
    const start = Math.max(0, center - (win >> 1));
    const frame = data.subarray(start, Math.min(data.length, start + win));
    let e = 0;
    for (const s of frame) e += s * s;
    const rms = Math.sqrt(e / Math.max(1, frame.length));
    const db = 20 * Math.log10(rms + 1e-9);
    const open = THREE.MathUtils.clamp((db - o.silenceDb) / (o.fullDb - o.silenceDb), 0, 1);
    let target = { A: 0, I: 0, U: 0, E: 0, O: 0 };
    if (open > 0 && frame.length > 32) {
      const fm = formants(frame, rate);
      const w = fm ? vowelWeights(fm[0], fm[1], o.formantScale) : last;
      last = w;
      for (const v of Object.keys(target)) target[v] = w[v] * open * o.gain;
    } else if (!o.closeMouthBetweenWords) target = { ...smooth };
    for (const v of Object.keys(smooth)) {
      const k = target[v] > smooth[v] ? o.attack : o.release;
      smooth[v] += (target[v] - smooth[v]) * k;
      smooth[v] = Math.min(o.maxWeight, smooth[v]);
    }
    result.push({ t: f / o.fps, db, ...smooth });
  }
  return result;
}

/** Build an AnimationClip driving the VRoid mouth morphs on every mesh that has them. */
export function lipSyncClip(model, frames, { name = 'LipSync', morphNames = VROID_VISEMES } = {}) {
  const tracks = [];
  const times = Float32Array.from(frames.map((f) => f.t));
  model.traverse((m) => {
    if (!m.isMesh || !m.morphTargetDictionary) return;
    for (const [v, morph] of Object.entries(morphNames)) {
      const key = Object.keys(m.morphTargetDictionary).find((k) => k === morph || k === `Viseme.${v}` || k.endsWith(`_MTH_${v}`));
      if (key === undefined) continue;
      tracks.push(new THREE.NumberKeyframeTrack(`${m.uuid}.morphTargetInfluences[${key}]`, times, Float32Array.from(frames.map((f) => f[v]))));
    }
  });
  const duration = frames.length ? frames[frames.length - 1].t : 0;
  return new THREE.AnimationClip(name, duration, tracks);
}

/** Merge lip sync tracks into an existing body animation clip. */
export function mergeClips(base, extra, name) {
  return new THREE.AnimationClip(name ?? base.name, Math.max(base.duration, extra.duration), [...base.tracks.map((t) => t.clone()), ...extra.tracks.map((t) => t.clone())]);
}
