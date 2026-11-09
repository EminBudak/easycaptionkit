"use strict";

// Words into captions. A caption (a cue) is a run of words shown together,
// at most `lines` lines of at most `maxChars` columns each. The cuts are
// chosen over the whole text at once, by dynamic programming: a cue ends
// best where a sentence ends, next best at a comma or a pause, and worst in
// the middle of a phrase; a pause inside a cue costs, and so do cues that
// are too short to read or too long to hold.

const { width, characters, join, spaced, endsSentence, endsClause } = require("./text");

const MAX_WORDS = 40;
const PARTICLE = /^(?:は|が|を|に|で|と|も|へ|や|の|から|まで|より|けど|ので)$/u;
const NO_LINE_START = /^(?:[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮーゝゞヽヾ]|(?:は|が|を|に|で|と|も|へ|や|の|ね|よ)$)/u;
// Reading speed people can follow, in characters a second, and the limit
// past which a cue counts as fast (Netflix's for adult English programmes).
const COMFORT_CPS = 17;
const FAST_CPS = 20;

// Japanese: a line or a caption does not start with a particle or a small
// kana, and does not split a word the segmenter cut in two: kanji from the
// kana that ends it (高|く) or the polite お and ご from what follows them
// (お|兄さん).
function badBreak(before, after) {
  if (NO_LINE_START.test(after)) return true;
  if (/\p{Script=Han}$/u.test(before) && /^\p{Script=Hiragana}/u.test(after)) return true;
  return /^[おご]$/u.test(before) && /^\p{Script=Han}/u.test(after);
}

// Each word measured once: its columns, whether a space comes before it,
// and what kind of break comes after it. A run of words then measures as
// a difference of sums, without joining any text.
function measure(texts) {
  const n = texts.length;
  const at = new Float64Array(n + 1);
  const gap = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    gap[k] = k > 0 && spaced(texts[k - 1], texts[k]) ? 1 : 0;
    at[k + 1] = at[k] + gap[k] + width(texts[k]);
  }
  const sentence = texts.map(endsSentence);
  const clause = texts.map(endsClause);
  const particle = texts.map((t) => PARTICLE.test(t));
  const bad = texts.map((t, k) => k > 0 && badBreak(texts[k - 1], t));
  const bads = new Uint32Array(n + 1);
  for (let k = 0; k < n; k++) bads[k + 1] = bads[k] + (bad[k] ? 1 : 0);
  return {
    texts,
    sentence,
    clause,
    particle,
    bad,
    // Columns of words i..j-1 on one line.
    span: (i, j) => at[j] - at[i] - gap[i],
    // Bad places to break between words i..j-1.
    badInside: (i, j) => (j - i > 1 ? bads[j] - bads[i + 1] : 0),
  };
}

// Whether words i..j-1 fit on `lines` lines of `maxChars` columns: filling
// each line as far as it goes uses the fewest lines.
function fits(m, i, j, lines, maxChars) {
  let used = 1;
  let start = i;
  for (let k = i + 1; k <= j; k++) {
    if (m.span(start, k) <= maxChars) continue;
    if (k - 1 === start) return false;
    used++;
    start = k - 1;
    if (used > lines || m.span(start, k) > maxChars) return false;
  }
  return true;
}

// The best cuts for words i..j-1 on at most `lines` lines: [] when they fit
// on one, null when they do not fit at all; otherwise as few lines as fit,
// balanced, and broken after punctuation when that costs little.
function bestCuts(m, i, j, lines, maxChars) {
  if (m.span(i, j) <= maxChars) return [];
  if (lines < 2 || j - i < 2) return null;
  let best = null;
  const breakCost = (cut) => {
    let cost = 0;
    if (m.sentence[cut - 1]) cost -= 12;
    else if (m.clause[cut - 1]) cost -= 8;
    // A particle ends a phrase, which is a good place to break.
    if (m.bad[cut]) cost += 30;
    else if (m.particle[cut - 1]) cost -= 6;
    return cost;
  };
  const score = (widths, cuts) => {
    let cost = Math.max(...widths) - Math.min(...widths);
    // A top line longer than the one under it reads worse than the other way.
    for (let k = 0; k + 1 < widths.length; k++) if (widths[k] > widths[k + 1]) cost += 0.3 * (widths[k] - widths[k + 1]);
    for (const cut of cuts) cost += breakCost(cut);
    cost += widths.length * 50;
    if (!best || cost < best.cost) best = { cost, cuts };
  };
  for (let a = i + 1; a < j; a++) {
    const first = m.span(i, a);
    if (first > maxChars) break;
    const rest = m.span(a, j);
    if (rest <= maxChars) score([first, rest], [a]);
    if (lines < 3) continue;
    for (let b = a + 1; b < j; b++) {
      const second = m.span(a, b);
      if (second > maxChars) break;
      const third = m.span(b, j);
      if (third <= maxChars) score([first, second, third], [a, b]);
    }
  }
  return best ? best.cuts : null;
}

function linesAt(m, i, j, cuts) {
  const bounds = [i, ...cuts, j];
  return bounds.slice(1).map((end, k) => join(m.texts.slice(bounds[k], end)));
}

// The best way to set words on at most `lines` lines of `maxChars`
// columns, or null when they do not fit. One line when they fit on one;
// otherwise as few lines as fit, balanced, and broken after punctuation
// when that costs little.
function layout(texts, lines, maxChars) {
  const m = measure(texts);
  const cuts = bestCuts(m, 0, texts.length, lines, maxChars);
  return cuts ? linesAt(m, 0, texts.length, cuts) : null;
}

// What a cue made of words[i..j) costs, the cut after it included.
function cueCost(words, m, i, j, { maxChars, lines, blockEnd }) {
  const last = words[j - 1];
  const next = j < words.length ? words[j] : null;
  let cost = 1;
  if (next && !blockEnd) {
    const pause = next.start - last.end;
    if (m.sentence[j - 1]) cost += 0;
    else if (m.clause[j - 1]) cost += pause > 0.25 ? 0.5 : 1.5;
    else if (m.particle[j - 1]) cost += pause > 0.25 ? 1 : 2.5;
    else if (pause >= 0.5) cost += 1.5;
    else if (pause >= 0.25) cost += 3;
    else cost += 6;
    if (m.bad[j]) cost += 8;
    if (next.seg !== last.seg && next.seg >= 0) cost -= 0.8;
  }
  for (let k = i; k < j - 1; k++) {
    if (m.sentence[k]) cost += 2.5;
    const pause = words[k + 1].start - words[k].end;
    if (pause >= 0.7) cost += 4;
    else if (pause >= 0.4) cost += 1.5;
  }
  const fill = m.span(i, j) / (lines * maxChars);
  cost += 2 * (1 - Math.min(1, fill)) ** 2;
  const duration = last.end - words[i].start;
  if (duration < 0.7 && next && !blockEnd && !m.sentence[j - 1]) cost += 2;
  return cost;
}

// Cuts one block of words (never joined with the next) into cues.
function cutBlock(words, m, from, to, options) {
  const { maxChars, lines, maxDuration } = options;
  const n = to - from;
  const best = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= Math.max(0, j - MAX_WORDS); i--) {
      const single = j - i === 1;
      if (!single && !fits(m, from + i, from + j, lines, maxChars)) break;
      const duration = words[from + j - 1].end - words[from + i].start;
      if (duration > maxDuration && !single) break;
      let cost = best[i] + cueCost(words, m, from + i, from + j, { maxChars, lines, blockEnd: from + j === to });
      // A cue whose next one comes on as it does would never show.
      if (from + j < to && words[from + j].start <= words[from + i].start) cost += 100;
      // A caption whose lines can only break in a bad place costs as much
      // as a bad cut between captions.
      if (!single && m.badInside(from + i, from + j)) {
        const cuts = bestCuts(m, from + i, from + j, lines, maxChars);
        if (cuts && cuts.some((cut) => m.bad[cut])) cost += 8;
      }
      if (cost < best[j]) {
        best[j] = cost;
        back[j] = i;
      }
    }
  }
  const cuts = [];
  for (let j = n; j > 0; j = back[j]) cuts.unshift([from + back[j], from + j]);
  return cuts;
}

// Cues from words. options: { maxChars, lines, maxDuration, hard, duration }
// where hard says segments are never joined, and duration (the video's
// length) is where the last cue has to end.
function buildCues(words, options) {
  const opts = { maxDuration: 7, ...options };
  const blocks = [];
  let start = 0;
  for (let k = 1; k <= words.length; k++) {
    const gap = k < words.length ? words[k].start - words[k - 1].end : 0;
    // Segments that come on at the same moment, like two steps of a demo
    // at one time, are shown together: apart, the first would never show.
    const segment = opts.hard && words[k] && words[k].seg !== words[k - 1].seg && words[k].start > words[start].start;
    const boundary = k === words.length || segment || gap > 2.5;
    if (boundary) {
      blocks.push([start, k]);
      start = k;
    }
  }
  const m = measure(words.map((w) => w.text));
  const cues = [];
  for (const [from, to] of blocks) {
    for (const [i, j] of cutBlock(words, m, from, to, opts)) {
      const cuts = bestCuts(m, i, j, opts.lines, opts.maxChars) || [];
      const lines = linesAt(m, i, j, cuts);
      // cuts: where each line after the first starts, so the lines can be
      // set again word by word without joining any text.
      cues.push({ first: i, last: j - 1, start: words[i].start, end: words[j - 1].end, spoken: words[j - 1].end, lines, cuts, text: lines.join(" ") });
    }
  }
  time(cues, opts);
  cues.forEach((cue, i) => {
    cue.n = i + 1;
    cue.chars = characters(cue.lines.join("\n"));
    cue.cps = cue.end > cue.start ? cue.chars / (cue.end - cue.start) : Infinity;
    cue.wide = cue.lines.some((line) => width(line) > opts.maxChars);
  });
  return cues;
}

// When each cue shows. It comes on with its first word. A short gap to the
// next cue is closed so the captions do not blink; a cue too short to read
// is held longer where there is room; after the last word of a cue that
// nothing follows soon, it stays a little. A cue the next one would
// replace as it comes on still shows for a moment, and the next one comes
// on after it: no cue ends where it starts.
const BRIEF = 0.2;
function time(cues, { duration = Infinity }) {
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const next = cues[i + 1];
    const until = Math.min(next ? next.start : Infinity, duration);
    const want = Math.max(0.9, characters(cue.text) / COMFORT_CPS);
    let end = Math.min(Math.max(cue.spoken + 0.4, cue.start + want), cue.spoken + 1.2);
    if (next && next.start - end < 0.3) end = next.start;
    cue.end = Math.max(cue.start, Math.min(end, until));
    if (cue.end <= cue.start) {
      cue.end = Math.min(cue.start + BRIEF, Math.max(duration, cue.start + 0.001));
      if (next && next.start < cue.end) next.start = cue.end;
    }
  }
}

// A cue's lines as words: { t: the text, s: whether a space comes before
// it, i: its place in the cue }. A cue made without its cuts has them
// found again from its lines.
function cueLines(cue, words) {
  let cuts = cue.cuts;
  if (!cuts) {
    cuts = [];
    let k = cue.first;
    for (const line of cue.lines.slice(0, -1)) {
      let built = "";
      while (k <= cue.last && built.length < line.length) built = join([built, words[k++].text].filter(Boolean));
      cuts.push(k);
    }
  }
  const bounds = [cue.first, ...cuts, cue.last + 1];
  return bounds.slice(1).map((end, n) => {
    const line = [];
    for (let k = bounds[n]; k < end; k++) line.push({ t: words[k].text, s: k > bounds[n] && spaced(words[k - 1].text, words[k].text), i: k - cue.first });
    return line;
  });
}

// The states a karaoke or word style shows, in time order: { from, to,
// cue, word } where word is the index in the cue of the word that is lit,
// or shown alone; -1 for the whole cue unlit. Between cues nothing shows.
function states(cues, words, style) {
  const out = [];
  for (const [c, cue] of cues.entries()) {
    if (style === "line") {
      out.push({ from: cue.start, to: cue.end, cue: c, word: -1 });
      continue;
    }
    const count = cue.last - cue.first + 1;
    for (let k = 0; k < count; k++) {
      const w = words[cue.first + k];
      const from = k === 0 ? cue.start : Math.max(cue.start, w.start);
      let to = k + 1 < count ? Math.max(from, words[cue.first + k + 1].start) : cue.end;
      // A word shown alone does not stay up through a long pause.
      if (style === "word" && to - w.end > 1.0) to = Math.max(from + 0.1, w.end + 1.0);
      to = Math.min(to, cue.end);
      if (to - from > 0.0005) out.push({ from, to, cue: c, word: k });
    }
  }
  return out;
}

// Reading speed over all cues: the fastest, the median and the cues past
// FAST_CPS, slowest last.
function readingSpeed(cues) {
  const speeds = cues.map((c) => c.cps).filter(Number.isFinite).sort((a, b) => a - b);
  const median = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
  const fast = cues.filter((c) => c.cps > FAST_CPS).sort((a, b) => b.cps - a.cps);
  return {
    limit: FAST_CPS,
    comfort: COMFORT_CPS,
    fastest: speeds.length ? round(speeds[speeds.length - 1], 1) : 0,
    median: round(median, 1),
    fast: fast.map((c) => ({ n: c.n, start: round(c.start, 3), end: round(c.end, 3), cps: round(c.cps, 1), text: c.text })),
  };
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

module.exports = { buildCues, layout, states, cueLines, readingSpeed, badBreak, FAST_CPS, COMFORT_CPS };
