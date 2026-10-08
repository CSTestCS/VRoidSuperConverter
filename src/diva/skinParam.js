// Project DIVA external skin parameter files (ext_skp_*.txt): osage physics parameters.
// Text "parameter tree" format: dotted.key=value lines, lists carry a ".length" entry.

export function parseParameterTree(text) {
  const map = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

function num(map, key, def = 0) {
  const v = map.get(key);
  if (v == null) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function list(map, prefix, fn) {
  const len = parseInt(map.get(`${prefix}.length`) ?? '0', 10) || 0;
  const out = [];
  for (let i = 0; i < len; i++) out.push(fn(`${prefix}.${i}`));
  return out;
}

/** @returns {Map<string, object>} skin parameters keyed by osage external name */
export function readSkinParams(text) {
  const map = parseParameterTree(text);
  const names = new Set();
  for (const key of map.keys()) names.add(key.split('.')[0]);
  const out = new Map();
  for (const name of names) {
    const r = `${name}.root`;
    out.set(name, {
      name,
      force: num(map, `${r}.force`), forceGain: num(map, `${r}.force_gain`), airResistance: num(map, `${r}.air_res`),
      rotationY: num(map, `${r}.rot_y`), rotationZ: num(map, `${r}.rot_z`), friction: num(map, `${r}.friction`),
      windAffection: num(map, `${r}.wind_afc`), collisionType: num(map, `${r}.coli_type`),
      initRotationY: num(map, `${r}.init_rot_y`), initRotationZ: num(map, `${r}.init_rot_z`),
      hingeY: num(map, `${r}.hinge_y`, 90), hingeZ: num(map, `${r}.hinge_z`, 90),
      collisionRadius: num(map, `${r}.coli_r`), stiffness: num(map, `${r}.stiffness`), moveCancel: num(map, `${r}.move_cancel`),
      collisionTargetOsage: map.get(`${r}.colli_tgt_osg`) ?? null,
      collisions: list(map, `${r}.coli`, (p) => ({
        type: num(map, `${p}.type`), radius: num(map, `${p}.radius`),
        bone0: { name: map.get(`${p}.bone.0.name`) ?? '', position: [num(map, `${p}.bone.0.posx`), num(map, `${p}.bone.0.posy`), num(map, `${p}.bone.0.posz`)] },
        bone1: { name: map.get(`${p}.bone.1.name`) ?? '', position: [num(map, `${p}.bone.1.posx`), num(map, `${p}.bone.1.posy`), num(map, `${p}.bone.1.posz`)] },
      })),
      bocs: list(map, `${r}.boc`, (p) => ({ stNode: num(map, `${p}.st_node`), edNode: num(map, `${p}.ed_node`), edRoot: map.get(`${p}.ed_root`) ?? '' })),
      nodes: list(map, `${name}.node`, (p) => ({
        hingeYMin: num(map, `${p}.hinge_ymin`, -180), hingeYMax: num(map, `${p}.hinge_ymax`, 180),
        hingeZMin: num(map, `${p}.hinge_zmin`, -180), hingeZMax: num(map, `${p}.hinge_zmax`, 180),
        radius: num(map, `${p}.coli_r`), weight: num(map, `${p}.weight`, 1), inertialCancel: num(map, `${p}.inertial_cancel`),
      })),
    });
  }
  return out;
}

function fmt(v) {
  if (typeof v === 'string') return v;
  if (Number.isInteger(v)) return String(v);
  const s = String(Number(Math.fround(v).toPrecision(7)));
  return s.replace(/e([+-])(\d+)$/, (_, sign, d) => `E${sign}${d.padStart(2, '0')}`);
}

/** Serialise parameters (iterable of objects as returned by readSkinParams). */
export function writeSkinParams(params) {
  const lines = [];
  const put = (k, v) => lines.push(`${k}=${fmt(v)}\n`);
  for (const p of params) {
    const r = `${p.name}.root`;
    put(`${r}.force`, p.force); put(`${r}.force_gain`, p.forceGain); put(`${r}.air_res`, p.airResistance);
    put(`${r}.rot_y`, p.rotationY); put(`${r}.rot_z`, p.rotationZ); put(`${r}.friction`, p.friction);
    put(`${r}.wind_afc`, p.windAffection); put(`${r}.coli_type`, Math.round(p.collisionType ?? 0));
    put(`${r}.init_rot_y`, p.initRotationY ?? 0); put(`${r}.init_rot_z`, p.initRotationZ ?? 0);
    put(`${r}.hinge_y`, p.hingeY ?? 90); put(`${r}.hinge_z`, p.hingeZ ?? 90);
    put(`${r}.coli_r`, p.collisionRadius ?? 0); put(`${r}.stiffness`, p.stiffness ?? 0); put(`${r}.move_cancel`, p.moveCancel ?? 0);
    if (p.collisionTargetOsage) put(`${r}.colli_tgt_osg`, p.collisionTargetOsage);
    (p.collisions ?? []).forEach((c, i) => {
      const k = `${r}.coli.${i}`;
      put(`${k}.type`, Math.round(c.type)); put(`${k}.radius`, c.radius);
      [c.bone0, c.bone1].forEach((b, j) => {
        put(`${k}.bone.${j}.name`, b.name ?? '');
        put(`${k}.bone.${j}.posx`, b.position[0]); put(`${k}.bone.${j}.posy`, b.position[1]); put(`${k}.bone.${j}.posz`, b.position[2]);
      });
    });
    put(`${r}.coli.length`, (p.collisions ?? []).length);
    (p.bocs ?? []).forEach((b, i) => {
      put(`${r}.boc.${i}.st_node`, b.stNode); put(`${r}.boc.${i}.ed_node`, b.edNode); put(`${r}.boc.${i}.ed_root`, b.edRoot);
    });
    put(`${r}.boc.length`, (p.bocs ?? []).length);
    (p.nodes ?? []).forEach((n, i) => {
      const k = `${p.name}.node.${i}`;
      put(`${k}.hinge_ymin`, n.hingeYMin); put(`${k}.hinge_ymax`, n.hingeYMax);
      put(`${k}.hinge_zmin`, n.hingeZMin); put(`${k}.hinge_zmax`, n.hingeZMax);
      put(`${k}.coli_r`, n.radius); put(`${k}.inertial_cancel`, n.inertialCancel); put(`${k}.weight`, n.weight);
    });
    put(`${p.name}.node.length`, (p.nodes ?? []).length);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '# This file was generated automatically. DO NOT EDIT.\n' + lines.join('');
}

/** Build a skin parameter for an osage block that has none, using its internal parameter if present. */
export function skinParamFromOsageBlock(block, defaults = {}) {
  const ip = block.internalSkinParam;
  const d = { force: 0.05, forceGain: 0.4, airResistance: 0.5, friction: 1, windAffection: 0.5, hinge: 90, radius: 0.03, ...defaults };
  return {
    name: block.externalName,
    force: ip?.force ?? d.force, forceGain: ip?.forceGain ?? d.forceGain, airResistance: ip?.airResistance ?? d.airResistance,
    rotationY: ip?.rotationY ?? 0, rotationZ: ip?.rotationZ ?? 0, friction: ip?.friction ?? d.friction,
    windAffection: ip?.windAffection ?? d.windAffection, collisionType: 0, initRotationY: 0, initRotationZ: 0,
    hingeY: ip?.hingeY ?? d.hinge, hingeZ: ip?.hingeZ ?? d.hinge, collisionRadius: ip?.collisionRadius ?? d.radius,
    stiffness: 0, moveCancel: 0, collisionTargetOsage: null, collisions: [], bocs: [],
    nodes: block.nodes.map(() => ({
      hingeYMin: -(ip?.hingeY ?? d.hinge), hingeYMax: ip?.hingeY ?? d.hinge,
      hingeZMin: -(ip?.hingeZ ?? d.hinge), hingeZMax: ip?.hingeZ ?? d.hinge,
      radius: ip?.collisionRadius ?? d.radius, weight: 1, inertialCancel: 0,
    })),
  };
}
