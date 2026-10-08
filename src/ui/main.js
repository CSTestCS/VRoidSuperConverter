// VRoid Super Converter — application UI.
import * as THREE from 'three';
import { Viewer } from '../viewer/Viewer.js';
import { h, field, section, button, row, note } from './dom.js';
import { openFiles, saveFile, readSiblings } from './platform.js';
import { loadModelFile, loadAudioFile, MODEL_EXTENSIONS, AUDIO_EXTENSIONS, ext } from '../formats/loaders.js';
import { convertToVRoid, retargetClip, captureRest } from '../core/retarget.js';
import { autoRig } from '../core/autoRig.js';
import { detectHumanoid, validateHumanoid } from '../core/humanoid.js';
import { HUMANOID_NAMES } from '../core/vroidSkeleton.js';
import { refitClothing, attachClothing, matchProportions, DEFAULT_FIT_SETTINGS } from '../core/fit.js';
import { editHeadMotion, DEFAULT_HEAD_OPTIONS } from '../core/headControl.js';
import { optimizeModel, DEFAULT_OPTIMIZE } from '../core/optimize.js';
import { renameShapeKeys, renameClipShapeKeys, addAsymmetricShapeKeys } from '../core/shapeKeys.js';
import { addIKRig, bakeIKToClip } from '../core/ik.js';
import { RIG_PROFILES, getProfile, parseProfile } from '../core/rigProfiles.js';
import { convertToProfile, convertToProvidedRig } from '../core/rigConvert.js';
import { analyzeLipSync, lipSyncClip, mergeClips, DEFAULT_LIPSYNC } from '../core/lipsync.js';
import { bakeAppearance, encodePng } from '../core/textureBake.js';
import { exportVRoidPose, applyVRoidPose, storeRestPose } from '../formats/vroidPose.js';
import { exportFBX } from '../formats/fbxExporter.js';
import { exportGLTF } from '../formats/gltfExport.js';
import { readCustomItem, writeCustomItem, recategorize, replaceImage, setThumbnail, setName, regenerateIds, CATEGORIES, describeCustomItem } from '../formats/vroidCustomItem.js';
import { loadDivaSource, addSkinParamText, mergeDivaSources } from '../diva/divaMerge.js';
import { buildDivaPreview, refreshDivaVisibility } from '../diva/divaPreview.js';
import { skinnedMeshesOf, meshesOf } from '../core/skinning.js';

const MODEL_FILTER = [{ name: 'Models & animations', extensions: MODEL_EXTENSIONS }];
const state = {
  vroid: null, // {root, name, meta}
  other: null, // {root, loaded, humanoid, kind, name, converted}
  clips: [], // {name, clip}
  active: null,
  audio: null,
  diva: { sources: [], previews: new Map() },
  item: null,
  options: {
    convert: { keepExtraBones: true, tPose: true, targetHeight: 0 },
    retarget: { alignRestPose: true, inPlace: false, fps: 30, translateHips: true },
    fit: structuredClone(DEFAULT_FIT_SETTINGS),
    proportions: { direction: 'otherToVroid', strength: 1, girth: 0 },
    head: structuredClone(DEFAULT_HEAD_OPTIONS),
    ikBake: { footLock: true, floorY: 0 },
    optimize: { ...DEFAULT_OPTIMIZE },
    shapeKeys: { style: 'readable', blend: 0.02, leftSuffix: '.L', rightSuffix: '.R' },
    rig: { profile: 'tower-unite', proportions: 'model', keepExtraBones: true },
    lipsync: { ...DEFAULT_LIPSYNC, mergeWithActive: true },
    item: { category: '', name: '', newIds: true, bakeSize: 1024, bakeDistance: 0.05, bakeMaterial: '' },
    diva: { outputName: 'mikitm901', objectName: 'MIKITM901', objectId: 901, objectSetId: 3901, textureIdBase: '', singleObject: true, compactVertices: true, includeSkinParamInFarc: false, compress: true },
    export: { target: 'vroid', format: 'fbx', units: 'cm', clips: 'all' },
  },
};

// ------------------------------------------------------------------ layout
const app = document.getElementById('app');
const viewport = h('div', { class: 'viewport' });
const logEl = h('div', { class: 'log' });
const scenePanel = h('div', { class: 'scene-panel' });
const toolTabs = h('div', { class: 'tabs' });
const toolBody = h('div', { class: 'tool-body' });
const busy = h('div', { class: 'busy hidden' }, h('div', { class: 'spinner' }), h('span', { class: 'busy-text' }, 'Working…'));
const timeSlider = h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: 0, class: 'time' });
const frameLabel = h('span', { class: 'frame' }, 'frame 0 / 0');
const playBtn = h('button', { class: 'btn' }, '▶');
const clipSelect = h('select', { class: 'clip-select' });

app.append(
  h('header', { class: 'topbar' },
    h('strong', {}, 'VRoid Super Converter'),
    button('Import VRoid model…', () => importVRoid(), { primary: true, title: 'Load the VRoid model (VRM / GLB / FBX). Non-VRoid rigs are converted to the VRoid skeleton.' }),
    button('Import model / animation…', () => importOther(), { title: 'Any bipedal model (rigged or not) or animation (FBX, GLB, BVH, VRMA, DAE, OBJ)' }),
    button('Import audio…', () => importAudio()),
    button('Import .farc…', () => importFarc()),
    button('Frame all', () => viewer.frame()),
    field('Side by side', { v: false }, 'v', 'checkbox', { onChange: (v) => { viewer.sideBySide = v; viewer.layout(); } }),
    field('Skeleton', { v: true }, 'v', 'checkbox', { onChange: (v) => { viewer.showSkeleton = v; viewer.refreshHelpers(); } }),
  ),
  h('main', { class: 'main' },
    h('aside', { class: 'left' }, scenePanel, h('h3', {}, 'Log'), logEl),
    h('div', { class: 'center' }, viewport,
      h('div', { class: 'timeline' }, playBtn, clipSelect, timeSlider, frameLabel,
        button('⏮', () => viewer.setTime(0)), button('◀|', () => step(-1)), button('|▶', () => step(1)),
        field('Loop', viewer_loop(), 'v', 'checkbox', { onChange: (v) => { viewer.loop = v; } }))),
    h('aside', { class: 'right' }, toolTabs, toolBody),
  ),
  busy,
);
function viewer_loop() { return { v: true }; }

const viewer = new Viewer(viewport);
viewer.onTime = (t) => {
  timeSlider.max = Math.max(viewer.duration, 0.001);
  timeSlider.value = t;
  frameLabel.textContent = `frame ${Math.round(t * viewer.fps)} / ${Math.round(viewer.duration * viewer.fps)}  (${t.toFixed(2)}s)`;
};
timeSlider.oninput = () => { viewer.setPlaying(false); playBtn.textContent = '▶'; viewer.setTime(Number(timeSlider.value)); };
playBtn.onclick = () => { viewer.setPlaying(!viewer.playing); playBtn.textContent = viewer.playing ? '⏸' : '▶'; };
clipSelect.onchange = () => setActiveClip(state.clips[Number(clipSelect.value)] ?? null);
function step(d) { viewer.setPlaying(false); playBtn.textContent = '▶'; viewer.setTime(Math.round(viewer.time * viewer.fps + d) / viewer.fps); }

// ------------------------------------------------------------------ helpers
function log(msg, kind = 'info') {
  const line = h('div', { class: `log-line ${kind}` }, `${new Date().toLocaleTimeString()}  ${msg}`);
  logEl.prepend(line);
  if (kind === 'error') console.error(msg); else console.log(msg);
}
async function run(label, fn) {
  busy.querySelector('.busy-text').textContent = `${label}…`;
  busy.classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 30));
  try { const r = await fn(); return r; }
  catch (e) { log(`${label} failed: ${e.message ?? e}`, 'error'); console.error(e); return null; }
  finally { busy.classList.add('hidden'); refreshScenePanel(); }
}
const baseName = (n) => (n ?? 'model').replace(/\.[^.]+$/, '');
const need = (cond, msg) => { if (!cond) throw new Error(msg); };

function addClip(clip, name) {
  clip.name = name ?? clip.name;
  state.clips.push({ name: clip.name, clip });
  refreshClipSelect();
  setActiveClip(state.clips[state.clips.length - 1]);
}
function refreshClipSelect() {
  clipSelect.replaceChildren(h('option', { value: -1 }, '(no animation)'), ...state.clips.map((c, i) => h('option', { value: i, selected: c === state.active }, c.name)));
}
function setActiveClip(entry) {
  state.active = entry;
  viewer.stop('vroid');
  if (entry && state.vroid) viewer.play('vroid', entry.clip);
  else viewer.duration = 0;
  refreshClipSelect();
  viewer.onTime(viewer.time);
}

// ------------------------------------------------------------------ import
async function readSelected(opts) {
  const files = await openFiles(opts);
  for (const f of files) if (f.path && !f.siblings) f.siblings = await readSiblings(f.path);
  return files;
}

function toVRoidModel(loaded) {
  const o = state.options.convert;
  const common = { keepExtraBones: o.keepExtraBones, tPose: o.tPose, targetHeight: o.targetHeight > 0 ? o.targetHeight : null };
  let model;
  if (loaded.rigged || (loaded.humanoid && Object.keys(loaded.humanoid.bones).length > 8)) {
    const v = validateHumanoid(loaded.humanoid);
    if (v.missing.length) log(`Bone detection is missing: ${v.missing.join(', ')}. Fix them in the bone mapping table if needed.`, 'warn');
    model = convertToVRoid(loaded.root, { ...common, humanoid: loaded.humanoid, name: baseName(loaded.fileName) });
    log(`Converted rig of ${loaded.fileName} to the VRoid skeleton (${Object.keys(model.userData.humanoid).length} humanoid bones).`);
  } else {
    model = autoRig(loaded.root, { tPose: o.tPose, targetHeight: common.targetHeight });
    model.name = baseName(loaded.fileName);
    const a = model.userData.autoRigJoints?._meta?.aPose ?? 0;
    log(`Auto-rigged ${loaded.fileName} (detected arm angle ${a.toFixed(0)}° below horizontal).`);
  }
  storeRestPose(model);
  return model;
}

async function importVRoid() {
  const [f] = await readSelected({ title: 'VRoid model', filters: MODEL_FILTER });
  if (!f) return;
  await run(`Loading ${f.name}`, async () => {
    const loaded = await loadModelFile(f.name, f.bytes, f.siblings);
    need(loaded.kind === 'model', 'This file has no meshes; load it as an animation instead.');
    const model = toVRoidModel(loaded);
    state.vroid = { root: model, name: baseName(f.name), meta: loaded.meta };
    viewer.setSlot('vroid', model);
    viewer.frame();
    for (const c of loaded.clips) addClip(retargetOnto(loaded, c), `${c.name || 'clip'} (from ${f.name})`);
    if (state.active) setActiveClip(state.active);
  });
}

async function importOther() {
  const [f] = await readSelected({ title: 'Model or animation', filters: MODEL_FILTER });
  if (!f) return;
  await run(`Loading ${f.name}`, async () => {
    const loaded = await loadModelFile(f.name, f.bytes, f.siblings);
    state.other = { root: loaded.root, loaded, humanoid: loaded.humanoid, kind: loaded.kind, name: baseName(f.name), converted: false };
    viewer.setSlot('other', loaded.root);
    viewer.frame();
    log(`Loaded ${f.name}: ${loaded.kind}, ${loaded.rigged ? 'rigged' : loaded.humanoid ? 'skeleton only' : 'not rigged'}, ${loaded.clips.length} animation(s).`);
    if (loaded.kind === 'animation' && state.vroid) {
      for (const c of loaded.clips) addClip(retargetOnto(loaded, c), `${c.name || baseName(f.name)}`);
      log(`Retargeted ${loaded.clips.length} animation(s) onto the VRoid model.`);
    }
    showTab('convert');
  });
}

function retargetOnto(loaded, clip) {
  need(state.vroid, 'Load a VRoid model first.');
  const t = state.vroid.root;
  return viewer.aligned(() => retargetClip(clip, { root: loaded.root, bones: loaded.humanoid.bones, facing: loaded.humanoid.facing },
    { root: t, bones: t.userData.humanoid, rest: restSnapshot(t) }, state.options.retarget));
}
function restSnapshot(model) {
  // rest pose captured from stored local transforms (works while an animation is playing)
  const saved = [];
  model.traverse((o) => { const r = model.userData.restLocal?.[o.name]; if (o.isBone && r) { saved.push([o, o.quaternion.clone(), o.position.clone()]); o.quaternion.copy(r.q); o.position.copy(r.p); } });
  const rest = captureRest(model, model.userData.humanoid);
  for (const [o, q, p] of saved) { o.quaternion.copy(q); o.position.copy(p); }
  model.updateMatrixWorld(true);
  return rest;
}

async function importAudio() {
  const [f] = await openFiles({ title: 'Audio', filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }] });
  if (!f) return;
  await run('Decoding audio', async () => {
    const decoded = await loadAudioFile(f.bytes);
    if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
    const url = URL.createObjectURL(new Blob([f.bytes]));
    const el = new Audio(url);
    state.audio = { name: f.name, decoded, url, el };
    log(`Audio ${f.name}: ${decoded.duration.toFixed(2)} s, ${decoded.sampleRate} Hz.`);
    showTab('lipsync');
  });
}

async function importFarc() {
  const files = await openFiles({ title: 'Project DIVA files', multiple: true, filters: [{ name: 'FARC / obj.bin / skin param', extensions: ['farc', 'bin', 'txt'] }] });
  if (!files.length) return;
  await run('Reading DIVA files', async () => {
    for (const f of files) {
      if (f.name.toLowerCase().endsWith('.txt')) {
        const target = state.diva.sources[state.diva.sources.length - 1];
        need(target, 'Import a .farc before its skin parameter file.');
        addSkinParamText(target, new TextDecoder().decode(f.bytes));
        log(`Added skin parameters from ${f.name} to ${target.fileName}.`);
        continue;
      }
      const src = loadDivaSource(f.name, f.bytes);
      state.diva.sources.push(src);
      const preview = buildDivaPreview(src);
      state.diva.previews.set(src, preview);
      const objs = src.objectSets.reduce((a, os) => a + os.set.objects.length, 0);
      log(`${f.name}: ${objs} object(s), ${src.textureSets.size} texture set(s), ${src.skinParams.size} skin parameter(s).`);
      for (const e of src.otherEntries) if (e.error) log(`  ${e.name}: ${e.error}`, 'warn');
    }
    rebuildDivaPreview();
    showTab('diva');
  });
}

function rebuildDivaPreview() {
  const g = new THREE.Group();
  let x = 0;
  for (const [, p] of state.diva.previews) { p.position.x = x; x += 0.9; g.add(p); refreshDivaVisibility(p); }
  viewer.setSlot('diva', g);
}

// ------------------------------------------------------------------ scene panel
function refreshScenePanel() {
  const v = state.vroid, o = state.other;
  scenePanel.replaceChildren(
    h('h3', {}, 'Scene'),
    h('div', { class: 'slot' }, h('b', {}, 'VRoid model: '), v ? v.name : '—',
      v ? h('div', { class: 'small' }, `${meshesOf(v.root).length} mesh(es), ${Object.keys(v.root.userData.humanoid).length} humanoid bones${v.root.userData.ik ? ', IK' : ''}`) : null),
    h('div', { class: 'slot' }, h('b', {}, 'Secondary: '), o ? `${o.name} (${o.converted ? 'VRoid rig' : o.kind})` : '—',
      o ? row(button('Remove', () => { state.other = null; viewer.setSlot('other', null); refreshScenePanel(); })) : null),
    h('div', { class: 'slot' }, h('b', {}, 'Animations: '), String(state.clips.length),
      ...state.clips.map((c, i) => h('div', { class: 'clip-row' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); setActiveClip(c); } }, c === state.active ? `▸ ${c.name}` : c.name),
        h('button', { class: 'mini', title: 'Rename', onclick: () => { const n = prompt('Clip name', c.name); if (n) { c.name = n; c.clip.name = n; refreshScenePanel(); refreshClipSelect(); } } }, '✎'),
        h('button', { class: 'mini', title: 'Delete', onclick: () => { state.clips.splice(i, 1); if (state.active === c) setActiveClip(null); refreshScenePanel(); refreshClipSelect(); } }, '✕')))),
    h('div', { class: 'slot' }, h('b', {}, 'Audio: '), state.audio ? state.audio.name : '—'),
    h('div', { class: 'slot' }, h('b', {}, 'DIVA archives: '), String(state.diva.sources.length)),
  );
}

// ------------------------------------------------------------------ tabs
const TABS = [
  ['convert', 'Convert', convertTab],
  ['fit', 'Fit & Shape', fitTab],
  ['anim', 'Animation', animTab],
  ['tools', 'Model tools', toolsTab],
  ['rig', 'Rig convert', rigTab],
  ['item', 'Custom item', itemTab],
  ['lipsync', 'Lip sync', lipsyncTab],
  ['diva', 'DIVA .farc', divaTab],
  ['export', 'Export', exportTab],
];
let currentTab = 'convert';
function showTab(id) {
  currentTab = id;
  toolTabs.replaceChildren(...TABS.map(([k, label]) => h('button', { class: `tab ${k === id ? 'active' : ''}`, onclick: () => showTab(k) }, label)));
  const tab = TABS.find((t) => t[0] === id);
  toolBody.replaceChildren(...[tab[2]()].flat());
}

// ---- Convert
function convertTab() {
  const o = state.options.convert;
  const other = state.other;
  const els = [
    section('Conversion options',
      field('Keep extra bones (hair, skirt, accessories)', o, 'keepExtraBones', 'checkbox'),
      field('Normalize to T-pose', o, 'tPose', 'checkbox', { title: 'VRoid models use a T-pose; A-pose sources are rotated and re-bound.' }),
      field('Target height (m, 0 = keep / auto units)', o, 'targetHeight', 'number', { step: 0.01, min: 0 }),
      note('Units are detected automatically (centimetre rigs such as Mixamo/Unreal are scaled to metres). Models facing -Z are turned around.')),
  ];
  if (!other) { els.push(note('Import a model or animation to convert it. Import a VRoid model to retarget animations and fit models to it.')); return els; }
  const H = other.humanoid;
  const actions = [];
  if (other.kind === 'model' && !other.converted) {
    actions.push(button(other.loaded.rigged ? 'Convert rig to VRoid skeleton' : 'Auto-rig with VRoid skeleton', () => run('Converting', () => {
      const model = viewer.aligned(() => toVRoidModel({ ...other.loaded, humanoid: other.humanoid }));
      state.other = { ...other, root: model, humanoid: { bones: model.userData.humanoid, facing: 1 }, converted: true };
      viewer.setSlot('other', model);
      showTab('convert');
    }), { primary: true }));
  }
  if (other.converted) {
    actions.push(button('Use as the VRoid model', () => {
      state.vroid = { root: other.root, name: other.name };
      viewer.setSlot('vroid', other.root);
      state.other = null; viewer.setSlot('other', null);
      log(`${other.name} is now the VRoid model.`);
      showTab('convert');
    }));
  }
  if (other.loaded.clips.length) {
    actions.push(button(`Retarget ${other.loaded.clips.length} animation(s) to VRoid model`, () => run('Retargeting', () => {
      for (const c of other.loaded.clips) addClip(retargetOnto({ ...other.loaded, humanoid: other.humanoid }, c), `${c.name || other.name}`);
    }), { disabled: !state.vroid }));
  }
  els.push(section('Secondary model', row(...actions),
    H ? note(`Detected ${Object.keys(H.bones).length} humanoid bones. Facing ${H.facing === 1 ? '+Z' : '-Z (will be turned around)'}.`) : note('No skeleton found: the model will be auto-rigged.')));
  els.push(section('Retarget options',
    field('Align rest poses (A-pose ↔ T-pose)', state.options.retarget, 'alignRestPose', 'checkbox'),
    field('Move hips (root motion)', state.options.retarget, 'translateHips', 'checkbox'),
    field('In place (no horizontal root motion)', state.options.retarget, 'inPlace', 'checkbox'),
    field('Sample rate (fps)', state.options.retarget, 'fps', 'number', { min: 1, step: 1 })));
  if (H && !other.converted) {
    const names = [];
    other.root.traverse((x) => { if (x.isBone || (x !== other.root && !x.isMesh)) names.push(x); });
    const table = h('table', { class: 'mapping' }, h('tr', {}, h('th', {}, 'Humanoid'), h('th', {}, 'Source bone')),
      ...HUMANOID_NAMES.map((k) => h('tr', {}, h('td', {}, k), h('td', {}, h('select', {
        onchange: (e) => { const b = names[Number(e.target.value)]; if (b) H.bones[k] = b; else delete H.bones[k]; },
      }, h('option', { value: -1 }, '—'), ...names.map((b, i) => h('option', { value: i, selected: H.bones[k] === b }, b.name || `(node ${i})`)))))));
    els.push(section('Bone mapping (editable)', note('Detected automatically from names and skeleton shape. Correct any wrong entries before converting or retargeting.'), table));
  }
  return els;
}

// ---- Fit
function fitTab() {
  const s = state.options.fit;
  const p = state.options.proportions;
  const ro = s.regionOffsets;
  return [
    section('Refit clothing / accessory onto the VRoid model',
      note('Secondary model = clothing (rigged or not). It is shrink-wrapped onto the VRoid body with the settings below, then skinned to the VRoid skeleton.'),
      field('Offset from skin (m)', s, 'offset', 'range', { min: 0, max: 0.03, step: 0.0005 }),
      field('Tightness', s, 'tightness', 'range', { min: 0, max: 1 }),
      field('Max pull distance (m)', s, 'maxPullDistance', 'range', { min: 0, max: 0.3, step: 0.005, title: 'Parts farther than this from the body (skirts, capes) keep their shape' }),
      field('Push out only (never pull in)', s, 'pushOutOnly', 'checkbox'),
      field('Smoothing iterations', s, 'smoothingIterations', 'range', { min: 0, max: 30, step: 1 }),
      field('Smoothing strength', s, 'smoothingStrength', 'range', { min: 0, max: 1 }),
      field('Collision passes', s, 'collisionPasses', 'range', { min: 0, max: 6, step: 1 }),
      field('Auto-align bounding boxes', s, 'autoAlign', 'checkbox'),
      h('div', { class: 'grid3' }, ...['X', 'Y', 'Z'].map((a, i) => field(`Scale ${a}`, s.scale, i, 'number', { step: 0.01 }))),
      h('div', { class: 'grid3' }, ...['X', 'Y', 'Z'].map((a, i) => field(`Move ${a} (m)`, s.translate, i, 'number', { step: 0.005 }))),
      field('Rotate Y (°)', s, 'rotateY', 'number', { step: 1 }),
      h('div', { class: 'grid3' }, ...Object.keys(ro).map((k) => field(`+offset ${k}`, ro, k, 'number', { step: 0.001 }))),
      field('Transfer skin weights from body', s, 'transferWeights', 'checkbox'),
      field('Weight smoothing', s, 'weightSmoothing', 'range', { min: 0, max: 10, step: 1 }),
      row(
        button('Refit (preview)', () => run('Refitting', () => doRefit(false))),
        button('Refit & attach to VRoid model', () => run('Refitting', () => doRefit(true)), { primary: true }),
      )),
    section('Proportions',
      field('Direction', p, 'direction', 'select', { options: [['otherToVroid', 'Secondary adopts VRoid proportions'], ['vroidToOther', 'VRoid adopts secondary proportions']] }),
      field('Strength', p, 'strength', 'range', { min: 0, max: 1 }),
      field('Limb thickness (girth) match', p, 'girth', 'range', { min: 0, max: 1 }),
      button('Match proportions', () => run('Matching proportions', () => {
        need(state.vroid && state.other?.converted, 'Needs a VRoid model and a converted secondary model (Convert tab).');
        const [a, b] = p.direction === 'otherToVroid' ? [state.other.root, state.vroid.root] : [state.vroid.root, state.other.root];
        viewer.aligned(() => matchProportions(a, b, { strength: p.strength, girth: p.girth }));
        storeRestPose(a);
        viewer.refreshHelpers();
        log('Proportions matched.');
      }), { primary: true })),
  ];
}

function doRefit(attach) {
  need(state.vroid && state.other, 'Needs a VRoid model and a secondary (clothing) model.');
  viewer.stop('vroid');
  const { meshes, stats } = viewer.aligned(() => refitClothing(state.other.root, state.vroid.root, { ...state.options.fit, transferWeights: attach && state.options.fit.transferWeights }));
  log(`Refit ${stats.vertices} vertices: ${stats.pushedOut} pushed out, ${stats.pulledIn} pulled in.`);
  if (attach) {
    attachClothing(state.vroid.root, meshes);
    state.other = null; viewer.setSlot('other', null);
    log(`Attached ${meshes.length} mesh(es) to the VRoid model.`);
  } else {
    const g = new THREE.Group(); g.name = `${state.other.name} (fitted)`;
    for (const m of meshes) g.add(m.isSkinnedMesh ? new THREE.Mesh(m.geometry, m.material) : m);
    state.other = { ...state.other, root: g, loaded: { ...state.other.loaded, root: g, rigged: false }, humanoid: null, kind: 'model', converted: false };
    viewer.setSlot('other', g);
  }
  if (state.active) setActiveClip(state.active);
}

// ---- Animation
function animTab() {
  const ho = state.options.head;
  const H = ho.head, E = ho.eyes;
  return [
    section('Active animation',
      note(state.active ? `"${state.active.name}" — ${state.active.clip.duration.toFixed(2)} s` : 'No animation selected. Import an animation (FBX, BVH, GLB, VRMA…) with “Import model / animation”.'),
      row(
        button('Export current frame as .vroidpose', () => run('Exporting pose', async () => {
          need(state.vroid, 'Load a VRoid model first.');
          const pose = exportVRoidPose(state.vroid.root);
          const frame = Math.round(viewer.time * viewer.fps);
          await saveFile(`${state.vroid.name}_${state.active?.name ?? 'pose'}_f${frame}.vroidpose`, new TextEncoder().encode(JSON.stringify(pose, null, 2)), [{ name: 'VRoid pose', extensions: ['vroidpose'] }]);
          log(`Saved pose at frame ${frame}.`);
        }), { primary: true }),
        button('Apply .vroidpose…', () => run('Applying pose', async () => {
          need(state.vroid, 'Load a VRoid model first.');
          const [f] = await openFiles({ filters: [{ name: 'VRoid pose', extensions: ['vroidpose', 'json'] }] });
          if (!f) return;
          setActiveClip(null);
          const unknown = applyVRoidPose(state.vroid.root, JSON.parse(new TextDecoder().decode(f.bytes)));
          if (unknown.length) log(`Unknown bones in pose: ${unknown.join(', ')}`, 'warn');
        })),
        button('Reset pose', () => { setActiveClip(null); viewer.stop('vroid'); }),
      )),
    section('Head & eye motion',
      field('Head', H, 'mode', 'select', { options: [['keep', 'Keep original'], ['remove', 'Remove head motion'], ['lookAround', 'Look around'], ['fixed', 'Fixed direction']] }),
      field('Fixed: space', H, 'space', 'select', { options: [['local', 'Relative to body'], ['world', 'World (keeps looking that way)']] }),
      field('Yaw (° + = left)', H, 'yaw', 'range', { min: -80, max: 80, step: 1 }),
      field('Pitch (° + = up)', H, 'pitch', 'range', { min: -60, max: 60, step: 1 }),
      field('Roll (°)', H, 'roll', 'range', { min: -40, max: 40, step: 1 }),
      field('Look-around yaw range (°)', H, 'amplitudeYaw', 'range', { min: 0, max: 80, step: 1 }),
      field('Look-around pitch range (°)', H, 'amplitudePitch', 'range', { min: 0, max: 50, step: 1 }),
      field('Look-around speed', H, 'speed', 'range', { min: 0.05, max: 2 }),
      field('Hold time (s)', H, 'holdTime', 'range', { min: 0, max: 5, step: 0.1 }),
      field('Neck share', H, 'neckShare', 'range', { min: 0, max: 1 }),
      field('Add on top of original', H, 'additive', 'checkbox'),
      field('Blend with original', H, 'blend', 'range', { min: 0, max: 1 }),
      field('Random seed', H, 'seed', 'number', { step: 1 }),
      h('hr'),
      field('Eyes', E, 'mode', 'select', { options: [['keep', 'Keep original'], ['none', 'Straight ahead'], ['lookAround', 'Eyes only look around'], ['fixed', 'Fixed eye direction'], ['followHead', 'Lead the head movement']] }),
      field('Eye yaw (°)', E, 'yaw', 'range', { min: -30, max: 30, step: 1 }),
      field('Eye pitch (°)', E, 'pitch', 'range', { min: -25, max: 25, step: 1 }),
      field('Eye yaw range (°)', E, 'amplitudeYaw', 'range', { min: 0, max: 30, step: 1 }),
      field('Eye pitch range (°)', E, 'amplitudePitch', 'range', { min: 0, max: 25, step: 1 }),
      field('Saccade interval (s)', E, 'saccadeInterval', 'range', { min: 0.1, max: 4, step: 0.05 }),
      field('Eye seed', E, 'seed', 'number', { step: 1 }),
      row(button('Apply to active animation (new clip)', () => run('Editing head motion', () => {
        need(state.vroid, 'Load a VRoid model first.');
        const base = state.active?.clip ?? new THREE.AnimationClip('Idle', 10, []);
        viewer.stop('vroid');
        const clip = editHeadMotion(base, state.vroid.root, ho);
        addClip(clip, `${base.name} (head: ${H.mode}, eyes: ${E.mode})`);
      }), { primary: true }))),
    section('Inverse kinematics bake',
      field('Lock feet while in contact', state.options.ikBake, 'footLock', 'checkbox'),
      field('Floor height (m)', state.options.ikBake, 'floorY', 'number', { step: 0.01 }),
      button('Bake leg IK into active animation', () => run('Baking IK', () => {
        need(state.vroid && state.active, 'Needs a VRoid model and an active animation.');
        viewer.stop('vroid');
        addClip(bakeIKToClip(state.vroid.root, state.active.clip, state.options.ikBake), `${state.active.name} (IK)`);
      }))),
  ];
}

// ---- Model tools
function toolsTab() {
  const v = state.vroid;
  const so = state.options.shapeKeys;
  const morphs = [];
  if (v) v.root.traverse((m) => { if (m.isMesh && m.morphTargetDictionary) for (const [n, i] of Object.entries(m.morphTargetDictionary)) morphs.push([m, n, i]); });
  const sliders = morphs.slice(0, 400).map(([m, n, i]) => field(`${m.name}: ${n}`, m.morphTargetInfluences, i, 'range', { min: 0, max: 1 }));
  return [
    section('Optimize (weld duplicate vertices)',
      note('Merges vertices of the same material that share a position.'),
      field('Tolerance (m)', state.options.optimize, 'tolerance', 'number', { step: 0.000001 }),
      field('Keep UV seams', state.options.optimize, 'requireSameUV', 'checkbox', { title: 'Off = weld every coincident vertex (what VRoid duplicates). On = only weld when UVs match too.' }),
      field('Keep hard normals', state.options.optimize, 'requireSameNormal', 'checkbox'),
      field('Remove degenerate triangles', state.options.optimize, 'removeDegenerate', 'checkbox'),
      field('Remove duplicate faces', state.options.optimize, 'removeDuplicateFaces', 'checkbox'),
      button('Optimize VRoid model', () => run('Optimizing', () => {
        need(v, 'Load a VRoid model first.');
        viewer.stop('vroid');
        const report = optimizeModel(v.root, state.options.optimize);
        for (const r of report) log(`${r.mesh}: ${r.before} → ${r.after} vertices, ${r.removedTriangles} triangle(s) removed.`);
        if (state.active) setActiveClip(state.active);
      }), { primary: true })),
    section('Shape keys',
      field('Naming', so, 'style', 'select', { options: [['readable', 'Readable (Eyes.Blink, Mouth.Smile…)'], ['vroid', 'VRoid original (Fcl_…)']] }),
      button('Rename shape keys', () => run('Renaming', () => {
        need(v, 'Load a VRoid model first.');
        const map = renameShapeKeys(v.root, so.style);
        for (const c of state.clips) renameClipShapeKeys(c.clip, map);
        log(`Renamed ${Object.keys(map).length} shape key(s).`);
        showTab('tools');
      })),
      field('Left/right blend width (m)', so, 'blend', 'range', { min: 0.001, max: 0.1, step: 0.001 }),
      field('Left suffix', so, 'leftSuffix', 'text'), field('Right suffix', so, 'rightSuffix', 'text'),
      button('Add asymmetric (L/R) versions of every shape key', () => run('Adding asymmetric shape keys', () => {
        need(v, 'Load a VRoid model first.');
        const added = addAsymmetricShapeKeys(v.root, so);
        v.root.traverse((m) => { if (m.isMesh) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => { x.needsUpdate = true; }); });
        log(`Added ${added.length} shape key(s).`);
        showTab('tools');
      })),
      h('details', {}, h('summary', {}, `Preview shape keys (${morphs.length})`), ...sliders)),
    section('Inverse kinematics',
      button(v?.root.userData.ik ? 'IK rig added' : 'Add IK rig (targets + poles)', () => run('Adding IK', () => {
        need(v, 'Load a VRoid model first.');
        addIKRig(v.root);
        storeRestPose(v.root);
        viewer.refreshHelpers();
        log('Added IK target bones (IK_Foot_L/R, IK_Hand_L/R, knee/elbow poles, IK_LookAt). They export with the skeleton.');
        showTab('tools');
      })),
      v?.root.userData.ik ? h('div', {},
        field('Live IK in viewport', { v: viewer.ikEnabled }, 'v', 'checkbox', { onChange: (x) => { viewer.ikEnabled = x; if (x) setActiveClip(null); } }),
        ...v.root.userData.ik.chains.map((c) => row(field(c.name, c, 'enabled', 'checkbox'), field('match target rotation', c, 'matchRotation', 'checkbox'),
          button('Drag target', () => { viewer.ikEnabled = true; viewer.transform.attach(c.targetBone); }), button('Drag pole', () => viewer.transform.attach(c.poleBoneObj)))),
        row(field('Look-at', v.root.userData.ik, 'lookAtEnabled', 'checkbox'), button('Drag look-at target', () => { viewer.ikEnabled = true; viewer.transform.attach(v.root.userData.ik.lookAt); }),
          button('Release gizmo', () => viewer.transform.detach())),
        note('Drag targets, then use Animation → Export current frame as .vroidpose to save the pose.')) : null),
  ];
}

// ---- Rig conversion
function rigTab() {
  const o = state.options.rig;
  return [
    section('Convert VRoid model to another rig',
      field('Target rig', o, 'profile', 'select', { options: RIG_PROFILES.map((p) => [p.id, p.name]) }),
      field('Keep extra bones', o, 'keepExtraBones', 'checkbox'),
      row(button('Convert (preview as secondary)', () => run('Converting rig', () => {
        need(state.vroid, 'Load a VRoid model first.');
        viewer.stop('vroid');
        const out = convertToProfile(state.vroid.root, getProfile(o.profile), { keepExtraBones: o.keepExtraBones });
        showConvertedRig(out, getProfile(o.profile).name);
      }), { primary: true }),
      button('Load rig profile JSON…', () => run('Loading profile', async () => {
        const [f] = await openFiles({ filters: [{ name: 'Rig profile', extensions: ['json'] }] });
        if (!f) return;
        const p = parseProfile(new TextDecoder().decode(f.bytes));
        RIG_PROFILES.push(p); o.profile = p.id; showTab('rig');
      }))),
      note('Tower Unite’s modern player-model skeleton uses Unreal Engine 4 mannequin bone names. For an exact match of bone orientations, use “provided rig” with the official skeleton file.')),
    section('Convert to a provided rig file',
      field('Proportions', o, 'proportions', 'select', { options: [['model', 'Keep the VRoid model proportions'], ['target', 'Adopt the rig proportions']] }),
      button('Choose rig file (FBX / GLB / VRM / DAE)…', () => run('Converting to provided rig', async () => {
        need(state.vroid, 'Load a VRoid model first.');
        const [f] = await readSelected({ filters: MODEL_FILTER });
        if (!f) return;
        const loaded = await loadModelFile(f.name, f.bytes, f.siblings);
        viewer.stop('vroid');
        const out = viewer.aligned(() => convertToProvidedRig(cloneForConvert(state.vroid.root), loaded.root, { proportions: o.proportions, keepExtraBones: o.keepExtraBones }));
        showConvertedRig(out, baseName(f.name));
      }))),
  ];
}
function cloneForConvert(model) {
  // operate on a copy so the VRoid model stays intact
  return convertToVRoid(model, { humanoid: { bones: model.userData.humanoid, facing: 1 }, keepExtraBones: true, tPose: false, groundToZero: false });
}
function showConvertedRig(out, label) {
  state.other = { root: out, loaded: { root: out, rigged: true, clips: [], fileName: label }, humanoid: { bones: out.userData.humanoid, facing: 1 }, kind: 'model', name: `${state.vroid.name} → ${label}`, converted: false, rigConverted: true };
  viewer.setSlot('other', out);
  viewer.sideBySide = true; viewer.layout();
  log(`Converted to ${label}. Export it from the Export tab (target: secondary).`);
  if (state.active) setActiveClip(state.active);
}

// ---- Custom item
function itemTab() {
  const o = state.options.item;
  const it = state.item;
  const els = [section('VRoid custom item (.vroidcustomitem)',
    note('Custom items are VRoid Studio archives. This tool can change the category (within hair / clothing / accessory), rename, give fresh IDs, replace embedded textures and the thumbnail. To turn a model into a custom item, open a template item of the wanted category exported from VRoid Studio, then bake the model onto the VRoid model’s matching texture and replace the template’s texture.'),
    row(button('Open .vroidcustomitem…', () => run('Opening custom item', async () => {
      const [f] = await openFiles({ filters: [{ name: 'VRoid custom item', extensions: ['vroidcustomitem'] }] });
      if (!f) return;
      state.item = { item: readCustomItem(f.bytes), name: baseName(f.name) };
      o.category = state.item.item.category?.key ?? '';
      o.name = state.item.item.meta.name ?? baseName(f.name);
      log(`Custom item: ${JSON.stringify(describeCustomItem(state.item.item))}`);
      showTab('item');
    }), { primary: true })))];
  if (!it) return els;
  const info = describeCustomItem(it.item);
  const family = it.item.category?.family;
  els.push(section(`Item: ${it.name}`,
    note(`Category: ${info.category} (${info.family}), ${info.entries} entries, ${info.images.length} embedded image(s).`),
    field('Category', o, 'category', 'select', { options: CATEGORIES.filter((c) => !family || c.family === family).map((c) => [c.key, `${c.label} (${c.family})`]) }),
    field('Name', o, 'name', 'text'),
    field('Generate new item IDs (import as a new item)', o, 'newIds', 'checkbox'),
    h('div', { class: 'thumbs' }, ...it.item.images.map((img) => h('figure', {},
      h('img', { src: URL.createObjectURL(new Blob([img.bytes], { type: `image/${img.type}` })) }),
      h('figcaption', {}, `${img.type} ${(img.size / 1024).toFixed(0)} KB`),
      button('Replace…', () => run('Replacing image', async () => {
        const [f] = await openFiles({ filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (!f) return;
        replaceImage(it.item, img.id, f.bytes); showTab('item');
      })),
      button('Replace with bake', () => run('Baking texture', async () => {
        need(state.vroid && state.other, 'Needs the VRoid model (target UVs) and a secondary model (appearance to bake).');
        const target = findBakeTarget(o.bakeMaterial);
        const baked = viewer.aligned(() => bakeAppearance(state.other.root, target.mesh, { size: o.bakeSize, maxDistance: o.bakeDistance, materialIndex: target.materialIndex }));
        log(`Baked ${(baked.coverage * 100).toFixed(0)}% of ${target.label}.`);
        replaceImage(it.item, img.id, await encodePng(baked));
        showTab('item');
      })))))));
  const mats = bakeTargets();
  els.push(section('Bake settings',
    field('VRoid material to bake onto', o, 'bakeMaterial', 'select', { options: [['', '(auto: match category)'], ...mats.map((m) => [m.label, m.label])] }),
    field('Texture size', o, 'bakeSize', 'select', { options: [512, 1024, 2048, 4096], numeric: true }),
    field('Max surface distance (m)', o, 'bakeDistance', 'number', { step: 0.005 }),
    row(button('Thumbnail from viewport', () => run('Thumbnail', async () => { setThumbnail(it.item, await viewer.snapshot(512)); log('Thumbnail updated.'); })),
      button('Save .vroidcustomitem…', () => run('Saving custom item', async () => {
        let item = it.item;
        if (o.category && o.category !== item.category?.key) recategorize(item, o.category);
        if (o.name) setName(item, o.name);
        if (o.newIds) item = regenerateIds(item);
        await saveFile(`${o.name || it.name}.vroidcustomitem`, writeCustomItem(item), [{ name: 'VRoid custom item', extensions: ['vroidcustomitem'] }]);
        log('Custom item saved.');
      }), { primary: true }))));
  return els;
}
function bakeTargets() {
  const out = [];
  state.vroid?.root.traverse((m) => {
    if (!m.isMesh || !m.geometry.attributes.uv) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    mats.forEach((mat, i) => out.push({ mesh: m, materialIndex: Array.isArray(m.material) ? i : null, label: `${m.name} / ${mat.name || i}` }));
  });
  return out;
}
function findBakeTarget(label) {
  const list = bakeTargets();
  need(list.length, 'The VRoid model has no UV-mapped meshes.');
  if (label) return list.find((t) => t.label === label) ?? list[0];
  const cat = state.item?.item.category?.suffix ?? '';
  return list.find((t) => t.label.toLowerCase().includes(cat.toLowerCase())) ?? list.find((t) => /cloth|tops|body/i.test(t.label)) ?? list[0];
}

// ---- Lip sync
function lipsyncTab() {
  const o = state.options.lipsync;
  return [section('Lip sync from audio',
    note(state.audio ? `Audio: ${state.audio.name} (${state.audio.decoded.duration.toFixed(2)} s)` : 'Import an audio file (WAV, MP3, OGG, FLAC…) from the toolbar.'),
    field('Frames per second', o, 'fps', 'number', { step: 1, min: 1 }),
    field('Mouth gain', o, 'gain', 'range', { min: 0.1, max: 2 }),
    field('Silence threshold (dB)', o, 'silenceDb', 'range', { min: -80, max: -10, step: 1 }),
    field('Full opening at (dB)', o, 'fullDb', 'range', { min: -40, max: 0, step: 1 }),
    field('Voice pitch (formant scale)', o, 'formantScale', 'range', { min: 0.7, max: 1.4 }),
    field('Attack', o, 'attack', 'range', { min: 0.05, max: 1 }),
    field('Release', o, 'release', 'range', { min: 0.05, max: 1 }),
    field('Max weight', o, 'maxWeight', 'range', { min: 0.1, max: 1 }),
    field('Close mouth between words', o, 'closeMouthBetweenWords', 'checkbox'),
    field('Combine with active body animation', o, 'mergeWithActive', 'checkbox'),
    row(button('Generate lip sync', () => run('Analysing audio', () => {
      need(state.vroid && state.audio, 'Needs a VRoid model and an audio file.');
      const frames = analyzeLipSync(state.audio.decoded, o);
      let clip = lipSyncClip(state.vroid.root, frames, { name: `LipSync ${baseName(state.audio.name)}` });
      need(clip.tracks.length, 'The VRoid model has no Fcl_MTH_A/I/U/E/O (or Viseme.*) shape keys.');
      if (o.mergeWithActive && state.active) clip = mergeClips(state.active.clip, clip, `${state.active.name} + ${clip.name}`);
      viewer.audio = state.audio.el;
      addClip(clip);
      log(`Lip sync: ${frames.length} frames.`);
    }), { primary: true }),
    button('Attach audio to playback', () => { viewer.audio = state.audio?.el ?? null; }),
    button('Detach audio', () => { viewer.audio?.pause(); viewer.audio = null; })))];
}

// ---- DIVA
function divaTab() {
  const o = state.options.diva;
  const tree = h('div', { class: 'diva-tree' });
  for (const src of state.diva.sources) {
    const preview = state.diva.previews.get(src);
    const refresh = () => refreshDivaVisibility(preview);
    const srcEl = h('details', { open: true }, h('summary', {}, src.fileName,
      h('button', { class: 'mini', title: 'Remove archive', onclick: () => { state.diva.sources.splice(state.diva.sources.indexOf(src), 1); state.diva.previews.delete(src); rebuildDivaPreview(); showTab('diva'); } }, '✕')));
    for (const os of src.objectSets) for (const obj of os.set.objects) {
      const objEl = h('details', {}, h('summary', {}, field(`${obj.name} — ${obj.meshes.length} mesh(es), ${obj.skin?.bones.length ?? 0} bones, ${obj.skin?.blocks.filter((b) => b.type === 'OSG').length ?? 0} osage`, obj, 'enabled', 'checkbox', { onChange: refresh })));
      for (const m of obj.meshes) {
        const meshEl = h('details', { class: 'indent' }, h('summary', {}, field(`${m.name || 'mesh'} (${m.positions.length / 3} verts)`, m, 'enabled', 'checkbox', { onChange: refresh })));
        m.subMeshes.forEach((sm, i) => meshEl.append(h('div', { class: 'indent' }, field(`sub-mesh ${i}: ${obj.materials[sm.materialIndex]?.name ?? '?'} (${sm.indices.length} idx)`, sm, 'enabled', 'checkbox', { onChange: refresh }))));
        objEl.append(meshEl);
      }
      srcEl.append(objEl);
    }
    tree.append(srcEl);
  }
  return [
    section('Project DIVA Mega Mix+ .farc merge',
      note('Import several module/item .farc files (toolbar → Import .farc). Untick objects, meshes or sub-meshes to remove them, then export one merged .farc. Bones are unified by name, osage/cloth physics blocks are merged, and an ext_skp skin parameter file is generated (taken from imported skin_param .txt files where available).'),
      button('Add skin parameter .txt to last archive…', () => importFarcSkp()),
      tree),
    section('Output',
      field('Output name (file prefix)', o, 'outputName', 'text'),
      field('Object name', o, 'objectName', 'text'),
      field('Object ID', o, 'objectId', 'number', { step: 1 }),
      field('Object set ID (mod_obj_db)', o, 'objectSetId', 'number', { step: 1 }),
      field('New texture ID base (blank = keep IDs)', o, 'textureIdBase', 'text'),
      field('Merge into a single object', o, 'singleObject', 'checkbox'),
      field('Remove unused vertices', o, 'compactVertices', 'checkbox'),
      field('Put skin_param txt inside the .farc too', o, 'includeSkinParamInFarc', 'checkbox'),
      field('Compress (FArC)', o, 'compress', 'checkbox'),
      button('Merge & export…', () => run('Merging', async () => {
        need(state.diva.sources.length, 'Import at least one .farc.');
        const res = mergeDivaSources(state.diva.sources, { ...o, textureIdBase: o.textureIdBase === '' ? null : Number(o.textureIdBase) });
        for (const r of res.report) log(r);
        const saved = await saveFile(res.farcName, res.farc, [{ name: 'FARC', extensions: ['farc'] }]);
        if (!saved) return;
        await saveFile(res.skinParamName, new TextEncoder().encode(res.skinParamText), [{ name: 'Skin parameters', extensions: ['txt'] }]);
        await saveFile('mod_obj_db.bin', res.objDb, [{ name: 'Object database', extensions: ['bin'] }]);
        if (res.texDb) await saveFile('mod_tex_db.bin', res.texDb, [{ name: 'Texture database', extensions: ['bin'] }]);
        log(`Saved ${res.farcName}, ${res.skinParamName} and mod_obj_db.bin${res.texDb ? ' + mod_tex_db.bin' : ''}.`);
      }), { primary: true })),
  ];
}
async function importFarcSkp() {
  const [f] = await openFiles({ filters: [{ name: 'Skin parameters', extensions: ['txt'] }] });
  if (!f) return;
  const target = state.diva.sources[state.diva.sources.length - 1];
  if (!target) return log('Import a .farc first.', 'warn');
  addSkinParamText(target, new TextDecoder().decode(f.bytes));
  log(`Added skin parameters from ${f.name}.`);
}

// ---- Export
function exportTab() {
  const o = state.options.export;
  const formats = [['fbx', 'FBX (binary 7.4)'], ['vrm1', 'VRM 1.0'], ['vrm0', 'VRM 0.x'], ['glb', 'GLB'], ['gltf', 'glTF (JSON)']];
  return [section('Export',
    field('What', o, 'target', 'select', { options: [['vroid', 'VRoid model'], ['other', 'Secondary model (e.g. converted rig)'], ['clips', 'Animations only (VRoid skeleton)']] }),
    field('Format', o, 'format', 'select', { options: formats }),
    field('FBX units', o, 'units', 'select', { options: [['cm', 'Centimetres (Unity/Unreal/Blender default)'], ['m', 'Metres']] }),
    field('Animations', o, 'clips', 'select', { options: [['all', 'All animations'], ['active', 'Active animation'], ['none', 'None']] }),
    button('Export…', () => run('Exporting', () => doExport()), { primary: true }),
    note('VRoid Studio itself only imports .vroidpose (poses) and .vroidcustomitem; VRM exports work in VRoid Hub, Unity (UniVRM), Blender (VRM add-on) and VR apps. .vroidpose export is in the Animation tab.'))];
}
async function doExport() {
  const o = state.options.export;
  const clips = o.clips === 'none' ? [] : o.clips === 'active' ? (state.active ? [state.active.clip] : []) : state.clips.map((c) => c.clip);
  let root, name, units = o.units;
  if (o.target === 'other') {
    need(state.other, 'No secondary model.');
    root = state.other.root.userData.exportRoot ?? state.other.root; name = state.other.name;
    units = state.other.root.userData.exportUnits ?? units;
  } else {
    need(state.vroid, 'Load a VRoid model first.');
    root = state.vroid.root; name = state.vroid.name;
  }
  viewer.stop('vroid'); viewer.stop('other');
  let bytes, extName;
  if (o.format === 'fbx') {
    if (o.target === 'clips') {
      // skeleton-only FBX: hide meshes
      const hidden = meshesOf(root).map((m) => [m, m.parent]);
      for (const [m, p] of hidden) p.remove(m);
      try { bytes = await exportFBX(root, { clips, units }); } finally { for (const [m, p] of hidden) p.add(m); }
    } else bytes = await exportFBX(root, { clips: o.target === 'other' ? [] : clips, units });
    extName = 'fbx';
  } else {
    bytes = await exportGLTF(root, { format: o.format, clips: o.target === 'other' ? [] : clips, meta: state.vroid?.meta });
    extName = o.format === 'vrm0' || o.format === 'vrm1' ? 'vrm' : o.format;
  }
  const saved = await saveFile(`${name}.${extName}`, bytes, [{ name: extName.toUpperCase(), extensions: [extName] }]);
  if (saved) log(`Exported ${name}.${extName} (${(bytes.length / 1048576).toFixed(2)} MB).`);
  if (state.active) setActiveClip(state.active);
}

// ------------------------------------------------------------------ drag & drop
viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const file of e.dataTransfer.files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const x = ext(file.name);
    if (x === 'farc') await run('Reading DIVA archive', async () => { const src = loadDivaSource(file.name, bytes); state.diva.sources.push(src); state.diva.previews.set(src, buildDivaPreview(src)); rebuildDivaPreview(); showTab('diva'); });
    else if (AUDIO_EXTENSIONS.includes(x)) await run('Decoding audio', async () => { const decoded = await loadAudioFile(bytes); const url = URL.createObjectURL(new Blob([bytes])); state.audio = { name: file.name, decoded, url, el: new Audio(url) }; showTab('lipsync'); });
    else if (x === 'vroidcustomitem') await run('Opening custom item', async () => { state.item = { item: readCustomItem(bytes), name: baseName(file.name) }; showTab('item'); });
    else if (MODEL_EXTENSIONS.includes(x)) await run(`Loading ${file.name}`, async () => {
      const loaded = await loadModelFile(file.name, bytes, null);
      if (!state.vroid && loaded.kind === 'model') { const model = toVRoidModel(loaded); state.vroid = { root: model, name: baseName(file.name), meta: loaded.meta }; viewer.setSlot('vroid', model); }
      else {
        state.other = { root: loaded.root, loaded, humanoid: loaded.humanoid, kind: loaded.kind, name: baseName(file.name), converted: false };
        viewer.setSlot('other', loaded.root);
        if (loaded.kind === 'animation' && state.vroid) for (const c of loaded.clips) addClip(retargetOnto(loaded, c), c.name || baseName(file.name));
      }
      viewer.frame();
      showTab(currentTab);
    });
  }
});

refreshScenePanel();
refreshClipSelect();
showTab('convert');
log('Ready. Import a VRoid model, then a model, animation, audio or .farc. Files can also be dropped on the viewport.');
window.__vsc = { state, viewer };
