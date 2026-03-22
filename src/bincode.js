/**
 * Minimal bincode 1.x encoder/decoder for the wormhole-nym message types.
 *
 * Bincode 1.x defaults (matching the Rust crate):
 *   - integers  : little-endian fixed-width
 *   - enum tag  : u32 (4 bytes LE)
 *   - String    : u64 length + UTF-8 bytes
 *   - Vec<u8>   : u64 length + bytes
 *   - [u8; N]   : N bytes, no length prefix
 */

export class BincodeWriter {
  #buf = [];

  writeU8(n) { this.#buf.push(n & 0xff); }

  writeU32(n) {
    n = n >>> 0;
    this.#buf.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  writeU64(n) {
    // n may be a BigInt or a safe Number
    const bi = BigInt(n);
    const lo = Number(bi & 0xffffffffn) >>> 0;
    const hi = Number((bi >> 32n) & 0xffffffffn) >>> 0;
    this.writeU32(lo);
    this.writeU32(hi);
  }

  writeBytes(bytes) {
    for (const b of bytes) this.#buf.push(b);
  }

  writeStr(s) {
    const bytes = new TextEncoder().encode(s);
    this.writeU64(bytes.length);
    this.writeBytes(bytes);
  }

  writeVec(bytes) {
    this.writeU64(bytes.length);
    this.writeBytes(bytes);
  }

  /** Fixed-size array ([u8; N]) — no length prefix. */
  writeFixed(bytes) {
    this.writeBytes(bytes);
  }

  toBytes() { return new Uint8Array(this.#buf); }
}

export class BincodeReader {
  #buf;
  #pos = 0;

  constructor(buf) {
    this.#buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  }

  readU8() { return this.#buf[this.#pos++]; }

  readU32() {
    const a = this.readU8(), b = this.readU8(), c = this.readU8(), d = this.readU8();
    return ((d << 24) | (c << 16) | (b << 8) | a) >>> 0;
  }

  readU64() {
    const lo = BigInt(this.readU32());
    const hi = BigInt(this.readU32());
    return lo | (hi << 32n);
  }

  readBytes(n) {
    const result = this.#buf.slice(this.#pos, this.#pos + n);
    this.#pos += n;
    return result;
  }

  readStr() {
    const len = Number(this.readU64());
    return new TextDecoder().decode(this.readBytes(len));
  }

  readVec() {
    const len = Number(this.readU64());
    return this.readBytes(len);
  }

  readFixed(n) { return this.readBytes(n); }
}
