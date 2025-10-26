const { app, BrowserWindow, ipcMain } = require("electron/main");
const BlinkTracker = require("./blink_integration");
const HeadTracker = require("./head_integration");
const EyeTraxTracker = require("./eyetrax_integration");


let blinkTracker = null;
let headTracker = null;
let eyeTracker = null;
let mainWindow = null;
let isCalibrating = false;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    autoHideMenuBar: true,
    fullscreen: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: require("path").join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");

  // Initialize blink tracker
  blinkTracker = new BlinkTracker();

  blinkTracker.on("ready", (data) => {
    console.log("Blink tracker ready:", data);
    mainWindow.webContents.send("blink-tracker-ready", data);
  });

  blinkTracker.on("blink", (data) => {
    console.log("Blink detected:", data);
    mainWindow.webContents.send("blink-detected", data);
  });

  blinkTracker.on("trackingStarted", (data) => {
    console.log("Blink tracking started:", data);
    mainWindow.webContents.send("blink-tracking-started", data);
  });

  blinkTracker.on("trackingStopped", (data) => {
    console.log("Blink tracking stopped:", data);
    mainWindow.webContents.send("blink-tracking-stopped", data);
  });

  blinkTracker.on("error", (error) => {
    console.error("Blink tracker error:", error);
    mainWindow.webContents.send("blink-tracker-error", error);
  });

  // Initialize head tracker
  headTracker = new HeadTracker();

  headTracker.on("ready", (data) => {
    console.log("Head tracker ready:", data);
    mainWindow.webContents.send("head-tracker-ready", data);
  });

  headTracker.on("headPose", (data) => {
    console.log("Head pose detected:", data);
    mainWindow.webContents.send("head-pose-detected", data);
  });

  headTracker.on("blink", (data) => {
    console.log("Blink detected:", data);
    mainWindow.webContents.send("blink-detected", data);
  });

  headTracker.on("trackingStarted", (data) => {
    console.log("Head tracking started:", data);
    mainWindow.webContents.send("head-tracking-started", data);
  });

  headTracker.on("trackingStopped", (data) => {
    console.log("Head tracking stopped:", data);
    mainWindow.webContents.send("head-tracking-stopped", data);
  });

  headTracker.on("calibrated", (data) => {
    console.log("Head tracker calibrated:", data);
    mainWindow.webContents.send("head-tracker-calibrated", data);
  });

  headTracker.on("error", (error) => {
    console.error("Head tracker error:", error);
    mainWindow.webContents.send("head-tracker-error", error);
  });

  // Set up event forwarding to renderer (eye tracker already initialized)
  if (eyeTracker) {
    eyeTracker.on("ready", (data) => {
      console.log("Eye tracker ready:", data);
      mainWindow.webContents.send("eye-tracker-ready", data);
    });

    eyeTracker.on("calibrationStarted", (data) => {
      console.log("Calibration started:", data);
      mainWindow.webContents.send("eye-calibration-started", data);
    });

    eyeTracker.on("calibrationInstruction", (data) => {
      console.log("Calibration instruction:", data);
      mainWindow.webContents.send("eye-calibration-instruction", data);
    });

    eyeTracker.on("calibrationCompleted", (data) => {
      console.log("Calibration completed:", data);
      mainWindow.webContents.send("eye-calibration-completed", data);
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
      mainWindow.webContents.send("eye-tracker-error", error);
    });
  }

  // Initialize both Python processes
  Promise.all([
    blinkTracker.initialize(),
    headTracker.initialize()
  ])
    .then(() => console.log("All trackers initialized successfully"))
    .catch((error) =>
      console.error("Failed to initialize trackers:", error)
    );
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
  // Cleanup trackers
  if (blinkTracker) {
    blinkTracker.shutdown();
  }
  if (headTracker) {
    headTracker.shutdown();
  }
  if (eyeTracker) {
    eyeTracker.shutdown();
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

// IPC handlers for blink tracking
ipcMain.handle("start-blink-tracking", async (event, sessionId) => {
  if (blinkTracker) {
    return blinkTracker.startTracking(sessionId);
  }
  return false;
});

ipcMain.handle("stop-blink-tracking", async () => {
  if (blinkTracker) {
    return blinkTracker.stopTracking();
  }
  return false;
});

ipcMain.handle("ping-blink-tracker", async () => {
  if (blinkTracker) {
    return blinkTracker.ping();
  }
  return false;
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

// IPC handlers for head tracking
ipcMain.handle("start-head-tracking", async (event, sessionId) => {
  if (headTracker) {
    return headTracker.startTracking(sessionId);
  }
  return false;
});

ipcMain.handle("stop-head-tracking", async () => {
  if (headTracker) {
    return headTracker.stopTracking();
  }
  return false;
});

ipcMain.handle("calibrate-head-tracker", async () => {
  if (headTracker) {
    return headTracker.calibrate();
  }
  return false;
});

ipcMain.handle("ping-head-tracker", async () => {
  if (headTracker) {
    return headTracker.ping();
  }
  return false;
});