/**
 * Python interpreter resolution.
 *
 * The trackers used to spawn a bare "python", which resolves through PATH to
 * whatever interpreter happens to be first.  That silently ignores the
 * project venv, so a machine could satisfy requirements.txt in one interpreter
 * and fail in the one actually used.  Resolution order is now explicit:
 *
 *   1. $ACE_PYTHON, if set (escape hatch for non-standard installs)
 *   2. game/.venv, the project venv
 *   3. "python" on PATH, recorded as a fallback so preflight can say so
 */

const path = require("path");
const fs = require("fs");

const GAME_ROOT = path.join(__dirname, "..");
const VENV_DIR = path.join(GAME_ROOT, ".venv");

/** Platform-specific interpreter location inside a venv. */
function venvInterpreter(venvDir) {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/**
 * Resolve the interpreter the trackers should run under.
 * Returns { command, source, venvDir, venvPath, venvPresent }.
 * `command` is safe to hand to spawn(); `source` names where it came from
 * so preflight can report the venv path when it is missing.
 */
function resolveInterpreter() {
  const venvPath = venvInterpreter(VENV_DIR);
  const venvPresent = fs.existsSync(venvPath);

  if (process.env.ACE_PYTHON) {
    return {
      command: process.env.ACE_PYTHON,
      source: "ACE_PYTHON",
      venvDir: VENV_DIR,
      venvPath,
      venvPresent,
    };
  }

  if (venvPresent) {
    return {
      command: venvPath,
      source: "venv",
      venvDir: VENV_DIR,
      venvPath,
      venvPresent,
    };
  }

  return {
    command: "python",
    source: "PATH",
    venvDir: VENV_DIR,
    venvPath,
    venvPresent,
  };
}

module.exports = { resolveInterpreter, venvInterpreter, GAME_ROOT, VENV_DIR };
