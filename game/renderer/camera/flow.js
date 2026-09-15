/**
 * Camera lifecycle.
 *
 * Runs the checks in dependency order and stops at the first unmet one, so
 * the screen a child sees always names the thing that is actually wrong.
 *
 *   screen geometry  ->  camera opens  ->  stream is usable  ->  handoff to
 *   the tracker  ->  the face is usable  ->  the child is at the right
 *   distance  ->  ready
 *
 * Geometry comes first because every later threshold is stated in degrees of
 * visual angle, and a degree cannot be expressed without it.
 *
 * See docs/calibration-design.md section 11.
 */

const CameraFlow = (function () {
  const S = () => window.CameraStates.STATES;

  /** Eccentricity the looking game needs, from assessment-design.md 5.1. */
  const REQUIRED_ECCENTRICITY_DEG = 20;

  /** Consecutive good health reports before the position check passes. */
  const POSITION_HOLD_FRAMES = 20;

  /** Health thresholds applied to the tracker's own measurements. */
  const HEALTH = {
    backlitGap: 55,
    minSubjectLuma: 60,
    minLaplacianVariance: 90,
    faceLossGraceMs: 1500,
  };

  let geometry = null;
  let plan = null;
  let lastReport = null;

  // ── Small helpers ──────────────────────────────────────────────────────────

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Record a lifecycle event.
   *
   * Goes to the session log once a session exists, and always to the console,
   * because the camera check runs before any session does and a check that
   * stops has to be able to say where.
   */
  function record(event) {
    console.info(`[camera] ${JSON.stringify(event)}`);
    if (window.aceSession && window.aceSession.appendEvent) {
      window.aceSession.appendEvent(event);
    }
  }

  /** Show a state and resolve with the id of the action the user chose. */
  function ask(stateId, context, actionIds) {
    return new Promise((resolve) => {
      const handlers = {};
      for (const id of actionIds) handlers[id] = () => resolve(id);
      CameraScreens.show(stateId, context, handlers);
      record({ kind: "camera_state", state: stateId, context });
    });
  }

  // ── Step 1: geometry ───────────────────────────────────────────────────────

  /**
   * Establish physical screen size, asking an operator for it only when the
   * platform cannot report it. A guessed size would silently corrupt every
   * angle in the session, so there is no guess.
   */
  async function resolveGeometry() {
    geometry = await window.aceGeometry.resolve(null);

    while (geometry.widthCm === null) {
      const input = CameraScreens.screenWidthInput();
      const chosen = await new Promise((resolve) => {
        const submit = () => resolve(parseFloat(input.value));
        CameraScreens.show(
          "GEOMETRY_UNKNOWN",
          {},
          { "enter-geometry": submit },
        );
        input.onkeydown = (e) => {
          if (e.key === "Enter") submit();
        };
      });

      if (Number.isFinite(chosen) && chosen >= 15 && chosen <= 200) {
        geometry = await window.aceGeometry.resolve({ widthCm: chosen });
      }
    }

    plan = await window.aceGeometry.plan(REQUIRED_ECCENTRICITY_DEG);
    record({
      kind: "geometry",
      source: geometry.source,
      confidence: geometry.confidence,
      widthCm: geometry.widthCm,
      meetsMinimum: geometry.meetsMinimum,
    });

    // A display too narrow for 20 degrees loses one game out of four and
    // keeps the rest of the battery. It is not a session failure.
    if (!geometry.meetsMinimum) {
      await ask(
        "DISPLAY_TOO_SMALL",
        {
          widthCm: geometry.widthCm,
          minWidthCm: geometry.minDisplayWidthCm,
        },
        ["continue"],
      );
      return { lookAwayAvailable: false };
    }

    return { lookAwayAvailable: true };
  }

  // ── Step 2 and 3: the camera opens, and its stream is usable ───────────────

  /**
   * Loop until the camera probe passes or the operator gives up.
   * Every failure shows its own screen with its own recovery action.
   */
  async function openAndMeasure() {
    for (;;) {
      const pre = await CameraProbe.preCheck();

      if (pre) {
        CameraScreens.setPreviewVisible(false);
        const action = await ask(
          pre.state,
          { ...pre.context, platform: window.aceCamera.platform },
          ["request", "retry"],
        );
        if (action === "request") {
          const granted = await CameraProbe.requestAccess();
          record({ kind: "camera_permission", ...granted });
        }
        continue;
      }

      const result = await CameraProbe.run();
      lastReport = result.report;

      if (result.ok) {
        record({ kind: "camera_probe", ok: true, report: result.report });
        return result.report;
      }

      record({
        kind: "camera_probe",
        ok: false,
        state: result.state,
        context: result.context,
      });

      CameraScreens.setPreviewVisible(false);
      await ask(
        result.state,
        { ...result.context, platform: window.aceCamera.platform },
        ["retry", "request", "recheck"],
      );
    }
  }

  // ── Step 4: handoff ────────────────────────────────────────────────────────

  /**
   * Start the tracker, which opens the camera the renderer has just released.
   *
   * A failure here is its own state. The renderer proved the device works
   * seconds ago, so "no camera" is the wrong message: something took it.
   */
  async function handOff() {
    for (;;) {
      const started = await window.aceTracker.start();
      if (started.ok) {
        record({ kind: "tracker_start", ok: true });
        return true;
      }

      record({ kind: "tracker_start", ok: false, reason: started.reason });

      const state =
        started.reason === "camera"
          ? S().TAKEN_BEFORE_START.id
          : S().HARDWARE_ERROR.id;

      const action = await ask(
        state,
        { errorMessage: started.message || null },
        ["retry"],
      );
      if (action !== "retry") return false;
    }
  }

  // ── Step 5 and 6: the face is usable, and the child is sitting right ───────

  /** Classify one tracker health report. Returns a state id, or null. */
  function judgeHealth(h) {
    if (!h.face_present) return { state: S().NO_FACE.id, context: {} };

    if (
      h.background_luma !== null &&
      h.subject_luma !== null &&
      h.background_luma - h.subject_luma > HEALTH.backlitGap &&
      h.subject_luma < HEALTH.minSubjectLuma * 1.6
    ) {
      return {
        state: S().TOO_DARK_BACKLIT.id,
        context: { subject: h.subject_luma, background: h.background_luma },
      };
    }

    if (h.subject_luma !== null && h.subject_luma < HEALTH.minSubjectLuma) {
      return {
        state: S().TOO_DARK_ROOM.id,
        context: { mean: h.subject_luma, minMean: HEALTH.minSubjectLuma },
      };
    }

    if (h.glare) return { state: S().GLASSES_GLARE.id, context: {} };

    if (
      h.laplacian_var !== null &&
      h.laplacian_var < HEALTH.minLaplacianVariance
    ) {
      return {
        state: S().BLURRED.id,
        context: {
          variance: h.laplacian_var,
          floor: HEALTH.minLaplacianVariance,
        },
      };
    }

    if (h.distance_cm !== null && plan) {
      if (h.distance_cm > plan.maxDistanceCm) {
        return {
          state: S().TOO_FAR.id,
          context: {
            distanceCm: h.distance_cm,
            targetCm: plan.targetDistanceCm,
          },
        };
      }
      if (h.distance_cm < plan.minDistanceCm) {
        return {
          state: S().TOO_CLOSE.id,
          context: {
            distanceCm: h.distance_cm,
            targetCm: plan.targetDistanceCm,
          },
        };
      }
    }

    return null;
  }

  /**
   * Hold the setup screen until the face and the distance have been good for
   * POSITION_HOLD_FRAMES consecutive reports.
   *
   * The screen only changes when the diagnosis changes. Flipping between two
   * near-tied causes every frame is unreadable, and for a child it is worse
   * than unreadable.
   */
  async function settleIntoPosition(age = null) {
    // The tracker owns the camera now, so frame quality comes from there.
    // It has the face box, which the renderer does not, and the face against
    // background comparison is the only check that catches a backlit child.
    await window.aceTracker.startHealth(age);

    return new Promise((resolve) => {
      let goodRun = 0;
      let shown = null;

      CameraScreens.setPreviewVisible(false);

      const finish = (value) => {
        window.aceTracker.stopHealth();
        resolve(value);
      };

      const unsubscribe = window.aceTracker.onHealth((h) => {
        const verdict = judgeHealth(h);

        CameraScreens.setGauge(h.distance_cm ?? null, plan);

        if (!verdict) {
          goodRun += 1;
          if (shown !== "OK") {
            shown = "OK";
            CameraScreens.show("OK", {}, {});
          }
          if (goodRun >= POSITION_HOLD_FRAMES) {
            unsubscribe();
            record({ kind: "position_settled", distanceCm: h.distance_cm });
            finish(true);
          }
          return;
        }

        goodRun = 0;
        if (shown !== verdict.state) {
          shown = verdict.state;
          CameraScreens.show(verdict.state, verdict.context, {
            recheck: () => {
              /* the next health report re-evaluates on its own */
            },
          });
          record({ kind: "camera_state", state: verdict.state });
        }
      });
    });
  }

  // ── Mid-session ────────────────────────────────────────────────────────────

  /**
   * Watch for the camera going away mid-session.
   *
   * Completed trials are already on disk, appended as each finished. This
   * marks the session incomplete, names the cause, and offers a return rather
   * than discarding anything.
   */
  function watchSession({ onResume, onEnd }) {
    const stop = window.aceTracker.onCameraLost(async (loss) => {
      record({ kind: "camera_lost", reason: loss.reason });

      const action = await ask(
        S().DISCONNECTED_MID_SESSION.id,
        { reason: loss.reason },
        ["retry", "end"],
      );

      if (action === "end") {
        await window.aceSession.finish(
          "incomplete",
          `the camera stopped: ${loss.reason}`,
        );
        CameraScreens.hide();
        onEnd();
        return;
      }

      const recovered = await recover();
      if (recovered) {
        CameraScreens.hide();
        onResume();
      } else {
        await window.aceSession.finish(
          "incomplete",
          "the camera did not come back",
        );
        CameraScreens.hide();
        onEnd();
      }
    });

    return stop;
  }

  /** Re-run the camera checks after a loss, without restarting the session. */
  async function recover() {
    await window.aceTracker.stop();
    await wait(400);
    const report = await openAndMeasure();
    if (!report) return false;
    const ok = await handOff();
    if (!ok) return false;
    return settleIntoPosition();
  }

  // ── Entry point ────────────────────────────────────────────────────────────

  /**
   * Run the full check. Resolves with what the rest of the app needs to know.
   * Never resolves in a state where the camera is unusable but the session
   * proceeds as though it were.
   */
  async function start() {
    CameraScreens.mount();

    const geo = await resolveGeometry();
    const report = await openAndMeasure();
    const handed = await handOff();

    if (!handed) {
      return {
        ok: false,
        lookAwayAvailable: false,
        geometry,
        plan,
        cameraReport: report,
      };
    }

    await settleIntoPosition();

    if (window.aceSession && window.aceSession.setCamera) {
      window.aceSession.setCamera({
        ...report,
        geometrySource: geometry.source,
        geometryConfidence: geometry.confidence,
      });
    }

    CameraScreens.hide();

    return {
      ok: true,
      lookAwayAvailable: geo.lookAwayAvailable,
      geometry,
      plan,
      cameraReport: report,
    };
  }

  return {
    start,
    watchSession,
    recover,
    judgeHealth,
    REQUIRED_ECCENTRICITY_DEG,
    geometry: () => geometry,
    plan: () => plan,
    lastReport: () => lastReport,
  };
})();
