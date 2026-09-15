/**
 * Monotonic clock, measured refresh interval, and dropped-frame accounting.
 *
 * Three facts this module exists to hold, from docs/assessment-design.md 2.5
 * and 2.8:
 *
 *   1. Every timestamp in the app comes from one monotonic origin.
 *      `performance.now()`, never `Date.now()`. Wall clock moves under NTP
 *      correction, DST, and a user setting the clock, and any of those inside
 *      a session would silently corrupt every latency in it.
 *
 *   2. The refresh interval is measured, never assumed. A stimulus drawn in a
 *      rAF callback presents at the next vsync, so onset is the callback
 *      timestamp plus one interval. Assuming 16.67 ms on a 165 Hz panel puts
 *      every onset 10.6 ms late.
 *
 *   3. Dropped frames around an onset make that onset uncertain, so they are
 *      counted per trial rather than ignored.
 *
 * Nothing here touches the DOM or calls rAF. The driver injects time, which
 * is what lets test/timing.test.js run the whole scheduler against a
 * synthetic clock at 60, 120 and 165 Hz.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceClock = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /** Intervals sampled before the median is trusted. Two seconds at 60 Hz. */
  const REFRESH_SAMPLES = 120;

  /** Gaps outside this band are not refresh intervals. 300 Hz to 8 Hz. */
  const MIN_PLAUSIBLE_GAP_MS = 3.2;
  const MAX_PLAUSIBLE_GAP_MS = 125;

  /** Until the meter has converged, assume the commonest panel. */
  const FALLBACK_INTERVAL_MS = 1000 / 60;

  /**
   * Rolling median of frame-to-frame gaps.
   *
   * Median rather than mean because a single 200 ms hitch from a garbage
   * collection or a window move would drag a mean far enough to matter and
   * leaves a median untouched.
   */
  function createRefreshMeter() {
    const gaps = new Float64Array(REFRESH_SAMPLES);
    const scratch = new Float64Array(REFRESH_SAMPLES);
    let write = 0;
    let filled = 0;
    let last = null;
    let interval = null;
    let sinceRecompute = 0;

    function recompute() {
      scratch.set(gaps.subarray(0, filled));
      const view = scratch.subarray(0, filled);
      Array.prototype.sort.call(view, (a, b) => a - b);
      const mid = filled >> 1;
      interval =
        filled % 2 ? view[mid] : (view[mid - 1] + view[mid]) / 2;
    }

    return {
      /**
       * Feed one frame timestamp.
       * Returns the gap since the previous frame, or null on the first.
       */
      sample(t) {
        if (last === null) {
          last = t;
          return null;
        }
        const gap = t - last;
        last = t;
        if (gap >= MIN_PLAUSIBLE_GAP_MS && gap <= MAX_PLAUSIBLE_GAP_MS) {
          gaps[write] = gap;
          write = (write + 1) % REFRESH_SAMPLES;
          if (filled < REFRESH_SAMPLES) filled += 1;
          sinceRecompute += 1;
          if (filled >= 12 && sinceRecompute >= 12) {
            sinceRecompute = 0;
            recompute();
          }
        }
        return gap;
      },

      /** Measured interval in ms, or the fallback before convergence. */
      intervalMs() {
        return interval === null ? FALLBACK_INTERVAL_MS : interval;
      },

      /** True once the median rests on a full window. */
      converged() {
        return filled >= REFRESH_SAMPLES;
      },

      hz() {
        return 1000 / this.intervalMs();
      },

      /**
       * Frames the compositor missed across one gap.
       * A 33.4 ms gap on a 16.67 ms panel is one dropped frame.
       */
      droppedIn(gap) {
        if (gap === null) return 0;
        const n = Math.round(gap / this.intervalMs()) - 1;
        return n > 0 ? n : 0;
      },

      reset() {
        write = 0;
        filled = 0;
        last = null;
        interval = null;
        sinceRecompute = 0;
      },
    };
  }

  /**
   * Fixed-timestep advance.
   *
   * The whole reason this exists: a state machine stepped once per frame
   * changes state at different simulated times on different panels. Stepped
   * on a fixed grid against elapsed monotonic time, it changes state at the
   * same simulated time everywhere, and the only difference between 60 Hz and
   * 165 Hz is how many steps run inside one callback.
   *
   * STEP_MS is 1. It has to be below one frame interval at the fastest panel
   * the app supports, or a frame could span no steps at all and a phase
   * boundary would land a whole frame late on that panel only. One
   * millisecond is comfortably under the 6.06 ms interval of a 165 Hz panel
   * and under the 2.78 ms of a 360 Hz one, and it makes the residual
   * scheduling quantisation smaller than every real term in the timing chain:
   * USB HID polling alone has an SD of 2.3 ms.
   *
   * The cost is a thousand steps a second. Each one is a handful of integer
   * comparisons on a state machine, so it does not register against the
   * MediaPipe inference the tracker subprocess is doing on the same CPU.
   *
   * Nothing is clamped silently. A long stall advances simulated time by the
   * full amount and raises `stalled`, because a trial that spanned a stall is
   * a trial to invalidate, not a trial to quietly stretch.
   */
  const STEP_MS = 1;

  /** A gap this long is a stall, not a slow frame. Flagged, not hidden. */
  const STALL_MS = 100;

  /** Ceiling on one advance, so a suspend-resume cannot run 900k steps. */
  const MAX_ADVANCE_MS = 2000;

  function createStepper(stepMs) {
    const step = stepMs || STEP_MS;
    let sim = 0;
    let accumulator = 0;
    let lastReal = null;
    let realAtSimZero = 0;
    let stalled = false;
    let desynced = false;

    return {
      stepMs: step,

      /** Anchor simulated time zero to a real monotonic timestamp. */
      start(realNow) {
        sim = 0;
        accumulator = 0;
        lastReal = realNow;
        realAtSimZero = realNow;
        stalled = false;
        desynced = false;
      },

      /**
       * Run whole steps for the real time elapsed since the last advance.
       * `onStep(simTime, stepMs)` is called once per step, in order.
       * Returns the number of steps run.
       */
      advance(realNow, onStep) {
        if (lastReal === null) this.start(realNow);
        let elapsed = realNow - lastReal;
        lastReal = realNow;
        if (elapsed < 0) elapsed = 0;
        if (elapsed >= STALL_MS) stalled = true;
        if (elapsed > MAX_ADVANCE_MS) {
          desynced = true;
          elapsed = MAX_ADVANCE_MS;
        }
        accumulator += elapsed;
        let ran = 0;
        while (accumulator >= step) {
          accumulator -= step;
          sim += step;
          onStep(sim, step);
          ran += 1;
        }
        return ran;
      },

      /** Simulated time, in ms since start. */
      now() {
        return sim;
      },

      /** Real monotonic time that corresponds to a simulated time. */
      toReal(simTime) {
        return realAtSimZero + simTime;
      },

      /** Raised by a gap over 100 ms. Read and cleared per trial. */
      takeStall() {
        const was = stalled;
        stalled = false;
        return was;
      },

      desynced() {
        return desynced;
      },
    };
  }

  /**
   * The real monotonic reading. One function so a grep for `Date.now` in the
   * renderer finds nothing that feeds a measurement.
   */
  function now() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Number(process.hrtime.bigint() / 1000n) / 1000;
  }

  return {
    createRefreshMeter,
    createStepper,
    now,
    STEP_MS,
    STALL_MS,
    REFRESH_SAMPLES,
    FALLBACK_INTERVAL_MS,
  };
});
