/**
 * Pieces every game needs, defined once.
 *
 * The per-trial record shape is here rather than in each game, because
 * docs/assessment-design.md 2.8 specifies one log format for every trial in
 * every task and four separate near-copies would drift apart.
 */

const AceGame = (function () {
  /** Fields written for every trial in every game. 2.8. */
  function record(base) {
    return {
      game: base.game,
      trial_index: base.trial_index,
      condition: base.condition,
      t_onset: base.t_onset === null ? null : round2(base.t_onset),
      t_response: base.t_response === null ? null : round2(base.t_response),
      rt: base.rt === null ? null : Math.round(base.rt),
      response_key: base.response_key || null,
      correct: base.correct,
      validity_flag: base.validity_flag,
      validity_reason: base.validity_reason || null,
      refresh_interval_measured: round3(base.refresh_interval_measured),
      frames_dropped: base.frames_dropped || 0,
      tracker_confidence: base.tracker_confidence === undefined ? null : base.tracker_confidence,
      face_present: base.face_present === undefined ? null : base.face_present,
    };
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const round3 = (v) => Math.round(v * 1000) / 1000;

  /** Anticipatory floor. Raised to 150 ms, see assessment-design 2.8. */
  const ANTICIPATORY_MS = 150;

  /**
   * Judge a response against the timing rules that are identical everywhere.
   * Returns a validity flag and, when invalid, the reason by name.
   */
  function judge(rt, quality, capture) {
    if (capture.lostFocus()) {
      return { valid: false, reason: "window focus lost during the trial" };
    }
    if (quality.framesDropped > 0) {
      return { valid: false, reason: "frames dropped before stimulus onset" };
    }
    if (quality.stalled) {
      return { valid: false, reason: "the renderer stalled during the trial" };
    }
    if (rt !== null && rt < ANTICIPATORY_MS) {
      return { valid: false, reason: "response before 150 ms, anticipatory" };
    }
    if (capture.bounced() > 0 && rt === null) {
      return { valid: false, reason: "key bounce or repeat" };
    }
    return { valid: true, reason: null };
  }

  /**
   * Mount the scope surface for a game.
   *
   * The rule drops from the header position to the vertical centre, where it
   * becomes the horizon. That drop is the one piece of motion in the app that
   * nobody asked for, and it earns its place by marking the handover: the
   * screen stops being something an adult reads and becomes something the
   * child plays on.
   */
  function mountStage(accent, options) {
    const opts = options || {};
    const { root } = AceUI.surface("scope", accent);
    root.classList.add("stage-screen");

    const host = AceUI.el("div", "stage-host");
    root.appendChild(host);

    const stage = AceStage.createStage(host, { ground: readToken("--scope") });

    const geo = window.aceStageGeometry;
    if (geo) stage.calibrate(geo.geometry, geo.viewingDistanceCm);

    const onResize = () => {
      stage.resize();
      if (window.aceDriver) window.aceDriver.invalidate();
    };
    window.addEventListener("resize", onResize);

    let progress = null;
    if (opts.progressMarks) {
      progress = AceUI.watchProgress(root, opts.progressMarks);
    }

    return {
      stage,
      host,
      root,
      progress,
      destroy() {
        window.removeEventListener("resize", onResize);
        stage.destroy();
      },
    };
  }

  function readToken(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  /** Parse a hex token once, so the draw loop never parses a string. */
  function rgb(hex) {
    const v = parseInt(hex.replace("#", ""), 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
  }

  /**
   * Blend a colour toward the background by a contrast fraction.
   * `c` of 1 is full contrast, 0 is invisible. This is the quantity the
   * Signal Watch staircase moves.
   */
  function atContrast(fg, bg, c) {
    const r = Math.round(bg.r + (fg.r - bg.r) * c);
    const g = Math.round(bg.g + (fg.g - bg.g) * c);
    const b = Math.round(bg.b + (fg.b - bg.b) * c);
    return `rgb(${r},${g},${b})`;
  }

  /**
   * A soft tick. Practice only.
   *
   * Feedback exists in practice because the child has to learn the mapping,
   * and practice trials are never scored. It does not exist in a scored
   * block, in any game, for the reason in assessment-design 1.3.
   *
   * No auditory stimulus carries a measurement (2.4), so the latency of this
   * does not matter and it is not timed.
   */
  function createTick() {
    let audio = null;
    return function tick() {
      try {
        if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
        const now = audio.currentTime;
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = "sine";
        osc.frequency.value = 660;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.08, now + 0.008);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
        osc.connect(gain).connect(audio.destination);
        osc.start(now);
        osc.stop(now + 0.12);
      } catch {
        // A machine with no audio device still runs the assessment. Practice
        // feedback is a convenience and is never the only channel: the
        // demonstration screen carries the mapping as well.
      }
    };
  }

  return {
    record,
    judge,
    mountStage,
    readToken,
    rgb,
    atContrast,
    createTick,
    ANTICIPATORY_MS,
  };
})();
