// ── Chart.js global dark-theme defaults ──────────────────────────────────────
Chart.defaults.color = "rgba(255,255,255,0.6)";
Chart.defaults.borderColor = "rgba(255,255,255,0.08)";
Chart.defaults.font.family = "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif";

const GRID = "rgba(255,255,255,0.07)";
const C_P1 = "#6366f1"; // indigo  — Phase 1
const C_P2 = "#8b5cf6"; // violet  — Phase 2
const C_GOOD = "#4ade80"; // green
const C_WARN = "#fbbf24"; // amber
const C_BAD = "#f87171"; // red

// Phase durations used in the game
const PHASE1_MS = 30000;
const PHASE2_MS = 15000;
const NORMAL_BLINK_MIN = 15;
const NORMAL_BLINK_MAX = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadData() {
  const s = localStorage.getItem("aceAssessmentData");
  return s ? JSON.parse(s) : null;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function blinkRateBadge(rate) {
  if (rate >= NORMAL_BLINK_MIN && rate <= NORMAL_BLINK_MAX)
    return { cls: "badge-normal", text: "Normal range" };
  if (rate < NORMAL_BLINK_MIN)
    return { cls: "badge-low", text: "Below normal" };
  return { cls: "badge-high", text: "Above normal" };
}

function focusBadge(pct) {
  if (pct >= 60) return { cls: "badge-normal", text: "Good attention" };
  if (pct >= 35) return { cls: "badge-low", text: "Moderate attention" };
  return { cls: "badge-high", text: "Low attention" };
}

function stabilityBadge(score) {
  if (score <= 25) return { cls: "badge-normal", text: "High stability" };
  if (score <= 55) return { cls: "badge-low", text: "Some movement" };
  return { cls: "badge-high", text: "High movement" };
}

function barPct(value, max) {
  return Math.min(100, (value / max) * 100).toFixed(1);
}

// Smooth an array with a simple moving average
function smooth(arr, w = 5) {
  return arr.map((_, i) => {
    const lo = Math.max(0, i - w);
    const hi = Math.min(arr.length, i + w + 1);
    const slice = arr.slice(lo, hi);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// ── Build the page ────────────────────────────────────────────────────────────

function displayResults() {
  const data = loadData();
  const contentDiv = document.getElementById("content");

  if (!data) {
    contentDiv.innerHTML = `<div class="no-data"><p>No assessment data found.</p><p style="font-size:14px;margin-top:8px">Complete the assessment first.</p></div>`;
    return;
  }

  // ── Derived metrics ─────────────────────────────────────────────────────────

  const cycles = data.cyclesCompleted || 1;
  const p1Blinks = (data.blinkData || []).filter((b) => b.phase === 1);
  const p2Blinks = (data.blinkData || []).filter((b) => b.phase === 2);
  const p1Min = (PHASE1_MS / 1000 / 60) * cycles;
  const p2Min = (PHASE2_MS / 1000 / 60) * cycles;
  const p1BlinkRate = p1Min > 0 ? p1Blinks.length / p1Min : 0;
  const p2BlinkRate = p2Min > 0 ? p2Blinks.length / p2Min : 0;
  const avgBlinkRate =
    p1Min + p2Min > 0
      ? (p1Blinks.length + p2Blinks.length) / (p1Min + p2Min)
      : 0;

  const proximityRows = (data.perSecondProximityData || []).filter(
    (r) => r.phase === 1,
  );
  const focusCount = proximityRows.filter((r) => r.withinProximity).length;
  const focusPct =
    proximityRows.length > 0
      ? Math.round((focusCount / proximityRows.length) * 100)
      : null;

  // Head movement — use HeadFidgetVisualizer if available
  let headAnalysis = null;
  let avgFidget = null;
  const headData = data.headOrientationData || [];
  if (headData.length > 0 && window.HeadFidgetVisualizer) {
    const viz = new HeadFidgetVisualizer();
    headAnalysis = viz.analyze(headData);
    if (!headAnalysis.error) {
      // Use Phase 2 fidget score as primary stability metric (fixation task)
      const p2Groups = Object.values(headAnalysis.groups || {}).filter(
        (g) => g.phase === 2,
      );
      if (p2Groups.length > 0) {
        const scores = p2Groups.flatMap((g) => g.fidgetScore);
        avgFidget = scores.reduce((a, b) => a + b, 0) / scores.length;
      } else {
        avgFidget = headAnalysis.overallSummary?.averageFidgetScore ?? null;
      }
    }
  }

  const sessionDate = data.completedAt
    ? new Date(data.completedAt).toLocaleString()
    : "Unknown";
  const totalDuration = fmtDuration((PHASE1_MS + PHASE2_MS) * cycles);

  document.getElementById("sessionMeta").textContent =
    `Completed ${sessionDate}  ·  ${cycles} cycle${cycles > 1 ? "s" : ""}  ·  ${totalDuration} total`;

  // ── Hero cards ──────────────────────────────────────────────────────────────

  function heroCard(icon, value, unit, label, badge) {
    const b = badge
      ? `<span class="metric-badge ${badge.cls}">${badge.text}</span>`
      : "";
    return `
      <div class="hero-card">
        <span class="metric-icon">${icon}</span>
        <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div>
        <div class="metric-label">${label}</div>
        ${b}
      </div>`;
  }

  const brBadge = blinkRateBadge(avgBlinkRate);
  const focusBadgeObj = focusPct !== null ? focusBadge(focusPct) : null;
  const stabBadge = avgFidget !== null ? stabilityBadge(avgFidget) : null;

  let heroHtml = `<div class="hero-grid">`;
  heroHtml += heroCard(
    "👁️",
    avgBlinkRate.toFixed(1),
    "/min",
    "Average Blink Rate",
    brBadge,
  );
  if (focusPct !== null)
    heroHtml += heroCard(
      "🎯",
      focusPct,
      "%",
      "Gaze Focus (Phase 1)",
      focusBadgeObj,
    );
  if (avgFidget !== null)
    heroHtml += heroCard(
      "🧠",
      avgFidget.toFixed(0),
      "/100",
      "Head Movement Index",
      stabBadge,
    );
  heroHtml += heroCard("⏱️", totalDuration, "", "Session Duration", null);
  heroHtml += `</div>`;

  // ── Blink section ───────────────────────────────────────────────────────────

  const p1BR = p1BlinkRate.toFixed(1);
  const p2BR = p2BlinkRate.toFixed(1);
  const maxBR = Math.max(p1BlinkRate, p2BlinkRate, NORMAL_BLINK_MAX) * 1.1;

  const blinkSection = `
    <div class="section">
      <div class="section-header">
        <div class="section-icon">👁️</div>
        <div>
          <h2>Blink Pattern</h2>
          <p>Blink rate per minute across task phases · Normal range ${NORMAL_BLINK_MIN}–${NORMAL_BLINK_MAX}/min</p>
        </div>
      </div>
      <div class="compare-row">
        <div class="compare-item">
          <label>Phase 1 - Visual Search</label>
          <span class="cval">${p1BR}</span><span class="cunit">/min</span>
          <div class="bar-track"><div class="bar-fill bar-phase1" style="width:${barPct(p1BlinkRate, maxBR)}%"></div></div>
          <div class="normal-band">${p1Blinks.length} blinks in ${fmtDuration(PHASE1_MS * cycles)}</div>
        </div>
        <div class="compare-item">
          <label>Phase 2 - Fixation</label>
          <span class="cval">${p2BR}</span><span class="cunit">/min</span>
          <div class="bar-track"><div class="bar-fill bar-phase2" style="width:${barPct(p2BlinkRate, maxBR)}%"></div></div>
          <div class="normal-band">${p2Blinks.length} blinks in ${fmtDuration(PHASE2_MS * cycles)}</div>
        </div>
      </div>
      <div class="chart-wrap">
        <canvas id="blinkChart"></canvas>
      </div>
      <div class="info-note">
        Blink rate typically decreases during cognitive tasks requiring sustained attention.
        A very low rate during fixation may indicate heightened focus; an unusually high rate
        can signal restlessness or distraction.
      </div>
    </div>`;

  // ── Gaze / attention section ─────────────────────────────────────────────────

  let gazeSection = "";
  if (proximityRows.length > 0) {
    gazeSection = `
      <div class="section">
        <div class="section-header">
          <div class="section-icon">🎯</div>
          <div>
            <h2>Gaze Attention - Phase 1</h2>
            <p>How closely gaze tracked the target star each second · threshold 200 px</p>
          </div>
        </div>
        <div class="two-col">
          <div>
            <div class="chart-wrap tall">
              <canvas id="gazeLineChart"></canvas>
            </div>
          </div>
          <div>
            <div class="chart-wrap tall donut-wrap" style="height:200px;margin-top:20px">
              <canvas id="gazeDonut"></canvas>
              <div class="donut-centre">
                <div class="dc-val">${focusPct}%</div>
                <div class="dc-label">on target</div>
              </div>
            </div>
          </div>
        </div>
        <div class="info-note">
          Gaze focus measures how often the user's eye position was within 200 px of the
          target star. Consistent tracking of moving targets tests selective attention and
          rapid attentional shifting.
        </div>
      </div>`;
  }

  // ── Head movement section ────────────────────────────────────────────────────

  let headSection = "";
  if (headAnalysis && !headAnalysis.error && headData.length > 0) {
    headSection = `
      <div class="section">
        <div class="section-header">
          <div class="section-icon">🧠</div>
          <div>
            <h2>Head Movement - Fixation Task</h2>
            <p>Angular velocity–based movement index over time (0 = still, 100 = maximum movement)</p>
          </div>
        </div>
        <div class="legend-row" id="headLegend"></div>
        <div class="chart-wrap tall">
          <canvas id="headChart"></canvas>
        </div>
        <div class="info-note">
          Involuntary head movement during the fixation task (Phase 2) is a behavioural marker
          for motor inhibition. Higher sustained movement indices may indicate difficulty
          maintaining stillness.
        </div>
      </div>`;
  }

  // ── Inject HTML then draw charts ─────────────────────────────────────────────

  contentDiv.innerHTML = heroHtml + blinkSection + gazeSection + headSection;

  setTimeout(() => {
    drawBlinkChart(data, p1Blinks, p2Blinks, p1BlinkRate, p2BlinkRate);
    if (proximityRows.length > 0)
      drawGazeCharts(proximityRows, focusPct, focusCount);
    if (headAnalysis && !headAnalysis.error) drawHeadChart(headAnalysis);
  }, 80);
}

// ── Chart: Blink rate bar ────────────────────────────────────────────────────

function drawBlinkChart(data, p1Blinks, p2Blinks, p1Rate, p2Rate) {
  const canvas = document.getElementById("blinkChart");
  if (!canvas) return;

  new Chart(canvas, {
    type: "bar",
    data: {
      labels: ["Phase 1 - Visual Search", "Phase 2 - Fixation"],
      datasets: [
        {
          label: "Blink rate (blinks/min)",
          data: [p1Rate, p2Rate],
          backgroundColor: [`${C_P1}99`, `${C_P2}99`],
          borderColor: [C_P1, C_P2],
          borderWidth: 2,
          borderRadius: 8,
        },
        {
          label: "Normal lower bound (15/min)",
          data: [NORMAL_BLINK_MIN, NORMAL_BLINK_MIN],
          type: "line",
          borderColor: `${C_GOOD}88`,
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
        {
          label: "Normal upper bound (20/min)",
          data: [NORMAL_BLINK_MAX, NORMAL_BLINK_MAX],
          type: "line",
          borderColor: `${C_GOOD}55`,
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: { boxWidth: 14, padding: 14 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) =>
              ` ${ctx.dataset.label}: ${
                typeof ctx.raw === "number" ? ctx.raw.toFixed(1) : ctx.raw
              } blinks/min`,
          },
        },
      },
      scales: {
        x: { grid: { color: GRID } },
        y: {
          beginAtZero: true,
          grid: { color: GRID },
          title: { display: true, text: "Blinks / minute" },
        },
      },
    },
  });
}

// ── Chart: Gaze focus line + donut ───────────────────────────────────────────

function drawGazeCharts(rows, focusPct, focusCount) {
  // Line chart — smoothed focus (1 = on target, 0 = off) over time
  const lineCanvas = document.getElementById("gazeLineChart");
  if (lineCanvas) {
    const raw = rows.map((r) => (r.withinProximity ? 1 : 0));
    const smoothed = smooth(raw, 3).map((v) => +(v * 100).toFixed(1));
    const labels = rows.map((r) => r.second);

    new Chart(lineCanvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Gaze on target (%)",
            data: smoothed,
            borderColor: C_P1,
            backgroundColor: `${C_P1}22`,
            borderWidth: 2,
            fill: true,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: ([ctx]) => `Second ${ctx.label}`,
              label: (ctx) => ` ${ctx.raw}% on target`,
            },
          },
        },
        scales: {
          x: {
            grid: { color: GRID },
            title: { display: true, text: "Time (seconds)" },
            ticks: { maxTicksLimit: 10 },
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: GRID },
            title: { display: true, text: "On target (%)" },
            ticks: { callback: (v) => `${v}%` },
          },
        },
      },
    });
  }

  // Donut
  const donutCanvas = document.getElementById("gazeDonut");
  if (donutCanvas) {
    const missed = rows.length - focusCount;
    new Chart(donutCanvas, {
      type: "doughnut",
      data: {
        labels: ["On target", "Off target"],
        datasets: [
          {
            data: [focusCount, missed],
            backgroundColor: [`${C_P1}cc`, "rgba(255,255,255,0.08)"],
            borderColor: [C_P1, "rgba(255,255,255,0.15)"],
            borderWidth: 2,
            hoverOffset: 4,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "70%",
        plugins: {
          legend: {
            position: "bottom",
            labels: { boxWidth: 12, padding: 12 },
          },
        },
      },
    });
  }
}

// ── Chart: Head movement (fidget score by phase) ──────────────────────────────

function drawHeadChart(analysis) {
  const canvas = document.getElementById("headChart");
  if (!canvas) return;

  const COLORS = {
    cycle1_phase1: { line: "#6366f1", fill: "#6366f111" },
    cycle1_phase2: { line: "#8b5cf6", fill: "#8b5cf611" },
    cycle2_phase1: { line: "#3b82f6", fill: "#3b82f611" },
    cycle2_phase2: { line: "#06b6d4", fill: "#06b6d411" },
  };

  const sortedKeys = Object.keys(analysis.groups).sort((a, b) => {
    const [ca, pa] = a.match(/\d+/g).map(Number);
    const [cb, pb] = b.match(/\d+/g).map(Number);
    return ca !== cb ? ca - cb : pa - pb;
  });

  const datasets = sortedKeys.map((key) => {
    const g = analysis.groups[key];
    const col = COLORS[key] || { line: "#818cf8", fill: "#818cf811" };
    const phaseLabel = g.phase === 1 ? "Visual Search" : "Fixation";
    return {
      label: `Cycle ${g.cycle} · Phase ${g.phase} (${phaseLabel})`,
      data: g.relativeTimeSeconds.map((t, i) => ({
        x: t,
        y: g.fidgetScore[i],
      })),
      borderColor: col.line,
      backgroundColor: col.fill,
      borderWidth: 2,
      fill: true,
      tension: 0.4,
      pointRadius: 0,
      pointHoverRadius: 4,
    };
  });

  // Build legend HTML
  const legendEl = document.getElementById("headLegend");
  if (legendEl) {
    legendEl.innerHTML = datasets
      .map(
        (ds) =>
          `<div class="legend-pill">
        <div class="legend-dot" style="background:${ds.borderColor}"></div>
        ${ds.label}
      </div>`,
      )
      .join("");
  }

  new Chart(canvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: "index",
          intersect: false,
          callbacks: {
            label: (ctx) =>
              ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}/100`,
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          grid: { color: GRID },
          title: { display: true, text: "Time from phase start (seconds)" },
          ticks: { maxTicksLimit: 10 },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: GRID },
          title: { display: true, text: "Movement index (0–100)" },
        },
      },
    },
  });
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportData() {
  const data = loadData();
  if (!data) {
    alert("No data to export");
    return;
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ace_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

window.addEventListener("DOMContentLoaded", displayResults);
