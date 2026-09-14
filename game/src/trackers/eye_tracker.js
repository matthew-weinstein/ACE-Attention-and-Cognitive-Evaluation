const path = require("path");
const PythonTracker = require("./base_tracker");

class EyeTracker extends PythonTracker {
  get scriptPath() {
    return path.join(__dirname, "../../python/eye_tracker.py");
  }

  get eventMap() {
    return {
      ready: "onReady",
      calibrationStarted: "onCalibrationStarted",
      calibrationInstruction: "onCalibrationInstruction",
      calibrationCompleted: "onCalibrationCompleted",
      gaze: "onGazeDetected",
      blink: "onBlinkDetected",
      headPose: "onHeadPoseDetected",
      trackingStarted: "onTrackingStarted",
      trackingStopped: "onTrackingStopped",
      error: "onError",
    };
  }

  routeMessage(msg) {
    switch (msg.type) {
      case "status":
        if (msg.action === "ready") this._callbacks.onReady?.(msg.data);
        if (msg.action === "tracking_started")
          this._callbacks.onTrackingStarted?.(msg.data);
        if (msg.action === "tracking_stopped")
          this._callbacks.onTrackingStopped?.(msg.data);
        break;
      case "calibration":
        if (msg.action === "started")
          this._callbacks.onCalibrationStarted?.(msg.data);
        if (msg.action === "instruction")
          this._callbacks.onCalibrationInstruction?.(msg.data);
        if (msg.action === "completed")
          this._callbacks.onCalibrationCompleted?.(msg.data);
        break;
      case "head_pose":
        if (msg.action === "detected")
          this._callbacks.onHeadPoseDetected?.(msg.data);
        break;
      case "gaze":
        if (msg.action === "detected")
          this._callbacks.onGazeDetected?.(msg.data);
        break;
      case "blink":
        if (msg.action === "detected")
          this._callbacks.onBlinkDetected?.(msg.data);
        break;
      case "error":
        this._callbacks.onError?.(msg.data);
        break;
    }
  }

  /** Trigger 9-point calibration; pass screen dimensions for pixel mapping. */
  calibrate(screenW, screenH) {
    return this.sendCommand("CALIBRATE", {
      screen_w: screenW || 1920,
      screen_h: screenH || 1080,
    });
  }
}

module.exports = EyeTracker;
