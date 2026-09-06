# ACE - Attention and Cognitive Evaluation

A pediatric screening tool that uses a standard webcam to passively assess attention-related behaviours during a short space-themed game. It measures eye tracking (gaze accuracy, fixation), blink rate, and head movement to produce a structured clinical report for a reviewing clinician.

---

## How It Works

The app runs as an Electron desktop application. Three parallel Python subprocesses handle computer-vision work and communicate with the renderer over newline-delimited JSON on stdin/stdout:

| Process            | Role                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eye_tracker.py`   | MediaPipe FaceLandmarker — gaze estimation, blink detection (EAR), head pose (ZYX Euler from the facial transformation matrix), 9-point polynomial calibration |
| `blink_tracker.py` | Lifecycle stub                                                                                                                                                 |
| `head_tracker.py`  | Lifecycle stub                                                                                                                                                 |

### Assessment phases

1. **Calibration** — 9-point grid calibration fits a degree-2 polynomial that maps normalised iris coordinates to screen pixels, correcting for nonlinear edge distortion.
2. **Round 1 — Visual Search** (30 s) — golden target stars appear at random positions; distractors try to pull attention away.
3. **Round 2 — Laser Focus** (15 s) — a single fixation star appears at screen centre; the child must hold their gaze still.

After both rounds a clinician-facing results page shows blink rate vs. norms, gaze focus percentage, and a head-movement (fidget) index over time.

---

## Project Structure

```
game/
├── main.js                   # Electron main process — window, IPC, tracker lifecycle
├── preload.js                # contextBridge — secure renderer ↔ main IPC surface
├── package.json
├── requirements.txt
│
├── renderer/                 # Renderer process (HTML + Canvas game)
│   ├── index.html
│   ├── renderer.js           # Game state machine and Canvas drawing
│   ├── results.html
│   ├── results.js            # Chart.js results dashboard
│   └── head_fidget_visualizer.js
│
├── src/
│   └── trackers/
│       ├── base_tracker.js   # PythonTracker — shared subprocess lifecycle
│       ├── blink_tracker.js
│       ├── head_tracker.js
│       └── eye_tracker.js
│
├── python/
│   ├── eye_tracker.py        # All camera/CV work lives here
│   ├── blink_tracker.py      # Stub
│   └── head_tracker.py       # Stub
│
└── models/
    └── face_landmarker.task  # MediaPipe FaceLandmarker (bundled, ~3.6 MB)
```

---

## Setup

### Prerequisites

- **Node.js** ≥ 18 and **npm**
- **Python** ≥ 3.9
- A webcam

### Install

```bash
# JavaScript dependencies
cd game
npm install

# Python dependencies (use a virtual environment)
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Run

```bash
cd game
npm start
```

---

## Controls

| Key   | Action                                                                       |
| ----- | ---------------------------------------------------------------------------- |
| `R`   | Toggle developer overlay (gaze cursor, head-pose wireframe, blink indicator) |
| `Esc` | Return to start screen / close app                                           |

---

## Architecture Notes

- **Single camera process**: All computer vision runs inside `eye_tracker.py` to avoid Windows camera contention. Blink and head pose events emitted by that process are forwarded to both the blink and head tracker IPC channels so downstream consumers see a uniform API.
- **9-point polynomial calibration**: Features `[ix, iy, ix·iy, ix², iy², 1]` fitted with least squares. Captures nonlinear optics at screen edges that a simple affine transform misses.
- **Lerp smoothing**: Gaze cursor and head-pose wireframe use linear interpolation (α = 0.2 / 0.15) with shortest-path angle normalisation to prevent the 3-D display from spinning through ±180° discontinuities.
