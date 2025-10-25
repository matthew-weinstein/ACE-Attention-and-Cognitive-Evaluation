const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

/*
gameState phase1 instead of play:
Visual Search
The child pilots a spaceship.
Stars spawn accross the screen 1 at a time for 15 seconds.
The child must track the star with their eyes without moving their head.
Occasionally a distracting object flashing comet moves accross the screen
This measures gaze fixation and search: ADHD children may have irregular scan paths and fixate more on distractors
*/

// Game variables
let spaceship = {
  x: window.innerWidth / 2 - 25,
  y: window.innerHeight - 150,
  width: 50,
  height: 50,
  speed: 7,
};
let targets = [];
let particles = [];
let keys = {};
let gameState = "start"; // 'start', 'phase1', 'play'
let animationTime = 0;
let stars = [];
let mousePos = { x: 0, y: 0 };
let startButtonHover = false;

// Phase 1: Visual Search variables
let phase1Active = false;
let phase1Timer = 0;
let phase1Duration = 15000; // 15 seconds in milliseconds
let phase1StartTime = 0;
let trackingStars = []; // Stars to track with eyes
let distractors = []; // Flashing comets as distractors
let currentTrackingStar = null;
let starSpawnInterval = 2000; // Spawn a new star every 2 seconds
let lastStarSpawn = 0;
let distractorSpawnInterval = 3000; // Spawn distractors every 3 seconds
let lastDistractorSpawn = 0;
let gazeData = []; // Store gaze tracking data

// Blink tracking variables
let blinkTrackerReady = false;
let blinkData = [];
let sessionId = null;

// Initialize blink tracker event listeners
if (window.blinkTracker) {
  window.blinkTracker.onReady((data) => {
    console.log('Blink tracker ready:', data);
    blinkTrackerReady = true;
  });

  window.blinkTracker.onBlinkDetected((data) => {
    console.log('Blink detected:', data);
    blinkData.push(data);
    
    // Record in gaze data as well
    if (phase1Active) {
      gazeData.push({
        timestamp: data.relative_time_ms,
        type: 'blink',
        blinkNumber: data.blink_number
      });
    }
  });

  window.blinkTracker.onTrackingStarted((data) => {
    console.log('Blink tracking started:', data);
  });

  window.blinkTracker.onTrackingStopped((data) => {
    console.log('Blink tracking stopped:', data);
    console.log('Total blinks detected:', data.total_blinks);
  });

  window.blinkTracker.onError((error) => {
    console.error('Blink tracker error:', error);
  });
}

// Initialize stars for background
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

// Reinitialize stars on resize
window.addEventListener("resize", initStars);

// Mouse tracking
canvas.addEventListener("mousemove", (e) => {
  mousePos.x = e.clientX;
  mousePos.y = e.clientY;

  // Check if hovering over start button
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

  canvas.style.cursor = startButtonHover ? "pointer" : "default";
});

// Click handler
canvas.addEventListener("click", (e) => {
  if (gameState === "start" && startButtonHover) {
    startPhase1();
  }
});

// Key controls
document.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (gameState === "start" && e.code === "Enter") {
    startPhase1();
  }
  // ESC to return to menu
  if (e.code === "Escape") {
    if (gameState === "phase1" || gameState === "play") {
      resetToStart();
    } else if (gameState === "start") {
      window.close();
    }
  }
});
document.addEventListener("keyup", (e) => (keys[e.code] = false));

// Create explosion particles
function createExplosion(x, y, color) {
  for (let i = 0; i < 20; i++) {
    particles.push({
      x: x,
      y: y,
      vx: (Math.random() - 0.5) * 8,
      vy: (Math.random() - 0.5) * 8,
      size: Math.random() * 4 + 2,
      life: 1,
      color: color,
    });
  }
}

// Update particles
function updateParticles() {
  particles.forEach((p, i) => {
    p.x += p.vx;
    p.y += p.vy;
    p.life -= 0.02;
    p.size *= 0.98;

    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  });
}

// Draw particles
function drawParticles() {
  particles.forEach((p) => {
    ctx.save();
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

// Spawn random targets
function spawnTarget() {
  if (gameState !== "play") return;

  let x = Math.random() * (canvas.width - 60) + 30;
  let y = Math.random() * 300 + 50;
  let speedX = (Math.random() - 0.5) * 2;
  let speedY = Math.random() * 0.5 + 0.5;
  targets.push({
    x: x,
    y: y,
    radius: 25,
    speedX: speedX,
    speedY: speedY,
    hue: Math.random() * 60 + 30, // Golden colors
  });
}
setInterval(spawnTarget, 1500);

// Check collision between spaceship and targets
function checkCollisions() {
  targets.forEach((target, index) => {
    // Calculate distance between spaceship center and target center
    const shipCenterX = spaceship.x + spaceship.width / 2;
    const shipCenterY = spaceship.y + spaceship.height / 2;
    const distance = Math.sqrt(
      Math.pow(target.x - shipCenterX, 2) + Math.pow(target.y - shipCenterY, 2)
    );

    // Check if collision occurred (spaceship treated as circle for simplicity)
    if (distance < target.radius + spaceship.width / 2) {
      // Create explosion effect
      createExplosion(target.x, target.y, `hsl(${target.hue}, 100%, 50%)`);

      // Remove target
      targets.splice(index, 1);

      // Visual feedback - flash effect
      ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  });
}

// Draw animated stars background
function drawStarsBackground() {
  stars.forEach((star) => {
    ctx.save();
    ctx.globalAlpha = star.opacity;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Move stars
    star.y += star.speed;
    if (star.y > canvas.height) {
      star.y = 0;
      star.x = Math.random() * canvas.width;
    }
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

// Draw modern start screen
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

// Draw spaceship with trail effect
function drawSpaceship() {
  // Draw trail
  ctx.save();
  const gradient = ctx.createLinearGradient(
    spaceship.x + spaceship.width / 2,
    spaceship.y + spaceship.height,
    spaceship.x + spaceship.width / 2,
    spaceship.y + spaceship.height + 30
  );
  gradient.addColorStop(0, "rgba(0, 255, 250, 0.5)");
  gradient.addColorStop(1, "rgba(0, 255, 250, 0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(
    spaceship.x + spaceship.width / 2 - 10,
    spaceship.y + spaceship.height
  );
  ctx.lineTo(
    spaceship.x + spaceship.width / 2 + 10,
    spaceship.y + spaceship.height
  );
  ctx.lineTo(
    spaceship.x + spaceship.width / 2,
    spaceship.y + spaceship.height + 30
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Draw spaceship body
  ctx.save();
  ctx.shadowColor = "#00FFFA";
  ctx.shadowBlur = 20;

  // Main body
  ctx.fillStyle = "#00FFFA";
  ctx.beginPath();
  ctx.moveTo(spaceship.x + spaceship.width / 2, spaceship.y);
  ctx.lineTo(spaceship.x, spaceship.y + spaceship.height);
  ctx.lineTo(
    spaceship.x + spaceship.width / 2,
    spaceship.y + spaceship.height - 10
  );
  ctx.lineTo(spaceship.x + spaceship.width, spaceship.y + spaceship.height);
  ctx.closePath();
  ctx.fill();

  // Cockpit
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.beginPath();
  ctx.arc(
    spaceship.x + spaceship.width / 2,
    spaceship.y + 15,
    5,
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();
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

// ============ PHASE 1: VISUAL SEARCH ============

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
  gazeData = [];
  blinkData = [];
  
  // Generate unique session ID
  sessionId = `phase1_${Date.now()}`;
  
  // Position spaceship at center bottom
  spaceship.x = canvas.width / 2 - spaceship.width / 2;
  spaceship.y = canvas.height - 150;
  
  // Start blink tracking
  if (window.blinkTracker && blinkTrackerReady) {
    window.blinkTracker.start(sessionId)
      .then(() => {
        console.log('Blink tracking started for session:', sessionId);
      })
      .catch((error) => {
        console.error('Failed to start blink tracking:', error);
      });
  } else {
    console.warn('Blink tracker not ready or not available');
  }
}// Reset to start screen
function resetToStart() {
  gameState = "start";
  phase1Active = false;
  trackingStars = [];
  distractors = [];
  currentTrackingStar = null;
  targets = [];
  
  // Stop blink tracking if active
  if (window.blinkTracker) {
    window.blinkTracker.stop()
      .then(() => {
        console.log('Blink tracking stopped');
      })
      .catch((error) => {
        console.error('Failed to stop blink tracking:', error);
      });
  }
}

// Spawn a tracking star
function spawnTrackingStar() {
  const star = {
    x: Math.random() * (canvas.width - 100) + 50,
    y: Math.random() * (canvas.height - 300) + 50,
    radius: 20,
    pulsePhase: Math.random() * Math.PI * 2,
    lifetime: 0,
    active: true,
  };
  trackingStars.push(star);
  currentTrackingStar = star;

  // Record gaze data
  gazeData.push({
    timestamp: Date.now() - phase1StartTime,
    starPosition: { x: star.x, y: star.y },
    type: "star_spawn",
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

  // Record gaze data
  gazeData.push({
    timestamp: Date.now() - phase1StartTime,
    distractorPosition: { x: distractor.x, y: distractor.y },
    type: "distractor_spawn",
  });
}

// Update tracking stars
function updateTrackingStars() {
  trackingStars.forEach((star, index) => {
    star.lifetime++;
    star.pulsePhase += 0.05;

    // Remove stars after 3 seconds or when new star spawns
    if (
      star.lifetime > 180 ||
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

// Draw tracking stars
function drawTrackingStars() {
  trackingStars.forEach((star) => {
    const pulse = Math.sin(star.pulsePhase) * 0.3 + 1;
    const radius = star.radius * pulse;

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
      radius
    );
    gradient.addColorStop(0, "#FFFFFF");
    gradient.addColorStop(0.3, "#FFD700");
    gradient.addColorStop(1, "rgba(255, 215, 0, 0.3)");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(star.x, star.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Draw star points
    ctx.fillStyle = "#FFFFFF";
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

// Draw Phase 1 UI
function drawPhase1UI() {
  const timeRemaining = Math.max(0, phase1Duration - phase1Timer);
  const seconds = Math.ceil(timeRemaining / 1000);

  // Timer background
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(canvas.width / 2 - 100, 20, 200, 60);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
  ctx.lineWidth = 2;
  ctx.strokeRect(canvas.width / 2 - 100, 20, 200, 60);
  ctx.restore();

  // Timer text
  ctx.fillStyle = "#FFFFFF";
  ctx.font = 'bold 32px "Segoe UI", sans-serif';
  ctx.textAlign = "center";
  ctx.fillText(`Time: ${seconds}s`, canvas.width / 2, 60);

  // Instructions at bottom
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = '20px "Segoe UI", sans-serif';
  ctx.fillText(
    "Track the golden star with your eyes",
    canvas.width / 2,
    canvas.height - 60
  );
  ctx.fillText("Do not move your head", canvas.width / 2, canvas.height - 30);
}

// Phase 1 game loop
function phase1Loop(currentTime) {
  phase1Timer = currentTime - phase1StartTime;

  // Check if phase 1 is complete
  if (phase1Timer >= phase1Duration) {
    completePhase1();
    return;
  }

  // Spawn tracking stars
  if (currentTime - lastStarSpawn >= starSpawnInterval) {
    spawnTrackingStar();
    lastStarSpawn = currentTime;
  }

  // Spawn distractors
  if (currentTime - lastDistractorSpawn >= distractorSpawnInterval) {
    spawnDistractor();
    lastDistractorSpawn = currentTime;
  }

  // Update
  updateTrackingStars();
  updateDistractors();

  // Draw
  drawGradientBackground();
  drawStarsBackground();
  drawSpaceship();
  drawTrackingStars();
  drawDistractors();
  drawPhase1UI();
}

// Complete Phase 1 and move to next phase
function completePhase1() {
  console.log("Phase 1 Complete!");
  console.log("Gaze Data:", gazeData);
  console.log("Blink Data:", blinkData);

  // Stop blink tracking
  if (window.blinkTracker) {
    window.blinkTracker.stop()
      .then(() => {
        console.log("Blink tracking stopped");
      })
      .catch((error) => {
        console.error("Failed to stop blink tracking:", error);
      });
  }

  // For now, return to start screen
  // In the future, this would transition to phase 2
  resetToStart();

  // Show completion message with blink count
  const blinkCount = blinkData.length;
  alert(
    `Phase 1 Complete!\n\nThank you for participating.\n\nGaze tracking data has been recorded.\nBlinks detected: ${blinkCount}\n\nSession ID: ${sessionId}`
  );
}

// ============ END PHASE 1 ============

// Game loop
function gameLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (gameState === "start") {
    drawStartScreen();
    requestAnimationFrame(gameLoop);
    return;
  }

  if (gameState === "phase1") {
    phase1Loop(Date.now());
    requestAnimationFrame(gameLoop);
    return;
  }

  // Game play
  drawGradientBackground();
  drawStarsBackground();

  // Move spaceship
  if (keys["ArrowLeft"] && spaceship.x > 0) spaceship.x -= spaceship.speed;
  if (keys["ArrowRight"] && spaceship.x + spaceship.width < canvas.width)
    spaceship.x += spaceship.speed;
  if (keys["ArrowUp"] && spaceship.y > 0) spaceship.y -= spaceship.speed;
  if (keys["ArrowDown"] && spaceship.y + spaceship.height < canvas.height)
    spaceship.y += spaceship.speed;

  // Update and draw targets
  targets.forEach((target, index) => {
    // Move targets
    target.x += target.speedX;
    target.y += target.speedY;

    // Bounce off walls
    if (
      target.x - target.radius <= 0 ||
      target.x + target.radius >= canvas.width
    ) {
      target.speedX *= -1;
    }

    // Remove targets that go off screen bottom
    if (target.y - target.radius > canvas.height) {
      targets.splice(index, 1);
    }

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

  // Check collisions
  checkCollisions();

  // Update and draw particles
  updateParticles();
  drawParticles();

  // Draw spaceship
  drawSpaceship();

  animationTime++;
  requestAnimationFrame(gameLoop);
}

// Start the game
gameLoop();
