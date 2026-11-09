"use strict";

// Media and word files for the tests, made on the spot: videos and sound
// from ffmpeg's own sources (testsrc2, color, sine, anoisesrc), word files
// in each speech-to-text shape, and a font kit folder like easyfontkit's
// with the OFL Inter fixture. Everything goes into one temporary folder.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easycaptionkit-test-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));

const CLI = path.resolve(__dirname, "../skills/easycaptionkit/scripts/easycaptionkit.js");
const FIXTURES = path.join(__dirname, "fixtures");

function has(name) {
  return spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
}
const hasFfmpeg = has("ffmpeg") && has("ffprobe");

// -fps_mode came in ffmpeg 5.1, in the place of -vsync, which Ubuntu
// 22.04's 4.4 has: the kit picks one as this does.
const FPS_MODE = hasFfmpeg && /-fps_mode/.test(spawnSync("ffmpeg", ["-hide_banner", "-h", "full"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout || "");
const fpsMode = (mode) => (FPS_MODE ? ["-fps_mode", mode] : ["-vsync", mode]);

function ffmpeg(args) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args], { encoding: "utf8", timeout: 300_000 });
  if (run.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed: ${run.stderr}`);
}

// A test video: testsrc2 at the size and rate asked, with a tone (or
// silence, or none) at the rate and channels asked.
// options: { width, height, fps, seconds, rate, channels, sound: "tone" |
// "silence" | "none", codec, rotate, sar, name }
function video(options = {}) {
  const o = { width: 1080, height: 1920, fps: 30, seconds: 6, rate: 48000, channels: 2, sound: "tone", ...options };
  const file = path.join(dir, o.name || `v-${o.width}x${o.height}-${String(o.fps).replace("/", "_")}-${o.seconds}-${o.sound}-${o.rate}-${o.channels}${o.codec ? `-${o.codec}` : ""}${o.rotate ? `-r${o.rotate}` : ""}${o.sar ? "-sar" : ""}.${o.width % 2 || o.height % 2 ? "mkv" : "mp4"}`);
  if (fs.existsSync(file)) return file;
  // testsrc2 draws even sizes only; an odd one is scaled to after it.
  const odd = o.width % 2 || o.height % 2;
  const args = ["-f", "lavfi", "-i", `testsrc2=s=${o.width + (o.width % 2)}x${o.height + (o.height % 2)}:r=${o.fps}:d=${o.seconds}`];
  if (o.sound === "tone") args.push("-f", "lavfi", "-i", `sine=f=440:d=${o.seconds}:sample_rate=${o.rate}`);
  if (o.sound === "silence") args.push("-f", "lavfi", "-i", `anullsrc=r=${o.rate}:cl=${o.channels === 1 ? "mono" : "stereo"}:d=${o.seconds}`);
  if (o.sar) args.push("-vf", `setsar=${o.sar}`);
  if (odd) args.push("-vf", `format=yuv444p,scale=${o.width}:${o.height}`);
  // An odd size cannot be H.264 in 4:2:0; FFV1 in Matroska takes any size.
  if (o.width % 2 || o.height % 2) args.push("-c:v", "ffv1", "-pix_fmt", "yuv444p");
  else args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast");
  if (o.sound !== "none") args.push("-ac", String(o.channels), "-c:a", o.codec || "aac", "-shortest");
  const raw = o.rotate ? file.replace(/\.(\w+)$/, ".raw.$1") : file;
  ffmpeg([...args, raw]);
  if (o.rotate) {
    // ffmpeg 7 and newer set the display matrix with -display_rotation;
    // older ones with the rotate tag.
    try {
      ffmpeg(["-display_rotation:v:0", String(o.rotate), "-i", raw, "-c", "copy", file]);
    } catch {
      ffmpeg(["-i", raw, "-c", "copy", "-metadata:s:v:0", `rotate=${(360 - o.rotate) % 360}`, file]);
    }
    fs.rmSync(raw, { force: true });
  }
  return file;
}

// A variable frame rate video: frames kept at uneven times, as a phone
// writes them.
function vfrVideo() {
  const file = path.join(dir, "vfr.mp4");
  if (fs.existsSync(file)) return file;
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=60:d=6", "-f", "lavfi", "-i", "sine=f=300:d=6", "-vf", "select='not(mod(n,3))+not(mod(n,7))'", ...fpsMode("vfr"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", file]);
  return file;
}

// A variable frame rate video whose frames sit on no grid at all: 30 fps
// with each frame up to 9 ms early or late, in a 1/90000 time base.
function jitterVideo() {
  const file = path.join(dir, "jitter.mp4");
  if (fs.existsSync(file)) return file;
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x568:r=30:d=3", "-f", "lavfi", "-i", "sine=f=330:d=3", "-vf", "settb=1/90000,setpts=(N/30+0.009*sin(N*1.3))/TB", ...fpsMode("passthrough"), "-enc_time_base:v", "1:90000", "-video_track_timescale", "90000", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", file]);
  return file;
}

// Each frame's time in a video: its best effort time, which ffprobe 4.4
// gives under that name too, where it has no pts_time for a frame. 4.4
// also writes an empty line for the side data of a frame, which is no
// frame.
function frameTimes(file) {
  return spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim().split("\n").filter((line) => line.trim()).map((line) => parseFloat(line));
}

function probe(file) {
  const run = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-count_frames", file], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout);
}

// The md5 of a file's first sound stream packets, to tell a copy from a
// re-encode.
function audioMd5(file) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-map", "0:a:0", "-c", "copy", "-f", "md5", "-"], { encoding: "utf8" });
  return run.stdout.trim();
}

// The RGB pixels of a region of one frame (the frame shown at t).
function region(file, t, { x, y, w, h }) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", t.toFixed(4), "-i", file, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"], { maxBuffer: 64 * 1024 * 1024 });
  return run.stdout;
}

// The frames of a video, one at a time, as count of pixels near a color
// inside a region; for finding when a caption state starts.
function colorFrames(file, { x, y, w, h }, [r, g, b], tolerance = 60) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-vf", `crop=${w}:${h}:${x}:${y},format=rgb24`, ...fpsMode("passthrough"), "-f", "rawvideo", "-"], { maxBuffer: 1024 * 1024 * 1024 });
  const size = w * h * 3;
  const counts = [];
  for (let at = 0; at + size <= run.stdout.length; at += size) {
    let n = 0;
    for (let i = at; i < at + size; i += 3) if (Math.abs(run.stdout[i] - r) + Math.abs(run.stdout[i + 1] - g) + Math.abs(run.stdout[i + 2] - b) < tolerance) n++;
    counts.push(n);
  }
  return counts;
}

function write(name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return file;
}

// A font kit like easyfontkit's: fonts.css, fonts.json and files/, with
// Inter's latin cut under the family name asked, and the license asked.
function fontKit(name, { family = "Inter", status = "open" } = {}) {
  const folder = path.join(dir, name);
  fs.mkdirSync(path.join(folder, "files"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "inter-latin-400.woff2"), path.join(folder, "files", "inter-latin-400.woff2"));
  fs.writeFileSync(
    path.join(folder, "fonts.css"),
    `/* Fonts of example.com, read by easyfontkit 0.1.1. */\n\n@font-face {\n  font-family: "${family}";\n  src: url("files/inter-latin-400.woff2") format("woff2");\n  font-weight: 400;\n  font-style: normal;\n  font-display: swap;\n}\n\n:root {\n  --font-heading: "${family}", sans-serif;\n  --font-heading-free: "Inter", sans-serif;\n  --font-body: "${family}", sans-serif;\n}\n`,
  );
  const license =
    status === "open"
      ? { status: "open", name: "SIL Open Font License", url: "https://openfontlicense.org", maker: "", basis: "the font file names the SIL Open Font License", copyright: "Copyright (c) 2016 The Inter Project Authors" }
      : { status: "commercial", name: "", url: "https://example.com/eula", maker: "Example Type", basis: "the file sells or restricts itself", copyright: "Copyright Example Type" };
  fs.writeFileSync(
    path.join(folder, "fonts.json"),
    JSON.stringify({ version: 1, url: "https://example.com/", generator: "easyfontkit 0.1.1", roles: { heading: { family, key: "f" } }, families: [{ key: "f", name: family, cssNames: [family], host: "example.com", license, free: status === "open" ? [] : [{ family: "Inter", from: "Google Fonts", license: "OFL-1.1" }] }] }, null, 2),
  );
  return folder;
}

// A brand kit like easybrandkit's.
function brandKit(name, colors) {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "brand.json"), JSON.stringify({ version: 1, url: "https://example.com/", name: "Example", generator: "easybrandkit 0.4.0", colors, fonts: { heading: "Inter", body: "Inter" } }, null, 2));
  return folder;
}

// Words spoken at even times: `text` split at spaces, from `start`, each
// word `each` seconds with `gap` between.
function evenWords(text, { start = 0.5, each = 0.4, gap = 0.1 } = {}) {
  return text.split(" ").map((word, i) => ({ word, start: +(start + i * (each + gap)).toFixed(3), end: +(start + i * (each + gap) + each).toFixed(3) }));
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 600_000, ...options });
}

module.exports = { dir, CLI, FIXTURES, hasFfmpeg, fpsMode, ffmpeg, video, vfrVideo, jitterVideo, frameTimes, probe, audioMd5, region, colorFrames, write, fontKit, brandKit, evenWords, run };
