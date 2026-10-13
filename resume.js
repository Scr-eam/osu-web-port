// Lazer's resume prompt. After a pause, the round waits until the player clicks an orange cursor that
// sits where the game cursor was at the pause, with the message above it. It is shown only when the
// pointer is over the window; otherwise the round carries on at once, as lazer does.
//
// From osu.Game/Screens/Play/ResumeOverlay.cs: the message (30 units, yellow, shadowed, 40% down the
// screen), TRANSITION_TIME 500 ms for its fades, OutQuint throughout.
// From osu.Game.Rulesets.Osu/UI/OsuResumeOverlay.cs: the cursor starts at 4x and shrinks to 1x over
// 1000 ms, fades from white to orange over 400 ms (white while the pointer is on it), and on a click
// grows to 2x while the overlay fades out.

export const RESUME_MESSAGE = "Click the orange cursor to resume";
// How close, in playfield units, the pointer must be to the orange cursor to hover it.
export const RESUME_HIT = 24;

const FADE = 500;          // TRANSITION_TIME: the overlay's fades and the click's growth
const APPEAR = 1000;       // the cursor shrinks from 4x to 1x over this long
const COLOUR = 400;        // the cursor's change between orange and white
const START_SCALE = 4;
const CLICK_SCALE = 2;
const ORANGE_G = 165 / 255;   // osuTK's Color4.Orange is (255, 165, 0)

const outQuint = (p) => 1 - (1 - p) ** 5;

// A value that moves from `from` to `to`, starting at `at` (ms) and lasting `dur` ms.
const tween = (from, to, at, dur) => ({ from, to, at, dur });
function valueOf(tw, now) {
  if (now <= tw.at) return tw.from;
  if (now >= tw.at + tw.dur) return tw.to;
  return tw.from + (tw.to - tw.from) * outQuint((now - tw.at) / tw.dur);
}

// The prompt's state machine. Times are in ms on one clock (performance.now() in the player).
//   show(now, x, y)   the prompt appears, with its cursor at playfield point (x, y)
//   hover(now, on)    the pointer is (or is not) on the orange cursor
//   click(now)        a press on the cursor: true when it was hovered, and the prompt starts to leave
//   cancel()          the prompt goes at once (the pause menu takes over)
//   frame(now)        what to draw, or null once the prompt has gone
export function createResume() {
  let s = null;

  return {
    show(now, x, y) {
      s = {
        x,
        y,
        hovered: false,
        leaving: false,
        alpha: tween(0, 1, now, FADE),
        scale: tween(START_SCALE, 1, now, APPEAR),
        mix: tween(1, 0, now, COLOUR),      // 1 is white, 0 orange; the cursor starts white and turns orange
      };
    },
    // True while the cursor can still be clicked to resume.
    get waiting() {
      return !!s && !s.leaving;
    },
    // Where the orange cursor is, in playfield units, or null when there is no prompt.
    origin() {
      return s ? { x: s.x, y: s.y } : null;
    },
    hover(now, on) {
      if (!s || s.leaving || on === s.hovered) return;
      s.hovered = on;
      s.mix = tween(valueOf(s.mix, now), on ? 1 : 0, now, COLOUR);
    },
    click(now) {
      if (!s || s.leaving || !s.hovered) return false;
      s.leaving = true;
      s.scale = tween(valueOf(s.scale, now), CLICK_SCALE, now, FADE);
      s.alpha = tween(valueOf(s.alpha, now), 0, now, FADE);
      return true;
    },
    cancel() {
      s = null;
    },
    frame(now) {
      if (!s) return null;
      if (s.leaving && now >= s.alpha.at + s.alpha.dur) {
        s = null;
        return null;
      }
      return {
        x: s.x,
        y: s.y,
        alpha: valueOf(s.alpha, now),
        scale: valueOf(s.scale, now),
        mix: valueOf(s.mix, now),
      };
    },
  };
}

// The orange cursor's colour for a mix (1 white, 0 orange), as the renderer's 0..1 RGB.
export function cursorTint(mix) {
  return [1, ORANGE_G + (1 - ORANGE_G) * mix, mix];
}

const FONT = '"Torus", "Nunito Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

// Draws the message on the overlay canvas, w x h pixels. Lazer's units are 1080 px tall, so u is 1 there.
export function drawResumeText(ctx, layer, w, h) {
  if (!layer || layer.alpha <= 0) return;
  const u = h / 1080;
  ctx.save();
  ctx.globalAlpha = layer.alpha;
  ctx.font = `500 ${30 * u}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${5 * u}px`;
  ctx.fillStyle = "#ffcc22";                  // OsuColour.Yellow
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowOffsetY = 0.05 * 30 * u;
  ctx.fillText(RESUME_MESSAGE, w / 2, h * 0.4);
  ctx.restore();
}
