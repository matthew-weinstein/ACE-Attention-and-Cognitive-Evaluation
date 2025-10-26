/**
 * Head Tracking Integration Module
 *
 * This module handles communication between the Electron app and the Python
 * head tracking script. It spawns the Python process and manages message passing.
 */

const { spawn } = require("child_process");
const path = require("path");

class HeadTracker {
  constructor() {
    this.pythonProcess = null;
    this.isRunning = false;
    this.callbacks = {
      onReady: null,
      onHeadPoseDetected: null,
      onBlinkDetected: null,
      onTrackingStarted: null,
      onTrackingStopped: null,
      onCalibrated: null,
      onError: null,
    };
  }

  /**
   * Initialize the Python head tracking process
   */
  initialize() {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, "head_tracker.py");

      console.log("Starting head tracker process:", scriptPath);

      this.pythonProcess = spawn("python", ["-u", scriptPath], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1"
        }
      });

      this.pythonProcess.stdout.on("data", (data) => {
        const lines = data
          .toString()
          .split("\n")
          .filter((line) => line.trim());

        lines.forEach((line) => {
          try {
            const message = JSON.parse(line);
            this.handleMessage(message);

            if (message.type === "status" && message.action === "ready") {
              this.isRunning = true;
              resolve(message);
            }
          } catch (error) {
            console.error("Failed to parse Python message:", line);
          }
        });
      });

      this.pythonProcess.stderr.on("data", (data) => {
        const message = data.toString();
        console.log("Head tracker stderr:", message);
        if (message.toLowerCase().includes('error') || message.toLowerCase().includes('exception')) {
          if (this.callbacks.onError) {
            this.callbacks.onError(message);
          }
        }
      });

      this.pythonProcess.on("close", (code) => {
        console.log(`Python process exited with code ${code}`);
        this.isRunning = false;
        this.pythonProcess = null;
      });

      this.pythonProcess.on("error", (error) => {
        console.error("Failed to start Python process:", error);
        reject(error);
      });

      setTimeout(() => {
        if (!this.isRunning) {
          console.error("Head tracker initialization timeout");
          reject(new Error("Python process initialization timeout"));
        }
      }, 10000);
    });
  }

  /**
   * Handle messages from Python script
   */
  handleMessage(message) {
    console.log("Received from Python (Head Tracker):", message);

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
        } else if (
          (message.action === "calibrated" || message.action === "recalibrated") &&
          this.callbacks.onCalibrated
        ) {
          this.callbacks.onCalibrated(message.data);
        }
        break;

      case "head_pose":
        if (message.action === "detected" && this.callbacks.onHeadPoseDetected) {
          this.callbacks.onHeadPoseDetected(message.data);
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
    if (!this.pythonProcess) {
      console.error("Head tracker Python process not initialized");
      return false;
    }

    if (!this.isRunning) {
      console.error("Head tracker Python process not running (not ready yet)");
      return false;
    }

    const command = {
      action: action,
      ...data,
    };

    try {
      console.log("Sending command to head tracker:", command);
      this.pythonProcess.stdin.write(JSON.stringify(command) + "\n");
      return true;
    } catch (error) {
      console.error("Failed to send command to head tracker:", error);
      return false;
    }
  }

  /**
   * Start head tracking for a session
   */
  startTracking(sessionId = "phase1") {
    return this.sendCommand("START", { session_id: sessionId });
  }

  /**
   * Stop head tracking
   */
  stopTracking() {
    return this.sendCommand("STOP");
  }

  /**
   * Recalibrate head pose
   */
  calibrate() {
    return this.sendCommand("CALIBRATE");
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
      headPose: "onHeadPoseDetected",
      blink: "onBlinkDetected",
      trackingStarted: "onTrackingStarted",
      trackingStopped: "onTrackingStopped",
      calibrated: "onCalibrated",
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
    console.log("Shutting down head tracker...");
    
    if (this.pythonProcess) {
      if (this.isRunning) {
        try {
          this.sendCommand("EXIT");
        } catch (error) {
          console.error("Error sending EXIT command:", error);
        }
      }

      setTimeout(() => {
        if (this.pythonProcess) {
          console.log("Force killing head tracker process");
          this.pythonProcess.kill('SIGTERM');
          
          setTimeout(() => {
            if (this.pythonProcess) {
              console.log("Force killing head tracker process (SIGKILL)");
              this.pythonProcess.kill('SIGKILL');
            }
          }, 1000);
        }
      }, 1000);
    }
  }
}

module.exports = HeadTracker;

