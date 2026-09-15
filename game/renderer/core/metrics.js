/**
 * Derived metrics.
 *
 * Scope, stated so nothing here is mistaken for more than it is. These are the
 * closed-form quantities from docs/assessment-design.md: rates, dispersion,
 * signal-detection indices, the within-child contrasts, and EZ-diffusion.
 * They are computed on the machine so the session file carries a summary
 * alongside the per-trial log.
 *
 * The ex-Gaussian parameters below use the method of moments. The design
 * specifies a maximum-likelihood fit, and a maximum-likelihood fit is a
 * different and better estimator, particularly for tau at the trial counts
 * this battery runs. What is here is a moment estimator, labelled as one in
 * the output, and it is an interim value for the session file rather than a
 * number for a report. Fitting belongs in the analysis layer with the
 * reference data, not in the renderer.
 *
 * Every function takes the trial records the games emit and returns plain
 * numbers. Nothing here touches the DOM, so it is testable without one.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AceMetrics = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

  function variance(a) {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1);
  }

  const sd = (a) => Math.sqrt(variance(a));

  function median(a) {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function skewness(a) {
    if (a.length < 3) return NaN;
    const m = mean(a);
    const s = sd(a);
    if (!(s > 0)) return NaN;
    const n = a.length;
    const sum = a.reduce((acc, v) => acc + Math.pow((v - m) / s, 3), 0);
    return (n / ((n - 1) * (n - 2))) * sum;
  }

  /** Inverse standard normal. Acklam's rational approximation. */
  function probit(p) {
    if (p <= 0 || p >= 1) return NaN;
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416];
    const plow = 0.02425;
    let q;
    let r;
    if (p < plow) {
      q = Math.sqrt(-2 * Math.log(p));
      return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > 1 - plow) {
      q = Math.sqrt(-2 * Math.log(1 - p));
      return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
        ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /**
   * Log-linear correction: add 0.5 to each cell. Perfect performance is
   * common in children and stays finite this way, where the uncorrected
   * z(1) is infinite and the trial is simply lost.
   */
  function logLinearRate(hits, total) {
    return (hits + 0.5) / (total + 1);
  }

  function signalDetection(hits, targets, falseAlarms, blanks) {
    if (!targets || !blanks) {
      return { d_prime: null, criterion_c: null, note: "no blank trials presented" };
    }
    const H = logLinearRate(hits, targets);
    const F = logLinearRate(falseAlarms, blanks);
    const zH = probit(H);
    const zF = probit(F);
    return {
      hit_rate: round(H, 4),
      false_alarm_rate: round(F, 4),
      d_prime: round(zH - zF, 3),
      criterion_c: round(-0.5 * (zH + zF), 3),
    };
  }

  /**
   * EZ-diffusion. Wagenmakers, van der Maas and Grasman.
   *
   * Both degenerate cases named rather than returned as a number. Pc of 1
   * makes the logit infinite, and Pc at or below 0.5 means the child was at
   * or below chance, where the model's drift rate is not interpretable.
   */
  function ezDiffusion(rtsSeconds, pc) {
    if (pc >= 1) {
      return { error: "accuracy was perfect, so drift rate is not estimable" };
    }
    if (pc <= 0.5) {
      return { error: "accuracy was at or below chance, so drift rate is not interpretable" };
    }
    const vrt = variance(rtsSeconds);
    const mrt = mean(rtsSeconds);
    if (!(vrt > 0)) return { error: "no variance in reaction time" };

    const s = 0.1;
    const s2 = s * s;
    const L = Math.log(pc / (1 - pc));
    const x = (L * (L * pc * pc - L * pc + pc - 0.5)) / vrt;
    const v = Math.sign(pc - 0.5) * s * Math.pow(x, 0.25);
    const a = (s2 * L) / v;
    const y = (-v * a) / s2;
    const mdt = (a / (2 * v)) * ((1 - Math.exp(y)) / (1 + Math.exp(y)));
    return {
      drift_rate_v: round(v, 4),
      boundary_separation_a: round(a, 4),
      non_decision_time_ter_s: round(mrt - mdt, 4),
      ter_note: "absolute latency, carries the machine's hardware lag, within-app comparison only",
    };
  }

  /**
   * Ex-Gaussian by the method of moments.
   *
   * Labelled in the output. See the header: the design specifies maximum
   * likelihood and this is not that.
   */
  function exGaussianMoments(rts) {
    const g = skewness(rts);
    const s = sd(rts);
    const m = mean(rts);
    if (!(g > 0) || !(s > 0)) {
      return { estimator: "moments", error: "distribution is not right-skewed, tau is not estimable" };
    }
    const tau = s * Math.pow(g / 2, 1 / 3);
    const sigma2 = s * s - tau * tau;
    return {
      estimator: "moments",
      tau_ms: round(tau, 1),
      sigma_ms: sigma2 > 0 ? round(Math.sqrt(sigma2), 1) : null,
      mu_ms: round(m - tau, 1),
      mu_note: "absolute latency, internal only",
    };
  }

  const round = (v, dp) => {
    if (!Number.isFinite(v)) return null;
    const f = Math.pow(10, dp);
    return Math.round(v * f) / f;
  };

  // ── Per-game summaries ────────────────────────────────────────────────────

  const isScored = (r) => r.valid && r.trial.block >= 0;

  function signalWatch(records, context) {
    const scored = records.filter(isScored);
    const targets = scored.filter((r) => !r.trial.blank);
    const blanks = scored.filter((r) => r.trial.blank);

    const correctRts = targets
      .filter((r) => r.correct && r.rt !== null)
      .map((r) => r.rt);

    const hits = targets.filter((r) => r.correct).length;
    const falseAlarms = blanks.filter((r) => !r.correct).length;

    const fast = targets.filter((r) => r.trial.isi === 1500 && r.correct && r.rt !== null);
    const slow = targets.filter((r) => r.trial.isi === 3000 && r.correct && r.rt !== null);
    const blockOne = targets.filter((r) => r.trial.block === 0 && r.correct && r.rt !== null);
    const blockTwo = targets.filter((r) => r.trial.block === 1 && r.correct && r.rt !== null);

    const omitIn = (set) => {
      const t = set.filter((r) => !r.trial.blank);
      return t.length ? t.filter((r) => r.rt === null).length / t.length : null;
    };

    const med = median(correctRts);
    const lapses = correctRts.filter((v) => v > 2.5 * med).length;

    // A common censor before differencing the two ISI blocks, because the
    // fast block's window is truncated by the next stimulus. Without this the
    // contrast compares two differently truncated distributions.
    const censor = Math.min(
      ...scored.map((r) => r.effective_window_ms).filter(Number.isFinite),
    );
    const censored = (set) => set.filter((r) => r.rt <= censor).map((r) => r.rt);

    return {
      valid_trials: scored.length,
      presented_trials: records.length,
      valid_fraction: round(scored.length / records.length, 3),
      omission_rate: round(targets.filter((r) => r.rt === null).length / targets.length, 3),
      accuracy: round(hits / targets.length, 3),
      sdrt_ms: round(sd(correctRts), 1),
      cv: round(sd(correctRts) / mean(correctRts), 3),
      cv_note: "denominator carries the machine's hardware lag, within-child comparison only",
      lapse_rate: round(lapses / correctRts.length, 3),
      ex_gaussian: exGaussianMoments(correctRts),
      signal_detection: signalDetection(hits, targets.length, falseAlarms, blanks.length),
      ez_diffusion: ezDiffusion(correctRts.map((v) => v / 1000), hits / targets.length),
      common_censor_ms: censor,
      isi_modulation_rt_ms: round(mean(censored(slow)) - mean(censored(fast)), 1),
      isi_modulation_omissions_pp: round((omitIn(slow.length ? slow : []) - omitIn(fast)) * 100, 1),
      block_change_rt_ms: round(mean(censored(blockTwo)) - mean(censored(blockOne)), 1),
      distractor_cost_pp: round(
        (omitIn(targets.filter((r) => r.trial.distractor)) -
          omitIn(targets.filter((r) => !r.trial.distractor))) * 100,
        1,
      ),
      contrast_threshold: context.staircase
        ? {
            converged: context.staircase.converged,
            contrast: round(context.staircase.contrast, 4),
            reversals: context.staircase.reversals,
          }
        : null,
      isi_order: context.slowFirst ? "slow block first" : "fast block first",
      invalidation: signalWatchInvalidation(records, scored, targets, context),
    };
  }

  function signalWatchInvalidation(records, scored, targets, context) {
    const reasons = [];
    if (scored.length / records.length < 0.6) {
      reasons.push("fewer than 60 percent of presented trials were valid");
    }
    const acc = targets.filter((r) => r.correct).length / targets.length;
    if (acc <= 0.55) reasons.push("accuracy at or below 55 percent, consistent with guessing");
    const anticipatory = records.filter(
      (r) => r.reason && r.reason.indexOf("anticipatory") >= 0,
    ).length;
    if (anticipatory / records.length > 0.2) {
      reasons.push("more than 20 percent anticipatory responses, consistent with rhythmic responding");
    }
    const omit = targets.filter((r) => r.rt === null).length / targets.length;
    if (omit > 0.5) reasons.push("more than half of targets drew no response");
    if (context.staircase && !context.staircase.converged) {
      reasons.push("the contrast staircase did not converge in 24 trials");
    }
    return reasons;
  }

  function asteroidRun(records) {
    const scored = records.filter((r) => r.valid);
    const go = scored.filter((r) => r.trial.kind === "go");
    const nogo = scored.filter((r) => r.trial.kind === "nogo");
    const hits = go.filter((r) => r.rt !== null).length;
    const commissions = nogo.filter((r) => r.rt !== null).length;
    const rts = go.filter((r) => r.rt !== null).map((r) => r.rt);
    const p = nogo.length ? commissions / nogo.length : NaN;

    const reasons = [];
    if (p > 0.9) reasons.push("a response on more than 90 percent of no-go trials, consistent with pressing on every trial");
    if (go.length && (go.length - hits) / go.length > 0.4) {
      reasons.push("more than 40 percent of go trials drew no response");
    }
    if (nogo.length < 60) reasons.push("fewer than 60 valid no-go trials");

    return {
      valid_trials: scored.length,
      presented_trials: records.length,
      commission_rate: round(p, 3),
      commission_se_pp: round(Math.sqrt((p * (1 - p)) / (nogo.length || 1)) * 100, 1),
      omission_rate: round(go.length ? (go.length - hits) / go.length : NaN, 3),
      sdrt_ms: round(sd(rts), 1),
      ex_gaussian: exGaussianMoments(rts),
      signal_detection: signalDetection(hits, go.length, commissions, nogo.length),
      burst_responses: records.reduce((n, r) => n + Math.max(0, r.presses - 1), 0),
      burst_note: "data quality flag, not a metric",
      invalidation: reasons,
    };
  }

  function beaconLine(sequences) {
    const forward = sequences.filter((s) => s.direction === "forward" && s.valid);
    const backward = sequences.filter((s) => s.direction === "backward" && s.valid);
    const spanOf = (set) =>
      set.filter((s) => s.correct).reduce((m, s) => Math.max(m, s.length), 0);
    const moves = sequences
      .filter((s) => s.correct)
      .flatMap((s) => s.gapsMs || []);

    const reasons = [];
    if (spanOf(forward) < 2) {
      reasons.push("forward span below 2, consistent with the task not being understood");
    }
    if (forward.length + backward.length < 4) reasons.push("fewer than 4 valid sequences");

    return {
      total_correct_backward: backward.filter((s) => s.correct).length,
      total_correct_backward_note: "primary score",
      total_correct_forward: forward.filter((s) => s.correct).length,
      span_forward: spanOf(forward),
      span_backward: spanOf(backward),
      backward_cost:
        forward.filter((s) => s.correct).length - backward.filter((s) => s.correct).length,
      median_movement_time_ms: round(median(moves), 0),
      movement_note: "motor covariate, not a metric",
      invalidation: reasons,
    };
  }

  function twoDoors(choices) {
    const valid = choices.filter((c) => c.valid);
    const quick = valid.filter((c) => c.choice === "small_immediate").length;
    const p = valid.length ? quick / valid.length : NaN;
    const firstHalf = valid.slice(0, Math.floor(valid.length / 2));
    const secondHalf = valid.slice(Math.floor(valid.length / 2));
    const rateOf = (set) =>
      set.length ? set.filter((c) => c.choice === "small_immediate").length / set.length : NaN;
    const latencies = valid.map((c) => c.latencyMs).filter(Number.isFinite);

    const reasons = [];
    if (valid.length < 15) reasons.push("fewer than 15 valid choices");
    const identical = valid.length > 0 && valid.every((c) => c.choice === valid[0].choice);
    if (identical && median(latencies) < 400) {
      reasons.push("the same door on every turn with a median choice latency under 400 ms, consistent with button-mashing");
    }

    return {
      delay_aversion_index: round(p, 3),
      se_pp: round(Math.sqrt((p * (1 - p)) / (valid.length || 1)) * 100, 1),
      se_note: "reported with the estimate on every session, the measure is imprecise at 20 trials",
      half_shift_pp: round((rateOf(secondHalf) - rateOf(firstHalf)) * 100, 1),
      median_choice_latency_ms: round(median(latencies), 0),
      latency_note: "descriptive only",
      valid_trials: valid.length,
      invalidation: reasons,
    };
  }

  function lookAway(records) {
    const scored = records.filter((r) => r.valid);
    const errors = scored.filter((r) => r.direction === "toward").length;
    const p = scored.length ? errors / scored.length : NaN;
    const reasons = [];
    if (scored.length < 25) reasons.push("fewer than 25 valid trials");
    return {
      direction_error_rate: round(p, 3),
      se_pp: round(Math.sqrt((p * (1 - p)) / (scored.length || 1)) * 100, 1),
      corrected_error_rate: round(
        scored.filter((r) => r.direction === "toward" && r.corrected).length /
          (errors || 1),
        3,
      ),
      unscorable_trial_rate: round(
        records.filter((r) => !r.valid).length / (records.length || 1),
        3,
      ),
      latency_note: "saccade latency is not measured and is not reported at 30 fps",
      invalidation: reasons,
    };
  }

  return {
    mean,
    sd,
    median,
    variance,
    skewness,
    probit,
    signalDetection,
    ezDiffusion,
    exGaussianMoments,
    signalWatch,
    asteroidRun,
    beaconLine,
    twoDoors,
    lookAway,
  };
});
