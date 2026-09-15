const { app, BrowserWindow, ipcMain, screen, session, systemPreferences } =
  require("electron/main");
const path = require("path");

const BlinkTracker = require("./src/trackers/blink_tracker");
const HeadTracker = require("./src/trackers/head_tracker");
const EyeTracker = require("./src/trackers/eye_tracker");
const { runPreflight } = require("./src/preflight");
const { resolveGeometry, distancePlan } = require("./src/geometry");
const { SessionStore, STATUS } = require("./src/session_store");

let blinkTracker = null;
let headTracker = null;
let eyeTracker = null;
let mainWindow = null;
let store = null;
let send = () => {};

/** Preflight result, held so the renderer can report a Python problem. */
let preflightResult = null;

/** Cached geometry, recomputed when an operator supplies a manual size. */
let geometryCache = null;

/**
 * Camera permission at the app level.
 *
 * Electron approves every permission request by default and shows no prompt
 * of its own, so the web platform's permission states never occur. Holding an
 * explicit grant here is what makes "not yet requested" a real state rather
 * than a screen that can never appear.
 */
let cameraGrant = "not-requested"; // "not-requested" | "granted" | "denied"

/** Whether the eye tracker process is up, so the renderer can drive handoff. */
let eyeTrackerReady = false;

// Flags, from either the command line or the environment. The command line
// works the same way on every platform, which an env var does not.
const FLAGS = {
  debug: process.argv.includes("--debug") || Boolean(process.env.ACE_DEBUG),
  selfTest:
    process.argv.includes("--selftest") || Boolean(process.env.ACE_SELFTEST),
};

// ── Permission handlers ───────────────────────────────────────────────────────

/**
 * Both handlers are required. The request path and the synchronous check path
 * are consulted separately, and implementing only one leaves the other at the
 * permissive default.
 */
function installPermissionHandlers(ses) {
  const decide = (permission, details) => {
    if (permission !== "media") return false;
    const wantsVideo =
      !details ||
      !details.mediaTypes ||
      details.mediaTypes.includes("video") ||
      details.mediaType === "video";
    if (!wantsVideo) return false;
    return cameraGrant === "granted";
  };

  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(decide(permission, details));
  });

  ses.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    decide(permission, details),
  );
}

/**
 * Forward one eye tracker's events to the renderer.
 *
 * Kept in one place because the tracker process is replaced after a camera
 * loss, and a replacement that is wired differently from the original is a
 * silent source of missing events.
 */
function wireEyeTracker(tracker) {
  tracker.on("ready", (d) => {
    eyeTrackerReady = true;
    send("eye-tracker-ready", d);
  });
  tracker.on("calibrationStarted", (d) => send("eye-calibration-started", d));
  tracker.on("calibrationInstruction", (d) =>
    send("eye-calibration-instruction", d),
  );
  tracker.on("calibrationCompleted", (d) =>
    send("eye-calibration-completed", d),
  );
  tracker.on("gaze", (d) => send("gaze-detected", d));
  tracker.on("noFace", (d) => send("gaze-no-face", d));
  tracker.on("headPose", (d) => send("head-pose-detected", d));
  tracker.on("blink", (d) => send("blink-detected", d));
  tracker.on("trackingStarted", (d) => send("eye-tracking-started", d));
  tracker.on("trackingStopped", (d) => send("eye-tracking-stopped", d));
  tracker.on("cameraHealth", (d) => send("camera-health", d));
  tracker.on("cameraLost", (d) => {
    eyeTrackerReady = false;
    send("camera-lost", d);
  });
  tracker.on("cameraUnavailable", (d) => send("camera-unavailable", d));
  tracker.on("error", (e) => send("eye-tracker-error", e));
}

// ── Window ────────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    fullscreen: true,
    backgroundColor: "#e6e7e2",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),

      /*
       * Chromium throttles requestAnimationFrame in an occluded or
       * backgrounded window, in the worst case to once a second. Every
       * stimulus onset in this app is stamped off a rAF callback, so a
       * throttled loop does not merely stutter, it moves the measurement.
       *
       * Turning it off is half the fix. The other half is in the renderer:
       * a trial that spanned a focus loss is invalidated rather than trusted,
       * because a child who looked away from a throttled window is still a
       * child who looked away. See docs/assessment-design.md 9.1.
       */
      backgroundThrottling: false,
    },
  });

  installPermissionHandlers(mainWindow.webContents.session);

  // The renderer drives the whole camera lifecycle, so its console is where
  // a failed check explains itself. Off by default, because the child-facing
  // build has no use for it.
  if (FLAGS.debug) {
    const levels = ["debug", "info", "warn", "error"];
    mainWindow.webContents.on("console-message", (_e, level, message, line, src) => {
      const where = src ? `${src.split(/[\\/]/).pop()}:${line}` : "renderer";
      console.log(`[${levels[level] || level}] ${where} ${message}`);
    });
  }

  mainWindow.loadFile("renderer/index.html");

  blinkTracker = new BlinkTracker();
  headTracker = new HeadTracker();
  eyeTracker = new EyeTracker();

  // Messages can be produced before the page is listening. Hold them rather
  // than sending into nothing.
  let rendererLoaded = false;
  const deferred = [];

  mainWindow.webContents.on("did-finish-load", () => {
    rendererLoaded = true;
    while (deferred.length) {
      const [channel, data] = deferred.shift();
      mainWindow.webContents.send(channel, data);
    }
  });

  send = (channel, data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!rendererLoaded) {
      deferred.push([channel, data]);
      return;
    }
    mainWindow.webContents.send(channel, data);
  };

  blinkTracker.on("ready", (d) => send("blink-tracker-ready", d));
  blinkTracker.on("blink", (d) => send("blink-detected", d));
  blinkTracker.on("trackingStarted", (d) => send("blink-tracking-started", d));
  blinkTracker.on("trackingStopped", (d) => send("blink-tracking-stopped", d));
  blinkTracker.on("error", (e) => send("blink-tracker-error", e));

  headTracker.on("ready", (d) => send("head-tracker-ready", d));
  headTracker.on("headPose", (d) => send("head-pose-detected", d));
  headTracker.on("trackingStarted", (d) => send("head-tracking-started", d));
  headTracker.on("trackingStopped", (d) => send("head-tracking-stopped", d));
  headTracker.on("calibrated", (d) => send("head-tracker-calibrated", d));
  headTracker.on("error", (e) => send("head-tracker-error", e));

  wireEyeTracker(eyeTracker);

  // Preflight no longer probes the camera. The renderer does that with
  // getUserMedia, which can tell apart causes OpenCV cannot, and probing the
  // device twice risks a contention failure on the handoff.
  preflightResult = await runPreflight({ checkCamera: false });

  if (!preflightResult.ok) {
    console.error(
      `Preflight failed [${preflightResult.check}]: ${preflightResult.message}`,
    );
    send("preflight-failed", {
      check: preflightResult.check,
      message: preflightResult.message,
    });
    return;
  }

  console.log(
    `Preflight passed: Python ${preflightResult.python} ` +
      `(${preflightResult.source}) at ${preflightResult.interpreter}`,
  );

  // The stub lifecycle processes touch no hardware, so they can start now.
  // The eye tracker opens the camera and waits for the renderer to release it.
  const results = await Promise.allSettled([
    blinkTracker.initialize(),
    headTracker.initialize(),
  ]);
  ["blink", "head"].forEach((name, i) => {
    if (results[i].status === "rejected") {
      console.error(`${name} tracker failed to start:\n${results[i].reason.message}`);
      send(`${name}-tracker-error`, { message: results[i].reason.message });
    }
  });

  send("preflight-passed", {
    python: preflightResult.python,
    interpreter: preflightResult.interpreter,
  });

  if (FLAGS.selfTest) await runSelfTest();
}

/**
 * Check this machine's camera and print the result, then exit.
 *
 * Run with `npm run selftest`. Intended for setting a machine up before a child
 * is in front of it, and for reporting a problem from a site without a
 * session transcript. It exercises the same code path the session uses.
 */
async function runSelfTest() {
  const script = `
    (async () => {
      await window.aceCamera.requestAccess();
      const pre = await CameraProbe.preCheck();
      const result = pre ? { ok: false, ...pre } : await CameraProbe.run();
      const view = window.CameraStates.render(
        result.state,
        { ...(result.context || {}), platform: window.aceCamera.platform },
      );
      return { result, view, devices: (await CameraProbe.enumerateCameras()).length };
    })()
  `;

  try {
    const { result, view, devices } = await mainWindow.webContents.executeJavaScript(
      script,
      true,
    );
    const geo = await resolveGeometry(screen.getPrimaryDisplay(), null);

    console.log("\nACE camera self-test");
    console.log("--------------------");
    console.log(`  video inputs enumerated : ${devices}`);
    console.log(`  system access           : ${systemAccessStatus()}`);
    console.log(`  screen                  : ${geo.widthCm ?? "unknown"} cm (${geo.source})`);
    console.log(`  looking game supported  : ${geo.meetsMinimum ? "yes" : "no"}`);
    console.log(`  state                   : ${result.state}`);
    console.log(`  title                   : ${view.title}`);
    console.log(`  child sees              : ${view.child}`);
    if (view.adult) console.log(`  adult sees              : ${view.adult}`);
    if (view.detail) console.log(`  detail                  : ${view.detail}`);
    if (result.report) {
      const r = result.report;
      console.log(`  resolution              : ${r.width} by ${r.height}`);
      console.log(
        `  frame rate              : ${r.measuredFps ? r.measuredFps.toFixed(1) : "not measured"} measured, ` +
          `${r.negotiatedFps ?? "?"} negotiated`,
      );
      console.log(`  brightness              : ${r.luminance.mean.toFixed(0)} mean`);
    }
    console.log("");
  } catch (err) {
    console.error(`self-test failed to run: ${err.message}`);
  }
  app.exit(0);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const openWindow = () =>
  createWindow().catch((err) => console.error("Window startup failed:", err));

app.whenReady().then(() => {
  store = new SessionStore(path.join(app.getPath("userData"), "sessions"));
  const orphans = store.reconcileOrphans();
  if (orphans.length) {
    console.log(
      `Marked ${orphans.length} session(s) incomplete after an earlier exit`,
    );
  }

  openWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", async () => {
  blinkTracker?.shutdown();
  headTracker?.shutdown();
  eyeTracker?.shutdown();
  if (store) await store.drain();
  if (process.platform !== "darwin") app.quit();
});

// ── Camera permission IPC ─────────────────────────────────────────────────────

/**
 * The OS-level answer.
 *
 * Windows is supported and reports the privacy setting: a user-level block is
 * "denied" and an administrator or policy block is "restricted". Those need
 * different people to fix them, so the app keeps them apart.
 */
function systemAccessStatus() {
  try {
    if (typeof systemPreferences.getMediaAccessStatus !== "function") {
      return "unknown";
    }
    return systemPreferences.getMediaAccessStatus("camera");
  } catch {
    return "unknown";
  }
}

ipcMain.handle("camera:permission-state", () => ({
  system: systemAccessStatus(),
  app: cameraGrant,
  platform: process.platform,
}));

ipcMain.handle("camera:request-access", async () => {
  const system = systemAccessStatus();
  if (system === "restricted" || system === "denied") {
    cameraGrant = "denied";
    return { granted: false, system, app: cameraGrant };
  }

  // macOS holds its own permission and can be dismissed without an answer.
  if (process.platform === "darwin" && systemPreferences.askForMediaAccess) {
    const allowed = await systemPreferences.askForMediaAccess("camera");
    cameraGrant = allowed ? "granted" : "denied";
    return { granted: allowed, system: systemAccessStatus(), app: cameraGrant };
  }

  cameraGrant = "granted";
  return { granted: true, system, app: cameraGrant };
});

ipcMain.handle("camera:reset-permission", () => {
  cameraGrant = "not-requested";
  return { app: cameraGrant };
});

// ── Geometry IPC ──────────────────────────────────────────────────────────────

ipcMain.handle("geometry:resolve", async (_e, override) => {
  const display = mainWindow
    ? screen.getDisplayNearestPoint(mainWindow.getBounds())
    : screen.getPrimaryDisplay();
  geometryCache = await resolveGeometry(display, override || null);
  return geometryCache;
});

ipcMain.handle("geometry:plan", (_e, eccentricityDeg) =>
  distancePlan(geometryCache, eccentricityDeg),
);

// ── Tracker IPC ───────────────────────────────────────────────────────────────

/**
 * Start the eye tracker, which opens the camera the renderer has released.
 *
 * The reason is classified so the renderer can show the right screen. A camera
 * failure here is not "no camera": the renderer proved the device worked
 * seconds ago, so something took it in between.
 */
ipcMain.handle("tracker:start", async () => {
  if (eyeTrackerReady) return { ok: true, alreadyRunning: true };
  try {
    const ready = await eyeTracker.initialize();
    eyeTrackerReady = true;
    return { ok: true, data: ready.data || null };
  } catch (err) {
    const message = err.message || String(err);
    const cameraFailure = /camera|videocapture|could not open|device/i.test(message);
    return {
      ok: false,
      reason: cameraFailure ? "camera" : "process",
      message,
    };
  }
});

ipcMain.handle("tracker:stop", async () => {
  eyeTrackerReady = false;
  eyeTracker?.shutdown();
  // A fresh process, wired identically to the one it replaces.
  eyeTracker = new EyeTracker();
  wireEyeTracker(eyeTracker);
  return { ok: true };
});

ipcMain.handle("tracker:health-start", (_e, age) =>
  eyeTracker?.startHealth(age) ?? false,
);
ipcMain.handle("tracker:health-stop", () => eyeTracker?.stopHealth() ?? false);

ipcMain.handle("preflight:result", () => preflightResult);

// ── Session store IPC ─────────────────────────────────────────────────────────

let activeSessionId = null;

ipcMain.handle("session:begin", (_e, sessionId, meta) => {
  activeSessionId = sessionId;
  return store.begin(sessionId, {
    ...meta,
    appVersion: app.getVersion(),
    geometry: geometryCache,
  });
});

// One-way on purpose. The renderer must never await a disk write, because a
// slow disk would then be able to move a measurement.
ipcMain.on("session:trial", (_e, trial) => {
  if (activeSessionId) store.appendTrial(activeSessionId, trial);
});

ipcMain.on("session:event", (_e, event) => {
  if (activeSessionId) store.appendEvent(activeSessionId, event);
});

ipcMain.on("session:camera", (_e, camera) => {
  if (activeSessionId) store.setCamera(activeSessionId, camera);
});

ipcMain.on("session:game-completed", (_e, game) => {
  if (activeSessionId) store.markGameCompleted(activeSessionId, game);
});

ipcMain.handle("session:finish", async (_e, status, reason) => {
  if (!activeSessionId) return null;
  const manifest = store.finish(
    activeSessionId,
    status === "complete" ? STATUS.COMPLETE : STATUS.INCOMPLETE,
    reason,
  );
  await store.drain();
  activeSessionId = null;
  return manifest;
});

// ── Legacy tracker IPC, still used by the existing game screens ──────────────

ipcMain.handle(
  "start-blink-tracking",
  (_e, sessionId) => blinkTracker?.startTracking(sessionId) ?? false,
);
ipcMain.handle("stop-blink-tracking", () => blinkTracker?.stopTracking() ?? false);
ipcMain.handle("ping-blink-tracker", () => blinkTracker?.ping() ?? false);

ipcMain.handle(
  "calibrate-eye-tracker",
  (_e, w, h) => eyeTracker?.calibrate(w, h) ?? false,
);
ipcMain.handle(
  "start-eye-tracking",
  (_e, id) => eyeTracker?.startTracking(id) ?? false,
);
ipcMain.handle("stop-eye-tracking", () => eyeTracker?.stopTracking() ?? false);
ipcMain.handle("ping-eye-tracker", () => eyeTracker?.ping() ?? false);

ipcMain.handle(
  "start-head-tracking",
  (_e, id) => headTracker?.startTracking(id) ?? false,
);
ipcMain.handle("stop-head-tracking", () => headTracker?.stopTracking() ?? false);
ipcMain.handle("calibrate-head-tracker", () => headTracker?.calibrate() ?? false);
ipcMain.handle("ping-head-tracker", () => headTracker?.ping() ?? false);
