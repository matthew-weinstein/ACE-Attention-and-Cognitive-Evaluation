/**
 * Blink Tracking Integration Module
 *
 * This module handles communication between the Electron app and the Python
 * blink tracking script. It spawns the Python process and manages message passing.
 */

const { spawn } = require("child_process");
const path = require("path");

class BlinkTracker {
  constructor() {
    this.pythonProcess = null;
    this.isRunning = false;
    this.callbacks = {
      onReady: null,
      onBlinkDetected: null,
      onTrackingStarted: null,
      onTrackingStopped: null,
      onError: null,
    };
  }

  /**
   * Initialize the Python blink tracking process
   */
  initialize() {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, "blink_tracker.py");

      // Spawn Python process
      this.pythonProcess = spawn("python", [scriptPath]);

      // Handle stdout (messages from Python)
      this.pythonProcess.stdout.on("data", (data) => {
        const lines = data
          .toString()
          .split("\n")
          .filter((line) => line.trim());

        lines.forEach((line) => {
          try {
            const message = JSON.parse(line);
            this.handleMessage(message);

            // Resolve on ready message
            if (message.type === "status" && message.action === "ready") {
              this.isRunning = true;
              resolve(message);
            }
          } catch (error) {
            console.error("Failed to parse Python message:", line);
          }
        });
      });

      // Handle stderr (errors from Python)
      this.pythonProcess.stderr.on("data", (data) => {
        console.error("Python Error:", data.toString());
        if (this.callbacks.onError) {
          this.callbacks.onError(data.toString());
        }
      });

      // Handle process exit
      this.pythonProcess.on("close", (code) => {
        console.log(`Python process exited with code ${code}`);
        this.isRunning = false;
        this.pythonProcess = null;
      });

      // Handle spawn errors
      this.pythonProcess.on("error", (error) => {
        console.error("Failed to start Python process:", error);
        reject(error);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!this.isRunning) {
          reject(new Error("Python process initialization timeout"));
        }
      }, 5000);
    });
  }

  /**
   * Handle messages from Python script
   */
  handleMessage(message) {
    console.log("Received from Python:", message);

    switch (message.type) {
      case "status":
        if (
          message.action === "tracking_started" &&
          this.callbacks.onTrackingStarted
        ) {
          this.callbacks.onTrackingStarted(message.data);
        } else if (
          message.action === "tracking_stopped" &&
          this.callbacks.onTrackingStopped
        ) {
          this.callbacks.onTrackingStopped(message.data);
        } else if (message.action === "ready" && this.callbacks.onReady) {
          this.callbacks.onReady(message.data);
        }
        break;

      case "blink":
        if (message.action === "detected" && this.callbacks.onBlinkDetected) {
          this.callbacks.onBlinkDetected(message.data);
        }
        break;

      case "error":
        console.error("Python Error:", message.data);
        if (this.callbacks.onError) {
          this.callbacks.onError(message.data);
        }
        break;
    }
  }

  /**
   * Send command to Python script
   */
  sendCommand(action, data = {}) {
    if (!this.pythonProcess || !this.isRunning) {
      console.error("Python process not running");
      return false;
    }

    const command = {
      action: action,
      ...data,
    };

    this.pythonProcess.stdin.write(JSON.stringify(command) + "\n");
    return true;
  }

  /**
   * Start blink tracking for a session
   */
  startTracking(sessionId = "phase1") {
    return this.sendCommand("START", { session_id: sessionId });
  }

  /**
   * Stop blink tracking
   */
  stopTracking() {
    return this.sendCommand("STOP");
  }

  /**
   * Test connection with Python process
   */
  ping() {
    return this.sendCommand("PING");
  }

  /**
   * Set callback functions
   */
  on(event, callback) {
    const eventMap = {
      ready: "onReady",
      blink: "onBlinkDetected",
      trackingStarted: "onTrackingStarted",
      trackingStopped: "onTrackingStopped",
      error: "onError",
    };

    const callbackKey = eventMap[event];
    if (callbackKey) {
      this.callbacks[callbackKey] = callback;
    }
  }

  /**
   * Cleanup and shutdown
   */
  shutdown() {
    if (this.pythonProcess && this.isRunning) {
      this.sendCommand("EXIT");

      // Force kill after 2 seconds if not closed
      setTimeout(() => {
        if (this.pythonProcess) {
          this.pythonProcess.kill();
        }
      }, 2000);
    }
  }
}

module.exports = BlinkTracker;
