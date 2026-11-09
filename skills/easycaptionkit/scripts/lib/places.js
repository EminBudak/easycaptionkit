"use strict";

// Where each app draws its buttons and text over a video, and where the
// captions go so they stay clear of them.
//
// The vertical apps fill a 9:16 phone screen with the video and lay their
// buttons over it: margins there are in pixels of a 1080x1920 screen, and a
// video of another shape is fitted inside that screen. The feeds lay a few
// controls over the video itself: margins there are in pixels of a frame of
// that shape. Only the ad specs of TikTok, Meta and Google publish such
// margins; every other figure is an estimate and says so. Apps change, so
// every entry carries where its numbers come from and when they were read.

const CHECKED = "2026-11-07";

const PLACES = {
  tiktok: {
    name: "TikTok",
    screen: { width: 1080, height: 1920 },
    margins: { top: 240, bottom: 660, left: 120, right: 120 },
    // The like, comment, save and share buttons down the right side.
    column: { from: 840, width: 180 },
    ui: "tiktok",
    source: "TikTok's safe zone file for In-Feed ads, 720x1280 scaled to 1080x1920, as Socialync reads it; the button column's width is Socialync's measurement",
    url: "https://www.socialync.io/tools/safe-zones/tiktok",
    read: "2026-10-11",
  },
  reels: {
    name: "Instagram Reels",
    screen: { width: 1080, height: 1920 },
    margins: { top: 269, bottom: 672, left: 65, right: 65 },
    // The like, comment, share and audio buttons down the right side.
    column: { from: 1152, width: 227 },
    ui: "reels",
    source: "Meta's ad specs for Instagram Reels: 14% at the top, 35% at the bottom and 6% on each side, as Socialync quotes them",
    note: "Meta gives no figure for the buttons on the right; the button column, 227 px wide from 1152 px down, is adkit.so's (adkit.so/tools/safe-zones/instagram, read 2026-11-07).",
    url: "https://www.socialync.io/tools/safe-zones/instagram-reels",
    read: "2026-10-11",
  },
  shorts: {
    name: "YouTube Shorts",
    screen: { width: 1080, height: 1920 },
    margins: { top: 288, bottom: 672, left: 48, right: 192 },
    ui: "shorts",
    source: "Google's Universal Video Ad Safe Zones for YouTube, vertical",
    url: "https://services.google.com/fh/files/misc/universalsafezones-youtube.pdf",
    read: CHECKED,
  },
  youtube: {
    name: "YouTube",
    shapes: {
      landscape: {
        frame: { width: 1920, height: 1080 },
        margins: { top: 166, bottom: 143, left: 152, right: 152 },
        ui: "youtube",
        source: "Google's Universal Video Ad Safe Zones for YouTube, horizontal: its top left corner, its bottom middle and its right side, on both sides",
        note: "Google's layout for ads also keeps the bottom left (856x337) and the bottom right (463x309) clear for ad buttons, which a normal upload does not have.",
        url: "https://services.google.com/fh/files/misc/universalsafezones-youtube.pdf",
        read: CHECKED,
      },
      square: {
        frame: { width: 1080, height: 1080 },
        margins: { top: 105, bottom: 390, left: 48, right: 192 },
        ui: "youtube",
        source: "Google's Universal Video Ad Safe Zones for YouTube, square",
        url: "https://services.google.com/fh/files/misc/universalsafezones-youtube.pdf",
        read: CHECKED,
      },
      vertical: "shorts",
    },
  },
  x: {
    name: "X",
    shapes: {
      landscape: {
        frame: { width: 1080, height: 608 },
        margins: { top: 43, bottom: 73, left: 54, right: 54 },
        ui: "x",
        source: "an estimate for X's feed player, which puts the time at the bottom left and the sound button at the bottom right",
        note: "X publishes no safe zone; adkit.so's spacing for it is 40 px at the top and bottom and 45 px at the sides of 1080x608.",
        url: "https://adkit.so/tools/safe-zones/x",
        read: CHECKED,
      },
      square: {
        frame: { width: 1080, height: 1080 },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        ui: "x-square",
        source: "adkit.so's spacing for square posts on X, its own estimate",
        url: "https://adkit.so/tools/safe-zones/x",
        read: CHECKED,
      },
      vertical: {
        frame: { width: 1080, height: 1920 },
        margins: { top: 80, bottom: 450, left: 80, right: 80 },
        ui: "x-vertical",
        source: "adkit.so's spacing for vertical video on X, its own estimate",
        url: "https://adkit.so/tools/safe-zones/x",
        read: CHECKED,
      },
    },
  },
  linkedin: {
    name: "LinkedIn",
    shapes: {
      landscape: {
        frame: { width: 1080, height: 608 },
        margins: { top: 43, bottom: 73, left: 54, right: 54 },
        ui: "linkedin",
        source: "an estimate for LinkedIn's player, which puts its play bar and buttons along the bottom",
        note: "LinkedIn publishes no safe zone for the feed; adkit.so's spacing for it is 40 px at the top and bottom and 45 px at the sides of 1080x608.",
        url: "https://adkit.so/tools/safe-zones/linkedin",
        read: CHECKED,
      },
      square: {
        frame: { width: 1080, height: 1080 },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        ui: "linkedin-square",
        source: "adkit.so's spacing for square and 4:5 posts on LinkedIn, its own estimate",
        url: "https://adkit.so/tools/safe-zones/linkedin",
        read: CHECKED,
      },
      vertical: {
        frame: { width: 1080, height: 1920 },
        margins: { top: 260, bottom: 560, left: 112, right: 210 },
        ui: "linkedin-vertical",
        source: "LinkedIn's guide for vertical video, as adkit.so reads it",
        url: "https://adkit.so/tools/safe-zones/linkedin",
        read: CHECKED,
      },
    },
  },
  square: {
    name: "a square or 4:5 feed post",
    shapes: {
      square: {
        frame: { width: 1080, height: 1080 },
        margins: { top: 80, bottom: 80, left: 80, right: 80 },
        ui: "square",
        source: "adkit.so's spacing for square posts on X and LinkedIn, its own estimate",
        note: "Instagram and Facebook put their sound button in the bottom right corner of a feed video.",
        url: "https://adkit.so/tools/safe-zones/x",
        read: CHECKED,
      },
    },
  },
};

const PLACE_NAMES = Object.keys(PLACES);

// A video's shape: vertical (9:16, 2:3), square (1:1 up to 4:5) or
// landscape (4:3, 16:9 and wider).
function shapeOf(width, height) {
  const r = width / height;
  if (r < 0.72) return "vertical";
  if (r <= 1.2) return "square";
  return "landscape";
}

// The places a video goes to when none are given: the vertical apps for a
// vertical video, the feeds for the others.
function defaultPlaces(width, height) {
  const shape = shapeOf(width, height);
  if (shape === "vertical") return ["tiktok", "reels", "shorts"];
  if (shape === "square") return ["square"];
  return ["youtube", "x", "linkedin"];
}

// One place's zone for a video of this size: { name, ui, source, url, read,
// shape, margins (in the video's pixels), column, screen and video rect for
// drawing, scale (screen pixels per video pixel) }.
function zone(key, width, height) {
  const place = PLACES[key];
  if (place.screen) {
    // The app's screen with the video fitted inside it.
    const { width: SW, height: SH } = place.screen;
    const s = Math.min(SW / width, SH / height);
    const vw = width * s;
    const vh = height * s;
    const x0 = (SW - vw) / 2;
    const y0 = (SH - vh) / 2;
    const m = place.margins;
    const toVideo = (screenPx) => screenPx / s;
    const margins = {
      top: Math.max(0, toVideo(m.top - y0)),
      bottom: Math.max(0, toVideo(m.bottom - y0)),
      left: Math.max(0, toVideo(m.left - x0)),
      right: Math.max(0, toVideo(m.right - x0)),
    };
    const column = place.column ? { from: toVideo(place.column.from - y0), width: Math.max(0, toVideo(place.column.width - x0)) } : null;
    return {
      key,
      name: place.name,
      ui: place.ui,
      source: place.source,
      note: place.note || "",
      url: place.url,
      read: place.read,
      shape: shapeOf(width, height),
      reference: { ...place.screen, margins: place.margins, column: place.column || null },
      margins,
      column,
      screen: { width: SW, height: SH, video: { x: x0, y: y0, width: vw, height: vh } },
      // A phone's screen is about 1080 px wide however big the video is.
      textBase: 1080 / s,
    };
  }
  const shape = shapeOf(width, height);
  let entry = place.shapes[shape] || place.shapes.square || place.shapes.landscape;
  if (typeof entry === "string") return zone(entry, width, height);
  const { frame, margins: m } = entry;
  const fx = width / frame.width;
  const fy = height / frame.height;
  return {
    key,
    name: place.name,
    ui: entry.ui,
    source: entry.source,
    note: entry.note || "",
    url: entry.url,
    read: entry.read,
    shape,
    reference: { ...frame, margins: m, column: null },
    margins: { top: m.top * fy, bottom: m.bottom * fy, left: m.left * fx, right: m.right * fx },
    column: null,
    screen: null,
    textBase: Math.min(width, height),
    mismatch: !place.shapes[shape] ? `${place.name[0].toUpperCase()}${place.name.slice(1)} has no figures for a ${shape} video, so its ${Object.keys(place.shapes).find((k) => typeof place.shapes[k] !== "string")} ones are used.` : "",
  };
}

// How far the look reaches past the letters, at a letter size: the black
// outline and its soft shadow, or the dark box around each line. The page
// that draws the captions uses the same figures.
function inkOf(fontPx, { style = "karaoke", box = false } = {}) {
  const stroke = Math.max(2, Math.round(fontPx * (style === "word" ? 0.1 : 0.09)));
  const shadow = { y: Math.round(fontPx * 0.05), blur: Math.round(fontPx * 0.12) };
  return { stroke, shadow, reach: box ? Math.ceil(fontPx * 0.3) : stroke + shadow.blur };
}

// Where the captions go in a video of this size for all the places at
// once: inside every place's zone, centered, at the bottom, the middle or
// the top of what is left. Nothing reaches past the safe space at the
// sides, the outline and its shadow included: letters too big for four of
// them to fit across are made smaller. The block is taller than its lines
// by half a letter, so that what reaches above and below them (accents,
// descenders, the outline and its shadow) fits in it: the page that draws
// the captions, and the ASS file, keep all of it inside.
//
// options: { style, size (percent of the short side of the screen the
// video plays on), position, lines, lineHeight, box }
function captionLayout(width, height, keys, { style, size, position = "bottom", lines = 2, lineHeight = 1.18, box = false }) {
  // Each place once: YouTube on a vertical video is YouTube Shorts.
  const zones = [];
  for (const key of keys) {
    const z = zone(key, width, height);
    if (!zones.some((other) => other.key === z.key)) zones.push(z);
  }
  const safe = { top: 0, bottom: 0, left: 0, right: 0 };
  for (const z of zones) for (const side of Object.keys(safe)) safe[side] = Math.max(safe[side], z.margins[side]);
  // Text big enough on the smallest screen it plays on.
  const asked = Math.round(Math.max(...zones.map((z) => (size / 100) * z.textBase)));
  const shown = style === "word" ? 1 : lines;
  const room = height - safe.top - safe.bottom;
  const notes = [];
  // The block for a letter size: its lines and the outline or box around
  // them, where it sits, and how much of the width it has. The button
  // column narrows the line where the captions reach it; the text stays
  // centered, so the same space is kept on the other side.
  const place = (fontPx) => {
    const blockMax = Math.ceil(shown * lineHeight * fontPx + 0.5 * fontPx);
    let top;
    let bottom;
    if (room < blockMax) {
      const middle = safe.top + room / 2;
      top = middle - blockMax / 2;
      bottom = middle + blockMax / 2;
    } else if (position === "top") {
      top = safe.top;
      bottom = top + blockMax;
    } else if (position === "middle") {
      // The middle of the safe space, as the top and the bottom are its own.
      const middle = safe.top + room / 2;
      top = middle - blockMax / 2;
      bottom = middle + blockMax / 2;
    } else {
      bottom = height - safe.bottom;
      top = bottom - blockMax;
    }
    top = Math.max(0, top);
    bottom = Math.min(height, bottom);
    let side = Math.max(safe.left, safe.right);
    for (const z of zones) if (z.column && bottom > z.column.from) side = Math.max(side, z.column.width);
    return { fontPx, blockMax, top, bottom, side, textWidth: Math.max(0, width - 2 * side) };
  };
  // Letters under a pixel draw nothing, and leave nothing to cut lines by.
  if (asked < 1) throw new Error(`The video is ${width}x${height}, too small for captions: at --size ${size} the letters would be less than a pixel tall`);
  let at = place(asked);
  const fourFit = (p) => p.fontPx * 4 + 2 * inkOf(p.fontPx, { style, box }).reach <= p.textWidth;
  if (!fourFit(at)) {
    // The size where four letters and the outline fit across, found from
    // the top down; a smaller block can leave the button column below it.
    let fontPx = at.fontPx;
    while (fontPx > 8 && !fourFit(place(fontPx))) fontPx--;
    at = place(fontPx);
    notes.push(`At ${size}% the letters would be ${asked} px, and four of them do not fit across the ${Math.round(at.textWidth)} px of safe space, so they are ${at.fontPx} px.`);
  }
  if (room < at.blockMax) notes.push(`The space left between the places' top and bottom margins (${Math.round(room)} px) is smaller than a caption (${at.blockMax} px); the captions sit in the middle of it and reach into the margins.`);
  for (const z of zones) if (z.mismatch) notes.push(z.mismatch);
  const ink = inkOf(at.fontPx, { style, box });
  return {
    frame: { width, height },
    zones,
    safe,
    side: at.side,
    // The safe width, and the width the letters themselves can take in it.
    textWidth: at.textWidth,
    glyphWidth: Math.max(0, at.textWidth - 2 * ink.reach),
    ink,
    fontPx: at.fontPx,
    askedPx: asked,
    lineHeight,
    position,
    blockTop: at.top,
    blockBottom: at.bottom,
    blockMax: at.blockMax,
    notes,
  };
}

// Characters a line can take at this width and size: a bold sans averages
// about 0.6 of its size per character. 8 where no width or size says.
function charsThatFit(textWidth, fontPx) {
  const n = Math.floor(textWidth / (0.6 * fontPx));
  return Number.isFinite(n) ? Math.max(8, Math.min(42, n)) : 8;
}

module.exports = { PLACES, PLACE_NAMES, CHECKED, shapeOf, defaultPlaces, zone, captionLayout, charsThatFit, inkOf };
