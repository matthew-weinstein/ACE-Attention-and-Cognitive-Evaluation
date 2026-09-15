/**
 * Preload bridge.
 *
 * Exposes the camera lifecycle, display geometry, tracker control and session
 * persistence to the renderer over contextBridge.
 *
 * Session writes are one-way sends rather than invokes. The renderer must
 * never await a disk write, because a slow disk would then be able to move a
 * measurement.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Subscribe and return an unsubscribe, so listeners do not accumulate. */
function subscribe(channel, callback) {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ── Camera permission and platform ───────────────────────────────────────────

contextBridge.exposeInMainWorld("aceCamera", {
  platform: process.platform,

  /** { system, app, platform }. `system` is the OS answer, `app` is ours. */
  permissionState: () => ipcRenderer.invoke("camera:permission-state"),

  /** Ask for access. On macOS this shows the real system prompt. */
  requestAccess: () => ipcRenderer.invoke("camera:request-access"),

  resetPermission: () => ipcRenderer.invoke("camera:reset-permission"),

  /** Convenience for the probe, which only needs the OS answer. */
  systemAccessStatus: async () =>
    (await ipcRenderer.invoke("camera:permission-state")).system,
});

// ── Display geometry ─────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("aceGeometry", {
  /** Resolve physical screen size. Pass { widthCm } to override EDID. */
  resolve: (override) => ipcRenderer.invoke("geometry:resolve", override),

  /** Viewing distance plan for an eccentricity in degrees. */
  plan: (eccentricityDeg) =>
    ipcRenderer.invoke("geometry:plan", eccentricityDeg),
});

// ── Tracker process control ──────────────────────────────────────────────────

contextBridge.exposeInMainWorld("aceTracker", {
  /** Start the tracker, which opens the camera the renderer has released. */
  start: () => ipcRenderer.invoke("tracker:start"),
  stop: () => ipcRenderer.invoke("tracker:stop"),

  startHealth: (age) => ipcRenderer.invoke("tracker:health-start", age),
  stopHealth: () => ipcRenderer.invoke("tracker:health-stop"),

  onHealth: (callback) => subscribe("camera-health", callback),
  onCameraLost: (callback) => subscribe("camera-lost", callback),
  onCameraUnavailable: (callback) => subscribe("camera-unavailable", callback),
  onNoFace: (callback) => subscribe("gaze-no-face", callback),

  preflight: () => ipcRenderer.invoke("preflight:result"),
  onPreflightFailed: (callback) => subscribe("preflight-failed", callback),
  onPreflightPassed: (callback) => subscribe("preflight-passed", callback),
});

// ── Session persistence ──────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("aceSession", {
  begin: (sessionId, meta) =>
    ipcRenderer.invoke("session:begin", sessionId, meta),

  /** Append one completed trial. Fire and forget, called between trials. */
  appendTrial: (trial) => ipcRenderer.send("session:trial", trial),
  appendEvent: (event) => ipcRenderer.send("session:event", event),
  setCamera: (camera) => ipcRenderer.send("session:camera", camera),
  markGameCompleted: (game) => ipcRenderer.send("session:game-completed", game),

  /** "complete" or "incomplete". Incomplete keeps every finished trial. */
  finish: (status, reason) =>
    ipcRenderer.invoke("session:finish", status, reason),
});

// ── Existing tracker APIs, unchanged for the current game screens ───────────

contextBridge.exposeInMainWorld("blinkTracker", {
  start: (sessionId) => ipcRenderer.invoke("start-blink-tracking", sessionId),
  stop: () => ipcRenderer.invoke("stop-blink-tracking"),
  ping: () => ipcRenderer.invoke("ping-blink-tracker"),
  onReady: (cb) => subscribe("blink-tracker-ready", cb),
  onBlinkDetected: (cb) => subscribe("blink-detected", cb),
  onTrackingStarted: (cb) => subscribe("blink-tracking-started", cb),
  onTrackingStopped: (cb) => subscribe("blink-tracking-stopped", cb),
  onError: (cb) => subscribe("blink-tracker-error", cb),
});

contextBridge.exposeInMainWorld("eyeTracker", {
  calibrate: (screenW, screenH) =>
    ipcRenderer.invoke("calibrate-eye-tracker", screenW, screenH),
  start: (sessionId) => ipcRenderer.invoke("start-eye-tracking", sessionId),
  stop: () => ipcRenderer.invoke("stop-eye-tracking"),
  ping: () => ipcRenderer.invoke("ping-eye-tracker"),
  onReady: (cb) => subscribe("eye-tracker-ready", cb),
  onCalibrationStarted: (cb) => subscribe("eye-calibration-started", cb),
  onCalibrationInstruction: (cb) => subscribe("eye-calibration-instruction", cb),
  onCalibrationCompleted: (cb) => subscribe("eye-calibration-completed", cb),
  onGazeDetected: (cb) => subscribe("gaze-detected", cb),
  onBlinkDetected: (cb) => subscribe("blink-detected", cb),
  onTrackingStarted: (cb) => subscribe("eye-tracking-started", cb),
  onTrackingStopped: (cb) => subscribe("eye-tracking-stopped", cb),
  onError: (cb) => subscribe("eye-tracker-error", cb),
});

contextBridge.exposeInMainWorld("headTracker", {
  start: (sessionId) => ipcRenderer.invoke("start-head-tracking", sessionId),
  stop: () => ipcRenderer.invoke("stop-head-tracking"),
  calibrate: () => ipcRenderer.invoke("calibrate-head-tracker"),
  ping: () => ipcRenderer.invoke("ping-head-tracker"),
  onReady: (cb) => subscribe("head-tracker-ready", cb),
  onHeadPoseDetected: (cb) => subscribe("head-pose-detected", cb),
  onTrackingStarted: (cb) => subscribe("head-tracking-started", cb),
  onTrackingStopped: (cb) => subscribe("head-tracking-stopped", cb),
  onCalibrated: (cb) => subscribe("head-tracker-calibrated", cb),
  onError: (cb) => subscribe("head-tracker-error", cb),
});
