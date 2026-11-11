"use strict";

// Whole runs on videos ffmpeg makes here: the captions land on the frames
// their words start on, the result keeps the video's frames, length and
// sound, odd videos come out right, a failed run leaves the folder as it
// was, and the libass and subtitles paths work too.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { readWords } = require("../skills/easycaptionkit/scripts/lib/words");
const { findChrome } = require("../skills/easycaptionkit/scripts/lib/chrome");
const { inkOf } = require("../skills/easycaptionkit/scripts/lib/places");
const h = require("./helpers");

// Chrome found the way the kit finds it.
const skip = (!h.hasFfmpeg && "needs ffmpeg") || (!findChrome() && "needs Chrome");
const hasFontconfig = process.platform === "linux" && spawnSync("fc-list", ["--version"], { stdio: "ignore" }).status === 0;
const out = (name) => path.join(h.dir, name);
const files = (folder) => fs.readdirSync(folder).sort();

function caption(args, options = {}) {
  const r = h.run([...args, "--json"], options);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

function blackVideo(name, { width = 1080, height = 1920, fps = 30, seconds = 4 } = {}) {
  const file = out(name);
  if (!fs.existsSync(file)) h.ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=${fps}:d=${seconds}`, "-f", "lavfi", "-i", `sine=f=500:d=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file]);
  return file;
}

// For each frame of a captioned video, in the band the captions take: how
// many pixels are green (the lit word), where they are, and how many white.
function litFrames(file, band, width = 1080) {
  // Every frame as it is: a variable frame rate is not filled up to a steady one.
  const run = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${width}:${band.height}:0:${band.y},format=rgb24`, ...h.fpsMode("passthrough"), "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const size = width * band.height * 3;
  const frames = [];
  for (let at = 0; at + size <= run.stdout.length; at += size) {
    let green = 0;
    let x = 0;
    let white = 0;
    for (let i = at; i < at + size; i += 3) {
      const [r, g, b] = [run.stdout[i], run.stdout[i + 1], run.stdout[i + 2]];
      if (g > 180 && r < 90 && b < 90) {
        green++;
        x += ((i - at) / 3) % width;
      }
      if (r > 200 && g > 200 && b > 200) white++;
    }
    frames.push({ green, x: green ? x / green : -1, white });
  }
  return frames;
}

test("each caption state starts on the frame its word starts on, and captions.json names that frame", { skip }, () => {
  const video = blackVideo("black-30.mp4");
  const words = h.write("timed.json", { task: "transcribe", words: [{ word: "one", start: 1.0, end: 1.4 }, { word: "two", start: 1.5, end: 1.9 }, { word: "three", start: 2.0, end: 2.4 }] });
  const c = caption([video, "--words", words, "--highlight", "#00ff00", "--out", out("timing")]);
  const band = c.layout.band;
  const file = path.join(out("timing"), "captioned.mp4");
  const frames = litFrames(file, band);
  // A time inside a frame shows from the next frame, and captions.json says so.
  const late = caption([video, "--words", h.write("timed-late.json", { task: "transcribe", words: [{ word: "one", start: 1.01, end: 1.4 }, { word: "two", start: 1.51, end: 1.9 }, { word: "three", start: 2.02, end: 2.4 }] }), "--highlight", "#00ff00", "--out", out("timing-late")]);
  assert.equal(late.cues[0].startFrame, 31);
  assert.deepEqual(late.cues[0].words.map((w) => w.frame), [31, 46, 61]);
  const seen = litFrames(path.join(out("timing-late"), "captioned.mp4"), late.layout.band);
  assert.equal(seen.findIndex((f) => f.white > 0 || f.green > 0), 31);
  const at = seen.map((f) => Math.round(f.x / 40));
  assert.ok(at[45] !== at[46] && at[60] !== at[61], `the lit word moves at frames 46 and 61: ${at.slice(42, 64).join(",")}`);
  // Nothing before frame 30 (1.0 s), "one" lit from 30, "two" from 45, "three" from 60, gone from 84.
  const shown = frames.map((f) => f.white > 0 || f.green > 0);
  assert.equal(shown.indexOf(true), 30);
  assert.equal(shown.lastIndexOf(true), 83);
  const lit = frames.map((f) => Math.round(f.x / 40));
  assert.ok(lit[44] !== lit[45] && lit[45] === lit[59] && lit[59] !== lit[60], `the lit word moves at frames 45 and 60: ${lit.slice(40, 64).join(",")}`);
  assert.ok(frames[31].x < frames[46].x && frames[46].x < frames[61].x, "left to right");
  assert.deepEqual([c.cues[0].startFrame, c.cues[0].endFrame], [30, 84]);
  const srt = readWords(path.join(out("timing"), "captions.srt"));
  assert.equal(srt.words[0].start, 1);
});

test("on a variable frame rate and in a millisecond time base, captions.json names the frame that shows each change, and the rate the frames keep", { skip }, () => {
  // Frames dropped unevenly from 60 fps.
  const vfr = out("black-vfr.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=360x640:r=60:d=4", "-f", "lavfi", "-i", "sine=d=4", "-vf", "select='not(mod(n,3))+not(mod(n,7))'", ...h.fpsMode("vfr"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", vfr]);
  const words = h.write("vfr-timed.json", { task: "transcribe", words: [{ word: "one", start: 1.01, end: 1.4 }, { word: "two", start: 1.51, end: 1.9 }, { word: "three", start: 2.02, end: 2.4 }] });
  const c = caption([vfr, "--words", words, "--highlight", "#00ff00", "--out", out("vfr-frames")]);
  const file = path.join(out("vfr-frames"), "captioned.mp4");
  const times = h.frameTimes(file);
  const firstAt = (t) => times.findIndex((p) => p >= Math.round(t * 1000) / 1000 - 1e-6);
  const named = c.cues[0].words.map((w) => w.frame);
  assert.deepEqual(named, [1.01, 1.51, 2.02].map(firstAt));
  assert.equal(c.output.frames, times.length);
  assert.ok(c.notes.some((n) => /frame rate varies/.test(n)), c.notes.join(" | "));
  // The video shows the caption from the frame named, and the lit word moves on the frames named.
  const seen = litFrames(file, c.layout.band, 360);
  assert.equal(seen.findIndex((f) => f.white > 0 || f.green > 0), c.cues[0].startFrame);
  const at = seen.map((f) => Math.round(f.x / 20));
  for (const f of named.slice(1)) assert.ok(at[f - 1] !== at[f], `the lit word moves at frame ${f}: ${at.slice(f - 3, f + 3).join(",")}`);
  // 24 fps in a Matroska file's millisecond time base: frames a millisecond off the grid.
  const mkv = out("ms-24.mkv");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=24:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", mkv]);
  const m = caption([mkv, "--words", h.write("ms-timed.json", { words: [{ word: "Early.", start: 1.0418, end: 1.6 }, { word: "Late.", start: 2.0418, end: 2.6 }] }), "--style", "line", "--out", out("ms-frames")]);
  assert.equal(m.output.fps, 24);
  const msTimes = h.frameTimes(path.join(out("ms-frames"), "captioned.mp4"));
  const msFirst = (t) => msTimes.findIndex((p) => p >= Math.round(t * 1000) / 1000 - 1e-6);
  assert.deepEqual(m.cues.map((cue) => cue.startFrame), [msFirst(1.0418), msFirst(2.0418)]);
});

test("in a time base as coarse as a frame, as an MP4 whose timescale is its frame rate has, or a video given frames at a steady rate, each change shows from the first frame at or after its time, the frame captions.json names, not the nearest", { skip }, () => {
  // An MP4 whose timescale is 30, and a video that holds a frame from 0.5 s to 2.5 s, which is given frames at 30 fps.
  const coarse = out("timescale-30.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=3", "-f", "lavfi", "-i", "sine=d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-video_track_timescale", "30", "-c:a", "aac", "-shortest", coarse]);
  assert.equal(h.probe(coarse).streams.find((s) => s.codec_type === "video").time_base, "1/30");
  const held = out("held-1-to-2.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=4", "-f", "lavfi", "-i", "sine=d=4", "-vf", "select='lt(t,0.5)+gte(t,2.5)'", ...h.fpsMode("vfr"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", held]);
  // Each word a few milliseconds after a frame: the frame after it shows it, not the one before, which is nearer.
  const words = h.write("after-a-frame.json", { words: [{ word: "one", start: 0.84, end: 1.2 }, { word: "two", start: 1.21, end: 1.5 }, { word: "three", start: 1.505, end: 2 }] });
  for (const [video, name] of [[coarse, "timescale-30"], [held, "held-filled"]]) {
    const c = caption([video, "--words", words, "--highlight", "#00ff00", "--out", out(`coarse-${name}`)]);
    assert.equal(c.output.fps, 30, name);
    const named = c.cues[0].words.map((w) => w.frame);
    assert.deepEqual(named, [26, 37, 46], name);
    const frames = litFrames(path.join(out(`coarse-${name}`), "captioned.mp4"), c.layout.band, 360);
    assert.equal(frames.findIndex((f) => f.green > 0), 26, `${name}: the first lit frame`);
    const at = frames.map((f) => Math.round(f.x / 20));
    for (const f of named.slice(1)) assert.ok(at[f - 2] === at[f - 1] && at[f - 1] !== at[f], `${name}: the lit word moves at frame ${f}: ${at.slice(f - 3, f + 2).join(",")}`);
  }
});

test("a video that holds a frame for seconds, as a screen recording that writes one only when the picture changes, is written at a steady rate, so every caption and every lit word shows on frames of its own", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  // Frames from 0 to 1.47 s, one at 5 s, then from 8 s on.
  const sparse = out("sparse.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=10", "-f", "lavfi", "-i", "sine=d=10", "-vf", "select='lt(t,1.5)+gte(t,8)+eq(n,150)'", ...h.fpsMode("vfr"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", sparse]);
  assert.equal(h.frameTimes(sparse).length, 106);
  const words = h.write("sparse.json", { words: h.evenWords("the screen holds still here while the voice goes on so these words fall between two frames then the picture moves again", { start: 0.2, each: 0.3, gap: 0.12 }) });
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  for (const style of ["line", "karaoke"]) {
    const c = caption([sparse, "--words", words, "--libass", "--style", style, "--lines", "1", "--max-chars", "14", "--out", out(`sparse-${style}`)], env);
    assert.ok(c.cues.length > 5);
    for (const cue of c.cues) assert.ok(cue.endFrame > cue.startFrame, `${style}: caption ${cue.n} (${cue.start} to ${cue.end} s) is on frames ${cue.startFrame} to ${cue.endFrame}`);
    if (style === "karaoke") {
      const lit = c.cues.flatMap((cue) => cue.words.map((w) => w.frame));
      assert.equal(new Set(lit).size, lit.length, "every lit word has a frame of its own");
    }
    assert.equal(c.output.fps, 30);
    assert.equal(c.output.frames, 300);
    assert.ok(c.notes.some((n) => /^The captions show on the video's own frames, and the video holds some frames for up to 3\.5\d s, as a recording that writes a frame only when the picture changes does, so \d+ captions would have shown late or on no frame\. captioned\.mp4 is written at 30 fps instead, each frame repeated until the next comes, so every caption shows at its time\.$/.test(n)), c.notes.join(" | "));
    assert.ok(!c.notes.some((n) => /frame rate varies|on no frame of captioned/.test(n)), c.notes.join(" | "));
  }
  // A video whose frames come evenly keeps its own.
  const even = caption([h.video({ width: 360, height: 640, seconds: 2 }), "--words", h.write("even.json", { words: h.evenWords("every frame its own", { start: 0.2 }) }), "--libass", "--out", out("even-frames")], env);
  assert.ok(!even.notes.some((n) => /steady rate|written at \d+ fps instead/.test(n)), even.notes.join(" | "));
});

test("a still picture over a podcast's sound at a frame a second is written at 24 fps, so every lit word shows on frames of its own, and a caption shorter than a frame is named and not said to show", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const still = out("still-1fps.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=navy:s=360x640:r=1:d=8", "-f", "lavfi", "-i", "sine=d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", still]);
  assert.equal(h.frameTimes(still).length, 8);
  const words = h.write("podcast-words.json", { words: h.evenWords("welcome back to the show where we talk about the week and the people who made it", { start: 0.4, each: 0.26, gap: 0.04 }) });
  const c = caption([still, "--words", words, "--libass", "--out", out("still-1fps")], env);
  assert.equal(c.output.fps, 24);
  const lit = c.cues.flatMap((cue) => cue.words.map((w) => w.frame));
  assert.equal(new Set(lit).size, lit.length, "every lit word has a frame of its own");
  for (const cue of c.cues) assert.ok(cue.startFrame / 24 - cue.start < 1 / 24 + 0.011, `caption ${cue.n} starts at ${cue.start} s and shows from frame ${cue.startFrame}`);
  assert.ok(c.notes.some((n) => /^The captions show on the video's own frames, and the video has 1 frame a second, so \d+ captions would have shown late or on no frame\. captioned\.mp4 is written at 24 fps instead, each frame repeated until the next comes, so every caption shows at its time\.$/.test(n)), c.notes.join(" | "));
  // A caption up for two hundredths of a second between two frames shows on none, even at 24 fps.
  const blink = h.write("blink-words.json", { words: [{ word: "One", start: 0.4, end: 0.9 }, { word: "Blinking", start: 2.01, end: 2.02 }, { word: "Tomorrow", start: 2.03, end: 2.6 }] });
  const b = caption([still, "--words", blink, "--libass", "--style", "line", "--lines", "1", "--max-chars", "8", "--out", out("still-1fps-blink")], env);
  const unseen = b.cues.filter((cue) => cue.endFrame <= cue.startFrame).map((cue) => cue.n);
  assert.deepEqual(unseen, [2]);
  assert.ok(b.notes.some((n) => /^The captions show on the video's own frames, and the video has 1 frame a second, .* captioned\.mp4 is written at 24 fps instead, each frame repeated until the next comes\.$/.test(n)), b.notes.join(" | "));
  assert.ok(b.notes.includes("Caption 2 shows on no frame of captioned.mp4, which has no frame while it is up. It is in captions.srt, captions.vtt and captions.ass."), b.notes.join(" | "));
});

test("a caption that comes or goes inside the last frame of a video at a steady rate needs no frames the video does not have, and a video of few frames a second gets a usual rate", () => {
  const { fillFor, steadyRate } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const times = Array.from({ length: 60 }, (_, i) => i / 30);
  const v = { times, fps: 30, baseRate: "30/1", duration: 2, picture: { start: 0, end: 2, last: times.at(-1) } };
  assert.equal(fillFor(v, [{ cue: 1, from: 0.5, to: 1.99 }]), null);
  // Its last frame held for 2 s: a caption that goes in it is late.
  const held = { ...v, duration: 4, picture: { start: 0, end: 4, last: times.at(-1) } };
  assert.equal(fillFor(held, [{ cue: 1, from: 0.5, to: 3 }]).held.toFixed(2), "2.03");
  const steady = (fps, base) => steadyRate({ times: Array.from({ length: 40 }, (_, i) => i / fps), fps, baseRate: base }).rate;
  assert.deepEqual([[1, "1/1"], [2, "2/1"], [5, "5/1"], [10, "10/1"], [12, "12/1"], [15, "15/1"], [20, "20/1"]].map(([fps, base]) => steady(fps, base)), ["24", "24", "25", "30", "24", "30", "24"]);
  assert.deepEqual([[24000 / 1001, "24000/1001"], [25, "25/1"], [30, "30/1"], [60, "60/1"], [120, "120/1"]].map(([fps, base]) => steady(fps, base)), ["24000/1001", "25/1", "30/1", "60/1", "60"]);
});

test("sheet.png takes each caption's frame from the frames that show it, nearest the middle of its words, and seeks a moment before that frame", () => {
  const { shotOf, momentOf } = require("../skills/easycaptionkit/scripts/lib/draw");
  // Frames from 0 to 1.47 s, one at 5 s, then from 8 s on, at 30 fps.
  const times = [...Array.from({ length: 45 }, (_, i) => i / 30), 5, ...Array.from({ length: 60 }, (_, i) => 8 + i / 30)];
  const cue = (start, end) => ({ start, end, spoken: end });
  // A caption in the stretch with no frame but the one at 5 s is shown by that frame.
  assert.deepEqual(shotOf(cue(3.9, 5.7), times), { seek: 4.9995, time: 5 });
  // One no frame shows: the frame on screen at its moment, which the note names.
  assert.equal(shotOf(cue(1.8, 3.8), times).time, 44 / 30);
  // Frames all through: the one nearest the middle of its words.
  const near = shotOf(cue(8.2, 9), times);
  assert.ok(Math.abs(near.time - momentOf(cue(8.2, 9))) <= 1 / 60 + 1e-9, String(near.time));
  assert.ok(near.time >= 8.2 && near.time < 9);
  // Without the frames' times, the moment.
  assert.deepEqual(shotOf(cue(8.2, 9)), { seek: momentOf(cue(8.2, 9)), time: momentOf(cue(8.2, 9)) });
});

test("a picture that starts after its sound, or ends before it, is captioned for as long as the sound runs, its first frame shown from the start and its last until the end", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const words = h.write("both-ends.json", { words: h.evenWords("we start before the picture and we go on after it ends until the very end", { start: 0.3, each: 0.3, gap: 0.1 }) });
  // Matroska keeps each stream's length in a DURATION tag: a 4 s picture and 7 s of sound, a whole file.
  const longer = out("longer-sound.mkv");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=4", "-f", "lavfi", "-i", "sine=d=7", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", longer]);
  const subs = caption(["subtitles", words, "--video", longer, "--style", "line", "--out", out("longer-sound-subs")]);
  assert.ok(Math.abs(subs.video.duration - 7) < 0.1, String(subs.video.duration));
  assert.ok(subs.cues.at(-1).end > 6.5, String(subs.cues.at(-1).end));
  assert.ok(!subs.notes.some((n) => /cut short|left out|belong to this video/.test(n)), subs.notes.join(" | "));
  assert.ok(subs.notes.some((n) => /^The video's picture ends at 4\.0\d s, and its sound runs on to 7\.0\d s\. The captions go on to the end of the sound, over the last frame, which players hold\.$/.test(n)), subs.notes.join(" | "));
  const held = caption([longer, "--words", words, "--libass", "--style", "line", "--out", out("longer-sound")], env);
  assert.ok(Math.abs(held.output.duration - 7) < 0.1, String(held.output.duration));
  for (const cue of held.cues) assert.ok(cue.endFrame > cue.startFrame, `caption ${cue.n} is on frames ${cue.startFrame} to ${cue.endFrame}`);
  assert.ok(held.notes.some((n) => /its picture ends at 4\.0\d s while its sound runs on to 7\.0\d s, .* each frame repeated until the next comes and the last until the sound ends, so every caption shows at its time\.$/.test(n)), held.notes.join(" | "));
  // A picture that starts 2 s after its sound, as an MP4 keeps it with an edit list: copied
  // in, since ffmpeg 4.4 fills the start of a picture it encodes with its first frame.
  const picture = out("late-picture-only.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", picture]);
  const late = out("late-picture.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "sine=d=7", "-itsoffset", "2", "-i", picture, "-map", "1:v", "-map", "0:a", "-c:v", "copy", "-c:a", "aac", late]);
  const early = caption([late, "--words", words, "--libass", "--style", "line", "--out", out("late-picture")], env);
  assert.ok(Math.abs(early.video.duration - 7) < 0.1, String(early.video.duration));
  assert.ok(early.cues.at(-1).end > 6.5, String(early.cues.at(-1).end));
  assert.equal(early.cues[0].startFrame, Math.round(early.cues[0].start * 30));
  for (const cue of early.cues) assert.ok(cue.endFrame > cue.startFrame, `caption ${cue.n} is on frames ${cue.startFrame} to ${cue.endFrame}`);
  assert.ok(early.notes.some((n) => /its picture starts at 2\.0\d s, after its sound, .* its first frame shown from the start and each frame repeated until the next comes/.test(n)), early.notes.join(" | "));
  // A 6 s picture and 9 s of sound cut at 2.5 s without encoding again: its edit list discards
  // the frames from the keyframe at 0, and the picture of captioned.mp4 ends with its sound.
  const gop = out("gop-long-sound.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=6", "-f", "lavfi", "-i", "sine=d=9", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-g", "150", "-keyint_min", "150", "-sc_threshold", "0", "-c:a", "aac", gop]);
  const trimmed = out("gop-long-sound-cut.mp4");
  h.ffmpeg(["-ss", "2.5", "-i", gop, "-c", "copy", trimmed]);
  const cut = caption([trimmed, "--words", words, "--libass", "--style", "line", "--out", out("gop-long-sound-cut")], env);
  assert.ok(Math.abs(cut.video.duration - 6.5) < 0.05, String(cut.video.duration));
  const streams = h.probe(path.join(out("gop-long-sound-cut"), "captioned.mp4")).streams;
  const length = (type) => Number(streams.find((s) => s.codec_type === type).duration);
  assert.ok(Math.abs(length("video") - length("audio")) < 0.1, `picture ${length("video")} s, sound ${length("audio")} s`);
});

test("a caption that runs to the end of the video is still there on the last frame", { skip }, () => {
  const video = blackVideo("black-25.mp4", { width: 640, height: 360, fps: 25, seconds: 2 });
  const words = h.write("to-the-end.json", { words: [{ word: "Until", start: 1.0, end: 1.4 }, { word: "the", start: 1.4, end: 1.6 }, { word: "end.", start: 1.6, end: 1.98 }] });
  const c = caption([video, "--words", words, "--style", "line", "--out", out("to-the-end")]);
  assert.equal(c.cues.at(-1).end, 2);
  const file = path.join(out("to-the-end"), "captioned.mp4");
  const band = c.layout.band;
  const last = h.region(file, 1.96, { x: 0, y: band.y, w: 640, h: band.height });
  let white = 0;
  for (let i = 0; i < last.length; i += 3) if (last[i] > 220 && last[i + 1] > 220 && last[i + 2] > 220) white++;
  assert.ok(white > 100, `${white} white pixels on the last frame`);
  assert.equal(h.probe(file).streams.find((s) => s.codec_type === "video").nb_read_frames, "50");
});

test("a launch-film timeline next to the film is written with the run's umask, as every other file of the run is, not with the mode of the file it comes from", { skip: skip || (process.platform === "win32" && "needs a umask") }, () => {
  const folder = out("umask-film");
  fs.mkdirSync(folder, { recursive: true });
  const film = path.join(folder, "film.mp4");
  fs.copyFileSync(blackVideo("black-umask.mp4", { width: 360, height: 640, seconds: 2 }), film);
  const timeline = path.join(folder, "film.timeline.json");
  fs.writeFileSync(timeline, JSON.stringify({ cuts: [1] }));
  fs.chmodSync(timeline, 0o664);
  const words = h.write("umask-words.json", { words: h.evenWords("a film with its cuts", { start: 0.2 }) });
  const r = spawnSync("sh", ["-c", 'umask 077 && exec "$0" "$@"', process.execPath, h.CLI, film, "--words", words, "--style", "line", "--out", path.join(folder, "out")], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, r.stderr);
  const mode = (name) => fs.statSync(path.join(folder, "out", name)).mode & 0o777;
  assert.equal(fs.readFileSync(path.join(folder, "out", "captioned.timeline.json"), "utf8"), fs.readFileSync(timeline, "utf8"));
  for (const name of ["captioned.timeline.json", "captioned.mp4", "CAPTIONS.md", "words.json"]) assert.equal(mode(name).toString(8), "600", name);
});

test("a file by a launch-film timeline's name far bigger than one is passed over, and said, where the run read it whole after the encode and a file past 2 GiB ended it with Node's error and no video", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const folder = out("big-timeline");
  fs.mkdirSync(folder, { recursive: true });
  const film = path.join(folder, "film.mp4");
  fs.copyFileSync(blackVideo("black-big-timeline.mp4", { width: 360, height: 640, seconds: 2 }), film);
  // 2.5 GiB, a sparse file that takes no room, where the disk keeps one so; else 5 MB.
  const timeline = path.join(folder, "film.timeline.json");
  fs.writeFileSync(timeline, "");
  fs.truncateSync(timeline, process.platform === "win32" ? 5 * 2 ** 20 : 2.5 * 2 ** 30);
  const words = h.write("big-timeline-words.json", { words: h.evenWords("a film and a big file", { start: 0.2 }) });
  const c = caption([film, "--words", words, "--libass", "--out", path.join(folder, "out")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
  assert.equal(fs.existsSync(path.join(folder, "out", "captioned.timeline.json")), false);
  assert.ok(fs.statSync(path.join(folder, "out", "captioned.mp4")).size > 0);
  assert.ok(c.notes.includes(`film.timeline.json, next to the video, is ${process.platform === "win32" ? "5.0 MB" : "2.5 GB"}, far more than a launch-film timeline holds, so it was not copied as captioned.timeline.json.`), c.notes.join(" | "));
  fs.rmSync(timeline, { force: true });
});

test("a video cut short after its header is captioned as far as its frames go, with the sheet's frames in it", { skip }, () => {
  const whole = out("whole-for-cut.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-movflags", "+faststart", whole]);
  const cut = out("cut-for-caption.mp4");
  fs.writeFileSync(cut, fs.readFileSync(whole).subarray(0, Math.round(fs.statSync(whole).size * 0.45)));
  const words = h.write("cut-words.json", { words: h.evenWords("words all through the video, past where the file was cut short and on to the end", { start: 0.2, each: 0.35, gap: 0.1 }) });
  const c = caption([cut, "--words", words, "--style", "line", "--out", out("cut-caption")]);
  assert.ok(c.video.duration < 6, String(c.video.duration));
  assert.ok(c.notes.some((n) => /^The video says it is 8\.00 s long, and its frames end at /.test(n)), c.notes.join(" | "));
  for (const name of ["captioned.mp4", "sheet.png", "safe-zones.png"]) assert.ok(fs.statSync(path.join(out("cut-caption"), name)).size > 0, name);
});

test("the captioned video keeps the frames, the length and the sound of the one given", { skip }, () => {
  const video = h.video({ width: 1080, height: 1920, fps: 30, seconds: 5, rate: 48000, channels: 2 });
  const words = h.write("five.json", { task: "transcribe", words: h.evenWords("Launch week is here and this one goes out with captions people can read", { start: 0.3, each: 0.24, gap: 0.06 }) });
  const fonts = h.fontKit("fonts-e2e");
  const brand = h.brandKit("brand-e2e", [{ hex: "#1a6b45", role: "logo" }]);
  const folder = out("keep");
  const c = caption([video, "--words", words, "--fonts", fonts, "--brand", brand, "--out", folder]);
  assert.deepEqual(files(folder), ["CAPTIONS.md", "captioned.mp4", "captions.ass", "captions.json", "captions.srt", "captions.vtt", "safe-zones.png", "sheet.png", "words.json"]);
  const before = h.probe(video);
  const after = h.probe(path.join(folder, "captioned.mp4"));
  const v0 = before.streams.find((s) => s.codec_type === "video");
  const v1 = after.streams.find((s) => s.codec_type === "video");
  assert.equal(v1.nb_read_frames, v0.nb_read_frames);
  assert.equal(`${v1.width}x${v1.height}`, "1080x1920");
  assert.equal(v1.r_frame_rate, "30/1");
  assert.ok(Math.abs(Number(after.format.duration) - Number(before.format.duration)) < 0.05);
  assert.equal(h.audioMd5(path.join(folder, "captioned.mp4")), h.audioMd5(video), "the sound is copied, not encoded again");
  assert.equal(c.look.font, "Inter");
  assert.ok(c.look.drawn.some((f) => f.family === "Inter" && f.glyphs > 0), JSON.stringify(c.look.drawn));
  assert.equal(c.look.highlightMode, "patch");
  assert.deepEqual(c.places.map((p) => p.place), ["tiktok", "reels", "shorts"]);
  // The captions stay inside every place's margins: the band they are
  // drawn in reaches past the block only by the outline and its shadow.
  const ink = inkOf(c.layout.fontPx, { style: "karaoke" });
  assert.ok(c.layout.band.y >= 288 - ink.reach && c.layout.band.y + c.layout.band.height <= 1920 - 672 + Math.ceil(ink.reach + ink.shadow.y + c.layout.fontPx * 0.05) + 2, JSON.stringify(c.layout.band));
  const md = fs.readFileSync(path.join(folder, "CAPTIONS.md"), "utf8");
  for (const part of ["## Files", "## Look", "## Where the captions sit", "## Reading speed", "## The words", "## Font license", "SIL Open Font License"]) assert.ok(md.includes(part), part);
  // words.json reads back as the words it came from.
  const back = readWords(path.join(folder, "words.json"));
  assert.equal(back.format, "easycaptionkit");
  assert.equal(back.words.length, 14);
  // A second run replaces this run's files and keeps someone's own.
  fs.writeFileSync(path.join(folder, "notes.txt"), "mine");
  caption([video, "--words", words, "--style", "line", "--out", folder]);
  assert.equal(fs.readFileSync(path.join(folder, "notes.txt"), "utf8"), "mine");
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "captions.json"), "utf8")).style, "line");
  // A misheard word fixed in words.json, and the run made again from it in place.
  const list = JSON.parse(fs.readFileSync(path.join(folder, "words.json"), "utf8"));
  list.words[0].text = "Lunch";
  fs.writeFileSync(path.join(folder, "words.json"), JSON.stringify(list));
  const fixed = caption([video, "--words", path.join(folder, "words.json"), "--style", "line", "--out", folder]);
  assert.match(fixed.cues[0].text, /^Lunch week/);
  assert.match(fs.readFileSync(path.join(folder, "captions.srt"), "utf8"), /Lunch week/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "words.json"), "utf8")).words[0].text, "Lunch");
});

test("the captioned video keeps each sound track's language and the chapters, leaves out the file's own tags, its cover picture, its other tracks and the files attached to it, and says so", { skip }, () => {
  const folder = out("tagged");
  fs.mkdirSync(folder, { recursive: true });
  const meta = path.join(folder, "meta.txt");
  fs.writeFileSync(meta, ";FFMETADATA1\ntitle=My talk\nlocation=+41.0000+029.0000/\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Intro\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Main\n");
  const subs = h.write("tagged.srt", "1\n00:00:00,200 --> 00:00:01,500\nA soft subtitle.\n");
  const video = path.join(folder, "talk.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-i", subs, "-i", meta, "-map", "0:v", "-map", "1:a", "-map", "2:s", "-map_metadata", "3", "-map_chapters", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-c:s", "mov_text", "-metadata:s:a:0", "language=tur", "-metadata:s:a:0", "handler_name=Turkish", video]);
  const c = caption([video, "--words", h.write("tagged.json", { words: h.evenWords("tags and chapters", { start: 0.2 }) }), "--out", path.join(folder, "out")]);
  assert.ok(c.notes.includes("captioned.mp4 keeps the picture, the sound with its language and the chapters, and leaves out the file's own tags (title and location) and its subtitle track."), c.notes.join(" | "));
  const r = spawnSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", "-show_chapters", path.join(folder, "out", "captioned.mp4")], { encoding: "utf8" });
  const info = JSON.parse(r.stdout);
  const sound = info.streams.find((st) => st.codec_type === "audio");
  // MP4 names a track by its handler.
  assert.deepEqual([sound.tags.language, sound.tags.handler_name], ["tur", "Turkish"]);
  assert.deepEqual(info.chapters.map((ch) => ch.tags.title), ["Intro", "Main"]);
  assert.equal(info.streams.filter((st) => st.codec_type === "subtitle").length, 0);
  assert.equal(info.format.tags.title, undefined);
  assert.equal(info.format.tags.location, undefined);
  assert.equal(info.format.tags.comment, "Captioned with easycaptionkit");
  // A plain video says nothing of it.
  const plain = caption([h.video({ width: 360, height: 640, seconds: 2 }), "--words", h.write("untagged.json", { words: h.evenWords("nothing to leave out", { start: 0.2 }) }), "--out", out("untagged")]);
  assert.ok(!plain.notes.some((n) => /leaves out/.test(n)), plain.notes.join(" | "));
  // A cover picture, as yt-dlp --embed-thumbnail stores it, goes too, and says so.
  const cover = path.join(folder, "cover.png");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", cover]);
  const covered = path.join(folder, "covered.mp4");
  h.ffmpeg(["-i", h.video({ width: 360, height: 640, seconds: 2 }), "-i", cover, "-map", "0", "-map", "1", "-c", "copy", "-disposition:v:1", "attached_pic", covered]);
  const withCover = caption([covered, "--words", h.write("covered.json", { words: h.evenWords("a video with its cover", { start: 0.2, each: 0.3, gap: 0.05 }) }), "--out", path.join(folder, "covered")]);
  assert.ok(withCover.notes.includes("captioned.mp4 keeps the picture and the sound with its language, and leaves out its cover picture."), withCover.notes.join(" | "));
  assert.deepEqual(h.probe(path.join(folder, "covered", "captioned.mp4")).streams.map((s) => s.codec_type), ["video", "audio"]);
  // So does a second video track, and a file attached to a Matroska file, as its fonts are.
  const font = path.join(folder, "font.ttf");
  fs.copyFileSync(path.join(h.FIXTURES, "inter-latin-400.woff2"), font);
  const angles = path.join(folder, "angles.mkv");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-attach", font, "-metadata:s:t", "mimetype=font/ttf", angles]);
  const twoAngles = caption([angles, "--words", h.write("angles.json", { words: h.evenWords("two angles and a font", { start: 0.2, each: 0.3, gap: 0.05 }) }), "--out", path.join(folder, "angles")]);
  assert.ok(twoAngles.notes.includes("captioned.mp4 keeps the picture and the sound with its language, and leaves out its other video track and the file attached to it."), twoAngles.notes.join(" | "));
  // Two sound tracks, AAC and AC-3: the first is copied as it was, and only the second is made AAC, which each place says by track.
  const tracks = path.join(folder, "two-sounds.mkv");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2:sample_rate=48000", "-f", "lavfi", "-i", "sine=f=220:d=2:sample_rate=48000", "-map", "0", "-map", "1", "-map", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a:0", "aac", "-ac:a:0", "2", "-c:a:1", "ac3", "-ac:a:1", "6", "-metadata:s:a:0", "language=eng", "-metadata:s:a:1", "language=tur", tracks]);
  const two = h.run([tracks, "--words", h.write("two-sounds.json", { words: h.evenWords("one copied one made", { start: 0.2, each: 0.3, gap: 0.05 }) }), "--out", path.join(folder, "two-sounds")]);
  assert.equal(two.status, 0, two.stderr);
  // ffmpeg 4.4 writes the Matroska file's frames a little off a steady 30 fps, and every frame keeps its own time.
  assert.match(two.stdout, /\n {2}Video {5}captioned\.mp4, 360x640, [\d.]+ fps, 2\.\d\d s, sound copied as it was, track 2 \(ac3\) made AAC\n/);
  const twoJson = JSON.parse(fs.readFileSync(path.join(folder, "two-sounds", "captions.json"), "utf8"));
  assert.deepEqual(twoJson.output.audio, [{ codec: "aac", channels: 2, rate: 48000, copied: true }, { codec: "aac", channels: 6, rate: 48000, copied: false, from: "ac3" }]);
  assert.ok(twoJson.notes.includes("Sound track 2 (ac3) was made AAC at 384k, at the same rate, since MP4 players do not take ac3."), twoJson.notes.join(" | "));
  assert.match(fs.readFileSync(path.join(folder, "two-sounds", "CAPTIONS.md"), "utf8"), /\| captioned\.mp4 \| 360x640, [\d.]+ fps, 2(?:\.\d+)? s, H\.264 \(\w+\), sound copied as it was, track 2 \(ac3\) made AAC \|/);
  // The first track decodes to what it was.
  const decoded = (file) => spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", file, "-map", "0:a:0", "-f", "md5", "-"], { encoding: "utf8" }).stdout.trim();
  assert.equal(decoded(path.join(folder, "two-sounds", "captioned.mp4")), decoded(tracks));
  const { soundText } = require("../skills/easycaptionkit/scripts/lib/report");
  assert.equal(soundText([]), "no sound");
  assert.equal(soundText([{ copied: false, from: "pcm_s16le" }]), "sound made AAC");
  assert.equal(soundText([{ copied: true }, { copied: true }]), "2 sound tracks, copied as they were");
  assert.equal(soundText([{ copied: false, from: "ac3" }, { copied: false, from: "dts" }]), "2 sound tracks, made AAC");
  assert.equal(soundText([{ copied: true }, { copied: false, from: "ac3" }, { copied: false, from: "dts" }]), "sound copied as it was, tracks 2 (ac3) and 3 (dts) made AAC");
});

test("odd videos: rotated, odd sized, with wide pixels, at 29.97 fps, with a variable frame rate, 44.1 kHz mono, silent, soundless or with PCM sound, at a path with spaces and other letters", { skip }, () => {
  const words = h.write("odd.json", { words: h.evenWords("odd videos come out upright and whole", { start: 0.2, each: 0.2, gap: 0.05 }) });
  const odd = path.join(h.dir, "my clips", "çekim ünlü 日本");
  fs.mkdirSync(odd, { recursive: true });
  const pcm = path.join(odd, "ses kaydı.mov");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=480x270:r=25:d=2", "-f", "lavfi", "-i", "sine=f=220:d=2:sample_rate=44100", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-shortest", pcm]);
  const cases = [
    { name: "rotated", file: h.video({ width: 640, height: 360, fps: 25, seconds: 2, rotate: 90 }), size: "360x640" },
    { name: "odd-size", file: h.video({ width: 721, height: 1281, fps: 30, seconds: 2 }), size: "720x1280", note: /even sides/ },
    { name: "wide-pixels", file: h.video({ width: 720, height: 576, fps: 25, seconds: 2, sar: "16/15" }), size: "768x576", note: /not square/ },
    { name: "ntsc", file: h.video({ width: 640, height: 360, fps: "30000/1001", seconds: 2, rate: 44100, channels: 1 }), size: "640x360" },
    { name: "vfr", file: h.vfrVideo(), size: "1080x1920", note: /frame rate varies/ },
    { name: "vfr-jitter", file: h.jitterVideo(), size: "320x568", note: /frame rate varies/ },
    { name: "silent", file: h.video({ width: 360, height: 640, seconds: 2, sound: "silence" }), size: "360x640" },
    { name: "soundless", file: h.video({ width: 360, height: 640, seconds: 2, sound: "none" }), size: "360x640", note: /no sound/ },
    { name: "pcm", file: pcm, size: "480x270", note: /made AAC/ },
  ];
  for (const k of cases) {
    // An ffmpeg that cannot write a display matrix makes no rotated clip to test with.
    if (k.name === "rotated" && !(h.probe(k.file).streams[0].side_data_list || []).some((d) => d.rotation)) continue;
    const folder = path.join(odd, `out ${k.name}`);
    const c = caption([k.file, "--words", words, "--out", folder]);
    const result = h.probe(path.join(folder, "captioned.mp4"));
    const v = result.streams.find((s) => s.codec_type === "video");
    const given = h.probe(k.file);
    const g = given.streams.find((s) => s.codec_type === "video");
    assert.equal(`${v.width}x${v.height}`, k.size, k.name);
    assert.ok(!(v.side_data_list || []).some((d) => d.rotation), `${k.name} is written upright, with no rotation left`);
    assert.equal(v.nb_read_frames, g.nb_read_frames, `${k.name} keeps every frame`);
    assert.ok(Math.abs(Number(result.format.duration) - Number(given.format.duration)) < 0.1, `${k.name}: ${result.format.duration} against ${given.format.duration}`);
    const sound = given.streams.filter((s) => s.codec_type === "audio");
    const kept = result.streams.filter((s) => s.codec_type === "audio");
    assert.equal(kept.length, sound.length, `${k.name} keeps its sound streams`);
    if (sound.length) assert.equal(kept[0].sample_rate, sound[0].sample_rate);
    if (sound.length && sound[0].codec_name === "aac") assert.equal(h.audioMd5(path.join(folder, "captioned.mp4")), h.audioMd5(k.file));
    if (k.note) assert.ok(c.notes.some((n) => k.note.test(n)), `${k.name}: ${c.notes.join(" | ")}`);
    if (k.name === "ntsc") assert.ok(Math.abs(c.output.fps - 29.97) < 0.01);
    if (k.name.startsWith("vfr")) {
      const a = h.frameTimes(k.file);
      const b = h.frameTimes(path.join(folder, "captioned.mp4"));
      assert.equal(b.length, a.length);
      const drift = Math.max(...a.map((t, i) => Math.abs(t - b[i])));
      assert.ok(drift < 0.0002, `${k.name}: every frame keeps its own time, off by ${drift} s at most`);
    }
  }
});

test("an HLG video stays HDR, with the captions' white at the reference white for graphics, drawn by Chrome or by libass", { skip }, () => {
  const hlg = out("hlg.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-vf", "format=yuv420p10le,setparams=color_trc=arib-std-b67:color_primaries=bt2020:colorspace=bt2020nc", "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", hlg]);
  const words = h.write("hlg.json", { words: h.evenWords("bright but not blinding", { start: 0.2 }) });
  const libass = / subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  for (const extra of [[], ...(libass ? [["--libass"]] : [])]) {
    const folder = out(`hlg${extra.join("")}`);
    const c = caption([hlg, "--words", words, "--style", "line", "--out", folder, ...extra]);
    const v = h.probe(path.join(folder, "captioned.mp4")).streams.find((s) => s.codec_type === "video");
    assert.equal(v.color_transfer, "arib-std-b67");
    assert.equal(v.color_primaries, "bt2020");
    assert.ok(c.notes.some((n) => /HDR \(HLG\)/.test(n)));
    if (v.pix_fmt === "yuv420p10le") {
      // White letters at 75% of the signal: 64 + 0.75 * 876 in 10-bit luma.
      const run = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", path.join(folder, "captioned.mp4"), "-frames:v", "1", "-pix_fmt", "yuv420p10le", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
      const luma = new Uint16Array(run.stdout.buffer, run.stdout.byteOffset, 360 * 640);
      let top = 0;
      for (const y of luma) top = Math.max(top, y);
      assert.ok(top > 690 && top < 760, `${extra.join(" ") || "Chrome"}: brightest caption luma ${top}`);
    }
    // captions.ass keeps the plain white, for players.
    assert.match(fs.readFileSync(path.join(folder, "captions.ass"), "utf8"), /Style: Caption,[^,]*,\d+,&H00FFFFFF,/);
  }
});

test("a full range video, as some phones and screen recorders write it, stays in full range, its picture as it was, where ffmpeg 4.4 took the picture to TV range and the video came out pale", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  // The chain keeps the range: ffmpeg 4.4 took a full range 4:2:0 picture to TV range on its way to yuv420p.
  const { prepareChain } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const plainVideo = { sar: 1, width: 720, height: 1280, out: { width: 720, height: 1280 }, color: { range: "tv" } };
  assert.equal(prepareChain(plainVideo), "format=yuv420p");
  assert.equal(prepareChain({ ...plainVideo, color: { range: "pc" } }), "scale=in_range=pc:out_range=pc,format=yuv420p");
  assert.equal(prepareChain({ ...plainVideo, sar: 4 / 3, color: { range: "pc" } }), "scale=720:1280:in_range=pc:out_range=pc,setsar=1,format=yuv420p");
  const full = out("full-range-src.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-pix_fmt", "yuvj420p", "-preset", "veryfast", "-c:a", "aac", "-shortest", "-color_primaries", "1", "-color_trc", "1", "-colorspace", "1", full]);
  // The raw values of a corner of a frame, which no caption covers, in the file's own pixel format.
  const raw = (file) => [...spawnSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", "crop=2:2:60:60", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 }).stdout];
  const words = h.write("full-range-words.json", { words: h.evenWords("full range stays full", { start: 0.2 }) });
  const libass = / ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  for (const [name, args] of [["full-range-libass", ["--libass"]], ["full-range-chrome", []]]) {
    if (name.endsWith("libass") ? !libass : !findChrome()) continue;
    caption([full, "--words", words, ...args, "--out", out(name)], { env: { ...process.env, ...(args.length ? { CHROME_PATH: "/nonexistent/chrome" } : {}) } });
    const result = path.join(out(name), "captioned.mp4");
    assert.equal(h.probe(result).streams.find((s) => s.codec_type === "video").color_range, "pc", name);
    const [before, after] = [raw(full), raw(result)];
    assert.equal(after.length, before.length, name);
    // x264 at CRF 18 moves a value by a step or two; TV range would move a Y of 76 to 81 and a V of 255 to 240.
    before.forEach((value, i) => assert.ok(Math.abs(after[i] - value) <= 3, `${name}: ${before} became ${after}`));
  }
});

test("a run that fails part way leaves the folder as it was", { skip }, () => {
  const video = h.video({ width: 360, height: 640, seconds: 2 });
  const words = h.write("fail.json", { words: h.evenWords("this one fails", { start: 0.2 }) });
  const folder = out("fails");
  caption([video, "--words", words, "--out", folder]);
  fs.writeFileSync(path.join(folder, "notes.txt"), "mine");
  const before = Object.fromEntries(files(folder).map((f) => [f, fs.readFileSync(path.join(folder, f)).length]));
  // An ffmpeg that fails only when it is asked to encode.
  const fake = path.join(h.dir, "fake-bin", "ffmpeg");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "-filter_complex" ] && { echo "disk full, as a test" >&2; exit 1; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const r = h.run([video, "--words", words, "--style", "word", "--out", folder], { env: { ...process.env, FFMPEG_PATH: fake } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /disk full, as a test/);
  const after = Object.fromEntries(files(folder).map((f) => [f, fs.readFileSync(path.join(folder, f)).length]));
  assert.deepEqual(after, before, "no file changed, none added, no work folder left");
  // A folder the failed run made itself is gone, and so are the folders it made to hold it.
  const fresh = out("fails-fresh");
  assert.equal(h.run([video, "--words", words, "--out", fresh], { env: { ...process.env, FFMPEG_PATH: fake } }).status, 1);
  assert.equal(fs.existsSync(fresh), false);
  assert.equal(h.run([video, "--words", words, "--out", path.join(out("fails-new"), "a", "b", "c")], { env: { ...process.env, FFMPEG_PATH: fake } }).status, 1);
  assert.equal(fs.existsSync(out("fails-new")), false);
});

// The pixels of one frame that differ from a flat gray background.
function inkAt(file, t, width, height) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const px = run.stdout;
  let left = width;
  let right = -1;
  for (let i = 0; i + 2 < px.length; i += 3) {
    if (Math.abs(px[i] - 128) + Math.abs(px[i + 1] - 128) + Math.abs(px[i + 2] - 128) < 40) continue;
    const x = (i / 3) % width;
    left = Math.min(left, x);
    right = Math.max(right, x);
  }
  return { left, right };
}

test("big letters, the word style and Reels alone keep every pixel of the caption inside the safe space, outline and shadow included", { skip }, () => {
  const gray = out("gray-vertical.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", gray]);
  const words = h.write("wide-caps.json", { words: h.evenWords("WATCH NEW MAKERS WORK WONDERS WITH MCP", { start: 0.2, each: 0.3, gap: 0.05 }) });
  for (const [name, args] of [["size-17", ["--size", "17", "--style", "line"]], ["word-20", ["--size", "20", "--style", "word"]], ["reels", ["--for", "reels", "--style", "line"]], ["box", ["--size", "12", "--box", "--style", "line"]]]) {
    const folder = out(`safe-${name}`);
    const c = caption([gray, "--words", words, "--out", folder, ...args]);
    const L = c.layout;
    assert.ok(L.fontPx * 4 <= L.textWidth, `${name}: ${L.fontPx} px letters in ${L.textWidth} px`);
    // Each caption whole, or in the word style each word alone.
    const moments = c.cues.flatMap((cue) => (c.style === "word" ? cue.words.map((w) => (w.start + Math.min(w.end, cue.end)) / 2) : [(cue.start + cue.end) / 2]));
    for (const t of moments) {
      const { left, right } = inkAt(path.join(folder, "captioned.mp4"), t, 1080, 1920);
      if (right < 0) continue;
      assert.ok(left >= L.side - 1 && right <= 1080 - L.side, `${name} at ${t.toFixed(2)} s: caption pixels from x ${left} to ${right}, safe space from ${L.side} to ${1080 - L.side}`);
    }
  }
});

// The first and last rows of one frame that differ from a flat gray.
function rowsAt(file, t, width) {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  const px = run.stdout;
  let top = -1;
  let bottom = -1;
  for (let i = 0; i + 2 < px.length; i += 3) {
    if (Math.abs(px[i] - 128) + Math.abs(px[i + 1] - 128) + Math.abs(px[i + 2] - 128) < 40) continue;
    const y = Math.floor(i / 3 / width);
    if (top < 0) top = y;
    bottom = y;
  }
  return { top, bottom };
}

test("captions in capitals that libass draws stay inside the safe space, at the letter size CAPTIONS.md gives", { skip }, function () {
  if (!/ subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const gray = out("gray-caps.mp4");
  if (!fs.existsSync(gray)) h.ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=25:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", gray]);
  // Lines cut for small letters, which in capitals are wider than the safe space.
  const words = h.write("caps-libass.json", { words: h.evenWords("FIX IT IN WORDS.JSON AND RUN IT AGAIN WITH THE SAME COMMAND, MAKERS WHO SHIP EVERY WEEK", { start: 0.2, each: 0.3, gap: 0.05 }) });
  const folder = out("caps-libass");
  const c = caption([gray, "--words", words, "--style", "line", "--libass", "--out", folder]);
  const L = c.layout;
  for (const cue of c.cues) {
    const { left, right } = inkAt(path.join(folder, "captioned.mp4"), (cue.start + cue.end) / 2, 1080, 1920);
    if (right < 0) continue;
    assert.ok(left >= L.side - 1 && right <= 1080 - L.side, `"${cue.text}": caption pixels from x ${left} to ${right}, safe space from ${L.side} to ${1080 - L.side}`);
  }
  assert.ok(c.notes.some((n) => /a line longer than the safe space takes at 70 px, by an estimate of the letters' width, so libass drew (it|them) smaller/.test(n)), c.notes.join(" | "));
  // The font's em is the 70 px of the layout: Arial, and Liberation Sans for it, are 1.1172 of their em tall.
  const style = /^Style: Caption,([^,]*),(\d+),/m.exec(fs.readFileSync(path.join(folder, "captions.ass"), "utf8"));
  assert.deepEqual([style[1], Number(style[2])], ["Arial", Math.round(70 * (1854 + 434) / 2048)]);
});

test("a video of a few pixels is captioned, and one too small for letters a pixel tall says so", { skip }, () => {
  const words = h.write("tiny.json", { words: h.evenWords("a small one", { start: 0.2 }) });
  // Chrome's window is never that small: it would not answer for a picture of it.
  const small = blackVideo("black-64.mp4", { width: 64, height: 64, seconds: 2 });
  const started = Date.now();
  const c = caption([small, "--words", words, "--out", out("tiny-64")]);
  assert.ok(Date.now() - started < 30_000, "it took a long time");
  assert.equal(c.cues.length > 0, true);
  // At 2x2 the letters would be 0 px, with or without Chrome.
  const dot = blackVideo("black-2.mp4", { width: 2, height: 2, seconds: 2 });
  for (const extra of [[], ["--libass"]]) {
    const r = h.run([dot, "--words", words, "--out", out("tiny-2"), ...extra]);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim().split("\n").pop(), "easycaptionkit: The video is 2x2, too small for captions: at --size 6.5 the letters would be less than a pixel tall");
    assert.equal(fs.existsSync(out("tiny-2")), false);
  }
  const subs = h.run(["subtitles", words, "--video", dot, "--out", out("tiny-2-subs")]);
  assert.match(subs.stderr, /The video is 2x2, too small for captions/);
});

test("libass burns a fonts.css font that fonts.css calls otherwise than its file does, found by the name in the file", { skip }, function () {
  if (!/ subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  // easyfontkit names a family as people write it, so InterVariable's file is Inter in fonts.css; here Inter's file is Kit Inter.
  const kit = h.fontKit("kit-renamed", { family: "Kit Inter" });
  const video = blackVideo("black-renamed.mp4", { width: 360, height: 640, seconds: 2 });
  const words = h.write("renamed.json", { words: h.evenWords("found by its own name", { start: 0.2 }) });
  const folder = out("renamed-libass");
  const r = h.run([video, "--words", words, "--fonts", kit, "--libass", "--style", "line", "--out", folder]);
  assert.equal(r.status, 0, r.stderr);
  const ass = path.join(folder, "captions.ass");
  assert.match(fs.readFileSync(ass, "utf8"), /^Style: Caption,Inter,/m);
  assert.match(r.stdout, /Font {6}Kit Inter 400 from fonts\.css, which captions\.ass names Inter, as its file does\n/);
  assert.match(fs.readFileSync(path.join(folder, "CAPTIONS.md"), "utf8"), /- Font: Kit Inter 400, from fonts\.css \(files\/inter-latin-400\.woff2\)\.\n {2}captions\.ass names it Inter, the family name in its file, which libass and the players that read ASS find a font by\.\n/);
  // libass, given the kit's folder, takes the kit's file for that name, not a font of this machine's.
  const log = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "debug", "-f", "lavfi", "-i", "color=c=black:s=360x640:r=4:d=2", "-vf", `subtitles=filename=${ass}:fontsdir=${path.join(kit, "files")}`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const picked = /fontselect: \(([^)]*)\) -> ([^,]*),/.exec(log);
  assert.ok(picked, "libass chose a font");
  assert.deepEqual([picked[1], picked[2]], ["Inter, 400, 0", "Inter-Regular"]);
});

test("libass is given a fonts folder of the look's own font files alone, not the folder of fonts.css, whose every other file it would read into memory", { skip: !h.hasFfmpeg ? "needs ffmpeg" : process.platform === "win32" && "needs a shell script for ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  // A fonts.css made elsewhere, next to its font and another big file.
  const kit = h.fontKit("kit-crowded");
  fs.writeFileSync(path.join(kit, "files", "recording.mov"), Buffer.alloc(1 << 20));
  // An ffmpeg that lists the folder each ass filter is given as its fonts folder, as the burn runs.
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, "fontsdir-bin", "ffmpeg");
  const listed = path.join(h.dir, "fontsdir-bin", "listed");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    *fontsdir=*) ls -A "$(printf '%s' "$a" | sed -n 's/.*fontsdir=\\([^:]*\\):.*/\\1/p')" >> "${listed}" ;;\n  esac\ndone\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const words = h.write("crowded.json", { words: h.evenWords("only the fonts", { start: 0.2 }) });
  caption([blackVideo("black-crowded.mp4", { width: 360, height: 640, seconds: 2 }), "--words", words, "--fonts", kit, "--libass", "--out", out("crowded")], { env: { ...process.env, FFMPEG_PATH: fake, CHROME_PATH: "/nonexistent/chrome" } });
  assert.equal(fs.readFileSync(listed, "utf8"), "inter-latin-400.woff2\n");
  // CAPTIONS.md still gives the kit's own folder, where the font stays.
  assert.match(fs.readFileSync(path.join(out("crowded"), "CAPTIONS.md"), "utf8"), /fontsdir=/);
  // A fonts.css that names that recording for one face, and for another a file past 64 MB that starts as a WOFF2 file
  // does: neither is a font the kit's measuring takes, and neither goes in the folder libass reads whole.
  const named = h.fontKit("kit-named");
  fs.writeFileSync(path.join(named, "files", "recording.mov"), Buffer.alloc(1 << 20));
  const huge = path.join(named, "files", "huge.woff2");
  fs.writeFileSync(huge, "wOF2");
  fs.truncateSync(huge, 65 * 1024 * 1024);
  fs.appendFileSync(path.join(named, "fonts.css"), `@font-face {\n  font-family: "Inter";\n  src: url("files/recording.mov") format("woff2");\n  font-weight: 400;\n  font-style: italic;\n}\n\n@font-face {\n  font-family: "Inter";\n  src: url("files/huge.woff2") format("woff2");\n  font-weight: 700;\n  font-style: normal;\n}\n`);
  fs.rmSync(listed, { force: true });
  const c = caption([blackVideo("black-crowded.mp4", { width: 360, height: 640, seconds: 2 }), "--words", words, "--fonts", named, "--libass", "--out", out("named")], { env: { ...process.env, FFMPEG_PATH: fake, CHROME_PATH: "/nonexistent/chrome" } });
  assert.deepEqual(c.look.files, ["files/inter-latin-400.woff2", "files/recording.mov", "files/huge.woff2"]);
  assert.equal(fs.readFileSync(listed, "utf8"), "inter-latin-400.woff2\n");
});

test("libass says a variable file's letters are thin only where that file draws letters, and the summary names the fonts captions.ass sets the others in", { skip: !h.hasFfmpeg ? "needs ffmpeg" : process.platform !== "linux" && "needs fontconfig" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  // Inter's file, given in fonts.css as one of the weights 100 to 900.
  const kit = h.fontKit("kit-variable");
  fs.writeFileSync(path.join(kit, "fonts.css"), fs.readFileSync(path.join(kit, "fonts.css"), "utf8").replace("font-weight: 400;", "font-weight: 100 900;"));
  const video = blackVideo("black-variable.mp4", { width: 360, height: 640, seconds: 2 });
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const thin = /a file of the weights 100 to 900|default weight/;
  const latin = h.run([video, "--words", h.write("variable-latin.json", { words: h.evenWords("thin letters here", { start: 0.2 }) }), "--fonts", kit, "--libass", "--style", "line", "--out", out("variable-latin")], env);
  assert.equal(latin.status, 0, latin.stderr);
  assert.match(latin.stdout, /\n {2}Note {6}libass draws Inter from files\/inter-latin-400\.woff2, a file of the weights 100 to 900, at that file's default weight, not at 700/);
  // Japanese has no letter in Inter's file.
  const kana = h.run([video, "--words", h.write("variable-kana.json", [{ text: "こんにちは", start: 0.2, end: 1.5 }]), "--fonts", kit, "--libass", "--style", "line", "--out", out("variable-kana")], env);
  assert.equal(kana.status, 0, kana.stderr);
  assert.doesNotMatch(kana.stdout + fs.readFileSync(path.join(out("variable-kana"), "CAPTIONS.md"), "utf8"), thin);
  const facts = JSON.parse(fs.readFileSync(path.join(out("variable-kana"), "captions.json"), "utf8"));
  assert.equal(facts.drawnWith, "libass");
  const set = /\n {2}Font {6}Inter 700 from fonts\.css(.*)\n/.exec(kana.stdout);
  assert.ok(set, kana.stdout);
  // Where this machine has a font for them, the summary names it.
  if (/\\fn/.test(fs.readFileSync(path.join(out("variable-kana"), "captions.ass"), "utf8"))) assert.match(set[1], /^, which has none of these letters: captions\.ass sets them in /);
});

test("libass lays out a line of Arabic from right to left, as Chrome does, so its full stop is at the left end", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const { libassFilter } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const video = blackVideo("black-rtl.mp4", { width: 1080, height: 1920, seconds: 2 });
  // The captions.ass of a subtitles run, burned on the black video as the kit burns it: the
  // Style line, and where the white of the letters is on the frame, from the left.
  const burned = (name, text) => {
    const folder = out(`rtl-${name}`);
    const r = h.run(["subtitles", h.write(`rtl-${name}.json`, [{ text, start: 0.2, end: 1.8 }]), "--video", video, "--style", "line", "--out", folder]);
    assert.equal(r.status, 0, r.stderr);
    const ass = path.join(folder, "captions.ass");
    const gray = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", video, "-ss", "1", "-frames:v", "1", "-vf", `${libassFilter(ass)},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 }).stdout;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] < 128) continue;
      sum += i % 1080;
      count++;
    }
    assert.ok(count > 0, `${name}: libass drew no letter`);
    return { style: /^Style: .*$/m.exec(fs.readFileSync(ass, "utf8"))[0], x: sum / count };
  };
  const stop = burned("stop", "منتجنا الجديد.");
  const none = burned("none", "منتجنا الجديد");
  // libass takes each line's direction from its first letter only with the Encoding -1.
  assert.match(stop.style, /,-1$/);
  // The line is centered: a full stop at its left end moves the letters to the right.
  assert.ok(stop.x - none.x > 2, `the letters moved ${(stop.x - none.x).toFixed(1)} px, so the full stop is at the ${stop.x > none.x ? "left" : "right"} end`);
  // Latin captions keep the Encoding VSFilter reads as the default character set.
  assert.match(burned("latin", "Launch day.").style, /,1$/);
});

test("descenders and accents, with the outline and its shadow or the box, stay inside the safe space at the bottom and at the top", { skip }, () => {
  const gray = out("gray-vertical.mp4");
  if (!fs.existsSync(gray)) h.ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", gray]);
  const low = h.write("descenders.json", { words: h.evenWords("Jumpy gypsy pugs jog quietly", { start: 0.2, each: 0.4, gap: 0.1 }) });
  const high = h.write("accents.json", { words: h.evenWords("ÉÅÖ ŻÓŁĆ Ñandú Ångström", { start: 0.2, each: 0.4, gap: 0.1 }) });
  const libass = / subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  const runs = [
    ["low", low, []],
    ["low-12", low, ["--size", "12", "--style", "line"]],
    ["low-box", low, ["--size", "12", "--style", "line", "--box"]],
    ["high-top", high, ["--size", "12", "--style", "line", "--position", "top"]],
    ...(libass ? [["low-libass", low, ["--style", "line", "--libass"]], ["high-libass", high, ["--size", "12", "--style", "line", "--position", "top", "--libass"]]] : []),
  ];
  for (const [name, words, args] of runs) {
    const folder = out(`edges-${name}`);
    const c = caption([gray, "--words", words, "--out", folder, ...args]);
    const safe = c.layout.safe;
    for (const cue of c.cues) {
      const { top, bottom } = rowsAt(path.join(folder, "captioned.mp4"), (cue.start + cue.end) / 2, 1080);
      if (bottom < 0) continue;
      assert.ok(bottom <= 1920 - safe.bottom - 1, `${name}, "${cue.text}": caption pixels down to row ${bottom}, the safe space ends at row ${1920 - safe.bottom - 1}`);
      assert.ok(top >= safe.top, `${name}, "${cue.text}": caption pixels from row ${top}, the safe space starts at row ${safe.top}`);
    }
  }
});

test("the outline has round corners: no point sticks out under a V", { skip }, () => {
  const gray = out("gray-vertical.mp4");
  if (!fs.existsSync(gray)) h.ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", gray]);
  const folder = out("round-outline");
  const c = caption([gray, "--words", h.write("vee.json", { words: [{ word: "VVV", start: 0.5, end: 2.5 }] }), "--style", "word", "--size", "20", "--out", folder]);
  const stroke = inkOf(c.layout.fontPx, { style: "word" }).stroke;
  const run = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-ss", "1.5", "-i", path.join(folder, "captioned.mp4"), "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 });
  // The lowest bright pixel (the letters, lit yellow) and the lowest near
  // black one (the outline).
  let white = -1;
  let black = -1;
  for (let i = 0; i + 2 < run.stdout.length; i += 3) {
    const y = Math.floor(i / 3 / 1080);
    const [r, g, b] = [run.stdout[i], run.stdout[i + 1], run.stdout[i + 2]];
    if (r > 200 && g > 170) white = Math.max(white, y);
    if (r < 25 && g < 25 && b < 25) black = Math.max(black, y);
  }
  assert.ok(white > 0 && black > white, `letters to ${white}, outline to ${black}`);
  assert.ok(black - white <= stroke * 1.4 + 2, `the outline reaches ${black - white} px under the letters, its stroke is ${stroke} px`);
});

test("output folders with % ' = , [ ] ; : ? # \\, a line break in their names, and a video named like a protocol", { skip }, () => {
  const { filterPath, libassFilter } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  // Escaped for the option parser, then for the graph parser; a backslash
  // is a folder's separator only on Windows.
  assert.equal(filterPath("/a\\b/c:d", "linux"), "/a\\\\\\\\b/c\\\\:d");
  assert.equal(filterPath("C:\\a\\b", "win32"), "C\\\\:/a/b");
  // Both parsers take the spaces off the ends of a value that are not
  // escaped, so a space is escaped for each.
  assert.equal(filterPath("/a/kit ", "linux"), "/a/kit\\\\\\ ");
  // libass draws with ffmpeg's ass filter in its complex shaping, which
  // joins Arabic letters in a font without their presentation forms, as
  // Noto Kufi Arabic is, and Devanagari's conjuncts; the subtitles filter
  // sets the simple shaping.
  assert.equal(libassFilter("/a/captions.ass"), "ass=filename=/a/captions.ass:shaping=complex");
  if (/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) {
    // A fonts folder whose name ends in a space, next to one whose name does not.
    const spaced = path.join(h.dir, "fonts-space ");
    for (const folder of [spaced, path.join(h.dir, "fonts-space")]) fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(h.FIXTURES, "inter-latin-400.woff2"), path.join(spaced, "inter.woff2"));
    const ass = h.write("space-fonts.ass", "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 240\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: C,Inter,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.00,C,,0,0,0,,Hello\n");
    const log = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "verbose", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=2:d=1", "-filter_complex", `[0:v]${libassFilter(ass, spaced)}[v]`, "-map", "[v]", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    assert.ok(log.includes(`Loading font file '${path.join(spaced, "inter.woff2")}'`), log.split("\n").filter((l) => /font/i.test(l)).join("\n"));
  }
  const source = h.video({ width: 360, height: 640, seconds: 2 });
  const named = path.join(h.dir, "take1:final.mp4");
  fs.copyFileSync(source, named);
  const words = h.write("odd-names.json", { words: h.evenWords("names that ffmpeg reads its own way", { start: 0.2, each: 0.15, gap: 0.03 }) });
  const caps = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout;
  const runs = [[path.join(h.dir, "take%03d"), []]];
  // A line break, and ? and #, which a link would read as its query and
  // fragment: ffmpeg reads the animated PNG of the states by its name.
  if (process.platform !== "win32") runs.push([path.join(h.dir, "two\nlines? #1"), []]);
  // On Linux and macOS a backslash is a letter of a folder's name.
  if (/ subtitles /.test(caps)) runs.push([path.join(h.dir, `out it's a=b,[c];d:e %d${process.platform === "win32" ? "" : " back\\slash"}`), ["--libass"]]);
  if (/ subtitles /.test(caps) && process.platform !== "win32") runs.push([path.join(h.dir, "plain\nlines? #2"), ["--libass"], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } }]);
  for (const [folder, extra, options] of runs) {
    const c = caption([named, "--words", words, "--out", folder, ...extra], options);
    assert.equal(c.video.file, "take1:final.mp4");
    for (const name of ["captioned.mp4", "sheet.png", "safe-zones.png"]) assert.ok(fs.statSync(path.join(folder, name)).size > 0, `${folder}: ${name}`);
    assert.equal(h.probe(path.join(folder, "captioned.mp4")).streams.find((s) => s.codec_type === "video").nb_read_frames, h.probe(source).streams.find((s) => s.codec_type === "video").nb_read_frames);
  }
});

test("the caption states go to ffmpeg as one animated PNG, each frame at its own millisecond however many come before it", { skip: !h.hasFfmpeg && "needs ffmpeg" }, () => {
  const { statesFrames } = require("../skills/easycaptionkit/scripts/lib/render");
  const { writeApng } = require("../skills/easycaptionkit/scripts/lib/apng");
  // A gap before the first state, two states back to back, a gap of more than a minute, and the blank second after the last state.
  const timeline = [{ from: 0.2004, to: 0.25, file: "a" }, { from: 0.25, to: 1.0006, file: "b" }, { from: 70, to: 70.5, file: "a" }];
  const frames = statesFrames(timeline, "blank", 71);
  assert.deepEqual(frames, [{ png: "blank", ms: 200 }, { png: "a", ms: 50 }, { png: "b", ms: 751 }, { png: "blank", ms: 68999 }, { png: "a", ms: 500 }, { png: "blank", ms: 1000 }]);
  // The stream ends with the captions, not with the length a header claims.
  assert.deepEqual(statesFrames(timeline, "blank", 1e9), frames);
  // A state that runs past the video ends with it.
  assert.deepEqual(statesFrames([{ from: 1, to: 3, file: "a" }], "blank", 2), [{ png: "blank", ms: 1000 }, { png: "a", ms: 1000 }, { png: "blank", ms: 1000 }]);
  const folder = out("apng");
  fs.mkdirSync(folder, { recursive: true });
  const png = {};
  for (const [name, color] of [["blank", "black@0.0"], ["a", "red@0.5"], ["b", "lime"]]) {
    png[name] = path.join(folder, `${name}.png`);
    h.ffmpeg(["-f", "lavfi", "-i", `color=c=${color}:s=48x16,format=rgba`, "-frames:v", "1", png[name]]);
  }
  const file = path.join(folder, "states.apng");
  writeApng(file, frames.map((f) => ({ png: png[f.png], ms: f.ms })));
  const times = spawnSync("ffprobe", ["-v", "error", "-f", "apng", "-max_fps", "0", "-i", file, "-show_entries", "packet=pts_time", "-of", "csv=p=0"], { encoding: "utf8" }).stdout.trim().split("\n").map(Number);
  // The minute and more of blank is a frame held twice: a frame's time is 16 bits of milliseconds.
  assert.deepEqual(times, [0, 0.2, 0.25, 1.001, 61.001, 70, 70.5]);
  const px = spawnSync("ffmpeg", ["-v", "error", "-f", "apng", "-max_fps", "0", "-i", file, "-vf", "crop=1:1:0:0", ...h.fpsMode("passthrough"), "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 20 }).stdout;
  assert.deepEqual([...px], [0, 0, 0, 0, 255, 0, 0, 127, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 127, 0, 0, 0, 0], "each frame replaces the one before, its see-through pixels too");
});

// An ffmpeg that says it is Ubuntu 22.04's 4.4, has no -fps_mode, and,
// like MakersMCP's guard, refuses a concat list.
function ffmpeg44(name) {
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, name, "ffmpeg");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in\n    -version) echo "ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021 the FFmpeg developers"; exit 0 ;;\n    -fps_mode*) echo "Unrecognized option '\${a#-}'." >&2; exit 1 ;;\n    concat) echo "concat is not on the format whitelist" >&2; exit 1 ;;\n  esac\ndone\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return fake;
}

test("on Ubuntu 22.04's ffmpeg 4.4 behind a guard that refuses concat lists, Chrome's captions and libass's are burned, each state on its frame", { skip }, () => {
  const fake = ffmpeg44("ffmpeg-44");
  const env = { env: { ...process.env, FFMPEG_PATH: fake } };
  const video = blackVideo("black-30.mp4");
  const words = h.write("timed-44.json", { task: "transcribe", words: [{ word: "one", start: 1.0, end: 1.4 }, { word: "two", start: 1.5, end: 1.9 }, { word: "three", start: 2.0, end: 2.4 }] });
  const c = caption([video, "--words", words, "--highlight", "#00ff00", "--out", out("on-44")], env);
  assert.deepEqual(c.cues[0].words.map((w) => w.frame), [30, 45, 60]);
  const frames = litFrames(path.join(out("on-44"), "captioned.mp4"), c.layout.band);
  assert.equal(frames.length, 120);
  assert.equal(frames.findIndex((f) => f.white > 0 || f.green > 0), 30);
  const lit = frames.map((f) => Math.round(f.x / 40));
  assert.ok(lit[44] !== lit[45] && lit[45] === lit[59] && lit[59] !== lit[60], `the lit word moves at frames 45 and 60: ${lit.slice(40, 64).join(",")}`);
  const libass = / subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  if (libass) {
    const l = caption([video, "--words", words, "--libass", "--out", out("on-44-libass")], env);
    assert.equal(l.output.frames, 120);
    for (const name of ["captioned.mp4", "sheet.png", "safe-zones.png"]) assert.ok(fs.statSync(path.join(out("on-44-libass"), name)).size > 0, name);
    // Without Chrome, the sheet's frames go to ffmpeg's tile as one animated PNG too.
    const plain = caption([video, "--words", words, "--libass", "--out", out("on-44-plain")], { env: { ...env.env, CHROME_PATH: "/nonexistent/chrome" } });
    assert.equal(plain.drawnWith, "libass");
    assert.ok(fs.statSync(path.join(out("on-44-plain"), "sheet.png")).size > 0);
  }
  // Older than 4.4 is refused, and says so.
  const old = path.join(h.dir, "ffmpeg-43", "ffmpeg");
  fs.mkdirSync(path.dirname(old), { recursive: true });
  fs.writeFileSync(old, fs.readFileSync(fake, "utf8").replace("4.4.2-0ubuntu0.22.04.1", "4.3.6"), { mode: 0o755 });
  const r = h.run([video, "--words", words, "--out", out("on-43")], { env: { ...process.env, FFMPEG_PATH: old } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^easycaptionkit: ffmpeg 4\.4 or newer is needed, and this one is 4\.3\./);
});

test("an FFMPEG_PATH and FFPROBE_PATH given from the folder the run starts in are found when ffmpeg runs in the work folder", { skip }, () => {
  const where = out("relative-bin");
  fs.mkdirSync(path.join(where, "bin"), { recursive: true });
  for (const name of ["ffmpeg", "ffprobe"]) fs.symlinkSync(spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim(), path.join(where, "bin", name));
  const video = h.video({ width: 360, height: 640, seconds: 2 });
  const words = h.write("relative.json", { words: h.evenWords("found from here", { start: 0.2 }) });
  const env = { ...process.env, FFMPEG_PATH: "./bin/ffmpeg", FFPROBE_PATH: "./bin/ffprobe" };
  const c = caption([video, "--words", words, "--out", "out-chrome"], { cwd: where, env });
  assert.equal(c.drawnWith, "chrome");
  if (/ subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) {
    const plain = caption([video, "--words", words, "--libass", "--out", "out-plain"], { cwd: where, env: { ...env, CHROME_PATH: "/nonexistent/chrome" } });
    assert.ok(fs.statSync(path.join(where, "out-plain", "sheet.png")).size > 0, plain.notes.join(" | "));
  }
});

test("a line wider than the safe space comes out smaller with libass and in captions.ass, by Chrome's measure where Chrome drew it", { skip }, () => {
  const gray = out("gray-vertical.mp4");
  if (!fs.existsSync(gray)) h.ffmpeg(["-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=25:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", gray]);
  const words = h.write("too-wide.json", { words: [{ text: "Internationalization", start: 0.3, end: 1.2 }, { text: "matters.", start: 1.2, end: 1.8 }, { text: "makersmcp.com/kits/easycaptionkit", start: 2.0, end: 2.9 }] });
  const scaled = (folder) => fs.readFileSync(path.join(folder, "captions.ass"), "utf8").split("\n").filter((l) => l.startsWith("Dialogue:") && /\\fscx\d+\\fscy\d+/.test(l)).length;
  const libass = / subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout);
  for (const [name, extra] of [["chrome", []], ...(libass ? [["libass", ["--libass"]]] : [])]) {
    const folder = out(`too-wide-${name}`);
    const c = caption([gray, "--words", words, "--style", "line", "--for", "reels", "--out", folder, ...extra]);
    const L = c.layout;
    for (const cue of c.cues) {
      const { left, right } = inkAt(path.join(folder, "captioned.mp4"), (cue.start + cue.end) / 2, 1080, 1920);
      if (right < 0) continue;
      assert.ok(left >= L.side - 1 && right <= 1080 - L.side, `${name}, "${cue.text}": caption pixels from x ${left} to ${right}, safe space from ${L.side} to ${1080 - L.side}`);
    }
    assert.ok(scaled(folder) >= 1, `${name}: captions.ass draws the long line smaller`);
    assert.ok(c.notes.some((n) => (name === "libass" ? /a line longer than the safe space takes at \d+ px, by an estimate of the letters' width, so libass drew (it|them) smaller/ : /wider than the safe space and drawn smaller to fit/).test(n)), `${name}: ${c.notes.join(" | ")}`);
  }
  // captions.ass of a subtitles run draws it smaller too, and says so.
  const subs = caption(["subtitles", words, "--for", "reels", "--style", "line", "--out", out("too-wide-subs")]);
  assert.ok(scaled(out("too-wide-subs")) >= 1);
  assert.ok(subs.notes.some((n) => /of captions\.ass (has|have) a line longer than the safe space takes at \d+ px, by an estimate of the letters' width, so captions\.ass draws (it|them) smaller/.test(n)), subs.notes.join(" | "));
});

test("a stopped run ends its ffmpeg and Chrome and leaves no Chrome profile; Chrome starts under a long TMPDIR", { skip: (skip || (process.platform !== "linux" && "needs Linux's ps")) }, async () => {
  const tmp = path.join(h.dir, "a-temporary-folder-whose-path-is-long-enough-to-trouble-chrome");
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp };
  const long = out("long-video.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=720x1280:r=30:d=40", "-f", "lavfi", "-i", "sine=d=40", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", long]);
  const many = h.write("many-words.json", { words: h.evenWords(Array.from({ length: 300 }, (_, i) => `w${i}`).join(" "), { start: 0.1, each: 0.1, gap: 0.03 }) });
  const children = (pid) => spawnSync("ps", ["-o", "pid=,comm=", "--ppid", String(pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map((l) => ({ pid: Number(l.trim().split(/\s+/)[0]), name: l.trim().split(/\s+/)[1] }));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const stopAt = (folder, phase, signal) =>
    new Promise((resolve) => {
      const child = require("node:child_process").spawn(process.execPath, [h.CLI, long, "--words", many, "--out", folder], { env, stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      let sent = false;
      let kids = [];
      child.stderr.on("data", (d) => {
        err += d;
        if (!sent && phase.test(err)) {
          sent = true;
          setTimeout(() => {
            kids = children(child.pid);
            child.kill(signal);
          }, 1500);
        }
      });
      child.on("exit", (code, signal) => resolve({ code, signal, kids, err }));
    });
  for (const [phase, signal, name] of [[/Encoding/, "SIGTERM", "encode"], [/in Chrome/, "SIGTERM", "draw"], [/in Chrome/, "SIGINT", "draw-int"]]) {
    const folder = out(`stopped-${name}`);
    const r = await stopAt(folder, phase, signal);
    // It ends by the signal, as a program stopped that way does, and says the folder is as it was.
    assert.equal(r.signal, signal, `${name}: exit ${r.code}, ${r.err}`);
    assert.equal(r.err.trim().split("\n").pop(), `easycaptionkit: stopped, so ${folder} is as it was`, name);
    assert.ok(r.kids.length > 0, `${name}: the run had a program going`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const kid of r.kids) assert.equal(alive(kid.pid), false, `${name}: ${kid.name} (${kid.pid}) is still running`);
    assert.deepEqual(chromesUnder(tmp), [], `${name}: a helper of Chrome is still running`);
    assert.equal(fs.existsSync(folder), false, `${name}: the folder it made is gone`);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("easycaptionkit-chrome-")), [], `${name}: a Chrome profile was left`);
  }
  // Ctrl-C in a shell loop over videos stops the loop, not just this video:
  // bash goes on to the next one unless its program died by SIGINT.
  const loop = await new Promise((resolve) => {
    const script = `for i in 1 2 3; do echo "start $i"; "${process.execPath}" "${h.CLI}" "${long}" --words "${many}" --out "${out("loop")}-$i"; done`;
    const sh = require("node:child_process").spawn("bash", ["-c", script], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let said = "";
    let err = "";
    let sent = false;
    sh.stdout.on("data", (d) => (said += d));
    sh.stderr.on("data", (d) => {
      err += d;
      if (!sent && /in Chrome/.test(err)) {
        sent = true;
        setTimeout(() => process.kill(-sh.pid, "SIGINT"), 1500);
      }
    });
    sh.on("exit", (code, signal) => resolve({ code, signal, said }));
  });
  assert.equal(loop.said.trim(), "start 1", `the loop went on: ${loop.said}`);
  assert.equal(loop.signal, "SIGINT");
  // Under the same long TMPDIR, a whole run draws with Chrome.
  const ok = h.run([h.video({ width: 360, height: 640, seconds: 2 }), "--words", h.write("long-tmp.json", { words: h.evenWords("drawn under a long temporary folder") }), "--out", out("long-tmp"), "--json"], { env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("easycaptionkit-chrome-")), []);
});

// The processes whose command line names `text`, as an ffmpeg names the
// file it writes and Chrome its profile.
function holding(text) {
  const found = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const command = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      if (command.includes(text) && !/^(?:\S*\/)?node /.test(command)) found.push(Number(name));
    } catch {
      // Gone while it was read.
    }
  }
  return found;
}

test("a run whose output goes away while it runs, as with head, ends as it would with its files in place, and a process ended by an error nothing caught leaves no ffmpeg, Chrome, profile or folder behind", { skip: (skip || (process.platform !== "linux" && "needs Linux's /proc")) }, async () => {
  const tmp = path.join(h.dir, "gone-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp };
  const video = h.video({ width: 720, height: 1280, seconds: 6 });
  const words = h.write("gone.json", { words: h.evenWords(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "), { start: 0.1, each: 0.1, gap: 0.03 }) });
  const profiles = () => fs.readdirSync(tmp).filter((n) => n.startsWith("easycaptionkit-chrome-"));
  // stdout and stderr both go away once the encode starts, as `2>&1 | head -2` makes them.
  const folder = out("gone-pipes");
  const r = await new Promise((resolve) => {
    const child = require("node:child_process").spawn(process.execPath, [h.CLI, video, "--words", words, "--out", folder], { env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d;
      if (/Encoding/.test(err)) {
        child.stdout.destroy();
        child.stderr.destroy();
      }
    });
    child.on("exit", (code, signal) => resolve({ code, signal, err }));
  });
  assert.equal(r.code, 0, `exit ${r.code} ${r.signal}: ${r.err}`);
  assert.deepEqual(files(folder), ["CAPTIONS.md", "captioned.mp4", "captions.ass", "captions.json", "captions.srt", "captions.vtt", "safe-zones.png", "sheet.png", "words.json"]);
  assert.deepEqual(profiles(), []);
  // An error nothing catches, thrown while Chrome draws and while ffmpeg encodes.
  const hook = h.write("throw-hook.js", 'const cp = require("node:child_process");\nconst spawn = cp.spawn;\ncp.spawn = function (file, args, ...rest) {\n  const child = spawn.call(this, file, args, ...rest);\n  if (Array.isArray(args) && args.includes(process.env.THROW_AT)) setTimeout(() => { throw new Error(`thrown while ${process.env.THROW_AT} ran`); }, 300);\n  return child;\n};\n');
  for (const [at, name] of [["--remote-debugging-pipe", "draw"], ["-filter_complex", "encode"]]) {
    const where = out(`thrown-${name}`);
    const t = spawnSync(process.execPath, ["--require", hook, h.CLI, video, "--words", words, "--out", where], { env: { ...env, THROW_AT: at }, encoding: "utf8", timeout: 300_000 });
    assert.notEqual(t.status, 0, name);
    assert.match(t.stderr, new RegExp(`thrown while ${at} ran`), name);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const left = [...holding(where), ...holding(tmp)];
    for (const pid of left) process.kill(pid, "SIGKILL");
    assert.deepEqual(left, [], `${name}: a program of the run is still going`);
    assert.equal(fs.existsSync(where), false, `${name}: the folder the run made is still there: ${fs.existsSync(where) ? fs.readdirSync(where).join(", ") : ""}`);
    assert.deepEqual(profiles(), [], `${name}: a Chrome profile was left`);
  }
});

// Every process that holds a Chrome profile under `tmp`, as Chrome's
// helpers do and its crash handlers, whose database is in the profile,
// with its parent and process group, and whether it is a helper, which
// names its --type. Chrome writes its command line over as one line, so
// it is searched as text.
function chromesUnder(tmp) {
  const found = [];
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const command = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      if (!command.includes(`--user-data-dir=${tmp}`) && !command.includes(`--database=${tmp}`)) continue;
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      found.push({ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), helper: / --type=/.test(command) });
    } catch {
      // Gone while it was read.
    }
  }
  return found;
}

test("Chrome runs in the kit's process group, so a supervisor that keeps that group, as makersmcp's sweep does, keeps its Chrome", { skip: (skip || (process.platform !== "linux" && "needs Linux's /proc")) }, async () => {
  const tmp = path.join(h.dir, "group-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const video = blackVideo("black-group.mp4", { width: 360, height: 640, seconds: 6 });
  const words = h.write("group.json", { words: h.evenWords(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" "), { start: 0.1, each: 0.1, gap: 0.03 }) });
  // The kit leads a session and process group of its own, as under
  // makersmcp's supervisor. Every process of its Chrome outside that group
  // is killed while it runs, as run-kit sweep does when another job ends:
  // the browser, the kit's own child, and each helper it starts, which
  // names its --type. Its crash handlers start sessions of their own and
  // end once Chrome is gone, and a process it has forked and not yet
  // started its program in still shows the browser's command line.
  const r = await new Promise((resolve) => {
    const child = require("node:child_process").spawn(process.execPath, [h.CLI, video, "--words", words, "--out", out("group")], { env: { ...process.env, TMPDIR: tmp }, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const seen = new Set();
    let swept = 0;
    const timer = setInterval(() => {
      for (const p of chromesUnder(tmp)) {
        seen.add(p.pid);
        if (p.group === child.pid || !(p.parent === child.pid || p.helper)) continue;
        try {
          process.kill(p.pid, "SIGKILL");
          swept++;
        } catch {
          // Gone already.
        }
      }
    }, 25);
    child.on("exit", (code) => {
      clearInterval(timer);
      resolve({ code, err, seen, swept });
    });
  });
  assert.equal(r.swept, 0, `${r.swept} processes of Chrome were outside the kit's process group: ${r.err}`);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.seen.size > 1, "Chrome and its helpers were seen");
  assert.deepEqual(chromesUnder(tmp), [], "a process of Chrome is left");
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("easycaptionkit-chrome-")), []);
});

test("a Chrome profile a run killed outright left in the temporary folder goes as the next Chrome starts, once no process names it and it has not changed for a day", { skip: process.platform === "win32" && "needs POSIX command lines" }, async () => {
  const { clearOldProfiles } = require("../skills/easycaptionkit/scripts/lib/chrome");
  const { spawn } = require("node:child_process");
  const tmp = out("old-profiles");
  fs.mkdirSync(tmp, { recursive: true });
  const profile = (name, days) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Local State"), "{}");
    const then = new Date(Date.now() - days * 24 * 3600 * 1000);
    fs.utimesSync(dir, then, then);
    return dir;
  };
  const stale = profile("easycaptionkit-chrome-Old001", 2);
  const fresh = profile("easycaptionkit-chrome-New001", 0.5);
  const busy = profile("easycaptionkit-chrome-Use001", 2);
  const other = profile("easycaptionkit-chrome-of-another-name", 2);
  // A Chrome still going names its profile on its command line: node takes what follows -- as the script's.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", `--user-data-dir=${busy}`], { stdio: "ignore" });
  try {
    // Once its command line shows, as Linux's /proc has it; elsewhere a moment.
    const named = () => {
      try {
        return fs.readFileSync(`/proc/${holder.pid}/cmdline`, "latin1").includes(path.basename(busy));
      } catch {
        return null;
      }
    };
    for (let waited = 0; waited < 10_000 && named() === false; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    if (process.platform === "linux") assert.equal(named(), true, "the process that names the profile is not going");
    else await new Promise((resolve) => setTimeout(resolve, 1000));
    clearOldProfiles(tmp);
    assert.equal(fs.existsSync(stale), false);
    for (const kept of [fresh, busy, other]) assert.ok(fs.existsSync(kept), kept);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("closing Chrome, or stopping the run, ends every process that holds its profile, and the profile goes", { skip: (skip || (process.platform !== "linux" && "needs Linux's /proc")) }, async () => {
  const { launch } = require("../skills/easycaptionkit/scripts/lib/chrome");
  const { stopAll } = require("../skills/easycaptionkit/scripts/lib/running");
  const tmp = path.join(h.dir, "close-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const before = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  // Chrome started through a script that writes down the environment it is given.
  const named = process.env.CHROME_PATH;
  const told = path.join(h.dir, "chrome-environment.txt");
  const wrapper = path.join(h.dir, "environment-chrome", "chrome");
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\nenv > "${told}"\nexec "${findChrome()}" "$@"\n`, { mode: 0o755 });
  process.env.CHROME_PATH = wrapper;
  try {
    const browser = await launch({ width: 320, height: 240 });
    await (await browser.page()).call("Page.navigate", { url: "about:blank" });
    assert.ok(chromesUnder(tmp).length > 1, "Chrome started helpers");
    // Chrome keeps its crash reports where its config would be, not in the profile it is given:
    // that place is in the profile too, so a dump goes with it, and the user's own Chrome keeps none of the kit's.
    const kit = chromesUnder(tmp).find((p) => p.parent === process.pid);
    const profile = /--user-data-dir=(\S+)/.exec(fs.readFileSync(`/proc/${kit.pid}/cmdline`, "utf8").replace(/\0/g, " "))[1];
    assert.ok(fs.readFileSync(told, "utf8").split("\n").includes(`CHROME_CONFIG_HOME=${path.join(profile, "config")}`), fs.readFileSync(told, "utf8"));
    const handlers = holding("--database=").map((pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ")).filter((command) => command.includes(path.basename(profile)));
    for (const command of handlers) assert.ok(command.includes(`--database=${path.join(profile, "config")}${path.sep}`), command);
    await browser.close();
    assert.deepEqual(chromesUnder(tmp), []);
    assert.equal(fs.existsSync(profile), false);
    if (named === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = named;
    await launch({ width: 320, height: 240 });
    assert.ok(chromesUnder(tmp).length > 1);
  } finally {
    stopAll();
    // An unset TMPDIR stays unset: one set to undefined is the folder "undefined".
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    if (named === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = named;
  }
  assert.deepEqual(chromesUnder(tmp), []);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith("easycaptionkit-chrome-")), []);
});

test("a run stopped while the same Ctrl-C ends its ffmpeg first says it was stopped, as JSON on stdout too with --json, and ends by the signal", { skip: (!h.hasFfmpeg && "needs ffmpeg") || (process.platform === "win32" && "needs a shell script for ffmpeg") }, async function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const video = blackVideo("black-group-int.mp4", { width: 360, height: 640, seconds: 2 });
  const words = h.write("group-int.json", { words: h.evenWords("stopped by the same key", { start: 0.2 }) });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, "group-int-bin", "ffmpeg");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  // The encode stops the whole process group, as Ctrl-C in a terminal does, and goes at once.
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "-filter_complex" ]; then kill -INT 0; exit 1; fi\ndone\nexec "${real}" "$@"\n`, { mode: 0o755 });
  for (const json of [false, true]) {
    const folder = out(`stopped-group${json ? "-json" : ""}`);
    const r = await new Promise((resolve) => {
      const child = require("node:child_process").spawn(process.execPath, [h.CLI, video, "--words", words, "--libass", "--out", folder, ...(json ? ["--json"] : [])], { env: { ...process.env, FFMPEG_PATH: fake }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    assert.equal(r.signal, "SIGINT", `exit ${r.code}: ${r.stderr}`);
    assert.equal(r.stderr.trim().split("\n").pop(), `easycaptionkit: stopped, so ${folder} is as it was`);
    assert.doesNotMatch(r.stderr, /could not write/);
    if (json) assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: `stopped, so ${folder} is as it was` });
    assert.equal(fs.existsSync(folder), false);
  }
});

test("a run that fails while ffmpeg takes the sheet's frames ends the others before it goes", { skip: (skip || (process.platform === "win32" && "needs a shell script for ffmpeg")) }, () => {
  const video = blackVideo("black-pool.mp4", { width: 360, height: 640, seconds: 6 });
  const words = h.write("pool.json", { words: Array.from({ length: 10 }, (_, i) => ({ word: `w${i}.`, start: 0.1 + i * 0.5, end: 0.4 + i * 0.5 })) });
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, "pool-bin", "ffmpeg");
  const pids = path.join(h.dir, "pool-bin", "pids");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  // The second frame fails at once; the others wait 4 s first.
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\ncase "$last" in\n  *sheet-002.png) echo "no frame, as a test" >&2; exit 1 ;;\n  *sheet-0*.png) echo $$ >> "${pids}"; sleep 4 ;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const r = h.run([video, "--words", words, "--lines", "1", "--max-chars", "8", "--out", out("pool")], { env: { ...process.env, FFMPEG_PATH: fake } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no frame, as a test/);
  const started = fs.readFileSync(pids, "utf8").trim().split("\n").map(Number);
  assert.ok(started.length > 0, "frames were being taken");
  // A process the kit killed still answers until the system reaps it, which
  // a busy machine can take a moment to do: one that has exited and waits
  // to be reaped (state Z) is gone, and the others get two seconds.
  const going = (pid) => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return process.platform !== "linux";
    }
  };
  let alive = started.filter(going);
  for (const until = Date.now() + 2000; alive.length && Date.now() < until; alive = alive.filter(going)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  assert.deepEqual(alive, [], "an ffmpeg is still taking a frame");
  assert.equal(fs.existsSync(out("pool")), false);
});

test("a video whose color tags are values no standard gives, which ffprobe calls reserved, or a log transfer or a matrix such as YCgCo, is captioned, in full range, 4:2:2 and 10 bits too, which ffmpeg 8 has to convert: setparams gets only the names it takes", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  const { optionNames, colorOf } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  // The names setparams takes, from its help as ffmpeg 4.4 (two spaces in) and 8 (three) print it.
  for (const indent of ["  ", "   "]) {
    const help = `setparams AVOptions:\n${indent}color_primaries   <int>        ..FV....... select color primaries (from -1 to 22) (default auto)\n     auto            -1           ..FV....... keep the same color primaries\n     bt709           1            ..FV.......\n     unknown         2            ..FV.......\n${indent}colorspace        <int>        ..FV....... select colorspace (from -1 to 14) (default auto)\n     bt709           1            ..FV.......\n     chroma-derived-nc 12           ..FV.......\n`;
    const names = optionNames(help);
    assert.deepEqual([...names.color_primaries], ["auto", "bt709", "unknown"]);
    assert.deepEqual([...names.colorspace], ["bt709", "chroma-derived-nc"]);
    // A tag by a name setparams does not take is left as the frames have it.
    assert.equal(colorOf({ height: 1080, color: { range: "tv", space: "bt709", transfer: "reserved", primaries: "reserved" } }, names).params, "colorspace=bt709:range=tv");
  }
  // Without the names, "reserved" is still left out.
  assert.equal(colorOf({ height: 1080, color: { range: "tv", space: "bt709", transfer: "reserved", primaries: "bt709" } }).params, "color_primaries=bt709:colorspace=bt709:range=tv");
  // A matrix tagged reserved is replaced as the video is read, by the matrix the captions take for its size.
  assert.deepEqual(colorOf({ height: 1080, color: { range: "tv", space: "bt709", transfer: "", primaries: "" } }).input, []);
  assert.deepEqual(colorOf({ height: 1080, color: { range: "tv", space: "reserved", transfer: "", primaries: "" } }).input, ["-colorspace", "bt709"]);
  assert.deepEqual(colorOf({ height: 640, color: { range: "tv", space: "reserved", transfer: "", primaries: "" } }).input, ["-colorspace", "smpte170m"]);
  // ffmpeg 8's scaler converts no frame tagged reserved, log100 or log316, or YCgCo: first in the chain they are unknown,
  // or the matrix the captions are converted with, and setparams gives back each by a name it takes. The others stay.
  const names8 = optionNames(spawnSync("ffmpeg", ["-hide_banner", "-h", "filter=setparams"], { encoding: "utf8" }).stdout);
  const tags = (space, transfer, primaries, height = 1080) => colorOf({ height, color: { range: "tv", space, transfer, primaries } }, names8);
  assert.equal(tags("bt709", "bt709", "bt709").retag, "");
  assert.equal(tags("bt2020nc", "smpte2084", "bt2020").retag, "");
  // A matrix the video does not name is the one the captions take, and so is a range, where ffmpeg 7.1 and newer
  // gave the overlay's two pictures one matrix and took the video's for BT.601. A picture stored as RGB is converted
  // to them in its chain.
  assert.deepEqual([tags("", "", "").retag, tags("unknown", "", "", 640).retag], ["colorspace=bt709", "colorspace=smpte170m"]);
  assert.deepEqual([colorOf({ height: 1080, color: { range: "", space: "", transfer: "", primaries: "" } }).retag, colorOf({ height: 1080, color: { range: "", space: "bt709", transfer: "", primaries: "" } }).retag], ["colorspace=bt709:range=tv", "range=tv"]);
  assert.equal(colorOf({ height: 720, pixFmt: "rgb24", color: { range: "", space: "", transfer: "", primaries: "" } }).retag, "");
  assert.equal(tags("bt709", "reserved", "reserved").retag, "color_primaries=unknown:color_trc=unknown");
  assert.deepEqual([tags("bt709", "log100", "bt709").retag, tags("bt709", "log316", "bt709").params], ["color_trc=unknown", "color_primaries=bt709:color_trc=log316:colorspace=bt709:range=tv"]);
  // YCgCo is converted with the colorspace filter, and written as the matrix it was converted to; ICtCp, which nothing converts, is kept.
  assert.deepEqual([tags("ycgco", "bt709", "bt709").retag, tags("ycgco", "bt709", "bt709").params, tags("ycgco", "", "").params], ["colorspace=bt709", "color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", "color_primaries=unknown:color_trc=unknown:colorspace=bt709:range=tv"]);
  assert.match(tags("ycgco", "bt709", "bt709").recode, /^colorspace=iprimaries=bt709:itrc=bt709:ispace=ycgco:irange=tv:primaries=bt709:trc=bt709:space=bt709:range=tv$/);
  assert.deepEqual([tags("ictcp", "smpte2084", "bt2020", 640).retag, tags("ictcp", "smpte2084", "bt2020", 640).kept, tags("ictcp", "smpte2084", "bt2020", 640).recode], ["colorspace=bt2020nc", "ictcp", ""]);
  // A matrix tagged reserved is written as the one the captions were converted with.
  assert.deepEqual([tags("reserved", "", "", 640).retag, tags("reserved", "", "", 640).params], ["colorspace=smpte170m", "colorspace=smpte170m:range=tv"]);
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const words = h.write("reserved-words.json", { words: h.evenWords("colors no standard gives", { start: 0.2 }) });
  // A picture in a pixel format of its own, a full range one, 4:2:2 or 10 bits, which has to be converted to 4:2:0.
  const source = (format, [width, height] = [360, 640]) => {
    if (format === "yuv420p") return h.video({ width, height, seconds: 2 });
    const file = out(`colors-${format}-${width}x${height}.mp4`);
    if (!fs.existsSync(file)) h.ffmpeg(["-f", "lavfi", "-i", `testsrc2=s=${width}x${height}:r=30:d=2`, "-f", "lavfi", "-i", "sine=f=440:d=2", "-c:v", "libx264", "-pix_fmt", format, "-preset", "veryfast", "-c:a", "aac", "-shortest", file]);
    return file;
  };
  const tenBit = /yuv420p10le/.test(spawnSync("ffmpeg", ["-hide_banner", "-h", "encoder=libx264"], { encoding: "utf8" }).stdout);
  // Reserved primaries and transfer, and all three tags reserved, the matrix too, which ffmpeg 8 refuses as an "Invalid color space";
  // a log transfer and YCgCo, which setparams gives back, so the pictures are taken from a captioned.mp4 that has them.
  const cases = [
    ["reserved-colors", "yuv420p", ["3", "3", "1"], [360, 640], "bt709"],
    ["reserved-matrix", "yuv420p", ["3", "3", "3"], [360, 640], "smpte170m"],
    ["reserved-matrix-hd", "yuv420p", ["3", "3", "3"], [1280, 720], "bt709"],
    ["reserved-full", "yuvj420p", ["3", "3", "3"], [360, 640], "smpte170m"],
    ["reserved-422", "yuv422p", ["3", "3", "1"], [360, 640], "bt709"],
    ...(tenBit ? [["reserved-10bit", "yuv420p10le", ["3", "3", "3"], [360, 640], "smpte170m"]] : []),
    ["log100-422", "yuv422p", ["1", "9", "1"], [360, 640], "bt709"],
    ["ycgco-full", "yuvj420p", ["1", "1", "8"], [360, 640], "smpte170m"],
  ];
  for (const [name, format, [primaries, transfer, space], size, written] of cases) {
    const tagged = out(`${name}.mp4`);
    h.ffmpeg(["-i", source(format, size), "-c", "copy", "-color_primaries", primaries, "-color_trc", transfer, "-colorspace", space, "-movflags", "+write_colr", tagged]);
    const stream = h.probe(tagged).streams.find((s) => s.codec_type === "video");
    const named = { 1: "bt709", 3: "reserved", 8: "ycgco", 9: "log100" };
    assert.deepEqual([stream.pix_fmt, stream.color_primaries, stream.color_transfer, stream.color_space], [format, named[primaries], named[transfer], named[space]], name);
    const c = caption([tagged, "--words", words, "--libass", "--out", out(name)], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
    const result = h.probe(path.join(out(name), "captioned.mp4")).streams.find((s) => s.codec_type === "video");
    assert.equal(result.color_space, written, name);
    // ffprobe leaves out a tag that says nothing.
    assert.equal(result.color_transfer || "unknown", transfer === "9" ? "log100" : transfer === "1" ? "bt709" : "unknown", name);
    assert.equal(result.color_range, format === "yuvj420p" ? "pc" : "tv", name);
    assert.ok(c.cues.length > 0);
    for (const picture of ["sheet.png", "safe-zones.png"]) assert.ok(fs.statSync(path.join(out(name), picture)).size > 0, `${name} ${picture}`);
  }
  // Chrome's captions go over the picture of a YCgCo video in 4:2:2 too, where ffmpeg 8 found no way to lay them over it.
  if (findChrome()) {
    const tagged = out("ycgco-422.mp4");
    h.ffmpeg(["-i", source("yuv422p"), "-c", "copy", "-colorspace", "8", "-movflags", "+write_colr", tagged]);
    caption([tagged, "--words", words, "--out", out("ycgco-422-chrome")]);
    assert.equal(h.probe(path.join(out("ycgco-422-chrome"), "captioned.mp4")).streams.find((s) => s.codec_type === "video").color_space, "smpte170m");
  }
});

// The color of a pixel of the frame at 0.5 s, decoded with the matrix and range given, as a player that follows them does.
function pixelAt(file, x, y, matrix, range) {
  const run = spawnSync("ffmpeg", ["-v", "error", "-ss", "0.5", "-i", file, "-frames:v", "1", "-vf", `crop=2:2:${x}:${y},scale=in_color_matrix=${matrix}:in_range=${range},format=rgb24`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  return [...run.stdout.subarray(0, 3)];
}

const near = (got, want, by, what) => assert.ok(got.length === 3 && got.every((c, i) => Math.abs(c - want[i]) <= by), `${what}: ${got} is not ${want}`);

test("a video stored as RGB, as PNG or QuickTime Animation in a MOV is, is converted with the matrix its captions take and tagged with it, and a video that names no matrix is tagged with the one its captions were converted with", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const words = h.write("rgb-words.json", { words: h.evenWords("stored as red green blue", { start: 0.2 }) });
  // A patch of 192,48,48: PNG in a MOV 1280 rows tall, which ffprobe 8 tags gbr, and QuickTime Animation 720 rows tall, which names no matrix.
  const png = out("rgb-png.mov");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=0xc03030:s=720x1280:r=30:d=2,format=rgba", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "png", "-c:a", "aac", "-shortest", png]);
  const qtrle = out("rgb-qtrle.mov");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=0xc03030:s=1280x720:r=30:d=2,format=rgb24", "-f", "lavfi", "-i", "sine=d=2", "-c:v", "qtrle", "-c:a", "aac", "-shortest", qtrle]);
  const runs = [["--libass"], ...(findChrome() ? [[]] : [])];
  for (const source of [png, qtrle]) {
    for (const extra of runs) {
      const name = `${path.basename(source, ".mov")}${extra.join("")}`;
      caption([source, "--words", words, ...extra, "--out", out(name)], { env: { ...process.env, ...(extra.length ? { CHROME_PATH: "/nonexistent/chrome" } : {}) } });
      const file = path.join(out(name), "captioned.mp4");
      const v = h.probe(file).streams.find((s) => s.codec_type === "video");
      assert.deepEqual([v.pix_fmt, v.color_space, v.color_range], ["yuv420p", "bt709", "tv"], name);
      near(pixelAt(file, 40, 40, "bt709", "tv"), [192, 48, 48], 4, name);
      const c = JSON.parse(fs.readFileSync(path.join(out(name), "captions.json"), "utf8"));
      assert.ok(c.notes.some((n) => /^The video's picture is stored as RGB \((?:rgb24|rgba|argb|bgra)\); it was written as 8-bit 4:2:0, with the BT\.709 matrix, which every app takes\.$/.test(n)), `${name}: ${c.notes.join(" | ")}`);
    }
  }
  // A plain video that names no matrix says the one players take for its size, which its captions were converted with.
  caption([h.video({ width: 360, height: 640, seconds: 2 }), "--words", words, "--libass", "--out", out("no-matrix")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
  assert.equal(h.probe(path.join(out("no-matrix"), "captioned.mp4")).streams.find((s) => s.codec_type === "video").color_space, "smpte170m");
});

// How a color is coded in a matrix (bt601 or bt709) and range (tv or pc), in 8 bits.
function coding(hex, matrix, range) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [kr, kb] = matrix === "bt709" ? [0.2126, 0.0722] : [0.299, 0.114];
  const y = kr * r + (1 - kr - kb) * g + kb * b;
  const [u, v] = [(b - y) / (2 * (1 - kb)), (r - y) / (2 * (1 - kr))];
  return range === "pc" ? [255 * y, 128 + 255 * u, 128 + 255 * v].map(Math.round) : [16 + 219 * y, 128 + 224 * u, 128 + 224 * v].map(Math.round);
}

// In the frame of a black 8-bit 4:2:0 video at t, read as it is stored: the coding of the lit word, the one color of the
// frame, as the median luma and color differences of the blocks of four pixels inside its letters, and the brightest
// luma, the captions' white.
function captionCoding(file, t, width, height) {
  const buf = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-"], { maxBuffer: 1 << 28 }).stdout;
  const found = [[], [], []];
  let white = 0;
  const [ys, cw, cs] = [width * height, width / 2, (width / 2) * (height / 2)];
  for (let y = 0; y < height - 1; y += 2) {
    for (let x = 0; x < width - 1; x += 2) {
      const luma = [buf[y * width + x], buf[y * width + x + 1], buf[(y + 1) * width + x], buf[(y + 1) * width + x + 1]];
      white = Math.max(white, ...luma);
      const [u, v] = [buf[ys + (y / 2) * cw + x / 2], buf[ys + cs + (y / 2) * cw + x / 2]];
      if (Math.abs(u - 128) + Math.abs(v - 128) < 40 || Math.min(...luma) < 60 || Math.max(...luma) - Math.min(...luma) > 4) continue;
      [Math.round(luma.reduce((a, b) => a + b) / 4), u, v].forEach((c, i) => found[i].push(c));
    }
  }
  const median = (list) => list.sort((a, b) => a - b)[list.length >> 1];
  return { lit: found[0].length ? found.map(median) : [], white };
}

test("libass draws the captions' colors as the video's own matrix and range code them, and captions.ass names them, on a 360p BT.709 video, a 1080p BT.601 one and a full range one, on ffmpeg 8 and on 4.4, whose ass filter takes BT.601 whatever it is told", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const { colorOf, matrixLine, as601 } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  // The YCbCr Matrix line: the video's own, or for BT.2020, RGB, YCgCo or ICtCp, None, with which a player takes the video's.
  assert.deepEqual([matrixLine("bt709", "tv"), matrixLine("bt601", "pc"), matrixLine("bt2020", "tv")], ["TV.709", "PC.601", "None"]);
  const tagged = (space, extra = {}) => colorOf({ height: 1080, pixFmt: "yuv420p", color: { space, range: "tv", primaries: "", transfer: "", ...extra } }).header;
  assert.deepEqual([tagged("bt709"), tagged("smpte170m"), tagged(""), tagged("bt2020nc"), tagged("ycgco"), tagged("ictcp"), colorOf({ height: 1080, pixFmt: "rgb24", color: { space: "", range: "", primaries: "", transfer: "" } }).header], ["TV.709", "TV.601", "TV.709", "None", "None", "None", "None"]);
  // For an ass filter that takes BT.601: the color whose BT.601 coding is the color's BT.709 coding, and for a pure green,
  // which none is, the nearest.
  const yellow = as601("#ffd23f", "bt709");
  assert.deepEqual(yellow.shown, "#ffd23f");
  coding(yellow.hex, "bt601", "tv").forEach((c, i) => assert.ok(Math.abs(c - coding("#ffd23f", "bt709", "tv")[i]) <= 1, `${yellow.hex}: ${coding(yellow.hex, "bt601", "tv")}`));
  assert.notEqual(as601("#00ff00", "bt709").shown, "#00ff00");
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const words = h.write("matrix-words.json", { words: [{ word: "Captions", start: 0.2, end: 0.9 }, { word: "LOOK", start: 0.9, end: 1.4 }, { word: "right", start: 1.4, end: 1.9 }] });
  // A red whose BT.601 and BT.709 codings are 14 apart in luma.
  const red = "#ff3b30";
  const cases = [
    ["small-709", 640, 360, "yuv420p", ["-colorspace", "bt709", "-color_range", "tv"], "bt709", "tv", "TV.709"],
    ["big-601", 1920, 1080, "yuv420p", ["-colorspace", "smpte170m", "-color_range", "tv"], "bt601", "tv", "TV.601"],
    ["full-709", 720, 1280, "yuvj420p", ["-colorspace", "bt709", "-color_range", "pc"], "bt709", "pc", "PC.709"],
  ];
  for (const [name, width, height, format, tags, matrix, range, line] of cases) {
    const video = out(`matrix-${name}.mp4`);
    h.ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${width}x${height}:r=30:d=2`, "-f", "lavfi", "-i", "sine=d=2", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", format, ...tags, "-c:a", "aac", "-shortest", video]);
    caption([video, "--words", words, "--libass", "--highlight", red, "--size", "12", "--out", out(`matrix-${name}`)], env);
    const folder = out(`matrix-${name}`);
    assert.match(fs.readFileSync(path.join(folder, "captions.ass"), "utf8"), new RegExp(`^YCbCr Matrix: ${line.replace(".", "\\.")}$`, "m"), name);
    // LOOK is lit at 1.1 s.
    const { lit, white } = captionCoding(path.join(folder, "captioned.mp4"), 1.1, width, height);
    const want = coding(red, matrix, range);
    assert.ok(lit.length && lit.every((c, i) => Math.abs(c - want[i]) <= 3), `${name}: the lit word is coded ${lit}, and ${red} is ${want} in ${matrix} ${range}`);
    assert.ok(range === "pc" ? white >= 250 : white >= 230 && white <= 250, `${name}: the captions' white is ${white}`);
  }
  // A subtitles run with the video names its matrix and range too.
  caption(["subtitles", words, "--video", out("matrix-big-601.mp4"), "--out", out("matrix-big-601-subtitles")]);
  assert.match(fs.readFileSync(path.join(out("matrix-big-601-subtitles"), "captions.ass"), "utf8"), /^YCbCr Matrix: TV\.601$/m);
});

test("the note says what the picture loses on its way to 8-bit 4:2:0: a 12-bit 4:4:4 or 4:2:2 video says both, an 8-bit 4:4:4 one its sampling, and an 8-bit NV12 one nothing, where nv12 read as 10-bit", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const words = h.write("formats-words.json", { words: h.evenWords("every format says what it lost", { start: 0.2 }) });
  const cases = [
    ["ffv1-444-12.mkv", ["-c:v", "ffv1", "-pix_fmt", "yuv444p12le"], "The video is 12-bit 4:4:4; it was written as 8-bit 4:2:0, which every app takes."],
    ["ffv1-422-12.mkv", ["-c:v", "ffv1", "-pix_fmt", "yuv422p12le"], "The video is 12-bit 4:2:2; it was written as 8-bit 4:2:0, which every app takes."],
    ["x264-444.mp4", ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv444p"], "The video is 4:4:4; it was written as 4:2:0, which every app takes."],
    ["raw-nv12.nut", ["-c:v", "rawvideo", "-pix_fmt", "nv12"], ""],
  ];
  for (const [name, args, note] of cases) {
    const file = out(`format-${name}`);
    h.ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=360x640:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", ...args, "-c:a", name.endsWith(".mp4") ? "aac" : "pcm_s16le", "-shortest", file]);
    const c = caption([file, "--words", words, "--libass", "--out", out(`format-${name.replace(/\./g, "-")}`)], env);
    const said = c.notes.filter((n) => /-bit|4:[0-4]:[0-4]/.test(n));
    assert.deepEqual(said, note ? [note] : [], name);
  }
});

// The types of a PNG's chunks, in order.
function pngChunks(file) {
  const buf = fs.readFileSync(file);
  const types = [];
  for (let at = 8; at + 12 <= buf.length; at += 12 + buf.readUInt32BE(at)) types.push(buf.toString("latin1", at + 4, at + 8));
  return types;
}

// The color of one pixel of a picture.
const pictureAt = (file, x, y) => [...spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=1:1:${x}:${y},format=rgb24`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 }).stdout];

test("sheet.png and safe-zones.png show an HD video's colors as players show them: its frames go to Chrome as PNG, not as a JPEG of the BT.709 picture, which Chrome reads as BT.601, and a PNG that names no primaries or transfer, which Chrome converts its colors by", { skip }, () => {
  // 192,48,48 all over, coded BT.709 and tagged BT.709 in its primaries, transfer and matrix, as launch-film writes its films and phones record, 720x1280.
  const red = out("red-709.mp4");
  h.ffmpeg(["-f", "lavfi", "-i", "color=c=0xc03030:s=720x1280:r=30:d=2,format=rgb24", "-f", "lavfi", "-i", "sine=d=2", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv", "-c:v", "libx264", "-preset", "veryfast", "-crf", "10", "-c:a", "aac", "-shortest", red]);
  const v = h.probe(red).streams.find((s) => s.codec_type === "video");
  assert.deepEqual([v.color_primaries, v.color_transfer, v.color_space, v.color_range], ["bt709", "bt709", "bt709", "tv"]);
  const words = h.write("red-words.json", { words: h.evenWords("red as it is", { start: 0.2 }) });
  const c = caption([red, "--words", words, "--out", out("red-709")]);
  assert.equal(c.cues.length, 1);
  // The first frame of the sheet is 240 px wide, 24 px in from its top left corner; a point well above the captions. In
  // safe-zones.png, a point of the first phone clear of its margins and buttons.
  near(pictureAt(path.join(out("red-709"), "sheet.png"), 144, 174), [192, 48, 48], 4, "sheet.png");
  near(pictureAt(path.join(out("red-709"), "safe-zones.png"), 120, 200), [192, 48, 48], 4, "safe-zones.png");
  // The pictures ffmpeg makes without Chrome name none either, so a viewer shows them as they are.
  caption([red, "--words", words, "--libass", "--out", out("red-709-plain")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
  for (const picture of ["sheet.png", "safe-zones.png"]) assert.deepEqual(pngChunks(path.join(out("red-709-plain"), picture)).filter((type) => ["cICP", "cHRM", "gAMA", "sRGB", "iCCP"].includes(type)), [], picture);
});

test("a YCgCo video's picture is converted to the matrix its captions take, which captioned.mp4 says, and one in ICtCp, which nothing converts, keeps its matrix and says the captions' colors are coded for another", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const env = { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } };
  const words = h.write("ycgco-words.json", { words: h.evenWords("coded in green and orange", { start: 0.2 }) });
  // A picture coded in YCgCo, in TV range: 255,210,63 above, 26,107,69 below.
  const coded = ([r, g, b]) => [0.25 * r + 0.5 * g + 0.25 * b, -0.25 * r + 0.5 * g - 0.25 * b, 0.5 * r - 0.5 * b].map((c, i) => Math.round(i ? 128 + (224 * c) / 255 : 16 + (219 * c) / 255));
  const [top, bottom] = [coded([255, 210, 63]), coded([26, 107, 69])];
  const raw = out("ycgco.yuv");
  fs.writeFileSync(raw, Buffer.concat([0, 1, 2].map((p) => Buffer.concat([Buffer.alloc(360 * 320, top[p]), Buffer.alloc(360 * 320, bottom[p])]))));
  const ycgco = out("true-ycgco.mp4");
  h.ffmpeg(["-f", "rawvideo", "-pix_fmt", "yuv444p", "-s", "360x640", "-r", "30", "-i", raw, "-f", "lavfi", "-i", "sine=d=2", "-vf", "loop=loop=59:size=1:start=0,setparams=colorspace=bt709:range=tv,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-bsf:v", "h264_metadata=matrix_coefficients=8", "-c:a", "aac", "-t", "2", ycgco]);
  assert.equal(h.probe(ycgco).streams.find((s) => s.codec_type === "video").color_space, "ycgco");
  const c = caption([ycgco, "--words", words, "--libass", "--out", out("true-ycgco")], env);
  const file = path.join(out("true-ycgco"), "captioned.mp4");
  assert.equal(h.probe(file).streams.find((s) => s.codec_type === "video").color_space, "smpte170m");
  near(pixelAt(file, 40, 40, "bt601", "tv"), [255, 210, 63], 5, "above");
  near(pixelAt(file, 40, 400, "bt601", "tv"), [26, 107, 69], 5, "below");
  assert.ok(!c.notes.some((n) => /color matrix is/.test(n)), c.notes.join(" | "));
  // ICtCp: kept, and said.
  const ictcp = out("ictcp.mp4");
  h.ffmpeg(["-i", h.video({ width: 360, height: 640, seconds: 2 }), "-c", "copy", "-bsf:v", "h264_metadata=matrix_coefficients=14", ictcp]);
  const i = caption([ictcp, "--words", words, "--libass", "--out", out("ictcp")], env);
  assert.equal(h.probe(path.join(out("ictcp"), "captioned.mp4")).streams.find((s) => s.codec_type === "video").color_space, "ictcp");
  assert.ok(i.notes.includes("The video's color matrix is ICtCp, which ffmpeg converts no colors into, so captioned.mp4 keeps it, and the captions' colors are coded in BT.601: a player that follows the video's matrix shows the captions in other colors."), i.notes.join(" | "));
});

test("Chrome's captions over an HD video that names no matrix, as a browser's recording and many clips ffmpeg makes do, are coded BT.709, as players take the video, and its own picture keeps its coding, in 4:4:4 and in full range too, where ffmpeg 7.1 and newer took the picture for BT.601 and converted the captions or the picture", { skip }, () => {
  const words = h.write("unnamed-words.json", { words: h.evenWords("named no matrix", { start: 0.2 }) });
  // One 1280x720 frame written raw, so nothing names its matrix: black, or 192,48,48 coded BT.709 above black, in 4:4:4,
  // and in full range 4:2:0. Each plane is the rows of the color above, then black's.
  const unnamed = (name, format, range, top) => {
    const black = range === "pc" ? [0, 128, 128] : [16, 128, 128];
    const planes = format === "yuv444p" ? [[1280, 720], [1280, 720], [1280, 720]] : [[1280, 720], [640, 360], [640, 360]];
    const raw = out(`${name}.yuv`);
    fs.writeFileSync(raw, Buffer.concat(planes.map(([w, rows], p) => Buffer.concat([Buffer.alloc((w * rows) / 2, top ? top[p] : black[p]), Buffer.alloc((w * rows) / 2, black[p])]))));
    const file = out(`${name}.mp4`);
    h.ffmpeg(["-f", "rawvideo", "-pix_fmt", format, "-s", "1280x720", "-r", "30", "-i", raw, "-f", "lavfi", "-i", "sine=d=2", "-vf", "loop=loop=59:size=1:start=0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "8", "-pix_fmt", format, "-c:a", "aac", "-t", "2", file]);
    const v = h.probe(file).streams.find((s) => s.codec_type === "video");
    assert.deepEqual([v.color_space, v.color_primaries, v.color_range === "pc"], [undefined, undefined, range === "pc"], name);
    return file;
  };
  // The lit word of a plain 8-bit 4:2:0 one.
  const red = "#ff3b30";
  caption([unnamed("unnamed-420", "yuv420p", "tv", null), "--words", words, "--highlight", red, "--out", out("unnamed-420")]);
  const { lit } = captionCoding(path.join(out("unnamed-420"), "captioned.mp4"), 0.4, 1280, 720);
  const want = coding(red, "bt709", "tv");
  assert.ok(lit.length && lit.every((c, i) => Math.abs(c - want[i]) <= 3), `the lit word is coded ${lit}, and ${red} is ${want} in BT.709`);
  // The picture of a 4:4:4 one and a full range one, which go through the scaler.
  for (const [name, format, range] of [["unnamed-444", "yuv444p", "tv"], ["unnamed-full", "yuvj420p", "pc"]]) {
    const video = unnamed(name, format, range, coding("#c03030", "bt709", range));
    near(pixelAt(video, 40, 40, "bt709", range), [192, 48, 48], 4, `${name} as made`);
    caption([video, "--words", words, "--out", out(name)]);
    const file = path.join(out(name), "captioned.mp4");
    const v = h.probe(file).streams.find((s) => s.codec_type === "video");
    assert.deepEqual([v.color_space, v.color_range], ["bt709", range], name);
    near(pixelAt(file, 40, 40, "bt709", range), [192, 48, 48], 4, name);
  }
});

test("why ffmpeg 6.1 failed: the line that names the option a filter refused, not Error initializing a simple filtergraph, which it prints after that line", () => {
  const { whyFailed } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  // What ffmpeg 6.1, Ubuntu 24.04's and ubuntu-latest's, printed when the
  // loudness meter in musicfit's -af refused a framelog value, copied from
  // musicfit's tests.
  const said = fs.readFileSync(path.join(h.FIXTURES, "stderr", "framelog-6.1.txt"), "utf8");
  assert.match(said, /\] Error initializing a simple filtergraph\n/);
  assert.equal(whyFailed({ code: 234, signal: null, stderr: said }), "Error applying option 'framelog' to filter 'ebur128': Invalid argument");
});

test("why ffmpeg failed: the line that names the filter or option, not the closing lines after it, and the signal that stopped it, as SIGKILL when memory runs out, or the SIGTERM it took itself and ended with 255 for", { skip: (!h.hasFfmpeg && "needs ffmpeg") || (process.platform === "win32" && "needs a shell script for ffmpeg") }, function () {
  const { whyFailed } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  // ffmpeg 8 and 4.4 on a color tag setparams does not take.
  const eight = "[Parsed_setparams_1 @ 0x6357] [Eval @ 0x7ffe] Undefined constant or missing '(' in 'reserved'\n[Parsed_setparams_1 @ 0x6357] Unable to parse option value \"reserved\"\n[fc#0 @ 0x6357] Error applying option 'color_primaries' to filter 'setparams': Invalid argument\nError : Invalid argument\n";
  assert.equal(whyFailed({ code: 234, signal: null, stderr: eight }), "Error applying option 'color_primaries' to filter 'setparams': Invalid argument");
  const four = "[setparams @ 0x560d] Unable to parse option value \"reserved\"\n[setparams @ 0x560d] Error setting option color_primaries to value reserved.\n[Parsed_setparams_1 @ 0x560d] Error applying options to the filter.\n[AVFilterGraph @ 0x560d] Error initializing filter 'setparams' with args 'color_primaries=reserved:range=tv'\nError initializing complex filters.\nInvalid argument\n";
  assert.equal(whyFailed({ code: 1, signal: null, stderr: four }), "Error initializing filter 'setparams' with args 'color_primaries=reserved:range=tv'");
  assert.equal(whyFailed({ code: 254, signal: null, stderr: "[out#0/mp4 @ 0x64df] Error opening output /proc/x.mp4: No such file or directory\nError opening output file /proc/x.mp4.\nError opening output files: No such file or directory\n" }), "Error opening output /proc/x.mp4: No such file or directory");
  // ffmpeg 8 on a frame its filters do not take, which ends with its encoder never opened.
  const refused = "[graph -1 input from stream 0:0 @ 0x7c53] Invalid color space\n[vf#0:0 @ 0x593c] Error reinitializing filters!\n[vf#0:0 @ 0x593c] Task finished with error code: -22 (Invalid argument)\n[vf#0:0 @ 0x593c] Terminating thread with return code -22 (Invalid argument)\n[vost#0:0/libx264 @ 0x5939] [enc:libx264 @ 0x593a] Could not open encoder before EOF\n[vost#0:0/libx264 @ 0x5939] Task finished with error code: -22 (Invalid argument)\n[vost#0:0/libx264 @ 0x5939] Terminating thread with return code -22 (Invalid argument)\n[out#0/mp4 @ 0x593b] Nothing was written into output file, because at least one of its streams received no packets.\n";
  assert.equal(whyFailed({ code: 234, signal: null, stderr: refused }), "Invalid color space");
  assert.equal(whyFailed({ code: 1, signal: null, stderr: "Invalid argument\n" }), "Invalid argument");
  assert.equal(whyFailed({ code: 1, signal: null, stderr: "" }), "it ended with code 1 and said nothing");
  // Killed, as the system kills a program when memory runs out, it says nothing.
  assert.equal(whyFailed({ code: null, signal: "SIGKILL", stderr: "" }), "it was stopped by SIGKILL, as the system stops a program when memory runs out. Run again with fewer jobs at once, or with a smaller video");
  assert.equal(whyFailed({ code: null, signal: "SIGSEGV", stderr: "" }, "ffprobe"), "ffprobe crashed (SIGSEGV)");
  // ffmpeg takes SIGTERM and SIGINT itself, and ends with 255, saying so only at a level -loglevel error leaves out.
  assert.equal(whyFailed({ code: 255, signal: null, stderr: "" }), "it ended with code 255, as ffmpeg does when a signal such as SIGTERM or SIGINT stops it");
  assert.equal(whyFailed({ code: 255, signal: null, stderr: "[out#0/mp4 @ 0x5] Error opening output x.mp4: Operation not permitted\n" }), "Error opening output x.mp4: Operation not permitted");
  if (!/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return this.skip("this ffmpeg has no libass");
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, "killed-bin", "ffmpeg");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  fs.writeFileSync(fake, `#!/bin/sh\ncase " $* " in\n  *" -progress "*) kill -KILL $$ ;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const words = h.write("killed-words.json", { words: h.evenWords("the encode is stopped", { start: 0.2 }) });
  const r = h.run([h.video({ width: 360, height: 640, seconds: 2 }), "--words", words, "--libass", "--out", out("killed-encode")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome", FFMPEG_PATH: fake } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\neasycaptionkit: ffmpeg could not write captioned\.mp4: it was stopped by SIGKILL, as the system stops a program when memory runs out\. Run again with fewer jobs at once, or with a smaller video\n$/);
  assert.equal(fs.existsSync(out("killed-encode")), false);
  // The real ffmpeg sent SIGTERM alone a second into an encode it reads at the video's own pace, as a task manager or pkill sends it.
  const termed = path.join(h.dir, "termed-bin", "ffmpeg");
  fs.mkdirSync(path.dirname(termed), { recursive: true });
  fs.writeFileSync(termed, `#!/bin/sh\ncase " $* " in\n  *" -progress "*) "${real}" -re "$@" & p=$!; sleep 1; kill -TERM $p; wait $p; exit $? ;;\nesac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const t = h.run([h.video({ width: 360, height: 640, seconds: 2 }), "--words", words, "--libass", "--out", out("termed-encode")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome", FFMPEG_PATH: termed } });
  assert.equal(t.status, 1);
  assert.match(t.stderr, /\neasycaptionkit: ffmpeg could not write captioned\.mp4: it ended with code 255, as ffmpeg does when a signal such as SIGTERM or SIGINT stops it\n$/);
  assert.equal(fs.existsSync(out("termed-encode")), false);
});

test("the encode is let go on while it prints nothing and writes its file, as +faststart writes a whole MP4 again after the last frame, and stopped when it neither prints nor writes", { skip: process.platform === "win32" && "needs a shell script for ffmpeg" }, async () => {
  const { burn } = require("../skills/easycaptionkit/scripts/lib/ffmpeg");
  const caps = { encoder: { name: "libx264", args: ["-c:v", "libx264"] }, colorNames: {}, setparams: true, fpsMode: true, aac: true, libass: true, overlay: true };
  const video = { file: out("quiet-in.mp4"), index: 0, color: { range: "tv", space: "", transfer: "", primaries: "" }, hdr: false, sar: 1, width: 360, height: 640, out: { width: 360, height: 640 }, audio: [], timeBase: "1:15360", duration: 2 };
  // In ffmpeg's place: progress to the end, then two seconds of silence, writing or not.
  const fake = (name, write) => {
    const file = path.join(h.dir, "quiet-bin", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\nfor a in "$@"; do out="$a"; done\nprintf 'out_time_us=1000000\\nprogress=continue\\n'\nsleep 0.1\nprintf 'out_time_us=2000000\\nprogress=continue\\n'\ni=0\nwhile [ $i -lt 20 ]; do\n  ${write ? 'printf x >> "$out"' : ":"}\n  sleep 0.1\n  i=$((i + 1))\ndone\nprintf 'progress=end\\n'\nexit 0\n`, { mode: 0o755 });
    return file;
  };
  const shares = [];
  const made = await burn({ bins: { ffmpeg: fake("writing", true) }, caps, video, output: out("quiet-out.mp4"), ass: out("quiet.ass"), onProgress: (share) => shares.push(share), quiet: 600 });
  assert.deepEqual(made.tracks, []);
  assert.deepEqual(shares, [0.5, 1]);
  assert.equal(fs.statSync(out("quiet-out.mp4")).size, 20);
  await assert.rejects(burn({ bins: { ffmpeg: fake("stuck", false) }, caps, video, output: out("quiet-stuck.mp4"), ass: out("quiet.ass"), quiet: 600 }), /^Error: stuck stopped answering for 1 s and was stopped$/);
});

test("a file written in the folder by one of the kit's names while the encode runs stays there, and the run's files go in a folder of their own",{ skip: (skip || (process.platform === "win32" && "needs a shell script for ffmpeg")) }, () => {
  const video = blackVideo("black-race.mp4", { width: 360, height: 640, seconds: 2 });
  const words = h.write("race.json", { words: h.evenWords("made while it ran", { start: 0.2 }) });
  const folder = out("race-run");
  caption([video, "--words", words, "--out", folder]);
  const real = spawnSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const fake = path.join(h.dir, "race-bin", "ffmpeg");
  fs.mkdirSync(path.dirname(fake), { recursive: true });
  // The encode writes someone's own sheet.png and notes into the folder before it starts.
  fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "-filter_complex" ]; then printf 'my own sheet' > "$RACE_DIR/sheet.png"; printf 'my notes' > "$RACE_DIR/CAPTIONS.md"; fi\ndone\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const r = h.run([video, "--words", words, "--style", "line", "--out", folder], { env: { ...process.env, FFMPEG_PATH: fake, RACE_DIR: folder } });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /sheet\.png and CAPTIONS\.md changed in .*race-run while this run was going, so the run left the folder as it was\. Its files are in .*race-run.easycaptionkit-new: move them where you want them, or run again/);
  assert.equal(fs.readFileSync(path.join(folder, "sheet.png"), "utf8"), "my own sheet");
  assert.equal(fs.readFileSync(path.join(folder, "CAPTIONS.md"), "utf8"), "my notes");
  assert.deepEqual(files(path.join(folder, "easycaptionkit-new")), ["CAPTIONS.md", "captioned.mp4", "captions.ass", "captions.json", "captions.srt", "captions.vtt", "safe-zones.png", "sheet.png", "words.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "easycaptionkit-new", "captions.json"), "utf8")).style, "line");
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, "captions.json"), "utf8")).style, "karaoke");
  assert.deepEqual(fs.readdirSync(folder).filter((n) => n.startsWith(".easycaptionkit-work-")), []);
});

test("without Chrome, --libass draws the captions with ffmpeg, and the pictures too", { skip: !h.hasFfmpeg && "needs ffmpeg" }, function () {
  const caps = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout;
  if (!/ subtitles /.test(caps)) return this.skip("this ffmpeg has no libass");
  const video = h.video({ width: 1280, height: 720, fps: 25, seconds: 3, rate: 44100, channels: 1 });
  const words = h.write("libass.srt", "1\n00:00:00,500 --> 00:00:02,500\nDrawn by libass, no browser at all.\n");
  const folder = out("libass");
  const c = caption([video, "--words", words, "--libass", "--style", "line", "--box", "--out", folder], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
  assert.equal(c.drawnWith, "libass");
  assert.deepEqual(c.places.map((p) => p.place), ["youtube", "x", "linkedin"]);
  for (const name of ["captioned.mp4", "sheet.png", "safe-zones.png", "captions.ass"]) assert.ok(fs.statSync(path.join(folder, name)).size > 0, name);
  // A TMPDIR that names no folder, where Chrome would keep its profile: ffmpeg makes the pictures, and says why.
  if (process.platform !== "win32") {
    const nowhere = out("no-such-tmp");
    const t = caption([video, "--words", words, "--libass", "--style", "line", "--out", out("libass-no-tmp")], { env: { ...process.env, TMPDIR: nowhere } });
    assert.ok(t.notes.includes(`ffmpeg made sheet.png and safe-zones.png, plainer than Chrome lays them out, since TMPDIR is ${nowhere}, and there is no folder there. The frames have no caption numbers or times on them, and the margins no app buttons or names.`), t.notes.join(" | "));
    assert.equal(fs.existsSync(nowhere), false);
  }
  // White letters on the dark box, low in the frame.
  const px = h.region(path.join(folder, "captioned.mp4"), 1.5, { x: 0, y: 540, w: 1280, h: 180 });
  let white = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 220 && px[i + 1] > 220 && px[i + 2] > 220) white++;
  assert.ok(white > 500, `${white} white pixels where the caption is`);
});

test("a Chrome that cannot start its sandbox stops the run before the encode and points to --libass, which draws the captions and plainer pictures without it, and one the system stops with SIGKILL says to run fewer jobs at once too", { skip: (!h.hasFfmpeg && "needs ffmpeg") || (process.platform === "win32" && "needs a shell script for Chrome") }, () => {
  const broken = path.join(h.dir, "broken-chrome", "chrome");
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  // It answers --version, which a run asks before any work, as Chrome does without its sandbox.
  fs.writeFileSync(broken, "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'Chromium 140.0.0.0, a stand-in'; exit 0; }\necho '[0101/000000.000000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see the docs.' >&2\nexit 1\n", { mode: 0o755 });
  const env = { env: { ...process.env, CHROME_PATH: broken } };
  const video = h.video({ width: 360, height: 640, seconds: 2 });
  const words = h.write("broken-chrome.json", { words: h.evenWords("drawn without a sandbox", { start: 0.2 }) });
  const stopped = h.run([video, "--words", words, "--out", out("broken-chrome-run")], env);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /Chrome stopped \(exit 1\): Chrome could not start its sandbox here \(No usable sandbox! Update your kernel or see the docs\.\)\. Pass --libass to have ffmpeg draw the captions without Chrome\n/);
  assert.doesNotMatch(stopped.stderr, /Encoding/);
  assert.equal(fs.existsSync(out("broken-chrome-run")), false);
  // A Chrome with no #! line, which Linux has /bin/sh run, that answered when asked its version, stopped for its
  // sandbox too, not for what its file is.
  const sandboxNote = /^ffmpeg made sheet\.png and safe-zones\.png, plainer than Chrome lays them out, since Chrome could not draw them: Chrome stopped \(exit 1\): Chrome could not start its sandbox here/;
  if (process.platform === "linux") {
    const unmarked = path.join(h.dir, "unmarked-chrome", "chrome");
    fs.mkdirSync(path.dirname(unmarked), { recursive: true });
    fs.writeFileSync(unmarked, fs.readFileSync(broken, "utf8").replace(/^#!.*\n/, ""), { mode: 0o755 });
    const unmarkedEnv = { env: { ...process.env, CHROME_PATH: unmarked } };
    const plain = h.run([video, "--words", words, "--out", out("unmarked-chrome-run")], unmarkedEnv);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /\neasycaptionkit: Chrome stopped \(exit 1\): Chrome could not start its sandbox here \(No usable sandbox! Update your kernel or see the docs\.\)\. Pass --libass to have ffmpeg draw the captions without Chrome\n$/);
    if (/ subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) {
      const drawn = caption([video, "--words", words, "--libass", "--out", out("unmarked-chrome-libass")], unmarkedEnv);
      assert.ok(drawn.notes.some((n) => sandboxNote.test(n)), drawn.notes.join(" | "));
    }
  }
  // A Chrome the system stops with SIGKILL, as when memory runs out on a busy machine, gets what ffmpeg's SIGKILL gets.
  const killed = path.join(h.dir, "killed-chrome", "chrome");
  fs.mkdirSync(path.dirname(killed), { recursive: true });
  fs.writeFileSync(killed, "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'Chromium 140.0.0.0, a stand-in'; exit 0; }\nkill -KILL $$\n", { mode: 0o755 });
  const oom = h.run([video, "--words", words, "--out", out("killed-chrome-run")], { env: { ...process.env, CHROME_PATH: killed } });
  assert.equal(oom.status, 1);
  assert.match(oom.stderr, /\neasycaptionkit: Chrome was stopped by SIGKILL, as the system stops a program when memory runs out\. Run again with fewer jobs at once or with a smaller video, or pass --libass to have ffmpeg draw the captions without Chrome\n$/);
  assert.equal(fs.existsSync(out("killed-chrome-run")), false);
  if (!/ subtitles /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) return;
  const c = caption([video, "--words", words, "--libass", "--out", out("broken-chrome-libass")], env);
  assert.equal(c.drawnWith, "libass");
  for (const name of ["captioned.mp4", "sheet.png", "safe-zones.png"]) assert.ok(fs.statSync(path.join(out("broken-chrome-libass"), name)).size > 0, name);
  assert.ok(c.notes.some((n) => sandboxNote.test(n)), c.notes.join(" | "));
  // With CHROME_PATH naming nothing, the note says so.
  const none = caption([video, "--words", words, "--libass", "--out", out("no-chrome-libass")], { env: { ...process.env, CHROME_PATH: "/nonexistent/chrome" } });
  assert.ok(none.notes.some((n) => /plainer than Chrome lays them out, since CHROME_PATH points to \/nonexistent\/chrome, where there is none\./.test(n)), none.notes.join(" | "));
});

test("a Chrome the system stops while a page loads fails the run with what SIGKILL gets where Chrome draws the captions, and leaves the pictures to ffmpeg where it draws them, where the process ended with code 0 and said nothing", { skip: skip || (process.platform === "win32" && "needs a shell script for Chrome") }, () => {
  // Passes the DevTools pipe on to the real Chrome, and on the launch KILL_AT kills it with SIGKILL, and itself, once
  // Chrome has answered Page.navigate, before the page's load event.
  const proxy = path.join(h.dir, "dying-chrome", "proxy.js");
  fs.mkdirSync(path.dirname(proxy), { recursive: true });
  fs.writeFileSync(
    proxy,
    `const fs = require("node:fs");
const { spawn } = require("node:child_process");
const n = (Number(fs.existsSync(process.env.COUNT_FILE) ? fs.readFileSync(process.env.COUNT_FILE, "utf8") : 0) || 0) + 1;
fs.writeFileSync(process.env.COUNT_FILE, String(n));
const chrome = spawn(process.env.REAL_CHROME, process.argv.slice(2), { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
const navigations = new Set();
let asked = Buffer.alloc(0);
fs.createReadStream(null, { fd: 3 }).on("data", (chunk) => {
  asked = Buffer.concat([asked, chunk]);
  for (let end; (end = asked.indexOf(0)) >= 0; asked = asked.subarray(end + 1)) {
    const message = JSON.parse(asked.subarray(0, end).toString());
    if (message.method === "Page.navigate") navigations.add(message.id);
  }
  chrome.stdio[3].write(chunk);
});
const toKit = fs.createWriteStream(null, { fd: 4 });
let told = Buffer.alloc(0);
chrome.stdio[4].on("data", (chunk) => {
  told = Buffer.concat([told, chunk]);
  for (let end; (end = told.indexOf(0)) >= 0; told = told.subarray(end + 1)) {
    const message = JSON.parse(told.subarray(0, end).toString());
    toKit.write(Buffer.from(told.subarray(0, end + 1)), () => {
      if (n !== Number(process.env.KILL_AT) || !navigations.has(message.id)) return;
      process.kill(chrome.pid, "SIGKILL");
      process.kill(process.pid, "SIGKILL");
    });
  }
});
chrome.stdio[3].on("error", () => {});
chrome.on("exit", () => process.kill(process.pid, "SIGKILL"));
`,
  );
  const wrapper = path.join(path.dirname(proxy), "chrome");
  // The version a run asks before any work comes from the real Chrome, and counts as no launch.
  fs.writeFileSync(wrapper, `#!/bin/sh\n[ "$1" = --version ] && exec "$REAL_CHROME" --version\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(proxy)} "$@"\n`, { mode: 0o755 });
  const video = h.video({ width: 360, height: 640, seconds: 2 });
  const words = h.write("dying-chrome.json", { words: h.evenWords("drawn while Chrome goes", { start: 0.2 }) });
  const count = path.join(path.dirname(proxy), "count");
  const envAt = (at) => ({ env: { ...process.env, CHROME_PATH: wrapper, REAL_CHROME: findChrome(), COUNT_FILE: count, KILL_AT: String(at) } });
  // The captions page: the run fails, as when Chrome is stopped at any other moment.
  for (const json of [false, true]) {
    fs.rmSync(count, { force: true });
    const r = h.run([video, "--words", words, "--out", out(`dying-chrome-${json}`), ...(json ? ["--json"] : [])], envAt(1));
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /easycaptionkit: Chrome was stopped by SIGKILL, as the system stops a program when memory runs out\. Run again with fewer jobs at once or with a smaller video, or pass --libass to have ffmpeg draw the captions without Chrome\n$/);
    if (json) assert.equal(JSON.parse(r.stdout).ok, false);
    assert.equal(fs.existsSync(out(`dying-chrome-${json}`)), false);
  }
  // The page of safe-zones.png, once the video is captioned: ffmpeg makes the pictures.
  fs.rmSync(count, { force: true });
  const c = caption([video, "--words", words, "--out", out("dying-chrome-zones")], envAt(2));
  assert.ok(fs.statSync(path.join(out("dying-chrome-zones"), "captioned.mp4")).size > 0);
  assert.ok(c.notes.some((n) => /^ffmpeg made sheet\.png and safe-zones\.png, plainer than Chrome lays them out, since Chrome could not draw them: Chrome was stopped by SIGKILL/.test(n)), c.notes.join(" | "));
});

test("a process that ends with code 0 while a run is going, with nothing left to wait for, ends with code 1 and says the run ended before it was done, as JSON on stdout too with --json, and the folder is as it was", { skip: process.platform === "win32" && "needs a POSIX exit" }, () => {
  const caption = path.resolve(__dirname, "../skills/easycaptionkit/scripts/lib/caption.js");
  for (const json of [false, true]) {
    const folder = out(`ended-early-${json}`);
    // A run that begins and then waits on a promise nothing settles, so the process has nothing left to do.
    const script = `const c = require(${JSON.stringify(caption)}); c.stopOnSignals({ json: ${json} }); c.begin(${JSON.stringify(folder)}); new Promise(() => {}).then(() => {});`;
    const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr, `easycaptionkit: the run ended before it was done, so ${folder} is as it was\n`);
    assert.equal(r.stdout, json ? `${JSON.stringify({ ok: false, error: `the run ended before it was done, so ${folder} is as it was` })}\n` : "");
    assert.equal(fs.existsSync(folder), false);
  }
});

test("subtitles only: the files from the words, for a video's size, the video untouched", { skip: !h.hasFfmpeg && "needs ffmpeg" }, () => {
  const video = h.video({ width: 1920, height: 1080, fps: 25, seconds: 4 });
  const words = h.write("subs.json", { task: "transcribe", words: h.evenWords("Soft subtitles go to YouTube and LinkedIn as a file and the player draws them in its own way", { start: 0.1, each: 0.15, gap: 0.04 }) });
  const folder = out("subs");
  const c = caption(["subtitles", words, "--video", video, "--out", folder]);
  assert.deepEqual(files(folder), ["CAPTIONS.md", "captions.ass", "captions.json", "captions.srt", "captions.vtt", "words.json"]);
  assert.equal(c.layout.maxChars, 42);
  for (const cue of c.cues) for (const line of cue.lines) assert.ok(line.length <= 42, line);
  assert.match(fs.readFileSync(path.join(folder, "captions.ass"), "utf8"), /PlayResX: 1920\nPlayResY: 1080/);
  // Without a video, a vertical place lays the ASS file out for a phone.
  const phone = caption(["subtitles", words, "--for", "tiktok", "--out", out("subs-phone")]);
  assert.equal(phone.layout.width, 1080);
  assert.equal(phone.layout.height, 1920);
  // There 42 characters do not fit across: captions.ass has captions of
  // its own, cut to what fits, and CAPTIONS.md says so.
  const { charsThatFit } = require("../skills/easycaptionkit/scripts/lib/places");
  const fit = Math.min(42, phone.layout.ass.maxChars);
  assert.ok(fit < 42 && fit <= charsThatFit(phone.layout.textWidth, phone.layout.fontPx), JSON.stringify(phone.layout.ass));
  const assText = fs.readFileSync(path.join(out("subs-phone"), "captions.ass"), "utf8");
  const shown = assText.split("\n").filter((l) => l.startsWith("Dialogue:")).map((l) => l.split(",").slice(9).join(",").replace(/\{[^}]*\}/g, ""));
  for (const event of shown) for (const line of event.split("\\N")) assert.ok(line.length <= fit, `"${line}" is wider than ${fit}`);
  assert.equal(new Set(shown.map((e) => e.replace(/\\N/g, " "))).size, phone.layout.ass.cues);
  assert.ok(phone.layout.ass.cues > phone.cues.length);
  assert.match(fs.readFileSync(path.join(out("subs-phone"), "CAPTIONS.md"), "utf8"), new RegExp(`up to ${fit} characters a line in captions\\.ass`));
  for (const cue of phone.cues) for (const line of cue.lines) assert.ok(line.length <= 42, line);
  // A fonts.css font is a file that libass finds only in its folder: CAPTIONS.md gives it, from
  // the folder captions.ass is in, as the fontsdir of the filter that burns captions.ass there.
  assert.doesNotMatch(fs.readFileSync(path.join(folder, "CAPTIONS.md"), "utf8"), /fontsdir/);
  const kit = h.fontKit("fonts-for-ass", { family: "Kitface" });
  const kitted = out("subs-kit");
  caption(["subtitles", words, "--video", video, "--fonts", kit, "--out", kitted]);
  const row = /\n\| captions\.ass \| .*; its font is a file of fonts\.css in `([^`]+)`, which the filter finds when that is its fontsdir, as in `([^`]+)` run in this folder, and a player once the font is installed \|\n/.exec(fs.readFileSync(path.join(kitted, "CAPTIONS.md"), "utf8"));
  assert.ok(row, fs.readFileSync(path.join(kitted, "CAPTIONS.md"), "utf8"));
  assert.equal(path.resolve(kitted, row[1]), path.join(kit, "files"));
  assert.equal(row[2], `ass=captions.ass:fontsdir=${row[1]}:shaping=complex`);
  if (/ ass /.test(spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout)) {
    const burned = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", row[2], "-ss", "1", "-frames:v", "1", "self.png"], { cwd: kitted, encoding: "utf8" });
    assert.equal(burned.status, 0, burned.stderr);
  }
});

test("Chrome names the fonts of a text every time it is asked, the first font of the list too: the text is laid out before Chrome is asked; on a machine with no Japanese font, the letters no font has are boxes, and the fonts named drew only the others", { skip }, async () => {
  const { renderStates, fontsOf } = require("../skills/easycaptionkit/scripts/lib/render");
  const { launch, openPage } = require("../skills/easycaptionkit/scripts/lib/chrome");
  const { buildCues, states } = require("../skills/easycaptionkit/scripts/lib/cues");
  const { chooseLook } = require("../skills/easycaptionkit/scripts/lib/look");
  const { captionLayout } = require("../skills/easycaptionkit/scripts/lib/places");
  const { chromeBoxes, machineLetters } = require("../skills/easycaptionkit/scripts/lib/boxes");
  const { kitLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  // A text set and asked about at once, over and over: Chrome lays a text
  // out only at its next frame, and says nothing of one it has not.
  const page = out("probe-page.html");
  fs.writeFileSync(page, `<!doctype html><html><body><div id="probe" style="font: 700 40px Arial, 'Liberation Sans', sans-serif"></div></body></html>`);
  const browser = await launch({ width: 800, height: 600 });
  try {
    const tab = await openPage(browser, page, { width: 800, height: 600 });
    const empty = [];
    for (let i = 0; i < 30; i++) if (!(await fontsOf(tab, i % 2 ? `Hamburgefonstiv ${i}` : `日本語 ${i}`)).length) empty.push(i);
    assert.deepEqual(empty, [], "Chrome named no font for these texts");
  } finally {
    await browser.close();
  }
  // Japanese, which the first sans of the list lacks, so another font draws most of it.
  const read = readWords(h.write("first-font.srt", "1\n00:00:00,500 --> 00:00:02,500\n今日は いい天気ですね。\n"));
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, lines: 2 });
  const cues = buildCues(read.words, { lines: 2, maxChars: 14, hard: read.hard, duration: 3 });
  const dir = out("first-font");
  fs.mkdirSync(dir, { recursive: true });
  // The letters that came out as boxes are told as a run tells them.
  const look = chooseLook({ lang: "ja" });
  const r = await renderStates({ cues, words: read.words, states: states(cues, read.words, "karaoke"), style: "karaoke", look, place, duration: 3, dir, boxed: (all, fonts) => chromeBoxes(all, fonts, { kit: kitLetters(look) }) });
  assert.ok(r.first, "Chrome named the first font of the list");
  assert.match(fs.readFileSync(path.join(dir, "captions-page.html"), "utf8"), /^<!doctype html>\n<html lang="ja">/);
  const letters = [...cues.map((c) => c.lines.join("")).join("")];
  // A machine with no Japanese font, as GitHub's runners are without
  // one installed: Chrome named the first font of the list, a Latin one,
  // for the letters it found no font for and drew a box for each, which
  // the run says, and the fonts it names drew only the others.
  const japanese = spawnSync("fc-list", [":lang=ja", "family", "style"], { encoding: "utf8" }).stdout || "";
  if (hasFontconfig && !japanese.trim()) {
    const every = machineLetters();
    const none = [...new Set(letters)].filter((c) => !every(c.codePointAt(0)));
    assert.ok(none.length > 0 && none.every((c) => r.boxes.includes(c)), JSON.stringify(r.boxes));
    assert.equal(r.fonts.reduce((n, f) => n + f.glyphs, 0), letters.filter((c) => !r.boxes.includes(c)).length, JSON.stringify(r.fonts));
    return;
  }
  assert.deepEqual(r.boxes, [], "no letter came out as a box");
  assert.ok(r.fonts.length > 0, "Chrome named the fonts that drew the words");
  // The captions show no space between Japanese words, and Chrome is
  // asked about the letters they show: the first font, a Latin one, drew
  // none of them, and a space is no letter.
  assert.deepEqual(r.fonts.filter((f) => f.family === r.first), [], JSON.stringify(r.fonts));
  assert.equal(r.fonts.reduce((n, f) => n + f.glyphs, 0), letters.length);
  // In the bold face of a CJK family this machine has, not its regular one.
  if (/style=Bold/.test(japanese)) {
    for (const f of r.fonts) assert.doesNotMatch(f.postScriptName, /-(?:Regular|Light|Medium)$/, JSON.stringify(r.fonts));
  }
});

test("a letter no font on this machine has, which Chrome draws as a box and says the first font of the list drew, is named with its caption in the notes and CAPTIONS.md with what to do, and the fonts they name drew the others; libass says the same of its boxes, and neither takes a no-break hyphen for one", { skip: skip || (!hasFontconfig && "needs fontconfig") }, function () {
  // A letter of the last private use plane, which no font has, between
  // words any font has. A no-break hyphen, which Liberation Sans 2.1
  // lacks and draws with its plain hyphen, is no box.
  const video = blackVideo("black-box.mp4", { width: 360, height: 640, seconds: 3 });
  const words = (name, last) => h.write(name, [{ text: "Ship", start: 0.3, end: 0.8 }, { text: "\u{10fffd}", start: 0.8, end: 1.2 }, { text: last, start: 1.2, end: 2 }]);
  const plain = words("box-plain.json", "today");
  const hyphen = words("box-hyphen.json", "to\u2011day");
  const advice = "Install a font that has it, such as a Noto font for its script, or give --fonts an easyfontkit folder whose font has it, and run again.";
  const said = "Chrome found no font on this machine for 1 letter of caption 1 (\u{10fffd}), so it drew a box for it.";
  const boxNotes = (notes) => notes.filter((note) => /\bbox\b/.test(note));
  for (const [name, file, letters, more] of [["box-chrome", hyphen, 10, []], ["box-kit", plain, 9, ["--fonts", h.fontKit("box-kit-fonts")]]]) {
    const c = caption([video, "--words", file, "--style", "line", ...more, "--out", out(name)]);
    assert.ok(c.notes.includes(`${said} ${advice}`), JSON.stringify(c.notes));
    assert.equal(boxNotes(c.notes).length, 1, JSON.stringify(c.notes));
    // The fonts named drew the words, and the box is none of theirs.
    assert.equal(c.look.drawn.reduce((n, f) => n + f.glyphs, 0), letters, JSON.stringify(c.look.drawn));
    const md = fs.readFileSync(path.join(out(name), "CAPTIONS.md"), "utf8");
    const lines = md.split("## Look\n\n")[1].split("\n- ")[0].split("\n");
    assert.match(lines[0], /^- Font: /);
    assert.equal(lines[1], `  ${said}`, md);
    // Inter, from fonts.css, drew every letter but the box.
    if (more.length) assert.deepEqual(lines.slice(2), ["  Chrome drew all the other letters with it."], md);
    assert.ok(md.includes(`\n- ${said} ${advice}\n`), md);
  }
  const libass = caption([video, "--words", hyphen, "--style", "line", "--libass", "--out", out("box-libass")]);
  const boxed = "No font on this machine that libass can use has 1 letter of caption 1 (\u{10fffd}), so the video shows a box for it.";
  assert.ok(libass.notes.includes(`${boxed} ${advice}`), JSON.stringify(libass.notes));
  assert.equal(boxNotes(libass.notes).length, 1, JSON.stringify(libass.notes));
  assert.ok(fs.readFileSync(path.join(out("box-libass"), "CAPTIONS.md"), "utf8").split("## Look\n\n")[1].includes(`\n  ${boxed}\n`));
});

test("with --libass, every letter no font on this machine has is counted, past the 64 letters fontconfig is asked about", { skip: skip || (!hasFontconfig && "needs fontconfig") }, function () {
  const video = blackVideo("black-many-boxes.mp4", { width: 360, height: 640, seconds: 3 });
  const letters = Array.from({ length: 70 }, (_, i) => String.fromCodePoint(0x10ff00 + i));
  const words = h.write("many-boxes.json", Array.from({ length: 7 }, (_, i) => ({ text: letters.slice(i * 10, i * 10 + 10).join(""), start: 0.3 + i * 0.3, end: 0.6 + i * 0.3 })));
  const c = caption([video, "--words", words, "--style", "line", "--libass", "--out", out("many-boxes")]);
  assert.ok(c.notes.some((note) => note.startsWith("No font on this machine that libass can use has 70 letters of caption")), JSON.stringify(c.notes));
});

test("a script run in the captions page is waited for as long as it is given, as the fit of a hundred thousand words is given two minutes, where every call to Chrome had 60 s at most", { skip }, async () => {
  const { launch, openPage, evaluate } = require("../skills/easycaptionkit/scripts/lib/chrome");
  // evaluate waits for Chrome's answer for longer than the time it gives the script.
  const asked = [];
  const value = await evaluate({ call: async (method, params, wait) => (asked.push({ method, timeout: params.timeout, wait }), { result: { value: 7 } }) }, "__fit()", 120_000);
  assert.equal(value, 7);
  assert.equal(asked[0].timeout, 120_000);
  assert.ok(asked[0].wait > 120_000, `the call waits ${asked[0].wait} ms`);
  // Each call to Chrome waits as long as it says: a script of 1.5 s fails a call given 0.3 s, and is answered within its own time.
  const page = out("wait-page.html");
  fs.writeFileSync(page, "<!doctype html><html><body></body></html>");
  const browser = await launch({ width: 400, height: 400 });
  try {
    const tab = await openPage(browser, page, { width: 400, height: 400 });
    const slow = (n) => `new Promise((resolve) => setTimeout(() => resolve(${n}), 1500))`;
    await assert.rejects(tab.call("Runtime.evaluate", { expression: slow(1), awaitPromise: true, returnByValue: true }, 300), /^Error: Chrome did not answer Runtime\.evaluate within 0\.3 s$/);
    assert.equal(await evaluate(tab, slow(2), 5000), 2);
  } finally {
    await browser.close();
  }
});

test("Hindi, Bengali and Thai captions are drawn from the bold face of their script's family, which Chrome's list names for their letters", { skip }, () => {
  const { chooseLook } = require("../skills/easycaptionkit/scripts/lib/look");
  const { scriptsIn } = require("../skills/easycaptionkit/scripts/lib/text");
  // The families come after the Latin ones and the emoji, each once.
  const texts = ["नमस्ते दोस्तों,", "ভাই", "สวัสดี", "வணக்கம்", "hello"];
  assert.deepEqual(scriptsIn(texts), ["Devanagari", "Bengali", "Tamil", "Thai"]);
  const look = chooseLook({ scripts: scriptsIn(texts) });
  for (const name of ["Noto Sans Devanagari", "Kohinoor Devanagari", "Nirmala UI", "Noto Sans Bengali", "Noto Sans Tamil", "Noto Sans Thai", "Thonburi", "Leelawadee UI"]) assert.ok(look.listed.includes(name), name);
  assert.equal(look.listed.filter((name) => name === "Nirmala UI").length, 1);
  assert.ok(look.listed.indexOf("Noto Color Emoji") < look.listed.indexOf("Noto Sans Devanagari"));
  assert.ok(!chooseLook({}).listed.includes("Noto Sans Devanagari"));
  // Where the bold file is installed, Chrome draws the letters from it.
  const bold = spawnSync("fc-list", ["", "file"], { encoding: "utf8" }).stdout || "";
  const video = blackVideo("black-indic.mp4", { width: 360, height: 640, seconds: 2 });
  for (const [name, text, family] of [["hi", "नमस्ते दोस्तों,", "Noto Sans Devanagari"], ["bn", "নমস্কার বন্ধুরা", "Noto Sans Bengali"], ["th", "สวัสดีครับ", "Noto Sans Thai"]]) {
    const face = `${family.replace(/ /g, "")}-Bold`;
    if (!bold.includes(`/${face}.`)) continue;
    const c = caption([video, "--words", h.write(`indic-${name}.json`, [{ text, start: 0.2, end: 1.8 }]), "--style", "line", "--out", out(`indic-${name}`)]);
    const drawn = c.look.drawn.filter((f) => f.family === family);
    assert.ok(drawn.length > 0, `${name}: ${JSON.stringify(c.look.drawn)}`);
    for (const f of drawn) assert.equal(f.postScriptName, face, `${name}: ${JSON.stringify(c.look.drawn)}`);
    assert.doesNotMatch(fs.readFileSync(path.join(out(`indic-${name}`), "CAPTIONS.md"), "utf8"), /a face lighter than the 700 asked for/);
  }
});

test("a silent demo captioned from easyscreenshotkit's steps.json, in the word style", { skip }, () => {
  const video = h.video({ width: 1920, height: 1080, fps: 30, seconds: 4, sound: "none" });
  const steps = h.write("steps.json", {
    version: 1, kind: "demo", tool: "easyscreenshotkit 0.1.1", video: { file: "demo.mp4", width: 1920, height: 1080, fps: 30, duration: 4 },
    steps: [
      { n: 1, action: "visit", label: "Open acme.com", note: "This is Acme.", start: 0, end: 0 },
      { n: 2, action: "click", label: "Click Pricing", note: "One plan, one price.", start: 1.2, end: 2.6 },
    ],
  });
  const c = caption([video, "--words", steps, "--style", "word", "--out", out("steps")]);
  assert.equal(c.words.format, "steps");
  assert.equal(c.cues.length, 2);
  assert.equal(c.cues[1].start, 1.2);
  assert.equal(c.layout.lines, 1);
  assert.ok(c.notes.some((n) => /no sound/.test(n)));
  // Nothing was heard: a word of a step is changed, from steps.json and from the words.json a run of it wrote, which
  // says the steps' words are shown while each step plays and names steps.json as where its words first came from.
  const stepsSaid = /^\d+ words from .*, each step's words shown while the step plays, spread over that time by their length\.$/m;
  const told = (folder) => fs.readFileSync(path.join(folder, "CAPTIONS.md"), "utf8");
  assert.match(told(out("steps")), /^words\.json has them as read\. To change a word of a step, edit its text there/m);
  const from = (folder) => JSON.parse(fs.readFileSync(path.join(folder, "words.json"), "utf8")).from;
  assert.equal(from(out("steps")), "easyscreenshotkit's steps.json");
  const again = caption([video, "--words", path.join(out("steps"), "words.json"), "--style", "word", "--out", out("steps")]);
  assert.deepEqual([again.words.origin.format, again.words.firstFormat], ["steps", "steps"]);
  assert.match(told(out("steps")), stepsSaid);
  assert.doesNotMatch(told(out("steps")), /speech-to-text/);
  assert.match(told(out("steps")), /^words\.json has them as read\. To change a word of a step, edit its text there/m);
  assert.equal(from(out("steps")), "easyscreenshotkit's steps.json");
  // Subtitles of them in a folder of their own, as a refusal gives the command, read them as steps too.
  const elsewhere = caption(["subtitles", path.join(out("steps"), "words.json"), "--video", video, "--out", out("steps-subtitles")]);
  assert.deepEqual([elsewhere.words.format, elsewhere.words.firstFormat, elsewhere.words.origin], ["easycaptionkit", "steps", undefined]);
  const firstRead = /^\d+ words from words\.json \(a words\.json from easycaptionkit, first read from easyscreenshotkit's steps\.json\), each step's words/m;
  assert.match(told(out("steps-subtitles")), firstRead);
  assert.match(told(out("steps-subtitles")), /^words\.json has them as read\. To change a word of a step, edit its text there/m);
  // The command that folder's CAPTIONS.md gives, run as given, still says where the steps' words first came from,
  // where it said they were first read from words.json, the file of the other folder.
  const command = /^words\.json has them as read\. To change a word of a step, edit its text there and run subtitles again with .*: `(.*)`\.$/m.exec(told(out("steps-subtitles")));
  assert.ok(command, told(out("steps-subtitles")));
  const shell = spawnSync(command[1], { shell: true, encoding: "utf8", timeout: 600_000, env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}` } });
  assert.equal(shell.status, 0, shell.stderr);
  assert.match(told(out("steps-subtitles")), firstRead);
  assert.equal(from(out("steps-subtitles")), "easyscreenshotkit's steps.json");
  // A captioning run from that words.json, in a folder of its own and then from its own words.json, says the same.
  for (const words of [path.join(out("steps-subtitles"), "words.json"), path.join(out("steps-moved"), "words.json")]) {
    const moved = caption([video, "--words", words, "--style", "word", "--out", out("steps-moved")]);
    assert.equal(moved.words.firstFormat, "steps");
    assert.match(told(out("steps-moved")), firstRead);
  }
});
