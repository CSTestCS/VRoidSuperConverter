// Little/big-endian binary reader and a writer with deferred ("scheduled") offset writes.
// The writer mirrors the layout semantics used by MikuMikuLibrary (MIT, Skyth) so that
// files produced here are laid out the way Project DIVA tooling expects.

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

export class BinReader {
  constructor(bytes, littleEndian = true) {
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.le = littleEndian;
    this.pos = 0;
    this.baseStack = [];
  }

  get base() { return this.baseStack.length ? this.baseStack[this.baseStack.length - 1] : 0; }
  get length() { return this.bytes.byteLength; }
  pushBase(at = this.pos) { this.baseStack.push(at); }
  popBase() { return this.baseStack.pop(); }
  seek(p) { this.pos = p; }
  skip(n) { this.pos += n; }

  u8() { return this.view.getUint8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos, this.le); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, this.le); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, this.le); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, this.le); this.pos += 4; return v; }
  f32() { const v = this.view.getFloat32(this.pos, this.le); this.pos += 4; return v; }
  offset() { return this.u32(); }
  vec(n) { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = this.f32(); return out; }
  f32s(count) { const out = new Float32Array(count); for (let i = 0; i < count; i++) out[i] = this.f32(); return out; }
  u16s(count) { const out = new Uint16Array(count); for (let i = 0; i < count; i++) out[i] = this.u16(); return out; }
  bytesN(n) { const out = this.bytes.slice(this.pos, this.pos + n); this.pos += n; return out; }

  cstr() {
    let end = this.pos;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    const s = textDecoder.decode(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  fixedStr(n) {
    const sub = this.bytes.subarray(this.pos, this.pos + n);
    let end = sub.indexOf(0);
    if (end < 0) end = n;
    this.pos += n;
    return textDecoder.decode(sub.subarray(0, end));
  }

  /** Read a string through an offset relative to the current base. 0 → null. */
  strOffset() {
    const off = this.offset();
    if (off === 0) return null;
    return this.at(off, () => this.cstr());
  }

  /** Jump to base+offset, run fn, come back. Offset 0 means "absent". */
  at(off, fn) {
    if (!off) return undefined;
    const saved = this.pos;
    this.pos = this.base + off;
    const r = fn();
    this.pos = saved;
    return r;
  }

  /** Read an offset field and immediately follow it. */
  readOffset(fn) { return this.at(this.offset(), fn); }
}

export class BinWriter {
  constructor(littleEndian = true) {
    this.le = littleEndian;
    this.buf = new Uint8Array(1 << 16);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
    this.len = 0;
    this.baseStack = [];
    this.scheduled = [];
    this.stringTables = [];
  }

  get base() { return this.baseStack.length ? this.baseStack[this.baseStack.length - 1] : 0; }
  pushBase(at = this.pos) { this.baseStack.push(at); }
  popBase() { return this.baseStack.pop(); }

  ensure(n) {
    const need = this.pos + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length;
    while (size < need) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  advance(n) { this.pos += n; if (this.pos > this.len) this.len = this.pos; }

  u8(v) { this.ensure(1); this.view.setUint8(this.pos, v & 0xff); this.advance(1); }
  u16(v) { this.ensure(2); this.view.setUint16(this.pos, v & 0xffff, this.le); this.advance(2); }
  i16(v) { this.ensure(2); this.view.setInt16(this.pos, v, this.le); this.advance(2); }
  u32(v) { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, this.le); this.advance(4); }
  i32(v) { this.ensure(4); this.view.setInt32(this.pos, v | 0, this.le); this.advance(4); }
  f32(v) { this.ensure(4); this.view.setFloat32(this.pos, v, this.le); this.advance(4); }
  vec(arr) { for (const v of arr) this.f32(v); }
  f32s(arr) { for (let i = 0; i < arr.length; i++) this.f32(arr[i]); }
  u16s(arr) { for (let i = 0; i < arr.length; i++) this.u16(arr[i]); }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.advance(b.length); }
  nulls(n) { this.ensure(n); this.buf.fill(0, this.pos, this.pos + n); this.advance(n); }
  cstr(s) { this.bytes(textEncoder.encode(s ?? '')); this.u8(0); }
  fixedStr(s, n) {
    const enc = textEncoder.encode(s ?? '');
    const out = new Uint8Array(n);
    out.set(enc.subarray(0, n - 1));
    this.bytes(out);
  }

  align(n, filler = 0) {
    if (!n || n <= 1) return;
    const diff = (n - (this.pos % n)) % n;
    this.ensure(diff);
    this.buf.fill(filler, this.pos, this.pos + diff);
    this.advance(diff);
  }

  patchU32(at, v) {
    const saved = this.pos;
    this.pos = at;
    this.u32(v);
    this.pos = saved;
  }

  /**
   * Reserve an offset field and schedule `fn` to be written later. When the
   * scheduled block is written, the field is patched with (blockStart - base).
   * @param {number} alignment
   * @param {'none'|'left'|'center'|'right'} mode
   * @param {() => void} fn
   * @param {{condition?: boolean, priority?: number, size?: boolean}} [opts]
   */
  offset(alignment, mode, fn, opts = {}) {
    const field = this.pos;
    this.u32(0);
    if (opts.size) this.u32(0);
    if (opts.condition === false) return;
    this.scheduled.push({
      field, alignment, mode, fn,
      priority: opts.priority ?? 0,
      base: this.base,
      size: !!opts.size,
      offsetMode: opts.offsetMode ?? (opts.size ? 'offsetAndSize' : 'offset'),
    });
  }

  /** Write an offset to a block that has already been written (absolute position). */
  rawOffset(absolute) { this.u32(absolute - this.base); }

  performScheduledWrites() {
    if (!this.scheduled.length) return;
    this._perform(0, this.scheduled.length - 1, 0);
    this.scheduled = [];
  }

  _perform(first, last, baseOffset) {
    let priority = 0;
    let increment;
    do {
      increment = false;
      for (let i = first; i !== this.scheduled.length && i !== last + 1; i++) {
        const s = this.scheduled[i];
        if (s.priority === priority) this._performOne(s, baseOffset);
        else if (s.priority > priority) increment = true;
      }
      priority++;
    } while (increment);
  }

  _performOne(s, baseOffset) {
    if (s.mode === 'left' || s.mode === 'center') this.align(s.alignment);
    const first = this.scheduled.length - 1;
    const start = this.pos;
    s.fn();
    const end = this.pos;
    const last = this.scheduled.length - 1;
    if (s.mode === 'right' || s.mode === 'center') this.align(s.alignment);
    if (s.base > 0) baseOffset = s.base;
    this._perform(first + 1, last, baseOffset);
    const saved = this.pos;
    this.pos = s.field;
    if (s.offsetMode === 'offset') this.u32(start - baseOffset);
    else if (s.offsetMode === 'sizeOnly') this.u32(end - start);
    else if (s.offsetMode === 'offsetAndSize') { this.u32(start - baseOffset); this.u32(end - start); }
    this.pos = saved;
  }

  pushStringTable(alignment = 16, mode = 'center') {
    this.stringTables.push({ base: this.base, strings: new Map(), alignment, mode });
  }

  /** Reserve a string offset; null writes 0 and is not added to the table. */
  strOffset(value) {
    const table = this.stringTables[this.stringTables.length - 1];
    const field = this.pos;
    this.u32(0);
    if (value == null) return;
    if (!table) throw new Error('No string table pushed');
    const list = table.strings.get(value);
    if (list) list.push(field); else table.strings.set(value, [field]);
  }

  popStringTable() {
    const table = this.stringTables.pop();
    if (!table || table.strings.size === 0) return;
    if (table.mode === 'left' || table.mode === 'center') this.align(table.alignment);
    const entries = [...table.strings.entries()].sort((a, b) => a[1][0] - b[1][0]);
    for (const [value, fields] of entries) {
      const at = this.pos;
      this.cstr(value);
      for (const f of fields) this.patchU32(f, at - table.base);
    }
    if (table.mode === 'right' || table.mode === 'center') this.align(table.alignment);
  }

  toBytes() { return this.buf.slice(0, this.len); }
}

export const utf8 = { encode: (s) => textEncoder.encode(s), decode: (b) => textDecoder.decode(b) };
