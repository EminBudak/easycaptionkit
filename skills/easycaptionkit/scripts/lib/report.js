"use strict";

// CAPTIONS.md, for people and agents, and captions.json, for tools: what
// was made, the look, where the captions sit and why, how fast they read,
// and the license facts of the font burned into the picture.

const fs = require("node:fs");
const path = require("node:path");
const { variableFace, sameName } = require("./look");
const { onPath } = require("./ffmpeg");
const { FORMATS } = require("./words");

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
// A moment as m:ss.s, rounded to the tenth before the minutes are taken,
// so that 59.96 s is 1:00.0 and not 0:60.0.
const clock = (t) => {
  const tenths = Math.max(0, Math.round(t * 10));
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
};
const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The captions letters are in, of [{ letter, cue }], as a note says them:
// "caption 3", "captions 1, 2 and 5", or the first six and how many more.
function captionsOf(items) {
  const cues = [...new Set(items.map((m) => m.cue))];
  return `${cues.length === 1 ? "caption" : "captions"} ${cues.length > 6 ? `${cues.slice(0, 6).join(", ")} and ${cues.length - 6} more` : list(cues.map(String))}`;
}

// The letters themselves, each once: all of them, or the first eight and
// how many more.
function lettersOf(items) {
  const letters = [...new Set(items.map((m) => m.letter))];
  return letters.length > 8 ? `${letters.slice(0, 8).join(" ")} and ${letters.length - 8} more` : letters.join(" ");
}

// The letters the video shows as boxes, [{ letter, cue }], as a sentence:
// Chrome found no font for them, or no font libass can use has them.
function boxesText(boxes, drawnWith) {
  const n = boxes.length;
  if (drawnWith === "libass") return `No font on this machine that libass can use has ${plural(n, "letter", "letters")} of ${captionsOf(boxes)} (${lettersOf(boxes)}), so the video shows ${n === 1 ? "a box for it" : "boxes for them"}.`;
  return `Chrome found no font on this machine for ${plural(n, "letter", "letters")} of ${captionsOf(boxes)} (${lettersOf(boxes)}), so it drew a box for ${n === 1 ? "it" : "each of them"}.`;
}

// What to do about letters no font here has: install one that has them,
// named where one font covers them all, as Noto Sans CJK covers Chinese,
// Japanese and Korean, or give a font kit whose font has them.
const CJK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}　-〿＀-￯]/u;
const PICTURE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;
function installText(items) {
  const letters = items.map((m) => m.letter);
  const them = letters.length === 1 ? "it" : "them";
  if (letters.every((c) => PICTURE.test(c))) return "Install a color emoji font, such as Noto Color Emoji (fonts-noto-color-emoji on Debian and Ubuntu), and run again.";
  const font = letters.every((c) => CJK.test(c)) ? "Noto Sans CJK (fonts-noto-cjk on Debian and Ubuntu)" : `a Noto font for ${letters.length === 1 ? "its" : "their"} script`;
  return `Install a font that has ${them}, such as ${font}, or give --fonts an easyfontkit folder whose font has ${them}, and run again.`;
}
// A name on one line of Markdown or of the terminal: its control
// characters become a space, as a line break in it would end a heading or
// a list item, or start a line of its own in a message, and an escape
// would be a sequence the terminal acts on, as one that sets its title.
const shown = (name) => String(name).replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");

// A value as a shell takes it: as it is when it holds only plain letters,
// else in single quotes, inside which sh, bash and zsh expand nothing, not
// even the ! of an interactive shell's history, with a quote in it written
// '\''. Control characters, the C1 ones too, are written out in $'...',
// which bash and zsh read, so the command stays on one line and shows as
// it is in a message: each as the bytes of its UTF-8, \x0a, \xc2\x9b,
// which give the name's own bytes in any locale, and a quote or a ! as
// \x27 and \x21 there. On Windows, whose cmd takes no single quotes, in
// double ones, with every letter as it is, a backslash, a $ and a ` too,
// as Windows splits a command line: only the backslashes before a quote,
// which a Windows name never holds, or before the closing one, as a path
// to a drive's top folder ends, are doubled. PowerShell still reads a
// $name inside double quotes as its variable.
const quote = (value, platform = process.platform) => {
  const text = String(value);
  if (/^[\w./:@%+=-]+$/.test(text)) return text;
  if (platform === "win32") return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  const bytes = (c) => [...Buffer.from(c, "utf8")].map((b) => `\\x${b.toString(16).padStart(2, "0")}`).join("");
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return `$'${text.replace(/\\/g, "\\\\").replace(/['!\u0000-\u001f\u007f-\u009f]/g, bytes)}'`;
  return `'${text.replace(/'/g, "'\\''")}'`;
};

// A path as a shell takes it, quoted as above. A relative one that starts
// with a dash, as -take2/words.json, is written from ./ (.\ on Windows),
// so the program does not take it for an option.
const arg = (p, platform = process.platform) => {
  const text = String(p);
  return quote(text.startsWith("-") ? `${platform === "win32" ? ".\\" : "./"}${text}` : text, platform);
};

// Text as a Markdown code span: fenced by one backtick more than the
// longest run of them in it, so a ` in a path does not end it, and copied
// whole, nothing of the sentence around it comes with it.
const code = (text) => {
  const longest = Math.max(0, ...(String(text).match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = /^`|`$/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
};

// The program a printed command starts with, as this run was started, so
// the command runs as given in the shell it was started from: npx's copy
// again with npx, the command npm install -g puts on PATH by its name, a
// project's own copy that npx or an npm script ran with npx, which runs
// that copy, and any other with node and its whole path, as the skill
// runs it. npm puts a project's node_modules/.bin first on the PATH of
// what it runs, for that run alone, so a name found there is not on the
// shell's PATH. `script` is the file node runs.
function programOf(script = process.argv[1] || "", { pathTo = onPath, env = process.env } = {}) {
  if (!script) return "npx easycaptionkit@latest";
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  const parts = (file) => String(file).split(/[\\/]/);
  const within = (name) => [script, real(script)].some((file) => parts(file).includes(name));
  if (within("_npx")) return "npx easycaptionkit@latest";
  const npmBin = (dir) => {
    const p = parts(dir).filter(Boolean);
    return p[p.length - 1] === ".bin" && p[p.length - 2] === "node_modules";
  };
  const named = pathTo("easycaptionkit", { skip: npmBin });
  if (named && !npmBin(path.dirname(named)) && real(named) === real(script)) return "easycaptionkit";
  if ((env.npm_command || env.npm_lifecycle_event) && within("node_modules")) return "npx easycaptionkit";
  return `node ${arg(script)}`;
}

// The subtitles command that makes a run again from the words of `words`
// into `out`: with its video and every option of the run that is not its
// default, each path as it was given, so it runs from where the run was
// made. `options` are the run's: { program, video, places, style, lines,
// maxChars, size, position, box, brand, fonts, font, highlight }, program
// from programOf, as npx runs the kit where it is not given.
function subtitlesCommand(options, words, out) {
  const o = options || {};
  const parts = [o.program || "npx easycaptionkit@latest", "subtitles", arg(words)];
  if (o.video) parts.push("--video", arg(o.video));
  if (o.places && o.places.length) parts.push("--for", o.places.join(","));
  if (o.style && o.style !== "karaoke") parts.push("--style", o.style);
  if (o.lines !== undefined && o.lines !== 2) parts.push("--lines", String(o.lines));
  if (o.maxChars !== undefined && o.maxChars !== 42) parts.push("--max-chars", String(o.maxChars));
  if (o.size !== undefined && o.size !== (o.style === "word" ? 9.5 : 6.5)) parts.push("--size", String(o.size));
  if (o.position && o.position !== "bottom") parts.push("--position", o.position);
  if (o.box) parts.push("--box");
  for (const [flag, value] of [["--brand", o.brand], ["--fonts", o.fonts]]) if (value) parts.push(flag, arg(value));
  for (const [flag, value] of [["--font", o.font], ["--highlight", o.highlight]]) if (value) parts.push(flag, quote(value));
  parts.push("--out", arg(out));
  return parts.join(" ");
}

// The font captions.ass names, for the subtitles report: { name, more },
// the name as the sentence gives it and what follows it. libass and the
// players that read ASS size a font by its own heights, so a font asked
// for by name is sized for the one this machine gives for it.
function assFontText(f) {
  const look = f.look;
  const m = f.libassFont || null;
  if (!look.family) return { name: "Arial, as captions.ass asks for it by name", more: "" };
  if (look.from === "fonts.css") return { name: `${look.family} from fonts.css`, more: [f.assFamily && !sameName(f.assFamily, look.family) ? `captions.ass names it ${f.assFamily}, the family name in its file, which players find a font by.` : "", thinner(f)].filter(Boolean).join(" ") };
  if (m && sameName(m.family, look.family)) return { name: `${look.family}, as installed on this machine`, more: "" };
  if (m) return { name: look.family, more: `${look.family} was asked for by name, and this machine does not have it: captions.ass is sized for ${m.family}${m.style ? ` ${m.style}` : ""}, which fontconfig gives for that name, so a player with another font for it draws the captions larger or smaller.` };
  return { name: look.family, more: `${look.family} was asked for by name, and captions.ass is sized for Arial's heights: nothing here says what this machine gives for that name.` };
}

// Where ffmpeg's ass filter finds a font of fonts.css, which is on no
// machine's list of fonts, for the captions.ass row of a table: in its
// folder, from the folder of captions.ass, given as the filter's
// fontsdir. A player draws it once it is installed.
function fontsWhere(f) {
  if (!f.assFonts) return "";
  const cell = (text) => code(shown(text)).replace(/\|/g, "\\|");
  // A folder of plain letters goes into the filter as it is.
  const filter = `ass=captions.ass:fontsdir=${/^[\w./@%+=-]+$/.test(f.assFonts) ? f.assFonts : "<that folder>"}:shaping=complex`;
  // Where Chrome drew the captions, libass's letters are thinner than its,
  // and a subtitles run says so where it says what captions.ass draws.
  const thin = !f.subtitlesOnly && f.drawnWith !== "libass" ? thinner(f, "in captioned.mp4", cell) : "";
  return `; its font is a file of fonts.css in ${cell(f.assFonts)}, which the filter finds when that is its fontsdir, as in ${cell(filter)} run in this folder, and a player once the font is installed${thin ? `. ${thin.replace(/\.$/, "")}` : ""}`;
}

// That libass draws a variable font file of fonts.css at its default
// weight, as captions.ass is drawn, and what the letters come out thinner
// than, if anything; "" for a font of fixed weights, or where libass draws
// no letter with it. `name` writes the file's name.
function thinner(f, than = "", name = (text) => text) {
  const face = f.look.from === "fonts.css" && setsAny(f) ? variableFace(f.look) : null;
  if (!face) return "";
  return `libass draws ${name(face.name || path.basename(face.file))}, a file of the weights ${face.weight[0]} to ${face.weight[1]}, at its default weight, not at ${f.look.weight}, so the letters come out thinner${than ? ` than ${than}` : ""}.`;
}

// How captioned.mp4's sound was written, from its tracks, each { copied,
// from }: "sound copied as it was", "sound made AAC", and for several
// tracks which were made AAC, by number and the codec they had.
function soundText(tracks = []) {
  if (!tracks.length) return "no sound";
  const made = tracks.map((t, i) => ({ ...t, n: i + 1 })).filter((t) => !t.copied);
  if (tracks.length === 1) return made.length ? "sound made AAC" : "sound copied as it was";
  if (!made.length) return `${tracks.length} sound tracks, copied as they were`;
  if (made.length === tracks.length) return `${tracks.length} sound tracks, made AAC`;
  return `sound copied as it was, ${made.length === 1 ? "track" : "tracks"} ${list(made.map((t) => `${t.n} (${t.from})`))} made AAC`;
}

// The places as the subject of a sentence, with its verb.
const placesLeave = (places) => (places.length === 1 ? `${places[0].name} leaves` : `${list(places.map((z) => z.name))} leave`);

const STYLE_WORDS = {
  karaoke: "the karaoke style (each caption whole, the spoken word lit)",
  line: "the line style (each caption whole)",
  word: "the word style (one word at a time)",
};

function marginsText(zone) {
  const r = zone.reference;
  const m = r.margins;
  const column = r.column ? `, buttons ${r.column.width} px wide from ${r.column.from} px down` : "";
  return `top ${m.top}, bottom ${m.bottom}, left ${m.left}, right ${m.right} px of a ${r.width}x${r.height} ${zone.screen ? "screen" : "frame"}${column}`;
}

// What fontconfig gives for a name libass asks for, as a sentence, or
// that libass does not say.
const givenFor = (m) => (m ? `fontconfig, which libass looks fonts up through on Linux, gives ${m.family}${m.style ? ` ${m.style}` : ""} for that name.` : "libass draws with what this machine gives for that name and does not say which font that is.");

// What captions.ass sets in other fonts than its own: the letters its font
// lacks, each in the font fontconfig gives for it, sized to the same em.
function fallbackLine(f) {
  const fb = f.assFallbacks || [];
  if (!fb.length) return "";
  const n = fb.reduce((a, b) => a + b.letters, 0);
  const where = `in ${list(fb.map((x) => x.family))}, which fontconfig gives for ${n === 1 ? "it" : "them"}, at the size that makes ${n === 1 ? "it a" : "them"} ${f.layout.fontPx} px ${n === 1 ? "letter" : "letters"} too.`;
  if (setsNone(f)) return `The font has none of the ${plural(n, "letter", "letters")}: captions.ass sets ${n === 1 ? "it" : "them"} ${where}`;
  // Where the video shows boxes too, the font lacks more letters than these.
  return `captions.ass sets ${boxedIn(f) ? "" : "the "}${plural(n, "letter", "letters")} the font lacks ${where}`;
}

// Whether the font captions.ass names sets any letter of the captions,
// and whether it sets none and other fonts set them all, with no letter
// libass showed as a box.
const setsAny = (f) => !f.assLetters || f.assLetters.own > 0;
const setsNone = (f) => !setsAny(f) && (f.assFallbacks || []).length > 0 && !boxedIn(f);

// Whether the video shows letters as boxes.
const boxedIn = (f) => (f.boxes || []).length > 0;

// The font the captions were drawn with: none named, the first of the
// common sans fonts this machine has, which Chrome found for Latin
// letters, and the fonts that drew the letters it lacks. The letters the
// video shows as boxes, which no font drew, are said after the font, and
// the letters counted after them are the others.
function fontLines(f) {
  const lines = [];
  const look = f.look;
  const drawn = (f.fontsDrawn || []).filter((x) => x.glyphs > 0);
  const total = drawn.reduce((a, b) => a + b.glyphs, 0);
  const libass = f.drawnWith === "libass";
  const m = libass ? f.libassFont || null : null;
  const fill = (fonts) => list(fonts.map((x) => (fonts.length > 1 ? `${x.family} (${x.glyphs})` : x.family)));
  const filled = libass && fallbackLine(f) ? [`  ${fallbackLine(f)}`] : [];
  const boxed = boxedIn(f) ? [`  ${boxesText(f.boxes, f.drawnWith)}`] : [];
  const other = boxed.length ? "other " : "";
  const ofAll = boxed.length ? `of the other ${total}` : `of ${total}`;
  if (!look.family) {
    if (libass) {
      lines.push(`- Font: Arial ${look.weight}, as captions.ass asks for it by name. ${m && sameName(m.family, "Arial") ? "This machine has it." : givenFor(m)}`, ...boxed, ...filled);
      return lines;
    }
    // Chrome did not say which font is the first of the list: the fonts
    // that drew, and none named as that one.
    const first = f.fontFirst || "";
    if (!first) {
      lines.push(`- Font: a common sans ${look.weight}, the first of the common sans fonts easycaptionkit asks for that this machine has.`, ...boxed);
      if (drawn.length) lines.push(`  Chrome drew the ${other}${total} letters with ${fill(drawn)}.`);
      return lines;
    }
    lines.push(`- Font: ${first} ${look.weight}, the first of the common sans fonts easycaptionkit asks for that this machine has.`, ...boxed);
    const own = drawn.find((x) => x.family === first);
    const others = drawn.filter((x) => x.family !== first);
    if (others.length) {
      const rest = total - (own ? own.glyphs : 0);
      lines.push(own ? `  Chrome drew ${own.glyphs} ${ofAll} letters with it, and the ${rest} it lacks with ${fill(others)}.` : `  It has none of the ${other}${total} letters, so Chrome drew them with ${fill(others)}.`);
    }
    lines.push(...lighterLines(look, others));
    return lines;
  }
  const files = `fonts.css (${look.faces.map((x) => x.name || x.file.split(/[\\/]/).slice(-2).join("/")).join(", ")})`;
  if (look.from === "machine") {
    if (libass) {
      if (m && sameName(m.family, look.family)) lines.push(`- Font: ${look.family} ${look.weight}, as installed on this machine.`);
      else if (m) lines.push(`- Font: ${look.family} ${look.weight} was asked for by name, and this machine does not have it: ${givenFor(m)} Give easyfontkit's folder with --fonts to burn the real font.`);
      else lines.push(`- Font: ${look.family} ${look.weight}, asked for by name. ${givenFor(m)}`);
      lines.push(...boxed, ...filled);
      return lines;
    }
    // Not on this machine: Chrome drew the letters with other fonts, or
    // drew every letter as a box, and its first font is another.
    const absent = !machineHas(f) && (drawn.length ? !drawn.some((x) => drewWith(x, look)) : boxed.length > 0);
    if (absent) {
      if (boxed.length) lines.push(`- Font: ${look.family} ${look.weight} was asked for by name, and this machine does not have it. Give easyfontkit's folder with --fonts to burn the real font.`, ...boxed, ...(drawn.length ? [`  Chrome drew the other letters with ${fill(drawn)}.`] : []));
      else lines.push(`- Font: ${look.family} ${look.weight} was asked for by name, and this machine does not have it, so Chrome drew the letters with ${fill(drawn)}. Give easyfontkit's folder with --fonts to burn the real font.`);
      return lines;
    }
    if (drawn.length && !drawn.some((x) => drewWith(x, look))) {
      if (boxed.length) lines.push(`- Font: ${look.family} ${look.weight}, as installed on this machine.`, ...boxed, `  It has none of the other ${total} letters, so Chrome drew them with ${fill(drawn)}.`, ...lighterLines(look, drawn));
      else lines.push(`- Font: ${look.family} ${look.weight}, as installed on this machine. It has none of the ${total} letters, so Chrome drew them with ${fill(drawn)}.`, ...lighterLines(look, drawn));
      return lines;
    }
    lines.push(`- Font: ${look.family} ${look.weight}, as installed on this machine.`);
  } else if (libass && variableFace(look) && setsAny(f)) {
    const face = variableFace(look);
    lines.push(`- Font: ${look.family}, from ${files}. That file holds the weights ${face.weight[0]} to ${face.weight[1]}, and libass draws such a file at its default weight, not at ${look.weight}, so the letters are thinner than Chrome draws them.`);
  } else lines.push(`- Font: ${look.family} ${look.weight}, from ${files}.`);
  if (f.assFamily && !sameName(f.assFamily, look.family)) lines.push(`  captions.ass names it ${f.assFamily}, the family name in its file, which libass and the players that read ASS find a font by.`);
  if (libass) lines.push("  libass drew the letters and does not say which font drew each.", ...boxed, ...filled);
  else lines.push(...boxed);
  if (!drawn.length) return lines;
  // A font file of fonts.css is the only web font on the page, and Chrome
  // names it by the family in the file, which fonts.css can call
  // otherwise.
  const own = drawn.filter((x) => drewWith(x, look));
  const others = drawn.filter((x) => !drewWith(x, look));
  if (!own.length) lines.push(`  Chrome drew ${boxed.length ? "none of the other letters" : "no letter"} with the file of ${look.family}: ${drawn[0].family} drew them.`);
  else if (!others.length) lines.push(boxed.length ? "  Chrome drew all the other letters with it." : "  Chrome drew every letter with it.");
  else {
    const mine = own.reduce((a, b) => a + b.glyphs, 0);
    lines.push(`  Chrome drew ${mine} ${ofAll} letters with it, and the ${total - mine} it lacks with ${fill(others)}.`);
  }
  lines.push(...lighterLines(look, others));
  return lines;
}

// A face lighter than the weight asked for, by its PostScript name, as a
// system's fallback gives a regular one: Noto Sans CJK JP's
// NotoSansCJKjp-Regular for letters asked for at 700.
const LIGHTER = /-(?:Thin|ExtraLight|UltraLight|Light|DemiLight|SemiLight|Book|Regular|Normal|Roman|Medium|W[0-5])$/i;

// The lines that say a font that filled in drew from a face lighter than
// the weight asked for: a family of the list, which Chrome matches with
// that weight, has no bolder face here; a font of the system's fallback,
// for letters no font of the list has, can come in its regular face though
// its bold is there.
function lighterLines(look, drawn) {
  if (look.weight < 600) return [];
  const listed = (x) => (look.listed || []).some((name) => sameName(name, x.family));
  return drawn
    .filter((x) => !x.custom && LIGHTER.test(x.postScriptName || ""))
    .map((x) => `  ${x.family} drew its ${plural(x.glyphs, "letter", "letters")} from ${x.postScriptName}, a face lighter than the ${look.weight} asked for, ${listed(x) ? "since Chrome found no bolder face of it on this machine" : "the face the system's fallback gave Chrome for letters no font of the list has"}, so they are thinner than the others.`);
}

// The fonts that drew every letter of the captions where the font asked
// for, by name or from fonts.css, drew none of them, as a Latin font draws
// no Japanese: the fonts Chrome drew them with, or with libass the fonts
// captions.ass sets them in. Their names, or [] when the font drew any
// letter, no font was asked for, or nothing says.
function drewNone(f) {
  if (f.drawnWith === "libass") return f.look.family && setsNone(f) ? f.assFallbacks.map((x) => x.family) : [];
  const drawn = (f.fontsDrawn || []).filter((x) => x.glyphs > 0);
  if (!f.look.family || !drawn.length || drawn.some((x) => drewWith(x, f.look))) return [];
  return drawn.map((x) => x.family);
}

// Whether this machine has the font asked for by name, as far as Chrome
// says: it is the first of the list Chrome draws plain Latin letters with.
const machineHas = (f) => Boolean(f.fontFirst) && sameName(f.fontFirst, f.look.family);

// Whether a font Chrome drew with is the one asked for.
const drewWith = (x, look) => (look.from === "fonts.css" && x.custom) || x.family.toLowerCase() === look.family.toLowerCase();

// The spoken word as it was drawn: Chrome puts a color too dark for
// letters on a patch, libass in a thick border.
function highlightLine(look, style, drawnWith) {
  if (style === "line") return [];
  const ink = look.highlightInk === "#ffffff" ? "white" : "black";
  const dark = `since ${look.highlight} is too dark to read as letters on the outline`;
  const how = look.highlightMode !== "patch" ? `in ${look.highlight}` : drawnWith === "libass" ? `in ${ink} with a thick border of ${look.highlight}, ${dark}` : `on a patch of ${look.highlight}, in ${ink}, ${dark}`;
  const from = look.highlightFrom === "given" ? "the color given" : look.highlightFrom === "default" ? "the default" : look.highlightFrom;
  return [`- The spoken word: ${how} (${from}).`];
}

const STATUS = { open: "an open license", commercial: "a commercial license", unknown: "a license easyfontkit could not tell" };

// What the license section says of fonts that came with this machine.
const systemFonts = (names) => `${list(names)}, which came with this machine. easycaptionkit has no license facts for ${names.length === 1 ? "it" : "them"}; a system's fonts are licensed with the system.`;

function licenseSection(f) {
  const look = f.look;
  const lines = ["## Font license", ""];
  const l = look.license;
  const status = l ? (Object.hasOwn(STATUS, l.status) ? STATUS[l.status] : l.status) : "";
  const read = l ? `easyfontkit read ${l.family} as under ${status}${l.name ? `: ${l.name}` : ""}${l.url ? ` (${l.url})` : ""}` : "";
  const libass = f.drawnWith === "libass";
  // A font that drew none of the letters is in no copy of the video: the
  // ones that drew them are, whatever its license.
  const instead = drewNone(f);
  if (instead.length) {
    const drew = libass ? "captions.ass sets them all in" : boxedIn(f) ? "Chrome drew all but the boxes with" : "Chrome drew them all with";
    // A font asked for by name that this machine has, or one from fonts.css, lacks the letters.
    const lacks = look.from === "fonts.css" || (libass ? f.libassFont && sameName(f.libassFont.family, look.family) : machineHas(f));
    const lead = read ? `${read}, but no letter of it is in the video` : `No letter of ${look.family} is in the video`;
    lines.push(`${lead}, since ${lacks ? "it has none of these letters" : "this machine does not have it"}: ${drew} ${systemFonts(instead)}`);
    return lines;
  }
  if (!l) {
    // libass says nothing of what it drew with; fontconfig can say what
    // it gives for the name, and for the letters the font lacks.
    const m = libass ? f.libassFont || null : null;
    const filled = libass ? (f.assFallbacks || []).map((x) => x.family) : [];
    const byName = libass && look.from === "machine" && !(m && sameName(m.family, look.family));
    if (look.from === "fonts.css") lines.push(`fonts.json was not next to fonts.css, so there are no license facts for ${look.family} here.`);
    else if (byName && m) lines.push(`The captions ask for ${look.family} by name, and this machine does not have it: fontconfig gives ${m.family}, which came with this machine. easycaptionkit has no license facts for it; a system's fonts are licensed with the system.`);
    else if (byName) lines.push(`The captions ask for ${look.family} by name, and libass draws whatever this machine gives for that name. easycaptionkit has no license facts for it; a system's fonts are licensed with the system, and easyfontkit reads a site's from its own font files.`);
    else if (look.from === "machine") lines.push(`${look.family} came from this machine by its name. easycaptionkit has no license facts for it; easyfontkit reads them from the site's own font files.`);
    // No font asked for: the one fontconfig gives for Arial, where it sets
    // any letter, and those it gives for the letters that one lacks.
    else if (m || filled.length) lines.push(`The captions use ${systemFonts([...new Set([...(m && setsAny(f) ? [m.family] : []), ...filled])])}`);
    else lines.push("The captions use a font that came with this machine. easycaptionkit has no license facts for it; a system's fonts are licensed with the system.");
    return lines;
  }
  lines.push(`${read}.`);
  if (l.copyright) lines.push("", `- Copyright: ${l.copyright}`);
  if (l.maker) lines.push(`- Maker: ${l.maker}`);
  if (l.basis) lines.push(`- How it was read: ${l.basis}`);
  if (l.from) lines.push(`- The file came from ${l.from}`);
  if (l.status !== "open") {
    lines.push("", `Captions burned into a video carry the font's letters into every copy of it, and whether that use is allowed is up to ${l.family}'s license and the license the site holds, not easycaptionkit.`);
    if (l.free) lines.push(`easyfontkit found ${l.free.family} (${l.free.from}, ${l.free.license}) as the closest free font. To burn it instead, install it on this machine and run again with ${code(`--font ${quote(l.free.family)}`)}.`);
  }
  return lines;
}

// Whether the words are a demo's steps, from steps.json or from a
// words.json made of them, which names steps.json as the format its words
// first came in or where they first came from. They were written, not
// heard: no speech-to-text gives them times, a word of one is changed, not
// misheard, and each step's words show while the step plays.
const fromSteps = (w) => [w.format, w.firstFormat, w.origin && w.origin.format].includes("steps");

function readingSection(f) {
  const r = f.reading;
  const lines = ["## Reading speed", ""];
  lines.push(`Median ${r.median} characters a second, the fastest caption ${r.fastest}. People read about ${r.comfort} comfortably; past ${r.limit} many cannot finish a caption before it goes.`);
  if (!r.fast.length) lines.push("", `No caption goes faster than ${r.limit} characters a second.`);
  else {
    lines.push("", `${plural(r.fast.length, "caption goes", "captions go")} faster than ${r.limit}:`, "");
    for (const c of r.fast.slice(0, 8)) lines.push(`- ${c.n} at ${clock(c.start)}, ${c.cps} a second: "${c.text}"`);
    if (r.fast.length > 8) lines.push(`- and ${r.fast.length - 8} more, listed in captions.json`);
    // A demo has no speaker: its steps give the times. readSteps in
    // words.js spreads a step's words until the next step with words
    // starts, over ten seconds at most, and time in cues.js keeps the
    // step's last caption up after them when nothing comes sooner, 0.4 to
    // 1.2 s by its length, or on to the next caption when that starts
    // within 0.3 s more. So a wait after a step gives its words more time
    // only up to those ten seconds and that moment.
    const slower = fromSteps(f.source) ? "The times follow the demo's steps: a step's words are spread over the time until the next step with words starts, ten seconds at most, and its last caption stays a moment after them when nothing comes sooner. Fewer words in a step's note make them easier to read, and so does a wait after that step, up to those ten seconds and that moment, when the demo is recorded again." : "The times follow the speaker. Fewer words or a slower take make them easier to read.";
    lines.push("", slower);
  }
  return lines;
}

function wordsSection(f) {
  const w = f.source;
  const lines = ["## The words", ""];
  // The line style lights no word: there the estimate moves only the cut
  // of a line too long for one caption.
  const off = f.style === "line" ? "where a line too long for one caption is cut, the cut can come a little early or late" : "a lit word can come a little early or late";
  const steps = fromSteps(w);
  // Words with times of their own but for a few the file gives none, as
  // WhisperX gives a numeral none, which were placed between the words
  // around them: they have no times for whole lines, however few have
  // their own.
  const given = f.wordList || [];
  const own = given.filter((x) => x.timed).length;
  const placed = given.filter((x) => x.placed).length;
  const some = own > 0 && placed > 0 && own + placed === given.length;
  const how = some ? `${own} with ${own === 1 ? "its" : "their"} own time and ${placed} with none of ${placed === 1 ? "its" : "their"} own, placed between the words around ${placed === 1 ? "it" : "them"}` : w.byWord ? "each with its own time" : steps ? "each step's words shown while the step plays, spread over that time by their length" : `with times for whole lines only, spread over their words by length, so ${off}. A speech-to-text JSON with word times fixes that`;
  // Where the words first came from: the file the folder's first run read,
  // unless that was a words.json of this kit too, as one taken from another
  // folder is, which names no source; then the format its words first came
  // in, which that words.json keeps.
  const origin = w.origin && w.origin.format !== "easycaptionkit" ? w.origin : null;
  const first = origin ? `, first read from ${shown(origin.file)}` : w.firstFormat ? `, first read from ${FORMATS[w.firstFormat] || shown(w.firstFormat)}` : "";
  lines.push(`${plural(w.count, "word", "words")} from ${shown(w.file)} (${w.about}${first}), ${how}.`);
  const words = f.out ? path.join(f.out, "words.json") : "words.json";
  const out = f.out || ".";
  // subtitles takes the words file as its argument, not --words, and the
  // command is given whole, with the video and the options of the run. It
  // is said in words first, so it still reads as a call to make where the
  // kit runs as a tool and its flags are the tool's parameters. A
  // captioning run gives the flags to add to its command. Both are code,
  // so the sentence's full stop is no part of what is copied.
  const video = f.rerun && f.rerun.video ? "--video and " : "";
  const again = f.subtitlesOnly ? `run subtitles again with ${arg(words)} as the words file, the same ${video}options and --out ${arg(out)}: ${code(subtitlesCommand(f.rerun, words, out))}` : `run the same command again with ${code(`--words ${arg(words)} --out ${arg(out)}`)}`;
  lines.push("", `words.json has them as read. ${steps ? "To change a word of a step" : "To fix a misheard word"}, edit its text there and ${again}.`);
  return lines;
}

function placesTable(f) {
  const lines = ["| Place | Margins | From | Read |", "| --- | --- | --- | --- |"];
  for (const z of f.places) lines.push(`| ${z.name} | ${marginsText(z)} | ${z.source} ([link](${z.url})) | ${z.read} |`);
  const notes = f.places.filter((z) => z.note);
  if (notes.length) lines.push("", ...notes.map((z) => `- ${z.name}: ${z.note}`));
  return lines;
}

function captionsMarkdown(f) {
  const v = f.output;
  const placeNames = list(f.places.map((z) => z.name));
  const L = f.layout;
  const lines = [`# Captions for ${shown(f.video.file)}`, ""];
  lines.push(`${plural(f.cues.length, "caption", "captions")} in ${STYLE_WORDS[f.style]}, burned into captioned.mp4 clear of the buttons of ${placeNames}, and the same captions in captions.srt, captions.vtt and captions.ass. Made by ${f.tool}.`);
  lines.push("", "## Files", "", "| File | What it is |", "| --- | --- |");
  lines.push(`| captioned.mp4 | ${v.width}x${v.height}, ${v.fps} fps, ${v.duration} s, H.264 (${v.encoder}), ${soundText(v.audio)} |`);
  lines.push("| captions.srt | the captions as text with times, for the places that take a captions file (YouTube, LinkedIn, X, Vimeo) |");
  lines.push("| captions.vtt | the same in WebVTT, for the web's <track> and most players |");
  lines.push(`| captions.ass | the same with the font, the colors and the place, for players that read ASS and for ffmpeg's ass filter${fontsWhere(f)} |`);
  lines.push(`| words.json | the ${f.source.count} words as read, with their times |`);
  lines.push("| captions.json | everything in this file, for tools |");
  lines.push(`| sheet.png | a frame of captioned.mp4 for ${f.sheet === f.cues.length ? "each caption" : `${f.sheet} of the captions, spread over the video`} |`);
  lines.push("| safe-zones.png | a frame under each place's buttons, with the margins the captions keep out of |");
  if (f.timelineCopied) lines.push("| captioned.timeline.json | launch-film's timeline of the film, so its check finds the cuts |");
  lines.push("", "## Look", "");
  lines.push(...fontLines(f));
  lines.push(...highlightLine(f.look, f.style, f.drawnWith));
  lines.push(`- Size: ${L.fontPx} px letters, ${f.style === "word" ? "one word at a time" : `up to ${plural(L.lines, "line", "lines")} of up to ${L.maxChars} characters`}, ${f.look.box ? "white on a dark box" : "white with a black outline"}.`);
  lines.push("", "## Where the captions sit", "");
  // The rows the captions reach as Chrome drew them, not the band of the
  // pictures, which has room around them.
  const reach = f.reach ? ` Drawn, they reach from y ${f.reach.top} to ${f.reach.bottom} of the ${v.height} px picture, ${f.look.box ? "the box" : "outline and shadow"} included, and the safe space runs from y ${Math.round(L.safe.top)} to ${Math.round(v.height - L.safe.bottom)}.` : "";
  lines.push(`At the ${L.position} of the space ${f.places.length === 1 ? placesLeave(f.places) : "all the places leave"} free, centered, ${Math.round(L.side)} px in from each side.${reach} safe-zones.png shows the frame at ${clock(f.moment)}.`);
  lines.push("", ...placesTable(f));
  lines.push("", "The figures come from the apps' ad guides or are estimates, and apps change their screens. Look at safe-zones.png, and check one post on a phone before posting many.");
  lines.push("", ...readingSection(f));
  lines.push("", ...wordsSection(f));
  lines.push("", ...licenseSection(f));
  if (f.notes.length) lines.push("", "## Notes", "", ...f.notes.map((n) => `- ${shown(n)}`));
  lines.push("", "## Next", "");
  lines.push(`- Look at sheet.png: ${f.sheet === f.cues.length ? "each caption on its frame" : `${f.sheet} of the ${f.cues.length} captions on their frames, spread over the video; captions.json has the time of every caption`}. Then safe-zones.png.`);
  lines.push(`- ${code(`npx launch-film@latest check ${f.out ? arg(path.join(f.out, "captioned.mp4")) : "captioned.mp4"}`)} measures the result: size, frame rate, length, black and still stretches, loudness and peaks.`);
  return oneLineEach(lines);
}

// The lines of a report, each one line whatever the names in it: a font
// file's name from a fonts.css made elsewhere, a family name in a font
// file or one Chrome or fontconfig gives can hold a line break, which
// would start a heading or a list item of its own in the file agents read
// first, or an escape a terminal that prints it takes for a command.
const oneLineEach = (lines) => lines.map(shown).join("\n") + "\n";

function subtitlesMarkdown(f) {
  const L = f.layout;
  const lines = [`# Subtitles from ${shown(f.source.file)}`, ""];
  const narrower = L.assMaxChars && L.assMaxChars < L.maxChars;
  lines.push(`${plural(f.cues.length, "caption", "captions")} of up to ${plural(L.lines, "line", "lines")} and ${L.maxChars} characters a line, in ${narrower ? `captions.srt and captions.vtt, and ${plural(L.assCues, "caption", "captions")} of up to ${L.assMaxChars} characters a line in captions.ass` : "captions.srt, captions.vtt and captions.ass"}. The video was not changed. Made by ${f.tool}.`);
  lines.push("", "## Files", "", "| File | What it is |", "| --- | --- |");
  lines.push("| captions.srt | the captions as text with times, for the places that take a captions file (YouTube, LinkedIn, X, Vimeo) |");
  lines.push("| captions.vtt | the same in WebVTT, for the web's <track> and most players |");
  lines.push(`| captions.ass | the same with the font, the colors and the place${f.video ? `, laid out for ${f.video.width}x${f.video.height}` : `, laid out for ${f.frame.width}x${f.frame.height}`}, for players that read ASS and for ffmpeg's ass filter${fontsWhere(f)} |`);
  lines.push(`| words.json | the ${f.source.count} words as read, with their times |`);
  lines.push("| captions.json | everything in this file, for tools |");
  lines.push("", ...readingSection(f));
  lines.push("", ...wordsSection(f));
  lines.push("", "## Where captions.ass puts them", "");
  const width = narrower ? `, up to ${L.assMaxChars} characters a line, what fits across the ${Math.round(L.textWidth)} px of safe space at that size` : `, up to ${L.maxChars} characters a line`;
  const font = assFontText(f);
  const more = [font.more, fallbackLine(f)].filter(Boolean).join(" ");
  lines.push(`At the ${L.position} of the space ${placesLeave(f.places)} free, ${L.fontPx} px letters in ${font.name}${width}.${more ? ` ${more}` : ""} No font goes with these files: a player draws captions.ass with the fonts of its own machine.`, "", ...placesTable(f));
  if (f.notes.length) lines.push("", "## Notes", "", ...f.notes.map((n) => `- ${shown(n)}`));
  return oneLineEach(lines);
}

// The first frame of a video that shows a change at t, from the times of
// its frames: the first at or after the time the change is drawn at, t to
// the millisecond (Chrome's states) or to the hundredth (ASS). Past the
// last frame it is the number of frames.
function frameOf(times, step) {
  return (t) => {
    const at = Math.round(t / step) * step - 1e-7;
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] >= at) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
}

function captionsJson(f) {
  const frames = Boolean(f.frameTimes && f.frameTimes.length);
  const frame = frames ? frameOf(f.frameTimes, f.frameStep || 0.001) : () => undefined;
  const L = f.layout;
  return {
    version: 1,
    tool: f.tool,
    video: f.video,
    output: f.output || null,
    words: f.source,
    style: f.style,
    drawnWith: f.drawnWith || null,
    look: {
      font: f.look.family || null,
      weight: f.look.weight,
      from: f.look.from,
      files: f.look.faces.map((x) => x.name || x.file),
      license: f.look.license,
      drawn: f.fontsDrawn || [],
      text: f.look.textColor,
      highlight: f.look.highlight,
      highlightFrom: f.look.highlightFrom,
      highlightMode: f.look.highlightMode,
      box: f.look.box,
    },
    layout: {
      width: L.frame.width,
      height: L.frame.height,
      position: L.position,
      fontPx: L.fontPx,
      lines: L.lines,
      maxChars: L.maxChars,
      side: round(L.side, 1),
      textWidth: round(L.textWidth, 1),
      safe: Object.fromEntries(Object.entries(L.safe).map(([k, x]) => [k, round(x, 1)])),
      band: f.band || null,
      reach: f.reach || null,
      ...(L.assMaxChars ? { ass: { maxChars: L.assMaxChars, cues: L.assCues } } : {}),
    },
    places: f.places.map((z) => ({
      place: z.key,
      name: z.name,
      margins: Object.fromEntries(Object.entries(z.margins).map(([k, x]) => [k, round(x, 1)])),
      column: z.column ? { from: round(z.column.from, 1), width: round(z.column.width, 1) } : null,
      reference: z.reference,
      source: z.source,
      ...(z.note ? { note: z.note } : {}),
      url: z.url,
      read: z.read,
    })),
    cues: f.cues.map((c) => ({
      n: c.n,
      start: round(c.start),
      end: round(c.end),
      ...(frames ? { startFrame: frame(c.start), endFrame: frame(c.end) } : {}),
      text: c.text,
      lines: c.lines,
      cps: round(c.cps, 1),
      words: f.wordList.slice(c.first, c.last + 1).map((w) => ({ text: w.text, start: round(w.start), end: round(w.end), ...(frames ? { frame: frame(Math.max(c.start, w.start)) } : {}) })),
    })),
    reading: f.reading,
    notes: f.notes,
    // The other files the run wrote, with their sizes.
    files: f.files || {},
  };
}

module.exports = { captionsMarkdown, subtitlesMarkdown, captionsJson, marginsText, drewWith, setsAny, setsNone, boxedIn, machineHas, captionsOf, lettersOf, boxesText, installText, arg, quote, code, clock, subtitlesCommand, programOf, shown, soundText };
