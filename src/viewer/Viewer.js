// 3D preview: two model slots (VRoid model + secondary model/animation), skeleton display,
// animation playback with scrubbing, IK target gizmos, and DIVA object preview.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { solveModelIK } from '../core/ik.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x24262c);
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 200);
    this.camera.position.set(0, 1.2, 3.6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.9, 0);
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(1.5, 3, 2.5);
    this.scene.add(dir);
    this.grid = new THREE.GridHelper(10, 20, 0x666a75, 0x3a3d45);
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(0.3);
    this.scene.add(this.axes);

    this.slots = { vroid: new THREE.Group(), other: new THREE.Group(), diva: new THREE.Group() };
    for (const g of Object.values(this.slots)) this.scene.add(g);
    this.helpers = new THREE.Group();
    this.scene.add(this.helpers);
    this.sideBySide = false;

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(0.6);
    this.transform.addEventListener('dragging-changed', (e) => { this.controls.enabled = !e.value; });
    this.scene.add(this.transform.getHelper ? this.transform.getHelper() : this.transform);

    this.clock = new THREE.Clock();
    this.mixers = new Map(); // slot -> {mixer, action, clip}
    this.playing = false;
    this.time = 0;
    this.duration = 0;
    this.fps = 30;
    this.loop = true;
    this.ikEnabled = false;
    this.onTime = null;
    this.audio = null; // {element}
    this.showSkeleton = true;

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setSlot(slot, object) {
    const g = this.slots[slot];
    for (const c of [...g.children]) g.remove(c);
    this.stop(slot);
    if (object) g.add(object);
    this.layout();
    this.refreshHelpers();
  }

  get(slot) { return this.slots[slot].children[0] ?? null; }

  /** Place the secondary slot beside the VRoid model, or overlapping it. */
  layout() {
    this.slots.other.position.x = this.sideBySide && this.get('vroid') ? 1.1 : 0;
    this.slots.diva.position.x = this.get('vroid') || this.get('other') ? -1.1 : 0;
  }

  /** Run fn with both slots at the origin (tools work in world space). */
  aligned(fn) {
    const saved = [this.slots.other.position.x, this.slots.diva.position.x];
    this.slots.other.position.x = 0; this.slots.diva.position.x = 0;
    this.scene.updateMatrixWorld(true);
    try { return fn(); } finally { [this.slots.other.position.x, this.slots.diva.position.x] = saved; this.scene.updateMatrixWorld(true); }
  }

  refreshHelpers() {
    for (const c of [...this.helpers.children]) { this.helpers.remove(c); c.dispose?.(); }
    if (!this.showSkeleton) return;
    for (const slot of ['vroid', 'other']) {
      const o = this.get(slot);
      if (!o) continue;
      let hasBones = false;
      o.traverse((x) => { if (x.isBone) hasBones = true; });
      if (!hasBones) continue;
      const h = new THREE.SkeletonHelper(o);
      h.material.depthTest = false;
      h.material.transparent = true;
      h.material.opacity = 0.85;
      this.helpers.add(h);
    }
  }

  frame(object = null) {
    const box = new THREE.Box3();
    const targets = object ? [object] : Object.values(this.slots);
    for (const t of targets) box.expandByObject(t);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const half = Math.max(s.y / 2, s.x / 2 / Math.max(0.5, this.camera.aspect), 0.25);
    const d = (half * 1.25) / Math.tan((this.camera.fov * Math.PI) / 360) + s.z / 2;
    this.controls.target.copy(c);
    this.camera.position.set(c.x, c.y + s.y * 0.05, c.z + d);
    this.controls.update();
  }

  // ---------------------------------------------------------------- animation
  play(slot, clip) {
    const root = this.get(slot);
    if (!root || !clip) return;
    this.stop(slot);
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    this.mixers.set(slot, { mixer, action, clip, root });
    this.duration = Math.max(...[...this.mixers.values()].map((m) => m.clip.duration), 0);
    this.setTime(0);
  }

  stop(slot) {
    const m = this.mixers.get(slot);
    if (!m) return;
    m.mixer.stopAllAction();
    m.mixer.uncacheRoot(m.root);
    this.mixers.delete(slot);
    // restore the rest pose
    m.root.traverse((o) => {
      const r = m.root.userData.restLocal?.[o.name];
      if (o.isBone && r) { o.quaternion.copy(r.q); o.position.copy(r.p); }
    });
    m.root.traverse((o) => { if (o.isMesh && o.morphTargetInfluences) o.morphTargetInfluences.fill(0); });
  }

  setTime(t) {
    this.time = Math.max(0, Math.min(this.duration, t));
    for (const m of this.mixers.values()) m.mixer.setTime(Math.min(this.time, m.clip.duration));
    if (this.audio && !this.playing) this.audio.currentTime = this.time;
    this.onTime?.(this.time);
  }

  setPlaying(p) {
    this.playing = p;
    if (this.audio) { if (p) { this.audio.currentTime = this.time; this.audio.play().catch(() => {}); } else this.audio.pause(); }
  }

  tick() {
    const dt = this.clock.getDelta();
    if (this.playing && this.mixers.size) {
      let t = this.audio && !this.audio.paused ? this.audio.currentTime : this.time + dt;
      if (t > this.duration) {
        if (this.loop) { t = 0; if (this.audio) this.audio.currentTime = 0; } else { t = this.duration; this.setPlaying(false); }
      }
      this.setTime(t);
    }
    const v = this.get('vroid');
    if (v && this.ikEnabled && v.userData.ik) solveModelIK(v);
    this.renderer.render(this.scene, this.camera);
  }

  /** Square PNG snapshot (custom item thumbnails). */
  async snapshot(size = 512) {
    const old = this.renderer.getSize(new THREE.Vector2());
    const oldAspect = this.camera.aspect;
    const helpersVisible = this.helpers.visible, gridVisible = this.grid.visible;
    this.helpers.visible = false; this.grid.visible = false; this.axes.visible = false;
    const bg = this.scene.background;
    this.scene.background = new THREE.Color(0xf5f5f5);
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1; this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const blob = await new Promise((r) => this.renderer.domElement.toBlob(r, 'image/png'));
    this.scene.background = bg;
    this.helpers.visible = helpersVisible; this.grid.visible = gridVisible; this.axes.visible = true;
    this.renderer.setSize(old.x, old.y);
    this.camera.aspect = oldAspect; this.camera.updateProjectionMatrix();
    return new Uint8Array(await blob.arrayBuffer());
  }
}
