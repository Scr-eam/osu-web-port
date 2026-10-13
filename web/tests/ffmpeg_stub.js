// Stands in for @ffmpeg/ffmpeg in the browser tests (the CDN cannot be reached from the test sandbox).
// It has the same calls as the real FFmpeg class, so transcode.js runs unchanged. exec() records its
// arguments and the number of runs on window, takes two seconds as a real conversion would, and hands back
// converted.webm, a clip made in advance, as the output.

const OUTPUT_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/stub/converted.webm";

export class FFmpeg {
  #files = new Map();
  #progress = new Set();

  on(_event, fn) { this.#progress.add(fn); }
  off(_event, fn) { this.#progress.delete(fn); }

  async load() {
    window.__ffLoads = (window.__ffLoads || 0) + 1;
    // A converter that never starts (the test sets window.__ffHang before the page loads).
    if (window.__ffHang) await new Promise(() => {});
  }

  async writeFile(name, data) { this.#files.set(name, data); }
  async readFile(name) {
    const data = this.#files.get(name);
    if (!data) throw new Error(`no file ${name}`);
    return data;
  }
  async deleteFile(name) { this.#files.delete(name); }

  async exec(args) {
    window.__ffExecs = (window.__ffExecs || 0) + 1;
    window.__ffArgs = args;
    for (const fn of this.#progress) fn({ progress: 0.5, time: 0 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const out = new Uint8Array(await (await fetch(OUTPUT_URL)).arrayBuffer());
    this.#files.set("out.webm", out);
    for (const fn of this.#progress) fn({ progress: 1, time: 0 });
    return 0;
  }
}
