/**
 * The trial machine the timed games share.
 *
 * Signal Watch, Asteroid Run and Look Away are the same shape: a lead-in, a
 * stimulus with a fixed duration, a response window measured from the onset
 * that actually reached the panel, and a fixed onset-to-onset period. Writing
 * that three times would mean three slightly different definitions of when a
 * response window closes, which is exactly the kind of drift that makes two
 * games' reaction times not comparable.
 *
 * Everything here is stated in milliseconds and stepped on the fixed grid.
 * There is no frame count anywhere in this file.
 *
 * ── Two decisions worth reading ────────────────────────────────────────────
 *
 * The response window is measured from the stamped onset in real monotonic
 * time, not from simulated time. Simulated time says when the machine decided
 * to show the stimulus. The stamp says when the panel showed it. Those differ
 * by up to one frame interval and the difference is exactly the thing that
 * varies between a 60 Hz panel and a 165 Hz one, so the window has to hang
 * off the stamp.
 *
 * The capture is armed at the start of the trial, not at onset. A press 10 ms
 * before the stimulus is real data, and it has to be recorded as an
 * anticipatory response and invalidated rather than silently dropped. Arming
 * at onset would discard it and quietly improve the child's score.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceBlock = factory();
})(typeof self !== "undefined" ? self : this, function () {
  /**
   * @param {object} spec
   *   trials   array of trial descriptors, generated ahead of time from a seed
   *   timing   (trial, index) -> { leadMs, stimulusMs, windowMs, soaMs }
   *   host     the surface the machine drives, see below
   *   score    (trial, response) -> { correct, condition }
   *
   * host must provide:
   *   show(trial)        paint the stimulus
   *   hide(trial)        clear it
   *   stampOnset(fn)     resolve fn(onsetMs, quality) after the paint that showed it
   *   now()              real monotonic time
   *   capture            response capture from AceInput
   *   emit(record)       one finished trial
   *   tick(trial, ok)    optional, practice feedback only
   */
  function createCptMachine(spec) {
    const { trials, timing, host, score } = spec;
    const feedback = Boolean(spec.feedback);

    let index = -1;
    let trial = null;
    let time = null;

    /**
     * The trial grid, in simulated time.
     *
     * Advanced by the exact nominal period, never reset to whatever the
     * current step happens to be. Resetting to the current step adds up to
     * one step of overshoot to every trial, and that overshoot lands in the
     * onset-to-onset interval, which is the quantity the ISI contrast is
     * computed from. Holding the grid exact leaves display quantisation as
     * the only error, which is irreducible: a stimulus can only appear on a
     * vsync.
     */
    let trialStartSim = 0;
    let scheduledOnsetSim = 0;

    let onsetRequested = false;
    let onset = null;
    let quality = null;
    let visible = false;
    let closed = false;
    let response = null;
    let finished = false;

    const results = [];

    function beginTrial(sim, startSim) {
      index += 1;
      if (index >= trials.length) {
        finished = true;
        return;
      }
      trial = trials[index];
      time = timing(trial, index);
      trialStartSim = startSim === undefined ? sim : startSim;
      scheduledOnsetSim = trialStartSim + time.leadMs;
      onsetRequested = false;
      onset = null;
      quality = null;
      visible = false;
      closed = false;
      response = null;
      host.capture.arm(host.now());
    }

    function closeTrial() {
      closed = true;
      const verdict = score(trial, response, onset);

      // Integer milliseconds, per the metric conventions in 2.8. The
      // sub-millisecond part is noise: the smallest real term in the chain,
      // USB HID polling, has an SD of 2.3 ms.
      const rt =
        response && onset !== null ? Math.round(response.t - onset) : null;

      const q = quality || {
        refreshIntervalMs: 0,
        framesDropped: 0,
        stalled: false,
      };
      const validity = spec.judge(rt, q, host.capture);

      const rec = {
        trial,
        index,
        onset,
        response,
        rt,
        correct: verdict.correct,
        condition: verdict.condition,
        quality: q,
        timing: time,
        /**
         * When the stimulus was due, against when it appeared. The gap is the
         * wait for the next vsync and is always between zero and one frame
         * interval. Recorded so a session can show it rather than assert it.
         */
        scheduled_onset: host.toReal ? host.toReal(scheduledOnsetSim) : null,
        /**
         * The window that actually applied. In the fast ISI block the
         * onset-to-onset period is shorter than the nominal 1800 ms window,
         * so the window is censored by the next stimulus. Recorded per trial
         * so the analysis can apply one common censor to both ISI blocks
         * before differencing them, rather than compare two differently
         * truncated distributions.
         */
        effective_window_ms: Math.min(time.windowMs, time.soaMs),
        valid: validity.valid,
        reason: validity.reason,
        presses: host.capture.count(),
        bounced: host.capture.bounced(),
      };
      results.push(rec);
      host.emit(rec);
      if (feedback && host.tick) host.tick(trial, verdict.correct);
    }

    /** One step against the current trial. Returns true if it ended. */
    function runStep(sim) {
      const local = sim - trialStartSim;

      // Onset. Requested on the simulated-time boundary, stamped on the
      // paint that follows it.
      if (!onsetRequested && local >= time.leadMs) {
        onsetRequested = true;
        visible = true;
        host.show(trial);
        host.stampOnset((at, q) => {
          onset = at;
          quality = q;
        });
      }

      // Offset. Fixed duration in milliseconds, not in frames.
      if (visible && local >= time.leadMs + time.stimulusMs) {
        visible = false;
        host.hide(trial);
      }

      // Response window. Real time against the stamped onset.
      if (!closed && onset !== null) {
        const press = host.capture.first();
        if (press) {
          response = press;
          closeTrial();
        } else if (host.now() - onset >= time.windowMs) {
          closeTrial();
        }
      }

      // End of trial. Onset-to-onset period, so the pace does not drift.
      if (local >= time.leadMs + time.soaMs) {
        if (!closed) closeTrial();
        if (visible) {
          visible = false;
          host.hide(trial);
        }
        beginTrial(sim, trialStartSim + time.leadMs + time.soaMs);
        return true;
      }
      return false;
    }

    return {
      /**
       * Called once per fixed step. Nothing else drives this machine.
       *
       * The body re-enters after a trial boundary rather than returning. A
       * trial that ends on this step has to hand over inside this step, or
       * the next trial's onset is requested one step late and lands one frame
       * late on the panel. That was a real defect, caught by
       * test/timing.test.js asserting the onset falls on the first frame at
       * or after it was due.
       */
      step(sim) {
        let guard = 0;
        while (guard++ < 64) {
          if (finished) return;
          if (trial === null) {
            beginTrial(sim);
            if (finished) return;
          }
          if (!runStep(sim)) return;
        }
      },

      finished: () => finished,
      index: () => index,
      total: trials.length,
      results,
      /** Progress through the block, by elapsed trials only. */
      progress: () => (trials.length ? Math.min(1, (index + 1) / trials.length) : 1),
    };
  }

  return { createCptMachine };
});
