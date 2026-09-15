/**
 * Screen construction.
 *
 * Six arrangements, built here and nowhere else, so a screen cannot quietly
 * invent a seventh layout. Each returns a promise that settles when the child
 * or the operator has moved it on.
 *
 * Copy rules these enforce structurally rather than by review:
 *   - A plate takes one sentence. The element has a max-width in characters
 *     and no second paragraph slot, so a wall of text cannot be added to it
 *     without changing this file.
 *   - Nothing on a child screen reports a score, a streak, or a correctness
 *     mark. There is no element here that could carry one.
 */

const AceUI = (function () {
  const app = () => document.getElementById("app");

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Swap the whole surface. Returns the new root, already in the document. */
  function surface(kind, accentVar) {
    // Hand the loop back before the old surface is torn out. A scene left
    // running would keep painting into a canvas that is no longer in the
    // document, which costs a frame's work every frame for nothing.
    if (window.aceDriver) window.aceDriver.clearScene();

    const host = app();
    host.replaceChildren();
    host.className = kind === "ledger" ? "ledger" : "scope";
    if (accentVar) host.style.setProperty("--accent", accentVar);

    const root = el("div", "surface");
    const rule = el("div", "rule");
    rule.dataset.draw = "true";
    root.appendChild(rule);
    host.appendChild(root);
    return { root, rule };
  }

  /**
   * Wait for one key. Uses a plain listener rather than the measurement
   * capture, because advancing a screen is not a measured response and must
   * not consume one.
   */
  function awaitKey(keys) {
    return new Promise((resolve) => {
      const accept = new Set(keys);
      const handler = (e) => {
        if (e.repeat || !accept.has(e.key)) return;
        e.preventDefault();
        window.removeEventListener("keydown", handler, true);
        resolve(e.key);
      };
      window.addEventListener("keydown", handler, true);
    });
  }

  const KEY_LABEL = {
    " ": "space",
    ArrowLeft: "left arrow",
    ArrowRight: "right arrow",
  };

  function cueFor(key, verb) {
    const wrap = el("div", "cue");
    const cap = el("span", "keycap", KEY_LABEL[key] || key);
    if (key === " ") cap.dataset.key = "space";
    wrap.appendChild(cap);
    wrap.appendChild(el("span", null, verb));
    return wrap;
  }

  /**
   * A plate. One picture, one sentence, a wide margin.
   *
   * `paint(ctx, w, h, t)` draws the demonstration. It is handed the driver's
   * frame time so a demonstration animates on delta time like everything
   * else, and it is only called while the plate is on screen.
   */
  async function plate(options) {
    const { root } = surface("scope", options.accent);
    const screen = el("div", "plate-screen");
    screen.dataset.band = options.band || "B";

    const figure = el("figure", "plate-figure");
    const canvas = document.createElement("canvas");
    figure.appendChild(canvas);

    const text = el("div", "plate-text");
    const line = el("p", "plate-line", options.line);
    text.appendChild(line);
    text.appendChild(cueFor(options.key || " ", options.verb || "to carry on"));

    screen.appendChild(figure);
    screen.appendChild(text);

    if (options.aside) {
      const aside = el("div", "plate-aside");
      aside.appendChild(el("div", "label", options.aside));
      screen.appendChild(aside);
    }

    root.appendChild(screen);

    let stop = null;
    if (options.paint) stop = runFigure(canvas, figure, options.paint);

    const key = await awaitKey([options.key || " "]);
    if (stop) stop();
    return key;
  }

  /**
   * Drive a plate demonstration off the shared loop.
   *
   * It runs on the same driver as the games, so there is exactly one
   * requestAnimationFrame callback in the app and a demonstration cannot
   * quietly start a second loop that keeps running after the screen is gone.
   */
  function runFigure(canvas, host, paint) {
    const ctx = canvas.getContext("2d", { alpha: true });
    let w = 0;
    let h = 0;

    function size() {
      const rect = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener("resize", size);

    const driver = window.aceDriver;
    driver.setScene({
      draw(t) {
        ctx.clearRect(0, 0, w, h);
        paint(ctx, w, h, t);
        driver.invalidate();
      },
    });

    return () => {
      window.removeEventListener("resize", size);
      driver.clearScene();
    };
  }

  /**
   * The screen between games. One line, no instruction, no result.
   *
   * The line is the same regardless of how the previous game went. That is
   * not politeness, it is the reinforcement rule from assessment-design 1.3:
   * performance-contingent feedback narrows the very gap the battery exists
   * to detect, so between-game copy carries no performance information at all.
   */
  async function pause(options) {
    const { root } = surface("scope", options.accent);
    const screen = el("div", "pause-screen");
    screen.appendChild(el("p", "pause-line", options.line));

    const foot = el("div", "pause-foot");
    foot.appendChild(cueFor(" ", options.verb || "when you are ready"));
    if (options.position) foot.appendChild(el("div", "label", options.position));
    screen.appendChild(foot);

    root.appendChild(screen);
    await awaitKey([" "]);
  }

  /** A ledger screen with a title, prose, and buttons. Adults only. */
  function sheet(options) {
    const { root } = surface("ledger", options.accent);
    const head = el("div", "sheet-head");
    head.appendChild(el("div", "mark", "ACE"));
    if (options.step) head.appendChild(el("div", "label", options.step));
    root.appendChild(head);

    const page = el("div", "sheet");
    // The report runs the full measure, because an interval drawn to scale
    // needs the width to be read as a width.
    if (options.wide) page.classList.add("wide");
    page.appendChild(el("h1", "sheet-title", options.title));
    const body = el("div", "sheet-body");
    for (const para of options.paragraphs || []) {
      body.appendChild(el("p", null, para));
    }
    page.appendChild(body);
    root.appendChild(page);
    return { root, page, body };
  }

  /** Ticks along the horizon. The same mark the adult rail uses. */
  function watchProgress(host, total) {
    const bar = el("div", "watch-progress");
    const marks = [];
    for (let i = 0; i < total; i++) {
      const m = el("div", "watch-mark");
      bar.appendChild(m);
      marks.push(m);
    }
    host.appendChild(bar);
    return {
      /** `done` runs 0 to 1 and is a function of elapsed trials only. */
      set(done) {
        const filled = Math.round(done * total);
        for (let i = 0; i < total; i++) {
          marks[i].dataset.state = i < filled ? "done" : "pending";
        }
      },
      remove: () => bar.remove(),
    };
  }

  return { surface, plate, pause, sheet, awaitKey, cueFor, watchProgress, el };
})();
