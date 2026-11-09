"use strict";

// The few things of a font file captions.ass needs: the name libass finds
// it by, how tall libass makes the font for a size, and how wide each
// letter is. Read from TrueType and
// OpenType files, collections of them, and WOFF and WOFF2, the files
// easyfontkit saves. A file that is not one of them, or is cut short, gives
// null: the caller then takes Arial's numbers.

const fs = require("node:fs");
const zlib = require("node:zlib");

// No font file the captions use is this big, nor do its tables unpack to
// more; a file made to unpack to gigabytes is not unpacked.
const MOST = 64 * 1024 * 1024;

// What a file's tables would unpack to is more than the room left for it.
const TOO_BIG = "too big";

// WOFF2 names its tables by a number into this list.
const KNOWN = "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill"
  .match(/.{4}\s?/g)
  .map((t) => t.slice(0, 4));

const tag = (buf, at) => buf.toString("latin1", at, at + 4);

// The tables of a font, { tag: Buffer }, for the ones asked for.
function sfntTables(buf, at, wanted) {
  const count = buf.readUInt16BE(at + 4);
  const tables = {};
  for (let i = 0; i < count; i++) {
    const rec = at + 12 + i * 16;
    const name = tag(buf, rec);
    if (!wanted.includes(name)) continue;
    const offset = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + length > buf.length) throw new Error("cut short");
    tables[name] = buf.subarray(offset, offset + length);
  }
  return tables;
}

// The tables of a WOFF, each packed on its own. What the tables asked for
// unpack to, as the table directory gives it, is checked against `room`
// and passed to `charge` before any of them is unpacked, and none unpacks
// past its own length.
function woffTables(buf, wanted, room, charge) {
  const count = buf.readUInt16BE(12);
  const records = [];
  for (let i = 0; i < count; i++) {
    const rec = 44 + i * 20;
    const name = tag(buf, rec);
    if (!wanted.includes(name)) continue;
    const offset = buf.readUInt32BE(rec + 4);
    const compressed = buf.readUInt32BE(rec + 8);
    const length = buf.readUInt32BE(rec + 12);
    if (offset + compressed > buf.length) throw new Error("cut short");
    records.push({ name, data: buf.subarray(offset, offset + compressed), length, packed: compressed < length });
  }
  const unpacked = records.filter((r) => r.packed).reduce((sum, r) => sum + r.length, 0);
  if (unpacked > room) throw new Error(TOO_BIG);
  charge(unpacked);
  const tables = {};
  for (const r of records) tables[r.name] = r.packed ? zlib.inflateSync(r.data, { maxOutputLength: Math.max(1, r.length) }) : r.data;
  return tables;
}

// A number of WOFF2's table directory: seven bits a byte, at most five.
function base128(buf, state) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buf[state.at++];
    if (byte === undefined || (i === 0 && byte === 0x80)) throw new Error("bad number");
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return value;
  }
  throw new Error("bad number");
}

// The tables of a WOFF2, all packed in one stream. The stream's length, the
// sum of its tables' as the table directory gives them, is checked against
// `room` and passed to `charge` before the stream is unpacked, and the
// stream does not unpack past it.
function woff2Tables(buf, wanted, room, charge) {
  if (tag(buf, 4) === "ttcf") return null;
  const count = buf.readUInt16BE(12);
  const compressed = buf.readUInt32BE(20);
  const state = { at: 48 };
  const entries = [];
  for (let i = 0; i < count; i++) {
    const flags = buf[state.at++];
    let name = KNOWN[flags & 0x3f];
    if ((flags & 0x3f) === 63) {
      name = tag(buf, state.at);
      state.at += 4;
    }
    const version = flags >> 6;
    const length = base128(buf, state);
    // glyf and loca are transformed unless the version is 3, the others
    // only when it is not 0.
    const transformed = name === "glyf" || name === "loca" ? version !== 3 : version !== 0;
    entries.push({ name, length: transformed ? base128(buf, state) : length, transformed });
  }
  if (state.at + compressed > buf.length) throw new Error("cut short");
  const unpacked = entries.reduce((sum, e) => sum + e.length, 0);
  if (unpacked > room) throw new Error(TOO_BIG);
  charge(unpacked);
  const data = zlib.brotliDecompressSync(buf.subarray(state.at, state.at + compressed), { maxOutputLength: Math.max(1, unpacked) });
  const tables = {};
  let at = 0;
  for (const e of entries) {
    if (wanted.includes(e.name)) {
      if (at + e.length > data.length) throw new Error("cut short");
      tables[e.name] = Object.assign(data.subarray(at, at + e.length), { transformed: e.transformed });
    }
    at += e.length;
  }
  return tables;
}

// The glyph of each character a cmap maps, in its format 4 or 12 table.
// A table that says it holds more than it does is cut short: it is
// checked here, while the file is read, so that no lookup later reads
// past its end.
function cmapOf(table) {
  const short = (end) => {
    if (end > table.length) throw new Error("cut short");
  };
  short(4);
  const count = table.readUInt16BE(2);
  short(4 + count * 8);
  let best = null;
  for (let i = 0; i < count; i++) {
    const platform = table.readUInt16BE(4 + i * 8);
    const encoding = table.readUInt16BE(6 + i * 8);
    const offset = table.readUInt32BE(8 + i * 8);
    short(offset + 2);
    const format = table.readUInt16BE(offset);
    const rank = format === 12 && (platform === 3 || platform === 0) ? 2 : format === 4 && ((platform === 3 && encoding === 1) || platform === 0) ? 1 : 0;
    if (rank && (!best || rank > best.rank)) best = { rank, offset, format };
  }
  if (!best) return null;
  const at = best.offset;
  // The first of `n` entries whose end is at or past code, found by halves
  // where the ends come in order, as the format asks, else by going
  // through them: a CJK font has thousands, and every letter of every
  // caption is looked up. `ordered` says which.
  const firstEnding = (n, endOf) => {
    let ordered = true;
    for (let i = 1; i < n && ordered; i++) ordered = endOf(i) >= endOf(i - 1);
    const find = (code) => {
      if (!ordered) {
        for (let i = 0; i < n; i++) if (code <= endOf(i)) return i;
        return n;
      }
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (endOf(mid) >= code) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    return Object.assign(find, { ordered });
  };
  if (best.format === 12) {
    short(at + 16);
    const groups = table.readUInt32BE(at + 12);
    short(at + 16 + groups * 12);
    const list = [];
    for (let g = 0; g < groups; g++) list.push([table.readUInt32BE(at + 16 + g * 12), table.readUInt32BE(at + 20 + g * 12), table.readUInt32BE(at + 24 + g * 12)]);
    const find = firstEnding(list.length, (i) => list[i][1]);
    // Groups in order, each after the one before: the group a code is in
    // is the first that ends at or past it.
    const apart = find.ordered && list.every((g, i) => i === 0 || g[0] > list[i - 1][1]);
    return (code) => {
      if (apart) {
        const group = list[find(code)];
        return group && code >= group[0] ? group[2] + code - group[0] : 0;
      }
      for (const [from, to, glyph] of list) if (code >= from && code <= to) return glyph + code - from;
      return 0;
    };
  }
  short(at + 14);
  const segments = Math.floor(table.readUInt16BE(at + 6) / 2);
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  short(ranges + segments * 2);
  const find = firstEnding(segments, (s) => table.readUInt16BE(ends + s * 2));
  return (code) => {
    if (code > 0xffff) return 0;
    for (let s = find(code); s < segments; s++) {
      if (code > table.readUInt16BE(ends + s * 2)) continue;
      const start = table.readUInt16BE(starts + s * 2);
      if (code < start) return 0;
      const delta = table.readInt16BE(deltas + s * 2);
      const range = table.readUInt16BE(ranges + s * 2);
      if (!range) return (code + delta) & 0xffff;
      // A glyph looked up past the end of the table is none.
      const where = ranges + s * 2 + range + (code - start) * 2;
      if (where + 2 > table.length) return 0;
      const glyph = table.readUInt16BE(where);
      return glyph ? (glyph + delta) & 0xffff : 0;
    }
    return 0;
  };
}

// UTF-16 as the name table keeps it, high byte first.
function utf16be(bytes) {
  let text = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) text += String.fromCharCode(bytes.readUInt16BE(i));
  return text;
}

// The family name a font file gives itself, the one libass finds a file of
// its fonts folder by (and Windows a font by): name 1 of its Windows
// names, in English where it has one. A file with no Windows names gives
// its Unicode or its Mac one. libass does not look at the typographic
// family (name 16), so neither does this. Empty when there is none.
function familyOf(name) {
  if (!name || name.length < 6) return "";
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found = [];
  for (let i = 0; i < count && 6 + i * 12 + 12 <= name.length; i++) {
    const rec = 6 + i * 12;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((k) => name.readUInt16BE(rec + k));
    const at = strings + offset;
    if (id !== 1 || at + length > name.length || (platform === 1 && encoding !== 0) || ![0, 1, 3].includes(platform)) continue;
    const bytes = name.subarray(at, at + length);
    const text = (platform === 1 ? bytes.toString("latin1") : utf16be(bytes)).replace(/\u0000/g, "").trim();
    if (text) found.push({ platform, language, text });
  }
  const pick = found.find((n) => n.platform === 3 && n.language === 0x409) || found.find((n) => n.platform === 3) || found.find((n) => n.platform === 0) || found[0];
  return pick ? pick.text : "";
}

// The advance of each glyph, from hmtx as it is or as WOFF2 keeps it,
// with its side bearings left out.
function advancesOf(hmtx, count) {
  const at = hmtx.transformed ? 1 : 0;
  const step = hmtx.transformed ? 2 : 4;
  if (at + count * step > hmtx.length) throw new Error("cut short");
  const widths = new Uint16Array(count);
  for (let i = 0; i < count; i++) widths[i] = hmtx.readUInt16BE(at + i * step);
  return widths;
}

// { family, unitsPerEm, winAscent, winDescent, ascender, descender,
// advance }: family is the name libass finds the file by (empty when it
// gives none), advance(character) a letter's width in ems, or NaN when the
// font has no glyph for it. `index` picks a font of a collection.
const readFont = (file, index = 0) => loadFont(file, index).font;

// { font, size }: the font as readFont gives it, or null, and the bytes
// reading it took: the file's, and what its tables unpacked to. A file
// that would take more than `budget` is not unpacked, and its font is
// null. The font keeps a copy of the cmap and the widths it reads, and
// nothing else of the file, so a font kept for a whole run takes little
// memory however much its file unpacked to.
function loadFont(file, index = 0, budget = Infinity) {
  let size = 0;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MOST || stat.size > budget) return { font: null, size: 0 };
    const buf = fs.readFileSync(file);
    size = buf.length;
    const room = Math.min(MOST, budget - size);
    const wanted = ["head", "hhea", "OS/2", "cmap", "hmtx", "name"];
    const kind = tag(buf, 0);
    let tables;
    const charge = (n) => (size += n);
    if (kind === "wOF2") tables = woff2Tables(buf, wanted, room, charge);
    else if (kind === "wOFF") tables = woffTables(buf, wanted, room, charge);
    else if (kind === "ttcf") {
      const fonts = buf.readUInt32BE(8);
      if (index >= fonts) return { font: null, size };
      tables = sfntTables(buf, buf.readUInt32BE(12 + index * 4), wanted);
    } else if (kind === "\u0000\u0001\u0000\u0000" || kind === "OTTO" || kind === "true") tables = sfntTables(buf, 0, wanted);
    if (!tables || !tables.head || !tables.hhea || tables.head.readUInt32BE(12) !== 0x5f0f3cf5) return { font: null, size };
    const unitsPerEm = tables.head.readUInt16BE(18);
    if (!(unitsPerEm >= 16 && unitsPerEm <= 16384)) return { font: null, size };
    const os2 = tables["OS/2"] && tables["OS/2"].length >= 78 ? tables["OS/2"] : null;
    let family = "";
    try {
      family = familyOf(tables.name);
    } catch {
      // A name table cut short names nothing.
    }
    const font = {
      family,
      unitsPerEm,
      ascender: tables.hhea.readInt16BE(4),
      descender: tables.hhea.readInt16BE(6),
      winAscent: os2 ? os2.readUInt16BE(74) : 0,
      winDescent: os2 ? os2.readUInt16BE(76) : 0,
      advance: () => NaN,
    };
    if (tables.cmap && tables.hmtx) {
      // A copy: the lookup keeps the cmap, and a view would keep the whole
      // file, or all it unpacked to, with it.
      const glyphOf = cmapOf(Buffer.from(tables.cmap));
      const widths = advancesOf(tables.hmtx, tables.hhea.readUInt16BE(34));
      if (glyphOf && widths.length) {
        font.advance = (c) => {
          const glyph = glyphOf(c.codePointAt(0));
          return glyph ? widths[Math.min(glyph, widths.length - 1)] / unitsPerEm : NaN;
        };
      }
    }
    return { font, size };
  } catch {
    return { font: null, size };
  }
}

// What a font file loadFont reads starts with: WOFF2, WOFF, a collection,
// TrueType or OpenType.
const KINDS = new Set(["wOF2", "wOFF", "ttcf", "\u0000\u0001\u0000\u0000", "OTTO", "true"]);

// Whether a file is one loadFont would read: a file of no more than MOST
// bytes that starts as a font file does. Only its first four bytes are
// read, so a video named as a font is not.
function fontLike(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MOST) return false;
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    return fs.readSync(fd, head, 0, 4, 0) === 4 && KINDS.has(tag(head, 0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The ASS font size for a font whose em is one pixel. libass, as VSFilter
// does, makes the font as tall as its OS/2 winAscent and winDescent: an
// em is the size times unitsPerEm over their sum, where the font has
// both those and its hhea ascender and descender.
function assScale(font) {
  const win = font.winAscent + font.winDescent;
  const hhea = font.ascender - font.descender;
  const height = win > 0 && hhea > 0 ? win : hhea > 0 ? hhea : win;
  return height > 0 ? height / font.unitsPerEm : 0;
}

module.exports = { readFont, loadFont, assScale, fontLike };
