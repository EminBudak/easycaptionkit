"use strict";

// Reading the files other tools wrote: never more than such a file can
// hold, whatever the file is (a pipe or a device says it holds nothing and
// can go on forever), in UTF-8 or UTF-16, and saying where a JSON file
// stops being JSON.

const fs = require("node:fs");

// The order of the bytes of a text in UTF-16 with no byte order mark. UTF-8
// text has no NUL, and in UTF-16 each digit, space and Latin letter (an
// SRT's times, a JSON's keys) has one in its high byte, so NULs on one
// side of the pairs of bytes and next to none on the other tell UTF-16.
// "le", "be", or "" for any other text.
function utf16Order(buf) {
  const n = Math.min(buf.length, 512) & ~1;
  if (n < 4) return "";
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (buf[i] === 0) even++;
    if (buf[i + 1] === 0) odd++;
  }
  const many = (n / 2) * 0.3;
  if (odd >= many && even <= odd / 8) return "le";
  if (even >= many && odd <= even / 8) return "be";
  return "";
}

// A file's bytes as text: UTF-16 when it starts with UTF-16's byte order
// mark, as Notepad's Unicode and some Windows subtitle tools save it, or
// reads as UTF-16 without one; else UTF-8. The mark is kept, as UTF-8's
// is, for the reader to take off.
function decodeText(buf) {
  const swapped = () => Buffer.from(buf.subarray(0, buf.length - (buf.length % 2))).swap16();
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) return swapped().toString("utf16le");
  const order = utf16Order(buf);
  if (order === "le") return buf.toString("utf16le");
  if (order === "be") return swapped().toString("utf16le");
  return buf.toString("utf8");
}

// The file as text, or an error with code EFBIG and the size, when known,
// once it holds more than `most` bytes.
function readAtMost(file, most) {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) throw Object.assign(new Error(`${file} is a folder`), { code: "EISDIR" });
    const big = (size) => Object.assign(new Error(`${file} holds more than ${most} bytes`), { code: "EFBIG", size });
    if (stat.isFile() && stat.size > most) throw big(stat.size);
    const chunks = [];
    const chunk = Buffer.allocUnsafe(1 << 16);
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      total += n;
      if (total > most) throw big(stat.isFile() ? stat.size : null);
      chunks.push(Buffer.from(chunk.subarray(0, n)));
    }
    return decodeText(Buffer.concat(chunks));
  } finally {
    fs.closeSync(fd);
  }
}

// The same, read without holding up the process, for a pipe or a device:
// one that nothing writes to yet waits in the background, so a signal
// still stops the run while it waits.
async function readAtMostLater(file, most) {
  const handle = await fs.promises.open(file, "r");
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) throw Object.assign(new Error(`${file} is a folder`), { code: "EISDIR" });
    const big = (size) => Object.assign(new Error(`${file} holds more than ${most} bytes`), { code: "EFBIG", size });
    if (stat.isFile() && stat.size > most) throw big(stat.size);
    const chunks = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(1 << 16);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > most) throw big(stat.isFile() ? stat.size : null);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return decodeText(Buffer.concat(chunks));
  } finally {
    await handle.close();
  }
}

// How many lists and objects a JSON text opens, and how deep they nest,
// found in one pass that steps over its strings and makes nothing of it,
// so that a text of millions of them, or of thousands opened one inside
// another, is told before JSON.parse makes them all, or badAt keeps a
// stack of them: 64 MB of either took gigabytes and half a minute. The
// pass stops once either passes `most` or `deepest`. { opened, deepest,
// over }.
function jsonShape(text, { most = Infinity, deepest = Infinity } = {}) {
  let opened = 0;
  let depth = 0;
  let deep = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // To the quote that ends the string, one no backslash escapes.
      for (i++; i < text.length; i++) {
        const d = text.charCodeAt(i);
        if (d === 0x5c) i++;
        else if (d === 0x22) break;
      }
    } else if (c === 0x7b || c === 0x5b) {
      opened++;
      if (++depth > deep) deep = depth;
      if (opened > most || deep > deepest) return { opened, deepest: deep, over: true };
    } else if ((c === 0x7d || c === 0x5d) && depth > 0) depth--;
  }
  return { opened, deepest: deep, over: false };
}

// Where JSON text stops being JSON: the position of the first character
// a JSON reader cannot take there, or the end of the text when it stops
// short. -1 when it is all JSON. Walked with a stack rather than by
// recursion, so a deep nesting cannot overflow.
function badAt(text) {
  let i = 0;
  const n = text.length;
  const skip = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  // A string from its opening quote; false at the character that breaks it.
  const string = () => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return true;
      }
      if (c < 0x20) return false;
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            i += 2;
            while (i < n && /[0-9a-fA-F]/.test(text[i])) i++;
            return false;
          }
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else {
          i++;
          return false;
        }
      } else i++;
    }
    return false;
  };
  const value = () => {
    const c = text[i];
    if (c === '"') return string();
    for (const word of ["true", "false", "null"]) {
      if (c !== word[0]) continue;
      for (const letter of word) {
        if (text[i] !== letter) return false;
        i++;
      }
      return true;
    }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) return false;
    // A number cut short, like 1. or -, breaks where it stops.
    i += m[0].length;
    return !/^[.eE\d]/.test(text[i] || "");
  };
  const stack = [];
  for (;;) {
    skip();
    if (i >= n) return n;
    if (text[i] === "{" || text[i] === "[") {
      stack.push(text[i]);
      i++;
      skip();
      if (text[i] === (stack[stack.length - 1] === "{" ? "}" : "]")) {
        stack.pop();
        i++;
      } else {
        if (stack[stack.length - 1] === "{") {
          if (text[i] !== '"') return i < n ? i : n;
          if (!string()) return Math.min(i, n);
          skip();
          if (text[i] !== ":") return i < n ? i : n;
          i++;
        }
        continue;
      }
    } else if (!value()) return Math.min(i, n);
    // After a value: a comma and the next one, the end of what holds it, or
    // the end of the text.
    for (;;) {
      skip();
      if (!stack.length) return i < n ? i : -1;
      const open = stack[stack.length - 1];
      if (text[i] === ",") {
        i++;
        if (open === "{") {
          skip();
          if (text[i] !== '"') return i < n ? i : n;
          if (!string()) return Math.min(i, n);
          skip();
          if (text[i] !== ":") return i < n ? i : n;
          i++;
        }
        break;
      }
      if (text[i] === (open === "{" ? "}" : "]")) {
        stack.pop();
        i++;
        continue;
      }
      return i < n ? i : n;
    }
  }
}

// "at line 7, column 17: Expected ',' or '}' after property value", from
// JSON.parse's error and the text it read. Where the error gives no
// position, as for a word typed without quotes, it is found in the text.
// What the error quotes of the text is left out: it can hold a line break
// or any other character the file has.
function jsonProblem(err, text) {
  const message = String((err && err.message) || err);
  const m = /^(.*?(?: after JSON)?)(?: in JSON)? at position (\d+)/.exec(message);
  const at = m ? Number(m[2]) : badAt(text);
  const why = (m ? m[1] : message.replace(/, (?:\.\.\.)?".*$/s, "").replace(/^(Unexpected end of JSON input).*$/s, "$1")).replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (at < 0) return `: ${why}`;
  const before = text.slice(0, at);
  const line = before.split("\n").length;
  const column = Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
  return ` at line ${line}, column ${column}: ${why}`;
}

// The size of a file in words: "65 MB", or "more than 64 MB" for a pipe.
const sizeText = (err, most) => (err.size ? `${Math.round(err.size / 1048576)} MB` : `more than ${Math.round(most / 1048576)} MB`);

module.exports = { readAtMost, readAtMostLater, decodeText, jsonShape, jsonProblem, badAt, sizeText };
