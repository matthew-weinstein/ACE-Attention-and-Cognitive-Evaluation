#!/usr/bin/env python3
"""
Eye Tracker — gaze estimation, blink detection, and head pose in a single process.

All computer vision runs here rather than in separate blink_tracker.py /
head_tracker.py processes to avoid Windows camera contention (only one process
can open a DirectShow device at a time).

Electron communicates via newline-delimited JSON on stdin/stdout:
  Electron → Python  e.g. {"action": "START", "session_id": "phase1"}
  Python → Electron  e.g. {"type": "gaze", "action": "detected", "data": {...}}
"""

import sys
import json
import time
import threading
import collections
import math
import os
from datetime import datetime
import cv2
import numpy as np
import mediapipe as mp
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

CAMERA_INDEX = 0
EAR_THRESHOLD    = 0.17   # below this EAR value we consider the eye closed
CONSEC_FRAMES    = 3      # minimum consecutive closed frames to count as a blink
MAX_CONSEC_FRAMES = 12    # above this the eye has been "down" too long — not a blink

LEFT_IRIS  = [468, 469, 470, 471, 472]
RIGHT_IRIS = [473, 474, 475, 476, 477]
LEFT_EYE_INDICES  = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../models/face_landmarker.task")


class EyeTracker:
    def __init__(self):
        self.is_tracking = False
        self.session_id = None
        self.gaze_data = []
        self.blink_data = []
        self.cap = None
        self.face_landmarker = None
        self.tracking_thread = None

        # Affine calibration coefficients [a, b, c] for gx = a*ix + b*iy + c
        self.calib_cx = None
        self.calib_cy = None
        self.calibrated = False

        self.screen_w = 1920
        self.screen_h = 1080

        # Blink state
        self.blink_counter = 0
        self.total_blinks = 0
        self.was_sustained = False   # True when eyes have been down > MAX_CONSEC_FRAMES

        # Head pose state
        self.angle_buffer = collections.deque(maxlen=5)
        self.initial_pitch = None
        self.initial_yaw  = None
        self.initial_roll  = None

        self.frame_ms = 0

    def send_message(self, msg_type, action, data=None):
        msg = {
            "type": msg_type,
            "action": action,
            "timestamp": datetime.now().isoformat(),
            "data": data or {}
        }
        print(json.dumps(msg), flush=True)

    def initialize(self):
        try:
            self.cap = cv2.VideoCapture(CAMERA_INDEX)
            if not self.cap.isOpened():
                raise Exception("Camera not found at index 0")
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            self.cap.set(cv2.CAP_PROP_FPS, 30)

            options = vision.FaceLandmarkerOptions(
                base_options=python.BaseOptions(model_asset_path=MODEL_PATH),
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5,
                output_facial_transformation_matrixes=True
            )
            self.face_landmarker = vision.FaceLandmarker.create_from_options(options)
            self.send_message("status", "ready", {"message": "Eye tracker ready (MediaPipe iris)"})
            return True
        except Exception as e:
            self.send_message("error", "error", {"message": str(e)})
            return False

    def _extract_head_pose(self, results):
        """Extract pitch/yaw/roll from MediaPipe's facial_transformation_matrixes.
        Returns (None,None,None) on any failure."""
        try:
            if not results.facial_transformation_matrixes:
                return None, None, None
            tm = results.facial_transformation_matrixes[0]
            # In MP >= 0.10.9 tm is already a numpy ndarray (4x4).
            # In older versions it is a MatrixData proto with a .data repeated field
            # (flat floats, row-major).  numpy arrays also have a .data attribute
            # (memoryview), so we must distinguish by type, not just attribute presence.
            if isinstance(tm, np.ndarray):
                mat = tm.astype("double").reshape(4, 4)
            elif hasattr(tm, "data"):
                mat = np.array(list(tm.data), dtype="double").reshape(4, 4)
            else:
                mat = np.array(tm, dtype="double").reshape(4, 4)
            rmat = mat[:3, :3]

            # ZYX Euler decomposition — always in [-180, 180]
            sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
            if sy > 1e-6:
                pitch = math.degrees(math.atan2( rmat[2, 1], rmat[2, 2]))
                yaw   = math.degrees(math.atan2(-rmat[2, 0], sy))
                roll  = math.degrees(math.atan2( rmat[1, 0], rmat[0, 0]))
            else:
                pitch = math.degrees(math.atan2(-rmat[1, 2], rmat[1, 1]))
                yaw   = math.degrees(math.atan2(-rmat[2, 0], sy))
                roll  = 0.0

            return pitch, yaw, roll
        except Exception:
            return None, None, None

    def _read_frame(self):
        """Read one camera frame, return all derived values or Nones.

        Returns:
            (iris_nx, iris_ny, eye_width, ear, pitch, yaw, roll)
            Face-normalised iris coords remove head-translation drift.
        """
        if not self.cap or not self.face_landmarker:
            return None, None, None, None, None, None, None
        ret, frame = self.cap.read()
        if not ret:
            return None, None, None, None, None, None, None

        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        self.frame_ms += 33
        results = self.face_landmarker.detect_for_video(mp_image, self.frame_ms)

        if not results.face_landmarks:
            return None, None, None, None, None, None, None

        lm = results.face_landmarks[0]

        # ── Iris / gaze ──────────────────────────────────────────────────────
        lx = np.mean([lm[i].x for i in LEFT_IRIS]) * w
        ly = np.mean([lm[i].y for i in LEFT_IRIS]) * h
        rx = np.mean([lm[i].x for i in RIGHT_IRIS]) * w
        ry = np.mean([lm[i].y for i in RIGHT_IRIS]) * h
        iris_x = (lx + rx) / 2
        iris_y = (ly + ry) / 2

        face_left_x  = lm[33].x  * w
        face_right_x = lm[263].x * w
        face_top_y   = lm[168].y * h
        face_bot_y   = lm[152].y * h
        face_w = face_right_x - face_left_x
        face_h = face_bot_y   - face_top_y

        if face_w < 1 or face_h < 1:
            return None, None, None, None, None, None, None

        iris_nx = (iris_x - face_left_x) / face_w
        iris_ny = (iris_y - face_top_y)  / face_h

        lw = abs(lm[133].x - lm[33].x)  * w
        rw = abs(lm[263].x - lm[362].x) * w
        eye_width = (lw + rw) / 2

        # ── EAR (blink) ───────────────────────────────────────────────────────
        def calc_ear(indices):
            pts = np.array([[lm[i].x * w, lm[i].y * h] for i in indices])
            A = np.linalg.norm(pts[1] - pts[5])
            B = np.linalg.norm(pts[2] - pts[4])
            C = np.linalg.norm(pts[0] - pts[3])
            return (A + B) / (2.0 * C) if C > 0 else 0.3

        ear = (calc_ear(LEFT_EYE_INDICES) + calc_ear(RIGHT_EYE_INDICES)) / 2

        # ── Head pose (from MediaPipe's own face transform matrix) ───────────
        pitch, yaw, roll = self._extract_head_pose(results)

        return iris_nx, iris_ny, eye_width, ear, pitch, yaw, roll

    def calibrate(self):
        """9-point calibration (3×3 grid) — fits a 2nd-order polynomial iris→screen
        mapping per axis.  More points + higher-order features catch edge distortion
        that a 5-point affine map misses.
        Always sends calibration.completed so the renderer never hangs."""
        iris_pts  = []
        screen_pts = []
        try:
            mx = self.screen_w * 0.1
            my = self.screen_h * 0.1
            cx = self.screen_w / 2
            cy = self.screen_h / 2
            rx = self.screen_w - mx
            ry = self.screen_h - my
            # 3×3 grid: corners, edge-midpoints, centre
            points = [
                (cx, cy),          # centre first — face still settling
                (mx, my),          # top-left
                (cx, my),          # top-mid
                (rx, my),          # top-right
                (mx, cy),          # mid-left
                (rx, cy),          # mid-right
                (mx, ry),          # bot-left
                (cx, ry),          # bot-mid
                (rx, ry),          # bot-right
            ]

            self.send_message("calibration", "started", {
                "message": "Calibration starting",
                "total_points": len(points)
            })

            for i, (sx, sy) in enumerate(points):
                self.send_message("calibration", "instruction", {
                    "message": "Look at the dot and hold still",
                    "point": i + 1,
                    "total_points": len(points),
                    "x": sx,
                    "y": sy
                })

                time.sleep(0.6)          # settle time per dot
                samples_x, samples_y = [], []
                deadline = time.time() + 1.5
                while time.time() < deadline:
                    try:
                        ix, iy, _, _, _, _, _ = self._read_frame()
                        if ix is not None:
                            samples_x.append(ix)
                            samples_y.append(iy)
                    except Exception:
                        pass
                    time.sleep(0.033)

                if len(samples_x) >= 5:
                    iris_pts.append((float(np.median(samples_x)), float(np.median(samples_y))))
                    screen_pts.append((sx, sy))

            # Need ≥ 6 points to fit the 6-parameter polynomial [ix, iy, ix·iy, ix², iy², 1]
            if len(iris_pts) >= 6:
                A  = np.array([[ix, iy, ix*iy, ix**2, iy**2, 1.0] for ix, iy in iris_pts])
                Bx = np.array([sx for sx, _ in screen_pts])
                By = np.array([sy for _, sy in screen_pts])
                self.calib_cx, _, _, _ = np.linalg.lstsq(A, Bx, rcond=None)
                self.calib_cy, _, _, _ = np.linalg.lstsq(A, By, rcond=None)
                self.calibrated = True
            elif len(iris_pts) >= 3:
                # Fallback to linear affine if too many dots were missed
                A  = np.array([[ix, iy, 1.0] for ix, iy in iris_pts])
                Bx = np.array([sx for sx, _ in screen_pts])
                By = np.array([sy for _, sy in screen_pts])
                self.calib_cx, _, _, _ = np.linalg.lstsq(A, Bx, rcond=None)
                self.calib_cy, _, _, _ = np.linalg.lstsq(A, By, rcond=None)
                self.calib_cx = np.append(self.calib_cx, [0.0, 0.0, 0.0])
                self.calib_cy = np.append(self.calib_cy, [0.0, 0.0, 0.0])
                self.calibrated = True

        except Exception as e:
            self.send_message("error", "calibration_error", {"message": str(e)})

        self.send_message("calibration", "completed", {
            "message": "Calibration complete",
            "calibrated": self.calibrated,
            "points_collected": len(iris_pts)
        })

    def _iris_to_screen(self, iris_nx, iris_ny):
        if self.calibrated and self.calib_cx is not None and self.calib_cy is not None:
            ix, iy = iris_nx, iris_ny
            feat = np.array([ix, iy, ix*iy, ix**2, iy**2, 1.0])
            gx = float(np.dot(self.calib_cx, feat))
            gy = float(np.dot(self.calib_cy, feat))
        else:
            gx = (iris_nx - 0.2) / 0.6 * self.screen_w
            gy = (iris_ny - 0.2) / 0.6 * self.screen_h

        return (
            max(0.0, min(float(self.screen_w), gx)),
            max(0.0, min(float(self.screen_h), gy))
        )

    def _track_loop(self):
        while self.is_tracking:
            try:
                ix, iy, ew, ear_val, pitch, yaw, roll = self._read_frame()

                if ix is not None:
                    # ── Gaze ─────────────────────────────────────────────────
                    gx, gy = self._iris_to_screen(ix, iy)
                    self.send_message("gaze", "detected", {
                        "x": round(gx),
                        "y": round(gy),
                        "confidence": 0.9
                    })
                    self.gaze_data.append({"x": gx, "y": gy})

                    # ── Blink (was_sustained prevents false positives on look-down) ──
                    if ear_val is not None and ear_val < EAR_THRESHOLD:
                        self.blink_counter += 1
                        if self.blink_counter > MAX_CONSEC_FRAMES:
                            self.was_sustained = True
                    else:
                        if self.blink_counter >= CONSEC_FRAMES and not self.was_sustained:
                            self.total_blinks += 1
                            self.send_message("blink", "detected", {
                                "timestamp": time.time(),
                                "blink_number": self.total_blinks,
                                "ear": ear_val
                            })
                            self.blink_data.append({"timestamp": time.time()})
                        self.blink_counter = 0
                        self.was_sustained = False

                    # ── Head pose ─────────────────────────────────────────────
                    if pitch is not None:
                        self.angle_buffer.append([pitch, yaw, roll])
                        if len(self.angle_buffer) >= 3:
                            avg = np.mean(self.angle_buffer, axis=0)
                            p, y_, r = float(avg[0]), float(avg[1]), float(avg[2])

                            if self.initial_pitch is None:
                                self.initial_pitch = p
                                self.initial_yaw   = y_
                                self.initial_roll  = r

                            # Shortest-path delta — prevents ±180 wrap causing 360° spin
                            def _angle_diff(a, b):
                                d = a - b
                                while d >  180: d -= 360
                                while d < -180: d += 360
                                return d

                            pd = round(_angle_diff(p,  self.initial_pitch), 2)
                            yd = round(_angle_diff(y_, self.initial_yaw),   2)
                            rd = round(_angle_diff(r,  self.initial_roll),  2)

                            thresh = 10
                            if   yd < -thresh: direction = "Left"
                            elif yd >  thresh: direction = "Right"
                            elif pd < -thresh: direction = "Down"
                            elif pd >  thresh: direction = "Up"
                            else:              direction = "Forward"

                            self.send_message("head_pose", "detected", {
                                "pitch": pd,
                                "yaw":   yd,
                                "roll":  rd,
                                "direction": direction,
                                "timestamp": datetime.now().isoformat()
                            })

            except Exception as e:
                self.send_message("error", "track_error", {"message": str(e)})
            time.sleep(0.033)

    def start_tracking(self, session_id):
        self.session_id    = session_id
        self.is_tracking   = True
        self.gaze_data     = []
        self.blink_data    = []
        self.total_blinks  = 0
        self.blink_counter = 0
        self.was_sustained = False
        self.angle_buffer.clear()
        self.initial_pitch = None
        self.initial_yaw   = None
        self.initial_roll  = None
        self.tracking_thread = threading.Thread(target=self._track_loop, daemon=True)
        self.tracking_thread.start()
        self.send_message("status", "tracking_started", {"session_id": session_id})

    def stop_tracking(self):
        self.is_tracking = False
        if self.tracking_thread:
            self.tracking_thread.join(timeout=1.0)
        self.send_message("status", "tracking_stopped", {
            "total_gaze_points": len(self.gaze_data),
            "total_blinks":      len(self.blink_data)
        })


def main():
    tracker = EyeTracker()
    if not tracker.initialize():
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd    = json.loads(line)
            action = cmd.get("action")

            if action == "CALIBRATE":
                tracker.screen_w = cmd.get("screen_w", 1920)
                tracker.screen_h = cmd.get("screen_h", 1080)
                t = threading.Thread(target=tracker.calibrate, daemon=True)
                t.start()

            elif action == "START":
                tracker.start_tracking(cmd.get("session_id", "default"))

            elif action == "STOP":
                tracker.stop_tracking()

            elif action == "PING":
                tracker.send_message("status", "pong", {})

            elif action == "EXIT":
                tracker.stop_tracking()
                break

        except Exception as e:
            tracker.send_message("error", "error", {"message": str(e)})

    if tracker.cap:
        tracker.cap.release()


if __name__ == "__main__":
    main()
