"use strict";

// A whole run. Everything is made in a work folder inside the output
// folder and moved into place only once all of it is made, so a run that
// fails leaves the folder as it was: no half written video, no subtitles
// from one run next to a video from another.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadWords, handFixed, wordsSha256, FORMATS, MOST_OPENED, DEEPEST } = require("./words");
const { cjkLanguage, arabicIn, scriptsIn } = require("./text");
const { buildCues, states: makeStates, readingSpeed } = require("./cues");
const { srt, vtt, ass, assFont, kitLetters, estimatedScales, shrunkOf, assLetters, SRT_SPECIAL } = require("./subtitles");
const { machineLetters, chromeBoxes, boxesIn } = require("./boxes");
const { captionLayout, charsThatFit, defaultPlaces, shapeOf } = require("./places");
const { chooseLook, variableFace, machineFont, fallbackFont } = require("./look");
const { fontLike } = require("./fontfile");
const ffmpeg = require("./ffmpeg");
const { chromeReady, chromeProblem, tempProblem } = require("./chrome");
const { renderStates } = require("./render");
const { safeZonesPng, sheetPng, plainPictures, shotOf } = require("./draw");
const { captionsMarkdown, captionsJson, subtitlesMarkdown, arg, subtitlesCommand, shown, captionsOf, lettersOf, boxesText, installText } = require("./report");
const { jsonShape, jsonProblem, decodeText } = require("./files");
const { stopAll } = require("./running");
const version = require("./version");

const TOOL = `easycaptionkit ${version}`;
// Every file a run writes; anything else in the folder is left alone.
const OUTPUTS = ["captioned.mp4", "captioned.timeline.json", "captions.srt", "captions.vtt", "captions.ass", "words.json", "captions.json", "sheet.png", "safe-zones.png", "CAPTIONS.md"];
// The files only a captioning run writes, next to the subtitle files.
const CAPTION_ONLY = ["captioned.mp4", "captioned.timeline.json", "sheet.png", "safe-zones.png"];
const SUBTITLE_OUTPUTS = OUTPUTS.filter((name) => !CAPTION_ONLY.includes(name));

// A file's name as the name of a folder: its letters and digits in any
// script, lower case, the rest as dashes. Accents come off Latin letters
// only (caf\u00e9, \u015fark\u0131); in other scripts the marks on a letter are part of
// it, as the voiced mark of a Japanese kana and the vowel signs of Hindi
// are, and a Korean syllable stays one letter, so the name a run prints is
// the one a person types. A name of more than 60 letters or 180 bytes is
// cut and ends in a short hash of the whole name, so two such files never
// share a folder, and easycaptionkit-subtitles- before it and -2 after it
// stay within the 255 bytes a disk takes for a name.
function slug(file) {
  const name = path.basename(file).replace(/\.[^.]+$/, "").normalize("NFC");
  const plain = (text) => text.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1");
  const words = plain(plain(name).toLowerCase())
    .normalize("NFC")
    // Anything else is a dash, with any mark on it: a mark is kept only on
    // a letter or a digit.
    .replace(/(?:[^\p{L}\p{N}\p{M}]\p{M}*)+/gu, "-")
    .replace(/^\p{M}+/u, "")
    .replace(/^-+|-+$/g, "");
  if (!words) return "video";
  const bytes = (text) => Buffer.byteLength(text, "utf8");
  const letters = Array.from(words);
  if (letters.length <= 60 && bytes(words) <= 180) return words;
  let cut = "";
  for (const letter of letters.slice(0, 53)) {
    if (bytes(cut + letter) > 172) break;
    cut += letter;
  }
  return `${cut.replace(/-+$/, "")}-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 6)}`;
}

// The folder as a message names it: "this folder" for the one the run is
// in.
const named = (dir) => (path.resolve(dir) === process.cwd() ? "this folder" : shown(dir));

const list = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// The folder can be made and written, checked before any work: the
// nearest folder that exists has to be one, and writable. A link on the
// way to a folder that is not there is said so, as musicfit says it, and
// so is a name longer than the disk takes, where making the folder would
// fail at the end of the work. (`paths`, `exists` and `lstat` stand in for
// Windows in the tests.)
function writable(dir, { paths = path, exists = fs.existsSync, lstat = (at) => fs.lstatSync(at, { throwIfNoEntry: false }) } = {}) {
  let at = paths.resolve(dir);
  // A folder on the way, named as the --out names it.
  const named = (folder) => (folder === paths.resolve(dir) ? "it" : paths.isAbsolute(dir) ? folder : paths.relative(process.cwd(), folder) || folder);
  while (!exists(at)) {
    let s = null;
    try {
      s = lstat(at);
    } catch (err) {
      if (err.code === "ENAMETOOLONG") throw new Error(`Cannot write to ${dir}: a name in it is longer than the disk takes`);
      // Else a file on the way, which is told below.
    }
    if (s && s.isSymbolicLink()) throw new Error(`Cannot write to ${dir}: ${named(at)} is a link to ${fs.readlinkSync(at)}, which is not there`);
    const up = paths.dirname(at);
    // A drive or network share that is not there is its own parent.
    if (up === at) throw new Error(`Cannot write to ${dir}: the drive or share is not there`);
    at = up;
  }
  try {
    if (!fs.statSync(at).isDirectory()) throw Object.assign(new Error(`${at} is a file`), { code: "ENOTDIR" });
    fs.accessSync(at, fs.constants.W_OK);
  } catch (err) {
    const why = { EACCES: "permission denied", EPERM: "permission denied", EROFS: "the disk is read-only", ENOTDIR: "a file is in the way" }[err.code] || err.message;
    throw new Error(`Cannot write to ${dir}: ${why}`);
  }
}

function mustExist(file, what) {
  if (!fs.existsSync(file)) throw new Error(`Cannot read ${file}: no such ${what}`);
}

// A name like https://example.com/demo.mp4. easycaptionkit reads files,
// so an input given as an address that is no file is refused before any
// work, as musicfit refuses one, where it was taken for a file that is not
// there. A video or words can be downloaded; a brand kit or a font kit is
// a folder that easybrandkit or easyfontkit makes from a site, which a
// download of the address is not, so the refusal names the kit. `inputs`
// are { video, words, brand, fonts }, in the order they are told; a dry
// run tells them too, from their names and whether a file has one.
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\//i;
const KIT_OF = { brand: ["--brand", "an easybrandkit folder or its brand.json", "easybrandkit"], fonts: ["--fonts", "an easyfontkit folder or its fonts.css", "easyfontkit"] };
function notAddresses(inputs) {
  for (const [role, name] of Object.entries(inputs)) {
    if (!name || !ADDRESS.test(name) || fs.existsSync(name)) continue;
    if (Object.hasOwn(KIT_OF, role)) {
      const [flag, takes, kit] = KIT_OF[role];
      throw new Error(`Cannot read ${name}: ${flag} takes ${takes}, so make one from that site with ${kit} first`);
    }
    throw new Error(`Cannot read ${name}: easycaptionkit reads files, not addresses, so download it first`);
  }
}

const statOf = (file) => {
  try {
    return fs.statSync(file, { bigint: true });
  } catch {
    return null;
  }
};

// What a name of the folder is itself: a link is not followed.
const lstatOf = (file) => {
  try {
    return fs.lstatSync(file, { bigint: true, throwIfNoEntry: false }) || null;
  } catch {
    return null;
  }
};

// A file's SHA-256, read in pieces, so a long video takes no more memory
// than a short one.
function sha256Of(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// A JSON file of the folder as easycaptionkit wrote it: { data } when it
// says easycaptionkit wrote it, { problem } when it is no longer JSON (a
// quote typed by hand can do that), else {}. Only a file of the size such
// a file has is read, and never a pipe: a run of the most words a run
// takes (words.js) writes its captions.json in some 40 MB. A text of more
// lists and objects than a words file may hold, or nested deeper, is no
// file a run wrote, and is not parsed.
function readOwn(file) {
  let text;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return {};
    text = decodeText(fs.readFileSync(file)).replace(/^\ufeff/, "");
  } catch {
    return {};
  }
  if (/^\s*[{[]/.test(text) && jsonShape(text, { most: MOST_OPENED, deepest: DEEPEST }).over) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { problem: jsonProblem(err, text) };
  }
  // A tool named by anything but text is none: an object with a toString of
  // its own would stop the run with an error that names no file.
  return data && typeof data === "object" && typeof data.tool === "string" && /^easycaptionkit\b/.test(data.tool) ? { data } : {};
}

const ours = (file) => Boolean(readOwn(file).data);

const timelineOf = (videoFile) => videoFile.replace(/\.[^./\\]+$/, "") + ".timeline.json";

// The most a launch-film timeline holds, a few KB for a film of a hundred
// clips, with room to spare: a file far bigger by that name is something
// else, and is not copied.
const MOST_TIMELINE = 4 * 1024 * 1024;

// A file's bytes, read only while they are no more than `most`: { bytes },
// { big: true } when it holds more, or { error } when it cannot be read.
function bytesOf(file, most) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const chunks = [];
    const chunk = Buffer.allocUnsafe(1 << 16);
    let total = 0;
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
      total += n;
      if (total > most) return { big: true };
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return { bytes: Buffer.concat(chunks) };
  } catch (err) {
    return { error: err };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// A size in bytes as people say it: 4.2 MB, 2.1 GB.
const bytesText = (size) => (size >= 2 ** 30 ? `${(size / 2 ** 30).toFixed(1)} GB` : `${(size / 2 ** 20).toFixed(1)} MB`);

// The files behind each input: a brand or font folder stands for the
// files read from it.
function filesOf(role, given) {
  const folder = statOf(given) && statOf(given).isDirectory();
  if (role === "brand") return folder ? ["brand.json", "_brand.yml", "brand/brand.json"].map((name) => path.join(given, name)) : [given];
  if (role === "fonts") {
    const css = folder ? path.join(given, "fonts.css") : given;
    return [css, path.join(path.dirname(css), "fonts.json")];
  }
  return [given];
}

const SHA256 = /^[0-9a-f]{64}$/;

// The files an earlier run says it wrote, with their sizes and SHA-256:
// { name: { size, sha256 } }. captions.json lists every other file its run
// wrote, words.json every one but captions.json.
function filesSaid(data) {
  const files = data && data.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) return {};
  return Object.fromEntries(Object.entries(files).filter(([name, f]) => OUTPUTS.includes(name) && f && typeof f === "object" && Number.isSafeInteger(f.size) && f.size >= 0 && typeof f.sha256 === "string" && SHA256.test(f.sha256)));
}

// What a run writes in captions.json and words.json: the files it wrote
// before them, each with its size and SHA-256, so the next run into the
// folder knows them, and knows them changed even when a hand edit keeps
// the size.
function writtenFiles(dir, names) {
  return Object.fromEntries(names.filter((name) => name !== "captions.json").map((name) => [name, { size: fs.statSync(path.join(dir, name)).size, sha256: sha256Of(path.join(dir, name)) }]));
}

// Checked before any work: a run replaces the files it writes in the
// folder, so none of them may be a file the run reads (through a link, a
// hard link or another letter case too), or a file by one of those names
// that easycaptionkit did not write. captions.json and words.json say
// easycaptionkit wrote them, and each names the other files its run
// wrote, with their sizes and SHA-256: a file is an earlier run's only
// when one of them names it and it is still what that run wrote. The
// kit writes no links, so a link by one of the names is no earlier run's
// either, even one to nothing. The one file read and written over is a
// words.json from an earlier run, fixed by hand; a run that does not read
// it does not replace the words fixed in it, and says how to keep them. A
// subtitles run leaves the captioning files alone, but does not go into a
// folder that holds what an earlier run captioned, whose captions its
// files would no longer match; when the words there were fixed by hand,
// it says how to make subtitles of them in a folder of their own.
// `options` are a subtitles run's, for the commands it gives.
//
// Returns what each name of the folder was then, { stat, sha256 } or
// null, so that the run can see, when it puts its files in place, that
// none came in or changed since.
function guard(dir, inputs, { subtitles = false, options = {} } = {}) {
  const at = (name) => path.join(dir, name);
  const where = named(dir);
  const stats = new Map(OUTPUTS.map((name) => [name, lstatOf(at(name))]));
  const existing = OUTPUTS.filter((name) => stats.get(name)).map((name) => ({ name, stat: stats.get(name) }));
  const sums = new Map();
  const view = () => new Map(OUTPUTS.map((name) => [name, stats.get(name) ? { stat: stats.get(name), sha256: sums.get(name) || "" } : null]));
  // The files this run writes over or takes away.
  const touched = existing.filter((o) => !subtitles || SUBTITLE_OUTPUTS.includes(o.name));
  for (const o of touched) {
    if (o.stat.isDirectory()) throw new Error(`${shown(at(o.name))} is a folder, and this run writes a file by that name. Pick another --out`);
    if (o.stat.isSymbolicLink()) throw new Error(`${shown(at(o.name))} is a link, and this run writes a file by that name. Pick another --out, or move ${o.name} away`);
    if (!o.stat.isFile()) throw new Error(`${shown(at(o.name))} is not a file, and this run writes a file by that name. Pick another --out`);
  }
  let readsOwnWords = false;
  for (const [role, given] of Object.entries(inputs)) {
    if (!given) continue;
    for (const file of filesOf(role, given)) {
      const s = statOf(file);
      if (!s) continue;
      const same = touched.find((o) => oneFile(o.stat, at(o.name), s, file));
      if (!same) continue;
      if (role === "words" && same.name === "words.json") {
        const own = readOwn(at("words.json"));
        if (own.problem) throw new Error(`Cannot read ${shown(file)}: it is not valid JSON${own.problem}. Fix it there and run again`);
        if (own.data) {
          readsOwnWords = true;
          continue;
        }
      }
      throw new Error(`${shown(file)} is the ${same.name} this run would write in ${where}. Pick another --out`);
    }
  }
  if (!touched.length) return view();
  // What the earlier run's captions.json and words.json say of each file.
  const said = new Map();
  const own = {};
  for (const name of ["captions.json", "words.json"]) {
    if (!existing.some((o) => o.name === name)) continue;
    own[name] = readOwn(at(name));
    if (own[name].problem) throw new Error(`${where} holds a ${name} that is not valid JSON${own[name].problem}, so it cannot say easycaptionkit wrote it. Fix it or move it away, or pick another --out`);
    if (!own[name].data) throw new Error(`${where} already holds a ${name} that easycaptionkit did not write, and this run would replace it. Pick another --out, or move ${name} away`);
    for (const [file, f] of Object.entries(filesSaid(own[name].data))) said.set(file, [...(said.get(file) || []), f]);
  }
  const sumOf = (o) => {
    if (!sums.has(o.name)) sums.set(o.name, sha256Of(at(o.name)));
    return sums.get(o.name);
  };
  // The SHA-256 is read only of a file whose size is the one written.
  const made = (o) => o.stat.isFile() && (said.get(o.name) || []).some((f) => f.size === Number(o.stat.size) && f.sha256 === sumOf(o));
  const fixedHere = Boolean(own["words.json"]) && handFixed(own["words.json"].data);
  // A subtitles run goes into no folder of what an earlier run captioned,
  // whatever its words: that comes first, and says how to make subtitles
  // of the words fixed there.
  if (subtitles) {
    const captioned = existing.filter((o) => CAPTION_ONLY.includes(o.name) && made(o)).map((o) => o.name);
    if (captioned.length) {
      const words = at("words.json");
      const base = `easycaptionkit-subtitles-${slug(options.video || words)}`;
      const elsewhere = defaultFolder(base, options.video ? { kind: "video", file: options.video } : { kind: "words", file: words }, words).dir;
      // The step in words, then its command, as CAPTIONS.md gives it, so it
      // still reads as a call where the kit's flags are a tool's parameters.
      const keep = fixedHere ? `. To make them from the words fixed by hand there, run subtitles with ${arg(words)} as the words file, the same ${options.video ? "--video and " : ""}options and --out ${arg(elsewhere)}: ${subtitlesCommand(options, words, elsewhere)}` : "";
      if (captioned.includes("captioned.mp4")) throw new Error(`${where} holds the captioned video of an earlier run, and new subtitle files next to it would not match its captions. Pick another --out${keep}`);
      throw new Error(`${where} holds the ${list(captioned)} of an earlier captioning run, and new subtitle files next to ${captioned.length === 1 ? "it" : "them"} would not match its captions. Pick another --out${keep}`);
    }
  }
  // The words of a person's fix are kept unless the run reads them.
  // The command that keeps them ends the message, so all that follows its
  // colon is the command.
  if (fixedHere && !readsOwnWords) {
    const fixed = at("words.json");
    const again = subtitles ? `run subtitles again with ${arg(fixed)} as the words file, the same ${options.video ? "--video and " : ""}options and --out ${arg(dir)}: ${subtitlesCommand(options, fixed, dir)}` : `run the same command with --words ${arg(fixed)} --out ${arg(dir)}`;
    throw new Error(`${shown(fixed)} holds words fixed by hand, and this run would replace them with the words of ${shown(path.basename(inputs.words))}. To start again from ${shown(path.basename(inputs.words))}, move ${shown(fixed)} away. To keep the fixes, ${again}`);
  }
  for (const o of touched) {
    if (o.name === "captions.json" || o.name === "words.json" || made(o)) continue;
    if (said.has(o.name)) throw new Error(`${where} holds a ${o.name} that has changed since an earlier easycaptionkit run wrote it, and this run would replace it. Pick another --out, or move ${o.name} away`);
    throw new Error(`${where} already holds ${o.name}, and no captions.json or words.json from an earlier easycaptionkit run says it made it. This run would replace it, so pick another --out, or move ${o.name} away`);
  }
  // captions.json and words.json were read whole, and are known by their
  // content as the others are.
  for (const o of touched) if ((o.name === "captions.json" || o.name === "words.json") && o.stat.isFile()) sumOf(o);
  return view();
}

// How a name of the folder is not what the guard saw: "came" when a file
// came in by that name while the run was going, "changed" when the one
// there changed, else "". A file whose ctime alone moved had its mode, an
// attribute or a link changed, as a sync client or the Finder does to a
// file it uploads or opens: its content tells whether it changed.
function changedSince(view, dir, name) {
  const now = lstatOf(path.join(dir, name));
  if (!now) return "";
  const then = view.get(name);
  if (!then) return "came";
  const s = then.stat;
  if (s.dev !== now.dev || s.ino !== now.ino || s.size !== now.size || s.mtimeNs !== now.mtimeNs) return "changed";
  if (s.ctimeNs === now.ctimeNs) return "";
  return then.sha256 && now.isFile() && sha256Of(path.join(dir, name)) === then.sha256 ? "" : "changed";
}

// ─── which video a folder holds the captions of ───────────────────────────

// A file's whole path as the disk has it, links followed.
function realOf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// Whether two files, each a stat and its name, are one: by the disk and
// the number there, which holds for a link and for another letter case on
// a disk that does not tell cases apart; by the whole path when the disk
// gives its files no numbers, as some network shares and FUSE drives do.
function oneFile(x, a, y, b) {
  if (x.ino !== 0n && y.ino !== 0n) return x.dev === y.dev && x.ino === y.ino;
  return realOf(a) === realOf(b);
}

// Whether two names are one file, as above, or by the whole path when one
// is gone.
function sameFile(a, b) {
  const x = statOf(a);
  const y = statOf(b);
  return x && y ? oneFile(x, a, y, b) : realOf(a) === realOf(b);
}

// Where a file is, as captions.json says it: from the output folder, so
// the two can move together.
const fromFolder = (dir, file) => path.relative(realOf(dir), realOf(file)) || ".";

// What a run made its files from: the video, or for subtitles with no
// video the words file, where the words first came from when the run read
// the folder's own words.json. { kind, file } with the file's whole path,
// or null when an earlier run's captions.json does not say.
function sourceOf(json, dir) {
  const of = (part) => (part && typeof part.from === "string" ? path.resolve(realOf(dir), part.from) : null);
  if (json.video) return of(json.video) ? { kind: "video", file: of(json.video) } : null;
  const words = json.words && json.words.origin && typeof json.words.origin.from === "string" ? json.words.origin : json.words;
  return of(words) ? { kind: "words", file: of(words) } : null;
}

// Where the words of a run first came from, when it reads the folder's own
// words.json, fixed by hand: what the earlier run's captions.json says, so
// the folder keeps saying it. { file, from, format }, from the folder, or
// null.
function originOf(dir, wordsFile) {
  if (!sameFile(wordsFile, path.join(dir, "words.json"))) return null;
  const earlier = readOwn(path.join(dir, "captions.json")).data;
  const words = earlier && earlier.words && typeof earlier.words === "object" ? earlier.words : null;
  if (!words) return null;
  const first = words.origin && typeof words.origin === "object" ? words.origin : words;
  if (typeof first.file !== "string" || typeof first.from !== "string" || first.from === "words.json") return null;
  return { file: first.file, from: first.from, ...(typeof first.format === "string" ? { format: first.format } : {}) };
}

// The format the words of a run first came in, by its name in FORMATS:
// the one a words.json of this kit names as its `from`, else, when the run
// reads the folder's own words.json, the one the earlier run's
// captions.json says, else the format of the file read. A demo's steps
// read again from their words.json are still a demo's steps.
function firstFormat(read, origin) {
  const said = origin && typeof origin.format === "string" && origin.format !== "easycaptionkit" && Object.hasOwn(FORMATS, origin.format) ? origin.format : "";
  return read.firstFormat || said || read.format;
}

// Whether an earlier run in `dir` made its files from `source` too. A
// subtitles run with no video from the folder's own words.json, the fixed
// words of that earlier run, is the same run made again; any other run
// is told by its video or its words file. An earlier run that does not
// say is taken to be the same, as it always was.
function sameSource(dir, source, wordsFile) {
  const earlier = readOwn(path.join(dir, "captions.json")).data;
  if (!earlier) return { same: true };
  if (source.kind === "words" && sameFile(wordsFile, path.join(dir, "words.json"))) return { same: true };
  const before = sourceOf(earlier, dir);
  if (!before) return { same: true };
  return { same: before.kind === source.kind && sameFile(before.file, source.file), before };
}

// The folder a run goes to when no --out is given: easycaptionkit-<name>,
// or, when that holds the captions of another file by the same name,
// easycaptionkit-<name>-2, -3 and on, so no run replaces another video's.
function defaultFolder(base, source, wordsFile) {
  for (let n = 1; n < 100; n++) {
    const dir = n === 1 ? base : `${base}-${n}`;
    if (sameSource(dir, source, wordsFile).same) return { dir, note: n > 1 ? `${base} holds the captions of another ${shown(path.basename(source.file))}, so these are in ${dir}.` : "" };
  }
  return { dir: base, note: "" };
}

// The folder of a run, and a note when it replaces what an earlier run
// made from another file.
function outFolder(options, base, source, wordsFile) {
  if (!options.out) return defaultFolder(base, source, wordsFile);
  const { same, before } = sameSource(options.out, source, wordsFile);
  const where = named(options.out) === "this folder" ? "This folder" : named(options.out);
  return { dir: options.out, note: same ? "" : `${where} held the files an earlier run made from ${shown(fromFolder(process.cwd(), before.file))}, and this run replaced them.` };
}

// ─── the work folder ──────────────────────────────────────────────────────

const WORK = /^\.easycaptionkit-work-/;
const DAY = 24 * 3600 * 1000;
// The signals that stop a run, with the code it ends with: Ctrl+Break
// sends SIGBREAK on Windows.
const signalsOf = (platform) => ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129, ...(platform === "win32" ? { SIGBREAK: 149 } : {}) });
const SIGNALS = signalsOf(process.platform);

// The run that owns a work folder, while it is still going: its process
// is alive on this machine. A run on another machine (a shared folder)
// cannot be asked, so its folder counts as live for a day. An owner.json
// that is not the object a run writes, with its pid, host and start, as
// null or a host that is no text, names no run.
function liveOwner(work) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(path.join(work, "owner.json"), "utf8"));
  } catch {
    return null;
  }
  if (!owner || typeof owner !== "object" || typeof owner.host !== "string" || typeof owner.started !== "string") return null;
  if (!Number.isInteger(owner.pid) || !(Date.now() - Date.parse(owner.started) < DAY)) return null;
  if (owner.host !== os.hostname()) return owner;
  try {
    process.kill(owner.pid, 0);
    return owner;
  } catch (err) {
    return err.code === "EPERM" ? owner : null;
  }
}

// What earlier runs left in the folder. A work folder another run is
// still using stops this one. One a stopped run left goes, once the
// earlier files it held, which that run could not put back, are back in
// the folder; one whose name the folder has again stops the run, and the
// message says where it is. Only a folder is a work folder: a link or a
// file by such a name is no run's, and stays where it is, as does what a
// link named .before leads to. Returns a note for each file put back.
function recover(dir, given) {
  const notes = [];
  if (!fs.existsSync(dir)) return notes;
  const folder = (file) => Boolean(lstatOf(file) && lstatOf(file).isDirectory());
  for (const name of fs.readdirSync(dir)) {
    if (!WORK.test(name)) continue;
    const work = path.join(dir, name);
    if (!folder(work)) continue;
    const owner = liveOwner(work);
    if (owner) throw new Error(`Another easycaptionkit run (process ${owner.pid}${owner.host !== os.hostname() ? ` on ${owner.host}` : ""}) is writing to ${named(given)}. Wait for it to end, or pick another --out. If no run is going, remove ${shown(path.join(given, name))}`);
    const before = path.join(work, ".before");
    let kept = [];
    try {
      if (folder(before)) kept = fs.readdirSync(before).filter((file) => OUTPUTS.includes(file));
    } catch {
      // Nothing was kept.
    }
    const taken = kept.filter((file) => fs.lstatSync(path.join(dir, file), { throwIfNoEntry: false }));
    if (taken.length) throw new Error(`${shown(path.join(given, name, ".before"))} holds the earlier ${list(taken)} that a run could not put back, and ${named(given)} has ${taken.length === 1 ? "a file by that name" : "files by those names"} again. Move ${taken.length === 1 ? "it" : "them"} where you want ${taken.length === 1 ? "it" : "them"}, remove ${shown(path.join(given, name))} and run again`);
    for (const file of kept) {
      fs.renameSync(path.join(before, file), path.join(dir, file));
      notes.push(`The earlier ${file}, which a run could not put back, went back into ${named(given)} before this run started.`);
    }
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return notes;
}

// ─── a run stopped by a signal ────────────────────────────────────────────

// The runs of this process that began and have not ended; the folder, as
// given, of the last one that began, and whether it ended well; whether a
// signal has stopped them; and the listeners stopOnSignals added.
const going = new Set();
const last = { folder: null, done: false };
let stopping = false;
const watching = new Map();
// Whether the command line asked for JSON, as stopOnSignals was told.
let asJson = false;

// Written at once: a pipe can be asynchronous, and the process ends next.
function say(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // Nobody is reading.
  }
}

// A run stopped with Ctrl-C or a kill ends the programs it started, and
// its work folder and the folders it made go, so the folder is as it was.
// It says so, on stdout too as JSON with --json, and ends by that signal,
// so a shell running the kit in a loop stops the loop too: bash goes on
// unless its program died by SIGINT. Windows has no such signals; there
// the code says it.
function stopBySignal(signal, { json = false } = {}) {
  if (stopping) return;
  stopping = true;
  stopAll();
  for (const run of [...going]) abandon(run);
  const message = last.folder === null ? "stopped" : last.done ? "" : `stopped, so ${named(last.folder)} is as it was`;
  if (message && json) say(1, JSON.stringify({ ok: false, error: message }) + "\n");
  if (message) say(2, `easycaptionkit: ${message}\n`);
  for (const [name, listener] of watching) process.removeListener(name, listener);
  watching.clear();
  if (process.platform !== "win32" && process.listenerCount(signal) === 0) {
    process.kill(process.pid, signal);
    // Only reached when the signal does not end the process.
    setTimeout(() => process.exit(SIGNALS[signal] || 143), 500);
    return;
  }
  process.exit(SIGNALS[signal] || 143);
}

// For the command line: a signal stops the run as above from before the
// run begins to the end of the process, so a stop that comes a moment
// after the run failed over it, as when Ctrl-C reaches ffmpeg first, is
// still said as a stop. Elsewhere each run listens while it goes.
function stopOnSignals({ json = false } = {}) {
  asJson = json;
  watchExit();
  if (watching.size) return;
  for (const signal of Object.keys(SIGNALS)) {
    const listener = () => stopBySignal(signal, { json });
    watching.set(signal, listener);
    process.on(signal, listener);
  }
}

// Whether a signal stopped this process's runs, and whether a run began.
const stopped = () => stopping;
const began = () => last.folder !== null;

// A process that ends while a run is going, by an error nothing caught or
// a process.exit from elsewhere, ends the programs the run started, and
// its work folder and the folders it made go, as when it fails: no ffmpeg
// goes on encoding into a folder no run will clear, and no Chrome profile
// stays. Both are done at once, since a process that exits waits for
// nothing. A process that ends with code 0 while a run is going had
// nothing left to wait for, as when a program the run waited on went away
// and nothing said so: the run did not end well, and that is said, with
// code 1.
let watchingExit = false;
function watchExit() {
  if (watchingExit) return;
  watchingExit = true;
  process.on("exit", (code) => {
    const runs = [...going];
    stopAll();
    for (const run of runs) abandon(run);
    if (!runs.length || code || process.exitCode) return;
    const message = `the run ended before it was done, so ${named(runs[runs.length - 1].given || runs[runs.length - 1].dir)} is as it was`;
    if (asJson) say(1, JSON.stringify({ ok: false, error: message }) + "\n");
    say(2, `easycaptionkit: ${message}\n`);
    process.exitCode = 1;
  });
}

// Starts a run's folder: made when missing, with a work folder in it that
// says which process owns it. If the run is stopped with Ctrl-C or a
// kill, the programs it started, its work folder and the folders it made
// go too, and the run ends by that signal.
function begin(given) {
  const dir = path.resolve(given);
  watchExit();
  recover(dir, given);
  // The first folder mkdir made, if it made any: a failed run removes
  // what it made, up to there.
  const made = fs.mkdirSync(dir, { recursive: true });
  const work = workFolder(dir);
  fs.writeFileSync(path.join(work, "owner.json"), JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString() }) + "\n");
  const run = { dir, given, made, work, keep: false };
  going.add(run);
  Object.assign(last, { folder: given, done: false });
  if (!watching.size) {
    run.stop = (signal) => stopBySignal(signal);
    for (const signal of Object.keys(SIGNALS)) process.once(signal, run.stop);
  }
  return run;
}

// A run's work folder in `dir`, by a name no other run has: made with the
// default mode, so it takes the umask and, under a default ACL, the access
// the folder gives, as the files of the run do. mkdtemp's 0700 would shut
// out the others the ACL lets in, as a hosted worker that clears what a
// run killed outright left behind.
function workFolder(dir) {
  for (let n = 1; ; n++) {
    const work = path.join(dir, `.easycaptionkit-work-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.mkdirSync(work);
      return work;
    } catch (err) {
      if (err.code !== "EEXIST" || n >= 20) throw err;
    }
  }
}

function release(run) {
  going.delete(run);
  if (run.stop) for (const signal of Object.keys(SIGNALS)) process.removeListener(signal, run.stop);
}

// The run's files, in a folder of their own next to the work folder, when
// they cannot go in place: easycaptionkit-new, or -2 and on when that is
// taken. Made with the folder's own access, as the output folder's files
// are.
function setAside(run, names) {
  for (let n = 1; ; n++) {
    const aside = path.join(run.dir, n === 1 ? "easycaptionkit-new" : `easycaptionkit-new-${n}`);
    try {
      fs.mkdirSync(aside);
    } catch (err) {
      if (err.code === "EEXIST" && n < 100) continue;
      throw err;
    }
    for (const name of names) fs.renameSync(path.join(run.work, name), path.join(aside, name));
    return aside;
  }
}

// Moves the made files into place. What an earlier run wrote goes into the
// work folder first, so a file that cannot be moved (one a player holds
// open, say) puts everything back as it was. A captioning run also takes
// away what an earlier one made that this one does not, so nothing in the
// folder is from another run. An earlier file that cannot be put back
// stays in the work folder's .before, where the next run into the folder
// finds it; once the new files are in, .before is .replaced, which the
// next run only removes.
//
// `view` is what the guard saw of each name before the run started. A file
// that came in by one of them since, or one that changed, from a person,
// an editor's export or another tool while the encode ran, is no earlier
// run's: the folder is left as it is, and the new files go in a folder of
// their own, which the error names.
function finish(run, names, { stale = true, view = null } = {}) {
  const how = view ? OUTPUTS.filter((name) => stale || names.includes(name)).map((name) => [name, changedSince(view, run.dir, name)]) : [];
  const came = how.filter(([, h]) => h === "came").map(([name]) => name);
  const changed = how.filter(([, h]) => h === "changed").map(([name]) => name);
  if (came.length || changed.length) {
    const aside = setAside(run, names);
    const given = run.given || run.dir;
    const what = [came.length ? `${list(came)} came into ${named(given)}` : "", changed.length ? `${list(changed)} changed ${came.length ? "there" : `in ${named(given)}`}` : ""].filter(Boolean).join(" and ");
    throw new Error(`${what} while this run was going, so the run left the folder as it was. Its files are in ${shown(path.join(given, path.basename(aside)))}: move them where you want them, or run again`);
  }
  const before = path.join(run.work, ".before");
  fs.mkdirSync(before);
  const moved = [];
  const placed = [];
  try {
    for (const name of OUTPUTS) {
      if (!stale && !names.includes(name)) continue;
      if (!fs.lstatSync(path.join(run.dir, name), { throwIfNoEntry: false })) continue;
      fs.renameSync(path.join(run.dir, name), path.join(before, name));
      moved.push(name);
    }
    for (const name of names) {
      fs.renameSync(path.join(run.work, name), path.join(run.dir, name));
      placed.push(name);
    }
  } catch (err) {
    const left = [];
    for (const name of placed.reverse()) {
      try {
        fs.renameSync(path.join(run.dir, name), path.join(run.work, name));
      } catch {
        // Replaced again from `before` below, or left as it is.
      }
    }
    for (const name of moved.reverse()) {
      try {
        fs.rmSync(path.join(run.dir, name), { force: true });
        fs.renameSync(path.join(before, name), path.join(run.dir, name));
      } catch {
        left.push(name);
      }
    }
    // An earlier file that could not go back stays in the work folder.
    if (left.length) run.keep = true;
    throw new Error(`Could not move the new files into ${shown(run.dir)}: ${err.message}. ${left.length ? `The earlier ${left.join(", ")} could not be put back and ${left.length === 1 ? "is" : "are"} in ${shown(before)}, where the next run into the folder puts ${left.length === 1 ? "it" : "them"} back` : "The folder is as it was"}`);
  }
  release(run);
  if (last.folder === run.given) last.done = true;
  try {
    fs.renameSync(before, path.join(run.work, ".replaced"));
    fs.rmSync(run.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // The files are in place; the next run into this folder removes it.
  }
}

function abandon(run) {
  release(run);
  if (!run.keep) {
    try {
      fs.rmSync(run.work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Gone with the next run into this folder.
    }
  }
  if (!run.made) return;
  // The folders this run made, deepest first, as long as they are empty:
  // what is in them otherwise is not this run's.
  for (let at = run.dir; ; at = path.dirname(at)) {
    try {
      fs.rmdirSync(at);
    } catch {
      break;
    }
    if (at === run.made || path.dirname(at) === at) break;
  }
}

// Two turns of the event loop, so that a signal that came while the run
// worked without a pause, as it reads a large words file into captions and
// writes captions.ass, is heard before the run begins or puts its files in
// place: the process looks at the signals that came in once a turn, and a
// run that does not wait goes to its end and leaves the signal unheard.
const heard = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

// A run that fails ends what it started before its work folder goes: an
// ffmpeg still taking a frame would write into it.
function fail(run, err) {
  stopAll();
  abandon(run);
  throw err;
}

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// A share in whole percent, rounded down, so a share under 1 never shows
// as 100%.
const percentOf = (share) => Math.floor(share * 100 + 1e-9);
// The encode's progress, logged at each tenth.
const encodingLine = (share) => `Encoding ${percentOf(share)}%`;

// A still picture given as the video, as a thumbnail or a poster frame can
// be, is refused as musicfit refuses one, where its length of a frame said
// the words belong to another video: one frame and no sound, read by one
// of ffmpeg's picture readers (image2 for a JPEG, png_pipe and the other
// _pipe ones), or lasting no more than a tenth of a second. A picture over
// sound, or one frame held for seconds, is a video, and is captioned.
const PICTURE = /^(?:image2|image2pipe|\w+_pipe)$/;
function notStill(video, name) {
  if (video.frames <= 1 && !video.audio.length && (PICTURE.test(video.container) || !(video.duration > 0.1))) throw new Error(`${name} is a still picture, not a video`);
}

// The words, cut to the video: words after its end are left out, a word
// that runs past it is cut there.
function fitWords(read, duration, givenBy = "") {
  const notes = [];
  if (!Number.isFinite(duration)) return { words: read.words, notes };
  const words = read.words.filter((w) => w.start < duration - 0.05).map((w) => ({ ...w, end: Math.min(w.end, duration) }));
  const dropped = read.words.length - words.length;
  // `givenBy`: the file that gives the length where no video was given,
  // which says nothing of whether its own words belong to its video.
  const end = `${duration.toFixed(2)} s${givenBy ? `, as ${givenBy} gives its length` : ""}`;
  if (dropped) notes.push(`${dropped} ${dropped === 1 ? "word starts" : "words start"} after the video ends (${end}) and ${dropped === 1 ? "was" : "were"} left out.${givenBy ? "" : " Check that the words belong to this video."}`);
  if (!words.length) throw new Error(`Every word starts after the video ends (${end}). ${givenBy ? "The times in that file or the length it gives are wrong" : "The words file belongs to another video, or its times are in another unit"}`);
  const last = words[words.length - 1].end;
  if (!givenBy && last < duration * 0.5 && duration > 20) notes.push(`The words end at ${last.toFixed(1)} s, before half of the video (${duration.toFixed(1)} s). Check that they belong to this video.`);
  return { words, notes };
}

function cueLayout(options, width, height, places) {
  const style = options.style;
  const lines = style === "word" ? 1 : options.lines;
  const place = captionLayout(width, height, places, { style, size: options.size, position: options.position, lines, box: Boolean(options.box) });
  const maxChars = options.maxChars || charsThatFit(place.glyphWidth, place.fontPx);
  return { place, lines, maxChars };
}

// A color #rrggbb as its red, green and blue, 0 to 255.
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// The color matrices a note names, by ffprobe's names for them.
const MATRICES = { bt709: "BT.709", bt601: "BT.601", bt2020: "BT.2020", bt2020c: "BT.2020 constant luminance", ictcp: "ICtCp", "ipt-c2": "IPT-C2", "ycgco-re": "YCgCo-R", "ycgco-ro": "YCgCo-R", smpte2085: "SMPTE ST 2085", "chroma-derived-nc": "chromaticity derived", "chroma-derived-c": "chromaticity derived constant luminance" };

// The captions SRT readers would take for formatting, by number.
function specialNote(cues) {
  const odd = cues.filter((cue) => cue.lines.some((line) => SRT_SPECIAL.test(line))).map((cue) => cue.n);
  if (!odd.length) return [];
  const which = odd.length > 6 ? `${odd.slice(0, 6).join(", ")} and ${odd.length - 6} more` : list(odd.map(String));
  return [`${odd.length === 1 ? `Caption ${which} has` : `Captions ${which} have`} < > { } or \\ in ${odd.length === 1 ? "it" : "them"}, which SRT readers take for formatting, so captions.srt has ‹ › ( ) and ⧵ in their place, and captions.ass ( ) and ⧵.`];
}

// The letters libass drew boxes for, since this machine has no font it
// can draw them with, as notes: emoji, which libass draws in no color
// font, and any other letters, with what to do. `missing` and `unsure`
// are assLetters': where nothing says which font an emoji goes in, as on
// macOS and Windows, the note says it can be a box.
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
function missingNotes(missing, unsure = []) {
  const boxes = (n) => (n === 1 ? "a box for it" : "boxes for them");
  const emoji = missing.filter((m) => EMOJI.test(m.letter));
  const other = missing.filter((m) => !EMOJI.test(m.letter));
  const notes = [];
  if (emoji.length) notes.push(`libass draws no color emoji, and this machine has no other font that draws ${emoji.length === 1 ? "the emoji" : `the ${emoji.length} emoji`} in ${captionsOf(emoji)} (${lettersOf(emoji)}) whole, so the video shows ${boxes(emoji.length)}. Leave out --libass to have Chrome draw ${emoji.length === 1 ? "it" : "them"}.`);
  if (other.length) notes.push(`${boxesText(other, "libass")} ${installText(other)}`);
  if (unsure.length) notes.push(`libass draws no color emoji, so ${unsure.length === 1 ? "the emoji" : `the ${unsure.length} emoji`} in ${captionsOf(unsure)} (${lettersOf(unsure)}) can show as ${unsure.length === 1 ? "a box" : "boxes"}: nothing on this machine says which font libass draws ${unsure.length === 1 ? "it" : "them"} with. Leave out --libass to have Chrome draw ${unsure.length === 1 ? "it" : "them"}.`);
  return notes;
}

// The letters Chrome drew as boxes, [{ letter, cue }], as a note: which,
// and what to do.
const boxesNotes = (boxes) => (boxes.length ? [`${boxesText(boxes, "chrome")} ${installText(boxes)}`] : []);

// The folder of a fonts.css font's files, which ffmpeg's ass filter finds
// the font of captions.ass in when it is its fontsdir, from the output
// folder `dir`, where captions.ass is; else "".
const fontsFolder = (look, dir) => (look.from === "fonts.css" && look.faces.length ? path.relative(path.resolve(dir), path.dirname(look.faces[0].file)) || "." : "");

// The folder ffmpeg's ass filter finds the look's font files in: a folder
// of the work folder that holds those files alone, each linked, or copied
// where no link can be made, or "" when the look has none. libass reads
// every file of the folder it is given into memory, and the folder of a
// fonts.css made elsewhere can hold any file next to its fonts, which that
// fonts.css can name too: a file past 64 MB, or one that does not start as
// a font file does, which the kit's own measuring passes over too, is no
// font libass can use, and is left out.
function fontsOfLook(look, work) {
  if (!look.faces.length) return "";
  const dir = path.join(work, "fonts");
  fs.mkdirSync(dir);
  const taken = new Set();
  for (const file of new Set(look.faces.map((f) => f.file))) {
    if (!fontLike(file)) continue;
    let name = path.basename(file);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${n}-${path.basename(file)}`;
    taken.add(name.toLowerCase());
    try {
      fs.linkSync(file, path.join(dir, name));
    } catch {
      try {
        fs.copyFileSync(file, path.join(dir, name));
      } catch {
        // A file that cannot be read is no font libass can use.
      }
    }
  }
  return dir;
}

// What fontconfig gives for a letter the font of captions.ass lacks, for
// a look: bold as it is, in the language of its words.
const givenFor = (look) => (code) => fallbackFont(code, look.weight, look.lang);

// What the look needs to know of the words' scripts: the language of
// CJK words, whether there are Arabic letters, and the scripts of India
// and Southeast Asia they hold letters of.
const scriptsOf = (words) => {
  const texts = words.map((w) => w.text);
  return { lang: cjkLanguage(texts), arabic: arabicIn(texts), scripts: scriptsIn(texts) };
};

// caption_video. options: { words, style, places, brand, fonts, font,
// highlight, position, lines, maxChars, size, box, libass, out, log }
async function captionVideo(videoFile, options) {
  const log = options.log || (() => {});
  notAddresses({ video: videoFile, words: options.words, brand: options.brand, fonts: options.fonts });
  mustExist(videoFile, "file");
  mustExist(options.words, "file");
  if (options.brand) mustExist(options.brand, "file or folder");
  if (options.fonts) mustExist(options.fonts, "file or folder");
  const folder = outFolder(options, `easycaptionkit-${slug(videoFile)}`, { kind: "video", file: videoFile }, options.words);
  const dir = folder.dir;
  const origin = originOf(dir, options.words);
  writable(dir);
  const notes = recover(path.resolve(dir), dir);
  const view = guard(dir, { video: videoFile, timeline: timelineOf(videoFile), words: options.words, brand: options.brand, fonts: options.fonts });
  const useLibass = Boolean(options.libass);
  // Chrome keeps its profile in the temporary folder.
  const temp = useLibass ? "" : tempProblem();
  if (temp) throw new Error(`${temp}. Set it to a folder, or unset it`);
  // Each program the run uses is asked its version before the video is
  // read, Chrome while ffmpeg is: one that cannot be started or does not
  // answer as itself stops the run with what the system or the program
  // said, ffmpeg's first.
  const chrome = useLibass ? null : chromeReady();
  if (chrome) chrome.catch(() => {});
  const tools = await ffmpeg.ready();
  if (chrome) await chrome;
  const bins = { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe, places: tools.places };
  const [video, caps] = await Promise.all([ffmpeg.readVideo(videoFile, bins), ffmpeg.capabilities(bins, tools.version)]);
  notStill(video, videoFile);
  if (!caps.encoder) throw new Error("This ffmpeg has no H.264 encoder (libx264, VideoToolbox, OpenH264 or Media Foundation), so it cannot write the captioned MP4");
  if (useLibass && !caps.libass) throw new Error("This ffmpeg has no libass (its ass filter), so --libass cannot draw the captions. Leave out --libass to draw them with Chrome, or install an ffmpeg built with libass");
  if (!useLibass && !caps.overlay) throw new Error("This ffmpeg has no overlay filter, so it cannot lay the captions over the video");
  const read = await loadWords(options.words);
  const first = firstFormat(read, origin);
  const look = chooseLook({ ...options, ...scriptsOf(read.words) });
  if (folder.note) notes.push(folder.note);
  notes.push(...read.notes, ...look.notes, ...video.notes);
  const { width, height } = video.out;
  const places = options.places && options.places.length ? options.places : defaultPlaces(width, height);
  const { place, lines, maxChars } = cueLayout(options, width, height, places);
  notes.push(...place.notes);
  const fitted = fitWords(read, video.duration);
  notes.push(...fitted.notes);
  if (read.format === "steps" && read.video && Math.abs(read.video.duration - video.duration) > 0.5) notes.push(`steps.json is for a video ${read.video.duration.toFixed(1)} s long, and this one is ${video.duration.toFixed(1)} s. The captions follow the steps' times.`);
  const words = fitted.words;
  log(`Read ${count(words.length, "word", "words")} from ${shown(path.basename(options.words))} (${read.about})`);
  const cues = buildCues(words, { lines, maxChars, hard: read.hard, duration: video.duration });
  const states = makeStates(cues, words, options.style);
  log(`Cut ${words.length === 1 ? "it" : "them"} into ${count(cues.length, "caption", "captions")}`);
  notes.push(...specialNote(cues));
  if (video.rotation) notes.push(`The video is stored turned ${video.rotation} degrees; it was captioned upright, as players show it, and written upright.`);
  if (video.sar !== 1) notes.push(`The video's pixels are not square (${video.sar.toFixed(3)}:1); it was scaled to ${width}x${height} with square pixels first.`);
  if (video.width !== width || video.height !== height) notes.push(`The video is ${video.width}x${video.height}; H.264 needs even sides, so the last ${video.width !== width && video.height !== height ? "column and row" : video.width !== width ? "column" : "row"} of pixels ${video.width !== width && video.height !== height ? "were" : "was"} cut, to ${width}x${height}.`);
  if (video.hdr) notes.push(`The video is HDR (${/arib/.test(video.color.transfer) ? "HLG" : "PQ"}). It ${caps.tenBit ? "stays HDR in 10 bits" : "was written in 8 bits with its HDR tags, since this ffmpeg's x264 writes no 10 bits, so smooth skies can band"}, and the captions' white is the reference white for graphics on HDR, not the brightest the screen shows. Check it on the phone it was shot with.`);
  // What the picture loses on its way to the 8-bit 4:2:0, or 10-bit for HDR, every app takes.
  const format = ffmpeg.pixelFormat(video.pixFmt);
  const bits = video.hdr && caps.tenBit ? 10 : 8;
  if (format.rgb) notes.push(`The video's picture is stored as RGB (${video.pixFmt}); it was written as ${bits}-bit 4:2:0, with the ${MATRICES[ffmpeg.colorOf(video).matrix]} matrix, which every app takes.`);
  else {
    const changed = [...(format.bits > bits && !video.hdr ? [[`${format.bits}-bit`, `${bits}-bit`]] : []), ...(format.chroma && format.chroma !== "4:2:0" ? [[format.chroma, "4:2:0"]] : [])];
    if (changed.length) notes.push(`The video is ${changed.map((c) => c[0]).join(" ")}; it was written as ${changed.map((c) => c[1]).join(" ")}, which every app takes.`);
  }
  if (!video.audio.length) notes.push("The video has no sound.");
  const color = ffmpeg.colorOf(video, caps.colorNames);
  if (color.kept) notes.push(`The video's color matrix is ${MATRICES[color.kept] || color.kept}, which ffmpeg converts no colors into, so captioned.mp4 keeps it, and the captions' colors are coded in ${MATRICES[color.matrix]}: a player that follows the video's matrix shows the captions in other colors.`);
  const lost = leftOut(video);
  if (lost) notes.push(lost);
  // launch-film's timeline next to the film, looked at before any work: a
  // file far bigger than one is passed over, and said.
  const timeline = timelineOf(videoFile);
  const timelineStat = statOf(timeline);
  const tooBig = (size) => `${shown(path.basename(timeline))}, next to the video, is ${bytesText(size)}, far more than a launch-film timeline holds, so it was not copied as captioned.timeline.json.`;
  let copyTimeline = Boolean(timelineStat && timelineStat.isFile());
  if (copyTimeline && Number(timelineStat.size) > MOST_TIMELINE) {
    notes.push(tooBig(Number(timelineStat.size)));
    copyTimeline = false;
  }
  // Frames at a steady rate where the video has too few for the captions,
  // said here once the result shows which captions are on its frames.
  const fill = ffmpeg.fillFor(video, states);
  const fillAt = notes.length;

  await heard();
  const run = begin(dir);
  try {
    const out = path.join(run.work, "captioned.mp4");
    let drawn = null;
    // How each sound track was written: copied, or made AAC.
    let sound = [];
    // The color tags ffmpeg reads captioned.mp4 by for the pictures, and
    // the ones it leaves out of them.
    let frameTags = {};
    const titled = path.basename(videoFile);
    // captions.ass draws a caption smaller where the burned one is.
    // The font captions.ass names, as libass and players that read ASS
    // make it: a font asked for by name is what this machine gives for it.
    const libassFont = look.from === "fonts.css" ? null : machineFont(look.family || "Arial", look.weight);
    // libass finds a font through fontconfig for each letter its own font
    // lacks: one no font on this machine has, as fontconfig lists them, is
    // a box, which needs no asking.
    const every = useLibass ? machineLetters() : null;
    const font = assFont(look, libassFont, { fallback: givenFor(look), lacks: every ? (code) => !every(code) : null });
    const letters = assLetters(cues, font);
    // The letters the video shows as boxes, [{ letter, cue }].
    let boxes = useLibass ? letters.missing : [];
    // captions.ass names the video's own matrix and range for players; the
    // file libass burns can name others, and give other colors (assColors).
    const assFile = (scales, { level = 1, matrix = color.header, tint = null } = {}) => ass(cues, words, { states, style: options.style, look: { ...look, tool: TOOL }, place, title: titled, level, scales, font, matrix, tint });
    const progress = (share) => log(encodingLine(share));
    const unit = options.style === "word" ? ["word", "words"] : ["caption", "captions"];
    if (useLibass) {
      log(`Drawing ${count(states.length, "caption state", "caption states")} with libass`);
      // libass measures nothing it is given: a line that by the estimate is
      // wider than the safe space is drawn smaller.
      const scales = estimatedScales(cues, words, { style: options.style, place, font });
      fs.writeFileSync(path.join(run.work, "captions.ass"), assFile(scales));
      const fontsDir = fontsOfLook(look, run.work);
      // libass draws from a copy whose colors are at the reference white for
      // graphics on HDR, as Chrome's are, and that names the matrix and range
      // the picture has as the ass filter gets it, or, for a filter that
      // converts every color as BT.601 does, gives it the colors that come
      // out as the video's own; captions.ass keeps its own.
      const level = ffmpeg.hdrLevel(video);
      const draw = ffmpeg.assColors(color, await ffmpeg.libassFollows(bins, run.work, caps));
      let burnAss = path.join(run.work, "captions.ass");
      if (level < 1 || draw.header !== color.header || draw.tint) {
        burnAss = path.join(run.work, "burn.ass");
        fs.writeFileSync(burnAss, assFile(scales, { level, matrix: draw.header, tint: draw.tint }));
      }
      const made = await ffmpeg.burn({ bins, caps, video, output: out, ass: burnAss, assMatrix: draw.matrix, assFull: draw.full, fontsDir, fill, onProgress: progress });
      // A lit color such a filter cannot give as the video's matrix codes it
      // comes out as the nearest it can draw.
      const reach = draw.tint && level >= 1 && options.style !== "line" ? ffmpeg.as601(look.highlight, color.matrix).shown : "";
      if (reach && rgbOf(reach).some((c, i) => Math.abs(c - rgbOf(look.highlight)[i]) > 3)) notes.push(`This ffmpeg's ass filter converts every color as BT.601 does, so libass cannot draw ${look.highlight} as the video's ${MATRICES[color.matrix]} holds it: the lit word shows as ${reach}, the nearest it can draw. Leave out --libass to have Chrome draw it.`);
      notes.push(...made.notes);
      sound = made.tracks;
      frameTags = made.frameTags;
      const small = shrunkOf(scales);
      if (small.count) notes.push(`${small.count} ${small.count === 1 ? `${unit[0]} has` : `${unit[1]} have`} a line longer than the safe space takes at ${place.fontPx} px, by an estimate of the letters' width, so libass drew ${small.count === 1 ? "it" : "them"} smaller, ${small.count === 1 ? "at" : "the smallest at"} ${percentOf(small.smallest)}% of the size.`);
      // A variable file draws thin letters only where it draws any.
      const face = letters.own > 0 ? variableFace(look) : null;
      notes.push(...missingNotes(letters.missing, letters.unsure));
      if (face) notes.push(`libass draws ${look.family} from ${face.name}, a file of the weights ${face.weight[0]} to ${face.weight[1]}, at that file's default weight, not at ${look.weight}, so the letters are thinner than Chrome draws them. Leave out --libass to draw the ${look.weight}.`);
      // libass finds a file of the fonts folder by the names in it.
      if (look.from === "fonts.css" && !font.family) notes.push(`${look.faces[0].name || path.basename(look.faces[0].file)} gives no family name easycaptionkit can read, so captions.ass names the font ${look.family}, as fonts.css does. libass finds a font file by the names in it, so it may have drawn the captions with another font.`);
    } else {
      log(`Drawing ${count(states.length, "caption state", "caption states")} in Chrome`);
      try {
        drawn = await renderStates({ cues, words, states, style: options.style, look, place, duration: video.duration, dir: run.work, log, boxed: (all, fonts) => chromeBoxes(all, fonts, { kit: kitLetters(look) }) });
      } catch (err) {
        // A Chrome that cannot start here (no usable sandbox, as in a
        // container) stops the run before the encode; libass needs none. A
        // Chrome the system stopped as memory ran out can draw with fewer
        // jobs at once, or a smaller video.
        if (err.chrome && err.signal === "SIGKILL") err.message += ". Run again with fewer jobs at once or with a smaller video, or pass --libass to have ffmpeg draw the captions without Chrome";
        else if (err.chrome && err.start) err.message += ". Pass --libass to have ffmpeg draw the captions without Chrome";
        throw err;
      }
      fs.writeFileSync(path.join(run.work, "captions.ass"), assFile(drawn.scales));
      log(`Encoding ${shown(titled)} with the captions (${caps.encoder.name})`);
      const made = await ffmpeg.burn({ bins, caps, video, output: out, overlay: { file: drawn.file, y: drawn.y }, fill, onProgress: progress });
      notes.push(...made.notes);
      sound = made.tracks;
      frameTags = made.frameTags;
      boxes = boxesIn(cues, drawn.boxes);
      notes.push(...boxesNotes(boxes));
      if (drawn.failedFonts.length) notes.push(`Chrome could not load the font ${[...new Set(drawn.failedFonts)].join(", ")}; the next font in the list drew the captions.`);
      if (drawn.shrunk) notes.push(`${drawn.shrunk} ${drawn.shrunk === 1 ? `${unit[0]} was` : `${unit[1]} were`} wider than the safe space and drawn smaller to fit, ${drawn.shrunk === 1 ? "at" : "the smallest at"} ${percentOf(drawn.smallest)}% of the size.`);
    }
    // launch-film's check finds the cuts in a timeline next to the film. It
    // is written as the other files are, so it takes the umask and the
    // folder's default ACL, where a copy would keep the mode of the file it
    // copies.
    const names = ["captioned.mp4", "captions.ass"];
    const found = copyTimeline ? bytesOf(timeline, MOST_TIMELINE) : {};
    if (found.bytes) {
      fs.writeFileSync(path.join(run.work, "captioned.timeline.json"), found.bytes);
      names.push("captioned.timeline.json");
    } else if (found.big) notes.push(tooBig(Number((statOf(timeline) || { size: 0 }).size)));
    else if (found.error && found.error.code !== "ENOENT") notes.push(`${shown(path.basename(timeline))}, next to the video, could not be read (${{ EACCES: "permission denied", EPERM: "permission denied" }[found.error.code] || shown(found.error.message)}), so it was not copied as captioned.timeline.json.`);
    fs.writeFileSync(path.join(run.work, "captions.srt"), srt(cues));
    fs.writeFileSync(path.join(run.work, "captions.vtt"), vtt(cues, { note: `${TOOL}, from ${path.basename(options.words)}` }));
    names.push("captions.srt", "captions.vtt");

    // What the result is, measured: its frames' own times give the frame
    // each change shows on, whatever the frame rate does.
    const [result, times] = await Promise.all([ffmpeg.probe(out, bins), ffmpeg.frameTimes(out, bins)]);
    const rate = ffmpeg.rateOf(times, result.fps);
    if (rate.variable) notes.push(`The video's frame rate varies (${round(rate.fps, 3)} fps on average); every frame keeps its own time.`);
    // A caption state starts at its time to the millisecond on Chrome's
    // states, to the hundredth of a second in ASS.
    const frameStep = useLibass ? 0.01 : 0.001;
    const unseen = onNoFrame(cues, times, frameStep);
    if (fill) notes.splice(fillAt, 0, fillNote(video, fill, unseen));
    if (unseen.length) notes.push(`${unseen.length === 1 ? `Caption ${unseen[0]} shows` : `Captions ${list(unseen.map(String))} show`} on no frame of captioned.mp4, which has no frame while ${unseen.length === 1 ? "it is" : "they are"} up. ${unseen.length === 1 ? "It is" : "They are"} in captions.srt, captions.vtt and captions.ass.`);
    log("Making sheet.png and safe-zones.png");
    const widest = cues.reduce((a, b) => (b.lines.length > a.lines.length || (b.lines.length === a.lines.length && b.chars > a.chars) ? b : a), cues[0]);
    const pictures = { sheet: 0 };
    const zonesFile = path.join(run.work, "safe-zones.png");
    const sheetFile = path.join(run.work, "sheet.png");
    // Chrome lays the pictures out. Where there is none, or it cannot start
    // or stops, ffmpeg makes plainer ones: the captions are in the video
    // by now, and the pictures only show them. A run that drew them with
    // libass asks Chrome its version here, which a run that drew them with
    // Chrome did before any work, with the temporary folder.
    let plain = useLibass ? (await chromeProblem()) || tempProblem() : "";
    if (!plain) {
      try {
        await safeZonesPng({ bins, video, output: out, zones: place.zones, cue: widest, times, file: zonesFile, dir: run.work, frameTags });
        pictures.sheet = await sheetPng({ bins, video, output: out, cues, times, file: sheetFile, dir: run.work, frameTags });
      } catch (err) {
        if (!err.chrome) throw err;
        plain = `Chrome could not draw them: ${err.message}`;
      }
    }
    if (plain) {
      pictures.sheet = await plainPictures({ bins, video, output: out, cues, times, zones: place.zones, cue: widest, sheetFile, zonesFile, dir: run.work, frameTags });
      notes.push(`ffmpeg made sheet.png and safe-zones.png, plainer than Chrome lays them out, since ${plain.replace(/\.$/, "")}. The frames have no caption numbers or times on them, and the margins no app buttons or names.`);
    }
    names.push("sheet.png", "safe-zones.png");

    const facts = {
      tool: TOOL,
      out: dir,
      video: { file: path.basename(videoFile), from: fromFolder(run.dir, videoFile), ...describe(video) },
      // Each sound track as it was written: copied, or made AAC from the codec it had.
      output: { file: "captioned.mp4", ...withSound(describe(result, rate, times.length), sound), encoder: caps.encoder.name },
      source: { file: path.basename(options.words), from: fromFolder(run.dir, options.words), format: read.format, about: read.about, ...(first !== read.format ? { firstFormat: first } : {}), count: words.length, byWord: read.byWord, ...(origin ? { origin } : {}) },
      style: options.style,
      drawnWith: useLibass ? "libass" : "chrome",
      look,
      places: place.zones,
      layout: { ...place, zones: undefined, maxChars, lines },
      band: drawn ? { y: drawn.y, height: drawn.height } : null,
      reach: drawn ? drawn.reach : null,
      states: drawn ? drawn.states : states.length,
      fontsDrawn: drawn ? drawn.fonts : [],
      fontFirst: drawn ? drawn.first : "",
      boxes,
      libassFont: useLibass ? libassFont : null,
      // The name captions.ass gives the font, from its file for fonts.css,
      // and the fonts it sets the letters in that the font lacks.
      assFamily: font.family || look.family || "Arial",
      assFonts: fontsFolder(look, dir),
      assFallbacks: letters.fallbacks,
      assLetters: { total: letters.total, own: letters.own },
      cues,
      wordList: words,
      reading: readingSpeed(cues),
      sheet: pictures.sheet,
      timelineCopied: names.includes("captioned.timeline.json"),
      moment: round(shotOf(widest, times).time, 2),
      frameTimes: times,
      frameStep,
      notes,
    };
    fs.writeFileSync(path.join(run.work, "CAPTIONS.md"), captionsMarkdown(facts));
    names.push("CAPTIONS.md");
    const files = writtenFiles(run.work, names);
    fs.writeFileSync(path.join(run.work, "words.json"), JSON.stringify(wordsJson(words, read, files, first, video.duration), null, 2) + "\n");
    const json = captionsJson({ ...facts, files: { ...files, ...writtenFiles(run.work, ["words.json"]) } });
    fs.writeFileSync(path.join(run.work, "captions.json"), JSON.stringify(json, null, 2) + "\n");
    names.push("words.json", "captions.json");
    await heard();
    finish(run, names, { view });
    return { dir, captions: json, facts };
  } catch (err) {
    return fail(run, err);
  }
}

// The note for a video given frames at a steady rate, as fillFor says,
// and `unseen`, the captions that still show on no frame of the result.
function fillNote(video, fill, unseen = []) {
  const why = [];
  if (fill.few) why.push(`the video has ${count(fill.few, "frame", "frames")} a second`);
  else if (fill.held) why.push(`the video holds some frames for up to ${fill.held.toFixed(2)} s, as a recording that writes a frame only when the picture changes does`);
  if (fill.start) why.push(`its picture starts at ${video.picture.start.toFixed(2)} s, after its sound`);
  if (fill.past) why.push(`its picture ends at ${video.picture.end.toFixed(2)} s while its sound runs on to ${video.duration.toFixed(2)} s`);
  const how = [...(fill.start ? ["its first frame shown from the start"] : []), "each frame repeated until the next comes", ...(fill.past ? ["the last until the sound ends"] : [])];
  return `The captions show on the video's own frames, and ${list(why)}, so ${count(fill.captions, "caption", "captions")} would have shown late or on no frame. captioned.mp4 is written at ${round(fill.fps, 3)} fps instead, ${list(how)}${unseen.length ? "." : ", so every caption shows at its time."}`;
}

// The numbers of the cues no frame of a video shows, from its frames'
// times: each frame shows the cue up at its time, a change drawn at its
// time to the `step`.
function onNoFrame(cues, times, step) {
  const first = (t) => {
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
  return times.length ? cues.filter((cue) => first(cue.end) <= first(cue.start)).map((cue) => cue.n) : [];
}

// What captioned.mp4 leaves out of the video given, as a note, or "".
function leftOut(v) {
  const { tags = [], covers = 0, videos = 0, subtitles = 0, data = 0, attachments = 0 } = v.left || {};
  const parts = [];
  // Each tag once, though MP4 keeps one for each language too (location
  // and location-eng); the ones people know first, then the rest by name.
  const names = [...new Set(tags.map((t) => t.replace(/-[a-z]{3}$/i, "")))];
  if (names.length) {
    const known = /^(?:title|location.*|com\.apple\.quicktime\.location.*|creation_time|com\.apple\.quicktime\.creationdate|date|artist|comment|description)$/i;
    const named = [...names.filter((t) => known.test(t)), ...names.filter((t) => !known.test(t))].map(shown);
    const shownTags = named.length > 4 ? [...named.slice(0, 3), `${named.length - 3} more`] : named;
    parts.push(`the file's own ${names.length === 1 ? "tag" : "tags"} (${list(shownTags)})`);
  }
  if (covers) parts.push(covers === 1 ? "its cover picture" : `its ${covers} cover pictures`);
  if (videos) parts.push(videos === 1 ? "its other video track" : `its ${videos} other video tracks`);
  if (subtitles) parts.push(subtitles === 1 ? "its subtitle track" : `its ${subtitles} subtitle tracks`);
  if (data) parts.push(data === 1 ? "its data track" : `its ${data} data tracks`);
  if (attachments) parts.push(attachments === 1 ? "the file attached to it" : `the ${attachments} files attached to it`);
  if (!parts.length) return "";
  const kept = ["the picture", ...(v.audio.length ? [v.audio.length === 1 ? "the sound with its language" : "each sound track with its language"] : []), ...(v.chapters ? ["the chapters"] : [])];
  return `captioned.mp4 keeps ${list(kept)}, and leaves out ${list(parts)}.`;
}

// A description of the result, each of its sound tracks with how it was
// written: { codec, channels, rate, copied }, and the codec it had, as
// from, where it was made AAC.
function withSound(d, sound) {
  return { ...d, audio: d.audio.map((a, i) => (sound[i] && !sound[i].copied ? { ...a, copied: false, from: sound[i].from } : { ...a, copied: true })) };
}

function describe(v, rate = null, frames = 0) {
  return {
    width: v.out ? v.out.width : v.width,
    height: v.out ? v.out.height : v.height,
    shape: shapeOf(v.width, v.height),
    fps: round(rate ? rate.fps : v.fps, 3),
    duration: round(v.duration, 3),
    frames: frames || v.frames,
    rotation: v.rotation,
    codec: v.codec,
    audio: v.audio.map((a) => ({ codec: a.codec, channels: a.channels, rate: a.rate })),
  };
}

// words.json: the words as read, in a shape easycaptionkit reads back, so
// a misheard word can be fixed there and the run made again from it. It
// carries the SHA-256 of its words, so the next run into the folder can
// tell they were fixed by hand since, and says so when they came from
// words fixed by hand. `from` is the format they first came in (`first`,
// firstFormat's), which a run that reads the file again keeps. A word
// without a time of its own says how it got one: spread over its line by
// length, or placed between its neighbors, as the file gave it none.
// Words of a demo's steps keep `end`, where this run ended the captions:
// the video's length, or the one steps.json gives without a video. That
// is `demo`, where a later subtitles run with no video ends them too.
function wordsJson(words, read, files, first, end) {
  const items = words.map((w) => ({ text: w.text, start: round(w.start), end: round(w.end), ...(w.seg >= 0 ? { seg: w.seg } : {}), ...(w.timed ? {} : w.placed ? { placed: true } : { spread: true }) }));
  const demo = read.video && Number.isFinite(end) ? end : 0;
  return {
    tool: TOOL,
    from: FORMATS[first] || read.about,
    hard: read.hard,
    ...(demo > 0 ? { demo: { duration: round(demo) } } : {}),
    // The other files the run wrote, so a folder whose captions.json went
    // is still known as the run's.
    files,
    ...(read.fixed ? { fixed: true } : {}),
    wordsSha256: wordsSha256(items),
    words: items,
  };
}

// The frame captions.ass is laid out for when no video is given: a phone
// when any place named is one of the vertical apps, a square for square
// posts alone, else 16:9.
function frameFor(places = []) {
  if (places.some((p) => ["tiktok", "reels", "shorts"].includes(p))) return { width: 1080, height: 1920 };
  if (places.length && places.every((p) => p === "square")) return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

// make_subtitles: the subtitle files from the words alone, no video
// changed. options: { video, places, style, lines, maxChars, size,
// position, brand, fonts, font, highlight, box, out, log }
async function makeSubtitles(wordsFile, options) {
  const log = options.log || (() => {});
  notAddresses({ words: wordsFile, video: options.video, brand: options.brand, fonts: options.fonts });
  mustExist(wordsFile, "file");
  if (options.video) mustExist(options.video, "file");
  if (options.brand) mustExist(options.brand, "file or folder");
  if (options.fonts) mustExist(options.fonts, "file or folder");
  const source = options.video ? { kind: "video", file: options.video } : { kind: "words", file: wordsFile };
  const folder = outFolder(options, `easycaptionkit-subtitles-${slug(options.video || wordsFile)}`, source, wordsFile);
  const dir = folder.dir;
  const origin = originOf(dir, wordsFile);
  writable(dir);
  const notes = recover(path.resolve(dir), dir);
  const view = guard(dir, { words: wordsFile, video: options.video, brand: options.brand, fonts: options.fonts }, { subtitles: true, options });
  // The video is read with ffprobe alone, which is asked its version first;
  // no ffmpeg is started, so nothing at ffmpeg's path stops the run.
  const bins = options.video ? await ffmpeg.readyProbe() : null;
  const read = await loadWords(wordsFile);
  const first = firstFormat(read, origin);
  const look = chooseLook({ ...options, ...scriptsOf(read.words) });
  if (folder.note) notes.push(folder.note);
  notes.push(...read.notes, ...look.notes);
  let video = null;
  if (options.video) {
    video = await ffmpeg.readVideo(options.video, bins);
    notStill(video, options.video);
    notes.push(...video.notes);
  }
  const { width, height } = video ? video.out : frameFor(options.places);
  const places = options.places && options.places.length ? options.places : defaultPlaces(width, height);
  const maxChars = options.maxChars || 42;
  const { place, lines } = cueLayout({ ...options, maxChars }, width, height, places);
  notes.push(...place.notes);
  // No caption runs past the video's end: the video's, or with no video
  // the one steps.json gives the demo's video, as words.json keeps it.
  const end = video ? video.duration : read.video ? read.video.duration : Infinity;
  const fitted = fitWords(read, end, video ? "" : shown(path.basename(wordsFile)));
  notes.push(...fitted.notes);
  const words = fitted.words;
  log(`Read ${count(words.length, "word", "words")} from ${shown(path.basename(wordsFile))} (${read.about})`);
  const shape = { lines: options.style === "word" ? 1 : lines, hard: read.hard, duration: end };
  const cues = buildCues(words, { ...shape, maxChars });
  // Words said after the picture ends, while the sound runs on, are heard.
  if (video && video.soundPast && cues.some((cue) => cue.end > video.picture.end + 0.05)) notes.push(`The video's picture ends at ${video.picture.end.toFixed(2)} s, and its sound runs on to ${video.duration.toFixed(2)} s. The captions go on to the end of the sound, over the last frame, which players hold.`);
  log(`Cut ${words.length === 1 ? "it" : "them"} into ${count(cues.length, "caption", "captions")}`);
  // captions.ass sets its lines on the frame, at its letter size: when
  // fewer characters fit across than the subtitle files take, it has
  // captions of its own, cut to what fits.
  const fit = charsThatFit(place.glyphWidth, place.fontPx);
  const assChars = Math.min(maxChars, fit);
  const narrow = assChars < maxChars ? buildCues(words, { ...shape, maxChars: assChars }) : cues;
  const assCues = narrow.length === cues.length && narrow.every((cue, i) => cue.lines.join("\n") === cues[i].lines.join("\n")) ? cues : narrow;
  const assStates = makeStates(assCues, words, options.style);
  // A font asked for by name is what this machine gives for it.
  const libassFont = look.from === "fonts.css" ? null : machineFont(look.family || "Arial", look.weight);
  const font = assFont(look, libassFont, { fallback: givenFor(look) });
  const assScales = estimatedScales(assCues, words, { style: options.style, place, font });
  const letters = assLetters(assCues, font);
  if (assCues !== cues) notes.push(`At ${place.fontPx} px, ${assChars} characters fit across the ${Math.round(place.textWidth)} px of safe space on the ${width}x${height} frame, so captions.ass cuts the words into ${count(assCues.length, "caption", "captions")} of up to ${assChars} characters a line; captions.srt and captions.vtt take ${maxChars}.`);
  const small = shrunkOf(assScales);
  if (small.count) notes.push(`${small.count} ${options.style === "word" ? (small.count === 1 ? "word" : "words") : small.count === 1 ? "caption" : "captions"} of captions.ass ${small.count === 1 ? "has" : "have"} a line longer than the safe space takes at ${place.fontPx} px, by an estimate of the letters' width, so captions.ass draws ${small.count === 1 ? "it" : "them"} smaller, ${small.count === 1 ? "at" : "the smallest at"} ${percentOf(small.smallest)}% of the size.`);
  notes.push(...specialNote(cues));
  await heard();
  const run = begin(dir);
  try {
    fs.writeFileSync(path.join(run.work, "captions.srt"), srt(cues));
    fs.writeFileSync(path.join(run.work, "captions.vtt"), vtt(cues, { note: `${TOOL}, from ${path.basename(wordsFile)}` }));
    // With a video, captions.ass names its matrix and range, which players convert the colors with.
    fs.writeFileSync(path.join(run.work, "captions.ass"), ass(assCues, words, { states: assStates, style: options.style, look: { ...look, tool: TOOL }, place, title: path.basename(options.video || wordsFile), scales: assScales, font, matrix: video ? ffmpeg.colorOf(video).header : "" }));
    const facts = {
      tool: TOOL,
      out: dir,
      subtitlesOnly: true,
      video: video ? { file: path.basename(options.video), from: fromFolder(run.dir, options.video), ...describe(video) } : null,
      frame: { width, height },
      source: { file: path.basename(wordsFile), from: fromFolder(run.dir, wordsFile), format: read.format, about: read.about, ...(first !== read.format ? { firstFormat: first } : {}), count: words.length, byWord: read.byWord, ...(origin ? { origin } : {}) },
      style: options.style,
      look,
      places: place.zones,
      layout: { ...place, zones: undefined, maxChars, lines, assMaxChars: assChars, assCues: assCues.length },
      libassFont,
      assFamily: font.family || look.family || "Arial",
      assFonts: fontsFolder(look, dir),
      assFallbacks: letters.fallbacks,
      assLetters: { total: letters.total, own: letters.own },
      // What the fix-a-word command gives again.
      rerun: { program: options.program, video: options.video, places: options.places, style: options.style, lines: options.lines, maxChars: options.maxChars, size: options.size, position: options.position, box: options.box, brand: options.brand, fonts: options.fonts, font: options.font, highlight: options.highlight },
      cues,
      wordList: words,
      reading: readingSpeed(cues),
      notes,
    };
    fs.writeFileSync(path.join(run.work, "CAPTIONS.md"), subtitlesMarkdown(facts));
    const files = writtenFiles(run.work, ["captions.srt", "captions.vtt", "captions.ass", "CAPTIONS.md"]);
    fs.writeFileSync(path.join(run.work, "words.json"), JSON.stringify(wordsJson(words, read, files, first, end), null, 2) + "\n");
    const json = captionsJson({ ...facts, files: { ...files, ...writtenFiles(run.work, ["words.json"]) } });
    fs.writeFileSync(path.join(run.work, "captions.json"), JSON.stringify(json, null, 2) + "\n");
    await heard();
    finish(run, ["captions.srt", "captions.vtt", "captions.ass", "words.json", "captions.json", "CAPTIONS.md"], { stale: false, view });
    return { dir, captions: json, facts };
  } catch (err) {
    return fail(run, err);
  }
}

module.exports = { captionVideo, makeSubtitles, slug, notAddresses, writable, guard, recover, begin, finish, abandon, frameFor, encodingLine, percentOf, missingNotes, boxesNotes, signalsOf, stopOnSignals, stopped, began, OUTPUTS, TOOL, shown, named };
