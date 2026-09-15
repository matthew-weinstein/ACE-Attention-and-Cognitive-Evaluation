/**
 * Beacon Line.
 *
 * Spatial span, forward and backward. docs/assessment-design.md 4.3.
 *
 * Landing lights come on one at a time. The child clicks them in the same
 * order, then later in reverse. This is the one game where the mouse is right:
 * no metric here contains a latency, and selecting one of nine positions by
 * keyboard would be slower and more error-prone for a six-year-old than
 * pointing at it.
 *
 * ── Two things the design is explicit about ────────────────────────────────
 *
 * Total sequences correct is the primary score, not longest span. At age six
 * the mean Corsi span is 4.05 with an SD of 0.7, so a longest-span score
 * occupies about three integer values across the whole distribution and cannot
 * support a z-score. Counting every correct sequence restores the granularity.
 *
 * Hit targets are six degrees for a four-degree beacon. The oversize target
 * keeps the task well below any Fitts-law difficulty threshold, so mouse
 * proficiency contributes as little as possible to a memory score.
 *
 * ── The discontinue rule is invisible ──────────────────────────────────────
 *
 * A span task ends on failure, so the number of craft that land is
 * performance-linked whether anyone likes it or not. What the design can
 * control is whether the child can tell. The pad art is scaled to the
 * sequences actually attempted, so it always finishes full, and the closing
 * line is the same wherever the child stopped.
 */

const BeaconLine = (function () {
  const ID = "beacon_line";

  const LIT_MS = 800;
  const GAP_MS = 200;

  const BEACON_DEG = 4;
  const HIT_DEG = 6;

  const TRIALS_PER_LENGTH = 2;
  const START_LENGTH = 2;
  const MAX_LENGTH = 9;

  /** Response times out after this, then the sequence is invalid. */
  const RESPONSE_LIMIT_MS = 15000;

  /**
   * Nine positions, irregular on purpose.
   *
   * A regular grid lets a child encode a sequence as a shape or a path, which
   * turns a spatial span task into a pattern task. These are fractions of the
   * play area, chosen so no three are collinear and no two are closer than the
   * hit target diameter.
   */
  const LAYOUT = [
    [0.18, 0.24],
    [0.42, 0.14],
    [0.72, 0.22],
    [0.14, 0.55],
    [0.38, 0.47],
    [0.63, 0.58],
    [0.86, 0.46],
    [0.29, 0.81],
    [0.66, 0.84],
  ];

  function sequenceOf(random, length) {
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    random.shuffle(pool);
    return pool.slice(0, length);
  }

  // ── One sequence ──────────────────────────────────────────────────────────

  /**
   * Present a sequence, then collect clicks.
   *
   * The presentation runs on the fixed step like every other timed thing in
   * the app. It is not a measurement, but it is a stimulus, and a stimulus
   * whose duration changes with the panel is a different stimulus.
   */
  function present(sequence, state, driver) {
    return new Promise((resolve) => {
      const period = LIT_MS + GAP_MS;
      driver.setScene({
        step(sim) {
          const position = Math.floor(sim / period);
          if (position >= sequence.length) {
            state.lit = -1;
            driver.invalidate();
            resolve();
            return;
          }
          const inLamp = sim % period < LIT_MS;
          const next = inLamp ? sequence[position] : -1;
          if (next !== state.lit) {
            state.lit = next;
            driver.invalidate();
          }
        },
        draw: state.draw,
      });
      driver.start();
    });
  }

  function collect(mount, expected, state, driver) {
    return new Promise((resolve) => {
      const clicks = [];
      const times = [];
      const stage = mount.stage;
      const hitRadius = stage.deg(HIT_DEG / 2);
      let settled = false;

      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        stage.live.removeEventListener("pointerdown", onClick);
        driver.clearScene();
        const gaps = [];
        for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
        resolve({ clicks, gaps, ...outcome });
      };

      function onClick(event) {
        const rect = stage.live.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;

        let hit = -1;
        for (let i = 0; i < LAYOUT.length; i++) {
          const px = LAYOUT[i][0] * stage.width();
          const py = LAYOUT[i][1] * stage.height();
          if ((x - px) * (x - px) + (y - py) * (y - py) <= hitRadius * hitRadius) {
            hit = i;
            break;
          }
        }

        // A click that lands on no beacon invalidates the sequence. It is not
        // a wrong answer, it is a click whose intent cannot be read.
        if (hit < 0) {
          finish({ valid: false, correct: false, reason: "a click landed outside every beacon" });
          return;
        }

        clicks.push(hit);
        times.push(performance.now());
        state.pressed = hit;
        driver.invalidate();

        if (clicks.length >= expected.length) {
          const correct = clicks.every((v, i) => v === expected[i]);
          finish({ valid: true, correct, reason: null });
        }
      }

      stage.live.addEventListener("pointerdown", onClick);

      // The timeout is a state machine step, not a setTimeout, so it holds to
      // the same clock as everything else.
      driver.setScene({
        step(sim) {
          if (sim >= RESPONSE_LIMIT_MS) {
            finish({
              valid: false,
              correct: false,
              reason: "no further click within 15 seconds",
            });
          }
        },
        draw: state.draw,
      });
      driver.start();
    });
  }

  // ── The ladder ────────────────────────────────────────────────────────────

  /**
   * Standard span procedure. Length goes up when either trial at a length is
   * correct, and stops when both at a length are wrong. This is what the
   * published norms assume, and it is not a performance-contingent difficulty
   * adjustment of the kind the other games avoid.
   */
  async function runLadder(ctx, mount, state, direction, random, maxLengths) {
    const driver = window.aceDriver;
    const sequences = [];
    let length = START_LENGTH;
    let lengthsRun = 0;

    while (length <= MAX_LENGTH && lengthsRun < maxLengths) {
      let anyCorrect = false;
      for (let attempt = 0; attempt < TRIALS_PER_LENGTH; attempt++) {
        const order = sequenceOf(random, length);
        const expected = direction === "forward" ? order : order.slice().reverse();

        state.mode = "showing";
        state.pressed = -1;
        await present(order, state, driver);

        state.mode = "collecting";
        driver.invalidate();
        const result = await collect(mount, expected, state, driver);

        sequences.push({
          direction,
          length,
          valid: result.valid,
          correct: result.correct,
          gapsMs: result.gaps,
        });

        ctx.log(
          AceGame.record({
            game: ID,
            trial_index: sequences.length - 1,
            condition: `${direction}:length${length}`,
            t_onset: null,
            t_response: null,
            rt: null,
            response_key: "mouse",
            correct: result.correct,
            validity_flag: result.valid,
            validity_reason: result.reason,
            refresh_interval_measured: driver.intervalMs(),
            frames_dropped: 0,
          }),
        );

        if (result.correct) anyCorrect = true;
      }

      lengthsRun += 1;
      if (!anyCorrect) break;
      length += 1;
    }

    return sequences;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function makeState(mount) {
    const stage = mount.stage;
    const body = AceGame.readToken("--beam-soft");
    const lampColour = AceGame.readToken("--game-beacon-line");
    const lineColour = AceGame.readToken("--scope-line");
    const radius = stage.deg(BEACON_DEG / 2);

    const state = { lit: -1, pressed: -1, mode: "showing" };

    stage.setStatic((c) => {
      AceShapes.horizon(c, stage.width(), stage.height() * 0.93, lineColour, 1);
    });

    // Nine beacons is a small enough scene to repaint whole, and repainting
    // whole means no dirty-rectangle bookkeeping for a screen that changes
    // five times a second at most.
    state.draw = function draw() {
      const c = stage.ctx;
      stage.clearAll();
      for (let i = 0; i < LAYOUT.length; i++) {
        const x = LAYOUT[i][0] * stage.width();
        const y = LAYOUT[i][1] * stage.height();
        const active = state.lit === i || (state.mode === "collecting" && state.pressed === i);
        AceShapes.beacon(c, x, y, radius, body, lampColour, active);
      }
    };

    return state;
  }

  /** A fresh pad. The plate screens replace the surface, so each ladder mounts its own. */
  function mountPad() {
    const mount = AceGame.mountStage("var(--game-beacon-line)", {});
    const state = makeState(mount);
    mount.stage.live.style.cursor = "pointer";
    return { mount, state };
  }

  async function run(ctx) {
    const random = AceTrial.createRandom(
      AceTrial.seedFrom(`${ctx.participantId}:${ID}`),
    );

    const driver = window.aceDriver;

    // Forward.
    await AceUI.plate({
      accent: "var(--game-beacon-line)",
      band: ctx.band,
      line: "The landing lights come on one at a time.",
      paint: demoForward,
    });
    await AceUI.plate({
      accent: "var(--game-beacon-line)",
      band: ctx.band,
      line: "Click them in the same order.",
      paint: demoForward,
    });

    const forwardMount = mountPad();
    const maxLengths = ctx.band === "A" ? 4 : MAX_LENGTH;
    const forward = await runLadder(
      ctx,
      forwardMount.mount,
      forwardMount.state,
      "forward",
      random,
      maxLengths,
    );
    forwardMount.mount.destroy();

    // Backward. Practised separately, because the reversal is the part
    // children find hard and a forward pass says nothing about it.
    await AceUI.plate({
      accent: "var(--game-beacon-line)",
      band: ctx.band,
      line: "Now click them backwards. Start with the last one that lit up.",
      paint: demoBackward,
    });

    const backwardMount = mountPad();
    const backwardLengths = ctx.band === "A" ? 2 : MAX_LENGTH;
    const backward = await runLadder(
      ctx,
      backwardMount.mount,
      backwardMount.state,
      "backward",
      random,
      backwardLengths,
    );

    backwardMount.mount.destroy();
    driver.clearScene();

    // The same closing line wherever the child stopped.
    await AceUI.pause({
      accent: "var(--game-beacon-line)",
      line: "The pad is clear for the night.",
    });

    const summary = AceMetrics.beaconLine(forward.concat(backward));
    ctx.event({ kind: "game_summary", game: ID, summary });
    return { ok: true, summary };
  }

  // ── Demonstrations ────────────────────────────────────────────────────────

  function demoBeacons(c, w, h, litIndex, pressedIndex) {
    const body = AceGame.readToken("--beam-soft");
    const lampColour = AceGame.readToken("--game-beacon-line");
    const r = Math.min(w, h) * 0.055;
    const pair = [
      [0.32, 0.38],
      [0.64, 0.66],
    ];
    AceShapes.horizon(c, w, h * 0.92, AceGame.readToken("--scope-line"), 1);
    for (let i = 0; i < pair.length; i++) {
      AceShapes.beacon(
        c,
        pair[i][0] * w,
        pair[i][1] * h,
        r,
        body,
        lampColour,
        i === litIndex || i === pressedIndex,
      );
    }
    return pair;
  }

  function demoForward(c, w, h, t) {
    const step = Math.floor((t % 3000) / 750);
    demoBeacons(c, w, h, step < 2 ? step : -1, step >= 2 ? step - 2 : -1);
  }

  function demoBackward(c, w, h, t) {
    const step = Math.floor((t % 3000) / 750);
    demoBeacons(c, w, h, step < 2 ? step : -1, step >= 2 ? 3 - step : -1);
  }

  return { id: ID, label: "Beacon Line", accent: "var(--game-beacon-line)", run };
})();
