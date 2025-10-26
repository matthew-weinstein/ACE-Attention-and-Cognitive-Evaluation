/**
 * EyeTrax Eye Tracking Integration Module
 *
 * This module handles communication between the Electron app and the Python
 * eye tracking script using EyeTrax. It manages calibration and gaze tracking.
 */

const { spawn } = require("child_process");
const path = require("path");

class EyeTraxTracker {
  constructor() {
    this.pythonProcess = null;
    this.isRunning = false;
    this.isCalibrated = false;
    this.callbacks = {
      onReady: null,
      onCalibrationStarted: null,
      onCalibrationInstruction: null,
      onCalibrationCompleted: null,
      onGazeDetected: null,
      onBlinkDetected: null,
      onTrackingStarted: null,
      onTrackingStopped: null,
      onError: null,
    };
  }

  /**
   * Initialize the Python eye tracking process
   */
  initialize() {
    return new Promise((resolve, reject) => {
      const scriptPath = path.join(__dirname, "eyetrax_tracker.py");

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
        console.error("Python Eye Tracking Error:", data.toString());
        if (this.callbacks.onError) {
          this.callbacks.onError(data.toString());
        }
      });

      // Handle process exit
      this.pythonProcess.on("close", (code) => {
        console.log(`Python eye tracking process exited with code ${code}`);
        this.isRunning = false;
        this.pythonProcess = null;
      });

      // Handle spawn errors
      this.pythonProcess.on("error", (error) => {
        console.error("Failed to start Python eye tracking process:", error);
        reject(error);
      });

      // Timeout after 10 seconds (calibration might take a while)
      setTimeout(() => {
        if (!this.isRunning) {
          reject(new Error("Python eye tracking process initialization timeout"));
        }
      }, 10000);
    });
  }

  /**
   * Handle messages from Python script
   */
  handleMessage(message) {
    console.log("Received from Python Eye Tracker:", message);

    switch (message.type) {
      case "status":
        if (message.action === "ready" && this.callbacks.onReady) {
          this.callbacks.onReady(message.data);
        } else if (
          message.action === "tracking_started" &&
          this.callbacks.onTrackingStarted
        ) {
          this.callbacks.onTrackingStarted(message.data);
        } else if (
          message.action === "tracking_stopped" &&
          this.callbacks.onTrackingStopped
        ) {
          this.callbacks.onTrackingStopped(message.data);
        }
        break;

      case "calibration":
        if (
          message.action === "started" &&
          this.callbacks.onCalibrationStarted
        ) {
          this.callbacks.onCalibrationStarted(message.data);
        } else if (
          message.action === "instruction" &&
          this.callbacks.onCalibrationInstruction
        ) {
          this.callbacks.onCalibrationInstruction(message.data);
        } else if (
          message.action === "completed" &&
          this.callbacks.onCalibrationCompleted
        ) {
          this.isCalibrated = true;
          this.callbacks.onCalibrationCompleted(message.data);
        }
        break;

      case "gaze":
        if (message.action === "detected" && this.callbacks.onGazeDetected) {
          this.callbacks.onGazeDetected(message.data);
        }
        break;

      case "blink":
        if (message.action === "detected" && this.callbacks.onBlinkDetected) {
          this.callbacks.onBlinkDetected(message.data);
        }
        break;

      case "error":
        console.error("Python Eye Tracking Error:", message.data);
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
      console.error("Python eye tracking process not running");
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
   * Run calibration routine
   */
  calibrate() {
    return this.sendCommand("CALIBRATE");
  }

  /**
   * Start eye tracking for a session
   */
  startTracking(sessionId = "phase1") {
    if (!this.isCalibrated) {
      console.error("Eye tracker not calibrated");
      if (this.callbacks.onError) {
        this.callbacks.onError({
          message: "Please calibrate the eye tracker first",
        });
      }
      return false;
    }
    return this.sendCommand("START", { session_id: sessionId });
  }

  /**
   * Stop eye tracking
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
      calibrationStarted: "onCalibrationStarted",
      calibrationInstruction: "onCalibrationInstruction",
      calibrationCompleted: "onCalibrationCompleted",
      gaze: "onGazeDetected",
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

module.exports = EyeTraxTracker;
