/**
 * The canvas the child looks at, and the conversion from degrees to pixels.
 *
 * Every stimulus size and position in docs/assessment-design.md is stated in
 * degrees of visual angle, never in pixels. A 2.5 degree craft is 2.5 degrees
 * on a 13 inch laptop at 45 cm and on a 27 inch monitor at 70 cm, and those
 * are different pixel counts. So the stage owns the conversion and the games
 * never see a pixel constant.
 *
 * The tangent relation, not a pixels-per-degree constant. A linear constant
 * is 13 percent wrong at 20 degrees, which is exactly where Look Away puts
 * its cue.
 *
 * ── What keeps this cheap ──────────────────────────────────────────────────
 *
 * Two canvases. A static one holds the horizon and the field, painted once at
 * resize and blitted with a single drawImage. A live one holds only the
 * moving or changing shapes, and is cleared over the union of what it painted
 * last frame rather than over the whole surface.
 *
 * No shadowBlur, no filter, no createLinearGradient, no globalAlpha layers.
 * Those are the canvas operations that fall off the GPU path and land on the
 * CPU, which is the CPU the tracker subprocess is doing MediaPipe inference
 * on. Everything here is a flat fill on a closed path, which is also exactly
 * the Charley Harper reduction the visual direction asks for. The aesthetic
 * and the performance requirement want the same thing.
 *
 * Device pixel ratio is capped at 2. Flat shapes with hard edges gain nothing
 * above that and a 4K backing store costs four times the fill.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceStage = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_DPR = 2;
  const toRad = (deg) => (deg * Math.PI) / 180;

  function createStage(container, options) {
    const opts = options || {};

    const base = document.createElement("canvas");
    base.className = "stage-layer";
    const live = document.createElement("canvas");
    live.className = "stage-layer";
    container.appendChild(base);
    container.appendChild(live);

    // `alpha: false` on the base lets the compositor skip everything behind
    // it. The live layer must be transparent, because it sits on the base.
    const bctx = base.getContext("2d", { alpha: false });
    const lctx = live.getContext("2d", { alpha: true, desynchronized: true });

    let w = 0;
    let h = 0;
    let dpr = 1;
    let pxPerCm = 96 / 2.54;
    let distanceCm = 55;
    let paintStatic = null;

    // Dirty rectangle carried from the previous frame, so a clear costs the
    // area that actually changed.
    let dx0 = 0;
    let dy0 = 0;
    let dx1 = 0;
    let dy1 = 0;
    let dirtyEmpty = true;

    function sizeCanvas(canvas, ctx) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function resize() {
      const rect = container.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      sizeCanvas(base, bctx);
      sizeCanvas(live, lctx);
      repaintStatic();
      dirtyEmpty = true;
    }

    function repaintStatic() {
      bctx.fillStyle = opts.ground || "#101315";
      bctx.fillRect(0, 0, w, h);
      if (paintStatic) paintStatic(bctx, api);
    }

    const api = {
      base,
      live,
      ctx: lctx,

      /** CSS-pixel width and height of the play area. */
      width: () => w,
      height: () => h,
      centreX: () => w / 2,
      centreY: () => h / 2,

      /**
       * Physical calibration. `widthCm` and pixel width give density,
       * `distanceCm` gives the angle. Both come from the camera check, and
       * neither is guessed: the setup step asks an operator rather than
       * assume a size, because a wrong size corrupts every angle silently.
       */
      calibrate(geometry, viewingDistanceCm) {
        if (geometry && geometry.widthCm && geometry.pixelWidth) {
          pxPerCm = geometry.pixelWidth / geometry.widthCm;
        }
        if (viewingDistanceCm) distanceCm = viewingDistanceCm;
      },

      viewingDistanceCm: () => distanceCm,
      pixelsPerCm: () => pxPerCm,

      /** Pixels subtended by `degrees` of visual angle from screen centre. */
      deg(degrees) {
        return distanceCm * Math.tan(toRad(degrees)) * pxPerCm;
      },

      /** Screen x for an eccentricity, negative is left of centre. */
      degX(degrees) {
        return w / 2 + this.deg(degrees);
      },

      degY(degrees) {
        return h / 2 + this.deg(degrees);
      },

      /** The largest eccentricity this display can actually present. */
      maxEccentricityDeg() {
        const halfCm = w / 2 / pxPerCm;
        return (Math.atan((halfCm * 0.95) / distanceCm) * 180) / Math.PI;
      },

      /** Register the painter for the layer that does not change per frame. */
      setStatic(fn) {
        paintStatic = fn;
        repaintStatic();
      },

      repaintStatic,

      /**
       * Clear only what was painted last frame. `beginFrame` then a series of
       * `mark(x, y, r)` calls around each shape drawn, so the next clear
       * knows its bounds.
       */
      beginFrame() {
        if (!dirtyEmpty) {
          lctx.clearRect(dx0 - 2, dy0 - 2, dx1 - dx0 + 4, dy1 - dy0 + 4);
        }
        dirtyEmpty = true;
      },

      mark(x, y, radius) {
        const r = radius + 2;
        if (dirtyEmpty) {
          dx0 = x - r;
          dy0 = y - r;
          dx1 = x + r;
          dy1 = y + r;
          dirtyEmpty = false;
          return;
        }
        if (x - r < dx0) dx0 = x - r;
        if (y - r < dy0) dy0 = y - r;
        if (x + r > dx1) dx1 = x + r;
        if (y + r > dy1) dy1 = y + r;
      },

      /** Clear everything. Used at block boundaries, not per frame. */
      clearAll() {
        lctx.clearRect(0, 0, w, h);
        dirtyEmpty = true;
      },

      resize,

      destroy() {
        base.remove();
        live.remove();
      },
    };

    resize();
    return api;
  }

  return { createStage, MAX_DPR };
});
