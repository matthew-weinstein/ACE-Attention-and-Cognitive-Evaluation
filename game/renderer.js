const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// Game variables
let targets = [];
let keys = {};
let gameState = "start"; // 'start', 'instructions', 'phase1', 'phase2', 'complete'
let animationTime = 0;
let stars = [];
let mousePos = { x: 0, y: 0 };
let startButtonHover = false;
let dataButtonHover = false;

// Instruction screen variables
let instructionPhase = null; // 'phase1' or 'phase2'
let instructionStartTime = 0;
let instructionDuration = 10000; // 10 seconds

// Game cycle variables
let currentCycle = 1;
let totalCycles = 1;
let currentPhase = 1; // 1 or 2

// Phase 1: Visual Search variables
let phase1Active = false;
let phase1Timer = 0;
let phase1Duration = 30000; // 30 seconds in milliseconds
let phase1StartTime = 0;
let trackingStars = []; // Stars to track with eyes
let distractors = []; // Flashing comets as distractors
let currentTrackingStar = null;
let starSpawnInterval = 5000; // Spawn a new star every 2 seconds
let lastStarSpawn = 0;
let distractorSpawnInterval = 1000; // Spawn distractors every 3 seconds
let lastDistractorSpawn = 0;

// Phase 2: Fixation Task variables
let phase2Active = false;
let phase2Timer = 0;
let phase2Duration = 15000; // 15 seconds in milliseconds
let phase2StartTime = 0;
let fixationStar = null; // The static yellow star to stare at
let progressMeter = null; // Moving progress indicator

let blinkData = [];
let gazeData = [];
let headOrientationData = [];

let blinkTrackerReady = false;
let headTrackerReady = false;
let sessionId = null;

if (window.blinkTracker) {
  window.blinkTracker.onReady((data) => {
    console.log("Blink tracker ready:", data);
    blinkTrackerReady = true;
  });

  window.blinkTracker.onBlinkDetected((data) => {
    console.log("👁️ BLINK DETECTED!", data);

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

if (window.headTracker) {
  console.log("✓ window.headTracker is available");
  
  window.headTracker.onReady((data) => {
    console.log("✓ Head tracker READY:", data);
    headTrackerReady = true;
  });

  window.headTracker.onHeadPoseDetected((data) => {
    const headEntry = {
      ...data,
      phase: phase1Active ? 1 : phase2Active ? 2 : null,
      cycle: currentCycle,
      sessionId: sessionId,
    };
    headOrientationData.push(headEntry);
    
    if (headOrientationData.length % 100 === 0) {
      console.log(`   📊 Head data collected: ${headOrientationData.length} entries`);
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

setInterval(() => {
  if (phase1Active || phase2Active) {
    console.log('📊 DATA STATUS:', {
      phase: phase1Active ? 1 : phase2Active ? 2 : 0,
      cycle: currentCycle,
      blinkCount: blinkData.length,
      headCount: headOrientationData.length,
      gazeCount: gazeData.length
    });
  }
}, 10000);

function initStars() {
  stars = [];
  for (let i = 0; i < 200; i++) {
    stars.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      size: Math.random() * 2,
      speed: Math.random() * 0.5 + 0.1,
      opacity: Math.random() * 0.8 + 0.2,
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

// Click handler
canvas.addEventListener("click", (e) => {
  if (gameState === "start" && startButtonHover) {
    showInstructions("phase1");
    canvas.style.cursor = "default";
  }
  if (gameState === "complete" && dataButtonHover) {
    showDataSummary();
  }
});

// Key controls
document.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (gameState === "start" && e.code === "Enter") {
    showInstructions("phase1");
  }
  // ESC to return to menu
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

// Draw animated stary background
function drawStarsBackground() {
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

// Create gradient background
function drawGradientBackground() {
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#0a0e27");
  gradient.addColorStop(0.5, "#151b3d");
  gradient.addColorStop(1, "#1a1042");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Draw glowing text
function drawGlowingText(text, x, y, fontSize, color, glow = true) {
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = `bold ${fontSize}px 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`;

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
  ctx.font = 'bold 22px "Segoe UI", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText(title, x + 25, y + 33);

  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = '18px "Segoe UI", sans-serif';
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
    buttonY + buttonHeight
  );

  if (startButtonHover) {
    buttonGradient.addColorStop(0, "#818cf8");
    buttonGradient.addColorStop(1, "#6366f1");
  } else {
    buttonGradient.addColorStop(0, "#6366f1");
    buttonGradient.addColorStop(1, "#4f46e5");
  }

  ctx.fillStyle = buttonGradient;
  ctx.beginPath();
  ctx.roundRect(buttonX, buttonY, buttonWidth, buttonHeight, 15);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();

  ctx.fillStyle = "#ffffff";
  ctx.font = 'bold 28px "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("START GAME", canvas.width / 2, buttonY + 45);

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
      18
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

  drawGlowingText("SPACE", centerX, titleY, 96, "#6366f1");
  drawGlowingText("NAVIGATOR", centerX, titleY + 90, 64, "#818cf8");

  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.font = '20px "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("Attention and Cognitive Evalution", centerX, titleY + 150);

  // Center cards
  const cardWidth = 330;
  const cardX = centerX - cardWidth / 2;

  drawCard(
    cardX,
    canvas.height / 2 - 75,
    cardWidth,
    160,
    "⚠️ Important Notice",
    [
      "This game is a screening tool only.",
      "It does not diagnose or test ability.",
      "All data is confidential and secure.",
    ]
  );

  drawStartButton();
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
      y + height
    );
    this.lineTo(x + radius, y + height);
    this.quadraticCurveTo(x, y + height, x, y + height - radius);
    this.lineTo(x, y + radius);
    this.quadraticCurveTo(x, y, x + radius, y);
    this.closePath();
  };
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
    cardY + cardHeight
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
  ctx.fillStyle = "#818cf8";
  ctx.font = 'bold 40px "Segoe UI", sans-serif';
  ctx.textAlign = "center";

  if (instructionPhase === "phase1") {
    ctx.fillText(`Phase 1 - Visual Search`, centerX, cardY + 80);
  } else {
    ctx.fillText(`Phase 2 - Fixation Task`, centerX, cardY + 80);
  }

  // Instructions
  ctx.fillStyle = "#ffffff";
  ctx.font = '24px "Segoe UI", sans-serif';

  if (instructionPhase === "phase1") {
    ctx.fillText(
      "Look at the golden stars with your eyes",
      centerX,
      cardY + 150
    );
    ctx.fillText("when they appear on the screen", centerX, cardY + 185);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.font = '22px "Segoe UI", sans-serif';
    ctx.fillText("Ignore the flashing comets", centerX, cardY + 250);
    ctx.fillText(
      "Move yours eyes only, do NOT move your head",
      centerX,
      cardY + 280
    );
  } else {
    ctx.fillText("Stare at the gold star", centerX, cardY + 150);
    ctx.fillText("in the center of the screen", centerX, cardY + 185);
    ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    ctx.font = '22px "Segoe UI", sans-serif';
    ctx.fillText("Keep your eyes focused on it", centerX, cardY + 250);
    ctx.fillText("Stay as still as possible", centerX, cardY + 280);
  }

  // Countdown
  ctx.fillStyle = "#6366f1";
  ctx.font = 'bold 32px "Segoe UI", sans-serif';
  ctx.fillText(`Starting in ${remaining}...`, centerX, cardY + 355);
}

// Initialize Phase 1
function startPhase1() {
  gameState = "phase1";
  phase1Active = true;
  phase1StartTime = Date.now();
  phase1Timer = 0;
  trackingStars = [];
  distractors = [];
  currentTrackingStar = null;
  lastStarSpawn = 0;
  lastDistractorSpawn = 0;

  sessionId = `phase1_cycle${currentCycle}_${Date.now()}`;
  
  console.log("🚀 Starting Phase 1 - Session ID:", sessionId);
  console.log("   Blink tracker ready?", blinkTrackerReady);
  console.log("   Head tracker ready?", headTrackerReady);
  
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
      star.radius
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
      distractor.radius
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
      tailY
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

  drawGradientBackground();
  drawStarsBackground();
  drawTrackingStars();
  drawDistractors();
}

function completePhase1() {
  console.log(`Phase 1 Complete! (Cycle ${currentCycle})`);
  console.log(
    `Total Gaze Events: ${
      gazeData.filter((d) => d.phase === 1 && d.cycle === currentCycle).length
    }`
  );
  console.log(
    `Total Blinks in Phase 1: ${
      blinkData.filter((d) => d.phase === 1 && d.cycle === currentCycle).length
    }`
  );

  phase1Active = false;

  const stopPromises = [];
  
  if (window.blinkTracker) {
    stopPromises.push(
      window.blinkTracker.stop().catch((error) => {
        console.error("Failed to stop blink tracking:", error);
      })
    );
  }

  if (window.headTracker) {
    stopPromises.push(
      window.headTracker.stop().catch((error) => {
        console.error("Failed to stop head tracking:", error);
      })
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
    radius
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
    radius
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
}

function completePhase2() {
  console.log(`Phase 2 Complete! (Cycle ${currentCycle})`);
  console.log(
    `Total Head Orientation Events: ${
      headOrientationData.filter(
        (d) => d.phase === 2 && d.cycle === currentCycle
      ).length
    }`
  );
  console.log(
    `Total Blinks in Phase 2: ${
      blinkData.filter((d) => d.phase === 2 && d.cycle === currentCycle).length
    }`
  );

  phase2Active = false;

  const stopPromises = [];
  
  if (window.blinkTracker) {
    stopPromises.push(
      window.blinkTracker.stop().catch((error) => {
        console.error("Failed to stop blink tracking:", error);
      })
    );
  }

  if (window.headTracker) {
    stopPromises.push(
      window.headTracker.stop().catch((error) => {
        console.error("Failed to stop head tracking:", error);
      })
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
    console.log("Blink Data:", blinkData);
    console.log("Gaze Data:", gazeData);
    console.log("Head Orientation Data:", headOrientationData);

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
    totalBlinks: blinkData.length,
    totalGazeEvents: gazeData.length,
    totalHeadOrientationEvents: headOrientationData.length
  };
  
  localStorage.setItem('aceAssessmentData', JSON.stringify(assessmentData));
  console.log('✓ Assessment data saved to localStorage');
  console.log('   Total Blinks:', blinkData.length);
  console.log('   Total Gaze Events:', gazeData.length);
  console.log('   Total Head Movements:', headOrientationData.length);
  console.log('   Blink Data Sample:', blinkData.slice(0, 3));
  console.log('   Head Data Sample:', headOrientationData.slice(0, 3));
}

function drawCompletionScreen() {
  animationTime++;

  drawGradientBackground();
  drawStarsBackground();

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  // Main title
  drawGlowingText("MISSION COMPLETE!", centerX, centerY - 150, 72, "#6366f1");

  // Success message
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.font = '32px "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("Good job, you completed the mission!", centerX, centerY - 50);

  // Instruction text
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = '24px "Segoe UI", sans-serif';
  ctx.fillText(
    "Please inform your doctor that you have",
    centerX,
    centerY + 20
  );
  ctx.fillText("finished the assessment", centerX, centerY + 55);

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
    buttonY + buttonHeight
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
  ctx.font = 'bold 24px "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText("DOCTOR VIEW", centerX, buttonY + 38);

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
      15
    );
    ctx.stroke();
  }
}

function showDataSummary() {
  window.location.href = 'results.html';
}

function gameLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (gameState === "start") {
    drawStartScreen();
    requestAnimationFrame(gameLoop);
    return;
  }

  if (gameState === "instructions") {
    drawInstructionScreen();
    requestAnimationFrame(gameLoop);
    return;
  }

  if (gameState === "complete") {
    drawCompletionScreen();
    requestAnimationFrame(gameLoop);
    return;
  }

  if (gameState === "phase1") {
    phase1Loop(Date.now());
    requestAnimationFrame(gameLoop);
    return;
  }

  if (gameState === "phase2") {
    phase2Loop(Date.now());
    requestAnimationFrame(gameLoop);
    return;
  }

  // Game play
  drawGradientBackground();
  drawStarsBackground();

  // Update and draw targets
  targets.forEach((target, index) => {
    // Draw target with glow
    ctx.save();
    const pulse = Math.sin(animationTime * 0.05 + index) * 0.2 + 1;
    ctx.shadowColor = `hsl(${target.hue}, 100%, 50%)`;
    ctx.shadowBlur = 20 * pulse;

    // Inner circle
    const gradient = ctx.createRadialGradient(
      target.x,
      target.y,
      0,
      target.x,
      target.y,
      target.radius
    );
    gradient.addColorStop(0, `hsl(${target.hue}, 100%, 70%)`);
    gradient.addColorStop(1, `hsl(${target.hue}, 100%, 40%)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });

  animationTime++;
  requestAnimationFrame(gameLoop);
}

// Start the game
gameLoop();
