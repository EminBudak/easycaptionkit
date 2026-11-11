"use strict";

// ffmpeg and ffprobe, the ones already on the machine: what the video is,
// what this ffmpeg can do, the one encode that lays the captions over the
// picture, and frames of the result to look at. Nothing is downloaded.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { track } = require("./running");
const programs = require("./programs");

const { exe } = programs;

// Where package managers put it, for an agent or app whose PATH is short.
const KNOWN = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];

const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg or winget install ffmpeg";

// ffmpeg as a run looks for it and asks it its version (see programs.find()).
const FFMPEG = {
  name: "ffmpeg",
  variable: "FFMPEG_PATH",
  args: ["-version"],
  answers: (stdout) => /^ffmpeg version\b/m.test(stdout),
  names: [exe("ffmpeg")],
  known: KNOWN,
  none: `easycaptionkit needs ffmpeg, and none was found. Install it (${INSTALL}) or set FFMPEG_PATH to one.`,
  advice: {
    variable: `Set FFMPEG_PATH to an ffmpeg that runs, or unset it and install one (${INSTALL}).`,
    found: `Install ffmpeg (${INSTALL}) or set FFMPEG_PATH to an ffmpeg that runs.`,
  },
};

// ffprobe, which sits next to ffmpeg in every package: the one next to the
// ffmpeg at `ffmpeg`, when that is not ffmpeg's own file, else as ffmpeg is
// looked for.
const FFPROBE = (ffmpeg) => ({
  name: "ffprobe",
  variable: "FFPROBE_PATH",
  args: ["-version"],
  answers: (stdout) => /^ffprobe version\b/m.test(stdout),
  names: [exe("ffprobe")],
  known: KNOWN,
  first: () => (ffmpeg ? [{ file: path.join(path.dirname(ffmpeg), exe("ffprobe")), name: "ffprobe", where: `next to ${ffmpeg}`, next: true }].filter((place) => place.file !== ffmpeg) : []),
  none: `easycaptionkit needs ffprobe, and none was found${ffmpeg ? ` next to ${ffmpeg} or` : ""} on PATH. Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to one.`,
  advice: {
    variable: `Set FFPROBE_PATH to an ffprobe that runs, or unset it and install ffmpeg, which comes with ffprobe (${INSTALL}).`,
    next: "Set FFPROBE_PATH to an ffprobe that runs.",
    found: `Install ffmpeg, which comes with ffprobe (${INSTALL}), or set FFPROBE_PATH to an ffprobe that runs.`,
  },
});

// ffmpeg and ffprobe, each found and asked its version before any work,
// as { ffmpeg, ffprobe, version }: their files and what ffmpeg said, which
// capabilities() reads. ffprobe is looked for next to the ffmpeg that
// answered.
// A program that cannot be started or does not answer as itself stops the
// run there, as programs.find() says, ffmpeg's first.
async function ready(limit = programs.LIMIT) {
  const ffmpeg = await programs.find(FFMPEG, limit);
  const ffprobe = await programs.find(FFPROBE(ffmpeg.file), limit);
  return { ffmpeg: ffmpeg.file, ffprobe: ffprobe.file, version: ffmpeg.stdout };
}

// ffprobe alone, for a run that reads a video and starts no ffmpeg: found
// and asked as ready() does, next to the ffmpeg the run would take, which
// is not run, so nothing at ffmpeg's path stops it.
async function readyProbe(limit = programs.LIMIT) {
  const ffprobe = await programs.find(FFPROBE(programs.locate(FFMPEG)), limit);
  return { ffprobe: ffprobe.file };
}

// What ffmpeg prints once it has given up, after the lines that say why:
// how it stopped, which says nothing of the cause. ffmpeg 4.4 ends with
// the first ones and the bare text of the error, as "Invalid argument",
// ffmpeg 7 and newer with the others, and ffmpeg 8 says last that its
// encoder never opened and that it wrote nothing, after a filter that
// could not start, or that filtering failed, after the scaler said which
// frame it could not convert. ffmpeg 6.1 says it could not start a simple
// filtergraph, the one -vf gives, after the line that names the option
// its filter refused.
const CLOSING = [
  /^Could not open encoder before EOF/,
  /^Error while filtering\b/,
  /^Nothing was written into output file/,
  /^Conversion failed!?$/,
  /^Error while processing the decoded data/,
  /^Failed to inject frame into filter network/,
  /^Error reinitializing filters!?$/,
  /^Error initializing complex filters\.?$/,
  /^Error opening filters!?$/,
  /^Exiting normally/,
  /^Error initializing a simple filtergraph$/,
  /^(?:Invalid argument|Operation not permitted|Cannot allocate memory|Invalid data found when processing input|Unknown error occurred)$/,
  /^Error opening (?:input|output) files?\b/,
  /^Error selecting an encoder$/,
  /^Error closing file\b/,
  /^Error muxing a packet$/,
  /^Task finished with error code/,
  /^Terminating thread with return code/,
  /^Error initializing filters$/,
  /^Error : /,
];
// The words of a line that says what went wrong, as ffmpeg 8's "Impossible
// to convert between the formats supported by" two filters.
const WRONG = /error|\b(?:invalid|unable|cannot|can't|could not|couldn't|failed|not found|no such|unknown|unrecognized|not supported|impossible|denied|no space|refused|undefined)\b/i;
// The signals a program ends by when it crashes.
const CRASHES = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE"]);

// Why ffmpeg or ffprobe failed, as words that follow "could not ...: ".
// By a signal: which one, and for SIGKILL, which the system sends a
// program when memory runs out, as on a machine running many jobs, what
// to do. Else the last line it printed that names what went wrong, without
// the closing lines and the "[name @ 0x...]" that starts a line, as
// "Error applying option 'color_primaries' to filter 'setparams'" in the
// place of ffmpeg's last line, "Error : Invalid argument". ffmpeg itself
// takes SIGTERM and SIGINT, ends with code 255, and says so only at a
// level -loglevel error leaves out: code 255 with nothing said is that.
function whyFailed({ code, signal, stderr }, who = "it") {
  if (signal === "SIGKILL") return `${who} was stopped by SIGKILL, as the system stops a program when memory runs out. Run again with fewer jobs at once, or with a smaller video`;
  if (signal) return CRASHES.has(signal) ? `${who} crashed (${signal})` : `${who} was stopped by ${signal}`;
  const lines = String(stderr || "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !/^\s/.test(line))
    .map((line) => line.replace(/^(?:\[[^\]]*\]\s*)+/, "").trim())
    .filter(Boolean);
  const telling = lines.filter((line) => !CLOSING.some((closing) => closing.test(line)));
  const said = telling.filter((line) => WRONG.test(line)).pop() || telling.pop();
  if (said) return said;
  if (code === 255) return `${who} ended with code 255, as ffmpeg does when a signal such as SIGTERM or SIGINT stops it`;
  return lines.pop() || `${who} ended with code ${code} and said nothing`;
}

// Runs a program to its end, in the folder `cwd` when given. A run that
// prints nothing for `quiet` ms is stopped, so a stuck ffmpeg is an
// error, not a hang, unless what `busy` gives, as the size and the time of
// the file it writes, changed in that time: ffmpeg prints nothing while it
// writes a whole MP4 again to move its index to the front. With `binary`,
// stdout is the bytes it wrote, not text. The programs are the ones a run
// checked before any work, so one that cannot be started now says what
// the system said, or that the folder it was to run in is gone, never the
// system's code alone: Node throws some of those errors at once and gives
// the others a moment later.
function run(binary, args, { quiet = 120_000, onStdout = null, cwd = undefined, busy = null, binary: bytes = false } = {}) {
  return new Promise((resolve, reject) => {
    const failed = (err) => {
      if (!/^spawn\b/.test(err.syscall || "")) return err;
      // A start that fails for want of the folder it runs in is no fault of
      // the program's.
      if (cwd && !programs.enterable(cwd)) return new Error(`${path.basename(binary)} could not be started in ${cwd}, a folder that is not there any more or may not be entered`);
      return programs.startFailure(binary, err);
    };
    let child;
    try {
      child = track(spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], cwd }));
    } catch (err) {
      reject(failed(err));
      return;
    }
    let stdout = "";
    const chunks = [];
    let stderr = "";
    let timer = null;
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(failed(err));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: bytes ? Buffer.concat(chunks) : stdout, stderr });
    });
    // With no file descriptor left for them Node makes no pipes, and says
    // why a moment later.
    if (!child.stdout || !child.stderr) return;
    const arm = () => {
      clearTimeout(timer);
      const before = busy ? busy() : null;
      timer = setTimeout(() => {
        if (busy && busy() !== before) return arm();
        child.kill("SIGKILL");
        reject(new Error(`${path.basename(binary)} stopped answering for ${Math.round(quiet / 1000)} s and was stopped`));
      }, quiet);
      timer.unref();
    };
    arm();
    child.stdout.on("data", (d) => {
      arm();
      if (onStdout) onStdout(String(d));
      else if (bytes) chunks.push(d);
      else stdout += d;
    });
    child.stderr.on("data", (d) => {
      arm();
      stderr = (stderr + d).slice(-40_000);
    });
  });
}

// ─── what the video is ────────────────────────────────────────────────────

function ratio(text) {
  const m = /^(\d+(?:\.\d+)?)[:/](\d+(?:\.\d+)?)$/.exec(String(text || ""));
  if (!m) return NaN;
  const d = Number(m[2]);
  return d ? Number(m[1]) / d : NaN;
}

// Seconds from a Matroska DURATION tag, 00:00:06.000000000; 0 for none.
function tagSeconds(tags) {
  const key = Object.keys(tags || {}).find((k) => /^DURATION(?:-\w+)?$/i.test(k));
  const m = key ? /^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(tags[key]).trim()) : null;
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

// The first video stream as it is shown: turned upright when the file says
// it is rotated, and with square pixels. Its frame rate, the length the
// file states (0 where it states none), color and sound.
async function probe(file, bins) {
  if (!fs.existsSync(file)) throw new Error(`Cannot read ${file}: no such file`);
  if (fs.statSync(file).isDirectory()) throw new Error(`${file} is a folder, not a video`);
  // ffmpeg reads a name like take1:final.mp4 as a protocol and its path; a
  // whole path is only ever a file.
  const whole = path.resolve(file);
  const result = await run(bins.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", whole], { quiet: 60_000 });
  const { code, stdout, stderr } = result;
  if (code !== 0) {
    if (!result.signal && /Invalid data found|could not find codec|moov atom not found/i.test(stderr)) throw new Error(`Cannot read ${file}: ffmpeg does not know it as a video, or it is cut short`);
    throw new Error(`Cannot read ${file}: ${whyFailed(result, "ffprobe")}`);
  }
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error(`Cannot read ${file}: ffprobe gave no answer`);
  }
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === "video" && !(s.disposition && s.disposition.attached_pic));
  if (!video) throw new Error(`${file} has no video stream${streams.some((s) => s.codec_type === "audio") ? ", only sound" : ""}`);
  let rotation = 0;
  for (const side of video.side_data_list || []) if (side.rotation !== undefined) rotation = Number(side.rotation) || 0;
  if (!rotation && video.tags && video.tags.rotate) rotation = Number(video.tags.rotate) || 0;
  rotation = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  const sar = ratio(video.sample_aspect_ratio);
  const square = !(sar > 0) || Math.abs(sar - 1) < 0.01;
  let width = Number(video.width);
  let height = Number(video.height);
  if (!square) width = Math.round(width * sar);
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  const avg = ratio(video.avg_frame_rate);
  const base = ratio(video.r_frame_rate);
  // The stream's own rate when the average is that to a thousandth: in a
  // millisecond time base, as a WebM has, frames sit up to a millisecond
  // off the rate's grid, and the average comes out as 24.003.
  const fps = avg > 0 && avg < 1000 ? (base > 0 && base < 1000 && Math.abs(avg - base) / base < 0.001 ? base : avg) : base > 0 && base < 1000 ? base : 30;
  const start = Number(info.format && info.format.start_time);
  const fileStart = Number.isFinite(start) ? start : 0;
  // How long the picture runs by what the file states, from where the file
  // starts, which ffmpeg takes as 0: its own stream's length from where
  // that stream starts, as Matroska and WebM keep it in a DURATION tag, a
  // picture that starts after the sound too; else the file's, which is its
  // longest stream's, the sound's as often as the picture's.
  const own = Number(video.duration) > 0 ? Number(video.duration) : tagSeconds(video.tags);
  const streamStart = Number(video.start_time);
  const stated = own > 0 ? (Number.isFinite(streamStart) ? streamStart : fileStart) + own - fileStart : Number(info.format && info.format.duration) || 0;
  const duration = stated > 0 ? stated : 0;
  const audio = streams
    .filter((s) => s.codec_type === "audio")
    .map((s) => ({ index: s.index, codec: s.codec_name || "", channels: Number(s.channels) || 0, rate: Number(s.sample_rate) || 0, layout: s.channel_layout || "" }));
  const tb = /^(\d+)\/(\d+)$/.exec(video.time_base || "");
  const chapters = Array.isArray(info.chapters) ? info.chapters.length : 0;
  return {
    file: whole,
    name: file,
    // The stream to caption by its number in the file: a cover picture
    // stored as a video stream can come before it.
    index: video.index,
    // The stream's time base, which every frame's time is a whole number of.
    timeBase: tb && Number(tb[1]) > 0 && Number(tb[2]) > 0 ? `${tb[1]}:${tb[2]}` : "",
    container: (info.format && info.format.format_name) || "",
    codec: video.codec_name || "",
    stored: { width: Number(video.width), height: Number(video.height) },
    width,
    height,
    // The size written: H.264 in 4:2:0 needs even sides.
    out: { width: width - (width % 2), height: height - (height % 2) },
    rotation,
    sar: square ? 1 : sar,
    pixFmt: video.pix_fmt || "",
    fps,
    // The stream's base rate, as ffmpeg writes it: 30/1, 30000/1001.
    baseRate: base > 0 && /^\d+\/\d+$/.test(video.r_frame_rate || "") ? video.r_frame_rate : "",
    duration,
    // Whether that length is the picture's own or the file's.
    statedBy: own > 0 ? "stream" : duration > 0 ? "file" : "",
    // Where the file starts, which ffmpeg takes as 0.
    start: fileStart,
    frames: Number(video.nb_frames) || Math.round(duration * fps),
    color: {
      range: video.color_range === "pc" ? "pc" : video.color_range === "tv" ? "tv" : "",
      space: video.color_space || "",
      transfer: video.color_transfer || "",
      primaries: video.color_primaries || "",
    },
    hdr: /smpte2084|arib-std-b67/.test(video.color_transfer || ""),
    audio,
    chapters,
    // What the captioned video leaves out: the file's own tags, other than
    // the ones every muxer writes, its cover picture, as yt-dlp
    // --embed-thumbnail and podcast tools store it, its other video tracks,
    // its subtitle and data tracks and the files attached to a Matroska
    // file, as its fonts. A chapter list is kept, and MP4 keeps it in a text
    // track of its own, which is no data track of the file's.
    left: {
      tags: Object.keys((info.format && info.format.tags) || {}).filter((key) => !/^(?:major_brand|minor_version|compatible_brands|encoder)$/i.test(key)),
      covers: streams.filter((st) => st.codec_type === "video" && st.disposition && st.disposition.attached_pic).length,
      videos: streams.filter((st) => st.codec_type === "video" && st !== video && !(st.disposition && st.disposition.attached_pic)).length,
      subtitles: streams.filter((st) => st.codec_type === "subtitle").length,
      data: streams.filter((st) => st.codec_type === "data" && !(chapters && st.codec_tag_string === "text")).length,
      attachments: streams.filter((st) => st.codec_type === "attachment").length,
    },
  };
}

// The video to caption: what probe says of it, and how long its picture
// and its sound run, read from the times of their packets, which ffprobe
// reads without decoding them, from the start ffmpeg takes as 0. The last
// frame runs as long as its packet says, as a screen recording that ends
// on a still screen holds its last frame for seconds, or as long as the
// video's frames do on average. A WebM a browser recorded (Chrome's
// MediaRecorder) states no length, and is as long as its frames and its
// sound run. A file cut short, as an interrupted download or copy leaves
// it, states the whole length, and so can a header written to claim more:
// where every stream, the sound too, ends more than half a second before
// it, the captions end where the last frame starts, which can be cut short
// itself. A note says so. Elsewhere the picture runs to the length the
// file states for it, or further where its frames do, and where the sound
// runs on more than half a second past it, the captions go on to the end
// of the sound. { ...probe, duration, frames, times, picture: { start,
// end, last }, sound, soundPast, notes }: times are the frames', and last
// is where the last frame starts.
async function readVideo(file, bins) {
  const v = await probe(file, bins);
  const { video: own, ends } = await packetsOf(file, bins, v.index);
  const notes = [];
  if (!own.times.length) {
    if (v.duration > 0) return { ...v, times: new Float64Array(0), picture: { start: 0, end: v.duration, last: 0 }, sound: 0, soundPast: false, notes };
    throw new Error(`Cannot read ${file}: it states no length, and ffprobe found no times for its frames. Write it again with them, as ffmpeg -i <file> -c copy <new file> does, and caption that`);
  }
  const times = own.times.sort();
  const first = times[0];
  const lastStart = times[times.length - 1];
  const step = times.length > 1 ? (lastStart - first) / (times.length - 1) : 1 / v.fps;
  const zero = Math.min(v.start, first);
  const framesEnd = lastStart + (own.last.dur > 0 ? own.last.dur : step) - zero;
  let sound = 0;
  for (const a of v.audio) if (ends.has(a.index)) sound = Math.max(sound, ends.get(a.index) - zero);
  // Every frame counts, the ones with no time too.
  const found = { ...v, frames: Math.max(own.count, times.length), times: times.map((t) => t - zero), sound };
  const last = lastStart - zero;
  if (v.duration > 0 && Math.max(framesEnd, sound) < v.duration - 0.5) {
    const cut = Math.max(last, step);
    notes.push(`The video says it is ${v.duration.toFixed(2)} s long, and its frames end at ${cut.toFixed(2)} s${sound > 0 ? ` and its sound at ${sound.toFixed(2)} s` : ""}, as in a file cut short by an interrupted download or copy, so the captions end there.`);
    return { ...found, duration: cut, picture: { start: first - zero, end: cut, last }, soundPast: false, notes };
  }
  // The length the file states for the picture itself, where its frames
  // end within half a second of it, the shorter of the two; else the
  // longer, as a still last frame a player holds to it, or frames that
  // run past what the header says.
  let end = framesEnd;
  if (v.statedBy === "stream") end = Math.abs(framesEnd - v.duration) <= 0.5 ? Math.min(framesEnd, v.duration) : Math.max(framesEnd, v.duration);
  const soundPast = sound > end + 0.5;
  if (!(v.duration > 0)) notes.push(`The video states no length, as a recording a browser saved often does, so its length was read from its frames: ${end.toFixed(2)} s.`);
  return { ...found, duration: soundPast ? sound : end, picture: { start: first - zero, end, last }, soundPast, notes };
}

// What a program prints, handed to `take` a line at a time as it comes,
// so nothing keeps the whole of it: an onStdout for run, and an end that
// hands over a last line with no line break after it.
function byLine(take) {
  let rest = "";
  return {
    onStdout(text) {
      const lines = (rest + text).split("\n");
      rest = lines.pop();
      for (const line of lines) take(line);
    },
    end() {
      if (rest) take(rest);
      rest = "";
    },
  };
}

// Numbers kept as they come, eight bytes each, in a typed array that
// grows: a ten-hour video has two million frames.
function numbers() {
  let kept = new Float64Array(4096);
  let n = 0;
  return {
    push(value) {
      if (n === kept.length) {
        const more = new Float64Array(n * 2);
        more.set(kept);
        kept = more;
      }
      kept[n++] = value;
    },
    done: () => kept.slice(0, n),
  };
}

// The packets of a video, read without decoding them, as ffmpeg shows and
// plays them, a line of ffprobe's at a time, so a long video takes no more
// than its frames' times: of the video stream `index`, the times of its
// packets, in seconds, how many it has with a time and without, and its
// last packet's time and length, NaN where it gives none; of every other
// stream, where its last packet ends. { video: { times, count, last: {
// pts, dur } }, ends: Map(stream index => seconds) }. A packet an MP4's
// edit list discards is left out: a cut made without encoding again, as
// ffmpeg -ss with -c copy and LosslessCut make it, keeps the frames from
// the keyframe before the cut, at times before 0, and no player shows
// them. A packet with no time to be shown at, as an AVI gives a B-frame's,
// has the time it is decoded at, which ffmpeg gives that frame too.
async function packetsOf(file, bins, index) {
  const times = numbers();
  let count = 0;
  let last = null;
  const ends = new Map();
  const lines = byLine((line) => {
    const [stream, pts, dts, dur, flags] = line.split(",");
    if (!/^\d+$/.test(stream || "") || /D/.test(flags || "")) return;
    const i = Number(stream);
    const t = Number.isFinite(parseFloat(pts)) ? parseFloat(pts) : parseFloat(dts);
    const length = parseFloat(dur);
    if (i === index) count++;
    if (!Number.isFinite(t)) return;
    if (i !== index) ends.set(i, Math.max(ends.has(i) ? ends.get(i) : -Infinity, t + (length > 0 ? length : 0)));
    else {
      times.push(t);
      if (!last || t >= last.pts) last = { pts: t, dur: length };
    }
  });
  const result = await run(bins.ffprobe, ["-v", "error", "-show_entries", "packet=stream_index,pts_time,dts_time,duration_time,flags", "-of", "csv=p=0", path.resolve(file)], { quiet: 120_000, onStdout: lines.onStdout });
  lines.end();
  if (result.code !== 0) throw new Error(`Cannot read the frames of ${path.basename(file)}: ${whyFailed(result, "ffprobe")}`);
  return { video: { times: times.done(), count, last }, ends };
}

// Every frame's time in a video's first video stream, in order, read from
// its packets without decoding them, a line at a time.
async function frameTimes(file, bins) {
  const times = numbers();
  const lines = byLine((line) => {
    const t = parseFloat(line);
    if (Number.isFinite(t)) times.push(t);
  });
  const result = await run(bins.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path.resolve(file)], { quiet: 120_000, onStdout: lines.onStdout });
  lines.end();
  if (result.code !== 0) throw new Error(`Cannot read the frames of ${path.basename(file)}: ${whyFailed(result, "ffprobe")}`);
  return times.done().sort();
}

// The frame rate frame times show, and whether it varies: frames that all
// come within a millisecond and a half of a steady beat do not vary, as in
// a millisecond time base; `stated` is the rate the stream gives, taken
// when the times agree with it to a thousandth.
function rateOf(times, stated = 0) {
  if (times.length < 2) return { fps: stated, variable: false };
  let low = Infinity;
  let high = -Infinity;
  for (let i = 1; i < times.length; i++) {
    const step = times[i] - times[i - 1];
    low = Math.min(low, step);
    high = Math.max(high, step);
  }
  const fps = (times.length - 1) / (times[times.length - 1] - times[0]);
  return { fps: stated > 0 && Math.abs(fps - stated) / stated < 0.001 ? stated : fps, variable: high - low > 0.0015 };
}

// The rate most of a video's frames come at, from their times.
function mostRate(v) {
  const steps = numbers();
  for (let i = 1; i < v.times.length; i++) if (v.times[i] - v.times[i - 1] > 0.0005) steps.push(v.times[i] - v.times[i - 1]);
  const sorted = steps.done().sort();
  return sorted.length ? 1 / sorted[Math.floor(sorted.length / 2)] : v.fps > 0 ? v.fps : 30;
}

// The steady rate to give a video, as ffmpeg writes a rate: its stream's
// base rate, where that is a usual rate from 24 to 60 and no less than the
// rate most of its frames come at. Else a usual rate of 24 or more: the
// first of 24, 25 and 30 that repeats each frame the same number of
// times, as 24 does for a still picture at 1 or 2 frames a second and 30
// at 10 or 15, or the nearest of 24, 25, 30, 50 and 60 at or above the
// rate most frames come at.
function steadyRate(v) {
  const most = mostRate(v);
  const base = ratio(v.baseRate);
  if (base >= 23.9 && base <= 60 && base >= most * 0.98) return { rate: v.baseRate, fps: base };
  const whole = [24, 25, 30].find((r) => most < 23.9 && Math.abs(r / most - Math.round(r / most)) < 0.01);
  const floor = Math.min(Math.max(most, 24), 60);
  const near = whole || [24, 25, 30, 50, 60].filter((r) => r >= floor * 0.98).reduce((best, r) => (Math.abs(Math.log(r / floor)) < Math.abs(Math.log(best / floor)) ? r : best));
  return { rate: String(near), fps: near };
}

// How late a caption can come or go on the video's own frames before the
// video is given more: a tenth of a second, a third of a spoken word.
const LATE = 0.1;

// Whether captioned.mp4 needs frames the video does not have. The
// captions show on the video's own frames, so where the video holds a
// frame long (a screen recording that writes a frame only when the picture
// changes, a still last frame), has few frames a second (a still picture
// over a podcast's sound), starts after its sound, or ends before it, a
// caption or a lit word that comes or goes there shows late, or on no
// frame at all. Where any does by more than a tenth of a second, the video
// gets frames at a steady rate: { rate, fps, end, last, captions, held,
// few, start, past }, with how many captions would have come or gone late,
// the longest a frame held among them, the frames a second of a video
// whose frames all come at one low rate, and whether a caption came before
// the picture starts or after it ends; else null. `states` are the caption
// states.
function fillFor(v, states) {
  const times = v.times || [];
  if (!times.length) return null;
  const { rate, fps } = steadyRate(v);
  // The first frame at or after t, as its index; past the last, the count.
  const at = (t) => {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] >= t - 0.0005) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const late = new Set();
  let held = 0;
  let start = false;
  let past = false;
  for (const s of states) {
    for (const t of [s.from, s.to]) {
      if (t >= v.duration - 0.001) continue;
      const i = at(t);
      // The frame it shows on: the next, or past the last none before the
      // picture ends, and none at all after it.
      const next = i < times.length ? times[i] : t < v.picture.end - 0.001 ? v.picture.end : Infinity;
      if (next - t <= LATE) continue;
      late.add(s.cue);
      if (i === 0) start = true;
      else if (next === Infinity) past = true;
      // The frame before holds to the next, or past the last to the end of the picture.
      else held = Math.max(held, next - times[i - 1]);
    }
  }
  if (!late.size) return null;
  // Frames that all come at one rate, each held as long as the others: a
  // video of few frames a second.
  const own = mostRate(v);
  const few = held > 0 && !rateOf(times).variable && held <= 1.5 / own ? round3(own) : 0;
  return { rate, fps, end: v.duration, last: v.picture.last, captions: late.size, held, few, start, past };
}

const round3 = (value) => Math.round(value * 1000) / 1000;

// ─── what this ffmpeg can do ──────────────────────────────────────────────

// What this ffmpeg can do: its version number, from what it said when
// ready() asked it, and its filters and encoders.
async function capabilities(bins, version) {
  const [filters, encoders] = await Promise.all([run(bins.ffmpeg, ["-hide_banner", "-filters"], { quiet: 20_000 }), run(bins.ffmpeg, ["-hide_banner", "-encoders"], { quiet: 20_000 })]);
  // 4.4 is the oldest ffmpeg the kit is tried on: Ubuntu 22.04's. A build
  // from git says no number and is newer.
  const v = /ffmpeg version n?(\d+)\.(\d+)/.exec(version);
  const atLeast = (major, minor) => !v || Number(v[1]) > major || (Number(v[1]) === major && Number(v[2]) >= minor);
  if (!atLeast(4, 4)) throw new Error(`ffmpeg 4.4 or newer is needed, and this one is ${v[1]}.${v[2]}. Install a newer one (brew install ffmpeg, or a static build) or set FFMPEG_PATH to it.`);
  const hasFilter = (name) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(filters.stdout);
  const hasEncoder = (name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(encoders.stdout);
  let encoder = null;
  // No B-frames: with them the file starts behind an edit list, and a tool
  // that reads frames without it is two frames off the captions' times.
  if (hasEncoder("libx264")) encoder = { name: "libx264", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-bf", "0"] };
  else if (hasEncoder("h264_videotoolbox")) encoder = { name: "h264_videotoolbox", args: ["-c:v", "h264_videotoolbox", "-q:v", "65", "-profile:v", "high", "-bf", "0"] };
  else if (hasEncoder("libopenh264")) encoder = { name: "libopenh264", args: ["-c:v", "libopenh264", "-b:v", "12M"] };
  else if (hasEncoder("h264_mf")) encoder = { name: "h264_mf", args: ["-c:v", "h264_mf", "-b:v", "12M"] };
  // Whether x264 here writes 10 bits, which an HDR video needs to stay HDR.
  let tenBit = false;
  if (encoder && encoder.name === "libx264") {
    const help = await run(bins.ffmpeg, ["-hide_banner", "-h", "encoder=libx264"], { quiet: 20_000 });
    tenBit = /yuv420p10le/.test(help.stdout);
  }
  const setparams = hasFilter("setparams");
  return {
    // -fps_mode came in 5.1, in the place of -vsync.
    fpsMode: atLeast(5, 1),
    overlay: hasFilter("overlay"),
    libass: hasFilter("ass"),
    setparams,
    // The names setparams takes for each of its options.
    colorNames: setparams ? optionNames((await run(bins.ffmpeg, ["-hide_banner", "-h", "filter=setparams"], { quiet: 20_000 })).stdout) : {},
    encoder,
    tenBit,
    aac: /^\s*A\S*\s+aac\s/m.test(encoders.stdout),
  };
}

// The names each option of a filter takes, from its help: { option:
// Set(name) }. An option's line gives its type in angle brackets, and the
// names it takes follow it, each with its number.
function optionNames(help) {
  const names = {};
  let at = null;
  for (const line of String(help).split("\n")) {
    const option = /^\s+([\w-]+)\s+<\w+>/.exec(line);
    const constant = /^\s+(\S+)\s+-?\d+\s/.exec(line);
    if (option) names[option[1]] = at = new Set();
    else if (constant && at) at.add(constant[1]);
    else at = null;
  }
  return names;
}

// ─── the encode ───────────────────────────────────────────────────────────

// A path as an option's value inside a filter graph, escaped twice: for
// the option parser (backslash, quote and colon), then for the graph
// parser (backslash, quote, brackets, comma and semicolon), which takes
// the first escapes off again before the option parser sees the value.
// Both take the spaces, tabs and line breaks that are not escaped off the
// ends of a value, so a folder whose name ends in a space keeps it only
// when it is escaped for each. A backslash separates folders only on
// Windows; elsewhere it is a letter of a name, escaped like the others.
const filterPath = (p, platform = process.platform) =>
  (platform === "win32" ? String(p).replace(/\\/g, "/") : String(p))
    .replace(/[\\': \t\n\r]/g, "\\$&")
    .replace(/[\\'[\],; \t\n\r]/g, "\\$&");

// The video's picture made ready for the captions: square pixels, an even
// size (H.264 in 4:2:0 needs one) and 4:2:0, in 8 bits, or 10 for HDR.
// ffmpeg has already turned a rotated video upright by then. A picture in
// full range, as some phones and screen recorders write it, stays in full
// range: ffmpeg 4.4 takes a full range 4:2:0 picture to TV range on its way
// to yuv420p while its tag goes on saying full range, and the video comes
// out pale. A picture stored as RGB is converted with the matrix the
// captions take, in TV range, where ffmpeg 4.4 took BT.601 whatever the
// size and said nothing, and a YCgCo one first with the colorspace filter,
// which no scaler converts it with. `color` is colorOf's.
function prepareChain(v, deep = false, color = colorOf(v)) {
  const steps = [];
  if (color.recode) steps.push(color.recode);
  const how = color.rgb ? `out_color_matrix=${color.matrix}:out_range=tv` : color.range === "pc" ? "in_range=pc:out_range=pc" : "";
  if (v.sar !== 1) steps.push(`scale=${v.out.width}:${v.out.height}${how ? `:${how}` : ""},setsar=1`);
  else {
    if (v.width !== v.out.width || v.height !== v.out.height) steps.push(`crop=${v.out.width}:${v.out.height}:0:0`);
    if (how) steps.push(`scale=${how}`);
  }
  steps.push(deep ? "format=yuv420p10le" : "format=yuv420p");
  return steps.join(",");
}

// On HDR the captions' white would be the brightest white the screen can
// show. They are drawn at the reference white ITU-R BT.2408 gives for
// graphics instead: 75% of the signal for HLG, 58% for PQ.
function hdrLevel(v) {
  if (/arib-std-b67/.test(v.color.transfer)) return 0.75;
  if (/smpte2084/.test(v.color.transfer)) return 0.58;
  return 1;
}

// The color tags ffmpeg 8's scaler converts a picture with, as ffprobe
// names them, found on ffmpeg 8.0 one value at a time. It converts no frame
// tagged otherwise to another pixel format: not a phone's full range, 4:2:2
// or 10 bits to the 4:2:0 the captions go on, and not captioned.mp4 to the
// JPEG or PNG of a picture. Primaries or a transfer ffprobe calls reserved,
// the log transfers log100 and log316 and such matrices as YCgCo and ICtCp
// are not among them. ffmpeg 4.4 converts them all.
const CONVERTED = {
  color_primaries: new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "film", "bt2020", "smpte428", "smpte431", "smpte432", "jedec-p22", "ebu3213"]),
  color_trc: new Set(["bt709", "bt470m", "bt470bg", "smpte170m", "smpte240m", "linear", "iec61966-2-4", "bt1361e", "iec61966-2-1", "bt2020-10", "bt2020-12", "smpte2084", "smpte428", "arib-std-b67"]),
  colorspace: new Set(["gbr", "bt709", "fcc", "bt470bg", "smpte170m", "smpte240m", "bt2020nc"]),
};

// The pixel formats that store a picture as RGB, its red, green and blue,
// rather than as luma and color differences: QuickTime Animation, PNG or
// FFV1 in a MOV or MKV, an animated PNG or GIF, libx264rgb and VP9's
// gbrp. ffprobe tags such a picture's matrix gbr, or names none.
const RGB_FORMATS = /^(?:[0a]?(?:rgb|bgr)|gbr|bayer_|x2(?:rgb|bgr)|pal8)/;

// What a picture in a pixel format holds, from the format's name: { rgb,
// bits, chroma }, whether it is RGB, the bits of each value, and how its
// color is sampled against its luma: 4:4:4, 4:2:2, 4:2:0, 4:1:1, 4:4:0 or
// 4:1:0, "" for gray. yuv444p12le is 12 bits and 4:4:4, p010le 10 bits
// and 4:2:0, nv12 8 bits and 4:2:0, y210le 10 bits and 4:2:2.
function pixelFormat(name) {
  const n = String(name || "");
  const rgb = RGB_FORMATS.test(n);
  let bits = 8;
  for (const pattern of [/^yuva?\d+p(\d+)(?:le|be)$/, /^(?:gray|ya)(\d+)(?:le|be)$/, /^gbra?p(\d+)(?:le|be)$/, /^x2(?:rgb|bgr)(\d+)(?:le|be)$/, /^p\d(\d\d)(?:le|be)?$/, /^y2(\d\d)(?:le|be)?$/]) {
    const m = pattern.exec(n);
    if (m) {
      bits = Number(m[1]);
      break;
    }
  }
  if (/^(?:v210|nv20|xv30|v30x)/.test(n)) bits = 10;
  if (/^xv36/.test(n)) bits = 12;
  if (/^(?:rgba?|bgra?)(?:48|64)/.test(n)) bits = 16;
  const chroma = rgb ? "4:4:4" : /^(?:gray|ya|mono)/.test(n) ? "" : /444|nv24|nv42|^p4\d\d|^xv|^v30x|^vuy|^ayuv|^uyva/.test(n) ? "4:4:4" : /422|nv16|nv20|^p2\d\d|^y2\d\d|^v210|^yuyv|^yvyu|^uyvy/.test(n) ? "4:2:2" : /440/.test(n) ? "4:4:0" : /411/.test(n) ? "4:1:1" : /410/.test(n) ? "4:1:0" : "4:2:0";
  return { rgb, bits, chroma };
}

// The matrices the colorspace filter converts a picture from, on 4.4 and
// 8, that no scaler converts it from: YCgCo.
const RECODED = new Set(["ycgco"]);

// The color matrix and range the captions are converted with, so a
// brand color lands on the same color in the video: the video's own, or
// what players assume for its size when it says nothing. `params` are the
// video's color tags for setparams, each by a name setparams takes
// (`names`, from capabilities): ffprobe names a value no standard gives,
// as 3, "reserved", which setparams does not take, and such a tag is not
// written. The matrix is always written, so captioned.mp4 says what it
// holds wherever it goes: the video's own, or where it names none, is
// stored as RGB or was converted, the one the captions were converted
// with. `retag` is for setparams first in a chain: a tag the scaler
// converts with is left as it is, and the others are unknown while the
// picture is worked on, or for a matrix the one the captions are
// converted with, until `params` gives them back where setparams takes
// their names. A matrix or a range the video does not name is the one
// the captions take there too: ffmpeg 7.1 and newer give the overlay's
// two pictures one matrix, and take a picture that names none for
// BT.601, so the captions of an HD video were converted to BT.601 where
// the chain has no scaler, and the video's own picture to BT.709 where it
// has one. A matrix tagged reserved is the one tag ffmpeg 8 does not
// let a frame carry into its filters at all, "Invalid color space", so
// `input` gives the video, as it is read, the matrix the captions are
// converted with in its place, by the name ffmpeg's -colorspace takes.
// `rgb` says the picture is stored as RGB and goes to the matrix the
// captions take in TV range, `recode` is the colorspace filter that takes
// a YCgCo one there first, and `kept` names a matrix ffmpeg converts no
// color into, which captioned.mp4 keeps, so the captions' colors are
// coded for another. `stand` is the matrix the captions take by the name
// ffmpeg gives it, and `header` the YCbCr Matrix line captions.ass gives
// players for the video: its own matrix and range where that is BT.601 or
// BT.709, named or taken for its size, else None, with which a player
// converts the colors of captions.ass with the video's own matrix.
function colorOf(v, names = {}) {
  const rgb = RGB_FORMATS.test(v.pixFmt || "") || v.color.space === "gbr";
  const space = rgb ? "" : v.color.space || "";
  // Where the matrix is not named: BT.2020 for BT.2020's colors or HDR,
  // else as players take it for the size.
  const size = /bt2020/.test(v.color.primaries || "") || v.hdr ? "bt2020" : v.height >= 720 ? "bt709" : "bt601";
  const matrix = rgb ? size : /bt2020/.test(space) ? "bt2020" : /bt709/.test(space) ? "bt709" : /smpte170m|bt470bg|bt601/.test(space) ? "bt601" : size;
  const range = !rgb && v.color.range === "pc" ? "pc" : "tv";
  const takes = (option, value) => Boolean(value) && value !== "unknown" && (names[option] && names[option].size ? names[option].has(value) : !/^reserved/.test(value));
  const stand = { bt709: "bt709", bt601: "smpte170m", bt2020: "bt2020nc" }[matrix];
  const odd = (option, value) => Boolean(value) && value !== "unknown" && !CONVERTED[option].has(value);
  const recoded = RECODED.has(space);
  const params = [];
  // The colorspace filter tags what it converts BT.709: a primaries or a
  // transfer the video does not name goes back to unknown.
  for (const [option, value] of [["color_primaries", v.color.primaries], ["color_trc", v.color.transfer]]) {
    if (takes(option, value)) params.push(`${option}=${value}`);
    else if (recoded) params.push(`${option}=unknown`);
  }
  const kept = space && !recoded && odd("colorspace", space) && takes("colorspace", space) ? space : "";
  params.push(`colorspace=${kept || (takes("colorspace", space) && !recoded ? space : stand)}`);
  params.push(`range=${range}`);
  const unnamed = !rgb && (!space || space === "unknown");
  const retag = [odd("color_primaries", v.color.primaries) && "color_primaries=unknown", odd("color_trc", v.color.transfer) && "color_trc=unknown", (odd("colorspace", space) || unnamed) && `colorspace=${stand}`, !rgb && !v.color.range && `range=${range}`].filter(Boolean).join(":");
  const input = /^reserved/.test(space) ? ["-colorspace", stand] : [];
  // Only the matrix changes: the primaries and the transfer it is told are
  // the same on both sides, whatever the video's are.
  const recode = recoded ? `colorspace=iprimaries=bt709:itrc=bt709:ispace=${space}:irange=${range}:primaries=bt709:trc=bt709:space=${stand}:range=${range}` : "";
  const plain = !rgb && !recoded && !kept && matrix !== "bt2020" && !/^reserved/.test(space);
  const header = plain ? matrixLine(matrix, range) : "None";
  return { matrix, range, params: params.join(":"), retag, input, rgb, recode, kept, stand, header };
}

// Each sound stream kept as it is when MP4 players take it (AAC, MP3),
// else made AAC at the same rate: { args, notes, tracks }, with how each
// track was written, in the order they are, as { copied, from }, from the
// codec it had.
function audioArgs(v, caps) {
  const args = [];
  const notes = [];
  const tracks = [];
  v.audio.forEach((a, i) => {
    args.push("-map", `0:${a.index}`);
    if (["aac", "mp3"].includes(a.codec)) {
      args.push(`-c:a:${i}`, "copy");
      tracks.push({ copied: true, from: a.codec });
    } else {
      if (!caps.aac) throw new Error(`The sound is ${a.codec}, which MP4 players do not take, and this ffmpeg has no AAC encoder to convert it`);
      const bitrate = a.channels > 2 ? "384k" : a.channels === 1 ? "128k" : "192k";
      args.push(`-c:a:${i}`, "aac", `-b:a:${i}`, bitrate);
      notes.push(`${v.audio.length > 1 ? `Sound track ${i + 1}` : "The sound"} (${a.codec}) was made AAC at ${bitrate}, at the same rate, since MP4 players do not take ${a.codec}.`);
      tracks.push({ copied: false, from: a.codec });
    }
  });
  return { args, notes, tracks };
}

// The filter that draws an ASS file with libass: ffmpeg's ass filter, with
// libass's complex shaping, through HarfBuzz. The subtitles filter sets
// libass to its simple shaping, in which an Arabic letter takes its joined
// form only from a font that has the presentation forms, which Noto Kufi
// Arabic has not, so its letters come out as boxes, and Devanagari and
// Bengali letters join into no conjuncts.
const libassFilter = (ass, fontsDir = "") => `ass=filename=${filterPath(ass)}${fontsDir ? `:fontsdir=${filterPath(fontsDir)}` : ""}:shaping=complex`;

// The YCbCr Matrix line of an ASS file for a picture in the matrix (bt601,
// bt709 or bt2020) and range given: TV.709, PC.601. BT.2020 has no such
// name, and None has a player, or ffmpeg's ass filter, convert the colors
// with the picture's own matrix.
const matrixLine = (matrix, range) => (matrix === "bt2020" ? "None" : `${range === "pc" ? "PC" : "TV"}.${matrix === "bt709" ? "709" : "601"}`);

// Kr and Kb of each matrix, which give its luma and color differences.
const LUMA = { bt601: [0.299, 0.114], bt709: [0.2126, 0.0722], bt2020: [0.2627, 0.0593] };

// The color to give an ass filter that converts every color as BT.601
// does, for `hex` to come out as it is coded in `matrix`: { hex, shown },
// shown being the color the video then shows. That is `hex` itself, but
// for a color whose coding in `matrix` would need one past what RGB
// holds, as a pure green on an HD video would, which comes out duller.
function as601(hex, matrix) {
  const code = (c, [kr, kb]) => {
    const y = kr * c[0] + (1 - kr - kb) * c[1] + kb * c[2];
    return [y, (c[2] - y) / (2 * (1 - kb)), (c[0] - y) / (2 * (1 - kr))];
  };
  const decode = ([y, u, v], [kr, kb]) => {
    const r = y + 2 * (1 - kr) * v;
    const b = y + 2 * (1 - kb) * u;
    return [r, (y - kr * r - kb * b) / (1 - kr - kb), b];
  };
  const bytes = (c) => c.map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
  const text = (c) => `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  const rgb = [1, 3, 5].map((i) => parseInt(String(hex).slice(i, i + 2), 16) / 255);
  const given = bytes(decode(code(rgb, LUMA[matrix] || LUMA.bt601), LUMA.bt601));
  const shown = bytes(decode(code(given.map((x) => x / 255), LUMA.bt601), LUMA[matrix] || LUMA.bt601));
  return { hex: text(given), shown: text(shown) };
}

// Whether this ffmpeg's ass filter converts the colors of an ASS file with
// the matrix and range it is told, as ffmpeg 8 does by its YCbCr Matrix
// line and 7 by the tags of the frames it draws on, rather than every color
// as BT.601 does, in TV range or, on a yuvj420p picture, in full range, as
// 4.4 to 6 do: a red square drawn under PC.709 on a frame tagged BT.709 and
// full range has a luma of 54 then, and of 81 where BT.601 is taken. Asked
// once of each ffmpeg, in the folder `dir`.
const follows = new Map();
async function libassFollows(bins, dir, caps) {
  if (follows.has(bins.ffmpeg)) return follows.get(bins.ffmpeg);
  const file = path.join(dir, "matrix.ass");
  fs.writeFileSync(file, ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 16", "PlayResY: 16", "YCbCr Matrix: PC.709", "", "[V4+ Styles]", "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding", "Style: Square,Arial,10,&H000000FF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1", "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Dialogue: 0,0:00:00.00,0:00:05.00,Square,,0,0,0,,{\\pos(0,0)\\p1}m 0 0 l 16 0 16 16 0 16{\\p0}", ""].join("\n"));
  const tags = caps.setparams ? ",setparams=colorspace=bt709:range=pc" : "";
  // An ffmpeg that cannot say is taken to convert as BT.601 does, the way
  // that comes out right on every ass filter, a very saturated color aside.
  let result = { code: -1 };
  try {
    result = await run(bins.ffmpeg, ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=black:s=16x16:r=1:d=1,format=yuv420p${tags}`, "-vf", "ass=filename=matrix.ass", "-frames:v", "1", "-f", "rawvideo", "-"], { cwd: dir, quiet: 30_000, binary: true });
  } catch {
    // Not kept: the next run asks again.
  }
  fs.rmSync(file, { force: true });
  const luma = result.code === 0 && result.stdout.length >= 256 ? result.stdout[8 * 16 + 8] : -1;
  const answer = Math.abs(luma - 54) <= 3;
  if (result.code === 0) follows.set(bins.ffmpeg, answer);
  return answer;
}

// How libass draws a video's captions, from colorOf's colors and whether
// the ass filter follows the matrix it is told (libassFollows): { header,
// matrix, tint, full }. header is the burn's YCbCr Matrix line and matrix
// the one the picture is tagged with as the filter gets it, by ffmpeg's
// name, which ffmpeg 8 and 7 convert by: the picture's own. Where the
// filter takes BT.601 whatever it is told, both say BT.601, `tint` gives
// the color to write for each color, the one whose BT.601 coding is its
// coding in the picture's own matrix, and `full` says a full range picture
// goes to the filter as yuvj420p, the one picture 4.4 draws full range
// colors on.
function assColors(color, follow) {
  if (follow) return { header: matrixLine(color.matrix, color.range), matrix: color.stand, tint: null, full: false };
  return { header: matrixLine("bt601", color.range), matrix: "smpte170m", tint: color.matrix === "bt601" ? null : (hex) => as601(hex, color.matrix).hex, full: color.range === "pc" };
}

// The video's frames at a steady rate, `fill.rate` (30/1, 30000/1001),
// from 0 to `fill.end`, each frame repeated until the next comes: the first
// from 0 when the picture starts later, and the last to the end, past
// where the frames stop. fps pads the start; tpad holds the last frame
// whether or not fps already ran it to the end of its own duration, and
// trim ends the picture where the captions do.
const fillChain = (fill) => `fps=fps=${fill.rate}:start_time=0,tpad=stop_mode=clone:stop_duration=${Math.max(0, fill.end - fill.last + 1).toFixed(3)},trim=end=${fill.end.toFixed(3)},`;

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// The time base, as settb takes it, that holds every frame's time of a
// picture in the time base `base` (1:30, 1001:30000) and every
// millisecond, the times the caption states change at: 1 over the least
// common multiple of its denominator and 1000. The overlay reads the
// states in the time base of the picture they go over, rounded to the
// nearest of its steps, so in one as coarse as a frame (a picture given
// frames at a steady rate, an AVI, an MP4 whose timescale is its frame
// rate) a change came up to half a frame early. "" when the base is not
// known, or no finer one fits a time base's numbers.
function fineBase(base) {
  const m = /^(\d+)[:/](\d+)$/.exec(String(base || ""));
  if (!m || !Number(m[1]) || !Number(m[2])) return "";
  const den = Number(m[2]) / gcd(Number(m[1]), Number(m[2]));
  const fine = (den / gcd(den, 1000)) * 1000;
  return fine <= 2 ** 31 - 1 ? `1/${fine}` : "";
}

// The time base of the frames at a steady rate (30/1, 30000/1001, 24),
// one over the rate.
const rateBase = (rate) => {
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(rate));
  return m ? `${m[2] || 1}:${m[1]}` : "";
};

// Lays the captions over the video in one pass. Two ways:
// - overlay: the caption states Chrome drew, in one animated PNG that
//   shows each for its duration, read as one stream and laid at y.
// - libass: the ASS file drawn by libassFilter, on a picture tagged with
//   the matrix `assMatrix` and the range the captions take, which ffmpeg 7
//   converts their colors with, and with `assFull` as yuvj420p, for an ass
//   filter that draws full range colors on no other picture (assColors).
// The captions show on the video's own frames. Where it has too few for
// them, as fillFor says, `fill` gives it frames at a steady rate first.
async function burn({ bins, caps, video: v, output, overlay = null, ass = null, assMatrix = "", assFull = false, fontsDir = "", fill = null, onProgress = null, quiet = 180_000 }) {
  if (!caps.encoder) throw new Error("This ffmpeg has no H.264 encoder (libx264, VideoToolbox, OpenH264 or Media Foundation), so it cannot write the captioned MP4");
  const color = colorOf(v, caps.colorNames);
  // An HDR video stays HDR where x264 writes 10 bits.
  const deep = v.hdr && caps.tenBit;
  const level = hdrLevel(v);
  const dim = level < 1 ? `colorchannelmixer=rr=${level}:gg=${level}:bb=${level},` : "";
  const inputs = [...color.input, "-i", v.file];
  // Tags the scaler converts with, before anything converts the picture.
  const retag = caps.setparams && color.retag ? `setparams=${color.retag}` : "";
  const first = `[0:${v.index}]${retag ? `${retag},` : ""}${fill ? fillChain(fill) : ""}${prepareChain(v, deep, color)}`;
  let graph;
  // The animated PNG goes by its name, with ffmpeg in its folder, so
  // nothing in the folder's path (a % that names a numbered sequence, say)
  // is taken for more than a name. No frame is held back to a rate.
  const cwd = overlay ? path.dirname(overlay.file) : undefined;
  if (overlay) {
    inputs.push("-f", "apng", "-max_fps", "0", "-i", path.basename(overlay.file));
    // A time base the states' milliseconds and the picture's frames both
    // fall on, so each change shows from the first frame at or after it.
    const fine = fineBase(fill ? rateBase(fill.rate) : v.timeBase);
    graph =
      `${first}${fine ? `,settb=${fine}` : ""}[m];` +
      `[1:v]format=rgba,${dim}scale=out_color_matrix=${color.matrix}:out_range=${color.range},format=${deep ? "yuva420p10le" : "yuva420p"}[c];` +
      `[m][c]overlay=x=0:y=${overlay.y}:eof_action=pass:format=${deep ? "yuv420p10" : "yuv420"}${caps.setparams ? `,setparams=${color.params}` : ""}[v]`;
  } else {
    const tag = caps.setparams ? `,setparams=colorspace=${assMatrix || color.stand}:range=${color.range}` : "";
    const full = assFull && !deep;
    graph = `${first}${tag}${full ? ",scale=in_range=pc:out_range=pc,format=yuvj420p" : ""},${libassFilter(ass, fontsDir)}${full ? ",scale=in_range=pc:out_range=pc,format=yuv420p" : ""}${caps.setparams ? `,setparams=${color.params}` : ""}[v]`;
  }
  const encoder = deep ? caps.encoder.args.map((a) => (a === "high" ? "high10" : a)) : caps.encoder.args;
  const sound = audioArgs(v, caps);
  const args = [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
    ...inputs,
    "-filter_complex", graph,
    "-map", "[v]",
    ...sound.args,
    ...encoder,
    // Every frame at its own time: in the video's own time base, not moved
    // onto a grid of the frame rate, which a variable rate is not on. Or,
    // where it was given frames at a steady rate, at that rate.
    ...(fill ? ["-r", fill.rate, ...(caps.fpsMode ? ["-fps_mode:v", "cfr"] : ["-vsync", "cfr"])] : v.timeBase ? ["-enc_time_base:v", v.timeBase, ...(caps.fpsMode ? ["-fps_mode:v", "vfr"] : ["-vsync", "vfr"])] : []),
    "-pix_fmt", deep ? "yuv420p10le" : "yuv420p",
    // The file's own tags go (a phone's say where it was recorded); each
    // sound track keeps its own, its language among them, and the
    // chapters stay.
    "-map_metadata:g", "-1", "-map_chapters", "0",
    "-metadata", "comment=Captioned with easycaptionkit",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    output,
  ];
  let reported = -1;
  // After the last frame, +faststart writes the whole file again with its
  // index first and prints nothing until it is done, a minute and more for
  // a video of tens of GB: while the file still grows or changes, ffmpeg
  // is at work.
  const target = path.resolve(cwd || "", output);
  const written = () => {
    try {
      const s = fs.statSync(target);
      return `${s.size} ${s.mtimeMs}`;
    } catch {
      return "";
    }
  };
  const result = await run(bins.ffmpeg, args, {
    quiet,
    busy: written,
    cwd,
    onStdout: (text) => {
      const m = /out_time_us=(\d+)/.exec(text);
      if (!m || !onProgress) return;
      const share = Math.min(1, Number(m[1]) / 1e6 / v.duration);
      const step = Math.floor(share * 10);
      if (step > reported) {
        reported = step;
        onProgress(share);
      }
    },
  });
  if (result.code !== 0) throw new Error(`ffmpeg could not write ${path.basename(output)}: ${whyFailed(result)}`);
  // `frameTags` are for frameAt: `retag`, as captioned.mp4 has the tags
  // setparams gave back, and for an SDR video `untag`, which leaves its
  // primaries and transfer out of a picture of a frame. The PNG encoder
  // writes them into the PNG (cICP, cHRM and gAMA), and Chrome converts
  // the colors by them, darker or lighter than players show the video.
  const untag = caps.setparams && !v.hdr ? "color_primaries=unknown:color_trc=unknown" : "";
  return { notes: sound.notes, tracks: sound.tracks, color, deep, level, frameTags: { retag: retag ? color.retag : "", untag } };
}

// One frame of a video at a time, scaled to `width`, as JPEG or PNG.
// -update 1 writes the name as it is: a % in it is not a frame number.
// `retag` gives setparams the tags the scaler converts with, as burn does,
// and `untag`, last, the tags the picture written leaves out.
async function frameAt(bins, file, t, output, { width = 0, retag = "", untag = "" } = {}) {
  const steps = [...(retag ? [`setparams=${retag}`] : []), ...(width ? [`scale=${width}:-2:flags=lanczos`] : []), ...(untag ? [`setparams=${untag}`] : [])];
  const scale = steps.length ? ["-vf", steps.join(",")] : [];
  const result = await run(bins.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-ss", Math.max(0, t).toFixed(3), "-i", file, "-frames:v", "1", ...scale, "-q:v", "3", "-update", "1", output], { quiet: 60_000 });
  if (result.code !== 0) throw new Error(`ffmpeg could not take a frame at ${t.toFixed(2)} s: ${whyFailed(result)}`);
  if (!fs.existsSync(output)) throw new Error(`ffmpeg could not take a frame at ${t.toFixed(2)} s: it found none there`);
  return output;
}

module.exports = { FFMPEG, FFPROBE, ready, readyProbe, onPath: programs.onPath, probe, readVideo, packetsOf, frameTimes, rateOf, steadyRate, fillFor, capabilities, burn, frameAt, run, whyFailed, optionNames, colorOf, prepareChain, filterPath, libassFilter, hdrLevel, fineBase, matrixLine, as601, libassFollows, assColors, pixelFormat };
