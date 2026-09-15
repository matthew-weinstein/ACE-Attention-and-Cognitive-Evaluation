/**
 * The clinician report.
 *
 * docs/assessment-design.md 6. A ledger surface at its densest: values sit on
 * the printed ruling, the way figures sit on a ruled record sheet.
 *
 * ── What this screen refuses to do ─────────────────────────────────────────
 *
 * Section 6.5 is a list of things the report never contains, and it is
 * enforced here structurally rather than by review. There is no element in
 * this file that can render a total score, a composite, a probability, a risk
 * level, or a red-amber-green coding, and nothing anywhere renders a
 * recommendation. The previous results page showed "Good attention" and "High
 * stability" badges and compared blink rate against an adult 15 to 20 per
 * minute band. Both are interpretive claims of exactly the kind 6.5 excludes,
 * and the blink band had a further problem: the underlying dopamine-proxy
 * premise is disputed, and Groen et al. found no blink-rate difference in 50
 * children aged 10 to 12, directly inside this age range. So blink rate is
 * shown as a raw count with no band and no label, or not at all.
 *
 * ── Intervals are drawn, not just printed ──────────────────────────────────
 *
 * The single most important presentation decision in the report. The precision
 * figures are sobering and the report must not hide them: the delay aversion
 * index has a standard error of 11.2 percentage points at twenty trials. A
 * printed number invites a reader to treat it as exact. A drawn interval does
 * not.
 *
 * ── On reference bands ─────────────────────────────────────────────────────
 *
 * There are none, and the report says so on every row rather than borrowing a
 * band from a non-gamified parent task. Gamification produces an additive
 * upward shift, so a borrowed norm would bias scores upward and systematically
 * under-identify. Reference data must come from this build, run as shipped.
 */

const AceReport = (function () {
  const VERDICT = {
    usable: "Usable",
    limited: "Usable with limits",
    unusable: "Not usable",
  };

  /**
   * Individual-level standard errors from the research, in the units of each
   * metric. These are the realistic figures, not the optimistic ones.
   */
  const KNOWN_SE = {
    d_prime: { se: 0.23, unit: "", note: "at any feasible session length" },
    commission_rate: { se: 0.053, unit: "", note: "at 90 no-go trials" },
    direction_error_rate: { se: 0.079, unit: "", note: "at 40 trials" },
    delay_aversion_index: { se: 0.112, unit: "", note: "at 20 trials" },
  };

  function el(tag, className, text) {
    return AceUI.el(tag, className, text);
  }

  function section(page, title) {
    const head = el("h2", "sheet-title", title);
    head.style.fontSize = "var(--t-sub)";
    head.style.marginTop = "var(--s6)";
    head.style.maxWidth = "32ch";
    page.appendChild(head);
    const block = el("div");
    block.style.maxWidth = "120ch";
    page.appendChild(block);
    return block;
  }

  function row(host, name, value, note, options) {
    const opts = options || {};
    const r = el("div", "row");
    if (opts.depth) r.dataset.depth = String(opts.depth);
    r.appendChild(el("div", "row-name", name));
    r.appendChild(
      el("div", "row-value", value === null || value === undefined ? "not computed" : String(value)),
    );
    r.appendChild(el("div", opts.bar ? "row-bar" : "row-note", note || ""));
    host.appendChild(r);
    return r;
  }

  /**
   * A value with its interval drawn to scale.
   *
   * The bar is the plausible range, the tick is the point estimate, and the
   * axis is the full range the metric can take. A reader sees the width before
   * they read the number, which is the intended reading order.
   */
  function intervalRow(host, spec) {
    const r = el("div", "row row-interval");
    r.appendChild(el("div", "row-name", spec.label));

    const printed =
      spec.value === null || !Number.isFinite(spec.value)
        ? "not computed"
        : spec.format(spec.value);
    r.appendChild(el("div", "row-value", printed));

    const cell = el("div");
    if (spec.value !== null && Number.isFinite(spec.value) && spec.se) {
      const lo = Math.max(spec.min, spec.value - 1.96 * spec.se);
      const hi = Math.min(spec.max, spec.value + 1.96 * spec.se);
      const pct = (v) => ((v - spec.min) / (spec.max - spec.min)) * 100;

      const track = el("div", "row-track");
      const range = el("div", "row-range");
      range.style.left = `${pct(lo)}%`;
      range.style.width = `${Math.max(0.4, pct(hi) - pct(lo))}%`;
      const point = el("div", "row-point");
      point.style.left = `${pct(spec.value)}%`;
      track.appendChild(range);
      track.appendChild(point);
      cell.appendChild(track);
      cell.appendChild(
        el(
          "div",
          "row-caption",
          `${spec.format(lo)} to ${spec.format(hi)}, no reference band yet`,
        ),
      );
    } else if (spec.value !== null && Number.isFinite(spec.value)) {
      cell.appendChild(
        el("div", "row-caption", "interval not estimated, no reference band yet"),
      );
    } else {
      cell.appendChild(el("div", "row-note", spec.missing || "this game did not run"));
    }

    r.appendChild(cell);
    host.appendChild(r);
  }

  // ── Page 1: session validity ──────────────────────────────────────────────

  function validityPage(page, session) {
    const games = session.games;
    const unusable = games.filter((g) => !g.ok);
    const limited = games.filter(
      (g) => g.ok && g.summary && g.summary.invalidation && g.summary.invalidation.length,
    );

    let verdict = "usable";
    if (unusable.length >= 2 || (games.length && unusable.length >= games.length / 2)) {
      verdict = "unusable";
    } else if (unusable.length || limited.length) {
      verdict = "limited";
    }

    const lead = el("p");
    lead.className = "read";
    lead.style.fontSize = "var(--t-lead)";
    lead.style.marginBottom = "var(--s4)";

    // The verdict names the cause in a specific sentence. Not "session
    // invalid" but which game stopped, after how many trials, and why.
    const causes = unusable
      .map((g) => `${g.label} did not produce data: ${g.reason}.`)
      .concat(
        limited.flatMap((g) =>
          g.summary.invalidation.map((r) => `${g.label}: ${r}.`),
        ),
      );

    lead.textContent =
      verdict === "usable"
        ? `${VERDICT.usable}. All ${games.length} games produced data within their validity rules.`
        : `${VERDICT[verdict]}. ${causes.join(" ")}`;
    page.appendChild(lead);

    const block = section(page, "Per game");
    for (const g of games) {
      const reasons = g.ok
        ? (g.summary && g.summary.invalidation) || []
        : [g.reason];
      row(
        block,
        g.label,
        g.ok && !reasons.length ? "Usable" : g.ok ? "Usable with limits" : "Not usable",
        reasons.join("; ") || "no validity rule was triggered",
      );
      if (g.summary && g.summary.valid_fraction !== undefined) {
        row(
          block,
          "valid trials",
          `${g.summary.valid_trials} of ${g.summary.presented_trials}`,
          bar(g.summary.valid_fraction),
          { depth: 1, bar: true },
        );
      }
    }

    const excl = section(page, "Why trials were excluded");
    const counts = session.exclusionCounts || {};
    const keys = Object.keys(counts);
    if (!keys.length) {
      row(excl, "No trials were excluded", "0", "");
    } else {
      for (const key of keys) row(excl, key, counts[key], "");
    }

    const timing = section(page, "Timing health");
    row(timing, "Measured refresh rate", `${session.timing.hz.toFixed(2)} Hz`,
      "measured from 120 consecutive frame intervals at session start");
    row(timing, "Frame interval", `${session.timing.intervalMs.toFixed(3)} ms`, "");
    row(timing, "Dropped frames, whole session", session.timing.framesDropped,
      "a trial with a dropped frame in the 100 ms before onset is excluded");
    row(timing, "Fixed logic step", `${session.timing.stepMs} ms`,
      "all trial timing runs on this grid, independent of the panel");

    const camera = section(page, "Camera and tracker");
    const cam = session.camera || {};
    row(camera, "Face detected", fraction(cam.facePresentFraction),
      cam.facePresentFraction === undefined ? "the passive layer did not report" : "");
    row(camera, "Mean tracker confidence", cam.meanConfidence === undefined ? null : cam.meanConfidence,
      "the tracker currently reports a constant, so this carries no information until that changes");
    row(camera, "Calibration residual", cam.residualDeg === undefined ? null : `${cam.residualDeg} deg`,
      "required before any antisaccade number can be reported");
    row(camera, "Tracking dropouts over 2 s", cam.dropouts === undefined ? null : cam.dropouts, "");

    const engagement = section(page, "Engagement");
    for (const g of games) {
      row(engagement, g.label,
        g.practiceAttempts === undefined ? "not recorded" : `${g.practiceAttempts} practice run${g.practiceAttempts === 1 ? "" : "s"}`,
        g.haltedEarly ? "stopped before the end" : "ran to the end");
    }
  }

  function bar(fraction) {
    if (!Number.isFinite(fraction)) return "";
    const filled = Math.round(fraction * 20);
    return "█".repeat(filled) + "░".repeat(20 - filled) + ` ${Math.round(fraction * 100)}%`;
  }

  function fraction(v) {
    return Number.isFinite(v) ? `${Math.round(v * 100)}%` : null;
  }

  // ── Page 2: core measures ─────────────────────────────────────────────────

  function measuresPage(page, session) {
    const block = section(page, "Core measures");
    const find = (id) => {
      const g = session.games.find((x) => x.id === id);
      return g && g.ok ? g.summary : null;
    };
    const sw = find("signal_watch");
    const ar = find("asteroid_run");
    const bl = find("beacon_line");
    const td = find("two_doors");
    const la = find("look_away");

    const ms = (v) => `${Math.round(v)} ms`;
    const pc = (v) => `${(v * 100).toFixed(1)}%`;
    const num = (v) => v.toFixed(2);

    intervalRow(block, {
      label: "Frequency of unusually slow responses",
      value: sw && sw.ex_gaussian ? sw.ex_gaussian.tau_ms : null,
      se: null,
      min: 0, max: 600, format: ms,
      missing: "Signal Watch did not produce a usable distribution",
    });
    intervalRow(block, {
      label: "Consistency of response speed",
      value: sw ? sw.sdrt_ms : null,
      se: sw && sw.sdrt_ms ? sw.sdrt_ms * 0.07 : null,
      min: 0, max: 400, format: ms,
      missing: "Signal Watch did not run",
    });
    intervalRow(block, {
      label: "Speed of information processing",
      value: sw && sw.ez_diffusion && sw.ez_diffusion.drift_rate_v !== undefined
        ? sw.ez_diffusion.drift_rate_v : null,
      se: null,
      min: 0, max: 0.4, format: num,
      missing: sw && sw.ez_diffusion ? sw.ez_diffusion.error : "Signal Watch did not run",
    });
    intervalRow(block, {
      label: "Missed signals",
      value: sw ? sw.omission_rate : null,
      se: null, min: 0, max: 1, format: pc,
      missing: "Signal Watch did not run",
    });
    intervalRow(block, {
      label: "Ability to tell signals from non-signals",
      value: sw && sw.signal_detection ? sw.signal_detection.d_prime : null,
      se: KNOWN_SE.d_prime.se, min: -1, max: 5, format: num,
      missing: "Signal Watch did not run",
    });
    intervalRow(block, {
      label: "Responses that should have been withheld",
      value: ar ? ar.commission_rate : null,
      se: KNOWN_SE.commission_rate.se, min: 0, max: 1, format: pc,
      missing: "Asteroid Run is not administered below age eight",
    });
    intervalRow(block, {
      label: "Holding and reordering a sequence",
      value: bl ? bl.total_correct_backward : null,
      se: null, min: 0, max: 16, format: (v) => String(v),
      missing: "Beacon Line did not run",
    });
    intervalRow(block, {
      label: "Looking at a light when asked to look away from it",
      value: la ? la.direction_error_rate : null,
      se: KNOWN_SE.direction_error_rate.se, min: 0, max: 1, format: pc,
      missing: lookAwayMissing(session),
    });
    intervalRow(block, {
      label: "Preference for a smaller immediate reward",
      value: td ? td.delay_aversion_index : null,
      se: KNOWN_SE.delay_aversion_index.se, min: 0, max: 1, format: pc,
      missing: "Two Doors did not run",
    });

    const note = el("p", "read");
    note.style.marginTop = "var(--s4)";
    note.textContent =
      "Absolute reaction times are not shown. The keyboard and display add 65 to 130 milliseconds that varies by machine, so an absolute latency from this session is not comparable with one from another. Every value above is an accuracy, a dispersion, or a within-child contrast, which the hardware offset cancels out of.";
    block.appendChild(note);
  }

  function lookAwayMissing(session) {
    const g = session.games.find((x) => x.id === "look_away");
    if (!g) return "Look Away was not in this battery";
    if (g.missing && g.missing.length) return g.missing[0];
    return g.reason || "Look Away did not run";
  }

  // ── Page 3: within-child contrasts ────────────────────────────────────────

  function contrastsPage(page, session) {
    const block = section(page, "Within-child contrasts");
    const intro = el("p", "read");
    intro.textContent =
      "These compare the child against themselves, so the machine's fixed keyboard and display lag cancels exactly. They are the values from this session that transfer most safely between machines.";
    intro.style.marginBottom = "var(--s4)";
    block.appendChild(intro);

    const find = (id) => {
      const g = session.games.find((x) => x.id === id);
      return g && g.ok ? g.summary : null;
    };
    const sw = find("signal_watch");
    const bl = find("beacon_line");
    const td = find("two_doors");

    row(block, "Slow pace against fast pace, speed",
      sw && Number.isFinite(sw.isi_modulation_rt_ms) ? `${sw.isi_modulation_rt_ms} ms` : null,
      "responses at a 3000 ms pace minus responses at a 1500 ms pace, against one common response window");
    row(block, "Slow pace against fast pace, misses",
      sw && Number.isFinite(sw.isi_modulation_omissions_pp) ? `${sw.isi_modulation_omissions_pp} pp` : null, "");
    row(block, "With distractors against without",
      sw && Number.isFinite(sw.distractor_cost_pp) ? `${sw.distractor_cost_pp} pp` : null,
      "missed signals in the last 30 trials of each block against the rest");
    row(block, "Second half against first half",
      sw && Number.isFinite(sw.block_change_rt_ms) ? `${sw.block_change_rt_ms} ms` : null, "");
    row(block, "Forward against backward span",
      bl ? bl.backward_cost : null, "sequences correct forward minus sequences correct backward");
    row(block, "Last ten turns against first ten",
      td && Number.isFinite(td.half_shift_pp) ? `${td.half_shift_pp} pp` : null,
      "change in preference for the quick door across the game");

    if (sw && sw.contrast_threshold) {
      const t = section(page, "Threshold");
      row(t, "Converged contrast",
        sw.contrast_threshold.converged ? sw.contrast_threshold.contrast : null,
        sw.contrast_threshold.converged
          ? `${sw.contrast_threshold.reversals} reversals in 24 staircase trials`
          : "the staircase did not converge in 24 trials, so no threshold is reported");
    }
  }

  // ── Page 4: what this report does not say ─────────────────────────────────

  const LIMITS = [
    "This report measures performance on computer games. It does not identify ADHD or any other condition, and it cannot.",
    "Performance on these measures differs on average between groups of children with and without an ADHD identification, and the distributions overlap heavily. Kofler et al. (2013) found that for response-time variability, the most replicated measure in this area, a cut-off placed at the edge of the typical range gives a positive predictive power of 45 percent. Roughly half the children such a cut-off flags would not have ADHD.",
    "These measures do not separate ADHD from autism. Townes et al. (2023) examined 45 measures across 24 tasks in children and adolescents and found no executive function differences between the two groups.",
    "Low scores are common in children with no attention difficulty. Cook et al. (2025) found that nearly two thirds of 1,269 typically developing children aged 7 to 17 scored at or below the 25th percentile on at least one of five cognitive measures.",
    "Performance measures and rating scales measure different things and do not agree closely. Olsen et al. (2024), in 139 children aged 6 to 13, found a correlation of -.10 between a computerised executive function battery and a parent behaviour rating scale. Disagreement between this report and a rating scale is expected and is not evidence that either is wrong.",
    "A single session measures one day. These measures vary within the same child across sessions by more than measurement error alone.",
    "No reference band is shown against any value on this report. Reference data have to come from this build, run exactly as shipped, because game elements shift scores upward and a band borrowed from a plain version of the same task would bias every score in the same direction.",
  ];

  function limitsPage(page) {
    const block = section(page, "What this report does not say");
    for (const line of LIMITS) {
      const p = el("p", "read", line);
      p.style.marginBottom = "var(--s4)";
      block.appendChild(p);
    }
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  function show(session) {
    const { root, page } = AceUI.sheet({
      step: `${session.participantId}, band ${session.band}`,
      title: "Session report",
      paragraphs: [],
      wide: true,
    });

    // The printed ruling appears only here. Every row is one ruling tall, so
    // the values sit on the lines the way figures sit on a record sheet.
    document.getElementById("app").classList.add("ruled");

    validityPage(page, session);
    measuresPage(page, session);
    contrastsPage(page, session);
    limitsPage(page);

    const actions = el("div", "sheet-actions");
    const where = el("p", "row-note", `Per-trial data: ${session.dir || "not written"}`);
    where.style.marginTop = "var(--s5)";
    page.appendChild(where);
    page.appendChild(actions);

    return root;
  }

  return { show, LIMITS };
})();
