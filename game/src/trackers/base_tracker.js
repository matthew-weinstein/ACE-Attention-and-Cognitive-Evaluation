/**
 * PythonTracker — base class for all Python subprocess trackers.
 *
 * Each tracker (blink, head, eye) spawns a child Python process and
 * communicates over newline-delimited JSON on stdin/stdout.  The common
 * machinery — process lifecycle, line framing, command serialisation,
 * graceful shutdown — lives here so subclasses stay concise.
 *
 * Subclasses must implement:
 *   get scriptPath()   → absolute path to the Python script
 *   get initTimeoutMs() → milliseconds before initialize() rejects
 *   get eventMap()     → { eventName: 'callbackKey', … }
 *   routeMessage(msg)  → dispatch a parsed JSON message to callbacks
 */

const { spawn } = require("child_process");
const EventEmitter = require("events");

class PythonTracker extends EventEmitter {
  constructor() {
    super();
    this._process = null;
    this._ready = false;
    this._callbacks = {};
  }

  /** Absolute path to the Python entry-point script. */
  get scriptPath() {
    throw new Error("scriptPath must be implemented by subclass");
  }

  /** Milliseconds to wait for the "ready" message before rejecting. */
  get initTimeoutMs() {
    return 15000;
  }

  /**
   * Spawn the Python process and wait for the "ready" status message.
   * Resolves with the ready message payload; rejects on timeout or error.
   */
  initialize() {
    return new Promise((resolve, reject) => {
      this._process = spawn("python", ["-u", this.scriptPath], {
        windowsHide: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });

      // Buffer partial lines across data chunks.
      let buffer = "";
      this._process.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete trailing line
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.routeMessage(msg);
            if (
              !this._ready &&
              msg.type === "status" &&
              msg.action === "ready"
            ) {
              this._ready = true;
              resolve(msg);
            }
          } catch {
            console.error(
              `[${this.constructor.name}] unparseable stdout:`,
              line,
            );
          }
        }
      });

      this._process.stderr.on("data", (data) => {
        const text = data.toString();
        // MediaPipe and TF print INFO/WARNING to stderr — only surface errors.
        if (/error|exception|traceback/i.test(text)) {
          console.error(`[${this.constructor.name}] stderr:`, text);
          this._callbacks.onError?.(text);
        }
      });

      this._process.on("close", (code) => {
        console.log(`[${this.constructor.name}] process exited (code ${code})`);
        this._ready = false;
        this._process = null;
      });

      this._process.on("error", (err) => {
        console.error(`[${this.constructor.name}] spawn error:`, err);
        reject(err);
      });

      setTimeout(() => {
        if (!this._ready) {
          reject(
            new Error(
              `[${this.constructor.name}] timed out after ${this.initTimeoutMs}ms — ` +
                "ensure Python and dependencies are installed",
            ),
          );
        }
      }, this.initTimeoutMs);
    });
  }

  /**
   * Dispatch a parsed message to the appropriate callback.
   * Subclasses override this to handle their message types.
   */
  routeMessage(_msg) {}

  /**
   * Write a command to the Python process over stdin.
   * Returns false if the process is not ready.
   */
  sendCommand(action, data = {}) {
    if (!this._process || !this._ready) {
      console.warn(
        `[${this.constructor.name}] sendCommand called while not ready`,
      );
      return false;
    }
    try {
      this._process.stdin.write(JSON.stringify({ action, ...data }) + "\n");
      return true;
    } catch (err) {
      console.error(`[${this.constructor.name}] sendCommand failed:`, err);
      return false;
    }
  }

  /**
   * Register a callback for a named event.
   * Subclasses expose specific event names via their eventMap getter.
   */
  on(event, callback) {
    const key = this.eventMap[event];
    if (key) this._callbacks[key] = callback;
  }

  /**
   * Gracefully shut down the Python process: send EXIT, then SIGTERM,
   * then SIGKILL as a last resort.
   */
  shutdown() {
    if (!this._process) return;
    if (this._ready) {
      try {
        this.sendCommand("EXIT");
      } catch {
        /* ignore */
      }
    }
    setTimeout(() => {
      this._process?.kill("SIGTERM");
      setTimeout(() => this._process?.kill("SIGKILL"), 1000);
    }, 1000);
  }

  ping() {
    return this.sendCommand("PING");
  }
  startTracking(sessionId = "default") {
    return this.sendCommand("START", { session_id: sessionId });
  }
  stopTracking() {
    return this.sendCommand("STOP");
  }
}

module.exports = PythonTracker;
