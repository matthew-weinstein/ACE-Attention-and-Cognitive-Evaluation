/**
 * Session orchestration.
 *
 * The order of the battery is a measurement decision, not a menu. Signal Watch
 * runs first because it is the anchor and needs the freshest attention: a
 * vigilance measure taken after fifteen minutes of other games measures
 * fatigue as much as vigilance. Beacon Line runs second as a change of input
 * and posture. Asteroid Run runs third because a fast motor rhythm is
 * recoverable after a memory task. The camera game runs last because it is the
 * shortest, needs nothing from a tired hand, and a calibration check
 * immediately before it is cheaper than holding calibration across a session.
 *
 * ── The one animation loop ────────────────────────────────────────────────
 *
 * Created here and shared by every screen. Nothing else in the renderer calls
 * requestAnimationFrame, and nothing that affects a measurement calls
 * setTimeout or setInterval. The loop starts before the camera check so the
 * refresh median has a full window of samples long before the first stimulus.
 */

const AceApp = (function () {
  const GAMES = {
    signal_watch: () => SignalWatch,
    beacon_line: () => BeaconLine,
    asteroid_run: () => AsteroidRun,
    two_doors: () => TwoDoors,
    look_away: () => LookAway,
  };

  /**
   * What the gaze pipeline can currently do.
   *
   * Every flag here is false, and each one is a named item from
   * docs/assessment-design.md 5.3 rather than a generic capability bit. Look
   * Away reads them and refuses to run rather than produce a direction-error
   * rate that no gaze sample could support. When the pipeline work lands,
   * these flip and the game runs with no other change.
   */
  const GAZE_PIPELINE = {
    samplesCarryCaptureTimestamp: false,
    sharedEpoch: false,
    realFrameClock: false,
    pacedLoop: false,
    realConfidence: false,
  };

  let driver = null;
  let capture = null;
  let session = null;

  const exclusionCounts = {};

  function countExclusion(reason) {
    if (!reason) return;
    exclusionCounts[reason] = (exclusionCounts[reason] || 0) + 1;
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function main() {
    driver = AceDriver.createDriver({});
    window.aceDriver = driver;
    driver.start();

    capture = AceInput.createResponseCapture({
      keys: ["ArrowLeft", "ArrowRight", " "],
    }).attach(window);

    // Esc ends the session deliberately, and keeps every trial already on
    // disk. It is the only key outside the response set the app listens for.
    let abandoned = false;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") abandoned = true;
    });

    const operator = await AceStart.show();

    // The refresh median needs 120 consecutive frames. The camera check takes
    // far longer than that, so waiting costs nothing and guarantees no
    // stimulus is ever presented against a fallback interval.
    const cameraResult = await Promise.all([
      CameraFlow.start(),
      driver.whenConverged(),
    ]).then(([camera]) => camera);

    const lookAwayAvailable =
      cameraResult.ok &&
      cameraResult.lookAwayAvailable &&
      Object.values(GAZE_PIPELINE).every(Boolean);

    const planned = AceStart.batteryFor(operator.band, lookAwayAvailable);

    // Hand the stage its physical calibration. Degrees of visual angle need
    // the display size and the viewing distance, and neither is guessed.
    window.aceStageGeometry = {
      geometry: cameraResult.geometry
        ? {
            widthCm: cameraResult.geometry.widthCm,
            pixelWidth: window.screen.width * (window.devicePixelRatio || 1),
          }
        : null,
      viewingDistanceCm: cameraResult.plan
        ? cameraResult.plan.targetDistanceCm
        : 55,
    };

    const sessionId = `${operator.participantId}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}`;

    const manifest = await window.aceSession.begin(sessionId, {
      band: operator.band,
      gamesPlanned: planned,
      geometry: cameraResult.geometry || null,
      camera: cameraResult.cameraReport || null,
    });

    session = {
      participantId: operator.participantId,
      band: operator.band,
      dir: manifest && manifest.dir,
      games: [],
      exclusionCounts,
      camera: {},
      timing: {
        hz: driver.hz(),
        intervalMs: driver.intervalMs(),
        framesDropped: 0,
        stepMs: driver.stepper.stepMs,
      },
    };

    // A camera loss mid-session marks the session incomplete and keeps every
    // trial already written. Nothing is discarded.
    const stopWatching = cameraResult.ok
      ? CameraFlow.watchSession({
          onResume: () => {},
          onEnd: () => {
            abandoned = true;
          },
        })
      : null;

    const ctx = {
      participantId: operator.participantId,
      band: operator.band,
      age: operator.age,
      capture,
      gamesTotal: planned.length,
      lookAwayAvailable,
      calibrationResidualDeg: undefined,
      gaze: {
        ...GAZE_PIPELINE,
        subscribe: (fn) => window.aceTracker.onGaze
          ? window.aceTracker.onGaze(fn)
          : () => {},
      },
      log(trial) {
        window.aceSession.appendTrial(trial);
        if (!trial.validity_flag) countExclusion(trial.validity_reason);
      },
      event(payload) {
        window.aceSession.appendEvent(payload);
      },
    };

    await AceUI.pause({
      accent: "var(--sig-ok)",
      line: "You are set up. The first watch is about to start.",
      position: `${planned.length} games`,
    });

    for (let i = 0; i < planned.length && !abandoned; i++) {
      const game = GAMES[planned[i]]();
      const result = await game.run(ctx);

      session.games.push({
        id: game.id,
        label: game.label,
        ok: result.ok,
        reason: result.reason || null,
        missing: result.missing || null,
        summary: result.summary || null,
        haltedEarly: !result.ok,
      });

      if (result.ok) window.aceSession.markGameCompleted(game.id);

      if (i < planned.length - 1 && !abandoned) {
        await AceUI.pause({
          accent: "var(--sig-ok)",
          line: "Take a moment. The next one is different.",
          position: `${i + 1} of ${planned.length} done`,
        });
      }
    }

    if (stopWatching) stopWatching();
    driver.clearScene();

    session.timing.framesDropped = driver.framesDropped();
    session.timing.hz = driver.hz();
    session.timing.intervalMs = driver.intervalMs();

    const completed = session.games.filter((g) => g.ok).length;
    await window.aceSession.finish(
      abandoned || completed < planned.length ? "incomplete" : "complete",
      abandoned ? "the session was ended before the last game" : null,
    );

    // The child's last screen, before the report goes up for the adult.
    await AceUI.pause({
      accent: "var(--sig-ok)",
      line: "That is everything. Thank you for playing.",
      verb: "when an adult is ready",
    });

    AceReport.show(session);
  }

  return { main, GAZE_PIPELINE };
})();

window.addEventListener("DOMContentLoaded", () => {
  AceApp.main().catch((err) => {
    // A crash gets the same treatment as a camera failure: name the actual
    // cause on screen rather than leave a blank window.
    console.error(err);
    const { root, page } = AceUI.sheet({
      step: "The session stopped",
      title: "The app could not continue",
      paragraphs: [
        `The session stopped with this error: ${err && err.message ? err.message : String(err)}`,
        "Any trials already finished have been written to disk and the session is marked incomplete. Close the app and start a new session.",
      ],
    });
  });
});
