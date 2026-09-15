/**
 * Two Doors.
 *
 * Delay aversion. docs/assessment-design.md 4.4.
 *
 * One door opens fast and gives one crystal. One opens slowly and gives two.
 * The child gets twenty turns either way.
 *
 * ── The trials constraint is the whole measure ─────────────────────────────
 *
 * Sonuga-Barke et al. showed hyperactive children diverge from comparison
 * children specifically under a trials constraint, where choosing the quick
 * door does not shorten the session and therefore earns strictly less for no
 * benefit. Under a time constraint, choosing quick is rational and the groups
 * do not separate.
 *
 * So the constraint has to be evident, not merely true. Three things carry it:
 * the turn counter is on screen at all times, the sentence the child reads is
 * "You get twenty turns either way", and the two demonstration turns walk
 * through both doors before any free choice, so the child has felt both waits.
 *
 * ── The reward is the task ─────────────────────────────────────────────────
 *
 * Every other game in the battery keeps reward out of the scored block,
 * because reinforcement narrows the gap being measured. Here the choice
 * between rewards is the measurement, so the crystals are real, visible and
 * accumulating. Unlike elsewhere, that does not contaminate the measure, it
 * constitutes it.
 *
 * ── Waiting is enforced ────────────────────────────────────────────────────
 *
 * The countdown cannot be skipped and the window must stay focused. A focus
 * loss during a delay invalidates that turn, because a delay that was not
 * experienced measures nothing.
 */

const TwoDoors = (function () {
  const ID = "two_doors";

  const TRIALS = 20;
  const QUICK_DELAY_MS = 2000;
  const PATIENT_DELAY_MS = 12000;
  const QUICK_REWARD = 1;
  const PATIENT_REWARD = 2;

  /** No choice within this long draws one re-prompt, then the turn is void. */
  const CHOICE_LIMIT_MS = 10000;

  const DOOR_DEG = 7;

  async function run(ctx) {
    const random = AceTrial.createRandom(
      AceTrial.seedFrom(`${ctx.participantId}:${ID}`),
    );

    // Sides counterbalanced, and swapped halfway, so a side preference cannot
    // masquerade as a delay preference.
    const quickOnLeftFirst = random.next() < 0.5;

    await AceUI.plate({
      accent: "var(--game-two-doors)",
      band: ctx.band,
      line: "Two doors. One opens fast and gives one crystal.",
      paint: (c, w, h, t) => demo(c, w, h, t, 0),
    });
    await AceUI.plate({
      accent: "var(--game-two-doors)",
      band: ctx.band,
      line: "The other opens slowly and gives two crystals.",
      paint: (c, w, h, t) => demo(c, w, h, t, 1),
    });
    await AceUI.plate({
      accent: "var(--game-two-doors)",
      band: ctx.band,
      line: "You get twenty turns either way. Pick the door you want.",
      paint: (c, w, h, t) => demo(c, w, h, t, 2),
    });

    const mount = AceGame.mountStage("var(--game-two-doors)", {});
    const view = createView(ctx, mount);
    const choices = [];

    // Two demonstration turns, one through each door, so both waits and both
    // rewards are experienced before any free choice. The demonstration is the
    // instruction, and there is no pass criterion because there is no correct
    // answer.
    for (const forced of ["patient", "quick"]) {
      await runTurn(ctx, view, {
        index: -1,
        forced,
        quickOnLeft: quickOnLeftFirst,
        label: "Showing you both doors",
      });
    }
    view.resetCrystals();

    for (let i = 0; i < TRIALS; i++) {
      const quickOnLeft = i < TRIALS / 2 ? quickOnLeftFirst : !quickOnLeftFirst;
      const outcome = await runTurn(ctx, view, {
        index: i,
        forced: null,
        quickOnLeft,
        label: `Door ${i + 1} of ${TRIALS}`,
      });
      choices.push(outcome);

      ctx.log(
        AceGame.record({
          game: ID,
          trial_index: i,
          condition: `${outcome.choice}:${quickOnLeft ? "quick-left" : "quick-right"}`,
          t_onset: outcome.shownAt,
          t_response: outcome.chosenAt,
          rt: outcome.latencyMs,
          response_key: outcome.key,
          correct: null,
          validity_flag: outcome.valid,
          validity_reason: outcome.reason,
          refresh_interval_measured: window.aceDriver.intervalMs(),
          frames_dropped: 0,
        }),
      );
    }

    view.destroy();
    mount.destroy();
    window.aceDriver.clearScene();

    // The same warmth whatever was collected. A child who took the quick door
    // twenty times finishes with twenty crystals and the game is as pleased
    // with that as with forty.
    await AceUI.pause({
      accent: "var(--game-two-doors)",
      line: "Your crystals are safe in the hold.",
    });

    const summary = AceMetrics.twoDoors(choices);
    ctx.event({ kind: "game_summary", game: ID, summary });
    return { ok: true, summary };
  }

  // ── One turn ──────────────────────────────────────────────────────────────

  function runTurn(ctx, view, options) {
    const driver = window.aceDriver;
    const capture = ctx.capture;

    return new Promise((resolve) => {
      let phase = "choosing";
      let choiceAt = null;
      let chosen = null;
      let reprompted = false;
      let delayStart = 0;
      let lostFocus = false;

      const shownAt = performance.now();
      view.setTurn(options.label, options.quickOnLeft);
      capture.arm(shownAt);

      const onBlur = () => {
        if (phase === "waiting") lostFocus = true;
      };
      window.addEventListener("blur", onBlur);

      driver.setScene({
        step(sim) {
          if (phase === "choosing") {
            let side = null;
            if (options.forced) {
              // Demonstration turns open on their own after a moment, so the
              // child sees both doors without having to pick one yet.
              if (sim > 1400) {
                side = options.forced === "quick"
                  ? (options.quickOnLeft ? "left" : "right")
                  : (options.quickOnLeft ? "right" : "left");
              }
            } else {
              const press = capture.first();
              if (press) side = press.key === "ArrowLeft" ? "left" : "right";
              else if (sim > CHOICE_LIMIT_MS && !reprompted) {
                reprompted = true;
                view.reprompt();
              } else if (sim > CHOICE_LIMIT_MS * 2) {
                cleanUp();
                resolve({
                  choice: null,
                  valid: false,
                  reason: "no choice was made",
                  latencyMs: null,
                  shownAt,
                  chosenAt: null,
                  key: null,
                });
                return;
              }
            }

            if (side) {
              const quick = (side === "left") === options.quickOnLeft;
              chosen = {
                side,
                quick,
                delay: quick ? QUICK_DELAY_MS : PATIENT_DELAY_MS,
                reward: quick ? QUICK_REWARD : PATIENT_REWARD,
                key: side === "left" ? "ArrowLeft" : "ArrowRight",
              };
              choiceAt = performance.now();
              delayStart = sim;
              phase = "waiting";
              view.open(side, chosen.delay);
            }
            return;
          }

          if (phase === "waiting") {
            const elapsed = sim - delayStart;
            view.countdown(elapsed / chosen.delay);
            if (elapsed >= chosen.delay) {
              phase = "paying";
              view.award(chosen.reward);
            }
            return;
          }

          if (phase === "paying" && sim - delayStart >= chosen.delay + 900) {
            cleanUp();
            resolve({
              choice: chosen.quick ? "small_immediate" : "large_delayed",
              valid: !lostFocus,
              reason: lostFocus
                ? "window focus was lost during the wait, so the delay was not experienced"
                : null,
              latencyMs: Math.round(choiceAt - shownAt),
              shownAt,
              chosenAt: choiceAt,
              key: chosen.key,
            });
          }
        },
        draw: view.draw,
      });
      driver.start();

      function cleanUp() {
        window.removeEventListener("blur", onBlur);
      }
    });
  }

  // ── The scene ─────────────────────────────────────────────────────────────

  function createView(ctx, mount) {
    const stage = mount.stage;
    const driver = window.aceDriver;
    const accent = AceGame.readToken("--game-two-doors");
    const frame = AceGame.readToken("--beam-soft");
    const mouth = AceGame.readToken("--scope-raise");
    const lineColour = AceGame.readToken("--scope-line");
    const beam = AceGame.readToken("--beam");

    const label = AceUI.el("div", "label");
    label.style.position = "absolute";
    label.style.top = "var(--s6)";
    label.style.left = "var(--s7)";
    mount.root.appendChild(label);

    let quickOnLeft = true;
    let openSide = null;
    let openFraction = 0;
    let sweep = 0;
    let lastSweepDrawn = -1;
    let crystals = 0;
    let awarding = 0;

    stage.setStatic((c) => {
      AceShapes.horizon(c, stage.width(), stage.height() * 0.66, lineColour, 1);
    });

    function doorGeometry() {
      const w = 2 * stage.deg(DOOR_DEG / 2);
      const h = w * 1.7;
      const y = stage.height() * 0.66;
      const offset = stage.deg(11);
      return { w, h, y, left: stage.centreX() - offset, right: stage.centreX() + offset };
    }

    function draw() {
      const c = stage.ctx;
      stage.clearAll();
      const g = doorGeometry();

      AceShapes.door(c, g.left, g.y, g.w, g.h, openSide === "left" ? openFraction : 0, frame, mouth);
      AceShapes.door(c, g.right, g.y, g.w, g.h, openSide === "right" ? openFraction : 0, frame, mouth);

      // The wait, above the door that is open. The full track is always
      // drawn, so the child can see how much is left.
      if (openSide) {
        const x = openSide === "left" ? g.left : g.right;
        const r = g.w * 0.3;
        AceShapes.countdown(
          c,
          x,
          g.y - g.h - r * 2.1,
          r,
          sweep,
          lineColour,
          accent,
          Math.max(3, g.w * 0.055),
        );
      }

      // The hold. One crystal per unit collected, standing on their own line
      // well below the doors, so the count never competes with the choice.
      const size = stage.deg(1.4);
      const holdY = stage.height() * 0.88;
      c.fillStyle = lineColour;
      c.fillRect(stage.width() * 0.3, holdY + size * 0.6, stage.width() * 0.4, 1);
      const startX = stage.width() * 0.5 - ((crystals - 1) * size * 1.5) / 2;
      for (let i = 0; i < crystals; i++) {
        AceShapes.crystal(
          c,
          startX + i * size * 1.5,
          holdY,
          size,
          accent,
          frame,
        );
      }
    }

    return {
      draw,

      setTurn(text, quickLeft) {
        label.textContent = text;
        quickOnLeft = quickLeft;
        openSide = null;
        openFraction = 0;
        sweep = 0;
        lastSweepDrawn = -1;
        awarding = 0;
        driver.invalidate();
      },

      reprompt() {
        label.textContent = "Pick a door with the left or right arrow";
        driver.invalidate();
      },

      open(side) {
        openSide = side;
        openFraction = 1;
        driver.invalidate();
      },

      /**
       * Repaint only when the ring has moved far enough to see.
       *
       * At 12 seconds a degree and a half of sweep is 50 ms, so the ring
       * repaints about twenty times a second instead of 165. Nothing else on
       * the screen is moving during a wait, so those are the only paints in
       * the longest phase of the game.
       */
      countdown(fraction) {
        sweep = Math.min(1, fraction);
        const degrees = sweep * 360;
        if (lastSweepDrawn < 0 || degrees - lastSweepDrawn >= 1.5) {
          lastSweepDrawn = degrees;
          driver.invalidate();
        }
      },

      award(n) {
        if (awarding) return;
        awarding = n;
        crystals += n;
        driver.invalidate();
      },

      resetCrystals() {
        crystals = 0;
        driver.invalidate();
      },

      destroy() {
        label.remove();
      },
    };
  }

  // ── Demonstration ─────────────────────────────────────────────────────────

  function demo(c, w, h, t, which) {
    const accent = AceGame.readToken("--game-two-doors");
    const frame = AceGame.readToken("--beam-soft");
    const mouth = AceGame.readToken("--scope-raise");
    const y = h * 0.74;
    const dw = w * 0.13;
    const dh = dw * 1.7;

    AceShapes.horizon(c, w, y, AceGame.readToken("--scope-line"), 1);

    const cycle = (t % 4000) / 4000;
    const leftOpen = which === 0 ? Math.min(1, cycle * 4) : 0;
    const rightOpen = which === 1 ? Math.min(1, cycle * 1.4) : 0;

    AceShapes.door(c, w * 0.34, y, dw, dh, which === 2 ? 0 : leftOpen, frame, mouth);
    AceShapes.door(c, w * 0.66, y, dw, dh, which === 2 ? 0 : rightOpen, frame, mouth);

    const size = Math.min(w, h) * 0.045;
    if (which === 0 && leftOpen >= 1) {
      AceShapes.crystal(c, w * 0.34, y + size * 2.2, size, accent, mouth);
    }
    if (which === 1 && rightOpen >= 1) {
      AceShapes.crystal(c, w * 0.66 - size * 1.2, y + size * 2.2, size, accent, mouth);
      AceShapes.crystal(c, w * 0.66 + size * 1.2, y + size * 2.2, size, accent, mouth);
    }
  }

  return { id: ID, label: "Two Doors", accent: "var(--game-two-doors)", run };
})();
