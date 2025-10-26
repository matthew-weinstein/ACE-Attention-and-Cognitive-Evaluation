const { app, BrowserWindow, ipcMain } = require("electron/main");
const BlinkTracker = require("./blink_integration");
const HeadTracker = require("./head_integration");

let blinkTracker = null;
let headTracker = null;
let mainWindow = null;

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
  createWindow();

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
