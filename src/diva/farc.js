// SEGA FARC archive reader/writer (FArc = stored, FArC = gzip, FARC = encrypted/compressed).
// Format reference: MikuMikuLibrary FarcArchive.cs (MIT).
import { gunzipSync, gzipSync } from 'fflate';
import { BinReader, BinWriter } from './binary.js';
import { aesDecryptEcb, aesDecryptCbc } from './aes.js';

const DT_KEY = new Uint8Array([0x70, 0x72, 0x6f, 0x6a, 0x65, 0x63, 0x74, 0x5f, 0x64, 0x69, 0x76, 0x61, 0x2e, 0x62, 0x69, 0x6e]); // "project_diva.bin"
const FT_KEY = new Uint8Array([0x13, 0x72, 0xd5, 0x7b, 0x6e, 0x9e, 0x31, 0xeb, 0xa2, 0x39, 0xb8, 0x3c, 0x15, 0x57, 0xc6, 0xbb]);

const align = (v, n) => Math.ceil(v / n) * n;

function inflate(data, expected) {
  const out = gunzipSync(data);
  return expected && out.length > expected ? out.subarray(0, expected) : out;
}

/**
 * @typedef {{name: string, data: Uint8Array}} FarcEntry
 * @param {Uint8Array} bytes
 * @returns {{entries: FarcEntry[], alignment: number, kind: string}}
 */
export function readFarc(bytes) {
  const r = new BinReader(bytes, false);
  const sig = r.fixedStr(4);
  if (sig !== 'FARC' && sig !== 'FArC' && sig !== 'FArc') throw new Error(`Not a FARC archive (signature "${sig}")`);
  const headerSize = r.u32() + 8;
  const entries = [];
  let alignment = 16;

  if (sig === 'FArc' || sig === 'FArC') {
    alignment = r.u32();
    while (r.pos < headerSize) {
      const name = r.cstr();
      const offset = r.u32();
      const size = r.u32();
      let unpacked = sig === 'FArC' ? r.u32() : size;
      const stored = bytes.subarray(offset, Math.min(offset + size, bytes.length));
      let data;
      if (sig === 'FArC' && unpacked !== 0 && size !== unpacked) data = inflate(stored, unpacked);
      else if (sig === 'FArC' && stored[0] === 0x1f && stored[1] === 0x8b) data = inflate(stored, unpacked);
      else data = stored.slice();
      entries.push({ name, data });
    }
    return { entries, alignment, kind: sig };
  }

  // FARC: encrypted and/or compressed
  let flags = r.u32();
  let compressed = (flags & 2) !== 0;
  let encrypted = (flags & 4) !== 0;
  r.u32(); // padding
  alignment = r.u32();
  const isFT = encrypted && (alignment & (alignment - 1)) !== 0;

  let hr = r;
  let entryPadding = 0, headerPadding = 0, entryCount = 0;
  let headerEnd = headerSize;
  if (isFT) {
    const iv = bytes.subarray(0x10, 0x20);
    const encHeader = bytes.subarray(0x20, align(headerSize, 16) <= bytes.length ? align(headerSize, 16) : headerSize);
    const dec = aesDecryptCbc(FT_KEY, iv, encHeader);
    hr = new BinReader(dec, false);
    headerEnd = headerSize - 0x20;
    hr.u32(); // inner header size
    alignment = hr.u32();
    entryCount = hr.u32();
    const entrySize = hr.u32();
    headerPadding = 0; // innerHeaderSize - 0x10, typically zero
    entryPadding = Math.max(0, entrySize - 0x10);
  } else {
    entryPadding = r.u32();
    headerPadding = r.u32();
  }
  hr.skip(headerPadding);

  while (hr.pos < headerEnd) {
    const name = hr.cstr();
    const offset = hr.u32();
    const compressedSize = hr.u32();
    const uncompressedSize = hr.u32();
    if (isFT) {
      flags = hr.u32();
      compressed = (flags & 2) !== 0;
      encrypted = (flags & 4) !== 0;
    }
    hr.skip(entryPadding);
    const isComp = compressed && compressedSize !== uncompressedSize;
    let data;
    if (encrypted) {
      const size = align(isComp ? compressedSize : uncompressedSize, 16);
      if (isFT) {
        const iv = bytes.subarray(offset, offset + 16);
        data = aesDecryptCbc(FT_KEY, iv, bytes.subarray(offset + 16, Math.min(offset + 16 + size, bytes.length)));
      } else {
        data = aesDecryptEcb(DT_KEY, bytes.subarray(offset, Math.min(offset + size, bytes.length)));
      }
      data = isComp ? inflate(data.subarray(0, compressedSize), uncompressedSize) : data.subarray(0, uncompressedSize);
    } else if (isComp) {
      data = inflate(bytes.subarray(offset, offset + compressedSize), uncompressedSize);
    } else {
      data = bytes.slice(offset, offset + uncompressedSize);
    }
    entries.push({ name, data: data.slice ? data.slice() : data });
    if (isFT && --entryCount === 0) break;
  }
  return { entries, alignment, kind: isFT ? 'FARC (FT)' : 'FARC' };
}

/**
 * Write a FArC (gzip-compressed) or FArc (stored) archive.
 * @param {FarcEntry[]} entries
 * @param {{compress?: boolean, alignment?: number}} [opts]
 */
export function writeFarc(entries, opts = {}) {
  const compress = opts.compress ?? true;
  const alignment = opts.alignment ?? 16;
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const payloads = sorted.map((e) => (compress ? gzipSync(e.data, { level: 6 }) : e.data));

  const w = new BinWriter(false);
  w.bytes(new TextEncoder().encode(compress ? 'FArC' : 'FArc'));
  const headerSizeField = w.pos;
  w.u32(0);
  const headerStart = w.pos;
  w.u32(alignment);
  const fields = [];
  for (let i = 0; i < sorted.length; i++) {
    w.cstr(sorted[i].name);
    fields.push(w.pos);
    w.u32(0); // offset
    w.u32(0); // stored size
    if (compress) w.u32(sorted[i].data.length);
  }
  w.patchU32(headerSizeField, w.pos - headerStart);
  for (let i = 0; i < sorted.length; i++) {
    w.align(alignment, 0x78);
    const at = w.pos;
    w.bytes(payloads[i]);
    w.patchU32(fields[i], at);
    w.patchU32(fields[i] + 4, payloads[i].length);
  }
  w.align(alignment, 0x78);
  return w.toBytes();
}
