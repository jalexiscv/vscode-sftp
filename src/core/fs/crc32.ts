// tslint:disable:no-bitwise
/**
 * CRC-32 (IEEE 802.3: the polynomial zip, gzip, PNG and FTP's XCRC use),
 * computed incrementally over a stream of chunks like a crypto Hash.
 *
 * Node only gained zlib.crc32 in v22 and the VS Code runtime this extension
 * targets does not guarantee it, so the 256-entry table is built once here
 * instead of pulling in a dependency.
 */

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

export default class Crc32 {
  private _crc: number = -1; // 0xffffffff, the IEEE initial value

  update(chunk: Buffer): void {
    let crc = this._crc;
    for (const byte of chunk) {
      crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    this._crc = crc;
  }

  /** Lowercase hex, zero-padded to 8 characters, like `crc32` tools print it. */
  digest(): string {
    const value = (this._crc ^ -1) >>> 0;
    return ('00000000' + value.toString(16)).slice(-8);
  }
}
