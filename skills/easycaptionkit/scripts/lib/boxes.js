"use strict";

// The letters a video shows as boxes. Chrome draws a letter it finds no
// font for with the missing glyph of the first font of the list, a box,
// and names that font as the one that drew it: on an Ubuntu with no
// Japanese font, Liberation Sans for every letter of a Japanese caption.
// So each font Chrome names is asked whether it has each letter, a font
// of fonts.css through its own files and any other through the letters
// fontconfig lists for it, and a letter none of them has is a box. libass
// looks through fontconfig for a font for each letter its own font lacks,
// and draws a box where no font on the machine has one. Without
// fontconfig, as on macOS and Windows, nothing here can say, and nothing
// is said.

const { spawnSync } = require("node:child_process");
const { clusters } = require("./text");
const { fcName } = require("./look");

// What fc-list prints for a pattern in a format, or "" where there is no
// fc-list or it fails. The letters of every font of a machine with many
// fonts take some megabytes.
function fcList(pattern, format) {
  let r;
  try {
    r = spawnSync("fc-list", ["-f", format, ...(pattern ? [pattern] : [])], { encoding: "utf8", timeout: 20_000, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return "";
  }
  return r.error || r.status !== 0 ? "" : r.stdout || "";
}

// The code points of fontconfig's charsets, as it prints them ("20-7e
// a0-17f 192"), all of them together, as a lookup: has(code). The ranges
// are put in order and joined, and a code point is found by halves.
function letterSet(charsets) {
  const ranges = [];
  for (const charset of charsets) {
    for (const part of charset.split(/\s+/)) {
      const m = /^([0-9a-f]{1,6})(?:-([0-9a-f]{1,6}))?$/i.exec(part);
      if (m) ranges.push([parseInt(m[1], 16), parseInt(m[2] || m[1], 16)]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const starts = [];
  const ends = [];
  for (const [from, to] of ranges) {
    const last = ends.length - 1;
    if (last >= 0 && from <= ends[last] + 1) ends[last] = Math.max(ends[last], to);
    else {
      starts.push(from);
      ends.push(to);
    }
  }
  return (code) => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= code) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 && code <= ends[found];
  };
}

// The letters a font Chrome names has, as fontconfig lists them for its
// PostScript name, else for its family: has(code), or null where
// fontconfig gives nothing for it or cannot be asked. `list` stands in
// for fc-list in the tests.
function fontLetters({ family = "", postScriptName = "" }, { platform = process.platform, list = fcList } = {}) {
  if (platform !== "linux") return null;
  const charsets = (pattern) => list(pattern, "%{charset}\\n").split("\n").filter((line) => line.trim());
  let found = postScriptName ? charsets(`:postscriptname=${fcName(postScriptName)}`) : [];
  if (!found.length && family) found = charsets(`:family=${fcName(family)}`);
  return found.length ? letterSet(found) : null;
}

// The letters of every font on this machine, as fontconfig lists them:
// has(code), or null where fontconfig cannot be asked. libass finds a
// font through fontconfig for a letter its own font lacks, among all of
// them, so a letter none of them has is a box.
function machineLetters({ platform = process.platform, list = fcList } = {}) {
  if (platform !== "linux") return null;
  const text = list("", "%{charset}\\n");
  return text.trim() ? letterSet(text.split("\n")) : null;
}

// A letter as a reader sees it, one or more code points, is in a font
// when the font has each of them but those that draw nothing (a joiner, a
// variation selector, the object mark U+FFFC), as they are, composed or
// decomposed: HarfBuzz draws é from e and its accent in a font that has
// only those, and a no-break hyphen with the plain one of a font that has
// only that, as Liberation Sans is from version 2.1.
const DRAWS_NOTHING = /^[\p{Default_Ignorable_Code_Point}\ufffc]$/u;
function hasLetter(has, letter) {
  for (const form of new Set([letter, letter.normalize("NFC"), letter.normalize("NFD"), letter.replace(/\u2011/g, "\u2010")])) {
    if (Array.from(form).every((p) => DRAWS_NOTHING.test(p) || has(p))) return true;
  }
  return false;
}

// The letters of `letters` Chrome drew as boxes: those no font it names
// for them has, of [{ family, postScriptName, custom, glyphs }]. A font of
// fonts.css, which Chrome names as custom, is asked through `kit(c)`,
// kitLetters' answer for a code point. Where a font named cannot be asked,
// as without fontconfig, or Chrome names none, nothing can say: none.
// `lookUp` stands in for fontLetters in the tests.
function chromeBoxes(letters, fonts, { kit = null, lookUp = fontLetters } = {}) {
  const drew = fonts.filter((font) => font.glyphs > 0);
  if (!drew.length) return [];
  const asks = [];
  for (const font of drew) {
    if (font.custom) {
      if (!kit) return [];
      asks.push(kit);
      continue;
    }
    const has = lookUp(font);
    if (!has) return [];
    asks.push((p) => has(p.codePointAt(0)));
  }
  return letters.filter((letter) => !/^\s+$/.test(letter) && !asks.some((has) => hasLetter(has, letter)));
}

// Each letter of the captions that is one of `boxed`, with the number of
// its caption: [{ letter, cue }], as assLetters gives the ones libass has
// no font for.
function boxesIn(cues, boxed) {
  const set = new Set(boxed);
  if (!set.size) return [];
  const out = [];
  for (const cue of cues) for (const line of cue.lines) for (const c of clusters(line)) if (set.has(c)) out.push({ letter: c, cue: cue.n });
  return out;
}

module.exports = { fcList, letterSet, fontLetters, machineLetters, hasLetter, chromeBoxes, boxesIn };
