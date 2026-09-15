/**
 * Session persistence.
 *
 * Session data previously lived in renderer arrays and reached disk once, at
 * the end, through localStorage. A camera loss at minute 14 of a 25 minute
 * session discarded everything.
 *
 * Here every completed trial is appended as it finishes, so an interrupted
 * session keeps the trials it completed and is marked incomplete rather than
 * discarded. See docs/calibration-design.md 11.6.
 *
 * Writes are queued and serialised per session. The renderer never awaits a
 * write, because a slow disk must never move a measurement.
 */

const fs = require("fs");
const path = require("path");

const MANIFEST = "manifest.json";
const TRIALS = "trials.ndjson";
const EVENTS = "events.ndjson";

const STATUS = {
  IN_PROGRESS: "in_progress",
  COMPLETE: "complete",
  INCOMPLETE: "incomplete",
};

class SessionStore {
  /** @param {string} rootDir directory that holds one folder per session */
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.sessions = new Map(); // sessionId -> { dir, manifest, queue, writing }
  }

  _dir(sessionId) {
    return path.join(this.rootDir, sessionId);
  }

  /**
   * Serialise appends per session. Each entry is a thunk returning a promise.
   * Failures are logged and dropped rather than thrown, because losing one
   * trial line must not take down a session that is still collecting data.
   */
  _enqueue(sessionId, task) {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      console.error(`[session] append to unknown session ${sessionId}`);
      return;
    }
    entry.queue.push(task);
    if (entry.writing) return;

    entry.writing = true;
    const drain = () => {
      const next = entry.queue.shift();
      if (!next) {
        entry.writing = false;
        return;
      }
      next()
        .catch((err) =>
          console.error(`[session ${sessionId}] write failed: ${err.message}`),
        )
        .then(drain);
    };
    drain();
  }

  _appendLine(sessionId, file, record) {
    const target = path.join(this._dir(sessionId), file);
    const line = JSON.stringify(record) + "\n";
    this._enqueue(sessionId, () => fs.promises.appendFile(target, line, "utf8"));
  }

  _writeManifest(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    const target = path.join(entry.dir, MANIFEST);
    const body = JSON.stringify(entry.manifest, null, 2);
    this._enqueue(sessionId, () => fs.promises.writeFile(target, body, "utf8"));
  }

  /**
   * Open a session directory and write the initial manifest.
   * Returns the manifest, including the directory, so the renderer can show
   * an operator where the data is.
   */
  begin(sessionId, meta = {}) {
    const dir = this._dir(sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const manifest = {
      sessionId,
      status: STATUS.IN_PROGRESS,
      statusReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      appVersion: meta.appVersion || null,
      geometry: meta.geometry || null,
      camera: meta.camera || null,
      band: meta.band || null,
      gamesPlanned: meta.gamesPlanned || [],
      gamesCompleted: [],
      trialsWritten: 0,
      dir,
    };

    this.sessions.set(sessionId, { dir, manifest, queue: [], writing: false });
    this._writeManifest(sessionId);
    return manifest;
  }

  /** Append one completed trial. Called in the inter-trial interval. */
  appendTrial(sessionId, trial) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.manifest.trialsWritten += 1;
    this._appendLine(sessionId, TRIALS, trial);
    return true;
  }

  /**
   * Append a session event: a camera state change, a calibration attempt, a
   * drift flag, a game boundary.
   */
  appendEvent(sessionId, event) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this._appendLine(sessionId, EVENTS, {
      at: new Date().toISOString(),
      ...event,
    });
    return true;
  }

  /** Record that a game finished, so a partial session says which ran. */
  markGameCompleted(sessionId, game) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    if (!entry.manifest.gamesCompleted.includes(game)) {
      entry.manifest.gamesCompleted.push(game);
    }
    this._writeManifest(sessionId);
    return true;
  }

  /** Attach or update the camera health record on the manifest. */
  setCamera(sessionId, camera) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    entry.manifest.camera = { ...(entry.manifest.camera || {}), ...camera };
    this._writeManifest(sessionId);
    return true;
  }

  /**
   * Close a session.
   *
   * `incomplete` is not a failure. Four finished games and one interrupted
   * game is a partial session and the report presents it as one, with the
   * reason recorded here.
   */
  finish(sessionId, status, reason = null) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return null;
    entry.manifest.status = status;
    entry.manifest.statusReason = reason;
    entry.manifest.endedAt = new Date().toISOString();
    this._writeManifest(sessionId);
    return entry.manifest;
  }

  /** Flush pending writes. Called on shutdown. */
  async drain(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    const pending = () =>
      [...this.sessions.values()].some((e) => e.writing || e.queue.length);
    while (pending() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return !pending();
  }

  /**
   * Mark any session left open by a crash. Called at startup so an
   * interrupted run does not sit on disk claiming to be in progress.
   */
  reconcileOrphans() {
    if (!fs.existsSync(this.rootDir)) return [];
    const fixed = [];
    for (const name of fs.readdirSync(this.rootDir)) {
      const file = path.join(this.rootDir, name, MANIFEST);
      if (!fs.existsSync(file)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
        if (manifest.status !== STATUS.IN_PROGRESS) continue;
        manifest.status = STATUS.INCOMPLETE;
        manifest.statusReason = "the app closed before the session ended";
        manifest.endedAt = manifest.endedAt || new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2), "utf8");
        fixed.push(name);
      } catch (err) {
        console.error(`[session] could not reconcile ${name}: ${err.message}`);
      }
    }
    return fixed;
  }
}

module.exports = { SessionStore, STATUS };
