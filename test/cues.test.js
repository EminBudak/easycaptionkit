"use strict";

// Words into captions: where the cuts go, how lines break, how long each
// caption shows, the states a karaoke or word style steps through, and
// the subtitle files written from them and read back.

const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCues, layout, states, readingSpeed, badBreak } = require("../skills/easycaptionkit/scripts/lib/cues");
const { srt, vtt, ass, assColor, assTag } = require("../skills/easycaptionkit/scripts/lib/subtitles");
const { readWords } = require("../skills/easycaptionkit/scripts/lib/words");
const { width, join, spaced } = require("../skills/easycaptionkit/scripts/lib/text");
const { captionLayout } = require("../skills/easycaptionkit/scripts/lib/places");
const { write } = require("./helpers");

// Words said one after another at a steady pace, with pauses where asked.
function spoken(text, { pace = 0.3, pauses = {} } = {}) {
  let t = 0.5;
  return text.split(" ").map((word, i) => {
    t += pauses[i] || 0;
    const w = { text: word, start: t, end: t + pace * 0.85, seg: -1, timed: true };
    t += pace;
    return w;
  });
}

test("columns and joins: wide CJK letters, no spaces in Japanese, punctuation on its word", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width("日本"), 4);
  assert.equal(width("👍"), 2);
  assert.equal(join(["Hello", ",", "world", "!"]), "Hello, world!");
  assert.equal(join(["今日", "は", "晴れ"]), "今日は晴れ");
  assert.equal(join(["don", "'t", "go"]), "don't go");
  assert.equal(spaced("(", "this"), false);
  assert.equal(join(["مرحبا", "بالعالم"]), "مرحبا بالعالم");
});

test("lines: one when it fits, else balanced, broken after a comma when that costs little", () => {
  assert.deepEqual(layout(["Short", "one"], 2, 20), ["Short one"]);
  const two = layout("We shipped it on Friday, and nobody noticed".split(" "), 2, 30);
  assert.deepEqual(two, ["We shipped it on Friday,", "and nobody noticed"]);
  for (const line of layout("one two three four five six seven eight".split(" "), 2, 20)) assert.ok(width(line) <= 20, line);
  assert.equal(layout("this will never fit in two short lines at all".split(" "), 2, 10), null);
  assert.equal(layout(["a", "b"], 1, 2), null);
});

test("cues end where sentences end and where the speaker pauses, within the limits", () => {
  const words = spoken("Captions matter. Most people watch without sound, so the words have to be on screen. That is all.", { pauses: { 9: 0.8 } });
  const cues = buildCues(words, { lines: 2, maxChars: 24 });
  for (const cue of cues) {
    assert.ok(cue.lines.length <= 2);
    for (const line of cue.lines) assert.ok(width(line) <= 24, line);
  }
  const ends = cues.map((c) => c.text.split(" ").pop());
  assert.ok(ends.includes("matter."), ends.join(" | "));
  assert.ok(ends.includes("screen."), ends.join(" | "));
  // Every word is in exactly one cue, in order.
  assert.deepEqual(cues.flatMap((c) => c.text.split(" ")), words.map((w) => w.text));
  // The cue after the pause starts after it.
  const after = cues.find((c) => c.first === 9);
  assert.ok(after, "a cue starts after the pause");
});

test("timing: back to back across short gaps, held for reading when there is room, never past the next cue or the video", () => {
  const words = spoken("one two three four five six seven eight nine ten", { pace: 0.25, pauses: { 5: 2 } });
  const cues = buildCues(words, { lines: 1, maxChars: 14, duration: 7 });
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start + 1e-9, `${i} ends at ${cues[i].end}, next starts ${cues[i + 1].start}`);
  for (const cue of cues) assert.ok(cue.end >= words[cue.last].end - 1e-9 || cue.end === 7, "a cue shows until its last word ends");
  const beforePause = cues.find((c) => c.last === 4);
  assert.ok(beforePause.end - words[4].end >= 0.39, `held ${beforePause.end - words[4].end} s after the last word before a pause`);
  assert.ok(cues.at(-1).end <= 7);
});

test("hard segments (an SRT's cues) are never joined, even when they would fit together", () => {
  const words = [
    { text: "Hi.", start: 0, end: 0.3, seg: 0, timed: false },
    { text: "Yes", start: 0.4, end: 0.6, seg: 1, timed: false },
    { text: "sure", start: 0.6, end: 0.9, seg: 1, timed: false },
  ];
  assert.equal(buildCues(words, { lines: 2, maxChars: 42, hard: true }).length, 2);
  assert.equal(buildCues(words.map((w) => ({ ...w, seg: -1 })), { lines: 2, maxChars: 42, hard: false }).length <= 2, true);
});

test("a word longer than a line gets a cue of its own instead of breaking the run", () => {
  const words = spoken("see https://example.com/a/very/long/path/that/never/fits for more");
  const cues = buildCues(words, { lines: 2, maxChars: 16 });
  assert.ok(cues.some((c) => c.wide && c.text.startsWith("https://")));
  assert.deepEqual(cues.flatMap((c) => c.text.split(" ")), words.map((w) => w.text));
});

test("cutting a long talk into captions takes moments, even at three lines of 80 characters", () => {
  const vocab = "we built this kit so the captions stay clear of the buttons, and they read well. Sometimes a sentence runs long; other times it stops.".split(" ");
  const words = Array.from({ length: 2000 }, (_, i) => ({ text: vocab[i % vocab.length], start: 0.3 + i * 0.26, end: 0.5 + i * 0.26, seg: -1, timed: true }));
  for (const [lines, maxChars] of [[3, 80], [2, 42]]) {
    const started = Date.now();
    const cues = buildCues(words, { lines, maxChars });
    const took = Date.now() - started;
    assert.ok(took < 5000, `${lines} lines of ${maxChars}: ${took} ms`);
    assert.deepEqual(cues.flatMap((c) => c.text.split(" ")), words.map((w) => w.text));
    for (const cue of cues) for (const line of cue.lines) assert.ok(width(line) <= maxChars, line);
  }
});

test("Japanese: no caption or line starts with a particle, and no word the segmenter cut in two is split", () => {
  const r = readWords(write("ja-voice.srt", "1\n00:00:00,000 --> 00:00:03,280\nこのムキムキのお兄さんがいるし、\n\n2\n00:00:03,700 --> 00:00:05,960\nバーだし少し高そうだと思いますよね。\n\n3\n00:00:07,000 --> 00:00:10,590\nこのバーの料金設定は良心的でした。\n\n4\n00:00:10,700 --> 00:00:12,840\nまあそんなに高くなかったです。\n"));
  assert.equal(badBreak("の", "は"), true);
  assert.equal(badBreak("高", "く"), true);
  assert.equal(badBreak("お", "兄さん"), true);
  assert.equal(badBreak("は", "良心"), false);
  for (const maxChars of [14, 16, 18, 20, 24]) {
    const cues = buildCues(r.words, { lines: 2, maxChars, hard: r.hard });
    // The word each line starts with, and the word before it.
    for (const cue of cues) {
      let k = cue.first;
      for (const line of cue.lines) {
        assert.equal(badBreak(k > 0 ? r.words[k - 1].text : "", r.words[k].text), false, `${maxChars}: a line starts with ${r.words[k].text}, after ${r.words[k - 1] && r.words[k - 1].text}`);
        let built = "";
        while (k <= cue.last && built.length < line.length) built += r.words[k++].text;
      }
    }
    assert.equal(cues.map((c) => c.lines.join("")).join(""), r.words.map((w) => w.text).join(""));
  }
});

test("karaoke and word states: one per word, back to back inside a cue, nothing between cues", () => {
  const words = spoken("Lights on. Camera ready.", { pauses: { 2: 1.5 } });
  const cues = buildCues(words, { lines: 2, maxChars: 20 });
  const karaoke = states(cues, words, "karaoke");
  assert.equal(karaoke.length, words.length);
  assert.equal(karaoke[0].from, cues[0].start);
  for (let i = 0; i + 1 < karaoke.length; i++) {
    if (karaoke[i].cue === karaoke[i + 1].cue) assert.ok(Math.abs(karaoke[i].to - karaoke[i + 1].from) < 1e-9);
    assert.equal(karaoke[i + 1].from, Math.max(cues[karaoke[i + 1].cue].start, words[cues[karaoke[i + 1].cue].first + karaoke[i + 1].word].start));
  }
  const line = states(cues, words, "line");
  assert.equal(line.length, cues.length);
  const solo = states(spoken("wait for it"), spoken("wait for it").map((w) => w), "word");
  assert.equal(solo.length, 0, "no cues, no states");
});

test("reading speed: characters a second, the fast ones listed fastest first", () => {
  // A long word said in a fifth of a second, with the next words right after.
  const words = [
    ...spoken("A calm caption that takes its time."),
    { text: "Speedingthroughthisone.", start: 3.5, end: 3.7, seg: -1, timed: true },
    { text: "Then", start: 3.72, end: 4.0, seg: -1, timed: true },
    { text: "calm.", start: 4.1, end: 4.6, seg: -1, timed: true },
  ];
  const cues = buildCues(words, { lines: 1, maxChars: 24 });
  const r = readingSpeed(cues);
  assert.ok(r.fastest > 20, `fastest ${r.fastest}`);
  assert.match(r.fast[0].text, /Speeding/);
  assert.ok(r.median < r.fastest);
});

test("SRT and VTT read back to the same cues and times", () => {
  const words = spoken("We built it in a weekend. It already saves us an hour a day, every day.");
  const cues = buildCues(words, { lines: 2, maxChars: 24 });
  const back = readWords(write("round.srt", srt(cues)));
  assert.equal(back.words.length, words.length);
  const fromSrt = buildCues(back.words, { lines: 2, maxChars: 24, hard: true });
  assert.equal(fromSrt.length, cues.length);
  fromSrt.forEach((c, i) => {
    assert.ok(Math.abs(c.start - cues[i].start) < 0.0011, `cue ${i} starts at ${c.start}, not ${cues[i].start}`);
    assert.equal(c.text, cues[i].text);
  });
  const text = vtt(cues, { note: "made --> here" });
  assert.match(text, /^WEBVTT\n\nNOTE made -> here\n/);
  const fromVtt = readWords(write("round.vtt", text));
  assert.deepEqual(fromVtt.words.map((w) => w.text), words.map((w) => w.text));
  assert.match(srt(cues), /^1\n00:00:00,500 --> /);
  assert.match(vtt([{ start: 3725.5, end: 3726, lines: ["a < b & c"] }]), /01:02:05\.500 --> 01:02:06\.000\na &lt; b &amp; c/);
});

test("SRT has no escapes: < > { } and \\ get stand-ins that read the same, and a name with a line break stays on the VTT's NOTE line", () => {
  const cues = [{ start: 0, end: 1, lines: ["wrap it in a <div> tag, a < b and c > d", "C:\\new\\Name {\\b1}x and {curly}"] }];
  const text = srt(cues);
  assert.match(text, /wrap it in a ‹div› tag, a ‹ b and c › d\nC:⧵new⧵Name \(⧵b1\)x and \(curly\)\n/);
  assert.doesNotMatch(text.split("\n").slice(2).join("\n"), /[<>{}\\]/);
  // ffmpeg, as mpv and others read SRT, keeps every word.
  const { spawnSync } = require("node:child_process");
  const read = spawnSync("ffmpeg", ["-hide_banner", "-v", "error", "-i", write("special.srt", text), "-f", "ass", "-"], { encoding: "utf8" });
  if (read.status === 0) {
    const event = read.stdout.split("\n").find((l) => l.startsWith("Dialogue:"));
    for (const word of ["‹div›", "tag,", "‹", "›", "C:⧵new⧵Name", "(⧵b1)x", "(curly)"]) assert.ok(event.includes(word), `${word} in ${event}`);
  }
  const note = vtt(cues, { note: "easycaptionkit, from x\n\n00:00:00.000 --> 00:00:09.000\nNOT A CAPTION.json" });
  assert.equal(note.split("\n\n")[1], "NOTE easycaptionkit, from x 00:00:00.000 -> 00:00:09.000 NOT A CAPTION.json");
  assert.deepEqual(readWords(write("note.vtt", note)).words.map((w) => w.text).slice(0, 2), ["wrap", "it"]);
});

test("no cue ends where it starts: segments that come on together share a cue, and a cue the next one would replace at once still shows", () => {
  // Two steps of a demo at one moment, each a hard segment.
  const words = [
    { text: "Open", start: 1, end: 1.05, seg: 0, timed: false },
    { text: "Acme.", start: 1.05, end: 1.1, seg: 0, timed: false },
    { text: "Then", start: 1, end: 2, seg: 1, timed: false },
    { text: "pricing.", start: 2, end: 3, seg: 1, timed: false },
  ];
  const cues = buildCues(words, { lines: 2, maxChars: 42, hard: true, duration: 10 });
  for (const cue of cues) assert.ok(cue.end > cue.start, `${cue.text}: ${cue.start} to ${cue.end}`);
  assert.deepEqual(cues.flatMap((c) => c.text.split(" ")), words.map((w) => w.text));
  // Forty-one words said at one moment cannot share a cue: each still shows.
  const burst = Array.from({ length: 41 }, (_, i) => ({ text: `w${i}`, start: 1, end: 1, seg: -1, timed: true }));
  const many = buildCues(burst, { lines: 1, maxChars: 8, duration: 30 });
  for (let i = 0; i < many.length; i++) {
    assert.ok(many[i].end > many[i].start, `cue ${i}: ${many[i].start} to ${many[i].end}`);
    if (i) assert.ok(many[i].start >= many[i - 1].end - 1e-9);
  }
});

test("ASS: colors as &HAABBGGRR, one event per state, the spoken word lit, the block where the layout puts it", () => {
  assert.equal(assColor("#1a6b45"), "&H00456B1A");
  assert.equal(assColor("#000000", 0.62), "&H61000000");
  assert.equal(assTag("#ffd23f"), "&H3FD2FF&");
  const words = spoken("Ship it today. Then rest.");
  const cues = buildCues(words, { lines: 2, maxChars: 16 });
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, position: "bottom", lines: 2 });
  const look = { tool: "easycaptionkit test", family: "Inter", weight: 700, textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, boxOpacity: 0.62 };
  const text = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place, title: "t" });
  assert.match(text, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(text, /Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour,/);
  assert.match(text, /Style: Caption,Inter,\d+,&H00FFFFFF,/);
  assert.equal((text.match(/^Dialogue:/gm) || []).length, words.length);
  assert.match(text, /\{\\1c&H3FD2FF&\}Ship\{\\1c&HFFFFFF&\} it/);
  // Bottom aligned, its margin the space under the block and the outline
  // and shadow libass draws past the letters' lines, so they stay in it.
  const style = text.split("\n").find((l) => l.startsWith("Style:")).split(",");
  assert.equal(style[18], "2");
  assert.equal(Number(style[21]), Math.round(1920 - place.blockBottom) + Number(style[16]) + Number(style[17]));
  const top = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, position: "top", lines: 2 });
  const atTop = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place: top }).split("\n").find((l) => l.startsWith("Style:")).split(",");
  assert.equal(Number(atTop[21]), Math.round(top.blockTop) + Number(atTop[16]));
});

test("ASS for an HDR burn: every color at a share of its signal, black still black", () => {
  const words = spoken("Bright but not blinding.");
  const cues = buildCues(words, { lines: 2, maxChars: 30 });
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, position: "bottom", lines: 2 });
  const look = { tool: "t", family: "Inter", weight: 700, textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, boxOpacity: 0.62 };
  const text = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place, level: 0.75 });
  const style = text.split("\n").find((l) => l.startsWith("Style:")).split(",");
  assert.equal(style[3], "&H00BFBFBF", "white at 75%");
  assert.equal(style[5], "&H00000000", "the outline stays black");
  assert.match(text, /\{\\1c&H2F9EBF&\}Bright\{\\1c&HBFBFBF&\}/);
  assert.match(ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place }), /Style: Caption,Inter,\d+,&H00FFFFFF,/);
});

test("ASS karaoke sets each caption's lines once, however many words it has", () => {
  const vocab = "so I think we can do it now and then we go to the next one if you want to see it as it is".split(" ");
  const words = Array.from({ length: 2000 }, (_, i) => ({ text: vocab[i % vocab.length], start: i * 0.22, end: i * 0.22 + 0.2, seg: -1, timed: true }));
  const cues = buildCues(words, { lines: 3, maxChars: 80 });
  const place = captionLayout(1920, 1080, ["youtube"], { style: "karaoke", size: 6.5, position: "bottom", lines: 3 });
  const look = { tool: "t", family: "", weight: 700, textColor: "#ffffff", highlight: "#ffd23f", highlightMode: "text", highlightInk: "#ffd23f", box: false, boxOpacity: 0.62 };
  const started = Date.now();
  const text = ass(cues, words, { states: states(cues, words, "karaoke"), style: "karaoke", look, place });
  const took = Date.now() - started;
  assert.ok(took < 1500, `${took} ms for ${words.length} words`);
  // Each event has the cue's own lines, the spoken word lit.
  const events = text.split("\n").filter((l) => l.startsWith("Dialogue:"));
  assert.equal(events.length, words.length);
  const first = events[0].split(",").slice(9).join(",").replace(/\{[^}]*\}/g, "").split("\\N");
  assert.deepEqual(first, cues[0].lines);
});
