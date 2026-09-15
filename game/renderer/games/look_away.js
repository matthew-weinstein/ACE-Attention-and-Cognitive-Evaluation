/**
 * Look Away.
 *
 * Antisaccade. docs/assessment-design.md 5.1.
 *
 * A light flashes on one side. The child looks at the empty circle on the
 * other side. The only response in the battery that is not a keypress.
 *
 * ── Why the eccentricity is 20 degrees ─────────────────────────────────────
 *
 * It is the design lever that converts an unusable tracker into a usable one,
 * and it is the only reason this measure is in the battery at all. The cue
 * sits five to six times the 3 to 4 degree webcam accuracy budget from centre,
 * with a 12 degree landing zone each side and a 16 degree dead band through
 * the middle. A gaze sample has to be badly wrong, not merely imprecise, to be
 * assigned the wrong side.
 *
 * ── What is deliberately not measured ──────────────────────────────────────
 *
 * Saccade latency. At 33.3 ms sampling neither saccade onset nor latency is
 * recoverable, so neither is computed and neither is reported. Direction is
 * assigned by a dwell rule: a trial scores left or right when gaze sits inside
 * one landing zone for three consecutive frames, and the first zone entered
 * within the window decides it.
 *
 * ── Why this reports itself unavailable ────────────────────────────────────
 *
 * Section 5.3 lists five pipeline prerequisites, and the first is that gaze
 * samples carry a capture timestamp. They currently carry `x`, `y` and a
 * hardcoded confidence, with no time field at all, and there is no shared
 * epoch between the Python monotonic clock and the renderer's time origin. So
 * a gaze sample cannot be aligned to a stimulus onset, and a dwell rule
 * without an alignment is not a measurement.
 *
 * The game refuses to run rather than produce a number that looks like a
 * direction-error rate. `preconditions()` names which prerequisite is missing,
 * and section 7.1's own fallback applies: Two Doors takes slot four until the
 * pipeline lands.
 */

const LookAway = (function () {
  const ID = "look_away";

  const FIXATION_MIN_MS = 1200;
  const FIXATION_MAX_MS = 1800;
  const CUE_MS = 200;
  const WINDOW_MS = 1500;

  const ECCENTRICITY_DEG = 20;
  const ZONE_DEG = 12;
  const DEAD_BAND_DEG = 16;

  const SCORED_TRIALS = 40;
  const PRACTICE_TRIALS = 12;
  const PRACTICE_PASS_OF_LAST = 8;
  const PRACTICE_PASS_CORRECT = 7;

  /** Consecutive samples inside a zone before the direction is assigned. */
  const DWELL_FRAMES = 3;

  /**
   * Everything that has to be true before a direction-error rate means
   * anything. Each one is a named gap from 5.3, not a generic capability flag.
   */
  function preconditions(ctx) {
    const gaze = ctx.gaze || {};
    const missing = [];
    if (!gaze.samplesCarryCaptureTimestamp) {
      missing.push("gaze samples carry no capture timestamp, so they cannot be aligned to a stimulus onset");
    }
    if (!gaze.sharedEpoch) {
      missing.push("the tracker clock and the renderer clock share no epoch");
    }
    if (!gaze.realFrameClock) {
      missing.push("the tracker feeds MediaPipe a synthetic 30 fps counter rather than elapsed time");
    }
    if (!gaze.pacedLoop) {
      missing.push("the tracker loop period is inference time plus 33 ms, and the achieved rate is not measured");
    }
    if (!gaze.realConfidence) {
      missing.push("the tracker reports a constant confidence, so no sample can be filtered on quality");
    }
    if (!ctx.lookAwayAvailable) {
      missing.push("the display is too narrow to present a cue at 20 degrees");
    }
    if (ctx.calibrationResidualDeg === null || ctx.calibrationResidualDeg === undefined) {
      missing.push("calibration reports no residual in degrees, so a session cannot be rejected on calibration quality");
    } else if (ctx.calibrationResidualDeg > 5) {
      missing.push(`the calibration residual is ${ctx.calibrationResidualDeg.toFixed(1)} degrees, above the 5 degree limit`);
    }
    return missing;
  }

  function buildTrials(random, count) {
    const sides = AceTrial.balancedSequence(random, count, ["left", "right"], [0.5, 0.5], 3);
    return sides.map((cueSide, i) => ({
      index: i,
      cueSide,
      correctSide: cueSide === "left" ? "right" : "left",
      fixationMs: Math.round(random.between(FIXATION_MIN_MS, FIXATION_MAX_MS)),
    }));
  }

  // ── Dwell scoring ─────────────────────────────────────────────────────────

  /**
   * Assign a direction from a stream of gaze samples.
   *
   * A sample is in a zone when its horizontal eccentricity is inside the zone
   * and outside the dead band. Three consecutive samples in the same zone
   * assign the direction, and the first assignment within the window stands.
   * A later entry into the other zone is recorded as a correction rather than
   * overwriting the first, because a corrected error is a different thing from
   * a correct response and the design reports them separately.
   */
  function createDwell() {
    let run = 0;
    let runSide = null;
    let assigned = null;
    let corrected = false;
    let samples = 0;
    let withFace = 0;

    return {
      feed(sample) {
        samples += 1;
        if (!sample.face_present) {
          run = 0;
          runSide = null;
          return;
        }
        withFace += 1;

        const ecc = sample.eccentricityDeg;
        const magnitude = Math.abs(ecc);
        const side = ecc < 0 ? "left" : "right";
        const inZone =
          magnitude >= DEAD_BAND_DEG / 2 &&
          magnitude >= ECCENTRICITY_DEG - ZONE_DEG / 2 &&
          magnitude <= ECCENTRICITY_DEG + ZONE_DEG / 2;

        if (!inZone) {
          run = 0;
          runSide = null;
          return;
        }

        if (side === runSide) run += 1;
        else {
          runSide = side;
          run = 1;
        }

        if (run >= DWELL_FRAMES) {
          if (assigned === null) assigned = side;
          else if (side !== assigned) corrected = true;
        }
      },

      result(trial) {
        if (assigned === null) {
          return {
            direction: null,
            valid: false,
            reason: "gaze never settled in either landing zone",
            corrected: false,
          };
        }
        if (samples > 0 && withFace / samples < 0.8) {
          return {
            direction: null,
            valid: false,
            reason: "no face detected for more than 20 percent of the trial window",
            corrected: false,
          };
        }
        return {
          direction: assigned === trial.correctSide ? "away" : "toward",
          valid: true,
          reason: null,
          corrected,
        };
      },
    };
  }

  // ── The scene ─────────────────────────────────────────────────────────────

  async function runBlock(ctx, trials, options) {
    const opts = options || {};
    const mount = AceGame.mountStage("var(--game-look-away)", {});
    const stage = mount.stage;
    const driver = window.aceDriver;

    const core = AceGame.readToken("--beam");
    const halo = AceGame.readToken("--scope-raise");
    const cueColour = AceGame.readToken("--game-look-away");
    const lineColour = AceGame.readToken("--scope-line");

    const zoneRadius = stage.deg(ZONE_DEG / 2);
    const markerRadius = stage.deg(0.8);

    stage.setStatic((c) => {
      const y = stage.height() / 2;
      AceShapes.horizon(c, stage.width(), y, lineColour, 1);
      // The landing zones are rings, never filled targets. A filled target is
      // more attractive than the cue, and the task is to resist the cue.
      AceShapes.zone(c, stage.degX(-ECCENTRICITY_DEG), y, zoneRadius, lineColour, 2);
      AceShapes.zone(c, stage.degX(ECCENTRICITY_DEG), y, zoneRadius, lineColour, 2);
    });

    let phase = "fixation";
    let cueSide = null;
    let hint = null;
    const results = [];

    // Beacons persist for the game. Performance-linked and unavoidable: the
    // child needs to know whether they did the thing, and there is no other
    // channel for it when the response is an eye movement.
    const litZones = [];

    await new Promise((resolve) => {
      let index = 0;
      let trialStart = 0;
      let dwell = null;
      let onset = null;
      let unsubscribe = null;

      function beginTrial(sim) {
        if (index >= trials.length) {
          resolve();
          return false;
        }
        trialStart = sim;
        phase = "fixation";
        cueSide = null;
        dwell = createDwell();
        onset = null;
        hint = opts.hint ? trials[index].correctSide : null;
        driver.invalidate();
        return true;
      }

      unsubscribe = ctx.gaze.subscribe((sample) => {
        if (phase === "window" && dwell) dwell.feed(sample);
      });

      driver.setScene({
        step(sim) {
          if (dwell === null && !beginTrial(sim)) return;
          const trial = trials[index];
          const local = sim - trialStart;

          if (phase === "fixation" && local >= trial.fixationMs) {
            phase = "cue";
            cueSide = trial.cueSide;
            driver.stampOnset((at) => {
              onset = at;
            });
            driver.invalidate();
          }

          if (phase === "cue" && local >= trial.fixationMs + CUE_MS) {
            phase = "window";
            cueSide = null;
            driver.invalidate();
          }

          if (phase === "window" && local >= trial.fixationMs + CUE_MS + WINDOW_MS) {
            const outcome = dwell.result(trial);
            if (outcome.direction === "away") {
              litZones.push(trial.correctSide);
              driver.invalidate();
            }
            results.push({ ...outcome, trial, onset, index });
            ctx.log(
              AceGame.record({
                game: ID,
                trial_index: index,
                condition: `${opts.phase || "scored"}:cue-${trial.cueSide}`,
                t_onset: onset,
                t_response: null,
                rt: null,
                response_key: "gaze",
                correct: outcome.direction === "away",
                validity_flag: outcome.valid,
                validity_reason: outcome.reason,
                refresh_interval_measured: driver.intervalMs(),
                frames_dropped: 0,
              }),
            );
            index += 1;
            dwell = null;
            if (index >= trials.length) {
              if (unsubscribe) unsubscribe();
              resolve();
            }
          }
        },

        draw() {
          const c = stage.ctx;
          stage.clearAll();
          const y = stage.height() / 2;

          if (phase === "fixation") {
            AceShapes.marker(c, stage.centreX(), y, markerRadius * 3, core, halo);
          }

          if (cueSide) {
            const x = stage.degX(cueSide === "left" ? -ECCENTRICITY_DEG : ECCENTRICITY_DEG);
            c.fillStyle = cueColour;
            c.beginPath();
            c.arc(x, y, markerRadius * 1.4, 0, Math.PI * 2);
            c.fill();
          }

          // The practice arrow, fading out across trials six to twelve.
          if (hint && opts.hintStrength > 0) {
            const x = stage.degX(hint === "left" ? -ECCENTRICITY_DEG : ECCENTRICITY_DEG);
            c.globalAlpha = opts.hintStrength;
            c.fillStyle = core;
            c.fillRect(x - zoneRadius, y + zoneRadius * 1.3, zoneRadius * 2, 3);
            c.globalAlpha = 1;
          }

          for (const side of litZones) {
            const x = stage.degX(side === "left" ? -ECCENTRICITY_DEG : ECCENTRICITY_DEG);
            AceShapes.zone(c, x, y, zoneRadius, cueColour, 2);
          }
        },
      });
      driver.start();
    });

    driver.clearScene();
    mount.destroy();
    return results;
  }

  async function run(ctx) {
    const missing = preconditions(ctx);
    if (missing.length) {
      ctx.event({ kind: "game_unavailable", game: ID, missing });
      return { ok: false, reason: missing[0], missing };
    }

    const random = AceTrial.createRandom(
      AceTrial.seedFrom(`${ctx.participantId}:${ID}`),
    );

    await AceUI.plate({
      accent: "var(--game-look-away)",
      band: ctx.band,
      line: "A light will flash on one side.",
      paint: demoCue,
    });
    await AceUI.plate({
      accent: "var(--game-look-away)",
      band: ctx.band,
      line: "Look at the empty circle on the other side.",
      paint: demoAway,
    });
    await AceUI.plate({
      accent: "var(--game-look-away)",
      band: ctx.band,
      line: "Try not to look at the light.",
      paint: demoAway,
    });

    // The practice bar is high on purpose. A child who has not grasped the
    // reversal produces an error rate that measures comprehension rather than
    // inhibition, and that is the main threat to this measure's validity.
    const practice = await runBlock(ctx, buildTrials(random, PRACTICE_TRIALS), {
      phase: "practice",
      hint: true,
      hintStrength: 1,
    });
    const lastEight = practice.slice(-PRACTICE_PASS_OF_LAST);
    const learned =
      lastEight.filter((r) => r.direction === "away").length >= PRACTICE_PASS_CORRECT;

    if (!learned) {
      return { ok: false, reason: "the look-away rule was not demonstrated in practice" };
    }

    await AceUI.pause({
      accent: "var(--game-look-away)",
      line: "Last one. Look away from the light.",
    });

    const results = await runBlock(ctx, buildTrials(random, SCORED_TRIALS), {
      phase: "scored",
      hint: false,
      hintStrength: 0,
    });

    const summary = AceMetrics.lookAway(results);
    ctx.event({ kind: "game_summary", game: ID, summary });
    return { ok: true, summary };
  }

  function demoCue(c, w, h, t) {
    const y = h / 2;
    const r = Math.min(w, h) * 0.07;
    AceShapes.horizon(c, w, y, AceGame.readToken("--scope-line"), 1);
    AceShapes.zone(c, w * 0.16, y, r, AceGame.readToken("--scope-line"), 2);
    AceShapes.zone(c, w * 0.84, y, r, AceGame.readToken("--scope-line"), 2);
    if ((t % 2400) < 700) {
      c.fillStyle = AceGame.readToken("--game-look-away");
      c.beginPath();
      c.arc(w * 0.84, y, r * 0.3, 0, Math.PI * 2);
      c.fill();
    }
  }

  function demoAway(c, w, h, t) {
    demoCue(c, w, h, t);
    const y = h / 2;
    const r = Math.min(w, h) * 0.07;
    if ((t % 2400) >= 700) {
      AceShapes.zone(c, w * 0.16, y, r, AceGame.readToken("--game-look-away"), 3);
    }
  }

  return {
    id: ID,
    label: "Look Away",
    accent: "var(--game-look-away)",
    run,
    preconditions,
  };
})();
