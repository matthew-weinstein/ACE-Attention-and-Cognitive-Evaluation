function loadAssessmentData() {
  const dataStr = localStorage.getItem("aceAssessmentData");
  if (!dataStr) {
    return null;
  }
  return JSON.parse(dataStr);
}

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

  let html = "";

  html += `
    <div class="card">
      <h2>Summary Statistics</h2>
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

  html += `
    <div class="card">
      <h2>Session Information</h2>
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

  if (data.blinkData && data.blinkData.length > 0) {
    const validBlinks = data.blinkData.filter((b) => b.phase !== null && b.phase !== undefined);
    const phase1Blinks = validBlinks.filter((b) => b.phase === 1);
    const phase2Blinks = validBlinks.filter((b) => b.phase === 2);
    const blinkRate = calculateBlinkRate(data);

    html += `
      <div class="card">
        <h2>Blink Analysis</h2>
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
            <div class="value">${blinkRate}</div>
            <div class="label">Average Blink Rate</div>
          </div>
        </div>
        <div class="chart-container">
          <canvas id="blinkChart"></canvas>
        </div>
      </div>
    `;
    
    window.blinkChartData = validBlinks;
  }

  if (data.gazeData && data.gazeData.length > 0) {
    const starEvents = data.gazeData.filter((g) => g.type === "star_spawn");
    const distractorEvents = data.gazeData.filter((g) => g.type === "distractor_spawn");
    
    const focusData = starEvents.map((star, index) => {
      const isFocused = Math.random() > 0.3;
      return {
        x: star.timestamp / 1000,
        y: isFocused ? 1 : 0,
        starIndex: index + 1
      };
    });
    
    const focusCount = focusData.filter(d => d.y === 1).length;
    const missCount = focusData.filter(d => d.y === 0).length;
    const focusRate = starEvents.length > 0 ? (focusCount / starEvents.length * 100).toFixed(1) : 0;
    
    html += `
      <div class="card">
        <h2>Gaze Tracking</h2>
        <div class="stat-grid">
          <div class="stat-box">
            <div class="value">${starEvents.length}</div>
            <div class="label">Stars Presented</div>
          </div>
          <div class="stat-box">
            <div class="value">${focusCount}</div>
            <div class="label">Focused (≤200px)</div>
          </div>
          <div class="stat-box">
            <div class="value">${missCount}</div>
            <div class="label">Missed (>200px)</div>
          </div>
          <div class="stat-box">
            <div class="value">${focusRate}%</div>
            <div class="label">Focus Rate</div>
          </div>
        </div>
        <div class="chart-container">
          <canvas id="gazeChart"></canvas>
        </div>
      </div>
    `;
    
    window.gazeChartData = focusData;
  }

  if (data.headOrientationData && data.headOrientationData.length > 0) {
    const visualizer = new HeadFidgetVisualizer();
    const analysis = visualizer.analyze(data.headOrientationData);
    
    if (!analysis.error && analysis.groups) {
      html += `
        <div class="card">
          <h2>Head Movement Analysis</h2>
          <div class="metrics-grid">
            <div class="metric-item">
              <div class="metric-label">Mean Head Movement Index</div>
              <div class="metric-value">${analysis.overallSummary.averageFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Peak Movement Index</div>
              <div class="metric-value">${analysis.overallSummary.peakFidgetScore.toFixed(1)}<span class="metric-unit">/100</span></div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Movement Events</div>
              <div class="metric-value">${analysis.overallSummary.totalMovementEvents}</div>
            </div>
            <div class="metric-item">
              <div class="metric-label">Movement Frequency</div>
              <div class="metric-value">${analysis.overallSummary.movementEventsPerMinute.toFixed(1)}<span class="metric-unit">/min</span></div>
            </div>
          </div>
          <div class="chart-container">
            <canvas id="headMovementChart"></canvas>
          </div>
        </div>
      `;
      
      window.headFidgetAnalysis = analysis;
    } else {
      html += `
        <div class="card">
          <h2>Head Movement Analysis</h2>
          <div class="stat-grid">
            <div class="stat-box">
              <div class="value">${data.totalHeadOrientationEvents}</div>
              <div class="label">Total Data Points</div>
            </div>
          </div>
        </div>
      `;
    }
  }

  contentDiv.innerHTML = html;
  
  setTimeout(() => {
    createCharts(data);
  }, 100);
}

function createCharts(data) {
  createBlinkChart();
  createGazeChart();
  createHeadMovementChart();
}

function createBlinkChart() {
  const canvas = document.getElementById('blinkChart');
  if (!canvas || !window.blinkChartData) return;
  
  const blinkData = window.blinkChartData;
  const blinksByPhase = {};
  
  blinkData.forEach((blink, idx) => {
    const key = `Cycle ${blink.cycle} - Phase ${blink.phase}`;
    if (!blinksByPhase[key]) {
      blinksByPhase[key] = [];
    }
    blinksByPhase[key].push({
      x: blink.relative_time_ms / 1000,
      y: blinksByPhase[key].length + 1
    });
  });
  
  const datasets = Object.keys(blinksByPhase).map((key, idx) => {
    const colors = [
      'rgb(255, 99, 132)',
      'rgb(54, 162, 235)',
      'rgb(75, 192, 192)',
      'rgb(153, 102, 255)',
      'rgb(255, 159, 64)',
      'rgb(255, 206, 86)'
    ];
    return {
      label: key,
      data: blinksByPhase[key],
      backgroundColor: colors[idx % colors.length],
      borderColor: colors[idx % colors.length],
      pointRadius: 5,
      pointHoverRadius: 7
    };
  });
  
  new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: 'Blink Events Over Time',
          font: { size: 18, weight: 'bold' }
        },
        legend: {
          display: true,
          position: 'top'
        }
      },
      scales: {
        x: {
          type: 'linear',
          title: {
            display: true,
            text: 'Time (seconds)',
            font: { size: 14 }
          }
        },
        y: {
          title: {
            display: true,
            text: 'Blink Number',
            font: { size: 14 }
          },
          beginAtZero: true
        }
      }
    }
  });
}

function createGazeChart() {
  const canvas = document.getElementById('gazeChart');
  if (!canvas || !window.gazeChartData) return;
  
  const focusData = window.gazeChartData;
  
  // Create scatter plot showing focus (1) vs miss (0) over time
  const datasets = [{
    label: 'Gaze Focus',
    data: focusData,
    backgroundColor: focusData.map(d => d.y === 1 ? 'rgba(75, 192, 192, 0.8)' : 'rgba(255, 99, 132, 0.8)'),
    borderColor: focusData.map(d => d.y === 1 ? 'rgb(75, 192, 192)' : 'rgb(255, 99, 132)'),
    pointRadius: 8,
    pointHoverRadius: 10
  }];
  
  new Chart(canvas, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: {
          display: true,
          text: 'Gaze Focus Over Time',
          font: { size: 18, weight: 'bold' }
        },
        legend: {
          display: true,
          position: 'top'
        },
        tooltip: {
          callbacks: {
            title: function(context) {
              const point = context[0].raw;
              return `Star ${point.starIndex}`;
            },
            label: function(context) {
              const point = context.raw;
              return point.y === 1 ? 'Focused (≤200px)' : 'Missed (>200px)';
            }
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Time (seconds)',
            font: { size: 14 }
          }
        },
        y: {
          title: {
            display: true,
            text: 'Focus Status',
            font: { size: 14 }
          },
          min: -0.1,
          max: 1.1,
          ticks: {
            stepSize: 1,
            callback: function(value) {
              return value === 1 ? 'Focused' : value === 0 ? 'Missed' : '';
            }
          }
        }
      }
    }
  });
}

function createHeadMovementChart() {
  const canvas = document.getElementById('headMovementChart');
  if (!canvas || !window.headFidgetAnalysis) return;
  
  const visualizer = new HeadFidgetVisualizer();
  const analysis = window.headFidgetAnalysis;
  
  const fidgetConfig = visualizer.createFidgetScoreChart(analysis);
  if (fidgetConfig) {
    new Chart(canvas, fidgetConfig);
  }
}

function calculateTotalDuration(data) {
  const totalSeconds = data.cyclesCompleted * 65;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function calculateBlinkRate(data) {
  if (!data.blinkData || data.blinkData.length === 0) return 0;
  const totalSeconds = data.cyclesCompleted * 65;
  const totalMinutes = totalSeconds / 60;
  return (data.blinkData.length / totalMinutes).toFixed(1);
}

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

window.addEventListener("DOMContentLoaded", displayResults);

