"""End-to-end test for the web player, run in headless Chromium.

Rounds:
  1. Autoplay on the default skin: every object judged, no misses, accuracy 100%, the slider
     body is drawn mid-slide, the canvas is not blank.
  2. No input: health drains to zero (fail) and accuracy stays low.
  3. Keyboard: bind key 1 to A in Settings, hit the circles with A and X, check that Escape
     cannot be bound, and that the binding survives a reload.
  4. Pause and restart: Escape freezes the song clock and resumes it, losing focus pauses,
     R restarts.
  4b. High precision mouse: the cursor moves by the mouse movement, a press or a resume does not
     move it, and sensitivity scales the movement.
  4c. Skip intro: a long intro can be skipped with a rebindable key, to two seconds before the first note.
  4d. Lead-in: a map whose first note is early starts its clock before the notes, as lazer does.
  4e. Mods: Easy and Hard Rock change the difficulty and Hard Rock and Mirror flip the playfield (slider curves
     too); Double Time runs the clock 1.5x; Hidden and Flashlight change what is drawn; Sudden Death, Perfect and
     No Fail decide the failure. Conflicting mods turn each other off, and the choice is kept across a reload.
  5. Skin: import a .osk, check it becomes active, its combo colour shows on a hit circle,
     its sprites and hit sound are loaded, and a switch mid-round recolours every object.
  6. Browser storage: an opened beatmap and an imported skin are still there after a reload,
     the saved beatmap plays from the list without its file, and Forget removes it for good.
  7. Browser storage blocked: a beatmap still opens and plays, and the page says it is not kept.
  8. Menus: the main menu, Play and Solo, Esc going back, Settings, and Enter starting a round.
  10. Looks: the default Argon note sprites, a beatmap's own skin files over them, and the settings
     that turn the beatmap skin off or pick the flat look.
  11. HUD: the combo counter sits bottom left, the score and accuracy top right and the health bar top left (the
     default look, and a skin's own digits and health bar when the skin has them).
  9. Beatmap video: the map's video plays behind the playfield from its start time, follows the song
     clock, pauses with the round, and a video file missing from the archive is left out. A video the
     browser cannot play (AVI, FLV, WMV) says so on screen.
  The playfield canvas covers the window. The page loads no game textures or sounds: the default
  look is flat shapes and text numbers, with no skin sprites or hit sound.

Usage: python3 e2e_test.py MAP.osz SKIN.osk
  (make the inputs with make_fixture.py and make_skin_fixture.py)
Needs: playwright (python), PIL, and Chromium at /opt/pw-browsers/chromium.
"""
import base64
import functools
import io
import json
import http.server
import os
import re
import socket
import sys
import threading
import zipfile

from PIL import Image, ImageDraw
from make_video_fixture import make as make_videos, rebuild
from playwright.sync_api import sync_playwright

WEB_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CHROMIUM = "/opt/pw-browsers/chromium"
LAUNCH_ARGS = [
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    "--autoplay-policy=no-user-gesture-required",
]
# Playfield points used by the pixel probes (see the comments where they are checked).
SLIDER_PROBE = (440, 273)   # the middle of the slider's outer band, 27 units above the centre-line (bands 22-33, border beyond)
CIRCLE_PROBE = (150, 120)   # inside the hit circle at (150,150), above its combo number
# The default combo palette (lazer's default skin), used to check colours after a skin change.
DEFAULT_COLOURS = [(255, 192, 0), (0, 202, 0), (18, 124, 255), (242, 24, 57)]
# Each top-level object's raw combo index, and the colour it is drawn with (index modulo the palette).
COLOUR_JS = """() => {
  const pal = window.osuDemo.displayColours();
  const d = window.osuDemo.records();
  const raw = [], shown = [];
  for (let i = 0; i < window.osuDemo.topCount(); i++) {
    const k = Math.round(d[i * 16 + 6]);
    raw.push(k);
    shown.push(pal[k % pal.length].join(","));
  }
  return { raw, shown };
}"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = functools.partial(QuietHandler, directory=WEB_ROOT)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


class Round:
    """One browser context and page, with console errors collected."""

    def __init__(self, browser, base, init_script=None):
        self.context = browser.new_context(viewport={"width": 1100, "height": 900})
        # The page loads Inter from Google Fonts. The sandbox cannot reach it, so the stylesheet is
        # served empty; the font falls back to the system one and the console stays clean.
        self.context.route("https://fonts.googleapis.com/**",
                           lambda route: route.fulfill(status=200, content_type="text/css", body=""))
        self.context.route("https://fonts.gstatic.com/**", lambda route: route.abort())
        if init_script:
            self.context.add_init_script(init_script)
        self.page = self.context.new_page()
        self.errors = []
        self.requests = []          # every URL the page asks for
        self.page.on("request", lambda req: self.requests.append(req.url))
        self.page.on("console",lambda m: self.errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.base = base
        self.page.goto(base + "/index.html")
        self.page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)

    def open_map(self, fixture):
        self.page.set_input_files("#file", fixture)
        self.page.wait_for_function("window.osuDemo.difficultyCount > 0", timeout=20000)

    def play(self, autoplay=False):
        if autoplay:
            self.page.check("#auto")
        self.page.click("#play")

    def song_time(self):
        return self.page.evaluate("window.osuDemo.stats().time")

    def wait_for_time(self, ms, timeout=40000):
        self.page.wait_for_function(f"window.osuDemo.stats().time >= {ms}", timeout=timeout, polling=5)

    def wait_for_end(self, timeout=60000):
        self.page.wait_for_function(
            "window.osuDemo.stats().finished === 1 || window.osuDemo.stats().failed === 1",
            timeout=timeout,
        )

    def circles(self):
        """(record index, start time, x, y) for each top-level circle, from the core's records."""
        return self.page.evaluate(
            "(() => { const d = window.osuDemo.records(); const n = window.osuDemo.topCount(); const out = [];"
            " for (let i = 0; i < n; i++) if (d[i * 16] === 0) out.push([i, d[i * 16 + 4], d[i * 16 + 1], d[i * 16 + 2]]);"
            " return out; })()"
        )

    def states(self):
        """State of each top-level object (record index 8): 0 open, 1 hit, 2 missed."""
        return self.page.evaluate(
            "(() => { const d = window.osuDemo.records(); const n = window.osuDemo.topCount(); const out = [];"
            " for (let i = 0; i < n; i++) out.push(d[i * 16 + 8]); return out; })()"
        )

    def view(self):
        """The area the canvas shows this round, in playfield units: {x, y, w, h}."""
        return self.page.evaluate("window.osuDemo.view()")

    def playfield_xy(self, x, y):
        box = self.page.locator("#gl").bounding_box()
        v = self.view()
        return box["x"] + (x - v["x"]) / v["w"] * box["width"], box["y"] + (y - v["y"]) / v["h"] * box["height"]

    def close(self):
        self.context.close()


def shift_osu(text, shift, timing=True):
    """Moves every time in a .osu file later by shift ms (timing, breaks, objects, spinner ends)."""
    out = []
    section = ""
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
        elif timing and section == "[TimingPoints]" and "," in stripped:
            parts = line.split(",")
            parts[0] = str(int(parts[0]) + shift)
            line = ",".join(parts)
        elif section == "[Events]" and stripped.startswith("2,"):
            parts = line.split(",")
            parts[1] = str(int(parts[1]) + shift)
            parts[2] = str(int(parts[2]) + shift)
            line = ",".join(parts)
        elif section == "[HitObjects]" and stripped:
            parts = line.split(",")
            parts[2] = str(int(parts[2]) + shift)
            if int(parts[3]) & 8:            # a spinner's end time is its sixth field
                parts[5] = str(int(parts[5]) + shift)
            line = ",".join(parts)
        out.append(line)
    return "\n".join(out)


def first_object_ms(text):
    """The start time of the first object in a .osu file's [HitObjects]."""
    section = ""
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("["):
            section = stripped
        elif section == "[HitObjects]" and stripped:
            return int(stripped.split(",")[2])
    raise SystemExit("no hit objects")


def make_early_map(src, dst, first_ms):
    """A copy of the map whose notes start earlier, so the first one is at first_ms. The timing is left as it is."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename.endswith(".osu"):
                text = data.decode("utf-8")
                text = shift_osu(text, first_ms - first_object_ms(text), timing=False)
                data = text.encode("utf-8")
            zout.writestr(info.filename, data)
    return dst


# Objects for the mods checks: a circle outside a flashlight's light at the centre cursor (about 180 units away),
# a second circle, and a slider with a curve for the flips.
MODS_OBJECTS = [
    "100,100,2000,1,0,0:0:0:0:",
    "400,300,3000,1,0,0:0:0:0:",
    "60,320,4000,2,0,L|200:320|200:200,1,100",
]


def make_mods_map(dst, objects, hp=5):
    """A map of plain objects with no audio file, so the round runs on the page's own clock."""
    text = (
        "osu file format v14\n\n[General]\nAudioFilename: none.mp3\nMode: 0\n\n"
        "[Metadata]\nTitle:Mods Test\nArtist:Tester\nCreator:Tester\nVersion:Normal\n\n"
        f"[Difficulty]\nHPDrainRate:{hp}\nCircleSize:4\nOverallDifficulty:8\nApproachRate:9\n"
        "SliderMultiplier:1.4\nSliderTickRate:1\n\n"
        "[TimingPoints]\n1000,500,4,2,0,60,1,0\n\n"
        "[Events]\n//Break\n\n"
        "[HitObjects]\n" + "\n".join(objects) + "\n"
    )
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mods.osu", text)
    return dst


def resume_round(r, via_escape=True):
    """Resumes a paused round as a player does: Escape (or the Continue button), then, when lazer's resume
    prompt comes up because the pointer is on the page, a click on its orange cursor."""
    page = r.page
    if via_escape:
        page.keyboard.press("Escape")
    else:
        page.click("#resume")
    page.wait_for_timeout(50)
    spot = page.evaluate("window.osuDemo.resumePrompt")
    if spot:
        x, y = r.playfield_xy(spot["x"], spot["y"])
        page.mouse.move(x, y, steps=4)
        page.mouse.click(x, y)
    page.wait_for_timeout(50)
    return spot


def near(a, b, eps=0.01):
    return abs(a - b) <= eps


def make_cover_fixture(src, out_dir):
    """A copy of the map that names a background image, with a small picture for it."""
    bg = io.BytesIO()
    img = Image.new("RGB", (640, 360))
    draw = ImageDraw.Draw(img)
    for x in range(640):
        draw.line([(x, 0), (x, 359)], fill=(40 + x // 4, 90, 200 - x // 4))
    img.save(bg, format="JPEG")
    dst = os.path.join(out_dir, "cover.osz")
    return rebuild(src, dst, '0,0,"bg.jpg",0,0', [("bg.jpg", bg.getvalue())])


def make_intro_map(src, dst, shift):
    """A copy of the map with a long intro (all times moved by shift ms) and one note in the top-left corner."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info.filename)
            if info.filename.endswith(".osu"):
                text = shift_osu(data.decode("utf-8"), shift).rstrip("\n")
                data = (text + "\n4,376,15000,5,0,0:0:0:0:\n").encode("utf-8")
            zout.writestr(info.filename, data)


def pixel_at(png, pf_x, pf_y, view):
    """The screenshot's pixel at a playfield point, for the round's view {x, y, w, h}."""
    img = Image.open(png).convert("RGB")
    return img.getpixel((round((pf_x - view["x"]) / view["w"] * img.width),
                         round((pf_y - view["y"]) / view["h"] * img.height)))


def canvases_at(rr, ms):
    """The round drawn again at song time ms: (playfield, overlay) as PIL images. See osuDemo.drawAt."""
    out = rr.page.evaluate("(ms) => window.osuDemo.drawAt(ms)", ms)
    decode = lambda url: Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGBA")
    return decode(out["playfield"]), decode(out["overlay"])


def image_pixel(img, pf_x, pf_y, view):
    """The pixel of a decoded canvas at a playfield point, for the round's view {x, y, w, h}."""
    return img.getpixel((round((pf_x - view["x"]) / view["w"] * img.width),
                         round((pf_y - view["y"]) / view["h"] * img.height)))


def canvas_has_content(png):
    """A rendered playfield has many distinct colours; a blank or failed WebGL canvas does not."""
    colours = Image.open(png).convert("RGB").getcolors(maxcolors=1 << 20) or []
    return len(colours) > 40, len(colours)


def lib_names(page):
    """Names of the saved beatmaps listed in song select (#lib)."""
    return page.evaluate("() => [...document.querySelectorAll('#lib button')].map((b) => b.dataset.name)")


def option_values(page, selector):
    """Values of the options in a select, e.g. the saved beatmaps in #lib."""
    return page.evaluate("(sel) => [...document.querySelectorAll(sel + ' option')].map((o) => o.value)", selector)


def read_text(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# The util module, with toBlobURL passing the URL through (the stand-in converter loads no core files).
# The converter's core is downloaded before the stand-in starts, so it is served too (empty but for a header).
CORE_WASM_STAND_IN = b"\x00asm\x01\x00\x00\x00" + bytes(512 * 1024)


def route_converter(r, stub_js, output_webm):
    """Answers the converter's CDN requests with the stand-in: the FFmpeg module, its worker and core files,
    and the WebM clip the stand-in hands back. Anything else on the CDN fails, as an unreachable CDN would."""
    cors = {"access-control-allow-origin": "*"}

    def handle(route):
        url = route.request.url
        if url.endswith("/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js"):
            route.fulfill(status=200, content_type="text/javascript", body=stub_js, headers=cors)
        elif url.endswith("/@ffmpeg/ffmpeg@0.12.10/dist/esm/worker.js"):
            route.fulfill(status=200, content_type="text/javascript", body="// worker stand-in\n", headers=cors)
        elif url.endswith("/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js"):
            route.fulfill(status=200, content_type="text/javascript", body="// core stand-in\n", headers=cors)
        elif url.endswith("/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm"):
            route.fulfill(status=200, content_type="application/wasm", body=CORE_WASM_STAND_IN, headers=cors)
        elif url == "https://cdn.jsdelivr.net/npm/@ffmpeg/stub/converted.webm":
            route.fulfill(status=200, content_type="video/webm", body=output_webm, headers=cors)
        else:
            route.abort()

    r.context.route("https://cdn.jsdelivr.net/**", handle)


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: e2e_test.py MAP.osz SKIN.osk")
    fixture = os.path.abspath(sys.argv[1])
    skin_file = os.path.abspath(sys.argv[2])
    # The skin is named after its file, as the page names imported skins.
    skin_name = re.sub(r"\.(osk|zip)$", "", os.path.basename(skin_file), flags=re.IGNORECASE).strip()
    for path in (fixture, skin_file):
        if not os.path.exists(path):
            sys.exit(f"missing input: {path}")
    out_dir = os.path.dirname(fixture)
    httpd, port = serve()
    base = f"http://127.0.0.1:{port}"
    failures = []

    def check(name, ok, detail=""):
        print(("PASS  " if ok else "FAIL  ") + name + (f"  [{detail}]" if detail else ""))
        if not ok:
            failures.append(name)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM, args=LAUNCH_ARGS)

            # ---- 1. autoplay, default look ----
            r = Round(browser, base)
            r.open_map(fixture)
            r.play(autoplay=True)
            r.wait_for_time(2700)
            cursor_css = r.page.evaluate("getComputedStyle(document.querySelector('#gl')).cursor")
            sprites = r.page.evaluate("window.osuDemo.skinSprites")
            check("the default Argon look draws its own note sprites, with no hit sound and no game assets fetched",
                  r.page.evaluate("window.osuDemo.lookSource") == "argon"
                  and r.page.evaluate("window.osuDemo.hasHitsound") is False
                  and "hitcircle" in sprites and "approachcircle" in sprites
                  and not any("githubusercontent" in u or "/assets/" in u for u in r.requests),
                  f"sprites={sprites}")
            check("system cursor is hidden during play", cursor_css == "none", f"cursor={cursor_css}")
            r.page.locator("#stage").screenshot(path=os.path.join(out_dir, "e2e_slider_probe.png"))
            t_probe = r.song_time()
            r.wait_for_end()
            stats = r.page.evaluate("window.osuDemo.stats()")
            states = r.states()
            print(f"autoplay: judged={stats['judgements']:.0f} accuracy={stats['accuracy']:.4f} "
                  f"miss={stats['miss']:.0f} great={stats['great']:.0f} maxCombo={stats['maxCombo']:.0f} "
                  f"score={stats['score']:.0f}")

            # The canvas covers the whole window, the view has the canvas's shape, and every note is inside the view.
            cr = r.page.evaluate("window.osuDemo.canvasRect()")
            iw, ih = r.page.evaluate("[innerWidth, innerHeight]")
            covers = abs(cr["x"]) < 1 and abs(cr["y"]) < 1 and abs(cr["w"] - iw) < 1 and abs(cr["h"] - ih) < 1
            check("the playfield canvas covers the whole window", covers, f"{cr} in {iw}x{ih}")
            v = r.view()
            check("the playview has the window's shape", abs(v["w"] / v["h"] - cr["w"] / cr["h"]) < 0.01,
                  f"{v['w'] / v['h']:.3f} vs {cr['w'] / cr['h']:.3f}")
            outside = r.page.evaluate('''() => {
              const v = window.osuDemo.view(), d = window.osuDemo.records(), n = window.osuDemo.topCount();
              const inside = (x, y) => x >= v.x && x <= v.x + v.w && y >= v.y && y <= v.y + v.h;
              let bad = 0;
              for (let i = 0; i < n; i++) {
                const kind = d[i * 16], x = d[i * 16 + 1], y = d[i * 16 + 2], rad = d[i * 16 + 3];
                if (kind === 0 && !(inside(x - rad, y - rad) && inside(x + rad, y + rad))) bad++;
                if (kind === 1) {
                  const pts = window.osuDemo.sliderPoints(i);
                  for (let k = 0; k + 1 < pts.length; k += 2) {
                    if (!inside(pts[k] - rad * 1.6, pts[k + 1] - rad * 1.6) || !inside(pts[k] + rad * 1.6, pts[k + 1] + rad * 1.6)) { bad++; break; }
                  }
                }
              }
              return bad;
            }''')
            check("every note lies inside the playview", outside == 0, f"{outside} outside")
            check("every top-level object judged", all(s != 0 for s in states),
                  f"{sum(1 for s in states if s != 0)}/{len(states)}")
            check("finished, not failed", stats["finished"] == 1 and stats["failed"] == 0)
            check("no misses under autoplay", stats["miss"] == 0, f"miss={stats['miss']:.0f}")
            check("accuracy >= 0.98 under autoplay", stats["accuracy"] >= 0.98, f"{stats['accuracy']:.4f}")
            check("result overlay shows the result", r.page.is_visible("#result") and "Finished" in r.page.inner_text("#resultText"))
            check("autoplay earns the X rank (full accuracy)", r.page.inner_text("#grade") == "X", r.page.inner_text("#grade"))
            check("system cursor is shown on the result screen", "hide-cursor" not in r.page.get_attribute("#stage", "class"))
            # The probe frame was taken while the slider was in progress.
            png = os.path.join(out_dir, "e2e_slider_probe.png")
            check("slider probe taken during the slide", 2700 <= t_probe <= 3500, f"t={t_probe:.0f} ms")
            px = pixel_at(png, *SLIDER_PROBE, r.view())
            check("slider body is drawn mid-slide", max(px) > 60, f"pixel rgb={px}")
            check("slider body colour is not saturated", max(px) < 180, f"pixel rgb={px}")
            ok_canvas, colours = canvas_has_content(png)
            check("playfield is not blank", ok_canvas, f"{colours} colours")
            check("no console errors (autoplay)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 2. no input ----
            r = Round(browser, base)
            r.open_map(fixture)
            r.play()
            r.wait_for_end()
            stats = r.page.evaluate("window.osuDemo.stats()")
            print(f"idle:     accuracy={stats['accuracy']:.4f} miss={stats['miss']:.0f} "
                  f"health={stats['health']:.3f} failed={stats['failed']:.0f}")
            check("idle play fails by draining health", stats["failed"] == 1 and "Failed" in r.page.inner_text("#resultText"))
            check("a failed round is ranked F", r.page.inner_text("#grade") == "F", r.page.inner_text("#grade"))
            check("idle play misses objects", stats["miss"] >= 3, f"miss={stats['miss']:.0f}")
            check("idle accuracy is low", stats["accuracy"] < 0.25, f"{stats['accuracy']:.4f}")
            check("no console errors (idle)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 3. keyboard ----
            r = Round(browser, base)
            page = r.page
            r.open_map(fixture)
            page.click("#selectSettings")
            page.click("#k0")
            page.keyboard.press("a")
            check("key 1 rebinds to A", page.inner_text("#k0") == "A"
                  and page.evaluate("window.osuDemo.settings.keys[0].code") == "KeyA")
            page.click("#k1")
            page.keyboard.press("Escape")
            check("Escape cannot be bound (key 2 unchanged)", page.inner_text("#k1") == "X"
                  and page.evaluate("window.osuDemo.settings.keys[1].code") == "KeyX")
            page.click("#closeSettings")
            r.play()
            # Hit each circle with the key that is bound to it: key 1 (A) and key 2 (X), alternating.
            # The bot waits for the song clock, moves the cursor onto the circle, then presses.
            for n, (idx, start, x, y) in enumerate(r.circles()):
                page.mouse.move(*r.playfield_xy(x, y))
                r.wait_for_time(start - 20)
                page.keyboard.press("a" if n % 2 == 0 else "x")
            r.wait_for_time(7200)
            states = r.states()
            circle_states = [states[i] for i, *_ in r.circles()]
            print(f"keyboard: circle states={circle_states}")
            check("keyboard hits every circle", all(s == 1 for s in circle_states), str(circle_states))
            # Reload: the binding is saved in localStorage and comes back.
            page.reload()
            page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            check("binding survives a reload", page.evaluate("window.osuDemo.settings.keys[0].code") == "KeyA")
            page.click("#settingsBtn")
            page.uncheck("#mouse")
            page.reload()
            page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            check("mouse toggle survives a reload", page.evaluate("window.osuDemo.settings.mouse") is False)
            page.click("#settingsBtn")
            check("cursor sensitivity is off until high precision mouse is on", page.is_disabled("#set-sensitivity"))
            page.check("#set-relative")
            page.reload()
            page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            page.click("#settingsBtn")
            check("high precision mouse survives a reload", page.is_checked("#set-relative"))
            check("cursor sensitivity is enabled with high precision mouse", not page.is_disabled("#set-sensitivity"))
            check("no console errors (keyboard)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4. pause and restart ----
            r = Round(browser, base)
            page = r.page
            r.open_map(fixture)
            r.play()
            r.wait_for_time(600)
            # The song clock reads the sound the listener hears, which trails the audio being rendered by the
            # device's output latency (about 30 ms here). A clock on the rendered time would show a lag of zero.
            lag = page.evaluate("window.osuDemo.audioLagMs")
            check("song clock trails the rendered audio by the output latency",
                  lag is not None and 5 < lag < 150, f"lag {lag}")
            page.keyboard.press("Escape")
            t0p = r.song_time()
            paused_shown = page.is_visible("#pause") and page.evaluate("window.osuDemo.paused")
            page.wait_for_timeout(700)
            t1 = r.song_time()
            page.wait_for_timeout(500)
            t2 = r.song_time()
            check("Escape pauses and shows the pause panel at once", paused_shown)
            # The song winds down over 200 ms rather than stopping dead: about 100 ms of song plays out.
            check("the song slows to a stop when paused, rather than stopping dead", 40 < t1 - t0p < 200,
                  f"{t1 - t0p:.0f} ms of song after the pause")
            check("song clock is frozen once it has stopped", t1 == t2, f"{t1:.1f} -> {t2:.1f}")
            resume_round(r)
            page.wait_for_timeout(400)
            t3 = r.song_time()
            check("Escape resumes the song", t3 > t2 + 200 and not page.evaluate("window.osuDemo.paused"),
                  f"{t2:.0f} -> {t3:.0f} ms")
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            check("losing focus pauses", page.evaluate("window.osuDemo.paused") is True)
            resume_round(r)
            page.keyboard.press("Escape")
            page.wait_for_timeout(100)
            page.keyboard.press("r")
            page.wait_for_timeout(300)
            check("R restarts the round", r.song_time() < 600 and page.evaluate("window.osuDemo.playing"),
                  f"t={r.song_time():.0f} ms")
            check("no console errors (pause)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4a. lazer's resume prompt: with the pointer on the page, a resume waits for the orange cursor ----
            r = Round(browser, base)
            page = r.page
            r.open_map(fixture)
            r.play()
            r.wait_for_time(600)
            box = page.locator("#gl").bounding_box()
            # The game cursor follows the pointer here, so the orange cursor comes up where the pointer was at the
            # pause. The pointer then moves away from it before the resume.
            page.mouse.move(box["x"] + 200, box["y"] + 200, steps=4)
            page.wait_for_timeout(100)
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=4)
            page.keyboard.press("Escape")
            page.wait_for_timeout(1200)                         # the cursor has shrunk to its size
            spot = page.evaluate("window.osuDemo.resumePrompt")
            check("a resume with the pointer on the page brings up the orange cursor and waits",
                  spot is not None and page.evaluate("window.osuDemo.paused") is True and not page.is_visible("#pause"),
                  str(spot))
            check("the system pointer is hidden for the prompt", "hide-cursor" in page.get_attribute("#stage", "class"))
            if spot:
                page.locator("#stage").screenshot(path=os.path.join(out_dir, "e2e_prompt.png"))
                img = Image.open(os.path.join(out_dir, "e2e_prompt.png")).convert("RGB")
                gx, gy = r.playfield_xy(spot["x"], spot["y"])
                px = img.getpixel((int(gx - box["x"]), int(gy - box["y"])))
                check("the prompt's cursor is orange", px[0] > 180 and 90 < px[1] < 210 and px[2] < 90, f"rgb={px}")
            page.mouse.click(box["x"] + box["width"] / 2 + 100, box["y"] + box["height"] / 2)
            page.wait_for_timeout(100)
            check("a click away from the orange cursor does not resume", page.evaluate("window.osuDemo.paused") is True)
            page.keyboard.press("Escape")
            page.wait_for_timeout(100)
            check("Escape during the prompt goes back to the pause menu",
                  page.evaluate("window.osuDemo.resumePrompt") is None and page.is_visible("#pause")
                  and page.evaluate("window.osuDemo.paused") is True)
            t_held = r.song_time()
            spot = resume_round(r)
            page.wait_for_timeout(500)
            check("clicking the orange cursor resumes the round", spot is not None and not page.evaluate("window.osuDemo.paused")
                  and r.song_time() > t_held + 150, f"{t_held:.0f} -> {r.song_time():.0f}")
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            page.evaluate("document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))")   # the pointer leaves the window
            page.keyboard.press("Escape")
            page.wait_for_timeout(100)
            check("with the pointer off the page, a resume carries on at once (no prompt)",
                  page.evaluate("window.osuDemo.resumePrompt") is None and not page.evaluate("window.osuDemo.paused"))
            check("no console errors (resume prompt)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4b. high precision mouse: the cursor moves by the mouse, it does not jump to it ----
            r = Round(browser, base)
            page = r.page
            page.click("#settingsBtn")
            page.check("#set-relative")
            page.click("#closeSettings")
            r.open_map(fixture)
            def context_menu_allowed():
                # dispatchEvent returns false when the page cancelled the menu
                return page.evaluate("() => document.querySelector('#gl').dispatchEvent("
                                     "new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))")
            check("the right-click menu is left alone in menus", context_menu_allowed() is True)
            r.play()
            page.wait_for_function("window.osuDemo.playing === true", timeout=20000)
            page.wait_for_timeout(300)
            check("no right-click menu during a round", context_menu_allowed() is False)
            box = page.locator("#gl").bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            scale = r.view()["w"] / box["width"]    # playfield units per CSS pixel
            page.mouse.move(cx, cy)
            page.wait_for_timeout(100)

            def cur():
                c = page.evaluate("window.osuDemo.cursor()")
                return c["x"], c["y"]

            check("high precision round locks the pointer", page.evaluate("window.osuDemo.cursor().locked") is True)
            sens = float(page.input_value("#set-sensitivity"))
            c0 = cur()
            page.mouse.move(cx + 60, cy, steps=6)
            page.wait_for_timeout(100)
            c1 = cur()
            check("mouse movement moves the cursor by the movement", abs((c1[0] - c0[0]) - 60 * scale * sens) < 1.5
                  and abs(c1[1] - c0[1]) < 1.5, f"moved {c1[0] - c0[0]:.1f}, expected {60 * scale * sens:.1f}")
            c2 = cur()
            page.mouse.down()
            page.mouse.up()
            page.wait_for_timeout(100)
            check("a mouse press does not move the cursor", cur() == c2, f"{c2} -> {cur()}")
            # Sensitivity is set without moving the mouse, so the pointer stays where the lock holds it.
            page.evaluate("""() => { const s = document.querySelector('#set-sensitivity');
                                     s.value = 2; s.dispatchEvent(new Event('input')); }""")
            c3 = cur()
            page.mouse.move(cx + 30, cy, steps=6)
            page.wait_for_timeout(100)
            c4 = cur()
            check("cursor sensitivity scales the movement", abs((c4[0] - c3[0]) + 30 * scale * 2) < 1.5,
                  f"moved {c4[0] - c3[0]:.1f}, expected {-30 * scale * 2:.1f}")
            c5 = cur()
            page.keyboard.press("Escape")            # pause
            page.wait_for_timeout(100)
            # A press on the playfield while paused used to move the cursor to where it landed.
            page.evaluate("() => document.querySelector('#gl').dispatchEvent(new PointerEvent('pointerdown', "
                          "{ clientX: 5, clientY: 5, button: 0, bubbles: true }))")
            page.wait_for_timeout(50)
            check("a click on the playfield while paused does not move the cursor", cur() == c5, f"{c5} -> {cur()}")
            resume_round(r)                          # resume: the prompt's orange cursor is clicked
            page.wait_for_timeout(100)
            check("pausing and resuming keeps the cursor where it was", cur() == c5, f"{c5} -> {cur()}")
            c6 = cur()
            # Synthetic movements: after a lock is released and taken again, Playwright's absolute mouse
            # positions no longer match the browser's own last position, so real moves would be measured
            # from the wrong place. The handler's movement logic is what is tested here. The first move after
            # a resume only sets the base, so a zero move goes first.
            move = "(dx) => window.dispatchEvent(new PointerEvent('pointermove', { movementX: dx, movementY: 0 }))"
            page.evaluate(move, 0)
            page.evaluate(move, 900)                 # more than half the window: the pointer coming back, not a flick
            page.wait_for_timeout(50)
            check("a pointer jump is not counted as movement", cur() == c6, f"{c6} -> {cur()}")
            page.evaluate(move, 20)
            page.wait_for_timeout(50)
            c7 = cur()
            check("movement after resume is still relative", abs((c7[0] - c6[0]) - 20 * scale * 2) < 1.5,
                  f"moved {c7[0] - c6[0]:.1f}, expected {20 * scale * 2:.1f}")
            check("no console errors (high precision)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4c. skip intro: a long intro jumps to two seconds before the first note ----
            intro_map = os.path.join(out_dir, "intro.osz")
            make_intro_map(fixture, intro_map, 6000)
            r = Round(browser, base)
            page = r.page
            r.open_map(intro_map)
            r.play(autoplay=True)
            page.wait_for_function("window.osuDemo.playing === true", timeout=20000)
            page.wait_for_timeout(200)
            check("a long intro can be skipped", page.evaluate("window.osuDemo.skipAvailable") is True)
            page.keyboard.press("Escape")
            page.click("#pauseSettings")
            page.click("#kskip")
            page.keyboard.press("KeyQ")
            page.click("#closeSettings")
            resume_round(r)
            check("the skip key can be rebound", page.evaluate("window.osuDemo.skipKey") == "Q",
                  page.evaluate("window.osuDemo.skipKey"))
            t_before = r.song_time()
            page.keyboard.press("Space")
            page.wait_for_timeout(100)
            check("the old skip key does nothing", r.song_time() - t_before < 400,
                  f"{t_before:.0f} -> {r.song_time():.0f} ms")
            first_ms = page.evaluate("window.osuDemo.stats().firstTime")
            page.keyboard.press("KeyQ")
            page.wait_for_timeout(150)
            target = first_ms - 2000
            check("the skip key jumps two seconds before the first note", abs(r.song_time() - target) < 300,
                  f"t={r.song_time():.0f} ms, target {target:.0f} ms")
            check("the intro cannot be skipped twice", page.evaluate("window.osuDemo.skipAvailable") is False)
            health = page.evaluate("window.osuDemo.stats().health")
            check("skipping does not drain health", health > 0.99, f"health={health:.3f}")
            r.wait_for_end()
            stats = page.evaluate("window.osuDemo.stats()")
            check("autoplay still clears the map after the skip",
                  stats["finished"] == 1 and stats["miss"] == 0 and stats["accuracy"] >= 0.98,
                  f"accuracy={stats['accuracy']:.4f} miss={stats['miss']:.0f}")
            check("no console errors (skip intro)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4d. lead-in: a map whose first note is early starts its clock before the notes ----
            early_map = os.path.join(out_dir, "early.osz")
            make_early_map(fixture, early_map, 300)
            r = Round(browser, base)
            r.open_map(early_map)
            r.play(autoplay=True)
            r.page.wait_for_function("window.osuDemo.playing === true", timeout=20000)
            t_start = r.song_time()
            check("a map whose first note is early starts with a lead-in, as lazer gives it",
                  t_start < -1000, f"clock at start {t_start:.0f} ms")
            r.wait_for_end()
            st = r.page.evaluate("window.osuDemo.stats()")
            check("the early map plays to the end under autoplay",
                  st["finished"] == 1 and st["failed"] == 0 and st["miss"] == 0, f"miss={st['miss']:.0f}")
            check("no console errors (lead-in)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 4e. mods: difficulty, playfield, clock, flashlight and the fail rules ----
            # Each round is closed once its checks are done: several live rounds at once slow the page down enough
            # for autoplay to miss. The circle's body is sampled at (100, 127): its centre is a dark disc.
            mod_errors = []

            def done(rr):
                mod_errors.extend(rr.errors)
                rr.close()

            def pick_mods(rr, *ids):
                rr.page.evaluate(
                    "(ids) => { for (const id of ids) [...document.querySelectorAll('#mods .mod')]"
                    ".find((b) => b.textContent === id).click(); }", list(ids))

            def pressed_mods(rr):
                return rr.page.evaluate(
                    "[...document.querySelectorAll('#mods .mod[aria-pressed=\"true\"]')].map((b) => b.textContent)")

            def start_round(osz, *ids, autoplay=False):
                rr = Round(browser, base)
                rr.open_map(osz)
                if ids:
                    pick_mods(rr, *ids)
                rr.play(autoplay=autoplay)
                rr.page.wait_for_function("window.osuDemo.playing === true", timeout=20000)
                rr.page.wait_for_function("window.osuDemo.drawn === true", timeout=20000)
                return rr

            def clock_ratio(rr, seconds=3.0):
                """Song time per page time over a wait: 1 at normal speed, the rate with a rate mod."""
                t_a = rr.page.evaluate("window.osuDemo.stats().time")
                w_a = rr.page.evaluate("performance.now()")
                rr.page.wait_for_timeout(int(seconds * 1000))
                t_b = rr.page.evaluate("window.osuDemo.stats().time")
                w_b = rr.page.evaluate("performance.now()")
                return (t_b - t_a) / (w_b - w_a)

            mods_osz = make_mods_map(os.path.join(out_dir, "mods.osz"), MODS_OBJECTS)

            # A mod that conflicts with one on turns that one off, and the choice is kept across a reload.
            conflict = Round(browser, base)
            conflict.open_map(mods_osz)
            pick_mods(conflict, "EZ", "HR")
            check("Hard Rock turns Easy off (they cannot be on together)", pressed_mods(conflict) == ["HR"],
                  str(pressed_mods(conflict)))
            conflict.page.reload()
            conflict.page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            conflict.page.wait_for_function("document.querySelectorAll('#mods .mod').length > 0", timeout=20000)
            check("the mods are kept when the page is reloaded", pressed_mods(conflict) == ["HR"],
                  str(pressed_mods(conflict)))
            done(conflict)

            plain = start_round(mods_osz)
            s0 = plain.page.evaluate("window.osuDemo.stats()")
            c0 = plain.circles()
            p0 = plain.page.evaluate("window.osuDemo.sliderPoints(2)")
            check("with no mods: no label, rate 1, no flashlight, not hidden",
                  plain.page.evaluate("window.osuDemo.mods") == "" and plain.page.evaluate("window.osuDemo.rate") == 1
                  and plain.page.evaluate("window.osuDemo.flashlight") is None
                  and plain.page.evaluate("window.osuDemo.hidden") is False)
            done(plain)

            hr = start_round(mods_osz, "HR")
            sh = hr.page.evaluate("window.osuDemo.stats()")
            ch = hr.circles()
            ph = hr.page.evaluate("window.osuDemo.sliderPoints(2)")
            check("Hard Rock: circle size x1.3, approach rate, accuracy and health x1.4 (capped at 10)",
                  near(sh["cs"], s0["cs"] * 1.3) and near(sh["ar"], min(s0["ar"] * 1.4, 10))
                  and near(sh["od"], min(s0["od"] * 1.4, 10)) and near(sh["hp"], min(s0["hp"] * 1.4, 10)),
                  f"cs {sh['cs']:.2f} ar {sh['ar']:.2f} od {sh['od']:.2f} hp {sh['hp']:.2f}")
            check("Hard Rock flips the circles vertically",
                  len(ch) == len(c0) > 0 and all(near(a[2], b[2]) and near(a[3], 384 - b[3]) for a, b in zip(ch, c0)),
                  f"{c0} -> {ch}")
            check("Hard Rock flips the slider curve too",
                  len(p0) > 0 and all(near(ph[k], p0[k]) and near(ph[k + 1], 384 - p0[k + 1]) for k in range(0, len(p0), 2)),
                  f"{p0[:6]} -> {ph[:6]}")
            done(hr)

            ez = start_round(mods_osz, "EZ")
            se = ez.page.evaluate("window.osuDemo.stats()")
            check("Easy halves circle size, approach rate, accuracy and health",
                  all(near(se[k], s0[k] * 0.5) for k in ("cs", "ar", "od", "hp")),
                  f"cs {se['cs']} ar {se['ar']} od {se['od']} hp {se['hp']}")
            done(ez)

            mr = start_round(mods_osz, "MR")
            cm = mr.circles()
            pm = mr.page.evaluate("window.osuDemo.sliderPoints(2)")
            check("Mirror flips the circles horizontally",
                  len(cm) == len(c0) > 0 and all(near(a[2], 512 - b[2]) and near(a[3], b[3]) for a, b in zip(cm, c0)),
                  f"{c0} -> {cm}")
            check("Mirror flips the slider curve too",
                  len(p0) > 0 and all(near(pm[k], 512 - p0[k]) and near(pm[k + 1], p0[k + 1]) for k in range(0, len(p0), 2)),
                  f"{p0[:6]} -> {pm[:6]}")
            done(mr)

            dt = start_round(mods_osz, "DT")
            dt_ratio = clock_ratio(dt)
            check("Double Time: the rate is 1.5 and the song clock runs 1.5x",
                  dt.page.evaluate("window.osuDemo.rate") == 1.5 and 1.35 < dt_ratio < 1.65, f"ratio {dt_ratio:.3f}")
            done(dt)
            plain_clock = start_round(mods_osz)
            plain_ratio = clock_ratio(plain_clock)
            check("without a rate mod the clock runs at 1x", 0.9 < plain_ratio < 1.1, f"ratio {plain_ratio:.3f}")
            done(plain_clock)

            # Hidden: the first circle (start 2000 ms, preempt 600 ms) is gone from 0.3 preempt before its start, so
            # it is absent at 1900 ms and there at 1700 ms (before its fade-out ends); without the mod it is there.
            hd = start_round(mods_osz, "HD")
            check("Hidden is on", hd.page.evaluate("window.osuDemo.mods") == "HD" and hd.page.evaluate("window.osuDemo.hidden") is True)
            hd_pf, _ = canvases_at(hd, 1900)
            hd_px = image_pixel(hd_pf, 100, 127, hd.view())
            hd_early, _ = canvases_at(hd, 1700)
            hd_early_px = image_pixel(hd_early, 100, 127, hd.view())
            done(hd)
            plain_ref = start_round(mods_osz)
            plain_pf, plain_overlay = canvases_at(plain_ref, 1900)
            plain_px = image_pixel(plain_pf, 100, 127, plain_ref.view())
            plain_alpha = image_pixel(plain_overlay, 100, 127, plain_ref.view())[3]
            done(plain_ref)
            check("Hidden: the circle is gone before its hit time, and without the mod it is there",
                  sum(hd_px[:3]) < 60 and sum(hd_early_px[:3]) > 150 and sum(plain_px[:3]) > 150,
                  f"hidden at 1900 {hd_px}, hidden at 1700 {hd_early_px}, plain at 1900 {plain_px}")

            # Flashlight: the playfield is covered outside a light round the cursor, and the cursor's spot is clear.
            fl = start_round(mods_osz, "FL")
            fl_light = fl.page.evaluate("window.osuDemo.flashlight")
            cursor_now = fl.page.evaluate("window.osuDemo.cursor()")
            check("Flashlight: a light of 125 at the cursor at the start",
                  fl_light is not None and near(fl_light["r"], 125, 0.5)
                  and near(fl_light["x"], cursor_now["x"], 1) and near(fl_light["y"], cursor_now["y"], 1),
                  str(fl_light))
            _, fl_overlay = canvases_at(fl, 1900)
            far_alpha = image_pixel(fl_overlay, 100, 127, fl.view())[3]   # below the circle, where the number is not
            centre_alpha = image_pixel(fl_overlay, fl_light["x"], fl_light["y"], fl.view())[3]
            done(fl)
            check("Flashlight: the playfield outside the light is covered, and without the mod it is not",
                  far_alpha > 200 and plain_alpha == 0, f"alpha {far_alpha}, plain {plain_alpha}")
            check("Flashlight: the light itself is clear", centre_alpha < 10, f"alpha {centre_alpha}")

            sd = start_round(mods_osz, "SD")
            sd.wait_for_end(timeout=20000)
            ss = sd.page.evaluate("window.osuDemo.stats()")
            check("Sudden Death: the first miss fails the round, and nothing after it counts as a miss",
                  ss["failed"] == 1 and ss["miss"] == 1, f"failed {ss['failed']} miss {ss['miss']}")
            done(sd)

            pf = start_round(mods_osz, "PF", autoplay=True)
            pf.wait_for_end(timeout=30000)
            sp = pf.page.evaluate("window.osuDemo.stats()")
            check("Perfect: an autoplay run with only top results is not failed",
                  sp["failed"] == 0 and sp["finished"] == 1 and sp["miss"] == 0, f"accuracy {sp['accuracy']:.4f}")
            done(pf)

            nf_osz = make_mods_map(os.path.join(out_dir, "mods-60.osz"),
                                   [f"100,100,{1000 + 500 * i},1,0,0:0:0:0:" for i in range(60)])
            nf = start_round(nf_osz, "NF")
            nf.wait_for_end(timeout=90000)
            sn = nf.page.evaluate("window.osuDemo.stats()")
            check("No Fail: an idle run is never failed, though its health empties",
                  sn["failed"] == 0 and sn["finished"] == 1 and sn["miss"] == 60 and sn["health"] == 0,
                  f"failed {sn['failed']} finished {sn['finished']} miss {sn['miss']} health {sn['health']}")
            done(nf)

            check("no page errors (mods)", not [e for e in mod_errors if e.startswith("pageerror")],
                  "; ".join(mod_errors[:3])[:300])

            # ---- 5. skin ----
            r = Round(browser, base)
            page = r.page
            page.set_input_files("#sf", skin_file)
            page.wait_for_function("(name) => window.osuDemo.settings.skin === name", arg=skin_name, timeout=20000)
            sprites = page.evaluate("window.osuDemo.skinSprites")
            check("skin imports and becomes active", page.evaluate("window.osuDemo.settings.skin") == skin_name)
            check("skin sprites load", all(n in sprites for n in ("hitcircle", "approachcircle", "digit-1")),
                  ", ".join(sorted(sprites)))
            check("skin hit sound loads", page.evaluate("window.osuDemo.hasHitsound") is True)
            r.open_map(fixture)
            r.play(autoplay=True)
            r.wait_for_time(1700)
            # Pause to hold the frame, then probe the circle at (150,150). The pause panel dims
            # the frame to 40%, so the thresholds are loose: a green combo colour stays green.
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)                  # the song winds down first
            page.locator("#stage").screenshot(path=os.path.join(out_dir, "e2e_skin_probe.png"))
            px = pixel_at(os.path.join(out_dir, "e2e_skin_probe.png"), *CIRCLE_PROBE, r.view())
            print(f"skin probe: t={r.song_time():.0f} ms pixel rgb={px}")
            if skin_name == "test-skin":
                # The fixture skin sets green combo colours; the beatmap's own colours would win otherwise.
                check("skin combo colour shows on the hit circle (green, not the default orange)",
                      px[1] > 60 and px[0] < 40 and px[2] < 40, f"rgb={px}")
            # A skin change during a paused round applies at once, without a reload.
            page.click("#pauseSettings")
            before = page.evaluate(COLOUR_JS)
            page.select_option("#skin", "")
            first = page.evaluate("window.osuDemo.displayColours()[0]")
            check("switching to the default skin mid-round changes the combo colours at once",
                  first == [255, 192, 0], f"colour 1 = {first}")
            after = page.evaluate(COLOUR_JS)
            expected = [",".join(map(str, DEFAULT_COLOURS[k % len(DEFAULT_COLOURS)])) for k in before["raw"]]
            check("every object takes the default palette's colour after the switch, as a fresh round would",
                  after["shown"] == expected and after["raw"] == before["raw"],
                  f"{sum(a != e for a, e in zip(after['shown'], expected))} of {len(expected)} differ")
            page.select_option("#skin", skin_name)
            page.wait_for_function("(name) => window.osuDemo.settings.skin === name", arg=skin_name, timeout=20000)
            page.click("#closeSettings")
            # Resume and finish the map, so the skin's hit sound plays on every hit.
            resume_round(r)
            r.wait_for_end()
            stats = page.evaluate("window.osuDemo.stats()")
            check("skinned round completes with full accuracy", stats["finished"] == 1 and stats["accuracy"] >= 0.98,
                  f"accuracy={stats['accuracy']:.4f} miss={stats['miss']:.0f}")
            check("no console errors (skin)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 6. browser storage: a beatmap and a skin survive a reload ----
            r = Round(browser, base)
            page = r.page
            map_name = os.path.basename(fixture)
            r.open_map(fixture)
            page.set_input_files("#sf", skin_file)
            page.wait_for_function("(name) => window.osuDemo.settings.skin === name", arg=skin_name, timeout=20000)
            page.reload()
            page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            # The default look has its own hit circle, so wait for the saved skin and map to be in use and listed.
            page.wait_for_function("window.osuDemo.lookSource === 'chosen' && window.osuDemo.savedMaps.length > 0", timeout=20000)
            check("an opened beatmap is kept in the browser after a reload",
                  page.evaluate("window.osuDemo.savedMaps").count(map_name) == 1)
            check("an imported skin is kept in the browser after a reload", skin_name in option_values(page, "#skin"))
            check("the saved skin is applied again after a reload",
                  "hitcircle" in page.evaluate("window.osuDemo.skinSprites"))
            # The saved copy plays without its file: Play, Solo, pick it from the list, autoplay to the end.
            page.click("#menuPlay")
            page.click("#menuSolo")
            maps = lib_names(page)
            check("song select lists the saved beatmap", map_name in maps, str(maps))
            page.click(f"#lib button[data-name='{map_name}']")
            page.wait_for_function("window.osuDemo.difficultyCount > 0", timeout=20000)
            r.play(autoplay=True)
            r.wait_for_end()
            stats = page.evaluate("window.osuDemo.stats()")
            check("a saved beatmap opens from the list and plays to the end",
                  stats["finished"] == 1 and stats["miss"] == 0,
                  f"accuracy={stats['accuracy']:.4f} miss={stats['miss']:.0f}")
            # Forget removes the saved copy (the open map is selected, so Forget applies to it). The skin stays.
            page.click("#quit")                    # back to song select from the results screen
            page.click("#delMap")
            page.wait_for_function("document.querySelectorAll('#lib button').length === 0", timeout=10000)
            check("Forget removes the saved beatmap from the list", lib_names(page) == [])
            page.reload()
            page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            page.wait_for_function("window.osuDemo.lookSource === 'chosen'", timeout=20000)
            page.click("#menuPlay")
            page.click("#menuSolo")
            check("a forgotten beatmap stays forgotten after a reload", lib_names(page) == [] and page.is_visible("#libEmpty"))
            check("forgetting a beatmap keeps the skin", skin_name in option_values(page, "#skin"))
            check("no console errors (storage)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 11. song covers: a saved song shows its background, and an older save gets one ----
            cover_osz = make_cover_fixture(fixture, out_dir)
            r = Round(browser, base)
            r.open_map(cover_osz)
            r.page.wait_for_function("document.querySelectorAll('#lib .cover').length === 1 && "
                                     "document.querySelector('#lib .cover').naturalWidth > 0", timeout=20000)
            check("a saved song shows its background beside its name", True)
            # An older save has no cover: drop the field from the stored record, reload, and it comes back.
            r.page.evaluate("""() => new Promise((resolve, reject) => {
                const req = indexedDB.open('osuport');
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction('maps', 'readwrite');
                    const store = tx.objectStore('maps');
                    const all = store.getAll();
                    all.onsuccess = () => { for (const rec of all.result) { delete rec.cover; store.put(rec); } };
                    tx.oncomplete = () => { db.close(); resolve(true); };
                    tx.onerror = () => reject(tx.error);
                };
            })""")
            r.page.reload()
            r.page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            r.page.wait_for_function("document.querySelectorAll('#lib .cover').length === 1 && "
                                     "document.querySelector('#lib .cover').naturalWidth > 0", timeout=20000)
            check("an older saved song gets its background after a reload", True)
            check("no console errors (covers)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 7. browser storage blocked: the beatmap still opens and plays, and the page says so ----
            blocked = Round(browser, base,
                            init_script="IDBFactory.prototype.open = function () { throw new Error('blocked'); };")
            blocked.open_map(fixture)
            status = blocked.page.inner_text("#status")
            check("a beatmap still opens when browser storage is blocked",
                  blocked.page.evaluate("window.osuDemo.difficultyCount") > 0)
            check("the page says the beatmap will not be kept", "will not be kept" in status, status)
            check("the saved list stays empty when storage is blocked", lib_names(blocked.page) == [])
            blocked.play(autoplay=True)
            blocked.wait_for_end()
            stats = blocked.page.evaluate("window.osuDemo.stats()")
            check("a round with storage blocked still completes",
                  stats["finished"] == 1 and stats["miss"] == 0,
                  f"accuracy={stats['accuracy']:.4f} miss={stats['miss']:.0f}")
            check("no console errors (storage blocked)", not blocked.errors, "; ".join(blocked.errors[:3]))
            blocked.close()

            # ---- 8. menus: main menu, Play, Solo, settings, Esc going back, Enter starts a round ----
            r = Round(browser, base)
            page = r.page
            check("the game starts on the main menu", page.evaluate("window.osuDemo.screen") == "menu" and page.is_visible("#menu"))
            check("Edit is not in this port yet", page.is_disabled("#menuEdit"))
            page.click("#menuPlay")
            check("Play opens the play menu", page.is_visible("#playmenu") and not page.is_visible("#menu"))
            page.click("#menuSolo")
            check("Solo opens song select", page.evaluate("window.osuDemo.screen") == "select" and page.is_visible("#select"))
            check("song select has no beatmap yet", page.is_disabled("#play"))
            page.keyboard.press("Escape")
            check("Escape goes back to the play menu", page.is_visible("#playmenu"))
            page.keyboard.press("Escape")
            check("Escape goes back to the main menu", page.is_visible("#menu"))
            page.click("#settingsBtn")
            check("Settings opens from the main menu", page.is_visible("#settings"))
            page.click("#closeSettings")
            check("Settings closes again", not page.is_visible("#settings"))
            page.click("#menuExit")
            check("Exit says to close the tab", "Close this tab" in page.inner_text("#status"))
            page.click("#menuPlay")
            page.click("#menuSolo")
            r.open_map(fixture)
            page.keyboard.press("Enter")
            page.wait_for_function("window.osuDemo.playing === true", timeout=20000)
            check("Enter starts a round from song select", page.evaluate("window.osuDemo.playing") is True)
            check("no console errors (menus)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # ---- 9. beatmap video ----
            video_osz, missing_osz, skin_osz, flv_osz = make_videos(fixture, out_dir)
            r = Round(browser, base)
            r.open_map(video_osz)
            r.play(autoplay=True)
            r.wait_for_time(2000)
            v = r.page.evaluate("window.osuDemo.video")
            check("the map's video loads and shows from its start",
                  v["loaded"] and v["shown"] and not v["broken"] and v["veil"] == 0.5, str(v))
            song_s = r.song_time() / 1000
            check("the video follows the song clock",
                  abs(v["time"] - (song_s - v["start"] / 1000)) < 0.5,
                  f"video={v['time']:.2f}s song={song_s:.2f}s")
            r.page.locator("#stage").screenshot(path=os.path.join(out_dir, "e2e_video.png"))
            shot = Image.open(os.path.join(out_dir, "e2e_video.png")).convert("L")
            mean = sum(shot.getdata()) / (shot.width * shot.height)
            check("the video shows behind the playfield, dimmed", mean > 12, f"mean luminance {mean:.1f}")
            r.page.keyboard.press("Escape")
            r.page.wait_for_timeout(300)
            t_paused = r.page.evaluate("window.osuDemo.video.time")
            r.page.wait_for_timeout(800)
            v = r.page.evaluate("window.osuDemo.video")
            check("the video holds still while the round is paused",
                  v["paused"] and abs(v["time"] - t_paused) < 0.05, f"{t_paused:.2f}s -> {v['time']:.2f}s")
            resume_round(r, via_escape=False)
            r.page.wait_for_timeout(600)
            v = r.page.evaluate("window.osuDemo.video")
            check("the video carries on when the round resumes", not v["paused"] and v["shown"],
                  f"time={v['time']:.2f}s")
            r.wait_for_end()
            # Judgement depends on the frame rate. Decoding the video costs a lot of frames in this
            # software-rendered browser (about 17 fps without it, about 10 with), so only require a
            # completed round with most notes hit, not the full-accuracy check the other rounds make.
            st = r.page.evaluate("window.osuDemo.stats()")
            check("the video round completes and is mostly hit",
                  st["finished"] == 1 and st["failed"] == 0 and st["accuracy"] > 0.8,
                  f"accuracy={st['accuracy']:.3f} miss={st['miss']:.0f}")
            check("no console errors (video)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            r = Round(browser, base)
            r.open_map(missing_osz)
            r.play(autoplay=True)
            r.wait_for_time(1500)
            v = r.page.evaluate("window.osuDemo.video")
            check("a map whose video file is missing plays without one",
                  not v["loaded"] and not v["shown"] and r.page.evaluate("window.osuDemo.playing") is True)
            r.wait_for_end()
            check("the round without its video completes", r.page.evaluate("window.osuDemo.stats().miss") == 0)
            check("no console errors (missing video)", not r.errors, "; ".join(r.errors[:3]))
            r.close()

            # A video the browser cannot play is converted to WebM in the page (transcode.js). The real
            # converter comes from the CDN, which the test sandbox cannot reach, so ffmpeg_stub.js stands in
            # for it and hands back converted.webm. The checks are about what the page does around the
            # converter: the round does not wait for it, the progress shows, the result plays, a second play
            # reuses the stored copy, and a converter that cannot be reached says why.
            stub_js = read_text(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ffmpeg_stub.js"))
            with open(os.path.join(out_dir, "converted.webm"), "rb") as f:
                converted_webm = f.read()

            r = Round(browser, base)
            route_converter(r, stub_js, converted_webm)
            r.open_map(flv_osz)
            r.play(autoplay=True)
            r.wait_for_time(300)
            v = r.page.evaluate("window.osuDemo.video")
            check("an FLV video starts converting, and the round does not wait for it",
                  r.page.evaluate("window.osuDemo.playing") is True and not v["loaded"] and "Converting" in v["note"],
                  v["note"])
            r.page.wait_for_function("window.osuDemo.video.note.indexOf('50%') >= 0", timeout=20000)
            check("the notice shows the conversion's progress", True,
                  r.page.evaluate("window.osuDemo.video.note"))
            r.page.wait_for_function("window.osuDemo.video.loaded === true", timeout=30000)
            v = r.page.evaluate("window.osuDemo.video")
            check("the converted video is shown, and says it was converted",
                  v["converted"] and v["shown"] and not v["broken"] and v["note"] == "", str(v))
            args = r.page.evaluate("window.__ffArgs || []")
            check("the converter is asked for a sound-free WebM (libvpx)",
                  "-an" in args and "libvpx" in args and args[-1] == "out.webm", " ".join(args))
            check("the converter ran once", r.page.evaluate("window.__ffExecs") == 1)
            r.wait_for_end()
            st = r.page.evaluate("window.osuDemo.stats()")
            check("the round with a converted video completes and is mostly hit",
                  st["finished"] == 1 and st["failed"] == 0 and st["accuracy"] > 0.8,
                  f"accuracy={st['accuracy']:.3f} miss={st['miss']:.0f}")
            check("no console errors (converted video)", not r.errors, "; ".join(r.errors[:3]))

            # The same map again, after a reload: the converted copy comes from IndexedDB, so no conversion.
            r.page.reload()
            r.page.wait_for_function("window.osuDemo && window.osuDemo.ready", timeout=20000)
            r.open_map(flv_osz)
            r.play(autoplay=True)
            r.page.wait_for_function("window.osuDemo.video.loaded === true", timeout=20000)
            check("a converted video is kept, so playing it again does not convert it",
                  r.page.evaluate("window.__ffExecs || 0") == 0 and r.page.evaluate("window.osuDemo.video.converted") is True)
            r.close()

            # No converter (the CDN cannot be reached): the round still plays, and the page says why.
            r = Round(browser, base)
            r.context.route("https://cdn.jsdelivr.net/**", lambda route: route.abort())
            r.open_map(flv_osz)
            r.play(autoplay=True)
            r.page.wait_for_function("window.osuDemo.video.note.indexOf('could not be converted') >= 0", timeout=30000)
            v = r.page.evaluate("window.osuDemo.video")
            check("without the converter, the FLV video is left out and the page says why",
                  not v["shown"] and "FLV" in v["note"] and "could not be loaded" in v["note"], v["note"])
            r.page.locator("#videoNote").screenshot(path=os.path.join(out_dir, "e2e_video_note.png"))
            r.wait_for_end()
            check("the round without its video completes", r.page.evaluate("window.osuDemo.stats().miss") == 0)
            check("no page errors (no converter)", not [e for e in r.errors if e.startswith("pageerror")],
                  "; ".join(r.errors[:3]))
            r.close()

            # A converter that never starts is reported after a while, instead of the notice staying at 0% for
            # good. Once it can start, the same page converts the next video.
            r = Round(browser, base, init_script="window.__ffHang = true")
            route_converter(r, stub_js, converted_webm)
            r.open_map(flv_osz)
            r.play(autoplay=True)
            r.page.wait_for_function("window.osuDemo.video.note.indexOf('could not be converted') >= 0", timeout=60000)
            note = r.page.evaluate("window.osuDemo.video.note")
            check("a converter that never starts is reported, not waited for", "did not start" in note, note)
            r.wait_for_end()
            r.page.evaluate("window.__ffHang = false")
            r.open_map(flv_osz)
            r.play(autoplay=True)
            r.page.wait_for_function("window.osuDemo.video.loaded === true", timeout=60000)
            check("after that, the next video converts", r.page.evaluate("window.osuDemo.video.converted") is True)
            check("no page errors (converter hang)", not [e for e in r.errors if e.startswith("pageerror")],
                  "; ".join(r.errors[:3]))
            r.close()

            # ---- 10. looks and the settings that choose them ----
            def look(init, osz):
                rr = Round(browser, base, init_script=init)
                rr.open_map(osz)
                rr.play()
                rr.wait_for_time(200)
                out = (rr.page.evaluate("window.osuDemo.lookSource"),
                       rr.page.evaluate("window.osuDemo.skinSprites"))
                rr.close()
                return out

            def settings_script(values):
                return ("localStorage.setItem('osuport.settings', JSON.stringify(" + json.dumps(values) + "));")

            src_, sprites_ = look(None, skin_osz)
            check("a beatmap's own hit circle is used, with the rest of the Argon look around it",
                  src_ == "beatmap" and "hitcircle" in sprites_ and "approachcircle" in sprites_ and "glow" in sprites_,
                  f"{src_} {sprites_}")
            src_, sprites_ = look(settings_script({"beatmapSkins": False}), skin_osz)
            check("turning Beatmap skins off ignores the map's own files", src_ == "argon", src_)
            src_, _ = look(settings_script({"defaultLook": "flat"}), fixture)
            check("the Flat default look draws plain shapes", src_ == "flat", src_)
            src_, _ = look(None, fixture)
            check("a map with no skin files keeps the Argon look", src_ == "argon", src_)

            # ---- 11. HUD: where the counters sit, and the skin's own digits and health bar ----
            # The HUD is on the overlay, so the opaque pixels in each corner show where it is drawn.
            def opaque(img, box):
                w, h = img.size
                crop = img.getchannel("A").crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
                return sum(crop.histogram()[129:])

            skin_names = [n.lower() for n in zipfile.ZipFile(skin_file).namelist()]
            skin_has = lambda name: any(n == name or n.endswith("/" + name) for n in skin_names)
            skin_combo = skin_has("combo-0.png") or skin_has("combo-0@2x.png")
            skin_bar = skin_has("scorebar-bg.png") or skin_has("scorebar-bg@2x.png")

            def hud_counts(rr):
                rr.wait_for_time(3000)
                ms = rr.page.evaluate("window.osuDemo.stats().time")
                combo = rr.page.evaluate("window.osuDemo.stats().combo")
                _, ov = canvases_at(rr, ms)
                return combo, {
                    "bottom-left": opaque(ov, (0, 0.8, 0.3, 1)),
                    "top-left": opaque(ov, (0, 0, 0.3, 0.1)),
                    "top-right": opaque(ov, (0.75, 0, 1, 0.2)),
                    "bottom-right": opaque(ov, (0.75, 0.8, 1, 1)),
                }

            r = Round(browser, base)
            r.open_map(fixture)
            r.play(autoplay=True)
            combo_, counts = hud_counts(r)
            print(f"HUD, default look: combo={combo_} {counts}")
            check("the default combo counter is bottom left, the score and accuracy top right",
                  combo_ >= 1 and counts["bottom-left"] > 300 and counts["top-right"] > 200,
                  str(counts))
            check("the default health bar is top left", counts["top-left"] > 500, str(counts))
            check("the default HUD leaves the bottom right clear while no keys are shown",
                  counts["bottom-right"] < 50, str(counts))
            check("no page errors (default HUD)", not [e for e in r.errors if e.startswith("pageerror")],
                  "; ".join(r.errors[:3]))
            r.close()

            r = Round(browser, base)
            r.page.set_input_files("#sf", skin_file)
            r.page.wait_for_function("(name) => window.osuDemo.settings.skin === name", arg=skin_name, timeout=20000)
            r.open_map(fixture)
            r.play(autoplay=True)
            sprites_ = r.page.evaluate("window.osuDemo.skinSprites")
            combo_, counts = hud_counts(r)
            print(f"HUD, skin: combo={combo_} {counts} sprites with combo={[s for s in sprites_ if s.startswith('combo')]}")
            check("the skin's combo digits load when the skin has them",
                  (not skin_combo) or "combo-0" in sprites_, f"skin has combo digits: {skin_combo}")
            check("the skin's health bar loads when the skin has one",
                  (not skin_bar) or "scorebar-bg" in sprites_, f"skin has a bar: {skin_bar}")
            check("with the skin, the combo is bottom left and the score and accuracy top right",
                  combo_ >= 1 and counts["bottom-left"] > 300 and counts["top-right"] > 200, str(counts))
            if skin_bar:
                check("the skin's own health bar is top left", counts["top-left"] > 500, str(counts))
            check("no page errors (skin HUD)", not [e for e in r.errors if e.startswith("pageerror")],
                  "; ".join(r.errors[:3]))
            r.close()

            browser.close()
    finally:
        httpd.shutdown()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: " + ", ".join(failures))
        sys.exit(1)
    print("ALL E2E CHECKS PASSED")


if __name__ == "__main__":
    main()
