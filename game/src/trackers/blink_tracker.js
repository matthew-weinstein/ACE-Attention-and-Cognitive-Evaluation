const path = require("path");
const PythonTracker = require("./base_tracker");

class BlinkTracker extends PythonTracker {
  get scriptPath() {
    return path.join(__dirname, "../../python/blink_tracker.py");
  }

  get eventMap() {
    return {
      ready: "onReady",
      blink: "onBlinkDetected",
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
      case "blink":
        if (msg.action === "detected")
          this._callbacks.onBlinkDetected?.(msg.data);
        break;
      case "error":
        this._callbacks.onError?.(msg.data);
        break;
    }
  }
}

module.exports = BlinkTracker;
