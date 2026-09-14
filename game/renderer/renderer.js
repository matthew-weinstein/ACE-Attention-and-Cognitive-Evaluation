const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

let targets = [];
let keys = {};
let gameState = "loading"; // 'loading', 'start', 'instructions', 'calibration', 'phase1', 'phase2', 'complete'
let animationTime = 0;
let stars = [];
let mousePos = { x: 0, y: 0 };
let startButtonHover = false;
let dataButtonHover = false;
let loadingProgress = 0;
let loadingMessage = "Initializing eye tracker...";

let instructionPhase = null;
let instructionStartTime = 0;
let instructionDuration = 10000;
let calibrationInstructionStart = 0;
let calibrationCommandTime = 0; // when CALIBRATE was sent to Python

let currentCycle = 1;
let totalCycles = 1;
let currentPhase = 1;

let phase1Active = false;
let phase1Timer = 0;
let phase1Duration = 30000;
let phase1StartTime = 0;
let trackingStars = [];
let distractors = [];
let currentTrackingStar = null;
let starSpawnInterval = 5000;
let lastStarSpawn = 0;
let distractorSpawnInterval = 1000;
let lastDistractorSpawn = 0;

let phase2Active = false;
let phase2Timer = 0;
let phase2Duration = 15000;
let phase2StartTime = 0;
let fixationStar = null;
let progressMeter = null;

// Unified data collection arrays (stores all data for entire test session)
let blinkData = []; // Blink events with phase info
let gazeData = []; // Gaze tracking data with phase info
let headOrientationData = []; // Head orientation data with phase info
let starProximityData = []; // Eye target proximity to stars with phase info
let perSecondProximityData = []; // Aggregated per-second proximity data

// Tracking variables
let blinkTrackerReady = true; // stub process, always ready
let headTrackerReady = true; // stub process, always ready
let eyeTrackerReady = false;
let eyeTrackerCalibrated = false;
let calibrationInProgress = false;
let calibrationDot = null; // {x, y, point, total} from Python instruction
let sessionId = null;
let lastProximityCheckSecond = -1; // Track which second we last checked

// Eye tracking variables
let currentGazeX = null;
let currentGazeY = null;
let gazeCursorAlpha = 0.0;

// Developer overlay (toggle with R key)
let devMode = false;
let lastBlinkTime = 0;
let lastHeadPose = { pitch: 0, yaw: 0, roll: 0 };
const BLINK_STICKY_MS = 1000;

const GAZE_LERP = 0.2; // fraction of remaining distance to close per frame (~30fps)
const HEAD_LERP = 0.15;

// Shortest-path lerp for angles that can wrap ±180
function lerpAngleDeg(from, to, t) {
  let diff = to - from;
  diff = ((diff + 540) % 360) - 180; // normalise to [-180, 180]
  return from + diff * t;
}

// Function to check if all trackers are ready and transition to start screen
function checkAllTrackersReady() {
  console.log("Checking tracker readiness:", {
    blink: blinkTrackerReady,
    head: headTrackerReady,
    eye: eyeTrackerReady,
    eyeCalibrated: eyeTrackerCalibrated,
    gameState: gameState,
  });

  const readyToStart =
    blinkTrackerReady && headTrackerReady && eyeTrackerCalibrated;
  if (
    readyToStart &&
    (gameState === "loading" ||
      gameState === "calibration" ||
      gameState === "calibration_instructions")
  ) {
    console.log("✓ All trackers ready! Transitioning to start screen...");
    setTimeout(() => {
      gameState = "start";
    }, 1000);
  }
}

// Initialize blink tracker event listeners
if (window.blinkTracker) {
  window.blinkTracker.onReady((data) => {
    console.log("Blink tracker ready:", data);
    blinkTrackerReady = true;
    checkAllTrackersReady(); // Check if we can transition to start screen
  });

  window.blinkTracker.onBlinkDetected((data) => {
    console.log("👁️ BLINK DETECTED!", data);
    lastBlinkTime = Date.now();

    const blinkEntry = {
      ...data,
      phase: phase1Active ? 1 : phase2Active ? 2 : null,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    blinkData.push(blinkEntry);
    console.log(`   Added to blinkData. Total blinks now: ${blinkData.length}`);
  });

  window.blinkTracker.onTrackingStarted((data) => {
    console.log("✓✓✓ Blink tracking STARTED successfully:", data);
  });

  window.blinkTracker.onTrackingStopped((data) => {
    console.log("Blink tracking stopped:", data);
    console.log("Total blinks detected:", data.total_blinks);
  });

  window.blinkTracker.onError((error) => {
    console.error("Blink tracker error:", error);
  });
}

// Initialize head tracker event listeners
if (window.headTracker) {
  console.log("✓ window.headTracker is available");

  window.headTracker.onReady((data) => {
    console.log("✓ Head tracker READY:", data);
    headTrackerReady = true;
    checkAllTrackersReady(); // Check if we can transition to start screen
  });

  window.headTracker.onHeadPoseDetected((data) => {
    // Shortest-path lerp so the 3D wireframe never spins the long way around
    lastHeadPose = {
      pitch: lerpAngleDeg(lastHeadPose.pitch, data.pitch, HEAD_LERP),
      yaw: lerpAngleDeg(lastHeadPose.yaw, data.yaw, HEAD_LERP),
      roll: lerpAngleDeg(lastHeadPose.roll, data.roll, HEAD_LERP),
    };
    const headEntry = {
      ...data,
      phase: phase1Active ? 1 : phase2Active ? 2 : null,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    headOrientationData.push(headEntry);

    if (headOrientationData.length % 100 === 0) {
      console.log(
        `   📊 Head data collected: ${headOrientationData.length} entries`,
      );
    }
  });

  window.headTracker.onTrackingStarted((data) => {
    console.log("✓ Head tracking STARTED:", data);
  });

  window.headTracker.onTrackingStopped((data) => {
    console.log("✓ Head tracking STOPPED:", data);
  });

  window.headTracker.onCalibrated((data) => {
    console.log("✓ Head tracker calibrated:", data);
  });

  window.headTracker.onError((error) => {
    console.error("❌ Head tracker ERROR:", error);
  });
} else {
  console.error("❌ window.headTracker is NOT available - check preload.js");
}

// Initialize eye tracker event listeners
if (window.eyeTracker) {
  window.eyeTracker.onReady((data) => {
    console.log("Eye tracker ready:", data);
    eyeTrackerReady = true;
    // Show 10-second instruction screen before calibration begins
    setTimeout(() => {
      gameState = "calibration_instructions";
      calibrationInstructionStart = Date.now();
    }, 400);
  });

  window.eyeTracker.onCalibrationStarted((data) => {
    console.log("Eye calibration started:", data);
    calibrationInProgress = true;
    calibrationDot = null;
  });

  window.eyeTracker.onCalibrationInstruction((data) => {
    console.log("Calibration instruction:", data);
    calibrationDot = {
      x: data.x,
      y: data.y,
      point: data.point,
      total: data.total_points,
    };
  });

  window.eyeTracker.onCalibrationCompleted((data) => {
    console.log("Eye calibration completed:", data);
    eyeTrackerCalibrated = true;
    calibrationInProgress = false;
    calibrationDot = null;
    checkAllTrackersReady();
    // Fallback: transition directly if checkAllTrackersReady didn't fire
    // (happens when blink/head tracker ready events arrive after calibration)
    setTimeout(() => {
      if (
        gameState === "calibration" ||
        gameState === "calibration_instructions"
      ) {
        console.log("Direct transition to start after calibration");
        gameState = "start";
      }
    }, 1500);
  });

  window.eyeTracker.onGazeDetected((data) => {
    // Lerp toward new position so the cursor glides rather than jumps
    if (currentGazeX === null) {
      currentGazeX = data.x;
      currentGazeY = data.y;
    } else {
      currentGazeX += (data.x - currentGazeX) * GAZE_LERP;
      currentGazeY += (data.y - currentGazeY) * GAZE_LERP;
    }

    // Show cursor immediately if it's hidden
    if (gazeCursorAlpha === 0) {
      gazeCursorAlpha = 0.3; // Start with some visibility
    }

    // Add to gaze data with phase info
    const gazeEntry = {
      ...data,
      phase: phase1Active ? 1 : phase2Active ? 2 : null,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    gazeData.push(gazeEntry);
  });

  window.eyeTracker.onBlinkDetected((data) => {
    console.log("Blink detected (eye tracker):", data);
    lastBlinkTime = Date.now();

    const blinkEntry = {
      ...data,
      phase: phase1Active ? 1 : phase2Active ? 2 : null,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    blinkData.push(blinkEntry);

    // Briefly suppress gaze cursor during blink
    gazeCursorAlpha = Math.max(0, gazeCursorAlpha - 0.5);
  });

  window.eyeTracker.onTrackingStarted((data) => {
    console.log("Eye tracking started:", data);
  });

  window.eyeTracker.onTrackingStopped((data) => {
    console.log("Eye tracking stopped:", data);
    console.log("Total gaze points:", data.total_gaze_points);
    console.log("Total blinks detected:", data.total_blinks);
  });

  window.eyeTracker.onError((error) => {
    console.error("Eye tracker error:", error);
    loadingMessage = `Error: ${error.message || "Unknown error"}`;

    // Unblock any waiting state so the app never hangs
    if (
      gameState === "loading" ||
      gameState === "calibration" ||
      gameState === "calibration_instructions"
    ) {
      eyeTrackerCalibrated = true;
      calibrationInProgress = false;
      checkAllTrackersReady();
    }
  });
}

setInterval(() => {
  if (phase1Active || phase2Active) {
    console.log("📊 DATA STATUS:", {
      phase: phase1Active ? 1 : phase2Active ? 2 : 0,
      cycle: currentCycle,
      blinkCount: blinkData.length,
      headCount: headOrientationData.length,
      gazeCount: gazeData.length,
    });
  }
}, 10000);

function initStars() {
  stars = [];
  const hues = ["warm", "cool", "white"];
  for (let i = 0; i < 220; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.random() * 2.2 + 0.3,
      speed: Math.random() * 0.4 + 0.05,
      opacity: Math.random() * 0.7 + 0.2,
      twinkleOffset: Math.random() * Math.PI * 2,
      twinkleSpeed: Math.random() * 0.04 + 0.01,
      hue: hues[Math.floor(Math.random() * hues.length)],
    });
  }
}
initStars();

window.addEventListener("resize", initStars);

canvas.addEventListener("mousemove", (e) => {
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;

  const buttonWidth = 350;
  const buttonHeight = 70;
  const buttonX = canvas.width / 2 - buttonWidth / 2;
  const buttonY = canvas.height / 2 + 200;

  startButtonHover =
    mousePos.x >= buttonX &&
    mousePos.x <= buttonX + buttonWidth &&
    mousePos.y >= buttonY &&
    mousePos.y <= buttonY + buttonHeight &&
    gameState === "start";

  if (gameState === "complete") {
    const dataButtonWidth = 250;
    const dataButtonHeight = 60;
    const dataButtonX = canvas.width / 2 - dataButtonWidth / 2;
    const dataButtonY = canvas.height / 2 + 150;

    dataButtonHover =
      mousePos.x >= dataButtonX &&
      mousePos.x <= dataButtonX + dataButtonWidth &&
      mousePos.y >= dataButtonY &&
      mousePos.y <= dataButtonY + dataButtonHeight;

    canvas.style.cursor = dataButtonHover ? "pointer" : "default";
  } else {
    canvas.style.cursor = startButtonHover ? "pointer" : "default";
  }
});

canvas.addEventListener("click", (e) => {
  if (gameState === "start" && startButtonHover) {
    // Start calibration process
    if (eyeTrackerReady && !eyeTrackerCalibrated) {
      startCalibration();
    } else if (eyeTrackerCalibrated) {
      showInstructions("phase1");
    } else {
      // Show loading screen instead of alert
      gameState = "loading";
      loadingMessage = "Eye tracker is initializing. Please wait...";
      loadingProgress = 30;
    }
    canvas.style.cursor = "default";
  }
  if (gameState === "complete" && dataButtonHover) {
    showDataSummary();
  }
});

document.addEventListener("keydown", (e) => {
  keys[e.code] = true;

  // R key toggles developer overlay (gaze cursor + blink indicator + 3D head viz)
  if (e.code === "KeyR") {
    devMode = !devMode;
    console.log(`Dev overlay: ${devMode ? "ON" : "OFF"}`);
  }

  if (gameState === "start" && e.code === "Enter") {
    // Start calibration process
    if (eyeTrackerReady && !eyeTrackerCalibrated) {
      startCalibration();
    } else if (eyeTrackerCalibrated) {
      showInstructions("phase1");
    } else {
      // Show loading screen instead of alert
      gameState = "loading";
      loadingMessage = "Eye tracker is initializing. Please wait...";
      loadingProgress = 30;
    }
  }
  if (e.code === "Escape") {
    if (
      gameState === "phase1" ||
      gameState === "phase2" ||
      gameState === "instructions" ||
      gameState === "complete"
    ) {
      resetToStart();
    } else if (gameState === "start") {
      window.close();
    }
  }
});
document.addEventListener("keyup", (e) => (keys[e.code] = false));

function spawnTarget() {
  let x = Math.random() * (canvas.width - 60) + 30;
  let y = Math.random() * 300 + 50;
  targets.push({
    x: x,
    y: y,
    radius: 25,
    hue: Math.random() * 60 + 30, // Golden colors
  });
}
setInterval(spawnTarget, starSpawnInterval);

function drawStarsBackground() {
  stars.forEach((star) => {
    const twinkle = Math.sin(
      animationTime * star.twinkleSpeed + star.twinkleOffset,
    );
    const alpha = star.opacity * (0.7 + 0.3 * twinkle);
    let color;
    if (star.hue === "warm") color = `rgba(255, 220, 160, ${alpha})`;
    else if (star.hue === "cool") color = `rgba(160, 200, 255, ${alpha})`;
    else color = `rgba(255, 255, 255, ${alpha})`;
    ctx.save();
    ctx.fillStyle = color;
    if (star.size > 1.5) {
      ctx.shadowColor = color;
      ctx.shadowBlur = star.size * 3;
    }
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function drawGradientBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#080c1e");
  gradient.addColorStop(0.5, "#10163a");
  gradient.addColorStop(1, "#150d38");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Nebula glow — upper left purple, lower right teal
  const neb1 = ctx.createRadialGradient(
    canvas.width * 0.15,
    canvas.height * 0.2,
    0,
    canvas.width * 0.15,
    canvas.height * 0.2,
    canvas.width * 0.55,
  );
  neb1.addColorStop(0, "rgba(110, 60, 200, 0.13)");
  neb1.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = neb1;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const neb2 = ctx.createRadialGradient(
    canvas.width * 0.85,
    canvas.height * 0.75,
    0,
    canvas.width * 0.85,
    canvas.height * 0.75,
    canvas.width * 0.5,
  );
  neb2.addColorStop(0, "rgba(0, 140, 160, 0.10)");
  neb2.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = neb2;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Draw glowing text
function drawGlowingText(text, x, y, fontSize, color, glow = true) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `bold ${fontSize}px Nunito, 'Segoe UI', sans-serif`;

  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 20;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.shadowBlur = 10;
    ctx.fillText(text, x, y);
  }

  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Draw card
function drawCard(x, y, width, height, title, content) {
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.3)";
  ctx.shadowBlur = 20;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10;

  const cardGradient = ctx.createLinearGradient(x, y, x, y + height);
  cardGradient.addColorStop(0, "rgba(255, 255, 255, 0.05)");
  cardGradient.addColorStop(1, "rgba(255, 255, 255, 0.02)");
  ctx.fillStyle = cardGradient;
  ctx.fillRect(x, y, width, height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();

  const titleGradient = ctx.createLinearGradient(x, y, x, y + 50);
  titleGradient.addColorStop(0, "rgba(99, 102, 241, 0.2)");
  titleGradient.addColorStop(1, "rgba(99, 102, 241, 0.05)");
  ctx.fillStyle = titleGradient;
  ctx.fillRect(x, y, width, 50);

  ctx.fillStyle = "#ffffff";
  ctx.font = 'bold 22px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText(title, x + 25, y + 33);

  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = '18px Nunito, "Segoe UI", sans-serif';
  content.forEach((line, i) => {
    ctx.fillText(line, x + 25, y + 80 + i * 30);
  });
}

// Draw animated start button
function drawStartButton() {
  const buttonWidth = 350;
  const buttonHeight = 70;
  const buttonX = canvas.width / 2 - buttonWidth / 2;
  const buttonY = canvas.height / 2 + 200;

  ctx.save();

  if (startButtonHover) {
    ctx.shadowColor = "#6366f1";
    ctx.shadowBlur = 30;
  }

  const buttonGradient = ctx.createLinearGradient(
    buttonX,
    buttonY,
    buttonX,
    buttonY + buttonHeight,
  );

  if (startButtonHover) {
    buttonGradient.addColorStop(0, "#9b8fff");
    buttonGradient.addColorStop(1, "#6366f1");
  } else {
    buttonGradient.addColorStop(0, "#7c6ff0");
    buttonGradient.addColorStop(1, "#4f46e5");
  }

  ctx.fillStyle = buttonGradient;
  ctx.beginPath();
  ctx.roundRect(buttonX, buttonY, buttonWidth, buttonHeight, 18);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = 'bold 26px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("BEGIN MISSION  🚀", canvas.width / 2, buttonY + 45);

  if (startButtonHover) {
    const pulse = (Math.sin(animationTime * 0.02) + 1) * 2;
    ctx.strokeStyle = "rgba(129, 140, 248, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(
      buttonX - pulse,
      buttonY - pulse,
      buttonWidth + pulse * 2,
      buttonHeight + pulse * 2,
      18,
    );
    ctx.stroke();
  }
}

// Draw start screen
function drawStartScreen() {
  animationTime++;

  drawGradientBackground();
  drawStarsBackground();

  const centerX = canvas.width / 2;
  const titleY = canvas.height / 4;

  drawGlowingText("SPACE", centerX, titleY, 96, "#7c6ff0");
  drawGlowingText("NAVIGATOR", centerX, titleY + 90, 68, "#a78bfa");

  ctx.fillStyle = "rgba(200, 210, 255, 0.55)";
  ctx.font = '700 20px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("Attention & Focus Assessment", centerX, titleY + 150);

  // Mission briefing card
  const cardWidth = 380;
  const cardX = centerX - cardWidth / 2;
  const cardY = canvas.height / 2 - 80;
  const cardH = 170;

  ctx.save();
  ctx.shadowColor = "rgba(99,102,241,0.4)";
  ctx.shadowBlur = 30;
  const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
  cardGrad.addColorStop(0, "rgba(40, 35, 80, 0.92)");
  cardGrad.addColorStop(1, "rgba(25, 20, 55, 0.92)");
  ctx.fillStyle = cardGrad;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardH, 18);
  ctx.fill();
  ctx.strokeStyle = "rgba(130, 140, 255, 0.35)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#a5b4fc";
  ctx.font = 'bold 19px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("🚀  Your Space Mission", centerX, cardY + 38);

  const missionLines = [
    "👀  Follow the stars with your eyes",
    "🧠  Stay focused, you’ve got this!",
    "🔒  Everything is private and safe",
  ];
  ctx.fillStyle = "rgba(255, 255, 255, 0.82)";
  ctx.font = '17px Nunito, "Segoe UI", sans-serif';
  missionLines.forEach((line, i) => {
    ctx.fillText(line, centerX, cardY + 75 + i * 30);
  });

  drawStartButton();
}

// Draw loading screen
function drawLoadingScreen() {
  animationTime++;

  drawGradientBackground();
  drawStarsBackground();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Semi-transparent overlay
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  // Title
  // Animated rocket icon
  const rocketBob = Math.sin(animationTime * 0.06) * 8;
  ctx.font = "56px serif";
  ctx.textAlign = "center";
  ctx.fillText("🚀", centerX, centerY - 150 + rocketBob);

  drawGlowingText("Getting Ready…", centerX, centerY - 80, 42, "#818cf8");

  // Loading message — remap technical messages to friendly ones
  const friendlyMsg = loadingMessage
    .replace(/initializ\w+/i, "warming up")
    .replace(/eye tracker/i, "the camera")
    .replace(/setting up eye tracking system/i, "almost there!")
    .replace(/system/i, "things");
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.font = '22px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(friendlyMsg, centerX, centerY - 15);

  // Star progress indicators
  const totalStars = 10;
  const filledStars = Math.round((loadingProgress / 100) * totalStars);
  const starSpacing = 36;
  const starsRowX = centerX - ((totalStars - 1) * starSpacing) / 2;
  const starsRowY = centerY + 35;
  ctx.font = "22px serif";
  ctx.textAlign = "center";
  for (let i = 0; i < totalStars; i++) {
    ctx.globalAlpha = i < filledStars ? 1.0 : 0.22;
    ctx.fillText("⭐", starsRowX + i * starSpacing, starsRowY);
  }
  ctx.globalAlpha = 1.0;

  // Animated dots
  const dots = ".".repeat(Math.floor(animationTime / 20) % 4);
  ctx.fillStyle = "rgba(200, 210, 255, 0.65)";
  ctx.font = '18px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`Just a moment${dots}`, centerX, centerY + 80);
}

// Add roundRect polyfill
if (!ctx.roundRect) {
  ctx.constructor.prototype.roundRect = function (x, y, width, height, radius) {
    this.beginPath();
    this.moveTo(x + radius, y);
    this.lineTo(x + width - radius, y);
    this.quadraticCurveTo(x + width, y, x + width, y + radius);
    this.lineTo(x + width, y + height - radius);
    this.quadraticCurveTo(
      x + width,
      y + height,
      x + width - radius,
      y + height,
    );
    this.lineTo(x + radius, y + height);
    this.quadraticCurveTo(x, y + height, x + y + height - radius);
    this.lineTo(x, y + radius);
    this.quadraticCurveTo(x, y, x + radius, y);
    this.closePath();
  };
}

// Start calibration
function startCalibration() {
  if (window.eyeTracker && eyeTrackerReady) {
    console.log("Starting eye tracker calibration...");
    gameState = "calibration";
    window.eyeTracker
      .calibrate()
      .then(() => {
        console.log("Calibration command sent");
      })
      .catch((error) => {
        console.error("Failed to start calibration:", error);
        alert("Failed to start calibration. Please try again.");
        gameState = "start";
      });
  }
}

// Pre-calibration instruction screen (10 seconds, then starts calibration)
function drawCalibrationInstructionScreen() {
  animationTime++;
  drawGradientBackground();
  drawStarsBackground();

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  const elapsed = Date.now() - calibrationInstructionStart;
  const remaining = Math.ceil((10000 - elapsed) / 1000);

  if (elapsed >= 10000) {
    gameState = "calibration";
    calibrationCommandTime = Date.now();
    window.eyeTracker
      .calibrate(canvas.width, canvas.height)
      .catch((err) => console.error("Calibration command failed:", err));
    return;
  }

  // Card
  const cw = 640,
    ch = 420;
  const cx2 = cx - cw / 2,
    cy2 = cy - ch / 2;
  ctx.save();
  ctx.shadowColor = "rgba(99,102,241,0.5)";
  ctx.shadowBlur = 40;
  const grad = ctx.createLinearGradient(cx2, cy2, cx2, cy2 + ch);
  grad.addColorStop(0, "rgba(30,30,60,0.95)");
  grad.addColorStop(1, "rgba(20,20,40,0.95)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(cx2, cy2, cw, ch, 20);
  ctx.fill();
  ctx.strokeStyle = "rgba(99,102,241,0.6)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Emoji header
  ctx.font = "44px serif";
  ctx.textAlign = "center";
  ctx.fillText("👀", cx, cy2 + 60);

  ctx.fillStyle = "#a5b4fc";
  ctx.font = 'bold 32px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("Let's Set Up Your Eyes!", cx, cy2 + 108);

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = '21px Nunito, "Segoe UI", sans-serif';
  ctx.fillText("9 glowing dots will appear on the screen.", cx, cy2 + 158);
  ctx.fillText("Look at each one and hold your gaze still.", cx, cy2 + 188);

  ctx.fillStyle = "rgba(200, 210, 255, 0.75)";
  ctx.font = '18px Nunito, "Segoe UI", sans-serif';
  ctx.fillText("Keep your head still, just move your eyes.", cx, cy2 + 240);
  ctx.fillText("Each dot only takes a moment!", cx, cy2 + 266);

  // Pulsing demo dot
  const pulse = (Math.sin(animationTime * 0.08) + 1) * 0.5;
  ctx.save();
  ctx.shadowColor = "#00ff88";
  ctx.shadowBlur = 20;
  ctx.fillStyle = "#00ff88";
  ctx.beginPath();
  ctx.arc(cx, cy2 + 325, 12 + pulse * 6, 0, Math.PI * 2);
  ctx.fill();
  // White centre
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy2 + 325, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#818cf8";
  ctx.font = 'bold 26px Nunito, "Segoe UI", sans-serif';
  ctx.fillText(`Starting in ${remaining}…`, cx, cy2 + 398);
}

// Draw calibration screen — driven by calibrationDot from Python instructions
function drawCalibrationScreen() {
  animationTime++;
  drawGradientBackground();
  drawStarsBackground();

  const cx = canvas.width / 2;

  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  if (!calibrationDot) {
    // If Python hasn't sent the first dot within 20 seconds, skip calibration
    if (
      calibrationCommandTime > 0 &&
      Date.now() - calibrationCommandTime > 20000
    ) {
      console.warn("Calibration timed out. Proceeding uncalibrated");
      eyeTrackerCalibrated = true;
      calibrationInProgress = false;
      checkAllTrackersReady();
      return;
    }
    // Waiting for first instruction from Python
    ctx.font = "48px serif";
    ctx.textAlign = "center";
    ctx.fillText("👀", cx, canvas.height / 2 - 90);
    drawGlowingText(
      "Getting ready…",
      cx,
      canvas.height / 2 - 20,
      42,
      "#818cf8",
    );
    ctx.fillStyle = "rgba(200,210,255,0.75)";
    ctx.font = '20px Nunito, "Segoe UI", sans-serif';
    ctx.textAlign = "center";
    ctx.fillText("The first dot is on its way!", cx, canvas.height / 2 + 30);
    return;
  }

  const { x, y, point, total } = calibrationDot;

  // Header bar instructions (always visible at top)
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.7)";
  ctx.fillRect(0, 0, canvas.width, 80);
  ctx.fillStyle = "#c7d2fe";
  ctx.font = 'bold 21px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(
    `Dot ${point} of ${total}  ·  Look right at the green dot!`,
    cx,
    45,
  );
  ctx.restore();

  // Progress dots row across top
  const dotSpacing = 28;
  const rowX = cx - ((total - 1) * dotSpacing) / 2;
  for (let i = 0; i < total; i++) {
    ctx.beginPath();
    ctx.arc(rowX + i * dotSpacing, 22, 5, 0, Math.PI * 2);
    ctx.fillStyle = i < point ? "#00ff88" : "rgba(255,255,255,0.2)";
    ctx.fill();
  }

  // Pulsing calibration dot at the instructed position
  const pulse = (Math.sin(animationTime * 0.1) + 1) * 0.5;
  const outerR = 18 + pulse * 8;
  const innerR = 8;

  ctx.save();
  // Outer glow ring
  ctx.strokeStyle = "rgba(0,255,136,0.4)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, outerR + 10, 0, Math.PI * 2);
  ctx.stroke();

  // Main dot
  ctx.shadowColor = "#00ff88";
  ctx.shadowBlur = 30;
  ctx.fillStyle = "#00ff88";
  ctx.beginPath();
  ctx.arc(x, y, outerR, 0, Math.PI * 2);
  ctx.fill();

  // White centre
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(x, y, innerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Show instruction screen before a phase
function showInstructions(phase) {
  gameState = "instructions";
  instructionPhase = phase;
  instructionStartTime = Date.now();
}

// Draw instruction screen
function drawInstructionScreen() {
  drawGradientBackground();
  drawStarsBackground();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Calculate time remaining
  const elapsed = Date.now() - instructionStartTime;
  const remaining = Math.ceil((instructionDuration - elapsed) / 1000);

  // Check if instruction time is up
  if (elapsed >= instructionDuration) {
    if (instructionPhase === "phase1") {
      startPhase1();
    } else if (instructionPhase === "phase2") {
      startPhase2();
    }
    return;
  }

  // Draw semi-transparent overlay
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  // Draw instruction card
  const cardWidth = 600;
  const cardHeight = 400;
  const cardX = centerX - cardWidth / 2;
  const cardY = centerY - cardHeight / 2;

  ctx.save();
  ctx.shadowColor = "rgba(99, 102, 241, 0.5)";
  ctx.shadowBlur = 40;

  const cardGradient = ctx.createLinearGradient(
    cardX,
    cardY,
    cardX,
    cardY + cardHeight,
  );
  cardGradient.addColorStop(0, "rgba(30, 30, 60, 0.95)");
  cardGradient.addColorStop(1, "rgba(20, 20, 40, 0.95)");
  ctx.fillStyle = cardGradient;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 20);
  ctx.fill();

  ctx.strokeStyle = "rgba(99, 102, 241, 0.6)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // Title
  // Phase emoji + title
  ctx.font = "46px serif";
  ctx.textAlign = "center";
  ctx.fillText(
    instructionPhase === "phase1" ? "⭐" : "🎯",
    centerX,
    cardY + 68,
  );

  ctx.fillStyle = "#a5b4fc";
  ctx.font = 'bold 30px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";

  if (instructionPhase === "phase1") {
    ctx.fillText("Round 1 - Star Search!", centerX, cardY + 115);
  } else {
    ctx.fillText("Round 2 - Laser Focus!", centerX, cardY + 115);
  }

  ctx.fillStyle = "#ffffff";
  ctx.font = '22px Nunito, "Segoe UI", sans-serif';

  if (instructionPhase === "phase1") {
    ctx.fillText(
      "When a golden star appears, look right at it.",
      centerX,
      cardY + 165,
    );
    ctx.fillStyle = "rgba(200, 210, 255, 0.85)";
    ctx.font = '19px Nunito, "Segoe UI", sans-serif';
    ctx.fillText(
      "Other things will try to distract you, ignore them!",
      centerX,
      cardY + 220,
    );
    ctx.fillText(
      "Move your eyes only, keep your head still.",
      centerX,
      cardY + 250,
    );
  } else {
    ctx.fillText(
      "A star will appear in the middle of the screen.",
      centerX,
      cardY + 165,
    );
    ctx.fillStyle = "rgba(200, 210, 255, 0.85)";
    ctx.font = '19px Nunito, "Segoe UI", sans-serif';
    ctx.fillText(
      "Keep your eyes locked on it the whole time.",
      centerX,
      cardY + 220,
    );
    ctx.fillText(
      "Try not to move your head, you've got this!",
      centerX,
      cardY + 250,
    );
  }

  // Countdown
  ctx.fillStyle = "#818cf8";
  ctx.font = 'bold 28px Nunito, "Segoe UI", sans-serif';
  ctx.fillText(`Starting in ${remaining}…`, centerX, cardY + 355);
}

// Initialize Phase 1
function startPhase1() {
  // Show initializing screen first
  gameState = "initializing";
  loadingMessage = "Initializing camera...";

  // Small delay to show the message
  setTimeout(() => {
    gameState = "phase1";
    phase1Active = true;
    phase1StartTime = Date.now();
    phase1Timer = 0;
    trackingStars = [];
    distractors = [];
    currentTrackingStar = null;
    lastStarSpawn = 0;
    lastDistractorSpawn = 0;
    lastProximityCheckSecond = -1; // Reset per-second tracking

    // Generate unique session ID for this phase
    sessionId = `phase1_cycle${currentCycle}_${Date.now()}`;

    // Start blink tracking
    if (window.blinkTracker && blinkTrackerReady) {
      console.log("   → Starting blink tracker...");
      window.blinkTracker
        .start(sessionId)
        .then(() => {
          console.log("   ✓ Blink tracking started");
        })
        .catch((error) => {
          console.error("   ❌ Failed to start blink tracking:", error);
        });
    } else {
      console.warn("   ⚠️ Blink tracker not ready or not available");
    }

    // Start head tracking
    if (window.headTracker && headTrackerReady) {
      console.log("   → Starting head tracker...");
      window.headTracker
        .start(sessionId)
        .then(() => {
          console.log("   ✓ Head tracking started");
        })
        .catch((error) => {
          console.error("   ❌ Failed to start head tracking:", error);
        });
    } else {
      console.warn("   ⚠️ Head tracker not ready or not available");
    }

    // Start eye tracking
    if (window.eyeTracker && eyeTrackerReady && eyeTrackerCalibrated) {
      window.eyeTracker
        .start(sessionId)
        .then(() => {
          console.log("Eye tracking started for session:", sessionId);
        })
        .catch((error) => {
          console.error("Failed to start eye tracking:", error);
        });
    } else {
      console.warn("Eye tracker not ready or not calibrated");
    }
  }, 100); // Short delay to show initializing message
}

// Reset to start screen
function resetToStart() {
  gameState = "start";
  phase1Active = false;
  phase2Active = false;
  trackingStars = [];
  distractors = [];
  currentTrackingStar = null;
  fixationStar = null;
  targets = [];
  currentCycle = 1;
  currentPhase = 1;

  blinkData = [];
  gazeData = [];
  headOrientationData = [];
  starProximityData = [];
  perSecondProximityData = [];
  lastProximityCheckSecond = -1;

  // Reset gaze tracking
  currentGazeX = null;
  currentGazeY = null;
  gazeCursorAlpha = 0;

  // Stop all trackers
  if (window.blinkTracker) {
    window.blinkTracker.stop().catch((error) => {
      console.error("Failed to stop blink tracking:", error);
    });
  }

  if (window.headTracker) {
    window.headTracker.stop().catch((error) => {
      console.error("Failed to stop head tracking:", error);
    });
  }

  if (window.eyeTracker) {
    window.eyeTracker
      .stop()
      .then(() => {
        console.log("Eye tracking stopped");
      })
      .catch((error) => {
        console.error("Failed to stop eye tracking:", error);
      });
  }
}

function spawnTrackingStar() {
  const marginX = 150;
  const marginY = 150;

  const star = {
    x: Math.random() * (canvas.width - marginX * 2) + marginX,
    y: Math.random() * (canvas.height - marginY * 2) + marginY,
    radius: 20,
    lifetime: 0,
    active: true,
  };
  trackingStars.push(star);
  currentTrackingStar = star;

  // Record gaze data with phase information
  gazeData.push({
    timestamp: Date.now() - phase1StartTime,
    starPosition: { x: star.x, y: star.y },
    type: "star_spawn",
    phase: 1,
    cycle: currentCycle,
    sessionId: sessionId,
  });
}

// Spawn a distractor comet
function spawnDistractor() {
  const fromLeft = Math.random() > 0.5;
  const distractor = {
    x: fromLeft ? -50 : canvas.width + 50,
    y: Math.random() * (canvas.height - 200) + 50,
    vx: fromLeft ? Math.random() * 4 + 3 : -(Math.random() * 4 + 3),
    vy: (Math.random() - 0.5) * 2,
    radius: 15,
    flashPhase: 0,
    trail: [],
    active: true,
  };
  distractors.push(distractor);

  // Record gaze data with phase information
  gazeData.push({
    timestamp: Date.now() - phase1StartTime,
    distractorPosition: { x: distractor.x, y: distractor.y },
    type: "distractor_spawn",
    phase: 1,
    cycle: currentCycle,
    sessionId: sessionId,
  });
}

function updateTrackingStars() {
  trackingStars.forEach((star, index) => {
    star.lifetime++;

    // Remove stars after 5 seconds or when new star spawns
    if (
      star.lifetime > 60 * 5 ||
      (currentTrackingStar !== star && star.lifetime > 60)
    ) {
      star.active = false;
      trackingStars.splice(index, 1);
    }
  });
}

// Update distractors
function updateDistractors() {
  distractors.forEach((distractor, index) => {
    distractor.x += distractor.vx;
    distractor.y += distractor.vy;
    distractor.flashPhase += 0.1;

    // Add trail
    distractor.trail.push({ x: distractor.x, y: distractor.y });
    if (distractor.trail.length > 15) {
      distractor.trail.shift();
    }

    // Remove if off screen
    if (
      distractor.x < -100 ||
      distractor.x > canvas.width + 100 ||
      distractor.y < -100 ||
      distractor.y > canvas.height + 100
    ) {
      distractor.active = false;
      distractors.splice(index, 1);
    }
  });
}

// Draw gaze cursor (only in dev mode)
function drawGazeCursor() {
  if (!devMode) return;
  if (currentGazeX === null || currentGazeY === null) return;

  // Fade in quickly
  if (gazeCursorAlpha < 1.0) {
    gazeCursorAlpha = Math.min(gazeCursorAlpha + 0.2, 1.0); // Faster fade-in
  }

  if (gazeCursorAlpha <= 0) return;

  const radius = 12;

  ctx.save();
  ctx.globalAlpha = gazeCursorAlpha;

  // Outer ring
  ctx.strokeStyle = "#00D4FF";
  ctx.lineWidth = 3;
  ctx.shadowColor = "#00D4FF";
  ctx.shadowBlur = 15;
  ctx.beginPath();
  ctx.arc(currentGazeX, currentGazeY, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Inner dot
  ctx.fillStyle = "#00D4FF";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(currentGazeX, currentGazeY, 4, 0, Math.PI * 2);
  ctx.fill();

  // Crosshair
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 2;
  ctx.shadowBlur = 5;
  ctx.beginPath();
  ctx.moveTo(currentGazeX - radius - 5, currentGazeY);
  ctx.lineTo(currentGazeX - radius + 2, currentGazeY);
  ctx.moveTo(currentGazeX + radius - 2, currentGazeY);
  ctx.lineTo(currentGazeX + radius + 5, currentGazeY);
  ctx.moveTo(currentGazeX, currentGazeY - radius - 5);
  ctx.lineTo(currentGazeX, currentGazeY - radius + 2);
  ctx.moveTo(currentGazeX, currentGazeY + radius - 2);
  ctx.lineTo(currentGazeX, currentGazeY + radius + 5);
  ctx.stroke();

  ctx.restore();
}

// Check proximity between gaze and stars
function checkStarProximity() {
  if (currentGazeX === null || currentGazeY === null) return;
  if (!phase1Active) return;

  const proximityThreshold = 200; // 200px threshold
  const currentTimeMs = Date.now() - phase1StartTime;
  const currentSecond = Math.floor(currentTimeMs / 1000);

  let isWithinProximity = false;
  let closestDistance = Infinity;
  let closestStar = null;

  trackingStars.forEach((star) => {
    const dx = currentGazeX - star.x;
    const dy = currentGazeY - star.y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance <= proximityThreshold) {
      isWithinProximity = true;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestStar = star;
      }

      // Save detailed proximity data (every frame when within range)
      const proximityEntry = {
        timestamp: currentTimeMs,
        gazeX: currentGazeX,
        gazeY: currentGazeY,
        starX: star.x,
        starY: star.y,
        distance: distance,
        phase: 1,
        cycle: currentCycle,
        sessionId: sessionId,
      };
      starProximityData.push(proximityEntry);
    }
  });

  // Aggregate data per second
  if (currentSecond !== lastProximityCheckSecond) {
    const perSecondEntry = {
      second: currentSecond,
      timestamp: currentTimeMs,
      withinProximity: isWithinProximity,
      closestDistance: isWithinProximity ? closestDistance : null,
      closestStarX: closestStar ? closestStar.x : null,
      closestStarY: closestStar ? closestStar.y : null,
      gazeX: currentGazeX,
      gazeY: currentGazeY,
      phase: 1,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    perSecondProximityData.push(perSecondEntry);
    lastProximityCheckSecond = currentSecond;
  }
}

function drawTrackingStars() {
  trackingStars.forEach((star) => {
    ctx.save();

    // Outer glow
    ctx.shadowColor = "#FFD700";
    ctx.shadowBlur = 30;

    // Star gradient
    const gradient = ctx.createRadialGradient(
      star.x,
      star.y,
      0,
      star.x,
      star.y,
      star.radius,
    );
    gradient.addColorStop(0, "#FFFFFF");
    gradient.addColorStop(0.3, "#FFD700");
    gradient.addColorStop(1, "rgba(255, 215, 0, 0.3)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw star points
    ctx.fillStyle = "#FFFFFF";
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const x1 = star.x + Math.cos(angle) * star.radius * 1.5;
      const y1 = star.y + Math.sin(angle) * star.radius * 1.5;
      const x2 = star.x + Math.cos(angle + Math.PI / 5) * star.radius * 0.6;
      const y2 = star.y + Math.sin(angle + Math.PI / 5) * star.radius * 0.6;
      const x3 = star.x + Math.cos(angle - Math.PI / 5) * star.radius * 0.6;
      const y3 = star.y + Math.sin(angle - Math.PI / 5) * star.radius * 0.6;

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineTo(star.x, star.y);
      ctx.lineTo(x3, y3);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  });
}

// Draw distractors
function drawDistractors() {
  distractors.forEach((distractor) => {
    ctx.save();

    // Draw trail
    ctx.strokeStyle = "rgba(255, 100, 100, 0.3)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    distractor.trail.forEach((point, i) => {
      if (i === 0) {
        ctx.moveTo(point.x, point.y);
      } else {
        ctx.lineTo(point.x, point.y);
      }
    });
    ctx.stroke();

    // Flashing effect
    const flash = Math.abs(Math.sin(distractor.flashPhase));
    const alpha = 0.5 + flash * 0.5;

    ctx.globalAlpha = alpha;
    ctx.shadowColor = "#FF6464";
    ctx.shadowBlur = 20;

    // Comet gradient
    const gradient = ctx.createRadialGradient(
      distractor.x,
      distractor.y,
      0,
      distractor.x,
      distractor.y,
      distractor.radius,
    );
    gradient.addColorStop(0, "#FFFFFF");
    gradient.addColorStop(0.3, "#FF6464");
    gradient.addColorStop(1, "rgba(255, 100, 100, 0.3)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(distractor.x, distractor.y, distractor.radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw comet tail
    const tailLength = 40;
    const tailAngle = Math.atan2(distractor.vy, distractor.vx) + Math.PI;
    const tailX = distractor.x + Math.cos(tailAngle) * tailLength;
    const tailY = distractor.y + Math.sin(tailAngle) * tailLength;

    const tailGradient = ctx.createLinearGradient(
      distractor.x,
      distractor.y,
      tailX,
      tailY,
    );
    tailGradient.addColorStop(0, "rgba(255, 100, 100, 0.6)");
    tailGradient.addColorStop(1, "rgba(255, 100, 100, 0)");

    ctx.fillStyle = tailGradient;
    ctx.beginPath();
    ctx.moveTo(distractor.x, distractor.y);
    ctx.lineTo(tailX + 10, tailY);
    ctx.lineTo(tailX - 10, tailY);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  });
}

// Phase 1 game loop
function phase1Loop(currentTime) {
  phase1Timer = currentTime - phase1StartTime;

  if (phase1Timer >= phase1Duration) {
    completePhase1();
    return;
  }

  if (currentTime - lastStarSpawn >= starSpawnInterval) {
    spawnTrackingStar();
    lastStarSpawn = currentTime;
  }

  if (currentTime - lastDistractorSpawn >= distractorSpawnInterval) {
    spawnDistractor();
    lastDistractorSpawn = currentTime;
  }

  updateTrackingStars();
  updateDistractors();

  // Check proximity between gaze and stars
  checkStarProximity();

  // Draw
  drawGradientBackground();
  drawStarsBackground();
  drawTrackingStars();
  drawDistractors();
  drawGazeCursor(); // Show where user is looking
}

function completePhase1() {
  console.log(`Phase 1 Complete! (Cycle ${currentCycle})`);
  console.log(
    `Total Gaze Events: ${
      gazeData.filter((d) => d.phase === 1 && d.cycle === currentCycle).length
    }`,
  );
  console.log(
    `Total Blinks in Phase 1: ${
      blinkData.filter((d) => d.phase === 1 && d.cycle === currentCycle).length
    }`,
  );
  console.log(
    `Total Star Proximity Events: ${
      starProximityData.filter((d) => d.phase === 1 && d.cycle === currentCycle)
        .length
    }`,
  );

  phase1Active = false;

  const stopPromises = [];

  if (window.blinkTracker) {
    stopPromises.push(
      window.blinkTracker.stop().catch((error) => {
        console.error("Failed to stop blink tracking:", error);
      }),
    );
  }

  if (window.headTracker) {
    stopPromises.push(
      window.headTracker.stop().catch((error) => {
        console.error("Failed to stop head tracking:", error);
      }),
    );
  }

  if (window.eyeTracker) {
    stopPromises.push(
      window.eyeTracker.stop().catch((error) => {
        console.error("Failed to stop eye tracking:", error);
      }),
    );
  }

  Promise.all(stopPromises)
    .then(() => {
      console.log("All trackers stopped");
      showInstructions("phase2");
    })
    .catch(() => {
      showInstructions("phase2");
    });
}

function startPhase2() {
  gameState = "phase2";
  phase2Active = true;
  phase2StartTime = Date.now();
  phase2Timer = 0;

  sessionId = `phase2_cycle${currentCycle}_${Date.now()}`;

  fixationStar = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    radius: 25,
  };

  progressMeter = {
    x: 50,
    y: canvas.height / 2,
    radius: 25,
    startX: 50,
    endX: canvas.width - 50,
  };

  console.log("🚀 Starting Phase 2 - Session ID:", sessionId);

  if (window.blinkTracker && blinkTrackerReady) {
    console.log("   → Starting blink tracker for Phase 2...");
    window.blinkTracker
      .start(sessionId)
      .then(() => {
        console.log("   ✓ Blink tracking started for Phase 2");
      })
      .catch((error) => {
        console.error("   ❌ Failed to start blink tracking:", error);
      });
  } else {
    console.warn("   ⚠️ Blink tracker not ready for Phase 2");
  }

  if (window.headTracker && headTrackerReady) {
    console.log("   → Starting head tracker for Phase 2...");
    window.headTracker
      .start(sessionId)
      .then(() => {
        console.log("   ✓ Head tracking started for Phase 2");
      })
      .catch((error) => {
        console.error("   ❌ Failed to start head tracking:", error);
      });
  } else {
    console.warn("   ⚠️ Head tracker not ready for Phase 2");
  }

  // Start eye tracking for Phase 2
  if (window.eyeTracker && eyeTrackerReady && eyeTrackerCalibrated) {
    window.eyeTracker
      .start(sessionId)
      .then(() => {
        console.log("Eye tracking started for Phase 2 session:", sessionId);
      })
      .catch((error) => {
        console.error("Failed to start eye tracking:", error);
      });
  } else {
    console.warn("Eye tracker not ready or not calibrated");
  }
}

function drawFixationStar() {
  if (!fixationStar) return;

  const star = fixationStar;
  const radius = star.radius;

  ctx.save();

  // Outer glow
  ctx.shadowColor = "#ffc400ff";
  ctx.shadowBlur = 40;

  // Star gradient - yellow/gold
  const gradient = ctx.createRadialGradient(
    star.x,
    star.y,
    0,
    star.x,
    star.y,
    radius,
  );
  gradient.addColorStop(0, "#FFFFFF");
  gradient.addColorStop(0.3, "#ffd900ff");
  gradient.addColorStop(1, "rgba(255, 215, 0, 0.4)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Draw star points
  ctx.fillStyle = "#FFED4E";
  for (let i = 0; i < 5; i++) {
    const angle = (i * Math.PI * 2) / 5 - Math.PI / 2;
    const x1 = star.x + Math.cos(angle) * radius * 1.5;
    const y1 = star.y + Math.sin(angle) * radius * 1.5;
    const x2 = star.x + Math.cos(angle + Math.PI / 5) * radius * 0.6;
    const y2 = star.y + Math.sin(angle + Math.PI / 5) * radius * 0.6;
    const x3 = star.x + Math.cos(angle - Math.PI / 5) * radius * 0.6;
    const y3 = star.y + Math.sin(angle - Math.PI / 5) * radius * 0.6;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(star.x, star.y);
    ctx.lineTo(x3, y3);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

function drawProgressMeter() {
  if (!progressMeter) return;

  const meter = progressMeter;
  const radius = meter.radius;

  ctx.save();

  // Outer glow
  ctx.shadowColor = "#00D4FF";
  ctx.shadowBlur = 30;

  // Meter gradient - blue/cyan
  const gradient = ctx.createRadialGradient(
    meter.x,
    meter.y,
    0,
    meter.x,
    meter.y,
    radius,
  );
  gradient.addColorStop(0, "#FFFFFF");
  gradient.addColorStop(0.3, "#00D4FF");
  gradient.addColorStop(1, "rgba(0, 212, 255, 0.4)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(meter.x, meter.y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Draw circle border
  ctx.strokeStyle = "#00D4FF";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.restore();
}

// Draw static background (no moving stars)
function drawStaticStarsBackground() {
  stars.forEach((star) => {
    ctx.save();
    ctx.globalAlpha = star.opacity;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

function phase2Loop(currentTime) {
  phase2Timer = currentTime - phase2StartTime;

  if (phase2Timer >= phase2Duration) {
    completePhase2();
    return;
  }

  if (progressMeter) {
    const progress = phase2Timer / phase2Duration;
    progressMeter.x =
      progressMeter.startX +
      (progressMeter.endX - progressMeter.startX) * progress;
  }

  drawGradientBackground();
  drawStaticStarsBackground();
  drawFixationStar();
  drawProgressMeter();
  drawGazeCursor(); // Show where user is looking
}

function completePhase2() {
  console.log(`Phase 2 Complete! (Cycle ${currentCycle})`);
  console.log(
    `Total Head Orientation Events: ${
      headOrientationData.filter(
        (d) => d.phase === 2 && d.cycle === currentCycle,
      ).length
    }`,
  );
  console.log(
    `Total Blinks in Phase 2: ${
      blinkData.filter((d) => d.phase === 2 && d.cycle === currentCycle).length
    }`,
  );

  phase2Active = false;

  const stopPromises = [];

  if (window.blinkTracker) {
    stopPromises.push(
      window.blinkTracker.stop().catch((error) => {
        console.error("Failed to stop blink tracking:", error);
      }),
    );
  }

  if (window.headTracker) {
    stopPromises.push(
      window.headTracker.stop().catch((error) => {
        console.error("Failed to stop head tracking:", error);
      }),
    );
  }

  if (window.eyeTracker) {
    stopPromises.push(
      window.eyeTracker.stop().catch((error) => {
        console.error("Failed to stop eye tracking:", error);
      }),
    );
  }

  Promise.all(stopPromises)
    .then(() => {
      console.log("All trackers stopped");
      proceedAfterPhase2();
    })
    .catch(() => {
      proceedAfterPhase2();
    });
}

function proceedAfterPhase2() {
  if (currentCycle < totalCycles) {
    currentCycle++;
    showInstructions("phase1");
  } else {
    console.log("=== TEST COMPLETE ===");
    console.log(`Total Blinks Recorded: ${blinkData.length}`);
    console.log(`Total Gaze Events Recorded: ${gazeData.length}`);
    console.log(`Total Head Orientation Events: ${headOrientationData.length}`);
    console.log(`Total Star Proximity Events: ${starProximityData.length}`);
    console.log("Blink Data:", blinkData);
    console.log("Gaze Data:", gazeData);
    console.log("Head Orientation Data:", headOrientationData);
    console.log("Star Proximity Data:", starProximityData);

    showCompletionScreen();
  }
}

function showCompletionScreen() {
  gameState = "complete";

  const assessmentData = {
    cyclesCompleted: totalCycles,
    sessionId: sessionId,
    completedAt: new Date().toISOString(),
    blinkData: blinkData,
    gazeData: gazeData,
    headOrientationData: headOrientationData,
    starProximityData: starProximityData,
    perSecondProximityData: perSecondProximityData,
    totalBlinks: blinkData.length,
    totalGazeEvents: gazeData.length,
    totalHeadOrientationEvents: headOrientationData.length,
    totalStarProximityEvents: starProximityData.length,
    totalPerSecondProximityChecks: perSecondProximityData.length,
  };

  localStorage.setItem("aceAssessmentData", JSON.stringify(assessmentData));
  console.log("✓ Assessment data saved to localStorage");
  console.log("   Total Blinks:", blinkData.length);
  console.log("   Total Gaze Events:", gazeData.length);
  console.log("   Total Head Movements:", headOrientationData.length);
  console.log("   Total Star Proximity Events:", starProximityData.length);
  console.log("   Per-Second Proximity Checks:", perSecondProximityData.length);
  console.log("   Blink Data Sample:", blinkData.slice(0, 3));
  console.log("   Head Data Sample:", headOrientationData.slice(0, 3));
  console.log(
    "   Per-Second Proximity Sample:",
    perSecondProximityData.slice(0, 5),
  );
}

function drawCompletionScreen() {
  animationTime++;

  drawGradientBackground();
  drawStarsBackground();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Sparkle rings that expand outward
  const rings = 3;
  for (let r = 0; r < rings; r++) {
    const phase =
      (animationTime * 0.015 + r * ((Math.PI * 2) / rings)) % (Math.PI * 2);
    const radius = 100 + Math.sin(phase) * 60 + r * 40;
    ctx.save();
    ctx.globalAlpha = 0.12 - r * 0.03;
    ctx.strokeStyle = "#818cf8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(centerX, centerY - 80, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Trophy + title
  ctx.font = "68px serif";
  ctx.textAlign = "center";
  ctx.fillText("🏆", centerX, centerY - 185);

  drawGlowingText("Mission Complete!", centerX, centerY - 110, 62, "#818cf8");

  // Success message
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.font = 'bold 28px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(
    "Amazing work! You're a real Space Navigator! 🌟",
    centerX,
    centerY - 28,
  );

  // Instruction text
  ctx.fillStyle = "rgba(200, 210, 255, 0.75)";
  ctx.font = '21px Nunito, "Segoe UI", sans-serif';
  ctx.fillText(
    "All done! Let your doctor know you've finished.",
    centerX,
    centerY + 20,
  );

  // Draw data button
  const buttonWidth = 250;
  const buttonHeight = 60;
  const buttonX = centerX - buttonWidth / 2;
  const buttonY = centerY + 150;

  ctx.save();

  if (dataButtonHover) {
    ctx.shadowColor = "#818cf8";
    ctx.shadowBlur = 30;
  }

  const buttonGradient = ctx.createLinearGradient(
    buttonX,
    buttonY,
    buttonX,
    buttonY + buttonHeight,
  );

  if (dataButtonHover) {
    buttonGradient.addColorStop(0, "#818cf8");
    buttonGradient.addColorStop(1, "#6366f1");
  } else {
    buttonGradient.addColorStop(0, "#6366f1");
    buttonGradient.addColorStop(1, "#4f46e5");
  }

  ctx.fillStyle = buttonGradient;
  ctx.beginPath();
  ctx.roundRect(buttonX, buttonY, buttonWidth, buttonHeight, 12);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = 'bold 22px Nunito, "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("View Results  📋", centerX, buttonY + 38);

  if (dataButtonHover) {
    const pulse = (Math.sin(animationTime * 0.02) + 1) * 2;
    ctx.strokeStyle = "rgba(129, 140, 248, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(
      buttonX - pulse,
      buttonY - pulse,
      buttonWidth + pulse * 2,
      buttonHeight + pulse * 2,
      15,
    );
    ctx.stroke();
  }
}

function showDataSummary() {
  window.location.href = "results.html";
}

// ── Developer overlay ─────────────────────────────────────────────────────

function draw3DHead(cx, cy, pitch, yaw, roll) {
  const p = (pitch * Math.PI) / 180;
  const y = (yaw * Math.PI) / 180;
  const r = (roll * Math.PI) / 180;

  const W = 22,
    H = 30,
    D = 18;
  const verts = [
    [-W, -H, -D],
    [W, -H, -D],
    [W, H, -D],
    [-W, H, -D], // back
    [-W, -H, D],
    [W, -H, D],
    [W, H, D],
    [-W, H, D], // front
  ];

  function project([x0, y0, z0]) {
    // Roll (Z axis)
    let x1 = x0 * Math.cos(r) - y0 * Math.sin(r);
    let y1 = x0 * Math.sin(r) + y0 * Math.cos(r);
    // Pitch (X axis)
    let y2 = y1 * Math.cos(p) - z0 * Math.sin(p);
    let z2 = y1 * Math.sin(p) + z0 * Math.cos(p);
    // Yaw (Y axis)
    let x3 = x1 * Math.cos(y) + z2 * Math.sin(y);
    let z3 = -x1 * Math.sin(y) + z2 * Math.cos(y);
    // Simple perspective
    const fov = 160 / (160 + z3);
    return [cx + x3 * fov, cy + y2 * fov];
  }

  const pts = verts.map(project);
  const edges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0], // back face
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4], // front face
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7], // connecting edges
  ];

  ctx.save();
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 1.5;
  ctx.shadowColor = "#00ff88";
  ctx.shadowBlur = 6;
  edges.forEach(([a, b]) => {
    ctx.beginPath();
    ctx.moveTo(pts[a][0], pts[a][1]);
    ctx.lineTo(pts[b][0], pts[b][1]);
    ctx.stroke();
  });

  // Red dot marks the "nose" on the front face centre
  const nosePts = [pts[4], pts[5], pts[6], pts[7]];
  const nx = nosePts.reduce((s, p) => s + p[0], 0) / 4;
  const ny = nosePts.reduce((s, p) => s + p[1], 0) / 4;
  ctx.fillStyle = "#ff4444";
  ctx.shadowColor = "#ff4444";
  ctx.beginPath();
  ctx.arc(nx, ny, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawDevOverlay() {
  const PAD = 14;
  const PW = 210;
  const PH = 300;
  const PX = canvas.width - PW - PAD;
  const PY = PAD;

  ctx.save();

  // Panel background
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.strokeStyle = "#00ff88";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(PX, PY, PW, PH, 8);
  ctx.fill();
  ctx.stroke();

  // Title
  ctx.fillStyle = "#00ff88";
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "left";
  ctx.shadowColor = "#00ff88";
  ctx.shadowBlur = 4;
  ctx.fillText("DEV MODE  [R to toggle]", PX + 10, PY + 18);

  ctx.shadowBlur = 0;

  // ── Blink indicator (1 s stickiness) ────────────────────────────────
  const blinkAge = Date.now() - lastBlinkTime;
  if (blinkAge < BLINK_STICKY_MS) {
    const alpha = 1 - blinkAge / BLINK_STICKY_MS;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#ffff00";
    ctx.font = "bold 15px monospace";
    ctx.shadowColor = "#ffff00";
    ctx.shadowBlur = 8;
    ctx.fillText("● BLINK", PX + 10, PY + 40);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "12px monospace";
    ctx.fillText("○ blink", PX + 10, PY + 40);
  }

  // ── Head pose angles ──────────────────────────────────────────────────
  ctx.fillStyle = "#ffffff";
  ctx.font = "11px monospace";
  const lp = lastHeadPose;
  ctx.fillText(`Pitch : ${(lp.pitch || 0).toFixed(1)}°`, PX + 10, PY + 62);
  ctx.fillText(`Yaw   : ${(lp.yaw || 0).toFixed(1)}°`, PX + 10, PY + 78);
  ctx.fillText(`Roll  : ${(lp.roll || 0).toFixed(1)}°`, PX + 10, PY + 94);

  // ── Gaze position ─────────────────────────────────────────────────────
  if (currentGazeX !== null) {
    ctx.fillStyle = "#00D4FF";
    ctx.fillText(
      `Gaze  : (${Math.round(currentGazeX)}, ${Math.round(currentGazeY)})`,
      PX + 10,
      PY + 114,
    );
  } else {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillText("Gaze  : --", PX + 10, PY + 114);
  }

  // ── 3-D head wireframe ────────────────────────────────────────────────
  draw3DHead(PX + PW / 2, PY + 210, lp.pitch || 0, lp.yaw || 0, lp.roll || 0);

  ctx.restore();
}

// ── Main game loop ────────────────────────────────────────────────────────

function gameLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  switch (gameState) {
    case "loading":
    case "initializing":
      drawLoadingScreen();
      break;
    case "start":
      drawStartScreen();
      break;
    case "calibration_instructions":
      drawCalibrationInstructionScreen();
      break;
    case "calibration":
      drawCalibrationScreen();
      break;
    case "instructions":
      drawInstructionScreen();
      break;
    case "complete":
      drawCompletionScreen();
      break;
    case "phase1":
      phase1Loop(Date.now());
      break;
    case "phase2":
      phase2Loop(Date.now());
      break;
    default:
      drawGradientBackground();
      drawStarsBackground();
      animationTime++;
  }

  // Dev overlay only during active game phases
  if (devMode && (gameState === "phase1" || gameState === "phase2")) {
    drawGazeCursor();
    drawDevOverlay();
  }

  requestAnimationFrame(gameLoop);
}

// Start the game
gameLoop();
