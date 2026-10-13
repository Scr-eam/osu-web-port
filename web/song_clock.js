// The song's position through a pause. The song plays on the audio clock at the round's rate. Pausing
// does not stop it at once: as in lazer, the track slows to a stop over a short ramp, and resuming
// speeds it back up, so the notes slow with the music. The ramps take a little of the song's time
// off it, and this keeps count of that.
//
// Times are audio-context seconds. The speed is a share of full speed: 1 while the song runs, 0 when
// it is stopped, and a straight line between the two while it ramps. The song has moved
//   rate * (time since zero - the time the ramps took off it)
// and that is exact for any sequence of ramps, since each ramp is linear.

export function createSongClock() {
  let zero = 0;          // audio time of song zero
  let rate = 1;          // song seconds per audio second at full speed
  let at = 0;            // audio time of the last change
  let lost = 0;          // audio seconds the ramps took off the song, up to `at`
  let speed = 1;         // share of full speed at `at`
  let ramp = null;       // { end, speed }: from `speed` at `at`, a straight line to `speed` at `end`

  // The share of full speed at audio time c.
  function speedAt(c) {
    if (!ramp) return speed;
    if (c >= ramp.end) return ramp.speed;
    return speed + (ramp.speed - speed) * (c - at) / (ramp.end - at);
  }

  // The audio seconds the song has lost since zero, at audio time c. The average speed over a straight
  // line is the mean of its ends, so this is exact. Times before `at` extend the same line back, which
  // is right for the output latency that reads a little behind the audio being rendered.
  function lostAt(c) {
    const end = ramp ? Math.min(c, ramp.end) : c;
    let total = lost + (end - at) * (1 - (speed + speedAt(end)) / 2);
    if (ramp && c > ramp.end) total += (c - ramp.end) * (1 - ramp.speed);
    return total;
  }

  return {
    // Starts a song whose zero is at audio time zeroAt and that plays at playRate song seconds per second.
    reset(zeroAt, playRate) {
      zero = zeroAt;
      rate = playRate;
      at = zeroAt;
      lost = 0;
      speed = 1;
      ramp = null;
    },
    // The song position in song seconds at audio time c.
    songAt(c) {
      return (c - zero - lostAt(c)) * rate;
    },
    // The share of full speed at audio time c (1 running, 0 stopped).
    speedAt,
    // True while a ramp is still under way at audio time c.
    rampingAt(c) {
      return !!ramp && c < ramp.end;
    },
    // Changes the speed to target from audio time c, over `seconds` (0 changes it at once). Returns the
    // speed at c, where the change starts, so the audio can start its own ramp from the same point.
    change(c, target, seconds) {
      const start = speedAt(c);
      lost = lostAt(c);
      at = c;
      speed = start;
      ramp = seconds > 0 ? { end: c + seconds, speed: target } : null;
      if (seconds <= 0) speed = target;
      return start;
    },
  };
}
