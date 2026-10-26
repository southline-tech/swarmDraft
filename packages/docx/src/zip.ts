/**
 * Defensive zip reader for .docx packages. Unlike a plain unzip, it never trusts declared sizes:
 * each entry is stream-inflated with a running byte count against the caps, and the result must
 * match the declared length and CRC-32 or the import fails (no silent truncation).
 */
import { Inflate } from 'fflate';

export interface ZipLimits {
  maxPartBytes: number;
  maxTotalBytes: number;
}

let CRC_TABLE: Uint32Array | undefined;
export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHUNK = 64 * 1024;

export function safeUnzip(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  limits: ZipLimits,
): Record<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => dv.getUint16(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('Not a valid .docx (zip directory not found)');
  const count = u16(eocd + 10);
  let p = u32(eocd + 16);
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  const dec = new TextDecoder();
  const seen = new Set<string>();
  for (let e = 0; e < count; e++) {
    if (p + 46 > bytes.length || u32(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const flags = u16(p + 8);
    const method = u16(p + 10);
    const crc = u32(p + 16);
    const csize = u32(p + 20);
    const usize = u32(p + 24);
    const nlen = u16(p + 28);
    const xlen = u16(p + 30);
    const clen = u16(p + 32);
    const off = u32(p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (seen.has(name))
      throw new Error(`Duplicate zip entry "${name}"; file is corrupt or tampered`);
    seen.add(name);
    if (!wanted(name)) continue;
    if (flags & 0x1 || method === 99)
      throw new Error(
        `Part ${name} is encrypted; remove the password in Word, re-save, then import`,
      );
    if (off + 30 > bytes.length || u32(off) !== 0x04034b50)
      throw new Error(`Corrupt zip entry ${name}`);
    const start = off + 30 + u16(off + 26) + u16(off + 28);
    if (start + csize > bytes.length) throw new Error(`Corrupt zip entry ${name}`);
    const comp = bytes.subarray(start, start + csize);
    const tooBig = () => new Error(`Part ${name} too large when inflated`);
    const chunks: Uint8Array[] = [];
    let n = 0;
    if (method === 0) {
      chunks.push(comp);
      n = comp.length;
      if (n > limits.maxPartBytes) throw tooBig();
    } else if (method === 8) {
      let done = false;
      const inf = new Inflate((chunk, final) => {
        n += chunk.length;
        if (n > limits.maxPartBytes) throw tooBig();
        if (total + n > limits.maxTotalBytes) throw new Error('Document too large when inflated');
        chunks.push(chunk);
        if (final) done = true;
      });
      for (let i = 0; i < comp.length; i += CHUNK)
        inf.push(comp.subarray(i, i + CHUNK), i + CHUNK >= comp.length);
      if (!comp.length) inf.push(new Uint8Array(0), true);
      if (!done) throw new Error(`Part ${name} is truncated`);
    } else throw new Error(`Unsupported zip compression method ${method} in ${name}`);
    total += n;
    if (total > limits.maxTotalBytes) throw new Error('Document too large when inflated');
    const data = new Uint8Array(n);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
    if (n !== usize)
      throw new Error(
        `Part ${name} size mismatch (declared ${usize}, actual ${n}); file is corrupt`,
      );
    if (crc32(data) !== crc) throw new Error(`Part ${name} checksum mismatch; file is corrupt`);
    out[name] = data;
  }
  return out;
}
