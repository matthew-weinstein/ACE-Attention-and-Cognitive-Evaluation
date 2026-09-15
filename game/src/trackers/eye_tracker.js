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
      noFace: "onNoFace",
      blink: "onBlinkDetected",
      headPose: "onHeadPoseDetected",
      trackingStarted: "onTrackingStarted",
      trackingStopped: "onTrackingStopped",
      cameraHealth: "onCameraHealth",
      cameraLost: "onCameraLost",
      cameraUnavailable: "onCameraUnavailable",
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
      case "camera":
        // Separate channels on purpose. A health report, a device that never
        // opened, and a device that went away mid-session lead to three
        // different screens and three different recoveries.
        if (msg.action === "health") this._callbacks.onCameraHealth?.(msg.data);
        if (msg.action === "lost") this._callbacks.onCameraLost?.(msg.data);
        if (msg.action === "unavailable")
          this._callbacks.onCameraUnavailable?.(msg.data);
        break;
      case "head_pose":
        if (msg.action === "detected")
          this._callbacks.onHeadPoseDetected?.(msg.data);
        break;
      case "gaze":
        if (msg.action === "detected")
          this._callbacks.onGazeDetected?.(msg.data);
        // A frame with no face in it. Reported distinctly so tracking loss
        // and a child looking away never collapse into the same value.
        if (msg.action === "no_face") this._callbacks.onNoFace?.(msg.data);
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

  /** Trigger calibration. Superseded by docs/calibration-design.md. */
  calibrate(screenW, screenH) {
    return this.sendCommand("CALIBRATE", {
      screen_w: screenW || 1920,
      screen_h: screenH || 1080,
    });
  }

  /** Stream frame quality for the setup screens. Off during tracking. */
  startHealth(age = null) {
    return this.sendCommand("HEALTH_START", age === null ? {} : { age });
  }

  stopHealth() {
    return this.sendCommand("HEALTH_STOP");
  }
}

module.exports = EyeTracker;
