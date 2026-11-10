"use strict";

// Every shape of words the kit reads, made here the way each tool writes
// it, and read back into the same list of words with times.

const assert = require("node:assert/strict");
const test = require("node:test");
const { readWords, seconds } = require("../skills/easycaptionkit/scripts/lib/words");
const { write } = require("./helpers");

const texts = (r) => r.words.map((w) => w.text);
const near = (a, b, within = 0.0011) => Math.abs(a - b) <= within;

test("times in seconds, milliseconds, SRT, VTT and Google's forms", () => {
  assert.equal(seconds(1.5), 1.5);
  assert.equal(seconds("1.5"), 1.5);
  assert.equal(seconds("1.300s"), 1.3);
  assert.equal(seconds("00:00:01,500"), 1.5);
  assert.equal(seconds("00:01.250"), 1.25);
  assert.equal(seconds("1:02:03.25"), 3723.25);
  assert.ok(Number.isNaN(seconds("soon")));
});

test("OpenAI verbose_json: bare words, as OpenAI sends them, take their punctuation and case from its text", () => {
  const file = write("openai.json", {
    task: "transcribe", language: "english", duration: 3.2, text: "Ship it today.",
    words: [{ word: "Ship", start: 0.5, end: 0.8 }, { word: "it", start: 0.8, end: 0.95 }, { word: "today", start: 1.0, end: 1.6 }],
    segments: [{ id: 0, start: 0.5, end: 1.6, text: " Ship it today." }],
  });
  const r = readWords(file);
  assert.equal(r.format, "openai");
  assert.deepEqual(texts(r), ["Ship", "it", "today."]);
  assert.equal(r.words[2].start, 1.0);
  assert.equal(r.byWord, true);
  // Two sentences: the caption ends where the first one does.
  const talk = readWords(write("openai-talk.json", {
    task: "transcribe", language: "english", duration: 9,
    text: "Launch week is here. This one goes out with captions people can read, in the brand's \"own\" font: state-of-the-art, for $20.",
    words: "launch week is here this one goes out with captions people can read in the brand's own font state of the art for 20".split(" ").map((word, i) => ({ word, start: 0.3 + i * 0.3, end: 0.5 + i * 0.3 })),
  }));
  assert.deepEqual(texts(talk), ["Launch", "week", "is", "here.", "This", "one", "goes", "out", "with", "captions", "people", "can", "read,", "in", "the", "brand's", "\"own\"", "font:", "state", "of", "the", "art,", "for", "$20."]);
  const cues = require("../skills/easycaptionkit/scripts/lib/cues").buildCues(talk.words, { lines: 2, maxChars: 42 });
  assert.equal(cues[0].text, "Launch week is here.");
  // A word the text does not have keeps its own spelling, and the rest still line up.
  const odd = readWords(write("openai-odd.json", { text: "Hello there, friend.", words: [{ word: "hello", start: 0, end: 0.3 }, { word: "uh", start: 0.3, end: 0.4 }, { word: "there", start: 0.4, end: 0.7 }, { word: "friend", start: 0.7, end: 1 }] }));
  assert.deepEqual(texts(odd), ["Hello", "uh", "there,", "friend."]);
  // Japanese, written without spaces.
  const ja = readWords(write("openai-ja.json", { text: "今日は、いい天気です。", words: [{ word: "今日", start: 0, end: 0.3 }, { word: "は", start: 0.3, end: 0.4 }, { word: "いい", start: 0.4, end: 0.6 }, { word: "天気", start: 0.6, end: 0.9 }, { word: "です", start: 0.9, end: 1.2 }] }));
  assert.deepEqual(texts(ja), ["今日", "は、", "いい", "天気", "です。"]);
});

test("whisper.cpp JSON, with token times and with segment times only", () => {
  const full = write("whispercpp-full.json", {
    systeminfo: "", model: {}, params: {}, result: { language: "en" },
    transcription: [{
      timestamps: { from: "00:00:00,000", to: "00:00:01,600" }, offsets: { from: 0, to: 1600 }, text: " Hello world, again",
      tokens: [
        { text: "[_BEG_]", offsets: { from: 0, to: 0 } },
        { text: " Hello", offsets: { from: 100, to: 500 } },
        { text: " world", offsets: { from: 500, to: 900 } },
        { text: ",", offsets: { from: 900, to: 950 } },
        { text: " again", offsets: { from: 1000, to: 1500 } },
        { text: "[_TT_80]", offsets: { from: 1600, to: 1600 } },
      ],
    }],
  });
  const r = readWords(full);
  assert.equal(r.format, "whispercpp");
  assert.deepEqual(texts(r), ["Hello", "world,", "again"]);
  assert.ok(near(r.words[1].end, 0.95));
  const plain = write("whispercpp.json", { transcription: [{ timestamps: { from: "00:00:01,000", to: "00:00:03,000" }, offsets: { from: 1000, to: 3000 }, text: " Two words" }] });
  const p = readWords(plain);
  assert.deepEqual(texts(p), ["Two", "words"]);
  assert.equal(p.words[0].start, 1);
  assert.equal(p.words[1].end, 3);
  assert.equal(p.byWord, false);
  // -oj -ml 1 writes a segment for each word: each has its own time.
  const each = readWords(write("whispercpp-ml1.json", { transcription: [{ offsets: { from: 0, to: 400 }, text: " One" }, { offsets: { from: 400, to: 900 }, text: " word" }, { offsets: { from: 1000, to: 1500 }, text: " each." }] }));
  assert.deepEqual(texts(each), ["One", "word", "each."]);
  assert.equal(each.byWord, true);
  assert.equal(each.words[2].start, 1);
  // Without -sow it cuts at every token: a rare word in pieces, and the
  // punctuation alone. They come back as whole words.
  const seg = (from, to, text) => ({ offsets: { from, to }, text });
  const pieces = readWords(write("whispercpp-tokens.json", { transcription: [seg(0, 0, ""), seg(320, 600, " Try"), seg(600, 900, " Makers"), seg(900, 1100, "MC"), seg(1100, 1250, "P"), seg(1300, 1700, " today"), seg(1700, 1800, "."), seg(2000, 2400, " It"), seg(2400, 2800, " costs"), seg(2800, 3100, " 20"), seg(3100, 3600, "26"), seg(3600, 4100, " euros"), seg(4100, 4200, ".")] }));
  assert.deepEqual(texts(pieces), ["Try", "MakersMCP", "today.", "It", "costs", "2026", "euros."]);
  assert.ok(near(pieces.words[1].start, 0.6) && near(pieces.words[1].end, 1.25));
  assert.ok(near(pieces.words[2].end, 1.8));
  // In Japanese each piece stays a word, and the punctuation goes on the one before it.
  const ja = readWords(write("whispercpp-ja.json", { transcription: [seg(0, 300, "今日"), seg(300, 400, "は"), seg(400, 700, "晴れ"), seg(700, 800, "。")] }));
  assert.deepEqual(texts(ja), ["今日", "は", "晴れ。"]);
});

test("WhisperX: segments with words, and a word it could not align placed between its neighbors", () => {
  const file = write("whisperx.json", {
    segments: [{ start: 0.2, end: 2.0, text: "It costs 20 dollars.", words: [{ word: "It", start: 0.2, end: 0.4, score: 0.9 }, { word: "costs", start: 0.45, end: 0.8, score: 0.9 }, { word: "20" }, { word: "dollars.", start: 1.4, end: 2.0, score: 0.8 }] }],
    word_segments: [],
  });
  const r = readWords(file);
  assert.equal(r.format, "whisperx");
  assert.deepEqual(texts(r), ["It", "costs", "20", "dollars."]);
  assert.ok(r.words[2].start >= 0.8 && r.words[2].end <= 1.4, `20 at ${r.words[2].start}`);
  assert.ok(r.notes.some((n) => /1 word had no time of its own/.test(n)));
  // It is marked placed, not timed, and the others keep their own times.
  assert.deepEqual(r.words.map((w) => [Boolean(w.timed), Boolean(w.placed)]), [[true, false], [true, false], [false, true], [true, false]]);
});

test("ElevenLabs: spacing left out, sound tags left out and counted", () => {
  const file = write("elevenlabs.json", {
    language_code: "en", text: "Hi (laughs) there",
    words: [
      { text: "Hi", start: 0.1, end: 0.3, type: "word" },
      { text: " ", start: 0.3, end: 0.35, type: "spacing" },
      { text: "(laughs)", start: 0.35, end: 0.9, type: "audio_event" },
      { text: "there", start: 1.0, end: 1.3, type: "word" },
    ],
  });
  const r = readWords(file);
  assert.equal(r.format, "elevenlabs");
  assert.deepEqual(texts(r), ["Hi", "there"]);
  assert.ok(r.notes.some((n) => /1 sound tag/.test(n)));
});

test("Deepgram, AssemblyAI (milliseconds), NeMo, AWS Transcribe and Google", () => {
  const deepgram = readWords(write("deepgram.json", { results: { channels: [{ alternatives: [{ transcript: "hello there", words: [{ word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.4 }, { word: "there", punctuated_word: "there.", start: 0.5, end: 0.8 }] }] }] } }));
  assert.equal(deepgram.format, "deepgram");
  assert.deepEqual(texts(deepgram), ["Hello", "there."]);
  const assembly = readWords(write("assemblyai.json", { id: "x", status: "completed", audio_duration: 3, words: [{ text: "Fast", start: 250, end: 600, confidence: 0.9 }, { text: "start.", start: 700, end: 1200 }] }));
  assert.equal(assembly.format, "assemblyai");
  assert.ok(near(assembly.words[0].start, 0.25) && near(assembly.words[1].end, 1.2));
  const nemo = readWords(write("nemo.json", { text: "one two", timestamp: { word: [{ word: "one", start: 0.32, end: 0.56, start_offset: 4, end_offset: 7 }, { word: "two", start: 0.64, end: 0.88 }] } }));
  assert.equal(nemo.format, "nemo");
  assert.deepEqual(texts(nemo), ["one", "two"]);
  const aws = readWords(write("aws.json", { results: { transcripts: [{ transcript: "Yes, sir." }], items: [{ type: "pronunciation", start_time: "0.1", end_time: "0.4", alternatives: [{ content: "Yes" }] }, { type: "punctuation", alternatives: [{ content: "," }] }, { type: "pronunciation", start_time: "0.5", end_time: "0.8", alternatives: [{ content: "sir" }] }, { type: "punctuation", alternatives: [{ content: "." }] }] } }));
  assert.equal(aws.format, "aws");
  assert.deepEqual(texts(aws), ["Yes,", "sir."]);
  const google = readWords(write("google.json", { results: [{ alternatives: [{ transcript: "good morning", words: [{ word: "good", startTime: "0.100s", endTime: "0.400s" }, { word: "morning", startTime: "0.400s", endTime: "0.900s" }] }] }] }));
  assert.equal(google.format, "google");
  assert.ok(near(google.words[1].start, 0.4));
});

test("Parakeet sentences of tokens, and transformers chunks by word and by line", () => {
  const parakeet = readWords(write("parakeet.json", { text: "Unbelievable work", sentences: [{ text: "Unbelievable work", start: 0.2, end: 1.4, tokens: [{ text: " Un", start: 0.2, end: 0.4 }, { text: "believ", start: 0.4, end: 0.6 }, { text: "able", start: 0.6, end: 0.8 }, { text: " work", start: 0.9, end: 1.4 }] }] }));
  assert.equal(parakeet.format, "parakeet");
  assert.deepEqual(texts(parakeet), ["Unbelievable", "work"]);
  assert.ok(near(parakeet.words[0].end, 0.8));
  const byWord = readWords(write("chunks-words.json", { text: " a b", chunks: [{ text: " Nice", timestamp: [0.0, 0.3] }, { text: " work", timestamp: [0.3, null] }] }));
  assert.equal(byWord.format, "transformers");
  assert.deepEqual(texts(byWord), ["Nice", "work"]);
  const byLine = readWords(write("chunks-lines.json", { chunks: [{ text: " It works on my machine", timestamp: [0, 2] }, { text: " and on yours", timestamp: [2, 3] }] }));
  assert.deepEqual(texts(byLine), ["It", "works", "on", "my", "machine", "and", "on", "yours"]);
  assert.equal(byLine.byWord, false);
});

test("SRT: tags stripped, entities decoded, each cue a hard segment, its time spread over its words by length", () => {
  const file = write("lines.srt", "1\r\n00:00:01,000 --> 00:00:03,000\r\n<i>Hello</i> {\\an8}wonderful\r\nworld &amp; you\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nBye\r\n");
  const r = readWords(file);
  assert.equal(r.format, "srt");
  assert.equal(r.hard, true);
  assert.deepEqual(texts(r), ["Hello", "wonderful", "world", "&", "you", "Bye"]);
  assert.equal(r.words[0].start, 1);
  assert.ok(near(r.words[4].end, 3));
  // "wonderful" is longer than "Hello", so it takes longer.
  assert.ok(r.words[1].end - r.words[1].start > r.words[0].end - r.words[0].start);
  assert.equal(r.words[5].seg, 1);
});

test("cues that overlap in time, as YouTube's downloaded captions do, keep their words apart", () => {
  const rolling = readWords(write("yt-rolling.srt", [
    "1", "00:00:00,000 --> 00:00:04,170", "hello everyone welcome back to the channel", "",
    "2", "00:00:02,159 --> 00:00:06,450", "today we are going to talk about captions", "",
    "3", "00:00:04,170 --> 00:00:08,610", "and how to keep them clear of the buttons", "",
    "4", "00:00:06,450 --> 00:00:10,000", "so people can read them on a phone", "",
  ].join("\n")));
  assert.equal(texts(rolling).join(" "), "hello everyone welcome back to the channel today we are going to talk about captions and how to keep them clear of the buttons so people can read them on a phone");
  // Each cue ends where the next one comes on.
  assert.ok(near(rolling.words.find((w) => w.text === "channel").end, 2.159));
  assert.equal(rolling.words.find((w) => w.text === "today").start, 2.159);
  for (let i = 1; i < rolling.words.length; i++) assert.ok(rolling.words[i].start >= rolling.words[i - 1].start && rolling.words[i].seg >= rolling.words[i - 1].seg);
  const cues = require("../skills/easycaptionkit/scripts/lib/cues").buildCues(rolling.words, { lines: 2, maxChars: 32, hard: rolling.hard });
  assert.deepEqual(cues.map((c) => c.text), ["hello everyone welcome back to the channel", "today we are going to talk about captions", "and how to keep them clear of the buttons", "so people can read them on a phone"]);
  // Out of order in the file, and two cues that come on together.
  const shuffled = readWords(write("shuffled.vtt", "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nlast\n\n00:00:00.000 --> 00:00:02.000\nfirst line\n\n00:00:00.000 --> 00:00:02.000\nsecond speaker\n"));
  assert.deepEqual(texts(shuffled), ["first", "line", "second", "speaker", "last"]);
  assert.ok(shuffled.words[3].end <= 2.0001);
});

test("YouTube's automatic captions as SRT, which repeat each line in the next cue, say each line once; a line said again in its own cue stays", () => {
  // As yt-dlp --convert-subs srt writes them: a 10 ms cue repeats the
  // line before, then each cue has that line over the new one.
  const ytdlp = readWords(write("ytdlp-auto.srt", [
    "1", "00:00:00,080 --> 00:00:02,149", "hey everybody welcome back to the", "",
    "2", "00:00:02,149 --> 00:00:02,159", "hey everybody welcome back to the", " ", "",
    "3", "00:00:02,159 --> 00:00:04,309", "hey everybody welcome back to the", "channel today we're going to be", "",
    "4", "00:00:04,309 --> 00:00:04,319", "channel today we're going to be", " ", "",
    "5", "00:00:04,319 --> 00:00:06,550", "channel today we're going to be", "talking about captions", "",
  ].join("\n")));
  assert.equal(texts(ytdlp).join(" "), "hey everybody welcome back to the channel today we're going to be talking about captions");
  const cues = require("../skills/easycaptionkit/scripts/lib/cues").buildCues(ytdlp.words, { lines: 2, maxChars: 42, hard: ytdlp.hard });
  assert.deepEqual(cues.map((c) => c.text), ["hey everybody welcome back to the", "channel today we're going to be", "talking about captions"]);
  assert.equal(ytdlp.words.find((w) => w.text === "channel").start, 2.159);
  // A chorus: the same line in cues of its own is said each time.
  const chorus = readWords(write("chorus.srt", "1\n00:00:01,000 --> 00:00:02,000\nLa la la\n\n2\n00:00:02,000 --> 00:00:03,000\nLa la la\n"));
  assert.equal(texts(chorus).join(" "), "La la la La la la");
});

test("a speaker who says again the line the cue before ended with keeps it, cues back to back or not: only a file of rolling captions says its lines twice", () => {
  const dialogue = readWords(write("dialogue.srt", [
    "1", "00:00:01,000 --> 00:00:02,500", "Did you call him?", "",
    "2", "00:00:03,000 --> 00:00:04,000", "No.", "",
    "3", "00:00:06,000 --> 00:00:08,500", "No.", "I was out all day.", "",
    "4", "00:00:09,000 --> 00:00:11,000", "- Ready?", "- Ready.", "",
    "5", "00:00:11,500 --> 00:00:13,500", "- Ready.", "- Then go!", "",
    // A cue of a few milliseconds that repeats the line before, seconds after it: said again, so kept.
    "6", "00:00:20,000 --> 00:00:20,010", "- Then go!", "",
  ].join("\n")));
  assert.equal(texts(dialogue).join(" "), "Did you call him? No. No. I was out all day. - Ready? - Ready. - Ready. - Then go! - Then go!");
  assert.deepEqual(dialogue.notes, []);
  // Back to back, as many exported SRT files have them: every line stays.
  const tight = readWords(write("dialogue-tight.srt", [
    "1", "00:00:01,000 --> 00:00:03,000", "Did you call him?", "",
    "2", "00:00:03,000 --> 00:00:04,500", "- Ready?", "- Ready.", "",
    "3", "00:00:04,500 --> 00:00:06,500", "- Ready.", "- Then go!", "",
    "4", "00:00:06,500 --> 00:00:08,000", "No.", "",
    "5", "00:00:08,000 --> 00:00:10,000", "No.", "I was out all day.", "",
  ].join("\n")));
  assert.equal(texts(tight).join(" "), "Did you call him? - Ready? - Ready. - Ready. - Then go! No. No. I was out all day.");
  assert.deepEqual(tight.notes, []);
  const pair = readWords(write("dialogue-pair.srt", "1\n00:00:01,000 --> 00:00:02,000\nNo.\n\n2\n00:00:02,030 --> 00:00:04,000\nNo.\nI was out all day.\n"));
  assert.equal(texts(pair).join(" "), "No. No. I was out all day.");
});

test("rolling captions are told by their pattern: cues of a moment that repeat the line before, or most cues starting with the last line of the one before; the lines left out are counted", () => {
  // As yt-dlp writes YouTube's automatic captions: a 10 ms cue between each.
  const echoes = readWords(write("rolling-echoes.srt", [
    "1", "00:00:00,080 --> 00:00:02,149", "hey everybody welcome back to the", "",
    "2", "00:00:02,149 --> 00:00:02,159", "hey everybody welcome back to the", "",
    "3", "00:00:02,159 --> 00:00:04,309", "hey everybody welcome back to the", "channel today we're going to be", "",
  ].join("\n")));
  assert.equal(texts(echoes).join(" "), "hey everybody welcome back to the channel today we're going to be");
  assert.deepEqual(echoes.notes, ["The file repeats the line before at the top of its cues, as YouTube's automatic captions do, so 2 repeated lines were left out."]);
  // Without the short cues, every cue of two lines starting with the line before.
  const rolled = readWords(write("rolling-plain.srt", [
    "1", "00:00:00,000 --> 00:00:02,000", "one line of words", "",
    "2", "00:00:02,000 --> 00:00:04,000", "one line of words", "and the second", "",
    "3", "00:00:04,000 --> 00:00:06,000", "and the second", "and a third", "",
    "4", "00:00:06,000 --> 00:00:08,000", "and a third", "and the last", "",
  ].join("\n")));
  assert.equal(texts(rolled).join(" "), "one line of words and the second and a third and the last");
  assert.deepEqual(rolled.notes, ["The file repeats the line before at the top of its cues, as YouTube's automatic captions do, so 3 repeated lines were left out."]);
  // The same as WebVTT without inline times.
  const vtt = readWords(write("rolling-plain.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\none line of words\n\n00:00:02.000 --> 00:00:04.000\none line of words\nand the second\n\n00:00:04.000 --> 00:00:06.000\nand the second\nand a third\n\n00:00:06.000 --> 00:00:08.000\nand a third\nand the last\n"));
  assert.equal(texts(vtt).join(" "), "one line of words and the second and a third and the last");
  assert.equal(vtt.notes.length, 1);
});

test("an entity named like a property every object has stays as it is", () => {
  const r = readWords(write("entities.srt", "1\n00:00:01,000 --> 00:00:03,000\nUse &constructor; and &hasOwnProperty; with &amp; &toString;\n"));
  assert.equal(texts(r).join(" "), "Use &constructor; and &hasOwnProperty; with & &toString;");
});

test("OpenAI's text far longer than its words is read only as far as the words reach", { timeout: 120_000 }, () => {
  const { spawnSync } = require("node:child_process");
  const file = write("openai-long-text.json", "");
  require("node:fs").writeFileSync(file, JSON.stringify({ task: "transcribe", text: "Launch week is here. This one goes out with captions people can read. ".repeat(420_000), words: [{ word: "launch", start: 0.5, end: 0.9 }, { word: "week", start: 0.9, end: 1.3 }] }));
  // Within a heap of 200 MB for a text of 30 MB: a list of every letter would take gigabytes.
  const r = spawnSync(process.execPath, ["--max-old-space-size=200", "-e", "const r = require(process.argv[1]).readWords(process.argv[2]); process.stdout.write(r.words.map((w) => w.text).join(\" \"))", require.resolve("../skills/easycaptionkit/scripts/lib/words"), file], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  assert.equal(r.stdout, "Launch week");
});

test("YouTube's automatic captions turned into SRT by ffmpeg read like the WebVTT they came from", { skip: !require("./helpers").hasFfmpeg && "needs ffmpeg" }, () => {
  const vtt = write("yt-auto.vtt", [
    "WEBVTT", "Kind: captions", "Language: en", "",
    "00:00:00.400 --> 00:00:02.990 align:start position:0%", " ", "hello<00:00:00.880><c> everyone</c><00:00:01.360><c> welcome</c><00:00:01.920><c> back</c>", "",
    "00:00:02.990 --> 00:00:03.000 align:start position:0%", "hello everyone welcome back", " ", "",
    "00:00:03.000 --> 00:00:05.990 align:start position:0%", "hello everyone welcome back", "today<00:00:03.400><c> we</c><00:00:03.600><c> talk</c><00:00:04.000><c> about</c><00:00:04.400><c> captions</c>", "",
    "00:00:05.990 --> 00:00:06.000 align:start position:0%", "today we talk about captions", " ", "",
    "00:00:06.000 --> 00:00:09.000 align:start position:0%", "today we talk about captions", "and<00:00:06.300><c> buttons</c><00:00:06.900><c> on</c><00:00:07.200><c> phones</c>", "",
  ].join("\n"));
  const srt = vtt.replace(/\.vtt$/, "-converted.srt");
  require("./helpers").ffmpeg(["-i", vtt, srt]);
  const fromSrt = readWords(srt);
  const fromVtt = readWords(vtt);
  assert.equal(texts(fromSrt).join(" "), texts(fromVtt).join(" "));
  assert.equal(texts(fromSrt).join(" "), "hello everyone welcome back today we talk about captions and buttons on phones");
});

test("an SRT with a missing empty line between cues, a byte order mark and CRLF line ends", () => {
  const r = readWords(write("noblank.srt", "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\n{\\an8}Hello there\r\n2\r\n00:00:02,500 --> 00:00:03,500\r\nGeneral Kenobi\r\n\r\n3\r\n00:00:04,000 --> 00:00:05,000\r\n<font color=\"#ff0000\">Red &amp; bold</font>\r\n"));
  assert.deepEqual(texts(r), ["Hello", "there", "General", "Kenobi", "Red", "&", "bold"]);
  assert.deepEqual([...new Set(r.words.map((w) => w.seg))], [0, 1, 2]);
  assert.equal(r.words[2].start, 2.5);
  // A cue whose text is a number keeps it when an empty line follows.
  const counted = readWords(write("counted.srt", "1\n00:00:01,000 --> 00:00:02,000\n3\n\n00:00:02,000 --> 00:00:03,000\ngo\n"));
  assert.deepEqual(texts(counted), ["3", "go"]);
});

test("WebVTT, plain and with YouTube's inline word times", () => {
  const plain = readWords(write("plain.vtt", "WEBVTT\n\nNOTE made by hand\n\nintro\n00:01.000 --> 00:02.500 line:90%\n<v Ana>Two &lt;words&gt;\n"));
  assert.equal(plain.format, "vtt");
  assert.deepEqual(texts(plain), ["Two", "<words>"]);
  const youtube = readWords(write("youtube.vtt", [
    "WEBVTT", "Kind: captions", "Language: en", "",
    "00:00:00.000 --> 00:00:02.000 align:start position:0%", " ", "so<00:00:00.400><c> this</c><00:00:00.900><c> is</c><00:00:01.200><c> it</c>", "",
    "00:00:02.000 --> 00:00:02.010 align:start position:0%", "so this is it", " ", "",
    "00:00:02.010 --> 00:00:04.000 align:start position:0%", "so this is it", "and<00:00:02.500><c> more</c>", "",
  ].join("\n")));
  assert.deepEqual(texts(youtube), ["so", "this", "is", "it", "and", "more"]);
  assert.equal(youtube.words[1].start, 0.4);
  assert.equal(youtube.words[5].start, 2.5);
  assert.equal(youtube.byWord, true);
});

test("easyscreenshotkit's steps.json: notes when steps have them, labels without waits when none do", () => {
  const steps = (notes) => ({
    version: 1, kind: "demo", tool: "easyscreenshotkit 0.1.1", video: { file: "demo.mp4", width: 1920, height: 1080, fps: 30, duration: 9 },
    steps: [
      { n: 1, action: "visit", label: "Open acme.com", start: 0, end: 0, ...(notes ? { note: "This is Acme." } : {}) },
      { n: 2, action: "wait", label: "Wait 1.5 s", start: 0.01, end: 1.5 },
      { n: 3, action: "click", label: "Click Pricing", start: 1.6, end: 3.2, ...(notes ? { note: "Pricing is one page." } : {}) },
    ],
  });
  const noted = readWords(write("steps-noted.json", steps(true)));
  assert.equal(noted.format, "steps");
  assert.deepEqual(texts(noted), ["This", "is", "Acme.", "Pricing", "is", "one", "page."]);
  assert.equal(noted.words[0].start, 0);
  assert.ok(noted.words[2].end >= 1.5, "a step that takes no time still shows its words");
  assert.equal(noted.video.duration, 9);
  const labels = readWords(write("steps-labels.json", steps(false)));
  assert.deepEqual(texts(labels), ["Open", "acme.com", "Click", "Pricing"]);
  assert.ok(labels.notes.some((n) => /no step notes/.test(n)));
});

test("a word timed past what a subtitle file can say, as 1e308 s is, is placed between its neighbors", () => {
  const r = readWords(write("huge-times.json", { words: [{ text: "a", start: 1e308, end: 1e308 }, { text: "b", start: 1, end: 2 }, { text: "c", start: 2, end: 1e300 }, { text: "d", start: 4, end: 5 }] }));
  assert.deepEqual(texts(r), ["a", "b", "c", "d"]);
  for (const w of r.words) assert.ok(Number.isFinite(w.start * 1000) && Number.isFinite(w.end * 1000) && w.end <= 5, JSON.stringify(w));
  assert.deepEqual(r.words.map((w) => w.timed), [false, true, false, true]);
  assert.ok(r.notes.some((n) => /2 words had no time of their own and were placed between the words around them/.test(n)), r.notes.join(" | "));
  const { srt, vtt } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const cues = require("../skills/easycaptionkit/scripts/lib/cues").buildCues(r.words, { lines: 2, maxChars: 42, hard: r.hard, duration: Infinity });
  for (const text of [srt(cues), vtt(cues)]) assert.doesNotMatch(text, /NaN|Infinity/);
});

test("its own words.json reads back the same", () => {
  const file = write("own.json", { tool: "easycaptionkit 0.1.0", from: "x", hard: true, words: [{ text: "Fixed", start: 0.5, end: 0.9, seg: 0 }, { text: "word", start: 1, end: 1.3, seg: 1, spread: true }] });
  const r = readWords(file);
  assert.equal(r.format, "easycaptionkit");
  assert.equal(r.hard, true);
  assert.deepEqual(texts(r), ["Fixed", "word"]);
  assert.equal(r.words[1].seg, 1);
  // A word the first run placed between its neighbors, as its file gave it no time, is still placed, not timed.
  const placed = readWords(write("own-placed.json", { tool: "easycaptionkit 0.1.0", from: "WhisperX or faster-whisper JSON", words: [{ text: "It", start: 0.2, end: 0.4, seg: 0 }, { text: "20", start: 0.8, end: 1.1, seg: 0, placed: true }, { text: "dollars.", start: 1.4, end: 2, seg: 0 }] }));
  assert.deepEqual(placed.words.map((w) => [Boolean(w.timed), Boolean(w.placed)]), [[true, false], [false, true], [true, false]]);
  // The format its words first came in, which it names as its `from`: a demo's steps read again are still steps.
  assert.equal(r.firstFormat, "");
  const first = (from) => readWords(write("own-from.json", { tool: "easycaptionkit 0.1.0", from, hard: true, words: [{ text: "Open", start: 0, end: 0.5, seg: 0, spread: true }] })).firstFormat;
  assert.deepEqual([first("easyscreenshotkit's steps.json"), first("OpenAI verbose_json"), first("a words.json from easycaptionkit"), first(7)], ["steps", "openai", "", ""]);
});

test("a word added to words.json by hand, without a segment, shows where its time puts it", () => {
  const { buildCues } = require("../skills/easycaptionkit/scripts/lib/cues");
  const { srt } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const own = (words) => readWords(write("own-added.json", { tool: "easycaptionkit 0.1.0", from: "an SRT file", hard: true, words }));
  const r = own([
    { text: "Watch", start: 0.5, end: 1, seg: 0, spread: true }, { text: "this.", start: 1, end: 2.9, seg: 0, spread: true },
    { text: "Try", start: 9, end: 9.5, seg: 1, spread: true }, { text: "your", start: 9.5, end: 10.3, seg: 1, spread: true },
    { text: "first", start: 10.3, end: 10.49 },
    { text: "reel.", start: 10.5, end: 11.8, seg: 1, spread: true },
    // Between the segments by time, and with no time at all, after "this.".
    { text: "then", start: 5, end: 5.4 },
  ]);
  assert.deepEqual(texts(r), ["Watch", "this.", "then", "Try", "your", "first", "reel."]);
  assert.equal(r.words.find((w) => w.text === "first").seg, 1);
  const cues = buildCues(r.words, { lines: 2, maxChars: 42, hard: r.hard });
  assert.deepEqual(cues.flatMap((c) => c.text.split(" ")), texts(r));
  assert.ok(cues.some((c) => c.text === "Try your first reel."), cues.map((c) => c.text).join(" | "));
  for (const cue of cues) assert.ok(cue.end > cue.start);
  assert.match(srt(cues), /^1\n00:00:00,500 --> /);
  const untimed = own([{ text: "One", start: 0, end: 0.5, seg: 0 }, { text: "two", seg: 0 }, { text: "three" }, { text: "Four", start: 3, end: 3.5, seg: 1 }]);
  assert.deepEqual(texts(untimed), ["One", "two", "three", "Four"]);
});

test("Japanese without spaces is split into words, with punctuation kept on the word before it", () => {
  const r = readWords(write("ja.srt", "1\n00:00:00,000 --> 00:00:02,000\n今日はいい天気ですね。\n"));
  assert.ok(r.words.length >= 4, texts(r).join("|"));
  assert.equal(texts(r).join(""), "今日はいい天気ですね。");
  assert.ok(texts(r).at(-1).endsWith("。"));
});

test("an object or a list where a word's text, a time, a segment or a tool goes gives no word or none of it, and one with a toString or a valueOf of its own stops nothing, where it became \"[object Object]\" or \"a,b\", or failed with an error that named no file", () => {
  // An object, a list and an object with a toString of its own where a word's text goes: no word, the others read.
  assert.deepEqual(texts(readWords(write("text-object.json", [{ text: "hello", start: 0.2, end: 0.6 }, { text: { value: "world" }, start: 0.6, end: 1 }, { text: ["a", "b"], start: 1, end: 1.4 }]))), ["hello"]);
  assert.deepEqual(texts(readWords(write("text-tostring.json", [{ text: "hello", start: 0.2, end: 0.6 }, { text: { toString: "x" }, start: 0.6, end: 1 }]))), ["hello"]);
  // A number is its digits, as before.
  assert.deepEqual(texts(readWords(write("text-number.json", [{ text: "since", start: 0.2, end: 0.6 }, { text: 2026, start: 0.6, end: 1 }]))), ["since", "2026"]);
  // A tool named by an object is no easycaptionkit's, and its words are read as a list's.
  const tool = readWords(write("tool-tostring.json", { tool: { toString: 1 }, words: [{ text: "hi", start: 0, end: 1 }] }));
  assert.deepEqual([tool.format, texts(tool)], ["words", ["hi"]]);
  // A segment's text that no text can be made of: the file's own message, which names it.
  assert.throws(() => readWords(write("segment-valueof.json", { segments: [{ start: 0, end: 1, text: { valueOf: 1, toString: 2 } }] })), /segment-valueof\.json: no words with times in it\./);
  // A segment number that is no whole number is none.
  const seg = readWords(write("seg-tostring.json", [{ text: "hello", start: 0.2, end: 0.6, seg: { toString: 1 } }, { text: "world", start: 0.6, end: 1, seg: { toString: 1 } }]));
  assert.deepEqual([texts(seg), seg.words.map((w) => w.seg)], [["hello", "world"], [-1, -1]]);
  // whisper.cpp's tokens and segments, Parakeet's tokens, AWS's content, ElevenLabs' text and a demo's steps, each with such values.
  const odd = { toString: 1, valueOf: 2 };
  const cpp = readWords(write("odd-whispercpp.json", { transcription: [{ offsets: { from: 0, to: 900 }, tokens: [{ text: " Hello", offsets: { from: 0, to: 400 } }, { text: odd, offsets: { from: 400, to: 600 } }, { text: " there", offsets: { from: odd, to: odd } }] }, { offsets: { from: 1000, to: 2000 }, text: odd }, { offsets: { from: 2000, to: 3000 }, text: " again" }] }));
  assert.deepEqual(texts(cpp), ["Hello", "there", "again"]);
  assert.deepEqual(texts(readWords(write("odd-parakeet.json", { sentences: [{ tokens: [{ text: "▁Hello", start: 0.5, end: 0.9 }, { text: odd, start: 0.9, end: 1 }, { text: "▁there", start: 1, end: 1.3 }] }] }))), ["Hello", "there"]);
  assert.deepEqual(texts(readWords(write("odd-aws.json", { results: { items: [{ type: "pronunciation", start_time: "0.5", end_time: "0.9", alternatives: [{ content: odd }] }, { type: "pronunciation", start_time: "1", end_time: "1.4", alternatives: [{ content: "there" }] }] } }))), ["there"]);
  assert.deepEqual(texts(readWords(write("odd-elevenlabs.json", { words: [{ type: "word", text: odd, start: 0.5, end: 0.9 }, { type: "word", text: "there", start: 1, end: 1.4 }] }))), ["there"]);
  const steps = readWords(write("odd-steps.json", { kind: "demo", video: { duration: odd }, steps: [{ action: "visit", note: odd, start: 0 }, { action: "click", note: "Pricing", start: odd }, { action: "click", note: "One plan.", start: 2, end: odd }] }));
  assert.deepEqual([texts(steps), steps.video], [["One", "plan."], null]);
});

test("a null or a number where an entry of a speech-to-text list goes is passed over, in every shape that has lists", () => {
  const word = { word: "Hello", start: 0.5, end: 0.9 };
  const shapes = {
    aws: { results: { items: [null, 7, { type: "pronunciation", start_time: "0.5", end_time: "0.9", alternatives: [null] }, { type: "pronunciation", start_time: "0.5", end_time: "0.9", alternatives: [{ content: "Hello" }] }] } },
    google: { results: [null, { alternatives: [null] }, { alternatives: [{ words: [{ word: "Hello", startTime: "0.5s", endTime: "0.9s" }] }] }] },
    whisperx: { segments: [null, { start: 0.5, end: 1, text: "Hello", words: [null, word] }] },
    openai: { task: "transcribe", text: "Hello there.", words: [word, { word: "there", start: 1, end: 1.4 }], segments: [null, 3, { end: 2, text: "Hello there." }] },
    transformers: { chunks: [null, { text: " Hello", timestamp: [0.5, 0.9] }] },
    parakeet: { sentences: [null, { tokens: [null, { text: "▁Hello", start: 0.5, end: 0.9 }, { start: 0.9, end: 1 }] }] },
  };
  for (const [format, data] of Object.entries(shapes)) {
    const read = readWords(write(`nulls-${format}.json`, data));
    assert.equal(read.format, format);
    assert.deepEqual(texts(read).slice(0, 1), ["Hello"], format);
  }
});

test("files that are not words say what they are not", () => {
  assert.throws(() => readWords(write("note.txt", "just some notes")), /not JSON, SRT or WebVTT/);
  // An ASS file, by its name or by its first line.
  const ass = "[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n";
  for (const name of ["captions.ass", "old.ssa", "renamed.txt", "renamed.json"]) assert.throws(() => readWords(write(name, ass)), /: easycaptionkit does not read ASS files as words\. Give the SRT or VTT file, or the speech-to-text JSON, the ASS was made from$/, name);
  assert.throws(() => readWords(write("bom.ass", `\ufeff${ass}`)), /does not read ASS files/);
  assert.throws(() => readWords(write("other.json", { hello: "world" })), /no words with times/);
  // Shapes it does not read: Rev.ai's, Azure's, and Speechmatics', which looks like Google's.
  const shapes = {
    revai: { monologues: [{ elements: [{ type: "text", value: "Hello", ts: 0.5, end_ts: 0.9 }] }] },
    azure: { recognizedPhrases: [{ nBest: [{ words: [{ word: "Hello", offsetInTicks: 5000000, durationInTicks: 4000000 }] }] }] },
    speechmatics: { results: [{ type: "word", start_time: 0.5, end_time: 0.9, alternatives: [{ content: "Hello", confidence: 1 }] }] },
  };
  for (const [name, data] of Object.entries(shapes)) assert.throws(() => readWords(write(`${name}.json`, data)), /: no words with times in it\. easycaptionkit reads easyscreenshotkit's steps\.json, an SRT file, .*, and plain lists of \{ text, start, end \}$/, name);
  // A shape it reads, with no words in it, says so.
  assert.throws(() => readWords(write("steps-none.json", { kind: "demo", steps: [] })), /steps-none\.json holds no words to caption$/);
  // So does a speech-to-text's answer for a clip with no speech: its list of words is empty.
  const silent = {
    openai: { task: "transcribe", language: "english", duration: 6, text: "", words: [], segments: [] },
    whispercpp: { transcription: [] },
    deepgram: { results: { channels: [{ alternatives: [{ transcript: "", confidence: 0, words: [] }] }] } },
    elevenlabs: { language_code: "en", text: "", words: [] },
  };
  for (const [name, data] of Object.entries(silent)) assert.throws(() => readWords(write(`silent-${name}.json`, data)), new RegExp(`silent-${name}\\.json holds no words to caption, as a speech-to-text model gives for a clip with no speech$`), name);
  // A bare empty list, which nothing says a speech-to-text wrote, holds none, and that is all.
  assert.throws(() => readWords(write("empty-list.json", [])), /empty-list\.json holds no words to caption$/);
  assert.throws(() => readWords(write("empty.srt", "")), /no words to caption|not JSON/);
  assert.throws(() => readWords(write("bad.vtt", "1\n00:00:00,000 --> 00:00:01,000\nhi\n")), /WEBVTT/);
  assert.throws(() => readWords("/nonexistent/words.json"), /no such file/);
  // A file far too big to be words, such as the video given in its place, is not read.
  const big = write("big.json", "");
  require("node:fs").truncateSync(big, 65 * 1024 * 1024);
  assert.throws(() => readWords(big), /65 MB, too big to be a words file/);
  // A JSON file says where it stops being JSON.
  assert.throws(() => readWords(write("typo.json", '{"words": [\n  {"text": "won"t", "start": 1, "end": 2}\n]}')), /it is not valid JSON at line 2, column 17: Expected ',' or '\}' after property value/);
  assert.throws(() => readWords(write("typo.txt", '[{"text": "a", "start": 1,, "end": 2}]')), /it is not valid JSON at line 1, column 27/);
  // Also where JSON.parse gives no position, as for a word typed without quotes, and with none of the file's own text in the message.
  for (const [text, where] of [['{"words": [\n  {"text": Launch, "start": 1, "end": 2}\n]}', "line 2, column 12: Unexpected token 'L'"], ['{"words": [\n  {"text": \'Launch\', "start": 1}]}', "line 2, column 12: Unexpected token '''"], ['{"words": [{"text": "a", "start": .5}]}', "line 1, column 35: Unexpected token '.'"], ['{"words": [{"text": "a", "start": 1', "line 1, column 36: Expected ',' or '}' after property value"]]) {
    let message = "";
    try {
      readWords(write("typo-unquoted.json", text));
    } catch (err) {
      message = err.message;
    }
    assert.ok(message.endsWith(`it is not valid JSON at ${where}`), message);
  }
  let shownMessage = "";
  try {
    readWords(write("typo-escape.json", '{"words": [{"text": x\u001b[31m red\n}]}'));
  } catch (err) {
    shownMessage = err.message;
  }
  assert.match(shownMessage, /at line 1, column 21: Unexpected token 'x'$/);
  assert.doesNotMatch(shownMessage, /[\u0000-\u001f]/);
});

test("a words file saved as UTF-16, as Notepad's Unicode and some Windows subtitle tools save it, reads as its UTF-8 does", () => {
  const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\nÇa va, très bien.\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n日本語も 😀\r\n";
  const want = texts(readWords(write("u8.srt", srt)));
  assert.deepEqual(want, ["Ça", "va,", "très", "bien.", "日本語", "も", "😀"]);
  const le = Buffer.from(srt, "utf16le");
  const be = Buffer.from(le).swap16();
  for (const [name, bytes] of [["u16le-bom.srt", Buffer.concat([Buffer.from([0xff, 0xfe]), le])], ["u16be-bom.srt", Buffer.concat([Buffer.from([0xfe, 0xff]), be])], ["u16le.txt", le], ["u16be.txt", be]]) {
    const file = write(name, "");
    require("node:fs").writeFileSync(file, bytes);
    assert.deepEqual(texts(readWords(file)), want, name);
  }
  const json = write("u16.json", "");
  require("node:fs").writeFileSync(json, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ words: [{ word: "Hello", start: 0, end: 1 }] }), "utf16le")]));
  assert.deepEqual(texts(readWords(json)), ["Hello"]);
});

test("a file of long runs of blank lines, spaces, tags or braces is read or refused in moments: no pattern scans a run again from each of its letters", () => {
  const quick = (what, fn) => {
    const start = Date.now();
    try {
      fn();
    } catch {
      // Refused, as most of these are.
    }
    const took = Date.now() - start;
    assert.ok(took < 1500, `${what} took ${took} ms`);
  };
  quick("blank lines", () => readWords(write("blank-lines.txt", `${"\n".repeat(100_000)}x`)));
  quick("blank lines after a number", () => readWords(write("number-blank.txt", `1${"\n".repeat(60_000)}x`)));
  quick("spaces after a number", () => readWords(write("number-spaces.txt", `1${" ".repeat(60_000)}\nx`)));
  quick("a line of brackets", () => readWords(write("brackets.srt", `1\n00:00:01,000 --> 00:00:02,000\n${"<".repeat(80_000)}\n`)));
  quick("a line of braces", () => readWords(write("braces.srt", `1\n00:00:01,000 --> 00:00:02,000\n${"{\\".repeat(50_000)}\n`)));
  // Two cues of many lines back to back, which are looked at for lines said
  // again, are read about as fast as the same cues apart, which are not.
  const lines = Array(40_000).fill("a").join("\n");
  const timed = (name, second) => {
    const file = write(name, `1\n00:00:00,000 --> 00:00:01,000\n${lines}\nb\n\n2\n${second}\n${lines}\n`);
    const start = Date.now();
    assert.equal(readWords(file).words.length, 80_001);
    return Date.now() - start;
  };
  const apart = timed("lines-apart.srt", "00:00:05,000 --> 00:00:06,000");
  const together = timed("lines-together.srt", "00:00:01,000 --> 00:00:02,000");
  assert.ok(together < 2 * apart + 500, `back to back ${together} ms, apart ${apart} ms`);
  const tags = readWords(write("tags.srt", "1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i> {\\an8}there <b>you\n"));
  assert.deepEqual(texts(tags), ["Hello", "there", "you"]);
});

test("a pipe that goes on past what words take is stopped there, words can come in on one, and a signal stops a run that waits on one nothing writes to yet", { skip: process.platform === "win32" && "needs mkfifo" }, async () => {
  const { spawn, spawnSync } = require("node:child_process");
  const fifo = require("node:path").join(require("./helpers").dir, "endless.json");
  spawnSync("mkfifo", [fifo]);
  // 70 MB of spaces from another process, which a size check of the file cannot see.
  const writer = spawn(process.execPath, ["-e", `const fs = require("fs"); const fd = fs.openSync(${JSON.stringify(fifo)}, "w"); const b = Buffer.alloc(1 << 20, 32); try { for (let i = 0; i < 70; i++) fs.writeSync(fd, b); } catch {}`], { stdio: "ignore" });
  const run = require("./helpers").run(["subtitles", fifo, "--out", require("node:path").join(require("./helpers").dir, "endless-out")]);
  writer.kill();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /endless\.json is more than 64 MB, too big to be a words file/);
  // Words a shell pipes in.
  const small = write("piped.json", { words: [{ text: "piped", start: 0.1, end: 0.5 }] });
  const out = require("node:path").join(require("./helpers").dir, "piped-out");
  const piped = spawnSync("sh", ["-c", 'cat "$1" | "$2" "$3" subtitles /dev/stdin --out "$4"', "sh", small, process.execPath, require("./helpers").CLI, out], { encoding: "utf8" });
  assert.equal(piped.status, 0, piped.stderr);
  assert.match(require("node:fs").readFileSync(require("node:path").join(out, "captions.srt"), "utf8"), /piped/);
  // A pipe nothing writes to yet: Ctrl-C or a kill stops the run while it waits, as at any other moment.
  const fs = require("node:fs");
  const path = require("node:path");
  const waiting = path.join(require("./helpers").dir, "waiting.json");
  spawnSync("mkfifo", [waiting]);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const folder = path.join(require("./helpers").dir, `waiting-out-${signal}`);
    const child = spawn(process.execPath, [require("./helpers").CLI, "subtitles", waiting, "--out", folder], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const ended = new Promise((resolve) => child.on("close", (code, sig) => resolve({ code, signal: sig })));
    // Once the kit listens for its signals, as Linux's /proc shows, and a moment more for it to
    // reach the pipe; a busy machine starts Node slowly. Node catches SIGINT and SIGTERM itself
    // from its start, so the sign is SIGHUP, which the kit listens for after those two.
    // Elsewhere, two seconds.
    const listening = () => {
      try {
        const mask = BigInt(`0x${/^SigCgt:\s*([0-9a-f]+)$/m.exec(fs.readFileSync(`/proc/${child.pid}/status`, "utf8"))[1]}`);
        return Boolean(mask & 1n);
      } catch {
        return null;
      }
    };
    for (let waited = 0; waited < 20_000 && listening() === false; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, listening() === null ? 2000 : 300));
    child.kill(signal);
    const r = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve(null), 5000))]);
    if (!r) {
      // Let the open go through, so the run can end.
      try {
        fs.closeSync(fs.openSync(waiting, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
      } catch {
        // No reader is waiting.
      }
      await ended;
    }
    assert.ok(r, `${signal} did not stop a run waiting for its words`);
    assert.equal(r.signal, signal, `exit ${r.code}: ${stderr}`);
    assert.equal(stderr, "easycaptionkit: stopped\n");
    assert.equal(fs.existsSync(folder), false);
  }
});

test("a words file past what a run takes is refused in moments: a word longer than 500 characters, more than 100,000 words, or more than a million characters of them", () => {
  const { LONGEST_WORD, MOST_WORDS, MOST_TEXT } = require("../skills/easycaptionkit/scripts/lib/words");
  assert.deepEqual([LONGEST_WORD, MOST_WORDS, MOST_TEXT], [500, 100_000, 1_000_000]);
  const quick = (name, content, pattern) => {
    const started = Date.now();
    assert.throws(() => readWords(write(name, content)), pattern);
    assert.ok(Date.now() - started < 5000, `${name} took ${Date.now() - started} ms`);
  };
  const word = "a".repeat(8 * 1024 * 1024);
  const long = /: it holds a word 8,388,608 characters long, and a word to caption is at most 500\. Check that it holds the words of the video, each with its time$/;
  // One word of megabytes, in a list, in OpenAI's shape with its text, on an SRT line and in a line of a list of lines.
  quick("long-word.json", [{ text: word, start: 0.5, end: 1.5 }, { text: "end.", start: 1.6, end: 2 }], long);
  quick("long-word-openai.json", { task: "transcribe", text: `${word} end.`, words: [{ word, start: 0.5, end: 1.5 }, { word: "end", start: 1.6, end: 2 }] }, long);
  quick("long-word.srt", `1\n00:00:01,000 --> 00:00:02,000\n${word}\n`, long);
  quick("long-line.json", [{ text: `one ${word}`, start: 0.5, end: 1.5 }, { text: "two three", start: 1.6, end: 2 }], long);
  // A line of Japanese of a million words.
  quick("many-ja.srt", `1\n00:00:01,000 --> 00:00:02,000\n${"日本語".repeat(1_000_000)}\n`, /: it holds more than 100,000 words, and a run takes at most 100,000, some 10 hours of speech\. Caption a longer video in parts, each with its own words$/);
  const many = (count, text) => ({ words: Array.from({ length: count }, (_, i) => ({ word: text, start: i * 0.3, end: i * 0.3 + 0.25 })) });
  quick("many-words.json", many(MOST_WORDS + 1, "go"), /: it holds 100,001 words, and a run takes at most 100,000, some 10 hours of speech\./);
  quick("much-text.json", many(4000, "w".repeat(251)), /: its words hold 1,004,000 characters, and a run takes at most 1,000,000, some 10 hours of speech\./);
  // At the limits it reads.
  assert.equal(readWords(write("most-words.json", many(MOST_WORDS, "go"))).words.length, MOST_WORDS);
  assert.equal(readWords(write("longest-word.json", [{ text: "w".repeat(500), start: 0.5, end: 1.5 }])).words[0].text.length, 500);
  // An SRT or a WebVTT file of 1.2 million cues of a word each, some 45 MB: refused as it is
  // read, in moments, and with less memory than a small machine gives Node.
  const stamp = (t, mark) => `${new Date(Math.round(t * 1000)).toISOString().slice(11, 19)}${mark}${String(Math.round(t * 1000) % 1000).padStart(3, "0")}`;
  const cues = (count, cue) => Array.from({ length: count }, (_, i) => cue(i + 1, stamp(i * 0.02, ","), stamp(i * 0.02 + 0.015, ","))).join("");
  const srt = write("many-cues.srt", cues(1_200_000, (n, from, to) => `${n}\n${from} --> ${to}\nw${n}\n\n`));
  const vtt = write("many-cues.vtt", `WEBVTT\n\n${cues(1_200_000, (n, from, to) => `${from.replace(",", ".")} --> ${to.replace(",", ".")}\nw${n}\n\n`)}`);
  const lib = require.resolve("../skills/easycaptionkit/scripts/lib/words");
  for (const file of [srt, vtt]) {
    const started = Date.now();
    const r = require("node:child_process").spawnSync(process.execPath, ["--max-old-space-size=200", "-e", `try { require(${JSON.stringify(lib)}).readWords(${JSON.stringify(file)}); } catch (err) { console.log(err.message); }`], { encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, `${file}: ${r.stderr.slice(-300)}`);
    assert.match(r.stdout, /: it holds more than 100,000 words, and a run takes at most 100,000, some 10 hours of speech\./);
    assert.ok(Date.now() - started < 10_000, `${file} took ${Date.now() - started} ms`);
  }
  // Across the cues, the words and their characters count as they come: past 100,000 words, or a million characters.
  // Each cue says its own words: cues of a moment that say the line before again are rolling captions' repeats.
  const own = (n) => `${n}`.padEnd(500, "t");
  quick("many-words.srt", cues(25_001, (n, from, to) => `${n}\n${from} --> ${to}\nw${n} a b c\n\n`), /: it holds more than 100,000 words, and a run takes at most 100,000/);
  quick("much-text.vtt", `WEBVTT\n\n${cues(2_001, (n, from, to) => `${from.replace(",", ".")} --> ${to.replace(",", ".")}\n${own(n)}\n\n`)}`, /: its words hold more than 1,000,000 characters, and a run takes at most 1,000,000, some 10 hours of speech\./);
  // And at the limits they read.
  assert.equal(readWords(write("most-words.srt", cues(25_000, (n, from, to) => `${n}\n${from} --> ${to}\nw${n} a b c\n\n`))).words.length, MOST_WORDS);
  assert.equal(readWords(write("most-text.vtt", `WEBVTT\n\n${cues(2_000, (n, from, to) => `${from.replace(",", ".")} --> ${to.replace(",", ".")}\n${own(n)}\n\n`)}`)).words.length, 2_000);
  // Millions of words in one cue, one line, one segment or a list of lines, which the 64 MB a words file takes lets in,
  // are refused at the word past the most, in moments and with less memory than a small machine gives Node, where they were
  // split whole first, and each line of a list of lines counted on its own: half a minute and gigabytes, or a heap out of memory.
  const bounded = (name, content, pattern) => {
    const file = write(name, content);
    const started = Date.now();
    const r = require("node:child_process").spawnSync(process.execPath, ["--max-old-space-size=200", "-e", `try { require(${JSON.stringify(lib)}).readWords(${JSON.stringify(file)}); } catch (err) { console.log(err.message); }`], { encoding: "utf8", timeout: 120_000 });
    require("node:fs").rmSync(file, { force: true });
    assert.equal(r.status, 0, `${name}: ${r.stderr.slice(-300)}`);
    assert.match(r.stdout, pattern, name);
    assert.ok(Date.now() - started < 10_000, `${name} took ${Date.now() - started} ms`);
  };
  const more = /: it holds more than 100,000 words, and a run takes at most 100,000, some 10 hours of speech\./;
  const line = (unit, size) => unit.repeat(Math.floor(size / unit.length));
  const MB = 1024 * 1024;
  bounded("one-cue.srt", `1\n00:00:01,000 --> 00:00:02,000\n${line("ab ", 60 * MB)}\n`, more);
  bounded("one-cue.vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${line("ab ", 20 * MB)}\n`, more);
  bounded("one-segment.json", JSON.stringify({ segments: [{ start: 1, end: 2, text: line("ab ", 20 * MB) }] }), more);
  bounded("list-of-lines.json", JSON.stringify(Array.from({ length: 180_000 }, (_, i) => ({ text: line("ab ", 300), start: i, end: i + 1 }))), more);
  bounded("whispercpp-lines.json", JSON.stringify({ transcription: Array.from({ length: 60_000 }, (_, i) => ({ offsets: { from: i * 1000, to: i * 1000 + 900 }, text: line(" ab", 300) })) }), more);
  // A karaoke line of millions of times, and a line of millions of words between tabs, entities or tags.
  bounded("karaoke-line.vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${line("<00:00:01.500>ab ", 20 * MB)}\n`, more);
  bounded("tabs.srt", `1\n00:00:01,000 --> 00:00:02,000\n${line("ab\t", 20 * MB)}\n`, more);
  bounded("entities.srt", `1\n00:00:01,000 --> 00:00:02,000\n${line("a&amp; ", 20 * MB)}\n`, more);
  bounded("tags.srt", `1\n00:00:01,000 --> 00:00:02,000\n${line("<i>ab</i> ", 20 * MB)}\n`, more);
  // A cue of millions of lines: it keeps all but its first three, each a word at least.
  bounded("cue-of-lines.srt", `1\n00:00:01,000 --> 00:00:02,000\n${line("ab\n", 20 * MB)}\n`, more);
  bounded("cue-of-lines.vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${line("ab\n", 20 * MB)}\n`, more);
  // Cues of fewer lines each, but millions in all: the lines of a file count across its cues, where each cue's were
  // counted alone and the words only once every cue was kept, a gigabyte and more.
  const lines = /: it holds more than 500,000 lines of captions, and a run takes at most 100,000 words, some 10 hours of speech\. Caption a longer video in parts, each with its own words$/m;
  bounded("cues-of-lines.srt", cues(200, (n, from, to) => `${n}\n${from} --> ${to}\n${"ab\n".repeat(100_000)}\n`), lines);
  bounded("cues-of-lines.vtt", `WEBVTT\n\n${cues(200, (n, from, to) => `${from.replace(",", ".")} --> ${to.replace(",", ".")}\n${"ab\n".repeat(100_000)}\n`)}`, lines);
  // A list of millions of entries is refused before it is made into words, where it was mapped whole first.
  const entries = /: it holds more than 500,000 entries, and a run takes at most 100,000 words, some 10 hours of speech\./;
  bounded("many-entries.json", `[${Array.from({ length: 2_000_001 }, () => '{"text":"a"}').join(",")}]`, entries);
  // Millions of empty objects or lists, or lists opened one inside another, in the 64 MB a words file takes, are refused
  // before JSON.parse makes them or badAt keeps a stack of them, where they took gigabytes and half a minute, or ran out
  // of the heap.
  bounded("objs.json", `[${"{},".repeat(22_000_000)}{}]`, entries);
  bounded("arrs.json", `[${"[],".repeat(22_000_000)}[]]`, entries);
  const deep = /: it nests lists and objects more than 64 deep, where a words file nests them a few deep\. Check that it holds the words of the video, each with its time$/m;
  bounded("open.json", "[".repeat(64 * MB - 16), deep);
  // Brackets in a string are text, and 64 levels are still read as JSON.
  assert.throws(() => readWords(write("deep-65.json", `${"[".repeat(65)}${"]".repeat(65)}`)), deep);
  assert.throws(() => readWords(write("deep-64.json", `${"[".repeat(64)}${"]".repeat(64)}`)), /: no words with times in it\./);
  assert.deepEqual(readWords(write("brackets.json", [{ text: "[".repeat(100), start: 0.5, end: 1 }, { text: "{".repeat(100), start: 1, end: 1.5 }])).words.map((w) => w.text.length), [100, 100]);
  // A cue of millions of lines of spaces, which give no words, reads, keeping none of them.
  const spaces = write("spaces.vtt", `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${"  \n".repeat(20_000_000)}word\n`);
  const started = Date.now();
  const r = require("node:child_process").spawnSync(process.execPath, ["--max-old-space-size=200", "-e", `console.log(JSON.stringify(require(${JSON.stringify(lib)}).readWords(${JSON.stringify(spaces)}).words.map((w) => w.text)))`], { encoding: "utf8", timeout: 120_000 });
  require("node:fs").rmSync(spaces, { force: true });
  assert.equal(r.status, 0, r.stderr.slice(-300));
  assert.equal(r.stdout.trim(), '["word"]');
  assert.ok(Date.now() - started < 10_000, `spaces.vtt took ${Date.now() - started} ms`);
  // An SRT cue of millions of lines of a tag alone, which give no words, counts them as lines of the file, as a WebVTT
  // cue's are, where it kept every one, read them all and ran out of memory; fewer of them read, and are not kept.
  bounded("tag-lines.srt", `1\n00:00:01,000 --> 00:00:02,000\nword\n${"<b>\n".repeat(15_000_000)}`, lines);
  bounded("entity-lines.srt", `1\n00:00:01,000 --> 00:00:02,000\nword\n${"&nbsp;\n".repeat(9_000_000)}`, lines);
  assert.deepEqual(readWords(write("some-tag-lines.srt", `1\n00:00:01,000 --> 00:00:02,000\nword\n${"<b>\n".repeat(400_000)}last\n`)).words.map((w) => w.text), ["word", "last"]);
  // A long line of few words, the rest spaces, tags and entities, still reads.
  const padded = readWords(write("padded.srt", `1\n00:00:01,000 --> 00:00:02,000\nfirst ${line(" \t<b></b>&nbsp; ", 4 * MB)} last\n`)).words;
  assert.deepEqual(padded.map((w) => w.text), ["first", "last"]);
});
