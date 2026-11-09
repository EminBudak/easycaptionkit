"use strict";

// Which letters come out as boxes: with Chrome, those no font it names for
// the captions has, as fontconfig lists each font's letters and the files
// of fonts.css hold them; with libass, those no font on the machine has.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { letterSet, fontLetters, machineLetters, hasLetter, chromeBoxes, boxesIn } = require("../skills/easycaptionkit/scripts/lib/boxes");
const { kitLetters } = require("../skills/easycaptionkit/scripts/lib/subtitles");
const { dir, FIXTURES } = require("./helpers");

const hasFontconfig = process.platform === "linux" && spawnSync("fc-list", ["--version"], { stdio: "ignore" }).status === 0;

test("fontconfig's charsets read as the code points they list, their ranges joined", () => {
  const has = letterSet(["20-7e a0-17f 192", "", "180-191 3000-303f 1f600", "41-5a"]);
  for (const code of [0x20, 0x41, 0x7e, 0xa0, 0x17f, 0x180, 0x191, 0x192, 0x3000, 0x303f, 0x1f600]) assert.ok(has(code), code.toString(16));
  for (const code of [0x1f, 0x7f, 0x9f, 0x193, 0x2fff, 0x3040, 0x1f601, 0x10fffd]) assert.ok(!has(code), code.toString(16));
  assert.equal(letterSet([])(0x41), false);
});

test("a font Chrome names is asked about through fontconfig by its PostScript name, else by its family, on Linux alone", () => {
  const asked = [];
  const list = (pattern, format) => {
    asked.push([pattern, format]);
    if (pattern === ":postscriptname=LiberationSans\\-Bold") return "20-7e a0-17f\n";
    if (pattern === ":family=Only Family") return "20-7e\n3040-309f\n";
    return "";
  };
  const ls = fontLetters({ family: "Liberation Sans", postScriptName: "LiberationSans-Bold" }, { platform: "linux", list });
  assert.ok(ls(0x41) && !ls(0x3042));
  assert.deepEqual(asked, [[":postscriptname=LiberationSans\\-Bold", "%{charset}\\n"]]);
  // A family alone, or a PostScript name fontconfig does not know: every
  // file of the family.
  const family = fontLetters({ family: "Only Family", postScriptName: "OnlyFamily-Bold" }, { platform: "linux", list });
  assert.ok(family(0x41) && family(0x3042) && !family(0x65e5));
  assert.equal(fontLetters({ family: "Nowhere", postScriptName: "Nowhere-Bold" }, { platform: "linux", list }), null);
  for (const platform of ["darwin", "win32"]) assert.equal(fontLetters({ family: "Liberation Sans", postScriptName: "LiberationSans-Bold" }, { platform, list }), null, platform);
  // Every font of the machine, for libass.
  const every = machineLetters({ platform: "linux", list: (pattern) => (pattern ? "" : "20-7e\n\n4e00-9fff 3000\n") });
  assert.ok(every(0x41) && every(0x4e00) && every(0x3000) && !every(0x3042));
  assert.equal(machineLetters({ platform: "linux", list: () => "" }), null);
  assert.equal(machineLetters({ platform: "darwin", list: () => "20-7e\n" }), null);
});

test("a letter is a box when no font Chrome names for the captions has it, as it is, composed or decomposed, the marks that draw nothing left out; where a font named cannot be asked about, or none is named, no letter is said to be one", () => {
  // é and the macron and acute marks, but not ḗ made of them.
  const latin = letterSet(["20-7e a0-17f 300-36f"]);
  const emoji = letterSet(["23 2a 30-39 20e3 1f300-1f64f 1f3fb-1f3ff"]);
  const lookUp = (font) => ({ "LiberationSans-Bold": latin, NotoColorEmoji: emoji })[font.postScriptName] || null;
  const fonts = [{ family: "Liberation Sans", postScriptName: "LiberationSans-Bold", custom: false, glyphs: 30 }, { family: "Noto Color Emoji", postScriptName: "NotoColorEmoji", custom: false, glyphs: 4 }];
  const letters = ["H", "é", "é", "ḗ", "👍🏽", "1️⃣", "👩‍💻", "今", "\u{10fffd}", "ᚠ", " "];
  assert.deepEqual(chromeBoxes(letters, fonts, { lookUp }), ["今", "\u{10fffd}", "ᚠ"]);
  assert.ok(hasLetter((c) => latin(c.codePointAt(0)), "ḗ"));
  assert.ok(!hasLetter((c) => latin(c.codePointAt(0)), "今"));
  // A no-break hyphen comes from the plain hyphen of a font that has only
  // that, as Liberation Sans is from 2.1, and U+FFFC draws nothing; a font
  // with neither hyphen shows a box.
  const hyphen = letterSet(["20-7e 2010"]);
  const onlyHyphen = [{ family: "Liberation Sans", postScriptName: "Hyphen-Bold", custom: false, glyphs: 3 }];
  assert.deepEqual(chromeBoxes(["a", "\u2011", "\u2010", "\ufffc"], onlyHyphen, { lookUp: () => hyphen }), []);
  assert.deepEqual(chromeBoxes(["a", "\u2011", "\u2010", "\ufffc"], onlyHyphen, { lookUp: () => letterSet(["20-7e"]) }), ["\u2011", "\u2010"]);
  // A font named that drew nothing is not asked about.
  assert.deepEqual(chromeBoxes(["今"], [...fonts, { family: "Unknown", postScriptName: "Unknown-Bold", custom: false, glyphs: 0 }], { lookUp }), ["今"]);
  // Nothing can say: a font fontconfig does not know, a font of fonts.css with no files to ask, or no font named.
  assert.deepEqual(chromeBoxes(["今"], [...fonts, { family: "Unknown", postScriptName: "Unknown-Bold", custom: false, glyphs: 2 }], { lookUp }), []);
  assert.deepEqual(chromeBoxes(["今"], [{ family: "Inter", postScriptName: "Inter-Regular", custom: true, glyphs: 5 }], { lookUp }), []);
  assert.deepEqual(chromeBoxes(["今"], [], { lookUp }), []);
  // A font of fonts.css is asked through its files.
  const kit = (c) => c === "今";
  assert.deepEqual(chromeBoxes(["今", "H", "日"], [{ family: "Kit Sans", postScriptName: "KitSans-Bold", custom: true, glyphs: 3 }], { kit, lookUp }), ["H", "日"]);
});

test("the files of a fonts.css family say which letters they have at the weight the captions take, and a letter a file that was not read could hold is taken to be there", () => {
  const inter = path.join(FIXTURES, "inter-latin-400.woff2");
  const face = (file, more = {}) => ({ family: "Inter", file, name: path.basename(file), weight: [400, 400], italic: false, unicodeRange: "", ...more });
  const kit = kitLetters({ faces: [face(inter)], weight: 400 });
  assert.ok(kit("A") && kit("é"));
  assert.ok(!kit("今") && !kit("\u{10fffd}"));
  // A file that is no font this kit reads cannot say which letters it lacks.
  const odd = path.join(dir, "boxes-not-a-font.woff2");
  fs.writeFileSync(odd, "not a font");
  assert.ok(kitLetters({ faces: [face(odd)], weight: 400 })("今"));
  // A face whose range leaves a letter out does not hold it; a file not read whose range holds it may.
  const ranged = kitLetters({ faces: [face(inter, { unicodeRange: "U+0000-00FF" }), face(odd, { unicodeRange: "U+0100-017F" })], weight: 400 });
  assert.ok(ranged("A") && ranged("Ā") && !ranged("今"));
  assert.equal(kitLetters({ faces: [], weight: 700 }), null);
});

test("each letter of the captions that is a box is counted with the number of its caption", () => {
  const cues = [{ n: 1, lines: ["今日は", "Hi 今"] }, { n: 2, lines: ["Hello"] }, { n: 3, lines: ["日"] }];
  assert.deepEqual(boxesIn(cues, ["今", "日"]), [{ letter: "今", cue: 1 }, { letter: "日", cue: 1 }, { letter: "今", cue: 1 }, { letter: "日", cue: 3 }]);
  assert.deepEqual(boxesIn(cues, []), []);
});

test("on this machine, fontconfig's letters of a font and of every font are what fc-list and fc-match say", { skip: !hasFontconfig && "needs fontconfig" }, () => {
  const sans = spawnSync("fc-match", ["-f", "%{family[0]}\t%{postscriptname}", "sans-serif"], { encoding: "utf8" }).stdout.split("\t");
  const has = fontLetters({ family: sans[0], postScriptName: sans[1] });
  assert.ok(has && has(0x41), `${sans.join(" ")} has A`);
  const every = machineLetters();
  assert.ok(every(0x41));
  // A letter of the last private use plane, which no font has.
  assert.ok(!every(0x10fffd) && !has(0x10fffd));
});
