const { app, BrowserWindow, ipcMain } = require("electron/main");
const path = require("path");

const BlinkTracker = require("./src/trackers/blink_tracker");
const HeadTracker = require("./src/trackers/head_tracker");
const EyeTracker = require("./src/trackers/eye_tracker");

let blinkTracker = null;
let headTracker = null;
let eyeTracker = null;
let mainWindow = null;

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
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

  const send = (channel, data) => mainWindow.webContents.send(channel, data);

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

  // ── Start all three trackers concurrently ─────────────────────────────────

  Promise.all([
    blinkTracker.initialize(),
    headTracker.initialize(),
    eyeTracker.initialize(),
  ])
    .then(() => console.log("All trackers initialized"))
    .catch((err) => console.error("Tracker initialization error:", err));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
