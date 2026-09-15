#!/usr/bin/env python3
"""
Camera source with health measurement and loss detection.

The previous implementation returned None from _read_frame() both when the
camera had gone and when no face was found, so a hardware failure and a child
leaning out of shot were the same value.  Nothing downstream could tell them
apart, and nothing reported either one.

This wraps cv2.VideoCapture and separates the two.  It also measures the frame
quality figures the setup screens need, and stamps every frame with a
monotonic capture time rather than a synthetic 33 ms counter.

Thresholds here are starting points.  They must be tuned on real hardware
before they mean anything.  See docs/calibration-design.md 11.5.
"""

import time
import cv2
import numpy as np


# Consecutive failed reads before the camera is treated as gone.  At a nominal
# 30 fps this is about half a second, which is long enough to ride out a single
# dropped frame and short enough that a child is not left staring at a frozen
# screen.
READ_FAILURE_LIMIT = 15

# Reopen attempts before giving up and reporting the camera lost.
REOPEN_ATTEMPTS = 2
REOPEN_DELAY_S = 0.4

# Analysis is done on a downscaled copy.  Every measure below is a single pass
# or a small kernel, so the cost is bounded and the full frame is never needed.
ANALYSIS_WIDTH = 320

# Specular highlight threshold for glasses glare, and the fraction of the eye
# region that has to be that bright before it is called glare.
GLARE_LEVEL = 243
GLARE_FRACTION = 0.06

# Pupillary distance in millimetres by age, used for the distance estimate.
# Values are a coarse reference and carry an assumption that has not been
# checked for this age band.  See docs/calibration-design.md section 15.
PD_MM_BY_AGE = {6: 50.0, 7: 51.0, 8: 52.0, 9: 53.0, 10: 54.0, 11: 55.0}
PD_MM_DEFAULT = 52.5

# Horizontal field of view assumed when deriving focal length in pixels.
# Recorded with every estimate so a wrong assumption is visible rather than
# silently folded into the number.
ASSUMED_HFOV_DEG = 60.0


class CameraLost(Exception):
    """Raised when the device is gone and could not be reopened."""

    def __init__(self, reason, detail=None):
        super().__init__(reason)
        self.reason = reason
        self.detail = detail


class CameraSource:
    """One camera, opened once, with health measurement on every frame."""

    def __init__(self, index=0, width=640, height=480, fps=30):
        self.index = index
        self.requested = (width, height, fps)
        self.cap = None
        self.actual = {}

        self._read_failures = 0
        self._frame_times = []          # monotonic capture times, recent only
        self._opened_at = None

    # ── Lifecycle ──────────────────────────────────────────────────────────

    def open(self):
        """Open the device and record what it actually gave us.

        cv2 silently ignores a set() the driver will not honour, so the
        requested and the delivered settings are both recorded.  Reporting the
        requested resolution as though it were the delivered one is how a
        320x240 camera passes a 640x480 check.
        """
        width, height, fps = self.requested
        cap = cv2.VideoCapture(self.index)
        if not cap.isOpened():
            cap.release()
            raise CameraLost(
                "could not open",
                "the device did not open at index {}".format(self.index),
            )

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        cap.set(cv2.CAP_PROP_FPS, fps)

        self.cap = cap
        self._opened_at = time.monotonic()
        self._read_failures = 0
        self._frame_times = []
        self.actual = {
            "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
            "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
            "fps_reported": float(cap.get(cv2.CAP_PROP_FPS) or 0.0),
            "backend": cap.getBackendName() if hasattr(cap, "getBackendName") else None,
            "requested_width": width,
            "requested_height": height,
            "requested_fps": fps,
        }
        return self.actual

    def release(self):
        if self.cap is not None:
            self.cap.release()
            self.cap = None

    def _reopen(self):
        """Try to get the device back. Returns True when it comes back."""
        self.release()
        for _ in range(REOPEN_ATTEMPTS):
            time.sleep(REOPEN_DELAY_S)
            try:
                self.open()
                ok, _ = self.cap.read()
                if ok:
                    return True
            except CameraLost:
                continue
            self.release()
        return False

    # ── Reading ────────────────────────────────────────────────────────────

    def read(self):
        """Read one frame.

        Returns (frame, capture_time_monotonic).  Raises CameraLost when the
        device has gone and could not be reopened.  A single failed read is
        not a loss, and a loss is never confused with an absent face.
        """
        if self.cap is None:
            raise CameraLost("not open", "read() before open()")

        ok, frame = self.cap.read()
        # Stamped immediately after the read returns.  This carries the
        # capture, transfer and decode latency, which is unmeasured.  See
        # docs/calibration-design.md 5.2 and section 15.
        captured_at = time.monotonic()

        if not ok or frame is None:
            self._read_failures += 1
            if self._read_failures >= READ_FAILURE_LIMIT:
                if self._reopen():
                    self._read_failures = 0
                    raise CameraLost(
                        "recovered",
                        "the camera stopped and came back",
                    )
                raise CameraLost(
                    "read failed",
                    "{} consecutive failed reads and the device would not "
                    "reopen".format(self._read_failures),
                )
            return None, captured_at

        self._read_failures = 0
        self._frame_times.append(captured_at)
        if len(self._frame_times) > 90:
            self._frame_times = self._frame_times[-90:]
        return frame, captured_at

    def achieved_fps(self):
        """Measured delivery rate over the recent window, or None."""
        if len(self._frame_times) < 5:
            return None
        span = self._frame_times[-1] - self._frame_times[0]
        if span <= 0:
            return None
        return (len(self._frame_times) - 1) / span


# ── Frame quality ──────────────────────────────────────────────────────────


def _downscale(frame):
    h, w = frame.shape[:2]
    if w <= ANALYSIS_WIDTH:
        return frame, 1.0
    scale = ANALYSIS_WIDTH / float(w)
    return cv2.resize(frame, (ANALYSIS_WIDTH, int(h * scale))), scale


def measure_exposure(frame, face_box=None):
    """Mean luminance overall, and inside against outside the face box.

    Mean luminance alone does not catch a backlit child, which is the common
    living room failure: the frame averages fine while the face is black.  The
    face against background gap is the measure that catches it, and it needs a
    face box, which is why this lives here rather than in the renderer.
    """
    small, scale = _downscale(frame)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    overall = float(np.mean(grey))
    clipped = float(np.count_nonzero(grey >= 250)) / grey.size * 100.0

    subject = None
    background = None
    if face_box is not None:
        x, y, w, h = [int(v * scale) for v in face_box]
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(grey.shape[1], x + w), min(grey.shape[0], y + h)
        if x1 > x0 and y1 > y0:
            face = grey[y0:y1, x0:x1]
            subject = float(np.mean(face))
            mask = np.ones(grey.shape, dtype=bool)
            mask[y0:y1, x0:x1] = False
            if mask.any():
                background = float(np.mean(grey[mask]))

    return {
        "mean": overall,
        "clipped_percent": clipped,
        "subject_luma": subject,
        "background_luma": background,
    }


def measure_focus(frame, face_box=None):
    """Variance of the Laplacian, over the face where one is known.

    Measuring the whole frame rewards a sharp background behind a blurred
    child, which is exactly backwards for this purpose.
    """
    small, scale = _downscale(frame)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    if face_box is not None:
        x, y, w, h = [int(v * scale) for v in face_box]
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(grey.shape[1], x + w), min(grey.shape[0], y + h)
        if x1 - x0 > 8 and y1 - y0 > 8:
            grey = grey[y0:y1, x0:x1]

    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def measure_glare(frame, eye_boxes):
    """Specular highlights in the eye regions, which is what glasses produce.

    Returns (is_glare, worst_fraction).  A blown-out highlight over an iris
    removes the landmark the whole gaze estimate rests on, so this is worth
    catching before calibration rather than after it.
    """
    if not eye_boxes:
        return False, 0.0

    grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    worst = 0.0
    for (x, y, w, h) in eye_boxes:
        x0, y0 = max(0, int(x)), max(0, int(y))
        x1, y1 = min(grey.shape[1], int(x + w)), min(grey.shape[0], int(y + h))
        if x1 <= x0 or y1 <= y0:
            continue
        region = grey[y0:y1, x0:x1]
        if region.size == 0:
            continue
        fraction = float(np.count_nonzero(region >= GLARE_LEVEL)) / region.size
        worst = max(worst, fraction)

    return worst >= GLARE_FRACTION, worst


def focal_length_px(frame_width, hfov_deg=ASSUMED_HFOV_DEG):
    """Focal length in pixels from an assumed horizontal field of view."""
    half = np.radians(hfov_deg / 2.0)
    return (frame_width / 2.0) / np.tan(half)


def estimate_distance_cm(iod_px, frame_width, age=None):
    """Viewing distance from apparent interocular distance.

    Pinhole geometry with an assumed field of view and an age-referenced
    pupillary distance.  Both assumptions are recorded alongside the estimate,
    because neither has been validated for this age band.
    """
    if not iod_px or iod_px <= 1:
        return None, {}

    pd_mm = PD_MM_BY_AGE.get(age, PD_MM_DEFAULT)
    f_px = focal_length_px(frame_width)
    distance_mm = (pd_mm * f_px) / float(iod_px)

    return distance_mm / 10.0, {
        "method": "iod_pinhole",
        "assumed_hfov_deg": ASSUMED_HFOV_DEG,
        "assumed_pd_mm": pd_mm,
        "focal_px": f_px,
    }
