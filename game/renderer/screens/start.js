/**
 * Operator entry.
 *
 * The one screen in the app written for an adult before the session starts. It
 * collects the two facts that change what runs: who this is, and how old they
 * are. Age decides the band, and the band decides the battery, the trial
 * counts and the reading level, so it is asked rather than assumed.
 *
 * It is a ledger surface. Cool paper, a printed ruling, square corners,
 * everything hanging left off the rule. The child never sees it.
 */

const AceStart = (function () {
  /** 6 to 11 inclusive. Band A is 6 to 7, band B is 8 to 11. See 1.1. */
  const MIN_AGE = 6;
  const MAX_AGE = 11;

  function bandFor(age) {
    return age <= 7 ? "A" : "B";
  }

  function batteryFor(band, lookAwayAvailable) {
    if (band === "A") {
      // Asteroid Run is not administered below eight, and Two Doors is core
      // here because the antisaccade reversal is not reliably grasped at six.
      return ["signal_watch", "beacon_line", "two_doors"];
    }
    return [
      "signal_watch",
      "beacon_line",
      "asteroid_run",
      lookAwayAvailable ? "look_away" : "two_doors",
    ];
  }

  /** Minutes of wall clock per game, from the battery tables in 7.1 and 7.2. */
  const WALL_CLOCK = {
    signal_watch: { B: 9.5, A: 7.0, label: "Signal Watch" },
    beacon_line: { B: 5.5, A: 4.5, label: "Beacon Line" },
    asteroid_run: { B: 6.0, A: 6.0, label: "Asteroid Run" },
    two_doors: { B: 3.5, A: 3.5, label: "Two Doors" },
    look_away: { B: 4.0, A: 4.0, label: "Look Away" },
  };

  /**
   * The session plan, written out.
   *
   * The same sequence the child sees as ticks on the horizon. An adult should
   * be able to see the whole session, in order, with its length, before
   * committing a child to it.
   */
  function planAside(band) {
    const aside = AceUI.el("aside", "sheet-aside");
    aside.appendChild(AceUI.el("div", "label", "What will run"));
    const list = AceUI.el("ol");
    const games = batteryFor(band, false);
    let total = 2.5;
    games.forEach((id, i) => {
      const entry = WALL_CLOCK[id];
      const minutes = entry[band];
      total += minutes;
      const li = AceUI.el("li");
      li.appendChild(AceUI.el("span", null, String(i + 1).padStart(2, "0")));
      li.appendChild(AceUI.el("span", null, entry.label));
      li.appendChild(AceUI.el("span", null, `${minutes} min`));
      list.appendChild(li);
    });
    aside.appendChild(list);

    const foot = AceUI.el("p", "row-note",
      `Plus 2.5 minutes of setup and camera check. About ${Math.round(total)} minutes door to door.`);
    foot.style.marginTop = "var(--s3)";
    aside.appendChild(foot);
    return aside;
  }

  function show() {
    return new Promise((resolve) => {
      const { root, page, body } = AceUI.sheet({
        step: "Before you start",
        title: "Set up a session",
        paragraphs: [
          "Enter the participant identifier used in your records. It is stored with the session and nothing else identifying is kept.",
          "Age sets the games, the number of trials, and the reading level of the instructions.",
        ],
      });

      const form = AceUI.el("form", "sheet-body");
      form.style.marginTop = "var(--s5)";

      const idRow = field("Participant identifier", "text", "ace-id");
      idRow.input.required = true;
      idRow.input.autocomplete = "off";
      idRow.input.style.width = "18ch";

      const ageRow = field("Age in years", "number", "ace-age");
      ageRow.input.min = String(MIN_AGE);
      ageRow.input.max = String(MAX_AGE);
      ageRow.input.required = true;

      const note = AceUI.el("p", null, "");
      note.className = "row-note";
      note.style.marginTop = "var(--s4)";
      note.style.minHeight = "var(--s4)";

      const actions = AceUI.el("div", "sheet-actions");
      const go = AceUI.el("button", "act", "Start the camera check");
      go.type = "submit";
      actions.appendChild(go);

      const error = AceUI.el("p", "row-note");
      error.style.color = "var(--sig-blocked)";
      error.style.marginTop = "var(--s3)";

      form.appendChild(idRow.wrap);
      form.appendChild(ageRow.wrap);
      form.appendChild(note);
      form.appendChild(actions);
      form.appendChild(error);
      page.appendChild(form);

      let aside = null;
      const setAside = (band) => {
        if (aside) aside.remove();
        aside = planAside(band);
        page.appendChild(aside);
      };
      setAside("B");

      /**
       * Say what the entered age will actually do, before the operator
       * commits to it. The band boundary is not obvious and getting it wrong
       * costs a whole session.
       */
      const describe = () => {
        const age = Number(ageRow.input.value);
        if (!Number.isFinite(age) || age < MIN_AGE || age > MAX_AGE) {
          note.textContent = "";
          return;
        }
        const band = bandFor(age);
        note.textContent =
          band === "A"
            ? "Band A. Shorter games, and the instructions are read aloud."
            : "Band B. The standard battery.";
        setAside(band);
      };
      ageRow.input.addEventListener("input", describe);

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const participantId = idRow.input.value.trim();
        const age = Number(ageRow.input.value);

        // Each failure names the field and the rule, because "invalid input"
        // tells an operator nothing they can act on.
        if (!participantId) {
          error.textContent = "Enter a participant identifier before starting.";
          idRow.input.focus();
          return;
        }
        if (!Number.isFinite(age)) {
          error.textContent = "Enter an age in whole years.";
          ageRow.input.focus();
          return;
        }
        if (age < MIN_AGE || age > MAX_AGE) {
          error.textContent = `This battery covers ages ${MIN_AGE} to ${MAX_AGE}. Age ${age} is outside it, and no reference data exist for it.`;
          ageRow.input.focus();
          return;
        }

        resolve({ participantId, age, band: bandFor(age) });
      });

      idRow.input.focus();
    });
  }

  function field(labelText, type, id) {
    const wrap = AceUI.el("div");
    wrap.style.marginBottom = "var(--s4)";
    const label = AceUI.el("label", "label", labelText);
    label.setAttribute("for", id);
    label.style.display = "block";
    label.style.marginBottom = "var(--s2)";
    const input = AceUI.el("input", "field");
    input.id = id;
    input.type = type;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap, input, label };
  }

  return { show, bandFor, batteryFor, MIN_AGE, MAX_AGE };
})();
