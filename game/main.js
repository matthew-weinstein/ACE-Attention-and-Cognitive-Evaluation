const { app, BrowserWindow, ipcMain } = require("electron/main");
const BlinkTracker = require("./blink_integration");

let blinkTracker = null;
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

app.whenReady().then(() => {
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
