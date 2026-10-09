// End-to-end checks of the second feature round against real files (VRoid VRM, Mixamo FBX in cm,
// real VRoid custom items and skin params). usage: node scripts/smoke-real.mjs <fixturesDir> <shotsDir>
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const [fixtures, shots] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const server = http.createServer(async (req, res) => {
  try {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const p = path.join('dist', u === '/' ? 'index.html' : u);
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(p)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('dialog', (d) => d.dismiss());
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__vsc);
const idle = () => page.waitForFunction(() => document.querySelector('.busy').classList.contains('hidden'), null, { timeout: 120000 });
const btn = (name) => page.getByRole('button', { name, exact: true }).first();
const choose = async (name, file) => {
  const [c] = await Promise.all([page.waitForEvent('filechooser'), btn(name).click()]);
  await c.setFiles(path.isAbsolute(file) ? file : path.join(fixtures, file));
  await page.waitForTimeout(900); await idle(); await page.waitForTimeout(150);
};
const click = async (name) => { await btn(name).click(); await page.waitForTimeout(150); await idle(); };
const tab = (name) => btn(name).click();
const download = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), btn(name).click()]);
  await idle();
  const p = path.join(os.tmpdir(), `vsc-${Date.now()}-${dl.suggestedFilename()}`);
  await dl.saveAs(p);
  return p;
};
const ev = (fn, arg) => page.evaluate(fn, arg);
const logText = () => page.$eval('.log', (e) => e.innerText);
const check = (cond, msg) => { if (!cond) errors.push(`CHECK FAILED: ${msg}`); else console.log(`ok - ${msg}`); };

// --- view modes with a real VRoid VRM and a centimetre Mixamo FBX
await choose('Import VRoid model…', 'VRM1_Constraint_Twist_Sample.vrm');
await choose('Import model / animation…', 'Samba_Dancing.fbx');
let v = await ev(() => { const V = window.__vsc.viewer; return { mode: V.viewMode, scale: V.slots.other.scale.x, x: V.slots.other.position.x, vis: [V.slots.vroid.visible, V.slots.other.visible] }; });
check(v.mode === 'side' && v.vis[0] && v.vis[1], `both models visible side by side (${JSON.stringify(v)})`);
check(v.scale === 0.01 && v.x > 0.3, 'centimetre model shown at metre scale beside the VRoid model');
await page.screenshot({ path: path.join(shots, 'r1-side.png') });
await page.selectOption('.view-select', 'vroid');
v = await ev(() => [window.__vsc.viewer.slots.vroid.visible, window.__vsc.viewer.slots.other.visible]);
check(v[0] && !v[1], 'view: VRoid only');
await page.selectOption('.view-select', 'other');
v = await ev(() => [window.__vsc.viewer.slots.vroid.visible, window.__vsc.viewer.slots.other.visible]);
check(!v[0] && v[1], 'view: secondary only');
await page.selectOption('.view-select', 'both');
v = await ev(() => [window.__vsc.viewer.slots.vroid.visible, window.__vsc.viewer.slots.other.visible, window.__vsc.viewer.slots.other.position.x]);
check(v[0] && v[1] && v[2] === 0, 'view: both overlapping');
await page.selectOption('.view-select', 'side');
check(await ev(() => window.__vsc.state.clips.length) === 0, 'secondary is a model (not auto-retargeted)');
await tab('Convert');
await page.getByRole('button', { name: /^Retarget \d+ animation/ }).click();
await page.waitForTimeout(300); await idle();
check(await ev(() => window.__vsc.state.clips.length) === 2, 'Samba animations retargeted onto the VRM');

// --- shape keys: grouped preview, rename replaces, undo/redo
await tab('Model tools');
const sliderCount = await page.locator('details .field input[type=range]').count();
check(sliderCount === 57, `one preview slider per shape key name (${sliderCount})`);
await ev(() => {
  const lab = [...document.querySelectorAll('details .field')].find((l) => l.textContent.includes('Fcl_EYE_Close (7 meshes)') || l.textContent.startsWith('Face_Blendshape.Fcl_EYE_Close'));
  const input = lab.querySelector('input'); input.value = 1; input.dispatchEvent(new Event('input', { bubbles: true }));
});
const closed = await ev(() => { let n = 0; window.__vsc.state.vroid.root.traverse((m) => { if (m.isMesh && m.morphTargetDictionary) { const i = m.morphTargetDictionary['Face_Blendshape.Fcl_EYE_Close']; if (i !== undefined && m.morphTargetInfluences[i] === 1) n++; } }); return n; });
check(closed === 7, `slider drives the shape key on all 7 face primitives (${closed})`);
await click('Rename shape keys');
const names = await ev(() => { const s = new Set(); let total = 0; window.__vsc.state.vroid.root.traverse((m) => { if (m.isMesh && m.morphTargetDictionary) { total += Object.keys(m.morphTargetDictionary).length; for (const k of Object.keys(m.morphTargetDictionary)) s.add(k); } }); return { unique: [...s], total }; });
check(names.unique.includes('Eyes.Blink') && !names.unique.some((n) => n.includes('Fcl_')), 'rename replaced the Fcl_ names (no duplicates left)');
check(names.total === 7 * 57, `shape key count unchanged by rename (${names.total})`);
await click('↶ Undo');
const afterUndo = await ev(() => { const s = new Set(); window.__vsc.state.vroid.root.traverse((m) => { if (m.isMesh && m.morphTargetDictionary) for (const k of Object.keys(m.morphTargetDictionary)) s.add(k); }); return [...s]; });
check(afterUndo.includes('Face_Blendshape.Fcl_EYE_Close') && !afterUndo.includes('Eyes.Blink'), 'undo restores the original names');
await click('↷ Redo');
const afterRedo = await ev(() => { const s = new Set(); window.__vsc.state.vroid.root.traverse((m) => { if (m.isMesh && m.morphTargetDictionary) for (const k of Object.keys(m.morphTargetDictionary)) s.add(k); }); return [...s]; });
check(afterRedo.includes('Eyes.Blink'), 'redo re-applies the rename');
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
check(await ev(() => { let ok = false; window.__vsc.state.vroid.root.traverse((m) => { if (m.morphTargetDictionary?.['Face_Blendshape.Fcl_EYE_Close'] !== undefined) ok = true; }); return ok; }), 'Ctrl+Z undoes');

// --- pose export matches the VRoid layout
await tab('Animation');
const posePath = await download('Export current frame as .vroidpose');
const pose = JSON.parse(await readFile(posePath, 'utf8'));
check(pose.Version === 1 && pose.BoneDefinition.HipsPosition && pose.BoneDefinition.Hips.w !== undefined && !pose.BoneDefinition.Hips.Rotation, 'exported .vroidpose uses VRoid Studio layout');

// --- lip sync with voice isolation on a model that has visemes
const [ac] = await Promise.all([page.waitForEvent('filechooser'), btn('Import audio…').click()]);
await ac.setFiles(path.join(fixtures, 'voice.wav'));
await page.waitForFunction(() => window.__vsc.state.audio);
await tab('Lip sync');
await click('Preset: singing over music');
await click('Generate lip sync');
check((await logText()).includes('Lip sync:'), 'lip sync generated with vocal isolation');

// --- COLLADA export, re-import
await tab('Export');
await page.locator('select').filter({ hasText: 'COLLADA (.dae)' }).first().selectOption('dae');
await page.locator('select').filter({ hasText: 'Active animation' }).first().selectOption('active');
const daePath = await download('Export…');
check(daePath.endsWith('.dae'), 'DAE exported');
await choose('Import model / animation…', daePath);
const dae = await ev(() => { const o = window.__vsc.state.other; let sk = 0; o.root.traverse((x) => { if (x.isSkinnedMesh) sk++; }); return { sk, clips: o.loaded.clips.length, kind: o.kind }; });
check(dae.sk > 0 && dae.clips === 1, `DAE re-imports with skin and animation (${JSON.stringify(dae)})`);

// --- custom items: hair preview + rebuild, hat parent bone
await tab('Custom item');
await choose('Open .vroidcustomitem…', 'HairstyleExample.vroidcustomitem');
check(await ev(() => window.__vsc.viewer.slots.hair.children[0]?.children.length) > 50, 'template hair strands shown on the VRoid head');
await page.screenshot({ path: path.join(shots, 'r2-hair.png') });
await choose('Import model / animation…', 'hair_cards.obj');
await tab('Custom item');
await click('Rebuild hair from secondary model');
check((await logText()).includes('Rebuilt hair: 12 strand(s)'), 'hair rebuilt from 12 mesh cards');
await page.screenshot({ path: path.join(shots, 'r3-rebuilt.png') });
const itemPath = await download('Save .vroidcustomitem…');
await choose('Open .vroidcustomitem…', itemPath);
check(await ev(() => window.__vsc.viewer.slots.hair.children[0]?.children.length) === 12, 'saved hair item reopens with 12 strands');
await choose('Open .vroidcustomitem…', 'MCHelm.vroidcustomitem');
await page.locator('select').filter({ hasText: 'J_Bip_C_Neck' }).first().selectOption('J_Bip_C_Neck');
await click('Set parent bone');
check((await logText()).includes('Accessory now attached to J_Bip_C_Neck'), 'hat re-parented to the neck');

// --- DIVA merge with template skin param
const [fc] = await Promise.all([page.waitForEvent('filechooser'), btn('Import .farc…').click()]);
await fc.setFiles(path.join(fixtures, 'mikitm001.farc'));
await page.waitForFunction(() => window.__vsc.state.diva.sources.length === 1);
await tab('DIVA .farc');
await choose('Load template skin_param .txt…', 'ext_skp_mikitm001_joha_outer_01__divskn.txt');
check((await logText()).includes('43 osage entries'), 'template skin_param loaded');
const downloads = [];
page.on('download', (d) => downloads.push(d.suggestedFilename()));
await click('Merge & export…');
await page.waitForTimeout(500);
check(downloads.some((n) => n.endsWith('__divskn.txt')), `skin param saved with __divskn name (${downloads.join(', ')})`);

console.log(errors.length ? `\nERRORS:\n${errors.join('\n')}` : '\nno page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
