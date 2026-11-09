"use strict";

// Text the way a caption counts it: characters as people see them (a
// letter with its accents, an emoji with its modifiers), East Asian and
// emoji characters two columns wide, and words joined with or without a
// space depending on the script.

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// A printable ASCII character is a character of its own, and the segmenter
// takes some 20 microseconds a word, which is seconds for the words of
// hours, so plain ASCII text is split by its characters.
const ASCII = /^[\x20-\x7e]*$/;

function clusters(text) {
  const string = String(text);
  if (ASCII.test(string)) return string.split("");
  return Array.from(graphemes.segment(string), (part) => part.segment);
}

// Full width letters, CJK, Hangul, kana and pictographs take two columns.
const WIDE = /^(?:[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏ꥠ-꥿가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic})/u;

// Columns a line of text takes.
function width(text) {
  let n = 0;
  for (const c of clusters(text)) n += WIDE.test(c) ? 2 : 1;
  return n;
}

// Characters as a reader counts them for reading speed: every visible
// character and the spaces between words, not line breaks.
function characters(text) {
  return clusters(String(text).replace(/\s*\n\s*/g, " ").trim()).length;
}

// Scripts written without spaces between words.
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}　-〿！-･]/u;
const CLOSING = /^[,.!?;:%)\]}»”’›、。，！？；：…‐-‒–—'’]/u;
const OPENING = /[([{«“‘‹¿¡]$/u;

// Whether a space goes between two words. It depends only on the end of
// the text before and the start of the text after.
function spaced(before, after) {
  if (!before || !after) return false;
  const last = clusters(before.slice(-32)).pop();
  const first = clusters(after.slice(0, 32))[0];
  if (SPACELESS.test(last) || SPACELESS.test(first)) return false;
  if (OPENING.test(before)) return false;
  // "don" + "'t", or a word followed by its own punctuation.
  if (CLOSING.test(after) && !/^['’]\p{L}{3,}/u.test(after)) return false;
  return true;
}

function join(words) {
  let out = "";
  let before = "";
  for (const word of words) {
    out += out && spaced(before, word) ? ` ${word}` : word;
    before = word;
  }
  return out;
}

// A sentence ends with the word: . ! ? … or their CJK forms, before any
// closing quotes or brackets.
const SENTENCE = /[.!?…。！？‼⁇]["'”’»)\]）」』]*$/u;
// A clause ends with it: a comma, a semicolon, a colon or a dash.
const CLAUSE = /[,;:，、；：—–]["'”’»)\]）」』]*$/u;

function endsSentence(word) {
  // "Mr." and "e.g." end no sentence; a number like "3.5" has no end mark.
  return SENTENCE.test(word) && !/^(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|no)\.$/i.test(word);
}

function endsClause(word) {
  return CLAUSE.test(word);
}

// Characters only Traditional Chinese writes, and their Simplified forms.
const TRADITIONAL = /[這個們來時會為國說學對開關從東動發經過還進樣點實麼現間長書車門見話讓頭]/gu;
const SIMPLIFIED = /[这个们来时会为国说学对开关从东动发经过还进样点实么现间长书车门见话让头]/gu;

// The language of CJK words, from their letters: Japanese where there is
// kana, Korean where there is Hangul, else Chinese for Han, Traditional
// where its own characters outnumber the Simplified ones. "ja", "ko",
// "zh-Hans", "zh-Hant", or "" for words with none of them.
function cjkLanguage(texts) {
  const text = texts.join(" ");
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return "ja";
  if (/\p{Script=Hangul}/u.test(text)) return "ko";
  if (!/\p{Script=Han}/u.test(text)) return "";
  return (text.match(TRADITIONAL) || []).length > (text.match(SIMPLIFIED) || []).length ? "zh-Hant" : "zh-Hans";
}

// A letter of the Arabic script, which Arabic, Persian and Urdu are
// written in, with the comma, digits and marks it shares with others.
const ARABIC = /\p{Script_Extensions=Arabic}/u;

// Whether words hold Arabic letters.
const arabicIn = (texts) => texts.some((text) => ARABIC.test(text));

// The scripts of India and Southeast Asia whose families the look names,
// in the order it names them.
const SCRIPTS = ["Devanagari", "Bengali", "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Khmer", "Myanmar"];
const SCRIPT_LETTER = Object.fromEntries(SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, "u")]));

// Which of those scripts words hold letters of.
const scriptsIn = (texts) => SCRIPTS.filter((name) => texts.some((text) => SCRIPT_LETTER[name].test(text)));

// A letter of a script written from right to left: Arabic, Hebrew,
// Syriac, Thaana, NKo and the others Unicode gives that direction.
const RTL = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}\p{Script=Mende_Kikakui}]/u;

module.exports = { clusters, width, characters, spaced, join, endsSentence, endsClause, cjkLanguage, arabicIn, scriptsIn, SPACELESS, ARABIC, RTL };
