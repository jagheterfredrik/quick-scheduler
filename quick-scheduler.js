// quick-scheduler: long-press an entity to create a one-shot schedule
// via scheduler-component's `scheduler.add` service.
//
// Card config:
//   hold_action:
//     action: fire-dom-event
//     quick_scheduler: true
//     entity: light.kitchen   # optional if the card has `entity`

const TAG = "quick-scheduler-dialog";
const STEP = 15; // minutes per minute-button press
const DAY = 24 * 60;

const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
const isSameDay = (a, b) => a.toDateString() === b.toDateString();

const getHass = () => document.querySelector("home-assistant")?.hass;

// Per-domain services for the two choices.
const DOMAIN_ACTIONS = {
  lock: {
    on: { service: "lock.lock", label: "Lock" },
    off: { service: "lock.unlock", label: "Unlock" },
  },
  cover: {
    on: { service: "cover.open_cover", label: "Open" },
    off: { service: "cover.close_cover", label: "Close" },
  },
};
const DEFAULT_ACTIONS = {
  on: { service: "homeassistant.turn_on", label: "Turn on" },
  off: { service: "homeassistant.turn_off", label: "Turn off" },
};
const actionsFor = (entityId) =>
  DOMAIN_ACTIONS[entityId.split(".")[0]] || DEFAULT_ACTIONS;

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const actionTargets = (action, entityId) =>
  [...asList(action.entity_id), ...asList(action.service_data?.entity_id)].includes(
    entityId
  );
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Upcoming runs of scheduler-component schedules that act on `entityId`,
// soonest first. Each entry is the schedule's next timeslot that targets
// the entity.
const upcomingFor = (schedules, entityId) => {
  const labels = Object.values(actionsFor(entityId));
  const labelFor = (service) =>
    labels.find((a) => a.service === service)?.label ||
    service.split(".").pop().replace(/_/g, " ");
  const now = Date.now();
  const items = [];
  for (const sched of schedules || []) {
    const slots = sched.timeslots || [];
    let best;
    slots.forEach((slot, i) => {
      const action = (slot.actions || []).find((a) => actionTargets(a, entityId));
      if (!action) return;
      const ts = new Date(sched.timestamps?.[i]);
      const when = ts > now ? ts : null;
      // Disabled schedules have no upcoming run but are still listed.
      if (!when && sched.enabled !== false) return;
      if (!best || (when && (!best.when || when < best.when))) {
        best = { when, service: action.service };
      }
    });
    if (!best) continue;
    items.push({
      entityId: sched.entity_id,
      label: labelFor(best.service),
      when: best.when,
      enabled: sched.enabled !== false,
      repeats: sched.repeat_type !== "single",
    });
  }
  // Enabled ones by time, disabled ones last.
  return items.sort(
    (a, b) => b.enabled - a.enabled || (a.when || 0) - (b.when || 0)
  );
};

// Fall back to the card's own config when the action has no `entity`.
const entityFromEvent = (ev) => {
  for (const el of ev.composedPath()) {
    const cfg = el && (el._config || el.config);
    if (cfg && typeof cfg.entity === "string") return cfg.entity;
  }
  return undefined;
};

const CLOSE =
  "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z";
const MINUS = "M19,13H5V11H19V13Z";
const PLUS = "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z";
const icon = (path) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;

// Compact picker: [-] HH [+] : [-] MM [+]. "time" wraps around midnight,
// "duration" is clamped to 15 min .. 23 h 45 min.
const pickerMarkup = (name, kind) => {
  const spin = (unit, step, label) => `
    <div class="spin">
      <button type="button" class="step" data-picker="${name}" data-step="-${step}"
        aria-label="${label} down">${icon(MINUS)}</button>
      <span class="value" data-value="${name}-${unit}"></span>
      <button type="button" class="step" data-picker="${name}" data-step="${step}"
        aria-label="${label} up">${icon(PLUS)}</button>
    </div>`;
  return `
    <div class="picker">
      ${spin("h", 60, "Hours")}
      ${kind === "time" ? '<span class="colon">:</span>' : ""}
      ${spin("m", STEP, "Minutes")}
    </div>`;
};

class SchedulerQuickDialog extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        dialog {
          border: none; border-radius: 24px; padding: 20px;
          width: min(380px, calc(100vw - 24px)); box-sizing: border-box;
          max-height: calc(100dvh - 24px);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color, #000);
          font-family: var(--ha-font-family-body, Roboto, sans-serif);
        }
        dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
        [hidden] { display: none !important; }
        h2 { margin: 0 0 16px; font-size: 20px; font-weight: 500;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .segmented { display: flex; gap: 6px; padding: 4px; border-radius: 14px;
          background: var(--secondary-background-color, #f2f2f2); }
        .segmented button {
          flex: 1; min-height: 44px; padding: 0 8px; font: inherit; font-size: 15px;
          border: none; border-radius: 10px; cursor: pointer;
          background: transparent; color: inherit;
        }
        .segmented button[aria-pressed="true"] {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
        }
        .segmented.small button { min-height: 36px; font-size: 14px; }

        .field { margin-top: 18px; }
        .label { display: flex; justify-content: space-between; align-items: baseline;
          font-size: 14px; margin-bottom: 8px; }
        .label .hint { color: var(--secondary-text-color, #666); }
        .field .picker, .field input { margin-top: 10px; }
        .label + .picker, .label + input { margin-top: 0; }

        .picker { display: flex; align-items: center; gap: 6px; }
        .spin { flex: 1; min-width: 0; display: flex; align-items: center; border-radius: 14px;
          background: var(--secondary-background-color, #f2f2f2); }
        .spin .value { flex: 1; min-width: 0; text-align: center; font-size: 26px;
          font-variant-numeric: tabular-nums; white-space: nowrap; }
        .colon { font-size: 26px; }
        button.step {
          flex: none; width: 44px; height: 48px; border: none; border-radius: 14px; cursor: pointer;
          background: transparent; color: inherit; padding: 0;
          display: flex; align-items: center; justify-content: center;
        }
        button.step svg { width: 22px; height: 22px; fill: currentColor; }
        button.step:active { background: var(--divider-color, #ddd); }
        .unit { font-size: 14px; color: var(--secondary-text-color, #666); margin-left: 2px; }

        input[type="datetime-local"] { width: 100%; box-sizing: border-box; padding: 10px 12px;
          font: inherit; font-size: 16px; border-radius: 14px; border: none;
          background: var(--secondary-background-color, #f2f2f2); color: inherit; }

        .error { color: var(--error-color, #db4437); font-size: 14px; margin-top: 12px; }
        .error:empty { display: none; }
        .footer { display: flex; align-items: center; gap: 8px; margin-top: 20px; }
        .footer .spacer { flex: 1; }
        .footer button { font: inherit; font-size: 15px; min-height: 40px; padding: 0 14px;
          border-radius: 20px; border: none; cursor: pointer; background: transparent;
          color: var(--primary-color, #03a9f4); white-space: nowrap; }
        .footer { gap: 4px; }
        .footer button.primary { background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff); padding: 0 20px; }
        .footer button#dateMode { padding: 0 8px; margin-left: -8px; font-size: 14px; }
        .footer button:disabled { opacity: 0.5; cursor: default; }

        .upcoming { margin: 20px -20px -20px; padding: 16px 20px 20px;
          border-top: 1px solid var(--divider-color, #ddd); }
        .upcoming ul { list-style: none; margin: 0; padding: 0; max-height: 168px;
          overflow-y: auto; border-radius: 14px;
          background: var(--secondary-background-color, #f2f2f2); }
        .upcoming li { display: flex; align-items: center; gap: 8px; min-height: 48px;
          padding: 0 4px 0 14px; font-size: 15px; }
        .upcoming li + li { border-top: 1px solid var(--divider-color, #ddd); }
        .upcoming .what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
          white-space: nowrap; }
        .upcoming .what .hint { color: var(--secondary-text-color, #666); font-size: 13px;
          margin-left: 6px; }
        .upcoming li.off .what { color: var(--secondary-text-color, #666); }
        .upcoming button { flex: none; border: none; cursor: pointer; font: inherit; }
        .upcoming button.delete { width: 44px; height: 44px; border-radius: 14px; padding: 0;
          background: transparent; color: var(--secondary-text-color, #666);
          display: flex; align-items: center; justify-content: center; }
        .upcoming button.delete svg { width: 20px; height: 20px; fill: currentColor; }
        .upcoming button.confirm { min-height: 32px; padding: 0 12px; margin-right: 6px;
          border-radius: 16px; font-size: 14px;
          background: var(--error-color, #db4437); color: #fff; }
        .upcoming button:disabled { opacity: 0.5; cursor: default; }
      </style>
      <dialog>
        <h2></h2>

        <div class="segmented" data-group="action">
          <button type="button" data-val="on"></button>
          <button type="button" data-val="off"></button>
        </div>

        <div class="field">
          <div class="label"><span>Start</span><span class="hint" data-when="start"></span></div>
          <div data-show="time">${pickerMarkup("start", "time")}</div>
          <input data-show="date" id="startDate" type="datetime-local" />
        </div>

        <div class="field">
          <div class="label"><span data-revert-title></span><span class="hint" data-when="end"></span></div>
          <div class="segmented small" data-group="endMode">
            <button type="button" data-val="none">Never</button>
            <button type="button" data-val="relative">After</button>
            <button type="button" data-val="absolute">At</button>
          </div>
          <div data-show-end="relative">${pickerMarkup("duration", "duration")}</div>
          <div data-show-end="absolute">
            <div data-show="time">${pickerMarkup("end", "time")}</div>
            <input data-show="date" id="endDate" type="datetime-local" />
          </div>
        </div>

        <div class="error"></div>
        <div class="footer">
          <button type="button" id="dateMode"></button>
          <span class="spacer"></span>
          <button type="button" id="cancel">Cancel</button>
          <button type="button" id="save" class="primary">Schedule</button>
        </div>

        <div class="upcoming" hidden>
          <div class="label"><span>Upcoming</span></div>
          <ul></ul>
        </div>
      </dialog>`;

    this._dialog = this._$("dialog");
    this._dialog.addEventListener("close", () => this.remove());
    this._$("#cancel").addEventListener("click", () => this._dialog.close());
    this._$("#save").addEventListener("click", () => this._save());
    this._$("#dateMode").addEventListener("click", () => {
      this._state.dateMode = !this._state.dateMode;
      this._update();
    });
    for (const id of ["#startDate", "#endDate"]) {
      this._$(id).addEventListener("input", () => this._update());
    }
    this.shadowRoot.addEventListener("click", (e) => {
      const del = e.target.closest(".upcoming button");
      if (del) {
        if (del.classList.contains("confirm")) this._removeSchedule(del.dataset.id);
        else this._renderUpcoming(del.dataset.id);
        return;
      }
      if (this._confirming) this._renderUpcoming(); // tap elsewhere cancels
      const seg = e.target.closest(".segmented button");
      if (seg) {
        this._state[seg.parentElement.dataset.group] = seg.dataset.val;
        this._update();
        return;
      }
      const step = e.target.closest("button.step");
      if (step) this._step(step.dataset.picker, Number(step.dataset.step));
    });
  }

  _$(s) {
    return this.shadowRoot.querySelector(s);
  }

  open(entityId) {
    const hass = getHass();
    this._entityId = entityId;
    this._actions = actionsFor(entityId);
    this._$("h2").textContent =
      hass?.states[entityId]?.attributes.friendly_name || entityId;
    this._$('[data-group="action"] [data-val="on"]').textContent =
      this._actions.on.label;
    this._$('[data-group="action"] [data-val="off"]').textContent =
      this._actions.off.label;

    // Default start: the next 15-minute slot from now.
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const start = (Math.floor(nowMin / STEP) + 1) * STEP;
    this._state = {
      action: "on",
      endMode: "none",
      dateMode: false,
      start: start % DAY,
      duration: 60,
      end: (start + 60) % DAY,
    };
    const startDate = addMinutes(now, start - nowMin);
    startDate.setSeconds(0, 0);
    this._$("#startDate").value = toLocalInput(startDate);
    this._$("#endDate").value = toLocalInput(addMinutes(startDate, 60));
    this._update();
    this._dialog.showModal();
    this._loadUpcoming();
  }

  // Fetch schedules from scheduler-component. If that fails (component
  // missing, old version), the section just stays hidden.
  async _loadUpcoming() {
    try {
      const schedules = await getHass().callWS({ type: "scheduler" });
      this._upcoming = upcomingFor(schedules, this._entityId);
    } catch (err) {
      console.warn("quick-scheduler: could not list schedules", err);
      this._upcoming = [];
    }
    this._renderUpcoming();
  }

  // `confirming` is the schedule entity whose delete button was tapped once.
  _renderUpcoming(confirming) {
    this._confirming = confirming;
    const items = this._upcoming || [];
    this._$(".upcoming").hidden = items.length === 0;
    this._$(".upcoming ul").innerHTML = items
      .map((it) => {
        const id = escapeHtml(it.entityId);
        const when = it.when ? this._describe(it.when) : "Disabled";
        const hint = it.repeats ? '<span class="hint">Repeats</span>' : "";
        const button =
          it.entityId === confirming
            ? `<button type="button" class="confirm" data-id="${id}">Remove</button>`
            : `<button type="button" class="delete" data-id="${id}"
                aria-label="Remove ${escapeHtml(it.label)} ${escapeHtml(when)}">${icon(CLOSE)}</button>`;
        return `<li class="${it.enabled ? "" : "off"}">
          <span class="what">${escapeHtml(it.label)} · ${escapeHtml(when)}${hint}</span>
          ${button}
        </li>`;
      })
      .join("");
  }

  async _removeSchedule(scheduleEntityId) {
    const error = this._$(".error");
    error.textContent = "";
    for (const b of this.shadowRoot.querySelectorAll(".upcoming button")) {
      b.disabled = true;
    }
    try {
      await getHass().callService("scheduler", "remove", {
        entity_id: scheduleEntityId,
      });
      this._upcoming = this._upcoming.filter((it) => it.entityId !== scheduleEntityId);
      this._renderUpcoming();
    } catch (err) {
      error.textContent = `Failed to remove: ${err?.message || err}`;
      this._renderUpcoming();
    }
  }

  _step(picker, delta) {
    const s = this._state;
    if (picker === "duration") {
      s.duration = Math.min(DAY - STEP, Math.max(STEP, s.duration + delta));
    } else {
      // Snap to the 15-minute grid, then wrap around midnight.
      const snapped = Math.round(s[picker] / STEP) * STEP;
      s[picker] = (((snapped + delta) % DAY) + DAY) % DAY;
    }
    this._update();
  }

  // Next occurrence of a minute-of-day after `after` (within 24 hours).
  _nextAt(minuteOfDay, after) {
    const d = new Date(after);
    d.setHours(Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0, 0);
    if (d <= after) d.setDate(d.getDate() + 1);
    return d;
  }

  _times() {
    const s = this._state;
    const start = s.dateMode
      ? new Date(this._$("#startDate").value)
      : this._nextAt(s.start, new Date());
    let end;
    if (s.endMode === "relative") {
      end = addMinutes(start, s.duration);
    } else if (s.endMode === "absolute") {
      end = s.dateMode
        ? new Date(this._$("#endDate").value)
        : this._nextAt(s.end, start);
    }
    return { start, end };
  }

  _describe(d) {
    if (isNaN(d)) return "";
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (isSameDay(d, now)) return `Today ${time}`;
    if (isSameDay(d, addMinutes(now, DAY))) return `Tomorrow ${time}`;
    return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} ${time}`;
  }

  _update() {
    const s = this._state;
    for (const btn of this.shadowRoot.querySelectorAll(".segmented button")) {
      btn.setAttribute(
        "aria-pressed",
        String(s[btn.parentElement.dataset.group] === btn.dataset.val)
      );
    }
    for (const el of this.shadowRoot.querySelectorAll("[data-show]")) {
      el.hidden = (el.dataset.show === "date") !== s.dateMode;
    }
    for (const el of this.shadowRoot.querySelectorAll("[data-show-end]")) {
      el.hidden = el.dataset.showEnd !== s.endMode;
    }
    this._$("#dateMode").textContent = s.dateMode ? "Next 24 h" : "Pick date";

    const setPicker = (name, minutes) => {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      const unit = (u) => (name === "duration" ? `<span class="unit">${u}</span>` : "");
      this._$(`[data-value="${name}-h"]`).innerHTML =
        (name === "duration" ? h : pad(h)) + unit("h");
      this._$(`[data-value="${name}-m"]`).innerHTML = pad(m) + unit("m");
    };
    setPicker("start", s.start);
    setPicker("end", s.end);
    setPicker("duration", s.duration);

    const revert = this._actions[s.action === "on" ? "off" : "on"];
    this._$("[data-revert-title]").textContent = `${revert.label} again`;

    const { start, end } = this._times();
    this._$('[data-when="start"]').textContent = this._describe(start);
    this._$('[data-when="end"]').textContent = end ? this._describe(end) : "";
  }

  _schedule(when, service, label) {
    const [date, time] = toLocalInput(when).split("T");
    return {
      start_date: date,
      end_date: date,
      repeat_type: "single",
      name: `${label} ${this._entityId} ${date} ${time}`,
      timeslots: [
        {
          start: time,
          actions: [{ service, entity_id: this._entityId }],
        },
      ],
    };
  }

  async _save() {
    const error = this._$(".error");
    error.textContent = "";
    const hass = getHass();
    if (!hass) {
      error.textContent = "Home Assistant connection not found.";
      return;
    }
    const { start, end } = this._times();
    if (isNaN(start) || start <= new Date()) {
      error.textContent = "Start must be in the future.";
      return;
    }
    if (end !== undefined && (isNaN(end) || end <= start)) {
      error.textContent = "End must be after start.";
      return;
    }

    const s = this._state;
    const first = this._actions[s.action];
    const revert = this._actions[s.action === "on" ? "off" : "on"];
    const payloads = [this._schedule(start, first.service, first.label)];
    if (end) payloads.push(this._schedule(end, revert.service, revert.label));

    const save = this._$("#save");
    save.disabled = true;
    try {
      for (const data of payloads) {
        await hass.callService("scheduler", "add", data);
      }
      this._dialog.close();
    } catch (err) {
      error.textContent = `Failed: ${err?.message || err}`;
      save.disabled = false;
    }
  }
}

if (!customElements.get(TAG)) {
  customElements.define(TAG, SchedulerQuickDialog);
}

window.addEventListener("ll-custom", (ev) => {
  const cfg = ev.detail;
  if (!cfg || !cfg.quick_scheduler) return;
  const entityId = cfg.entity || entityFromEvent(ev);
  if (!entityId) return;
  const dialog = document.createElement(TAG);
  document.body.appendChild(dialog);
  dialog.open(entityId);
});
