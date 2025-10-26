// Results page JavaScript
// Your friend can edit this file without affecting the main game

// Load data from localStorage
function loadAssessmentData() {
  const dataStr = localStorage.getItem("aceAssessmentData");
  if (!dataStr) {
    return null;
  }
  return JSON.parse(dataStr);
}

// Display the assessment data
function displayResults() {
  const data = loadAssessmentData();
  const contentDiv = document.getElementById("content");

  if (!data) {
    contentDiv.innerHTML = `
      <div class="no-data">
        <h2>No assessment data found</h2>
        <p>Please complete the assessment first.</p>
      </div>
    `;
    return;
  }

  // Build the results HTML
  let html = "";

  // Summary Statistics Card
  html += `
    <div class="card">
      <h2>📈 Summary Statistics</h2>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="value">${data.cyclesCompleted}</div>
          <div class="label">Cycles Completed</div>
        </div>
        <div class="stat-box">
          <div class="value">${data.totalBlinks || 0}</div>
          <div class="label">Total Blinks</div>
        </div>
        <div class="stat-box">
          <div class="value">${data.totalGazeEvents || 0}</div>
          <div class="label">Gaze Events</div>
        </div>
        <div class="stat-box">
          <div class="value">${data.totalHeadOrientationEvents || 0}</div>
          <div class="label">Head Movements</div>
        </div>
      </div>
    </div>
  `;

  // Session Information Card
  html += `
    <div class="card">
      <h2>ℹ️ Session Information</h2>
      <table class="data-table">
        <tr>
          <th>Session ID</th>
          <td>${data.sessionId || "N/A"}</td>
        </tr>
        <tr>
          <th>Completed At</th>
          <td>${new Date(data.completedAt).toLocaleString()}</td>
        </tr>
        <tr>
          <th>Total Duration</th>
          <td>${calculateTotalDuration(data)}</td>
        </tr>
      </table>
    </div>
  `;

  // Blink Data by Phase Card
  if (data.blinkData && data.blinkData.length > 0) {
    const phase1Blinks = data.blinkData.filter((b) => b.phase === 1);
    const phase2Blinks = data.blinkData.filter((b) => b.phase === 2);

    html += `
      <div class="card">
        <h2>👁️ Blink Analysis</h2>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="value">${phase1Blinks.length}</div>
            <div class="label">Phase 1 Blinks (Visual Search)</div>
          </div>
          <div class="stat-box">
            <div class="value">${phase2Blinks.length}</div>
            <div class="label">Phase 2 Blinks (Fixation)</div>
          </div>
          <div class="stat-box">
            <div class="value">${calculateBlinkRate(data)}</div>
            <div class="label">Avg Blinks/Minute</div>
          </div>
        </div>
      </div>
    `;

    // Detailed Blink Data Table
    html += `
      <div class="card">
        <h2>📋 Detailed Blink Data</h2>
        <table class="data-table">
          <thead>
            <tr>
              <th>Cycle</th>
              <th>Phase</th>
              <th>Blink #</th>
              <th>Timestamp (ms)</th>
            </tr>
          </thead>
          <tbody>
    `;

    data.blinkData.slice(0, 50).forEach((blink) => {
      html += `
        <tr>
          <td><span class="cycle-badge cycle-${blink.cycle}">Cycle ${
        blink.cycle
      }</span></td>
          <td><span class="phase-badge phase-${blink.phase}">Phase ${
        blink.phase
      }</span></td>
          <td>${blink.blink_number || "N/A"}</td>
          <td>${blink.relative_time_ms || blink.timestamp || "N/A"}</td>
        </tr>
      `;
    });

    if (data.blinkData.length > 50) {
      html += `
        <tr>
          <td colspan="4" style="text-align: center; color: rgba(255,255,255,0.5);">
            ... and ${data.blinkData.length - 50} more entries
          </td>
        </tr>
      `;
    }

    html += `
          </tbody>
        </table>
      </div>
    `;
  }

  // Gaze Data Summary
  if (data.gazeData && data.gazeData.length > 0) {
    html += `
      <div class="card">
        <h2>👀 Gaze Tracking Summary</h2>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="value">${
              data.gazeData.filter((g) => g.type === "star_spawn").length
            }</div>
            <div class="label">Stars Spawned</div>
          </div>
          <div class="stat-box">
            <div class="value">${
              data.gazeData.filter((g) => g.type === "distractor_spawn").length
            }</div>
            <div class="label">Distractors Spawned</div>
          </div>
        </div>
      </div>
    `;
  }

  // Head Orientation Data Summary
  if (data.headOrientationData && data.headOrientationData.length > 0) {
    html += `
      <div class="card">
        <h2>🎯 Head Orientation Analysis</h2>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="value">${data.totalHeadOrientationEvents}</div>
            <div class="label">Total Data Points</div>
          </div>
          <div class="stat-box">
            <div class="value">${
              data.headOrientationData.filter((h) => h.phase === 2).length
            }</div>
            <div class="label">Phase 2 Measurements</div>
          </div>
        </div>
        <p style="margin-top: 20px; color: rgba(255,255,255,0.6); font-style: italic;">
          Note: Head orientation tracking measures head stability during fixation tasks.
        </p>
      </div>
    `;
  }

  contentDiv.innerHTML = html;
}

// Calculate total duration
function calculateTotalDuration(data) {
  // Each cycle has 2 phases of 30s and 15s each = 45s per cycle
  // Plus instruction screens (10s each = 20s per cycle)
  const totalSeconds = data.cyclesCompleted * 65; // Approximate
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `~${minutes}m ${seconds}s`;
}

// Calculate blink rate
function calculateBlinkRate(data) {
  if (!data.blinkData || data.blinkData.length === 0) return 0;
  const totalSeconds = data.cyclesCompleted * 65;
  const totalMinutes = totalSeconds / 60;
  return (data.blinkData.length / totalMinutes).toFixed(1);
}

// Export data as JSON
function exportData() {
  const data = loadAssessmentData();
  if (!data) {
    alert("No data to export");
    return;
  }

  const dataStr = JSON.stringify(data, null, 2);
  const dataBlob = new Blob([dataStr], { type: "application/json" });
  const url = URL.createObjectURL(dataBlob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ace_assessment_${new Date()
    .toISOString()
    .slice(0, 19)
    .replace(/:/g, "-")}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// Load results on page load
window.addEventListener("DOMContentLoaded", displayResults);

