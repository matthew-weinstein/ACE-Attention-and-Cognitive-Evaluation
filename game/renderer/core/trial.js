/**
 * Seeded sequences and the per-trial phase machine.
 *
 * Two jobs.
 *
 * Trial order is generated from a seed, so the same participant id produces
 * the same sequence on any machine. docs/assessment-design.md 2.5 asks the
 * verification to assert exactly that: identical sequences at 60, 120 and
 * 165 Hz for a fixed seed. `Math.random()` cannot make that promise.
 *
 * Trial structure is a list of phases with durations in milliseconds, stepped
 * on the fixed grid. No phase is ever defined in frames. A 250 ms stimulus is
 * 250 ms of simulated time whether that took 15 frames or 41.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceTrial = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // ── Seeded random ─────────────────────────────────────────────────────────

  /** mulberry32. Small, fast, and adequate for trial ordering. */
  function createRandom(seed) {
    let a = seed >>> 0;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      next,
      /** Integer in [0, n). */
      int: (n) => Math.floor(next() * n),
      /** Uniform in [lo, hi]. */
      between: (lo, hi) => lo + next() * (hi - lo),
      pick: (arr) => arr[Math.floor(next() * arr.length)],
      /** Fisher-Yates, in place. */
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const tmp = arr[i];
          arr[i] = arr[j];
          arr[j] = tmp;
        }
        return arr;
      },
    };
  }

  /** Turn a participant id and a game id into a stable 32-bit seed. */
  function seedFrom(text) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /**
   * A two-value sequence at a given ratio with no run longer than `maxRun`.
   *
   * Signal Watch needs 50/50 left and right with no more than three of one
   * side in a row, because a longer run lets a child start anticipating and
   * an anticipated response is not a response to the stimulus.
   */
  function balancedSequence(random, n, values, weights, maxRun) {
    const pool = [];
    for (let i = 0; i < values.length; i++) {
      const count = Math.round(n * weights[i]);
      for (let k = 0; k < count; k++) pool.push(values[i]);
    }
    while (pool.length < n) pool.push(values[0]);
    pool.length = n;

    for (let attempt = 0; attempt < 200; attempt++) {
      random.shuffle(pool);
      let run = 1;
      let ok = true;
      for (let i = 1; i < pool.length; i++) {
        run = pool[i] === pool[i - 1] ? run + 1 : 1;
        if (run > maxRun) {
          ok = false;
          break;
        }
      }
      if (ok) return pool.slice();
    }
    // Deterministic repair, so the generator always terminates.
    return repairRuns(pool, maxRun);
  }

  function repairRuns(pool, maxRun) {
    let run = 1;
    for (let i = 1; i < pool.length; i++) {
      run = pool[i] === pool[i - 1] ? run + 1 : 1;
      if (run > maxRun) {
        for (let j = i + 1; j < pool.length; j++) {
          if (pool[j] !== pool[i]) {
            const tmp = pool[i];
            pool[i] = pool[j];
            pool[j] = tmp;
            break;
          }
        }
        run = 1;
      }
    }
    return pool;
  }

  /**
   * Go/no-go order with 2 to 5 go trials before each no-go, which is what
   * builds the prepotency the commission rate measures.
   */
  function prepotentSequence(random, goCount, nogoCount, minGap, maxGap) {
    const out = [];
    let goLeft = goCount;
    let nogoLeft = nogoCount;
    while (nogoLeft > 0) {
      const gap = Math.min(
        goLeft - Math.max(0, (nogoLeft - 1) * minGap),
        minGap + random.int(maxGap - minGap + 1),
      );
      const run = Math.max(minGap, Math.min(gap, goLeft));
      for (let i = 0; i < run && goLeft > 0; i++) {
        out.push("go");
        goLeft -= 1;
      }
      out.push("nogo");
      nogoLeft -= 1;
    }
    while (goLeft > 0) {
      out.push("go");
      goLeft -= 1;
    }
    return out;
  }

  // ── Phase machine ─────────────────────────────────────────────────────────

  /**
   * A list of `{ name, ms }` walked on simulated time.
   *
   * `advance` reports the phase the machine is in at that simulated time and
   * whether this is the first step inside it. Games hang stimulus onset off
   * `entered`, so onset happens on a simulated-time boundary rather than on a
   * frame boundary, and the same boundary on every panel.
   */
  function createPhases(steps) {
    let index = 0;
    let startedAt = 0;
    let entered = false;
    let finished = false;

    return {
      reset(sim) {
        index = 0;
        startedAt = sim;
        entered = true;
        finished = steps.length === 0;
      },

      /** Replace the schedule mid-trial, used where a phase is data-driven. */
      setSteps(next) {
        steps = next;
      },

      advance(sim) {
        if (finished) return { name: null, elapsed: 0, entered: false, finished: true };
        const wasEntered = entered;
        entered = false;
        let step = steps[index];
        let elapsed = sim - startedAt;

        // `while`, not `if`. A zero-length or very short phase inside one
        // advance must not be skipped or stretched to a step boundary.
        while (step && elapsed >= step.ms) {
          startedAt += step.ms;
          elapsed = sim - startedAt;
          index += 1;
          step = steps[index];
          entered = true;
          if (!step) {
            finished = true;
            return { name: null, elapsed, entered: false, finished: true };
          }
        }

        return {
          name: step.name,
          index,
          elapsed,
          remaining: step.ms - elapsed,
          entered: entered || wasEntered,
          finished: false,
        };
      },

      finished: () => finished,
      current: () => (steps[index] ? steps[index].name : null),
    };
  }

  return {
    createRandom,
    seedFrom,
    balancedSequence,
    prepotentSequence,
    createPhases,
  };
});
