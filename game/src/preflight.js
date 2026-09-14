/**
 * Startup preflight.
 *
 * Runs before any tracker is spawned and names the first unmet prerequisite.
 * Without it a missing interpreter, package or camera all present the same
 * way: the Python child exits, the handshake never arrives, and the only
 * message is a timeout that blames "Python and dependencies" regardless of
 * the real cause.
 *
 * Checks run in dependency order and stop at the first failure, because a
 * later check cannot be trusted once an earlier one fails (the camera probe
 * needs cv2, and cv2 needs the interpreter).
 */

const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

const { resolveInterpreter, GAME_ROOT } = require("./python_env");

const PROBE = path.join(GAME_ROOT, "python", "preflight_probe.py");
const REQUIREMENTS = path.join(GAME_ROOT, "requirements.txt");
const MODEL_ASSET = path.join(GAME_ROOT, "models", "face_landmarker.task");
const EYE_TRACKER = path.join(GAME_ROOT, "python", "eye_tracker.py");

const SENTINEL = "__ACE_PREFLIGHT__";
const PROBE_TIMEOUT_MS = 60000; // importing mediapipe is slow on a cold start
const MIN_PYTHON = [3, 9]; // mediapipe requires 3.9 or newer

const PIP_HINT =
  process.platform === "win32"
    ? ".venv\\Scripts\\pip install -r requirements.txt"
    : ".venv/bin/pip install -r requirements.txt";

/** Distributions whose import name differs from their package name. */
const MODULE_NAMES = { "opencv-python": "cv2", "opencv-contrib-python": "cv2" };

function moduleFor(dist) {
  return MODULE_NAMES[dist] || dist.replace(/-/g, "_");
}

/** Parse requirements.txt into { dist, module, op, version } entries. */
function readRequirements() {
  if (!fs.existsSync(REQUIREMENTS)) return [];
  return fs
    .readFileSync(REQUIREMENTS, "utf8")
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([A-Za-z0-9_.-]+)\s*(>=|==|~=|>|<=|<)?\s*(.+)?$/);
      if (!m) return null;
      return {
        dist: m[1],
        module: moduleFor(m[1]),
        op: m[2] || null,
        version: m[3] ? m[3].trim() : null,
      };
    })
    .filter(Boolean);
}

/** The camera index eye_tracker.py actually opens, so the two cannot drift. */
function cameraIndex() {
  try {
    const m = fs
      .readFileSync(EYE_TRACKER, "utf8")
      .match(/^CAMERA_INDEX\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* fall through to the default below */
  }
  return 0;
}

/** Compare dotted numeric versions. Returns -1, 0 or 1. Ignores suffixes. */
function compareVersions(a, b) {
  const parts = (v) =>
    String(v)
      .split(".")
      .map((p) => parseInt(p, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function satisfies(found, op, required) {
  if (!op || !required || !found) return true; // unpinned, or version unknown
  const c = compareVersions(found, required);
  switch (op) {
    case ">=":
    case "~=":
      return c >= 0;
    case ">":
      return c > 0;
    case "==":
      return c === 0;
    case "<=":
      return c <= 0;
    case "<":
      return c < 0;
    default:
      return true;
  }
}

/** Run the probe under `interpreter` and return its parsed JSON payload. */
function runProbe(interpreter, spec) {
  return new Promise((resolve, reject) => {
    execFile(
      interpreter,
      [PROBE, JSON.stringify(spec)],
      {
        timeout: PROBE_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const line = String(stdout || "")
          .split(/\r?\n/)
          .find((l) => l.startsWith(SENTINEL));

        if (line) {
          try {
            return resolve(JSON.parse(line.slice(SENTINEL.length).trim()));
          } catch (parseErr) {
            return reject(
              new Error(
                `preflight probe returned unreadable JSON: ${parseErr.message}`,
              ),
            );
          }
        }

        const detail =
          String(stderr || "").trim() || String(err && err.message) || "no output";
        reject(new Error(detail));
      },
    );
  });
}

function fail(check, message, extra = {}) {
  return { ok: false, check, message, ...extra };
}

/**
 * Run every prerequisite check.
 * Resolves with { ok: true, ... } or { ok: false, check, message } naming the
 * first unmet prerequisite.
 */
async function runPreflight() {
  const interpreter = resolveInterpreter();
  const requirements = readRequirements();
  const index = cameraIndex();

  // 1. Interpreter and venv path.
  if (
    interpreter.source === "ACE_PYTHON" &&
    !fs.existsSync(interpreter.command)
  ) {
    return fail(
      "interpreter",
      `ACE_PYTHON points at ${interpreter.command}, which does not exist. ` +
        "Correct it or unset it to use the project venv.",
    );
  }
  if (interpreter.source === "PATH") {
    return fail(
      "venv",
      `Python venv not found at ${interpreter.venvPath}. ` +
        `Create it with: python -m venv .venv, then ${PIP_HINT}`,
      { venvPath: interpreter.venvPath },
    );
  }

  // 2. Everything below needs the probe to run at all.
  let probe;
  try {
    probe = await runProbe(interpreter.command, {
      modules: requirements.map(({ dist, module }) => ({ dist, module })),
      camera_index: index,
    });
  } catch (err) {
    return fail(
      "interpreter",
      `Could not run Python at ${interpreter.command}. ${err.message}`,
    );
  }

  // 3. Python version.
  const [maj, min] = probe.python_version;
  if (compareVersions(`${maj}.${min}`, MIN_PYTHON.join(".")) < 0) {
    return fail(
      "python-version",
      `Python ${probe.python_version_str} at ${probe.executable} is too old. ` +
        `mediapipe requires ${MIN_PYTHON.join(".")} or newer.`,
    );
  }

  // 4. Required packages, reported one at a time in requirements.txt order.
  for (const req of requirements) {
    const found = probe.modules[req.dist];
    if (!found || !found.ok) {
      return fail(
        "package",
        `Package ${req.dist} is not installed in ${probe.prefix}. ` +
          `Install it with: ${PIP_HINT}`,
        { package: req.dist, detail: (found && found.error) || null },
      );
    }
    if (!satisfies(found.version, req.op, req.version)) {
      return fail(
        "package-version",
        `Package ${req.dist} is version ${found.version} in ${probe.prefix}, ` +
          `but requirements.txt asks for ${req.op}${req.version}. ` +
          `Upgrade it with: ${PIP_HINT}`,
        {
          package: req.dist,
          found: found.version,
          required: `${req.op}${req.version}`,
        },
      );
    }
  }

  // 5. Model asset the eye tracker loads at startup.
  if (!fs.existsSync(MODEL_ASSET)) {
    return fail(
      "model",
      `MediaPipe face landmark model missing at ${MODEL_ASSET}. ` +
        "Restore it from the repository.",
    );
  }

  // 6. Camera. This is the check that catches a machine with no webcam.
  if (probe.camera && probe.camera.checked && !probe.camera.opened) {
    return fail(
      "camera",
      `No camera opened at index ${index}. Connect a webcam, close any other ` +
        "app using it, and confirm camera access is allowed in Windows privacy settings.",
      { cameraIndex: index },
    );
  }

  return {
    ok: true,
    interpreter: probe.executable,
    source: interpreter.source,
    python: probe.python_version_str,
    packages: Object.fromEntries(
      Object.entries(probe.modules).map(([d, v]) => [d, v.version]),
    ),
    cameraIndex: index,
  };
}

module.exports = { runPreflight, compareVersions, satisfies, readRequirements };
