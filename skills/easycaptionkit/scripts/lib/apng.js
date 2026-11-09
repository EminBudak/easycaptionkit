"use strict";

// One animated PNG from PNG files of the same size and kind, each shown
// for its own whole number of milliseconds. ffmpeg reads it as one stream
// with every frame at its time, in a time base of 1/100000 s, through its
// apng demuxer, which opens nothing but the file it is given and reads it
// the same way from ffmpeg 4.4 on. A concat list of the PNGs would name
// other files, which a guard that keeps ffmpeg to its inputs refuses, and
// only ffmpeg 5.1 and newer time its pictures to the millisecond.

const fs = require("node:fs");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// A frame's time is a 16-bit count of its delay's unit: a longer one is
// written as the same picture again.
const LONGEST = 60_000;

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(parts) {
  let c = -1;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// A PNG as its parts: the header (IHDR's contents), the chunks between the
// header and the picture that say how to read it (a palette, its
// transparency, the color space), and the picture's compressed data, the
// contents of its IDAT chunks in order.
function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error(`${file} is not a PNG`);
  let header = null;
  const before = [];
  const data = [];
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (at + 12 + length > buf.length) break;
    const body = buf.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (type === "IEND") break;
    if (type === "IHDR") header = body;
    else if (type === "IDAT") data.push(body);
    else if (!data.length && !["acTL", "fcTL", "fdAT"].includes(type)) before.push({ type, body });
  }
  if (!header || header.length !== 13 || !data.length) throw new Error(`${file} is not a whole PNG`);
  return { header, before, data };
}

// The chunks a frame has to share with the first one to be read the same
// way: its size and pixel format, and its palette.
const kindOf = (png) => [png.header, ...png.before.filter((c) => c.type === "PLTE" || c.type === "tRNS").map((c) => Buffer.concat([Buffer.from(c.type, "latin1"), c.body]))].map((b) => b.toString("hex")).join(":");

// Writes `file` from frames: [{ png, ms }], each PNG shown for `ms`
// milliseconds, a whole number above 0. Every PNG has the size and pixel
// format of the first, and covers the whole picture.
function writeApng(file, frames) {
  const entries = [];
  for (const frame of frames) {
    if (!(Number.isInteger(frame.ms) && frame.ms > 0)) throw new Error(`a frame of ${file} lasts ${frame.ms} ms`);
    for (let left = frame.ms; left > 0; left -= LONGEST) entries.push({ png: frame.png, ms: Math.min(left, LONGEST) });
  }
  if (!entries.length) throw new Error(`${file} would have no frames`);
  // A picture shown more than once (the empty one, between captions) is
  // read once; the others are read when their turn comes.
  const uses = new Map();
  for (const e of entries) uses.set(e.png, (uses.get(e.png) || 0) + 1);
  const kept = new Map();
  const read = (png) => {
    if (kept.has(png)) return kept.get(png);
    const parts = readPng(png);
    if (uses.get(png) > 1) kept.set(png, parts);
    return parts;
  };
  const first = read(entries[0].png);
  const kind = kindOf(first);
  const width = first.header.readUInt32BE(0);
  const height = first.header.readUInt32BE(4);
  const fd = fs.openSync(file, "w");
  try {
    const put = (type, ...parts) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(parts.reduce((n, p) => n + p.length, 0), 0);
      head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32([head.subarray(4), ...parts]), 0);
      fs.writeSync(fd, Buffer.concat([head, ...parts, crc]));
    };
    fs.writeSync(fd, SIGNATURE);
    put("IHDR", first.header);
    const actl = Buffer.alloc(8);
    actl.writeUInt32BE(entries.length, 0);
    // Played once.
    actl.writeUInt32BE(1, 4);
    put("acTL", actl);
    for (const chunk of first.before) put(chunk.type, chunk.body);
    let sequence = 0;
    entries.forEach((entry, i) => {
      const png = i === 0 ? first : read(entry.png);
      if (kindOf(png) !== kind) throw new Error(`${entry.png} is not the size or pixel format of ${entries[0].png}`);
      const fctl = Buffer.alloc(26);
      fctl.writeUInt32BE(sequence++, 0);
      fctl.writeUInt32BE(width, 4);
      fctl.writeUInt32BE(height, 8);
      // At the top left corner; the delay in milliseconds; the picture
      // left as it is after the frame, and the frame put over it whole,
      // its transparent pixels too.
      fctl.writeUInt16BE(entry.ms, 20);
      fctl.writeUInt16BE(1000, 22);
      put("fcTL", fctl);
      for (const data of png.data) {
        if (i === 0) put("IDAT", data);
        else {
          const number = Buffer.alloc(4);
          number.writeUInt32BE(sequence++, 0);
          put("fdAT", number, data);
        }
      }
    });
    put("IEND");
  } finally {
    fs.closeSync(fd);
  }
  return entries.length;
}

module.exports = { writeApng, readPng, crc32 };
