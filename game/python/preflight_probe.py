#!/usr/bin/env python3
"""
Preflight probe - reports interpreter facts so Electron can name the exact
missing prerequisite instead of timing out on the tracker handshake.

Reports facts only.  Version comparison and the decision about what counts as
a failure live in src/preflight.js, so there is one source of truth for the
required versions (requirements.txt).

Usage:  python preflight_probe.py '<json spec>'
  spec: {"modules": [{"dist": "...", "module": "..."}], "camera_index": 0}

Writes one sentinel-prefixed JSON line to stdout.  The sentinel matters:
importing cv2 and mediapipe emits banner text on both streams, so the caller
cannot assume the JSON is alone on stdout.
"""

import sys
import json
import platform

SENTINEL = "__ACE_PREFLIGHT__"


def probe_module(module_name):
    """Import one module and report its version, or why it could not load."""
    try:
        mod = __import__(module_name)
    except Exception as exc:
        return {"ok": False, "version": None,
                "error": "{}: {}".format(type(exc).__name__, exc)}
    return {"ok": True, "version": getattr(mod, "__version__", None), "error": None}


def probe_camera(index):
    """Check that a capture device actually opens at `index`."""
    try:
        import cv2
    except Exception as exc:
        return {"checked": False, "opened": False,
                "error": "cv2 unavailable: {}".format(exc)}
    cap = None
    try:
        cap = cv2.VideoCapture(index)
        opened = bool(cap.isOpened())
        return {"checked": True, "opened": opened, "error": None}
    except Exception as exc:
        return {"checked": True, "opened": False, "error": str(exc)}
    finally:
        if cap is not None:
            cap.release()


def main():
    spec = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}

    result = {
        "executable": sys.executable,
        "python_version": list(sys.version_info[:3]),
        "python_version_str": platform.python_version(),
        "prefix": sys.prefix,
        "base_prefix": getattr(sys, "base_prefix", sys.prefix),
        "in_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
        "modules": {},
        "camera": None,
    }

    for entry in spec.get("modules", []):
        result["modules"][entry["dist"]] = probe_module(entry["module"])

    if spec.get("camera_index") is not None:
        result["camera"] = probe_camera(spec["camera_index"])

    sys.stdout.write("{} {}\n".format(SENTINEL, json.dumps(result)))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
