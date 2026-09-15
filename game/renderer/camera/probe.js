/**
 * Camera probe.
 *
 * Opens the camera in the renderer, where getUserMedia can tell apart causes
 * that cv2.VideoCapture cannot, measures whether the stream is usable, then
 * releases the device so the Python tracker can open it.
 *
 * Two processes cannot reliably share a webcam on Windows. Compressed formats
 * take exclusive control and defeat the Media Foundation frame server, so the
 * app owns the camera in one process at a time. See
 * docs/calibration-design.md 11.1 and 11.2.
 */

const CameraProbe = (function () {
  const S = window.CameraStates.STATES;

  // Frame requirements. The luminance and focus figures are starting points
  // and must be tuned on real hardware before they mean anything. See
  // docs/calibration-design.md 11.5.
  const REQ = {
    minWidth: 640,
    minHeight: 480,
    minFps: 15,
    preferredFps: 30,
    minMeanLuma: 45,
    maxLuma: 225,
    maxClippedPercent: 12,
    backlitGap: 55,
    fpsWindowMs: 2000,
    frameTimeoutMs: 2500,
    watchdogStaleMs: 1500,
  };

  const ANALYSIS_W = 160;
  const ANALYSIS_H = 120;

  // ── Permission ─────────────────────────────────────────────────────────────

  /**
   * Permissions API state: "granted", "prompt", "denied", or null when the
   * query is unsupported.
   *
   * This is the only reliable way to tell a denial from a dismissal. Chromium
   * rejects getUserMedia with NotAllowedError for both, and differs only in a
   * non-normative message string that must not be branched on.
   */
  async function queryPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return null;
    try {
      const status = await navigator.permissions.query({ name: "camera" });
      return status.state;
    } catch {
      return null;
    }
  }

  /** Cameras visible without prompting. Labels are blank before permission. */
  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === "videoinput");
    } catch {
      return [];
    }
  }

  // ── Error mapping ──────────────────────────────────────────────────────────

  /**
   * True once this session has held a working stream. It is what separates a
   * camera another app has taken from a camera that never worked.
   */
  let hasStreamed = false;

  /**
   * Map a getUserMedia rejection to a camera state.
   *
   * `permissionAfter` is the Permissions API state read immediately after the
   * rejection, which is what separates a denial from a dismissal.
   */
  function mapError(err, permissionAfter) {
    const name = err && err.name;

    switch (name) {
      case "NotAllowedError":
        // Both a denial and a dismissal arrive here. A dismissal writes no
        // persistent setting, so the permission state is still "prompt".
        return permissionAfter === "denied"
          ? S.PERMISSION_DENIED.id
          : S.PERMISSION_DISMISSED.id;

      case "NotFoundError":
        return S.NO_CAMERA.id;

      case "OverconstrainedError":
        // A device exists but a mandatory constraint could not be met. With
        // only ideal constraints this means the pinned deviceId is gone.
        return err.constraint === "deviceId" ? S.NO_CAMERA.id : S.RESOLUTION_TOO_LOW.id;

      case "NotReadableError":
        // The OS would not start the device. That covers another application
        // holding it and a device that is listed but has nothing usable
        // behind it, and the two are indistinguishable from here.
        //
        // Observed on a machine whose only imaging device is a printer and
        // scanner: enumerateDevices reported one video input and getUserMedia
        // rejected with NotReadableError, so "another app has the camera"
        // would have been confidently wrong.
        //
        // If this session has already held a stream, the device does work and
        // something took it, which is a different screen.
        return hasStreamed ? S.TAKEN_BEFORE_START.id : S.CAMERA_WONT_START.id;

      case "AbortError":
      case "SecurityError":
      case "InvalidStateError":
      case "TypeError":
      default:
        return S.HARDWARE_ERROR.id;
    }
  }

  // ── Stream acquisition ─────────────────────────────────────────────────────

  /**
   * Ask for a stream.
   *
   * Constraints are ideal rather than mandatory on purpose. A mandatory
   * minimum rejects with OverconstrainedError, which does not say what the
   * camera could actually do. Opening at whatever the camera offers and then
   * reading getSettings lets the failure message name the real resolution.
   */
  async function acquire(deviceId) {
    const video = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: REQ.preferredFps },
    };
    if (deviceId) video.deviceId = { ideal: deviceId };
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  /**
   * Acquire, retrying once on a failure to start.
   *
   * A device is often held for a moment by something that has just released
   * it, or by the app's own previous stream that has not finished tearing
   * down. One short retry turns a fair share of those into a success rather
   * than a screen the adult has to act on.
   */
  async function acquireWithRetry(deviceId) {
    try {
      return await acquire(deviceId);
    } catch (err) {
      if (err && err.name === "NotReadableError") {
        await new Promise((r) => setTimeout(r, 700));
        return acquire(deviceId);
      }
      throw err;
    }
  }

  /** Stop every track and wait for the device to actually be released. */
  async function release(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        /* already gone */
      }
    }
    // Windows does not release the device the instant stop() returns, and the
    // Python tracker opens it next. A short settle avoids a spurious
    // "camera in use" on the handoff.
    await new Promise((r) => setTimeout(r, 250));
  }

  // ── Measurement ────────────────────────────────────────────────────────────

  /** Attach a stream to an offscreen video element and wait for real frames. */
  function attach(stream) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;

      const timer = setTimeout(
        () => reject(new Error("video produced no metadata")),
        REQ.frameTimeoutMs,
      );

      video.onloadedmetadata = () => {
        clearTimeout(timer);
        video.play().then(
          () => resolve(video),
          (err) => reject(err),
        );
      };
    });
  }

  /**
   * Achieved frame rate, measured rather than asked for.
   *
   * getSettings().frameRate reports the negotiated rate, which a camera can
   * miss by a wide margin. requestVideoFrameCallback reports frames that were
   * actually presented, and its presentationTime is a DOMHighResTimeStamp on
   * the same monotonic origin as performance.now(), which is the clock
   * CLAUDE.md requires. Frames are counted, and monotonic time is the
   * denominator: this measures throughput and never substitutes for a clock.
   */
  function measureFrameRate(video) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback !== "function") {
        return resolve({ supported: false, fps: null, stalled: false });
      }

      let firstTime = null;
      let firstPresented = null;
      let lastTime = null;
      let lastPresented = null;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        resolve(result);
      };

      const stallTimer = setTimeout(
        () => finish({ supported: true, fps: null, stalled: true }),
        REQ.frameTimeoutMs,
      );

      const step = (now, meta) => {
        const t = meta && meta.presentationTime ? meta.presentationTime : now;
        const presented = meta ? meta.presentedFrames : null;

        if (firstTime === null) {
          firstTime = t;
          firstPresented = presented;
        } else {
          lastTime = t;
          lastPresented = presented;
        }

        if (lastTime !== null && lastTime - firstTime >= REQ.fpsWindowMs) {
          const elapsed = lastTime - firstTime;
          const frames =
            lastPresented !== null && firstPresented !== null
              ? lastPresented - firstPresented
              : null;
          return finish({
            supported: true,
            stalled: false,
            fps: frames !== null ? (frames * 1000) / elapsed : null,
            frames,
            elapsedMs: elapsed,
          });
        }
        video.requestVideoFrameCallback(step);
      };

      video.requestVideoFrameCallback(step);
    });
  }

  /**
   * Luminance of one frame, on a downscaled copy.
   *
   * Mean luminance alone does not catch a backlit child, which is the common
   * living room failure. The centre against border comparison is a coarse
   * proxy for the face against background check that runs later on the Python
   * side, where a real face box exists.
   */
  function measureLuminance(video) {
    const canvas = document.createElement("canvas");
    canvas.width = ANALYSIS_W;
    canvas.height = ANALYSIS_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, ANALYSIS_W, ANALYSIS_H);

    const { data } = ctx.getImageData(0, 0, ANALYSIS_W, ANALYSIS_H);

    // The band a seated face occupies: middle 40 percent across, upper middle
    // 55 percent down.
    const cx0 = Math.floor(ANALYSIS_W * 0.3);
    const cx1 = Math.floor(ANALYSIS_W * 0.7);
    const cy0 = Math.floor(ANALYSIS_H * 0.1);
    const cy1 = Math.floor(ANALYSIS_H * 0.65);

    let total = 0;
    let count = 0;
    let centreTotal = 0;
    let centreCount = 0;
    let borderTotal = 0;
    let borderCount = 0;
    let clipped = 0;

    for (let y = 0; y < ANALYSIS_H; y++) {
      for (let x = 0; x < ANALYSIS_W; x++) {
        const i = (y * ANALYSIS_W + x) * 4;
        // Rec. 601 luma, which is what the tracker's greyscale conversion uses.
        const luma =
          0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

        total += luma;
        count++;
        if (luma >= 250) clipped++;

        if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) {
          centreTotal += luma;
          centreCount++;
        } else {
          borderTotal += luma;
          borderCount++;
        }
      }
    }

    return {
      mean: total / count,
      centre: centreCount ? centreTotal / centreCount : 0,
      border: borderCount ? borderTotal / borderCount : 0,
      clippedPercent: (clipped / count) * 100,
    };
  }

  /** Average luminance over several frames, so one odd frame decides nothing. */
  async function measureLuminanceAveraged(video, samples = 5, gapMs = 120) {
    const readings = [];
    for (let i = 0; i < samples; i++) {
      readings.push(measureLuminance(video));
      if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
    }
    const mean = (key) =>
      readings.reduce((a, r) => a + r[key], 0) / readings.length;
    return {
      mean: mean("mean"),
      centre: mean("centre"),
      border: mean("border"),
      clippedPercent: mean("clippedPercent"),
      samples: readings.length,
    };
  }

  // ── Verdicts ───────────────────────────────────────────────────────────────

  /**
   * Judge the measurements. Returns { state, context } or null when usable.
   * Order matters: a black frame makes every other measure meaningless, so
   * exposure is judged before anything derived from image content.
   */
  function judge(settings, rate, luma) {
    if (rate.stalled) {
      return {
        state: S.FRAMES_STOPPED.id,
        context: { stalledMs: REQ.frameTimeoutMs },
      };
    }

    const width = settings.width || 0;
    const height = settings.height || 0;
    if (width < REQ.minWidth || height < REQ.minHeight) {
      return {
        state: S.RESOLUTION_TOO_LOW.id,
        context: {
          width,
          height,
          minWidth: REQ.minWidth,
          minHeight: REQ.minHeight,
        },
      };
    }

    if (rate.supported && rate.fps !== null && rate.fps < REQ.minFps) {
      return {
        state: S.FRAMERATE_TOO_LOW.id,
        context: {
          measuredFps: rate.fps,
          minFps: REQ.minFps,
          windowMs: rate.elapsedMs || REQ.fpsWindowMs,
        },
      };
    }

    if (luma.clippedPercent > REQ.maxClippedPercent) {
      return {
        state: S.TOO_BRIGHT.id,
        context: {
          clippedPercent: luma.clippedPercent,
          maxClippedPercent: REQ.maxClippedPercent,
        },
      };
    }

    // A bright background with a dark subject reads as adequately exposed on
    // the mean alone. Check the gap before the mean, or this lands on the
    // wrong screen and the adult moves the wrong lamp.
    if (
      luma.border - luma.centre > REQ.backlitGap &&
      luma.centre < REQ.minMeanLuma * 1.6
    ) {
      return {
        state: S.TOO_DARK_BACKLIT.id,
        context: { subject: luma.centre, background: luma.border },
      };
    }

    if (luma.mean < REQ.minMeanLuma) {
      return {
        state: S.TOO_DARK_ROOM.id,
        context: { mean: luma.mean, minMean: REQ.minMeanLuma },
      };
    }

    return null;
  }

  // ── Orchestration ──────────────────────────────────────────────────────────

  /**
   * Run every check up to, but not including, requesting permission.
   * Separated so the app can show the "turn on the camera" screen without
   * having triggered a prompt it cannot take back.
   */
  async function preCheck() {
    const { system, app, platform } = await window.aceCamera.permissionState();

    // A system policy block and a personal setting need different people to
    // fix them, so they are different screens. On Windows, a user switching
    // camera access off reports "denied" and an administrator or group policy
    // block reports "restricted".
    if (system === "restricted") {
      return { state: S.BLOCKED_BY_POLICY.id, context: { system, platform } };
    }
    if (system === "denied") {
      return { state: S.PERMISSION_DENIED.id, context: { system, platform } };
    }

    // enumerateDevices never prompts. Labels are blank before permission is
    // granted, but a videoinput entry still appears, so the absence of one is
    // a reliable "no camera present" without asking for anything.
    const cameras = await enumerateCameras();
    if (cameras.length === 0) {
      return { state: S.NO_CAMERA.id, context: {} };
    }

    if (app === "not-requested") {
      return {
        state: S.PERMISSION_NOT_REQUESTED.id,
        context: { cameraCount: cameras.length, platform },
      };
    }

    if (app === "denied") {
      // On macOS the system prompt can be closed without an answer. A
      // dismissal writes no persistent setting, so the system status is still
      // undecided, which is what separates it from a refusal.
      const dismissed = system === "not-determined" || system === "unknown";
      return {
        state: dismissed
          ? S.PERMISSION_DISMISSED.id
          : S.PERMISSION_DENIED.id,
        context: { system, platform },
      };
    }

    return null; // granted at both levels, and a camera exists
  }

  /** Ask for access, then re-read the resulting state. */
  async function requestAccess() {
    const result = await window.aceCamera.requestAccess();
    return { ...result, platform: window.aceCamera.platform };
  }

  /**
   * Open the camera, measure it, and release it.
   *
   * Resolves with { ok: true, report } when the stream is usable, or
   * { ok: false, state, context, report } naming the exact failure.
   */
  async function run() {
    const blocked = await preCheck();
    if (blocked) return { ok: false, ...blocked, report: null };

    let stream = null;
    try {
      stream = await acquireWithRetry();
      hasStreamed = true;
    } catch (err) {
      const permissionAfter = await queryPermission();
      // Labels are only populated once permission has been granted, and by
      // this point it has. They are the fastest way for an adult to see that
      // the listed device is a scanner rather than a camera.
      const cameras = await enumerateCameras();
      return {
        ok: false,
        state: mapError(err, permissionAfter),
        context: {
          platform: window.aceCamera.platform,
          errorName: err && err.name,
          errorMessage: err && err.message,
          deviceLabels: cameras.map((c) => c.label).filter(Boolean),
        },
        report: null,
      };
    }

    let video = null;
    try {
      video = await attach(stream);

      const track = stream.getVideoTracks()[0];
      const settings = track ? track.getSettings() : {};
      const rate = await measureFrameRate(video);
      const luma = await measureLuminanceAveraged(video);

      // On macOS before Electron 30, getUserMedia can resolve with a stream
      // that never produces a frame when the system has denied access. A
      // resolved promise is not proof of a working camera there.
      if (rate.stalled) {
        const system = await window.aceCamera.systemAccessStatus();
        if (system === "denied" || system === "restricted") {
          return {
            ok: false,
            state:
              system === "restricted"
                ? S.BLOCKED_BY_POLICY.id
                : S.PERMISSION_DENIED.id,
            context: { system, platform: window.aceCamera.platform },
            report: null,
          };
        }
      }

      const report = {
        deviceLabel: track ? track.label : null,
        deviceId: settings.deviceId || null,
        width: settings.width || null,
        height: settings.height || null,
        negotiatedFps: settings.frameRate || null,
        measuredFps: rate.fps,
        frameRateSupported: rate.supported,
        luminance: {
          mean: luma.mean,
          subjectRegion: luma.centre,
          backgroundRegion: luma.border,
          clippedPercent: luma.clippedPercent,
        },
        measuredAt: performance.now(),
      };

      const verdict = judge(settings, rate, luma);
      if (verdict) {
        return { ok: false, state: verdict.state, context: verdict.context, report };
      }
      return { ok: true, state: S.OK.id, context: {}, report };
    } catch (err) {
      return {
        ok: false,
        state: S.HARDWARE_ERROR.id,
        context: { errorName: err && err.name, errorMessage: err && err.message },
        report: null,
      };
    } finally {
      if (video) {
        video.srcObject = null;
      }
      await release(stream);
    }
  }

  /**
   * Hold a live preview for the positioning step, and watch for the stream
   * dying underneath it.
   *
   * The watchdog is built on frame arrival rather than on the track mute
   * event, because mute could not be confirmed to fire when another
   * application takes the camera mid-stream. A frame that does not arrive is
   * observable regardless of which events the platform chooses to send.
   */
  async function openPreview(videoElement, onLost) {
    const stream = await acquire();
    videoElement.srcObject = stream;
    await videoElement.play();

    const track = stream.getVideoTracks()[0];
    let lastFrameAt = performance.now();
    let closed = false;

    const tick = () => {
      if (closed) return;
      lastFrameAt = performance.now();
      if (typeof videoElement.requestVideoFrameCallback === "function") {
        videoElement.requestVideoFrameCallback(tick);
      }
    };
    tick();

    const watchdog = setInterval(() => {
      if (closed) return;
      const stale = performance.now() - lastFrameAt;
      if (track && track.readyState === "ended") {
        onLost({ state: S.DISCONNECTED_MID_SESSION.id, context: { reason: "track ended" } });
      } else if (stale > REQ.watchdogStaleMs) {
        onLost({ state: S.FRAMES_STOPPED.id, context: { stalledMs: stale } });
      }
    }, 500);

    if (track) {
      track.addEventListener("ended", () =>
        onLost({
          state: S.DISCONNECTED_MID_SESSION.id,
          context: { reason: "track ended" },
        }),
      );
    }

    const onDeviceChange = async () => {
      const cameras = await enumerateCameras();
      if (cameras.length === 0) {
        onLost({ state: S.NO_CAMERA.id, context: { reason: "device removed" } });
      }
    };
    navigator.mediaDevices.addEventListener("devicechange", onDeviceChange);

    return {
      stream,
      async close() {
        closed = true;
        clearInterval(watchdog);
        navigator.mediaDevices.removeEventListener("devicechange", onDeviceChange);
        videoElement.srcObject = null;
        await release(stream);
      },
    };
  }

  return {
    REQ,
    queryPermission,
    enumerateCameras,
    mapError,
    judge,
    preCheck,
    requestAccess,
    run,
    /** Test seam for the "worked, then failed" branch of mapError. */
    _setHasStreamed: (value) => {
      hasStreamed = value;
    },
    openPreview,
    release,
  };
})();
