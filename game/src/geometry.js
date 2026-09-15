/**
 * Display geometry.
 *
 * Every threshold in docs/assessment-design.md is stated in degrees of visual
 * angle. Converting a degree to a pixel needs two facts the app did not
 * previously hold: the physical size of the display, and the viewing distance.
 *
 * Physical size comes from EDID where the platform exposes it. Viewing
 * distance is measured per frame by the tracker and is not this module's job.
 * This module supplies the size, the pixel density, and the conversions.
 *
 * See docs/calibration-design.md section 2.
 */

const { execFile } = require("child_process");

/**
 * Minimum display width that can present a 20 degree cue at a viewing
 * distance a child can hold. Below this, Look Away is not administered.
 * 34 cm puts 20 degrees at 95 percent of half-width at 45 cm, which is close
 * but sustainable. A 13.3 in display would need 38 cm, which is not.
 */
const MIN_DISPLAY_WIDTH_CM = 34;

/** Fraction of half-width the outermost target sits at. */
const TARGET_EDGE_FRACTION = 0.95;

/** Plausibility bounds for an EDID size, in centimetres. */
const MIN_PLAUSIBLE_CM = 15;
const MAX_PLAUSIBLE_CM = 200;

const EDID_TIMEOUT_MS = 8000;

// ── Pure geometry ────────────────────────────────────────────────────────────

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/**
 * Distance from screen centre, in centimetres, for an eccentricity in degrees.
 * Uses the tangent relation. A linear pixels-per-degree constant is 13 percent
 * wrong at 20 degrees, which is exactly where the measurement happens.
 */
function degreesToCm(degrees, viewingDistanceCm) {
  return viewingDistanceCm * Math.tan(toRad(degrees));
}

/** Inverse of degreesToCm. */
function cmToDegrees(cm, viewingDistanceCm) {
  return toDeg(Math.atan(cm / viewingDistanceCm));
}

/** The largest eccentricity a half-width can present at a viewing distance. */
function maxEccentricity(halfWidthCm, viewingDistanceCm) {
  return cmToDegrees(halfWidthCm * TARGET_EDGE_FRACTION, viewingDistanceCm);
}

/**
 * The viewing distance that places `degrees` of eccentricity at
 * TARGET_EDGE_FRACTION of half-width. This is the distance the setup step
 * asks the child to sit at.
 */
function distanceForEccentricity(degrees, halfWidthCm) {
  return (halfWidthCm * TARGET_EDGE_FRACTION) / Math.tan(toRad(degrees));
}

// ── Physical size ────────────────────────────────────────────────────────────

/**
 * Read monitor physical size from EDID.
 *
 * Windows exposes MaxHorizontalImageSize and MaxVerticalImageSize in
 * centimetres through WMI. Other platforms have no equivalent that is worth
 * shelling out for, so they fall through to manual entry.
 *
 * Resolves with an array of { widthCm, heightCm, instance } or an empty array.
 */
function readEdidSizes() {
  if (process.platform !== "win32") return Promise.resolve([]);

  const script =
    "Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams " +
    "-ErrorAction SilentlyContinue | " +
    "Select-Object InstanceName, MaxHorizontalImageSize, MaxVerticalImageSize | " +
    "ConvertTo-Json -Compress";

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: EDID_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve([]);
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return resolve([]);
        }
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        resolve(
          rows
            .map((r) => ({
              widthCm: Number(r.MaxHorizontalImageSize),
              heightCm: Number(r.MaxVerticalImageSize),
              instance: String(r.InstanceName || ""),
            }))
            .filter(
              (r) =>
                Number.isFinite(r.widthCm) &&
                Number.isFinite(r.heightCm) &&
                r.widthCm >= MIN_PLAUSIBLE_CM &&
                r.widthCm <= MAX_PLAUSIBLE_CM &&
                r.heightCm >= MIN_PLAUSIBLE_CM / 2 &&
                r.heightCm <= MAX_PLAUSIBLE_CM,
            ),
        );
      },
    );
  });
}

/**
 * Pick the EDID entry that belongs to the display we are drawing on.
 *
 * With one monitor this is unambiguous. With several, match on aspect ratio
 * against the display's own pixel dimensions and report lower confidence,
 * because a wrong match silently corrupts every degree in the session.
 */
function matchEdidToDisplay(sizes, pixelWidth, pixelHeight) {
  if (sizes.length === 0) return { size: null, confidence: "none" };
  if (sizes.length === 1) return { size: sizes[0], confidence: "high" };

  const targetAspect = pixelWidth / pixelHeight;
  let best = null;
  let bestError = Infinity;
  for (const s of sizes) {
    const error = Math.abs(s.widthCm / s.heightCm - targetAspect);
    if (error < bestError) {
      bestError = error;
      best = s;
    }
  }
  // Two displays of the same aspect ratio cannot be told apart this way.
  const ambiguous =
    sizes.filter(
      (s) => Math.abs(s.widthCm / s.heightCm - targetAspect) - bestError < 0.02,
    ).length > 1;

  return {
    size: best,
    confidence: ambiguous ? "ambiguous" : bestError < 0.05 ? "medium" : "low",
  };
}

/**
 * Build the geometry record for a display.
 *
 * `display` is an Electron Display object. `override` is an operator-entered
 * width and height in centimetres, which wins over EDID when present.
 *
 * Returns a record that always states where its numbers came from. A guessed
 * geometry and a measured one must never be indistinguishable downstream.
 */
async function resolveGeometry(display, override = null) {
  const pixelWidth = display.size.width * display.scaleFactor;
  const pixelHeight = display.size.height * display.scaleFactor;

  let widthCm = null;
  let heightCm = null;
  let source = "unknown";
  let confidence = "none";

  if (
    override &&
    Number.isFinite(override.widthCm) &&
    override.widthCm >= MIN_PLAUSIBLE_CM &&
    override.widthCm <= MAX_PLAUSIBLE_CM
  ) {
    widthCm = override.widthCm;
    heightCm = override.heightCm || (override.widthCm * pixelHeight) / pixelWidth;
    source = "manual";
    confidence = "high";
  } else {
    const sizes = await readEdidSizes();
    const match = matchEdidToDisplay(sizes, pixelWidth, pixelHeight);
    if (match.size && match.confidence !== "ambiguous") {
      widthCm = match.size.widthCm;
      heightCm = match.size.heightCm;
      source = "edid";
      confidence = match.confidence;
    } else if (match.size) {
      // Ambiguous is worse than absent: it looks like an answer.
      source = "ambiguous";
      confidence = "none";
    }
  }

  const usable = widthCm !== null;

  return {
    source, // "edid" | "manual" | "ambiguous" | "unknown"
    confidence, // "high" | "medium" | "low" | "none"
    widthCm,
    heightCm,
    pixelWidth,
    pixelHeight,
    scaleFactor: display.scaleFactor,
    logicalWidth: display.size.width,
    logicalHeight: display.size.height,
    pixelsPerCm: usable ? pixelWidth / widthCm : null,
    halfWidthCm: usable ? widthCm / 2 : null,
    minDisplayWidthCm: MIN_DISPLAY_WIDTH_CM,
    meetsMinimum: usable ? widthCm >= MIN_DISPLAY_WIDTH_CM : null,
    targetEdgeFraction: TARGET_EDGE_FRACTION,
  };
}

/**
 * Everything the setup step needs to place a child at the right distance for
 * a given eccentricity. Returns null when the geometry is unknown.
 */
function distancePlan(geometry, eccentricityDeg) {
  if (!geometry || geometry.widthCm === null) return null;
  const halfWidthCm = geometry.widthCm / 2;
  const targetCm = distanceForEccentricity(eccentricityDeg, halfWidthCm);
  return {
    eccentricityDeg,
    targetDistanceCm: targetCm,
    // A 10 cm lean costs 0.55 degrees of accuracy, so the band is tight.
    minDistanceCm: targetCm * 0.92,
    maxDistanceCm: targetCm * 1.08,
    maxEccentricityAt60cm: maxEccentricity(halfWidthCm, 60),
    achievable: geometry.widthCm >= MIN_DISPLAY_WIDTH_CM,
  };
}

module.exports = {
  MIN_DISPLAY_WIDTH_CM,
  TARGET_EDGE_FRACTION,
  degreesToCm,
  cmToDegrees,
  maxEccentricity,
  distanceForEccentricity,
  readEdidSizes,
  matchEdidToDisplay,
  resolveGeometry,
  distancePlan,
};
