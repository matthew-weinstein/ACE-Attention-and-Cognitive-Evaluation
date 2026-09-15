/**
 * Camera check screens.
 *
 * One screen per state. Every screen names the actual cause, gives one
 * concrete action, and says plainly when the fix needs an adult. Nothing here
 * paraphrases a technical cause into a friendlier but vaguer one.
 */

const CameraScreens = (function () {
  const STEPS = [
    { id: "camera", label: "Camera" },
    { id: "light", label: "Light" },
    { id: "position", label: "Position" },
    { id: "ready", label: "Ready" },
  ];

  /** Which check a state belongs to, so the rail stays truthful. */
  const STEP_OF = {
    PERMISSION_NOT_REQUESTED: "camera",
    PERMISSION_DENIED: "camera",
    PERMISSION_DISMISSED: "camera",
    BLOCKED_BY_POLICY: "camera",
    NO_CAMERA: "camera",
    CAMERA_IN_USE: "camera",
    TAKEN_BEFORE_START: "camera",
    HARDWARE_ERROR: "camera",
    RESOLUTION_TOO_LOW: "camera",
    FRAMERATE_TOO_LOW: "camera",
    FRAMES_STOPPED: "camera",
    DISCONNECTED_MID_SESSION: "camera",
    GEOMETRY_UNKNOWN: "camera",
    DISPLAY_TOO_SMALL: "camera",
    TOO_DARK_BACKLIT: "light",
    TOO_DARK_ROOM: "light",
    TOO_BRIGHT: "light",
    BLURRED: "light",
    GLASSES_GLARE: "light",
    NO_FACE: "position",
    TOO_FAR: "position",
    TOO_CLOSE: "position",
    OK: "ready",
  };

  const KICKER = {
    camera: "Camera check",
    light: "Light check",
    position: "Where you sit",
    ready: "Ready",
  };

  let root = null;
  let els = {};
  let currentHandlers = {};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Build the layer once. Hidden until show() is called. */
  function mount() {
    if (root) return root;

    root = el("div");
    root.id = "camera-layer";
    root.dataset.visible = "false";
    root.setAttribute("role", "region");
    root.setAttribute("aria-live", "polite");

    root.appendChild(el("div", "cam-bar"));

    const body = el("div", "cam-body");

    // Rail
    const rail = el("aside", "cam-rail");
    rail.appendChild(el("div", "cam-mark", "ACE"));
    const steps = el("ol", "cam-steps");
    els.steps = {};
    for (let i = 0; i < STEPS.length; i++) {
      const li = el("li");
      li.dataset.step = STEPS[i].id;
      const num = el("span", "cam-step-num", String(i + 1).padStart(2, "0"));
      li.appendChild(num);
      li.appendChild(el("span", null, STEPS[i].label));
      steps.appendChild(li);
      els.steps[STEPS[i].id] = li;
    }
    rail.appendChild(steps);
    body.appendChild(rail);

    // Main
    const main = el("main", "cam-main");
    els.kicker = el("div", "cam-kicker");
    els.title = el("h1", "cam-title");
    els.rule = el("div", "cam-title-rule");
    els.child = el("p", "cam-child");

    els.adult = el("div", "cam-adult");
    els.adult.appendChild(el("div", "cam-adult-label", "For an adult"));
    els.adultText = el("p");
    els.adult.appendChild(els.adultText);

    els.field = el("div", "cam-field");
    els.field.hidden = true;
    const fieldWrap = el("div");
    const fieldLabel = el("label", null, "Screen width, edge to edge");
    fieldLabel.setAttribute("for", "cam-width-input");
    els.fieldInput = el("input");
    els.fieldInput.id = "cam-width-input";
    els.fieldInput.type = "number";
    els.fieldInput.min = "15";
    els.fieldInput.max = "200";
    els.fieldInput.step = "0.5";
    els.fieldInput.inputMode = "decimal";
    fieldWrap.appendChild(fieldLabel);
    fieldWrap.appendChild(els.fieldInput);
    els.field.appendChild(fieldWrap);
    els.field.appendChild(el("span", "cam-field-unit", "centimetres"));

    els.actions = el("div", "cam-actions");
    els.detail = el("div", "cam-detail");

    main.appendChild(els.kicker);
    main.appendChild(els.title);
    main.appendChild(els.rule);
    main.appendChild(els.child);
    main.appendChild(els.adult);
    main.appendChild(els.field);
    main.appendChild(els.actions);
    main.appendChild(els.detail);
    body.appendChild(main);

    // Aside
    const aside = el("aside", "cam-aside");
    els.previewLabel = el("div", "cam-preview-label", "Camera");
    els.previewFrame = el("div", "cam-preview-frame");
    els.video = el("video");
    els.video.muted = true;
    els.video.autoplay = true;
    els.video.playsInline = true;
    els.previewFrame.appendChild(els.video);

    els.gauge = el("div", "cam-gauge");
    els.gauge.hidden = true;
    const track = el("div", "cam-gauge-track");
    els.gaugeFill = el("div", "cam-gauge-fill");
    els.gaugeBand = el("div", "cam-gauge-band");
    track.appendChild(els.gaugeFill);
    track.appendChild(els.gaugeBand);
    const caption = el("div", "cam-gauge-caption");
    els.gaugeNow = el("span", null, "");
    els.gaugeTarget = el("span", null, "");
    caption.appendChild(els.gaugeNow);
    caption.appendChild(els.gaugeTarget);
    els.gauge.appendChild(track);
    els.gauge.appendChild(caption);

    aside.appendChild(els.previewLabel);
    aside.appendChild(els.previewFrame);
    aside.appendChild(els.gauge);
    body.appendChild(aside);

    root.appendChild(body);
    document.body.appendChild(root);
    return root;
  }

  function setRail(activeStep) {
    const order = STEPS.map((s) => s.id);
    const activeIndex = order.indexOf(activeStep);
    for (let i = 0; i < order.length; i++) {
      const li = els.steps[order[i]];
      li.dataset.state =
        i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
    }
  }

  /**
   * Render a state.
   *
   * `handlers` maps an action id to a function. An action whose handler is
   * missing is not rendered, so a screen never offers a button that does
   * nothing.
   */
  function show(stateId, context = {}, handlers = {}) {
    mount();
    currentHandlers = handlers;

    const view = window.CameraStates.render(stateId, context);
    const step = STEP_OF[stateId] || "camera";

    root.dataset.visible = "true";
    root.dataset.severity = view.severity;
    root.dataset.state = stateId;

    els.kicker.textContent = KICKER[step];
    els.title.textContent = view.title;
    els.child.textContent = view.child;

    if (view.adult) {
      els.adultText.textContent = view.adult;
      els.adult.hidden = false;
    } else {
      els.adult.hidden = true;
    }

    els.detail.textContent = view.detail || "";

    els.actions.replaceChildren();
    const usable = view.actions.filter((a) => typeof handlers[a.id] === "function");
    usable.forEach((action, i) => {
      const btn = el("button", "cam-btn", action.label);
      btn.type = "button";
      if (i === 0) btn.dataset.primary = "true";
      btn.addEventListener("click", () => handlers[action.id]());
      els.actions.appendChild(btn);
    });
    if (usable.length) els.actions.firstChild.focus();

    els.field.hidden = stateId !== "GEOMETRY_UNKNOWN";
    setRail(step);
    return view;
  }

  function hide() {
    if (!root) return;
    root.dataset.visible = "false";
  }

  /** The preview is only shown where seeing yourself helps. */
  function setPreviewVisible(visible) {
    mount();
    els.previewFrame.hidden = !visible;
    els.previewLabel.hidden = !visible;
  }

  function videoElement() {
    mount();
    return els.video;
  }

  /**
   * Distance gauge for the positioning step.
   * The band marks the acceptable window, the fill marks where the child is.
   */
  function setGauge(distanceCm, plan) {
    mount();
    if (distanceCm === null || !plan) {
      els.gauge.hidden = true;
      return;
    }
    els.gauge.hidden = false;

    const scaleMin = 25;
    const scaleMax = Math.max(plan.maxDistanceCm * 1.35, 90);
    const pct = (v) =>
      Math.max(0, Math.min(100, ((v - scaleMin) / (scaleMax - scaleMin)) * 100));

    els.gaugeFill.style.width = `${pct(distanceCm)}%`;
    els.gaugeBand.style.left = `${pct(plan.minDistanceCm)}%`;
    els.gaugeBand.style.width = `${pct(plan.maxDistanceCm) - pct(plan.minDistanceCm)}%`;
    els.gaugeNow.textContent = `${Math.round(distanceCm)} cm`;
    els.gaugeTarget.textContent = `target ${Math.round(plan.targetDistanceCm)} cm`;
  }

  function screenWidthInput() {
    mount();
    return els.fieldInput;
  }

  function isVisible() {
    return Boolean(root && root.dataset.visible === "true");
  }

  return {
    mount,
    show,
    hide,
    setPreviewVisible,
    videoElement,
    setGauge,
    screenWidthInput,
    isVisible,
    currentState: () => (root ? root.dataset.state : null),
  };
})();
