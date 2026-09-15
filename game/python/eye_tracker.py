#!/usr/bin/env python3
"""
Eye Tracker — gaze estimation, blink detection, head pose, and camera health.

All computer vision runs here rather than in separate blink_tracker.py /
head_tracker.py processes to avoid Windows camera contention.  Two processes
cannot reliably share a webcam on Windows, so the app owns the device in one
process at a time and the renderer releases it before this one opens it.
See docs/calibration-design.md 11.1.

Electron communicates via newline-delimited JSON on stdin/stdout:
  Electron → Python  e.g. {"action": "START", "session_id": "phase1"}
  Python → Electron  e.g. {"type": "gaze", "action": "detected", "data": {...}}

Timing: every sample carries a monotonic capture timestamp taken immediately
after the frame read returns.  The ready handshake publishes this process's
monotonic epoch so the renderer can relate it to performance.now().  Wall
clock is never used for anything a measurement depends on.
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

from camera_source import (
    CameraSource,
    CameraLost,
    measure_exposure,
    measure_focus,
    measure_glare,
    estimate_distance_cm,
)

CAMERA_INDEX = 0

# Blink thresholds in milliseconds, not frames.  The achieved camera rate is
# not the nominal rate and varies with load, so a frame count is a different
# duration on every machine.  Blinks last 100 to 400 ms.
EAR_THRESHOLD = 0.17
BLINK_MIN_MS = 90
BLINK_MAX_MS = 500

LEFT_IRIS = [468, 469, 470, 471, 472]
RIGHT_IRIS = [473, 474, 475, 476, 477]
LEFT_EYE_INDICES = [33, 160, 158, 133, 153, 144]
RIGHT_EYE_INDICES = [362, 385, 387, 263, 373, 380]

TARGET_PERIOD_S = 1.0 / 30.0
HEALTH_INTERVAL_S = 0.2

MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "../models/face_landmarker.task"
)


class EyeTracker:
    def __init__(self):
        self.is_tracking = False
        self.is_reporting_health = False
        self.session_id = None
        self.gaze_data = []
        self.blink_data = []
        self.camera = None
        self.face_landmarker = None
        self.tracking_thread = None
        self.health_thread = None
        self._lock = threading.Lock()

        # Affine / polynomial calibration coefficients.  Replaced wholesale by
        # the design in docs/calibration-design.md sections 4 to 7, which is
        # not implemented yet.
        self.calib_cx = None
        self.calib_cy = None
        self.calibrated = False

        self.screen_w = 1920
        self.screen_h = 1080
        self.child_age = None

        # Blink state, in time rather than frames.
        self.eyes_closed_since = None
        self.total_blinks = 0

        # Head pose state
        self.angle_buffer = collections.deque(maxlen=5)
        self.initial_pitch = None
        self.initial_yaw = None
        self.initial_roll = None

        self._epoch = time.monotonic()
        self._last_video_ms = -1

    # ── Messaging ──────────────────────────────────────────────────────────

    def send_message(self, msg_type, action, data=None):
        msg = {
            "type": msg_type,
            "action": action,
            "t_monotonic": time.monotonic(),
            "timestamp": datetime.now().isoformat(),
            "data": data or {},
        }
        print(json.dumps(msg), flush=True)

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def initialize(self):
        try:
            self.camera = CameraSource(CAMERA_INDEX, 640, 480, 30)
            actual = self.camera.open()

            options = vision.FaceLandmarkerOptions(
                base_options=python.BaseOptions(model_asset_path=MODEL_PATH),
                running_mode=vision.RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_face_presence_confidence=0.5,
                min_tracking_confidence=0.5,
                output_facial_transformation_matrixes=True,
            )
            self.face_landmarker = vision.FaceLandmarker.create_from_options(options)

            self._epoch = time.monotonic()
            self.send_message(
                "status",
                "ready",
                {
                    "message": "Eye tracker ready",
                    # The renderer pairs this with its own performance.now()
                    # reading to establish a shared epoch.  Without it, gaze
                    # samples cannot be aligned to stimulus onset at all.
                    "monotonic_epoch": self._epoch,
                    "wall_epoch": time.time(),
                    "camera": actual,
                },
            )
            return True
        except CameraLost as exc:
            # Named separately from every other startup failure, because the
            # renderer proved the device worked seconds ago.
            self.send_message(
                "camera",
                "unavailable",
                {"reason": exc.reason, "detail": exc.detail},
            )
            return False
        except Exception as exc:
            self.send_message("error", "error", {"message": str(exc)})
            return False

    def _report_lost(self, exc):
        self.is_tracking = False
        self.is_reporting_health = False
        self.send_message(
            "camera",
            "lost",
            {
                "reason": exc.reason,
                "detail": exc.detail,
                "gaze_points_kept": len(self.gaze_data),
                "blinks_kept": len(self.blink_data),
            },
        )

    # ── Head pose ──────────────────────────────────────────────────────────

    def _extract_head_pose(self, results):
        """Pitch, yaw and roll from MediaPipe's facial transformation matrix.

        Note this is rotation only.  The translation submatrix is discarded,
        so this measures a different physical quantity from QbTest's
        translation-based activity measure and cannot be scored against it.
        See assessment-design.md 3.8.
        """
        try:
            if not results.facial_transformation_matrixes:
                return None, None, None
            tm = results.facial_transformation_matrixes[0]
            if isinstance(tm, np.ndarray):
                mat = tm.astype("double").reshape(4, 4)
            elif hasattr(tm, "data"):
                mat = np.array(list(tm.data), dtype="double").reshape(4, 4)
            else:
                mat = np.array(tm, dtype="double").reshape(4, 4)
            rmat = mat[:3, :3]

            sy = math.sqrt(rmat[0, 0] ** 2 + rmat[1, 0] ** 2)
            if sy > 1e-6:
                pitch = math.degrees(math.atan2(rmat[2, 1], rmat[2, 2]))
                yaw = math.degrees(math.atan2(-rmat[2, 0], sy))
                roll = math.degrees(math.atan2(rmat[1, 0], rmat[0, 0]))
            else:
                pitch = math.degrees(math.atan2(-rmat[1, 2], rmat[1, 1]))
                yaw = math.degrees(math.atan2(-rmat[2, 0], sy))
                roll = 0.0

            return pitch, yaw, roll
        except Exception:
            return None, None, None

    # ── Frame reading ──────────────────────────────────────────────────────

    def _video_timestamp_ms(self, captured_at):
        """Strictly increasing millisecond stamp for MediaPipe VIDEO mode.

        Derived from real elapsed monotonic time.  The previous code added a
        flat 33 ms per frame, which asserted a rate the loop never achieved.
        """
        ms = int((captured_at - self._epoch) * 1000)
        if ms <= self._last_video_ms:
            ms = self._last_video_ms + 1
        self._last_video_ms = ms
        return ms

    def _read_frame(self, want_quality=False):
        """Read and analyse one frame.

        Returns a dict that always distinguishes these three cases:
          camera gone      -> raises CameraLost
          no face in shot  -> face_present False, frame quality still measured
          face found       -> everything populated

        Conflating the first two turns a camera problem into a finding about
        the child.  See assessment-design.md 5.2.
        """
        if self.camera is None or self.face_landmarker is None:
            raise CameraLost("not open", "read before initialize")

        frame, captured_at = self.camera.read()
        if frame is None:
            return {"ok": False, "face_present": False, "t_capture": captured_at}

        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
        results = self.face_landmarker.detect_for_video(
            mp_image, self._video_timestamp_ms(captured_at)
        )

        out = {
            "ok": True,
            "t_capture": captured_at,
            "face_present": False,
            "frame_width": w,
            "frame_height": h,
        }

        if not results.face_landmarks:
            if want_quality:
                exposure = measure_exposure(frame, None)
                out.update(exposure)
                out["laplacian_var"] = measure_focus(frame, None)
                out["glare"] = False
            return out

        lm = results.face_landmarks[0]
        out["face_present"] = True

        # ── Iris and eye geometry, kept per eye ──────────────────────────
        lx = np.mean([lm[i].x for i in LEFT_IRIS]) * w
        ly = np.mean([lm[i].y for i in LEFT_IRIS]) * h
        rx = np.mean([lm[i].x for i in RIGHT_IRIS]) * w
        ry = np.mean([lm[i].y for i in RIGHT_IRIS]) * h

        face_left_x = lm[33].x * w
        face_right_x = lm[263].x * w
        face_top_y = lm[168].y * h
        face_bot_y = lm[152].y * h
        face_w = face_right_x - face_left_x
        face_h = face_bot_y - face_top_y

        if face_w < 1 or face_h < 1:
            out["face_present"] = False
            return out

        iris_x = (lx + rx) / 2
        iris_y = (ly + ry) / 2
        out["iris_nx"] = (iris_x - face_left_x) / face_w
        out["iris_ny"] = (iris_y - face_top_y) / face_h

        # Interocular distance, which drives the viewing distance estimate.
        iod_px = math.hypot(rx - lx, ry - ly)
        out["iod_px"] = iod_px
        distance_cm, assumptions = estimate_distance_cm(iod_px, w, self.child_age)
        out["distance_cm"] = distance_cm
        out["distance_assumptions"] = assumptions

        # ── EAR for blink ────────────────────────────────────────────────
        def calc_ear(indices):
            pts = np.array([[lm[i].x * w, lm[i].y * h] for i in indices])
            a = np.linalg.norm(pts[1] - pts[5])
            b = np.linalg.norm(pts[2] - pts[4])
            c = np.linalg.norm(pts[0] - pts[3])
            return (a + b) / (2.0 * c) if c > 0 else 0.3

        out["ear"] = (calc_ear(LEFT_EYE_INDICES) + calc_ear(RIGHT_EYE_INDICES)) / 2

        pitch, yaw, roll = self._extract_head_pose(results)
        out["pitch"], out["yaw"], out["roll"] = pitch, yaw, roll

        # A real confidence figure.  The constant 0.9 the previous build sent
        # gave downstream code nothing to filter on.  This is a coarse proxy
        # until the per-eye disagreement signal in calibration-design.md
        # section 4 exists.
        out["confidence"] = self._confidence(out, lm, w, h)

        if want_quality:
            face_box = (
                int(face_left_x),
                int(face_top_y),
                int(face_w),
                int(face_h),
            )
            out["face_box"] = face_box
            out.update(measure_exposure(frame, face_box))
            out["laplacian_var"] = measure_focus(frame, face_box)

            eye_w = abs(lm[133].x - lm[33].x) * w
            eye_boxes = [
                (lm[33].x * w, lm[159].y * h - eye_w * 0.4, eye_w, eye_w * 0.8),
                (lm[362].x * w, lm[386].y * h - eye_w * 0.4, eye_w, eye_w * 0.8),
            ]
            glare, worst = measure_glare(frame, eye_boxes)
            out["glare"] = glare
            out["glare_fraction"] = worst

        return out

    def _confidence(self, out, lm, w, h):
        """Coarse per-sample confidence in the range 0 to 1.

        Falls with head rotation away from the calibrated range and with a
        partially closed eye, both of which degrade the iris estimate.
        """
        conf = 1.0
        yaw = out.get("yaw")
        pitch = out.get("pitch")
        if yaw is not None:
            conf *= max(0.0, 1.0 - abs(yaw) / 45.0)
        if pitch is not None:
            conf *= max(0.0, 1.0 - abs(pitch) / 45.0)
        ear = out.get("ear")
        if ear is not None and ear < EAR_THRESHOLD * 1.4:
            conf *= max(0.0, ear / (EAR_THRESHOLD * 1.4))
        return round(min(1.0, max(0.0, conf)), 3)

    # ── Calibration (superseded, see docs/calibration-design.md) ───────────

    def calibrate(self):
        """9-point calibration, unchanged pending the redesign.

        docs/calibration-design.md sections 5 to 8 replace this with a smooth
        pursuit pass, a five point validation pass, and a quality score that
        can reject a session.  That work is not implemented yet, so this
        remains in place rather than leaving nothing here.
        """
        iris_pts = []
        screen_pts = []
        try:
            mx = self.screen_w * 0.1
            my = self.screen_h * 0.1
            cx = self.screen_w / 2
            cy = self.screen_h / 2
            rx = self.screen_w - mx
            ry = self.screen_h - my
            points = [
                (cx, cy), (mx, my), (cx, my), (rx, my), (mx, cy),
                (rx, cy), (mx, ry), (cx, ry), (rx, ry),
            ]

            self.send_message(
                "calibration",
                "started",
                {"message": "Calibration starting", "total_points": len(points)},
            )

            for i, (sx, sy) in enumerate(points):
                self.send_message(
                    "calibration",
                    "instruction",
                    {
                        "message": "Look at the dot and hold still",
                        "point": i + 1,
                        "total_points": len(points),
                        "x": sx,
                        "y": sy,
                    },
                )

                time.sleep(0.6)
                samples_x, samples_y = [], []
                deadline = time.monotonic() + 1.5
                while time.monotonic() < deadline:
                    started = time.monotonic()
                    sample = self._read_frame()
                    if sample.get("face_present"):
                        samples_x.append(sample["iris_nx"])
                        samples_y.append(sample["iris_ny"])
                    elapsed = time.monotonic() - started
                    time.sleep(max(0.0, TARGET_PERIOD_S - elapsed))

                if len(samples_x) >= 5:
                    iris_pts.append(
                        (float(np.median(samples_x)), float(np.median(samples_y)))
                    )
                    screen_pts.append((sx, sy))

            if len(iris_pts) >= 6:
                a = np.array(
                    [[ix, iy, ix * iy, ix ** 2, iy ** 2, 1.0] for ix, iy in iris_pts]
                )
                bx = np.array([sx for sx, _ in screen_pts])
                by = np.array([sy for _, sy in screen_pts])
                self.calib_cx, _, _, _ = np.linalg.lstsq(a, bx, rcond=None)
                self.calib_cy, _, _, _ = np.linalg.lstsq(a, by, rcond=None)
                self.calibrated = True

        except CameraLost as exc:
            self._report_lost(exc)
            return
        except Exception as exc:
            self.send_message("error", "calibration_error", {"message": str(exc)})

        self.send_message(
            "calibration",
            "completed",
            {
                "message": "Calibration complete",
                "calibrated": self.calibrated,
                "points_collected": len(iris_pts),
            },
        )

    def _iris_to_screen(self, iris_nx, iris_ny):
        if self.calibrated and self.calib_cx is not None:
            ix, iy = iris_nx, iris_ny
            feat = np.array([ix, iy, ix * iy, ix ** 2, iy ** 2, 1.0])
            return float(np.dot(self.calib_cx, feat)), float(np.dot(self.calib_cy, feat))
        return (
            (iris_nx - 0.2) / 0.6 * self.screen_w,
            (iris_ny - 0.2) / 0.6 * self.screen_h,
        )

    # ── Health reporting, for the setup screens ────────────────────────────

    def _health_loop(self):
        """Report frame quality while the setup screens are on.

        Runs only when tracking is off, so the camera is read from one thread
        at a time.
        """
        while self.is_reporting_health:
            started = time.monotonic()
            try:
                sample = self._read_frame(want_quality=True)
            except CameraLost as exc:
                self._report_lost(exc)
                return

            if sample.get("ok"):
                self.send_message(
                    "camera",
                    "health",
                    {
                        "t_capture": sample["t_capture"],
                        "face_present": sample["face_present"],
                        "distance_cm": sample.get("distance_cm"),
                        "iod_px": sample.get("iod_px"),
                        "subject_luma": sample.get("subject_luma"),
                        "background_luma": sample.get("background_luma"),
                        "mean_luma": sample.get("mean"),
                        "clipped_percent": sample.get("clipped_percent"),
                        "laplacian_var": sample.get("laplacian_var"),
                        "glare": sample.get("glare", False),
                        "yaw": sample.get("yaw"),
                        "pitch": sample.get("pitch"),
                        "confidence": sample.get("confidence"),
                        "achieved_fps": self.camera.achieved_fps(),
                    },
                )

            elapsed = time.monotonic() - started
            time.sleep(max(0.0, HEALTH_INTERVAL_S - elapsed))

    # ── Tracking ───────────────────────────────────────────────────────────

    def _track_loop(self):
        while self.is_tracking:
            started = time.monotonic()
            try:
                sample = self._read_frame()
            except CameraLost as exc:
                self._report_lost(exc)
                return
            except Exception as exc:
                self.send_message("error", "track_error", {"message": str(exc)})
                sample = {"ok": False, "face_present": False}

            if sample.get("face_present"):
                gx, gy = self._iris_to_screen(sample["iris_nx"], sample["iris_ny"])
                self.send_message(
                    "gaze",
                    "detected",
                    {
                        # Unclamped.  Clamping to the screen turns a wild
                        # estimate into a plausible edge fixation and makes
                        # off-task looking indistinguishable from tracker
                        # error.  See calibration-design.md 3.3.
                        "x": round(gx, 1),
                        "y": round(gy, 1),
                        "on_screen": 0 <= gx <= self.screen_w and 0 <= gy <= self.screen_h,
                        "confidence": sample["confidence"],
                        "face_present": True,
                        "t_capture": sample["t_capture"],
                    },
                )
                self.gaze_data.append({"x": gx, "y": gy, "t": sample["t_capture"]})

                self._update_blink(sample)
                self._update_head_pose(sample)
            elif sample.get("ok"):
                # A frame arrived with no face in it.  Reported explicitly so
                # tracking loss and looking away stay separable.
                self.send_message(
                    "gaze",
                    "no_face",
                    {"t_capture": sample.get("t_capture")},
                )

            # Compensated pacing.  sleep(0.033) after the work meant the true
            # period was inference time plus 33 ms, which nothing measured.
            elapsed = time.monotonic() - started
            time.sleep(max(0.0, TARGET_PERIOD_S - elapsed))

    def _update_blink(self, sample):
        """Blink detection on elapsed time rather than a frame count."""
        ear = sample.get("ear")
        now = sample["t_capture"]
        if ear is None:
            return

        if ear < EAR_THRESHOLD:
            if self.eyes_closed_since is None:
                self.eyes_closed_since = now
            return

        if self.eyes_closed_since is None:
            return

        closed_ms = (now - self.eyes_closed_since) * 1000.0
        self.eyes_closed_since = None

        if BLINK_MIN_MS <= closed_ms <= BLINK_MAX_MS:
            self.total_blinks += 1
            self.send_message(
                "blink",
                "detected",
                {
                    "t_capture": now,
                    "blink_number": self.total_blinks,
                    "closed_ms": round(closed_ms, 1),
                    "ear": ear,
                },
            )
            self.blink_data.append({"t": now, "closed_ms": closed_ms})

    def _update_head_pose(self, sample):
        pitch = sample.get("pitch")
        if pitch is None:
            return
        self.angle_buffer.append([pitch, sample["yaw"], sample["roll"]])
        if len(self.angle_buffer) < 3:
            return

        avg = np.mean(self.angle_buffer, axis=0)
        p, y_, r = float(avg[0]), float(avg[1]), float(avg[2])

        if self.initial_pitch is None:
            self.initial_pitch, self.initial_yaw, self.initial_roll = p, y_, r

        def diff(a, b):
            d = a - b
            while d > 180:
                d -= 360
            while d < -180:
                d += 360
            return d

        pd = round(diff(p, self.initial_pitch), 2)
        yd = round(diff(y_, self.initial_yaw), 2)
        rd = round(diff(r, self.initial_roll), 2)

        thresh = 10
        if yd < -thresh:
            direction = "Left"
        elif yd > thresh:
            direction = "Right"
        elif pd < -thresh:
            direction = "Down"
        elif pd > thresh:
            direction = "Up"
        else:
            direction = "Forward"

        self.send_message(
            "head_pose",
            "detected",
            {
                "pitch": pd,
                "yaw": yd,
                "roll": rd,
                "direction": direction,
                "t_capture": sample["t_capture"],
            },
        )

    # ── Commands ───────────────────────────────────────────────────────────

    def start_health(self):
        if self.is_tracking:
            self.send_message(
                "error",
                "busy",
                {"message": "cannot report health while tracking"},
            )
            return
        if self.is_reporting_health:
            return
        self.is_reporting_health = True
        self.health_thread = threading.Thread(target=self._health_loop, daemon=True)
        self.health_thread.start()
        self.send_message("camera", "health_started", {})

    def stop_health(self):
        self.is_reporting_health = False
        if self.health_thread:
            self.health_thread.join(timeout=1.0)
            self.health_thread = None
        self.send_message("camera", "health_stopped", {})

    def start_tracking(self, session_id):
        self.stop_health()
        self.session_id = session_id
        self.is_tracking = True
        self.gaze_data = []
        self.blink_data = []
        self.total_blinks = 0
        self.eyes_closed_since = None
        self.angle_buffer.clear()
        self.initial_pitch = None
        self.initial_yaw = None
        self.initial_roll = None
        self.tracking_thread = threading.Thread(target=self._track_loop, daemon=True)
        self.tracking_thread.start()
        self.send_message("status", "tracking_started", {"session_id": session_id})

    def stop_tracking(self):
        self.is_tracking = False
        if self.tracking_thread:
            self.tracking_thread.join(timeout=1.0)
            self.tracking_thread = None
        self.send_message(
            "status",
            "tracking_stopped",
            {
                "total_gaze_points": len(self.gaze_data),
                "total_blinks": len(self.blink_data),
                "achieved_fps": self.camera.achieved_fps() if self.camera else None,
            },
        )


def main():
    tracker = EyeTracker()
    if not tracker.initialize():
        sys.exit(1)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            action = cmd.get("action")

            if action == "CALIBRATE":
                tracker.screen_w = cmd.get("screen_w", 1920)
                tracker.screen_h = cmd.get("screen_h", 1080)
                threading.Thread(target=tracker.calibrate, daemon=True).start()

            elif action == "HEALTH_START":
                tracker.child_age = cmd.get("age", tracker.child_age)
                tracker.start_health()

            elif action == "HEALTH_STOP":
                tracker.stop_health()

            elif action == "START":
                tracker.start_tracking(cmd.get("session_id", "default"))

            elif action == "STOP":
                tracker.stop_tracking()

            elif action == "PING":
                # Carries the monotonic clock so the renderer can re-check the
                # shared epoch for drift over a long session.
                tracker.send_message(
                    "status", "pong", {"monotonic": time.monotonic()}
                )

            elif action == "EXIT":
                tracker.stop_tracking()
                tracker.stop_health()
                break

        except Exception as exc:
            tracker.send_message("error", "error", {"message": str(exc)})

    if tracker.camera:
        tracker.camera.release()


if __name__ == "__main__":
    main()
