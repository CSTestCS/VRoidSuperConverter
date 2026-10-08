// UI smoke test: serves dist/ and drives the app in headless Chromium through the main workflows.
// usage: node scripts/smoke.mjs <fixturesDir> <screenshotDir>   (playwright must be resolvable via PLAYWRIGHT_PATH)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const [fixtures, shots] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const p = path.join('dist', decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    res.writeHead(200, { 'content-type': types[path.extname(p)] ?? 'application/octet-stream' });
    res.end(await readFile(p));
  } catch { res.writeHead(404); res.end(); }
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('dialog', (d) => d.dismiss());
await page.goto(url);
await page.waitForFunction(() => window.__vsc);

const choose = async (buttonText, file) => {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: buttonText, exact: true }).first().click()]);
  await chooser.setFiles(path.join(fixtures, file));
  await page.waitForFunction(() => document.querySelector('.busy').classList.contains('hidden'));
  await page.waitForTimeout(150);
};
const clickAndWait = async (name) => {
  await page.getByRole('button', { name, exact: true }).first().click();
  await page.waitForTimeout(100);
  await page.waitForFunction(() => document.querySelector('.busy').classList.contains('hidden'));
};
const download = async (name) => {
  const [dl] = await Promise.all([page.waitForEvent('download'), clickAndWait(name)]);
  return dl.suggestedFilename();
};
const logText = () => page.$eval('.log', (e) => e.innerText);
const shot = (n) => page.screenshot({ path: path.join(shots, `${n}.png`) });
const check = (cond, msg) => { if (!cond) { errors.push(`CHECK FAILED: ${msg}`); } else console.log(`ok - ${msg}`); };

await choose('Import VRoid model…', 'mixamo_wave.fbx');
check(await page.evaluate(() => !!window.__vsc.state.vroid), 'rigged FBX imported and converted as the VRoid model');
check(await page.evaluate(() => window.__vsc.state.clips.length === 1), 'its animation was retargeted');
await shot('01-vroid');

await choose('Import model / animation…', 'arm_raise.bvh');
check(await page.evaluate(() => window.__vsc.state.clips.length === 2), 'BVH animation retargeted onto VRoid model');
await page.evaluate(() => window.__vsc.viewer.setTime(0.5));
await shot('02-bvh');

await choose('Import model / animation…', 'box_person.obj');
await clickAndWait('Auto-rig with VRoid skeleton');
check(await page.evaluate(() => window.__vsc.state.other?.converted === true), 'OBJ auto-rigged');
await page.getByRole('button', { name: 'Fit & Shape', exact: true }).click();
await clickAndWait('Match proportions');
check((await logText()).includes('Proportions matched'), 'proportions matched');
await clickAndWait('Refit (preview)');
check((await logText()).includes('Refit'), 'clothing refit ran');
await shot('03-fit');

await page.getByRole('button', { name: 'Animation', exact: true }).click();
await page.locator('select').filter({ hasText: 'Keep original' }).first().selectOption('lookAround');
await clickAndWait('Apply to active animation (new clip)');
check(await page.evaluate(() => window.__vsc.state.clips.length === 3), 'head look-around clip added');
const pose = await download('Export current frame as .vroidpose');
check(pose.endsWith('.vroidpose'), `pose exported (${pose})`);
await clickAndWait('Bake leg IK into active animation');

await page.getByRole('button', { name: 'Model tools', exact: true }).click();
await clickAndWait('Optimize VRoid model');
check((await logText()).includes('vertices'), 'optimize ran');
if (await page.getByRole('button', { name: 'Add IK rig (targets + poles)', exact: true }).count()) await clickAndWait('Add IK rig (targets + poles)');
check(await page.evaluate(() => !!window.__vsc.state.vroid.root.userData.ik), 'IK rig added');

await page.getByRole('button', { name: 'Rig convert', exact: true }).click();
await clickAndWait('Convert (preview as secondary)');
check(await page.evaluate(() => !!window.__vsc.state.other?.root.getObjectByName('pelvis')), 'converted to Tower Unite rig');
await shot('04-rig');

await page.getByRole('button', { name: 'Export', exact: true }).click();
const fbx = await download('Export…');
check(fbx.endsWith('.fbx'), `FBX exported (${fbx})`);
await page.locator('select').filter({ hasText: 'VRM 1.0' }).first().selectOption('vrm1');
const vrm = await download('Export…');
check(vrm.endsWith('.vrm'), `VRM exported (${vrm})`);
await page.locator('select').filter({ hasText: 'VRM 1.0' }).first().selectOption('vrm0');
const vrm0 = await download('Export…');
check(vrm0.endsWith('.vrm'), `VRM 0.x exported (${vrm0})`);

const [ac] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import audio…' }).click()]);
await ac.setFiles(path.join(fixtures, 'voice.wav'));
await page.waitForFunction(() => window.__vsc.state.audio);
await page.getByRole('button', { name: 'Lip sync', exact: true }).click();
await clickAndWait('Generate lip sync');
check((await logText()).includes('Lip sync') || (await logText()).includes('Fcl_MTH'), 'lip sync attempted (test model has no mouth shapes)');

const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Import .farc…' }).click()]);
await fc.setFiles(path.join(fixtures, 'mikitm001.farc'));
await page.waitForFunction(() => window.__vsc.state.diva.sources.length === 1);
await page.waitForTimeout(200);
await shot('05-diva');
const farc = await download('Merge & export…');
check(farc.endsWith('.farc'), `DIVA farc merged (${farc})`);

console.log(errors.length ? `\nERRORS:\n${errors.join('\n')}` : '\nno page errors');
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
