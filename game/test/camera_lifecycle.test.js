/**
 * Verification for the camera lifecycle.
 *
 * Plain node, no framework, because package.json carries only electron and a
 * test dependency is not worth adding for this.
 *
 *   node test/camera_lifecycle.test.js
 */

const assert = require("assert");
const geometry = require("../src/geometry");
const { STATES, render } = require("../src/camera_states");
const { SessionStore, STATUS } = require("../src/session_store");
const fs = require("fs");
const os = require("os");
const path = require("path");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function near(actual, expected, tolerance, what) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${what}: got ${actual}, expected ${expected} +/- ${tolerance}`,
  );
}

// ── Geometry ────────────────────────────────────────────────────────────────

console.log("\ngeometry");

test("degrees to centimetres uses the tangent relation", () => {
  // 20 degrees at 60 cm is 60 * tan(20) = 21.84 cm.
  near(geometry.degreesToCm(20, 60), 21.84, 0.02, "20 deg at 60 cm");
  near(geometry.degreesToCm(0, 60), 0, 1e-9, "0 deg");
});

test("a linear pixels-per-degree constant misplaces the 20 degree target", () => {
  // Why the tangent relation is mandatory rather than a nicety. A constant
  // taken at screen centre puts the target 4.1 percent too close, which is
  // 0.76 degrees of eccentricity error against a 3 to 5 degree budget.
  const linear = geometry.degreesToCm(1, 60) * 20;
  const actual = geometry.degreesToCm(20, 60);
  near(((actual - linear) / actual) * 100, 4.09, 0.05, "position error percent");
  near(20 - geometry.cmToDegrees(linear, 60), 0.76, 0.02, "eccentricity error");
});

test("the local scale at 20 degrees is 13 percent wider than at centre", () => {
  // Distinct from the figure above: this is the derivative ratio, which is
  // why the error grows with eccentricity rather than staying flat.
  const atCentre = geometry.degreesToCm(0.5, 60) - geometry.degreesToCm(-0.5, 60);
  const at20 = geometry.degreesToCm(20.5, 60) - geometry.degreesToCm(19.5, 60);
  near(at20 / atCentre, 1.132, 0.01, "local scale ratio");
});

test("degrees and centimetres round trip", () => {
  for (const deg of [1, 5, 10, 20, 26]) {
    const cm = geometry.degreesToCm(deg, 58);
    near(geometry.cmToDegrees(cm, 58), deg, 1e-9, `round trip at ${deg} deg`);
  }
});

test("a 15.6 inch display cannot present 20 degrees at 60 cm", () => {
  const halfWidth = 17.3;
  const max = geometry.maxEccentricity(halfWidth, 60);
  assert(max < 20, `expected under 20 deg, got ${max.toFixed(1)}`);
  near(max, 15.3, 0.5, "max eccentricity on a 15.6 in display at 60 cm");
});

test("the required viewing distance is computed, not assumed", () => {
  const d = geometry.distanceForEccentricity(20, 17.3);
  near(d, 45.2, 0.5, "distance for 20 deg on a 15.6 in display");
  // And the geometry is self-consistent at that distance.
  near(geometry.maxEccentricity(17.3, d), 20, 1e-6, "eccentricity at that distance");
});

test("the minimum display width supports a distance a child can hold", () => {
  const halfWidth = geometry.MIN_DISPLAY_WIDTH_CM / 2;
  const d = geometry.distanceForEccentricity(20, halfWidth);
  assert(d >= 40, `minimum display would need ${d.toFixed(1)} cm, under 40`);
  assert(d <= 50, `minimum display would need ${d.toFixed(1)} cm, over 50`);
});

test("EDID matching picks the display with the closest aspect ratio", () => {
  const sizes = [
    { widthCm: 59.0, heightCm: 33.0, instance: "wide" }, // 16:9
    { widthCm: 40.8, heightCm: 25.5, instance: "sixteen-ten" }, // 16:10
  ];
  const m = geometry.matchEdidToDisplay(sizes, 2560, 1440);
  assert.strictEqual(m.size.instance, "wide");
});

test("two displays of the same aspect ratio report as ambiguous", () => {
  const sizes = [
    { widthCm: 59.0, heightCm: 33.2, instance: "a" },
    { widthCm: 52.0, heightCm: 29.3, instance: "b" },
  ];
  const m = geometry.matchEdidToDisplay(sizes, 2560, 1440);
  assert.strictEqual(m.confidence, "ambiguous");
});

test("implausible EDID sizes are rejected rather than used", () => {
  const m = geometry.matchEdidToDisplay([], 1920, 1080);
  assert.strictEqual(m.size, null);
  assert.strictEqual(m.confidence, "none");
});

test("a distance plan reports achievability rather than silently failing", () => {
  const small = geometry.distancePlan(
    { widthCm: 28.7, heightCm: 16.1 },
    20,
  );
  assert.strictEqual(small.achievable, false);

  const big = geometry.distancePlan({ widthCm: 59.0, heightCm: 33.0 }, 20);
  assert.strictEqual(big.achievable, true);
  near(big.targetDistanceCm, 77.0, 1.0, "target distance on a 59 cm display");
});

// ── States and copy ─────────────────────────────────────────────────────────

console.log("\ncamera states");

const REQUIRED_STATES = [
  "PERMISSION_NOT_REQUESTED",
  "PERMISSION_DENIED",
  "PERMISSION_DISMISSED",
  "NO_CAMERA",
  "CAMERA_IN_USE",
  "DISCONNECTED_MID_SESSION",
  "TOO_DARK_BACKLIT",
  "TOO_DARK_ROOM",
  "RESOLUTION_TOO_LOW",
  "FRAMERATE_TOO_LOW",
  "BLOCKED_BY_POLICY",
  "TAKEN_BEFORE_START",
  "FRAMES_STOPPED",
];

test("every state named in the requirement exists", () => {
  for (const id of REQUIRED_STATES) {
    assert(STATES[id], `missing state ${id}`);
  }
});

const CONTEXTS = {
  RESOLUTION_TOO_LOW: { width: 320, height: 240, minWidth: 640, minHeight: 480 },
  FRAMERATE_TOO_LOW: { measuredFps: 8.2, minFps: 15, windowMs: 2000 },
  TOO_DARK_BACKLIT: { subject: 31, background: 190 },
  TOO_DARK_ROOM: { mean: 22, minMean: 45 },
  TOO_BRIGHT: { clippedPercent: 31, maxClippedPercent: 12 },
  TOO_FAR: { distanceCm: 92, targetCm: 77 },
  TOO_CLOSE: { distanceCm: 40, targetCm: 77 },
  BLURRED: { variance: 34, floor: 90 },
  FRAMES_STOPPED: { stalledMs: 2500 },
  DISPLAY_TOO_SMALL: { widthCm: 28.7, minWidthCm: 34 },
  PERMISSION_DENIED: { platform: "win32" },
};

test("every state renders a title and a child line", () => {
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    assert(v.title && v.title.length > 0, `${id} has no title`);
    assert(v.child && v.child.length > 0, `${id} has no child line`);
  }
});

test("every state that needs an adult says what the adult must do", () => {
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    if (!v.needsAdult) continue;
    assert(v.adult && v.adult.length > 0, `${id} needs an adult but says nothing`);
  }
});

test("child copy obeys the project copy rules", () => {
  const banned = /[;—!]|\p{Extended_Pictographic}/u;
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    assert(!banned.test(v.child), `${id} child line breaks a copy rule: ${v.child}`);
    assert(!banned.test(v.title), `${id} title breaks a copy rule: ${v.title}`);
    if (v.adult) {
      assert(!banned.test(v.adult), `${id} adult line breaks a copy rule`);
    }
  }
});

test("no number or measurement appears in a primary message", () => {
  // Figures belong in the detail line, never in the line a child reads.
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    assert(!/\d/.test(v.child), `${id} child line carries a figure: ${v.child}`);
  }
});

test("child copy stays short enough to read", () => {
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    const words = v.child.split(/\s+/).length;
    assert(words <= 22, `${id} child line is ${words} words`);
    const longest = v.child
      .split(/\s+/)
      .reduce((a, w) => Math.max(a, w.replace(/[^a-z]/gi, "").length), 0);
    assert(longest <= 12, `${id} child line has a ${longest} letter word`);
  }
});

test("technical detail renders only where a context supplies it", () => {
  const v = render("RESOLUTION_TOO_LOW", CONTEXTS.RESOLUTION_TOO_LOW);
  assert(/320/.test(v.detail), "detail should carry the measured resolution");
  assert(!/320/.test(v.child), "child line must not carry it");
});

test("every state offers an action or is terminal on purpose", () => {
  const terminal = new Set(["OK", "TOO_FAR", "TOO_CLOSE"]);
  for (const id of Object.keys(STATES)) {
    const v = render(id, CONTEXTS[id] || {});
    if (terminal.has(id)) continue;
    assert(v.actions.length > 0, `${id} offers no way forward`);
  }
});

test("an unknown state raises rather than rendering something generic", () => {
  assert.throws(() => render("NOT_A_STATE", {}), /unknown camera state/);
});

// ── Error mapping ───────────────────────────────────────────────────────────

console.log("\ngetUserMedia error mapping");

// probe.js is a browser script rather than a module. Shimming the globals it
// reads at load time lets the error mapping, which is the most consequential
// function in the lifecycle, be tested without a browser.
const probeSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "camera", "probe.js"),
  "utf8",
);
global.window = { CameraStates: { STATES }, aceCamera: { platform: "win32" } };
global.navigator = { mediaDevices: {} };
global.document = { createElement: () => ({ getContext: () => ({}) }) };
// eslint-disable-next-line no-eval
const CameraProbe = eval(`${probeSource}; CameraProbe`);

const domError = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

test("a denial and a dismissal are separated by the permission state", () => {
  // Chromium rejects with the same error name for both, so the Permissions
  // API state read afterwards is the only thing that tells them apart.
  assert.strictEqual(
    CameraProbe.mapError(domError("NotAllowedError"), "denied"),
    "PERMISSION_DENIED",
  );
  assert.strictEqual(
    CameraProbe.mapError(domError("NotAllowedError"), "prompt"),
    "PERMISSION_DISMISSED",
  );
});

test("a device that will not start is not reported as in use", () => {
  // Verified against a real machine whose only imaging device is a printer
  // and an OBS Virtual Camera driver: one video input enumerated, and
  // getUserMedia rejected NotReadableError with no camera present at all.
  assert.strictEqual(
    CameraProbe.mapError(domError("NotReadableError"), "granted"),
    "CAMERA_WONT_START",
  );
});

test("a device that worked and then failed is reported as taken", () => {
  // The one case where another app holding the camera is established rather
  // than guessed, because this session already had a working stream.
  const before = CameraProbe.mapError(domError("NotReadableError"), "granted");
  assert.strictEqual(before, "CAMERA_WONT_START");
  CameraProbe._setHasStreamed(true);
  assert.strictEqual(
    CameraProbe.mapError(domError("NotReadableError"), "granted"),
    "TAKEN_BEFORE_START",
  );
  CameraProbe._setHasStreamed(false);
});

test("no device and an unmeetable constraint map to their own states", () => {
  assert.strictEqual(CameraProbe.mapError(domError("NotFoundError")), "NO_CAMERA");
  assert.strictEqual(
    CameraProbe.mapError(domError("OverconstrainedError", { constraint: "deviceId" })),
    "NO_CAMERA",
  );
  assert.strictEqual(
    CameraProbe.mapError(domError("OverconstrainedError", { constraint: "width" })),
    "RESOLUTION_TOO_LOW",
  );
});

test("an unexpected error still names the failure rather than staying silent", () => {
  const state = CameraProbe.mapError(domError("SomeFutureError"), "granted");
  assert.strictEqual(state, "HARDWARE_ERROR");
  const v = render(state, {});
  assert(v.adult && v.actions.length > 0, "an unmapped error must still offer a way out");
});

test("frame quality is judged in a fixed order", () => {
  const good = { width: 1280, height: 720 };
  const rate = { supported: true, fps: 30, stalled: false, elapsedMs: 2000 };

  // A stalled stream is judged before anything derived from image content,
  // because a frame that never arrived cannot be measured.
  assert.strictEqual(
    CameraProbe.judge(good, { ...rate, stalled: true }, { mean: 0, clippedPercent: 0, centre: 0, border: 0 }).state,
    "FRAMES_STOPPED",
  );

  // Backlighting is judged before mean brightness, or a bright background
  // with a dark face reads as correctly exposed and lands on the wrong screen.
  assert.strictEqual(
    CameraProbe.judge(good, rate, { mean: 120, clippedPercent: 2, centre: 30, border: 190 }).state,
    "TOO_DARK_BACKLIT",
  );

  assert.strictEqual(
    CameraProbe.judge(good, rate, { mean: 20, clippedPercent: 0, centre: 20, border: 22 }).state,
    "TOO_DARK_ROOM",
  );

  assert.strictEqual(
    CameraProbe.judge({ width: 320, height: 240 }, rate, { mean: 120, clippedPercent: 2, centre: 120, border: 120 }).state,
    "RESOLUTION_TOO_LOW",
  );

  assert.strictEqual(
    CameraProbe.judge(good, { ...rate, fps: 6 }, { mean: 120, clippedPercent: 2, centre: 120, border: 120 }).state,
    "FRAMERATE_TOO_LOW",
  );

  assert.strictEqual(
    CameraProbe.judge(good, rate, { mean: 120, clippedPercent: 2, centre: 120, border: 120 }),
    null,
    "a usable stream should return no verdict",
  );
});

// ── Session persistence ─────────────────────────────────────────────────────

console.log("\nsession persistence");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ace-session-"));

test("a trial reaches disk as it completes, not at the end", async () => {
  const store = new SessionStore(tmp);
  store.begin("s1", { band: "B" });
  store.appendTrial("s1", { trial_index: 0, rt: 412 });
  store.appendTrial("s1", { trial_index: 1, rt: 388 });
  await store.drain();

  const lines = fs
    .readFileSync(path.join(tmp, "s1", "trials.ndjson"), "utf8")
    .trim()
    .split("\n");
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[1]).rt, 388);
});

test("an interrupted session keeps its trials and is marked incomplete", async () => {
  const store = new SessionStore(tmp);
  store.begin("s2", {});
  store.appendTrial("s2", { trial_index: 0 });
  store.appendTrial("s2", { trial_index: 1 });
  store.markGameCompleted("s2", "signal_watch");
  const manifest = store.finish("s2", STATUS.INCOMPLETE, "the camera stopped");
  await store.drain();

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, "s2", "manifest.json"), "utf8"),
  );
  assert.strictEqual(onDisk.status, "incomplete");
  assert.strictEqual(onDisk.statusReason, "the camera stopped");
  assert.strictEqual(onDisk.trialsWritten, 2);
  assert.deepStrictEqual(onDisk.gamesCompleted, ["signal_watch"]);
  assert.strictEqual(manifest.status, "incomplete");

  const lines = fs
    .readFileSync(path.join(tmp, "s2", "trials.ndjson"), "utf8")
    .trim()
    .split("\n");
  assert.strictEqual(lines.length, 2, "completed trials must survive");
});

test("a session left open by a crash is reconciled at startup", async () => {
  const store = new SessionStore(tmp);
  store.begin("s3", {});
  store.appendTrial("s3", { trial_index: 0 });
  await store.drain();

  const fresh = new SessionStore(tmp);
  const fixed = fresh.reconcileOrphans();
  assert(fixed.includes("s3"), "s3 should have been reconciled");

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(tmp, "s3", "manifest.json"), "utf8"),
  );
  assert.strictEqual(onDisk.status, "incomplete");
  assert(/closed before/.test(onDisk.statusReason));
});

// Async tests above resolve before this runs because each awaits drain inside.
setTimeout(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}, 400);
