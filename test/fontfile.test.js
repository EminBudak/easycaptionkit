"use strict";

// The numbers captions.ass takes from a font: how tall libass makes it for
// a size, from its OS/2 heights, and how wide its letters are, read from
// TrueType, collections, WOFF and WOFF2; and Arial's where no file is
// known.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const test = require("node:test");
const { readFont, assScale } = require("../skills/easycaptionkit/scripts/lib/fontfile");
const { ass, assFont, estimatedScales, fallbackLetters, ARIAL } = require("../skills/easycaptionkit/scripts/lib/subtitles");
const { captionLayout, charsThatFit } = require("../skills/easycaptionkit/scripts/lib/places");
const { buildCues, states } = require("../skills/easycaptionkit/scripts/lib/cues");
const { dir, FIXTURES } = require("./helpers");

// A name table: each record { platform, encoding, language, id, text },
// the Windows and Unicode ones in UTF-16, the Mac ones in one byte each.
function nameTable(records) {
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let at = 0;
  const strings = records.map((r, i) => {
    const data = r.platform === 1 ? Buffer.from(r.text, "latin1") : Buffer.from(r.text, "utf16le").swap16();
    const o = 6 + i * 12;
    [r.platform, r.encoding, r.language, r.id, data.length, at].forEach((v, k) => head.writeUInt16BE(v, o + k * 2));
    at += data.length;
    return data;
  });
  return Buffer.concat([head, ...strings]);
}

// A font of four glyphs, built here: unitsPerEm 1000, hhea 800 and -200,
// OS/2 winAscent 950 and winDescent 250, A B C mapped to glyphs 1 to 3 of
// 600, 700 and 800 units, the rest to glyph 0, and named Four Test, with
// the typographic family Four.
function tables() {
  // Long enough for WOFF to pack.
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(4, 34);
  const os2 = Buffer.alloc(78);
  os2.writeUInt16BE(950, 74);
  os2.writeUInt16BE(250, 76);
  const hmtx = Buffer.alloc(16);
  [500, 600, 700, 800].forEach((w, i) => hmtx.writeUInt16BE(w, i * 4));
  // cmap: one format 4 table of two segments, A to C and the end.
  const sub = Buffer.alloc(32);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(32, 2);
  sub.writeUInt16BE(4, 6);
  sub.writeUInt16BE(0x43, 14);
  sub.writeUInt16BE(0xffff, 16);
  sub.writeUInt16BE(0x41, 20);
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(1 - 0x41, 24);
  sub.writeInt16BE(1, 26);
  const cmap = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
  const name = nameTable([
    { platform: 1, encoding: 0, language: 0, id: 1, text: "Four Mac" },
    { platform: 3, encoding: 1, language: 0x407, id: 1, text: "Vier Test" },
    { platform: 3, encoding: 1, language: 0x409, id: 1, text: "Four Test" },
    { platform: 3, encoding: 1, language: 0x409, id: 4, text: "Four Test Bold" },
    { platform: 3, encoding: 1, language: 0x409, id: 16, text: "Four" },
  ]);
  return { cmap, head, hhea, hmtx, name, "OS/2": os2 };
}

const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);

// An sfnt of the tables, its records' offsets counted from `base`.
function sfnt(t, base = 0) {
  const names = Object.keys(t).sort();
  const head = Buffer.alloc(12 + names.length * 16);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt16BE(names.length, 4);
  let at = base + head.length;
  const bodies = [];
  names.forEach((name, i) => {
    head.write(name, 12 + i * 16, "latin1");
    head.writeUInt32BE(at, 12 + i * 16 + 8);
    head.writeUInt32BE(t[name].length, 12 + i * 16 + 12);
    bodies.push(pad(t[name]));
    at += pad(t[name]).length;
  });
  return Buffer.concat([head, ...bodies]);
}

function woff(t) {
  const names = Object.keys(t).sort();
  const head = Buffer.alloc(44 + names.length * 20);
  head.write("wOFF", 0, "latin1");
  head.writeUInt16BE(names.length, 12);
  let at = head.length;
  const bodies = [];
  names.forEach((name, i) => {
    // A table that does not get smaller is kept as it is.
    const deflated = zlib.deflateSync(t[name]);
    const packed = deflated.length < t[name].length ? deflated : t[name];
    head.write(name, 44 + i * 20, "latin1");
    head.writeUInt32BE(at, 44 + i * 20 + 4);
    head.writeUInt32BE(packed.length, 44 + i * 20 + 8);
    head.writeUInt32BE(t[name].length, 44 + i * 20 + 12);
    bodies.push(pad(packed));
    at += pad(packed).length;
  });
  return Buffer.concat([head, ...bodies]);
}

function collection(t) {
  const head = Buffer.alloc(16);
  head.write("ttcf", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt32BE(1, 8);
  head.writeUInt32BE(16, 12);
  return Buffer.concat([head, sfnt(t, 16)]);
}

// A WOFF2 of the tables, with a table of `filler` zeros next to them, as a
// file can carry: a few kilobytes that unpack to as many megabytes as asked.
function woff2(t, filler = 0) {
  const known = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2"];
  const number = (n) => {
    const out = [];
    do {
      out.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    return out.map((b, i) => (i < out.length - 1 ? b | 0x80 : b));
  };
  const names = Object.keys(t);
  const entries = [];
  for (const name of names) entries.push(known.indexOf(name), ...number(t[name].length));
  if (filler) entries.push(63, ..."zzzz".split("").map((c) => c.charCodeAt(0)), ...number(filler));
  const stream = Buffer.concat([...names.map((name) => t[name]), Buffer.alloc(filler)]);
  const packed = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
  const head = Buffer.alloc(48);
  head.write("wOF2", 0, "latin1");
  head.writeUInt32BE(0x00010000, 4);
  head.writeUInt16BE(names.length + (filler ? 1 : 0), 12);
  head.writeUInt32BE(stream.length, 16);
  head.writeUInt32BE(packed.length, 20);
  const file = Buffer.concat([head, Buffer.from(entries), packed]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

const save = (name, buf) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return file;
};

test("a font's heights and letter widths, from TrueType, a collection and WOFF alike", () => {
  for (const [name, buf] of [["four.ttf", sfnt(tables())], ["four.ttc", collection(tables())], ["four.woff", woff(tables())]]) {
    const font = readFont(save(name, buf));
    assert.ok(font, name);
    assert.deepEqual([font.unitsPerEm, font.ascender, font.descender, font.winAscent, font.winDescent], [1000, 800, -200, 950, 250], name);
    assert.deepEqual(["A", "B", "C", "D", "日"].map((c) => font.advance(c)), [0.6, 0.7, 0.8, NaN, NaN], name);
    // libass makes it as tall as winAscent and winDescent: 1.2 of the em.
    assert.equal(assScale(font), 1.2, name);
    // The name libass finds the file by: its Windows family name, in English.
    assert.equal(font.family, "Four Test", name);
  }
  assert.equal(readFont(save("four-collection.ttc", collection(tables())), 1), null, "a collection of one font has no second");
});

test("the family name libass finds a file by is name 1 of its Windows names, in English where it has one, else the Unicode or the Mac one", () => {
  const named = (records) => {
    const t = tables();
    t.name = nameTable(records);
    return readFont(save("named.ttf", sfnt(t))).family;
  };
  assert.equal(named([{ platform: 3, encoding: 1, language: 0x40c, id: 1, text: "Quatre" }, { platform: 3, encoding: 1, language: 0x409, id: 16, text: "Four" }]), "Quatre");
  assert.equal(named([{ platform: 1, encoding: 0, language: 0, id: 1, text: "Four Mac" }, { platform: 0, encoding: 3, language: 0, id: 1, text: "Four Unicode" }]), "Four Unicode");
  assert.equal(named([{ platform: 1, encoding: 0, language: 0, id: 1, text: "Four Mac" }]), "Four Mac");
  assert.equal(named([{ platform: 3, encoding: 1, language: 0x409, id: 4, text: "Four Bold" }]), "");
  // A record that points past the table is passed over.
  const t = tables();
  t.name = nameTable([{ platform: 3, encoding: 1, language: 0x409, id: 1, text: "Four Test" }]);
  t.name.writeUInt16BE(400, 6 + 8);
  assert.equal(readFont(save("named-cut.ttf", sfnt(t))).family, "");
});

test("WOFF2, as easyfontkit saves a site's fonts: Inter's latin cut, its letters as wide as Chrome draws them", () => {
  const font = readFont(path.join(FIXTURES, "inter-latin-400.woff2"));
  assert.equal(font.family, "Inter");
  assert.deepEqual([font.unitsPerEm, font.winAscent, font.winDescent], [2048, 2269, 660]);
  // Chrome measures a at 0.5615 and W at 0.9854 of the em.
  assert.equal(font.advance("a"), 1150 / 2048);
  assert.equal(font.advance("W"), 2018 / 2048);
  assert.equal(assScale(font), (2269 + 660) / 2048);
});

test("a file that is not a font, or one cut short, gives nothing, and captions.ass then takes Arial's numbers", () => {
  const whole = sfnt(tables());
  for (const [name, buf] of [["notes.ttf", Buffer.from("just some notes, not a font")], ["cut.ttf", whole.subarray(0, 40)], ["cut.woff", woff(tables()).subarray(0, 60)], ["empty.woff2", Buffer.from("wOF2")]]) assert.equal(readFont(save(name, buf)), null, name);
  assert.equal(readFont(path.join(dir, "no-such-font.ttf")), null);
  // A cmap that says it holds more than it does, as a careless tool can
  // write one, gives nothing either, and is never read past its end.
  const claims = tables();
  claims.cmap.writeUInt16BE(0xfffe, 12 + 6);
  const many = tables();
  many.cmap.writeUInt16BE(40, 2);
  for (const [name, t] of [["claims.ttf", claims], ["many.ttf", many]]) assert.equal(readFont(save(name, sfnt(t))), null, name);
  // A segment whose glyph is looked up past the end of the table has no glyph.
  const far = tables();
  far.cmap.writeUInt16BE(0x7ff0, 12 + 28);
  const farFont = readFont(save("far.ttf", sfnt(far)));
  assert.ok(farFont);
  assert.ok(Number.isNaN(farFont.advance("B")));
  const broken = { family: "Broken", weight: 700, faces: [{ family: "Broken", file: path.join(dir, "notes.ttf"), weight: [700, 700], italic: false }] };
  assert.equal(assFont(broken), ARIAL);
  assert.equal(assFont({ ...broken, faces: [{ ...broken.faces[0], file: path.join(dir, "claims.ttf") }] }), ARIAL);
  assert.equal(assFont({ family: "", weight: 700, faces: [] }), ARIAL);
});

test("captions.ass sizes its font so that its em is the layout's letter size, from the font's own heights or Arial's", () => {
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "line", size: 6.5, lines: 2 });
  const words = [{ text: "Hello", start: 0.5, end: 1, seg: 0, timed: true }];
  const cues = buildCues(words, { lines: 2, maxChars: 14, hard: false, duration: 2 });
  const look = (more) => ({ family: "", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test", ...more });
  const size = (l, font) => Number(/^Style: Caption,[^,]*,(\d+),/m.exec(ass(cues, words, { states: states(cues, words, "line"), style: "line", look: l, place, font }))[1]);
  // Arial is 1.1172 of its em tall: 70 px letters take a size of 78, not 84.
  assert.equal(place.fontPx, 70);
  assert.equal(size(look()), 78);
  const inter = look({ family: "Inter", from: "fonts.css", faces: [{ family: "Inter", file: path.join(FIXTURES, "inter-latin-400.woff2"), name: "inter-latin-400.woff2", weight: [400, 400], italic: false }] });
  assert.equal(size(inter, assFont(inter)), Math.round(70 * (2269 + 660) / 2048));
  // fonts.css can call a family otherwise than its file does, as easyfontkit
  // does for InterVariable: captions.ass names it as the file does, since
  // libass finds a file of its fonts folder by the names in it.
  const renamed = look({ family: "Kit Inter", from: "fonts.css", faces: [{ ...inter.faces[0], family: "Kit Inter" }] });
  const style = (l, font) => /^Style: Caption,([^,]*),/m.exec(ass(cues, words, { states: states(cues, words, "line"), style: "line", look: l, place, font }))[1];
  assert.equal(assFont(renamed).family, "Inter");
  assert.equal(style(renamed, assFont(renamed)), "Inter");
  // A file that gives no name it can be found by leaves the name fonts.css gives.
  const nameless = tables();
  delete nameless.name;
  const unnamed = look({ family: "Kit Four", from: "fonts.css", faces: [{ family: "Kit Four", file: save("nameless.ttf", sfnt(nameless)), weight: [700, 700], italic: false }] });
  assert.equal(assFont(unnamed).family, "");
  assert.equal(style(unnamed, assFont(unnamed)), "Kit Four");
  // A name with a comma cannot go in a Style line, so it is not used either.
  const comma = tables();
  comma.name = nameTable([{ platform: 3, encoding: 1, language: 0x409, id: 1, text: "Four, Inc" }]);
  assert.equal(assFont(look({ family: "Kit Four", from: "fonts.css", faces: [{ family: "Kit Four", file: save("comma.ttf", sfnt(comma)), weight: [700, 700], italic: false }] })).family, "");
  // A family split into files by script, as a site serves it: each letter's width from the file that has it.
  const four = save("split-four.ttf", sfnt(tables()));
  const interFile = path.join(FIXTURES, "inter-latin-400.woff2");
  const face = (file, weight = [700, 700]) => ({ family: "Split", file, weight, italic: false });
  const split = assFont(look({ family: "Split", from: "fonts.css", faces: [face(save("split-notes.ttf", Buffer.from("not a font"))), face(four), face(interFile), face(interFile, [400, 400])] }));
  assert.equal(split.scale, 1.2, "the heights of the first file that reads");
  assert.equal(split.advance("A"), 0.6);
  assert.equal(split.advance("a"), readFont(interFile).advance("a"));
  assert.ok(Number.isNaN(split.advance("日")));
  // A font asked for by name takes the file fontconfig gives for it.
  const file = save("machine.ttf", sfnt(tables()));
  assert.equal(size(look({ family: "Four", from: "machine" }), assFont(look({ family: "Four" }), { family: "Four", file, index: 0 })), 84);
});

test("letters the font lacks are set in the font fontconfig gives for them, at the size that gives that font's em the layout's letter size, as libass sizes each font by its own heights", () => {
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, lines: 2 });
  // Four Test has A, B and C, and is 1.2 of its em tall. Wide Test has 日,
  // 0.6 of an em wide, and is 1.448 of its em tall, as Noto Sans CJK is.
  const four = save("fallback-four.ttf", sfnt(tables()));
  const wide = tables();
  wide.cmap.writeUInt16BE(0x65e5, 12 + 14);
  wide.cmap.writeUInt16BE(0x65e5, 12 + 20);
  wide.cmap.writeInt16BE(1 - 0x65e5, 12 + 24);
  wide["OS/2"].writeUInt16BE(1160, 74);
  wide["OS/2"].writeUInt16BE(288, 76);
  const cjk = save("fallback-wide.ttf", sfnt(wide));
  const asked = [];
  const give = (cp) => {
    asked.push(cp);
    return cp === 0x65e5 ? { family: "Wide Test", style: "Bold", file: cjk, index: 0 } : null;
  };
  const look = { family: "Four", from: "machine", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const font = assFont(look, { family: "Four Test", file: four, index: 0 }, { fallback: give });
  const words = [{ text: "AB", start: 0.5, end: 1, seg: 0, timed: true }, { text: "日日", start: 1, end: 1.5, seg: 0, timed: true }, { text: "C", start: 1.5, end: 2, seg: 0, timed: true }];
  const cues = buildCues(words, { lines: 2, maxChars: 14, hard: false, duration: 3 });
  const events = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place, font }).split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",,0,0,0,,")[1]);
  // 70 px letters: a size of 84 for a font 1.2 em tall, 101 for one 1.448 em tall.
  assert.deepEqual(events, [
    "{\\1c&H3FD2FF&}AB{\\1c&HFFFFFF&}{\\fnWide Test\\fs101}日日{\\fnFour\\fs84}C",
    "AB{\\1c&H3FD2FF&}{\\fnWide Test\\fs101}日日{\\1c&HFFFFFF&}{\\fnFour\\fs84}C",
    "AB{\\fnWide Test\\fs101}日日{\\1c&H3FD2FF&}{\\fnFour\\fs84}C{\\1c&HFFFFFF&}",
  ]);
  assert.deepEqual(asked, [0x65e5], "fontconfig is asked once for a letter it gave a font for");
  // The width libass is told to fit takes each letter's width from the font it is set in:
  // sixteen of 0.6 em fit the 692 px, twenty do not.
  const scale = (n) => estimatedScales([{ first: 0, last: 0, lines: ["日".repeat(n)] }], words, { style: "line", place, font })[0];
  assert.equal(place.glyphWidth, 692);
  assert.equal(scale(16), 1);
  assert.ok(Math.abs(scale(20) - 692 / (20 * 0.6 * 70)) < 1e-9, String(scale(20)));
  // A font read from no file, or no font given for a letter, changes nothing.
  for (const other of [assFont(look), assFont(look, { family: "Four Test", file: four, index: 0 }, { fallback: () => null })]) {
    const plain = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place, font: other });
    assert.doesNotMatch(plain, /\\fn/);
  }
});

// A cmap of one table that maps each range [first, last] to glyphs from 1
// on, in order: format 4, or format 12 where a letter is past U+FFFF.
function cmapOf(ranges) {
  if (ranges.some(([, last]) => last > 0xffff)) {
    const sub = Buffer.alloc(16 + ranges.length * 12);
    sub.writeUInt16BE(12, 0);
    sub.writeUInt32BE(sub.length, 4);
    sub.writeUInt32BE(ranges.length, 12);
    let glyph = 1;
    ranges.forEach(([first, last], i) => {
      sub.writeUInt32BE(first, 16 + i * 12);
      sub.writeUInt32BE(last, 20 + i * 12);
      sub.writeUInt32BE(glyph, 24 + i * 12);
      glyph += last - first + 1;
    });
    return Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12]), sub]);
  }
  const segments = [...ranges, [0xffff, 0xffff]];
  const n = segments.length;
  const sub = Buffer.alloc(16 + n * 8);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(n * 2, 6);
  let glyph = 1;
  segments.forEach(([first, last], i) => {
    sub.writeUInt16BE(last, 14 + i * 2);
    sub.writeUInt16BE(first, 16 + n * 2 + i * 2);
    sub.writeInt16BE(first === 0xffff ? 1 : glyph - first, 16 + n * 4 + i * 2);
    if (first !== 0xffff) glyph += last - first + 1;
  });
  return Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0, 12]), sub]);
}

test("a font of thousands of ranges, as a CJK font has, finds each letter's glyph in moments, by halves, and one whose ranges come out of order still finds them", () => {
  // 4,000 ranges of two letters from U+4E00, the third letter of each three left out.
  const ranges = Array.from({ length: 4000 }, (_, i) => [0x4e00 + i * 3, 0x4e00 + i * 3 + 1]);
  const codes = Array.from({ length: 12000 }, (_, i) => 0x4e00 + i);
  const has = (code) => (code - 0x4e00) % 3 !== 2;
  const fonts = {
    "format 4": cmapOf(ranges),
    "format 12": cmapOf([...ranges, [0x20000, 0x20001]]),
    "format 12 out of order": cmapOf([[0x20000, 0x20001], ...ranges].reverse()),
  };
  for (const [kind, cmap] of Object.entries(fonts)) {
    const font = readFont(save(`ranges-${kind.replace(/ /g, "-")}.ttf`, sfnt({ ...tables(), cmap })));
    for (const code of codes) assert.equal(Number.isFinite(font.advance(String.fromCodePoint(code))), has(code), `${kind}: U+${code.toString(16)}`);
    assert.ok(Number.isNaN(font.advance("A")), kind);
    if (kind === "format 12 out of order") continue;
    const started = Date.now();
    for (let round = 0; round < 20; round++) for (const code of codes) font.advance(String.fromCodePoint(code));
    assert.ok(Date.now() - started < 1000, `${kind}: 240,000 letters took ${Date.now() - started} ms`);
  }
});

test("an Arabic letter the font lacks is set in the Arabic family Chrome draws it with, not in fontconfig's own answer or a font found for another letter", () => {
  const { fallbackFont } = require("../skills/easycaptionkit/scripts/lib/look");
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "line", size: 6.5, lines: 2 });
  const four = save("arabic-four.ttf", sfnt(tables()));
  const arabic = save("arabic-sans.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x645, 0x647]]) }));
  const kufi = save("arabic-kufi.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x645, 0x647]]) }));
  // A font with an arrow and Arabic letters, as DejaVu Sans has.
  const arrow = save("arabic-arrow.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x645, 0x647], [0x2192, 0x2192]]) }));
  // fontconfig on Ubuntu 22.04: Noto Kufi Arabic for sans-serif with an
  // Arabic letter, Noto Sans Arabic when asked for by name.
  const match = (pattern) => {
    const family = pattern.startsWith("Noto Sans Arabic:") ? "Noto Sans Arabic" : /charset=2192/.test(pattern) ? "Arrow Test" : "Noto Kufi Arabic";
    return { family, style: "Bold", file: { "Noto Sans Arabic": arabic, "Arrow Test": arrow, "Noto Kufi Arabic": kufi }[family], index: 0, outline: true };
  };
  const look = { family: "Four", from: "machine", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const font = assFont(look, { family: "Four Test", file: four, index: 0 }, { fallback: (code) => fallbackFont(code, 700, "", { platform: "linux", match }) });
  const words = [{ text: "A→", start: 0.5, end: 1, seg: 0, timed: true }, { text: "منه", start: 1, end: 1.5, seg: 0, timed: true }];
  const cues = buildCues(words, { lines: 2, maxChars: 14, hard: false, duration: 3 });
  const events = ass(cues, words, { states: states(cues, words, "line"), style: "line", look, place, font }).split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",,0,0,0,,")[1]);
  assert.deepEqual(events, ["A{\\fnArrow Test\\fs84}→ {\\fnNoto Sans Arabic\\fs84}منه"]);
  assert.deepEqual(fallbackLetters(cues, font), [{ family: "Arrow Test", letters: 1 }, { family: "Noto Sans Arabic", letters: 3 }]);
});

test("a letter for which fontconfig gives no font libass can draw, a color emoji or one no font has, is counted with its caption and said in a note; one nothing can say of is not", () => {
  const { assLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const { missingNotes } = require("../skills/easycaptionkit/scripts/lib/caption");
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "line", size: 6.5, lines: 2 });
  const four = save("emoji-four.ttf", sfnt(tables()));
  // A black and white thumbs up without the skin tones, as Noto Sans Symbols2 has.
  const thumb = save("emoji-thumb.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x1f44d, 0x1f44d]]) }));
  const give = (code) => {
    if (code === 0x1f44d) return { family: "Thumb Test", style: "Regular", file: thumb, index: 0, outline: true };
    if (code === 0x1f680 || code === 0x1f525) return { family: "Noto Color Emoji", style: "Regular", file: "/f/NotoColorEmoji.ttf", index: 0, outline: false };
    // No font has it: fontconfig gives one without it.
    if (code === 0x16a0) return { family: "Thumb Test", style: "Regular", file: thumb, index: 0, outline: true };
    return null;
  };
  const look = { family: "Four", from: "machine", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const font = assFont(look, { family: "Four Test", file: four, index: 0 }, { fallback: give });
  const words = [
    { text: "AB", start: 0.5, end: 1, seg: 0, timed: true },
    { text: "🚀🔥", start: 1, end: 1.5, seg: 0, timed: true },
    { text: "👍🏽", start: 1.5, end: 2, seg: 1, timed: true },
    { text: "👍", start: 2, end: 2.5, seg: 1, timed: true },
    { text: "ᚠ", start: 2.5, end: 3, seg: 2, timed: true },
    { text: "Ж", start: 3, end: 3.5, seg: 2, timed: true },
  ];
  const cues = buildCues(words, { lines: 1, maxChars: 8, hard: true, duration: 4 });
  assert.deepEqual(cues.map((c) => c.lines.join("|")), ["AB 🚀🔥", "👍🏽 👍", "ᚠ Ж"]);
  const letters = assLetters(cues, font);
  // 👍 alone is set in the font that has it; with its skin tone it needs a font with both.
  assert.deepEqual(letters.fallbacks, [{ family: "Thumb Test", letters: 1 }]);
  assert.deepEqual(letters.missing, [{ letter: "🚀", cue: 1 }, { letter: "🔥", cue: 1 }, { letter: "👍🏽", cue: 2 }, { letter: "ᚠ", cue: 3 }]);
  // Ж, which fontconfig says nothing of here, is the font's as far as anything knows.
  assert.deepEqual([letters.total, letters.own], [8, 3]);
  const events = ass(cues, words, { states: states(cues, words, "line"), style: "line", look, place, font }).split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",,0,0,0,,")[1]);
  assert.equal(events[1], "👍🏽 {\\fnThumb Test\\fs84}👍");
  assert.deepEqual(missingNotes(letters.missing), [
    "libass draws no color emoji, and this machine has no other font that draws the 3 emoji in captions 1 and 2 (🚀 🔥 👍🏽) whole, so the video shows boxes for them. Leave out --libass to have Chrome draw them.",
    "No font on this machine that libass can use has 1 letter of caption 3 (ᚠ), so the video shows a box for it. Install a font that has it, such as a Noto font for its script, or give --fonts an easyfontkit folder whose font has it, and run again.",
  ]);
  assert.deepEqual(missingNotes([{ letter: "🚀", cue: 4 }]), ["libass draws no color emoji, and this machine has no other font that draws the emoji in caption 4 (🚀) whole, so the video shows a box for it. Leave out --libass to have Chrome draw it."]);
  assert.deepEqual(missingNotes([]), []);
});

test("a letter no font on this machine has is a box without asking fontconfig, so every one is counted, past the 64 letters fontconfig is asked about, as the eighty kanji of a Japanese caption on a machine with no Japanese font are", () => {
  const { assLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const { missingNotes } = require("../skills/easycaptionkit/scripts/lib/caption");
  const four = save("lacks-four.ttf", sfnt(tables()));
  const cyrillic = save("lacks-cyrillic.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x416, 0x416]]) }));
  // fontconfig gives a font without a letter no font has, as it gives
  // one for every letter.
  const asked = [];
  const give = (code) => {
    asked.push(code);
    return { family: "Cyrillic Test", style: "Bold", file: cyrillic, index: 0, outline: true };
  };
  const kanji = Array.from({ length: 80 }, (_, i) => String.fromCodePoint(0x4e00 + i));
  const lacks = (code) => code >= 0x4e00 && code < 0x4e00 + 80;
  const look = { family: "Four", from: "machine", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const words = [...Array.from({ length: 8 }, (_, i) => ({ text: kanji.slice(i * 10, i * 10 + 10).join(""), start: i * 0.5, end: i * 0.5 + 0.5, seg: i, timed: true })), { text: "Ж", start: 4, end: 4.5, seg: 8, timed: true }];
  const cues = buildCues(words, { lines: 1, maxChars: 20, hard: true, duration: 5 });
  assert.equal(cues.length, 9);
  const letters = assLetters(cues, assFont(look, { family: "Four Test", file: four, index: 0 }, { fallback: give, lacks }));
  assert.equal(letters.missing.length, 80);
  assert.deepEqual([...new Set(letters.missing.map((m) => m.letter))], kanji);
  // Ж, the 81st letter the font lacks, is still set in the font that has it.
  assert.deepEqual(letters.fallbacks, [{ family: "Cyrillic Test", letters: 1 }]);
  assert.deepEqual(asked, [0x416], "fontconfig was asked only about the letter a font has");
  assert.deepEqual([letters.total, letters.own], [81, 0]);
  assert.deepEqual(missingNotes(letters.missing), ["No font on this machine that libass can use has 80 letters of captions 1, 2, 3, 4, 5, 6 and 2 more (一 丁 丂 七 丄 丅 丆 万 and 72 more), so the video shows boxes for them. Install a font that has them, such as Noto Sans CJK (fonts-noto-cjk on Debian and Ubuntu), or give --fonts an easyfontkit folder whose font has them, and run again."]);
});

test("a no-break hyphen no font on this machine has is no box where the font has the plain hyphen, which HarfBuzz draws for it, as Liberation Sans has from 2.1; a font with neither shows a box", () => {
  const { assLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const hyphen = save("hyphen-plain.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x41, 0x41], [0x2010, 0x2010]]) }));
  const neither = save("hyphen-none.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x41, 0x41]]) }));
  const look = { family: "Four", from: "machine", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const cues = buildCues([{ text: "A\u2011A", start: 0.5, end: 1, seg: 0, timed: true }], { lines: 1, maxChars: 8, hard: true, duration: 2 });
  const letters = (file) => assLetters(cues, assFont(look, { family: "Four Test", file, index: 0 }, { fallback: () => null, lacks: () => true }));
  assert.deepEqual(letters(hyphen).missing, []);
  assert.equal(letters(hyphen).own, 3);
  assert.deepEqual(letters(neither).missing, [{ letter: "\u2011", cue: 1 }]);
});

test("on macOS and Windows, where fontconfig cannot say which font libass draws an emoji with, the emoji are named as ones that can show as boxes", () => {
  const { assLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const { missingNotes } = require("../skills/easycaptionkit/scripts/lib/caption");
  const { machineFont, fallbackFont } = require("../skills/easycaptionkit/scripts/lib/look");
  const look = { family: "", from: "default", weight: 700, faces: [], textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const words = [{ text: "Ship it today 🚀🔥 👍🏽", start: 0.5, end: 2, seg: 0, timed: true }, { text: "© 2026™", start: 2, end: 3, seg: 1, timed: true }];
  const cues = buildCues(words, { lines: 1, maxChars: 30, hard: true, duration: 4 });
  for (const platform of ["win32", "darwin"]) {
    // The run's own calls, as on that system.
    const font = assFont(look, machineFont("Arial", 700, { platform }), { fallback: (code) => fallbackFont(code, 700, "", { platform }) });
    const letters = assLetters(cues, font);
    assert.deepEqual(letters.missing, [], platform);
    // © and ™ are letters, which Arial has.
    assert.deepEqual(letters.unsure, [{ letter: "🚀", cue: 1 }, { letter: "🔥", cue: 1 }, { letter: "👍🏽", cue: 1 }], platform);
    assert.deepEqual(missingNotes(letters.missing, letters.unsure), ["libass draws no color emoji, so the 3 emoji in caption 1 (🚀 🔥 👍🏽) can show as boxes: nothing on this machine says which font libass draws them with. Leave out --libass to have Chrome draw them."], platform);
  }
  assert.deepEqual(missingNotes([], [{ letter: "🎉", cue: 2 }]), ["libass draws no color emoji, so the emoji in caption 2 (🎉) can show as a box: nothing on this machine says which font libass draws it with. Leave out --libass to have Chrome draw it."]);
});

test("a fonts.css family split into many files, as a site splits a CJK family, has the letters of every file and of every unicode-range, read or not", () => {
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "line", size: 6.5, lines: 2 });
  // Eight files of A, B and C, then a ninth of 日 and 本, all one family at 700.
  const latin = Array.from({ length: 8 }, (_, i) => save(`sliced-${i + 1}.ttf`, sfnt(tables())));
  const kanji = save("sliced-9.ttf", sfnt({ ...tables(), cmap: cmapOf([[0x65e5, 0x65e5], [0x672c, 0x672c]]) }));
  const face = (file, unicodeRange) => ({ family: "Site Gothic", file, name: `files/${path.basename(file)}`, weight: [700, 700], italic: false, unicodeRange });
  const faces = [...latin.map((file) => face(file, "U+0041-0043")), face(kanji, "U+3000-30FF, U+4E00-9FFF")];
  const look = { family: "Site Gothic", from: "fonts.css", weight: 700, faces, textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  const asked = [];
  const give = (code) => {
    asked.push(code);
    return null;
  };
  const words = [{ text: "AB", start: 0.5, end: 1, seg: 0, timed: true }, { text: "日本", start: 1, end: 1.5, seg: 0, timed: true }];
  const cues = buildCues(words, { lines: 2, maxChars: 14, hard: false, duration: 3 });
  const line = (font) => ass(cues, words, { states: states(cues, words, "line"), style: "line", look, place, font }).split("\n").find((l) => l.startsWith("Dialogue:")).split(",,0,0,0,,")[1];
  const font = assFont(look, null, { fallback: give });
  assert.equal(line(font), "AB日本");
  assert.equal(font.advance("日"), 0.6, "日 takes its width from the ninth file");
  assert.deepEqual(asked, [], "no letter of the family is asked of fontconfig");
  assert.deepEqual(fallbackLetters(cues, font), []);
  // A file not read, past what is read of a family, or one that is no font,
  // still has the letters of its unicode-range.
  const unread = assFont(look, null, { fallback: give, budget: fs.statSync(latin[0]).size });
  assert.equal(line(unread), "AB日本");
  assert.ok(Number.isNaN(unread.advance("日")));
  const broken = save("sliced-broken.woff2", Buffer.from("not a font"));
  assert.equal(line(assFont({ ...look, faces: [...faces.slice(0, 8), face(broken, "U+4E00-9FFF")] }, null, { fallback: give })), "AB日本");
  assert.deepEqual(asked, []);
  // A letter in no file's range is the font's to lack, and fontconfig is asked for it.
  const kana = [{ text: "AB", start: 0.5, end: 1, seg: 0, timed: true }, { text: "か", start: 1, end: 1.5, seg: 0, timed: true }];
  const kanaCues = buildCues(kana, { lines: 2, maxChars: 14, hard: false, duration: 3 });
  fallbackLetters(kanaCues, assFont({ ...look, faces: faces.slice(0, 8) }, null, { fallback: give }));
  assert.deepEqual(asked, [0x304b]);
});

test("what a fonts.css family's files unpack to counts against what is read of it, and a font keeps none of what it unpacked", () => {
  // Five files of one family, a letter each, each a few kilobytes that unpack to 10 MB.
  const letters = ["日", "本", "人", "字", "幕"];
  const files = letters.map((c, i) => save(`unpacks-${i + 1}.woff2`, woff2({ ...tables(), cmap: cmapOf([[c.codePointAt(0), c.codePointAt(0)]]) }, 10 << 20)));
  for (const file of files) assert.ok(fs.statSync(file).size < 64 * 1024, `${path.basename(file)} is ${fs.statSync(file).size} bytes`);
  const read = readFont(files[0]);
  assert.ok(read, "the file reads");
  assert.equal(read.advance("日"), 0.6);
  const look = { family: "Site Gothic", from: "fonts.css", weight: 700, textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, tool: "easycaptionkit test" };
  look.faces = files.map((file, i) => ({ family: "Site Gothic", file, name: `files/${path.basename(file)}`, weight: [700, 700], italic: false, unicodeRange: `U+${letters[i].codePointAt(0).toString(16)}` }));
  // Within 32 MB, three files are read, and the letters of the others are still the family's.
  const font = assFont(look, null, { fallback: () => null });
  assert.deepEqual(letters.map((c) => font.advance(c)), [0.6, 0.6, 0.6, NaN, NaN]);
  assert.deepEqual(letters.map((c) => font.has(c)), [true, true, true, true, true]);
  // Read and kept, ten such fonts keep no more than a few kilobytes each.
  const kept = require("node:child_process").spawnSync(process.execPath, ["--expose-gc", "-e", `
    const { readFont } = require(${JSON.stringify(require.resolve("../skills/easycaptionkit/scripts/lib/fontfile"))});
    const fonts = Array.from({ length: 10 }, (_, i) => readFont(${JSON.stringify(files[0])}));
    // What is no longer held goes once the collector has run and a moment has passed.
    (async () => {
      for (let i = 0; i < 2; i++) {
        globalThis.gc();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      process.stdout.write(JSON.stringify({ read: fonts.filter(Boolean).length, mb: process.memoryUsage().arrayBuffers / 1048576 }));
    })();
  `], { encoding: "utf8" });
  assert.equal(kept.status, 0, kept.stderr);
  const { read: count, mb } = JSON.parse(kept.stdout);
  assert.equal(count, 10);
  assert.ok(mb < 5, `ten fonts keep ${mb.toFixed(1)} MB`);
});

test("the width libass is told to fit is estimated from each letter of the font, so a line in capitals is drawn smaller where the same in small letters fits", () => {
  const place = captionLayout(1080, 1920, ["tiktok", "reels", "shorts"], { style: "line", size: 6.5, lines: 2 });
  const line = (text) => [{ first: 0, last: 0, lines: [text] }];
  const words = [{ text: "x", start: 0, end: 1 }];
  // 14 letters, as many as the lines are cut to here: in small letters they fit, in capitals they do not.
  assert.equal(charsThatFit(place.glyphWidth, place.fontPx), 14);
  const lower = "now we make it";
  const upper = lower.toUpperCase();
  assert.equal(estimatedScales(line(lower), words, { style: "line", place })[0], 1);
  const scale = estimatedScales(line(upper), words, { style: "line", place })[0];
  const wide = [...upper].reduce((sum, c) => sum + ARIAL.advance(c), 0) * place.fontPx;
  assert.ok(wide > place.glyphWidth, `${wide} px in ${place.glyphWidth}`);
  assert.equal(scale, place.glyphWidth / wide);
  // A letter the font has not is taken by its base letter, a wide one as an em and more.
  const accents = estimatedScales(line("ÉÉÉÉÉÉÉÉÉÉÉÉÉÉ"), words, { style: "line", place })[0];
  assert.equal(accents, estimatedScales(line("EEEEEEEEEEEEEE"), words, { style: "line", place })[0]);
  assert.ok(accents < 1);
  // A wide letter the font has not, as Arial has no Japanese, is taken as two columns of 0.6 of an em: seven fit, eight do not.
  assert.equal(estimatedScales(line("日本語の字幕で"), words, { style: "line", place })[0], 1);
  assert.ok(estimatedScales(line("日本語の字幕です"), words, { style: "line", place })[0] < 1);
});
