/**
 * Response capture.
 *
 * Reads `event.timeStamp` from the keydown event and never calls
 * `performance.now()` inside the handler. Both are on the same time origin in
 * Chromium, but `event.timeStamp` is stamped when the OS delivered the event,
 * and `performance.now()` inside the handler adds renderer event-loop
 * queueing. That queueing is the largest and most variable software term in
 * the chain, and it is worst exactly when the main thread is busy
 * compositing, which is exactly at stimulus onset. See
 * docs/assessment-design.md 2.6.
 *
 * Repeats are discarded and a 40 ms debounce is applied. Without both, OS key
 * repeat and mechanical bounce produce a second keydown that lands on the
 * following trial and scores as a commission error, inflating commission
 * rates by a device-dependent amount that has nothing to do with the child.
 *
 * Focus loss is tracked here too, because a trial spanning a focus loss is a
 * trial to invalidate and this is the only place that knows.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceInput = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const DEBOUNCE_MS = 40;

  /** Presses held while no window is armed still need somewhere to go. */
  const BUFFER = 32;

  function createResponseCapture(options) {
    const opts = options || {};
    const debounceMs = opts.debounceMs === undefined ? DEBOUNCE_MS : opts.debounceMs;
    const accept = opts.keys ? new Set(opts.keys) : null;

    // Pre-allocated so the hot path allocates nothing.
    const keys = new Array(BUFFER).fill(null);
    const times = new Float64Array(BUFFER);
    let count = 0;

    let lastAcceptedAt = -Infinity;
    let bounced = 0;
    let repeats = 0;
    let armedAt = null;

    let focusLostAt = null;
    let focusLostSinceArm = false;

    let target = null;

    function onKeyDown(event) {
      if (event.repeat) {
        repeats += 1;
        return;
      }
      if (accept && !accept.has(event.key)) return;

      // Chromium gives keydown a DOMHighResTimeStamp on the performance
      // time origin. Anything else is a synthetic event and is not a response.
      const t = event.timeStamp;
      if (!Number.isFinite(t)) return;

      if (t - lastAcceptedAt < debounceMs) {
        bounced += 1;
        return;
      }
      lastAcceptedAt = t;

      event.preventDefault();
      if (count < BUFFER) {
        keys[count] = event.key;
        times[count] = t;
        count += 1;
      }
    }

    function onBlur() {
      focusLostAt = typeof performance !== "undefined" ? performance.now() : 0;
      if (armedAt !== null) focusLostSinceArm = true;
    }

    return {
      attach(node) {
        target = node;
        target.addEventListener("keydown", onKeyDown, { capture: true });
        target.addEventListener("blur", onBlur);
        return this;
      },

      detach() {
        if (!target) return;
        target.removeEventListener("keydown", onKeyDown, { capture: true });
        target.removeEventListener("blur", onBlur);
        target = null;
      },

      /**
       * Open a response window. Anything pressed before this is discarded,
       * which is what makes a press during the inter-trial interval a
       * non-event rather than an instant response on the next trial.
       */
      arm(atRealTime) {
        count = 0;
        armedAt = atRealTime;
        focusLostSinceArm = false;
        bounced = 0;
        repeats = 0;
      },

      /** Number of accepted presses in the open window. */
      count() {
        return count;
      },

      /** The first accepted press, or null. `{ key, t }`. */
      first() {
        if (count === 0) return null;
        return { key: keys[0], t: times[0] };
      },

      /** The nth accepted press. Used for burst detection. */
      at(i) {
        if (i < 0 || i >= count) return null;
        return { key: keys[i], t: times[i] };
      },

      /** Presses rejected by the debounce during this window. */
      bounced() {
        return bounced;
      },

      /** Keydowns rejected as OS key repeat during this window. */
      repeats() {
        return repeats;
      },

      /** True if the window lost focus at any point in the open window. */
      lostFocus() {
        return focusLostSinceArm;
      },

      lastFocusLossAt() {
        return focusLostAt;
      },

      /**
       * Test seam. Feeds a press without a DOM, so the scheduler can be
       * driven headless at three refresh rates with identical input.
       */
      inject(key, t) {
        onKeyDown({ repeat: false, key, timeStamp: t, preventDefault() {} });
      },

      /** Same seam, for an event the filters are supposed to reject. */
      injectRaw(event) {
        onKeyDown(Object.assign({ preventDefault() {} }, event));
      },

      DEBOUNCE_MS: debounceMs,
    };
  }

  return { createResponseCapture, DEBOUNCE_MS };
});
