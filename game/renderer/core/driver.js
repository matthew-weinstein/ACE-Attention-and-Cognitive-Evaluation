/**
 * The one animation loop in the app.
 *
 * Every screen shares it. Nothing else calls requestAnimationFrame, and
 * nothing anywhere calls setInterval or setTimeout for anything that touches
 * a measurement.
 *
 * Three things it does that matter.
 *
 * Splits logic from rendering. Measurement logic runs on the fixed grid in
 * AceClock.createStepper, so a trial changes state at the same simulated time
 * on a 60 Hz panel and a 165 Hz one. Rendering runs at panel rate with delta
 * time, so motion looks the same and the numbers do not depend on it.
 *
 * Renders on change, not on tick. A scene paints only when it says it is
 * dirty. Signal Watch shows a static craft for 250 ms and then nothing for
 * 1550 ms, so it paints twice a trial instead of 330 times at 165 Hz. That is
 * the largest single thing keeping the renderer off the CPU the tracker
 * subprocess needs. On a clean frame the loop reads a timestamp, runs one to
 * four integer comparisons, and returns.
 *
 * Stamps stimulus onset honestly. A scene asks for an onset stamp; the driver
 * resolves it after the paint that actually showed the stimulus, as the rAF
 * callback timestamp plus one measured refresh interval, because the frame
 * drawn in a callback presents at the next vsync. It reports dropped frames
 * in the window before that onset alongside it, so a trial whose onset time
 * is uncertain can be flagged rather than trusted.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceDriver = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  const Clock =
    typeof module === "object" && module.exports
      ? require("./clock.js")
      : root.AceClock;

  /** How far back an onset looks for dropped frames. 2.5 in the design. */
  const ONSET_LOOKBACK_MS = 100;

  /** Frames kept for that lookback. 165 Hz needs 17, this is slack. */
  const HISTORY = 64;

  function createDriver(options) {
    const opts = options || {};
    const raf =
      opts.requestFrame ||
      ((cb) => requestAnimationFrame(cb));
    const cancel = opts.cancelFrame || ((id) => cancelAnimationFrame(id));

    // Injectable so the whole loop can be driven by a synthetic clock in
    // test/timing.test.js. Nothing in the app passes it.
    const readNow = opts.now || Clock.now;

    const meter = Clock.createRefreshMeter();
    const stepper = Clock.createStepper(opts.stepMs);

    const histT = new Float64Array(HISTORY);
    const histDropped = new Uint8Array(HISTORY);
    let histWrite = 0;

    let scene = null;
    let handle = null;
    let running = false;
    let lastT = null;
    let dirty = true;
    let onsetWaiting = null;
    let totalDropped = 0;
    let paints = 0;
    let convergedWaiters = [];

    function recordFrame(t, gap) {
      const dropped = meter.droppedIn(gap);
      totalDropped += dropped;
      histT[histWrite] = t;
      histDropped[histWrite] = dropped > 255 ? 255 : dropped;
      histWrite = (histWrite + 1) % HISTORY;
      return dropped;
    }

    /** Frames dropped in the `ms` before `t`. Used to judge an onset. */
    function droppedBefore(t, ms) {
      let sum = 0;
      for (let i = 0; i < HISTORY; i++) {
        if (histT[i] === 0) continue;
        if (t - histT[i] <= ms && histT[i] <= t) sum += histDropped[i];
      }
      return sum;
    }

    function frameCallback(t) {
      if (!running) return;
      handle = raf(frameCallback);

      const gap = meter.sample(t);
      recordFrame(t, gap);

      if (convergedWaiters.length && meter.converged()) {
        const waiting = convergedWaiters;
        convergedWaiters = [];
        for (const resolve of waiting) resolve(meter.intervalMs());
      }
      const dt = lastT === null ? 0 : t - lastT;
      lastT = t;

      if (!scene) return;

      // 1. Measurement logic, on the fixed grid.
      if (scene.step) {
        stepper.advance(t, scene.step);
      }

      // 2. Paint, only if something changed.
      if (dirty && scene.draw) {
        dirty = false;
        paints += 1;
        scene.draw(t, dt);

        // 3. Resolve any onset the scene asked for during that paint.
        if (onsetWaiting) {
          const interval = meter.intervalMs();
          const onset = t + interval;
          const request = onsetWaiting;
          onsetWaiting = null;
          request(onset, {
            refreshIntervalMs: interval,
            framesDropped: droppedBefore(t, ONSET_LOOKBACK_MS),
            stalled: stepper.takeStall(),
          });
        }
      }
    }

    return {
      meter,
      stepper,

      /**
       * Hand the loop to a scene. `{ step(sim, stepMs), draw(t, dt) }`.
       * Both are optional. A scene with neither is a still screen and costs
       * one function call a frame.
       */
      setScene(next) {
        scene = next;
        dirty = true;
        onsetWaiting = null;
        stepper.start(lastT === null ? readNow() : lastT);
      },

      clearScene() {
        scene = null;
      },

      start() {
        if (running) return;
        running = true;
        lastT = null;
        handle = raf(frameCallback);
      },

      stop() {
        running = false;
        if (handle !== null) cancel(handle);
        handle = null;
      },

      /**
       * Resolve once the refresh median rests on a full window of samples.
       *
       * No stimulus may be presented before this settles. Until it does, the
       * onset stamp would add a fallback interval rather than the real one,
       * which on a 165 Hz panel puts the first onsets 10.6 ms late. The
       * session waits for it during the camera check, where it costs nothing:
       * 120 samples is two seconds at 60 Hz and under one at 165 Hz.
       */
      whenConverged() {
        if (meter.converged()) return Promise.resolve(meter.intervalMs());
        return new Promise((resolve) => convergedWaiters.push(resolve));
      },

      /** Ask for a paint. Cheap and idempotent within a frame. */
      invalidate() {
        dirty = true;
      },

      /**
       * Stamp the onset of whatever the next paint shows.
       *
       * `resolve(onsetMs, quality)` is called once, after that paint. The
       * onset is the callback timestamp plus one measured interval, which is
       * when the drawn frame reaches the panel.
       */
      stampOnset(resolve) {
        onsetWaiting = resolve;
        dirty = true;
      },

      /** Measured panel interval, in ms. */
      intervalMs: () => meter.intervalMs(),
      hz: () => meter.hz(),
      refreshConverged: () => meter.converged(),
      framesDropped: () => totalDropped,
      paintCount: () => paints,
      droppedBefore,

      ONSET_LOOKBACK_MS,
    };
  }

  return { createDriver, ONSET_LOOKBACK_MS };
});
