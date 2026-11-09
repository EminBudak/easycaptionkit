#!/usr/bin/env node
"use strict";

const path = require("node:path");
const version = require("./lib/version");
const { PLACES, PLACE_NAMES } = require("./lib/places");
const { drewWith, setsAny, setsNone, machineHas, shown, soundText } = require("./lib/report");
const { variableFace, sameName } = require("./lib/look");

const USAGE = `Usage: easycaptionkit <video> --words <file> [options]
       easycaptionkit subtitles <words> [options]
       easycaptionkit styles [--json]

Burns captions into a video in the product's own fonts and colors, word by
word or line by line, clear of each app's buttons, and writes captions.srt,
captions.vtt and captions.ass to go with it. CAPTIONS.md says what was
made, how fast the captions read and how the font is licensed; sheet.png
and safe-zones.png show the result.

Options:
  --words <file>      the words and their times: a speech-to-text JSON
                      (OpenAI, whisper.cpp, WhisperX, ElevenLabs, Deepgram,
                      AssemblyAI, NeMo, Parakeet and others), an SRT or VTT
                      file, or easyscreenshotkit's steps.json
  --style <name>      karaoke (the spoken word lit), line or word
                      (default: karaoke)
  --for <places>      tiktok, reels, shorts, youtube, x, linkedin or square,
                      several with commas; the captions keep clear of the
                      buttons of all of them (default: from the video's shape)
  --brand <dir|file>  an easybrandkit folder or its brand.json: the spoken
                      word in its color, and its heading font by name when
                      there is no --fonts or --font
  --fonts <dir|file>  easyfontkit's folder or its fonts.css: the site's own
                      font files
  --font <family>     the font family to use, from fonts.css or this machine
  --highlight <color> the color of the spoken word, like #ffd23f (karaoke
                      and word styles)
  --position <where>  bottom, middle or top of the safe space (default:
                      bottom)
  --lines <n>         lines a caption can take, 1 to 3 (default: 2)
  --max-chars <n>     characters a line can take, 8 to 80 (default: what
                      fits the safe width, at most 42; 42 for subtitles)
  --size <n>          letter size in percent of the width of the phone or the
                      short side of the frame, 2 to 20 (default: 6.5, or 9.5
                      for the word style)
  --box               a dark box behind the words instead of an outline
  --libass            draw the captions with ffmpeg's libass instead of Chrome
  --out <dir>         where to save (default: ./easycaptionkit-<video name>,
                      with -2 and on when that holds another video's captions)
  --dry-run           check the options and say what would be made; reads and
                      writes nothing
  --json              print captions.json instead of a summary
  -h, --help          show this help
  -v, --version       show the version

Subtitles writes captions.srt, captions.vtt, captions.ass, words.json,
captions.json and CAPTIONS.md, and changes no video. captions.ass is laid
out for the video given (else a phone when tiktok, reels or shorts is
named, a square for square alone, and a 16:9 frame for the rest), its
lines cut to what fits across it. Without --out it goes to
easycaptionkit-subtitles-<video name>, or <words name> with no video,
with -2 and on in the same way. Its options:
  --video <file>      the video, for its size and length
  --for, --style, --lines, --max-chars (default 42), --size, --position,
  --brand, --fonts, --font, --highlight, --box, --out, --dry-run, --json

The captions are drawn by Chrome (or ffmpeg's libass with --libass) and
laid over the video by ffmpeg in one encode; the sound is copied, or made
AAC when MP4 players do not take it. A run replaces the files an earlier
run wrote in --out, and stops before any work when the folder holds a file
by one of those names that easycaptionkit did not write or that changed
since, or a words.json fixed by hand that the run does not read.
A subtitles run also stops at a folder that holds the captioned video of
an earlier run.

The video and the words are files on this machine, not addresses, so
download them first, and --brand and --fonts take what easybrandkit and
easyfontkit make from a site. Needs Node 22 or newer, ffmpeg 4.4 or newer
and Chrome, Chromium, Edge or Brave. Set FFMPEG_PATH and CHROME_PATH to
pick them, and FFPROBE_PATH for an ffprobe that is not next to ffmpeg or
on PATH. Nothing leaves your machine.`;

const VALUED = new Set(["--words", "--style", "--for", "--brand", "--fonts", "--font", "--highlight", "--position", "--lines", "--max-chars", "--size", "--out", "--video"]);
const STYLES = ["karaoke", "line", "word"];
const POSITIONS = ["bottom", "middle", "top"];

function parse(argv) {
  const raw = {};
  const flags = { help: false, version: false, json: false, dryRun: false, box: false, libass: false };
  const rest = [];
  let command = "caption";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") flags.help = true;
    else if (arg === "-v" || arg === "--version") flags.version = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--box") flags.box = true;
    else if (arg === "--libass") flags.libass = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && /^--[a-z]/.test(value))) throw new Error(`${name} needs a value`);
      raw[name.slice(2)] = value;
    } else if (arg.startsWith("-") && arg.length > 1) throw new Error(`Unknown option: ${arg}`);
    else if (!rest.length && (arg === "subtitles" || arg === "styles")) {
      command = arg;
      rest.push(null);
    } else rest.push(arg);
  }
  const given = rest.filter((r) => r !== null);
  const options = { ...flags, command, style: "karaoke", position: "bottom", lines: 2 };
  if (raw.style !== undefined) {
    options.style = raw.style.toLowerCase();
    if (!STYLES.includes(options.style)) throw new Error("--style takes karaoke, line or word");
  }
  if (raw.position !== undefined) {
    options.position = raw.position.toLowerCase();
    if (!POSITIONS.includes(options.position)) throw new Error("--position takes bottom, middle or top");
  }
  if (raw.for !== undefined) {
    const places = raw.for.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
    const unknown = places.filter((p) => !PLACE_NAMES.includes(p));
    if (!places.length || unknown.length) throw new Error(`--for takes ${PLACE_NAMES.join(", ")}, several with commas${unknown.length ? `, not ${unknown.join(", ")}` : ""}`);
    options.places = [...new Set(places)];
  }
  if (raw.lines !== undefined) {
    options.lines = Number(raw.lines);
    if (!Number.isInteger(options.lines) || options.lines < 1 || options.lines > 3) throw new Error("--lines takes 1, 2 or 3");
  }
  if (raw["max-chars"] !== undefined) {
    options.maxChars = Number(raw["max-chars"]);
    if (!Number.isInteger(options.maxChars) || options.maxChars < 8 || options.maxChars > 80) throw new Error("--max-chars takes a whole number from 8 to 80");
  }
  options.size = options.style === "word" ? 9.5 : 6.5;
  if (raw.size !== undefined) {
    options.size = Number(raw.size);
    if (!(options.size >= 2 && options.size <= 20)) throw new Error("--size takes 2 to 20, a percent of the phone's width or the frame's short side");
  }
  if (raw.highlight !== undefined) {
    if (!/^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw.highlight.trim())) throw new Error(`--highlight takes a color like #ffd23f, not ${raw.highlight}`);
    options.highlight = raw.highlight.trim();
  }
  if (raw.font !== undefined) {
    options.font = raw.font.trim().replace(/^["']|["']$/g, "");
    if (!options.font || options.font.length > 100 || /[\u0000-\u001f\u007f;{}<>]/.test(options.font)) throw new Error("--font takes a font family name, like Inter");
  }
  for (const key of ["words", "brand", "fonts", "out", "video"]) if (raw[key] !== undefined) options[key] = raw[key];
  if (options.help || options.version) return options;
  if (command === "styles") {
    if (given.length) throw new Error("styles takes no file");
    return options;
  }
  if (command === "subtitles") {
    if (given.length !== 1) throw new Error("Give one words file, for example: easycaptionkit subtitles transcript.json");
    if (options.words !== undefined) throw new Error("subtitles takes the words file as its argument, without --words");
    if (options.libass) throw new Error("--libass is for burning captions into a video; subtitles changes no video");
    options.words = given[0];
    if (options.maxChars === undefined) options.maxChars = 42;
    return options;
  }
  if (options.video !== undefined) throw new Error("--video is for subtitles; give the video as the first argument");
  if (given.length !== 1) throw new Error("Give one video, for example: easycaptionkit demo.mp4 --words transcript.json");
  if (options.words === undefined) throw new Error("Give --words, the words and their times: a speech-to-text JSON, an SRT or VTT file, or steps.json");
  options.video = given[0];
  return options;
}

const sec = (t) => `${t.toFixed(2)} s`;
const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// The places a dry run names: those given, or those of the video's shape.
// Subtitles with no video lay captions.ass out on a frame of their own,
// and its places are known: the frame's, each once.
function placesOf(options) {
  if (options.command === "subtitles" && !options.video) {
    const { frameFor } = require("./lib/caption");
    const { defaultPlaces, captionLayout } = require("./lib/places");
    const frame = frameFor(options.places);
    const keys = options.places || defaultPlaces(frame.width, frame.height);
    const zones = captionLayout(frame.width, frame.height, keys, { style: options.style, size: options.size, lines: options.lines }).zones;
    return { keys: zones.map((z) => z.key), text: `${list(zones.map((z) => z.name))}, on a ${frame.width}x${frame.height} frame`, frame };
  }
  return { keys: options.places || "from the video's shape", text: options.places ? list(options.places.map((p) => PLACES[p].name)) : "the places that fit the video's shape", frame: null };
}

function dryRun(options) {
  // The folder's name comes from the file's name alone, and an address is
  // told by its name and whether a file has it, as the run tells it, so the
  // call checked here is not refused there: nothing is read.
  const { slug, notAddresses } = require("./lib/caption");
  const { video, words, brand, fonts } = options;
  notAddresses(options.command === "subtitles" ? { words, video, brand, fonts } : { video, words, brand, fonts });
  const places = placesOf(options);
  const out = options.out || (options.command === "subtitles" ? `easycaptionkit-subtitles-${slug(options.video || options.words)}` : `easycaptionkit-${slug(options.video)}`);
  const plan = {
    ok: true,
    dryRun: true,
    command: options.command,
    video: options.video || null,
    words: options.words,
    style: options.style,
    places: places.keys,
    ...(places.frame ? { frame: places.frame } : {}),
    position: options.position,
    lines: options.style === "word" ? 1 : options.lines,
    maxChars: options.maxChars || "what fits the safe width, at most 42",
    size: options.size,
    brand: options.brand || null,
    fonts: options.fonts || null,
    font: options.font || null,
    highlight: options.highlight || null,
    box: options.box,
    drawWith: options.command === "subtitles" ? null : options.libass ? "libass" : "chrome",
    out,
  };
  if (options.json) return JSON.stringify(plan, null, 2);
  const lines = [];
  // The names given, each on the line it is said on.
  const where = shown(out);
  const also = options.out ? "" : ` (or ${where}-2 and on, when that folder holds the captions of another file by that name)`;
  if (options.command === "subtitles") lines.push(`Would write captions.srt, captions.vtt, captions.ass, words.json, captions.json and CAPTIONS.md from ${shown(options.words)} into ${where}${also}.`);
  else lines.push(`Would caption ${shown(options.video)} with the words in ${shown(options.words)} into ${where}/captioned.mp4${also}, with captions.srt, captions.vtt, captions.ass, words.json, captions.json, sheet.png, safe-zones.png and CAPTIONS.md.`);
  const width = options.maxChars ? `of up to ${options.maxChars} characters` : "of what fits the safe space, up to 42 characters";
  lines.push(`  Style     ${options.style}${options.style === "word" ? ", one word at a time" : `, up to ${options.lines} ${options.lines === 1 ? "line" : "lines"} ${width}`}, ${options.size}% letters`);
  lines.push(`  Places    ${places.text}, at the ${options.position}`);
  const lit = options.style === "line" ? "" : options.highlight ? `the spoken word in ${options.highlight}` : options.brand ? `the spoken word in a color from ${shown(options.brand)}` : "the spoken word in yellow";
  const font = options.font ? `in ${options.font}` : options.fonts ? `in the fonts from ${shown(options.fonts)}` : "";
  lines.push(`  Look      ${["white", "bold", options.box ? "on a dark box" : "outlined", font, lit].filter(Boolean).join(", ")}`);
  lines.push("", "Nothing was read or written: this was a dry run.");
  return lines.join("\n");
}

function stylesText(json) {
  const styles = {
    karaoke: "Each caption whole, one or more lines, with the word being spoken lit in the highlight color. The usual look on TikTok, Reels and Shorts.",
    line: "Each caption whole, in one color. For YouTube, LinkedIn and anything people watch with the sound off for longer.",
    word: "One word at a time, bigger, lit in the highlight color. For short, quick clips; --position middle puts it in the middle of the safe space.",
  };
  const fields = {
    "--style": "karaoke, line or word",
    "--for": `${PLACE_NAMES.join(", ")}: the apps whose buttons the captions keep clear of`,
    "--position": "bottom, middle or top of the space every place leaves free",
    "--lines": "1 to 3 lines a caption (karaoke and line)",
    "--max-chars": "characters a line, 8 to 80; by default what fits the width at the size, at most 42",
    "--size": "letters as a percent of the phone's width, or of the frame's short side, 2 to 20",
    "--brand": "an easybrandkit folder or its brand.json: its button, link or logo color lights the spoken word, and its heading font is asked for by name when there is no --fonts or --font",
    "--fonts": "easyfontkit's folder or its fonts.css: the site's own font files, its heading font first",
    "--font": "a family from fonts.css or this machine",
    "--highlight": "the spoken word's color; a dark one lights the word on a patch of it, or in a thick border of it with --libass",
    "--box": "a dark box behind each line instead of the outline",
  };
  const places = PLACE_NAMES.map((key) => {
    const p = PLACES[key];
    const entries = p.screen ? [["screen", p]] : Object.entries(p.shapes).filter(([, v]) => typeof v !== "string");
    return { place: key, name: p.name, zones: entries.map(([shape, z]) => ({ shape, size: z.screen ? `${z.screen.width}x${z.screen.height}` : `${z.frame.width}x${z.frame.height}`, margins: z.margins, column: z.column || null, source: z.source, ...(z.note ? { note: z.note } : {}), url: z.url, read: z.read })) };
  });
  if (json) return JSON.stringify({ styles, fields, places }, null, 2);
  const lines = ["Styles", ""];
  for (const [name, about] of Object.entries(styles)) lines.push(`  ${name.padEnd(8)} ${about}`);
  lines.push("", "Fields", "");
  for (const [name, about] of Object.entries(fields)) lines.push(`  ${name.padEnd(12)} ${about}`);
  lines.push("", "Places and their margins, in pixels of the screen or frame named", "");
  for (const p of places) {
    for (const z of p.zones) {
      const m = z.margins;
      lines.push(`  ${`${p.place}${p.zones.length > 1 ? ` (${z.shape})` : ""}`.padEnd(22)} ${z.size}: top ${m.top}, bottom ${m.bottom}, left ${m.left}, right ${m.right}${z.column ? `, buttons ${z.column.width} wide from ${z.column.from} down` : ""}`);
      lines.push(`  ${"".padEnd(22)} from ${z.source}, read ${z.read}`);
      if (z.note) lines.push(`  ${"".padEnd(22)} ${z.note}`);
    }
  }
  return lines.join("\n");
}

function summary({ dir, facts: f }) {
  const lines = [];
  const L = f.layout;
  if (f.subtitlesOnly) {
    lines.push(`Wrote ${f.cues.length} ${f.cues.length === 1 ? "caption" : "captions"} from ${shown(f.source.file)} to ${shown(dir)}: captions.srt, captions.vtt, captions.ass, words.json, captions.json and CAPTIONS.md`);
  } else {
    const o = f.output;
    lines.push(`Captioned ${shown(f.video.file)} in ${shown(dir)}`);
    lines.push(`  Captions  ${f.cues.length} in the ${f.style} style${f.style === "word" ? "" : `, up to ${L.lines} ${L.lines === 1 ? "line" : "lines"} of ${L.maxChars} characters`}, ${L.fontPx} px`);
    lines.push(`  Places    ${list(f.places.map((z) => z.name))}, at the ${L.position}`);
    const drawn = (f.fontsDrawn || []).filter((x) => x.glyphs > 0);
    const libass = f.drawnWith === "libass";
    // libass draws a name with what this machine gives for it, which
    // fontconfig can say.
    const m = libass ? f.libassFont || null : null;
    let font;
    // The first font of the list, or the fonts that drew the captions
    // where it has none of their letters, as a Latin one has none of
    // Japanese.
    const firstDrew = drawn.some((x) => x.family === f.fontFirst);
    // With libass, the letters the font lacks are in the fonts captions.ass
    // sets them in, which can be all of them, as Japanese over a Latin font.
    const fallbacks = libass ? f.assFallbacks || [] : [];
    const none = libass && setsNone(f);
    if (!f.look.family) font = libass ? `Arial, asked for by name${m && !sameName(m.family, "Arial") ? ` (fontconfig gives ${m.family})` : ""}` : f.fontFirst ? (drawn.length && !firstDrew ? `${f.fontFirst}, which has none of these letters: ${list(drawn.map((x) => x.family))} drew them` : f.fontFirst) : drawn.length ? `a common sans (${list(drawn.map((x) => x.family))} drew it)` : "a common sans";
    else if (libass && variableFace(f.look) && setsAny(f)) font = `${f.look.family} from fonts.css, which libass draws at its variable file's default weight, not at ${f.look.weight}`;
    else if (libass && f.look.from === "machine") font = `${f.look.family} ${f.look.weight}, asked for by name${!m ? "; libass draws whatever this machine gives for that name" : sameName(m.family, f.look.family) ? "" : ` (not on this machine: fontconfig gives ${m.family})`}`;
    else font = `${f.look.family} ${f.look.weight}${f.look.from === "fonts.css" ? " from fonts.css" : ""}`;
    // libass found it by the name captions.ass gives it, the one in its file.
    const renamed = libass && f.look.from === "fonts.css" && f.assFamily && !sameName(f.assFamily, f.look.family);
    if (renamed) font += `, which captions.ass names ${f.assFamily}, as its file does`;
    const families = list(fallbacks.map((x) => x.family));
    const set = fallbacks.reduce((a, b) => a + b.letters, 0);
    if (none) font += `, ${renamed ? "and which" : "which"} has none of these letters: captions.ass sets them in ${families}`;
    else if (fallbacks.length) font += `; captions.ass sets the ${set} ${set === 1 ? "letter" : "letters"} it lacks in ${families}`;
    const missing = drawn.length && f.look.family && !drawn.some((x) => drewWith(x, f.look));
    const why = f.look.from !== "machine" ? "its file drew nothing" : machineHas(f) ? "it has none of these letters" : "not on this machine";
    // With Chrome, the fonts that drew the letters the font lacks, where
    // it drew some itself, as CAPTIONS.md counts them.
    const own = libass ? [] : drawn.filter((x) => (f.look.family ? drewWith(x, f.look) : x.family === f.fontFirst));
    const others = own.length ? drawn.filter((x) => !own.includes(x)) : [];
    const rest = others.reduce((a, b) => a + b.glyphs, 0);
    const filled = others.length ? `; Chrome drew the ${rest} ${rest === 1 ? "letter" : "letters"} it lacks with ${list(others.map((x) => (others.length > 1 ? `${x.family} (${x.glyphs})` : x.family)))}` : "";
    lines.push(`  Font      ${font}${missing ? ` (${why}: ${list(drawn.map((x) => x.family))} drew them)` : filled}`);
    if (f.style !== "line") lines.push(`  Lit word  ${f.look.highlightMode !== "patch" ? f.look.highlight : libass ? `in a thick border of ${f.look.highlight}` : `on a patch of ${f.look.highlight}`}`);
    lines.push(`  Video     captioned.mp4, ${o.width}x${o.height}, ${o.fps} fps, ${sec(o.duration)}, ${soundText(o.audio)}`);
  }
  const r = f.reading;
  lines.push(`  Reading   median ${r.median} characters a second${r.fast.length ? `, ${r.fast.length} ${r.fast.length === 1 ? "caption" : "captions"} faster than ${r.limit}` : `, none faster than ${r.limit}`}`);
  for (const note of f.notes) lines.push(`  Note      ${shown(note)}`);
  const md = shown(path.join(dir, "CAPTIONS.md"));
  lines.push("", f.subtitlesOnly ? `Read ${md} for the details.` : `Read ${md}, then look at sheet.png and safe-zones.png.`);
  // Each line one line, as CAPTIONS.md's are, whatever the font names in it.
  return lines.map(shown).join("\n");
}

async function main() {
  // Whatever reads the output can go away while the run goes on, as head
  // does once it has its lines: what is written after that is lost, and
  // the run still ends as it would, its files in place.
  for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`easycaptionkit: ${shown(err.message)}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  if (options.command === "styles") return void process.stdout.write(`${stylesText(options.json)}\n`);
  // A call the kit refuses, or a run that fails, says why with code 1, as
  // JSON on stdout too with --json, which writes a control character out;
  // the terminal gets the message on one line.
  const refuse = (err) => {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easycaptionkit: ${shown(err.message)}\n`);
    process.exit(1);
  };
  if (options.dryRun) {
    try {
      return void process.stdout.write(`${dryRun(options)}\n`);
    } catch (err) {
      return refuse(err);
    }
  }
  const log = options.json ? () => {} : (line) => process.stderr.write(`${line}\n`);
  const { captionVideo, makeSubtitles, stopOnSignals, stopped, began } = require("./lib/caption");
  stopOnSignals({ json: options.json });
  try {
    const { programOf } = require("./lib/report");
    // The commands the run prints start with the program as it was started.
    const common = { ...options, log, program: programOf() };
    const result = options.command === "subtitles" ? await makeSubtitles(options.words, common) : await captionVideo(options.video, common);
    process.stdout.write(options.json ? JSON.stringify(result.captions, null, 2) + "\n" : summary(result) + "\n");
  } catch (err) {
    // Ctrl-C stops the whole process group, and ffmpeg or Chrome can end
    // before this process hears its own signal: a run that failed after it
    // began gives that signal a moment to come, and a stopped run has said
    // so and ends by it. A signal that came while the run waited for its
    // words is heard once the process turns to what came in.
    await new Promise((resolve) => setImmediate(resolve));
    if (began()) await new Promise((resolve) => setTimeout(resolve, 200));
    if (stopped()) return;
    refuse(err);
  }
}

if (require.main === module) main();

module.exports = { parse, summary, dryRun, stylesText, USAGE };
