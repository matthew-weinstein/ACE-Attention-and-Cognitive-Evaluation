const { app, BrowserWindow, ipcMain } = require("electron/main");
const path = require("path");

const BlinkTracker = require("./src/trackers/blink_tracker");
const HeadTracker = require("./src/trackers/head_tracker");
const EyeTracker = require("./src/trackers/eye_tracker");
const { runPreflight } = require("./src/preflight");

let blinkTracker = null;
let headTracker = null;
let eyeTracker = null;
let mainWindow = null;

// ── Window ────────────────────────────────────────────────────────────────────

async function createWindow() {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("renderer/index.html");

  // ── Instantiate trackers ───────────────────────────────────────────────────

  blinkTracker = new BlinkTracker();
  headTracker = new HeadTracker();
  eyeTracker = new EyeTracker();

  // ── Forward tracker events to renderer via IPC ─────────────────────────────

  // Preflight can fail before the page has loaded, and a send() at that point
  // reaches nothing.  Hold messages until the renderer is listening.
  let rendererLoaded = false;
  const deferred = [];

  mainWindow.webContents.on("did-finish-load", () => {
    rendererLoaded = true;
    while (deferred.length) {
      const [channel, data] = deferred.shift();
      mainWindow.webContents.send(channel, data);
    }
  });

  const send = (channel, data) => {
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
  headTracker.on("blink", (d) => send("blink-detected", d));
  headTracker.on("trackingStarted", (d) => send("head-tracking-started", d));
  headTracker.on("trackingStopped", (d) => send("head-tracking-stopped", d));
  headTracker.on("calibrated", (d) => send("head-tracker-calibrated", d));
  headTracker.on("error", (e) => send("head-tracker-error", e));

  eyeTracker.on("ready", (d) => send("eye-tracker-ready", d));
  eyeTracker.on("calibrationStarted", (d) =>
    send("eye-calibration-started", d),
  );
  eyeTracker.on("calibrationInstruction", (d) =>
    send("eye-calibration-instruction", d),
  );
  eyeTracker.on("calibrationCompleted", (d) =>
    send("eye-calibration-completed", d),
  );
  eyeTracker.on("gaze", (d) => send("gaze-detected", d));
  eyeTracker.on("headPose", (d) => send("head-pose-detected", d));
  eyeTracker.on("blink", (d) => send("blink-detected", d));
  eyeTracker.on("trackingStarted", (d) => send("eye-tracking-started", d));
  eyeTracker.on("trackingStopped", (d) => send("eye-tracking-stopped", d));
  eyeTracker.on("error", (e) => send("eye-tracker-error", e));

  // ── Preflight before spawning anything ────────────────────────────────────

  // Checks the venv path, Python version, required packages, the MediaPipe
  // model asset and the camera, and names the first one that is missing.
  // Without this a missing prerequisite only ever showed up as a handshake
  // timeout that blamed the wrong thing.
  const preflight = await runPreflight();

  if (!preflight.ok) {
    console.error(`Preflight failed [${preflight.check}]: ${preflight.message}`);
    const detail = { check: preflight.check, message: preflight.message };
    send("blink-tracker-error", detail);
    send("head-tracker-error", detail);
    send("eye-tracker-error", detail);
    return;
  }

  console.log(
    `Preflight passed: Python ${preflight.python} (${preflight.source}) at ${preflight.interpreter}, ` +
      `camera index ${preflight.cameraIndex}`,
  );

  // ── Start all three trackers concurrently ─────────────────────────────────

  // allSettled, not all: the blink and head processes are lifecycle stubs and
  // stay usable even when the eye tracker fails to start.
  const results = await Promise.allSettled([
    blinkTracker.initialize(),
    headTracker.initialize(),
    eyeTracker.initialize(),
  ]);

  const names = ["blink", "head", "eye"];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`${names[i]} tracker failed to start:\n${result.reason.message}`);
      send(`${names[i]}-tracker-error`, { message: result.reason.message });
    }
  });

  if (results.every((r) => r.status === "fulfilled")) {
    console.log("All trackers initialized");
  }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

const openWindow = () =>
  createWindow().catch((err) => console.error("Window startup failed:", err));

app.whenReady().then(() => {
  openWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
});

app.on("window-all-closed", () => {
  blinkTracker?.shutdown();
  headTracker?.shutdown();
  eyeTracker?.shutdown();
  if (process.platform !== "darwin") app.quit();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

// Blink
ipcMain.handle(
  "start-blink-tracking",
  (_e, sessionId) => blinkTracker?.startTracking(sessionId) ?? false,
);
ipcMain.handle(
  "stop-blink-tracking",
  () => blinkTracker?.stopTracking() ?? false,
);
ipcMain.handle("ping-blink-tracker", () => blinkTracker?.ping() ?? false);

// Eye
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

// Head
ipcMain.handle(
  "start-head-tracking",
  (_e, id) => headTracker?.startTracking(id) ?? false,
);
ipcMain.handle(
  "stop-head-tracking",
  () => headTracker?.stopTracking() ?? false,
);
ipcMain.handle(
  "calibrate-head-tracker",
  () => headTracker?.calibrate() ?? false,
);
ipcMain.handle("ping-head-tracker", () => headTracker?.ping() ?? false);
