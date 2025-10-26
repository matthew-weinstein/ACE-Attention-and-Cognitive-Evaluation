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

  // Head Orientation Data Summary with Fidgeting Analysis
  if (data.headOrientationData && data.headOrientationData.length > 0) {
    // Analyze head fidgeting
    const visualizer = new HeadFidgetVisualizer();
    const analysis = visualizer.analyze(data.headOrientationData);
    
    if (!analysis.error && analysis.groups) {
      // Overall summary
      html += `
        <div class="card">
          <h2>🎯 Overall Head Fidgeting Summary</h2>
          <div class="metrics-grid">
            <div class="metric-item">
              <div class="metric-label">Average Fidget Score</div>
              <div class="metric-value">${analysis.overallSummary.averageFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Peak Fidget Score</div>
              <div class="metric-value">${analysis.overallSummary.peakFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Total Movement Events</div>
              <div class="metric-value">${analysis.overallSummary.totalMovementEvents}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Events/Minute</div>
              <div class="metric-value">${analysis.overallSummary.movementEventsPerMinute.toFixed(1)}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Total Duration</div>
              <div class="metric-value">${analysis.overallSummary.totalDurationSeconds.toFixed(1)}<span class="metric-unit">s</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Cycles × Phases</div>
              <div class="metric-value">${analysis.groupCount}</div>
            </div>
          </div>
        </div>
      `;
      
      // Comparison chart
      html += `
        <div class="card">
          <h2>📊 Fidget Score Comparison by Cycle & Phase</h2>
          <div class="chart-container">
            <canvas id="comparisonChart"></canvas>
          </div>
        </div>
      `;
      
      // Detailed fidget score timeline
      html += `
        <div class="card">
          <h2>📈 Fidgeting Timeline (All Cycles & Phases)</h2>
          <div class="chart-container">
            <canvas id="fidgetScoreChart"></canvas>
          </div>
          <p style="margin-top: 15px; color: rgba(255,255,255,0.6); font-size: 14px;">
            <strong>Note:</strong> Each line represents a different cycle and phase combination. 
            Phase 1 = Visual Search (tracking stars), Phase 2 = Fixation (staying still).
          </p>
        </div>
      `;
      
      // Per-group details
      html += `
        <div class="card">
          <h2>📋 Detailed Analysis by Cycle & Phase</h2>
      `;
      
      // Sort and display each group
      const sortedKeys = Object.keys(analysis.groups).sort((a, b) => {
        const [cycleA, phaseA] = a.match(/\d+/g).map(Number);
        const [cycleB, phaseB] = b.match(/\d+/g).map(Number);
        if (cycleA !== cycleB) return cycleA - cycleB;
        return phaseA - phaseB;
      });
      
      sortedKeys.forEach(key => {
        const group = analysis.groups[key];
        const phaseLabel = group.phase === 1 ? 'Visual Search' : 'Fixation Task';
        const phaseBadge = group.phase === 1 ? 'phase-1' : 'phase-2';
        const cycleBadge = `cycle-${group.cycle}`;
        
        html += `
          <div style="margin-bottom: 20px; padding: 15px; background: rgba(255,255,255,0.03); border-radius: 8px;">
            <h3 style="color: #818cf8; margin-bottom: 10px;">
              <span class="${cycleBadge}">Cycle ${group.cycle}</span>
              <span class="${phaseBadge}">Phase ${group.phase} - ${phaseLabel}</span>
            </h3>
            <div class="metrics-grid">
              <div class="metric-item">
                <div class="metric-label">Avg Fidget Score</div>
                <div class="metric-value">${group.summary.averageFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Peak Score</div>
                <div class="metric-value">${group.summary.peakFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Movement Events</div>
                <div class="metric-value">${group.summary.totalMovementEvents}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Events/Min</div>
                <div class="metric-value">${group.summary.movementEventsPerMinute.toFixed(1)}</div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Stillness %</div>
                <div class="metric-value">${group.summary.stillnessPercentage.toFixed(1)}<span class="metric-unit">%</span></div>
              </div>
              <div class="metric-item">
                <div class="metric-label">Duration</div>
                <div class="metric-value">${group.summary.totalDurationSeconds.toFixed(1)}<span class="metric-unit">s</span></div>
              </div>
            </div>
          </div>
        `;
      });
      
      html += `
        </div>
      `;
      
      // Head angles chart
      html += `
        <div class="card">
          <h2>📐 Head Orientation Angles (All Cycles & Phases)</h2>
          <div class="chart-container">
            <canvas id="headAnglesChart"></canvas>
          </div>
          <p style="margin-top: 15px; color: rgba(255,255,255,0.6); font-size: 14px;">
            <strong>Legend:</strong> Solid lines = Phase 1 (Visual Search), Dashed lines = Phase 2 (Fixation). 
            Red = Pitch (up/down), Green = Yaw (left/right), Yellow = Roll (tilt).
          </p>
        </div>
      `;
      
      // Store analysis for chart creation
      window.headFidgetAnalysis = analysis;
    } else {
      html += `
        <div class="card">
          <h2>🎯 Head Orientation Analysis</h2>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="value">${data.totalHeadOrientationEvents}</div>
              <div class="label">Total Data Points</div>
            </div>
          </div>
          <p style="margin-top: 20px; color: rgba(255,255,255,0.6); font-style: italic;">
            Note: Head orientation tracking measures head stability during fixation tasks.
          </p>
        </div>
      `;
    }
  }

  contentDiv.innerHTML = html;
  
  // Create charts after DOM is updated
  setTimeout(() => {
    createCharts();
  }, 100);
}

// Create Chart.js visualizations
function createCharts() {
  if (!window.headFidgetAnalysis) return;
  
  const visualizer = new HeadFidgetVisualizer();
  const analysis = window.headFidgetAnalysis;
  
  // Create comparison bar chart
  const comparisonCanvas = document.getElementById('comparisonChart');
  if (comparisonCanvas) {
    const comparisonConfig = visualizer.createComparisonChart(analysis);
    if (comparisonConfig) {
      new Chart(comparisonCanvas, comparisonConfig);
    }
  }
  
  // Create fidget score timeline chart
  const fidgetCanvas = document.getElementById('fidgetScoreChart');
  if (fidgetCanvas) {
    const fidgetConfig = visualizer.createFidgetScoreChart(analysis);
    if (fidgetConfig) {
      new Chart(fidgetCanvas, fidgetConfig);
    }
  }
  
  // Create head angles chart
  const anglesCanvas = document.getElementById('headAnglesChart');
  if (anglesCanvas) {
    const anglesConfig = visualizer.createHeadAnglesChart(analysis);
    if (anglesConfig) {
      new Chart(anglesCanvas, anglesConfig);
    }
  }
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

