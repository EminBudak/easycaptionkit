"use strict";

// Chrome draws every caption state once, on a see-through page the size of
// the video, in the brand's fonts: a cue for the line style, a cue with one
// word lit for karaoke, a word alone for the word style. Each state is a
// PNG of the band the captions sit in. The PNGs then go into one animated
// PNG, each for as long as its state lasts, which ffmpeg reads as one
// stream and lays over the video once.

const fs = require("node:fs");
const path = require("node:path");
const { launch, openPage, evaluate } = require("./chrome");
const { cueLines } = require("./cues");
const { inkOf } = require("./places");
const { writeApng } = require("./apng");
const { clusters } = require("./text");

// The cue's lines as words, each with whether a space goes before it.
const lineWords = cueLines;

// The page's style. The outline is drawn with SVG text stroked with round
// joins under the letters, since CSS text stroke joins its corners in
// points that stick out of a v or a W. Font names and ranges come from
// fonts.css and brand.json, which other tools read from websites: every
// "<" is escaped, so nothing in them can end the style element.
const css = (look, place, style) => {
  const font = place.fontPx;
  const { stroke, shadow } = place.ink || inkOf(font, { style, box: look.box });
  const faces = look.faces
    .map((f) => `@font-face { font-family: ${JSON.stringify(f.family)}; src: url(${JSON.stringify(f.url)}); font-weight: ${f.weight[0]} ${f.weight[1]}; font-style: ${f.italic ? "italic" : "normal"};${f.unicodeRange ? ` unicode-range: ${f.unicodeRange};` : ""} font-display: block; }`)
    .join("\n");
  const anchor =
    place.position === "top"
      ? `top: ${place.blockTop}px;`
      : place.position === "middle"
        ? `top: ${(place.blockTop + place.blockBottom) / 2}px; transform: translateY(-50%);`
        : `bottom: ${place.frame.height - place.blockBottom}px;`;
  const patch = look.highlightMode === "patch";
  return `${faces}
html, body { margin: 0; padding: 0; background: transparent; }
body { width: ${place.frame.width}px; height: ${place.frame.height}px; overflow: hidden; position: relative; }
#cap { position: absolute; left: ${place.side}px; right: ${place.side}px; ${anchor} display: grid; justify-items: center;
  font-family: ${look.stack}; font-weight: ${look.weight}; font-size: ${font}px; line-height: ${place.lineHeight};
  font-synthesis: none; text-align: center; font-kerning: normal; text-rendering: geometricPrecision; }
#cap .layer { grid-area: 1 / 1; display: flex; flex-direction: column; align-items: center; position: relative; }
#cap .back { z-index: 0; color: transparent; }
#cap .front { z-index: 2; color: ${look.textColor}; }
#cap .line { white-space: pre; unicode-bidi: plaintext; }
#cap .base { display: inline-block; width: 0; height: 0; vertical-align: baseline; }
#cap .w { padding: 0.02em 0.12em 0.06em; margin: 0 -0.12em; border-radius: 0.2em; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
#cap svg.ink { position: absolute; left: 0; top: 0; overflow: visible; z-index: 1; filter: drop-shadow(0 ${shadow.y}px ${shadow.blur}px rgba(0, 0, 0, 0.55)); }
#cap svg.ink text { fill: #000; stroke: #000; stroke-width: ${stroke * 2}px; stroke-linejoin: round; stroke-linecap: round; paint-order: stroke fill; white-space: pre; unicode-bidi: plaintext; }
${look.box ? `#cap .back .line { background: rgba(0, 0, 0, ${look.boxOpacity}); border-radius: 0.16em; padding: 0 0.3em; margin: 0 -0.3em; }` : ""}
${patch ? `#cap .back .lit { background: ${look.highlight}; }
#cap svg.ink .lit { fill: none; stroke: none; }
#cap .front .lit { color: ${look.highlightInk}; }` : `#cap .front .lit { color: ${look.highlight}; }`}
#probe { position: absolute; left: 0; top: ${place.frame.height + 50}px; width: ${place.frame.width}px; white-space: pre-line;
  font-family: ${look.stack}; font-weight: ${look.weight}; font-size: 40px; font-synthesis: none; }`.replace(/</g, "\\3c ");
};

// The page script: builds a state, fits each cue to the width, and finds
// the band all states fit in.
const SCRIPT = String.raw`
const D = window.__data;
const cap = document.getElementById("cap");
const NS = "http://www.w3.org/2000/svg";
function words(line, lit) {
  const frag = document.createDocumentFragment();
  const base = document.createElement("span");
  base.className = "base";
  frag.appendChild(base);
  for (const w of line) {
    if (w.s) frag.appendChild(document.createTextNode(" "));
    const span = document.createElement("span");
    span.className = w.i === lit ? "w lit" : "w";
    span.textContent = w.t;
    frag.appendChild(span);
  }
  return frag;
}
// The outline: each line again as SVG text, centered on the line and on
// its baseline, stroked with round joins under the letters.
function ink() {
  if (D.box) return;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ink");
  const box = cap.getBoundingClientRect();
  svg.setAttribute("width", String(box.width));
  svg.setAttribute("height", String(box.height));
  for (const line of cap.querySelectorAll(".front .line")) {
    const r = line.getBoundingClientRect();
    const text = document.createElementNS(NS, "text");
    text.setAttribute("x", String(r.left + r.width / 2 - box.left));
    text.setAttribute("y", String(line.querySelector(".base").getBoundingClientRect().bottom - box.top));
    text.setAttribute("text-anchor", "middle");
    for (const node of line.childNodes) {
      if (node.nodeType === 3) text.appendChild(document.createTextNode(node.data));
      else if (node.classList.contains("w")) {
        const span = document.createElementNS(NS, "tspan");
        if (node.classList.contains("lit")) span.setAttribute("class", "lit");
        span.textContent = node.textContent;
        text.appendChild(span);
      }
    }
    svg.appendChild(text);
  }
  cap.appendChild(svg);
}
// unit: the cue, or the cue's word k shown alone (word style).
function build(c, lit, solo, scale) {
  cap.textContent = "";
  if (c < 0) return;
  const lines = solo >= 0 ? [[{ t: D.cues[c].words[solo], s: false, i: solo }]] : D.cues[c].lines;
  for (const kind of ["back", "front"]) {
    const layer = document.createElement("div");
    layer.className = "layer " + kind;
    if (kind === "back") layer.setAttribute("aria-hidden", "true");
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = "line";
      div.dir = "auto";
      div.appendChild(words(line, lit));
      layer.appendChild(div);
    }
    cap.appendChild(layer);
  }
  cap.style.fontSize = (D.font * scale) + "px";
  ink();
}
function widest() {
  let w = 0;
  for (const line of cap.querySelectorAll(".front .line")) w = Math.max(w, line.getBoundingClientRect().width);
  return w;
}
// How far up and down what is built reaches: the letters as the font
// draws them (accents above the line, descenders below it), with the
// outline and its shadow around them, or the box.
const pen = document.createElement("canvas").getContext("2d");
function reach() {
  pen.font = D.weight + " " + cap.style.fontSize + " " + D.stack;
  let top = Infinity, bottom = -Infinity;
  const take = (a, b) => { top = Math.min(top, a); bottom = Math.max(bottom, b); };
  for (const line of cap.querySelectorAll(".front .line")) {
    const base = line.querySelector(".base").getBoundingClientRect().bottom;
    const m = pen.measureText(line.textContent);
    take(base - m.actualBoundingBoxAscent - D.above, base + m.actualBoundingBoxDescent + D.below);
    if (D.box) { const r = line.getBoundingClientRect(); take(r.top, r.bottom); }
  }
  if (D.patch) for (const w of cap.querySelectorAll(".back .w")) { const r = w.getBoundingClientRect(); take(r.top, r.bottom); }
  return { top, bottom };
}
// A caption whose widest line, with the outline or box around it, is
// wider than the safe space is drawn smaller, as much as it takes: the
// box grows and shrinks with the letters, the outline and its shadow keep
// their width in pixels. Then all of them move up or down together, as
// far as it takes for every state to stay inside the block the layout
// gives them.
window.__fit = () => {
  const scales = [];
  let top = Infinity, bottom = -Infinity;
  const measure = (c, solo) => {
    build(c, -1, solo, 1);
    const letters = widest();
    const w = letters + 2 * D.reach;
    const scale = w <= D.width ? 1 : Math.max(0.01, D.box ? D.width / w : (D.width - 2 * D.reach) / letters);
    if (scale < 1) build(c, -1, solo, scale);
    const r = cap.getBoundingClientRect();
    const k = reach();
    top = Math.min(top, r.top, k.top);
    bottom = Math.max(bottom, r.bottom, k.bottom);
    return scale;
  };
  D.cues.forEach((cue, c) => {
    if (D.style === "word") scales.push(cue.words.map((_, k) => measure(c, k)));
    else scales.push(measure(c, -1));
  });
  cap.textContent = "";
  const below = Math.max(0, bottom - D.blockBottom);
  const above = Math.max(0, D.blockTop - top);
  const shift = Number.isFinite(top) ? (D.position === "top" ? above || -below : -below || above) : 0;
  cap.style.translate = "0 " + shift + "px";
  return { scales, top: top + shift, bottom: bottom + shift, shift };
};
window.__show = (c, lit, solo) => {
  const scale = c < 0 ? 1 : D.style === "word" ? D.scales[c][solo] : D.scales[c];
  build(c, lit, solo, scale);
  return true;
};
`;

function pageHtml(look, place, style, data) {
  return `<!doctype html>
<html${look.lang ? ` lang="${look.lang}"` : ""}><head><meta charset="utf-8"><title>captions</title>
<style>${css(look, place, style)}</style></head>
<body><div id="cap"></div><div id="probe"></div>
<script>window.__data = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>
<script>${SCRIPT}</script></body></html>`;
}

// Draws every state of the timeline to PNGs in `dir` and puts them in one
// animated PNG. Returns { file, y, height, reach, states, fonts, first,
// failedFonts, shrunk, scales, boxes }: the band the PNGs cover, the rows
// the captions reach in it, how many states there are, which fonts drew
// the letters and which of them is the first of the list this machine
// has, how many captions had to be drawn smaller to fit, and the letters
// Chrome drew as boxes. `boxed(letters, fonts)` gives those, of the
// letters of the captions and the fonts Chrome names for them
// (chromeBoxes); without it, none are.
async function renderStates({ cues, words, states, style, look, place, duration, dir, log = () => {}, boxed = null }) {
  const W = place.frame.width;
  const H = place.frame.height;
  const ink = place.ink || inkOf(place.fontPx, { style, box: look.box });
  const data = {
    style,
    font: place.fontPx,
    weight: look.weight,
    stack: look.stack,
    width: place.textWidth,
    reach: ink.reach,
    box: Boolean(look.box),
    patch: look.highlightMode === "patch" && style !== "line",
    // The outline reaches past the letters by its stroke, and its shadow
    // goes down by its offset and blurs out by its blur.
    above: look.box ? 0 : ink.stroke + Math.max(0, ink.shadow.blur - ink.shadow.y),
    below: look.box ? 0 : ink.stroke + ink.shadow.y + ink.shadow.blur,
    position: place.position,
    blockTop: place.blockTop,
    blockBottom: place.blockBottom,
    cues: cues.map((cue) => ({ lines: lineWords(cue, words), words: words.slice(cue.first, cue.last + 1).map((w) => w.text) })),
  };
  const file = path.join(dir, "captions-page.html");
  fs.writeFileSync(file, pageHtml(look, place, style, data));
  // The page is the size of the video; Chrome's window is never smaller
  // than 320 px a side, since below that it gives no picture of the page.
  const browser = await launch({ width: Math.max(W, 320), height: Math.max(H, 320) });
  try {
    const page = await openPage(browser, file, { width: W, height: H, transparent: true });
    // The letters the captions show, each word on a line of its own:
    // Chrome counts a space as a letter of the font that drew it, the
    // first of the list, and a script written without spaces shows none.
    // The fonts load for every letter of them before the first shot, and
    // Chrome says which font drew which letters.
    const probeText = cues.flatMap((cue) => cue.lines.flatMap((line) => line.split(/\s+/))).filter(Boolean).join("\n");
    const letters = [...new Set(probeText.replace(/\n/g, ""))].join("");
    const loaded = await evaluate(
      page,
      `(async () => {
        const spec = ${JSON.stringify(`${look.weight} ${place.fontPx}px ${look.stack}`)};
        try { await document.fonts.load(spec, ${JSON.stringify(letters)}); } catch (e) {}
        await document.fonts.ready;
        return [...document.fonts].filter((f) => f.status === "error").map((f) => f.family);
      })()`,
      60_000,
    );
    const named = await fontsOf(page, probeText);
    // A letter no font Chrome found has is a box, which Chrome says the
    // first font of the list drew. Those letters are left out when it is
    // asked again, so the fonts it names drew the letters that show.
    const boxes = boxed ? boxed([...new Set(probeText.split("\n").flatMap((word) => clusters(word)))], named) : [];
    const rest = boxes.length ? withoutLetters(probeText, new Set(boxes)) : probeText;
    const fonts = !boxes.length ? named : rest ? await fontsOf(page, rest) : [];
    // The first font of the list this machine has: the one that draws
    // plain Latin letters. The others draw only what it lacks.
    const latin = await fontsOf(page, "Hamburgefonstiv");
    await evaluate(page, `document.getElementById("probe").textContent = ""; true`);
    const fit = await evaluate(page, "__fit()", 120_000);
    await evaluate(page, `window.__data.scales = ${JSON.stringify(fit.scales)}; true`);
    // The band: every state fits in it, with room for the outline and
    // shadow; even, so it lands on whole chroma samples.
    const spill = Math.ceil(ink.reach + ink.shadow.y + place.fontPx * 0.05);
    let y = Math.max(0, Math.floor(fit.top - spill));
    let bottom = Math.min(H, Math.ceil(fit.bottom + spill));
    if (!Number.isFinite(fit.top)) {
      y = Math.round(place.blockTop);
      bottom = Math.round(place.blockBottom);
    }
    y -= y % 2;
    let height = bottom - y;
    height += height % 2;
    if (y + height > H) height = H - y - ((H - y) % 2);
    const shot = async (name) => {
      const { data: png } = await page.call("Page.captureScreenshot", { format: "png", clip: { x: 0, y, width: W, height, scale: 1 }, fromSurface: true, captureBeyondViewport: false });
      const out = path.join(dir, name);
      fs.writeFileSync(out, Buffer.from(png, "base64"));
      return out;
    };
    await evaluate(page, "__show(-1, -1, -1)");
    const blank = await shot("state-blank.png");
    // One PNG per distinct state, in time order.
    const made = new Map();
    const timeline = [];
    let count = 0;
    const total = states.length;
    let shown = -1;
    for (const state of states) {
      // The spoken word is lit in both styles that follow the words.
      const lit = style === "line" ? -1 : state.word;
      const solo = style === "word" ? state.word : -1;
      const key = `${state.cue}:${lit}:${solo}`;
      if (!made.has(key)) {
        await evaluate(page, `__show(${state.cue}, ${lit}, ${solo})`);
        made.set(key, await shot(`state-${String(made.size + 1).padStart(5, "0")}.png`));
      }
      timeline.push({ from: state.from, to: state.to, file: made.get(key) });
      count++;
      const step = Math.floor((count / total) * 4);
      if (step > shown && step > 0 && total > 200) {
        shown = step;
        log(`Drew ${count} of ${total} caption states`);
      }
    }
    const animation = path.join(dir, "states.apng");
    writeApng(animation, statesFrames(timeline, blank, duration));
    const all = style === "word" ? fit.scales.flat() : fit.scales;
    const shrunk = all.filter((s) => s < 1).length;
    // The rows every state stays in, its outline and shadow included.
    const reach = Number.isFinite(fit.top) ? { top: Math.max(0, Math.floor(fit.top)), bottom: Math.min(H, Math.ceil(fit.bottom)) } : null;
    return { file: animation, y, height, reach, states: made.size + 1, fonts, first: latin.length ? latin[0].family : "", failedFonts: loaded || [], shrunk, smallest: all.reduce((a, b) => Math.min(a, b), 1), scales: fit.scales, boxes };
  } finally {
    await browser.close();
  }
}

// The words of the probe, one a line, without the letters of `left`: a
// word of those letters alone goes.
const withoutLetters = (text, left) =>
  text
    .split("\n")
    .map((word) => clusters(word).filter((c) => !left.has(c)).join(""))
    .filter(Boolean)
    .join("\n");

// Which fonts Chrome draws a text with, and how many letters each. Chrome
// says so only of text it has laid out, and a text just set is laid out at
// the next frame: the probe is laid out in the same step its text is set
// in, and asked again after a frame when Chrome still says nothing.
async function fontsOf(page, text) {
  for (let tries = 0; tries < 2; tries++) {
    await evaluate(page, `(() => { const probe = document.getElementById("probe"); if (probe.textContent !== ${JSON.stringify(text)}) probe.textContent = ${JSON.stringify(text)}; probe.getBoundingClientRect(); return true; })()`);
    const fonts = await fontsUsed(page);
    if (fonts.length) return fonts;
    await evaluate(page, "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))");
  }
  return [];
}

// Which fonts Chrome drew the probe text with, and how many letters each.
async function fontsUsed(page) {
  try {
    await page.call("DOM.enable");
    await page.call("CSS.enable");
    const { root } = await page.call("DOM.getDocument", { depth: 1 });
    const { nodeId } = await page.call("DOM.querySelector", { nodeId: root.nodeId, selector: "#probe" });
    const { fonts } = await page.call("CSS.getPlatformFontsForNode", { nodeId });
    return (fonts || []).map((f) => ({ family: f.familyName, postScriptName: f.postScriptName || "", custom: Boolean(f.isCustomFont), glyphs: f.glyphCount })).sort((a, b) => b.glyphs - a.glyphs);
  } catch {
    return [];
  }
}

// The frames of the animated PNG: each state's PNG for as long as it
// shows, and the blank PNG in the gaps, from 0 to the end of the last
// state. Each frame starts and ends on a whole millisecond of the video's
// time, so no change drifts from its time however many come before it.
// The stream ends with the blank PNG a second after the last state: once
// the stream ends, the overlay passes the video on as it is, and a caption
// still showing then would go with it. The video's length bounds the
// states and nothing else, so a header that claims more than the file
// holds makes no longer a stream.
function statesFrames(timeline, blank, duration) {
  const at = (t) => Math.round(Math.min(Math.max(t, 0), duration) * 1000);
  const frames = [];
  let now = 0;
  const add = (png, ms) => {
    const last = frames[frames.length - 1];
    if (last && last.png === png) last.ms += ms;
    else frames.push({ png, ms });
  };
  const until = (png, t) => {
    const end = at(t);
    if (end <= now) return;
    add(png, end - now);
    now = end;
  };
  for (const item of timeline) {
    if (at(item.from) > now) until(blank, item.from);
    until(item.file, item.to);
  }
  add(blank, 1000);
  return frames;
}

module.exports = { renderStates, statesFrames, lineWords, pageHtml, fontsOf };
