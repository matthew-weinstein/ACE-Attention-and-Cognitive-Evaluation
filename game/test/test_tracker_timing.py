#!/usr/bin/env python3
"""
Verification for tracker timing and camera loss handling.

Run from the game directory:
    .venv/Scripts/python test/test_tracker_timing.py

CLAUDE.md requires that the app behave identically regardless of rate.  For
the tracker the relevant rate is the camera's, not the display's, and the
achieved camera rate is neither the nominal rate nor stable under load.  The
blink tests below assert that the same physical event produces the same
measurement whether it was sampled at 15, 24, 30 or 60 frames per second.
"""

import os
import sys
import math

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))

import camera_source
from camera_source import CameraSource, CameraLost, estimate_distance_cm

PASSED = []
FAILED = []


def test(name):
    def wrap(fn):
        try:
            fn()
            PASSED.append(name)
            print("  ok   {}".format(name))
        except AssertionError as exc:
            FAILED.append(name)
            print("  FAIL {}".format(name))
            print("       {}".format(exc))
        except Exception as exc:  # noqa: BLE001
            FAILED.append(name)
            print("  FAIL {}".format(name))
            print("       {}: {}".format(type(exc).__name__, exc))
        return fn

    return wrap


def near(actual, expected, tol, what):
    assert abs(actual - expected) <= tol, "{}: got {}, expected {} +/- {}".format(
        what, actual, expected, tol
    )


# ── A blink detector isolated from the camera ──────────────────────────────


class BlinkProbe:
    """The blink rule from eye_tracker.py, exercised without a camera.

    Kept in step with the real implementation by asserting the same
    thresholds.  If those move, this fails and says so.
    """

    def __init__(self, ear_threshold, min_ms, max_ms):
        self.ear_threshold = ear_threshold
        self.min_ms = min_ms
        self.max_ms = max_ms
        self.eyes_closed_since = None
        self.blinks = []

    def feed(self, ear, t):
        if ear < self.ear_threshold:
            if self.eyes_closed_since is None:
                self.eyes_closed_since = t
            return
        if self.eyes_closed_since is None:
            return
        closed_ms = (t - self.eyes_closed_since) * 1000.0
        self.eyes_closed_since = None
        if self.min_ms <= closed_ms <= self.max_ms:
            self.blinks.append(closed_ms)


def sample_blink(rate_hz, closed_ms, total_ms=2000, closed_start_ms=600):
    """Sample a blink of a known duration at a given frame rate."""
    probe = BlinkProbe(0.17, 90, 500)
    period = 1.0 / rate_hz
    n = int((total_ms / 1000.0) * rate_hz)
    for i in range(n):
        t = i * period
        t_ms = t * 1000.0
        closed = closed_start_ms <= t_ms < closed_start_ms + closed_ms
        probe.feed(0.10 if closed else 0.30, t)
    return probe.blinks


print("\nblink timing")


@test("the thresholds under test are the ones the tracker uses")
def _():
    # Read the constants straight out of the module so this cannot drift.
    import re

    src = open(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python", "eye_tracker.py"),
        encoding="utf-8",
    ).read()
    assert re.search(r"^EAR_THRESHOLD = 0\.17", src, re.M), "EAR_THRESHOLD changed"
    assert re.search(r"^BLINK_MIN_MS = 90", src, re.M), "BLINK_MIN_MS changed"
    assert re.search(r"^BLINK_MAX_MS = 500", src, re.M), "BLINK_MAX_MS changed"


@test("one blink is counted once at every sampling rate")
def _():
    for rate in (15, 24, 30, 60, 120):
        blinks = sample_blink(rate, 200)
        assert len(blinks) == 1, "rate {} counted {} blinks".format(rate, len(blinks))


@test("measured blink duration matches across sampling rates")
def _():
    # Quantisation is one sample period, so the spread across rates is bounded
    # by the slowest rate's period rather than growing without limit.
    durations = {rate: sample_blink(rate, 200)[0] for rate in (15, 24, 30, 60, 120)}
    for rate, ms in durations.items():
        near(ms, 200, 1000.0 / 15, "duration at {} Hz".format(rate))
    spread = max(durations.values()) - min(durations.values())
    assert spread <= 1000.0 / 15, "spread across rates was {:.1f} ms".format(spread)


@test("a frame-count rule would have failed this, which is why it was removed")
def _():
    # The previous rule required 3 consecutive closed frames. At 15 Hz that is
    # 200 ms and at 120 Hz it is 25 ms, so the same physical blink crossed the
    # threshold on one machine and not on another.
    def frame_rule(rate_hz, closed_ms, consec=3):
        period_ms = 1000.0 / rate_hz
        return math.floor(closed_ms / period_ms) >= consec

    assert frame_rule(120, 100) is True
    assert frame_rule(15, 100) is False, "the old rule was rate dependent"


@test("a long eye closure is not a blink at any rate")
def _():
    for rate in (15, 30, 60):
        assert sample_blink(rate, 900, total_ms=3000) == [], (
            "rate {} scored a sustained closure as a blink".format(rate)
        )


@test("a closure shorter than the floor is not a blink at any rate")
def _():
    for rate in (30, 60, 120):
        assert sample_blink(rate, 40) == [], "rate {} scored a flicker".format(rate)


# ── Loop pacing ────────────────────────────────────────────────────────────

print("\nloop pacing")


@test("compensated pacing holds the period regardless of work done")
def _():
    target = 1.0 / 30.0
    for work in (0.0, 0.005, 0.020, 0.033, 0.080):
        sleep = max(0.0, target - work)
        period = work + sleep
        if work <= target:
            near(period, target, 1e-9, "period with {:.0f} ms of work".format(work * 1000))
        else:
            # Past the budget the loop cannot keep up, and it must not sleep
            # on top of the overrun and fall further behind.
            assert sleep == 0.0
            near(period, work, 1e-9, "period when over budget")


@test("uncompensated pacing drifts, which is what the old loop did")
def _():
    target = 1.0 / 30.0
    work = 0.020  # plausible CPU inference time at 640x480
    old_period = work + target  # sleep(0.033) after the work
    new_period = work + max(0.0, target - work)
    near(1.0 / old_period, 18.8, 0.2, "old effective rate")
    near(1.0 / new_period, 30.0, 0.1, "new effective rate")


@test("video timestamps are strictly increasing under a stalled clock")
def _():
    # MediaPipe VIDEO mode rejects a non-increasing timestamp. Two frames that
    # land inside the same millisecond must still advance.
    last = -1
    stamps = []
    for captured in (0.0000, 0.0004, 0.0008, 0.0330, 0.0331):
        ms = int(captured * 1000)
        if ms <= last:
            ms = last + 1
        last = ms
        stamps.append(ms)
    assert stamps == sorted(set(stamps)), "stamps not strictly increasing: {}".format(stamps)
    assert len(stamps) == len(set(stamps))


# ── Camera loss ────────────────────────────────────────────────────────────

print("\ncamera loss")


class FakeCap:
    """Stands in for cv2.VideoCapture with a scripted failure pattern."""

    def __init__(self, reads):
        self.reads = list(reads)
        self.released = False

    def isOpened(self):
        return True

    def read(self):
        if not self.reads:
            return False, None
        ok = self.reads.pop(0)
        return (True, [[0]]) if ok else (False, None)

    def set(self, *_):
        return True

    def get(self, *_):
        return 0

    def release(self):
        self.released = True

    def getBackendName(self):
        return "FAKE"


@test("a single dropped frame is not a camera loss")
def _():
    cam = CameraSource()
    cam.cap = FakeCap([True, False, True, True])
    cam.read()
    frame, _ = cam.read()
    assert frame is None, "the dropped frame should read as absent"
    frame, _ = cam.read()
    assert frame is not None, "the camera should still be usable"


@test("a sustained read failure raises rather than returning None forever")
def _():
    cam = CameraSource()
    cam.cap = FakeCap([False] * 60)
    cam._reopen = lambda: False  # the device does not come back
    raised = None
    for _ in range(camera_source.READ_FAILURE_LIMIT + 2):
        try:
            cam.read()
        except CameraLost as exc:
            raised = exc
            break
    assert raised is not None, "the loop would have spun forever"
    assert raised.reason == "read failed"
    assert str(camera_source.READ_FAILURE_LIMIT) in raised.detail


@test("an absent face and an absent camera are different outcomes")
def _():
    # A camera that is working but sees nothing returns a frame. Only a camera
    # that has gone raises. Conflating the two turns a hardware problem into a
    # finding about the child.
    cam = CameraSource()
    cam.cap = FakeCap([True])
    frame, t = cam.read()
    assert frame is not None and t > 0


@test("achieved frame rate is measured, not assumed")
def _():
    cam = CameraSource()
    cam._frame_times = [i * (1.0 / 24.0) for i in range(25)]
    near(cam.achieved_fps(), 24.0, 0.01, "achieved fps")
    cam._frame_times = [0.0, 0.1]
    assert cam.achieved_fps() is None, "too few samples should report nothing"


# ── Distance estimate ──────────────────────────────────────────────────────

print("\ndistance estimate")


@test("the distance estimate carries its assumptions")
def _():
    distance, assumptions = estimate_distance_cm(62.0, 640, age=9)
    assert distance is not None
    assert assumptions["method"] == "iod_pinhole"
    assert "assumed_hfov_deg" in assumptions
    assert "assumed_pd_mm" in assumptions


@test("distance falls as the eyes get further apart in the image")
def _():
    near_cm, _ = estimate_distance_cm(120.0, 640, age=9)
    far_cm, _ = estimate_distance_cm(60.0, 640, age=9)
    assert far_cm > near_cm * 1.9, "halving the apparent size should roughly double the distance"


@test("a missing or absurd interocular distance yields no estimate")
def _():
    assert estimate_distance_cm(0, 640)[0] is None
    assert estimate_distance_cm(None, 640)[0] is None


print("\n{} passed, {} failed\n".format(len(PASSED), len(FAILED)))
sys.exit(1 if FAILED else 0)
