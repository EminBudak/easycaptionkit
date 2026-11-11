"use strict";

// The programs a run starts, ffmpeg, ffprobe and Chrome: where each one
// is, and whether it starts and answers as itself, asked before any work.
// Of one that does not, a run says only what is certain: what is at its
// path, as a folder or a file this user may not run, else what the system
// said when it could not start it, the first line the program printed and
// how it ended, or that it gave no answer in time. That line is the
// program's own, and says in its words what is at fault: nothing here
// guesses which file of a chain it is.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getSystemErrorMap } = require("node:util");
const { track } = require("./running");

const WINDOWS = process.platform === "win32";

const exe = (name) => (WINDOWS ? `${name}.exe` : name);

// A name with no folder in it, which is looked up on PATH.
const bare = (value) => !(value.includes("/") || (WINDOWS && value.includes("\\")));

// The errors a start can fail with that libuv has no name for, and Node
// calls "Unknown system error -86": each one's name and the system's
// words, by system and number. Linux's numbers are those of every
// processor Node.js runs on but MIPS.
const UNNAMED = {
  linux: { 80: ["ELIBBAD", "accessing a corrupted shared library"], 116: ["ESTALE", "stale file handle"] },
  darwin: { 70: ["ESTALE", "stale NFS file handle"], 85: ["EBADEXEC", "bad executable (or shared library)"], 86: ["EBADARCH", "bad CPU type in executable"], 87: ["ESHLIBVERS", "shared library version mismatch"], 88: ["EBADMACHO", "malformed Mach-o file"] },
};

// An error's name and the system's words for it, as ["EACCES",
// "permission denied"], or [] when neither is known.
const known = (err) => getSystemErrorMap().get(err.errno) || (!/^mips/.test(process.arch) && (UNNAMED[process.platform] || {})[-err.errno]) || [];

// The system's name for an error, as EACCES, else Node's.
const codeOf = (err) => known(err)[0] || err.code;

// The system's words for an error, as "permission denied", else its code.
const worded = (err) => known(err)[1] || err.code || String(err.message || err);

// How long a program may take to answer, in milliseconds: on a machine
// short of memory, with its swap full, ffmpeg 4.4 took more than 30
// seconds to say its version.
const LIMIT = 120_000;

// ─── where a program is ───────────────────────────────────────────────────

// A file this user may run, as a shell takes one: a file, not a folder,
// with the permission to run it. On Windows that permission is not looked
// at, and any file passes.
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Whether a folder is there and this user may enter it, as a program run
// in it needs.
function enterable(folder) {
  try {
    fs.accessSync(folder, fs.constants.X_OK);
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

// The folders of PATH in order, each as a whole path: one given from the
// current folder is taken from the folder the run started in, so a
// program found there is found when it runs in another folder. An empty
// entry is passed over.
const folders = () =>
  String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.resolve(dir));

// The first program by a name on PATH that this user may run, in a folder
// `skip` does not pass over, or "".
function onPath(name, { skip = () => false } = {}) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir || skip(dir)) continue;
    const file = path.resolve(dir, name);
    if (runnable(file)) return file;
  }
  return "";
}

// The file a path goes through as if it were a folder, as notes.txt in
// notes.txt/ffmpeg, or "".
function fileOnTheWay(file) {
  const parts = file.split(path.sep);
  for (let i = 2; i < parts.length; i++) {
    const part = parts.slice(0, i).join(path.sep);
    try {
      if (!fs.statSync(part).isDirectory()) return part;
    } catch {
      return "";
    }
  }
  return "";
}

// What keeps the system from running the file at a path, as far as can be
// told for certain before it runs: null when nothing does, else the words
// for it, and in `on` what the system does with such a file as it looks
// for a program on PATH. It "passes" over a folder, a named pipe, a
// socket and a device, none of which it runs, a link to nothing and a
// file this user may not run, to look in the next folder, and these are
// named when no program comes after them; it passes over nothing there
// and a folder this user may not enter "quietly", as these may hold no
// such program at all; and it "stops" at a path it cannot follow, as a
// loop of links.
function barred(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      let link = false;
      try {
        link = fs.lstatSync(file).isSymbolicLink();
      } catch {
        // Nothing there at all.
      }
      if (link) return { on: "passes", words: "is a link to a file that is not there" };
      const through = err.code === "ENOTDIR" ? fileOnTheWay(file) : "";
      return { on: "quietly", words: through ? `where there is none, as ${through} is a file, not a folder` : "where there is none" };
    }
    if (err.code === "EACCES" || err.code === "EPERM") return { on: "quietly", words: "may not be run: permission denied" };
    if (err.code === "ELOOP") return { on: "stops", words: "goes through a loop of links" };
    return { on: "stops", words: `cannot be looked at: ${worded(err)}` };
  }
  if (stat.isDirectory()) return { on: "passes", words: "is a folder" };
  if (WINDOWS) return null;
  if (!stat.isFile()) return { on: "passes", words: stat.isFIFO() ? "is a named pipe" : stat.isSocket() ? "is a socket" : "is a device" };
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    return { on: "passes", words: (stat.mode & 0o111) === 0 ? "is not executable" : "may not be run: permission denied" };
  }
  return null;
}

// ─── what a program said ──────────────────────────────────────────────────

// What `file` did when run with `args`, given `limit` milliseconds: { code,
// signal, stdout, stderr }, { late: true } when it gave no answer in that
// time and was stopped (see late()), or { err } when the system did not
// start it. What it printed is kept up to `cap` bytes.
function ask(file, args, { limit = LIMIT, cap = 1 << 20 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = track(spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] }));
    } catch (err) {
      resolve({ err });
      return;
    }
    let timer = null;
    let done = false;
    const end = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A start that fails gives its error before the close.
    child.on("error", (err) => end({ err }));
    // With no file descriptor left Node makes no pipes, and says why a
    // moment later.
    if (!child.stdout || !child.stderr) return;
    const said = { stdout: [], stderr: [] };
    let size = 0;
    for (const name of ["stdout", "stderr"]) {
      child[name].on("data", (chunk) => {
        if (size >= cap) return;
        said[name].push(chunk);
        size += chunk.length;
      });
    }
    // A program that hands its output on to one that goes on running may
    // never close it, so the answer is not waited for past the limit.
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Gone already.
      }
      child.stdout.destroy();
      child.stderr.destroy();
      end({ late: true });
    }, limit);
    child.on("close", (code, signal) => end({ code, signal, stdout: Buffer.concat(said.stdout).toString("utf8"), stderr: Buffer.concat(said.stderr).toString("utf8") }));
  });
}

// A line a program printed, in quotes, as it printed it, with its control
// characters written out, as \r or \x1b. A line longer than 200 characters
// keeps its first 120 and its last 80, as its end most often says why.
function quoted(line) {
  const chars = Array.from(String(line)).map((c) => {
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    if (!/[\p{Cc}\p{Cf}]/u.test(c)) return c;
    const n = c.codePointAt(0);
    return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u${n.toString(16).padStart(4, "0")}`;
  });
  const shown = chars.length > 200 ? [...chars.slice(0, 120), "...", ...chars.slice(-80)] : chars;
  return `"${shown.join("")}"`;
}

// The first line with anything in it of what a program printed, or null.
const firstLine = (text) =>
  String(text || "")
    .split(/\r?\n/)
    .find((line) => line.trim()) || null;

// What a program that ran did, where it did not answer: the first line it
// printed on its error output, where a program says what is wrong, else on
// its output, and how it ended. ffmpeg, ffprobe and Chrome give their
// versions on their output, so a program that ended well and printed on
// its error output alone is said to.
function happened(r) {
  const line = firstLine(r.stderr);
  if (line && r.code === 0 && !firstLine(r.stdout)) return `it printed ${quoted(line)} on its error output, nothing on its output, and exited with 0`;
  const ended = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.code}`;
  const said = line || firstLine(r.stdout);
  if (said) return `it printed ${quoted(said)} and ${ended}`;
  return r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.code}`;
}

// The first line of a file that starts with #!, which names the program
// the system starts the file with, or null. It is opened without waiting,
// as a named pipe put in the file's place since it was looked at would
// wait for a writer for good, and read only when it is a file.
function bangLine(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const bytes = Buffer.alloc(256);
    const got = bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0));
    if (got.indexOf("#!") !== 0) return null;
    const end = got.indexOf(10);
    return got.subarray(0, end < 0 ? got.length : end).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// What the system said when it did not start a file the checks found
// nothing wrong with. It says ENOENT of a file that is there when an
// interpreter or a loader the file needs is not, so a script's first
// line, which names its interpreter, is shown with it.
function unstartable(file, err) {
  if (["ENOEXEC", "EFTYPE", "EBADARCH", "EBADMACHO"].includes(codeOf(err))) return "it is not a program this system can run";
  const line = bangLine(file);
  const first = line === null ? "" : `; its first line is ${quoted(line)}`;
  if (codeOf(err) === "ENOENT") return `the system could not start it, as an interpreter or a loader it needs is not there${first}`;
  return `the system could not start it: ${worded(err)}${first}`;
}

// The errors that say the system is short of something to start a program
// with, not that the program is wrong: what it is short of, and what to do.
const SHORT = {
  EMFILE: "too many open files. Raise the limit on open files (ulimit -n) and run it again",
  ENFILE: "the system has too many files open. Run it again once fewer are",
  EAGAIN: "the system starts no more processes for now. Run it again once fewer are running",
  ENOMEM: "not enough memory. Free some and run it again",
  E2BIG: "its environment is too large. Run it with fewer or shorter environment variables",
};

// The errors a start fails with that the system passes over, as glibc's
// execvp does, to try the next folder of PATH: a file that is not there or
// may not be run, or one whose interpreter or loader is not there.
const PASSED = new Set(["ENOENT", "EACCES", "ENOTDIR", "ESTALE", "ENODEV", "ETIMEDOUT"]);

// The error for a program the system could not start for want of something
// it is short of, as open files: no fault of the program's.
const short = (name, err) => Object.assign(new Error(`easycaptionkit could not start ${name}: ${SHORT[err.code]}.`), { unusable: true, why: `the system could not start ${name}: ${SHORT[err.code].replace(/\. .*$/, "")}` });

// The error for a program that gave no answer in `limit` ms when asked
// `what`, as "its version": ffmpeg on a machine short of memory can be
// that slow as well as a program that is not ffmpeg, so only that is said,
// and to run again, with no advice to install another.
function late(spec, place, what, limit) {
  const words = `gave no answer in ${limit / 1000} s when asked ${what}`;
  return Object.assign(new Error(`easycaptionkit could not check ${spec.name}, ${place.file}: it ${words}, as on a machine short of memory. ${spec.advice.late}`), { unusable: true, why: placed(place, words) });
}

// The error for a program a run checked before any work that the system
// did not start during the work, `name` being what messages call it: what
// the system is short of, else the system's words, never its code alone,
// and what to check, as a program that answered when the run began can
// have been taken away or changed since.
function startFailure(file, err, name = path.basename(file)) {
  if (Object.hasOwn(SHORT, err.code)) return short(name, err);
  return new Error(`easycaptionkit could not start ${name}, ${file}, again: ${worded(err)}. Check that it is still there and may be run, and run easycaptionkit again.`);
}

// ─── finding a program and asking it ──────────────────────────────────────

// A program a run looks for, as ffmpeg.js and chrome.js give it: { name,
// variable, args, answers, names, first, known, ask, none, advice }.
// `name` is what messages call it, `variable` the one that names it,
// `args` what asks its version and `answers(stdout)` whether what it
// printed then answers as it does, after it exited with 0. `names` are its
// names on PATH. Where the variable is not set, `first()` gives places
// looked at before PATH, each { file, name, where, next }, of which the
// first that is there is taken, and `known` folders looked in where PATH
// has nothing by its names, as package managers put it there for an agent
// or an app whose PATH is short. With `ask` false, a program is taken once
// nothing is in the way of running it, as Chrome on Windows, which prints
// no version. `none` is the message when there is none, and `advice` the
// sentence that ends one about a program the run cannot use: `variable`
// for one the variable names, `next` for ffprobe next to ffmpeg, `found`
// for the others, and `late` for one that gave no answer in time.

// Where a run found a program, in words that name its place and say what
// happened there.
function placed(place, words) {
  if (place.variable && !bare(place.value)) return `${place.variable} points to ${place.file}, ${words.startsWith("where ") ? words : `which ${words}`}`;
  if (place.variable) return `${place.variable} names ${place.value}, found on PATH at ${place.file}, which ${words}`;
  return `the ${place.name} ${place.where}, ${place.file}, ${words}`;
}

// The error for a program a run cannot use: the message, and in `why` the
// words that name its place and what happened, as a note gives them.
function unusable(spec, place, words) {
  const why = placed(place, words);
  const advice = place.variable ? spec.advice.variable : place.next ? spec.advice.next : spec.advice.found;
  return Object.assign(new Error(`easycaptionkit needs ${spec.name}, and ${why}. ${advice}`), { unusable: true, why });
}

// Whether what a program did when asked its version answers as `spec`.
const answered = (spec, r) => !r.err && !r.late && r.code === 0 && !r.signal && spec.answers(r.stdout);

// The places in turn: what keeps each from running, then, unless `spec`
// says not to, what it did when asked its version. The first that answers
// is { found: place, stdout }. A place `alone`, the one a variable or a
// place before PATH gives, is the only one, and what is wrong with it is
// said. Of places on PATH, the system's search passes over some (see
// barred() and PASSED), and the first of those is given as `passed`; at
// any other the search stops, with what is wrong there.
async function walk(spec, places, limit, { alone = false } = {}) {
  let passed = null;
  for (const place of places) {
    let seen = barred(place.file);
    if (!seen) {
      if (spec.ask === false) return { found: place, stdout: "" };
      const r = await ask(place.file, spec.args, { limit, cap: 1 << 16 });
      if (r.err && Object.hasOwn(SHORT, r.err.code)) throw short(spec.name, r.err);
      if (r.late) throw late(spec, place, "its version", limit);
      if (answered(spec, r)) return { found: place, stdout: r.stdout };
      // A file taken away or changed since it was looked at is said to be
      // what it is now.
      if (r.err) seen = barred(place.file) || { on: PASSED.has(codeOf(r.err)) ? "passes" : "stops", words: `did not run as ${spec.name}: ${unstartable(place.file, r.err)}` };
      else seen = { on: "stops", words: `did not run as ${spec.name}: ${happened(r)}` };
    }
    if (alone || seen.on === "stops") throw unusable(spec, place, seen.words);
    if (seen.on === "passes" && !passed) passed = { place, words: seen.words };
  }
  return { passed };
}

// The places a program is looked for on PATH, by each of its names, and
// in the folders `known` where PATH has nothing by them.
function onPathPlaces(spec, value) {
  const names = value ? [value, ...(WINDOWS ? [exe(value)] : [])] : spec.names;
  const named = value ? { variable: spec.variable, value } : {};
  return names.flatMap((name) => folders().map((dir) => ({ file: path.join(dir, name), name, where: "on PATH", ...named })));
}

const knownPlaces = (spec) => (WINDOWS ? [] : (spec.known || []).flatMap((dir) => spec.names.map((name) => ({ file: path.join(dir, name), name, where: `in ${dir}` }))));

// The program a run uses, found and asked its version before any work, as
// { file, stdout, place }: the path its variable gives, as it is, or the
// first program by its name on PATH the system would start; with the
// variable unset, the first of the places before PATH that is there, else
// the first on PATH, else one in the known folders. It is taken only when
// it exits with 0 and its answer is one `spec` takes; otherwise the run
// stops before any work, with what is wrong with it, what the system said
// or what it printed (see unusable()), and when there is none, with
// `spec.none`. Every run checks the programs it uses with this first.
async function find(spec, limit = LIMIT) {
  const value = process.env[spec.variable] || "";
  const through = async (places, options) => {
    const { found, stdout, passed } = await walk(spec, places, limit, options);
    return found ? { file: found.file, stdout, place: found } : { passed };
  };
  if (value && !bare(value)) return through([{ file: path.resolve(value), variable: spec.variable, value }], { alone: true });
  if (!value) {
    const first = (spec.first ? spec.first() : []).find((place) => fs.existsSync(place.file));
    if (first) return through([first], { alone: true });
  }
  let result = await through(onPathPlaces(spec, value));
  if (!result.file && !result.passed && !value) result = await through(knownPlaces(spec));
  if (result.file) return result;
  if (result.passed) throw unusable(spec, result.passed.place, result.passed.words);
  if (value) throw Object.assign(new Error(`easycaptionkit needs ${spec.name}, and ${spec.variable} names ${value}, which is not on PATH. ${spec.advice.variable}`), { unusable: true, why: `${spec.variable} names ${value}, which is not on PATH` });
  throw Object.assign(new Error(spec.none), { unusable: true, why: `no ${spec.name} was found` });
}

// The file a run would take for a program by what is at each place alone,
// not run, or "": the path its variable gives, as it is, else as find()
// looks, where nothing keeps a file from running. ffprobe is looked for
// next to it, where a run uses ffprobe alone.
function locate(spec) {
  const value = process.env[spec.variable] || "";
  if (value && !bare(value)) return path.resolve(value);
  if (!value) {
    const first = (spec.first ? spec.first() : []).find((place) => fs.existsSync(place.file));
    if (first) return first.file;
  }
  // The first place nothing keeps from running, as { file }, else whether
  // the search stopped at one or passed over one.
  const look = (places) => {
    let passed = false;
    for (const place of places) {
      const seen = barred(place.file);
      if (!seen) return { file: place.file };
      if (seen.on === "stops") return { stopped: true };
      if (seen.on === "passes") passed = true;
    }
    return { passed };
  };
  const onPath = look(onPathPlaces(spec, value));
  if (onPath.file) return onPath.file;
  if (onPath.stopped || onPath.passed || value) return "";
  return look(knownPlaces(spec)).file || "";
}

// What the program found at `place` printed when run with `args` after it
// answered its version, as asked about `what` ("its encoders"): its
// output, read only once it ended well. One that fails or is stopped
// stops the run with how it ended, so a program that cannot answer is not
// taken for one without the encoder or the filter asked for, and one that
// gives no answer in time stops it as late() says.
async function probe(spec, place, args, what, limit = LIMIT) {
  const r = await ask(place.file, args, { limit });
  const asked = args.filter((arg) => arg !== "-hide_banner").join(" ");
  if (r.err && Object.hasOwn(SHORT, r.err.code)) throw short(spec.name, r.err);
  if (r.late) throw late(spec, place, `${what} (${asked})`, limit);
  if (!r.err && r.code === 0 && !r.signal) return r.stdout;
  throw unusable(spec, place, `failed when asked ${what} (${asked}): ${r.err ? unstartable(place.file, r.err) : happened(r)}`);
}

module.exports = { exe, enterable, onPath, quoted, happened, unstartable, find, locate, probe, startFailure, LIMIT };
