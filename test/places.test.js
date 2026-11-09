"use strict";

// Where the captions go: each place's margins mapped onto the video, the
// union of several places, a video of another shape fitted into a phone's
// screen, and the look read from a font kit and a brand kit.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { PLACES, PLACE_NAMES, zone, captionLayout, defaultPlaces, shapeOf, charsThatFit, inkOf } = require("../skills/easycaptionkit/scripts/lib/places");
const { uiRects } = require("../skills/easycaptionkit/scripts/lib/draw");
const { chooseLook, contrast, highlightMode, brandHighlight, parseColor, readBrand } = require("../skills/easycaptionkit/scripts/lib/look");
const { fontKit, brandKit, write, dir } = require("./helpers");

test("every place says where its numbers come from and when they were read", () => {
  assert.deepEqual(PLACE_NAMES, ["tiktok", "reels", "shorts", "youtube", "x", "linkedin", "square"]);
  for (const key of PLACE_NAMES) {
    const entries = PLACES[key].screen ? [PLACES[key]] : Object.values(PLACES[key].shapes).filter((v) => typeof v !== "string");
    for (const entry of entries) {
      assert.ok(entry.source && /^https:\/\//.test(entry.url), `${key} has a source and a link`);
      assert.match(entry.read, /^\d{4}-\d{2}-\d{2}$/);
      for (const side of ["top", "bottom", "left", "right"]) assert.ok(entry.margins[side] >= 0);
    }
  }
});

test("shapes, and the places a video goes to when none are given", () => {
  assert.equal(shapeOf(1080, 1920), "vertical");
  assert.equal(shapeOf(1080, 1350), "square");
  assert.equal(shapeOf(1080, 1080), "square");
  assert.equal(shapeOf(1920, 1080), "landscape");
  assert.deepEqual(defaultPlaces(1080, 1920), ["tiktok", "reels", "shorts"]);
  assert.deepEqual(defaultPlaces(1080, 1080), ["square"]);
  assert.deepEqual(defaultPlaces(1920, 1080), ["youtube", "x", "linkedin"]);
});

test("a 1080x1920 video on TikTok takes TikTok's margins as they are", () => {
  const z = zone("tiktok", 1080, 1920);
  assert.deepEqual(z.margins, { top: 240, bottom: 660, left: 120, right: 120 });
  assert.deepEqual(z.column, { from: 840, width: 180 });
  // A 720x1280 video is the same screen at two thirds the pixels.
  const small = zone("tiktok", 720, 1280);
  assert.equal(Math.round(small.margins.bottom), 440);
  assert.equal(Math.round(small.textBase), 720);
});

test("a 16:9 video on TikTok sits in the middle of the screen: the top bar falls outside it, the bottom one just reaches it, the sides do not move", () => {
  const z = zone("tiktok", 1920, 1080);
  assert.equal(z.margins.top, 0);
  // The screen's bottom margin ends 3.75 screen pixels into the video.
  assert.ok(Math.abs(z.margins.bottom - 3.75 / 0.5625) < 0.01, `bottom ${z.margins.bottom}`);
  assert.ok(Math.abs(z.margins.left - 120 * (1920 / 1080)) < 0.01);
  // Letters are sized for the phone the video plays on, so bigger than on a 16:9 frame.
  const phone = captionLayout(1920, 1080, ["tiktok"], { style: "line", size: 6.5, lines: 2 });
  const tv = captionLayout(1920, 1080, ["youtube"], { style: "line", size: 6.5, lines: 2 });
  assert.ok(phone.fontPx > tv.fontPx * 1.5, `${phone.fontPx} on a phone, ${tv.fontPx} on YouTube`);
});

test("the buttons drawn for each place stay out of the space it leaves free", () => {
  for (const key of PLACE_NAMES) {
    const entries = PLACES[key].screen ? [{ ...PLACES[key], frame: PLACES[key].screen }] : Object.values(PLACES[key].shapes).filter((v) => typeof v !== "string");
    for (const e of entries) {
      const { width: W, height: H } = e.frame;
      const m = e.margins;
      const safe = { x0: m.left, y0: m.top, x1: W - m.right, y1: H - m.bottom };
      for (const r of uiRects(e.ui, W, H)) {
        const x0 = Math.max(r.x, safe.x0);
        const y0 = Math.max(r.y, safe.y0);
        const x1 = Math.min(r.x + r.w, safe.x1);
        const y1 = Math.min(r.y + r.h, safe.y1);
        if (x1 <= x0 || y1 <= y0) continue;
        // Inside the safe space only where the button column takes it.
        const inColumn = e.column && x0 >= W - e.column.width && y0 >= e.column.from;
        assert.ok(inColumn, `${key} (${e.ui}): a button at ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)} is in the safe space`);
      }
    }
  }
});

test("several places at once: the captions keep out of every one's margins, the button columns of TikTok and Reels included", () => {
  const all = captionLayout(1080, 1920, ["tiktok", "reels", "shorts"], { style: "karaoke", size: 6.5, position: "bottom", lines: 2 });
  assert.deepEqual(all.safe, { top: 288, bottom: 672, left: 120, right: 192 });
  assert.equal(all.blockBottom, 1920 - 672);
  assert.equal(all.side, 227, "Reels' button column is the widest");
  assert.equal(all.textWidth, 1080 - 2 * 227);
  const reels = captionLayout(1080, 1920, ["reels"], { style: "line", size: 6.5, position: "bottom", lines: 2 });
  assert.equal(reels.side, 227, "the like button sits in the bottom line's way");
  assert.equal(captionLayout(1080, 1920, ["reels"], { style: "line", size: 6.5, position: "top", lines: 2 }).side, 65);
  const tiktok = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, position: "bottom", lines: 2 });
  assert.equal(tiktok.side, 180, "the button column narrows the line at the bottom");
  const top = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, position: "top", lines: 2 });
  assert.equal(top.blockTop, 240);
  assert.equal(top.side, 120, "the column starts lower than captions at the top reach");
  // The middle is the safe space's, not the picture's: on a phone the safe space sits high.
  const middleOf = (w, h, places, style = "karaoke") => {
    const l = captionLayout(w, h, places, { style, size: style === "word" ? 9.5 : 6.5, position: "middle", lines: 2 });
    return (l.blockTop + l.blockBottom) / 2;
  };
  assert.equal(middleOf(1080, 1920, ["reels"], "word"), (269 + 1920 - 672) / 2);
  assert.equal(middleOf(1080, 1920, ["tiktok"]), 750);
  assert.equal(middleOf(1920, 1080, ["youtube"]), (166 + 1080 - 143) / 2);
  assert.equal(middleOf(1080, 1920, ["tiktok", "reels", "shorts"]), (288 + 1920 - 672) / 2);
  assert.equal(charsThatFit(696, 70), 16);
});

test("no line is wider than the safe space: big letters are made smaller, and the outline and shadow fit in it too", () => {
  for (const [style, size, box] of [["line", 17, false], ["word", 20, false], ["karaoke", 6.5, false], ["line", 20, true]]) {
    const p = captionLayout(1080, 1920, ["tiktok", "reels", "shorts"], { style, size, position: "bottom", lines: 2, box });
    const ink = inkOf(p.fontPx, { style, box });
    assert.equal(p.textWidth, 1080 - 2 * p.side);
    assert.ok(p.fontPx * 4 + 2 * ink.reach <= p.textWidth, `${style} ${size}: ${p.fontPx} px letters in ${p.textWidth} px`);
    assert.equal(p.glyphWidth, p.textWidth - 2 * ink.reach);
    if (size >= 17) assert.ok(p.notes.some((n) => new RegExp(`At ${size}% the letters would be ${p.askedPx} px.*so they are ${p.fontPx} px`).test(n)), p.notes.join(" | "));
    else assert.equal(p.fontPx, p.askedPx);
  }
  // The outline reaches past the letters by its stroke and the shadow's blur; a box by its padding.
  assert.deepEqual(inkOf(100, { style: "karaoke" }), { stroke: 9, shadow: { y: 5, blur: 12 }, reach: 21 });
  assert.equal(inkOf(100, { box: true }).reach, 30);
});

test("characters a line can take: what fits, from 8 to 42, and 8 where nothing does", () => {
  assert.equal(charsThatFit(1000, 50), 33);
  assert.equal(charsThatFit(10000, 20), 42);
  assert.equal(charsThatFit(10, 50), 8);
  for (const [width, px] of [[0, 0], [100, 0], [NaN, 10], [Infinity, 0]]) assert.equal(charsThatFit(width, px), 8, `${width} px at ${px}`);
});

test("a place with no figures for the video's shape says which it used", () => {
  const z = captionLayout(1080, 1920, ["square"], { style: "line", size: 6.5, lines: 2 });
  assert.ok(z.notes.some((n) => /no figures for a vertical video/.test(n)));
});

test("colors: contrast, the brand color that lights a word, and when a dark one goes on a patch", () => {
  assert.equal(parseColor("#FC0"), "#ffcc00");
  assert.equal(parseColor("1a6b45"), "#1a6b45");
  assert.equal(parseColor("red"), null);
  assert.equal(Math.round(contrast("#ffffff", "#000000")), 21);
  assert.equal(highlightMode("#ffd23f").mode, "text");
  assert.deepEqual(highlightMode("#1a6b45"), { mode: "patch", ink: "#ffffff" });
  const picked = brandHighlight([{ hex: "#131312", role: "heading" }, { hex: "#f6f5f1", role: "surface" }, { hex: "#1a6b45", role: "logo" }, { hex: "#ff5a1f", role: "button" }]);
  assert.equal(picked.hex, "#ff5a1f", "a button's color comes before the logo's");
  assert.equal(brandHighlight([{ hex: "#111111", role: "button" }, { hex: "#fafafa", role: "surface" }]), null);
});

test("the look from easyfontkit's fonts.css and fonts.json and an easybrandkit folder", () => {
  const fonts = fontKit("font-kit-open");
  const brand = brandKit("brand-kit", [{ hex: "#1a6b45", role: "logo" }, { hex: "#f6f5f1", role: "surface" }]);
  const look = chooseLook({ fonts: path.join(fonts, "fonts.css"), brand });
  assert.equal(look.family, "Inter");
  assert.equal(look.from, "fonts.css");
  assert.equal(look.weight, 400, "Inter's only file is 400, so no fake bold");
  assert.ok(look.notes.some((n) => /no bold file/.test(n)));
  assert.match(look.faces[0].url, /^file:\/\/.*inter-latin-400\.woff2$/);
  assert.equal(look.license.status, "open");
  assert.equal(look.highlight, "#1a6b45");
  assert.equal(look.highlightMode, "patch");
  // The folder itself works as well as its fonts.css.
  assert.equal(chooseLook({ fonts }).family, "Inter");
  const paid = chooseLook({ fonts: fontKit("font-kit-paid", { family: "Brandface", status: "commercial" }) });
  assert.equal(paid.family, "Brandface");
  assert.equal(paid.license.status, "commercial");
  assert.equal(paid.license.free.family, "Inter");
  const given = chooseLook({ brand, highlight: "#00ff00", font: "DejaVu Sans" });
  assert.equal(given.highlight, "#00ff00");
  assert.equal(given.highlightMode, "text");
  assert.equal(given.from, "machine");
});

test("a brand kit's _brand.yml alone, and folders that are not kits", () => {
  const folder = path.join(dir, "yml-only");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "_brand.yml"), "meta:\n  name: Acme\ncolor:\n  palette:\n    button: \"#e4572e\"\n    heading: \"#111111\"\n  foreground: \"#111111\"\n  background: \"#ffffff\"\ntypography:\n  base: Inter\n  headings: Sora\n");
  const brand = readBrand(folder);
  assert.equal(brand.name, "Acme");
  assert.deepEqual(brand.fonts, { heading: "Sora", body: "Inter" });
  assert.equal(brandHighlight(brand.colors).hex, "#e4572e");
  // A font kit is no brand kit, and a brand kit no font kit.
  assert.throws(() => readBrand(fontKit("yml-font-kit")), /no brand\.json or _brand\.yml/);
  assert.throws(() => chooseLook({ fonts: brandKit("yml-brand-kit", [{ hex: "#e4572e", role: "button" }]) }), /no fonts\.css/);
  const broken = chooseLook({ fonts: write("broken.css", "@font-face { font-family: X; src: url(files/none.woff2); }") });
  assert.equal(broken.family, "");
  assert.ok(broken.notes.some((n) => /not on this disk/.test(n)), broken.notes.join(" | "));
  // A brand.json that holds no object is no brand kit, and says so.
  for (const [name, text] of [["null", "null"], ["text", '"just a string"'], ["list", "[1, 2]"], ["number", "7"]]) {
    const file = write(`brand-${name}/brand.json`, text);
    assert.throws(() => readBrand(path.dirname(file)), new RegExp(`^Error: Cannot read ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: it holds no brand kit$`), name);
  }
  // Font names that are not text are no names.
  assert.deepEqual(readBrand(write("brand-odd-fonts/brand.json", { colors: [null, { hex: "#e4572e", role: "button" }], fonts: { heading: { name: "Sora" }, body: "Inter" } })).fonts, { heading: "", body: "Inter" });
});

test("a fonts.json whose list of families holds something other than a family passes over it", () => {
  const kit = fontKit("font-kit-null", { family: "Lib Sans" });
  const json = JSON.parse(fs.readFileSync(path.join(kit, "fonts.json"), "utf8"));
  json.families = [null, 7, "Lib Sans", ...json.families];
  fs.writeFileSync(path.join(kit, "fonts.json"), JSON.stringify(json));
  const look = chooseLook({ fonts: kit });
  assert.equal(look.family, "Lib Sans");
  assert.equal(look.license.status, "open");
  fs.writeFileSync(path.join(kit, "fonts.json"), JSON.stringify({ families: { name: "Lib Sans" } }));
  assert.equal(chooseLook({ fonts: kit }).license, null);
});

test("font names and ranges from other tools cannot end the page's style or a line of captions.ass", () => {
  const { FIXTURES } = require("./helpers");
  const { pageHtml } = require("../skills/easycaptionkit/scripts/lib/render");
  const { ass } = require("../skills/easycaptionkit/scripts/lib/subtitles");
  const { parse } = require("../skills/easycaptionkit/scripts/easycaptionkit");
  const kit = path.join(dir, "hostile-fonts");
  fs.mkdirSync(path.join(kit, "files"), { recursive: true });
  for (const name of ["inter.woff2", "inter 100%.woff2"]) fs.copyFileSync(path.join(FIXTURES, "inter-latin-400.woff2"), path.join(kit, "files", name));
  fs.writeFileSync(
    path.join(kit, "fonts.css"),
    [
      '@font-face { font-family: "Brand</style><script>alert(1)</script>"; src: url("files/inter.woff2"); font-weight: 400; }',
      '@font-face { font-family: "Inter"; src: url("files/inter 100%.woff2"); font-weight: 400; unicode-range: U+0-FF</style>; }',
      '@font-face { font-family: "Inter"; src: url("files/inter.woff2"); font-weight: 700; unicode-range: U+0000-00FF, U+0131, U+02??; }',
      ':root { --font-heading: "Brand</style><script>alert(1)</script>", sans-serif; --font-body: "Inter", sans-serif; }',
    ].join("\n"),
  );
  const look = chooseLook({ fonts: kit });
  assert.equal(look.family, "Inter", "the family with a < in its name is left out");
  assert.ok(look.notes.some((n) => /a family with characters a font name cannot have/.test(n)), look.notes.join(" | "));
  assert.deepEqual(look.faces.map((f) => f.unicodeRange), ["", "U+0000-00FF, U+0131, U+02??"], "a range that is not U+ ranges is dropped");
  assert.ok(look.faces[0].file.endsWith("inter 100%.woff2"), "a % that is no escape is read as it is");
  const brand = path.join(dir, "hostile-brand");
  fs.mkdirSync(brand, { recursive: true });
  fs.writeFileSync(path.join(brand, "brand.json"), JSON.stringify({ name: "X", colors: [], fonts: { heading: "Head</style>x", body: "Body\nfont" } }));
  const fromBrand = chooseLook({ brand });
  assert.equal(fromBrand.family, "");
  assert.equal(fromBrand.notes.filter((n) => /names a (heading|body) font with characters a font name cannot have/.test(n)).length, 2);
  // Whatever reaches the page, the style element ends once.
  const place = captionLayout(1080, 1920, ["tiktok"], { style: "karaoke", size: 6.5, lines: 2 });
  const odd = { ...look, family: "X</style>", stack: '"X</style><b>", sans-serif', faces: [{ family: "Y</style>", url: "file:///a.woff2", weight: [400, 400], italic: false, unicodeRange: "U+0-FF</style>" }] };
  assert.equal(pageHtml(odd, place, "karaoke", { cues: [] }).split("</style>").length - 1, 1);
  // A line break in a family name stays on captions.ass's Style line.
  const text = ass([], [], { states: [], style: "line", look: { ...look, family: "Inter\nDialogue: 0,0:00:00.00,0:00:05.00,Caption,,0,0,0,,EXTRA", tool: "test" }, place });
  assert.equal(text.split("\n").filter((line) => line.startsWith("Dialogue:")).length, 0);
  assert.equal(text.split("\n").filter((line) => line.startsWith("Style:")).length, 1);
  assert.throws(() => parse(["a.mp4", "--words", "w.json", "--font", "Inter\nDialogue: x"]), /--font takes a font family name/);
  assert.throws(() => chooseLook({ font: "Bad<font" }), /--font takes a font family name/);
});

test("each place once: YouTube on a vertical video is YouTube Shorts, so naming both gives one", () => {
  const all = captionLayout(1080, 1920, ["tiktok", "reels", "shorts", "youtube", "x", "linkedin", "square"], { style: "line", size: 6.5, lines: 2 });
  const names = all.zones.map((z) => z.name);
  assert.equal(names.filter((n) => n === "YouTube Shorts").length, 1, names.join(", "));
  assert.equal(new Set(all.zones.map((z) => z.key)).size, all.zones.length);
});

test("fonts.css: a url() out of its folder, to a whole path, or through a link is left out unread, and the files are named from that folder", () => {
  const { FIXTURES } = require("./helpers");
  const root = path.join(dir, "contained");
  const kit = path.join(root, "job", "kit");
  fs.mkdirSync(path.join(kit, "files"), { recursive: true });
  fs.mkdirSync(path.join(root, "otherjob", "files"), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "inter-latin-400.woff2"), path.join(root, "otherjob", "files", "private.woff2"));
  fs.copyFileSync(path.join(FIXTURES, "inter-latin-400.woff2"), path.join(kit, "files", "own.woff2"));
  fs.symlinkSync(path.join(root, "otherjob", "files", "private.woff2"), path.join(kit, "files", "link.woff2"));
  fs.symlinkSync(path.join(root, "otherjob", "files"), path.join(kit, "linked"));
  fs.writeFileSync(
    path.join(kit, "fonts.css"),
    [
      '@font-face { font-family: "Brand"; src: url("../../otherjob/files/private.woff2"); font-weight: 700; }',
      `@font-face { font-family: "Brand"; src: url("${path.join(root, "otherjob", "files", "private.woff2")}"); font-weight: 600; }`,
      `@font-face { font-family: "Brand"; src: url("file://${path.join(root, "otherjob", "files", "private.woff2")}"); font-weight: 500; }`,
      '@font-face { font-family: "Brand"; src: url("files/link.woff2"); font-weight: 400; }',
      '@font-face { font-family: "Brand"; src: url("linked/private.woff2"); font-weight: 300; }',
      '@font-face { font-family: "Brand"; src: url("../../otherjob/files/none.woff2"); font-weight: 200; }',
      '@font-face { font-family: "Own"; src: url("files/own.woff2"); font-weight: 400; }',
      ':root { --font-heading: "Brand", sans-serif; --font-body: "Own", sans-serif; }',
    ].join("\n"),
  );
  const look = chooseLook({ fonts: kit });
  assert.equal(look.family, "Own", "no face of Brand was read");
  assert.deepEqual(look.faces.map((f) => f.name), ["files/own.woff2"]);
  assert.ok(look.faces.every((f) => f.file.startsWith(kit)));
  const note = look.notes.find((n) => /outside its own folder or through a link/.test(n));
  assert.ok(note, look.notes.join(" | "));
  assert.match(note, /fonts\.css names 6 font files/, "a file that is there and one that is not are told apart by nothing");
  assert.ok(!look.notes.some((n) => /not on this disk/.test(n)), look.notes.join(" | "));
});

test("a fonts.css or _brand.yml of long runs is read in moments: no pattern scans a run again from each of its letters", () => {
  const { readFontsCss } = require("../skills/easycaptionkit/scripts/lib/look");
  const quick = (what, fn) => {
    const start = Date.now();
    try {
      fn();
    } catch {
      // Refused.
    }
    const took = Date.now() - start;
    assert.ok(took < 1500, `${what} took ${took} ms`);
  };
  const css = (name, text) => {
    const folder = path.join(dir, name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "fonts.css"), text);
    return folder;
  };
  quick("@font-face blocks that never close", () => readFontsCss(css("runs-faces", "@font-face{".repeat(30_000))));
  quick("a role with no end", () => readFontsCss(css("runs-role", `:root { --font-heading:${" ".repeat(80_000)}x`)));
  quick("a url() with no end", () => readFontsCss(css("runs-url", `@font-face { font-family: "A"; src: url(${" ".repeat(60_000)}x; }`)));
  quick("a long line of _brand.yml", () => readBrand(write("runs/_brand.yml", `meta:\n  name: x${" ".repeat(80_000)}y\n`)));
  quick("comments that never close", () => readFontsCss(css("runs-comments", "/* ".repeat(160_000))));
  // What such files hold is still read as before.
  const kit = readFontsCss(css("runs-plain", `@font-face {\n  font-family: "Plain";\n  src: url( "files/plain.woff2" ) format("woff2"), url('files/plain.woff');\n  font-weight: 700;\n}\n:root {\n  --font-heading: "Plain", sans-serif;\n  --font-body:Plain;\n}\n`));
  assert.deepEqual([kit.roles, kit.missing], [{ heading: "Plain", body: "Plain" }, ["files/plain.woff2"]]);
  // A comment goes to its first */, and one that never closes to the end.
  const face = (family) => `@font-face { font-family: "${family}"; src: url("files/${family}.woff2"); }`;
  const commented = readFontsCss(css("runs-commented", `/* a */ ${face("One")} /* b /* c */ ${face("Two")} /* never closed ${face("Three")}`));
  assert.deepEqual(commented.missing, ["files/One.woff2", "files/Two.woff2"]);
  const brand = readBrand(write("runs-plain/_brand.yml", "meta:\n  name:   Acme  \ncolor:\n  palette:\n    green: \"#1a7f37\"\n  primary: green\ntypography:\n  headings: Geist\n  base:\n    family: Inter\n"));
  assert.equal(brand.name, "Acme");
  assert.deepEqual(brand.colors, [{ hex: "#1a7f37", role: "green" }]);
  assert.equal(brand.fonts.heading, "Geist");
});

test("CJK captions take the CJK families of their language, before Noto Sans, so Chrome draws their bold, and the page says the language", () => {
  const { cjkLanguage } = require("../skills/easycaptionkit/scripts/lib/text");
  assert.deepEqual([["今日は", "新しい"], ["오늘은"], ["今天", "我们", "说"], ["這個", "我們", "說"], ["Hello", "world"], ["中文"], ["東京"]].map(cjkLanguage), ["ja", "ko", "zh-Hans", "zh-Hant", "", "zh-Hans", "zh-Hant"]);
  const stack = (lang) => chooseLook({ lang }).stack.split(", ");
  const ja = stack("ja");
  assert.ok(ja.indexOf('"Noto Sans CJK JP"') > ja.indexOf('"Noto Color Emoji"') && ja.indexOf('"Noto Sans CJK JP"') < ja.indexOf('"Noto Sans"'), ja.join(", "));
  for (const family of ['"Hiragino Sans"', '"Yu Gothic"']) assert.ok(ja.includes(family), family);
  assert.ok(stack("ko").includes('"Noto Sans CJK KR"') && stack("zh-Hans").includes('"Noto Sans CJK SC"') && stack("zh-Hant").includes('"Noto Sans CJK TC"'));
  assert.ok(!stack("").some((f) => /CJK/.test(f)));
  assert.equal(chooseLook({ lang: "ja" }).lang, "ja");
});

test("Arabic, Persian and Urdu captions take the Arabic families, so Chrome draws their bold, and an Arabic letter the font lacks is looked for in them first, in that order", () => {
  const { arabicIn } = require("../skills/easycaptionkit/scripts/lib/text");
  const { fallbackFont } = require("../skills/easycaptionkit/scripts/lib/look");
  assert.deepEqual([["مرحبا"], ["سلام", "دوستان"], ["ہیلو"], ["Hello", "world"], ["今日は"], ["٣"]].map(arabicIn), [true, true, true, false, false, true]);
  const stack = (options) => chooseLook(options).stack.split(", ");
  const ar = stack({ arabic: true });
  assert.ok(ar.indexOf('"Noto Sans Arabic"') > ar.indexOf('"Noto Color Emoji"') && ar.indexOf('"Noto Sans Arabic"') < ar.indexOf('"Noto Naskh Arabic"') && ar.indexOf('"Noto Naskh Arabic"') < ar.indexOf('"DejaVu Sans"'), ar.join(", "));
  assert.ok(!stack({}).some((f) => /Arabic/.test(f)));
  assert.deepEqual(chooseLook({ arabic: true, font: "Inter" }).listed.slice(0, 2), ["Inter", "Helvetica Neue"]);
  // fontconfig weighs letters before names: asked for Noto Sans Arabic, it
  // gives it when it has the letter, else a font that has it. Ubuntu 22.04
  // gives Noto Kufi Arabic for sans-serif with an Arabic letter.
  const asked = [];
  const font = (family, outline = true) => ({ family, style: "Bold", file: `/f/${family.replace(/ /g, "")}-Bold.ttf`, index: 0, outline });
  const machine = (installed) => (pattern) => {
    asked.push(pattern);
    const name = pattern.split(":")[0];
    if (/charset=(?:1f680)/.test(pattern)) return font("Noto Color Emoji", false);
    if (/charset=65e5/.test(pattern)) return font("Noto Sans CJK JP");
    return installed.includes(name) ? font(name) : font("Noto Kufi Arabic");
  };
  const linux = (installed) => ({ platform: "linux", match: machine(installed) });
  assert.equal(fallbackFont(0x645, 700, "", linux(["Noto Sans Arabic", "Noto Naskh Arabic", "Noto Kufi Arabic"])).family, "Noto Sans Arabic");
  assert.deepEqual(asked, ["Noto Sans Arabic:charset=645:weight=200"]);
  assert.equal(fallbackFont(0x633, 700, "", linux(["Noto Naskh Arabic", "DejaVu Sans"])).family, "Noto Naskh Arabic");
  assert.equal(fallbackFont(0x6c1, 400, "", linux(["DejaVu Sans"])).family, "DejaVu Sans");
  // With none of them, fontconfig's own answer.
  asked.length = 0;
  assert.equal(fallbackFont(0x645, 700, "", linux([])).family, "Noto Kufi Arabic");
  assert.equal(asked[asked.length - 1], "sans-serif:charset=645:weight=200");
  // A letter of another script asks fontconfig once, in the words' language.
  asked.length = 0;
  assert.equal(fallbackFont(0x65e5, 700, "ja", linux([])).family, "Noto Sans CJK JP");
  assert.deepEqual(asked, ["sans-serif:charset=65e5:weight=200:lang=ja"]);
  // A font of pictures only is given as one libass cannot draw.
  assert.equal(fallbackFont(0x1f680, 700, "", linux([])).outline, false);
  assert.equal(fallbackFont(0x645, 700, "", { platform: "darwin", match: machine(["Noto Sans Arabic"]) }), null);
});

test("the emoji fonts come before the fonts that draw some emoji in black and white", () => {
  const look = chooseLook({});
  const stack = look.stack.split(", ");
  const emoji = stack.indexOf('"Noto Color Emoji"');
  assert.ok(emoji > stack.indexOf('"Liberation Sans"'));
  for (const mono of ['"Noto Sans"', '"DejaVu Sans"', "sans-serif"]) assert.ok(emoji < stack.indexOf(mono), `${mono} comes after the emoji fonts in ${look.stack}`);
  assert.ok(stack.indexOf('"Apple Color Emoji"') < stack.indexOf('"Noto Sans"') && stack.indexOf('"Segoe UI Emoji"') < stack.indexOf('"Noto Sans"'));
});
