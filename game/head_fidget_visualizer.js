/**
 * Head Fidgeting Visualization Module
 * 
 * Processes head movement data and creates interactive charts showing:
 * - Fidget score over time
 * - Movement events
 * - Stillness periods
 * - Head angle deviations
 */

class HeadFidgetVisualizer {
  constructor() {
    this.smoothingWindow = 5;
    this.movementThreshold = 2.0;
  }

  /**
   * Parse head tracking log data from localStorage
   */
  parseHeadData(headOrientationData) {
    if (!headOrientationData || headOrientationData.length === 0) {
      return null;
    }

    // Extract data arrays
    const data = {
      timestamps: [],
      pitch: [],
      yaw: [],
      roll: [],
      directions: [],
      phases: [],
      cycles: []
    };

    headOrientationData.forEach(entry => {
      // Convert ISO timestamp to milliseconds if needed
      let timestamp;
      if (typeof entry.timestamp === 'string') {
        timestamp = new Date(entry.timestamp).getTime();
      } else if (entry.timestamp) {
        timestamp = entry.timestamp;
      } else {
        timestamp = Date.now();
      }

      data.timestamps.push(timestamp);
      data.pitch.push(entry.pitch || 0);
      data.yaw.push(entry.yaw || 0);
      data.roll.push(entry.roll || 0);
      data.directions.push(entry.direction || 'Forward');
      data.phases.push(entry.phase || null);
      data.cycles.push(entry.cycle || null);
    });

    return data;
  }

  /**
   * Group data by cycle and phase
   */
  groupByCycleAndPhase(data) {
    const groups = {};

    for (let i = 0; i < data.timestamps.length; i++) {
      const cycle = data.cycles[i];
      const phase = data.phases[i];
      
      if (cycle === null || phase === null) continue;

      const key = `cycle${cycle}_phase${phase}`;
      
      if (!groups[key]) {
        groups[key] = {
          cycle: cycle,
          phase: phase,
          timestamps: [],
          pitch: [],
          yaw: [],
          roll: [],
          directions: []
        };
      }

      groups[key].timestamps.push(data.timestamps[i]);
      groups[key].pitch.push(data.pitch[i]);
      groups[key].yaw.push(data.yaw[i]);
      groups[key].roll.push(data.roll[i]);
      groups[key].directions.push(data.directions[i]);
    }

    return groups;
  }

  /**
   * Calculate angular velocity (rate of change)
   */
  calculateAngularVelocity(angles, timestamps) {
    if (angles.length < 2) return [0];

    const velocities = [0]; // First value is 0

    for (let i = 1; i < angles.length; i++) {
      const timeDiff = (timestamps[i] - timestamps[i - 1]) / 1000.0; // Convert to seconds
      if (timeDiff === 0) {
        velocities.push(0);
        continue;
      }

      const angleDiff = angles[i] - angles[i - 1];
      const velocity = angleDiff / timeDiff; // degrees per second
      velocities.push(velocity);
    }

    return velocities;
  }

  /**
   * Calculate total movement magnitude
   */
  calculateTotalMovement(pitchVel, yawVel, rollVel) {
    const totalMovement = [];

    for (let i = 0; i < pitchVel.length; i++) {
      const magnitude = Math.sqrt(
        pitchVel[i] ** 2 + yawVel[i] ** 2 + rollVel[i] ** 2
      );
      totalMovement.push(magnitude);
    }

    return totalMovement;
  }

  /**
   * Simple moving average smoothing
   */
  smoothSignal(signal, windowSize = 5) {
    if (signal.length < windowSize) return signal;

    const smoothed = [];
    const halfWindow = Math.floor(windowSize / 2);

    for (let i = 0; i < signal.length; i++) {
      const start = Math.max(0, i - halfWindow);
      const end = Math.min(signal.length, i + halfWindow + 1);
      const window = signal.slice(start, end);
      const avg = window.reduce((sum, val) => sum + val, 0) / window.length;
      smoothed.push(avg);
    }

    return smoothed;
  }

  /**
   * Calculate fidget score (0-100 scale)
   */
  calculateFidgetScore(totalMovement) {
    if (totalMovement.length === 0) return [];

    // Find 95th percentile to avoid outliers
    const sorted = [...totalMovement].sort((a, b) => a - b);
    const percentile95Index = Math.floor(sorted.length * 0.95);
    const maxMovement = sorted[percentile95Index] || 1;

    // Normalize to 0-100 scale
    const fidgetScore = totalMovement.map(movement => {
      const score = (movement / maxMovement) * 100;
      return Math.min(100, Math.max(0, score));
    });

    return fidgetScore;
  }

  /**
   * Detect discrete movement events
   */
  detectMovementEvents(totalMovement, timestamps) {
    const events = [];
    let inMovement = false;
    let movementStart = null;
    let movementIntensities = [];

    for (let i = 0; i < totalMovement.length; i++) {
      const movement = totalMovement[i];
      const timestamp = timestamps[i];

      if (movement > this.movementThreshold) {
        if (!inMovement) {
          // Start new movement
          inMovement = true;
          movementStart = timestamp;
          movementIntensities = [movement];
        } else {
          // Continue movement
          movementIntensities.push(movement);
        }
      } else {
        if (inMovement) {
          // End movement
          events.push({
            startTime: movementStart,
            endTime: timestamp,
            durationMs: timestamp - movementStart,
            peakIntensity: Math.max(...movementIntensities),
            avgIntensity: movementIntensities.reduce((a, b) => a + b, 0) / movementIntensities.length
          });
          inMovement = false;
        }
      }
    }

    // Handle ongoing movement at end
    if (inMovement && movementStart !== null) {
      const lastTimestamp = timestamps[timestamps.length - 1];
      events.push({
        startTime: movementStart,
        endTime: lastTimestamp,
        durationMs: lastTimestamp - movementStart,
        peakIntensity: Math.max(...movementIntensities),
        avgIntensity: movementIntensities.reduce((a, b) => a + b, 0) / movementIntensities.length
      });
    }

    return events;
  }

  /**
   * Detect stillness periods
   */
  detectStillnessPeriods(totalMovement, timestamps, stillnessThreshold = 1.0, minDurationMs = 2000) {
    const periods = [];
    let inStillness = false;
    let stillnessStart = null;

    for (let i = 0; i < totalMovement.length; i++) {
      const movement = totalMovement[i];
      const timestamp = timestamps[i];

      if (movement < stillnessThreshold) {
        if (!inStillness) {
          inStillness = true;
          stillnessStart = timestamp;
        }
      } else {
        if (inStillness) {
          const duration = timestamp - stillnessStart;
          if (duration >= minDurationMs) {
            periods.push({
              startTime: stillnessStart,
              endTime: timestamp,
              durationMs: duration
            });
          }
          inStillness = false;
        }
      }
    }

    // Handle ongoing stillness at end
    if (inStillness && stillnessStart !== null) {
      const lastTimestamp = timestamps[timestamps.length - 1];
      const duration = lastTimestamp - stillnessStart;
      if (duration >= minDurationMs) {
        periods.push({
          startTime: stillnessStart,
          endTime: lastTimestamp,
          durationMs: duration
        });
      }
    }

    return periods;
  }

  /**
   * Calculate standard deviation
   */
  calculateStd(values) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map(v => (v - mean) ** 2);
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Analyze a single group (cycle/phase combination)
   */
  analyzeGroup(groupData) {
    if (!groupData || groupData.timestamps.length === 0) {
      return null;
    }

    // Calculate velocities
    const pitchVel = this.calculateAngularVelocity(groupData.pitch, groupData.timestamps);
    const yawVel = this.calculateAngularVelocity(groupData.yaw, groupData.timestamps);
    const rollVel = this.calculateAngularVelocity(groupData.roll, groupData.timestamps);

    // Calculate total movement
    const totalMovement = this.calculateTotalMovement(pitchVel, yawVel, rollVel);

    // Smooth signal
    const totalMovementSmooth = this.smoothSignal(totalMovement, this.smoothingWindow);

    // Calculate fidget score
    const fidgetScore = this.calculateFidgetScore(totalMovementSmooth);

    // Detect events
    const movementEvents = this.detectMovementEvents(totalMovementSmooth, groupData.timestamps);
    const stillnessPeriods = this.detectStillnessPeriods(totalMovementSmooth, groupData.timestamps);

    // Calculate relative time in seconds
    const startTime = groupData.timestamps[0];
    const relativeTimeSeconds = groupData.timestamps.map(t => (t - startTime) / 1000.0);

    // Calculate summary statistics
    const durationSeconds = (groupData.timestamps[groupData.timestamps.length - 1] - startTime) / 1000.0;
    const totalStillnessDuration = stillnessPeriods.reduce((sum, p) => sum + p.durationMs, 0);

    const summary = {
      totalDurationSeconds: durationSeconds,
      averageFidgetScore: fidgetScore.length > 0 ? fidgetScore.reduce((a, b) => a + b, 0) / fidgetScore.length : 0,
      peakFidgetScore: fidgetScore.length > 0 ? Math.max(...fidgetScore) : 0,
      totalMovementEvents: movementEvents.length,
      movementEventsPerMinute: durationSeconds > 0 ? movementEvents.length / (durationSeconds / 60.0) : 0,
      totalStillnessPeriods: stillnessPeriods.length,
      totalStillnessDurationSeconds: totalStillnessDuration / 1000.0,
      stillnessPercentage: durationSeconds > 0 ? (totalStillnessDuration / (durationSeconds * 1000.0)) * 100 : 0,
      averagePitchDeviation: groupData.pitch.length > 0 ? this.calculateStd(groupData.pitch) : 0,
      averageYawDeviation: groupData.yaw.length > 0 ? this.calculateStd(groupData.yaw) : 0,
      averageRollDeviation: groupData.roll.length > 0 ? this.calculateStd(groupData.roll) : 0
    };

    return {
      cycle: groupData.cycle,
      phase: groupData.phase,
      relativeTimeSeconds,
      timestamps: groupData.timestamps,
      pitch: groupData.pitch,
      yaw: groupData.yaw,
      roll: groupData.roll,
      pitchVelocity: pitchVel,
      yawVelocity: yawVel,
      rollVelocity: rollVel,
      totalMovement,
      totalMovementSmooth,
      fidgetScore,
      movementEvents,
      stillnessPeriods,
      summary
    };
  }

  /**
   * Main analysis function
   */
  analyze(headOrientationData) {
    // Parse data
    const data = this.parseHeadData(headOrientationData);
    if (!data) {
      return {
        error: 'No head orientation data available',
        summary: {},
        groups: {}
      };
    }

    // Group by cycle and phase
    const groups = this.groupByCycleAndPhase(data);
    
    // Analyze each group
    const analyzedGroups = {};
    for (const [key, groupData] of Object.entries(groups)) {
      const analysis = this.analyzeGroup(groupData);
      if (analysis) {
        analyzedGroups[key] = analysis;
      }
    }

    // Calculate overall summary
    const allFidgetScores = [];
    const allMovementEvents = [];
    let totalDuration = 0;

    Object.values(analyzedGroups).forEach(group => {
      allFidgetScores.push(...group.fidgetScore);
      allMovementEvents.push(...group.movementEvents);
      totalDuration += group.summary.totalDurationSeconds;
    });

    const overallSummary = {
      totalDurationSeconds: totalDuration,
      totalGroups: Object.keys(analyzedGroups).length,
      averageFidgetScore: allFidgetScores.length > 0 ? allFidgetScores.reduce((a, b) => a + b, 0) / allFidgetScores.length : 0,
      peakFidgetScore: allFidgetScores.length > 0 ? Math.max(...allFidgetScores) : 0,
      totalMovementEvents: allMovementEvents.length,
      movementEventsPerMinute: totalDuration > 0 ? allMovementEvents.length / (totalDuration / 60.0) : 0
    };

    return {
      groups: analyzedGroups,
      overallSummary: overallSummary,
      groupCount: Object.keys(analyzedGroups).length
    };
  }

  /**
   * Get color for cycle/phase combination
   */
  getColorForGroup(cycle, phase) {
    const colors = {
      'cycle1_phase1': { border: 'rgb(255, 99, 132)', bg: 'rgba(255, 99, 132, 0.1)' },
      'cycle1_phase2': { border: 'rgb(255, 159, 64)', bg: 'rgba(255, 159, 64, 0.1)' },
      'cycle2_phase1': { border: 'rgb(54, 162, 235)', bg: 'rgba(54, 162, 235, 0.1)' },
      'cycle2_phase2': { border: 'rgb(75, 192, 192)', bg: 'rgba(75, 192, 192, 0.1)' },
      'cycle3_phase1': { border: 'rgb(153, 102, 255)', bg: 'rgba(153, 102, 255, 0.1)' },
      'cycle3_phase2': { border: 'rgb(255, 206, 86)', bg: 'rgba(255, 206, 86, 0.1)' }
    };
    
    const key = `cycle${cycle}_phase${phase}`;
    return colors[key] || { border: 'rgb(201, 203, 207)', bg: 'rgba(201, 203, 207, 0.1)' };
  }

  /**
   * Create Chart.js configuration for fidget score over time (split by cycles and phases)
   */
  createFidgetScoreChart(analysisResults) {
    if (analysisResults.error || !analysisResults.groups) {
      return null;
    }

    const datasets = [];
    
    // Sort groups by cycle and phase
    const sortedKeys = Object.keys(analysisResults.groups).sort((a, b) => {
      const [cycleA, phaseA] = a.match(/\d+/g).map(Number);
      const [cycleB, phaseB] = b.match(/\d+/g).map(Number);
      if (cycleA !== cycleB) return cycleA - cycleB;
      return phaseA - phaseB;
    });

    sortedKeys.forEach(key => {
      const group = analysisResults.groups[key];
      const color = this.getColorForGroup(group.cycle, group.phase);
      const phaseLabel = group.phase === 1 ? 'Visual Search' : 'Fixation';
      
      // Create data points with x (time) and y (fidget score) values
      const dataPoints = group.relativeTimeSeconds.map((time, idx) => ({
        x: time,
        y: group.fidgetScore[idx]
      }));
      
      datasets.push({
        label: `Cycle ${group.cycle} - Phase ${group.phase} (${phaseLabel})`,
        data: dataPoints,
        borderColor: color.border,
        backgroundColor: color.bg,
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4
      });
    });

    // Labels not needed when using x/y data points
    const labels = [];

    return {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Head Fidgeting Over Time (By Cycle & Phase)',
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            display: true,
            position: 'top',
            labels: {
              boxWidth: 20,
              padding: 10,
              font: { size: 11 }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: (context) => {
                const label = context.dataset.label || '';
                const value = context.parsed.y.toFixed(1);
                return `${label}: ${value}/100`;
              }
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: 'Time (seconds from phase start)',
              font: { size: 14 }
            },
            ticks: {
              maxTicksLimit: 10
            }
          },
          y: {
            title: {
              display: true,
              text: 'Fidget Score (0-100)',
              font: { size: 14 }
            },
            min: 0,
            max: 100
          }
        }
      }
    };
  }

  /**
   * Create Chart.js configuration for head angles (split by cycles and phases)
   */
  createHeadAnglesChart(analysisResults, angleType = 'all') {
    if (analysisResults.error || !analysisResults.groups) {
      return null;
    }

    const datasets = [];
    
    // Sort groups by cycle and phase
    const sortedKeys = Object.keys(analysisResults.groups).sort((a, b) => {
      const [cycleA, phaseA] = a.match(/\d+/g).map(Number);
      const [cycleB, phaseB] = b.match(/\d+/g).map(Number);
      if (cycleA !== cycleB) return cycleA - cycleB;
      return phaseA - phaseB;
    });

    const angleColors = {
      pitch: { border: 'rgb(239, 68, 68)', bg: 'rgba(239, 68, 68, 0.1)' },
      yaw: { border: 'rgb(34, 197, 94)', bg: 'rgba(34, 197, 94, 0.1)' },
      roll: { border: 'rgb(234, 179, 8)', bg: 'rgba(234, 179, 8, 0.1)' }
    };

    sortedKeys.forEach(key => {
      const group = analysisResults.groups[key];
      const phaseLabel = group.phase === 1 ? 'Visual Search' : 'Fixation';
      
      if (angleType === 'all' || angleType === 'pitch') {
        const pitchData = group.relativeTimeSeconds.map((time, idx) => ({
          x: time,
          y: group.pitch[idx]
        }));
        datasets.push({
          label: `C${group.cycle}P${group.phase} Pitch (Up/Down)`,
          data: pitchData,
          borderColor: angleColors.pitch.border,
          backgroundColor: angleColors.pitch.bg,
          borderWidth: 2,
          borderDash: group.phase === 2 ? [5, 5] : [],
          fill: false,
          tension: 0.4,
          pointRadius: 0
        });
      }

      if (angleType === 'all' || angleType === 'yaw') {
        const yawData = group.relativeTimeSeconds.map((time, idx) => ({
          x: time,
          y: group.yaw[idx]
        }));
        datasets.push({
          label: `C${group.cycle}P${group.phase} Yaw (Left/Right)`,
          data: yawData,
          borderColor: angleColors.yaw.border,
          backgroundColor: angleColors.yaw.bg,
          borderWidth: 2,
          borderDash: group.phase === 2 ? [5, 5] : [],
          fill: false,
          tension: 0.4,
          pointRadius: 0
        });
      }

      if (angleType === 'all' || angleType === 'roll') {
        const rollData = group.relativeTimeSeconds.map((time, idx) => ({
          x: time,
          y: group.roll[idx]
        }));
        datasets.push({
          label: `C${group.cycle}P${group.phase} Roll (Tilt)`,
          data: rollData,
          borderColor: angleColors.roll.border,
          backgroundColor: angleColors.roll.bg,
          borderWidth: 2,
          borderDash: group.phase === 2 ? [5, 5] : [],
          fill: false,
          tension: 0.4,
          pointRadius: 0
        });
      }
    });

    const labels = [];

    return {
      type: 'line',
      data: {
        labels: labels,
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Head Orientation Over Time (By Cycle & Phase)',
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            display: true,
            position: 'top',
            labels: {
              boxWidth: 20,
              padding: 8,
              font: { size: 10 }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: 'Time (seconds from phase start)',
              font: { size: 14 }
            },
            ticks: {
              maxTicksLimit: 10
            }
          },
          y: {
            title: {
              display: true,
              text: 'Angle (degrees)',
              font: { size: 14 }
            }
          }
        }
      }
    };
  }

  /**
   * Create comparison chart showing average fidget scores per cycle/phase
   */
  createComparisonChart(analysisResults) {
    if (analysisResults.error || !analysisResults.groups) {
      return null;
    }

    const labels = [];
    const avgScores = [];
    const peakScores = [];
    const eventCounts = [];
    const backgroundColors = [];

    // Sort groups
    const sortedKeys = Object.keys(analysisResults.groups).sort((a, b) => {
      const [cycleA, phaseA] = a.match(/\d+/g).map(Number);
      const [cycleB, phaseB] = b.match(/\d+/g).map(Number);
      if (cycleA !== cycleB) return cycleA - cycleB;
      return phaseA - phaseB;
    });

    sortedKeys.forEach(key => {
      const group = analysisResults.groups[key];
      const phaseLabel = group.phase === 1 ? 'Visual' : 'Fixation';
      const color = this.getColorForGroup(group.cycle, group.phase);
      
      labels.push(`C${group.cycle} P${group.phase}\n${phaseLabel}`);
      avgScores.push(group.summary.averageFidgetScore);
      peakScores.push(group.summary.peakFidgetScore);
      eventCounts.push(group.summary.totalMovementEvents);
      backgroundColors.push(color.border);
    });

    return {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Average Fidget Score',
          data: avgScores,
          backgroundColor: backgroundColors.map(c => c.replace('rgb', 'rgba').replace(')', ', 0.6)')),
          borderColor: backgroundColors,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          title: {
            display: true,
            text: 'Average Fidget Score Comparison',
            font: { size: 18, weight: 'bold' }
          },
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              afterLabel: (context) => {
                const idx = context.dataIndex;
                return [
                  `Peak Score: ${peakScores[idx].toFixed(1)}`,
                  `Movement Events: ${eventCounts[idx]}`
                ];
              }
            }
          }
        },
        scales: {
          y: {
            title: {
              display: true,
              text: 'Fidget Score (0-100)',
              font: { size: 14 }
            },
            min: 0,
            max: 100
          }
        }
      }
    };
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.HeadFidgetVisualizer = HeadFidgetVisualizer;
}

