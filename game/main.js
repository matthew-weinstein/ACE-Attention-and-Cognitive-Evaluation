const { app, BrowserWindow, ipcMain } = require("electron/main");
const BlinkTracker = require("./blink_integration");
const { spawn } = require("child_process");
const path = require("path");

let blinkTracker = null;
let mainWindow = null;
let calibrationComplete = false;

// Run calibration in a separate process before creating the main window
function runCalibration() {
  return new Promise((resolve, reject) => {
    console.log("Starting calibration process...");
    
    const calibrateScript = path.join(__dirname, "calibrate.py");
    const calibrationProcess = spawn("python", [calibrateScript]);

    let output = "";

    calibrationProcess.stdout.on("data", (data) => {
      const text = data.toString();
      output += text;
      console.log("Calibration:", text.trim());

      if (text.includes("CALIBRATION_SUCCESS")) {
        console.log("✅ Calibration completed successfully");
        calibrationComplete = true;
        resolve(true);
      } else if (text.includes("CALIBRATION_FAILED")) {
        console.error("❌ Calibration failed");
        reject(new Error(text));
      }
    });

    calibrationProcess.stderr.on("data", (data) => {
      console.error("Calibration error:", data.toString());
    });

    calibrationProcess.on("close", (code) => {
      if (code !== 0 && !calibrationComplete) {
        reject(new Error(`Calibration process exited with code ${code}`));
      }
    });

    calibrationProcess.on("error", (error) => {
      console.error("Failed to start calibration process:", error);
      reject(error);
    });
  });
}

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

  // Forward gaze position events to renderer
  blinkTracker.on("gaze", (data) => {
    // Optionally, you can clamp or transform coordinates here before sending
    mainWindow.webContents.send("gaze-position", data);
  });

  blinkTracker.on("trackingStarted", (data) => {
    console.log("Tracking started:", data);
    mainWindow.webContents.send("blink-tracking-started", data);
  });

  blinkTracker.on("trackingStopped", (data) => {
    console.log("Tracking stopped:", data);
    mainWindow.webContents.send("blink-tracking-stopped", data);
  });

  blinkTracker.on("error", (error) => {
    console.error("Blink tracker error:", error);
    mainWindow.webContents.send("blink-tracker-error", error);
  });

  // Initialize the Python process
  blinkTracker
    .initialize()
    .then(() => console.log("Blink tracker initialized successfully"))
    .catch((error) =>
      console.error("Failed to initialize blink tracker:", error)
    );
};

app.whenReady().then(async () => {
  // Run calibration first before opening the main window
  try {
    await runCalibration();
    console.log("Calibration complete, creating main window...");
  } catch (error) {
    console.error("Calibration failed:", error);
    // Show error dialog
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "Calibration Failed",
      `Failed to complete eye tracking calibration:\n${error.message}\n\nThe app will continue but gaze tracking may not work properly.`
    );
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Cleanup blink tracker
  if (blinkTracker) {
    blinkTracker.shutdown();
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
