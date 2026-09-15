/**
 * Asteroid Run.
 *
 * Go/no-go. docs/assessment-design.md 4.2.
 *
 * A plain rock is tagged with the spacebar. A rock with a bright rim is
 * already tagged and is left alone. "Already tagged" is the whole reason the
 * framing works at six: it gives a reason to withhold that a child can hold in
 * mind, where an arbitrary rule does not.
 *
 * Not administered below age eight. Galloway-Long et al. found commission
 * errors reached AUC .608 and non-significance at ages 5 to 6, so running it
 * on a band A child would spend a quarter of their tolerance producing a
 * number that carries no information.
 *
 * ── Why there is no feedback of any kind ───────────────────────────────────
 *
 * Commission errors are the measure. Any signal that suppressed them would
 * destroy the metric, so a child who taps every rock sees exactly what a child
 * who performs perfectly sees. That includes sound, colour, counters and
 * anything that moves on a wrong press.
 */

const AsteroidRun = (function () {
  const ID = "asteroid_run";

  const STIMULUS_MS = 400;
  const WINDOW_MS = 900;
  const SOA_MS = 1000;

  const GO_TRIALS = 210;
  const NOGO_TRIALS = 90;
  const MIN_GO_RUN = 2;
  const MAX_GO_RUN = 5;

  const ROCK_DEG = 3;

  const PRACTICE_GO = 14;
  const PRACTICE_NOGO = 6;
  const PRACTICE_PASS_NOGO = 4;
  const PRACTICE_ATTEMPTS = 3;

  function buildTrials(random, goCount, nogoCount) {
    const kinds = AceTrial.prepotentSequence(
      random,
      goCount,
      nogoCount,
      MIN_GO_RUN,
      MAX_GO_RUN,
    );
    return kinds.map((kind, i) => ({
      kind,
      index: i,
      block: 0,
      variant: random.int(7),
    }));
  }

  async function runBlock(ctx, trials, options) {
    const opts = options || {};
    const mount = AceGame.mountStage("var(--game-asteroid-run)", {
      progressMarks: opts.progressMarks || 0,
    });
    const stage = mount.stage;
    const driver = window.aceDriver;
    const capture = ctx.capture;

    const lineColour = AceGame.readToken("--scope-line");
    const bodyColour = AceGame.readToken("--beam-soft");
    const facetColour = AceGame.readToken("--scope-raise");
    const rimColour = AceGame.readToken("--game-asteroid-run");

    stage.setStatic((c) => {
      AceShapes.horizon(c, stage.width(), stage.height() / 2, lineColour, 1);
    });

    const radius = stage.deg(ROCK_DEG / 2);
    let showing = null;
    const emitted = [];

    // A no-go trial after an invalidated go trial is itself invalid, because
    // prepotency depends on the run that preceded it.
    let previousInvalid = false;

    const machine = AceBlock.createCptMachine({
      trials,
      feedback: Boolean(opts.feedback),
      timing: () => ({
        leadMs: 0,
        stimulusMs: STIMULUS_MS,
        windowMs: WINDOW_MS,
        soaMs: SOA_MS,
      }),
      score: (trial, response) => ({
        condition: trial.kind,
        correct: trial.kind === "go" ? response !== null : response === null,
      }),
      judge: (rt, quality, cap) => {
        const base = AceGame.judge(rt, quality, cap);
        if (!base.valid) return base;
        if (previousInvalid) {
          return {
            valid: false,
            reason: "the preceding go trial was invalid, so prepotency is unknown",
          };
        }
        return base;
      },
      host: {
        capture,
        now: () => performance.now(),
        toReal: (sim) => driver.stepper.toReal(sim),
        show(trial) {
          showing = trial;
          driver.invalidate();
        },
        hide() {
          showing = null;
          driver.invalidate();
        },
        stampOnset: (fn) => driver.stampOnset(fn),
        tick: opts.tick || null,
        emit(rec) {
          previousInvalid = !rec.valid && rec.trial.kind === "go";
          emitted.push(rec);
          ctx.log(
            AceGame.record({
              game: ID,
              trial_index: rec.index,
              condition: `${opts.phase || "scored"}:${rec.condition}`,
              t_onset: rec.onset,
              t_response: rec.response ? rec.response.t : null,
              rt: rec.rt,
              response_key: rec.response ? rec.response.key : null,
              correct: rec.correct,
              validity_flag: rec.valid,
              validity_reason: rec.reason,
              refresh_interval_measured: rec.quality.refreshIntervalMs,
              frames_dropped: rec.quality.framesDropped,
            }),
          );
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
        draw() {
          stage.beginFrame();
          if (!showing) return;
          const x = stage.centreX();
          const y = stage.centreY();
          AceShapes.rock(
            stage.ctx,
            x,
            y,
            radius,
            showing.variant,
            bodyColour,
            facetColour,
            showing.kind === "nogo" ? rimColour : null,
          );
          stage.mark(x, y, radius * 1.4);
        },
      });
      driver.start();
    });

    driver.clearScene();
    mount.destroy();
    return emitted;
  }

  function plates() {
    const bodyColour = AceGame.readToken("--beam-soft");
    const facetColour = AceGame.readToken("--scope-raise");
    const rimColour = AceGame.readToken("--game-asteroid-run");
    const lineColour = AceGame.readToken("--scope-line");

    return [
      {
        line: "Rocks drift past the station.",
        paint(c, w, h, t) {
          AceShapes.horizon(c, w, h / 2, lineColour, 1);
          const r = h * 0.16;
          const period = 4200;
          for (let i = 0; i < 3; i++) {
            const phase = ((t + i * 1400) % period) / period;
            AceShapes.rock(c, phase * (w + r * 3) - r, h / 2, r, i, bodyColour, facetColour, null);
          }
        },
      },
      {
        line: "Press space to tag a plain rock.",
        paint(c, w, h) {
          AceShapes.horizon(c, w, h / 2, lineColour, 1);
          AceShapes.rock(c, w / 2, h / 2, h * 0.2, 2, bodyColour, facetColour, null);
        },
      },
      {
        line: "Leave the glowing ones. They are already tagged.",
        paint(c, w, h) {
          AceShapes.horizon(c, w, h / 2, lineColour, 1);
          AceShapes.rock(c, w * 0.34, h / 2, h * 0.18, 2, bodyColour, facetColour, null);
          AceShapes.rock(c, w * 0.66, h / 2, h * 0.18, 4, bodyColour, facetColour, rimColour);
        },
      },
    ];
  }

  async function run(ctx) {
    if (ctx.band === "A") {
      return { ok: false, reason: "not administered below age eight" };
    }

    const random = AceTrial.createRandom(
      AceTrial.seedFrom(`${ctx.participantId}:${ID}`),
    );
    const tick = AceGame.createTick();

    for (const p of plates()) {
      await AceUI.plate({
        accent: "var(--game-asteroid-run)",
        band: ctx.band,
        line: p.line,
        paint: p.paint,
      });
    }

    // Pass criterion is on the no-go trials alone. Getting the go trials right
    // demonstrates nothing: pressing on everything scores 14 of 20. What has
    // to be demonstrated is the withhold.
    let learned = false;
    for (let attempt = 1; attempt <= PRACTICE_ATTEMPTS && !learned; attempt++) {
      await AceUI.pause({
        accent: "var(--game-asteroid-run)",
        line:
          attempt === 1
            ? "Try a few first. You will hear a tick when you get one right."
            : "Try a few more. Leave the glowing rocks alone.",
      });

      const practice = await runBlock(
        ctx,
        buildTrials(random, PRACTICE_GO, PRACTICE_NOGO),
        {
          feedback: true,
          phase: "practice",
          tick: (trial, correct) => {
            if (correct) tick();
          },
        },
      );
      const nogoCorrect = practice.filter(
        (r) => r.trial.kind === "nogo" && r.correct,
      ).length;
      ctx.event({
        kind: "practice_result",
        game: ID,
        attempt,
        nogo_correct: nogoCorrect,
        of: PRACTICE_NOGO,
      });
      learned = nogoCorrect >= PRACTICE_PASS_NOGO;
    }

    if (!learned) {
      return {
        ok: false,
        reason: `the withhold rule was not demonstrated in ${PRACTICE_ATTEMPTS} practice runs`,
      };
    }

    await AceUI.pause({
      accent: "var(--game-asteroid-run)",
      line: "The run starts now. Tag the plain rocks.",
    });

    const emitted = await runBlock(
      ctx,
      buildTrials(random, GO_TRIALS, NOGO_TRIALS),
      { progressMarks: 30, phase: "scored" },
    );

    const summary = AceMetrics.asteroidRun(emitted);
    ctx.event({ kind: "game_summary", game: ID, summary });
    return { ok: true, summary };
  }

  return { id: ID, label: "Asteroid Run", accent: "var(--game-asteroid-run)", run };
})();
