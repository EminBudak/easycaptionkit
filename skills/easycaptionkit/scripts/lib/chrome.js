"use strict";

// The user's Chrome, headless, over the DevTools protocol on a pipe (file
// descriptors 3 and 4), so no port is opened. Each run gets a throwaway
// profile, and the browser stays offline: the captions page carries its
// own fonts as local files.
//
// On a Mac, Chrome asks for the login keychain under a fresh profile
// unless it gets a mock keychain and a basic password store.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const programs = require("./programs");
const { track, trackFolder, untrackFolder, kill, sleep } = require("./running");

const LIBASS = "--libass has ffmpeg draw the captions without Chrome.";

// Chrome as a run looks for it and asks it its version (see
// programs.find()): the path CHROME_PATH gives, or a name on PATH, as
// FFMPEG_PATH is read; else where macOS and Windows install it, and on
// PATH by each of its names. It answers with a version number, as "Google
// Chrome 155.0.8059.84". On Windows, where Chrome prints no version, it is
// not asked, and taken once nothing keeps it from running.
const CHROME = {
  name: "Chrome",
  variable: "CHROME_PATH",
  args: ["--version"],
  answers: (stdout) => /\d+\.\d+/.test(stdout),
  names: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "microsoft-edge", "brave-browser"],
  first: () => {
    const mac = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ];
    const win = [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe"),
    ];
    const listed = process.platform === "darwin" ? mac : process.platform === "win32" ? win : [];
    return listed.filter(Boolean).map((file) => ({ file, name: "Chrome", where: "installed on this machine" }));
  },
  ask: process.platform !== "win32",
  none: `easycaptionkit needs Chrome to draw the captions, and none was found. Install Google Chrome or Chromium, or set CHROME_PATH to one. ${LIBASS}`,
  advice: {
    variable: `Set CHROME_PATH to a Chrome that runs, or unset it and install Google Chrome or Chromium. ${LIBASS}`,
    found: `Install Google Chrome or Chromium, or set CHROME_PATH to a Chrome that runs. ${LIBASS}`,
  },
};

// The Chrome a run would take, by what is at its place alone, not run, or
// "" where there is none.
const findChrome = () => programs.locate(CHROME);

// The Chrome that answered, for the CHROME_PATH, the PATH and the folder
// the run works with now: a run asks it once, and every Chrome it starts
// to draw is that one. A failure is not kept, so a later call asks again.
let checked = null;

// The Chrome a run draws with, found and asked its version before any work,
// so one that cannot be started or does not answer as Chrome stops the run
// with what the system or the program said, not once it begins to draw.
async function chromeReady(limit = programs.LIMIT) {
  let here = "";
  try {
    here = process.cwd();
  } catch {
    // A folder taken away since: only PATH's relative entries read from it.
  }
  const key = JSON.stringify([process.env.CHROME_PATH, process.env.PATH, here]);
  if (checked && checked.key === key) return checked.file;
  const { file } = await programs.find(CHROME, limit);
  checked = { key, file };
  return file;
}

// For a run that draws without Chrome and uses it for its pictures alone:
// why there is no Chrome to use, as words that follow "since", or "" when
// it answers.
async function chromeProblem() {
  try {
    await chromeReady();
    return "";
  } catch (err) {
    if (!err.unusable) throw err;
    return err.why;
  }
}

// An error of Chrome's own, not of a file or of ffmpeg: `start` when Chrome
// stopped before it answered at all, as one without a usable sandbox does,
// and `signal` when a signal ended it.
const failed = (message, { start = false, signal = null } = {}) => Object.assign(new Error(message), { chrome: true, start, signal });

// What is wrong with the temporary folder Chrome's profile goes in, as a
// sentence without its end, or "" when it is a folder this run can write:
// TMPDIR names a folder that is not there, a file, or one that cannot be
// written.
function tempProblem(tmp = os.tmpdir()) {
  const variable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  let stat;
  try {
    stat = fs.statSync(tmp);
  } catch {
    return `${variable} is ${tmp}, and there is no folder there`;
  }
  if (!stat.isDirectory()) return `${variable} is ${tmp}, which is a file, not a folder`;
  try {
    fs.accessSync(tmp, fs.constants.W_OK);
  } catch {
    return `${variable} is ${tmp}, a folder this run cannot write to`;
  }
  return "";
}

// Chrome makes a socket in a folder under TMPDIR, and the path of a socket
// can be only about 100 characters long, so a long TMPDIR stops Chrome at
// start. It gets a short one then.
function chromeTemp() {
  const tmp = os.tmpdir();
  if (process.platform === "win32" || tmp.length <= 60) return tmp;
  for (const dir of ["/tmp", "/var/tmp"]) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Not this one.
    }
  }
  return tmp;
}

// A profile, and the folder of the socket Chrome links from it, which a
// Chrome that was killed leaves behind.
function removeProfile(profile) {
  for (const link of ["SingletonSocket", "SingletonCookie"]) {
    try {
      const folder = path.dirname(fs.readlinkSync(path.join(profile, link)));
      if (/^(?:com\.google\.Chrome|org\.chromium\.Chromium|com\.microsoft\.Edge|com\.brave\.Browser)\.\w+$/.test(path.basename(folder))) fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      // No link: Chrome cleaned up after itself, or never got that far.
    }
  }
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// The processes of a Chrome that are still going: each one whose command
// line names its profile, as Chrome gives it to every helper it starts,
// and its crash handlers, whose database is in the profile, so they are
// found once the browser that started them is gone too. Chrome writes its
// command line over as one line, so it is searched as text: in /proc on
// Linux, from ps elsewhere.
function profileProcesses(profile) {
  const base = path.basename(profile);
  const holds = (command) => (command.includes("--user-data-dir=") || command.includes("--database=")) && command.includes(base);
  return commandLines()
    .filter(([, command]) => holds(command))
    .map(([pid]) => pid);
}

// Every process's command line but this one's, [pid, command], as text.
function commandLines() {
  const found = [];
  if (process.platform === "win32") return found;
  if (process.platform === "linux") {
    let names = [];
    try {
      names = fs.readdirSync("/proc");
    } catch {
      return found;
    }
    for (const name of names) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      try {
        found.push([Number(name), fs.readFileSync(`/proc/${name}/cmdline`, "latin1")]);
      } catch {
        // Gone while it was read.
      }
    }
    return found;
  }
  const r = spawnSync("ps", ["-A", "-ww", "-o", "pid=,command="], { encoding: "utf8", timeout: 5000 });
  for (const line of String(r.stdout || "").split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && Number(m[1]) !== process.pid) found.push([Number(m[1]), m[2]]);
  }
  return found;
}

// The profiles that runs killed outright (kill -9, or the system as
// memory ran out) left in the temporary folder, where they stay, since
// such a run cannot tidy up: each of this user's that no process names
// and that has not changed for a day goes as the next Chrome starts.
// Another user's stays, as the system would not let it go. On Windows,
// where no command lines are read, they stay.
const DAY = 24 * 3600 * 1000;
function clearOldProfiles(tmp = os.tmpdir(), now = Date.now()) {
  if (process.platform === "win32") return;
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return;
  }
  const old = names
    .filter((name) => /^easycaptionkit-chrome-\w{6}$/.test(name))
    .map((name) => path.join(tmp, name))
    .filter((dir) => {
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      return stat && stat.isDirectory() && now - stat.mtimeMs > DAY && (!process.getuid || stat.uid === process.getuid());
    });
  if (!old.length) return;
  const commands = commandLines().map(([, command]) => command);
  for (const dir of old) {
    if (commands.some((command) => command.includes(path.basename(dir)))) continue;
    try {
      removeProfile(dir);
    } catch {
      // Another user's, or gone already.
    }
  }
}

// Ends a Chrome and every helper it started. Chrome and the helpers it
// draws with run in the process group of the run, as the programs a run
// starts do, so that whatever keeps the run's group (makersmcp's
// supervisor does) keeps its Chrome too. Its crash handlers start a
// session of their own, and end once Chrome is gone. They are all found
// by its profile. A helper can start another as the first ones go, so
// they are looked for again.
function stopChrome(child, profile) {
  kill(child);
  for (let round = 0; round < 3; round++) {
    const left = profileProcesses(profile);
    if (!left.length) return;
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    }
    sleep(50);
  }
}

// Why Chrome stopped, from what it printed: its last FATAL line, else its
// last line that is not crashpad's noise about the machine.
function whyStopped(stderr, temp) {
  const lines = String(stderr).split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines.filter((l) => /:FATAL:/.test(l)).pop() || lines.filter((l) => !/crashpad/i.test(l)).pop() || "";
  const text = line.replace(/^\[[^\]]*\]\s*/, "");
  if (/Socket path too long/i.test(text)) return `the temporary folder's path is too long for Chrome's socket (${temp}); set TMPDIR to a shorter folder`;
  if (/No usable sandbox/i.test(text)) return `Chrome could not start its sandbox here (${text})`;
  return text;
}

// Starts the Chrome a run checked before any work (see chromeReady()),
// asking it first where it was not. A start the system refuses says what
// the system said, never its code alone.
async function launch({ width = 1920, height = 1080 } = {}) {
  let chrome;
  try {
    chrome = await chromeReady();
  } catch (err) {
    throw failed(err.message, { start: true });
  }
  const refused = (err) => failed(programs.startFailure(chrome, err, "Chrome").message, { start: true });
  const temp = chromeTemp();
  clearOldProfiles();
  // A profile Chrome cannot have is a Chrome that cannot start.
  let made;
  try {
    made = fs.mkdtempSync(path.join(os.tmpdir(), "easycaptionkit-chrome-"));
  } catch (err) {
    throw failed(tempProblem() || `Chrome's profile could not be made in ${os.tmpdir()}: ${err.message}`, { start: true });
  }
  const profile = trackFolder(made, removeProfile);
  const drop = () => {
    untrackFolder(profile);
    try {
      removeProfile(profile);
    } catch {
      // Left for the system's temp cleanup.
    }
  };
  const args = [
    "--headless=new", "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-sync", "--disable-default-apps", "--disable-background-networking",
    "--disable-component-update", "--disable-domain-reliability", "--disable-breakpad", "--metrics-recording-only",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--use-mock-keychain", "--password-store=basic", "--force-color-profile=srgb", "--font-render-hinting=none",
    "--allow-file-access-from-files",
    // Chrome's sandbox does not start as root; anyone else keeps it.
    ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
    ...(process.platform === "linux" ? ["--disable-dev-shm-usage"] : []),
    "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>",
    "--remote-debugging-pipe", `--user-data-dir=${profile}`, `--window-size=${width},${height}`, "about:blank",
  ];
  // A helper process left running writes into the profile after it is
  // removed: each stop ends them all. On Linux, Chrome keeps its crash
  // reports where its own config would be, not in the profile it is given,
  // and a dump of a crash would stay in the user's own Chrome folder for
  // good: that place is in the profile too, so they go with it. The
  // user's fontconfig stays where it is.
  let child;
  const stop = () => stopChrome(child, profile);
  try {
    child = track(spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: { ...process.env, TMPDIR: temp, CHROME_CONFIG_HOME: path.join(profile, "config") } }), stop);
  } catch (err) {
    drop();
    throw refused(err);
  }
  // Settles when Chrome is gone, whether it exited or never started.
  const gone = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  // With no file descriptor left for them Node makes no pipes, and says
  // why a moment later.
  if (!child.stdio || !child.stderr || !child.stdio[3] || !child.stdio[4]) {
    const err = await new Promise((resolve) => child.once("error", resolve));
    drop();
    throw refused(err);
  }
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-8000)));
  const told = new Promise((resolve) => child.stderr.once("close", resolve));
  const pending = new Map();
  const listeners = new Set();
  let id = 0;
  let buffer = Buffer.alloc(0);
  let dead = null;
  // Fails with Chrome's own error once Chrome is gone, so that a wait for
  // something Chrome would have sent, as a page's load, ends with it: once
  // Chrome is gone nothing else is left to keep the process going, and it
  // would end in the middle of the run, its code 0, with nothing said.
  let fall = () => {};
  const lost = new Promise((resolve, reject) => (fall = reject));
  lost.catch(() => {});
  // Whether Chrome has answered once: what stops it before that stops it
  // at the start.
  let answered = false;
  child.on("exit", async (code, signal) => {
    // What Chrome printed last can come in after it exits. The wait keeps
    // the process going, so the error is there for what waits on Chrome.
    let wait = null;
    await Promise.race([told, new Promise((resolve) => (wait = setTimeout(resolve, 500)))]);
    clearTimeout(wait);
    const why = whyStopped(stderr, temp);
    // SIGKILL is how the system stops a program when memory runs out, as
    // on a machine running many jobs, and such a program says nothing.
    const how = signal === "SIGKILL" ? "Chrome was stopped by SIGKILL, as the system stops a program when memory runs out" : `Chrome stopped (${signal ? `killed by ${signal}` : `exit ${code}`})${why ? `: ${why}` : ""}`;
    dead = failed(how, { start: !answered, signal });
    for (const waiting of pending.values()) waiting.reject(dead);
    pending.clear();
    fall(dead);
  });
  child.on("error", (err) => {
    dead = refused(err);
    for (const waiting of pending.values()) waiting.reject(dead);
    pending.clear();
    fall(dead);
  });
  child.stdio[4].on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(0)) >= 0) {
      const message = JSON.parse(buffer.subarray(0, end).toString("utf8"));
      buffer = buffer.subarray(end + 1);
      if (message.id && pending.has(message.id)) {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) waiting.reject(failed(message.error.message));
        else waiting.resolve(message.result || {});
      } else for (const listener of listeners) listener(message);
    }
  });
  child.stdio[3].on("error", () => {});
  // A call with no answer in `wait` ms, 60 s unless the call says, is an
  // error, not a hang.
  const send = (method, params = {}, sessionId, wait = 60_000) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const n = ++id;
      const timer = setTimeout(() => {
        if (pending.delete(n)) reject(failed(`Chrome did not answer ${method} within ${wait / 1000} s`, { start: !answered }));
      }, wait);
      timer.unref();
      pending.set(n, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      child.stdio[3].write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  try {
    await send("Browser.getVersion");
    answered = true;
  } catch (err) {
    stop();
    await gone;
    drop();
    throw err;
  }
  return {
    send,
    lost,
    on: (fn) => listeners.add(fn),
    off: (fn) => listeners.delete(fn),
    async page() {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      return { sessionId, targetId, call: (method, params, wait) => send(method, params, sessionId, wait) };
    },
    // Asks Chrome to quit, so it clears its own temp files, and kills it
    // when it does not within two seconds. The profile goes after.
    async close() {
      if (!dead) send("Browser.close").catch(() => {});
      const timer = setTimeout(stop, 2000);
      await gone;
      clearTimeout(timer);
      // A helper process still going would write into the profile.
      stop();
      drop();
    },
  };
}

// Runs an expression in a page and gives its value, waiting for a promise
// it gives: for `timeout` ms, which Chrome holds it to, and a moment more
// for Chrome's answer, where a call is otherwise given 60 s, so the fit of
// a hundred thousand words gets the two minutes it is given.
async function evaluate(page, expression, timeout = 30_000) {
  const r = await page.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout }, timeout + 10_000);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw failed(`the captions page failed: ${((d.exception && d.exception.description) || d.text || "error").split("\n")[0]}`);
  }
  return r.result ? r.result.value : undefined;
}

// Opens an HTML file in a page of the given size, with a see-through
// background when `transparent`, and waits for it to load, for 30 s at
// most, or until Chrome is gone, with Chrome's own error. The timer keeps
// the process going while it waits.
async function openPage(browser, file, { width, height, transparent = false }) {
  const page = await browser.page();
  await page.call("Page.enable");
  await page.call("Runtime.enable");
  await page.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  if (transparent) await page.call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  let timer = null;
  let on = null;
  const loaded = new Promise((resolve) => {
    on = (message) => {
      if (message.sessionId === page.sessionId && message.method === "Page.loadEventFired") resolve(true);
    };
    browser.on(on);
    timer = setTimeout(() => resolve(false), 30_000);
  });
  const { pathToFileURL } = require("node:url");
  try {
    await page.call("Page.navigate", { url: pathToFileURL(file).href });
    if (!(await Promise.race([loaded, browser.lost]))) throw failed("the captions page did not load within 30 s");
  } finally {
    clearTimeout(timer);
    browser.off(on);
  }
  return page;
}

module.exports = { CHROME, findChrome, chromeReady, chromeProblem, tempProblem, launch, evaluate, openPage, whyStopped, chromeTemp, clearOldProfiles };
