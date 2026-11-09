"use strict";

// The look of the captions from the product's own kit: the font files
// easyfontkit saved (fonts.css, and fonts.json for each family's license),
// and the colors easybrandkit read (brand.json, or _brand.yml). Without
// them the captions are white, bold and outlined, in a common sans.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { readAtMost, sizeText } = require("./files");
const { ARABIC: ARABIC_LETTER } = require("./text");

const DEFAULT_HIGHLIGHT = "#ffd23f";
// The emoji fonts come before Noto Sans and DejaVu Sans, which draw some
// emoji in black and white: 😀 would be an outline next to a 👍 in color.
const EMOJI = ['"Noto Color Emoji"', '"Apple Color Emoji"', '"Segoe UI Emoji"'];
const LATIN = ['"Helvetica Neue"', "Helvetica", "Arial", '"Liberation Sans"'];
const REST = ['"Noto Sans"', '"DejaVu Sans"', "sans-serif"];
// The CJK families of each language on Linux, macOS and Windows. Named in
// the list, they are matched with the weight asked for; letters left to
// the system's own fallback come in its regular face, which no bold is
// made of, as font-synthesis is off.
const CJK = {
  ja: ['"Noto Sans CJK JP"', '"Noto Sans JP"', '"Hiragino Sans"', '"Hiragino Kaku Gothic ProN"', '"Yu Gothic"', "Meiryo"],
  ko: ['"Noto Sans CJK KR"', '"Noto Sans KR"', '"Apple SD Gothic Neo"', '"Malgun Gothic"'],
  "zh-Hans": ['"Noto Sans CJK SC"', '"Noto Sans SC"', '"PingFang SC"', '"Microsoft YaHei"'],
  "zh-Hant": ['"Noto Sans CJK TC"', '"Noto Sans TC"', '"PingFang TC"', '"Microsoft JhengHei"'],
};
// The Arabic script's families on Linux, macOS and Windows, for words in
// Arabic, Persian or Urdu, named for the same reason: Chrome's fallback
// on Ubuntu 22.04 gives Noto Kufi Arabic's regular face for them.
const ARABIC = ['"Noto Sans Arabic"', '"Noto Naskh Arabic"', '"Geeza Pro"', '"Segoe UI"'];
// The families of the scripts of India and Southeast Asia on Linux, macOS
// and Windows, named when the words hold letters of their script, for the
// same reason: Chrome's fallback gives Noto Sans Devanagari's, Bengali's
// or Thai's regular face though its bold is there.
const SCRIPT_FAMILIES = {
  Devanagari: ['"Noto Sans Devanagari"', '"Kohinoor Devanagari"', '"Devanagari Sangam MN"', '"Nirmala UI"'],
  Bengali: ['"Noto Sans Bengali"', '"Kohinoor Bangla"', '"Bangla Sangam MN"', '"Nirmala UI"'],
  Gurmukhi: ['"Noto Sans Gurmukhi"', '"Gurmukhi Sangam MN"', '"Nirmala UI"'],
  Gujarati: ['"Noto Sans Gujarati"', '"Kohinoor Gujarati"', '"Gujarati Sangam MN"', '"Nirmala UI"'],
  Oriya: ['"Noto Sans Oriya"', '"Oriya Sangam MN"', '"Nirmala UI"'],
  Tamil: ['"Noto Sans Tamil"', '"Tamil Sangam MN"', '"Nirmala UI"'],
  Telugu: ['"Noto Sans Telugu"', '"Kohinoor Telugu"', '"Telugu Sangam MN"', '"Nirmala UI"'],
  Kannada: ['"Noto Sans Kannada"', '"Kannada Sangam MN"', '"Nirmala UI"'],
  Malayalam: ['"Noto Sans Malayalam"', '"Malayalam Sangam MN"', '"Nirmala UI"'],
  Sinhala: ['"Noto Sans Sinhala"', '"Sinhala Sangam MN"', '"Nirmala UI"'],
  Thai: ['"Noto Sans Thai"', "Thonburi", '"Leelawadee UI"'],
  Lao: ['"Noto Sans Lao"', '"Lao Sangam MN"', '"Leelawadee UI"'],
  Khmer: ['"Noto Sans Khmer"', '"Khmer Sangam MN"', '"Leelawadee UI"'],
  Myanmar: ['"Noto Sans Myanmar"', '"Myanmar Sangam MN"', '"Myanmar Text"'],
};

// ─── colors ──────────────────────────────────────────────────────────────

// A color as text or a number of six digits, from --highlight or a brand
// kit; anything else a brand.json gives is none.
function parseColor(value) {
  const text = (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : "").trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(text);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  return null;
}

function rgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG contrast ratio, 1 to 21.
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

function hsl(hex) {
  const [r, g, b] = rgb(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

// How the spoken word is lit: in the color itself when it reads against
// the dark outline or box, or on a rounded patch of the color when the
// color is too dark for that (a deep brand green, a navy).
function highlightMode(color, { box = false } = {}) {
  const ground = "#000000";
  if (contrast(color, ground) >= (box ? 3.5 : 4.5) && contrast(color, "#ffffff") >= 1.3) return { mode: "text", ink: color };
  return { mode: "patch", ink: contrast("#ffffff", color) >= 3 ? "#ffffff" : "#000000" };
}

// The brand color that lights words best: a button's, a link's or the
// logo's, saturated and neither near black nor near white.
const ROLE_ORDER = ["button", "link", "logo", "header", "heading", "footer", "surface"];
function brandHighlight(colors) {
  const usable = colors.filter((c) => {
    const { s, l } = hsl(c.hex);
    return s >= 0.25 && l >= 0.12 && l <= 0.9;
  });
  usable.sort((a, b) => rank(a.role) - rank(b.role));
  return usable[0] || null;
}
const rank = (role) => {
  const i = ROLE_ORDER.indexOf(String(role).replace(/-\d+$/, ""));
  return i < 0 ? ROLE_ORDER.length : i;
};

// ─── names from other tools ───────────────────────────────────────────────

// Font names and ranges come from fonts.css and brand.json, which other
// tools read from websites, and they end up in the page that draws the
// captions and in captions.ass. A family name holds no control characters
// and no < or >; a unicode-range is U+ ranges and nothing else.
const fontName = (name) => typeof name === "string" && name.length <= 200 && !/[\u0000-\u001f\u007f<>]/.test(name);
const RANGE = /^U\+[0-9a-f?]{1,6}(?:-[0-9a-f]{1,6})?(?:\s*,\s*U\+[0-9a-f?]{1,6}(?:-[0-9a-f]{1,6})?)*$/i;

// What a name that is no file or folder is: a pipe, a device or a socket.
function notAFile(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    return "";
  }
  if (stat.isFile() || stat.isDirectory()) return "";
  return stat.isFIFO() ? "a pipe" : stat.isSocket() ? "a socket" : "a device";
}

// A file other tools wrote, read whole, as long as it is the size such a
// file has. easybrandkit and easyfontkit write files, and only a file is
// read: a pipe that nothing writes to yet would hold the run in the
// system, where neither Ctrl-C nor a kill reaches it. `kit` says what to
// give instead.
function readSmall(file, what, kit, most = 8 * 1024 * 1024) {
  const odd = notAFile(file);
  if (odd) throw Object.assign(new Error(`${file} is ${odd}, not a file. Give ${kit}`), { code: "ENOTFILE" });
  try {
    return readAtMost(file, most);
  } catch (err) {
    if (err.code === "EFBIG") throw new Error(`${file} is ${sizeText(err, most)}, too big to be ${what}`);
    throw err;
  }
}

// ─── the brand folder ─────────────────────────────────────────────────────

// An easybrandkit folder, its brand.json or its _brand.yml: the name, the
// colors with the role the site gives them and the fonts by name.
function readBrand(given) {
  let file = given;
  if (fs.existsSync(given) && fs.statSync(given).isDirectory()) {
    file = ["brand.json", "_brand.yml", "brand/brand.json"].map((name) => path.join(given, name)).find((f) => fs.existsSync(f));
    if (!file) throw new Error(`${given} holds no brand.json or _brand.yml. Give the folder easybrandkit made, or its brand.json`);
  } else if (!fs.existsSync(given)) throw new Error(`Cannot read ${given}: no such file or folder`);
  const text = readSmall(file, "a brand kit's file", "the folder easybrandkit made, or its brand.json");
  if (/\.ya?ml$/i.test(file)) return { file, ...brandYml(text) };
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${err.message}`);
  }
  if (!object(data)) throw new Error(`Cannot read ${file}: it holds no brand kit`);
  const colors = (Array.isArray(data.colors) ? data.colors : [])
    .map((c) => ({ hex: parseColor(c && c.hex), role: textOf(c && c.role) }))
    .filter((c) => c.hex);
  const fonts = object(data.fonts) ? data.fonts : {};
  return { file, name: textOf(data.name), colors, fonts: { heading: textOf(fonts.heading), body: textOf(fonts.body) } };
}

// A JSON object, not null, a list or a value; and a value that is text.
const object = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOf = (value) => (typeof value === "string" ? value : "");

// The brand's font names that can be used as names; the others are named
// in a note and left out.
function brandFonts(brand, notes) {
  const out = {};
  for (const role of ["heading", "body"]) {
    const name = brand.fonts[role];
    if (name && !fontName(name)) notes.push(`${path.basename(brand.file)} names a ${role} font with characters a font name cannot have, so it was left out.`);
    out[role] = name && fontName(name) ? name : "";
  }
  return out;
}

// The few parts of a brand.yml the captions use: the palette, the theme
// colors and the heading and base fonts.
function brandYml(text) {
  const colors = [];
  const fonts = { heading: "", body: "" };
  let name = "";
  let section = "";
  let sub = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    // The key and the rest of the line, split at the first colon.
    const colon = line.indexOf(":");
    const key = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!/^[\w-]+$/.test(key)) continue;
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    if (indent === 0) {
      section = key;
      sub = "";
      continue;
    }
    if (section === "meta" && key === "name" && indent <= 2) name = value;
    if (section === "color") {
      if (indent === 2) sub = key;
      const hex = parseColor(value);
      if (hex && (sub === "palette" ? indent >= 4 : indent === 2)) colors.push({ hex, role: key === "primary" ? "button" : key });
    }
    if (section === "typography" && indent === 2) {
      if (key === "headings" && value) fonts.heading = value;
      if (key === "base" && value) fonts.body = value;
    }
  }
  return { name, colors, fonts };
}

// ─── fonts.css ────────────────────────────────────────────────────────────

const unquote = (text) => String(text || "").trim().replace(/^["']|["']$/g, "").trim();

function weightRange(value) {
  const text = String(value || "400").trim().toLowerCase();
  const named = { normal: 400, bold: 700, lighter: 300, bolder: 800 };
  const parts = text.split(/\s+/).map((p) => (Object.hasOwn(named, p) ? named[p] : Number(p))).filter(Number.isFinite);
  if (!parts.length) return [400, 400];
  return [Math.min(...parts), Math.max(...parts)];
}

// A url() of fonts.css as a path: percent escapes decoded, or the text as
// it is when a % in it is no escape.
function urlPath(url) {
  const raw = url.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// A font file fonts.css names, as easyfontkit saves them: in the folder of
// fonts.css or under it, reached without a link. { file, name } with the
// whole path (empty when there is no such file) and the name from that
// folder, or null for any other path, which a fonts.css made elsewhere
// could name to have files read from anywhere on the disk; that one is
// left out without looking at it.
function inKit(dir, given) {
  const full = path.resolve(dir, given);
  const rel = path.relative(dir, full);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  const name = rel.split(path.sep).join("/");
  let at = dir;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    const stat = fs.lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return { file: "", name };
    if (stat.isSymbolicLink()) return null;
  }
  return fs.statSync(at).isFile() ? { file: full, name } : { file: "", name };
}

// CSS without its comments: each goes to its first */, or to the end of
// the text when it never closes, as CSS reads it. Each is looked for from
// where the one before ended, so a file of many that never close is read
// once, not again from each.
function withoutComments(css) {
  let out = "";
  let at = 0;
  for (;;) {
    const open = css.indexOf("/*", at);
    if (open < 0) return out + css.slice(at);
    out += css.slice(at, open);
    const close = css.indexOf("*/", open + 2);
    if (close < 0) return out;
    at = close + 2;
  }
}

// easyfontkit's fonts.css: each @font-face with its file in the kit's
// folder, and the family each role (--font-heading, --font-body ...)
// starts with.
function readFontsCss(given) {
  let file = given;
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(given, "fonts.css");
    if (!fs.existsSync(file)) throw new Error(`${given} holds no fonts.css. Give the folder easyfontkit made, or its fonts.css`);
  }
  // A pipe could not carry the font files fonts.css names either: they are
  // next to it.
  let css;
  try {
    css = readSmall(file, "a fonts.css", "the folder easyfontkit made, or its fonts.css with the font files it names next to it");
  } catch (err) {
    throw new Error(err.code === "ENOENT" ? `Cannot read ${file}: no such file` : err.code === "ENOTFILE" || /too big/.test(err.message) ? err.message : `Cannot read ${file}: ${err.message}`);
  }
  css = withoutComments(css);
  const dir = path.dirname(path.resolve(file));
  const faces = [];
  const missing = [];
  const outside = new Set();
  const odd = new Set();
  // A block holds no other brace, and a url() no other bracket, so a file
  // of many that never close is looked at once, not again from each.
  for (const block of css.matchAll(/@font-face\s*\{([^{}]*)\}/gi)) {
    const body = block[1];
    const prop = (name) => (new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(body) || [])[1];
    const family = unquote(prop("font-family"));
    if (!family) continue;
    if (!fontName(family)) {
      odd.add(family);
      continue;
    }
    const urls = [...String(prop("src") || "").matchAll(/url\(([^()]*)\)/gi)].map((m) => unquote(m[1])).filter(Boolean);
    // Only files on this disk, the kit's own: the captions are drawn
    // offline.
    const local = [];
    for (const url of urls.filter((u) => !/^(?:https?:|data:)/i.test(u))) {
      const where = inKit(dir, urlPath(url));
      if (where) local.push(where);
      else outside.add(url);
    }
    const found = local.find((f) => f.file);
    if (!found) {
      if (local.length) missing.push(local[0].name);
      continue;
    }
    // A range the browser would not take is left out, as the browser
    // would leave it out: the face then covers every letter it has.
    const range = String(prop("unicode-range") || "").trim();
    faces.push({
      family,
      file: found.file,
      name: found.name,
      weight: weightRange(prop("font-weight")),
      italic: /italic|oblique/i.test(String(prop("font-style") || "")),
      unicodeRange: RANGE.test(range) ? range : "",
    });
  }
  // Each declaration on its own, so a role whose value never ends is read
  // to the end of its rule once.
  const roles = {};
  for (const declaration of css.split(/[;{}]/)) {
    const m = /^\s*--font-(heading|body|button|code)\s*:(.*)$/is.exec(declaration);
    if (!m) continue;
    const firstFamily = unquote(m[2].split(",")[0]);
    if (firstFamily && fontName(firstFamily) && !roles[m[1].toLowerCase()]) roles[m[1].toLowerCase()] = firstFamily;
  }
  // fonts.json next to it says how each family is licensed. One that is no
  // file is passed over, as one that is not JSON is.
  let kit = null;
  try {
    kit = JSON.parse(readSmall(path.join(dir, "fonts.json"), "a fonts.json", "the folder easyfontkit made"));
  } catch {
    kit = null;
  }
  return { file: path.resolve(file), faces, roles, missing, outside: [...outside], odd: [...odd], kit };
}

// ─── the choice ───────────────────────────────────────────────────────────

// Two font names, the same but for case and the spaces around them. A name
// that is not text, as a fonts.json made elsewhere can give, is no name.
const sameName = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

// The weight to draw with: bold where the family has it, else the
// heaviest it has, so Chrome never fakes a bold.
function pickWeight(faces) {
  const upright = faces.filter((f) => !f.italic);
  const list = upright.length ? upright : faces;
  if (!list.length) return 700;
  if (list.some((f) => f.weight[0] <= 700 && f.weight[1] >= 700)) return 700;
  const heavy = list.filter((f) => f.weight[0] >= 600).sort((a, b) => a.weight[0] - b.weight[0]);
  if (heavy.length) return heavy[0].weight[0];
  return Math.max(...list.map((f) => f.weight[1]));
}

// The font file libass cannot draw at the weight asked for: one face of
// fonts.css for a range of weights (a variable font), when no face has
// that weight alone. libass draws such a file at its default weight, as
// its own, while Chrome picks the weight from the range. Null otherwise.
function variableFace(look) {
  const upright = look.faces.filter((f) => !f.italic);
  const faces = upright.length ? upright : look.faces;
  if (faces.some((f) => f.weight[0] === look.weight && f.weight[1] === look.weight)) return null;
  return faces.find((f) => f.weight[0] < f.weight[1] && f.weight[0] <= look.weight && f.weight[1] >= look.weight) || null;
}

// What fc-match gives for a pattern: { family, style, file, index,
// outline }, outline false for a font of pictures only, such as a color
// emoji font. Null without fc-match, or when it gives no file.
function fcMatch(pattern) {
  let r;
  try {
    r = spawnSync("fc-match", ["-f", "%{family[0]}\t%{style[0]}\t%{file}\t%{index}\t%{outline}", pattern], { encoding: "utf8", timeout: 10_000 });
  } catch {
    return null;
  }
  if (r.error || r.status !== 0 || !r.stdout) return null;
  const [family, style, file, index, outline] = r.stdout.split("\t");
  if (!family || !file || !path.isAbsolute(file)) return null;
  return { family, style: style || "", file, index: Number(index) || 0, outline: outline === "True" };
}

// A family name in a fontconfig pattern, where a backslash, dash, colon or
// comma is escaped; and the weight captions.ass asks for, bold at 600 and
// up.
const fcName = (family) => String(family).replace(/[\\\-:,]/g, "\\$&");
const fcWeight = (weight) => `:weight=${weight >= 600 ? 200 : 80}`;

// The font fontconfig gives for a family name, which is the one libass
// draws with on Linux, where it looks fonts up through fontconfig.
// { family, style, file, index }, or null on other systems, without
// fc-match, or when it gives nothing.
function machineFont(family, weight, { platform = process.platform, match = fcMatch } = {}) {
  if (platform !== "linux") return null;
  const got = match(`${fcName(family)}${fcWeight(weight)}`);
  return got ? { family: got.family, style: got.style, file: got.file, index: got.index } : null;
}

// fontconfig's names of the CJK languages cjkLanguage gives.
const FC_LANG = { ja: "ja", ko: "ko", "zh-Hans": "zh-cn", "zh-Hant": "zh-tw" };

// The families an Arabic letter is looked for in first, in the order of
// the list Chrome draws with: the Arabic ones, then those of the list's
// end that have Arabic letters, such as DejaVu Sans.
const ARABIC_ORDER = [...ARABIC, ...REST].map(unquote).filter((name) => name !== "sans-serif");

// The font fontconfig gives for a letter a font lacks, as libass draws it
// with one on Linux, bold as captions.ass asks for it and in the language
// of the words. An Arabic letter is set in the first family of
// ARABIC_ORDER that has it, the one Chrome draws it with. { family, style,
// file, index, outline }, where outline is false for a font libass cannot
// draw, as it draws no color emoji; null on other systems or without
// fc-match. `match` stands in for fc-match in the tests.
function fallbackFont(codePoint, weight, lang = "", { platform = process.platform, match = fcMatch } = {}) {
  if (platform !== "linux" || !Number.isInteger(codePoint)) return null;
  const charset = `:charset=${codePoint.toString(16)}`;
  // fontconfig weighs a font's letters before its name, so it gives the
  // family named only when that family has the letter, or no font does.
  if (ARABIC_LETTER.test(String.fromCodePoint(codePoint))) {
    for (const name of ARABIC_ORDER) {
      const got = match(`${fcName(name)}${charset}${fcWeight(weight)}`);
      if (got && got.outline && sameName(got.family, name)) return got;
    }
  }
  return match(`sans-serif${charset}${fcWeight(weight)}${FC_LANG[lang] ? `:lang=${FC_LANG[lang]}` : ""}`);
}

// A fact of fonts.json as text on one line, and not too long for one:
// easyfontkit copies a copyright from the font file's names as it is, over
// several lines at times, and CAPTIONS.md gives each fact in a sentence or
// a list item. A fact that is not text is none.
function factOf(value, most = 300) {
  const one = textOf(value).replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  return one.length > most ? `${one.slice(0, most - 1).trim()}…` : one;
}

// The license facts fonts.json gives for a family, passing over what in
// its list is no family.
function licenseOf(kit, family) {
  if (!object(kit) || !Array.isArray(kit.families)) return null;
  const entry = kit.families.filter(object).find((f) => sameName(f.name, family) || (Array.isArray(f.cssNames) && f.cssNames.some((n) => sameName(n, family))));
  if (!entry) return null;
  const l = object(entry.license) ? entry.license : {};
  const free = Array.isArray(entry.free) && object(entry.free[0]) && factOf(entry.free[0].family) ? entry.free[0] : null;
  return {
    family: factOf(entry.name) || family,
    status: factOf(l.status) || "unknown",
    name: factOf(l.name),
    url: factOf(l.url),
    maker: factOf(l.maker),
    copyright: factOf(l.copyright),
    basis: factOf(l.basis),
    from: factOf(entry.host),
    free: free ? { family: factOf(free.family), from: factOf(free.from), license: factOf(free.license) } : null,
  };
}

// options: { fonts (path to fonts.css), brand (path), font (family name),
// highlight (color), box, lang (of CJK words, from cjkLanguage), arabic
// (whether the words hold Arabic letters), scripts (the scripts of
// SCRIPT_FAMILIES they hold letters of, from scriptsIn) }
function chooseLook(options = {}) {
  const notes = [];
  if (options.font && !fontName(options.font)) throw new Error("--font takes a font family name, like Inter");
  const css = options.fonts ? readFontsCss(options.fonts) : null;
  const brand = options.brand ? readBrand(options.brand) : null;
  if (css && css.missing.length) notes.push(`fonts.css names ${css.missing.length} font ${css.missing.length === 1 ? "file" : "files"} that ${css.missing.length === 1 ? "is" : "are"} not on this disk, like ${css.missing[0]}.`);
  if (css && css.outside.length) notes.push(`fonts.css names ${css.outside.length} font ${css.outside.length === 1 ? "file" : "files"} outside its own folder or through a link, like ${css.outside[0]}, and ${css.outside.length === 1 ? "it was" : "they were"} left out: easycaptionkit reads font files only from the folder of fonts.css, where easyfontkit saves them.`);
  if (css && css.odd.length) notes.push(`fonts.css names ${css.odd.length === 1 ? "a family" : `${css.odd.length} families`} with characters a font name cannot have, so ${css.odd.length === 1 ? "it was" : "they were"} left out.`);
  const brandNames = brand ? brandFonts(brand, notes) : { heading: "", body: "" };
  let family = "";
  let from = "default";
  if (options.font) {
    family = options.font;
    from = css && css.faces.some((f) => sameName(f.family, family)) ? "fonts.css" : "machine";
  } else if (css) {
    const roleFamily = ["heading", "body", "button"].map((r) => css.roles[r]).find((name) => name && css.faces.some((f) => sameName(f.family, name)));
    family = roleFamily || (css.faces[0] && css.faces[0].family) || "";
    from = family ? "fonts.css" : "default";
    if (!family) notes.push("fonts.css declares no font file on this disk, so a common sans is used.");
  } else if (brandNames.heading || brandNames.body) {
    family = brandNames.heading || brandNames.body;
    from = "machine";
  }
  const faces = css && family ? css.faces.filter((f) => sameName(f.family, family)) : [];
  if (faces.length) family = faces[0].family;
  const weight = pickWeight(faces);
  if (faces.length && weight < 600) notes.push(`${family} has no bold file in fonts.css, so the captions use its ${weight} weight.`);
  const lang = Object.hasOwn(CJK, options.lang || "") ? options.lang : "";
  const scripts = (options.scripts || []).filter((name) => Object.hasOwn(SCRIPT_FAMILIES, name)).flatMap((name) => SCRIPT_FAMILIES[name]);
  const after = [...new Set([...LATIN, ...EMOJI, ...(lang ? CJK[lang] : []), ...(options.arabic ? ARABIC : []), ...scripts, ...REST])];

  // The color of the spoken word.
  let highlight = DEFAULT_HIGHLIGHT;
  let highlightFrom = "default";
  if (options.highlight) {
    highlight = parseColor(options.highlight);
    highlightFrom = "given";
  } else if (brand) {
    const picked = brandHighlight(brand.colors);
    if (picked) {
      highlight = picked.hex;
      highlightFrom = `the brand's ${picked.role || "color"} color`;
    } else if (brand.colors.length) notes.push("None of the brand's colors is bright enough to light a word, so the default yellow is used. Give --highlight to pick one.");
  }
  const lit = highlightMode(highlight, { box: Boolean(options.box) });
  return {
    family,
    from,
    stack: [...(family ? [JSON.stringify(family)] : []), ...after].join(", "),
    // The families of the list by name, which Chrome matches with the
    // weight asked for.
    listed: [...(family ? [family] : []), ...after.map(unquote).filter((name) => name !== "sans-serif")],
    lang,
    weight,
    faces: faces.map((f) => ({ ...f, url: pathToFileURL(f.file).href })),
    css: css ? css.file : "",
    license: css && family ? licenseOf(css.kit, family) : null,
    brand: brand ? { file: brand.file, name: brand.name, fonts: brandNames } : null,
    textColor: "#ffffff",
    highlight,
    highlightFrom,
    highlightMode: lit.mode,
    highlightInk: lit.ink,
    box: Boolean(options.box),
    boxOpacity: 0.62,
    notes,
  };
}

module.exports = { chooseLook, readBrand, readFontsCss, parseColor, contrast, luminance, highlightMode, brandHighlight, variableFace, machineFont, fallbackFont, fcName, sameName, DEFAULT_HIGHLIGHT };
