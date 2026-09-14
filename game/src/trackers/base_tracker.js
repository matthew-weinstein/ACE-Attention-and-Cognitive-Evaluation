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
const path = require("path");
const EventEmitter = require("events");

const { resolveInterpreter } = require("../python_env");

const MAX_CAPTURED_STDERR = 8192; // enough for a traceback, bounded for safety
const MAX_QUEUED_COMMANDS = 64;

class PythonTracker extends EventEmitter {
  constructor() {
    super();
    this._process = null;
    this._ready = false;
    this._callbacks = {};

    // Commands issued between spawn and the ready handshake.
    this._queue = [];

    // Why the tracker is unusable, once that is known.  Set on startup
    // failure and on exit after a successful start.  sendCommand reports it
    // instead of failing anonymously.
    this._failure = null;

    // Startup diagnostics.  The Python reports failures as JSON on stdout and
    // leaves stderr empty, so a useful error needs both streams plus the exit
    // code.  Reporting only the handshake timeout hides all three.
    this._stderr = "";
    this._pythonError = null;
  }

  /** Absolute path to the Python entry-point script. */
  get scriptPath() {
    throw new Error("scriptPath must be implemented by subclass");
  }

  /** Interpreter to run the script under. Prefers the project venv. */
  get pythonPath() {
    return resolveInterpreter().command;
  }

  /** Milliseconds to wait for the "ready" message before rejecting. */
  get initTimeoutMs() {
    return 15000;
  }

  /** Short script name for log lines. */
  get _label() {
    return `${this.constructor.name} (${path.basename(this.scriptPath)})`;
  }

  /**
   * Everything known about why startup failed, as a readable block.
   * Includes the exit code, the last error the Python reported on stdout,
   * and captured stderr, each omitted only when genuinely absent.
   */
  _diagnostics({ code = null, signal = null } = {}) {
    const lines = [];

    if (signal) lines.push(`  killed by signal ${signal}`);
    else if (code !== null) lines.push(`  exit code: ${code}`);

    lines.push(`  interpreter: ${this.pythonPath}`);
    lines.push(`  script: ${this.scriptPath}`);

    if (this._pythonError) {
      lines.push(`  python reported: ${this._pythonError}`);
    }

    const stderr = this._stderr.trim();
    lines.push(stderr ? `  stderr:\n${stderr}` : "  stderr: (empty)");

    if (!this._pythonError && !stderr) {
      lines.push("  the process produced no diagnostic output before exiting");
    }

    return lines.join("\n");
  }

  /** One-line version of a startup failure, for repeated command logs. */
  _summarise(err) {
    const first = err.message.split("\n")[0].trim();
    return this._pythonError ? `${first} ${this._pythonError}` : first;
  }

  /**
   * Spawn the Python process and wait for the "ready" status message.
   * Resolves with the ready message payload.  Rejects as soon as the child
   * exits without signalling ready, rather than waiting out the full timeout.
   */
  initialize() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;

      const succeed = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      };

      const abort = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep the full diagnostics for the rejection, and a one-line summary
        // for the per-command logs, which would otherwise repeat the block.
        this._failure = this._summarise(err);
        this._rejectQueue(this._failure);
        reject(err);
      };

      try {
        this._process = spawn(this.pythonPath, ["-u", this.scriptPath], {
          windowsHide: true,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
      } catch (err) {
        abort(new Error(`[${this._label}] could not spawn: ${err.message}`));
        return;
      }

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

            // Keep the last error the Python reported so a later exit can
            // explain itself.  This is the channel the camera failure uses.
            if (msg.type === "error" && msg.data && msg.data.message) {
              this._pythonError = msg.data.message;
            }

            this.routeMessage(msg);

            if (
              !this._ready &&
              msg.type === "status" &&
              msg.action === "ready"
            ) {
              this._ready = true;
              this._flushQueue();
              succeed(msg);
            }
          } catch {
            console.error(`[${this._label}] unparseable stdout:`, line);
          }
        }
      });

      this._process.stderr.on("data", (data) => {
        const text = data.toString();

        // Capture everything for the startup error, bounded.
        if (this._stderr.length < MAX_CAPTURED_STDERR) {
          this._stderr = (this._stderr + text).slice(0, MAX_CAPTURED_STDERR);
        }

        // MediaPipe and TF print INFO/WARNING to stderr — only surface errors.
        if (/error|exception|traceback/i.test(text)) {
          console.error(`[${this._label}] stderr:`, text);
          this._callbacks.onError?.(text);
        }
      });

      this._process.on("close", (code, signal) => {
        const wasReady = this._ready;
        this._ready = false;
        this._process = null;

        if (!settled) {
          // Exited before the handshake.  Report the real cause now instead
          // of leaving initialize() pending until the timeout fires.
          abort(
            new Error(
              `[${this._label}] exited before signalling ready.\n` +
                this._diagnostics({ code, signal }),
            ),
          );
          return;
        }

        console.log(`[${this._label}] process exited (code ${code})`);
        if (wasReady) {
          this._failure = `process exited (code ${code})`;
          this._rejectQueue(this._failure);
        }
      });

      this._process.on("error", (err) => {
        const hint =
          err.code === "ENOENT"
            ? `\n  interpreter not found at ${this.pythonPath}`
            : "";
        abort(new Error(`[${this._label}] spawn error: ${err.message}${hint}`));
      });

      timer = setTimeout(() => {
        abort(
          new Error(
            `[${this._label}] no ready message within ${this.initTimeoutMs}ms. ` +
              "The process is still running but did not complete its handshake.\n" +
              this._diagnostics(),
          ),
        );
      }, this.initTimeoutMs);
    });
  }

  /**
   * Dispatch a parsed message to the appropriate callback.
   * Subclasses override this to handle their message types.
   */
  routeMessage(_msg) {}

  /** Write one command to the child. Returns false if the write fails. */
  _write(action, data) {
    try {
      this._process.stdin.write(JSON.stringify({ action, ...data }) + "\n");
      return true;
    } catch (err) {
      console.error(`[${this._label}] sendCommand failed:`, err);
      return false;
    }
  }

  /** Send everything queued during startup, in the order it was issued. */
  _flushQueue() {
    const queued = this._queue.splice(0);
    for (const { action, data } of queued) this._write(action, data);
  }

  /** Discard queued commands once the tracker is known to be unusable. */
  _rejectQueue(reason) {
    if (this._queue.length === 0) return;
    const dropped = this._queue.splice(0).map((c) => c.action);
    console.error(
      `[${this._label}] dropped ${dropped.length} queued command(s) ` +
        `(${dropped.join(", ")}): ${reason}`,
    );
  }

  /**
   * Write a command to the Python process over stdin.
   *
   * Returns true when the command was written or queued for the pending
   * handshake, false when the tracker cannot accept it.  A false return
   * always logs the specific reason: the tracker never fails anonymously.
   */
  sendCommand(action, data = {}) {
    if (this._failure) {
      console.error(
        `[${this._label}] ${action} not sent: tracker unavailable. ${this._failure}`,
      );
      return false;
    }

    if (!this._process) {
      console.error(
        `[${this._label}] ${action} not sent: no process. ` +
          "initialize() has not been called, or the process already exited.",
      );
      return false;
    }

    // Spawned but still starting up: hold the command until the handshake.
    if (!this._ready) {
      if (this._queue.length >= MAX_QUEUED_COMMANDS) {
        console.error(
          `[${this._label}] ${action} not sent: ` +
            `${MAX_QUEUED_COMMANDS} commands already queued awaiting startup.`,
        );
        return false;
      }
      this._queue.push({ action, data });
      return true;
    }

    return this._write(action, data);
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
    this._queue.length = 0;
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
