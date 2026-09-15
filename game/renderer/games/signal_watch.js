/**
 * Signal Watch.
 *
 * The anchor task. docs/assessment-design.md 4.1.
 *
 * A craft crosses the scope leaning left or right. The child presses the arrow
 * key that matches the lean. The mapping is spatially compatible, so the whole
 * instruction is one sentence.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * There is no score, no streak, no counter, and no per-trial feedback inside a
 * scored block. Nothing on the screen changes when the child is wrong. That is
 * not a kindness, it is the measurement: Dovis et al. showed rich
 * reinforcement narrows the very gap this task exists to detect, and Wiley et
 * al. showed game elements compress the construct-specific contrast while
 * improving consistency. So the wrapper is gamified and the scored trials are
 * not. The progress marks along the horizon advance on elapsed trials alone
 * and are identical for every child.
 *
 * ── One judgement call, stated ─────────────────────────────────────────────
 *
 * The design gives a 1800 ms response window and a 1500 ms fast ISI, which
 * overlap. ISI is read as onset-to-onset here, because that is the only
 * reading under which Asteroid Run's stated duration comes out exact: 300
 * trials at 1000 ms is 5.0 minutes, which is the figure in 4.2. So the fast
 * block runs at 1500 ms onset-to-onset and the nominal 1800 ms window is
 * censored at 1500 ms by the next stimulus, while the slow block gets the
 * full window.
 *
 * That leaves the two ISI blocks with differently truncated reaction time
 * distributions, and the ISI contrast is a difference of their means. So the
 * window that actually applied is written to every trial as
 * `effective_window_ms`, and the contrast is computed against one common
 * censor rather than against two different ones.
 */

const SignalWatch = (function () {
  const ID = "signal_watch";

  const STIMULUS_MS = 250;
  const WINDOW_MS = 1800;
  const ISI_FAST_MS = 1500;
  const ISI_SLOW_MS = 3000;

  const CRAFT_DEG = 2.5;
  const TILT_DEG = 8;

  const BLANK_RATE = 0.1;
  const DISTRACTOR_TRIALS = 30;
  const STAIRCASE_TRIALS = 24;

  const PRACTICE_TRIALS = 16;
  const PRACTICE_PASS = 12;
  const PRACTICE_ATTEMPTS = 3;

  /** Contrast levels, log-spaced. Level 0 is full, the last is near invisible. */
  const CONTRAST = (() => {
    const out = [];
    for (let i = 0; i < 20; i++) out.push(1.0 * Math.pow(0.88, i));
    return out;
  })();

  const KEY_FOR = { left: "ArrowLeft", right: "ArrowRight" };

  // ── Trial generation ──────────────────────────────────────────────────────

  function buildTrials(random, band) {
    const total = band === "A" ? 120 : 180;
    const perBlock = total / 2;

    // Block order counterbalanced by participant, so ISI and fatigue are not
    // confounded across the sample.
    const slowFirst = random.next() < 0.5;

    const trials = [];
    for (let b = 0; b < 2; b++) {
      const isi = (b === 0) === slowFirst ? ISI_SLOW_MS : ISI_FAST_MS;
      const sides = AceTrial.balancedSequence(
        random,
        perBlock,
        ["left", "right"],
        [0.5, 0.5],
        3,
      );

      // Blank trials carry the correct-rejection rate that d-prime needs.
      const blanks = new Set();
      while (blanks.size < Math.round(perBlock * BLANK_RATE)) {
        blanks.add(random.int(perBlock));
      }

      for (let i = 0; i < perBlock; i++) {
        trials.push({
          block: b,
          within: i,
          isi,
          side: sides[i],
          blank: blanks.has(i),
          distractor: i >= perBlock - DISTRACTOR_TRIALS,
        });
      }
    }
    return { trials, slowFirst, perBlock };
  }

  function practiceTrials(random) {
    const sides = AceTrial.balancedSequence(
      random,
      PRACTICE_TRIALS,
      ["left", "right"],
      [0.5, 0.5],
      3,
    );
    return sides.map((side, i) => ({
      block: -1,
      within: i,
      isi: ISI_SLOW_MS,
      side,
      blank: false,
      distractor: false,
    }));
  }

  // ── The staircase ─────────────────────────────────────────────────────────

  /**
   * One-up two-down on the first 24 trials, then frozen.
   *
   * Freezing matters. A staircase running through the scored block makes
   * difficulty co-vary with performance, and the reaction time distribution
   * then describes the staircase rather than the child. The converged value is
   * reported as a threshold estimate in its own right.
   */
  function createStaircase() {
    let level = 2;
    let correctRun = 0;
    let lastDirection = 0;
    const reversals = [];
    let frozen = false;

    return {
      contrast: () => CONTRAST[level],
      frozen: () => frozen,

      record(correct) {
        if (frozen) return;
        let direction = 0;
        if (correct) {
          correctRun += 1;
          if (correctRun >= 2) {
            correctRun = 0;
            if (level < CONTRAST.length - 1) level += 1;
            direction = 1;
          }
        } else {
          correctRun = 0;
          if (level > 0) level -= 1;
          direction = -1;
        }
        if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) {
          reversals.push(CONTRAST[level]);
        }
        if (direction !== 0) lastDirection = direction;
      },

      /**
       * Freeze at the geometric mean of the reversals after the first two.
       * Fewer than four reversals in 24 trials means the staircase did not
       * converge, which is a named session-invalidation reason rather than a
       * number quietly used anyway.
       */
      freeze() {
        frozen = true;
        const used = reversals.slice(2);
        if (used.length >= 4) {
          const logMean =
            used.reduce((a, v) => a + Math.log(v), 0) / used.length;
          const value = Math.exp(logMean);
          let best = 0;
          for (let i = 1; i < CONTRAST.length; i++) {
            if (Math.abs(CONTRAST[i] - value) < Math.abs(CONTRAST[best] - value)) {
              best = i;
            }
          }
          level = best;
          return { converged: true, contrast: CONTRAST[level], reversals: used.length };
        }
        return { converged: false, contrast: CONTRAST[level], reversals: used.length };
      },
    };
  }

  // ── The scene ─────────────────────────────────────────────────────────────

  /**
   * Peripheral debris for the distractor condition.
   *
   * Aged on delta time, never on a frame counter. The old build did
   * `star.lifetime++` once per frame, which ran 2.75 times faster on a 165 Hz
   * panel and made the distractor condition a different condition on every
   * machine.
   *
   * Positions are pooled and reused, so the animation allocates nothing.
   */
  function createDebris(stage, count) {
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    const vx = new Float64Array(count);
    const rot = new Float64Array(count);
    const spin = new Float64Array(count);
    const size = new Float64Array(count);
    const random = AceTrial.createRandom(0x5eed1e);

    function place(i, w, h, offscreen) {
      const exclusion = stage.deg(6);
      xs[i] = offscreen ? w + random.between(0, w * 0.4) : random.between(0, w);
      do {
        ys[i] = random.between(h * 0.08, h * 0.92);
      } while (Math.abs(ys[i] - h / 2) < exclusion);
      vx[i] = -random.between(0.012, 0.03) * w * 0.001 * 1000;
      rot[i] = random.between(0, Math.PI * 2);
      spin[i] = random.between(-0.0004, 0.0004);
      size[i] = stage.deg(random.between(0.5, 1.1));
    }

    const w0 = stage.width();
    const h0 = stage.height();
    for (let i = 0; i < count; i++) place(i, w0, h0, false);

    return {
      update(dt) {
        const w = stage.width();
        const h = stage.height();
        for (let i = 0; i < count; i++) {
          xs[i] += vx[i] * (dt / 1000);
          rot[i] += spin[i] * dt;
          if (xs[i] < -size[i] * 2) place(i, w, h, true);
        }
      },
      draw(ctx, fill) {
        for (let i = 0; i < count; i++) {
          AceShapes.debris(ctx, xs[i], ys[i], size[i], rot[i], fill);
          stage.mark(xs[i], ys[i], size[i] * 1.6);
        }
      },
    };
  }

  // ── Running one block ─────────────────────────────────────────────────────

  async function runBlock(ctx, trials, options) {
    const opts = options || {};
    const mount = AceGame.mountStage("var(--game-signal-watch)", {
      progressMarks: opts.progressMarks || 0,
    });
    const stage = mount.stage;
    const driver = window.aceDriver;
    const capture = ctx.capture;

    const scopeRgb = AceGame.rgb(AceGame.readToken("--scope"));
    const beamRgb = AceGame.rgb(AceGame.readToken("--beam"));
    const lineColour = AceGame.readToken("--scope-line");
    const accent = AceGame.readToken("--game-signal-watch");

    stage.setStatic((c) => {
      AceShapes.horizon(c, stage.width(), stage.height() / 2, lineColour, 1);
    });

    const craftSize = 2 * stage.deg(CRAFT_DEG / 2);
    const debris = createDebris(stage, 9);

    let showing = null;
    let showContrast = 1;
    let distractorOn = false;

    const staircase = opts.staircase || null;
    const emitted = [];
    let settled = null;

    const machine = AceBlock.createCptMachine({
      trials,
      feedback: Boolean(opts.feedback),
      timing: (trial) => ({
        leadMs: 0,
        stimulusMs: STIMULUS_MS,
        windowMs: WINDOW_MS,
        soaMs: trial.isi,
      }),
      score: (trial, response) => ({
        condition: trial.blank
          ? "blank"
          : `${trial.side}${trial.distractor ? "-distractor" : ""}`,
        correct: trial.blank
          ? response === null
          : response !== null && response.key === KEY_FOR[trial.side],
      }),
      judge: AceGame.judge,
      host: {
        capture,
        now: () => performance.now(),
        toReal: (sim) => driver.stepper.toReal(sim),
        show(trial) {
          distractorOn = trial.distractor;
          showing = trial.blank ? null : trial;
          showContrast = staircase ? staircase.contrast() : 1;
          driver.invalidate();
        },
        hide() {
          showing = null;
          driver.invalidate();
        },
        stampOnset: (fn) => driver.stampOnset(fn),
        tick: opts.tick || null,
        emit(rec) {
          if (staircase && !staircase.frozen()) {
            staircase.record(rec.correct);
            if (rec.index + 1 >= STAIRCASE_TRIALS) settled = staircase.freeze();
          }
          emitted.push(rec);
          ctx.log(toRecord(rec, opts.phase || "scored"));
          if (mount.progress) mount.progress.set(machine.progress());
        },
      },
    });

    await new Promise((resolve) => {
      driver.setScene({
        step(sim) {
          machine.step(sim);
          if (machine.finished()) resolve();
        },
        draw(t, dt) {
          stage.beginFrame();
          const c = stage.ctx;

          if (distractorOn) {
            debris.update(dt);
            debris.draw(c, lineColour);
            driver.invalidate();
          }

          if (showing) {
            const x = stage.centreX();
            const y = stage.centreY();
            const fill = AceGame.atContrast(beamRgb, scopeRgb, showContrast);
            AceShapes.craft(
              c,
              x,
              y,
              craftSize,
              showing.side === "left" ? -TILT_DEG : TILT_DEG,
              fill,
            );
            stage.mark(x, y, craftSize);
          }
        },
      });
      driver.start();
    });

    driver.clearScene();
    mount.destroy();
    return { emitted, settled, accent };
  }

  function toRecord(rec, phase) {
    return AceGame.record({
      game: ID,
      trial_index: rec.index,
      condition: `${phase}:${rec.condition}:block${rec.trial.block}:isi${rec.trial.isi}`,
      t_onset: rec.onset,
      t_response: rec.response ? rec.response.t : null,
      rt: rec.rt,
      response_key: rec.response ? rec.response.key : null,
      correct: rec.correct,
      validity_flag: rec.valid,
      validity_reason: rec.reason,
      refresh_interval_measured: rec.quality.refreshIntervalMs,
      frames_dropped: rec.quality.framesDropped,
    });
  }

  // ── Instruction plates ────────────────────────────────────────────────────

  /**
   * Three plates, one sentence each, each with a moving demonstration under
   * it. The demonstration is drawn with the same shape function the game uses,
   * so what the child practises on is what the child sees.
   */
  function plates(band) {
    const scope = AceGame.rgb(AceGame.readToken("--scope"));
    const beam = AceGame.rgb(AceGame.readToken("--beam"));
    const accent = AceGame.readToken("--game-signal-watch");
    const line = AceGame.readToken("--scope-line");
    const full = AceGame.atContrast(beam, scope, 1);

    /** A chevron pointing left or right, drawn at the size of a keycap glyph. */
    function arrow(c, x, y, r, left, fill) {
      const d = left ? -1 : 1;
      c.fillStyle = fill;
      c.beginPath();
      c.moveTo(x + d * r, y);
      c.lineTo(x - d * r * 0.35, y - r * 0.8);
      c.lineTo(x - d * r * 0.35, y + r * 0.8);
      c.closePath();
      c.fill();
    }

    return [
      {
        line: "Small ships fly past the station.",
        paint(c, w, h, t) {
          const y = h / 2;
          AceShapes.horizon(c, w, y, line, 1);
          // Delta time, not a frame counter. One crossing every 3.6 seconds on
          // a 60 Hz panel and on a 165 Hz one.
          const period = 3600;
          const x = ((t % period) / period) * (w + w * 0.2) - w * 0.1;
          AceShapes.craft(c, x, y, w * 0.12, -8, full);
        },
      },
      {
        line: "Each ship leans a little to one side.",
        paint(c, w, h) {
          const y = h / 2;
          AceShapes.horizon(c, w, y, line, 1);
          AceShapes.craft(c, w * 0.32, y, w * 0.2, -8, full);
          AceShapes.craft(c, w * 0.68, y, w * 0.2, 8, full);
        },
      },
      {
        line: "Press the arrow key on the side it leans towards.",
        paint(c, w, h, t) {
          const y = h * 0.40;
          AceShapes.horizon(c, w, y, line, 1);
          // Alternates on a two second period, so a child sees both cases
          // without having to hold one in mind.
          const left = Math.floor(t / 2000) % 2 === 0;
          const span = w * 0.24;
          AceShapes.craft(c, w / 2, y, span, left ? -8 : 8, full);
          // The arrow sits under the wingtip that drops, so the mapping is
          // shown rather than described.
          arrow(c, w / 2 + (left ? -span / 2 : span / 2), y + h * 0.22, h * 0.055, left, accent);
        },
      },
    ];
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  async function run(ctx) {
    const random = AceTrial.createRandom(
      AceTrial.seedFrom(`${ctx.participantId}:${ID}`),
    );
    const tick = AceGame.createTick();

    for (const p of plates(ctx.band)) {
      await AceUI.plate({
        accent: "var(--game-signal-watch)",
        band: ctx.band,
        line: p.line,
        paint: p.paint,
        verb: "to carry on",
      });
    }

    // Practice. Feedback exists here because the child has to learn the
    // mapping, and practice trials are never scored.
    let learned = false;
    for (let attempt = 1; attempt <= PRACTICE_ATTEMPTS && !learned; attempt++) {
      await AceUI.pause({
        accent: "var(--game-signal-watch)",
        line:
          attempt === 1
            ? "Try a few first. You will hear a tick when you match the lean."
            : "Try a few more. Press the arrow on the side the ship leans.",
      });

      const practice = await runBlock(ctx, practiceTrials(random), {
        feedback: true,
        phase: "practice",
        tick: (trial, correct) => {
          if (correct) tick();
        },
      });
      const correct = practice.emitted.filter((e) => e.correct).length;
      ctx.event({
        kind: "practice_result",
        game: ID,
        attempt,
        correct,
        of: PRACTICE_TRIALS,
      });
      learned = correct >= PRACTICE_PASS;
    }

    if (!learned) {
      return {
        ok: false,
        reason: `the lean-matching rule was not learned in ${PRACTICE_ATTEMPTS} practice runs`,
      };
    }

    const plan = buildTrials(random, ctx.band);
    const staircase = createStaircase();

    await AceUI.pause({
      accent: "var(--game-signal-watch)",
      line: "The watch starts now. Keep looking at the middle.",
      position: `Watch 1 of ${ctx.gamesTotal}`,
    });

    const first = plan.trials.filter((t) => t.block === 0);
    const second = plan.trials.filter((t) => t.block === 1);

    const runOne = await runBlock(ctx, first, {
      staircase,
      progressMarks: 24,
      phase: "scored",
    });

    // The same line regardless of performance. Between-block copy carries no
    // performance information, in either direction.
    await AceUI.pause({
      accent: "var(--game-signal-watch)",
      line: "The watch is going well. One more stretch.",
      position: "Halfway",
    });

    const runTwo = await runBlock(ctx, second, {
      staircase,
      progressMarks: 24,
      phase: "scored",
    });

    const all = runOne.emitted.concat(runTwo.emitted);
    const summary = AceMetrics.signalWatch(all, {
      slowFirst: plan.slowFirst,
      staircase: runOne.settled || staircase.freeze(),
    });
    ctx.event({ kind: "game_summary", game: ID, summary });

    return { ok: true, summary };
  }

  return { id: ID, label: "Signal Watch", accent: "var(--game-signal-watch)", run };
})();
