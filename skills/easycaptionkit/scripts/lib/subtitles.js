"use strict";

// captions.srt, captions.vtt and captions.ass from the cues. SRT and VTT
// carry the text and the times, for the places that take a captions file
// (YouTube, LinkedIn, X, Vimeo, a web page's <track>). The ASS file also
// carries the look: the font, the colors, the outline or the box and
// where the captions sit, so a player that reads ASS (VLC, mpv) or
// ffmpeg's ass filter draws them close to the burned ones.

const { cueLines } = require("./cues");
const { width, clusters, ARABIC, RTL } = require("./text");
const { readFont, loadFont, assScale } = require("./fontfile");

const pad = (n, size = 2) => String(n).padStart(size, "0");

function clock(t, separator) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

// SRT has no way to escape: its readers take <...> for a tag and {...}
// for an ASS override, and those that turn it into ASS (ffmpeg, mpv) take
// \N for a line break. These stand in for them, as in captions.ass, so the
// words read the same in every player.
const escapeSrt = (text) => text.replace(/</g, "‹").replace(/>/g, "›").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\\/g, "⧵");
const SRT_SPECIAL = /[<>{}\\]/;

function srt(cues) {
  return cues.map((cue, i) => `${i + 1}\n${clock(cue.start, ",")} --> ${clock(cue.end, ",")}\n${cue.lines.map(escapeSrt).join("\n")}\n`).join("\n");
}

const escapeVtt = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A line break ends a NOTE, so none goes in one.
const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f]+/g, " ");

function vtt(cues, { note = "" } = {}) {
  const head = note ? `WEBVTT\n\nNOTE ${oneLine(note).replace(/-->/g, "->")}\n` : "WEBVTT\n";
  return `${head}\n${cues.map((cue, i) => `${i + 1}\n${clock(cue.start, ".")} --> ${clock(cue.end, ".")}\n${cue.lines.map(escapeVtt).join("\n")}\n`).join("\n")}`;
}

// ─── ASS ──────────────────────────────────────────────────────────────────

// ASS times are centiseconds: H:MM:SS.cc.
function assClock(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

// #rrggbb with an opacity 0 to 1 as ASS writes colors: &HAABBGGRR, where
// AA is transparency.
function assColor(hex, opacity = 1) {
  const [r, g, b] = rgbHex(hex);
  const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, "0");
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

// The same color in an override tag, which takes no transparency:
// &HBBGGRR&.
function assTag(hex) {
  const [r, g, b] = rgbHex(hex);
  return `&H${b}${g}${r}&`.toUpperCase();
}

function rgbHex(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [m[1], m[2], m[3]] : ["ff", "ff", "ff"];
}

// A color at a share of its signal: what the captions drawn by Chrome get
// on an HDR video, where white would otherwise be the brightest white the
// screen can show.
function dimmed(hex, level) {
  if (level >= 1) return hex;
  return `#${rgbHex(hex).map((c) => Math.round(parseInt(c, 16) * level).toString(16).padStart(2, "0")).join("")}`;
}

// ASS has no way to show a literal brace or backslash in all players;
// these stand in for them.
const escapeAss = (text) => text.replace(/\\/g, "⧵").replace(/\{/g, "(").replace(/\}/g, ")");

// ─── the font captions.ass names ─────────────────────────────────────────

// Arial Bold's widths in thousandths of an em, from the space to the
// tilde: Helvetica Bold's, which Liberation Sans Bold shares too.
const ARIAL_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Arial's OS/2 winAscent and winDescent over its em, as Liberation Sans has
// them too: libass makes a font that tall for its size.
const arialAdvance = (c) => (c.length === 1 && c >= " " && c <= "~" ? ARIAL_BOLD[c.charCodeAt(0) - 32] / 1000 : NaN);
const ARIAL = { scale: (1854 + 434) / 2048, advance: arialAdvance, has: (c) => Number.isFinite(arialAdvance(c)), from: "Arial", family: "" };

// A name a Style line can carry: it ends at a line break and its fields
// at commas.
const styleName = (name) => Boolean(name) && !/[\u0000-\u001f\u007f,]/.test(name);

// The font captions.ass names, as libass will make it: { scale, advance,
// has, from, family }. scale is the ASS size whose em is one pixel,
// advance(c) a letter's width in ems, NaN for one the font does not have
// or whose file was not read, and has(c) whether the letter is the font's.
// From the font's own files where they are known: the faces of fonts.css
// nearest the weight, each file for the letters it has, as a site splits a
// family by script; else the file fontconfig gives for the name,
// `machine`. Else Arial's, which libass draws when no font is named.
// family is the name captions.ass gives a fonts.css font: the one in its
// file, which libass finds a file of its fonts folder by, and which
// fonts.css can give otherwise (easyfontkit calls InterVariable Inter).
// Empty when the file gives no name a Style line can carry, or the font is
// not from fonts.css.
//
// `fallback(codePoint)` gives the font fontconfig gives for a letter the
// font lacks, { family, file, index, outline }, which libass draws it
// with. libass sizes each font by its own heights, so captions.ass sets
// those letters in that font at a size of its own: the font then has
// `fallback(c)`, the font a letter is set in, { family, scale, advance },
// or null.
function assFont(look, machine = null, { fallback = null, budget = BUDGET } = {}) {
  const upright = (look.faces || []).filter((f) => !f.italic);
  const faces = upright.length ? upright : look.faces || [];
  const nearest = faces.length ? Math.min(...faces.map((f) => distance(f, look.weight))) : 0;
  const files = faces.filter((f) => distance(f, look.weight) === nearest);
  const kit = files.length ? familyOf(files, budget) : null;
  const first = kit ? kit.first : machine ? readFont(machine.file, machine.index) : null;
  const scale = first ? assScale(first) : 0;
  if (!(scale > 0.5 && scale < 3)) return ARIAL;
  const advance = kit ? kit.advance : first.advance;
  const has = kit ? kit.has : (c) => Number.isFinite(first.advance(c));
  const own = kit ? kit.family : "";
  const font = { scale, advance, has, from: files.length ? files[0].name || files[0].file : machine.file, family: styleName(own) ? own : "" };
  if (fallback) font.fallback = fallbacksOf(fallback);
  return font;
}

// What is read of a fonts.css family's files in all, at most, counting
// what WOFF and WOFF2 files unpack to: a site splits a CJK family into a
// hundred files and more, each small, and a file of a few hundred bytes
// can say it unpacks to many megabytes.
const BUDGET = 32 * 1024 * 1024;

// A unicode-range as [first, last] pairs, or null for none, which covers
// every letter: U+0025-00FF, U+4??, U+3000.
function rangesOf(text) {
  if (!text) return null;
  return String(text)
    .split(",")
    .map((part) => /^\s*U\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part))
    .filter(Boolean)
    .map((m) => [parseInt(m[1].replace(/\?/g, "0"), 16), m[2] ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, "f"), 16)]);
}

// The files of a fonts.css family at one weight, each read once a letter
// in its unicode-range is asked for, as Chrome loads them, and no more than
// `budget` bytes of them in all, files and what they unpack to. { first,
// family, advance, has }: the first file that reads, which gives the size,
// and the family name in it or in the next file that has one. A letter in
// the range of a file that was not read, or is no font this kit reads, is
// the family's still: libass finds that file by its name.
function familyOf(faces, budget) {
  const list = faces.map((face) => ({ face, ranges: rangesOf(face.unicodeRange), font: undefined }));
  let left = budget;
  const fontOf = (item) => {
    if (item.font !== undefined) return item.font;
    const { font, size } = loadFont(item.face.file, 0, left);
    left -= size;
    item.font = font;
    return item.font;
  };
  const inRange = (item, code) => !item.ranges || item.ranges.some(([a, b]) => code >= a && code <= b);
  // Each letter once: a family of many files has many ranges to look in.
  const known = new Map();
  const lookUp = (c) => {
    const code = c.codePointAt(0);
    if (known.has(code)) return known.get(code);
    let found = { advance: NaN, has: false };
    for (const item of list) {
      if (!inRange(item, code)) continue;
      const font = fontOf(item);
      const w = font ? font.advance(c) : NaN;
      if (Number.isFinite(w)) {
        found = { advance: w, has: true };
        break;
      }
      if (!font && item.ranges) found.has = true;
    }
    known.set(code, found);
    return found;
  };
  let first = null;
  let family = "";
  for (const item of list) {
    const font = fontOf(item);
    if (font && !first) first = font;
    if (font && font.family) family = font.family;
    if (first && family) break;
  }
  return { first, family, advance: (c) => lookUp(c).advance, has: (c) => lookUp(c).has };
}

// A name an override tag can carry: it ends at a backslash or a brace.
const tagName = (name) => styleName(name) && !/[\\{}]/.test(name);

// The marks that join or vary the letter before them and draw nothing of
// their own: the zero width joiners, the variation selectors and the tags
// of a flag.
const JOINER = /^[\u200c\u200d\ufe00-\ufe0f\u{e0020}-\u{e007f}\u{e0100}-\u{e01ef}]$/u;
const NONE = Object.freeze({ none: true });

// The fonts given for the letters a font lacks, each read once: a letter
// a font found already has is set in it, and fontconfig is asked about a
// letter once, and about 64 at most. An Arabic letter is set only in a
// font found for an Arabic letter, from the Arabic families Chrome draws
// them with, and not in one found for an arrow, say, that has them too. A
// letter of several, as an emoji with its skin tone is, goes in a font
// that has them all. libass draws no font of pictures alone, as a color
// emoji font is, and fontconfig gives a font that lacks a letter only
// when no font has it: `none(c)` says fontconfig gives no font libass can
// draw the letter with, so libass draws a box for it.
function fallbacksOf(give) {
  const found = [];
  const asked = new Map();
  const fontFor = (first, arabic) => {
    const code = first.codePointAt(0);
    if (asked.has(code)) return asked.get(code);
    if (asked.size >= 64) return null;
    const given = give(code);
    let got = null;
    if (given && given.outline === false) got = NONE;
    else if (given && tagName(given.family)) {
      const font = readFont(given.file, given.index);
      const scale = font ? assScale(font) : 0;
      if (font && scale > 0.5 && scale < 3) got = Number.isFinite(font.advance(first)) ? { family: given.family, scale, advance: font.advance, arabic } : NONE;
    }
    if (got && got !== NONE) found.push(got);
    asked.set(code, got);
    return got;
  };
  // The font for a letter, NONE, or null where nothing can say.
  const settle = (c) => {
    const points = Array.from(c).filter((p) => !JOINER.test(p));
    if (!points.length) return null;
    const arabic = ARABIC.test(points[0]);
    const all = (f) => points.every((p) => Number.isFinite(f.advance(p)));
    for (const f of found) if (f.arabic === arabic && all(f)) return f;
    const got = fontFor(points[0], arabic);
    return got && got !== NONE && !all(got) ? NONE : got;
  };
  const fallback = (c) => {
    const got = settle(c);
    return got === NONE ? null : got;
  };
  fallback.none = (c) => settle(c) === NONE;
  return fallback;
}

// The font a letter is set in: null for the font itself, which has it,
// else the one given for it. A space stays in the font of what is around
// it.
function setIn(c, font, now) {
  if (/^\s+$/.test(c)) return now;
  if (!font.fallback || font.has(Array.from(c)[0])) return null;
  return font.fallback(c);
}

const distance = (face, weight) => (weight < face.weight[0] ? face.weight[0] - weight : weight > face.weight[1] ? weight - face.weight[1] : 0);

// A line's width in ems: each letter by its width in the font, a letter
// it lacks by its width in the font it is set in, else by its base letter,
// else as the lines are cut, 0.6 of an em a column, so a wide letter of
// Chinese or Japanese is an em and more.
function emsOf(line, font) {
  let ems = 0;
  for (const c of clusters(line)) {
    const first = Array.from(c)[0];
    let w = font.advance(first);
    if (!Number.isFinite(w) && font.fallback) {
      const other = setIn(c, font, null);
      if (other) w = other.advance(first);
    }
    if (!Number.isFinite(w)) w = font.advance(Array.from(c.normalize("NFD"))[0]);
    if (!Number.isFinite(w)) w = width(c) * 0.6;
    ems += w;
  }
  return ems;
}

// How much smaller each caption is drawn so that its widest line, outline
// included, fits the safe space, in the shape Chrome measures them in: a
// scale for each cue, or for each word of a cue in the word style, 1 for
// one that fits. Without Chrome's measure it is an estimate from the
// widths of the letters in the font captions.ass names, leaving kerning
// out, so a line in capitals, which are wider than the lines are cut for,
// comes out smaller too.
function estimatedScales(cues, words, { style, place, font = ARIAL }) {
  const fit = (lines) => {
    const wide = lines.reduce((most, line) => Math.max(most, emsOf(line, font)), 0) * place.fontPx;
    return wide > place.glyphWidth && wide > 0 ? Math.max(0.01, place.glyphWidth / wide) : 1;
  };
  return cues.map((cue) => (style === "word" ? words.slice(cue.first, cue.last + 1).map((w) => fit([w.text])) : fit(cue.lines)));
}

// How many captions (or words, in the word style) are drawn smaller, and
// the smallest scale.
function shrunkOf(scales) {
  const all = scales.flat();
  return { count: all.filter((x) => x < 1).length, smallest: all.reduce((a, b) => Math.min(a, b), 1) };
}

// One Dialogue line per state: a whole cue for the line style, the cue
// with its spoken word in the highlight color for karaoke, a word alone,
// lit the same way, for the word style. `level` dims every color, for
// the burn of an HDR video. `scales` makes a caption smaller, as the
// burned ones are; without it, the estimate above does. The font's size
// gives it an em of the layout's letter size, as Chrome draws it: libass
// makes a font as tall as its OS/2 heights, not its em, which for Arial
// is 1.12 of the em and for other fonts up to 1.4 and more. `matrix` is
// the YCbCr Matrix line, which players and ffmpeg 8's ass filter convert
// the colors with: the video's own matrix and range (colorOf), else what
// players take for the frame's size. `tint` gives the color written for
// each color, for an ass filter that converts every color as BT.601 does.
function ass(cues, words, { states, style, look, place, title = "", level = 1, scales = null, font = ARIAL, matrix = "", tint = null }) {
  const sizes = scales || estimatedScales(cues, words, { style, place, font });
  const { width: W, height: H } = place.frame;
  const size = Math.round(place.fontPx * font.scale);
  const outline = look.box ? 0 : Math.max(1, Math.round(place.fontPx * 0.09));
  const border = look.box ? Math.round(place.fontPx * 0.18) : outline;
  const shadow = look.box ? 0 : 2;
  const paint = (hex) => (tint ? tint(hex) : hex);
  const text = paint(dimmed(look.textColor, level));
  const primary = assColor(text);
  const outlineColor = look.box ? assColor("#000000", look.boxOpacity) : assColor("#000000");
  const back = assColor("#000000", look.box ? look.boxOpacity : 0.45);
  const borderStyle = look.box ? 3 : 1;
  const side = Math.round(place.side);
  // Where the block sits: its bottom edge, its middle or its top edge. The
  // outline or the box, and the shadow under it, reach past the letters'
  // lines, so they are kept inside the block too.
  const alignment = place.position === "top" ? 8 : place.position === "middle" ? 5 : 2;
  const marginV = place.position === "top" ? Math.round(place.blockTop) + border : Math.round(H - place.blockBottom) + border + shadow;
  const lit = assTag(paint(dimmed(look.highlight, level)));
  const plain = assTag(text);
  // The spoken word: in its color, or, when the color is too dark for
  // letters, as letters in the ink color with a thick border of it, which
  // is as close to the burned patch as ASS comes.
  const patch = look.highlightMode === "patch";
  const thick = Math.max(4, Math.round(place.fontPx * 0.16));
  const on = patch ? `{\\1c${assTag(paint(dimmed(look.highlightInk, level)))}\\3c${lit}\\bord${thick}}` : `{\\1c${lit}}`;
  const off = patch ? `{\\1c${plain}\\3c${assTag("#000000")}\\bord${border}}` : `{\\1c${plain}}`;
  // A Style line ends at a line break and its fields at commas.
  const family = (font.family || look.family || "Arial").replace(/[\u0000-\u001f\u007f,]/g, " ");
  // A run of letters the font lacks goes in the font given for them, at
  // the size that gives it the same em, and back after; where the name of
  // the font cannot go in an override tag, the letters stay as they are.
  const switching = Boolean(font.fallback) && tagName(family);
  const home = `{\\fn${family}\\fs${size}}`;
  // libass lays every line out from left to right unless the style's
  // Encoding is -1, its own value for taking each line's direction from
  // its first letter, as Chrome's dir="auto" does. Laid out from the left,
  // a line of Arabic or Hebrew has its full stop or comma at its right
  // end, which is where it starts, and a Latin word in it puts the words
  // around it in the wrong order. VSFilter reads the field as a Windows
  // character set, so -1 goes only into captions that need it.
  const encoding = cues.some((cue) => cue.lines.some((line) => RTL.test(line))) ? -1 : 1;
  const head = [
    "[Script Info]",
    `; Written by ${look.tool}. The same captions as the burned ones, with the same look where ASS allows it.`,
    ...(title ? [`Title: ${title.replace(/[\u0000-\u001f\u007f]+/g, " ")}`] : []),
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `YCbCr Matrix: ${matrix || (H >= 720 ? "TV.709" : "TV.601")}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Caption,${family},${size},${primary},${primary},${outlineColor},${back},${look.weight >= 600 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${border},${shadow},${alignment},${side},${side},${marginV},${encoding}`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const position = alignment === 5 ? `{\\an5\\pos(${Math.round(W / 2)},${Math.round((place.blockTop + place.blockBottom) / 2)})}` : "";
  // Each cue's lines as words, set once; a state only colors one of them.
  const set = new Map();
  const linesOf = (c) => {
    if (!set.has(c)) set.set(c, cueLines(cues[c], words).map((line) => line.map((w) => ({ ...w, t: escapeAss(w.t) }))));
    return set.get(c);
  };
  // The letters of a word, split once: karaoke gives each word of a caption
  // again for every word lit in it.
  const split = new Map();
  const lettersOf = (text) => {
    if (!split.has(text)) split.set(text, clusters(text));
    return split.get(text);
  };
  // An event's text from its lines, each a list of pieces { text, lit }:
  // the spoken word colored, and each run of letters the font lacks set
  // in the font given for them.
  const textOf = (lines) => {
    let out = "";
    let lighting = false;
    let now = null;
    lines.forEach((line, n) => {
      if (n) out += "\\N";
      for (const piece of line) {
        if (piece.lit !== lighting) {
          out += piece.lit ? on : off;
          lighting = piece.lit;
        }
        if (!switching) {
          out += piece.text;
          continue;
        }
        for (const c of lettersOf(piece.text)) {
          const want = setIn(c, font, now);
          if (want !== now) {
            out += want ? `{\\fn${want.family}\\fs${Math.round(place.fontPx * want.scale)}}` : home;
            now = want;
          }
          out += c;
        }
      }
    });
    return lighting ? out + off : out;
  };
  const events = [];
  for (const state of states) {
    const cue = cues[state.cue];
    const scale = style === "word" ? sizes[state.cue][state.word] : sizes[state.cue];
    // In whole percent, rounded down, so it still fits.
    const smaller = scale < 1 ? `{\\fscx${Math.max(1, Math.floor(scale * 100))}\\fscy${Math.max(1, Math.floor(scale * 100))}}` : "";
    let lines;
    if (style === "word") lines = [[{ text: escapeAss(words[cue.first + state.word].text), lit: true }]];
    // Each line's words, the spoken one colored.
    else if (style === "karaoke" && state.word >= 0) lines = linesOf(state.cue).map((line) => line.flatMap((w) => [...(w.s ? [{ text: " ", lit: false }] : []), { text: w.t, lit: w.i === state.word }]));
    else lines = cue.lines.map((line) => [{ text: escapeAss(line), lit: false }]);
    events.push(`Dialogue: 0,${assClock(state.from)},${assClock(state.to)},Caption,,0,0,0,,${position}${smaller}${textOf(lines)}`);
  }
  return `${head.join("\n")}\n${events.join("\n")}\n`;
}

// An emoji as an emoji, in color where the font has it: one shown so by
// default, one asked for so, or a flag. A © or a ™ is a letter.
const SHOWN_AS_EMOJI = /\p{Emoji_Presentation}|\ufe0f|\p{Regional_Indicator}/u;

// How captions.ass sets the letters of the captions, the spaces left out:
// { total, own, fallbacks, missing, unsure }. own is how many are in the
// font it names, or where nothing says otherwise; fallbacks the fonts it
// sets the others in, [{ family, letters }]; missing each letter for which
// libass has no font, [{ letter, cue }], with the number of its caption;
// unsure each emoji the font lacks that nothing says the font of, as on
// macOS and Windows, where there is no fontconfig to ask.
function assLetters(cues, font) {
  const counts = new Map();
  const missing = [];
  const unsure = [];
  let total = 0;
  let own = 0;
  for (const cue of cues) {
    for (const line of cue.lines) {
      for (const c of clusters(line)) {
        if (/^\s+$/.test(c)) continue;
        total++;
        const lacks = !font.has(Array.from(c)[0]);
        const other = setIn(c, font, null);
        if (other) counts.set(other.family, (counts.get(other.family) || 0) + 1);
        else if (font.fallback && lacks && font.fallback.none(c)) missing.push({ letter: c, cue: cue.n });
        else {
          own++;
          if (lacks && SHOWN_AS_EMOJI.test(c)) unsure.push({ letter: c, cue: cue.n });
        }
      }
    }
  }
  return { total, own, fallbacks: [...counts].map(([family, letters]) => ({ family, letters })), missing, unsure };
}

// The letters of the captions set in another font than the one captions.ass
// names, by that font: [{ family, letters }].
const fallbackLetters = (cues, font) => assLetters(cues, font).fallbacks;

module.exports = { srt, vtt, ass, assFont, estimatedScales, shrunkOf, assLetters, fallbackLetters, clock, assClock, assColor, assTag, dimmed, escapeSrt, SRT_SPECIAL, ARIAL };
