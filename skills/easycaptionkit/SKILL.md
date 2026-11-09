---
name: easycaptionkit
description: Burn captions into a video before it goes out, such as a launch film, a product demo, a reel, a short or a talking clip, from words with times you already have (a speech-to-text JSON, an SRT or VTT file, or a demo's steps.json). Draws them word by word (karaoke, the spoken word lit) or line by line, in the fonts and colors of the product's own site, inside the space TikTok, Reels, Shorts, YouTube, X and LinkedIn leave free of their buttons, and writes captions.srt, captions.vtt and captions.ass to go with the video. Use it whenever a video needs captions or subtitles, or the user asks for them to read with the sound off.
---

# easycaptionkit

Many people watch a feed with the sound off, so the words have to be on the picture, and they have to be where the app's buttons and the post's text do not cover them. easycaptionkit takes words with times from whatever made them, draws them with Chrome in the site's own font files, lays them over the video with ffmpeg in one encode, and writes a frame under each app's buttons to check.

## Caption a video

```bash
node <skill>/scripts/easycaptionkit.js video.mp4 --words transcript.json --out captions/video
```

`<skill>` is this skill's folder. The script needs Node 22 or newer, ffmpeg 4.4 or newer and Chrome, Chromium, Edge or Brave on the machine; it installs nothing and needs no API key. A one minute video takes about half a minute.

- `--words` is the words and their times. It reads speech-to-text JSON with word times (OpenAI verbose_json, whisper.cpp, WhisperX, faster-whisper, ElevenLabs, Deepgram, AssemblyAI, NeMo, Parakeet, transformers chunks, AWS, Google), an SRT or VTT file (a voice-over tool's captions from its script), or easyscreenshotkit's steps.json for a demo with no voice. The kit does not listen to the sound: when there is no words file, get one from a speech-to-text model first.
- `--for tiktok,reels,shorts` (or youtube, x, linkedin, square) names the places the video goes to. The captions keep clear of the buttons of all of them in one file. Left out, the places come from the video's shape.
- `--fonts <easyfontkit folder or its fonts.css>` draws with the site's own font files; `--brand <easybrandkit folder or its brand.json>` lights the spoken word in the brand's color, and without `--fonts` or `--font` asks for the brand's heading font by name, which this machine may not have. Make them first with easyfontkit and easybrandkit when the user wants the product's look.
- `--style karaoke` (default) lights the spoken word, `line` shows whole captions in one color, `word` shows one word at a time. `--box` puts a dark box behind the words.
- `--position middle` or `top` moves the captions when the picture has text or a face at the bottom of the safe space.
- `--dry-run` checks the options without reading anything.

For subtitle files only, with no video changed (for YouTube or LinkedIn, which take a captions file):

```bash
node <skill>/scripts/easycaptionkit.js subtitles transcript.json --video video.mp4 --out captions/video-subtitles
```

`styles` lists the styles, the options and every place's margins with their sources.

## Use the result

1. Read `CAPTIONS.md` first. It says which font drew the letters (and how many letters fell back to another font, as Japanese or Arabic text over a Latin brand font does), where the captions sit and why, and which captions go faster than people read.
2. Look at `sheet.png`: frames of `captioned.mp4` for up to 24 captions, spread over the video. Check that no caption covers text or a face in the picture; if one does, run again with `--position middle` or `top`. A video with more captions than the sheet shows has every caption's time in `captions.json`; take a frame at the times that matter.
3. Show `safe-zones.png` to the user: a frame under each app's buttons, the margins tinted, the safe space outlined.
4. Hand over `captioned.mp4`. It has every frame of the video at its own time, or, where the video holds a frame too long for the captions or has few frames a second (CAPTIONS.md says so), every frame at a steady rate, and its sound copied, or made AAC when MP4 players do not take it. Give `captions.srt` or `captions.vtt` to places that take a captions file.
5. To fix a misheard word, edit its text in `<out>/words.json` and run the same command again with `--words <out>/words.json --out <out>`. For subtitles, give that file in the place of the words file, with the same `--video` and options: `subtitles <out>/words.json --video video.mp4 --out <out>`. CAPTIONS.md gives the whole command for its own folder, which starts as the run was started (`node <skill>/scripts/easycaptionkit.js` here). If the edit breaks the JSON, the run stops and says at which line and column. From then on, a run into that folder from the first words file stops rather than replace the fixes; keep giving `<out>/words.json`, or move it away to start over.
6. To measure the result, run launch-film's check on it from the same folder: `npx launch-film@latest check <out>/captioned.mp4`. For a launch-film film, the kit copies the film's timeline next to it as `captioned.timeline.json`, so the check finds the cuts.

## When it goes wrong

- "reads files, not addresses": the video or the words were given as a link. Download it first and give the file. "--brand takes an easybrandkit folder" or "--fonts takes an easyfontkit folder": a site's address was given for the brand or the fonts. Make the folder from that site with easybrandkit or easyfontkit and give it.
- "Every word starts after the video ends": the words belong to another video, or their times are in milliseconds in a shape the kit does not know. Convert them to seconds in a plain list of `{ "text", "start", "end" }`.
- A caption is drawn smaller than the others: one of its lines was wider than the safe space (with `--libass`, by an estimate of its width). Lower `--max-chars` for long lines. A single long word, like a link, fits only at a lower `--size`; or shorten it in `words.json`.
- "Pick another --out": the folder holds a file by one of the names the kit writes that it did not write itself (another tool's words.json, or a link, say) or that has changed since it wrote it, or one of the files the run reads, or, for a subtitles run, the captioned video of an earlier run, which new subtitle files would no longer match. Give a new folder with `--out`.
- "holds words fixed by hand": the folder's words.json has fixes this run would lose, since it reads another words file. The message gives the command that keeps them, the one refused with `<out>/words.json` as its words; or move `<out>/words.json` away to start again from the words file. A subtitles run into the folder of a captioned video is refused whatever its words, and when they were fixed there, the message gives the command that makes subtitles of them in a folder of their own.
- "came into <out> while this run was going", or "changed in <out>": a file by one of the kit's names came into the folder during the run, or the content of one there changed. The folder is as it was, and the run's files are in `<out>/easycaptionkit-new`.
- Without `--out`, a second video by the same name as an earlier one (every easyscreenshotkit demo is demo.mp4) goes to `easycaptionkit-demo-2`, and the summary says so. A subtitles run goes to `easycaptionkit-subtitles-<video name>`, or `easycaptionkit-subtitles-<words name>` without `--video`, in the same way. With `--out`, a run into the folder of another video's captions replaces them and says whose they were.
- CAPTIONS.md says the brand font was asked for by name and this machine does not have it: give easyfontkit's folder with `--fonts`. When it says Chrome drew no letter with the file of a fonts.css font, that file lacks the letters of these words, as a cut for another script does.
- The font license in CAPTIONS.md is commercial: tell the user before the video goes out. The file names the closest free font; `--font "<that font>"` uses it once it is installed. When CAPTIONS.md says no letter of the font is in the video, as with Japanese or Arabic words over a Latin font, its license does not reach the video: the fonts that drew the letters came with the machine.
- With `--libass`, CAPTIONS.md can say the video shows boxes for some emoji: libass draws no color emoji. Run again without `--libass` to have Chrome draw them. A letter no font on the machine has shows as a box with Chrome too.
- No Chrome on the machine: the run stops. `--libass` draws the captions with ffmpeg's libass instead, which needs an ffmpeg built with libass (Homebrew's default ffmpeg is not).
- "Chrome could not start its sandbox here", or another reason Chrome stopped as it started (in a container, or on a CI runner without user namespaces): the run stops before the encode. `--libass` draws the captions without Chrome, and ffmpeg makes plainer sheet.png and safe-zones.png, which CAPTIONS.md notes.
- A run killed outright (`kill -9`, or the system when memory runs out) cannot tidy up: its hidden `.easycaptionkit-work-` folder stays in the out folder, where an ffmpeg it started can go on writing captioned.mp4, and its Chrome profile stays in the temporary folder. The captioned.mp4 in that folder is no result to hand over: run again. The next run into the folder removes the work folder, and a later run of the same user that starts Chrome removes the profile once no process names it and it has not changed for a day, except on Windows, where it stays in the temporary folder until Windows or the user clears it.
- The safe zones are the apps' ad guides or estimates, each with its source and date. Tell the user to check one post on a phone.
- Never say the captions are correct word for word: they are what the words file says.
