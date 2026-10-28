// Nano Cortex Editor — live sync with the pedal (from #14 by @itsbreaded).
// Keeps the editor in step with what changes on the pedal itself: amp and effect knobs, footswitch bypasses and the
// expression pedal. None of this is in the upstream editor, and editor/index.html stays verbatim, so it lives here:
// core-level code that only uses core.js globals and overrides core functions through `window`, the way pro/ui.js
// does (a top-level function in core.js calls another by its global name, so the override is what runs).
// Loaded after core.js and before transfer.js and ui.js; pro/ui.js plugs its UI rules in through NanoLive.hooks.
// Protocol notes: docs/INVESTIGATION.md §12.
(() => {
  'use strict';

  // Message types upstream's MSG table doesn't name.
  const LIVE_MSG = Object.freeze({
    ControlChanged: 26,           // {1:1 3:control 4:raw 0–255 6:1}: amp, capture volume or gate reduction moved
    DeviceStateChanged: 31,       // {1:1}: something changed; {1:1 3:enable slot 4:0 on / 1 off}: an FX block switched
    ExpressionPosition: 64,       // {1:1 3:2 4:position 0–255}; at the heel field 4 is left out (protobuf zero)
    CabParamChanged: 94,          // a cab parameter moved; no field says which, so the state is read again
    FXParamChanged: 99,           // {1:1 3:FX slot 0–4 4:parameter 5:raw 0–255 as float32}
    DeleteLibraryIRRequest: 82,
    DeleteLibraryIRResponse: 83,
  });

  // pro/ui.js fills these in.
  const hooks = {
    keepLocalBypass: (_key, _enabled) => false,   // a bypass click the pedal hasn't confirmed yet wins over an older report
    expressionMoved: () => {},                     // the pedal moved: local edits of expression targets give way
    afterExpression: () => false,                  // re-apply local edits after a position was applied; true = changed
    stateRead: () => {},                           // a current-state read completed
  };

  const field = (fields, n) => fields[n] && fields[n][0];
  const varintOr = (fields, n, fallback) => { const e = field(fields, n); return e && e.wire === 0 ? e.value : fallback; };

  // ------------------------------------------------------------------ exact notification bytes
  // Upstream's onC305 (and wrappers that copy it) read `event.target.value.buffer` whole. A Web Bluetooth DataView
  // may be a window into a larger buffer, so the outermost handler hands every layer a value whose buffer holds
  // exactly the notification (pro/ui.js installs it last).
  function exactBytes(event) {
    const v = event && event.target && event.target.value;
    if (!v || !v.buffer) return null;
    const offset = v.byteOffset || 0;
    const length = typeof v.byteLength === 'number' ? v.byteLength : v.buffer.byteLength - offset;
    return new Uint8Array(v.buffer, offset, length);
  }
  function withExactBytes(handler) {
    return function (event, ...rest) {
      const v = event && event.target && event.target.value;
      if (v && v.buffer) {
        const bytes = exactBytes(event);
        if (bytes.byteOffset !== 0 || bytes.byteLength !== v.buffer.byteLength) {
          event = { target: { value: new DataView(bytes.slice().buffer) } };
        }
      }
      return handler.call(this, event, ...rest);
    };
  }

  // ------------------------------------------------------------------ state reads
  // The core reads the current preset with one request and a streamed reply (parseBufferedCurrentState). Count the
  // reads that complete, so a caller can wait for "a read that started after X" instead of guessing from timers.
  let stateReads = 0;
  const coreParseState = window.parseBufferedCurrentState;
  window.parseBufferedCurrentState = function () {
    const had = state.stateBytes.length > 0;
    const result = coreParseState.apply(this, arguments);
    if (had) noteStateRead();
    return result;
  };
  function noteStateRead() {
    stateReads++;
    try { hooks.stateRead(); } catch (err) { log('ERROR: state read hook: ' + err.message); }
  }

  // Reads the current preset's state again; true once a read that started now has completed.
  async function readCurrentState(timeoutMs = 6000) {
    if (!state.connected) return false;
    const before = stateReads;
    requestCurrentPresetState();
    const ok = await waitUntil(() => !state.connected || stateReads > before, timeoutMs);
    if (ok && state.connected) return true;
    if (state.stateMode === 'current' && !state.stateBytes.length) state.stateMode = 'idle';   // nothing came: unblock later reads
    return false;
  }

  // ------------------------------------------------------------------ one coalesced refresh
  // Reports without enough context (a bare type 31, an unknown control, a cab parameter) ask for one state read.
  // Several in a row make one read; it waits for reads and writes in flight and is dropped when a preset load (which
  // reads the state anyway) or any other state read starts first.
  let refresh = { timer: null, pending: false, keepModels: true };
  const busy = () => state.stateMode !== 'idle' || state.pendingParamBlock || state.paramRefreshQueue.length ||
    state.fileBusy || gattWriteQueue.length || gattWritePumpRunning;
  const presetLoading = () => state.protocol.presetLoad || state.presetLoadTimer;

  function scheduleStateRefresh({ keepModels = false } = {}) {
    if (!state.connected || presetLoading()) return;
    refresh.keepModels = refresh.pending ? refresh.keepModels && keepModels : keepModels;
    refresh.pending = true;
    clearTimeout(refresh.timer);
    refresh.timer = setTimeout(runStateRefresh, 150);
  }
  function runStateRefresh() {
    refresh.timer = null;
    if (!refresh.pending || !state.connected || presetLoading()) { refresh.pending = false; return; }
    if (busy()) { refresh.timer = setTimeout(runStateRefresh, 100); return; }
    refresh.pending = false;
    // A bypass or knob on the pedal can't change which effects are loaded, and the pedal may report stale model ids
    // in such a read (upstream skips the model fields after capture/cab changes for the same reason).
    if (refresh.keepModels) state.protocol.skipFXModelApply = true;
    log('Pedal state changed; refreshing the current preset');
    requestCurrentPresetState();
  }
  function cancelStateRefresh() {
    clearTimeout(refresh.timer);
    refresh = { timer: null, pending: false, keepModels: true };
  }
  const coreRequestState = window.requestCurrentPresetState;
  window.requestCurrentPresetState = function () {
    cancelStateRefresh();   // this read covers it
    return coreRequestState.apply(this, arguments);
  };

  // ------------------------------------------------------------------ expression pedal
  // Type 64 reports the pedal's position. Amp knobs, capture level and gate reduction follow it directly (their
  // ranges are known). An FX "Amount" is a different parameter per effect, so it only moves on screen when the
  // mapping is certain; otherwise the throttled read-back below shows the real value.
  const AMOUNT_BY_MODEL = { Transpose: 'Semitones' };   // effects whose Amount isn't their Mix (checked on a pedal)
  const notEnum = (p) => !(p.meta && p.meta.kind === 'enum');
  function expressionAmountParam(block) {
    if (!block || !block.params || !block.params.length || block.unknownId) return null;
    const names = AMOUNT_BY_MODEL[block.model] ? [AMOUNT_BY_MODEL[block.model]] : ['Mix', 'Amount'];
    for (const name of names) {
      const hit = block.params.find(p => normaliseName(p.name) === normaliseName(name) && notEnum(p));
      if (hit) return hit;
    }
    return null;
  }

  function expressionTargetState(target) {
    if (target.block) {
      const block = state.blocks[target.block];
      return block ? { get: () => block.on, set: (v) => { block.on = v; } } : null;
    }
    if (target.key === 'capture') return { get: () => state.capture.on, set: (v) => { state.capture.on = v; } };
    if (target.key === 'cab') return { get: () => state.cabIR.on, set: (v) => { state.cabIR.on = v; } };
    if (target.key === 'gate') return { get: () => state.gate.on, set: (v) => { state.gate.on = v; } };
    return null;
  }

  // Heel-toe switches act at the ends of the travel only, so a sweep doesn't flip them halfway.
  function heelToeEnabled(entry, raw) {
    if (!entry || !entry.on || entry.mode !== 'heelToe' || (raw > 2 && raw < 253)) return null;
    const atToe = raw >= 253;
    return entry.inverted ? !atToe : atToe;
  }
  function travel(range, raw) {
    const pos = clamp(Number(raw), 0, 255) / 255;
    const t = range.inverted ? 1 - pos : pos;
    const min = clamp(Number(range.min), 0, 100) / 100, max = clamp(Number(range.max), 0, 100) / 100;
    return clamp(min + t * (max - min), 0, 1);
  }

  const expr = { position: null, renderTimer: null, readTimer: null, readAt: 0 };
  const expressionLoaded = () => state.exp.loaded && state.exp.preset === state.selectedPreset;

  // Applies a position the pedal reported to the editor's model (the pedal has applied it already: UI only).
  function applyExpressionPosition(raw) {
    if (!expressionLoaded()) return false;
    let changed = false;
    const set = (get, put, value) => { if (get() !== value) { put(value); changed = true; } };
    for (const target of EXP_RANGES) {
      const range = state.exp.ranges[target.key];
      if (!range || !range.on) continue;
      const n = travel(range, raw);
      if (target.block) {
        const p = expressionAmountParam(state.blocks[target.block]);
        if (p) set(() => p.value, (v) => { p.value = v; }, normalizedToParamValue(p, n));
      } else if (['gain', 'bass', 'mid', 'treble'].includes(target.key)) {
        set(() => state.amp[target.key], (v) => { state.amp[target.key] = v; }, Math.round(n * 255));
      } else if (target.key === 'level') {
        set(() => state.captureVolumeDb, (v) => { state.captureVolumeDb = v; }, captureRawToDb(Math.round(n * 255)));
      } else if (target.key === 'gate' && state.gate.params[0]) {
        set(() => state.gate.params[0].value, (v) => { state.gate.params[0].value = v; }, Math.round(n * 100));
      }
    }
    for (const target of EXP_BYPASS) {
      const t = expressionTargetState(target);
      const on = t ? heelToeEnabled(state.exp.bypass[target.key], Number(raw)) : null;
      if (on !== null) set(t.get, t.set, on);
    }
    if (hooks.afterExpression()) changed = true;
    if (changed && !expr.renderTimer) expr.renderTimer = setTimeout(() => { expr.renderTimer = null; render(); }, 0);
    return changed;
  }
  // After a state read the dump shows the stored values; put the last reported position back on top.
  function reapplyExpression() {
    return expr.position === null ? false : applyExpressionPosition(expr.position);
  }

  // The FX blocks whose Amount is on the pedal (active ones only: reading a bypassed block crashed the Nano).
  // Nothing assigned → nothing to read.
  function expressionReadbackKeys() {
    if (!expressionLoaded()) return [];
    const keys = EXP_RANGES.filter(t => t.block && state.exp.ranges[t.key] && state.exp.ranges[t.key].on).map(t => t.block);
    return [...new Set(keys)].filter(key => {
      const b = state.blocks[key];
      return b && b.on && b.model !== 'None' && !b.unknownId && b.params && b.params.length > 0;
    });
  }
  // upstream's queueFXParamRefreshes() for some blocks only.
  function queueFXParamReads(keys) {
    if (state.fileBusy) return;
    cancelFXParamRefresh();
    state.paramRefreshQueue = keys.filter(key => {
      const b = state.blocks[key];
      return b && b.on && b.model !== 'None' && b.params && b.params.length > 0;
    });
    if (state.paramRefreshQueue.length) requestNextFXParamRefresh();
  }
  // Expression events come faster than a parameter read completes: at most one read-back every 250 ms while the
  // pedal moves, and never on top of a state read, a preset load or a read already in progress.
  const READBACK_MS = 250;
  function scheduleExpressionReadback() {
    if (!state.connected || state.fileBusy || expr.readTimer) return;
    const wait = Math.max(0, READBACK_MS - (Date.now() - expr.readAt));
    expr.readTimer = setTimeout(() => {
      expr.readTimer = null;
      if (!state.connected || state.fileBusy) return;
      if (state.stateMode !== 'idle' || presetLoading()) { scheduleExpressionReadback(); return; }
      if (state.pendingParamBlock || state.paramRefreshQueue.length) return;
      const keys = expressionReadbackKeys();
      if (!keys.length) return;
      expr.readAt = Date.now();
      queueFXParamReads(keys);
    }, wait);
  }
  function cancelExpression() {
    clearTimeout(expr.readTimer); expr.readTimer = null; expr.readAt = 0;
    clearTimeout(expr.renderTimer); expr.renderTimer = null;
    expr.position = null;
  }

  // A preset load (app, footswitch, connect) makes the last position and any read-back of the old preset stale.
  const coreBeginPresetLoad = window.beginPresetLoad;
  window.beginPresetLoad = function () {
    cancelExpression();
    cancelStateRefresh();
    return coreBeginPresetLoad.apply(this, arguments);
  };
  // The assignments arrive after the state: show the position the pedal already reported.
  const coreParseExp = window.parseExpAssignments;
  window.parseExpAssignments = function () {
    const result = coreParseExp.apply(this, arguments);
    reapplyExpression();
    return result;
  };

  // ------------------------------------------------------------------ live reports
  const CONTROLS = { 0x00: ['amp', 'gain'], 0x01: ['amp', 'level'], 0x02: ['amp', 'bass'], 0x03: ['amp', 'mid'], 0x04: ['amp', 'treble'],
    0x0A: ['capture', 'volume'], 0x0B: ['gate', 'reduction'] };
  let recentFXParam = null;   // a type-99 report comes with a type-26 control 6 carrying the same raw value

  function fixed32(entry) {
    if (!entry || entry.wire !== 5 || !entry.raw || entry.raw.length !== 4) return null;
    const v = new DataView(Uint8Array.from(entry.raw).buffer).getFloat32(0, true);
    return Number.isFinite(v) ? v : null;
  }
  const isReport = (f) => { const e = field(f, 1); return !!e && e.wire === 0 && e.value === 1; };

  // 26: true when applied (or a known companion); false when it needs a state read.
  function onControlReport(f) {
    const marker = field(f, 6), id = field(f, 3), value = field(f, 4);
    if (!marker || marker.wire !== 0 || marker.value !== 1 || (id && id.wire !== 0) || (value && value.wire !== 0)) return false;
    const control = id ? id.value : 0;       // gain is control 0: protobuf leaves the field out
    const raw = clamp(value ? value.value : 0, 0, 255);
    if (!CONTROLS[control]) {
      if (control === 0x06 && recentFXParam && Date.now() - recentFXParam.at < 250 && raw === Math.round(recentFXParam.raw)) { recentFXParam = null; return true; }
      return false;
    }
    const [kind, key] = CONTROLS[control];
    let changed = false;
    if (kind === 'amp') { if (state.amp[key] !== raw) { state.amp[key] = raw; changed = true; } }
    else if (kind === 'capture') { const db = captureRawToDb(raw); if (state.captureVolumeDb !== db) { state.captureVolumeDb = db; changed = true; } }
    else { const r = clamp(raw - 108, 0, 100); if (state.gate.params[0].value !== r) { state.gate.params[0].value = r; changed = true; } }   // gate: see the reduction read-back in ui.js
    if (changed) render();
    return true;
  }

  // 99: an FX parameter, by slot and index; zero slot, index and value are left out.
  function onFXParamReport(f) {
    const slot = field(f, 3), index = field(f, 4), value = field(f, 5);
    if ((slot && slot.wire !== 0) || (index && index.wire !== 0) || (value && value.wire !== 5)) return false;
    const s = slot ? slot.value : 0, i = index ? index.value : 0, raw = value ? fixed32(value) : 0;
    if (!(s >= 0 && s < FX_BLOCK_KEYS.length) || !(i >= 0) || raw === null || raw < 0 || raw > 255) return false;
    const block = state.blocks[FX_BLOCK_KEYS[s]];
    const p = block && !block.unknownId && block.params && block.params[i];
    if (!p) return false;
    recentFXParam = { raw, at: Date.now() };
    const next = normalizedToParamValue(p, raw / 255);
    if (p.value !== next) { p.value = next; render(); }
    return true;
  }

  // 31 with an enable slot: an FX block switched on the pedal (field 4 left out = 0 = on).
  function onEnableReport(f) {
    const slot = field(f, 3), value = field(f, 4);
    if (!slot || slot.wire !== 0 || (value && value.wire !== 0)) return false;
    const v = value ? value.value : 0;
    const key = FX_BLOCK_KEYS.find(k => blockSlotConfig[k] && blockSlotConfig[k].enableSlot === slot.value);
    if (!key || (v !== 0 && v !== 1)) return false;
    const enabled = v === 0;
    if (hooks.keepLocalBypass(key, enabled)) return true;
    if (state.blocks[key].on !== enabled) { state.blocks[key].on = enabled; render(); }
    return true;
  }

  // 64: the expression pedal's position (selector 3 = 2). The phone app's assignment read gets the same shape back
  // as a side reply, so it is ignored while that read is outstanding.
  function onExpressionReport(f) {
    if (varintOr(f, 3, 0) !== 2 || (state.exp && state.exp.pending)) return;
    expr.position = varintOr(f, 4, 0);
    hooks.expressionMoved();
    if (presetLoading()) return;
    applyExpressionPosition(expr.position);
    scheduleExpressionReadback();
  }

  // All live reports are handled inside the core's typed-message dispatch, after its RX log line and after any
  // waiter in pro/transfer.js or pro/ui.js had its chance; claiming them keeps them out of upstream's fallback.
  const coreTyped = window.handleTypedMessage;
  window.handleTypedMessage = function (data) {
    const type = frameType(data);
    try {
      if (type === LIVE_MSG.ControlChanged || type === LIVE_MSG.FXParamChanged || type === LIVE_MSG.DeviceStateChanged ||
          type === LIVE_MSG.ExpressionPosition || type === LIVE_MSG.CabParamChanged) {
        const f = framePayloadFields(data);
        if (type === LIVE_MSG.ExpressionPosition) { onExpressionReport(f); return true; }
        // Anything that can't be applied on the spot is read back once.
        if (type === LIVE_MSG.ControlChanged && !(isReport(f) && onControlReport(f))) scheduleStateRefresh();
        else if (type === LIVE_MSG.FXParamChanged && !(isReport(f) && onFXParamReport(f))) scheduleStateRefresh();
        else if (type === LIVE_MSG.DeviceStateChanged && !(isReport(f) && onEnableReport(f))) scheduleStateRefresh({ keepModels: true });
        else if (type === LIVE_MSG.CabParamChanged) scheduleStateRefresh();
        return true;
      }
    } catch (err) { log('ERROR: live report ' + type + ': ' + err.message); return true; }
    return coreTyped.apply(this, arguments);
  };

  // Disconnect (or demo stop): drop every timer and what the pedal last reported.
  function reset() {
    cancelStateRefresh();
    cancelExpression();
    recentFXParam = null;
  }

  window.NanoLive = {
    MSG: LIVE_MSG, hooks, exactBytes, withExactBytes,
    readCurrentState, noteStateRead, get stateReads() { return stateReads; },
    scheduleStateRefresh, cancelStateRefresh,
    expressionAmountParam, expressionTargetState, applyExpressionPosition, reapplyExpression, expressionReadbackKeys,
    queueFXParamReads, get expressionPosition() { return expr.position; },
    reset,
  };
})();
