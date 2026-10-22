<div align="center">

# [wosu!](https://scr-eam.github.io/wosu/)

**A browser port of osu!lazer: solo, offline, no install.**

Bring your own beatmaps and skins, click the circles, chase the combo.

![made with Claude](https://img.shields.io/badge/100%25%20made%20with-Claude-d97757?style=for-the-badge)
![based on](https://img.shields.io/badge/based%20on-osu!lazer-ff66aa?style=for-the-badge)
![runs in](https://img.shields.io/badge/runs%20in-the%20browser-7a4dff?style=for-the-badge)

</div>

---

> [!NOTE]
> **This project is 100% made by Claude**, Anthropic's AI. Every line of code, the game core, the menus, the tests and
> this README were written by Claude, directed through conversation. No code was written by hand.

## ✨ Features

**Gameplay, ported from osu!lazer**
- The game rules come straight from **lazer's own code** (2026.1005.0), rewritten in C++ and compiled to **WebAssembly**:
  - **Scoring**: lazer's ScoreV2, plus its health and drain rules
  - **Judging**: hit circles, slider heads, ticks, repeats and tails, and spinner rotation, using lazer's default hit order
  - **Beatmaps**: lazer's .osu decoder, combo colours, stacking and slider paths
- Circles, sliders (snaking in and out), spinners, combo, accuracy, health and grades
- **Argon**, lazer's default skin, is the default look and sound
- **Mods**: EZ, NF, HT, HR, SD, PF, DT, NC, HD, FL, MR and DC
- **Hit sounds** for circles, slider ticks, slides and spins, following lazer's sample rules. They still play on maps that mute them, if you like (setting).
- Beatmap videos and backgrounds, autoplay, pause / retry, and resume with a countdown

**Your stuff**
- Import **.osz** beatmaps and **.osk** skins by clicking or dragging them onto the page
- **Import from osu!**: point it at your osu!stable folder and bring over your whole Songs and Skins library in one go
- Everything is saved in the browser, so it's still there next time with nothing to re-add
- Skins drive the whole look: hit circles, numbers, cursor, colours, hit sounds, and the main menu too

**Main menu**
- An osu!-style menu with a logo that pulses to the beat and a visualizer ring around it
- Your saved maps play as menu music, with previous / pause / next controls
- The menu buttons are **notes you hit**. Exit and Back are **sliders** you follow.
- Drifting hit-object shapes you can push around with the mouse, stardust, and sparks thrown off the logo on the beat
- The logo, stripes, sparks, shapes and progress bar all take on your **skin's colours**
- A guided **first-visit tutorial**, replayable from Settings

## 🚀 Running it

You need [Python 3](https://www.python.org/) (only to serve the files) and a modern browser (Chrome, Edge, Firefox or Safari).

**Windows:** double-click `web/start.bat`. It starts the server and opens the game at http://localhost:8080.

**Anywhere else:**
```bash
cd web
python serve.py 8080
```
Then open **http://localhost:8080**.

> [!TIP]
> Opening `index.html` straight from the file system won't work, because browsers block WebAssembly and modules on
> `file://`. Use the server above or any static host.

## 🎮 Getting started

1. Click the big **osu!** circle to open the menu. The first visit walks you through everything.
2. **Play → Solo** opens song select. Add maps with **Open .osz**, by dropping files on the page, or with
   **Import from osu!**.
3. Pick a difficulty, add mods if you want, and hit **Play** (or Enter).

| Action | Default |
|---|---|
| Hit | `Z` / `X` (rebindable), or the mouse buttons |
| Pause / back | `Esc` |
| Retry | `R` |
| Skip intro | `Space` |
| Menu buttons | Click them, or press `1`–`4` |

### Importing from osu!

**osu!stable:** choose your osu! folder (on Windows it's usually `%LOCALAPPDATA%\osu!`), or just its `Songs` or
`Skins` folder. You get a list of everything found, with the ones you already have marked. Nothing is uploaded: files
are copied into your browser's storage.

**osu!lazer:** lazer keeps its files in its own database, which a web page can't read. Use **Export** on a beatmap or
skin inside lazer and add the file here instead.

## 🧩 How it's built

```
core/   C++ port of lazer's osu! ruleset: beatmap decoding, slider paths, judging, ScoreV2 scoring, health  ->  osu_core.wasm
web/    The game: rendering, audio, menus, skins, storage (plain ES modules, no build step)
```

| File | What it does |
|---|---|
| `web/index.html` | The app: screens, main menu, input, audio, import, tutorial |
| `web/core.js` + `osu_core.wasm` | Loads the WebAssembly core |
| `web/renderer.js` / `hud.js` | Draws the playfield (WebGL) and the HUD |
| `web/skin.js` / `argon.js` | Skin loading, and the default Argon look |
| `web/hitsounds.js` | Hit sound samples and slider / spinner loops |
| `web/mods.js` | Mod rules |
| `web/storage.js` | Saved maps and skins (IndexedDB) |
| `web/settings.js` | The settings panel |

To rebuild the core: `cd core && ./build.sh` (clang with the wasm32 target, or Emscripten with `EMCC=1`).

## ⚠️ Disclaimer

This is an unofficial fan port of [osu!lazer](https://github.com/ppy/osu), **not affiliated with or endorsed by ppy Pty Ltd**. The game rules are ported from lazer's source, which ppy publishes under the MIT licence. *osu!* is a trademark of ppy
Pty Ltd. The default sounds and other game resources come from
[ppy/osu-resources](https://github.com/ppy/osu-resources) under its
[CC BY-NC 4.0](https://github.com/ppy/osu-resources/blob/master/LICENCE.md) licence: credit to ppy, non-commercial
use only. Beatmaps and skins belong to their creators. Support the real game at [osu.ppy.sh](https://osu.ppy.sh).

This port is solo and offline only. It has no accounts, online scores or leaderboards.

---

<div align="center">

Built entirely by **Claude** · made for fun · go play the real osu! too 💗

</div>
