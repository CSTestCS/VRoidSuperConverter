// Project DIVA texture set (*_tex.bin, "TXP") reading, raw merging and preview decoding.
import { BinReader, BinWriter } from './binary.js';

const TXP3 = 0x03505854, TXP4 = 0x04505854, TXP5 = 0x05505854, TXP2 = 0x02505854;

export const TEX_FORMAT = { A8: 0, RGB8: 1, RGBA8: 2, RGB5: 3, RGB5A1: 4, RGBA4: 5, DXT1: 6, DXT1a: 7, DXT3: 8, DXT5: 9, ATI1: 10, ATI2: 11, L8: 12, L8A8: 13, BC7: 15 };

/** Parse a texture set. Each texture keeps its raw self-contained blob (offsets are texture-relative). */
export function readTextureSet(bytes) {
  const r = new BinReader(bytes, true);
  const sig = r.u32();
  if (sig !== TXP3) throw new Error('Not a TXP texture set');
  const count = r.i32();
  r.i32();
  const textures = [];
  for (let i = 0; i < count; i++) {
    const off = r.u32();
    textures.push(readTexture(bytes, off));
  }
  return { textures };
}

function readTexture(bytes, start) {
  const r = new BinReader(bytes, true);
  r.seek(start);
  const sig = r.u32();
  if (sig !== TXP4 && sig !== TXP5) throw new Error('Bad texture signature');
  const subCount = r.i32();
  const info = r.i32();
  let mipCount = info & 0xff;
  const arraySize = (info >> 8) & 0xff;
  if (arraySize === 1 && mipCount !== subCount) mipCount = subCount;
  const subs = [];
  let end = r.pos + subCount * 4;
  for (let i = 0; i < arraySize * mipCount; i++) {
    const off = r.u32();
    const sr = new BinReader(bytes, true);
    sr.seek(start + off);
    if (sr.u32() !== TXP2) throw new Error('Bad sub-texture signature');
    const width = sr.i32(), height = sr.i32(), format = sr.i32();
    sr.i32();
    const dataSize = sr.i32();
    subs.push({ width, height, format, dataOffset: start + off + 24, dataSize });
    end = Math.max(end, start + off + 24 + dataSize);
  }
  return {
    raw: bytes.slice(start, end),
    width: subs[0]?.width ?? 0,
    height: subs[0]?.height ?? 0,
    format: subs[0]?.format ?? -1,
    mipCount, arraySize,
    subs: subs.map((s) => ({ ...s, data: bytes.subarray(s.dataOffset, s.dataOffset + s.dataSize) })),
  };
}

/** Write a texture set from raw texture blobs. */
export function writeTextureSet(textures) {
  const w = new BinWriter(true);
  w.u32(TXP3);
  w.i32(textures.length);
  w.i32((textures.length | 0x01010100) >>> 0);
  const fields = textures.map(() => { const p = w.pos; w.u32(0); return p; });
  textures.forEach((t, i) => {
    w.align(4);
    w.patchU32(fields[i], w.pos);
    w.bytes(t.raw);
  });
  return w.toBytes();
}

// ---------------------------------------------------------------- decoding (for preview only)
function rgb565(c) {
  return [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
}

function decodeColorBlock(src, o, out, x0, y0, w, h, hasAlpha1Bit) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  const p0 = rgb565(c0), p1 = rgb565(c1);
  const pal = [p0.concat(255), p1.concat(255)];
  if (c0 > c1 || !hasAlpha1Bit) {
    pal.push(p0.map((v, i) => (2 * v + p1[i]) / 3).concat(255));
    pal.push(p0.map((v, i) => (v + 2 * p1[i]) / 3).concat(255));
  } else {
    pal.push(p0.map((v, i) => (v + p1[i]) / 2).concat(255));
    pal.push([0, 0, 0, 0]);
  }
  for (let y = 0; y < 4; y++) {
    const bits = src[o + 4 + y];
    for (let x = 0; x < 4; x++) {
      const px = x0 + x, py = y0 + y;
      if (px >= w || py >= h) continue;
      const c = pal[(bits >> (x * 2)) & 3];
      const d = (py * w + px) * 4;
      out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = c[3];
    }
  }
}

function decodeAlphaBlockBC3(src, o, out, x0, y0, w, h, channel) {
  const a0 = src[o], a1 = src[o + 1];
  const pal = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal.push(((7 - i) * a0 + i * a1) / 7);
  else { for (let i = 1; i < 5; i++) pal.push(((5 - i) * a0 + i * a1) / 5); pal.push(0, 255); }
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits |= BigInt(src[o + 2 + i]) << BigInt(8 * i);
  for (let i = 0; i < 16; i++) {
    const px = x0 + (i & 3), py = y0 + (i >> 2);
    const idx = Number((bits >> BigInt(3 * i)) & 7n);
    if (px < w && py < h) out[(py * w + px) * 4 + channel] = pal[idx];
  }
}

export function decodeSubTexture(sub) {
  const { width: w, height: h, format, data } = sub;
  const out = new Uint8ClampedArray(w * h * 4);
  const bw = Math.max(1, Math.ceil(w / 4)), bh = Math.max(1, Math.ceil(h / 4));
  switch (format) {
    case TEX_FORMAT.RGBA8: out.set(data.subarray(0, out.length)); break;
    case TEX_FORMAT.RGB8:
      for (let i = 0; i < w * h; i++) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = 255; }
      break;
    case TEX_FORMAT.L8: for (let i = 0; i < w * h; i++) { out.fill(data[i], i * 4, i * 4 + 3); out[i * 4 + 3] = 255; } break;
    case TEX_FORMAT.L8A8: for (let i = 0; i < w * h; i++) { out.fill(data[i * 2], i * 4, i * 4 + 3); out[i * 4 + 3] = data[i * 2 + 1]; } break;
    case TEX_FORMAT.A8: for (let i = 0; i < w * h; i++) { out.fill(255, i * 4, i * 4 + 3); out[i * 4 + 3] = data[i]; } break;
    case TEX_FORMAT.DXT1: case TEX_FORMAT.DXT1a:
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) decodeColorBlock(data, (by * bw + bx) * 8, out, bx * 4, by * 4, w, h, true);
      break;
    case TEX_FORMAT.DXT3:
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const o = (by * bw + bx) * 16;
        decodeColorBlock(data, o + 8, out, bx * 4, by * 4, w, h, false);
        for (let i = 0; i < 16; i++) {
          const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
          const a = (data[o + (i >> 1)] >> ((i & 1) * 4)) & 15;
          if (px < w && py < h) out[(py * w + px) * 4 + 3] = a * 17;
        }
      }
      break;
    case TEX_FORMAT.DXT5:
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const o = (by * bw + bx) * 16;
        decodeColorBlock(data, o + 8, out, bx * 4, by * 4, w, h, false);
        decodeAlphaBlockBC3(data, o, out, bx * 4, by * 4, w, h, 3);
      }
      break;
    case TEX_FORMAT.ATI1:
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) decodeAlphaBlockBC3(data, (by * bw + bx) * 8, out, bx * 4, by * 4, w, h, 0);
      for (let i = 0; i < w * h; i++) { out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4]; out[i * 4 + 3] = 255; }
      break;
    case TEX_FORMAT.ATI2:
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        const o = (by * bw + bx) * 16;
        decodeAlphaBlockBC3(data, o, out, bx * 4, by * 4, w, h, 0);
        decodeAlphaBlockBC3(data, o + 8, out, bx * 4, by * 4, w, h, 1);
      }
      for (let i = 0; i < w * h; i++) { out[i * 4 + 2] = 255; out[i * 4 + 3] = 255; }
      break;
    default:
      for (let i = 0; i < w * h; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 160; out[i * 4 + 3] = 255; }
  }
  return { width: w, height: h, data: out };
}

/** Decode the top mip of a texture to RGBA8, handling DIVA's YCbCr (ATI2 two-level) encoding. */
export function decodeTexture(tex) {
  if (tex.format === TEX_FORMAT.ATI2 && tex.arraySize === 1 && tex.mipCount === 2) {
    const lum = decodeSubTexture(tex.subs[0]);
    const chr = decodeSubTexture(tex.subs[1]);
    const out = new Uint8ClampedArray(lum.width * lum.height * 4);
    for (let y = 0; y < lum.height; y++) for (let x = 0; x < lum.width; x++) {
      const i = (y * lum.width + x) * 4;
      const cx = Math.min(chr.width - 1, Math.floor(x * chr.width / lum.width));
      const cy = Math.min(chr.height - 1, Math.floor(y * chr.height / lum.height));
      const j = (cy * chr.width + cx) * 4;
      const Y = lum.data[i] / 255;
      const cr = (chr.data[j] / 255) * 1.003922 - 0.503929;
      const cg = (chr.data[j + 1] / 255) * 1.003922 - 0.503929;
      out[i] = (Y + 1.5748 * cg) * 255;
      out[i + 1] = (Y - 0.1873 * cr - 0.4681 * cg) * 255;
      out[i + 2] = (Y + 1.8556 * cr) * 255;
      out[i + 3] = lum.data[i + 1];
    }
    return { width: lum.width, height: lum.height, data: out };
  }
  return decodeSubTexture(tex.subs[0]);
}
