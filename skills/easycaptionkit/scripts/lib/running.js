"use strict";

// What a run has going at a time: the programs it started (ffmpeg,
// ffprobe, Chrome) and the temporary folders they use. A run that is
// stopped with Ctrl-C or a kill ends the programs and removes the folders,
// so no ffmpeg keeps encoding into a deleted file and no Chrome profile is
// left in the temporary folder.

const children = new Map();
const folders = new Map();

function kill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

// `stop` ends the child and what it started that would outlive it, as
// Chrome's helper processes would; by default the child alone is killed.
// It runs at once, since a run that is stopped ends right after.
function track(child, stop = () => kill(child)) {
  children.set(child, stop);
  const done = () => children.delete(child);
  child.once("exit", done);
  child.once("error", done);
  return child;
}

// `remove` takes the folder away; it runs when the run is stopped.
function trackFolder(dir, remove) {
  folders.set(dir, remove);
  return dir;
}

function untrackFolder(dir) {
  folders.delete(dir);
}

// Waits without letting anything else run, as a run that is stopped has
// to before it ends.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function stopAll() {
  const killed = children.size > 0;
  for (const [, stop] of children) stop();
  children.clear();
  // A moment for the killed programs to be gone, so none of them writes
  // into a folder after it is removed.
  if (killed && folders.size) sleep(200);
  for (const [dir, remove] of folders) {
    try {
      remove(dir);
    } catch {
      // Left for the system's temp cleanup.
    }
  }
  folders.clear();
}

module.exports = { track, trackFolder, untrackFolder, stopAll, kill, sleep };
