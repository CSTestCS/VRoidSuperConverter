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
  // Voice targeting (for speech or singing over music / background noise)
  voiceFocus: 'off',      // off | band (voice band only) | isolate (centre-channel vocals + noise subtraction)
  noiseReduction: 0.6,    // 0..1 spectral subtraction strength
  voiceLowHz: 90,
  voiceHighHz: 4000,
  centerFocus: 0.8,       // 0..1 how strongly side (non-centred) stereo content is removed
  voicingThreshold: 0,    // 0..1; frames with weaker pitch periodicity than this are treated as non-voice
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
  const channels = o.voiceFocus && o.voiceFocus !== 'off' ? [isolateVoice(audio.channels, audio.sampleRate, o)] : audio.channels;
  const { data, rate } = prepare(channels, audio.sampleRate);
  let voicedHold = 0;
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
    let voiced = true;
    if (o.voicingThreshold > 0 && open > 0 && frame.length > 32) {
      if (periodicity(frame, rate) >= o.voicingThreshold) voicedHold = 2; // keep short consonants between vowels
      else if (voicedHold > 0) voicedHold--;
      else voiced = false;
    }
    if (open > 0 && voiced && frame.length > 32) {
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

// ------------------------------------------------------------------ voice targeting
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Pull the voice out of a mix: STFT, keep the centre of the stereo field (vocals are usually
 * panned centre while instruments are spread), keep the voice band, then subtract a stationary
 * noise/music floor estimated per frequency bin. Returns a mono signal at the input rate.
 */
export function isolateVoice(channels, sampleRate, o = DEFAULT_LIPSYNC) {
  const N = 2048, hop = 512, bins = N / 2 + 1;
  const L = channels[0], R = channels[1] ?? channels[0];
  const len = L.length;
  const frames = Math.max(1, Math.ceil((len - N) / hop) + 1);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const stereo = channels.length > 1;
  const specRe = new Array(frames), specIm = new Array(frames), mags = new Array(frames);
  const lo = Math.floor((o.voiceLowHz * N) / sampleRate), hi = Math.ceil((o.voiceHighHz * N) / sampleRate);
  for (let f = 0; f < frames; f++) {
    const lr = new Float64Array(N), li = new Float64Array(N), rr = new Float64Array(N), ri = new Float64Array(N);
    for (let i = 0; i < N; i++) { const k = f * hop + i; lr[i] = (L[k] ?? 0) * win[i]; rr[i] = (R[k] ?? 0) * win[i]; }
    fft(lr, li);
    if (stereo) fft(rr, ri);
    const re = new Float64Array(bins), im = new Float64Array(bins), mag = new Float64Array(bins);
    for (let b = 0; b < bins; b++) {
      let mr = stereo ? (lr[b] + rr[b]) / 2 : lr[b], mi = stereo ? (li[b] + ri[b]) / 2 : li[b];
      if (stereo && o.voiceFocus === 'isolate') {
        const sr = (lr[b] - rr[b]) / 2, si = (li[b] - ri[b]) / 2;
        const m = Math.hypot(mr, mi), sd = Math.hypot(sr, si);
        const centre = m / (m + sd + 1e-12); // 1 = perfectly centred
        const gain = Math.pow(centre, 1 + 6 * o.centerFocus);
        mr *= gain; mi *= gain;
      }
      if (b < lo || b > hi) { mr = 0; mi = 0; }
      re[b] = mr; im[b] = mi; mag[b] = Math.hypot(mr, mi);
    }
    specRe[f] = re; specIm[f] = im; mags[f] = mag;
  }
  // stationary floor = 20th percentile magnitude of each bin over time
  if (o.voiceFocus === 'isolate' && o.noiseReduction > 0 && frames > 4) {
    const floor = new Float64Array(bins);
    const col = new Float64Array(frames);
    for (let b = lo; b <= Math.min(hi, bins - 1); b++) {
      for (let f = 0; f < frames; f++) col[f] = mags[f][b];
      const sorted = Float64Array.from(col).sort();
      floor[b] = sorted[Math.floor(frames * 0.2)];
    }
    const alpha = 1 + 2 * o.noiseReduction;
    for (let f = 0; f < frames; f++) for (let b = 0; b < bins; b++) {
      const m = mags[f][b];
      if (m <= 0) continue;
      const g = Math.max(0.05 * (1 - o.noiseReduction), (m - alpha * floor[b]) / m);
      specRe[f][b] *= g; specIm[f][b] *= g;
    }
  }
  const out = new Float32Array(len);
  for (let f = 0; f < frames; f++) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let b = 0; b < bins; b++) { re[b] = specRe[f][b]; im[b] = specIm[f][b]; if (b > 0 && b < N / 2) { re[N - b] = specRe[f][b]; im[N - b] = -specIm[f][b]; } }
    fft(re, im, true);
    for (let i = 0; i < N; i++) { const k = f * hop + i; if (k < len) out[k] += re[i] * win[i] * (hop * 2 / N); }
  }
  return out;
}

/** Normalised autocorrelation peak in the 70–600 Hz pitch range (0 = noise, 1 = perfectly periodic). */
export function periodicity(frame, rate) {
  const n = frame.length;
  let mean = 0;
  for (const v of frame) mean += v;
  mean /= n;
  const x = Float32Array.from(frame, (v) => v - mean);
  let e0 = 0;
  for (const v of x) e0 += v * v;
  if (e0 <= 1e-12) return 0;
  let best = 0;
  for (let lag = Math.floor(rate / 600); lag <= Math.min(n - 8, Math.ceil(rate / 70)); lag++) {
    let c = 0, e1 = 0, e2 = 0;
    for (let i = 0; i + lag < n; i++) { c += x[i] * x[i + lag]; e1 += x[i] * x[i]; e2 += x[i + lag] * x[i + lag]; }
    const r = c / Math.sqrt(e1 * e2 + 1e-12);
    if (r > best) best = r;
  }
  return best;
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
