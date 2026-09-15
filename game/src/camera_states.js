/**
 * Camera states and the copy for each.
 *
 * Every camera failure gets its own state, its own screen, and copy that
 * names the actual cause. There is no generic failure state, and no state
 * falls through to another one's message.
 *
 * Copy rules, from CLAUDE.md and docs/assessment-design.md 1.4:
 *   - A child of six reads the `child` line and knows what is happening.
 *   - An adult reads the `adult` line and knows what to do.
 *   - `needsAdult` is true when a child cannot fix it alone. The screen says
 *     so plainly rather than leaving the child to fail at something they
 *     cannot change.
 *   - `detail` carries the technical specifics. It is never the primary
 *     message and it is the only place a number or an API name appears.
 *
 * Loadable from the main process with require() and from the renderer with a
 * script tag, because both sides must agree on the state set.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CameraStates = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const WINDOWS_PRIVACY_PATH =
    "Open Windows Settings, then Privacy and security, then Camera. " +
    "Turn on camera access, and allow desktop apps to use the camera.";

  const MAC_PRIVACY_PATH =
    "Open System Settings, then Privacy and Security, then Camera. " +
    "Allow this app to use the camera, then start the app again.";

  const RETRY = { id: "retry", label: "Try again" };
  const REQUEST = { id: "request", label: "Turn on the camera" };
  const RECHECK = { id: "recheck", label: "Check again" };

  /**
   * severity:
   *   "ask"     nothing is wrong yet, we need a decision
   *   "setup"   fixable in the room, in seconds
   *   "blocked" cannot proceed until something outside the app changes
   *   "lost"    the session was under way and the camera went
   */
  const STATES = {
    OK: {
      id: "OK",
      severity: "ok",
      needsAdult: false,
      title: "The camera is ready",
      child: "We can see you. You are ready to start.",
      adult: null,
      actions: [],
    },

    PERMISSION_NOT_REQUESTED: {
      id: "PERMISSION_NOT_REQUESTED",
      severity: "ask",
      needsAdult: false,
      title: "Turn on the camera",
      child:
        "The camera looks at where your eyes go. It does not save any video.",
      adult:
        "Choose Turn on the camera, then select Allow if a prompt appears. " +
        "No video leaves this computer.",
      actions: [REQUEST],
    },

    PERMISSION_DENIED: {
      id: "PERMISSION_DENIED",
      severity: "blocked",
      needsAdult: true,
      title: "The camera is turned off",
      child: "An adult needs to turn the camera on for this app.",
      adult: (ctx) =>
        (ctx && ctx.platform === "darwin"
          ? MAC_PRIVACY_PATH
          : WINDOWS_PRIVACY_PATH) + " Then choose Try again.",
      actions: [RETRY],
    },

    PERMISSION_DISMISSED: {
      id: "PERMISSION_DISMISSED",
      severity: "ask",
      needsAdult: false,
      title: "The camera question closed",
      child: "The question about the camera went away before it was answered.",
      adult: "Choose Ask again, then select Allow.",
      actions: [{ id: "request", label: "Ask again" }],
    },

    BLOCKED_BY_POLICY: {
      id: "BLOCKED_BY_POLICY",
      severity: "blocked",
      needsAdult: true,
      title: "The camera is blocked on this computer",
      child: "An adult needs to help with this one.",
      adult:
        "Camera access is blocked by a system policy rather than by a " +
        "personal setting. The person who manages this computer has to allow " +
        "camera access before the app can use it.",
      actions: [RETRY],
    },

    NO_CAMERA: {
      id: "NO_CAMERA",
      severity: "blocked",
      needsAdult: true,
      title: "No camera found",
      child: "This computer does not have a camera we can use.",
      adult:
        "Plug in a webcam, then choose Try again. If one is already plugged " +
        "in, check the cable and try a different port.",
      actions: [RETRY],
    },

    /**
     * The device would not start, and the cause is genuinely not known.
     *
     * Chromium reports NotReadableError both when another application holds
     * the camera and when a device is listed but cannot be opened at all, so
     * an app that has never had a working stream cannot tell the two apart.
     * A driver with no hardware behind it, a scanner that presents as a video
     * input, and a camera held by a video call all land here identically.
     *
     * Naming one cause would be wrong about half the time, so this names the
     * observed fact and gives the two recoveries in order of likelihood.
     * TAKEN_BEFORE_START covers the case where the device did work, which is
     * the only case where "another app has it" is actually established.
     */
    CAMERA_WONT_START: {
      id: "CAMERA_WONT_START",
      severity: "blocked",
      needsAdult: true,
      title: "The camera will not start",
      child: "The computer found a camera but it will not turn on.",
      adult:
        "Close any app that might be using the camera, such as a video call, " +
        "Camera, Teams or Zoom, then choose Try again. If nothing else is " +
        "using it, unplug the camera and plug it back in. A device listed " +
        "here is not always a working camera.",
      detail: (ctx) =>
        ctx.deviceLabels && ctx.deviceLabels.length
          ? `Listed video inputs: ${ctx.deviceLabels.join(", ")}.`
          : null,
      actions: [RETRY],
    },

    CAMERA_IN_USE: {
      id: "CAMERA_IN_USE",
      severity: "blocked",
      needsAdult: true,
      title: "Another app has the camera",
      child: "Something else on this computer is using the camera.",
      adult:
        "Close the other app that is using the camera, such as a video call, " +
        "Camera, Teams or Zoom. Then choose Try again.",
      actions: [RETRY],
    },

    TAKEN_BEFORE_START: {
      id: "TAKEN_BEFORE_START",
      severity: "blocked",
      needsAdult: true,
      title: "Something took the camera",
      child: "The camera worked a moment ago. Now something else has it.",
      adult:
        "An app opened the camera in the last few seconds. Close it, then " +
        "choose Try again.",
      actions: [RETRY],
    },

    HARDWARE_ERROR: {
      id: "HARDWARE_ERROR",
      severity: "blocked",
      needsAdult: true,
      title: "The camera did not start",
      child: "The camera did not start properly.",
      adult:
        "Unplug the camera and plug it back in, then choose Try again. If " +
        "the camera is built in, restart the computer.",
      actions: [RETRY],
    },

    RESOLUTION_TOO_LOW: {
      id: "RESOLUTION_TOO_LOW",
      severity: "blocked",
      needsAdult: true,
      title: "This camera's picture is too small",
      child: "This camera cannot make a big enough picture.",
      adult:
        "The picture does not have enough detail to find the eyes reliably. " +
        "Use a different webcam.",
      detail: (ctx) =>
        `Camera delivered ${ctx.width} by ${ctx.height}. ` +
        `Minimum is ${ctx.minWidth} by ${ctx.minHeight}.`,
      actions: [RETRY],
    },

    FRAMERATE_TOO_LOW: {
      id: "FRAMERATE_TOO_LOW",
      severity: "blocked",
      needsAdult: true,
      title: "This camera is too slow",
      child: "This camera does not take enough pictures each second.",
      adult:
        "Close other apps that are working the computer hard, then choose " +
        "Try again. If it stays slow, use a different webcam.",
      detail: (ctx) =>
        `Measured ${ctx.measuredFps.toFixed(1)} frames per second over ` +
        `${(ctx.windowMs / 1000).toFixed(1)} s. Minimum is ${ctx.minFps}.`,
      actions: [RETRY],
    },

    TOO_DARK_BACKLIT: {
      id: "TOO_DARK_BACKLIT",
      severity: "setup",
      needsAdult: true,
      title: "There is a light behind you",
      child: "The bright light behind you makes your face too dark to see.",
      adult:
        "Close the blind or move the lamp that is behind the child. Turning " +
        "the chair so the window is to one side also works.",
      detail: (ctx) =>
        `Subject region brightness ${Math.round(ctx.subject)} against ` +
        `background ${Math.round(ctx.background)} on a 0 to 255 scale.`,
      actions: [RECHECK],
    },

    TOO_DARK_ROOM: {
      id: "TOO_DARK_ROOM",
      severity: "setup",
      needsAdult: true,
      title: "The room is too dark",
      child: "We cannot see your face well enough.",
      adult:
        "Turn on a light in front of the child. A light behind them makes " +
        "this worse rather than better.",
      detail: (ctx) =>
        `Mean brightness ${Math.round(ctx.mean)} on a 0 to 255 scale. ` +
        `Minimum is ${ctx.minMean}.`,
      actions: [RECHECK],
    },

    TOO_BRIGHT: {
      id: "TOO_BRIGHT",
      severity: "setup",
      needsAdult: true,
      title: "The picture is washed out",
      child: "There is too much light on your face to see your eyes.",
      adult:
        "Move the lamp further away, or point it at a wall instead of at the " +
        "child.",
      detail: (ctx) =>
        `${Math.round(ctx.clippedPercent)} percent of the picture is at full ` +
        `white. Limit is ${ctx.maxClippedPercent} percent.`,
      actions: [RECHECK],
    },

    NO_FACE: {
      id: "NO_FACE",
      severity: "setup",
      needsAdult: true,
      title: "We cannot see your face",
      child: "Sit so your whole face is in the picture.",
      adult:
        "Raise or lower the seat so the child's whole face is in the picture, " +
        "and point the camera at them.",
      actions: [RECHECK],
    },

    TOO_FAR: {
      id: "TOO_FAR",
      severity: "setup",
      needsAdult: false,
      title: "Move a bit closer",
      child: "Move your chair forward until the bar turns full.",
      adult: null,
      detail: (ctx) =>
        `Estimated ${Math.round(ctx.distanceCm)} cm. Target is ` +
        `${Math.round(ctx.targetCm)} cm.`,
      actions: [],
    },

    TOO_CLOSE: {
      id: "TOO_CLOSE",
      severity: "setup",
      needsAdult: false,
      title: "Move back a bit",
      child: "Move your chair back until the bar turns full.",
      adult: null,
      detail: (ctx) =>
        `Estimated ${Math.round(ctx.distanceCm)} cm. Target is ` +
        `${Math.round(ctx.targetCm)} cm.`,
      actions: [],
    },

    BLURRED: {
      id: "BLURRED",
      severity: "setup",
      needsAdult: true,
      title: "The picture is blurry",
      child: "Try to hold still.",
      adult:
        "If it stays blurry when the child is still, wipe the camera lens " +
        "with a soft cloth.",
      detail: (ctx) =>
        `Focus measure ${ctx.variance.toFixed(0)} against a floor of ` +
        `${ctx.floor}.`,
      actions: [RECHECK],
    },

    GLASSES_GLARE: {
      id: "GLASSES_GLARE",
      severity: "setup",
      needsAdult: true,
      title: "The glasses are catching the light",
      child: "Tilt your head down just a little.",
      adult:
        "A lamp or window is reflecting in the glasses. Move the light, or " +
        "tilt the screen down slightly so the reflection falls away.",
      actions: [RECHECK],
    },

    DISPLAY_TOO_SMALL: {
      id: "DISPLAY_TOO_SMALL",
      severity: "blocked",
      needsAdult: true,
      title: "This screen is too small for the looking game",
      child: "We will skip the looking game and play the others.",
      adult:
        "The looking game needs the targets placed 20 degrees to each side, " +
        "which this screen cannot show at a distance a child can sit at. The " +
        "other games are unaffected and the report will record this.",
      detail: (ctx) =>
        `Screen is ${ctx.widthCm.toFixed(0)} cm wide. Minimum is ` +
        `${ctx.minWidthCm} cm.`,
      actions: [{ id: "continue", label: "Carry on" }],
    },

    GEOMETRY_UNKNOWN: {
      id: "GEOMETRY_UNKNOWN",
      severity: "blocked",
      needsAdult: true,
      title: "We need the screen size",
      child: "An adult needs to type in one number.",
      adult:
        "This computer does not report the physical size of its screen. " +
        "Measure the width of the picture area, edge to edge, in centimetres, " +
        "and enter it. Without it, distances on screen cannot be converted to " +
        "the angles the assessment measures.",
      actions: [{ id: "enter-geometry", label: "Enter screen width" }],
    },

    FRAMES_STOPPED: {
      id: "FRAMES_STOPPED",
      severity: "lost",
      needsAdult: true,
      title: "The camera stopped sending pictures",
      child: "The camera is on but no pictures are coming through.",
      adult:
        "Unplug the camera, plug it back in, then choose Try again. If it is " +
        "built in, close any other app that may have taken it.",
      detail: (ctx) => `No frame for ${Math.round(ctx.stalledMs)} ms.`,
      actions: [RETRY],
    },

    DISCONNECTED_MID_SESSION: {
      id: "DISCONNECTED_MID_SESSION",
      severity: "lost",
      needsAdult: true,
      title: "The camera stopped",
      child: "The camera stopped working. Everything you finished is saved.",
      adult:
        "Check that the camera is still plugged in. Completed games are " +
        "saved. Choosing Finish here marks the session incomplete and keeps " +
        "every result up to this point.",
      actions: [
        { id: "retry", label: "Try the camera again" },
        { id: "end", label: "Finish here" },
      ],
    },
  };

  /** Resolve a field that may be a string or a function of context. */
  function field(state, name, ctx) {
    const v = state[name];
    if (typeof v === "function") {
      try {
        return v(ctx || {});
      } catch {
        return null;
      }
    }
    return v === undefined ? null : v;
  }

  /** Flatten a state into plain strings for rendering. */
  function render(stateId, ctx) {
    const state = STATES[stateId];
    if (!state) {
      throw new Error(`unknown camera state: ${stateId}`);
    }
    return {
      id: state.id,
      severity: state.severity,
      needsAdult: state.needsAdult,
      title: field(state, "title", ctx),
      child: field(state, "child", ctx),
      adult: field(state, "adult", ctx),
      detail: field(state, "detail", ctx),
      actions: state.actions || [],
    };
  }

  return { STATES, render };
});
