import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
// Deterministic native PNG generation. No source image, personal data or network request.
function crc(data) {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
for (const size of [192, 512]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const nx = x / size,
        ny = y / size,
        arrow =
          ny > 0.25 &&
          ny < 0.75 &&
          nx > 0.37 + (0.25 - Math.abs(ny - 0.5)) * 0.8 &&
          nx < 0.51 + (0.25 - Math.abs(ny - 0.5)) * 0.8,
        dot = (nx - 0.285) ** 2 + (ny - 0.5) ** 2 < 0.045 ** 2;
      const color = arrow ? [239, 184, 61] : dot ? [114, 215, 179] : [11, 21, 37];
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      rows.set(color, offset);
    }
  writeFileSync(
    `web/public/icon-${size}.png`,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}
