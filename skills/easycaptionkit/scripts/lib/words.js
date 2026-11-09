"use strict";

// Reads the words to caption and their times from whatever made them: a
// speech-to-text JSON with word times (OpenAI verbose_json, whisper.cpp,
// WhisperX, ElevenLabs, Deepgram, AssemblyAI, NeMo, Parakeet, Hugging Face
// transformers, AWS Transcribe, Google Speech-to-Text), an SRT or WebVTT
// file, easyscreenshotkit's steps.json, or a words.json this kit wrote.
//
// Every reader gives the same list: { text, start, end, seg, timed }, in
// seconds. seg numbers the segment a word came in (a cue of an SRT file, a
// step, a speech-to-text segment); hard segments are never joined in one
// caption. timed is false for a word whose time was spread over its
// segment by length, since the file gave times for whole lines only.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { width, SPACELESS } = require("./text");
const { readAtMost, readAtMostLater, jsonShape, jsonProblem, sizeText } = require("./files");

// The SHA-256 of the words of a words.json, as JSON: a words.json says
// what its run wrote, so a later run can tell the words were fixed by
// hand since.
const wordsSha256 = (words) => crypto.createHash("sha256").update(JSON.stringify(words)).digest("hex");

// Whether the words of a words.json this kit wrote were fixed by hand:
// they are not the words its run wrote, or that run read them from a
// words.json fixed by hand. One that does not say what its run wrote
// cannot be told apart from one fixed by hand.
function handFixed(data) {
  if (!data || data.fixed === true) return true;
  return !(Array.isArray(data.words) && typeof data.wordsSha256 === "string" && wordsSha256(data.words) === data.wordsSha256);
}

const FORMATS = {
  easycaptionkit: "a words.json from easycaptionkit",
  steps: "easyscreenshotkit's steps.json",
  srt: "an SRT file",
  vtt: "a WebVTT file",
  openai: "OpenAI verbose_json",
  whispercpp: "whisper.cpp JSON",
  whisperx: "WhisperX or faster-whisper JSON",
  elevenlabs: "ElevenLabs speech-to-text JSON",
  deepgram: "Deepgram JSON",
  assemblyai: "AssemblyAI JSON",
  nemo: "NeMo JSON",
  parakeet: "Parakeet JSON",
  transformers: "Hugging Face transformers JSON (chunks)",
  aws: "AWS Transcribe JSON",
  google: "Google Speech-to-Text JSON",
  words: "a JSON list of words with times",
  segments: "a JSON list of lines with times",
};

// The most a run takes: 100,000 words, some 10 hours of speech, of at most
// 500 characters each and a million in all. Past that a file is no words
// to caption, as one word of megabytes is not, and a run of it would take
// gigabytes and minutes, and write a words.json and a captions.json too
// big for the next run into the folder to read back.
const MOST_WORDS = 100_000;
const LONGEST_WORD = 500;
const MOST_TEXT = 1_000_000;
const big = (n) => n.toLocaleString("en-US");
const tooMuch = (message) => Object.assign(new Error(message), { code: "EWORDS" });
const tooLong = (length) => tooMuch(`it holds a word ${big(length)} characters long, and a word to caption is at most ${LONGEST_WORD}. Check that it holds the words of the video, each with its time`);
// The count of words, or of characters, or none where the reading stopped
// at the most.
const tooMany = (count = 0) => tooMuch(`it holds ${count ? big(count) : `more than ${big(MOST_WORDS)}`} words, and a run takes at most ${big(MOST_WORDS)}, some 10 hours of speech. Caption a longer video in parts, each with its own words`);
const tooMuchText = (count = 0) => tooMuch(`its words hold ${count ? big(count) : `more than ${big(MOST_TEXT)}`} characters, and a run takes at most ${big(MOST_TEXT)}, some 10 hours of speech. Caption a longer video in parts, each with its own words`);

// Words within what a run takes, or the error that says how they are not.
function withinLimits(words) {
  if (words.length > MOST_WORDS) throw tooMany(words.length);
  let text = 0;
  for (const w of words) {
    const length = String(w.text).length;
    if (length > LONGEST_WORD) throw tooLong(length);
    text += length;
  }
  if (text > MOST_TEXT) throw tooMuchText(text);
  return words;
}

// What a reader has read so far, for the limits to stop the reading as
// soon as it passes one, across a whole file: words and their characters,
// the lines of a subtitle file's cues and the entries of a JSON file's
// lists.
const tally = () => ({ words: 0, text: 0, lines: 0, items: 0 });

// A cue of a subtitle file loses at most its first three lines, as the
// repeats of rolling captions, and each line it keeps holds a word: one
// of more lines than that is more words than a run takes, which is said
// as it is read.
const MOST_LINES = MOST_WORDS + 3;

// The lines of text a subtitle file holds in all, across its cues: five
// for each word a run takes, as rolling captions say each line up to three
// times, and a roll-up of four lines up to five. Past that the file is
// refused as it is read, before its lines take gigabytes.
const MOST_ALL_LINES = 5 * MOST_WORDS;
const tooManyLines = () => tooMuch(`it holds more than ${big(MOST_ALL_LINES)} lines of captions, and a run takes at most ${big(MOST_WORDS)} words, some 10 hours of speech. Caption a longer video in parts, each with its own words`);

// The entries a JSON file's lists hold in all, five for each word a run
// takes: a speech-to-text's list of words can hold a spacing or a mark of
// punctuation between them, and its tokens are pieces of words. Each list
// is counted before any of it is read, so a list of millions of entries is
// refused before it is made into words.
const MOST_ITEMS = 5 * MOST_WORDS;
const tooManyItems = () => tooMuch(`it holds more than ${big(MOST_ITEMS)} entries, and a run takes at most ${big(MOST_WORDS)} words, some 10 hours of speech. Caption a longer video in parts, each with its own words`);
function listed(list, read) {
  read.items += list.length;
  if (read.items > MOST_ITEMS) throw tooManyItems();
  return list;
}

// The lists and objects a JSON text may open in all, five for each entry
// of its lists a run takes, as a word of a speech-to-text's list is an
// object that holds a few more, and how deep they may nest, where a
// speech-to-text's JSON nests them a few deep. Both are looked at before
// the text is parsed: a text of 64 MB, which a words file can be, of
// millions of empty objects or of lists opened one inside another took
// JSON.parse and badAt gigabytes and half a minute before anything was
// counted. A words.json and a captions.json a run writes, of the most
// words, hold under half a million.
const MOST_OPENED = 5 * MOST_ITEMS;
const DEEPEST = 64;
const tooDeep = () => tooMuch(`it nests lists and objects more than ${DEEPEST} deep, where a words file nests them a few deep. Check that it holds the words of the video, each with its time`);

// The fewest words a line of a subtitle file gives once it is cleaned:
// runs of what is not a space, as its tags, its entities and its control
// characters give none, found a character at a time without making
// anything of the line. A line of more of them than a run takes is
// refused before it is cleaned, which for millions of words takes
// seconds and gigabytes; a shorter line cannot hold that many.
function fewestWords(line) {
  if (line.length <= 2 * MOST_WORDS) return;
  let words = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    // A tag or an override block, to its end or the end of the line.
    if (c === 0x3c || (c === 0x7b && line.charCodeAt(i + 1) === 0x5c)) {
      const close = line.indexOf(c === 0x3c ? ">" : "}", i + 1);
      i = close < 0 ? line.length : close;
      continue;
    }
    if (c === 0x26) {
      const entity = /^&(?:#x[0-9a-f]+|#\d+|[a-z]+);/i.exec(line.slice(i, i + 40));
      if (entity) {
        i += entity[0].length - 1;
        continue;
      }
    }
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) continue;
    if (c === 0x20 || c === 0x09 || c === 0x0a || (c > 0x7f && /\s/.test(line[i]))) {
      inWord = false;
      continue;
    }
    if (inWord) continue;
    inWord = true;
    if (++words > MOST_WORDS) throw tooMany();
  }
}

// ─── times ────────────────────────────────────────────────────────────────

// Seconds from 12.5, "12.5", "12.5s" (Google), "00:00:12,500" or
// "00:12.500" (SRT, VTT, whisper.cpp) and "1:02:03.25" (ASS).
function seconds(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  let m;
  if ((m = /^(-?\d+(?:\.\d+)?)s?$/.exec(text))) return Number(m[1]);
  if ((m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(text))) {
    const fraction = m[4] ? Number(m[4]) / 10 ** m[4].length : 0;
    return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + fraction;
  }
  return NaN;
}

const first = (object, keys) => {
  for (const key of keys) if (object && object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
};

// An entry of a speech-to-text list that can be read: an object, where a
// null or a number in its place is passed over.
const entry = (value) => Boolean(value) && typeof value === "object";

// A value of a JSON file as text: a string as it is, a finite number as
// its digits, and anything else as none. An object or a list where a
// word's text goes gives no word, rather than "[object Object]" or "a,b"
// burned into the video, and one with a toString or a valueOf of its own,
// which JavaScript cannot make text of, stops no run with an error that
// names no file.
const textOf = (value) => (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "");

// A value of a JSON file as a number, as Number takes it, but an object or
// a list, which is none, for the same reason.
const numberOf = (value) => (value !== null && typeof value === "object" ? NaN : Number(value));

// ─── the list every reader returns ────────────────────────────────────────

// Text on one line, its control characters out and each run of spaces and
// line breaks one space. A space that is one already stays as it is, so a
// line of millions of words is not made again a word at a time.
function cleanText(text) {
  return textOf(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\s{2,}|[^\S ]/g, " ")
    .trim();
}

// The latest time a subtitle file can say to the millisecond: past it, as
// 1e308 s is, a time in milliseconds is no whole number, or no number.
const LAST_TIME = Number.MAX_SAFE_INTEGER / 1000;

// Words in order, with times made sound: a word with no time, or one past
// what a subtitle file can say, placed between its neighbors, and marked
// placed, an end before its start set to the start, and nothing before
// zero. With `bySegment` (an SRT's cues, a demo's steps) the words of one
// segment stay together, in the segments' order.
function settle(words, { bySegment = false } = {}) {
  const out = words.filter((w) => w.text);
  out.forEach((w, i) => (w.order = i));
  for (const w of out) {
    if (!(Math.abs(w.start) <= LAST_TIME)) w.start = NaN;
    if (!(Math.abs(w.end) <= LAST_TIME)) w.end = NaN;
  }
  const known = (w) => Number.isFinite(w.start) && Number.isFinite(w.end);
  // Fill a run of untimed words from the neighbors, by length.
  let untimed = 0;
  for (let i = 0; i < out.length; i++) {
    if (known(out[i])) continue;
    let j = i;
    while (j < out.length && !known(out[j])) j++;
    const from = i > 0 ? out[i - 1].end : j < out.length ? Math.max(0, out[j].start - 0.3 * (j - i)) : 0;
    const to = j < out.length ? Math.max(from, out[j].start) : from + 0.3 * (j - i);
    spread(out.slice(i, j), from, to);
    for (let k = i; k < j; k++) Object.assign(out[k], { timed: false, placed: true });
    untimed += j - i;
    i = j - 1;
  }
  for (const w of out) {
    w.start = Math.max(0, w.start);
    w.end = Math.max(w.start, w.end);
  }
  // Stable: words that start together keep the order they came in.
  out.sort((a, b) => (bySegment ? a.seg - b.seg : 0) || a.start - b.start || a.order - b.order);
  for (const w of out) delete w.order;
  return { words: out, untimed };
}

// Times for words that share one segment, by their length: a long word
// takes longer to say. Each word gets its letters plus one for the space.
function spread(words, start, end) {
  const weights = words.map((w) => width(w.text) + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let at = start;
  words.forEach((w, i) => {
    const span = ((end - start) * weights[i]) / total;
    w.start = at;
    w.end = at + span;
    at += span;
  });
  return words;
}

// A line's text as words, with its time spread over them. A line of one
// word gives that word its own time. `read` counts the words of the file
// so far.
function lineWords(text, start, end, seg, read = tally()) {
  const texts = splitWords(text, read);
  const words = texts.map((t) => ({ text: t, seg, timed: texts.length === 1 }));
  return spread(words, start, end);
}

// The cues of a subtitle file, each with its lines as text, as words. A
// cue still up when the next one comes on ends there, so the words of two
// cues never mix: YouTube's downloaded captions keep each line up while
// the next rolls in. Cues that come on together are shown together, as
// one. Returns { words, left }: left is how many repeated lines of the
// file were left out.
//
// Rolling captions say each line once: YouTube's automatic captions, as
// yt-dlp and ffmpeg write them as SRT, repeat the line before at the top
// of every cue, with a cue of a few milliseconds between that repeats it
// alone, each cue coming on as the one before it goes. Only a file that
// shows that pattern is read as one: a cue that short repeating the line
// before, or most of the cues of two lines or more that come on as the
// one before goes starting with its last lines, three at least. There a
// cue's first lines that are the last lines of the cue before are left
// out when it comes on within 50 ms of that cue's end, or before it, and
// has a line of its own after them, and so is a cue that short which only
// repeats. In any other file every line stays, as a speaker in a film who
// says again the line the cue before ended with, cues back to back or
// not, or a chorus in cues of its own. `read` counts the words so far.
function cueWords(cues, read = tally()) {
  const sorted = cues
    .map((cue, i) => ({ ...cue, lines: cue.lines.filter(Boolean), i }))
    .filter((cue) => cue.lines.length && cue.end >= cue.start)
    .sort((a, b) => a.start - b.start || a.i - b.i);
  // Each cue against the one before: whether it comes on as that one
  // goes, how many of its first lines are that one's last lines, with a
  // line of its own after them, and whether it is a cue of a moment that
  // only repeats.
  const seen = sorted.map((cue, k) => {
    const before = k > 0 ? sorted[k - 1] : null;
    if (!before) return { rolling: false, repeated: 0, echo: false };
    const { lines } = cue;
    const ends = (n) => lines.slice(0, n).every((line, j) => line === before.lines[before.lines.length - n + j]);
    const rolling = cue.start - before.end <= 0.05;
    // Rolling captions repeat a line or two, three in a roll-up of four:
    // no more is looked for, so a cue of many lines is not compared again
    // for each count of them.
    let repeated = 0;
    for (let n = rolling ? Math.min(3, before.lines.length, lines.length - 1) : 0; n > 0; n--) {
      if (ends(n)) {
        repeated = n;
        break;
      }
    }
    const echo = rolling && cue.end - cue.start < 0.05 && lines.length <= before.lines.length && ends(lines.length);
    return { rolling, repeated, echo };
  });
  let echoes = 0;
  let stacked = 0;
  let repeating = 0;
  sorted.forEach((cue, k) => {
    if (seen[k].echo) echoes++;
    if (!seen[k].rolling || cue.lines.length < 2) return;
    stacked++;
    if (seen[k].repeated > 0) repeating++;
  });
  const pattern = echoes > 0 || (repeating >= 3 && repeating >= 0.8 * stacked);
  const fresh = [];
  let left = 0;
  sorted.forEach((cue, k) => {
    const { repeated, echo } = pattern ? seen[k] : { repeated: 0, echo: false };
    if (echo) left += cue.lines.length;
    else {
      left += repeated;
      fresh.push({ start: cue.start, end: cue.end, text: cue.lines.slice(repeated).join(" ") });
    }
  });
  const merged = [];
  for (const cue of fresh) {
    const last = merged[merged.length - 1];
    if (last && cue.start - last.start < 0.05) {
      last.text += ` ${cue.text}`;
      last.end = Math.max(last.end, cue.end);
    } else merged.push({ ...cue });
  }
  const words = merged.flatMap((cue, seg) => {
    const next = merged[seg + 1];
    return lineWords(cue.text, cue.start, next ? Math.min(cue.end, next.start) : cue.end, seg, read);
  });
  return { words, left };
}

// A note for the repeated lines a file of rolling captions had.
const rollingNote = (left) => (left ? [`The file repeats the line before at the top of its cues, as YouTube's automatic captions do, so ${left === 1 ? "1 repeated line was" : `${left} repeated lines were`} left out.`] : []);

// Splits text into words at spaces; text in a script without spaces is
// split by the language's own word segmenter.
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
// What cleanText leaves between its spaces: a run of anything but the
// spaces and line breaks it turns into one, as it takes out the control
// characters, the carriage return among them, rather than space them.
const PIECES = /[\S\v\f\r]+/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
// A word longer than a run takes, or more words or characters than it
// takes, in this text and the ones `read` counted before it, stops the
// reading here, before a word is measured. The text is walked a piece at
// a time, each cleaned as it comes, so a line of millions of words stops
// at the word past the most, not once all of them are split.
function splitWords(text, read = tally()) {
  const out = [];
  const raw = textOf(text);
  for (const found of raw.matchAll(PIECES)) {
    const piece = found[0].replace(CONTROL, "");
    if (!piece) continue;
    if (!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(piece)) {
      if (piece.length > LONGEST_WORD) throw tooLong(piece.length);
      out.push(piece);
      read.words++;
      read.text += piece.length;
      if (read.text > MOST_TEXT) throw tooMuchText();
      if (read.words > MOST_WORDS) throw tooMany();
      continue;
    }
    // Words of a spaceless script: punctuation goes with the word before
    // it, an opening quote or bracket with the word after it. Every
    // character of the piece goes into one of its words.
    const words = [];
    let opening = "";
    let seen = 0;
    for (const part of wordSegmenter.segment(piece)) {
      if (part.isWordLike) {
        words.push(opening + part.segment);
        opening = "";
      } else if (/^[\p{Ps}\p{Pi}]+$/u.test(part.segment) || !words.length) opening += part.segment;
      else words[words.length - 1] += part.segment;
      seen += part.segment.length;
      if (words.length && words[words.length - 1].length > LONGEST_WORD) throw tooLong(words[words.length - 1].length);
      if (opening.length > LONGEST_WORD) throw tooLong(opening.length);
      if (read.text + seen > MOST_TEXT) throw tooMuchText();
      if (read.words + words.length > MOST_WORDS) throw tooMany();
    }
    if (opening) {
      if (words.length) words[words.length - 1] += opening;
      else words.push(opening);
    }
    out.push(...words);
    read.words += words.length;
    read.text += seen;
  }
  return out;
}

// ─── SRT and WebVTT ───────────────────────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", lrm: "‎", rlm: "‏" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : all;
  });
}

// SRT and VTT style tags and ASS override blocks some SRT files carry. A
// tag holds no other < and a block no other {, so a line of many of them
// is looked at once, not again from each.
function stripTags(text) {
  return text.replace(/\{\\[^{}]*\}/g, "").replace(/<[^<>]*>/g, "");
}

const ARROW = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?)/;

// SRT. Every timing line starts a cue, so a file that leaves out the empty
// line between two cues still reads right: the bare number just above a
// timing line is that cue's number, not text of the cue before. The lines
// are read one at a time and the cues with text counted as they come: each
// holds a word at least, so a file of more of them than a run takes words
// is refused there, before the rest of it is read, and so is a cue of more
// lines, a line of more words, or a file of more lines in all than the
// rolling captions of that many words hold. Each line of a cue but an
// empty one counts there, as a WebVTT cue's lines do, whether or not it
// gives words, and one that gives none is not kept.
function readSrt(content) {
  const text = content.replace(/\r\n?/g, "\n");
  const cues = [];
  const read = tally();
  let cue = null;
  // Whether the line before is a bare number the cue took as its text.
  let number = false;
  for (let at = 0; at <= text.length; ) {
    const end = text.indexOf("\n", at);
    const stop = end < 0 ? text.length : end;
    const line = text.slice(at, stop);
    at = stop + 1;
    const m = ARROW.exec(line);
    if (m) {
      // A cue whose only text was that number has none.
      if (cue && number && cue.lines.pop() && --cue.said === 0 && cues[cues.length - 1] === cue) cues.pop();
      if (cues.length > MOST_WORDS) throw tooMany();
      cue = { start: seconds(m[1]), end: seconds(m[2]), lines: [], said: 0 };
      number = false;
    } else if (cue && line.trim()) {
      fewestWords(line);
      if (++read.lines > MOST_ALL_LINES) throw tooManyLines();
      const said = lineText(line);
      // A line of tags, entities or control characters alone, as a line of
      // spaces, gives no words.
      if (!said) {
        number = false;
        continue;
      }
      cue.lines.push(said);
      if (++cue.said === 1) cues.push(cue);
      if (cue.said > MOST_LINES) throw tooMany();
      number = /^\s*\d+\s*$/.test(line);
    } else number = false;
  }
  if (cues.length > MOST_WORDS) throw tooMany();
  const { words, left } = cueWords(cues, read);
  return { words, hard: true, notes: rollingNote(left) };
}

// A line of a cue as plain text.
const lineText = (line) => cleanText(decodeEntities(stripTags(line)));

// WebVTT. Inline times (<00:00:01.500>) give each word its own start, as
// in YouTube's automatic captions; those files repeat the previous line in
// every cue, so when a file has inline times only the timed lines count.
// The cues are read one at a time, and a file of more cues with text than
// a run takes words is refused there, as an SRT is, and so is one of more
// lines of text.
function readVtt(content) {
  const text = content.replace(/^\ufeff/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT/.test(text)) throw new Error("it starts without WEBVTT, so it is not a WebVTT file");
  const cues = [];
  const read = tally();
  // Only an empty line ends a cue: YouTube's files have lines of one space
  // inside their cues, which give no words and are not kept. A cue's lines
  // are taken one at a time, and its lines with text counted as they come.
  const blank = /\n\n+/g;
  for (let at = 0; at <= text.length; ) {
    blank.lastIndex = at;
    const gap = blank.exec(text);
    const stop = gap ? gap.index : text.length;
    let from = at;
    at = gap ? gap.index + gap[0].length : text.length + 1;
    let m = null;
    const said = [];
    let lines = 0;
    for (let first = true; from <= stop; first = false) {
      const end = text.indexOf("\n", from);
      const line = text.slice(from, end < 0 || end > stop ? stop : end);
      from = end < 0 || end > stop ? stop + 1 : end + 1;
      if (first && /^(NOTE|STYLE|REGION)\b/.test(line)) break;
      if (!m) m = ARROW.exec(line);
      else if (line.trim()) {
        said.push(line);
        if (++lines > MOST_LINES) throw tooMany();
        if (++read.lines > MOST_ALL_LINES) throw tooManyLines();
      }
    }
    if (!m || !lines) continue;
    cues.push({ start: seconds(m[1]), end: seconds(m[2]), lines: said });
    if (cues.length > MOST_WORDS) throw tooMany();
  }
  const INLINE = /<((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})>/;
  const karaoke = cues.some((cue) => cue.lines.some((line) => INLINE.test(line)));
  if (!karaoke) {
    const { words, left } = cueWords(cues.map((cue) => ({ start: cue.start, end: cue.end, lines: cue.lines.map((line) => (fewestWords(line), lineText(line))) })), read);
    return { words, hard: true, notes: rollingNote(left) };
  }
  const words = [];
  let seg = 0;
  for (const cue of cues) {
    if (!(cue.end >= cue.start)) continue;
    for (const line of cue.lines) {
      if (!INLINE.test(line)) continue;
      // Pieces between the times, each taken as it comes, so a line of
      // millions of them stops where the words pass the most: the first
      // starts with the cue.
      const times = /<((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})>/g;
      let at = cue.start;
      let from = 0;
      const timed = [];
      const take = (part) => {
        fewestWords(part);
        for (const word of splitWords(decodeEntities(stripTags(part)), read)) timed.push({ text: word, start: at, seg, timed: true });
      };
      for (let m; (m = times.exec(line)); from = m.index + m[0].length) {
        take(line.slice(from, m.index));
        at = seconds(m[1]);
      }
      take(line.slice(from));
      timed.forEach((w, i) => (w.end = i + 1 < timed.length ? Math.max(w.start, timed[i + 1].start) : Math.max(w.start, cue.end)));
      words.push(...timed);
      seg++;
    }
  }
  return { words, hard: false };
}

// ─── JSON shapes ──────────────────────────────────────────────────────────

// Times in a list of items: seconds, or milliseconds when `ms`.
function timedItems(items, { text = ["word", "text", "punctuated_word", "content", "token"], start = ["start", "start_time", "startTime", "from"], end = ["end", "end_time", "endTime", "to"], ms = false, seg = -1 } = {}) {
  return items
    .filter(entry)
    .map((item) => {
      const t = ms ? 0.001 : 1;
      const s = seconds(first(item, start));
      const e = seconds(first(item, end));
      // A segment the item gives is kept as a words.json's are: a whole
      // number, none below zero.
      return { text: cleanText(first(item, text)), start: s * t, end: e * t, seg: Number.isInteger(item.seg) && item.seg >= 0 ? item.seg : seg, timed: Number.isFinite(s) };
    });
}

// Words from segments that hold their own words (WhisperX, OpenAI with
// both, Parakeet's sentences): each word keeps its segment. The words of
// the segments that hold none are counted across all of them, as a
// subtitle file's are.
function wordsInSegments(segments, key, options = {}, read = tally()) {
  const words = [];
  listed(segments, read);
  segments.forEach((segment, i) => {
    if (!entry(segment)) return;
    const inside = Array.isArray(segment[key]) ? segment[key] : [];
    if (inside.length) words.push(...timedItems(listed(inside, read), { ...options, seg: i }));
    else {
      const s = seconds(first(segment, ["start", "start_time"]));
      const e = seconds(first(segment, ["end", "end_time"]));
      if (Number.isFinite(s) && Number.isFinite(e)) words.push(...lineWords(first(segment, ["text", "sentence"]), s, e, i, read));
    }
  });
  return words;
}

// Tokens that make up words (whisper.cpp's full JSON, Parakeet): a token
// that starts with a space or "▁" starts a word, any other is joined to
// the word before it.
function wordsFromTokens(tokens, seg) {
  const words = [];
  for (const token of tokens) {
    const raw = textOf(token.text);
    if (!raw || /^\[_|^<\|/.test(raw)) continue;
    const startsWord = /^[\s▁]/.test(raw) || !words.length || words[words.length - 1].seg !== seg;
    const text = raw.replace(/^[\s▁]+/, "");
    if (!text) continue;
    if (startsWord) words.push({ text, start: token.start, end: token.end, seg, timed: Number.isFinite(token.start) });
    else {
      const last = words[words.length - 1];
      last.text += text;
      if (Number.isFinite(token.end)) last.end = token.end;
    }
  }
  return words.map((w) => ({ ...w, text: cleanText(w.text) }));
}

// The shape of a JSON file, its words, and `entries`: how many entries the
// list of that shape held, which a file of a known shape whose list is
// empty, as a speech-to-text's answer for a clip with no speech is, has
// none of. Each list is counted before it is read (listed).
function detectJson(data) {
  const shape = (found, list) => ({ ...found, entries: Array.isArray(list) ? list.length : 0 });
  const read = tally();
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (typeof data.tool === "string" && /^easycaptionkit\b/.test(data.tool) && Array.isArray(data.words)) {
      // A word the first run spread over its line keeps saying so, and so
      // does one it placed between its neighbors, as the file gave it none.
      const items = listed(data.words, read).filter((w) => w && typeof w === "object");
      const words = timedItems(items).map((w, i) => ({ ...w, seg: Number.isInteger(items[i].seg) && items[i].seg >= 0 ? items[i].seg : -1, timed: w.timed && !items[i].spread && !items[i].placed, ...(items[i].placed ? { placed: true } : {}) }));
      if (data.hard) placeAdded(words);
      // The format the words first came in, which words.json names as its
      // `from`: a demo's steps stay steps when their words.json is read
      // again, in its own folder or in another.
      const first = Object.keys(FORMATS).find((key) => key !== "easycaptionkit" && FORMATS[key] === data.from);
      return shape({ format: "easycaptionkit", words, hard: Boolean(data.hard), fixed: handFixed(data), ...(first ? { first } : {}) }, data.words);
    }
    if (data.kind === "demo" && Array.isArray(data.steps)) return shape({ format: "steps", ...readSteps(data, listed(data.steps, read)) }, data.steps);
    if (Array.isArray(data.transcription)) return shape({ format: "whispercpp", words: readWhisperCpp(listed(data.transcription, read), read) }, data.transcription);
    const alternative = data.results && Array.isArray(data.results.channels) && data.results.channels[0] && (data.results.channels[0].alternatives || [])[0];
    if (alternative && Array.isArray(alternative.words)) return shape({ format: "deepgram", words: timedItems(listed(alternative.words, read), { text: ["punctuated_word", "word"] }) }, alternative.words);
    if (data.results && Array.isArray(data.results.items)) return shape({ format: "aws", words: readAws(listed(data.results.items, read)) }, data.results.items);
    if (Array.isArray(data.results) && data.results.some((r) => r && Array.isArray(r.alternatives))) return shape({ format: "google", words: readGoogle(listed(data.results, read), read) }, data.results);
    if (data.timestamp && Array.isArray(data.timestamp.word)) return shape({ format: "nemo", words: timedItems(listed(data.timestamp.word, read), { text: ["word", "text"] }) }, data.timestamp.word);
    if (Array.isArray(data.sentences) && data.sentences.some((s) => s && Array.isArray(s.tokens))) {
      listed(data.sentences, read);
      return shape({ format: "parakeet", words: data.sentences.flatMap((s, i) => (entry(s) && Array.isArray(s.tokens) ? wordsFromTokens(listed(s.tokens, read).filter(entry).map((t) => ({ text: t.text, start: seconds(t.start), end: seconds(t.end) })), i) : [])) }, data.sentences);
    }
    if (Array.isArray(data.chunks) && data.chunks.some((c) => c && Array.isArray(c.timestamp))) return shape({ format: "transformers", ...readChunks(listed(data.chunks, read)) }, data.chunks);
    if (Array.isArray(data.words) && data.words.some((w) => w && w.type !== undefined && w.text !== undefined)) {
      // ElevenLabs: spacing entries between words, and sound tags.
      const spoken = listed(data.words, read).filter((w) => w && w.type !== "spacing");
      const tags = spoken.filter((w) => w.type === "audio_event").length;
      return shape({ format: "elevenlabs", words: timedItems(spoken.filter((w) => w.type !== "audio_event"), { text: ["text"] }), notes: tags ? [`${tags} sound ${tags === 1 ? "tag" : "tags"} like (laughs) left out.`] : [] }, data.words);
    }
    if (Array.isArray(data.words) && (data.audio_duration !== undefined || data.audio_url !== undefined || data.acoustic_model !== undefined)) {
      // AssemblyAI: milliseconds.
      return shape({ format: "assemblyai", words: timedItems(listed(data.words, read), { text: ["text"], ms: true }) }, data.words);
    }
    if (Array.isArray(data.segments) && data.segments.some((s) => s && Array.isArray(s.words))) {
      return shape({ format: "whisperx", words: wordsInSegments(data.segments, "words", {}, read) }, data.segments);
    }
    if (Array.isArray(data.words) && data.words.length) {
      // OpenAI verbose_json with word times, and lists like it, within
      // what a run takes before their text is matched.
      const words = withinLimits(timedItems(listed(data.words, read)));
      if (Array.isArray(data.segments)) markSegments(words, listed(data.segments, read));
      const text = typeof data.text === "string" ? data.text : Array.isArray(data.segments) ? data.segments.map((s) => (s && typeof s.text === "string" ? s.text : "")).join(" ") : "";
      if (text) punctuate(words, text);
      return shape({ format: data.task === "transcribe" || data.segments ? "openai" : "words", words }, data.words);
    }
    if (Array.isArray(data.word_segments)) return shape({ format: "whisperx", words: timedItems(listed(data.word_segments, read)) }, data.word_segments);
    if (Array.isArray(data.word)) return shape({ format: "nemo", words: timedItems(listed(data.word, read), { text: ["word", "text"] }) }, data.word);
    if (Array.isArray(data.segments)) return shape({ format: data.task === "transcribe" ? "openai" : "segments", words: wordsInSegments(data.segments, "words", {}, read) }, data.segments);
    // An empty list where a speech-to-text keeps its words, as ElevenLabs'
    // answer for silence is: a list of words with none in it.
    if (["words", "results", "chunks", "sentences"].some((key) => Array.isArray(data[key]) && !data[key].length)) return { format: "words", words: [], entries: 0 };
  }
  if (Array.isArray(data)) {
    const items = listed(data, read).filter((d) => d && typeof d === "object");
    // An empty list, which nothing says a speech-to-text wrote.
    if (!data.length) return { format: "words", words: [], entries: 0, bare: true };
    if (items.length && items.every((d) => first(d, ["text", "word", "content"]) !== undefined)) {
      const timed = timedItems(items);
      // A list of lines rather than words: spread each over its words,
      // counted across all the lines.
      const lines = timed.filter((w) => /\s/.test(w.text)).length > timed.length / 2;
      if (lines) return shape({ format: "segments", words: timed.flatMap((w, i) => lineWords(w.text, w.start, w.end, i, read)) }, data);
      return shape({ format: "words", words: timed }, data);
    }
  }
  return null;
}

// A word added to a words.json by hand, without the segment the others
// carry, goes in the segment its time falls in, else in the one of the
// word before it in time, so it shows where it is said. A word with no
// time goes with the word before it in the list.
function placeAdded(words) {
  const spans = new Map();
  for (const w of words) {
    if (w.seg < 0 || !Number.isFinite(w.start)) continue;
    const s = spans.get(w.seg) || { start: Infinity, end: -Infinity };
    spans.set(w.seg, { start: Math.min(s.start, w.start), end: Math.max(s.end, Number.isFinite(w.end) ? w.end : w.start) });
  }
  const placed = words.filter((w) => w.seg >= 0 && Number.isFinite(w.start)).sort((a, b) => a.start - b.start);
  if (!placed.length) return;
  const segments = [...spans].sort((a, b) => a[1].start - b[1].start);
  // The last of `list` (sorted by start) that starts at or before t.
  const lastBefore = (list, startOf, t) => {
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (startOf(list[mid]) <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const added = [];
  words.forEach((w, i) => {
    if (w.seg >= 0) return;
    if (!Number.isFinite(w.start)) return added.push(i);
    const k = lastBefore(segments, (s) => s[1].start, w.start);
    if (k >= 0 && w.start < segments[k][1].end) w.seg = segments[k][0];
    else {
      const p = lastBefore(placed, (x) => x.start, w.start);
      w.seg = (p >= 0 ? placed[p] : placed[0]).seg;
    }
  });
  for (const i of added) {
    let j = i - 1;
    while (j >= 0 && words[j].seg < 0) j--;
    let after = i + 1;
    while (after < words.length && words[after].seg < 0) after++;
    words[i].seg = j >= 0 ? words[j].seg : after < words.length ? words[after].seg : 0;
  }
}

// Letters, digits and the marks on them: what a word is spelled with.
const SPELLED = /[\p{L}\p{N}\p{M}]/u;
const OPENS = /[\p{Ps}\p{Pi}]/u;

// OpenAI sends its word times as bare words ("Hello"), and the punctuation
// and the letter case only in its text ("Hello."). Each word takes its
// spelling from the text, with the punctuation after it and any opening
// quote, bracket or sign right before it, so captions can end where the
// sentences do. A word the text does not have keeps its own spelling.
//
// The text is walked with positions in it, and its letters are found only
// as far as the words reach: a word is looked for no further than 80
// letters past the one before it, so a text far longer than its words
// costs no more than the part they use.
function punctuate(words, raw) {
  const text = raw.normalize("NFC");
  // The character that starts at a position of the text, and the one that
  // ends there.
  const at = (i) => String.fromCodePoint(text.codePointAt(i));
  const before = (i) => {
    const low = text.charCodeAt(i - 1);
    if (low >= 0xdc00 && low <= 0xdfff && i >= 2) {
      const high = text.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) return text.slice(i - 2, i);
    }
    return text[i - 1];
  };
  const space = (c) => /\s/.test(c);
  // Where each letter of the text starts, found as they are needed.
  let starts = new Uint32Array(256);
  let found = 0;
  let scanned = 0;
  const letters = (n) => {
    while (found < n && scanned < text.length) {
      const c = at(scanned);
      if (SPELLED.test(c)) {
        if (found === starts.length) {
          const more = new Uint32Array(starts.length * 2);
          more.set(starts);
          starts = more;
        }
        starts[found++] = scanned;
      }
      scanned += c.length;
    }
    return found >= n;
  };
  const letter = (k) => at(starts[k]).toLowerCase();
  const endOf = (k) => starts[k] + at(starts[k]).length;
  let next = 0;
  let after = 0;
  for (const w of words) {
    const want = Array.from(String(w.text).normalize("NFC")).filter((c) => SPELLED.test(c)).map((c) => c.toLowerCase());
    if (!want.length) continue;
    const spacedWord = !SPACELESS.test(want[0]);
    let match = -1;
    for (let s = next; s < next + 80 && letters(s + want.length); s++) {
      if (!want.every((c, k) => letter(s + k) === c)) continue;
      const from = starts[s];
      const to = endOf(s + want.length - 1);
      if (/\s/.test(text.slice(from, to))) continue;
      // A word of a script written with spaces is a whole word of the
      // text, not a piece of a longer one.
      if (spacedWord && ((from > 0 && SPELLED.test(before(from))) || (to < text.length && SPELLED.test(at(to))))) continue;
      match = s;
      break;
    }
    if (match < 0) continue;
    let from = starts[match];
    let to = endOf(match + want.length - 1);
    // What comes before it at the start of a word of the text, like the $
    // of $20 or a bracket, else an opening quote or bracket alone, as in
    // Japanese.
    let lead = from;
    while (lead > after && !space(before(lead)) && !SPELLED.test(before(lead))) lead -= before(lead).length;
    if (lead === 0 || space(before(lead))) from = lead;
    else while (from > after && OPENS.test(before(from))) from -= before(from).length;
    let end = to;
    while (end < text.length && !space(at(end)) && !SPELLED.test(at(end)) && !OPENS.test(at(end))) end += at(end).length;
    // Not a hyphen or an apostrophe that joins it to the next word.
    if (end === text.length || space(at(end)) || OPENS.test(at(end)) || !spacedWord || SPACELESS.test(at(end))) to = end;
    w.text = cleanText(text.slice(from, to));
    next = match + want.length;
    after = to;
  }
}

// Which segment of OpenAI's each word falls in, so captions prefer to
// break where Whisper did.
function markSegments(words, segments) {
  const ends = segments.filter(entry).map((s) => seconds(s.end)).filter(Number.isFinite);
  let k = 0;
  for (const w of words) {
    while (k < ends.length - 1 && w.start >= ends[k] - 0.01) k++;
    w.seg = k;
  }
}

// whisper.cpp's segments. With -ml 1 and no -sow, it cuts a segment at
// every token, so a word can come in pieces (" Makers", "MC", "P") and
// punctuation alone ("."): a segment that starts without a space goes on
// the word before it, as a token does, and so does closing punctuation.
// In a script written without spaces each piece stays a word. The words
// of segments read from their text are counted across all of them.
function readWhisperCpp(transcription, read = tally()) {
  const words = [];
  transcription.forEach((segment, i) => {
    if (!segment || typeof segment !== "object") return;
    const offsets = segment.offsets || {};
    const stamps = segment.timestamps || {};
    const start = Number.isFinite(offsets.from) ? offsets.from / 1000 : seconds(stamps.from);
    const end = Number.isFinite(offsets.to) ? offsets.to / 1000 : seconds(stamps.to);
    let pieces = [];
    let raw = "";
    if (Array.isArray(segment.tokens) && segment.tokens.some((t) => t && t.offsets)) {
      const at = (offsets, key) => (entry(offsets) ? numberOf(offsets[key]) / 1000 : NaN);
      const tokens = listed(segment.tokens, read).filter((t) => t && typeof t === "object").map((t) => ({ text: textOf(t.text), start: at(t.offsets, "from"), end: at(t.offsets, "to") }));
      const first = tokens.find((t) => t.text && !/^\[_|^<\|/.test(t.text));
      raw = first ? first.text : "";
      pieces = wordsFromTokens(tokens, i);
    } else if (Number.isFinite(start) && Number.isFinite(end)) {
      raw = textOf(segment.text);
      pieces = lineWords(raw, start, end, i, read);
    }
    const last = words[words.length - 1];
    if (last && pieces.length && continues(last.text, raw, pieces[0].text)) {
      last.text += pieces[0].text;
      if (Number.isFinite(pieces[0].end)) last.end = Math.max(last.end, pieces[0].end);
      pieces.shift();
    }
    words.push(...pieces);
  });
  return words;
}

// Whether a piece goes on the word before it: closing punctuation does,
// and so does a piece that starts without a space, unless one of the two
// is in a script written without spaces.
const CLOSES = /^[.,!?;:…。、，！？；：)\]}»”’›」』）]+$/u;
function continues(before, raw, piece) {
  if (CLOSES.test(piece)) return true;
  if (/^[\s▁]/.test(raw)) return false;
  return !SPACELESS.test(Array.from(before).pop() || "") && !SPACELESS.test(Array.from(piece)[0] || "");
}

function readAws(items) {
  const words = [];
  for (const item of items.filter(entry)) {
    const best = Array.isArray(item.alternatives) && entry(item.alternatives[0]) ? item.alternatives[0] : {};
    const content = cleanText(best.content);
    if (!content) continue;
    if (item.type === "punctuation" && words.length) words[words.length - 1].text += content;
    else words.push({ text: content, start: seconds(item.start_time), end: seconds(item.end_time), seg: -1, timed: true });
  }
  return words;
}

function readGoogle(results, read = tally()) {
  const words = [];
  results.forEach((result, i) => {
    const best = entry(result) && Array.isArray(result.alternatives) ? result.alternatives[0] : null;
    if (!entry(best) || !Array.isArray(best.words)) return;
    words.push(...timedItems(listed(best.words, read), { text: ["word"], start: ["startTime", "startOffset", "start_time"], end: ["endTime", "endOffset", "end_time"], seg: i }));
  });
  return words;
}

function readChunks(chunks) {
  const items = chunks.filter(entry).map((c) => ({ text: c.text, start: Array.isArray(c.timestamp) ? c.timestamp[0] : NaN, end: Array.isArray(c.timestamp) ? c.timestamp[1] : NaN }));
  // The last chunk of a pipeline that ran out of audio can end with null.
  items.forEach((item, i) => {
    if (item.end === null || item.end === undefined) item.end = i + 1 < items.length ? items[i + 1].start : item.start;
  });
  const timed = timedItems(items);
  const lines = timed.filter((w) => /\s/.test(w.text)).length > timed.length / 2;
  const read = tally();
  return lines ? { words: timed.flatMap((w, i) => lineWords(w.text, w.start, w.end, i, read)), hard: false } : { words: timed };
}

// easyscreenshotkit's steps: each step's note, or its label when no step
// has a note, shown while the step plays. A wait step without a note says
// nothing worth reading, so it shows nothing.
function readSteps(data, list = data.steps) {
  const steps = list.filter((s) => s && Number.isFinite(numberOf(s.start))).sort((a, b) => numberOf(a.start) - numberOf(b.start));
  const noted = steps.some((s) => cleanText(s.note));
  const notes = [];
  const shown = steps.filter((s) => (noted ? cleanText(s.note) : cleanText(s.label) && s.action !== "wait"));
  if (!noted && shown.length) notes.push("steps.json has no step notes, so the step labels are shown. A note on each step (what to say about it) makes better captions.");
  const video = entry(data.video) && numberOf(data.video.duration) > 0 ? { duration: numberOf(data.video.duration), file: textOf(data.video.file) } : null;
  const words = [];
  const read = tally();
  shown.forEach((step, i) => {
    const start = numberOf(step.start);
    // What a step's note says holds while the steps after it play, until
    // the next step with words, for at most ten seconds; a page opening
    // takes no time of its own.
    const next = shown[i + 1] ? numberOf(shown[i + 1].start) : video ? video.duration : Math.max(numberOf(step.end) || start, start + 3);
    const end = Math.min(next, start + 10);
    words.push(...lineWords(noted ? step.note : step.label, start, Math.max(start + 0.1, end), i, read));
  });
  return { words, hard: true, notes, video };
}

// ─── the entry point ──────────────────────────────────────────────────────

// The words of an hour of speech take about a megabyte; a file far bigger
// is something else, often the video given in its place.
const MAX_SIZE = 64 * 1024 * 1024;

// The words of a file's content, in whatever shape it is: { format,
// words, hard, notes, json }.
function readContent(content, ext, file, unknown) {
  // The shape of an SRT is looked for within lines: a pattern that runs on
  // across line breaks would scan a file of blank lines again from each.
  if (ext === ".srt" || (ext !== ".json" && ext !== ".vtt" && /^\s*\d+[ \t]*\r?\n[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->/.test(content))) return { format: "srt", ...readSrt(content) };
  if (ext === ".vtt" || /^WEBVTT/.test(content)) {
    try {
      return { format: "vtt", ...readVtt(content) };
    } catch (err) {
      if (err.code === "EWORDS") throw err;
      throw new Error(`Cannot read ${file}: ${err.message}`);
    }
  }
  // A JSON text's lists and objects are counted before it is parsed, and a
  // text of far more of them than words take, or nested far deeper, is
  // refused. Only a text that starts as a list or an object has any: JSON
  // reads anything else as one value, or stops at its first character.
  if (/^\s*[{[]/.test(content)) {
    const shape = jsonShape(content, { most: MOST_OPENED, deepest: DEEPEST });
    if (shape.deepest > DEEPEST) throw tooDeep();
    if (shape.over) throw tooManyItems();
  }
  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    const json = /^\s*[{[]/.test(content);
    if (!json && /^[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->/m.test(content)) return { format: "srt", ...readSrt(content) };
    // A JSON file says where it breaks, as a quote typed by hand can make it.
    if (json || ext === ".json") throw new Error(`Cannot read ${file}: it is not valid JSON${jsonProblem(err, content)}`);
    throw new Error(`Cannot read ${file}: it is not JSON, SRT or WebVTT. Give the words with their times: a speech-to-text JSON, an SRT or VTT file, or easyscreenshotkit's steps.json`);
  }
  const found = detectJson(data);
  if (!found) throw unknown();
  return { ...found, json: true };
}

// Why the words file could not be read, as the error to give.
function unread(err, file) {
  if (err.code === "EFBIG") return new Error(`${file} is ${sizeText(err, MAX_SIZE)}, too big to be a words file (the words of an hour of speech take about 1 MB). Check that it is the words and not the video`);
  if (err.code === "ENOENT") return new Error(`Cannot read ${file}: no such file`);
  if (err.code === "EISDIR") return new Error(`${file} is a folder; give the words file in it`);
  return new Error(`Cannot read ${file}: ${err.message}`);
}

// The words of a file, as readWords reads them. A pipe or a device, as a
// shell's <(...) or /dev/stdin is, is read without holding up the
// process, so Ctrl-C or a kill still stops a run whose words have not
// come yet: reading one at once would wait in the system, where no signal
// gets through.
async function loadWords(file) {
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    // Not there, which readWords says.
  }
  if (!stat || stat.isFile() || stat.isDirectory()) return readWords(file);
  let content;
  try {
    content = await readAtMostLater(file, MAX_SIZE);
  } catch (err) {
    throw unread(err, file);
  }
  return readWords(file, content);
}

// The words of a file, from the text `given` when it was read already.
function readWords(file, given = null) {
  let content = given;
  if (content === null) {
    try {
      content = readAtMost(file, MAX_SIZE);
    } catch (err) {
      throw unread(err, file);
    }
  }
  content = content.replace(/^\ufeff/, "");
  const ext = path.extname(file).toLowerCase();
  // A JSON file in no shape easycaptionkit knows, or in a shape it took
  // for one it knows and found no words in the entries of, as a
  // Speechmatics file looks like Google's.
  const unknown = () => new Error(`Cannot read ${file}: no words with times in it. easycaptionkit reads ${Object.values(FORMATS).slice(1, -2).join(", ")}, and plain lists of { text, start, end }`);
  // An ASS file, as Aegisub writes it, yt-dlp's --convert-subs ass, or this
  // kit's own captions.ass, starts with its [Script Info].
  if (ext === ".ass" || ext === ".ssa" || /^\s*\[Script Info\]/i.test(content)) throw new Error(`Cannot read ${file}: easycaptionkit does not read ASS files as words. Give the SRT or VTT file, or the speech-to-text JSON, the ASS was made from`);
  let found;
  try {
    found = readContent(content, ext, file, unknown);
    withinLimits(found.words || []);
  } catch (err) {
    if (err.code === "EWORDS") throw new Error(`Cannot read ${file}: ${err.message}`);
    throw err;
  }
  const { words, untimed } = settle(found.words || [], { bySegment: Boolean(found.hard) });
  if (!words.length) {
    const spoken = found.json && !["easycaptionkit", "steps"].includes(found.format);
    if (spoken && found.entries > 0) throw unknown();
    // A list of a speech-to-text's shape with nothing in it, as one writes
    // for a clip with no speech.
    throw new Error(`${file} holds no words to caption${spoken && !found.bare ? ", as a speech-to-text model gives for a clip with no speech" : ""}`);
  }
  const notes = [...(found.notes || [])];
  if (untimed && ["openai", "whisperx", "deepgram", "elevenlabs", "assemblyai", "nemo", "parakeet", "aws", "google", "words", "transformers", "easycaptionkit"].includes(found.format)) {
    notes.push(`${untimed} ${untimed === 1 ? "word had" : "words had"} no time of ${untimed === 1 ? "its" : "their"} own and ${untimed === 1 ? "was" : "were"} placed between the words around ${untimed === 1 ? "it" : "them"}.`);
  }
  const timedOwn = words.filter((w) => w.timed).length;
  return {
    format: found.format,
    about: FORMATS[found.format] || found.format,
    // For a words.json of this kit, the format its words first came in,
    // where it names one; else "".
    firstFormat: found.first || "",
    words,
    // Segments never joined: an SRT's cues, a demo's steps.
    hard: Boolean(found.hard),
    byWord: timedOwn >= words.length * 0.9,
    // Words a person fixed in a words.json of this kit, which the
    // words.json a run writes from them keeps saying.
    fixed: Boolean(found.fixed),
    notes,
    video: found.video || null,
  };
}

module.exports = { readWords, loadWords, seconds, spread, splitWords, settle, wordsSha256, handFixed, FORMATS, MOST_WORDS, LONGEST_WORD, MOST_TEXT, MOST_OPENED, DEEPEST };
