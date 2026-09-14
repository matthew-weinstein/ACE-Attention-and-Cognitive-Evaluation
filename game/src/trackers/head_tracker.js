const path = require("path");
const PythonTracker = require("./base_tracker");

class HeadTracker extends PythonTracker {
  get scriptPath() {
    return path.join(__dirname, "../../python/head_tracker.py");
  }

  get eventMap() {
    return {
      ready: "onReady",
      headPose: "onHeadPoseDetected",
      blink: "onBlinkDetected",
      trackingStarted: "onTrackingStarted",
      trackingStopped: "onTrackingStopped",
      calibrated: "onCalibrated",
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
        if (msg.action === "calibrated" || msg.action === "recalibrated")
          this._callbacks.onCalibrated?.(msg.data);
        break;
      case "head_pose":
        if (msg.action === "detected")
          this._callbacks.onHeadPoseDetected?.(msg.data);
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

  calibrate() {
    return this.sendCommand("CALIBRATE");
  }
}

module.exports = HeadTracker;
