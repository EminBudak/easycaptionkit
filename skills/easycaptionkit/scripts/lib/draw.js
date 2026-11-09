"use strict";

// The pictures to look at: sheet.png, a frame of the captioned video for
// each caption, and safe-zones.png, a frame under each place's buttons and
// text, drawn where each app puts them, with the margins the captions keep
// out of. Chrome lays them out; without Chrome, ffmpeg draws plainer ones.

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { launch, openPage, evaluate } = require("./chrome");
const { frameAt, run, whyFailed } = require("./ffmpeg");
const { writeApng } = require("./apng");
const { clock } = require("./report");
const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The cues the sheet shows: all of them up to `most`, else spread evenly.
function sheetCues(cues, most = 24) {
  if (cues.length <= most) return cues;
  const picked = [];
  for (let i = 0; i < most; i++) picked.push(cues[Math.round((i * (cues.length - 1)) / (most - 1))]);
  return [...new Set(picked)];
}

// When a cue is best seen: the middle of its spoken words.
const momentOf = (cue) => Math.max(cue.start, Math.min(cue.end - 0.02, (cue.start + Math.max(cue.start + 0.05, cue.spoken)) / 2));

// The frame of captioned.mp4 to show a cue with, from the times of its
// frames: { seek, time }, the time of the frame that shows the cue nearest
// its moment, and a time a moment before it to seek to, which lands on
// it. Where no frame shows the cue, the one on screen at its moment.
// Without the times, the moment itself, and the first frame after it.
function shotOf(cue, times = []) {
  const moment = momentOf(cue);
  if (!times.length) return { seek: moment, time: moment };
  // The first frame at or after t, as its index.
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
  const from = at(cue.start);
  const to = at(cue.end);
  let pick;
  if (to > from) {
    const i = Math.min(Math.max(at(moment), from), to - 1);
    pick = i > from && moment - times[i - 1] < times[i] - moment ? i - 1 : i;
  } else pick = Math.max(0, at(moment + 0.001) - 1);
  return { seek: Math.max(0, times[pick] - 0.0005), time: times[pick] };
}

// Up to four ffmpeg runs at a time. Once one fails, no other starts.
async function inPool(items, worker, size = 4) {
  const out = new Array(items.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length && !failed) {
        const i = next++;
        try {
          out[i] = await worker(items[i], i);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    }),
  );
  return out;
}

// ─── shapes of each app's buttons, in shares of its screen ────────────────

// dot: a round button; bar: a line of text; band: a strip of controls.
const UI = {
  tiktok: [
    ["bar", 0.3, 0.05, 0.16, 0.014], ["bar", 0.54, 0.05, 0.16, 0.014], ["dot", 0.93, 0.057, 0.03],
    ["dot", 0.915, 0.49, 0.05], ["dot", 0.915, 0.575, 0.04], ["dot", 0.915, 0.645, 0.04], ["dot", 0.915, 0.715, 0.04], ["dot", 0.915, 0.785, 0.04], ["dot", 0.915, 0.87, 0.045],
    ["bar", 0.04, 0.8, 0.3, 0.018], ["bar", 0.04, 0.83, 0.64, 0.013], ["bar", 0.04, 0.852, 0.5, 0.013], ["bar", 0.04, 0.88, 0.42, 0.013],
    ["band", 0, 0.935, 1, 0.065],
  ],
  reels: [
    ["bar", 0.05, 0.05, 0.18, 0.018], ["dot", 0.93, 0.058, 0.03],
    ["dot", 0.92, 0.62, 0.04], ["dot", 0.92, 0.69, 0.04], ["dot", 0.92, 0.76, 0.04], ["dot", 0.92, 0.83, 0.035], ["dot", 0.92, 0.895, 0.04],
    ["dot", 0.07, 0.8, 0.04], ["bar", 0.13, 0.79, 0.25, 0.018], ["bar", 0.04, 0.835, 0.66, 0.013], ["bar", 0.04, 0.858, 0.48, 0.013], ["bar", 0.04, 0.89, 0.4, 0.013],
    ["band", 0, 0.935, 1, 0.065],
  ],
  shorts: [
    ["dot", 0.82, 0.055, 0.03], ["dot", 0.93, 0.055, 0.03],
    ["dot", 0.915, 0.55, 0.045], ["dot", 0.915, 0.625, 0.045], ["dot", 0.915, 0.7, 0.045], ["dot", 0.915, 0.775, 0.045], ["dot", 0.915, 0.85, 0.04],
    ["dot", 0.07, 0.8, 0.04], ["bar", 0.13, 0.79, 0.22, 0.018], ["bar", 0.38, 0.787, 0.18, 0.026], ["bar", 0.04, 0.835, 0.66, 0.013], ["bar", 0.04, 0.858, 0.45, 0.013],
    ["band", 0, 0.935, 1, 0.065],
  ],
  youtube: [["bar", 0.03, 0.04, 0.4, 0.04], ["band", 0, 0.885, 1, 0.115], ["bar", 0.02, 0.895, 0.96, 0.008]],
  x: [["bar", 0.03, 0.9, 0.09, 0.055], ["dot", 0.95, 0.93, 0.05]],
  "x-square": [["bar", 0.03, 0.935, 0.09, 0.04], ["dot", 0.95, 0.955, 0.04]],
  "x-vertical": [["bar", 0.04, 0.8, 0.5, 0.014], ["bar", 0.04, 0.83, 0.7, 0.012], ["band", 0, 0.9, 1, 0.1]],
  linkedin: [["band", 0, 0.88, 1, 0.12], ["bar", 0.15, 0.93, 0.6, 0.012]],
  "linkedin-square": [["band", 0, 0.926, 1, 0.074], ["bar", 0.15, 0.955, 0.6, 0.012]],
  "linkedin-vertical": [["dot", 0.9, 0.62, 0.045], ["dot", 0.9, 0.7, 0.045], ["dot", 0.9, 0.78, 0.045], ["bar", 0.04, 0.8, 0.55, 0.014], ["bar", 0.04, 0.83, 0.62, 0.012], ["band", 0, 0.92, 1, 0.08]],
  square: [["dot", 0.06, 0.955, 0.04], ["dot", 0.94, 0.955, 0.04]],
};

// Each shape of a kind as a rectangle in a box of w by h: { x, y, w, h }.
function uiRects(kind, w, h) {
  return (UI[kind] || []).map(([type, x, y, a, b]) => (type === "dot" ? { x: x * w - (a * w) / 2, y: y * h - (a * w) / 2, w: a * w, h: a * w } : { x: x * w, y: y * h, w: a * w, h: b * h }));
}

function uiShapes(kind, box) {
  return (UI[kind] || [])
    .map(([type, x, y, a, b]) => {
      if (type === "dot") {
        const d = a * box.w;
        return `<div class="ui dot" style="left:${box.x + x * box.w - d / 2}px;top:${box.y + y * box.h - d / 2}px;width:${d}px;height:${d}px"></div>`;
      }
      return `<div class="ui ${type}" style="left:${box.x + x * box.w}px;top:${box.y + y * box.h}px;width:${a * box.w}px;height:${b * box.h}px"></div>`;
    })
    .join("");
}

// One panel: the frame where the app shows it, the app's buttons over it,
// the margins tinted and the space the captions may use outlined.
function panel(zone, frame, video, height) {
  if (zone.screen) {
    const s = height / zone.screen.height;
    const w = zone.screen.width * s;
    const v = zone.screen.video;
    const m = zone.reference.margins;
    const box = { x: 0, y: 0, w, h: height };
    const col = zone.reference.column;
    const safe = { x: m.left * s, y: m.top * s, w: (zone.screen.width - m.left - m.right) * s, h: (zone.screen.height - m.top - m.bottom) * s };
    return {
      width: w,
      html: `<div class="phone" style="width:${w}px;height:${height}px">
        <img src="${frame}" style="left:${v.x * s}px;top:${v.y * s}px;width:${v.width * s}px;height:${v.height * s}px">
        ${uiShapes(zone.ui, box)}
        <div class="margin" style="left:0;top:0;width:${w}px;height:${m.top * s}px"></div>
        <div class="margin" style="left:0;top:${height - m.bottom * s}px;width:${w}px;height:${m.bottom * s}px"></div>
        <div class="margin" style="left:0;top:${m.top * s}px;width:${m.left * s}px;height:${safe.h}px"></div>
        <div class="margin" style="left:${w - m.right * s}px;top:${m.top * s}px;width:${m.right * s}px;height:${safe.h}px"></div>
        ${col ? `<div class="margin" style="left:${w - col.width * s}px;top:${col.from * s}px;width:${(col.width - m.right) * s}px;height:${Math.max(0, height - m.bottom * s - col.from * s)}px"></div>` : ""}
        <div class="safe" style="left:${safe.x}px;top:${safe.y}px;width:${safe.w}px;height:${safe.h}px"></div>
      </div>`,
    };
  }
  const scale = Math.min(height / video.height, (height * 1.25) / video.width);
  const w = video.width * scale;
  const h = video.height * scale;
  const m = zone.margins;
  const box = { x: 0, y: 0, w, h };
  return {
    width: w,
    html: `<div class="frame" style="width:${w}px;height:${h}px;margin-top:${(height - h) / 2}px">
      <img src="${frame}" style="left:0;top:0;width:${w}px;height:${h}px">
      ${uiShapes(zone.ui, box)}
      <div class="margin" style="left:0;top:0;width:${w}px;height:${m.top * scale}px"></div>
      <div class="margin" style="left:0;top:${h - m.bottom * scale}px;width:${w}px;height:${m.bottom * scale}px"></div>
      <div class="margin" style="left:0;top:${m.top * scale}px;width:${m.left * scale}px;height:${h - (m.top + m.bottom) * scale}px"></div>
      <div class="margin" style="left:${w - m.right * scale}px;top:${m.top * scale}px;width:${m.right * scale}px;height:${h - (m.top + m.bottom) * scale}px"></div>
      <div class="safe" style="left:${m.left * scale}px;top:${m.top * scale}px;width:${w - (m.left + m.right) * scale}px;height:${h - (m.top + m.bottom) * scale}px"></div>
    </div>`,
  };
}

function marginsText(zone) {
  const r = zone.reference;
  const m = r.margins;
  const column = r.column ? `, buttons ${r.column.width} px wide from ${r.column.from} px down` : "";
  return `Top ${m.top}, bottom ${m.bottom}, left ${m.left}, right ${m.right} px of a ${r.width}x${r.height} ${zone.screen ? "screen" : "frame"}${column}.`;
}

const PAGE_CSS = `
html, body { margin: 0; background: #15161a; color: #e9e7e1; font: 15px/1.4 "Helvetica Neue", Arial, "Liberation Sans", sans-serif; }
.wrap { display: inline-flex; gap: 36px; padding: 32px; align-items: flex-start; }
.cell { display: flex; flex-direction: column; gap: 12px; }
.phone, .frame { position: relative; overflow: hidden; background: #000; }
.phone { border-radius: 26px; box-shadow: 0 0 0 6px #2b2c31; }
.frame { box-shadow: 0 0 0 2px #2b2c31; }
img { position: absolute; display: block; }
.ui { position: absolute; background: rgba(255, 255, 255, 0.78); box-shadow: 0 0 0 1.5px rgba(0, 0, 0, 0.55); }
.ui.dot { border-radius: 50%; }
.ui.bar { border-radius: 99px; }
.ui.band { background: rgba(20, 20, 22, 0.72); box-shadow: none; }
.margin { position: absolute; background: repeating-linear-gradient(135deg, rgba(255, 45, 45, 0.38) 0 6px, rgba(255, 45, 45, 0.12) 6px 12px); }
.safe { position: absolute; outline: 2px dashed #7cff9b; outline-offset: -1px; }
h2 { margin: 0; font-size: 18px; }
p { margin: 0; color: #b9b6ad; font-size: 13px; }
.note { padding: 0 32px 28px; color: #b9b6ad; font-size: 13px; max-width: 1400px; }
.sheet { display: grid; gap: 14px; padding: 24px; }
.shot { position: relative; }
.shot img { position: static; display: block; }
.shot b { position: absolute; left: 6px; top: 6px; background: rgba(0, 0, 0, 0.72); color: #fff; padding: 2px 7px; border-radius: 6px; font-size: 13px; }`;

async function screenshotPage(html, file, dir, { width = 1600, height = 900 } = {}) {
  const page = path.join(dir, `${path.basename(file, ".png")}-page.html`);
  fs.writeFileSync(page, html);
  const browser = await launch({ width, height });
  try {
    const tab = await openPage(browser, page, { width, height });
    await evaluate(tab, "Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => true)");
    const size = await evaluate(tab, "({ w: Math.ceil(document.querySelector('.root').getBoundingClientRect().width), h: Math.ceil(document.querySelector('.root').getBoundingClientRect().height) })");
    await tab.call("Emulation.setDeviceMetricsOverride", { width: Math.max(320, size.w), height: Math.max(200, size.h), deviceScaleFactor: 1, mobile: false });
    const { data } = await tab.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  } finally {
    await browser.close();
  }
}

// safe-zones.png: one frame of the captioned video under each place's
// buttons, one that shows the caption that reaches widest. `times` are the
// frames' times. The frames go to Chrome as PNG, converted to RGB with
// captioned.mp4's own matrix: a JPEG is read as BT.601, and ffmpeg writes
// the BT.709 picture of an HD video into one as it is, so its colors and
// the lit word's came out shifted. `frameTags` are burn's, for frameAt:
// a PNG of an SDR video names no primaries or transfer, which Chrome
// would convert its colors by.
async function safeZonesPng({ bins, video, output, zones, cue, times = [], file, dir, frameTags = {} }) {
  const frame = await frameAt(bins, output, shotOf(cue, times).seek, path.join(dir, "zone-frame.png"), { width: Math.min(1080, video.width), ...frameTags });
  const url = pathToFileURL(frame).href;
  const cells = zones.map((zone) => {
    const p = panel(zone, url, video, 640);
    return `<div class="cell" style="width:${Math.max(p.width, 300)}px">${p.html}
      <h2>${esc(zone.name)}</h2><p>${esc(marginsText(zone))}</p><p>From ${esc(zone.source)}, read ${esc(zone.read)}.</p>${zone.note ? `<p>${esc(zone.note)}</p>` : ""}</div>`;
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body><div class="root" style="display:inline-block">
    <div class="wrap">${cells.join("")}</div>
    <div class="note">Red: the margins each app covers with its buttons and text. Dashed green: where text is safe. The buttons are drawn roughly where each app puts them. Apps change their screens: check one post on a phone.</div>
  </div></body></html>`;
  await screenshotPage(html, file, dir);
}

// sheet.png: a frame of the captioned video for each caption, one that
// shows it, with its number and the frame's time.
async function sheetPng({ bins, video, output, cues, times = [], file, dir, frameTags = {} }) {
  const picked = sheetCues(cues);
  const shots = picked.map((cue) => shotOf(cue, times));
  const thumb = video.width >= video.height ? 400 : 240;
  const frames = await inPool(picked, (cue, i) => frameAt(bins, output, shots[i].seek, path.join(dir, `sheet-${String(i + 1).padStart(3, "0")}.png`), { width: thumb, ...frameTags }));
  const columns = video.width >= video.height ? 4 : 6;
  const cells = picked.map((cue, i) => `<div class="shot"><img src="${pathToFileURL(frames[i]).href}" width="${thumb}"><b>${cue.n} · ${clock(shots[i].time)}</b></div>`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head><body>
    <div class="root sheet" style="display:inline-grid;grid-template-columns:repeat(${Math.min(columns, picked.length)}, ${thumb}px)">${cells.join("")}</div></body></html>`;
  await screenshotPage(html, file, dir);
  return picked.length;
}

// Without Chrome: the sheet as ffmpeg's tile of frames, and each place's
// margins tinted over one frame with drawbox, side by side.
async function plainPictures({ bins, video, output, cues, times = [], zones, cue, sheetFile, zonesFile, dir, frameTags = {} }) {
  const picked = sheetCues(cues);
  const thumb = video.width >= video.height ? 400 : 240;
  const frames = await inPool(picked, (c, i) => frameAt(bins, output, shotOf(c, times).seek, path.join(dir, `sheet-${String(i + 1).padStart(3, "0")}.png`), { width: thumb, ...frameTags }));
  const columns = Math.min(video.width >= video.height ? 4 : 6, frames.length);
  const rows = Math.ceil(frames.length / columns);
  // The frames as one animated PNG, read by its name from its folder, as
  // the captions' states are.
  const strip = path.join(dir, "sheet.apng");
  writeApng(strip, frames.map((png) => ({ png, ms: 1000 })));
  let r = await run(bins.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-f", "apng", "-i", path.basename(strip), "-vf", `tile=${columns}x${rows}:padding=12:margin=12:color=0x15161a`, "-frames:v", "1", "-update", "1", path.resolve(sheetFile)], { cwd: dir });
  if (r.code !== 0) throw new Error(`ffmpeg could not make sheet.png: ${whyFailed(r)}`);
  const frame = await frameAt(bins, output, shotOf(cue, times).seek, path.join(dir, "zone-frame.png"), { width: 0, ...frameTags });
  const inputs = [];
  const parts = [];
  zones.forEach((zone, i) => {
    const m = zone.margins;
    const box = (x, y, w, h) => `drawbox=x=${Math.round(x)}:y=${Math.round(y)}:w=${Math.max(1, Math.round(w))}:h=${Math.max(1, Math.round(h))}:color=red@0.25:t=fill`;
    const W = video.out.width;
    const H = video.out.height;
    const boxes = [box(0, 0, W, m.top), box(0, H - m.bottom, W, m.bottom), box(0, m.top, m.left, H - m.top - m.bottom), box(W - m.right, m.top, m.right, H - m.top - m.bottom)];
    if (zone.column) boxes.push(box(W - zone.column.width, zone.column.from, zone.column.width, Math.max(1, H - m.bottom - zone.column.from)));
    boxes.push(`drawbox=x=${Math.round(m.left)}:y=${Math.round(m.top)}:w=${Math.round(W - m.left - m.right)}:h=${Math.round(H - m.top - m.bottom)}:color=0x7cff9b:t=4`);
    inputs.push(...(frame.includes("%") ? ["-pattern_type", "none"] : []), "-i", frame);
    parts.push(`[${i}:v]${boxes.join(",")},scale=-2:640,pad=iw+24:ih+24:12:12:color=0x15161a[p${i}]`);
  });
  const graph = zones.length > 1 ? `${parts.join(";")};${zones.map((_, i) => `[p${i}]`).join("")}hstack=inputs=${zones.length}[out]` : `${parts[0]};[p0]null[out]`;
  r = await run(bins.ffmpeg, ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...inputs, "-filter_complex", graph, "-map", "[out]", "-frames:v", "1", "-update", "1", zonesFile]);
  if (r.code !== 0) throw new Error(`ffmpeg could not make safe-zones.png: ${whyFailed(r)}`);
  return picked.length;
}

module.exports = { safeZonesPng, sheetPng, plainPictures, sheetCues, momentOf, shotOf, marginsText, uiRects, UI };
