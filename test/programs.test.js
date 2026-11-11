"use strict";

// The programs a run starts, ffmpeg, ffprobe and Chrome, as a run finds them
// and asks them their versions before any work: what it says of one that
// cannot be started or does not answer as itself, which is only what is
// certain, and that one that answers, as a wrapper does, goes ahead.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { run, write, video, dir, hasFfmpeg, evenWords, CLI } = require("./helpers");
const programs = require("../skills/easycaptionkit/scripts/lib/programs");

const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";
const LIBASS = "--libass has ffmpeg draw the captions without Chrome.";
// How each message ends: for a program a variable names, and for one found.
const ADVICE = {
  FFMPEG_PATH: `Set FFMPEG_PATH to an ffmpeg that runs, or unset it and install one (${INSTALL}).`,
  FFPROBE_PATH: `Set FFPROBE_PATH to an ffprobe that runs, or unset it and install ffmpeg, which comes with ffprobe (${INSTALL}).`,
  CHROME_PATH: `Set CHROME_PATH to a Chrome that runs, or unset it and install Google Chrome or Chromium. ${LIBASS}`,
  ffmpeg: `Install ffmpeg (${INSTALL}) or set FFMPEG_PATH to an ffmpeg that runs.`,
  ffprobe: `Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to an ffprobe that runs.`,
  chrome: `Install Google Chrome or Chromium, or set CHROME_PATH to a Chrome that runs. ${LIBASS}`,
};
const NAME = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", chrome: "Chrome" };
const VARIABLE = { ffmpeg: "FFMPEG_PATH", ffprobe: "FFPROBE_PATH", chrome: "CHROME_PATH" };
const ROLES = ["ffmpeg", "ffprobe", "chrome"];
const posix = process.platform !== "win32";
const linux = process.platform === "linux";
const { FFMPEG_PATH, FFPROBE_PATH, CHROME_PATH, ...base } = process.env;
// The real programs, as a shell finds them.
const real = (name) => (posix ? spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim() : "");
const has = (name) => Boolean(real(name));

test("a line a program printed is quoted as it is, its control characters written out and a long one cut in its middle", () => {
  assert.equal(programs.quoted("ffmpeg: not found"), '"ffmpeg: not found"');
  assert.equal(programs.quoted("a\tb\rc\x1b[31m\u200bé日本"), '"a\\tb\\rc\\x1b[31m\\u200bé日本"');
  const long = `${"a".repeat(150)}${"b".repeat(100)}`;
  assert.equal(programs.quoted(long), `"${"a".repeat(120)}...${"b".repeat(80)}"`);
  assert.equal(programs.quoted("x".repeat(200)), `"${"x".repeat(200)}"`);
});

test("what a program did when it did not answer: its first line and how it ended, on its error output first, or that it printed nothing, was stopped or gave no answer", () => {
  const said = (r) => programs.happened({ code: 0, signal: null, stdout: "", stderr: "", ...r }, 120_000);
  assert.equal(said({}), "it printed nothing and exited with 0");
  assert.equal(said({ code: 3, stderr: "\n  \nsomething went wrong\nmore\n", stdout: "an answer\n" }), 'it printed "something went wrong" and exited with 3');
  assert.equal(said({ code: 2, stdout: "\nusage: tool\n" }), 'it printed "usage: tool" and exited with 2');
  assert.equal(said({ stderr: "ffmpeg version 9.9\n" }), 'it printed "ffmpeg version 9.9" on its error output, nothing on its output, and exited with 0');
  assert.equal(said({ code: null, signal: "SIGKILL" }), "it was stopped by SIGKILL");
  assert.equal(said({ code: null, signal: "SIGTERM", stderr: "dyld[4321]: Library not loaded\n" }), 'it printed "dyld[4321]: Library not loaded" and was stopped by SIGTERM');
  assert.equal(programs.happened({ late: true }, 500), "it gave no answer in 0.5 s");
});

test("what the system said of a file it did not start is told without waiting on a named pipe in the file's place", { skip: !posix && "needs mkfifo" }, () => {
  const fifo = path.join(dir, "fifo-in-place", "ffmpeg");
  fs.mkdirSync(path.dirname(fifo), { recursive: true });
  assert.equal(spawnSync("mkfifo", ["-m", "755", fifo]).status, 0);
  // A read that waits for a writer ends by no signal the process takes, so the check runs in a process of its own,
  // killed once the time is up.
  const err = `Object.assign(new Error("spawn EACCES"), { code: "EACCES", errno: ${-require("node:os").constants.errno.EACCES} })`;
  const script = `process.stdout.write(require(${JSON.stringify(require.resolve("../skills/easycaptionkit/scripts/lib/programs"))}).unstartable(${JSON.stringify(fifo)}, ${err}))`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  assert.equal(r.signal, null, "the read waited for a writer");
  assert.equal(r.stdout, "the system could not start it: permission denied");
});

test("a start error Node.js has no name for is told in the system's words, and a program for another processor on macOS is said to be one this system cannot run", () => {
  const { getSystemErrorName } = require("node:util");
  // The error Node.js gives for a start that failed with the system's error number `n`.
  const failed = (n, file = "/opt/ff/ffmpeg") => Object.assign(new Error(`spawn ${file} ${getSystemErrorName(-n)}`), { errno: -n, code: getSystemErrorName(-n), syscall: `spawn ${file}`, path: file });
  assert.equal(failed(86).code, "Unknown system error -86");
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const on = (system, check) => {
    Object.defineProperty(process, "platform", { ...platform, value: system });
    try {
      check();
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  };
  on("linux", () => {
    assert.equal(programs.unstartable("/opt/ff/ffmpeg", failed(80)), "the system could not start it: accessing a corrupted shared library");
    assert.equal(programs.startFailure("/opt/ff/ffmpeg", failed(80)).message, "easycaptionkit could not start ffmpeg, /opt/ff/ffmpeg, again: accessing a corrupted shared library. Check that it is still there and may be run, and run easycaptionkit again.");
  });
  on("darwin", () => {
    assert.equal(programs.unstartable("/opt/ff/ffmpeg", failed(86)), "it is not a program this system can run");
    assert.equal(programs.unstartable("/opt/ff/ffmpeg", failed(85)), "the system could not start it: bad executable (or shared library)");
    assert.equal(programs.startFailure("/opt/ff/ffmpeg", failed(86)).message, "easycaptionkit could not start ffmpeg, /opt/ff/ffmpeg, again: bad CPU type in executable. Check that it is still there and may be run, and run easycaptionkit again.");
  });
});

// A folder of the stand-ins of a case, with a file in it for each program, from what `body` gives for its name.
function cases(root) {
  const at = (...names) => path.join(root, ...names);
  const put = (name, body, mode = 0o755) => {
    fs.mkdirSync(at(name), { recursive: true });
    for (const role of ROLES) {
      fs.writeFileSync(at(name, role), typeof body === "function" ? body(role) : body);
      fs.chmodSync(at(name, role), mode);
    }
  };
  return { at, put };
}

// What a run says of a file that ran when asked its version and did not answer, as the test sees it run the same way:
// the first line it printed, on its error output, else on its output, and how it ended.
function printed(file, role, env = base) {
  const r = spawnSync(file, [role === "chrome" ? "--version" : "-version"], { encoding: "utf8", env });
  const first = (text) => String(text || "").split(/\r?\n/).find((line) => line.trim());
  const line = first(r.stderr);
  const how = r.signal ? `was stopped by ${r.signal}` : `exited with ${r.status}`;
  const words = line && r.status === 0 && !first(r.stdout) ? `it printed ${programs.quoted(line)} on its error output, nothing on its output, and exited with 0` : line || first(r.stdout) ? `it printed ${programs.quoted(line || first(r.stdout))} and ${how}` : r.signal ? `it was stopped by ${r.signal}` : `it printed nothing and exited with ${r.status}`;
  return `did not run as ${NAME[role]}: ${words}`;
}

// What a run says of a file the system did not start, as its interpreter or its loader is not there, with the first line
// of a script.
const lacking = (role, line) => `did not run as ${NAME[role]}: the system could not start it, as an interpreter or a loader it needs is not there${line ? `; its first line is ${programs.quoted(line)}` : ""}`;
const refusedStart = (role, line) => `did not run as ${NAME[role]}: the system could not start it: permission denied; its first line is ${programs.quoted(line)}`;

// A run in a folder of its own, with an empty TMPDIR: it ends with code 1 and the message, as JSON on stdout too, and
// leaves no out folder and nothing in TMPDIR. A message given as a pattern is one whose words the program prints in an
// order of its own.
function refuser(root) {
  let n = 0;
  return (env, args, message, { spawn = (a, options) => run(a, options) } = {}) => {
    const folder = path.join(root, "runs", String(n++));
    const tmp = path.join(folder, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    const r = spawn([...args, "--out", path.join(folder, "out"), "--json"], { env: { ...base, ...env, TMPDIR: tmp } });
    const what = `${JSON.stringify(env)} ${args.join(" ")}`;
    if (message instanceof RegExp) {
      assert.match(r.stderr, new RegExp(`^easycaptionkit: ${message.source.replace(/^\^|\$$/g, "")}\n$`), what);
      assert.match(JSON.parse(r.stdout).error, message, what);
    } else {
      assert.equal(r.stderr, `easycaptionkit: ${message}\n`, what);
      assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: message }, what);
    }
    assert.equal(r.status, 1, what);
    assert.deepEqual(fs.readdirSync(folder), ["tmp"], what);
    assert.deepEqual(fs.readdirSync(tmp), [], what);
  };
}

const message = (role, place, words, advice) => `easycaptionkit needs ${NAME[role]}, and ${place}, ${words}. ${advice}`;
// The message for a program its variable points to.
const pointed = (role, file, words) => message(role, `${VARIABLE[role]} points to ${file}`, words.startsWith("where ") ? words : `which ${words}`, ADVICE[VARIABLE[role]]);

test("an ffmpeg, ffprobe or Chrome that cannot be started or does not answer as itself when asked its version stops a run before any work, with its variable or the PATH that gave it, its path, and what the system or the program said", { skip: (!hasFfmpeg && "needs ffmpeg") || (!linux && "the files that cannot be run are Linux's") }, async (t) => {
  const root = path.join(dir, "unstarted");
  const { at, put } = cases(root);
  const refused = refuser(root);
  const asRoot = process.getuid() === 0;
  const clip = video({ width: 320, height: 240, seconds: 1, sound: "none" });
  const words = write("unstarted-words.json", { words: evenWords("one two three", { start: 0.1, each: 0.2, gap: 0.05 }) });
  const found = { ffmpeg: real("ffmpeg"), ffprobe: real("ffprobe") };
  const bytes = { ffmpeg: fs.readFileSync(fs.realpathSync(found.ffmpeg)), ffprobe: fs.readFileSync(fs.realpathSync(found.ffprobe)) };
  bytes.chrome = bytes.ffmpeg;
  const swap = (buffer, from, to) => {
    const i = buffer.indexOf(from, 0, "latin1");
    const copy = Buffer.from(buffer);
    copy.write(to, i, "latin1");
    return copy;
  };
  const elf = (b) => b.length > 64 && b.readUInt32BE(0) === 0x7f454c46;
  // A library each program needs and the loader that starts it, each with a letter changed, so the system finds
  // neither, and a version of glibc it asks for made one no glibc has.
  const library = (role) => (/libavdevice\.so\.\d+/.exec(bytes[role].toString("latin1")) || [""])[0];
  const loader = (role) => (/\/lib[\w/.-]*\/ld-[\w.-]+\.so\.\d+/.exec(bytes[role].subarray(0, 4096).toString("latin1")) || [""])[0];
  const gone = (name) => `${name.slice(0, -1)}${name.endsWith("9") ? "8" : "9"}`;
  const linked = ROLES.every((role) => elf(bytes[role]) && library(role) && loader(role));
  // A version of glibc that ffmpeg and ffprobe of Ubuntu 22.04 and newer ask for.
  const glibc = ["GLIBC_2.34", "GLIBC_2.29"].find((version) => ROLES.every((role) => bytes[role].indexOf(version, 0, "latin1") > 0));
  if (linked) {
    put("libmiss", (role) => swap(bytes[role], library(role), library(role).replace("libavdevice", "libavdevicX")));
    put("noloader", (role) => swap(bytes[role], loader(role), gone(loader(role))));
  }
  // A loader that is a script, which the system takes for a corrupted shared library: ldd, glibc's script.
  const script = fs.existsSync("/usr/bin/ldd") && fs.readFileSync("/usr/bin/ldd").subarray(0, 2).toString("latin1") === "#!" ? "/usr/bin/ldd" : "";
  if (linked && script) put("scriptloader", (role) => swap(bytes[role], loader(role), script.padEnd(loader(role).length, "\0")));
  if (glibc) put("newer", (role) => swap(bytes[role], glibc, "GLIBC_2.99"));
  // The other processor, by the number ELF gives it.
  const other = { x64: 183, arm64: 62 }[process.arch];
  if (other)
    put("arm", (role) => {
      const copy = Buffer.from(bytes[role]);
      copy.writeUInt16LE(other, 18);
      return copy;
    });
  put("libsay", '#!/bin/sh\necho "$0: error while loading shared libraries: libavdevice.so.61: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
  put("pe", Buffer.concat([Buffer.from("4d5a90000300000004000000ffff0000b800000000000000400000000000000000", "hex"), Buffer.alloc(4096)]));
  put("macho", Buffer.concat([Buffer.from("cffaedfe07000001030000000200000000", "hex"), Buffer.alloc(4096)]));
  put("garbage", Buffer.from("8f3a9c1e77d20b5566aa01ff3c9e2b7d10203040506070809a0b0c0d0e0f1011", "hex"));
  put("empty", "");
  put("empty-unmarked", "", 0o644);
  put("text", "not a program\n");
  put("echoes", "echo hello\n");
  put("page", "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head></html>\n");
  put("missing-interpreter", "#!/nonexistent/sh\n");
  put("crlf", "#!/bin/sh\r\nexit 0\r\n");
  // The system reads the program a #! line names up to a space or a tab: the folders and the file these scripts name
  // are where no space is, under /tmp where the test's folder has one.
  const plain = /[ \t]/.test(root) ? (() => { try { return fs.mkdtempSync("/tmp/easycaptionkit-test-"); } catch { return ""; } })() : root;
  if (plain && plain !== root) t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const unspaced = !plain && "needs a folder whose path has no space";
  // A folder whose name has letters outside ASCII, which a #! line holds as UTF-8.
  const letters = plain && path.join(plain, "klasör-日本");
  if (plain) {
    put("folder-interpreter", `#!${plain}\n`);
    fs.mkdirSync(letters, { recursive: true });
    put("letters-interpreter", `#!${letters}\n`);
    fs.writeFileSync(path.join(plain, "readme.txt"), "a file\n", { mode: 0o644 });
    put("locked-interpreter", `#!${path.join(plain, "readme.txt")}\n`);
  }
  // Scripts whose #! line has env start a program that is not on PATH, and one that is a folder there.
  put("env-missing", "#!/usr/bin/env no-program-by-this-name\n");
  put("env-folder", "#!/usr/bin/env folder-by-this-name\n");
  fs.mkdirSync(at("env-path", "folder-by-this-name"), { recursive: true });
  // A script that fails as Node.js does, with a stack under the line that says why, and one that runs a program the
  // loader cannot start, whose words name that program and not the script.
  put("throws", `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'throw new Error("the wrapper could not find its config")'\n`);
  put("runs-libless", '#!/bin/sh\necho "/opt/real/ffmpeg: error while loading shared libraries: libavdevice.so.61: cannot open shared object file: No such file or directory" >&2\nexit 127\n');
  put("unmarked", (role) => bytes[role], 0o644);
  put("others", (role) => bytes[role], 0o055);
  for (const role of ROLES) fs.mkdirSync(at("folder", role), { recursive: true });
  for (const name of ["linkdir", "dangling", "loop"]) fs.mkdirSync(at(name), { recursive: true });
  for (const role of ROLES) {
    fs.symlinkSync(at("folder", role), at("linkdir", role));
    fs.symlinkSync(at("nowhere", role), at("dangling", role));
    fs.symlinkSync(at("loop", `${role}-b`), at("loop", role));
    fs.symlinkSync(at("loop", role), at("loop", `${role}-b`));
  }
  put("locked", (role) => bytes[role]);
  fs.writeFileSync(at("afile"), "x");
  // Programs that start and are not the one asked for: one that says nothing, one that fails, one that crashes and one
  // the system stops with SIGKILL.
  put("silent", "#!/bin/sh\nexit 0\n");
  put("failing", "#!/bin/sh\necho 'something went wrong' >&2\nexit 3\n");
  put("crashing", "#!/bin/sh\nkill -SEGV $$\n");
  put("killed", "#!/bin/sh\nkill -KILL $$\n");
  // A named pipe with the permission to run it, which the system does not run, and whose first line a read waits for.
  fs.mkdirSync(at("fifo"), { recursive: true });
  for (const role of ROLES) assert.equal(spawnSync("mkfifo", ["-m", "755", at("fifo", role)]).status, 0);
  // Each program named by its variable: ffmpeg in a run that burns captions with libass, ffprobe in that run and in a
  // subtitles run, which uses ffprobe alone, and Chrome in a run that draws with it. `env` is more of the
  // environment, as a PATH, and `options` how each run is started.
  const named = (file, what, env = {}, options = {}) => {
    const value = (role) => (typeof file === "function" ? file(role) : file);
    const expect = (role) => {
      const words = what(value(role), role);
      if (!(words instanceof RegExp)) return pointed(role, value(role), words);
      const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`^${escape(pointed(role, value(role), "\0")).replace("\0", words.source)}$`);
    };
    refused({ ...env, FFMPEG_PATH: value("ffmpeg"), FFPROBE_PATH: found.ffprobe }, [clip, "--words", words, "--libass"], expect("ffmpeg"), options);
    for (const args of [[clip, "--words", words, "--libass"], ["subtitles", words, "--video", clip]]) refused({ ...env, FFPROBE_PATH: value("ffprobe") }, args, expect("ffprobe"), options);
    refused({ ...env, CHROME_PATH: value("chrome") }, [clip, "--words", words], expect("chrome"), options);
  };
  const list = [
    ["nothing at the path", "nothing", () => "where there is none"],
    ["a path through a file", "afile", () => `where there is none, as ${at("afile")} is a file, not a folder`],
    ["a folder", "folder", () => "is a folder"],
    ["a link to a folder", "linkdir", () => "is a folder"],
    ["a link to nothing", "dangling", () => "is a link to a file that is not there"],
    ["a loop of links", "loop", () => "goes through a loop of links"],
    ["a file without the permission to run it", "unmarked", () => "is not executable"],
    ["an empty file without the permission to run it", "empty-unmarked", () => "is not executable"],
    ["a file only other users may run", "others", () => "may not be run: permission denied", asRoot && "root may run it"],
    ["an empty file, which the shell runs and which prints nothing", "empty", (file, role) => `did not run as ${NAME[role]}: it printed nothing and exited with 0`],
    ["a text file with no #! line", "text", printed],
    ["a text file with no #! line that the shell runs and that prints a line", "echoes", (file, role) => `did not run as ${NAME[role]}: it printed "hello" and exited with 0`],
    ["a web page saved in the program's place", "page", printed],
    ["a script whose interpreter is not there", "missing-interpreter", (file, role) => lacking(role, "#!/nonexistent/sh")],
    ["a script saved with Windows line ends", "crlf", (file, role) => lacking(role, "#!/bin/sh\r")],
    ["a script whose interpreter is a folder", "folder-interpreter", (file, role) => refusedStart(role, `#!${plain}`), unspaced],
    ["a script whose interpreter is a folder whose name has letters outside ASCII", "letters-interpreter", (file, role) => refusedStart(role, `#!${letters}`), unspaced],
    ["a script whose interpreter may not be run", "locked-interpreter", (file, role) => refusedStart(role, `#!${path.join(plain, "readme.txt")}`), unspaced],
    ["a script whose #! line has env start a program that is not on PATH", "env-missing", printed],
    ["a program whose loader the machine lacks", "noloader", (file, role) => lacking(role, null), !linked && "the system's ffmpeg names no loader"],
    ["a program whose loader is a script", "scriptloader", (file, role) => `did not run as ${NAME[role]}: the system could not start it: accessing a corrupted shared library`, (!linked && "the system's ffmpeg names no loader") || (!script && "needs ldd as a script")],
    ["a program that needs a shared library the machine lacks", "libmiss", printed, !linked && "the system's ffmpeg is not linked to libavdevice"],
    ["a program made for a newer glibc than the machine's", "newer", printed, !glibc && "the system's ffmpeg asks for no GLIBC_2.34 or GLIBC_2.29"],
    ["the loader's words for a library it did not find, from a script", "libsay", printed],
    ["a script that runs a program the loader cannot start", "runs-libless", printed],
    // The shell reads the whole program as a script, and what it says comes in an order of its own.
    ["a program for another processor", "arm", (file, role) => new RegExp(`did not run as ${NAME[role]}: it printed "${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: \\d+: .*" and exited with \\d+`), !other && "needs an x86-64 or ARM64 machine"],
    ["a Windows program", "pe", printed],
    ["a macOS program", "macho", printed],
    ["a file of bytes that are no program", "garbage", printed],
    ["a script that fails as Node.js does", "throws", printed],
    ["a program that says nothing when asked its version", "silent", (file, role) => `did not run as ${NAME[role]}: it printed nothing and exited with 0`],
    ["a program that fails when asked its version", "failing", (file, role) => `did not run as ${NAME[role]}: it printed "something went wrong" and exited with 3`],
    ["a program that crashes when asked its version", "crashing", (file, role) => `did not run as ${NAME[role]}: it was stopped by SIGSEGV`],
    ["a program the system stops with SIGKILL when asked its version", "killed", (file, role) => `did not run as ${NAME[role]}: it was stopped by SIGKILL`],
  ];
  for (const [title, folder, what, skip] of list) await t.test(title, { skip }, () => named((role) => at(folder, role), what));
  // A run that waits on the pipe ends neither by SIGINT nor by SIGTERM, so it is killed once a minute has passed.
  await t.test("a named pipe with the permission to run it", () => {
    named((role) => at("fifo", role), () => "is a named pipe", {}, { spawn: (args, options) => run(args, { ...options, timeout: 60_000, killSignal: "SIGKILL" }) });
  });
  await t.test("a script whose #! line has env start a program that is a folder on PATH", () => {
    const PATH = `${at("env-path")}${path.delimiter}${base.PATH}`;
    named((role) => at("env-folder", role), (file, role) => printed(file, role, { ...base, PATH }), { PATH });
  });
  await t.test("a name that is not on PATH", () => {
    assert.ok(!has("no-program-by-this-name"));
    refused({ FFMPEG_PATH: "no-program-by-this-name" }, [clip, "--words", words, "--libass"], `easycaptionkit needs ffmpeg, and FFMPEG_PATH names no-program-by-this-name, which is not on PATH. ${ADVICE.FFMPEG_PATH}`);
    refused({ FFPROBE_PATH: "no-program-by-this-name" }, ["subtitles", words, "--video", clip], `easycaptionkit needs ffprobe, and FFPROBE_PATH names no-program-by-this-name, which is not on PATH. ${ADVICE.FFPROBE_PATH}`);
    refused({ CHROME_PATH: "no-program-by-this-name" }, [clip, "--words", words], `easycaptionkit needs Chrome, and CHROME_PATH names no-program-by-this-name, which is not on PATH. ${ADVICE.CHROME_PATH}`);
  });
  await t.test("a name found on PATH that is not the program asked for", () => {
    const PATH = `${at("failing")}${path.delimiter}${base.PATH}`;
    refused({ PATH, FFMPEG_PATH: "ffmpeg" }, [clip, "--words", words, "--libass"], `easycaptionkit needs ffmpeg, and FFMPEG_PATH names ffmpeg, found on PATH at ${at("failing", "ffmpeg")}, which did not run as ffmpeg: it printed "something went wrong" and exited with 3. ${ADVICE.FFMPEG_PATH}`);
  });
  await t.test("the program of another role", () => {
    refused({ FFMPEG_PATH: found.ffprobe }, [clip, "--words", words, "--libass"], pointed("ffmpeg", found.ffprobe, printed(found.ffprobe, "ffmpeg")));
    refused({ FFPROBE_PATH: found.ffmpeg }, ["subtitles", words, "--video", clip], pointed("ffprobe", found.ffmpeg, printed(found.ffmpeg, "ffprobe")));
  });
  await t.test("a file in a folder this user may not enter", { skip: asRoot && "root enters any folder" }, () => {
    fs.chmodSync(at("locked"), 0o000);
    try {
      named((role) => at("locked", role), () => "may not be run: permission denied");
    } finally {
      fs.chmodSync(at("locked"), 0o755);
    }
  });
  // On PATH, with nothing named: the system passes over a folder, a file this user may not run, a link to nothing and a
  // script whose interpreter is missing, and the first of them is named when no program comes after them; it stops at
  // the first file that ran and did not answer.
  fs.mkdirSync(at("lone"), { recursive: true });
  fs.symlinkSync(fs.realpathSync(found.ffmpeg), at("lone", "ffmpeg"));
  fs.mkdirSync(at("chromes", "google-chrome"), { recursive: true });
  fs.mkdirSync(at("broken-chrome"), { recursive: true });
  fs.copyFileSync(at("pe", "chrome"), at("broken-chrome", "google-chrome"));
  const onPath = (where, name, words) => `easycaptionkit needs ${NAME[name] || "Chrome"}, and the ${name} on PATH, ${at(where, name)}, ${words}. ${ADVICE[name] || ADVICE.chrome}`;
  await t.test("a PATH whose first match is a folder, with nothing after it", () => {
    refused({ PATH: at("folder") }, [clip, "--words", words, "--libass"], onPath("folder", "ffmpeg", "is a folder"));
    refused({ PATH: at("folder"), FFMPEG_PATH: at("lone", "ffmpeg") }, ["subtitles", words, "--video", clip], onPath("folder", "ffprobe", "is a folder"));
    refused({ PATH: at("chromes"), FFMPEG_PATH: found.ffmpeg, FFPROBE_PATH: found.ffprobe }, [clip, "--words", words], onPath("chromes", "google-chrome", "is a folder"));
    refused({ PATH: `${at("dangling")}${path.delimiter}${at("unmarked")}` }, [clip, "--words", words, "--libass"], onPath("dangling", "ffmpeg", "is a link to a file that is not there"));
  });
  await t.test("a PATH whose first match is a file that runs and does not answer", () => {
    const PATH = `${at("pe")}${path.delimiter}${base.PATH}`;
    refused({ PATH }, [clip, "--words", words, "--libass"], onPath("pe", "ffmpeg", printed(at("pe", "ffmpeg"), "ffmpeg")));
    refused({ PATH, FFMPEG_PATH: at("lone", "ffmpeg") }, ["subtitles", words, "--video", clip], onPath("pe", "ffprobe", printed(at("pe", "ffprobe"), "ffprobe")));
    refused({ PATH: `${at("broken-chrome")}${path.delimiter}${base.PATH}` }, [clip, "--words", words], onPath("broken-chrome", "google-chrome", printed(at("broken-chrome", "google-chrome"), "chrome")));
  });
  await t.test("the ffprobe next to the ffmpeg named", () => {
    refused({ FFMPEG_PATH: at("failing", "ffmpeg") }, ["subtitles", words, "--video", clip], `easycaptionkit needs ffprobe, and the ffprobe next to ${at("failing", "ffmpeg")}, ${at("failing", "ffprobe")}, did not run as ffprobe: it printed "something went wrong" and exited with 3. Set FFPROBE_PATH to an ffprobe that runs.`);
  });
  // A file system mounted noexec, in a mount namespace of its own, where the run is root of a user namespace.
  const mount = at("noexec");
  fs.mkdirSync(mount, { recursive: true });
  const namespaced = spawnSync("unshare", ["-rm", "sh", "-c", 'mount -t tmpfs -o noexec,size=1m tmpfs "$1"', "sh", mount], { encoding: "utf8" }).status === 0;
  await t.test("a file on a file system mounted noexec", { skip: !namespaced && "needs unshare to mount a file system of its own" }, () => {
    const inside = (role, mode) => (args, options) => spawnSync("unshare", ["-rm", "sh", "-c", 'mount -t tmpfs -o noexec,size=64m tmpfs "$1" && cp "$2" "$1/$3" && chmod "$4" "$1/$3" && shift 4 && exec "$@"', "sh", mount, fs.realpathSync(found[role === "chrome" ? "ffmpeg" : role]), role, mode, process.execPath, CLI, ...args], { encoding: "utf8", timeout: 600_000, ...options });
    for (const [mode, what] of [["755", "may not be run: permission denied"], ["644", "is not executable"]]) {
      refused({ FFMPEG_PATH: path.join(mount, "ffmpeg"), FFPROBE_PATH: found.ffprobe }, [clip, "--words", words, "--libass"], pointed("ffmpeg", path.join(mount, "ffmpeg"), what), { spawn: inside("ffmpeg", mode) });
      refused({ FFPROBE_PATH: path.join(mount, "ffprobe") }, ["subtitles", words, "--video", clip], pointed("ffprobe", path.join(mount, "ffprobe"), what), { spawn: inside("ffprobe", mode) });
      refused({ CHROME_PATH: path.join(mount, "chrome") }, [clip, "--words", words], pointed("chrome", path.join(mount, "chrome"), what), { spawn: inside("chrome", mode) });
    }
  });
  // With no file descriptor left for the pipes of the first program it starts: a node that holds all it may but three.
  await t.test("no file descriptor left to start a program with", () => {
    const hold = at("hold-fds.js");
    fs.writeFileSync(hold, 'const fs = require("node:fs");\nconst held = [];\ntry {\n  for (;;) held.push(fs.openSync(__filename, "r"));\n} catch {}\nfor (let i = 0; i < 3; i++) fs.closeSync(held.pop());\n');
    const limited = (args, options) => spawnSync("sh", ["-c", 'ulimit -n 256 && exec "$@"', "sh", process.execPath, "-r", hold, CLI, ...args], { encoding: "utf8", timeout: 600_000, ...options });
    refused({}, [clip, "--words", words, "--libass"], "easycaptionkit could not start ffmpeg: too many open files. Raise the limit on open files (ulimit -n) and run it again.", { spawn: limited });
  });
  // With no process left for this user: a node that, once its own threads are going, may start no more, as prlimit sets
  // it. The limit does not hold for root.
  const prlimit = !asRoot && spawnSync("prlimit", ["--version"], { encoding: "utf8" }).status === 0;
  await t.test("no process left to start a program with", { skip: !prlimit && (asRoot ? "root starts any number of processes" : "needs prlimit") }, () => {
    const limit = at("no-more-processes.js");
    fs.writeFileSync(limit, 'const { spawnSync } = require("node:child_process");\nrequire("node:fs").stat(__filename, () => {});\nif (spawnSync("prlimit", ["--pid", String(process.pid), "--nproc=1:1"]).status !== 0) process.exit(9);\n');
    const limited = (args, options) => spawnSync(process.execPath, ["-r", limit, CLI, ...args], { encoding: "utf8", timeout: 600_000, ...options });
    refused({}, [clip, "--words", words, "--libass"], "easycaptionkit could not start ffmpeg: the system starts no more processes for now. Run it again once fewer are running.", { spawn: limited });
  });
});

test("with no program by its names on PATH or where package managers put it, a run says it found none and how to get one", { skip: !posix && "Windows looks where Chrome installs itself" }, async () => {
  const { FFMPEG, FFPROBE } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const { CHROME } = require("../skills/easycaptionkit/scripts/lib/chrome");
  const empty = path.join(dir, "empty-path");
  fs.mkdirSync(empty, { recursive: true });
  const saved = { PATH: process.env.PATH, FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH, CHROME_PATH: process.env.CHROME_PATH };
  try {
    process.env.PATH = empty;
    for (const name of ["FFMPEG_PATH", "FFPROBE_PATH", "CHROME_PATH"]) delete process.env[name];
    await assert.rejects(programs.find({ ...FFMPEG, known: [] }), { message: `easycaptionkit needs ffmpeg, and none was found. Install it (${INSTALL}) or set FFMPEG_PATH to one.`, why: "no ffmpeg was found" });
    await assert.rejects(programs.find({ ...FFPROBE(path.join(empty, "ffmpeg")), known: [] }), { message: `easycaptionkit needs ffprobe, and none was found next to ${path.join(empty, "ffmpeg")} or on PATH. Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to one.` });
    await assert.rejects(programs.find({ ...FFPROBE(""), known: [] }), { message: `easycaptionkit needs ffprobe, and none was found on PATH. Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to one.` });
    if (linux) await assert.rejects(programs.find(CHROME), { message: `easycaptionkit needs Chrome to draw the captions, and none was found. Install Google Chrome or Chromium, or set CHROME_PATH to one. ${LIBASS}`, why: "no Chrome was found" });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("an ffmpeg or a Chrome that gives no answer when asked its version is stopped once the time is up and named with its place", { skip: !posix && "the stand-ins are shell scripts" }, async () => {
  const ffmpeg = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const { chromeReady } = require("../skills/easycaptionkit/scripts/lib/chrome");
  const standIn = path.join(dir, "hangs", "program");
  fs.mkdirSync(path.dirname(standIn), { recursive: true });
  fs.writeFileSync(standIn, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
  const saved = { FFMPEG_PATH: process.env.FFMPEG_PATH, CHROME_PATH: process.env.CHROME_PATH };
  try {
    process.env.FFMPEG_PATH = standIn;
    process.env.CHROME_PATH = standIn;
    const started = Date.now();
    await assert.rejects(ffmpeg.ready(500), { message: `easycaptionkit needs ffmpeg, and FFMPEG_PATH points to ${standIn}, which did not run as ffmpeg: it gave no answer in 0.5 s. ${ADVICE.FFMPEG_PATH}` });
    await assert.rejects(chromeReady(500), { message: `easycaptionkit needs Chrome, and CHROME_PATH points to ${standIn}, which did not run as Chrome: it gave no answer in 0.5 s. ${ADVICE.CHROME_PATH}` });
    assert.ok(Date.now() - started < 20_000);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("on PATH a run takes the ffmpeg the system starts, past a folder, a file it may not run, a link to nothing and a script whose interpreter is missing, and ffprobe next to it", { skip: (!hasFfmpeg && "needs ffmpeg") || (!posix && "the stand-ins are shell scripts") }, async () => {
  const ffmpeg = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const root = path.join(dir, "passed-over");
  const { at, put } = cases(root);
  put("missing-interpreter", "#!/nonexistent/sh\n");
  put("unmarked", "#!/bin/sh\nexit 0\n", 0o644);
  for (const role of ROLES) fs.mkdirSync(at("folder", role), { recursive: true });
  fs.mkdirSync(at("dangling"), { recursive: true });
  for (const role of ROLES) fs.symlinkSync(at("nowhere", role), at("dangling", role));
  const saved = { PATH: process.env.PATH, FFMPEG_PATH: process.env.FFMPEG_PATH, FFPROBE_PATH: process.env.FFPROBE_PATH };
  try {
    delete process.env.FFMPEG_PATH;
    delete process.env.FFPROBE_PATH;
    const ffmpegDir = path.dirname(real("ffmpeg"));
    process.env.PATH = [at("folder"), at("unmarked"), at("dangling"), at("missing-interpreter"), ffmpegDir].join(path.delimiter);
    const found = await ffmpeg.ready();
    assert.equal(found.ffmpeg, path.join(ffmpegDir, "ffmpeg"));
    assert.equal(found.ffprobe, path.join(ffmpegDir, "ffprobe"));
    assert.match(found.version, /^ffmpeg version /);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a wrapper in a program's place that answers as the program goes ahead: with no #! line, and when its shell first says something of a line it goes past", { skip: (!hasFfmpeg && "needs ffmpeg") || (!linux && "the wrappers are Linux shell scripts") }, () => {
  const root = path.join(dir, "wrappers");
  fs.mkdirSync(root, { recursive: true });
  const clip = video({ width: 320, height: 240, seconds: 1, sound: "none" });
  const words = write("wrapper-words.json", { words: evenWords("one two three", { start: 0.1, each: 0.2, gap: 0.05 }) });
  const chrome = real("google-chrome") || real("chromium");
  const wrap = (shape, role, target) => {
    const file = path.join(root, shape, role);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${shape === "unmarked" ? "" : "#!/bin/sh\n"}${shape === "warns" ? "no-such-command-of-a-wrapper\n" : ""}exec ${JSON.stringify(target)} "$@"\n`, { mode: 0o755 });
    return file;
  };
  const libass = / ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  for (const shape of ["unmarked", "warns"]) {
    const env = { ...base, FFMPEG_PATH: wrap(shape, "ffmpeg", real("ffmpeg")), FFPROBE_PATH: wrap(shape, "ffprobe", real("ffprobe")) };
    const subtitles = run(["subtitles", words, "--video", clip, "--out", path.join(root, `${shape}-subtitles`)], { env });
    assert.equal(subtitles.status, 0, subtitles.stderr);
    if (chrome) {
      const drawn = run([clip, "--words", words, "--out", path.join(root, `${shape}-chrome`)], { env: { ...env, CHROME_PATH: wrap(shape, "chrome", chrome) } });
      assert.equal(drawn.status, 0, drawn.stderr);
      assert.ok(fs.statSync(path.join(root, `${shape}-chrome`, "captioned.mp4")).size > 0);
    } else if (libass) {
      const drawn = run([clip, "--words", words, "--libass", "--out", path.join(root, `${shape}-libass`)], { env });
      assert.equal(drawn.status, 0, drawn.stderr);
    }
  }
});

test("subtitles --video reads the video with ffprobe alone, so an ffmpeg that cannot be run, named or first on PATH, does not stop it", { skip: (!hasFfmpeg && "needs ffmpeg") || (!posix && "needs file modes") }, () => {
  const root = path.join(dir, "probe-alone");
  fs.mkdirSync(root, { recursive: true });
  const clip = video({ width: 320, height: 240, seconds: 1, sound: "none" });
  const words = write("probe-alone-words.json", { words: evenWords("one two three", { start: 0.1, each: 0.2, gap: 0.05 }) });
  const at = (...names) => path.join(root, ...names);
  for (const name of ["plain", "empty", "folder", "dangling"]) fs.mkdirSync(at(name), { recursive: true });
  fs.writeFileSync(at("plain", "ffmpeg"), fs.readFileSync(fs.realpathSync(real("ffmpeg"))), { mode: 0o644 });
  fs.writeFileSync(at("empty", "ffmpeg"), "", { mode: 0o755 });
  fs.mkdirSync(at("folder", "ffmpeg"), { recursive: true });
  fs.symlinkSync(at("nowhere", "ffmpeg"), at("dangling", "ffmpeg"));
  const ffprobeDir = path.dirname(real("ffprobe"));
  const made = (out) => fs.readdirSync(out).sort();
  const six = ["CAPTIONS.md", "captions.ass", "captions.json", "captions.srt", "captions.vtt", "words.json"];
  let n = 0;
  for (const env of [
    { FFMPEG_PATH: at("plain", "ffmpeg") },
    { FFMPEG_PATH: at("empty", "ffmpeg") },
    { FFMPEG_PATH: at("folder", "ffmpeg") },
    { FFMPEG_PATH: at("dangling", "ffmpeg") },
    { FFMPEG_PATH: at("nowhere", "ffmpeg") },
    { FFMPEG_PATH: at("empty", "ffmpeg"), FFPROBE_PATH: real("ffprobe") },
    { PATH: `${at("folder")}${path.delimiter}${ffprobeDir}` },
    { PATH: `${at("plain")}${path.delimiter}${ffprobeDir}` },
  ]) {
    const out = at("out", String(n++));
    const r = run(["subtitles", words, "--video", clip, "--out", out], { env: { ...base, ...env } });
    assert.equal(r.status, 0, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.deepEqual(made(out), six, JSON.stringify(env));
  }
});

test("an ffmpeg that answers its version and then fails or is stopped when asked its encoders or its filters is said to, where the run said it had no H.264 encoder, no overlay filter or no libass; one with no H.264 encoder is refused with all four a run can use named", { skip: (!hasFfmpeg && "needs ffmpeg") || (!posix && "the stand-ins are shell scripts") }, () => {
  const root = path.join(dir, "probes");
  const refused = refuser(root);
  const clip = video({ width: 320, height: 240, seconds: 1, sound: "none" });
  const words = write("probes-words.json", { words: evenWords("one two three", { start: 0.1, each: 0.2, gap: 0.05 }) });
  const ffmpeg = real("ffmpeg");
  const standIn = (name, on, then) => {
    const file = path.join(root, name, "ffmpeg");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\ncase " $* " in *" ${on} "*) ${then};; esac\nexec ${JSON.stringify(ffmpeg)} "$@"\n`, { mode: 0o755 });
    return file;
  };
  const failed = (file, what, how) => `easycaptionkit needs ffmpeg, and FFMPEG_PATH points to ${file}, which failed when asked ${what}: ${how}. ${ADVICE.FFMPEG_PATH}`;
  const env = (file) => ({ FFMPEG_PATH: file, FFPROBE_PATH: real("ffprobe") });
  const killEncoders = standIn("kill-encoders", "-encoders", "kill -KILL $$");
  const killFilters = standIn("kill-filters", "-filters", "kill -KILL $$");
  const failEncoders = standIn("fail-encoders", "-encoders", "echo 'something failed while listing' >&2; exit 1");
  const crashX264 = standIn("crash-x264", "encoder=libx264", "kill -SEGV $$");
  const failSetparams = standIn("fail-setparams", "filter=setparams", "echo 'no help here' >&2; exit 1");
  const lists = /^\s*V\S*\s+libx264\s/m.test(spawnSync(ffmpeg, ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout);
  const setparams = /^\s*\S+\s+setparams\s/m.test(spawnSync(ffmpeg, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  const chrome = has("google-chrome") || has("chromium");
  for (const libass of chrome ? [[], ["--libass"]] : [["--libass"]]) {
    const args = [clip, "--words", words, ...libass];
    refused(env(killEncoders), args, failed(killEncoders, "its encoders (-encoders)", "it was stopped by SIGKILL"));
    refused(env(killFilters), args, failed(killFilters, "its filters (-filters)", "it was stopped by SIGKILL"));
    refused(env(failEncoders), args, failed(failEncoders, "its encoders (-encoders)", 'it printed "something failed while listing" and exited with 1'));
    if (lists) refused(env(crashX264), args, failed(crashX264, "about its libx264 (-h encoder=libx264)", "it was stopped by SIGSEGV"));
    if (setparams) refused(env(failSetparams), args, failed(failSetparams, "about its setparams filter (-h filter=setparams)", 'it printed "no help here" and exited with 1'));
  }
  // An ffmpeg that lists no H.264 encoder.
  const noH264 = path.join(root, "no-h264", "ffmpeg");
  fs.mkdirSync(path.dirname(noH264), { recursive: true });
  fs.writeFileSync(noH264, `#!/bin/sh\ncase " $* " in *" -encoders "*) ${JSON.stringify(ffmpeg)} "$@" | grep -v -E 'h264|x264'; exit 0;; esac\nexec ${JSON.stringify(ffmpeg)} "$@"\n`, { mode: 0o755 });
  refused(env(noH264), [clip, "--words", words, "--libass"], "This ffmpeg has no H.264 encoder (libx264, VideoToolbox, OpenH264 or Media Foundation), so it cannot write the captioned MP4");
});

test("a program a run checked that the system cannot start during the work says what the system is short of, or what it said and what to check, and one started in a work folder that is gone says so", { skip: (!hasFfmpeg && "needs ffmpeg") || (!posix && "needs a shell's ffmpeg") }, async () => {
  const ffmpeg = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const failure = (code, file = "/opt/ffmpeg/ffprobe") => programs.startFailure(file, Object.assign(new Error(`spawn ${file} ${code}`), { code, errno: -require("node:os").constants.errno[code], syscall: `spawn ${file}` })).message;
  assert.equal(failure("EMFILE"), "easycaptionkit could not start ffprobe: too many open files. Raise the limit on open files (ulimit -n) and run it again.");
  assert.equal(failure("ENFILE"), "easycaptionkit could not start ffprobe: the system has too many files open. Run it again once fewer are.");
  assert.equal(failure("EAGAIN"), "easycaptionkit could not start ffprobe: the system starts no more processes for now. Run it again once fewer are running.");
  assert.equal(failure("ENOMEM"), "easycaptionkit could not start ffprobe: not enough memory. Free some and run it again.");
  const again = (words) => `easycaptionkit could not start ffprobe, /opt/ffmpeg/ffprobe, again: ${words}. Check that it is still there and may be run, and run easycaptionkit again.`;
  assert.equal(failure("ENOENT"), again("no such file or directory"));
  assert.equal(failure("EACCES"), again("permission denied"));
  const gone = path.join(dir, "gone-work-folder");
  const file = real("ffmpeg");
  await assert.rejects(ffmpeg.run(file, ["-version"], { cwd: gone }), { message: `${path.basename(file)} could not be started in ${gone}, a folder that is not there any more or may not be entered` });
  await assert.rejects(ffmpeg.run(path.join(dir, "no-such-ffmpeg"), ["-version"]), { message: `easycaptionkit could not start no-such-ffmpeg, ${path.join(dir, "no-such-ffmpeg")}, again: no such file or directory. Check that it is still there and may be run, and run easycaptionkit again.` });
  // An ffmpeg that answers when the run begins and may not be run once libass has been asked how it draws colors, so
  // the encode cannot start it.
  if (!/ ass /.test(spawnSync(file, ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return;
  const root = path.join(dir, "started-again");
  const refused = refuser(root);
  const lost = path.join(root, "lost", "ffmpeg");
  fs.mkdirSync(path.dirname(lost), { recursive: true });
  fs.writeFileSync(lost, `#!/bin/sh\ncase " $* " in *" ass=filename=matrix.ass "*) ${JSON.stringify(file)} "$@"; s=$?; chmod 644 "$0"; exit $s;; esac\nexec ${JSON.stringify(file)} "$@"\n`, { mode: 0o755 });
  const clip = video({ width: 320, height: 240, seconds: 1, sound: "none" });
  const words = write("started-again-words.json", { words: evenWords("one two three", { start: 0.1, each: 0.2, gap: 0.05 }) });
  refused({ FFMPEG_PATH: lost, FFPROBE_PATH: real("ffprobe") }, [clip, "--words", words, "--libass"], `easycaptionkit could not start ffmpeg, ${lost}, again: permission denied. Check that it is still there and may be run, and run easycaptionkit again.`);
});
