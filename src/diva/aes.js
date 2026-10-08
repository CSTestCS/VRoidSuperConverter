// Minimal AES-128 block decryption (ECB/CBC, zero padding) used for encrypted FARC archives.
// WebCrypto cannot be used because FARC data is zero padded, not PKCS#7 padded.

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

(function buildTables() {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function mul(a, b) {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
  return r;
}

export function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  for (let i = 16, r = 0; i < 176; i += 4) {
    let t = new Uint8Array(w.subarray(i - 4, i));
    if (i % 16 === 0) {
      t = new Uint8Array([SBOX[t[1]] ^ RCON[r++], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]);
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}

function encryptBlock(rk, input, out) {
  const s = new Uint8Array(input.subarray(0, 16));
  for (let i = 0; i < 16; i++) s[i] ^= rk[i];
  for (let round = 1; round <= 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]];
    const t = new Uint8Array(s);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[c * 4 + r] = t[((c + r) % 4) * 4 + r];
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
        s[c * 4 + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
      }
    }
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  }
  out.set(s);
}

function decryptBlock(rk, input, out) {
  const s = new Uint8Array(input.subarray(0, 16));
  for (let i = 0; i < 16; i++) s[i] ^= rk[160 + i];
  for (let round = 9; round >= 0; round--) {
    const t = new Uint8Array(s);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[((c + r) % 4) * 4 + r] = t[c * 4 + r];
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]];
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
    if (round !== 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
        s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
        s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
        s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
      }
    }
  }
  out.set(s);
}

export function aesEncryptEcb(key, data) {
  const rk = expandKey(key);
  const out = new Uint8Array(Math.ceil(data.length / 16) * 16);
  const block = new Uint8Array(16);
  for (let i = 0; i < out.length; i += 16) {
    block.fill(0); block.set(data.subarray(i, i + 16));
    encryptBlock(rk, block, out.subarray(i, i + 16));
  }
  return out;
}

export function aesDecryptEcb(key, data) {
  const rk = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 16) decryptBlock(rk, data.subarray(i, i + 16), out.subarray(i, i + 16));
  return out;
}

export function aesDecryptCbc(key, iv, data) {
  const rk = expandKey(key);
  const n = data.length - (data.length % 16);
  const out = new Uint8Array(n);
  let prev = iv;
  for (let i = 0; i < n; i += 16) {
    const block = data.subarray(i, i + 16);
    const o = out.subarray(i, i + 16);
    decryptBlock(rk, block, o);
    for (let j = 0; j < 16; j++) o[j] ^= prev[j];
    prev = new Uint8Array(block);
  }
  return out;
}

export function aesEncryptCbc(key, iv, data) {
  const rk = expandKey(key);
  const out = new Uint8Array(Math.ceil(data.length / 16) * 16);
  let prev = iv;
  const block = new Uint8Array(16);
  for (let i = 0; i < out.length; i += 16) {
    block.fill(0); block.set(data.subarray(i, i + 16));
    for (let j = 0; j < 16; j++) block[j] ^= prev[j];
    const o = out.subarray(i, i + 16);
    encryptBlock(rk, block, o);
    prev = o;
  }
  return out;
}
