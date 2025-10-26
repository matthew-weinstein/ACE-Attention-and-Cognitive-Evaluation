const { app, BrowserWindow, ipcMain } = require("electron/main");
const BlinkTracker = require("./blink_integration");
const EyeTraxTracker = require("./eyetrax_integration");

let blinkTracker = null;
let eyeTracker = null;
let mainWindow = null;
let isCalibrating = false;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    fullscreen: true, // Show fullscreen immediately since calibration is done
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: require("path").join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");

  // Set up event forwarding to renderer (eye tracker already initialized)
  eyeTracker.on("ready", (data) => {
    console.log("Eye tracker ready:", data);
    mainWindow.webContents.send("eye-tracker-ready", data);
  });

  eyeTracker.on("calibrationStarted", (data) => {
    console.log("Calibration started:", data);
    // No window exists yet, so nothing to do here
    if (mainWindow) {
      mainWindow.webContents.send("eye-calibration-started", data);
    }
  });

  eyeTracker.on("calibrationInstruction", (data) => {
    console.log("Calibration instruction:", data);
    if (mainWindow) {
      mainWindow.webContents.send("eye-calibration-instruction", data);
    }
  });

  eyeTracker.on("calibrationCompleted", (data) => {
    console.log("Calibration completed:", data);
    // Window will be created after this event fires
    if (mainWindow) {
      mainWindow.webContents.send("eye-calibration-completed", data);
    }
  });

  eyeTracker.on("gaze", (data) => {
    // Send gaze data to renderer
    mainWindow.webContents.send("gaze-detected", data);
  });

  eyeTracker.on("blink", (data) => {
    console.log("Blink detected:", data);
    mainWindow.webContents.send("blink-detected", data);
  });

  eyeTracker.on("trackingStarted", (data) => {
    console.log("Eye tracking started:", data);
    mainWindow.webContents.send("eye-tracking-started", data);
  });

  eyeTracker.on("trackingStopped", (data) => {
    console.log("Eye tracking stopped:", data);
    mainWindow.webContents.send("eye-tracking-stopped", data);
  });

  eyeTracker.on("error", (error) => {
    console.error("Eye tracker error:", error);
    if (mainWindow) {
      mainWindow.webContents.send("eye-tracker-error", error);
    }
  });
};

app.whenReady().then(() => {
  // Initialize eye tracker BEFORE creating window
  eyeTracker = new EyeTraxTracker();

  eyeTracker.on("calibrationCompleted", (data) => {
    console.log("Calibration completed, now creating window...");
    // Create window only after calibration is done
    createWindow();
  });

  eyeTracker.on("error", (error) => {
    console.error("Eye tracker error:", error);
    // Create window anyway if calibration fails
    if (!mainWindow) {
      createWindow();
    }
  });

  // Initialize and calibrate before showing anything
  eyeTracker
    .initialize()
    .then(() => {
      console.log("Eye tracker initialized successfully");
      console.log("Starting automatic calibration...");
      eyeTracker.calibrate();
    })
    .catch((error) => {
      console.error("Failed to initialize eye tracker:", error);
      // Create window anyway if initialization fails
      createWindow();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Cleanup eye tracker
  if (eyeTracker) {
    eyeTracker.shutdown();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC handlers for eye tracking
ipcMain.handle("calibrate-eye-tracker", async () => {
  if (eyeTracker) {
    return eyeTracker.calibrate();
  }
  return false;
});

ipcMain.handle("start-eye-tracking", async (event, sessionId) => {
  if (eyeTracker) {
    return eyeTracker.startTracking(sessionId);
  }
  return false;
});

ipcMain.handle("stop-eye-tracking", async () => {
  if (eyeTracker) {
    return eyeTracker.stopTracking();
  }
  return false;
});

ipcMain.handle("ping-eye-tracker", async () => {
  if (eyeTracker) {
    return eyeTracker.ping();
  }
  return false;
});
