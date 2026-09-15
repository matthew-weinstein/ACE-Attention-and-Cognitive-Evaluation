/**
 * The shape vocabulary.
 *
 * Charley Harper called what he did minimal realism: a rock is two triangles
 * and a shadow, a bird is three circles and a wedge. Reduce the object to the
 * fewest flat shapes that still read as that object, then stop. No modelling,
 * no texture, no gradient, no glow. Dick Bruna's discipline sits on top of
 * that, one unmodulated line weight and a short palette, which is what keeps
 * this child-appropriate without bubble letters or primary colours.
 *
 * The reduction is also why the renderer is cheap. Every shape below is a
 * closed path and one flat fill. There is no shadowBlur, no filter and no
 * gradient anywhere in this file, which are the canvas operations that leave
 * the GPU path and take CPU the tracker needs for inference.
 *
 * Every function takes a size in pixels that the stage computed from degrees
 * of visual angle. No shape holds a pixel constant of its own.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceShapes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const TAU = Math.PI * 2;

  /**
   * A craft crossing the scope, leaning left or right.
   *
   * A swept delta and nothing else. The first version of this was a vertical
   * wedge with a fin, and on screen it read as a mouse cursor rather than as a
   * vehicle. Worse, a tall narrow shape rolled by eight degrees barely changes:
   * the lean is the measurement, so the lean has to be the most legible thing
   * about the shape.
   *
   * A wide flat wing solves both. Rolled eight degrees, one wingtip visibly
   * rises and the other drops, and the tip that drops is the side to press.
   * `size` is the full wingspan, which is the 2.5 degrees of visual angle the
   * stage computes.
   */
  function craft(ctx, x, y, size, tiltDeg, fill) {
    const s = size / 2;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((tiltDeg * Math.PI) / 180);
    ctx.fillStyle = fill;

    // The wing. One swept delta, which is where the lean reads from.
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.34);
    ctx.lineTo(s, s * 0.3);
    ctx.lineTo(0, s * 0.02);
    ctx.lineTo(-s, s * 0.3);
    ctx.closePath();
    ctx.fill();

    // The fuselage. Without it the wing alone reads as a bird or a chevron,
    // and the child is being asked to watch for craft.
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.52);
    ctx.lineTo(s * 0.13, s * 0.1);
    ctx.lineTo(0, s * 0.42);
    ctx.lineTo(-s * 0.13, s * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  /** Deterministic vertex offsets, so a rock looks the same every session. */
  function rockPath(ctx, x, y, r, variant) {
    const sides = 7;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU - Math.PI / 2;
      const wobble = 0.82 + 0.3 * ((Math.sin(i * 2.7 + variant * 1.9) + 1) / 2);
      const px = x + Math.cos(a) * r * wobble;
      const py = y + Math.sin(a) * r * wobble;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * A rock. Body, one darker facet, and nothing else.
   *
   * `rim` is the already-tagged marker in Asteroid Run. It is a ring of
   * constant width at the same size and position as a plain rock, so the
   * only difference between go and no-go is the rim. Anything else would let
   * a child respond to size or position instead of to the rule.
   */
  function rock(ctx, x, y, r, variant, fill, facet, rim) {
    rockPath(ctx, x, y, r, variant);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.save();
    ctx.clip();
    ctx.fillStyle = facet;
    ctx.beginPath();
    ctx.moveTo(x - r * 1.2, y + r * 0.1);
    ctx.lineTo(x + r * 1.2, y + r * 0.62);
    ctx.lineTo(x + r * 1.2, y + r * 1.2);
    ctx.lineTo(x - r * 1.2, y + r * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (rim) {
      ctx.strokeStyle = rim;
      ctx.lineWidth = Math.max(2, r * 0.16);
      rockPath(ctx, x, y, r * 1.14, variant);
      ctx.stroke();
    }
  }

  /**
   * A landing beacon. A squat base standing on the horizon with a lamp on it.
   * Lit is a filled lamp, unlit is an outlined one. Same footprint either way,
   * so nothing moves when it lights.
   */
  function beacon(ctx, x, y, r, body, lamp, lit) {
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.62, y + r);
    ctx.lineTo(x - r * 0.34, y - r * 0.1);
    ctx.lineTo(x + r * 0.34, y - r * 0.1);
    ctx.lineTo(x + r * 0.62, y + r);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y - r * 0.52, r * 0.46, 0, TAU);
    if (lit) {
      ctx.fillStyle = lamp;
      ctx.fill();
    } else {
      ctx.strokeStyle = body;
      ctx.lineWidth = Math.max(2, r * 0.13);
      ctx.stroke();
    }
  }

  /**
   * The fixation and validation marker from docs/calibration-design.md 5.2.
   *
   * A small high-contrast core inside a larger low-contrast ring. The core is
   * what the eye lands on, the ring is what makes it findable from across the
   * screen. Schlegelmilch and Wertz found sharp edges pull fixation to the
   * edge rather than the centre, so the outer element is a low-contrast ring
   * rather than a hard-edged disc, and the core is small enough that there is
   * only one place to look.
   */
  function marker(ctx, x, y, r, core, halo) {
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.26, 0, TAU);
    ctx.fill();
  }

  /** An empty landing zone in Look Away. Ring only, never a filled target. */
  function zone(ctx, x, y, r, stroke, weight) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = weight;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
  }

  /**
   * A door standing on the horizon. `open` runs 0 to 1.
   *
   * Three flat shapes: the dark way through, the leaf that slides off it, and
   * the frame around both. The first version was a grey slab with a dark slot
   * growing inside it, which read as a rectangle with a hole rather than as a
   * door, and a child waiting on a door needs to see that it is opening.
   */
  function door(ctx, x, y, width, height, open, frame, mouth) {
    const left = x - width / 2;
    const top = y - height;

    // The way through.
    ctx.fillStyle = mouth;
    ctx.fillRect(left, top, width, height);

    // The leaf, sliding off to the side.
    const leaf = width * (1 - Math.min(1, Math.max(0, open)));
    if (leaf > 0) {
      ctx.fillStyle = frame;
      ctx.fillRect(left, top, leaf, height);
    }

    // The frame, and a lintel heavy enough to read at a glance.
    const weight = Math.max(3, width * 0.06);
    ctx.fillStyle = frame;
    ctx.fillRect(left - weight, top - weight, width + weight * 2, weight);
    ctx.fillRect(left - weight, top, weight, height);
    ctx.fillRect(left + width, top, weight, height);
  }

  /**
   * The wait, drawn as a ring that empties.
   *
   * The full track is always there, so a child can see how much is left rather
   * than only how much has gone. The wait cannot be skipped, and a wait with no
   * visible end is the kind of thing a six-year-old gives up on.
   */
  function countdown(ctx, x, y, r, fraction, track, sweep, weight) {
    ctx.lineWidth = weight;
    ctx.strokeStyle = track;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();

    if (fraction <= 0) return;
    ctx.strokeStyle = sweep;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.min(1, fraction) * TAU);
    ctx.stroke();
  }

  /** A crystal. Two triangles, which is the whole of it. */
  function crystal(ctx, x, y, r, fill, facet) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.62, y + r * 0.5);
    ctx.lineTo(x - r * 0.62, y + r * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = facet;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.62, y + r * 0.5);
    ctx.lineTo(x, y + r * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Peripheral debris for the distractor condition.
   *
   * Deliberately dull: a plain quadrilateral in a colour close to the ground.
   * It has to be noticeable without being more interesting than the stimulus,
   * or it stops being a distractor and becomes the task.
   */
  function debris(ctx, x, y, r, rotation, fill) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-r, -r * 0.42);
    ctx.lineTo(r * 0.7, -r * 0.7);
    ctx.lineTo(r, r * 0.5);
    ctx.lineTo(-r * 0.6, r * 0.66);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * The horizon. One flat line at the vertical centre of the play area, which
   * is the same datum the adult screens rule their content against.
   */
  function horizon(ctx, width, y, stroke, weight) {
    ctx.fillStyle = stroke;
    ctx.fillRect(0, y - weight / 2, width, weight);
  }

  /** A tick on the horizon. Position in the session, same mark on both surfaces. */
  function tick(ctx, x, y, height, weight, fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x - weight / 2, y - height, weight, height);
  }

  return {
    craft,
    rock,
    beacon,
    marker,
    zone,
    door,
    countdown,
    crystal,
    debris,
    horizon,
    tick,
  };
});
