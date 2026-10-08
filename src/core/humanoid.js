// Humanoid bone detection for arbitrary bipedal rigs (Mixamo, Unity, Unreal, VRoid/VRM,
// MMD (Japanese names), Valve Biped, Blender/Rigify, Tower Unite, generic, or unnamed).
// Name matching is tried first; skeleton topology fills in anything names cannot resolve.
import * as THREE from 'three';
import { HUMANOID_NAMES, HUMANOID_PARENT, HUMANOID_FROM_VROID } from './vroidSkeleton.js';

const IGNORED_TOKENS = new Set(['j', 'bip', 'bip01', 'bip001', 'bip002', 'c', 'mixamorig', 'valvebiped', 'valve', 'biped', 'def', 'org', 'mch', 'cc', 'base', 'rig',
  'bn', 'b', 'jnt', 'joint', 'bone', 'skel', 'skeleton', 'armature', 'character', 'ue', 'sk', 'dt', 'deform', 'drv']);
const LEFT = new Set(['l', 'left', 'lft', 'lf']);
const RIGHT = new Set(['r', 'right', 'rgt', 'rt']);
const EXCLUDE = /(twist|roll|helper|\bik\b|^ik|ik$|pole|target|\bend\b|_end|nub|tip|dummy|null|ctrl|control|offset|socket|attach|weapon|prop|capsule|collider|reference|\bsec\b|hair|skirt|bust|breast|cloth|tail|wing|ear|tongue|teeth|brow|lid|lash|cheek|lip|mouth|捩|ＩＫ|ik先|親|操作|ダミー|先$)/i;

const PART_PATTERNS = [
  ['eye', /^(faceeye|eye|eyeball|eyes|目)$/],
  ['jaw', /^(jaw|chin|顎|あご)$/],
  ['head', /^(head|頭)$/],
  ['neck', /^(neck\d*|首)$/],
  ['upperChest', /^(upperchest|chestupper|上半身3)$/],
  ['chest', /^(chest|上半身2|ribcage|thorax)$/],
  ['spine', /^(spine\d*|abdomen|上半身|waist|torso|spinelower|lowerspine)$/],
  ['hips', /^(hips?|pelvis|下半身|cog|roothips)$/],
  ['shoulder', /^(shoulder|clavicle|collar|collarbone|肩)$/],
  ['lowerArm', /^(forearm|lowerarm|elbow|ひじ|lowarm|armlower|forearmroot)$/],
  ['upperArm', /^(upperarm|uparm|arm|bicep|腕|armupper)$/],
  ['hand', /^(hand|wrist|手首|手)$/],
  ['foot', /^(foot|ankle|足首)$/],
  ['toes', /^(toe|toes|toebase|ball|toe0|toe1|つま先|toebase1)$/],
  ['lowerLeg', /^(leg|lowerleg|calf|shin|knee|ひざ|lowleg|leglower)$/],
  ['upperLeg', /^(upleg|upperleg|thigh|足|legupper|hip)$/],
];
const FINGER_PATTERN = /^(?:hand|finger|f)?(thumb|index|middle|ring|pinky|little|親指|人指|人差指|中指|薬指|小指)(?:finger)?([0-9０-９]*|metacarpal|proximal|intermediate|distal|meta|prox|inter|dist)?$/;
const FINGER_KIND = { thumb: 'Thumb', 親指: 'Thumb', index: 'Index', 人指: 'Index', 人差指: 'Index', middle: 'Middle', 中指: 'Middle', ring: 'Ring', 薬指: 'Ring', pinky: 'Little', little: 'Little', 小指: 'Little' };

/** Parse a bone name into {side, part, finger}. */
export function parseBoneName(name) {
  const vroid = HUMANOID_FROM_VROID[name];
  if (vroid) return { side: null, part: null, humanoid: vroid };
  let n = String(name).split(/[:|]/).pop();
  let side = null;
  if (/^左|左$/.test(n) || n.startsWith('左')) { side = 'left'; n = n.replace('左', ''); }
  else if (n.startsWith('右') || /右$/.test(n)) { side = 'right'; n = n.replace('右', ''); }
  n = n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  let tokens = n.toLowerCase().split(/[\s._\-]+/).filter(Boolean);
  const raw = tokens.join(' ');
  if (EXCLUDE.test(raw) && !/faceeye/.test(raw.replace(/\s/g, ''))) return { side, part: null, excluded: true };
  tokens = tokens.filter((t) => {
    if (!side && LEFT.has(t)) { side = 'left'; return false; }
    if (!side && RIGHT.has(t)) { side = 'right'; return false; }
    return !IGNORED_TOKENS.has(t);
  });
  // "lthigh" / "rarm" style prefixes (Valve/3ds Max without separators)
  let compact = tokens.join('').replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!side && /^(l|r)(upperarm|forearm|hand|thigh|calf|foot|clavicle|toe|shoulder|arm|leg)/.test(compact)) {
    side = compact[0] === 'l' ? 'left' : 'right';
    compact = compact.slice(1);
  }
  if (compact.startsWith('adj')) compact = compact.slice(3);
  const finger = compact.match(FINGER_PATTERN);
  if (finger) return { side, part: 'finger', finger: FINGER_KIND[finger[1]], fingerIndex: finger[2] ?? '' };
  for (const [part, re] of PART_PATTERNS) if (re.test(compact)) return { side, part };
  return { side, part: null };
}

function collectBones(root) {
  const bones = [];
  root.traverse((o) => { if (o.isBone) bones.push(o); });
  if (bones.length) return bones;
  // Animation-only files may use plain nodes
  root.traverse((o) => { if (o !== root && !o.isMesh && !o.isCamera && !o.isLight) bones.push(o); });
  return bones;
}

function worldPos(o) { return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); }
function isAncestor(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }
function depth(o) { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; }
function pathBetween(ancestor, descendant) {
  const out = [];
  for (let p = descendant.parent; p && p !== ancestor; p = p.parent) out.unshift(p);
  return isAncestor(ancestor, descendant) ? out : [];
}
function lca(a, b) {
  const set = new Set();
  for (let p = a; p; p = p.parent) set.add(p);
  for (let p = b; p; p = p.parent) if (set.has(p)) return p;
  return null;
}

/**
 * Detect the humanoid skeleton of a model or animation rig.
 * @param {THREE.Object3D} root
 * @returns {{bones: Record<string, THREE.Object3D>, facing: number, height: number, unmapped: THREE.Object3D[], method: Record<string,string>}}
 */
export function detectHumanoid(root) {
  root.updateMatrixWorld(true);
  const all = collectBones(root);
  const boneSet = new Set(all);
  const pos = new Map(all.map((b) => [b, worldPos(b)]));
  const box = new THREE.Box3();
  for (const p of pos.values()) box.expandByPoint(p);
  const height = Math.max(1e-6, box.max.y - box.min.y);
  const map = {};
  const method = {};
  const set = (k, b, how) => { if (b && !map[k]) { map[k] = b; method[k] = how; } };
  const childrenOf = (b) => b.children.filter((c) => boneSet.has(c));
  const descendants = (b) => { const out = []; b.traverse((o) => { if (o !== b && boneSet.has(o)) out.push(o); }); return out; };

  // ---- 1. names
  const parsed = new Map(all.map((b) => [b, parseBoneName(b.name)]));
  const byKey = {};
  const fingers = { left: {}, right: {} };
  for (const b of all) {
    const p = parsed.get(b);
    if (p.humanoid) { (byKey[p.humanoid] ??= []).push(b); continue; }
    if (!p.part) continue;
    if (p.part === 'finger') {
      if (!p.side) continue;
      (fingers[p.side][p.finger] ??= []).push(b);
      continue;
    }
    const sided = ['eye', 'shoulder', 'upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'toes'].includes(p.part);
    if (sided && !p.side) continue;
    const key = sided ? `${p.side}${p.part[0].toUpperCase()}${p.part.slice(1)}` : p.part;
    (byKey[key] ??= []).push(b);
  }
  // Prefer the shallowest candidate that has descendants (deform bone, not a helper)
  for (const key of Object.keys(byKey)) {
    const c = byKey[key].sort((a, b) => depth(a) - depth(b));
    if (key === 'hips') {
      // the hips must be an ancestor of the legs if those were named
      const legs = [...(byKey.leftUpperLeg ?? []), ...(byKey.rightUpperLeg ?? [])];
      const good = c.filter((h) => legs.length === 0 || legs.some((l) => isAncestor(h, l)));
      set(key, (good.length ? good : c).slice(-1)[0] ?? c[0], 'name');
    } else {
      set(key, c.find((b) => childrenOf(b).length > 0 || /eye|toes/i.test(key)) ?? c[0], 'name');
    }
  }

  // ---- 2. topology for hips / legs if missing
  const leaves = all.filter((b) => childrenOf(b).length === 0);
  if (!map.hips) {
    // lowest common ancestor of the lowest leaves on each side
    const low = leaves.filter((l) => pos.get(l).y < box.min.y + height * 0.25);
    const leftLow = low.filter((l) => pos.get(l).x > 0).sort((a, b) => pos.get(a).y - pos.get(b).y)[0];
    const rightLow = low.filter((l) => pos.get(l).x < 0).sort((a, b) => pos.get(a).y - pos.get(b).y)[0];
    if (leftLow && rightLow) {
      let h = lca(leftLow, rightLow);
      while (h && !boneSet.has(h)) h = null;
      set('hips', h, 'topology');
    }
  }
  const hips = map.hips;
  if (hips) {
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? 1 : -1;
      const S = (n) => `${side}${n}`;
      if (!map[S('UpperLeg')]) {
        const hp = pos.get(hips);
        const cand = childrenOf(hips).map((c) => {
          // follow to a descendant leaf that is low
          const low = descendants(c).concat([c]).filter((d) => pos.get(d).y < hp.y - height * 0.3);
          return { c, low };
        }).filter((x) => x.low.length && Math.sign(pos.get(x.low[0]).x) === sign);
        if (cand.length) {
          let c = cand[0].c;
          // skip short connector bones that sit near the hips
          while (childrenOf(c).length === 1 && pos.get(c).distanceTo(hp) < height * 0.03) c = childrenOf(c)[0];
          set(S('UpperLeg'), c, 'topology');
        }
      }
      const ul = map[S('UpperLeg')];
      if (ul) {
        const chain = longestDownChain(ul, childrenOf, pos);
        const ankleY = box.min.y + height * 0.1;
        if (!map[S('Foot')]) set(S('Foot'), chain.slice(1).find((b) => pos.get(b).y <= ankleY) ?? chain[Math.max(1, chain.length - 2)], 'topology');
        const foot = map[S('Foot')];
        if (!map[S('LowerLeg')] && foot) {
          const between = pathBetween(ul, foot);
          if (between.length) {
            const mid = (pos.get(ul).y + pos.get(foot).y) / 2;
            set(S('LowerLeg'), between.sort((a, b) => Math.abs(pos.get(a).y - mid) - Math.abs(pos.get(b).y - mid))[0], 'topology');
          }
        }
        if (!map[S('Toes')] && foot) {
          const toe = childrenOf(foot).find((c) => childrenOf(c).length > 0 || pos.get(c).z > pos.get(foot).z) ?? childrenOf(foot)[0];
          if (toe && childrenOf(toe).length >= 0 && toe !== foot) set(S('Toes'), toe, 'topology');
        }
      }
    }
  }

  // ---- 3. head / neck / spine
  if (!map.head) {
    const top = leaves.concat(all).filter((b) => !hips || isAncestor(lca(b, hips) ?? b, b)).sort((a, b) => pos.get(b).y - pos.get(a).y)[0];
    // head: the highest bone on the upward chain with a meaningful length, or parent of the top leaf
    if (top) {
      let h = top;
      while (h.parent && boneSet.has(h.parent) && childrenOf(h.parent).length === 1 && pos.get(h).y - pos.get(h.parent).y < height * 0.06) h = h.parent;
      if (childrenOf(h).length === 0 && h.parent && boneSet.has(h.parent)) h = h.parent;
      set('head', h, 'topology');
    }
  }
  if (map.head && hips && !map.neck) {
    const base = lca(map.head, hips);
    const path = pathBetween(base, map.head);
    if (path.length) set('neck', path[path.length - 1], 'chain');
  }
  if (map.head && hips && map.neck) {
    // The spine chain is resolved from the hierarchy path hips -> neck (names like Spine1/Spine2
    // or spine_01..05 are ambiguous between conventions). Exact VRoid names always win.
    const base = isAncestor(hips, map.neck) ? hips : lca(hips, map.neck);
    let path = pathBetween(base, map.neck);
    if (base !== hips && boneSet.has(base) && !isAncestor(base, hips)) path.unshift(base);
    path = path.filter((b) => b !== hips && boneSet.has(b) && !isAncestor(b, hips));
    const exact = (k) => map[k] && parsed.get(map[k]).humanoid === k;
    for (const k of ['spine', 'chest', 'upperChest']) if (!exact(k)) { delete map[k]; delete method[k]; }
    const free = path.filter((b) => !['spine', 'chest', 'upperChest'].some((k) => map[k] === b));
    if (!map.spine && free.length) set('spine', free.shift(), 'chain');
    if (!map.upperChest && !map.chest && free.length >= 2) { set('upperChest', free.pop(), 'chain'); set('chest', free[Math.floor((free.length - 1) / 2)], 'chain'); }
    else if (!map.chest && free.length) set('chest', free[free.length - 1], 'chain');
  }

  // ---- 4. arms
  const torsoTop = map.upperChest ?? map.chest ?? map.spine ?? hips;
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    const S = (n) => `${side}${n}`;
    if (!map[S('Hand')] && torsoTop) {
      // farthest lateral bone below the head and above the hips that has several children (fingers) or is an extreme leaf
      const tp = pos.get(torsoTop);
      const lateral = all.filter((b) => Math.sign(pos.get(b).x) === sign && Math.abs(pos.get(b).x) > height * 0.15
        && pos.get(b).y > (hips ? pos.get(hips).y - height * 0.2 : box.min.y + height * 0.4)
        && (!map.head || !isAncestor(map.head, b)) && isAncestor(lca(b, torsoTop) ?? b, b));
      const withFingers = lateral.filter((b) => childrenOf(b).length >= 3);
      const hand = (withFingers.length ? withFingers : lateral).sort((a, b) => depth(a) - depth(b))[0];
      if (hand && tp) set(S('Hand'), hand, 'topology');
    }
    const hand = map[S('Hand')];
    if (hand) {
      const base = torsoTop && isAncestor(torsoTop, hand) ? torsoTop : lca(hand, map.neck ?? map.head ?? hand);
      let path = pathBetween(base, hand).filter((b) => b !== map.neck && b !== map.head);
      // Unused spine bones between the mapped chest and the arm chain are not part of the arm
      path = path.filter((b) => Math.abs(pos.get(b).x) > 1e-4 || b === map[S('Shoulder')]);
      if (!map[S('UpperArm')] || !map[S('LowerArm')]) {
        if (map[S('LowerArm')] && !map[S('UpperArm')]) {
          const p = pathBetween(base, map[S('LowerArm')]).filter((b) => Math.abs(pos.get(b).x) > 1e-4);
          set(S('UpperArm'), p[p.length - 1], 'chain');
        } else if (path.length >= 3) {
          set(S('Shoulder'), path[0], 'chain');
          set(S('UpperArm'), path[1], 'chain');
          set(S('LowerArm'), closestTo(path.slice(2), pos, midpoint(pos.get(path[1]), pos.get(hand))) ?? path[path.length - 1], 'chain');
        } else if (path.length === 2) {
          set(S('UpperArm'), path[0], 'chain');
          set(S('LowerArm'), path[1], 'chain');
        }
      }
      if (!map[S('Shoulder')] && map[S('UpperArm')]) {
        const p = pathBetween(base, map[S('UpperArm')]).filter((b) => Math.abs(pos.get(b).x) > 1e-4);
        if (p.length) set(S('Shoulder'), p[p.length - 1], 'chain');
      }
      // fingers
      const named = fingers[side];
      const kids = childrenOf(hand);
      for (const kind of ['Thumb', 'Index', 'Middle', 'Ring', 'Little']) {
        let chain = (named[kind] ?? []).filter((b) => isAncestor(hand, b)).sort((a, b) => depth(a) - depth(b));
        if (!chain.length) continue;
        chain = chain.filter((b, i) => i === 0 || isAncestor(chain[0], b));
        const names = kind === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
        // drop end/nub bones without children if we have more than 3
        if (chain.length > 3) chain = chain.filter((b, i) => i < 3 || childrenOf(b).length > 0).slice(0, 3);
        chain.slice(0, 3).forEach((b, i) => set(S(kind + names[i]), b, 'name'));
      }
      if (!map[S('IndexProximal')] && kids.length >= 4) {
        // Unnamed fingers: sort by z (forward = thumb/index side) at the hand
        const ordered = kids.filter((k) => descendants(k).length >= 1).sort((a, b) => pos.get(b).z - pos.get(a).z);
        const thumb = ordered.sort((a, b) => pos.get(a).distanceTo(pos.get(hand)) - pos.get(b).distanceTo(pos.get(hand)))[0];
        const rest = ordered.filter((k) => k !== thumb).sort((a, b) => pos.get(b).z - pos.get(a).z);
        const assign = (kind, start) => {
          const names = kind === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal'];
          let b = start;
          for (let i = 0; i < 3 && b; i++) { set(S(kind + names[i]), b, 'topology'); b = childrenOf(b)[0]; }
        };
        if (thumb) assign('Thumb', thumb);
        ['Index', 'Middle', 'Ring', 'Little'].forEach((k, i) => rest[i] && assign(k, rest[i]));
      }
    }
  }

  // ---- 5. eyes from head children
  if (map.head) {
    for (const side of ['left', 'right']) {
      const key = `${side}Eye`;
      if (map[key]) continue;
      const sign = side === 'left' ? 1 : -1;
      const c = descendants(map.head).filter((b) => /eye|目/i.test(b.name) && Math.sign(pos.get(b).x) === sign && !/brow|lid|lash/i.test(b.name));
      if (c.length) set(key, c.sort((a, b) => depth(a) - depth(b))[0], 'name');
    }
  }

  // Facing: VRoid/VRM convention puts the character's left at +X. If named-left bones sit at -X, the model faces -Z.
  let facing = 1;
  const lu = map.leftUpperArm ?? map.leftUpperLeg, ru = map.rightUpperArm ?? map.rightUpperLeg;
  if (lu && ru && pos.get(lu).x < pos.get(ru).x) facing = -1;

  const bones = {};
  for (const k of HUMANOID_NAMES) if (map[k]) bones[k] = map[k];
  const mappedSet = new Set(Object.values(bones));
  return { bones, facing, height, method, unmapped: all.filter((b) => !mappedSet.has(b)) };
}

function longestDownChain(start, childrenOf, pos) {
  let best = [start];
  const walk = (b, acc) => {
    const kids = childrenOf(b);
    if (!kids.length) { if (acc.length > best.length || pos.get(acc[acc.length - 1]).y < pos.get(best[best.length - 1]).y) best = acc; return; }
    for (const k of kids) walk(k, [...acc, k]);
  };
  walk(start, [start]);
  return best;
}
function midpoint(a, b) { return a.clone().add(b).multiplyScalar(0.5); }
function closestTo(list, pos, p) {
  return list.slice().sort((a, b) => pos.get(a).distanceTo(p) - pos.get(b).distanceTo(p))[0];
}

/** Validate a humanoid map: returns missing required bones and sanity warnings. */
export function validateHumanoid(h) {
  const missing = ['hips', 'spine', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'].filter((k) => !h.bones[k]);
  const warnings = [];
  for (const [k, b] of Object.entries(h.bones)) {
    const p = HUMANOID_PARENT[k];
    if (p && h.bones[p] && !isAncestor(h.bones[p], b)) warnings.push(`${k} (${b.name}) is not below ${p} (${h.bones[p].name}); it will be re-parented.`);
  }
  return { missing, warnings, ok: missing.length === 0 };
}
