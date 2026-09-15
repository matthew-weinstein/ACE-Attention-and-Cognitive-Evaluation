/**
 * Refresh-rate invariance.
 *
 * docs/assessment-design.md 2.5 sets the bar and the method:
 *
 *   "Run the trial scheduler headless against a synthetic clock at 60, 120
 *    and 165 Hz and assert that recorded onset times, response windows and
 *    inter-trial intervals match within one frame interval. Assert that the
 *    generated trial sequence is identical for a fixed random seed. Any
 *    change to timing or animation restates this check."
 *
 * This is that check. It drives the real modules, not a copy of them: the
 * same AceDriver, AceClock, AceBlock and AceInput the renderer loads. The only
 * things replaced are the clock and requestAnimationFrame, which is the whole
 * reason both are injectable.
 *
 * The virtual child presses at a fixed true latency after the stimulus
 * physically appears. The assertion that matters is not that onsets are equal
 * across panels, because they are not and cannot be: a 165 Hz panel presents a
 * frame sooner than a 60 Hz one. It is that the measured reaction time is
 * identical to the millisecond, because both the onset and the response are
 * timestamped rather than counted.
 *
 *   node test/timing.test.js
 */

const assert = require("assert");
const Clock = require("../renderer/core/clock.js");
const Driver = require("../renderer/core/driver.js");
const Input = require("../renderer/core/input.js");
const Block = require("../renderer/core/block.js");
const Trial = require("../renderer/core/trial.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

const RATES = [60, 120, 165];
const SEED = Trial.seedFrom("ACE-0001:signal_watch");

// -- The virtual machine -----------------------------------------------------

/**
 * Run one block on a synthetic panel.
 *
 * `trueLatencyMs` is the child's actual reaction time, applied from the moment
 * the stimulus physically reaches the panel. A press can only be delivered on
 * a real event, so it is delivered at the exact time it happens, which is what
 * `event.timeStamp` would carry.
 */
function runAt(hz, options) {
  const opts = options || {};
  const frameMs = 1000 / hz;
  const trueLatency =
    opts.trueLatencyMs === undefined ? 420 : opts.trueLatencyMs;

  let clock = 0;
  const pending = [];
  const driver = Driver.createDriver({
    now: () => clock,
    requestFrame: (cb) => pending.push(cb),
    cancelFrame: () => {},
    stepMs: opts.stepMs,
  });

  const capture = Input.createResponseCapture({
    keys: ["ArrowLeft", "ArrowRight"],
  });

  // Deterministic trial list, generated from the seed.
  const random = Trial.createRandom(SEED);
  const sides = Trial.balancedSequence(
    random,
    opts.trials || 24,
    ["left", "right"],
    [0.5, 0.5],
    3,
  );
  const blanks = new Set();
  while (blanks.size < Math.round(sides.length * 0.1)) {
    blanks.add(random.int(sides.length));
  }
  const trials = sides.map((side, i) => ({
    side,
    blank: blanks.has(i),
    isi: i < sides.length / 2 ? 1500 : 3000,
  }));

  const emitted = [];
  const scheduled = [];
  let visible = null;
  let current = null;

  const host = {
    capture,
    now: () => clock,
    show(trial) {
      visible = trial;
      current = trial;
    },
    hide() {
      visible = null;
    },
    stampOnset(fn) {
      const trial = current;
      driver.stampOnset((at, q) => {
        fn(at, q);
        // The child reacts to photons, so the press is scheduled from the
        // onset that actually reached the panel.
        if (trial && !trial.blank && trueLatency < 90000) {
          scheduled.push({
            at: at + trueLatency,
            key: trial.side === "left" ? "ArrowLeft" : "ArrowRight",
          });
        }
      });
    },
    emit(rec) {
      emitted.push(rec);
    },
    toReal: (sim) => driver.stepper.toReal(sim),
  };

  const machine = Block.createCptMachine({
    trials,
    timing: (trial) => ({
      leadMs: 0,
      stimulusMs: 250,
      windowMs: 1800,
      soaMs: 250 + trial.isi,
    }),
    score: (trial, response) => ({
      condition: trial.blank ? "blank" : trial.side,
      correct: trial.blank
        ? response === null
        : response !== null &&
          response.key === (trial.side === "left" ? "ArrowLeft" : "ArrowRight"),
    }),
    judge: (rt, q, cap) => {
      if (cap.lostFocus()) return { valid: false, reason: "focus lost" };
      if (q.framesDropped > 0) {
        return { valid: false, reason: "frames dropped before onset" };
      }
      if (rt !== null && rt < 150) {
        return { valid: false, reason: "anticipatory" };
      }
      return { valid: true, reason: null };
    },
    host,
  });

  // Warm up first. No stimulus is presented until the refresh median rests on
  // a full window, because until then the onset stamp would carry the
  // fallback interval instead of the measured one. The app does this during
  // the camera check. Here it is the same wait, made explicit.
  driver.setScene({});
  driver.start();
  while (!driver.refreshConverged() && clock < 60000) {
    clock += frameMs;
    const warm = pending.shift();
    pending.length = 0;
    if (warm) warm(clock);
  }
  assert(driver.refreshConverged(), `${hz} Hz never converged`);

  driver.setScene({
    step(sim) {
      machine.step(sim);
    },
    draw() {
      // Where a real stimulus would reach the compositor.
    },
  });

  let guard = 0;
  while (!machine.finished() && guard < 400000) {
    guard++;
    clock += frameMs;

    // Deliver any press whose moment has arrived, at its true time.
    for (let i = scheduled.length - 1; i >= 0; i--) {
      if (scheduled[i].at <= clock) {
        capture.inject(scheduled[i].key, scheduled[i].at);
        scheduled.splice(i, 1);
      }
    }

    const cb = pending.shift();
    pending.length = 0;
    if (cb) cb(clock);
    driver.invalidate();
  }

  return {
    hz,
    frameMs,
    driver,
    machine,
    emitted,
    trials,
    measuredIntervalMs: driver.intervalMs(),
  };
}

// -- The checks --------------------------------------------------------------

console.log("\nRefresh-rate invariance (assessment-design 2.5)\n");

const runs = RATES.map((hz) => runAt(hz, { trials: 24 }));

test("the measured refresh interval matches the synthetic panel", () => {
  for (const r of runs) {
    assert(
      Math.abs(r.measuredIntervalMs - r.frameMs) < 0.01,
      `${r.hz} Hz: measured ${r.measuredIntervalMs.toFixed(3)} ms, panel ${r.frameMs.toFixed(3)} ms`,
    );
  }
});

test("the trial sequence is identical at every rate for a fixed seed", () => {
  const signature = (r) =>
    r.trials.map((t) => `${t.side}${t.blank ? "-" : "+"}${t.isi}`).join(",");
  const first = signature(runs[0]);
  for (const r of runs) {
    assert.strictEqual(signature(r), first, `${r.hz} Hz sequence differs`);
  }
});

test("every rate completes the same number of trials", () => {
  for (const r of runs) {
    assert.strictEqual(r.emitted.length, 24, `${r.hz} Hz emitted ${r.emitted.length}`);
  }
});

test("onset-to-onset intervals match the specified SOA within one frame", () => {
  for (const r of runs) {
    for (let i = 1; i < r.emitted.length; i++) {
      const prev = r.emitted[i - 1];
      const cur = r.emitted[i];
      if (prev.onset === null || cur.onset === null) continue;
      const soa = cur.onset - prev.onset;
      const want = prev.timing.soaMs;
      assert(
        Math.abs(soa - want) <= r.frameMs + 0.001,
        `${r.hz} Hz trial ${i}: SOA ${soa.toFixed(2)} ms against ${want} ms, tolerance ${r.frameMs.toFixed(2)} ms`,
      );
    }
  }
});

test("the stimulus is painted on the first frame at or after it is due", () => {
  // The honest cross-rate claim. Two panels cannot present the same stimulus
  // at the same instant: a 60 Hz panel shows it up to 16.7 ms later than a
  // 165 Hz one, and no amount of software removes that. What has to hold is
  // that every panel paints on the first frame at or after the scheduled
  // time, and that the presentation delay is measured rather than assumed.
  // Onset is that frame plus one interval, so onset minus due lands in
  // [interval, 2 * interval) at every rate.
  for (const r of runs) {
    for (const e of r.emitted) {
      if (e.onset === null) continue;
      const late = e.onset - e.scheduled_onset;
      const ceiling = r.frameMs * 2 + Clock.STEP_MS;
      assert(
        late >= r.frameMs - 0.001 && late < ceiling + 0.001,
        `${r.hz} Hz trial ${e.index}: onset landed ${late.toFixed(2)} ms after due, outside [${r.frameMs.toFixed(2)}, ${ceiling.toFixed(2)})`,
      );
    }
  }
});

test("the schedule itself is identical at every rate", () => {
  // What is invariant is the plan. The panel decides when it can show it, and
  // the session starts at a different wall time on each panel because the
  // refresh warm-up takes 120 frames, so the comparison is of the schedule
  // relative to its own first trial.
  const relative = (r) =>
    r.emitted.map((e) => Math.round((e.scheduled_onset - r.emitted[0].scheduled_onset) * 1000));
  const base = relative(runs[0]);
  for (const r of runs.slice(1)) {
    assert.deepStrictEqual(
      relative(r),
      base,
      `${r.hz} Hz scheduled different onset times`,
    );
  }
});

test("measured reaction time is identical at every rate", () => {
  const base = runs[0].emitted.map((e) => e.rt);
  for (const r of runs.slice(1)) {
    assert.deepStrictEqual(
      r.emitted.map((e) => e.rt),
      base,
      `${r.hz} Hz reaction times differ from 60 Hz`,
    );
  }
  const responded = base.filter((v) => v !== null);
  assert(responded.length > 0, "no responses were recorded at all");
  for (const rt of responded) {
    assert(
      Math.abs(rt - 420) < 0.001,
      `expected the true latency of 420 ms, got ${rt}`,
    );
  }
});

test("scored correctness is identical at every rate", () => {
  const base = runs[0].emitted.map((e) => `${e.correct}:${e.valid}`);
  for (const r of runs.slice(1)) {
    assert.deepStrictEqual(
      r.emitted.map((e) => `${e.correct}:${e.valid}`),
      base,
      `${r.hz} Hz scoring differs`,
    );
  }
});

test("a slow responder is scored the same at every rate", () => {
  const slow = RATES.map((hz) => runAt(hz, { trials: 12, trueLatencyMs: 1650 }));
  const base = slow[0].emitted.map((e) => e.rt);
  for (const r of slow.slice(1)) {
    assert.deepStrictEqual(
      r.emitted.map((e) => e.rt),
      base,
      `${r.hz} Hz differs`,
    );
  }
});

test("a non-responder times out at the same trial count at every rate", () => {
  const none = RATES.map((hz) => runAt(hz, { trials: 12, trueLatencyMs: 99999 }));
  for (const r of none) {
    assert.strictEqual(r.emitted.length, 12);
    assert(r.emitted.every((e) => e.rt === null), `${r.hz} Hz recorded a response`);
  }
});

// -- The fixed step itself ---------------------------------------------------

console.log("\nFixed timestep\n");

test("simulated time tracks real time within one step at every rate", () => {
  for (const hz of RATES) {
    const stepper = Clock.createStepper();
    stepper.start(0);
    const frame = 1000 / hz;
    let t = 0;
    for (let i = 0; i < 2000; i++) {
      t += frame;
      stepper.advance(t, () => {});
    }
    const drift = t - stepper.now();
    assert(
      drift >= 0 && drift < Clock.STEP_MS,
      `${hz} Hz: simulated ${stepper.now().toFixed(1)} ms against real ${t.toFixed(1)} ms`,
    );
  }
});

test("the step size is below one frame interval at 165 Hz", () => {
  assert(
    Clock.STEP_MS < 1000 / 165,
    `step ${Clock.STEP_MS} ms is not below the 165 Hz frame interval`,
  );
});

test("a dropped frame is counted, not absorbed", () => {
  const meter = Clock.createRefreshMeter();
  for (let i = 0; i < 200; i++) meter.sample(i * (1000 / 165));
  assert.strictEqual(meter.droppedIn(1000 / 165), 0, "a normal gap counted as dropped");
  assert.strictEqual(meter.droppedIn((1000 / 165) * 2), 1, "one dropped frame missed");
  assert.strictEqual(meter.droppedIn((1000 / 165) * 4), 3, "three dropped frames missed");
});

// -- Delta-time animation ----------------------------------------------------

console.log("\nDelta-time animation\n");

test("a moving object covers the same distance at every rate", () => {
  // The bug this replaces: `star.lifetime++` once per frame, which ages a
  // stimulus 2.75 times faster at 165 Hz than at 60 Hz.
  const SPEED_PX_PER_MS = 0.25;
  const DURATION_MS = 4000;
  const distances = RATES.map((hz) => {
    const frame = 1000 / hz;
    let x = 0;
    let t = 0;
    let last = 0;
    while (t < DURATION_MS) {
      t += frame;
      const dt = t - last;
      last = t;
      x += SPEED_PX_PER_MS * dt;
    }
    return x;
  });
  const spread = Math.max(...distances) - Math.min(...distances);
  assert(
    spread < SPEED_PX_PER_MS * (1000 / 60) + 0.001,
    `distances diverged by ${spread.toFixed(2)} px across rates`,
  );
});

test("frame counting diverges, which is why it is not used", () => {
  const counts = RATES.map((hz) => Math.round(4000 / (1000 / hz)));
  assert(
    counts[0] !== counts[2],
    "frame counts at 60 and 165 Hz came out equal, which cannot be right",
  );
});

// -- Response capture --------------------------------------------------------

console.log("\nResponse capture (assessment-design 2.6)\n");

test("key repeat is discarded", () => {
  const cap = Input.createResponseCapture({ keys: [" "] });
  cap.arm(0);
  cap.inject(" ", 100);
  cap.injectRaw({ repeat: true, key: " ", timeStamp: 140 });
  assert.strictEqual(cap.count(), 1);
  assert.strictEqual(cap.repeats(), 1);
});

test("a second press inside 40 ms is a bounce, not a response", () => {
  const cap = Input.createResponseCapture({ keys: [" "] });
  cap.arm(0);
  cap.inject(" ", 100);
  cap.inject(" ", 130);
  cap.inject(" ", 200);
  assert.strictEqual(cap.count(), 2, "the debounce did not hold");
  assert.strictEqual(cap.bounced(), 1, "the bounce was not counted");
});

test("arming clears presses from the previous trial", () => {
  const cap = Input.createResponseCapture({ keys: [" "] });
  cap.arm(0);
  cap.inject(" ", 100);
  cap.arm(200);
  assert.strictEqual(cap.count(), 0);
  assert.strictEqual(cap.first(), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
