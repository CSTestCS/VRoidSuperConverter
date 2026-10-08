// VRoid Studio custom items (.vroidcustomitem).
//
// A custom item is a ZIP archive:
//   meta.json                                   package metadata
//   thumbnails/thumbnail.png                    512x512 preview shown in VRoid Studio
//   v1customitem/meta.json                      item metadata (rootTransferableGroupTypeId = category)
//   v1customitem/basetransferable.basetransferable   shared materials / textures / image blobs (protobuf)
//   v1customitem/transferablegroups/*.transferablegroup  root group: category + edit type + refs (protobuf)
//   v1customitem/transferables/*.transferable   item payload (protobuf)
// The protobuf schema is not public. This module only performs schema-agnostic edits that are
// known to be safe: category rewrite within the same family, image/thumbnail replacement,
// renaming, and regenerating the item IDs. Layout knowledge from CustomItemForge (MIT).
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const CATEGORIES = [
  { key: 'all-hair', label: 'Overall hair', suffix: 'AllHair', family: 'hair' },
  { key: 'base-hair', label: 'Base hair', suffix: 'BaseHair', family: 'hair' },
  { key: 'hair-front', label: 'Front hair', suffix: 'HairFront', family: 'hair' },
  { key: 'hair-back', label: 'Back hair', suffix: 'HairBack', family: 'hair' },
  { key: 'hair-side', label: 'Sideburns', suffix: 'HairSideburns', family: 'hair' },
  { key: 'hair-tied', label: 'Extensions', suffix: 'HairTied', family: 'hair' },
  { key: 'hair-ahoge', label: 'Ahoge', suffix: 'HairAhoge', family: 'hair' },
  { key: 'hair-extra', label: 'Extra hair', suffix: 'HairHanege', family: 'hair' },
  { key: 'tops', label: 'Tops', suffix: 'Tops', family: 'clothing' },
  { key: 'bottoms', label: 'Bottoms', suffix: 'Bottoms', family: 'clothing' },
  { key: 'onepiece', label: 'Dresses / one-piece', suffix: 'Onepiece', family: 'clothing' },
  { key: 'shoes', label: 'Shoes', suffix: 'Shoes', family: 'clothing' },
  { key: 'socks', label: 'Socks', suffix: 'Socks', family: 'clothing' },
  { key: 'neck-accessory', label: 'Neck accessory', suffix: 'NeckAccessory', family: 'accessory' },
  { key: 'arm-accessory', label: 'Arm accessory', suffix: 'ArmAccessory', family: 'accessory' },
  { key: 'leg-accessory', label: 'Leg accessory', suffix: 'LegAccessory', family: 'accessory' },
  { key: 'glasses', label: 'Glasses', suffix: 'Glasses', family: 'accessory' },
].map((c) => ({ ...c, groupTypeId: `TransferableGroupType.N00.Level1.${c.suffix}`, transferableType: `TransferableType.N00.${c.suffix}` }));

export const categoryByGroupId = (id) => CATEGORIES.find((c) => c.groupTypeId === id) ?? null;
export const categoryByKey = (k) => CATEGORIES.find((c) => c.key === k || c.suffix === k) ?? null;

const META = 'v1customitem/meta.json';
const ROOT_META = 'meta.json';
const THUMB = 'thumbnails/thumbnail.png';
const HEX32 = /^[0-9a-f]{32}$/;

// ------------------------------------------------------------------ protobuf wire helpers
function readVarint(b, o) {
  let v = 0, shift = 0;
  for (let i = o; i < Math.min(b.length, o + 10); i++) {
    v += (b[i] & 0x7f) * 2 ** shift;
    if (!(b[i] & 0x80)) return [v, i + 1];
    shift += 7;
  }
  throw new Error('bad varint');
}
function varint(v) {
  const out = [];
  while (v > 0x7f) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return Uint8Array.from(out);
}
function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Parse one protobuf message level. Throws if the bytes are not a well-formed message. */
export function parseFields(b) {
  const fields = [];
  let o = 0;
  while (o < b.length) {
    const start = o;
    let key;
    [key, o] = readVarint(b, o);
    const number = Math.floor(key / 8), wire = key & 7;
    if (number === 0 || number > 536870911) throw new Error('bad field');
    let value;
    if (wire === 0) [value, o] = readVarint(b, o);
    else if (wire === 1) { value = b.subarray(o, o + 8); o += 8; }
    else if (wire === 2) { let len; [len, o] = readVarint(b, o); if (o + len > b.length) throw new Error('truncated'); value = b.subarray(o, o + len); o += len; }
    else if (wire === 5) { value = b.subarray(o, o + 4); o += 4; }
    else throw new Error('unsupported wire type');
    if (o > b.length) throw new Error('truncated');
    fields.push({ number, wire, value, raw: b.subarray(start, o) });
  }
  return fields;
}

const textOf = (f) => {
  if (f.wire !== 2) return null;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(f.value);
    return s && !/[\u0000-\u0008\u000e-\u001f]/.test(s) ? s : null;
  } catch { return null; }
};
const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

function encodeField(number, wire, value) {
  const key = varint(number * 8 + wire);
  if (wire === 2) return concat([key, varint(value.length), value]);
  return concat([key, value instanceof Uint8Array ? value : varint(value)]);
}

/** Find embedded images (PNG/JPEG) at any nesting depth. Returns their field paths. */
export function findImages(bytes, path = [], depth = 0, out = []) {
  let fields;
  try { fields = parseFields(bytes); } catch { return out; }
  fields.forEach((f, i) => {
    if (f.wire !== 2) return;
    if (isPng(f.value) || isJpg(f.value)) { out.push({ path: [...path, i], size: f.value.length, type: isPng(f.value) ? 'png' : 'jpg', bytes: f.value }); return; }
    if (depth < 10 && f.value.length > 2 && textOf(f) === null) findImages(f.value, [...path, i], depth + 1, out);
  });
  return out;
}

/** Replace the value of the field at `path` (indices into each level's field list). */
export function replaceAtPath(bytes, path, newValue) {
  const fields = parseFields(bytes);
  const [i, ...rest] = path;
  const f = fields[i];
  const value = rest.length ? replaceAtPath(f.value, rest, newValue) : newValue;
  return concat(fields.map((x, k) => (k === i ? encodeField(f.number, 2, value) : x.raw)));
}

function replaceTextField(bytes, number, value) {
  const fields = parseFields(bytes);
  const hits = fields.filter((f) => f.number === number && textOf(f) !== null);
  if (hits.length !== 1) throw new Error(`Expected one text field #${number}, found ${hits.length}`);
  return concat(fields.map((f) => (f === hits[0] ? encodeField(number, 2, new TextEncoder().encode(value)) : f.raw)));
}

// ------------------------------------------------------------------ archive model
export function readCustomItem(bytes) {
  const files = unzipSync(bytes);
  if (!files[META]) throw new Error('Not a .vroidcustomitem (missing v1customitem/meta.json)');
  const item = { files, order: Object.keys(files) };
  item.meta = JSON.parse(strFromU8(files[META]));
  item.rootMeta = files[ROOT_META] ? JSON.parse(strFromU8(files[ROOT_META])) : null;
  item.categoryId = item.meta.rootTransferableGroupTypeId ?? null;
  item.category = categoryByGroupId(item.categoryId);
  item.rootGroup = findRootGroup(item);
  item.images = listImages(item);
  item.thumbnail = files[THUMB] ?? null;
  return item;
}

function findRootGroup(item) {
  const groups = item.order.filter((n) => n.startsWith('v1customitem/transferablegroups/'));
  let best = null;
  for (const entry of groups) {
    let fields;
    try { fields = parseFields(item.files[entry]); } catch { continue; }
    const category = fields.filter((f) => f.number === 2).map(textOf).find(Boolean) ?? null;
    const editType = fields.filter((f) => f.number === 3).map(textOf).find(Boolean) ?? null;
    const refs = [];
    for (const f of fields.filter((x) => (x.number === 4 || x.number === 5) && x.wire === 2)) {
      try { const id = parseFields(f.value).filter((x) => x.number === 2).map(textOf).find(Boolean); if (id) refs.push(id); } catch { /* not a ref */ }
    }
    const score = (category === item.categoryId ? 10 : 0) + refs.length;
    if (!best || score > best.score) best = { entry, category, editType, refs, score };
  }
  if (best) {
    best.transferableEntry = item.order.find((n) => n.startsWith('v1customitem/transferables/') && best.refs.some((r) => n.includes(r))) ?? null;
  }
  return best;
}

function listImages(item) {
  const out = [];
  for (const entry of item.order) {
    if (!/\.(basetransferable|transferable|transferablegroup)$/.test(entry)) continue;
    for (const img of findImages(item.files[entry])) out.push({ entry, ...img, id: `${entry}#${img.path.join('.')}` });
  }
  return out;
}

/** Change the item category (same family only unless `force`). */
export function recategorize(item, categoryKey, { force = false } = {}) {
  const target = categoryByKey(categoryKey);
  if (!target) throw new Error(`Unknown category ${categoryKey}`);
  if (item.category && item.category.family !== target.family && !force) {
    throw new Error(`Cannot move a ${item.category.family} item to the ${target.family} family: their payloads use different schemas.`);
  }
  const rg = item.rootGroup;
  if (!rg) throw new Error('Root transferable group not found');
  item.files[rg.entry] = replaceTextField(item.files[rg.entry], 2, target.groupTypeId);
  if (rg.transferableEntry) item.files[rg.transferableEntry] = replaceTextField(item.files[rg.transferableEntry], 2, target.transferableType);
  item.meta.rootTransferableGroupTypeId = target.groupTypeId;
  item.files[META] = strToU8(JSON.stringify(item.meta));
  item.categoryId = target.groupTypeId;
  item.category = target;
  item.rootGroup = findRootGroup(item);
  return item;
}

/** Replace an embedded image (by id from item.images) with new PNG bytes. */
export function replaceImage(item, imageId, png) {
  const img = item.images.find((i) => i.id === imageId);
  if (!img) throw new Error('Image not found');
  item.files[img.entry] = replaceAtPath(item.files[img.entry], img.path, png);
  item.images = listImages(item);
  return item;
}

export function setThumbnail(item, png) { item.files[THUMB] = png; item.thumbnail = png; if (!item.order.includes(THUMB)) item.order.push(THUMB); }

/** Set the display name wherever the metadata carries one. */
export function setName(item, name) {
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (/^(name|displayName|title|itemName)$/i.test(k) && typeof obj[k] === 'string') obj[k] = name;
      else visit(obj[k]);
    }
  };
  visit(item.meta);
  item.files[META] = strToU8(JSON.stringify(item.meta));
  if (item.rootMeta) { visit(item.rootMeta); item.files[ROOT_META] = strToU8(JSON.stringify(item.rootMeta)); }
}

/**
 * Give the item fresh IDs so VRoid Studio treats it as a new item (it can then coexist with
 * the original). IDs are 32-hex strings; they are replaced byte-for-byte (same length), so no
 * protobuf length fields change.
 */
export function regenerateIds(item, random = () => Math.random()) {
  const ids = new Set();
  const collect = (v) => {
    if (typeof v === 'string' && HEX32.test(v)) ids.add(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(item.meta);
  for (const n of item.order) for (const m of n.matchAll(/[0-9a-f]{32}/g)) ids.add(m[0]);
  const map = new Map([...ids].map((id) => [id, Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')]));
  const enc = new TextEncoder();
  const replaceBytes = (b) => {
    let out = b;
    for (const [from, to] of map) {
      const f = enc.encode(from), t = enc.encode(to);
      for (let i = 0; i + 32 <= out.length; i++) {
        let match = true;
        for (let k = 0; k < 32; k++) if (out[i + k] !== f[k]) { match = false; break; }
        if (match) { if (out === b) out = b.slice(); out.set(t, i); i += 31; }
      }
    }
    return out;
  };
  const files = {};
  const order = [];
  for (const n of item.order) {
    let name = n;
    for (const [from, to] of map) name = name.split(from).join(to);
    files[name] = replaceBytes(item.files[n]);
    order.push(name);
  }
  item.files = files;
  item.order = order;
  return readCustomItem(writeCustomItem(item));
}

export function writeCustomItem(item) {
  const out = {};
  for (const n of item.order) out[n] = [item.files[n], { level: n.endsWith('.png') ? 0 : 6 }];
  return zipSync(out);
}

/** Summary for the UI. */
export function describeCustomItem(item) {
  return {
    category: item.category?.label ?? item.categoryId ?? 'unknown',
    family: item.category?.family ?? 'unknown',
    editType: item.rootGroup?.editType,
    entries: item.order.length,
    images: item.images.map((i) => ({ id: i.id, type: i.type, size: i.size })),
  };
}
