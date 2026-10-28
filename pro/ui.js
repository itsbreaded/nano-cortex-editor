// Nano Cortex Editor — pro UI layer.
// Sits on top of core.js (generated from the upstream editor). Core owns the
// BLE protocol and the `state` object; this file owns everything you see.
// Core calls render(), renderPresetSelect(), renderCaptureIR(),
// renderCaptureIRExtraParams(), log(), setStatus(), setCaptureVolumeUI();
// all of those are (re)defined here on window.

(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') n.textContent = v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return n;
  };
  const svgNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs = {}) => {
    const n = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  // The platform: the shell's process.platform (src/editor-preload.js) when there is one, else the browser's.
  // Key handlers always follow the real platform (modKey: ⌘ on macOS, Ctrl elsewhere). Shortcut labels follow
  // `isMac`, which a test can override with ?platform=mac|win|linux to check the other platforms' labels.
  const realMac = window.nanoShell && window.nanoShell.platform ? window.nanoShell.platform === 'darwin'
    : /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const platformParam = (/[?&]platform=(mac|darwin|win|win32|linux)\b/.exec(location.search) || [])[1];
  const isMac = platformParam ? /^(mac|darwin)$/.test(platformParam) : realMac;
  const modKey = (e) => (realMac ? e.metaKey : e.ctrlKey);
  // Shortcut labels are written the Mac way (⌘S, ⇧⌘S, ⌥⌘I) and shown as Ctrl+S, Ctrl+Shift+S, Ctrl+Alt+I on
  // Windows and Linux. Works on a single shortcut or on any text containing them ("Save (⌘S)").
  const keyLabel = (text) => isMac ? String(text) : String(text).replace(/[\u2325\u21e7\u2318]+(.)/gu, (_m, k) => {
    const mods = _m.slice(0, -k.length);
    return [mods.includes('\u2318') && 'Ctrl', mods.includes('\u2325') && 'Alt', mods.includes('\u21e7') && 'Shift'].filter(Boolean).join('+') + '+' + k;
  });
  window.__keyLabel = keyLabel;   // for the UX test
  const typingTarget = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // The firmware the effect tables (upstream's, in core.js) were verified against on hardware. A pedal reporting a
  // newer one gets a one-time notice; see "After a firmware update" in CLAUDE.md before raising it.
  const COMPAT = Object.freeze({ testedFirmware: '2.2.1' });

  // ------------------------------------------------------------------ capture kinds
  // A library capture's `type` (protobuf field 6; Cloud metadata `deviceType`) and `instrument` (field 10;
  // `instrumentType`) shown as small icons in the library picker. Our own line drawings (16×16, 1.5 px stroke,
  // currentColor); the native app reuses these strings verbatim. `default` / `instrument_not_set` mean
  // "unknown" and get no icon; words missing from the table get none either but stay in the row's tooltip.
  const KIND_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">';
  const KIND_ICONS = {
    ampHead: KIND_SVG + '<rect x="1.5" y="5.5" width="13" height="7" rx="1"/><path d="M6 5.5V3.5h4v2M4.5 8h0M8 8h0M11.5 8h0"/></svg>',
    combo: KIND_SVG + '<rect x="1.5" y="1.5" width="13" height="13" rx="1"/><path d="M1.5 5.5h13M4.5 3.5h0M7 3.5h0"/><circle cx="8" cy="10" r="2.5"/></svg>',
    pedal: KIND_SVG + '<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M8 4.5h0"/><circle cx="8" cy="10.5" r="1.75"/></svg>',
    rack: KIND_SVG + '<rect x="1.5" y="5.5" width="13" height="5" rx=".5"/><path d="M3.5 5.5v5M12.5 5.5v5M6.5 8h0M9.5 8h0"/></svg>',
    powerAmp: KIND_SVG + '<rect x="1.5" y="3.5" width="13" height="9" rx="1"/><circle cx="10.5" cy="8" r="2"/><path d="M5.5 5.5 4 8h2.5L5 10.5"/></svg>',
    fullRig: KIND_SVG + '<rect x="3.5" y="1.5" width="9" height="4" rx=".5"/><path d="M6 3.5h0M8 3.5h0M10 3.5h0"/><rect x="2.5" y="7.5" width="11" height="7" rx=".5"/><circle cx="8" cy="11" r="2"/></svg>',
    cab: KIND_SVG + '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><circle cx="8" cy="8" r="3"/></svg>',
    guitar: KIND_SVG + '<path d="M9.5 6.5 14 2"/><path d="M8.2 5.3c-.9-.4-2 0-2.4 1-.2.5-.8.6-1.4.6-1.6 0-2.9 1.3-2.9 2.9 0 2.4 1.9 4.1 4.1 4.1 1.6 0 2.9-1.3 2.9-2.9 0-.6.1-1.2.6-1.4 1-.4 1.4-1.5 1-2.4z"/><path d="M5 11h0"/></svg>',
    bass: KIND_SVG + '<path d="M9.5 6.5 14.5 1.5"/><path d="M8.2 5.3c-.9-.4-2 0-2.4 1-.2.5-.8.6-1.4.6-1.6 0-2.9 1.3-2.9 2.9 0 2.4 1.9 4.1 4.1 4.1 1.6 0 2.9-1.3 2.9-2.9 0-.6.1-1.2.6-1.4 1-.4 1.4-1.5 1-2.4z"/><path d="M5 11h0M12 2.5l1.5 1.5"/></svg>',
  };
  const CAPTURE_KINDS = {
    type: {
      amp_head: { icon: KIND_ICONS.ampHead, label: 'Amp head' },
      amp: { icon: KIND_ICONS.ampHead, label: 'Amp head' },
      combo: { icon: KIND_ICONS.combo, label: 'Combo' },
      amp_combo: { icon: KIND_ICONS.combo, label: 'Combo' },   // the word a real pedal reports for combos
      pedal: { icon: KIND_ICONS.pedal, label: 'Pedal' },
      preamp: { icon: KIND_ICONS.rack, label: 'Preamp' },
      rack: { icon: KIND_ICONS.rack, label: 'Rack' },
      power_amp: { icon: KIND_ICONS.powerAmp, label: 'Power amp' },
      full_rig: { icon: KIND_ICONS.fullRig, label: 'Full rig' },
      rig: { icon: KIND_ICONS.fullRig, label: 'Full rig' },
      cab: { icon: KIND_ICONS.cab, label: 'Cab' },
      default: null,
    },
    instrument: {
      guitar: { icon: KIND_ICONS.guitar, label: 'Guitar' },
      bass: { icon: KIND_ICONS.bass, label: 'Bass' },
      instrument_not_set: null,
    },
  };
  window.__CAPTURE_KINDS = CAPTURE_KINDS;
  const unknownKinds = new Set();
  // One icon node for a type/instrument word, or null (unknown, or deliberately iconless).
  function kindIcon(table, word) {
    if (!word) return null;
    const key = String(word).toLowerCase();
    if (!(key in CAPTURE_KINDS[table])) {
      if (!unknownKinds.has(key)) { unknownKinds.add(key); console.debug('[library] unknown capture kind', word); }
      return null;
    }
    const k = CAPTURE_KINDS[table][key];
    if (!k) return null;
    const n = el('span', { class: 'kind', title: k.label, 'aria-label': k.label, role: 'img', dataset: { kind: table, word: key } });
    n.innerHTML = k.icon;
    return n;
  }
  // The library picker row's subtitle: [type icon] [instrument icon] Author.
  const captureSub = (it) => {
    const kids = [kindIcon('type', it.type), kindIcon('instrument', it.instrument), it.author ? el('span', { class: 'author', text: it.author }) : null].filter(Boolean);
    return kids.length ? kids : null;
  };

  // ------------------------------------------------------------------ UI state
  const ui = {
    selected: 'capture',
    demo: false,
    clearOverridesOnRead: true,   // the next state dump replaces local edits of expression targets
    expressionLocalOverrides: new Map(),
    pendingBypassTargets: new Map(),
    bypassWriteChain: Promise.resolve(),
    bypassWriteGeneration: 0,
    stagePointerClicks: new Map(),
    bypassPointerClicks: new Map(),
    stageContextNativePending: false,
    connText: 'Not connected',
    connecting: false,
    connectError: '',
    connectHelp: false,   // the error has a Troubleshooting link (pedal not found, Bluetooth off)
    filter: '',
    drawerOpen: false,
    editing: false,       // an inline value editor is open
    renderQueued: false,
    knobDragging: false,  // defer full renders while a pointer drag owns a knob
    renderAfterKnob: false,
    sideSig: '',
    presetReorderBusy: false,
    presetUnknown: false,   // a read after a preset move failed: which preset the pedal is on isn't known
    lastAction: '',
    logs: [],
    logSeq: 0,   // lines ever logged; each entry carries its number, so readers can index past the trim below
    usage: null,          // last slot usage scan: { captures, cabs, library, cabLibrary, date, complete, scanned, total }
    scanning: false,
    scanStop: false,
    previewing: false,
    previewBusy: false,
    previewName: '',
    cabIRLoadActive: null,
    cabIRLoadQueue: [],
    cabIRLoadPaused: false,
    cabIRLoadTimedOut: null,
    captureSlotPreselect: 0,
    pendingIRSlotTarget: null,
  };
  window.__ui = ui; // handy for poking at from DevTools
  let presetMoveProtocolPending = false;
  let suppressPresetClickUntil = 0;

  // ------------------------------------------------------------------ settings storage + accent colour
  // Small per-machine preferences in localStorage under "settings.*". The metronome keeps its own "metronome" key.
  const pref = {
    get(k, dflt) { try { const v = localStorage.getItem('settings.' + k); return v === null ? dflt : JSON.parse(v); } catch { return dflt; } },
    set(k, v) { try { localStorage.setItem('settings.' + k, JSON.stringify(v)); } catch { /* fine */ } },
  };
  let devTools = !!pref.get('devTools', false);   // Settings → Developer tools (see applyDevTools)
  // Cortex Control's palette. `hi` is the hover shade; when absent it is derived.
  const ACCENTS = [
    { id: 'purple', name: 'Purple', hex: '#6954ff', hi: '#7b68ff', focus: '#9d8dff' },
    { id: 'teal', name: 'Teal', hex: '#00ffdd' },
    { id: 'green', name: 'Green', hex: '#45f862' },
    { id: 'orange', name: 'Orange', hex: '#ff7000' },
    { id: 'yellow', name: 'Yellow', hex: '#ffd236' },
    { id: 'red', name: 'Red', hex: '#e44a5d' },
    { id: 'blue', name: 'Blue', hex: '#4a9eff' },
  ];
  const rgbOf = (hex) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const hexOf = (c) => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const tint = (hex, t) => hexOf(rgbOf(hex).map(v => v + (255 - v) * t));   // toward white
  const luminance = (hex) => {
    const [r, g, b] = rgbOf(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const accentOf = (hex) => ACCENTS.find(a => a.hex === String(hex || '').toLowerCase()) || ACCENTS[0];
  // Sets --accent, --accent-hi (~8 % lighter), --focus (lighter still) and --on-accent (text on accent
  // fills: white or near-black, whichever reads better). Everything purple in ui.css derives from these.
  function applyAccent(hex) {
    const a = accentOf(hex);
    const root = document.documentElement.style;
    root.setProperty('--accent', a.hex);
    root.setProperty('--accent-hi', a.hi || tint(a.hex, 0.12));
    root.setProperty('--focus', a.focus || tint(a.hex, 0.35));
    const L = luminance(a.hex);
    root.setProperty('--on-accent', 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? '#ffffff' : '#121212');
    return a;
  }
  const shellBridge = window.nanoShell || null;   // the desktop shell (src/editor-preload.js); absent in tests and the web preview
  function setAccent(hex) {
    const a = applyAccent(hex);
    pref.set('accent', a.hex);
    if (shellBridge) shellBridge.setAccent(a.hex, pref.get('dockFollowsAccent', true)).catch(() => {});
    return a;
  }
  applyAccent(pref.get('accent', ACCENTS[0].hex));
  window.__accent = { ACCENTS, set: setAccent };

  // Outside links (pro/links.js) always open in the default browser: through the shell when there is one,
  // otherwise as a new window, which the desktop shell (and the UX test) hand to the system instead.
  const LINKS = window.NANO_LINKS || {};
  function openLink(url) {
    if (!/^https:\/\//.test(url || '')) return;
    if (shellBridge && shellBridge.openExternal) shellBridge.openExternal(url).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  }
  // A quiet text link: real href (so it reads as a link), opened by openLink.
  const linkEl = (url, label, fk, extra = {}) => el('a', { class: 'ext-link', href: url, dataset: { fk }, ...extra,
    onclick: (e) => { e.preventDefault(); openLink(url); } }, label);
  window.__openLink = openLink;

  // ------------------------------------------------------------------ chain model
  const STAGES = [
    { key: 'gate',    title: 'Gate' },
    { key: 'pre1',    title: 'Pre FX 1' },
    { key: 'pre2',    title: 'Pre FX 2' },
    { key: 'capture', title: 'Capture' },
    { key: 'cab',     title: 'Cab / IR' },
    { key: 'post1',   title: 'Post FX 1' },
    { key: 'post2',   title: 'Post FX 2' },
    { key: 'post3',   title: 'Post FX 3' },
  ];
  const stage = (key) => STAGES.find(s => s.key === key);
  // Colours follow Cortex Control's block scheme: fixed hues for gate, capture
  // and cab; an effect slot takes the colour of the effect category loaded in
  // it (FX_COLORS from upstream, the Quad Cortex category palette).
  const CATEGORY_KEY = { 'Overdrive': 'overdrive', 'Compressor': 'compressor', 'Utility/EQ': 'equalizer', 'Wah/Filter': 'filter', 'Modulation': 'modulation', 'Delay': 'delay', 'Reverb': 'reverb', 'Pitch': 'pitch', 'Utility': 'utility' };
  function stageColor(key) {
    if (key === 'gate') return 'var(--c-gate)';
    if (key === 'capture') return 'var(--c-capture)';
    if (key === 'cab') return 'var(--c-cab)';
    const b = state.blocks[key];
    const def = b && b.models.find(m => m.name === b.model);
    if (!def || b.model === 'None') return FX_COLORS.none;
    const cat = CATEGORY_KEY[def.category] || 'utility';
    return READABLE[cat] || FX_COLORS[cat] || FX_COLORS.utility;
  }
  // Two Quad Cortex hues are too dark on a near-black panel; same family, more light. Upstream gives Reverb the
  // same #00FFDD as Delay, so a delay next to a reverb looked identical: Reverb is soft pink here (both editions).
  // Every category colour goes through stageColor(), so this map is the one place for them.
  const READABLE = { modulation: '#8f78ff', equalizer: '#4a9eff', reverb: '#f570d6' };
  STAGES.forEach(s => Object.defineProperty(s, 'color', { get: () => stageColor(s.key) }));
  window.__stageColor = stageColor;   // the UX test checks every category's colour

  const presetName = (n) => state.presetNames.get(n) || ('Preset ' + n);
  const captureSlotCount = () => Math.max(25, ...state.captureNames.keys());
  const irSlotCount = () => Math.max(5, ...state.irNames.keys());
  const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

  // A preset can play a capture or IR straight from the pedal's library rather than from a slot: the state
  // dump then reports capture position 6 / cab slot 6, one past the range (PROTOCOL-NOTES §8 in the native repo).
  // state.capture.fromLibrary / state.cabIR.fromLibrary are set from the dump (and by demo mode).
  function activeCaptureSlot() {
    if (!state.capture.on) return 0;
    if (state.capture.fromLibrary) return null;
    const sel = state.capture.selectedSlot;   // two slots can hold the same capture: trust the selected one when it fits
    if (sel && sameName(state.captureNames.get(sel), state.currentCapture.name)) return sel;
    for (let i = 1; i <= captureSlotCount(); i++) {
      if (state.currentCapture.name && sameName(state.captureNames.get(i), state.currentCapture.name)) return i;
    }
    return state.capture.selectedSlot || null;
  }
  function activeIRSlot() {
    const pending = ui.pendingIRSlotTarget;
    if (pending && pending.preset === Number(state.selectedPreset)) return pending.slot;
    if (!state.cabIR.on) return 0;
    if (state.cabIR.fromLibrary) return null;
    const sel = state.cabIR.selectedSlot;
    if (Number.isInteger(sel) && sel >= 1 && sel <= 5) return sel;
    for (let i = 1; i <= irSlotCount(); i++) {
      if (state.currentIR.shortName && sameName(state.irNames.get(i), state.currentIR.shortName)) return i;
    }
    return state.cabIR.selectedSlot || null;
  }

  function selectedIRIsFactory() {
    const slot = activeIRSlot();
    const name = slot && state.irNames.get(slot);
    const factoryIRs = state.library.irFactory || [];
    if (slot && slot >= 1 && slot <= 5 && state.library.loaded) {
      // With the pedal library loaded, a pedal slot is factory only when its
      // actual contents match a factory entry. Missing or user names must not
      // inherit the microphone from an IR that was only being previewed.
      return Boolean(name && factoryIRs.some(item => sameName(item.name, name)));
    }
    if (name) {
      // The selected pedal slot is authoritative when preview state leaves the
      // current IR name stale. Unknown slot names are non-factory once the
      // pedal library has been read, rather than inheriting the preview's mic.
      if (factoryIRs.some(item => sameName(item.name, name))) return true;
      if ((state.library.irUser || []).some(item => sameName(item.name, name)) || state.library.loaded) return false;
    }
    return isFactoryCabIR();
  }

  const shortMic = (m) => String(m || '').replace('Condenser', 'Cond').replace('Dynamic', 'Dyn').replace('Ribbon', 'Rib');

  const actualStageEnabled = (key) => key === 'gate' ? Boolean(state.gate.on)
    : key === 'capture' ? Boolean(state.capture.on)
      : key === 'cab' ? Boolean(state.cabIR.on) : Boolean(state.blocks[key] && state.blocks[key].on);
  const stageEnabled = (key) => {
    const pending = ui.pendingBypassTargets.get(key);
    return pending && pending.preset === Number(state.selectedPreset) ? pending.on : actualStageEnabled(key);
  };

  function stageInfo(key) {
    if (key === 'gate') {
      const r = state.gate.params[0];
      return { on: stageEnabled(key), model: 'Noise gate', sub: 'Reduction ' + Math.round(r.value) + '%', canToggle: true };
    }
    if (key === 'capture') {
      const slot = activeCaptureSlot();
      const name = state.currentCapture.name || (slot ? state.captureNames.get(slot) : '') || '';
      const on = stageEnabled(key);
      return {
        on,
        model: name || 'Capture',
        sub: !on ? 'Bypassed' : state.capture.fromLibrary ? 'From the library: ' + (name || 'capture')
          : (state.currentCapture.inBank === false ? 'Library capture' : (slot ? 'Slot ' + slot : '')),
        canToggle: true,
      };
    }
    if (key === 'cab') {
      const name = state.currentIR.shortName || '';
      const on = stageEnabled(key);
      return {
        on,
        model: name || 'Cab / IR',
        sub: !on ? 'Bypassed' : state.cabIR.fromLibrary ? 'From the library: ' + (name || 'cab') : (selectedIRIsFactory() ? shortMic(state.cabIR.mic) + ', pos ' + state.cabIR.position : (state.currentIR.inBank === false ? 'Library IR' : 'User IR')),
        canToggle: true,
      };
    }
    const b = state.blocks[key];
    if (b.unknownId) return { on: stageEnabled(key), none: false, unknown: true, model: 'Unknown effect', sub: 'Newer firmware?', canToggle: true };
    const def = b.models.find(m => m.name === b.model);
    const none = b.model === 'None';
    return {
      on: stageEnabled(key), none,
      model: none ? 'Empty' : b.model,
      sub: none ? 'Add effect' : (def ? def.category : ''),
      canToggle: !(none && !stageEnabled(key)),
    };
  }

  // ------------------------------------------------------------------ actions
  function pedalDirtyForUI() {
    return Boolean(state.presetDirty);
  }

  function setStageEnabled(key, on) {
    if (key === 'gate') state.gate.on = on;
    else if (key === 'capture') state.capture.on = on;
    else if (key === 'cab') state.cabIR.on = on;
    else if (state.blocks[key]) state.blocks[key].on = on;
  }
  function writeStageEnabled(key, on) {
    if (key === 'gate') return setGateEnabled(on);
    if (key === 'capture') return on ? setCapture(state.capture.lastActiveSlot || 1) : selectCaptureSlot(0);
    if (key === 'cab') return selectCabIRSlot(on ? (state.cabIR.lastActiveSlot || 1) : 0);
    return setFXBlockEnabled(key, on);
  }
  const BYPASS_TARGET_GRACE_MS = 300;
  function applyPendingBypassTargets() {
    const preset = Number(state.selectedPreset);
    let changed = false;
    for (const [key, target] of ui.pendingBypassTargets) {
      if (target.preset === preset && actualStageEnabled(key) !== target.on) {
        setStageEnabled(key, target.on);
        changed = true;
      }
    }
    return changed;
  }
  function refreshAfterBypassWrites(job) {
    if (job.generation !== ui.bypassWriteGeneration || job.preset !== Number(state.selectedPreset)) return Promise.resolve();
    if (!state.connected || ui.demo) {
      if (job.generation === ui.bypassWriteGeneration) {
        setTimeout(() => {
          if (job.generation === ui.bypassWriteGeneration) ui.pendingBypassTargets.clear();
        }, BYPASS_TARGET_GRACE_MS);
      }
      return Promise.resolve();
    }
    const checked = waitForPresetState(job.preset, 1800);
    return Promise.resolve(requestCurrentPresetState()).then(() => checked).then(() => {
      if (job.generation === ui.bypassWriteGeneration) ui.pendingBypassTargets.clear();
    });
  }
  function queueStageEnabled(key, on) {
    const job = { key, on: Boolean(on), preset: Number(state.selectedPreset), generation: ++ui.bypassWriteGeneration };
    ui.pendingBypassTargets.set(key, job);
    ui.bypassWriteChain = ui.bypassWriteChain
      .catch(() => {})
      .then(() => job.preset === Number(state.selectedPreset) ? writeStageEnabled(key, job.on) : false)
      .then(() => refreshAfterBypassWrites(job))
      .catch(err => log('ERROR: bypass write: ' + err.message));
  }

  function toggleStage(key) {
    if (!state.connected) return;
    if (key !== 'gate' && key !== 'capture' && key !== 'cab') {
      const b = state.blocks[key];
      if (!b) return;
      if (!b.on && b.model === 'None' && !b.unknownId) { toast('Choose an effect for ' + b.title + ' first'); return; }
    }
    const on = !stageEnabled(key);
    setStageEnabled(key, on);
    noteExpressionLocalOverride(key, 'bypass', on);
    queueStageEnabled(key, on);
    render();
  }

  function chooseModel(key, name) {
    const b = state.blocks[key];
    if (!b || (name === b.model && !b.unknownId)) return;
    if (name === 'None') {
      delete b.unknownId;   // like any effect: bypassed, and the slot shows empty until the pedal reports it again
      b.model = 'None';
      b.params = [];
      if (b.on) { b.on = false; setFXBlockEnabled(key, false); }
    } else {
      setFXModel(key, name);
    }
    render();
  }

  async function doSave() {
    if (!state.connected) { toast('Connect your Nano Cortex to save'); return; }
    if (presetUnknownRefuses()) return;
    if (!(await stopAnyAudition('Save'))) return;
    flushTempo();
    await savePreset(); // the outcome arrives through showSaveResult()
  }

  // Throw away the live edits: re-selecting the current slot makes the pedal reload the preset as saved
  // (the same reload doDelete() uses for the current preset).
  async function doDiscard() {
    if (!state.connected) { toast('Connect your Nano Cortex first'); return; }
    if (presetUnknownRefuses()) return;
    const n = state.selectedPreset;
    const choice = await modal({
      title: 'Discard edits to ' + presetName(n) + '?',
      body: 'The preset reloads as it was last saved on the pedal. The unsaved edits are lost.',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Discard', primary: true }],
    });
    if (choice !== 'ok') { render(); return; }
    if (!(await stopAnyAudition('Discard'))) return;
    ui.lastAction = 'Discarding edits\u2026'; renderStatus();
    state.exp.loaded = false;   // the pedal reloads the saved set too; read it again
    await selectPreset(n);
    if (ui.demo) demo.load(n);
    ui.lastAction = '';
    toast('Edits discarded; preset ' + n + ' reloaded');
    render();
  }

  // Save the live sound into another slot under a new name, then switch to it. The source preset keeps
  // its saved state (the pedal drops unsaved edits on the switch). Same type-3 write as savePreset(),
  // with the chosen slot and name; verified on the pedal 2026-10-08 from the native app.
  async function doSaveAs(preselect) {
    if (!state.connected) { toast('Connect your Nano Cortex to save'); return; }
    if (presetUnknownRefuses()) return;
    const from = state.selectedPreset;
    let target = Number.isInteger(preselect) && preselect !== from ? preselect : 0;
    for (let i = 1; !target && i <= 64; i++) if (i !== from && presetName(i) === 'Empty') { target = i; break; }
    if (!target) target = from % 64 + 1;
    const input = el('input', { class: 'search', type: 'text', value: (presetName(from) === 'Empty' ? 'Preset ' + from : presetName(from)) + ' copy', maxlength: '64', 'aria-label': 'New preset name', spellcheck: 'false' });
    const warn = el('p', { class: 'warn' });
    const list = el('div', { class: 'slots presets', role: 'listbox', 'aria-label': 'Destination preset' });
    const draw = () => {
      list.replaceChildren(...Array.from({ length: 64 }, (_, i) => i + 1).map(i => el('button', {
        class: 'slot' + (i === target ? ' on' : '') + (i === from ? ' current' : ''), role: 'option', 'aria-selected': String(i === target), disabled: i === from ? 'true' : null,
        dataset: { fk: 'saveas-' + i }, onclick: () => { target = i; draw(); },
      }, el('span', { class: 'n', text: i }), el('span', { class: 't' + (presetName(i) === 'Empty' ? ' empty' : ''), text: presetName(i) }))));
      warn.textContent = presetName(target) === 'Empty' ? '' : 'Preset ' + target + ' \u201c' + presetName(target) + '\u201d will be overwritten.';
    };
    draw();
    const choice = await modal({
      title: 'Save as a new preset', wide: true, focus: input,
      body: 'Writes the current sound, including unsaved edits, into the slot you pick. Preset ' + from + ' keeps what it had.',
      content: el('div', {}, el('label', { class: 'field' }, el('span', { text: 'Name' }), input), list, warn),
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Save to the chosen slot', primary: true }],
    });
    if (choice !== 'ok') { render(); return; }
    const name = input.value.trim();
    if (name.length < 4) { toast('Preset name must have at least 4 characters.'); return; }
    if (new TextEncoder().encode(name).length > 64) { toast('Preset name is too long.'); return; }
    if (!(await stopAnyAudition('Save as'))) return;
    await savePresetAs(target, name);
  }
  async function savePresetAs(n, name) {
    const nameBytes = new TextEncoder().encode(name);
    const packet = new Uint8Array(12 + nameBytes.length);
    let i = 0;
    packet[i++] = nameBytes.length + 10; packet[i++] = 0xC0; packet[i++] = 0x08; packet[i++] = 0x01; packet[i++] = 0x18; packet[i++] = n - 1;
    packet[i++] = 0x2A; packet[i++] = nameBytes.length; packet.set(nameBytes, i); i += nameBytes.length;
    packet[i++] = 0x03; packet[i++] = 0x00; packet[i++] = 0x00; packet[i++] = 0x00;
    ui.lastAction = 'Saving as preset ' + n + '\u2026'; renderStatus();
    if (!await writeC304('save preset ' + n, packet)) { toast('Save failed: the Bluetooth write did not go through.'); ui.lastAction = ''; render(); return false; }
    state.presetNames.set(n, name);
    if (ui.demo) demo.store(n);
    ui.sideSig = '';
    await selectPreset(n);
    if (ui.demo) demo.load(n);
    ui.lastAction = '';
    toast('Saved as preset ' + n + ', ' + name);
    render();
    scrollPresetIntoView();
    return true;
  }

  // Delete a preset: type 50 {1: 2, 3: index}, acked by type 51 {1: 6, 3: index, 4: 1}; decoded from the phone app
  // (docs/INVESTIGATION.md §7). Confirmed in a dialog; the slot comes back empty.
  async function doDelete(n) {
    if (!state.connected) { toast('Connect your Nano Cortex first'); return; }
    if (presetName(n) === 'Empty') { toast('Preset ' + n + ' is already empty'); return; }
    const choice = await modal({
      title: 'Delete preset ' + n + ', \u201c' + presetName(n) + '\u201d?',
      body: 'The slot on the pedal becomes empty. There is no undo; if you might want it back, use Save as\u2026 to copy it to a free slot first.',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete', primary: true }],
    });
    if (choice !== 'ok') { render(); return; }
    if (!(await stopAnyAudition('Delete'))) return;
    const ok = await deletePresetOnPedal(n);
    if (!ok) { toast('The pedal refused to delete preset ' + n); render(); return; }
    state.presetNames.set(n, 'Empty');
    if (ui.demo) demo.erase(n);
    ui.sideSig = '';
    toast('Preset ' + n + ' deleted');
    if (n === state.selectedPreset) { state.exp.loaded = false; await selectPreset(n); if (ui.demo) demo.load(n); }
    render();
  }
  async function deletePresetOnPedal(n) {
    const f = await writeAndAwait('Delete preset ' + n, new Uint8Array([0x08, 0xC0, 0x08, 0x02, 0x18, n - 1, 0x32, 0x00, 0x00, 0x00]), 51);
    return fieldValue(f, 4) === 1;
  }

  // Footswitch assignment (docs/INVESTIGATION.md §8): the four 4-Preset-mode slots IA, IB, IIA, IIB live in the
  // state dump as fields 14, 15, 38, 39 (core: state.presetSlots a1, b1, a2, b2). Assigning is the preset-change
  // message (type 29) with field 4 = -1 (no change), the slot's field (5-8) = the preset index, the others -1 and
  // field 9 = 0; the pedal acks with type 30 {1: 1, 4: 1}. Decoded from the phone app, 2026-10-09.
  const FOOTSWITCHES = [
    { key: 'a1', label: 'IA', field: 5 },
    { key: 'b1', label: 'IB', field: 6 },
    { key: 'a2', label: 'IIA', field: 7 },
    { key: 'b2', label: 'IIB', field: 8 },
  ];
  function footswitchFrame(slotKey, presetIndex) {
    const body = [0x18, 0x00, 0x20, ...encodeInt32(-1)];
    for (const f of FOOTSWITCHES) body.push(f.field << 3, ...encodeInt32(f.key === slotKey ? presetIndex : -1));
    body.push(0x48, 0x00);
    return buildFrame(body, MSG.SetPresetSlotsRequest);
  }
  async function assignFootswitch(slotKey, presetIndex) {
    const fs = FOOTSWITCHES.find(f => f.key === slotKey);
    if (!fs || !(presetIndex >= 0 && presetIndex < 64)) return false;
    if (!state.connected) { toast('Connect your Nano Cortex first'); return false; }
    // The pedal drops the current preset's unsaved edits on an assignment (seen in the trace, INVESTIGATION §8),
    // so ask first, like a preset switch does.
    const dirty = isDirtyNow();
    let choice = null;
    if (dirty) {
      choice = await modal({
        title: 'Save changes to ' + presetName(state.selectedPreset) + '?',
        body: 'Assigning a footswitch discards edits that haven\u2019t been saved to the pedal.',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'discard', label: 'Don\u2019t save' },
          { id: 'save', label: 'Save and assign', primary: true },
        ],
      });
      if (choice === 'cancel' || !choice) { render(); return false; }
    }
    if (!(await stopAnyAudition('the footswitch assignment'))) return false;
    if (dirty && choice === 'save') await doSave();
    const n = presetIndex + 1;
    const f = await writeAndAwait('Assign preset ' + n + ' to footswitch ' + fs.label, footswitchFrame(slotKey, presetIndex), MSG.SetPresetSlotsResponse);
    if (fieldValue(f, 4) !== 1) {
      window.log('Footswitch assignment FAILED: ' + (f ? 'the pedal refused it' : 'no reply'));
      toast('The pedal did not confirm footswitch ' + fs.label);
      render();
      return false;
    }
    state.presetSlots = { ...state.presetSlots, [slotKey]: presetIndex };
    if (dirty && ui.demo) demo.load(state.selectedPreset);   // the pedal is back on the stored preset
    window.log('Assigned preset ' + n + ' to footswitch ' + fs.label);
    toast('Preset ' + n + ' on footswitch ' + fs.label);
    render();
    return true;
  }
  window.__assignFootswitch = assignFootswitch;
  window.__footswitchFrame = footswitchFrame;

  async function doRename() {
    if (!state.connected) { toast('Connect your Nano Cortex to rename presets'); return; }
    if (presetUnknownRefuses()) return;
    const n = state.selectedPreset;
    const input = el('input', { class: 'search', type: 'text', value: presetName(n), maxlength: '64', 'aria-label': 'Preset name', spellcheck: 'false' });
    const choice = await modal({
      title: 'Rename preset ' + n, content: input, focus: input,
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Rename', primary: true }],
    });
    if (choice !== 'ok') { render(); return; }
    if (!(await stopAnyAudition('Rename'))) return;
    const err = await renamePresetTo(n, input.value);
    if (err) { toast(err); return; }
    ui.sideSig = '';
    toast('Renamed preset ' + n + ' to ' + input.value.trim());
    render();
  }

  // ------------------------------------------------------------------ tuner
  function toggleTuner() {
    if (!state.connected) { toast('Connect your Nano Cortex to use the tuner'); return; }
    if (state.tuner.open) closeTuner(); else openTuner(false);
    renderTuner();
  }
  function renderTuner() {
    $('tunerOverlay').hidden = !state.tuner.open;
    $('tunerBtn').classList.toggle('on', state.tuner.open);
    const mute = $('tunerMute');
    mute.classList.toggle('on', state.tuner.muted);
    mute.setAttribute('aria-pressed', String(state.tuner.muted));
    const f = $('tunerFreq');
    if (document.activeElement !== f) f.value = String(state.tuner.baseFrequency);
  }
  $('tunerClose').addEventListener('click', () => { closeTuner(); renderTuner(); });
  $('tunerOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) { closeTuner(); renderTuner(); } }); // backdrop click closes
  $('tunerMute').addEventListener('click', () => { setTunerOption({ muted: !state.tuner.muted }); renderTuner(); });
  $('tunerFreq').addEventListener('change', (e) => {
    const hz = Math.round(Number(e.target.value));
    setTunerOption({ baseFrequency: Number.isFinite(hz) ? Math.max(400, Math.min(480, hz)) : 440 });
    renderTuner();
  });

  // ------------------------------------------------------------------ metronome
  // A click track through the Mac's audio output (Web Audio, scheduled ahead so
  // the timing doesn't depend on the UI thread). Simple mode: N beats, beat one
  // accented (the original overlay). Advanced mode: time signature, an accent
  // pattern, subdivisions with swing, count-in, tempo and gap trainers.
  //
  // Pipeline: setup → metroBarEvents(setup, bar) (pure: [{ offsetBeats, role }])
  // → metroTick (lookahead scheduler; trainers only change inputs between bars)
  // → soundFor(role).play(at, gain). Roles are a fixed set of names; each has a
  // gain (Levels) and a sound source, so a sample-based source can replace the
  // synth one later without touching the scheduler. The scheduler takes a list
  // of patterns (layers) so a second, concurrent pattern (polyrhythm) can slot in.
  const ROLE = Object.freeze({ ACCENT: 'accent', NORMAL: 'normal', SOFT: 'soft', SUB: 'sub', MUTE: 'mute' });
  const CELL_CYCLE = [ROLE.ACCENT, ROLE.NORMAL, ROLE.SOFT, ROLE.MUTE];   // what a click on a pattern cell steps through
  const CELL_NAME = { accent: 'Accent', normal: 'Normal', soft: 'Soft', mute: 'Mute' };
  // Pattern presets. Group starts: the first is the accent, later ones normal, the rest soft.
  const METRO_PATTERNS = [
    { id: '4/4', name: '4/4', beats: 4, note: 4, groups: null },
    { id: '3/4', name: '3/4', beats: 3, note: 4, groups: null },
    { id: '6/8', name: '6/8 (3+3)', beats: 6, note: 8, groups: [3, 3] },
    { id: '5/4', name: '5/4 (3+2)', beats: 5, note: 4, groups: [3, 2] },
    { id: '7/8', name: '7/8 (2+2+3)', beats: 7, note: 8, groups: [2, 2, 3] },
    { id: '12/8', name: '12/8 (4×3)', beats: 12, note: 8, groups: [3, 3, 3, 3] },
  ];
  const patternCells = (p) => p.groups
    ? p.groups.flatMap((g, gi) => Array.from({ length: g }, (_, i) => (i ? ROLE.SOFT : gi ? ROLE.NORMAL : ROLE.ACCENT)))
    : Array.from({ length: p.beats }, (_, i) => (i ? ROLE.NORMAL : ROLE.ACCENT));
  const plainCells = (n) => Array.from({ length: n }, (_, i) => (i ? ROLE.NORMAL : ROLE.ACCENT));
  // The preset an advanced setup currently matches, or null ("Custom").
  const patternOf = (adv) => METRO_PATTERNS.find(p => p.beats === adv.beats && p.note === adv.note && patternCells(p).join() === adv.pattern.join()) || null;
  const SUBDIVS = [{ n: 1, name: 'None' }, { n: 2, name: '2 (eighths)' }, { n: 3, name: '3 (triplets)' }, { n: 4, name: '4 (sixteenths)' }];
  const advDefaults = () => ({
    beats: 4, note: 4, pattern: plainCells(4), sub: 1, swing: 0, countIn: 0,
    ramp: { on: false, target: 140, step: 2, every: 4 },
    gap: { on: false, play: 3, mute: 1 },
  });
  const levelDefaults = () => ({ accent: 1, main: 1, sub: 1 });
  // The click sounds per role (Settings → Metronome → Sounds): a built-in voice each, and optionally the user's own
  // sample, which replaces it (metro.samples[role] = { name }; the copy lives in the shell, src/metro-samples.js).
  const SOUND_ROLES = [['accent', 'Accent'], ['main', 'Main beat'], ['sub', 'Subdivision']];
  const soundDefaults = (v = 'click') => ({ accent: v, main: v, sub: v });
  const VOICE_IDS = ['click', 'woodblock', 'tick', 'beep', 'cowbell'];   // the built-in voices (VOICES below), in menu order

  // Off-beat position inside a beat. Swing 0 % is straight; 100 % moves the off-beat to the
  // triplet position (2/3 for eighths; each sixteenth pair likewise inside its half beat).
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  function subOffsets(sub, swing) {
    const s = (sub === 2 || sub === 4) ? clamp(Number(swing) || 0, 0, 100) / 100 : 0;
    if (sub === 2) return [0.5 + s / 6];
    if (sub === 4) return [0.25 + s / 12, 0.5, 0.75 + s / 12];
    if (sub === 3) return [1 / 3, 2 / 3];
    return [];
  }
  // Normalise anything (stored JSON, a test's literal) into a full advanced setup.
  function normSetup(x) {
    const d = advDefaults(); x = x || {};
    const beats = clamp(Math.round(Number(x.beats) || d.beats), 1, 16);
    const pattern = Array.from({ length: beats }, (_, i) => (CELL_CYCLE.includes((x.pattern || [])[i]) ? x.pattern[i] : (i ? ROLE.NORMAL : ROLE.ACCENT)));
    const num = (v, lo, hi, dflt) => clamp(Math.round(Number(v) || dflt), lo, hi);
    return {
      beats, pattern,
      note: [4, 8, 16].includes(Number(x.note)) ? Number(x.note) : 4,
      sub: [1, 2, 3, 4].includes(Number(x.sub)) ? Number(x.sub) : 1,
      swing: clamp(Math.round(Number(x.swing) || 0), 0, 100),
      countIn: [0, 1, 2].includes(Number(x.countIn)) ? Number(x.countIn) : 0,
      ramp: { on: !!(x.ramp && x.ramp.on), target: num(x.ramp && x.ramp.target, 30, 300, d.ramp.target), step: num(x.ramp && x.ramp.step, 1, 50, d.ramp.step), every: num(x.ramp && x.ramp.every, 1, 64, d.ramp.every) },
      gap: { on: !!(x.gap && x.gap.on), play: num(x.gap && x.gap.play, 1, 64, d.gap.play), mute: num(x.gap && x.gap.mute, 1, 64, d.gap.mute) },
    };
  }
  // Pure: the events of one bar. `bar` counts from 0 at Start, count-in bars included.
  // Count-in bars are plain clicks (beat one accented, no subdivisions). The gap trainer
  // turns every event of a resting bar into a mute (the indicator still runs).
  function metroBarEvents(setup, bar = 0) {
    const s = normSetup(setup);
    if (bar < s.countIn) return plainCells(s.beats).map((role, i) => ({ offsetBeats: i, role }));
    const subs = subOffsets(s.sub, s.swing);
    const out = [];
    s.pattern.forEach((role, i) => {
      out.push({ offsetBeats: i, role });
      for (const o of subs) out.push({ offsetBeats: r6(i + o), role: ROLE.SUB });
    });
    const m = bar - s.countIn;
    if (s.gap.on && m % (s.gap.play + s.gap.mute) >= s.gap.play) out.forEach(e => { e.role = ROLE.MUTE; });
    return out;
  }
  // Pure: the tempo of main bar `m` under the tempo trainer, starting from `from`.
  function metroRampBpm(setup, from, m) {
    const s = normSetup(setup);
    if (!s.ramp.on || m <= 0) return from;
    const steps = Math.floor(m / s.ramp.every) * s.ramp.step;
    return s.ramp.target >= from ? Math.min(s.ramp.target, from + steps) : Math.max(s.ramp.target, from - steps);
  }

  const metro = {
    open: false, running: false, mode: 'simple', opensIn: 'simple',
    bpm: 100, beats: 4, volume: 0.6, output: '', sounds: soundDefaults(), samples: {},
    adv: advDefaults(), levels: levelDefaults(),
    // Tempo source. Later: follow the preset's tempo (two-way) once the pedal's tempo message is decoded.
    tempoFollowsPreset: false, presetTempo: null,
    onTempoChange: null,   // hook (bpm, source) for a user tempo change; the app can write it to the pedal later
    outputs: [], beat: -1, sub: -1, count: 0, bar: 0, countingIn: 0, gapRest: false, rampFrom: 0,
    taps: [], lastVoice: '', scheduled: [],
  };
  const TRANSIENT = () => ({ open: false, running: false, outputs: [], beat: -1, sub: -1, count: 0, bar: 0, countingIn: 0, gapRest: false, rampFrom: 0, taps: [], lastVoice: '', scheduled: [], onTempoChange: null, presetTempo: null, tempoFollowsPreset: false });
  try { Object.assign(metro, JSON.parse(localStorage.getItem('metronome') || '{}'), TRANSIENT()); } catch { /* defaults */ }
  metro.adv = normSetup(metro.adv);
  metro.levels = Object.assign(levelDefaults(), metro.levels);
  for (const k of Object.keys(levelDefaults())) { const v = Number(metro.levels[k]); metro.levels[k] = Number.isFinite(v) ? clamp(v, 0, 1) : 1; }
  // One "sound" for every role before per-role sounds: it becomes each role's sound.
  metro.sounds = Object.assign(soundDefaults(typeof metro.sound === 'string' ? metro.sound : 'click'), metro.sounds);
  delete metro.sound;
  metro.samples = metro.samples && typeof metro.samples === 'object' ? metro.samples : {};
  for (const [k] of SOUND_ROLES) {
    if (!VOICE_IDS.includes(metro.sounds[k])) metro.sounds[k] = 'click';
    if (metro.samples[k] && typeof metro.samples[k].name !== 'string') delete metro.samples[k];
  }
  for (const k of Object.keys(metro.samples)) if (!SOUND_ROLES.some(([r]) => r === k)) delete metro.samples[k];
  if (metro.opensIn !== 'advanced') metro.opensIn = 'simple';
  metro.mode = metro.opensIn;
  const saveMetro = () => { try { localStorage.setItem('metronome', JSON.stringify({ bpm: metro.bpm, beats: metro.beats, volume: metro.volume, output: metro.output, sounds: metro.sounds, samples: metro.samples, opensIn: metro.opensIn, adv: metro.adv, levels: metro.levels })); } catch { /* fine */ } };
  // The one tempo the scheduler reads.
  const effectiveBpm = () => (metro.tempoFollowsPreset && Number(metro.presetTempo) > 0 ? clamp(Number(metro.presetTempo), 30, 300) : metro.bpm);
  // What the scheduler plays: one pattern per layer. Today a single layer; a polyrhythm adds a
  // second, spread over the same bar.
  const simpleSetup = () => normSetup({ beats: metro.beats, pattern: plainCells(metro.beats) });
  const metroLayers = () => [metro.mode === 'advanced' ? metro.adv : simpleSetup()];

  // Audio outputs. Chromium only reveals output names after microphone access
  // was granted once, so the first listing asks for it (and releases it at once).
  async function listOutputs(askPermission) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    let devices = await navigator.mediaDevices.enumerateDevices();
    let outs = devices.filter(d => d.kind === 'audiooutput');
    if (askPermission && outs.some(d => !d.label)) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
        devices = await navigator.mediaDevices.enumerateDevices();
        outs = devices.filter(d => d.kind === 'audiooutput');
      } catch (err) { log('Audio outputs: microphone permission not granted (' + err.message + '), names stay hidden.'); }
    }
    metro.outputs = outs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: d.label || ('Output ' + (i + 1)) }));
    return metro.outputs;
  }
  async function applyOutput() {
    if (!audio || typeof audio.setSinkId !== 'function') return;
    try { await audio.setSinkId(metro.output || ''); }
    catch (err) { log('Metronome output: could not switch (' + err.message + '), using the system default.'); metro.output = ''; saveMetro(); }
  }
  let audio = null, metroTimer = null, noiseBuf = null;
  function ensureAudio() {
    if (!audio) { audio = new (window.AudioContext || window.webkitAudioContext)(); applyOutput(); }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }
  // Click sounds, synthesized from Web Audio nodes (no sample files). `p` scales the pitch
  // (subdivision ticks use a higher variant of the same sound). Each click's nodes end in `voiceOut`, the click's own
  // gain node (see click()), so the next click can cut it.
  let voiceOut = null;
  const envelope = (at, peak, attack, decay) => {
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
    g.connect(voiceOut || audio.destination);
    return g;
  };
  const tone = (at, type, freq, dest, len) => {
    const o = audio.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, at);
    o.connect(dest); o.start(at); o.stop(at + len);
    return o;
  };
  function noise() {
    if (!noiseBuf || noiseBuf.sampleRate !== audio.sampleRate) {
      noiseBuf = audio.createBuffer(1, Math.round(audio.sampleRate * 0.05), audio.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = audio.createBufferSource(); src.buffer = noiseBuf;
    return src;
  }
  const VOICES = {
    click: { name: 'Click', play(at, accent, vol, p = 1) {   // today's square blip
      tone(at, 'square', (accent ? 1200 : 800) * p, envelope(at, vol * (accent ? 1 : 0.7), 0.002, 0.058), 0.07);
    } },
    woodblock: { name: 'Woodblock', play(at, accent, vol, p = 1) {   // resonant 800 Hz (accent 1.2 kHz), sharp attack, ~40 ms decay
      const f = (accent ? 1200 : 800) * p;
      const g = envelope(at, vol * (accent ? 1 : 0.75), 0.001, 0.04);
      const o = tone(at, 'sine', f * 1.08, g, 0.06);
      o.frequency.exponentialRampToValueAtTime(f, at + 0.01);
      const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 12;
      const n = noise(); n.connect(bp).connect(envelope(at, vol * 0.5, 0.0005, 0.012)); n.start(at); n.stop(at + 0.02);
    } },
    tick: { name: 'Tick', play(at, accent, vol, p = 1) {   // short band-passed noise burst around 4 kHz
      const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = (accent ? 5000 : 4000) * p; bp.Q.value = 2.5;
      const n = noise(); n.connect(bp).connect(envelope(at, vol * (accent ? 1.6 : 1.1), 0.0005, 0.018)); n.start(at); n.stop(at + 0.03);
    } },
    beep: { name: 'Beep', play(at, accent, vol, p = 1) {   // longer 880 Hz sine, accent an octave up
      const g = audio.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(vol * (accent ? 0.9 : 0.7), at + 0.005);
      g.gain.setValueAtTime(vol * (accent ? 0.9 : 0.7), at + 0.09);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
      g.connect(voiceOut || audio.destination);
      tone(at, 'sine', (accent ? 1760 : 880) * p, g, 0.14);
    } },
    cowbell: { name: 'Cowbell', play(at, accent, vol, p = 1) {   // two detuned square partials ~560/845 Hz through a band-pass, short
      const k = (accent ? 1.19 : 1) * p;
      const bp = audio.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 800 * k; bp.Q.value = 3;
      bp.connect(envelope(at, vol * (accent ? 1.1 : 0.8), 0.001, 0.09));
      tone(at, 'square', 560 * k, bp, 0.11); tone(at, 'square', 845 * k, bp, 0.11);
    } },
  };
  // Per role: which Levels slider scales it, a fixed trim, which sound plays it (Settings → Metronome → Sounds), and how
  // a built-in voice renders it. Soft beats play the main sound, quieter.
  const ROLE_MIX = {
    accent: { level: 'accent', sound: 'accent', trim: 1, accent: true, pitch: 1 },
    normal: { level: 'main', sound: 'main', trim: 1, accent: false, pitch: 1 },
    soft: { level: 'main', sound: 'main', trim: 0.45, accent: false, pitch: 1 },
    sub: { level: 'sub', sound: 'sub', trim: 0.5, accent: false, pitch: 1.5 },
  };
  const roleGain = (role) => { const m = ROLE_MIX[role]; return m ? metro.volume * metro.levels[m.level] * m.trim : 0; };

  // Custom samples. The shell does the file dialog, the checks, the copy into its data folder and the reads
  // (src/metro-samples.js, IPC 'metro-sample'); this page names only the operation and the role, decodes the bytes
  // once into an AudioBuffer (the first 2 s) and plays it through the same graph as the built-ins. The UX test swaps
  // the bridge for its own (__metro.samples.setBridge), which also runs the launch-time load again.
  const SAMPLE_MAX_S = 2;
  const sampleBufs = {};   // role (accent | main | sub) → AudioBuffer
  const samples = { bridge: shellBridge && shellBridge.metroSample ? (op, role) => shellBridge.metroSample(op, role) : null };
  // Chromium decodes WAV, MP3, AAC/M4A, FLAC and Ogg (Vorbis, Opus) on every platform, but not AIFF: uncompressed
  // AIFF and AIFF-C (what Logic and GarageBand export) are read here. Big-endian PCM unless AIFF-C says 'sowt'
  // (little-endian) or 'fl32'/'fl64' (float); the sample rate is an 80-bit float. Returns null for anything else.
  function readAiff(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o) => (o + 4 <= bytes.length ? String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]) : '');
    if (tag(0) !== 'FORM' || (tag(8) !== 'AIFF' && tag(8) !== 'AIFC')) return null;
    let ch = 0, frames = 0, bits = 0, rate = 0, comp = 'NONE', data = -1;
    for (let o = 12; o + 8 <= bytes.length;) {
      const id = tag(o), size = v.getUint32(o + 4), body = o + 8;
      if (id === 'COMM' && body + 18 <= bytes.length) {
        ch = v.getUint16(body); frames = v.getUint32(body + 2); bits = v.getUint16(body + 6);
        const exp = v.getUint16(body + 8) & 0x7fff;
        rate = (v.getUint32(body + 10) * 2 ** 32 + v.getUint32(body + 14)) * 2 ** (exp - 16383 - 63);
        if (tag(8) === 'AIFC' && size >= 22) comp = tag(body + 18);
      } else if (id === 'SSND' && body + 8 <= bytes.length) data = body + 8 + v.getUint32(body);
      o = body + size + (size & 1);
    }
    const float = comp === 'fl32' || comp === 'FL32' || comp === 'fl64' || comp === 'FL64';
    if (!['NONE', 'twos', 'sowt'].includes(comp) && !float) return null;
    const bps = float ? (comp.endsWith('64') ? 8 : 4) : Math.ceil(bits / 8);
    if (!ch || !rate || data < 0 || bps < 1 || bps > 8 || (!float && bps > 4)) return null;
    frames = Math.min(frames, Math.floor((bytes.length - data) / (bps * ch)), Math.ceil(rate * SAMPLE_MAX_S) + 1);
    if (frames < 1) return null;
    const buf = new AudioBuffer({ numberOfChannels: ch, length: frames, sampleRate: rate });
    const le = comp === 'sowt', scale = 2 ** (bps * 8 - 1);
    for (let c = 0; c < ch; c++) {
      const out = buf.getChannelData(c);
      for (let i = 0, o = data + c * bps; i < frames; i++, o += bps * ch) {
        if (float) { out[i] = bps === 8 ? v.getFloat64(o) : v.getFloat32(o); continue; }
        let x = 0;
        for (let b = 0; b < bps; b++) x = x * 256 + bytes[le ? o + bps - 1 - b : o + b];
        out[i] = (x >= scale ? x - 2 * scale : x) / scale;
      }
    }
    return buf;
  }
  // Bytes → AudioBuffer (throws when it isn't audio). An offline context: no output device needed at launch.
  async function decodeSample(bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let buf = null;
    try { buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice().buffer); }
    catch { try { buf = readAiff(bytes); } catch { buf = null; } }
    if (!buf || !buf.length) throw new Error('not audio');
    return buf;
  }
  // What plays: mono (the channels averaged, not normalised), the first 2 s, with a 5 ms fade where it was cut.
  function prepSample(buf) {
    const max = Math.round(buf.sampleRate * SAMPLE_MAX_S), len = Math.min(buf.length, max), n = buf.numberOfChannels;
    const d = new Float32Array(len);
    for (let c = 0; c < n; c++) { const x = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] += x[i] / n; }
    if (buf.length > max) { const fade = Math.min(len, Math.round(buf.sampleRate * 0.005)); for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade; }
    const out = new AudioBuffer({ numberOfChannels: 1, length: len, sampleRate: buf.sampleRate });
    out.copyToChannel(d, 0);
    return out;
  }
  const sampleLabel = (role) => (SOUND_ROLES.find(([r]) => r === role) || [])[1] || role;
  // Settings → "Custom sample…": the shell's dialog, then decode, then the shell copies it. Resolves { ok } when set,
  // { canceled }, or { error } with the reason Settings shows under the rows (a refused file changes nothing).
  async function pickSample(role) {
    if (!samples.bridge) return { canceled: true };
    const r = await samples.bridge('pick', role).catch(() => null);
    if (!r || r.canceled) return { canceled: true };
    const refuse = (error) => { log('Metronome: ' + sampleLabel(role) + ': ' + error); return { error }; };
    if (r.error === 'size') return refuse('“' + r.name + '” is larger than 5 MB.');
    if (r.error || !r.bytes) return refuse('Couldn’t read “' + (r.name || 'the file') + '”.');
    let buf;
    try { buf = await decodeSample(r.bytes); }
    catch {
      samples.bridge('discard', role).catch(() => null);
      return refuse('“' + r.name + '” isn’t audio the metronome can play.');
    }
    const saved = await samples.bridge('save', role).catch(() => null);
    if (!saved || !saved.ok) return refuse('Couldn’t copy “' + r.name + '”.');
    sampleBufs[role] = prepSample(buf);
    metro.samples[role] = { name: r.name };
    saveMetro();
    log('Metronome: ' + sampleLabel(role) + ' plays ' + r.name + (buf.duration > SAMPLE_MAX_S ? ' (first 2 s)' : '') + '.');
    if (buf.duration > SAMPLE_MAX_S) toast('“' + r.name + '” is trimmed to its first 2 seconds.');
    return { ok: true };
  }
  // Back to the built-in sound (Reset, or a built-in picked from the menu): the shell deletes its copy.
  async function resetSample(role) {
    const had = !!metro.samples[role];
    delete metro.samples[role]; delete sampleBufs[role];
    saveMetro();
    if (had && samples.bridge) await samples.bridge('reset', role).catch(() => null);
  }
  // At launch: decode every stored sample once. A missing or unreadable one falls back to the built-in sound (the
  // setting goes back too, so the notice doesn't repeat) with one toast for all of them.
  async function loadSamples() {
    const lost = [];
    for (const [role] of SOUND_ROLES) {
      if (!metro.samples[role]) { delete sampleBufs[role]; continue; }
      try {
        const r = samples.bridge ? await samples.bridge('load', role) : null;
        if (!r || !r.bytes) throw new Error(r && r.error === 'size' ? 'too large' : 'missing');
        sampleBufs[role] = prepSample(await decodeSample(r.bytes));
      } catch (err) {
        log('Metronome: the custom ' + sampleLabel(role).toLowerCase() + ' sound (' + metro.samples[role].name + ') is ' + (err.message === 'not audio' ? 'unreadable' : err.message) + '; using ' + VOICES[metro.sounds[role]].name + '.');
        lost.push(role);
        await resetSample(role);
      }
    }
    if (lost.length) {
      const names = lost.map(sampleLabel);
      toast('Couldn\u2019t load the custom metronome sound' + (lost.length > 1 ? 's for ' + names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + '; using the built-in ones.' : ' for ' + names[0] + '; using the built-in one.'));
    }
    return lost;
  }
  function playSample(buf, at, gain) {
    const src = audio.createBufferSource(); src.buffer = buf;
    const g = audio.createGain(); g.gain.value = gain;
    g.connect(voiceOut || audio.destination);
    src.connect(g); src.start(at);
    return src;
  }
  // The sound source for a role: { id, play(at, gain) }. The role's custom sample when there is one, otherwise its
  // built-in voice; both through the same context, so the output device and the scheduling are the same.
  function soundFor(role) {
    const m = ROLE_MIX[role];
    if (!m) return null;
    const buf = sampleBufs[m.sound];
    if (buf) return { id: 'sample', buffer: buf, play: (at, gain) => playSample(buf, at, gain) };
    const id = VOICES[metro.sounds[m.sound]] ? metro.sounds[m.sound] : 'click';
    return { id, play: (at, gain) => VOICES[id].play(at, m.accent, gain, m.pitch) };
  }
  // One click at `at`. Clicks don't overlap: the one still sounding is cut where this one starts (its own gain node
  // fades to 0 over 5 ms, a sample's source stops there), so long sounds never ring over each other. A muted or
  // silent event cuts nothing. Returns the gain, the sound id and the click (the scheduler hangs its info on it).
  const CUT_S = 0.005;
  let sounding = null;   // { out, node, at, info }
  function click(at, role) {
    const src = soundFor(role), gain = roleGain(role);
    if (src) metro.lastVoice = src.id;
    if (!src || gain <= 0) return { gain, sound: src ? src.id : null, handle: null };
    if (sounding && at > sounding.at) {
      sounding.out.gain.setValueAtTime(1, at);
      sounding.out.gain.linearRampToValueAtTime(0, at + CUT_S);
      if (sounding.node) sounding.node.stop(at + CUT_S);
      if (sounding.info) sounding.info.cut = at + CUT_S;
    }
    const out = audio.createGain();
    out.connect(audio.destination);
    voiceOut = out;
    let node = null;
    try { node = src.play(at, gain) || null; } finally { voiceOut = null; }
    sounding = { out, node, at, info: null };
    return { gain, sound: src.id, handle: sounding };
  }
  // Settings ▶: one click of that sound (accent | main | sub) at its level.
  function previewSound(role) { ensureAudio(); click(audio.currentTime + 0.03, role === 'accent' ? ROLE.ACCENT : role === 'sub' ? ROLE.SUB : ROLE.NORMAL); }

  // Scheduler state: the current bar's events (all layers merged, sorted) and a cursor (the time
  // and beat offset of the last scheduled point), so a tempo change applies from the next event.
  let barIdx = 0, barBeats = 4, barEvents = [], evI = 0, cursorAt = 0, cursorOff = 0;
  function planBar() {   // the start of a bar: the only place trainers change anything
    const layers = metroLayers();
    const s = normSetup(layers[0]);
    const m = barIdx - s.countIn;
    // Tempo trainer: one step toward the target at every `every`-th main bar (same rule as metroRampBpm,
    // applied to the current tempo so a hand-made change mid-ramp is respected).
    // Following the preset tempo, the steps start from it and go to the pedal live only (never into the preset).
    const cur = effectiveBpm();
    if (s.ramp.on && m > 0 && m % s.ramp.every === 0 && cur !== s.ramp.target) {
      setBpm(cur < s.ramp.target ? Math.min(s.ramp.target, cur + s.ramp.step) : Math.max(s.ramp.target, cur - s.ramp.step), 'trainer');
    }
    metro.countingIn = barIdx < s.countIn ? barIdx + 1 : 0;
    barBeats = s.beats;
    barEvents = layers.flatMap((layer, li) => {
      const k = s.beats / normSetup(layer).beats;   // a second layer spreads over the first one's bar
      return metroBarEvents(layer, barIdx).map(e => ({ ...e, offsetBeats: r6(e.offsetBeats * k), layer: li }));
    }).sort((a, b) => a.offsetBeats - b.offsetBeats || a.layer - b.layer);
    evI = 0; cursorOff = 0;
  }
  function metroTick() {
    const horizon = audio.currentTime + 0.12;
    for (let guard = 0; guard < 512; guard++) {
      const spb = 60 / effectiveBpm();
      if (evI >= barEvents.length) {
        const end = cursorAt + (barBeats - cursorOff) * spb;
        if (end >= horizon) return;
        cursorAt = end; barIdx++; planBar();
        continue;
      }
      const ev = barEvents[evI];
      const at = cursorAt + (ev.offsetBeats - cursorOff) * spb;
      if (at >= horizon) return;
      cursorAt = at; cursorOff = ev.offsetBeats; evI++;
      const { gain, sound, handle } = click(at, ev.role);
      const info = { bar: barIdx, countIn: metro.countingIn, offsetBeats: ev.offsetBeats, role: ev.role, layer: ev.layer, bpm: effectiveBpm(), gain: r6(gain), sound, at };
      if (handle) handle.info = info;
      metro.scheduled.push(info);
      if (metro.scheduled.length > 512) metro.scheduled.shift();
      if (ev.layer) continue;   // the indicator follows the first layer
      setTimeout(() => {
        if (!metro.running) return;
        const beat = Math.floor(ev.offsetBeats + 1e-9);
        if (ev.offsetBeats === beat) { metro.beat = beat; metro.sub = -1; metro.count++; }
        const s = normSetup(metroLayers()[0]);
        if (ev.offsetBeats !== beat) metro.sub = subOffsets(s.sub, s.swing).findIndex(o => Math.abs(beat + o - ev.offsetBeats) < 1e-4);
        metro.countingIn = info.countIn;
        metro.bar = info.countIn ? 0 : info.bar - s.countIn + 1;
        metro.gapRest = ev.role === ROLE.MUTE && s.gap.on && !info.countIn;
        renderMetroBeats();
      }, Math.max(0, (at - audio.currentTime) * 1000));
    }
  }
  function startMetro() {
    if (metro.running) return;
    ensureAudio();
    metro.running = true; metro.beat = -1; metro.sub = -1; metro.count = 0; metro.bar = 0; metro.scheduled = []; sounding = null;
    metro.rampFrom = effectiveBpm();
    barIdx = 0; cursorAt = audio.currentTime + 0.05;
    planBar();
    metroTimer = setInterval(metroTick, 25);
    metroTick();
    renderMetro();
  }
  function stopMetro() {
    if (!metro.running) return;
    metro.running = false; clearInterval(metroTimer); metroTimer = null; metro.beat = -1; metro.sub = -1; metro.countingIn = 0; metro.gapRest = false;
    renderMetro();
  }
  // source: 'user' (overlay buttons, typing, slider, tap), 'settings' (the default tempo) or 'trainer'.
  // User and trainer changes go through the onTempoChange hook (the pedal write when following the preset
  // tempo); phase is 'live' while the slider moves, 'step' (−/+), 'tap' or 'commit' (typed, slider released).
  function setBpm(v, source = 'user', phase = 'commit') {
    metro.bpm = clamp(Math.round(Number(v) || metro.bpm), 30, 300);
    saveMetro(); renderMetro();
    if ((source === 'user' || source === 'trainer') && typeof metro.onTempoChange === 'function') { try { metro.onTempoChange(metro.bpm, source, phase); } catch { /* the hook's problem */ } }
  }
  function tapTempo() {
    const now = performance.now();
    if (metro.taps.length && now - metro.taps[metro.taps.length - 1] > 2500) metro.taps = [];
    metro.taps.push(now);
    if (metro.taps.length > 5) metro.taps.shift();
    if (metro.taps.length >= 2) {
      const gaps = metro.taps.slice(1).map((t, i) => t - metro.taps[i]);
      setBpm(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length), 'user', 'tap');
    }
  }
  function toggleMetro() {
    metro.open = !metro.open;
    if (metro.open) metro.mode = metro.opensIn;
    else { stopMetro(); if (pop && pop.classList.contains('levels-pop')) closePopover(); }
    renderMetro();
    if (metro.open) $('metroStart').focus();
  }
  function setMetroMode(mode) {
    if (mode === metro.mode) return;
    const was = metro.running;
    if (was) stopMetro();
    metro.mode = mode === 'advanced' ? 'advanced' : 'simple';
    if (pop && pop.classList.contains('levels-pop')) closePopover();
    renderMetro();
    if (was) startMetro();
  }
  // Advanced setup edits. Live while running: the next bar picks them up.
  function updateAdv(patch) {
    metro.adv = normSetup(Object.assign({}, metro.adv, patch));
    saveMetro(); renderMetro();
  }
  function applyPattern(id) {
    const p = METRO_PATTERNS.find(x => x.id === id);
    if (p) updateAdv({ beats: p.beats, note: p.note, pattern: patternCells(p) });
  }
  function setAdvBeats(n) {
    n = clamp(Math.round(Number(n) || 4), 1, 16);
    updateAdv({ beats: n, pattern: Array.from({ length: n }, (_, i) => metro.adv.pattern[i] || (i ? ROLE.NORMAL : ROLE.ACCENT)) });
  }
  function cycleCell(i) {
    const pattern = metro.adv.pattern.slice();
    pattern[i] = CELL_CYCLE[(CELL_CYCLE.indexOf(pattern[i]) + 1) % CELL_CYCLE.length];
    updateAdv({ pattern });
  }
  function setLevel(k, v) { metro.levels[k] = clamp(Number(v), 0, 1); saveMetro(); }

  function renderMetroBeats() {
    const box = $('metroBeats');
    if (metro.mode !== 'advanced') {
      if (box.dataset.sig !== 'simple' + metro.beats) {
        box.dataset.sig = 'simple' + metro.beats;
        box.replaceChildren(...Array.from({ length: metro.beats }, (_, i) => el('span', { class: i === 0 ? 'accent' : '' })));
      }
      [...box.children].forEach((d, i) => d.classList.toggle('on', metro.running && i === metro.beat));
      return;
    }
    // Advanced: one pip per beat (styled by its role), smaller pips for the subdivisions.
    const s = metro.adv, nSub = subOffsets(s.sub, 0).length;
    const sig = 'adv' + s.pattern.join() + '|' + nSub;
    if (box.dataset.sig !== sig) {
      box.dataset.sig = sig;
      box.replaceChildren(...s.pattern.map((role) => el('span', { class: 'pipgrp' },
        el('span', { class: 'pip ' + role }), ...Array.from({ length: nSub }, () => el('span', { class: 'subpip' })))));
    }
    box.classList.toggle('resting', metro.running && metro.gapRest);
    [...box.children].forEach((g, i) => {
      const here = metro.running && i === metro.beat;
      g.firstChild.classList.toggle('on', here && metro.sub < 0);
      [...g.children].slice(1).forEach((d, j) => d.classList.toggle('on', here && metro.sub === j));
    });
    const st = $('metroStatus');
    st.textContent = !metro.running ? (s.countIn ? 'Count-in ' + s.countIn + (s.countIn > 1 ? ' bars' : ' bar') : 'Bar –')
      : metro.countingIn ? 'Count-in ' + metro.countingIn + ' / ' + s.countIn
      : 'Bar ' + Math.max(1, metro.bar) + (metro.gapRest ? ' · rest' : '');
    $('metroSig').textContent = s.beats + '/' + s.note + (s.sub > 1 ? ' · ' + SUB_WORD[s.sub] : '');
  }
  const SUB_WORD = { 2: 'eighths', 3: 'triplets', 4: 'sixteenths' };

  // The advanced controls, built once and updated by renderMetro.
  let advUI = null;
  function numInput(fk, label, min, max, onSet) {
    const i = el('input', { class: 'num', type: 'number', min: String(min), max: String(max), step: '1', 'aria-label': label, dataset: { fk } });
    i.addEventListener('change', () => onSet(clamp(Math.round(Number(i.value) || min), min, max)));
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } e.stopPropagation(); });
    return i;
  }
  // − value + as one bordered field around a number input; the buttons step it and fire its change event.
  function stepper(input) {
    const step = (d) => {
      const v = clamp(Math.round(Number(input.value) || 0) + d, Number(input.min), Number(input.max));
      input.value = String(v); input.dispatchEvent(new Event('change'));
    };
    const name = input.getAttribute('aria-label') || '';
    return el('div', { class: 'stepper' },
      el('button', { type: 'button', tabindex: '-1', 'aria-label': 'Less: ' + name, onclick: () => step(-1) }, '−'), input,
      el('button', { type: 'button', tabindex: '-1', 'aria-label': 'More: ' + name, onclick: () => step(1) }, '+'));
  }
  function segGroup(fk, label, items, onPick) {
    return el('div', { class: 'seg', role: 'group', 'aria-label': label },
      items.map(([v, text]) => el('button', { dataset: { fk: fk + '-' + v, v: String(v) }, onclick: () => onPick(v) }, text)));
  }
  const syncSeg = (seg, v) => [...seg.children].forEach(b => { const on = b.dataset.v === String(v); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const syncSwitch = (b, on) => { b.classList.toggle('on', !!on); b.setAttribute('aria-checked', String(!!on)); };
  function buildMetroAdv() {
    const u = {};
    u.beats = numInput('metro-adv-beats', 'Beats per bar', 1, 16, (v) => setAdvBeats(v));
    u.note = segGroup('metro-note', 'Note value', [[4, '4'], [8, '8'], [16, '16']], (v) => updateAdv({ note: v }));
    u.note.dataset.fk = 'metro-note';
    u.pattern = el('select', { class: 'select', 'aria-label': 'Pattern', dataset: { fk: 'metro-pattern' }, onchange: (e) => applyPattern(e.target.value) },
      METRO_PATTERNS.map(p => el('option', { value: p.id }, p.name)), el('option', { value: 'custom', disabled: true }, 'Custom'));
    u.cells = el('div', { class: 'metro-cells', role: 'group', 'aria-label': 'Accent pattern' });
    u.sub = segGroup('metro-sub', 'Subdivision', [[1, 'None'], [2, '2'], [3, '3'], [4, '4']], (v) => updateAdv({ sub: v }));
    u.swing = el('input', { type: 'range', min: '0', max: '100', step: '5', 'aria-label': 'Swing', dataset: { fk: 'metro-swing' } });
    u.swing.addEventListener('input', () => updateAdv({ swing: Number(u.swing.value) }));
    u.swingVal = el('span', { class: 'metro-val' });
    u.countIn = segGroup('metro-countin', 'Count-in', [[0, 'Off'], [1, '1 bar'], [2, '2 bars']], (v) => updateAdv({ countIn: v }));
    u.rampOn = toggleSwitch('metro-ramp', 'Tempo trainer', metro.adv.ramp.on, (v) => updateAdv({ ramp: { ...metro.adv.ramp, on: v } }));
    u.rampTarget = numInput('metro-ramp-target', 'Target tempo', 30, 300, (v) => updateAdv({ ramp: { ...metro.adv.ramp, target: v } }));
    u.rampStep = numInput('metro-ramp-step', 'BPM per step', 1, 50, (v) => updateAdv({ ramp: { ...metro.adv.ramp, step: v } }));
    u.rampEvery = numInput('metro-ramp-every', 'Bars per step', 1, 64, (v) => updateAdv({ ramp: { ...metro.adv.ramp, every: v } }));
    u.gapOn = toggleSwitch('metro-gap', 'Gap trainer', metro.adv.gap.on, (v) => updateAdv({ gap: { ...metro.adv.gap, on: v } }));
    u.gapPlay = numInput('metro-gap-play', 'Bars to play', 1, 64, (v) => updateAdv({ gap: { ...metro.adv.gap, play: v } }));
    u.gapMute = numInput('metro-gap-mute', 'Bars to rest', 1, 64, (v) => updateAdv({ gap: { ...metro.adv.gap, mute: v } }));
    // One 3-column grid: Beats / Note value / Pattern, the accent cells across, Subdivision / Swing / Count-in.
    // The two trainer sentences share one grid too, so their words and steppers line up.
    const field = (title, ...kids) => el('div', { class: 'metro-field' }, el('h4', {}, ...[title].flat()), ...kids);
    const word = (t, cls) => el('span', { class: 'metro-word' + (cls ? ' ' + cls : ''), text: t });
    u.rampWord = word('bars', 'last');
    u.gapWord = word('bars, repeat', 'last');
    u.rampRow = el('div', { class: 'metro-trow' }, u.rampOn, word('to'), stepper(u.rampTarget), word('BPM, +'), stepper(u.rampStep), word('every'), stepper(u.rampEvery), u.rampWord);
    u.gapRow = el('div', { class: 'metro-trow' }, u.gapOn, word('play'), stepper(u.gapPlay), word('mute'), stepper(u.gapMute), u.gapWord);
    $('metroAdv').replaceChildren(
      el('div', { class: 'metro-grid' },
        field('Beats', stepper(u.beats)),
        field('Note value', u.note),
        field('Pattern', u.pattern),
        el('div', { class: 'metro-field wide' }, el('h4', {}, 'Accents', el('span', { class: 'metro-hint', text: 'Click a beat to cycle accent, normal, soft, mute' })), u.cells),
        field('Subdivision', u.sub),
        field(['Swing', u.swingVal], u.swing),
        field('Count-in', u.countIn)),
      el('div', { class: 'metro-trainers' }, u.rampRow, u.gapRow));
    return u;
  }
  function renderMetroAdv() {
    if (!advUI) advUI = buildMetroAdv();
    const u = advUI, s = metro.adv;
    u.beats.value = String(s.beats);
    syncSeg(u.note, s.note);
    const p = patternOf(s);
    u.pattern.value = p ? p.id : 'custom';
    if (u.cells.dataset.sig !== s.pattern.join()) {
      u.cells.dataset.sig = s.pattern.join();
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
      u.cells.replaceChildren(...s.pattern.map((role, i) => el('button', {
        class: 'metro-cell ' + role, dataset: { fk: 'metro-cell-' + i }, title: 'Beat ' + (i + 1) + ': ' + CELL_NAME[role] + ' (click to change)',
        'aria-label': 'Beat ' + (i + 1) + ', ' + CELL_NAME[role], onclick: () => cycleCell(i),
      }, el('span', { class: 'n', text: String(i + 1) }), el('span', { class: 'r', text: CELL_NAME[role] }))));
      if (focused && /^metro-cell-/.test(focused)) { const f = u.cells.querySelector('[data-fk="' + focused + '"]'); if (f) f.focus(); }
    }
    syncSeg(u.sub, s.sub);
    const swingable = s.sub === 2 || s.sub === 4;
    u.swing.disabled = !swingable;
    if (document.activeElement !== u.swing) u.swing.value = String(s.swing);
    u.swingVal.textContent = swingable ? s.swing + ' %' : 'for 2 and 4';
    syncSeg(u.countIn, s.countIn);
    syncSwitch(u.rampOn, s.ramp.on);
    syncSwitch(u.gapOn, s.gap.on);
    for (const [i, v] of [[u.rampTarget, s.ramp.target], [u.rampStep, s.ramp.step], [u.rampEvery, s.ramp.every], [u.gapPlay, s.gap.play], [u.gapMute, s.gap.mute]]) {
      if (document.activeElement !== i) i.value = String(v);
    }
    u.rampRow.classList.toggle('off', !s.ramp.on);
    u.gapRow.classList.toggle('off', !s.gap.on);
    u.rampWord.textContent = s.ramp.every === 1 ? 'bar' : 'bars';
    u.gapWord.textContent = s.gap.mute === 1 ? 'bar, repeat' : 'bars, repeat';
  }
  // Range fill: the track paints the accent up to --p (set from the value; see ui.css).
  const rangeFill = (r) => { const lo = Number(r.min) || 0, hi = Number(r.max) || 100; r.style.setProperty('--p', ((Number(r.value) - lo) / (hi - lo || 1)) * 100 + '%'); };
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('.metro input[type=range], .lvl-row input[type=range]')) rangeFill(e.target); });
  function renderMetro() {
    const o = $('metroOverlay');
    const adv = metro.mode === 'advanced';
    o.hidden = !metro.open;
    o.classList.toggle('running', metro.running);
    o.classList.toggle('adv', adv);
    syncSeg($('metroMode'), metro.mode);
    $('metroAdv').hidden = !adv;
    $('metroStatus').hidden = !adv;
    $('metroLevels').hidden = !adv;
    $('metroBeatsLbl').hidden = adv;
    const ramp = $('metroRamp');
    ramp.hidden = !(adv && metro.adv.ramp.on);
    ramp.textContent = metro.running ? 'ramping ' + metro.rampFrom + ' → ' + metro.adv.ramp.target : 'ramps ' + effectiveBpm() + ' → ' + metro.adv.ramp.target;
    if (adv) renderMetroAdv();
    if (document.activeElement !== $('metroBpm')) $('metroBpm').value = String(effectiveBpm());
    $('metroBeatsSel').value = String(metro.beats);
    $('metroVol').value = String(metro.volume);
    $('metroVolVal').textContent = Math.round(metro.volume * 100) + ' %';
    if (document.activeElement !== $('metroTempo')) $('metroTempo').value = String(effectiveBpm());
    $('metroFollow').hidden = !(metro.tempoFollowsPreset && metro.presetTempo);
    $('metroStart').replaceChildren(metro.running ? 'Stop ' : 'Start ', el('kbd', { text: 'Space' }));
    $('metroStart').className = 'btn' + (metro.running ? '' : ' primary');
    $('metroBtn').classList.toggle('on', metro.open);
    const sel = $('metroOut');
    const want = [{ id: '', label: 'System default' }, ...metro.outputs];
    if ([...sel.options].map(o => o.value + '|' + o.textContent).join(';') !== want.map(o => o.id + '|' + o.label).join(';')) {
      sel.replaceChildren(...want.map(o => el('option', { value: o.id, text: o.label })));
    }
    sel.value = metro.outputs.some(o => o.id === metro.output) ? metro.output : '';
    $('metroOverlay').querySelectorAll('input[type=range]').forEach(rangeFill);
    renderMetroBeats();
  }
  // Three independent level sliders (also in Settings → Metronome). `fkPrefix` keeps the test ids apart.
  function levelSliders(fkPrefix, after) {
    return [['accent', 'Accent'], ['main', 'Main ticks'], ['sub', 'Subdivisions']].map(([k, label]) => {
      const val = el('span', { class: 'metro-val', text: Math.round(metro.levels[k] * 100) + ' %' });
      const r = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(metro.levels[k]), 'aria-label': label + ' level', dataset: { fk: fkPrefix + k } });
      rangeFill(r);
      r.addEventListener('input', () => { setLevel(k, r.value); val.textContent = Math.round(metro.levels[k] * 100) + ' %'; if (after) after(); });
      return { k, label, r, val };
    });
  }
  function openLevels(anchor) {
    if (pop) { const was = pop.classList.contains('levels-pop'); closePopover(); if (was) return; }
    const rows = levelSliders('lvl-');
    pop = el('div', { class: 'pop levels-pop', role: 'dialog', 'aria-label': 'Metronome levels' },
      el('div', { class: 'pop-group', text: 'Levels' }),
      ...rows.map(x => el('label', { class: 'lvl-row' }, el('span', { text: x.label }), x.r, x.val)),
      el('p', { class: 'metro-hint', text: 'Each multiplies the overall Volume.' }));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect(), h = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - h.width - 8)) + 'px';
    pop.style.top = Math.max(8, r.top - h.height - 6 < 8 ? r.bottom + 6 : r.top - h.height - 6) + 'px';
    rows[0].r.focus();
  }
  $('metroBtn').addEventListener('click', toggleMetro);
  $('metroClose').addEventListener('click', toggleMetro);
  $('metroOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) toggleMetro(); });
  $('metroMode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMetroMode(b.dataset.mode); });
  $('metroLevels').addEventListener('click', (e) => openLevels(e.currentTarget));
  $('metroStart').addEventListener('click', () => (metro.running ? stopMetro() : startMetro()));
  $('metroTap').addEventListener('click', tapTempo);
  $('metroUp').addEventListener('click', (e) => setBpm(effectiveBpm() + (e.shiftKey ? 10 : 1), 'user', 'step'));
  $('metroDown').addEventListener('click', (e) => setBpm(effectiveBpm() - (e.shiftKey ? 10 : 1), 'user', 'step'));
  $('metroBpm').addEventListener('change', (e) => setBpm(e.target.value));
  $('metroBpm').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setBpm(e.target.value); e.target.blur(); } e.stopPropagation(); });
  $('metroBeatsSel').addEventListener('change', (e) => { metro.beats = clamp(Math.round(Number(e.target.value)) || 4, 1, 7); saveMetro(); renderMetro(); });
  $('metroBeatsSel').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); });
  $('metroBeatsLbl').querySelectorAll('button[data-d]').forEach(b => b.addEventListener('click', () => {
    const i = $('metroBeatsSel'); i.value = String(clamp(metro.beats + Number(b.dataset.d), 1, 7)); i.dispatchEvent(new Event('change'));
  }));
  $('metroTempo').addEventListener('input', (e) => setBpm(e.target.value, 'user', 'live'));
  $('metroTempo').addEventListener('change', (e) => setBpm(e.target.value, 'user', 'commit'));
  $('metroVol').addEventListener('input', (e) => { metro.volume = Number(e.target.value); $('metroVolVal').textContent = Math.round(metro.volume * 100) + ' %'; saveMetro(); });
  $('metroOut').addEventListener('pointerdown', async () => { if (!metro.outputs.length || metro.outputs.some(o => /^Output \d+$/.test(o.label))) { await listOutputs(true); renderMetro(); } });
  $('metroOut').addEventListener('change', (e) => { metro.output = e.target.value; saveMetro(); applyOutput(); });
  listOutputs(false).then(renderMetro);
  window.__metro = {
    state: metro, start: startMetro, stop: stopMetro, tap: tapTempo, setBpm, setMode: setMetroMode, listOutputs, VOICES,
    ROLE, PATTERNS: METRO_PATTERNS, patternCells, barEvents: metroBarEvents, rampBpm: metroRampBpm, normSetup, effectiveBpm, soundFor, roleGain,
    // Custom samples: the decoded buffers, the AIFF reader, and the test's bridge (setting it runs the launch-time load).
    samples: { buffers: sampleBufs, decode: decodeSample, readAiff, setBridge: (b) => { samples.bridge = b; return loadSamples(); } },
  };
  if (samples.bridge) loadSamples();
  ui.metroBarEvents = metroBarEvents;   // the pure event generator, for tests (window.__ui)

  // ------------------------------------------------------------------ preset tempo
  // Type 145 (phone-app trace 2026-10-09, docs/INVESTIGATION.md §9): body {3: scope, 4: 0, 5: bpm (f32), 6: 0}.
  // Scope 1 sets the running tempo (the pedal follows, the preset stays clean); scope 0 writes it into the
  // preset (the pedal answers 115 dirty, and a normal Save stores it as state-dump field 56). Like the official
  // app: scope 1 while the value moves, one scope 0 with the final value. Field 4 is always 0 (4:1 showed up
  // with the app's tap pad and is unverified); an rx with 4:1 is read like 4:0. The pedal echoes
  // {1:1 3:1 5:bpm} after a live write and sends it unsolicited when the tempo changes on the pedal.
  const TEMPO_MSG = 145;
  const clampTempo = (v) => clamp(Math.round(Number(v)), 30, 300);
  const f32 = (raw) => new DataView(Uint8Array.from(raw).buffer).getFloat32(0, true);
  // scope 1 = live, 0 = into the preset; no bpm = a query (the echo carries the current value).
  const tempoFrame = (scope, bpm) => buildFrame([0x18, scope, 0x20, 0x00, ...(bpm == null ? [] : [0x2D, ...float32LE(bpm)]), 0x30, 0x00], TEMPO_MSG);
  const tempo = { lastLive: null, commitTimer: null, taps: [], ctl: null, dragging: false };

  // Everything that shows the tempo: the inspector field and the metronome when it follows the preset.
  function tempoChanged() {
    metro.presetTempo = state.connected && Number(state.presetTempo) > 0 ? state.presetTempo : null;
    renderTempo();
    if (metro.open) renderMetro();
  }
  function cancelTempoCommit() { clearTimeout(tempo.commitTimer); tempo.commitTimer = null; }
  // keepCommit: a tempo-trainer step leaves a pending commit of the user's own change alone.
  function tempoLive(v, keepCommit = false) {
    if (!state.connected) return;
    const bpm = clampTempo(v);
    if (!keepCommit) cancelTempoCommit();
    state.presetTempo = bpm; tempo.lastLive = bpm;
    writeC304('Live tempo ' + bpm + ' BPM', tempoFrame(1, bpm), 'tempo-live');
    tempoChanged();
  }
  // One scope-0 write with the final value. A typed value goes out live first so the pedal plays it at once.
  function tempoCommit(v) {
    if (!state.connected) return;
    const bpm = clampTempo(v);
    const pending = tempo.commitTimer !== null || tempo.lastLive !== null;
    cancelTempoCommit();
    if (bpm === state.presetTempo && !pending) { tempoChanged(); return; }   // nothing changed
    if (tempo.lastLive !== bpm) writeC304('Live tempo ' + bpm + ' BPM', tempoFrame(1, bpm), 'tempo-live');
    tempo.lastLive = null;
    state.presetTempo = bpm;
    writeC304('Preset tempo ' + bpm + ' BPM', tempoFrame(0, bpm));
    tempoChanged();
  }
  function tempoCommitSoon(ms) { cancelTempoCommit(); tempo.commitTimer = setTimeout(() => { tempo.commitTimer = null; tempoCommit(state.presetTempo); }, ms); }
  // Commit delays, the same in the native editor: −/+, arrows and scrubbing settle after 0.8 s, Tap after 2.6 s
  // (time for more taps), metronome changes when following the preset tempo after 1.5 s.
  const COMMIT_STEP = 800, COMMIT_TAP = 2600, COMMIT_METRO = 1500;
  // −/+ (and arrow keys): live at once, committed when the steps settle (or at Enter / Save).
  function tempoStep(v) { tempoLive(v); tempoCommitSoon(COMMIT_STEP); }
  function tempoTap() {
    const now = performance.now();
    if (tempo.taps.length && now - tempo.taps[tempo.taps.length - 1] > 2500) tempo.taps = [];
    tempo.taps.push(now);
    if (tempo.taps.length > 5) tempo.taps.shift();
    if (tempo.taps.length < 2) return;
    const gaps = tempo.taps.slice(1).map((t, i) => t - tempo.taps[i]);
    tempoLive(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length));
    tempoCommitSoon(COMMIT_TAP);
  }
  // Save right after a step: commit first so the saved preset carries the tempo (the official app does the same).
  function flushTempo() { if (tempo.commitTimer !== null) tempoCommit(state.presetTempo); }
  // State dump field 56 (f32): the preset's stored tempo.
  function tempoFromDump(fields) {
    const e = fields[56] && fields[56][0];
    if (!e || e.wire !== 5) return;
    const v = f32(e.raw);
    if (!(v >= 20 && v <= 400)) return;
    cancelTempoCommit(); tempo.lastLive = null;
    state.presetTempo = clampTempo(v);
    tempoChanged();
  }
  // rx 145 {1:1 3:1 [4:1] 5:bpm}: the echo of a live write, or the tempo changed on the pedal (tap on footswitch I).
  function tempoFromReport(d) {
    const f = parseProtoFields(d.slice(2, d.length - 4));
    const e = f[5] && f[5][0];
    if (!e || e.wire !== 5) return;
    const v = f32(e.raw);
    if (!(v >= 20 && v <= 400)) return;
    const bpm = clampTempo(v);
    if (bpm === state.presetTempo) return;
    if (tempo.commitTimer !== null || tempo.dragging) return;   // an echo of our own writes while the user is still changing it
    log('Pedal tempo: ' + bpm + ' BPM');   // shown (and followed by the metronome), not written into the preset
    tempo.lastLive = null;
    state.presetTempo = bpm;
    tempoChanged();
  }
  const coreOnC305ForTempo = window.onC305;
  window.onC305 = function (event, ...rest) {
    try {
      const v = event && event.target && event.target.value;
      const d = v && v.buffer ? new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength || v.buffer.byteLength) : null;
      const type = d ? frameType(d) : null;
      if (type === TEMPO_MSG) { log('RX C305: ' + hex(d)); tempoFromReport(d); return; }
      if (type === MSG.SetPresetSlotsRequest) { cancelTempoCommit(); tempo.lastLive = null; }   // preset changed on the pedal
    } catch { /* fall through to the core */ }
    return coreOnC305ForTempo.apply(this, [event, ...rest]);
  };

  // Live reports from the pedal (knobs, footswitch bypasses, the expression pedal) are applied in pro/live-sync.js.
  // The UI's part: a bypass click the pedal hasn't confirmed yet wins over an older report, and a local edit of an
  // expression target stays until the pedal moves again.
  NanoLive.hooks.keepLocalBypass = (key, enabled) => {
    const pending = ui.pendingBypassTargets.get(key);
    return !!pending && pending.preset === Number(state.selectedPreset) && pending.on !== enabled;
  };
  NanoLive.hooks.expressionMoved = () => ui.expressionLocalOverrides.clear();
  NanoLive.hooks.stateRead = () => { if (ui.presetUnknown) { ui.presetUnknown = false; ui.sideSig = ''; render(); } };
  NanoLive.hooks.afterExpression = () => restoreExpressionLocalOverrides();

  function clearPendingIRSlotTarget(target = ui.pendingIRSlotTarget) {
    if (!target) return;
    clearTimeout(target.timer);
    if (ui.pendingIRSlotTarget === target) ui.pendingIRSlotTarget = null;
  }

  function holdIRSlotTargetForPreview() {
    const target = ui.pendingIRSlotTarget;
    if (!target) return;
    target.holdForPreviewStop = true;
    clearTimeout(target.timer);
    target.timer = null;
  }

  function releaseIRSlotTargetWhenPreviewFails() {
    const target = ui.pendingIRSlotTarget;
    if (!target || !target.holdForPreviewStop || irAudition.active) return;
    target.holdForPreviewStop = false;
    target.timer = setTimeout(() => settlePendingIRSlotTarget(target), 2500);
  }

  function settleIRSlotTargetAfterPreview() {
    const target = ui.pendingIRSlotTarget;
    if (!target || !target.holdForPreviewStop) return;
    if (target.preset !== Number(state.selectedPreset)) {
      clearPendingIRSlotTarget(target);
      return;
    }
    state.cabIR.fromLibrary = false;
    state.cabIR.on = target.slot > 0;
    state.cabIR.selectedSlot = target.slot;
    state.cabIR.stateSlot = target.slot;
    if (target.slot > 0) state.cabIR.lastActiveSlot = target.slot;
    if (target.currentIR) state.currentIR = { ...target.currentIR };
    clearPendingIRSlotTarget(target);
    render();
  }

  function settlePendingIRSlotTarget(target) {
    if (ui.pendingIRSlotTarget !== target) return;
    clearPendingIRSlotTarget(target);
    render();
  }

  function beginExpressionBoundary() {
    ui.clearOverridesOnRead = true;
    ui.expressionLocalOverrides.clear();
    ui.pendingBypassTargets.clear();
    ui.bypassWriteGeneration++;
    clearPendingIRSlotTarget();
  }

  // A preset change on the pedal (footswitch): local edits, unconfirmed clicks and auditions belong to the old preset.
  const coreOnC305ForPresetChange = window.onC305;
  window.onC305 = function (event, ...rest) {
    const d = NanoLive.exactBytes(event);
    if (d && frameType(d) === MSG.SetPresetSlotsRequest) { beginExpressionBoundary(); endAuditionsAfterPedalPresetChange(); }
    return coreOnC305ForPresetChange.apply(this, [event, ...rest]);
  };

  // Edits on their way to the pedal. Its dirty report (115) comes after an edit lands, so a prompt right after an
  // edit would see a clean preset: an edit write queued or in flight, or sent less than 300 ms ago with no 115 since,
  // counts as unsaved for the "Save changes to …?" prompts (isDirtyNow). The mark in the header stays the pedal's.
  const EDIT_WRITE_TYPES = new Set([26, 28, 31, 62, 94, 95, 99, 136]);   // knobs, slots, bypass, expression, cab, FX, models
  const editWrites = { inFlight: 0, lastSentAt: 0, lastReportAt: 0 };
  const isEditWrite = (p) => {
    const type = p && p.length >= 6 ? frameType(p) : null;
    return EDIT_WRITE_TYPES.has(type) || (type === TEMPO_MSG && p[2] === 0x18 && p[3] === 0);   // tempo: the preset's, not the live one
  };
  const coreWriteC304 = window.writeC304;
  window.writeC304 = function (label, payload) {
    if (!isEditWrite(payload)) return coreWriteC304.apply(this, arguments);
    editWrites.inFlight++;
    return coreWriteC304.apply(this, arguments).then((ok) => {
      editWrites.inFlight--;
      if (ok) editWrites.lastSentAt = Date.now();
      return ok;
    });
  };
  const coreTypedForDirty = window.handleTypedMessage;
  window.handleTypedMessage = function (data) {
    if (frameType(data) === MSG.PresetDirtyStateChanged) editWrites.lastReportAt = Date.now();
    return coreTypedForDirty.apply(this, arguments);
  };
  const editPending = () => editWrites.inFlight > 0 || (editWrites.lastSentAt > editWrites.lastReportAt && Date.now() - editWrites.lastSentAt < 300);

  // A preset switch drops unsaved edits on the pedal, a pending tempo commit included.
  const coreSelectPreset = window.selectPreset;
  window.selectPreset = function () {
    cancelTempoCommit();
    tempo.lastLive = null;
    beginExpressionBoundary();
    return coreSelectPreset.apply(this, arguments);
  };

  // The Tempo field in the inspector's top row: −/+ (Shift ×10), typeable, Tap. Built once and moved into each
  // inspector head, so it keeps focus and a half-typed value across renders.
  function tempoControl() {
    if (tempo.ctl) return tempo.ctl.root;
    const input = el('input', { class: 'tempo-num', type: 'text', inputmode: 'numeric', maxlength: '3', spellcheck: 'false', 'aria-label': 'Preset tempo (BPM)', dataset: { fk: 'tempo-bpm' } });
    const stepBy = (d) => tempoStep((Number(state.presetTempo) || 120) + d);
    const btn = (fk, label, d, text) => el('button', { type: 'button', tabindex: '-1', 'aria-label': label, title: label + ' (Shift: ' + (d > 0 ? '+' : '−') + '10)', dataset: { fk }, onclick: (e) => stepBy(e.shiftKey ? d * 10 : d) }, text);
    const down = btn('tempo-down', 'Slower', -1, '−'), up = btn('tempo-up', 'Faster', 1, '+');
    const tap = el('button', { type: 'button', class: 'btn small tempo-tap', title: 'Tap the tempo (two taps or more)', dataset: { fk: 'tempo-tap' }, onclick: tempoTap }, 'Tap');
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) tempoCommit(input.value); input.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; input.blur(); renderTempo(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepBy((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1)); }
    });
    input.addEventListener('change', () => { const v = Number(input.value); if (input.value.trim() && Number.isFinite(v) && clampTempo(v) !== state.presetTempo) tempoCommit(v); });
    input.addEventListener('blur', () => { renderTempo(); render(); });
    // Drag sideways on the TEMPO label to scrub: 1 BPM per 4 px (Shift: per 16 px), live, committed after it settles.
    const lbl = el('span', { class: 'tempo-lbl', text: 'Tempo', title: 'Drag sideways to change the tempo', dataset: { fk: 'tempo-scrub' } });
    lbl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !state.connected) return;
      e.preventDefault();
      const x0 = e.clientX, from = Number(state.presetTempo) || 120;
      let moved = false;
      tempo.dragging = true;
      document.body.style.cursor = 'ew-resize';
      const move = (ev) => {
        const v = clampTempo(from + Math.trunc((ev.clientX - x0) / (ev.shiftKey ? 16 : 4)));
        if (v === state.presetTempo) return;
        moved = true; tempoLive(v);
      };
      const up = () => {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        tempo.dragging = false;
        document.body.style.cursor = '';
        if (moved) tempoCommitSoon(COMMIT_STEP);
      };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    const root = el('div', { class: 'tempo-ctl', title: keyLabel('The preset\u2019s tempo (delay and modulation sync follow it). Save (\u2318S) stores it.') },
      lbl,
      el('div', { class: 'stepper tempo-stepper' }, down, input, up),
      el('span', { class: 'tempo-unit', text: 'BPM' }), tap);
    tempo.ctl = { root, input, down, up, tap };
    renderTempo();
    return root;
  }
  const tempoFocused = () => Boolean(tempo.ctl && document.activeElement === tempo.ctl.input);
  function renderTempo() {
    const c = tempo.ctl;
    if (!c) return;
    const on = state.connected;
    const known = on && Number(state.presetTempo) > 0;
    if (document.activeElement !== c.input) c.input.value = known ? String(state.presetTempo) : '';
    c.input.placeholder = '–';
    for (const b of [c.input, c.down, c.up, c.tap]) b.disabled = !on;
    c.root.classList.toggle('off', !on);
  }

  // Settings → Metronome → "Follow the preset tempo": the metronome plays the preset's tempo, and changing the
  // metronome's tempo writes it to the pedal (live while it moves, into the preset on commit).
  metro.tempoFollowsPreset = Boolean(pref.get('metroFollowsPreset', false));
  function setFollowPreset(v) { metro.tempoFollowsPreset = !!v; pref.set('metroFollowsPreset', metro.tempoFollowsPreset); tempoChanged(); renderMetro(); }
  // Every metronome change goes live at once and is committed 1.5 s after the last one; trainer steps stay live.
  metro.onTempoChange = (bpm, source) => {
    if (!metro.tempoFollowsPreset || !state.connected) return;
    if (source === 'trainer') { tempoLive(bpm, true); return; }
    if (source !== 'user') return;
    tempoLive(bpm); tempoCommitSoon(COMMIT_METRO);
  };
  window.__tempo = { state: tempo, frame: tempoFrame, live: tempoLive, commit: tempoCommit, tap: tempoTap, setFollow: setFollowPreset };

  // ------------------------------------------------------------------ pedal library
  let irLibraryQuery = '';
  async function ensureLibrary() {
    if (state.library.loaded) return true;
    requestLibraryContent();
    const t0 = Date.now();
    while (!state.library.loaded && Date.now() - t0 < 6000) await new Promise(r => setTimeout(r, 100));
    return state.library.loaded;
  }

  function applyIRLibrarySearch(root) {
    const query = irLibraryQuery.trim().toLowerCase();
    let visible = 0;
    root.querySelectorAll('.cab-library-group').forEach(group => {
      let groupVisible = 0;
      group.querySelectorAll('.library-row').forEach(row => {
        const match = !query || row.dataset.search.includes(query);
        row.hidden = !match;
        if (match) groupVisible++;
      });
      group.hidden = groupVisible === 0;
      visible += groupVisible;
    });
    const empty = root.querySelector('.library-empty');
    if (empty) {
      const loaded = state.library.loaded;
      empty.hidden = loaded && visible > 0;
      if (!loaded) empty.textContent = state.connected ? 'Reading the pedal library…' : 'Connect your Nano Cortex to read its library.';
      else if (query) empty.textContent = 'Nothing matches “' + irLibraryQuery.trim() + '”.';
      else empty.textContent = 'No cabs or IRs are available in the pedal library.';
    }
  }

  // Built again only when the library or an audition changed (the inspector redraws on every report). The query is
  // applied to the rows in place, so typing never rebuilds it; the same input keeps its focus and caret.
  let irLibraryCache = { sig: '', node: null };
  function irLibrarySection() {
    const lib = state.library;
    const sig = JSON.stringify([state.connected, lib.loaded, ui.uploading, ui.previewBusy,
      irAudition.busy, irAudition.stopping, irAudition.active && [irAudition.active.kind, irAudition.active.index],
      irAudition.pending && [irAudition.pending.kind, irAudition.pending.index],
      ...['irFactory', 'irUser'].map(k => (lib[k] || []).map(x => x.index + ':' + x.name).join('|'))]);
    if (irLibraryCache.node && irLibraryCache.sig === sig) return irLibraryCache.node;
    const old = irLibraryCache.node && irLibraryCache.node.querySelector('.cab-library-search');
    const caret = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd] : null;
    const root = el('div', { class: 'cab-library-content' });
    irLibraryCache = { sig, node: root };
    const search = el('input', {
      class: 'search cab-library-search', type: 'search', placeholder: 'Search cabs and IRs', dataset: { fk: 'cab-lib-search' },
      'aria-label': 'Search cabs and IRs', autocomplete: 'off', spellcheck: 'false', value: irLibraryQuery,
      oninput: (e) => { irLibraryQuery = e.currentTarget.value; applyIRLibrarySearch(root); },
    });
    const groups = [
      ['irFactory', 'Factory cabs', state.library.irFactory || []],
      ['irUser', 'Your IRs', state.library.irUser || []],
    ];
    const list = el('div', { class: 'cab-library-groups' });
    for (const [kind, label, items] of groups) {
      if (!items.length) continue;
      const grid = el('div', { class: 'library-grid' });
      for (const item of items) {
        const details = [label, item.type, item.instrument, item.author, NanoText.captureDescription(item.description), ...(item.tags || [])].filter(Boolean).join(' · ');
        const isActive = () => Boolean(irAudition.active && irAudition.active.kind === kind && irAudition.active.index === item.index);
        const isPending = () => Boolean(irAudition.pending && irAudition.pending.kind === kind && irAudition.pending.index === item.index);
        const row = el('div', {
          class: 'library-row' + (isActive() ? ' previewing' : ''),
          dataset: { search: [item.name, details].join(' ').toLowerCase() },
          title: details || item.name,
          oncontextmenu: (e) => contextMenu(e, [
            {
              label: isActive() ? 'Stop preview' : 'Preview',
              disabled: !state.connected || !state.library.loaded || ui.uploading || ui.previewBusy || irAudition.busy,
              action: () => isActive() ? stopIRPreview() : startIRPreview({ kind, index: item.index, name: item.name }),
            },
            {
              label: 'Load into slot…',
              disabled: !state.connected || !state.library.loaded || ui.uploading,
              action: () => loadFromLibrary('cab', { kind, index: item.index, name: item.name }),
            },
            ...(kind === 'irUser' ? ['-', {
              label: 'Delete…', danger: true,
              disabled: !state.connected || !state.library.loaded || ui.uploading || ui.previewBusy || irAudition.busy,
              action: () => deleteLibraryIR({ ...item, kind }),
            }] : []),
          ]),
        });
        const pick = el('button', {
          class: 'library-item', type: 'button', disabled: !state.connected || !state.library.loaded,
          'aria-label': 'Choose a slot for ' + item.name,
          onclick: () => loadFromLibrary('cab', { kind, index: item.index, name: item.name }),
        }, el('span', { text: item.name }));
        const previewIcon = sv('svg', { class: 'library-preview-icon', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' });
        previewIcon.append(isActive()
          ? sv('path', { d: 'M4 3h8v10H4z', fill: 'currentColor' })
          : sv('path', { d: 'M5 3v10l8-5z', fill: 'currentColor' }));
        const preview = el('button', {
          class: 'library-preview' + (isActive() ? ' playing' : ''), type: 'button',
          disabled: !state.connected || !state.library.loaded || irAudition.busy,
          'aria-pressed': String(isActive()),
          'aria-label': isActive() ? 'Stop preview of ' + item.name : 'Preview ' + item.name,
          title: isPending() ? 'Starting preview' : isActive() && irAudition.stopping ? 'Stopping preview' : (isActive() ? 'Stop preview' : 'Audition without loading into a slot'),
          onclick: () => isActive() ? stopIRPreview() : startIRPreview({ kind, index: item.index, name: item.name }),
        }, isPending() ? el('span', { class: 'library-preview-pending', 'aria-hidden': 'true', text: '…' }) : previewIcon);
        row.append(pick, preview);
        grid.append(row);
      }
      list.append(el('div', { class: 'cab-library-group' }, el('h4', { text: label }), grid));
    }
    const empty = el('p', { class: 'library-empty' });
    root.append(search, list, empty);
    applyIRLibrarySearch(root);
    if (caret) search.setSelectionRange(caret[0], caret[1]);   // rebuilt while typing: the caret stays where it was
    return root;
  }

  let cabIRLoadId = 0;
  function queueCabIRLoad(item, preselectedSlot = 0) {
    if (ui.cabIRLoadPaused) {
      toast('The last IR load was not confirmed. Reconnect the pedal before loading another IR.');
      return;
    }
    const job = {
      id: ++cabIRLoadId,
      kind: item.kind,
      index: item.index,
      name: item.name,
      preselectedSlot: Number(preselectedSlot) || 0,
      slot: null,
      phase: 'queued',
    };
    const queued = Boolean(ui.cabIRLoadActive || ui.cabIRLoadQueue.length);
    ui.cabIRLoadQueue.push(job);
    if (queued) toast('Queued ' + item.name + '. It will load after the current IR change.');
    render();
    startNextCabIRLoad();
  }

  function startNextCabIRLoad() {
    if (ui.cabIRLoadPaused || ui.cabIRLoadActive || !ui.cabIRLoadQueue.length) return;
    const job = ui.cabIRLoadQueue.shift();
    ui.cabIRLoadActive = job;
    job.phase = 'choosing';
    ui.slotPreselect = job.preselectedSlot;
    render();

    const current = (state.library[job.kind] || []).find(candidate => candidate.index === job.index);
    if (!current || !sameName(current.name, job.name)) {
      toast('The pedal IR library changed. Refresh it and try again.');
      void finishCabIRLoad(job, false);
      return;
    }

    Promise.resolve(loadLibraryCab(job.kind, job.index)).then(slot => {
      if (ui.cabIRLoadActive !== job || job.finishing) return;
      if (slot) {
        if (ui.demo) demo.pickIR(slot);
        void finishCabIRLoad(job, true);
        return;
      }
      const pending = state.pendingCabAssignment;
      const uncertain = job.slot && pending && pending.slot === job.slot && sameName(pending.name, job.name);
      if (uncertain) {
        state.pendingCabAssignment = null;
        ui.cabIRLoadPaused = true;
        ui.cabIRLoadTimedOut = job;
        ui.cabIRLoadQueue.length = 0;
        toast('The pedal did not confirm this IR change. Reconnect before trying another IR.');
      }
      void finishCabIRLoad(job, false, { acknowledged: job.responseReceived, timeout: uncertain });
    }).catch(err => {
      if (ui.cabIRLoadActive !== job || job.finishing) return;
      log('ERROR: loading library IR: ' + err.message);
      toast('Could not load ' + job.name + ' into a pedal slot.');
      void finishCabIRLoad(job, false);
    });
  }

  async function finishCabIRLoad(job, success, { acknowledged = false, timeout = false } = {}) {
    if (ui.cabIRLoadActive !== job || job.finishing) return;
    job.finishing = true;
    job.phase = success ? 'activating' : timeout ? 'unconfirmed' : 'failed';
    render();
    if (success) toast('Cab ' + job.name + ' loaded into slot ' + job.slot);
    else if (!acknowledged && !timeout && job.slot) toast('Could not confirm loading ' + job.name + ' into a slot.');
    ui.slotPreselect = 0;
    ui.cabIRLoadActive = null;
    render();
    startNextCabIRLoad();
  }

  // `slot`: load the pick straight into that slot (from a slot button's menu) instead of asking.
  async function openLibraryPicker(kind, anchor, slot) {
    if (pop) { closePopover(); return; }
    if (!state.library.loaded) {
      toast('Reading the library on the pedal…');
      if (!await ensureLibrary()) { toast('The pedal didn’t send its library. Try again.'); return; }
    }
    const isCap = kind === 'capture';
    const groups = isCap
      ? [['factory', 'Factory captures', state.library.factory], ['user', 'Your captures', state.library.user]]
      : [['irFactory', 'Factory cabs', state.library.irFactory], ['irUser', 'Your IRs', state.library.irUser]];
    // `sub` (raw words) stays the search text and the row tooltip; `subNode` is what the row shows.
    const items = groups.flatMap(([k, cat, list]) => list.map(it => ({
      kind: k, index: it.index, name: it.name, cat, sub: [it.type, it.instrument, it.author].filter(Boolean).join(' · '),
      subNode: isCap ? captureSub(it) : null,
    })));
    const curName = isCap ? state.currentCapture.name : state.currentIR.shortName;
    pickerPopover({
      anchor, color: stage(isCap ? 'capture' : 'cab').color,
      label: isCap ? 'Load a capture from the pedal’s library' : 'Load a cab from the pedal’s library',
      placeholder: isCap ? 'Search captures' : 'Search cabs and IRs',
      items, isCurrent: (m) => sameName(m.name, curName),
      emptyText: (q) => (items.length ? 'Nothing matches “' + q + '”.' : 'The pedal’s library is empty.'),
      onPick: (m) => loadFromLibrary(kind, m, slot || 0),
    });
  }
  async function loadFromLibrary(kind, item, preselectedSlot = 0) {
    if (kind === 'cab') {
      queueCabIRLoad(item, preselectedSlot);
      return;
    }
    if (preselectedSlot) ui.captureSlotPreselect = Number(preselectedSlot) || 0;
    let slot;
    try {
      slot = await loadLibraryCapture(item.kind, item.index);
    } finally {
      ui.captureSlotPreselect = 0;
    }
    if (!slot) { render(); return; }
    if (ui.demo) demo.pickCapture(slot);
    toast('Capture ' + item.name + ' loaded into slot ' + slot);
    render();
  }

  // Delete a user IR from the pedal's library: 82 { 1: 2, 4: { 1: index, 2: name } } → 83 { 1: 6, 3: 1 }
  // (docs/INVESTIGATION.md §6a). The library is read again right before the delete, and the index must still hold
  // this IR: library indices shift when an IR is added or removed.
  function irSlotsHolding(name) {
    const slots = [];
    for (let i = 1; i <= irSlotCount(); i++) if (sameName(state.irNames.get(i), name)) slots.push(i);
    return slots;
  }
  async function deleteLibraryIR(item) {
    if (!state.connected || !item || item.kind !== 'irUser' || !Number.isInteger(item.index)) return;
    if (ui.uploading || NanoTransfer.busy || ui.previewBusy || irAudition.busy) {
      toast('Finish the current pedal action before deleting an IR.');
      return;
    }
    const slots = irSlotsHolding(item.name);
    const playing = activeIRSlot();
    const where = state.cabIR.fromLibrary && sameName(state.currentIR.shortName, item.name)
      ? ' The current preset plays it straight from the library.'
      : slots.length ? ' It is loaded in IR slot ' + slots.join(' and ') + (slots.includes(playing) ? ', which the current preset uses' : '') + '. Check ' + (slots.length > 1 ? 'those slots' : 'that slot') + ' afterwards.' : '';
    const choice = await modal({
      title: 'Delete IR “' + item.name + '” from the pedal?',
      body: 'This permanently removes the IR from the Nano Cortex library. There is no undo.' + where,
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Delete', primary: true }],
    });
    if (choice !== 'ok') { render(); return; }
    if (!(await stopAnyAudition('deleting the IR'))) return;

    ui.uploading = true;
    ui.lastAction = 'Checking the pedal library…';
    renderStatus();
    let current = null, reply = null;
    try {
      state.library.loaded = false;
      state.library.requested = false;
      if (await ensureLibrary()) current = state.library.irUser.find(candidate => candidate.index === item.index);
      if (current && sameName(current.name, item.name)) {
        const nameBytes = Array.from(new TextEncoder().encode(current.name));
        const record = [0x08, ...encodeVarint(current.index), 0x12, ...encodeVarint(nameBytes.length), ...nameBytes];
        const frame = buildFrame([0x08, 0x02, 0x22, ...encodeVarint(record.length), ...record], NanoLive.MSG.DeleteLibraryIRRequest);
        ui.lastAction = 'Deleting IR ' + current.name;
        renderStatus();
        reply = await writeAndAwait('Delete IR ' + current.name, frame, NanoLive.MSG.DeleteLibraryIRResponse);
      }
    } finally {
      ui.uploading = false;
      ui.lastAction = '';
      render();
    }
    if (!current || !sameName(current.name, item.name)) {
      toast(state.library.loaded
        ? 'The pedal’s IR library changed: “' + item.name + '” is no longer where it was. Nothing was deleted.'
        : 'Could not read the pedal’s IR library, so nothing was deleted. Try again.');
      return;
    }
    if (!reply || fieldValue(reply, 3) !== 1) {
      toast('The pedal did not confirm deleting ' + current.name + '.');
      return;
    }

    state.library.loaded = false;
    state.library.requested = false;
    const refreshed = await ensureLibrary();
    if (!refreshed) {
      state.library.irUser = state.library.irUser.filter(candidate => candidate.index !== current.index);
    }
    render();
    toast(refreshed
      ? current.name + ' deleted from the pedal IR library.'
      : current.name + ' deleted, but the pedal IR list could not be refreshed.');
  }
  window.__deleteLibraryIR = deleteLibraryIR;

  // ------------------------------------------------------------------ slot usage scan
  // Parity with the native app: step through every saved preset, note the capture and cab slot each one
  // plays (or that it plays one straight from the library), then go back to the preset we started on.
  // Switching presets discards unsaved edits, so the scan refuses to start while there are any.
  const isDirtyNow = () => pedalDirtyForUI() || editPending();
  window.__isDirtyForPrompt = isDirtyNow;
  const presetLabel = (n) => n + ' ' + presetName(n);
  const usersOf = (kind, slot) => (ui.usage && (kind === 'capture' ? ui.usage.captures : ui.usage.cabs)[slot]) || [];
  const scanTime = () => (ui.usage ? ui.usage.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
  // Small count on a slot button after a scan: how many presets play that slot.
  function usageBadge(kind, slot) {
    if (!ui.usage) return null;
    const users = usersOf(kind, slot);
    const partial = ui.usage.complete ? '' : ' (partial scan)';
    if (!users.length) return el('span', { class: 'uses free', text: 'free', title: 'No scanned preset uses this slot' + partial });
    return el('span', { class: 'uses', text: String(users.length),
      title: 'Used by ' + users.length + ' preset' + (users.length === 1 ? '' : 's') + ': ' + users.map(presetLabel).join(', ') + partial });
  }

  async function switchForScan(n) {
    const settled = ui.demo ? null : waitForPresetState(n, 4000);
    await selectPreset(n);
    if (ui.demo) { demo.load(n); await new Promise(r => setTimeout(r, 40)); return true; }
    return settled;
  }
  async function scanUsage() {
    if (ui.scanning || !state.connected) return;
    if (isDirtyNow()) { toast('Save or discard your edits first: the scan switches presets.'); return; }
    if (!(await stopAnyAudition('the scan'))) return;
    ui.scanning = true; ui.scanStop = false;
    const origin = state.selectedPreset;
    const todo = [];
    for (let i = 1; i <= 64; i++) if (!/^empty$/i.test(presetName(i))) todo.push(i);
    const res = { captures: {}, cabs: {}, library: [], cabLibrary: [], date: null, complete: false, scanned: 0, total: todo.length };
    const add = (map, k, n) => { (map[k] = map[k] || []).push(n); };
    const note = (n) => {
      if (state.capture.on) {
        if (state.capture.fromLibrary) res.library.push(n);
        else { const slot = activeCaptureSlot(); if (slot) add(res.captures, slot, n); }
      }
      if (state.cabIR.on) {
        if (state.cabIR.fromLibrary) res.cabLibrary.push(n);
        else { const slot = activeIRSlot(); if (slot) add(res.cabs, slot, n); }
      }
    };
    log('Slot usage scan: ' + todo.length + ' presets, starting from preset ' + origin);
    try {
      if (todo.includes(origin)) { note(origin); res.scanned++; }   // the preset we're on needs no switch
      for (const n of todo) {
        if (n === origin) continue;
        if (ui.scanStop || !state.connected || isDirtyNow()) break;
        ui.lastAction = 'Scanning presets ' + (res.scanned + 1) + '/' + todo.length + '\u2026';
        renderStatus(); refreshUsagePop();
        if (!(await switchForScan(n))) { log('Slot usage scan: preset ' + n + ' did not answer, stopping.'); break; }
        note(n);
        res.scanned++;
      }
    } finally {
      if (state.connected && state.selectedPreset !== origin) {
        ui.lastAction = 'Returning to preset ' + origin + '\u2026'; renderStatus();
        await switchForScan(origin);
      }
      res.complete = res.scanned === todo.length;
      res.date = new Date();
      ui.usage = res;
      ui.scanning = false; ui.scanStop = false;
      ui.lastAction = res.complete ? 'Scanned ' + res.scanned + ' presets' : 'Partial scan: ' + res.scanned + ' of ' + todo.length + ' presets';
      log('Slot usage scan ' + (res.complete ? 'done' : 'stopped early') + ': ' + res.scanned + '/' + todo.length + ', back on preset ' + state.selectedPreset);
      ui.sideSig = '';
      render(); refreshUsagePop(); scrollPresetIntoView();
    }
  }

  function usageContent() {
    const kids = [el('div', { class: 'pop-group', text: 'Slot usage' })];
    const dirty = isDirtyNow();
    if (ui.scanning) {
      kids.push(el('button', { class: 'ctx-item', dataset: { fk: 'usage-stop' }, onclick: () => { ui.scanStop = true; } }, 'Stop scan'));
      kids.push(el('p', { class: 'usage-line dim', text: ui.lastAction }));
      return kids;
    }
    kids.push(el('button', { class: 'ctx-item', dataset: { fk: 'usage-scan' }, disabled: dirty || !state.connected ? 'true' : null,
      onclick: () => scanUsage() }, 'Scan slot usage\u2026'));
    if (dirty) kids.push(el('p', { class: 'usage-line warn', dataset: { fk: 'usage-why' }, text: 'Save or discard your edits first: the scan switches through every preset, and switching discards unsaved edits.' }));
    else if (!ui.usage) kids.push(el('p', { class: 'usage-line dim', text: 'Steps through every saved preset to see which capture and cab slots it plays, then comes back here. About a second per preset.' }));
    const u = ui.usage;
    if (!u) return kids;
    const line = (fk, label, value, cls = '') => el('p', { class: 'usage-line ' + cls, dataset: { fk } }, el('b', { text: label + ': ' }), value);
    const list = (ns) => (ns.length ? ns.map(presetLabel).join(', ') : 'none');
    kids.push(el('div', { class: 'sep' }));
    kids.push(line('usage-date', 'Scanned', scanTime() + ', ' + u.scanned + ' preset' + (u.scanned === 1 ? '' : 's'), 'dim'));
    if (!u.complete) kids.push(line('usage-partial', 'Partial scan', 'stopped after ' + u.scanned + ' of ' + u.total + ' presets', 'warn'));
    const cur = activeCaptureSlot();
    if (state.capture.fromLibrary) kids.push(el('p', { class: 'usage-line', dataset: { fk: 'usage-feeds' }, text: 'This preset plays ' + (state.currentCapture.name || 'its capture') + ' straight from the library.' }));
    else if (cur) kids.push(line('usage-feeds', 'Slot ' + cur + ' feeds', list(usersOf('capture', cur))));
    const free = (kind, count) => Array.from({ length: count }, (_, i) => i + 1).filter(i => !usersOf(kind, i).length);
    const fc = free('capture', captureSlotCount()), fi = free('cab', irSlotCount());
    kids.push(line('usage-free', 'Free capture slots', fc.length ? fc.join(', ') : 'none'));
    kids.push(line('usage-free-cab', 'Free cab slots', fi.length ? fi.join(', ') : 'none'));
    if (u.library.length) kids.push(line('usage-library', 'Captures from the library', list(u.library)));
    if (u.cabLibrary.length) kids.push(line('usage-cab-library', 'Cabs from the library', list(u.cabLibrary)));
    return kids;
  }
  function refreshUsagePop() {
    if (pop && pop.classList.contains('usage-pop')) pop.replaceChildren(...usageContent());
  }
  function openUsage(anchor) {
    if (pop) { const wasUsage = pop.classList.contains('usage-pop'); closePopover(); if (wasUsage) return; }
    pop = el('div', { class: 'pop usage-pop', role: 'dialog', 'aria-label': 'Slot usage', style: '--c:' + stage('capture').color }, ...usageContent());
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 348)) + 'px';
    pop.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - pop.getBoundingClientRect().height - 8)) + 'px';
    const first = pop.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  window.__scanUsage = scanUsage;

  async function goToPreset(n) {
    n = Math.max(1, Math.min(64, n));
    if (ui.scanning) { toast('Wait for the slot usage scan to finish.'); ui.sideSig = ''; render(); return; }
    ui.pendingPreset = null;
    ui.sideSig = ''; // repaint the list either way (undoes a keyboard highlight if cancelled)
    if (n === state.selectedPreset && state.connected && !ui.presetUnknown) { render(); return; }
    if (isDirtyNow() && state.connected) {
      const choice = await modal({
        title: 'Save changes to ' + presetName(state.selectedPreset) + '?',
        body: 'Switching presets discards edits that haven’t been saved to the pedal.',
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'discard', label: 'Don’t save' },
          { id: 'save', label: 'Save and switch', primary: true },
        ],
      });
      if (choice === 'cancel' || !choice) { render(); return; }
      if (choice === 'save') await doSave();
    }
    if (!(await stopAnyAudition('the preset switch'))) { ui.sideSig = ''; render(); return; }
    await selectPreset(n);
    if (ui.demo) demo.load(n);
    render();
    scrollPresetIntoView();
  }
  const goToPresetSoon = debounce(goToPreset, 220);

  async function doConnect() {
    if (state.connected) {
      if (ui.demo) { demo.stop(); return; }
      disconnect();
      return;
    }
    ui.connectError = '';
    ui.connecting = true;
    wrapRequestDevice();
    render();
    try {
      await connectAll();
    } finally {
      ui.connecting = false;
      ble.autoWhy = '';
      closeBleChooser();
      if (ble.restart) { ble.restart = false; if (!state.connected && !ui.demo) doConnect(); }   // Scan again, Show all, or choose again
      else ble.next = null;
      render();
    }
  }

  // Turn Web Bluetooth's raw errors into what to do next.
  function friendlyConnectError(msg) {
    const hint = window.__bleHint; window.__bleHint = null; // set by the desktop shell's device picker
    if (hint === 'auto-none' && ble.autoWhy === 'wake') return 'Your Nano Cortex didn\u2019t show up after the computer woke up. Power it on (and close Cortex Cloud on your phone), then click Connect.';
    if (hint === 'auto-none') return 'Your Nano Cortex didn\u2019t show up at launch. Power it on (and close Cortex Cloud on your phone), then click Connect.';
    if (hint === 'none-found') return 'No Nano Cortex showed up nearby. Check that it\u2019s powered on and that Cortex Cloud on your phone isn\u2019t connected to it, then try again.';
    if (/adapter not available|bluetooth.*(off|unavailable)/i.test(msg)) return 'Bluetooth is off or unavailable on this computer. Turn it on and try again.';
    if (/cancel/i.test(msg)) return 'No device was chosen. Click Connect to scan again.';
    if (/C304|C305|A002|A003|service/i.test(msg)) return 'That device isn\u2019t a Nano Cortex, or its editor service didn\u2019t respond. Try again and pick the Nano Cortex.';
    if (/GATT|disconnect|connection/i.test(msg)) return 'The pedal dropped the connection. Make sure your phone isn\u2019t connected to it, then try again.';
    return 'Couldn\u2019t connect: ' + msg;
  }

  // ------------------------------------------------------------------ Bluetooth chooser (desktop app)
  // The shell's picker (src/bt-picker.js) answers requestDevice(): it takes the remembered pedal or the first device
  // that advertises the Nano's service by itself, and otherwise has this chooser drawn. The page tells it, right
  // before each requestDevice(), what the scan is for (bt-request, which answers with the scan mode), and afterwards
  // how connecting went: only 'ok' (C304/C305 found) remembers the device (issue #15).
  //   'nano' scan: requestDevice() filtered on the Nano's services, so nothing else is listed.
  //   'all' scan: every device nearby (the fallback, "Show all Bluetooth devices").
  // Without the shell (tests, the web preview) choices and results are only collected in __ble.
  const ble = {
    next: null,        // options for the next requestDevice(): { want, auto, choose, notice }
    restart: false,    // start another scan once the current attempt has ended
    mode: 'nano',
    attempt: { noService: 0, otherService: 0, accessible: 0 },
    chooser: null,     // { bg, list, status, view }
    choices: [], results: [],
  };
  window.__ble = ble;
  const BLE_SERVICES = typeof SERVICE_UUIDS !== 'undefined' ? SERVICE_UUIDS : [];

  // ------------------------------------------------------------------ releasing the Bluetooth link
  // The page lets go of the pedal whenever it decides it is disconnected: the link dropped (gattserverdisconnected),
  // a write found it gone, an explicit Disconnect, a connect that failed half-way, the computer going to sleep. It
  // calls gatt.disconnect() on the device it had, even when Chromium already reports it disconnected, and keeps no
  // reference to it. Before every new requestDevice() an older device object that still reports a connection is
  // disconnected as well. (2026-10-20→23: the editor showed "Disconnected" for two days while macOS still held a
  // link to the pedal; the pedal stopped advertising, and Connect found nothing until the app quit.)
  ble.devices = new Set();   // device objects a requestDevice() returned that may still hold a link
  ble.requests = [];         // the options of each requestDevice() (`next`), for the UX test
  function releaseDevice(device) {
    if (!device) return;
    try { device.removeEventListener('gattserverdisconnected', window.onDisconnected); } catch { /* not an EventTarget */ }
    const open = !!(device.gatt && device.gatt.connected);
    try { if (device.gatt) device.gatt.disconnect(); } catch (err) { log('ERROR: releasing the Bluetooth link: ' + err.message); }
    const still = !!(device.gatt && device.gatt.connected);
    if (still) ble.devices.add(device);   // tried again before the next scan
    else ble.devices.delete(device);
    log('Bluetooth link to ' + (device.name || 'the device') + ' released' + (still ? ', but it still reports a connection (tried again before the next scan)' : open ? ' (it was still open)' : '') + '.');
  }
  // The page is disconnected now (setStatus 'Disconnected'): release the device it had and drop every reference.
  function releaseLink() {
    const device = state.device;
    state.device = null; state.server = null; state.c304 = null; state.c305 = null;
    if (device) releaseDevice(device);
  }
  // Right before a scan: any device object from before that still reports a connection.
  function releaseOldDevices() {
    if (state.device && !state.connected) releaseLink();
    for (const device of [...ble.devices]) {
      if (device === state.device) continue;
      if (device.gatt && device.gatt.connected) releaseDevice(device);
      else ble.devices.delete(device);
    }
  }
  // A write that failed because the link is gone (no gattserverdisconnected came, or not yet): disconnected, and
  // released like any other disconnect. A write refused while the link is still up changes nothing.
  let writeFailPending = false;
  function writeFailed(err) {
    if (ui.demo || !state.connected || writeFailPending) return;
    const d = state.device;
    const gone = !d || !d.gatt || !d.gatt.connected || /disconnected|not connected/i.test(String((err && err.message) || err));
    if (!gone) return;
    writeFailPending = true;
    setTimeout(() => {   // after the core's "ERROR: BLE write failed" line
      writeFailPending = false;
      if (!state.connected || ui.demo) return;
      log('The Bluetooth link is gone (a write failed); disconnecting.');
      window.onDisconnected();
    }, 0);
  }
  // Every requestDevice() goes through here: the release above first, then (in the desktop app) the shell's picker is
  // told what the scan is for. ble.requestDevice is the browser's; the UX test puts a fake pedal there. Installed at
  // boot and again before each connect (a browser that gains navigator.bluetooth later, the UX test on Linux).
  function wrapRequestDevice() {
    const bt = navigator.bluetooth;
    if (!bt || !bt.requestDevice || bt.requestDevice.__nano) return;
    if (!ble.requestDevice) ble.requestDevice = bt.requestDevice.bind(bt);
    const wrapped = (options) => {
      releaseOldDevices();
      ble.requests.push(Object.assign({}, ble.next || {}));
      let opts = options;
      if (shellBridge && shellBridge.bluetoothRequest) {
        const next = ble.next || {};
        ble.next = null;
        ble.mode = shellBridge.bluetoothRequest(next) === 'all' ? 'all' : 'nano';
        if (ble.mode !== 'all' && BLE_SERVICES.length) opts = { filters: BLE_SERVICES.map(s => ({ services: [s] })), optionalServices: BLE_SERVICES };
      }
      return Promise.resolve(ble.requestDevice(opts)).then((device) => { if (device) ble.devices.add(device); return device; });
    };
    wrapped.__nano = true;
    bt.requestDevice = wrapped;
  }
  wrapRequestDevice();
  // A new scan from the shell (after a device turned out not to be a Nano, with a user gesture) or from the
  // chooser's buttons. While an attempt is running it is cancelled first and the scan starts when it has ended.
  window.__connectAgain = (opts) => {
    if (state.connected || ui.demo) return false;
    ble.next = Object.assign({}, opts);
    if (ui.connecting) ble.restart = true; else doConnect();
    return true;
  };
  function bleChoose(choice) {
    ble.choices.push(choice);
    if (shellBridge && shellBridge.bluetoothChoose) shellBridge.bluetoothChoose(choice).catch(() => {});
  }
  function bleResult(kind) {
    ble.results.push(kind);
    if (shellBridge && shellBridge.bluetoothResult) shellBridge.bluetoothResult(kind).catch(() => {});
  }
  // From the core's log lines for one connect attempt: did the device answer "no such service" (not a Nano), or did
  // something else go wrong (a dropped link proves nothing)?
  function bleTrack(text) {
    const a = ble.attempt;
    if (/^Requesting Nano Cortex/.test(text)) Object.assign(a, { noService: 0, otherService: 0, accessible: 0 });
    else if (/^Service accessible/.test(text)) a.accessible++;
    else if (/^Service unavailable /.test(text)) { if (/No Services matching/i.test(text)) a.noService++; else a.otherService++; }
    else if (/^Connect failed:/.test(text)) {
      const msg = text.replace(/^Connect failed:\s*/, '');
      bleResult(/cancel/i.test(msg) ? 'cancelled'
        : /C304\/C305 not found/.test(msg) && !a.otherService && (a.noService || a.accessible) ? 'no-service' : 'failed');
      Object.assign(a, { noService: 0, otherService: 0, accessible: 0 });
    }
  }

  function closeBleChooser() {
    const c = ble.chooser;
    if (!c) return;
    ble.chooser = null;
    c.bg.remove();
    document.removeEventListener('keydown', c.onKey, true);
    if (c.prev && c.prev.isConnected) c.prev.focus({ preventScroll: true });
  }
  // The user's answer: a device id, or 'cancel' / 'rescan' / 'all'.
  function bleChooserAction(what) {
    const c = ble.chooser;
    if (!c) return;
    const mode = c.view.mode;
    closeBleChooser();
    if (what === 'rescan' || what === 'all') {
      window.__connectAgain({ want: what === 'all' ? 'all' : mode, choose: true });
      bleChoose(what);
    } else bleChoose(what === 'cancel' ? '' : what);
  }
  const unnamedLabel = (id) => 'Unnamed device · …' + String(id).replace(/[^0-9a-z]/gi, '').slice(-4).toUpperCase();
  // view from the shell: { open, mode, scanning, notice, devices: [{ id, name, nano, remembered, notNano }] }, in order.
  function showBleChooser(view) {
    if (!view || !view.open) { closeBleChooser(); return; }
    let c = ble.chooser;
    if (!c) {
      const list = el('div', { class: 'bt-list', role: 'listbox', 'aria-label': 'Bluetooth devices', dataset: { fk: 'bt-list' } });
      const status = el('div', { class: 'bt-status', dataset: { fk: 'bt-status' } });
      const title = el('h2', { dataset: { fk: 'bt-title' } });
      const notice = el('p', { class: 'warn bt-notice', dataset: { fk: 'bt-notice' } });
      const allBtn = el('button', { class: 'btn', dataset: { fk: 'bt-all' }, onclick: () => bleChooserAction('all') }, 'Show all Bluetooth devices');
      const btns = el('div', { class: 'row' }, allBtn, el('span', { class: 'grow' }),
        el('button', { class: 'btn', dataset: { fk: 'bt-rescan' }, onclick: () => bleChooserAction('rescan') }, 'Scan again'),
        el('button', { class: 'btn', dataset: { fk: 'bt-cancel' }, onclick: () => bleChooserAction('cancel') }, 'Cancel'));
      const kbd = (t) => el('kbd', { text: t });
      const bg = el('div', { class: 'modal-bg bt-bg', onclick: (e) => { if (e.target === bg) bleChooserAction('cancel'); } },
        el('div', { class: 'modal bt-chooser', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'btTitle', dataset: { fk: 'bt-chooser' } },
          title, notice,
          el('p', { class: 'bt-hint', dataset: { fk: 'bt-hint' } }, 'Put the Nano Cortex in pairing mode: hold ', kbd('EXIT'), ' + ', kbd('CAPTURE'),
            ' for about a second, until the Gain ring lights up. Close Cortex Cloud on your phone first; the pedal takes one connection at a time.'),
          status, list, btns));
      title.id = 'btTitle';
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); bleChooserAction('cancel'); return; }
        if (e.key === 'Tab') {   // keep focus inside
          const f = [...bg.querySelectorAll('button:not(:disabled)')];
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          if (f.length) f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
        e.stopPropagation();
      };
      c = ble.chooser = { bg, list, status, title, notice, allBtn, onKey, prev: document.activeElement, rows: new Map(), view };
      document.addEventListener('keydown', onKey, true);
      document.body.append(bg);
    }
    c.view = view;
    const devices = view.devices || [];
    const nanoScan = view.mode === 'nano';
    c.title.textContent = nanoScan ? 'Looking for your Nano Cortex' : 'Choose your Nano Cortex';
    c.notice.textContent = view.notice === 'not-nano' ? 'That device isn’t a Nano Cortex: it has no Nano Cortex service. Pick another one.' : '';
    c.allBtn.hidden = !nanoScan;
    const n = devices.length;
    const count = n === 1 ? '1 device' : n + ' devices';
    c.status.replaceChildren(el('span', { class: 'led' + (view.scanning ? ' busy' : '') }), el('span', { text: nanoScan
      ? (view.scanning ? 'Scanning for the Nano Cortex…' : 'Scan finished. Scan again, or show all Bluetooth devices.')
      : (view.scanning ? 'Scanning… ' + count + ' nearby.' : 'Scan finished: ' + count + '. Scan again to keep looking.') }));
    // Rows are kept per device and moved, not rebuilt, so a click isn't lost when the list updates under it.
    const scroll = c.list.scrollTop;
    const keep = new Set(devices.map(d => d.id));
    for (const [id, row] of c.rows) if (!keep.has(id)) { row.remove(); c.rows.delete(id); }
    const rows = devices.map((d, i) => {
      let row = c.rows.get(d.id);
      if (!row) {
        row = el('button', { class: 'bt-row', role: 'option', onclick: () => bleChooserAction(row.dataset.id) });
        c.rows.set(d.id, row);
      }
      row.dataset.id = d.id;
      row.dataset.fk = 'bt-dev-' + i;
      row.className = 'bt-row' + (d.nano ? ' nano' : '') + (d.notNano ? ' not-nano' : '') + (d.name ? '' : ' unnamed');
      const tag = d.notNano ? 'Not a Nano Cortex' : d.remembered ? 'Last used' : d.nano ? 'Looks like a Nano Cortex' : '';
      row.title = d.name ? d.name : 'This device doesn’t broadcast a name. On Windows the Nano Cortex often shows up like this.';
      row.replaceChildren(...[el('span', { class: 'name', text: d.name || unnamedLabel(d.id) }), tag ? el('span', { class: 'tag', text: tag }) : null].filter(Boolean));
      return row;
    });
    const empty = !n ? el('div', { class: 'bt-empty', dataset: { fk: 'bt-empty' } }, nanoScan
      ? 'Nothing yet. Only devices that offer the Nano Cortex’s Bluetooth service appear here, and the pedal is picked as soon as it does.'
      : 'No Bluetooth devices yet.') : null;
    c.list.replaceChildren(...rows, ...(empty ? [empty] : []));
    c.list.scrollTop = scroll;
    if (!c.bg.contains(document.activeElement)) (rows[0] || c.bg.querySelector('[data-fk="bt-cancel"]')).focus({ preventScroll: true });
  }
  window.__bleChooser = { show: showBleChooser, close: closeBleChooser, action: bleChooserAction };
  if (shellBridge && shellBridge.onBluetoothChooser) shellBridge.onBluetoothChooser(showBleChooser);

  // ------------------------------------------------------------------ captures from Cortex Cloud
  // The shell hands over { cns: base64, meta } when "Send to Nano Cortex" is clicked on
  // a capture page in the Cloud tab. Confirm, stream it to the pedal, refresh the
  // library, then offer a slot.
  async function receiveCapture(bundle) {
    const meta = bundle.meta || {};
    if (!state.connected) { toast('Connect your Nano Cortex first, then send ' + (meta.name || 'the capture') + ' again.'); return false; }
    if (ui.uploading || NanoTransfer.busy) { toast('Another transfer to the pedal is still running. Try again when it has finished.'); return false; }
    const cns = typeof bundle.cns === 'string' ? Uint8Array.from(atob(bundle.cns), c => c.charCodeAt(0)) : Uint8Array.from(bundle.cns);
    const choice = await modal({
      title: 'Send ' + meta.name + ' to the pedal?',
      body: (meta.authorName ? 'By ' + meta.authorName + '. ' : '') + (cns.length / 1024).toFixed(1) + ' KB over Bluetooth. It lands in the pedal\u2019s library; nothing in your presets changes until you load it into a slot.',
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Send', primary: true }],
    });
    if (choice !== 'ok') { render(); return false; }
    ui.uploading = true;
    let reply;
    try {
      reply = await NanoTransfer.uploadCapture({ cns, meta }, (i, n) => { ui.lastAction = 'Sending ' + meta.name + ': ' + i + ' / ' + n; renderStatus(); });
    } catch (err) {
      toast('Sending failed: ' + err.message);
      ui.uploading = false; ui.lastAction = ''; render();
      return false;
    }
    ui.uploading = false;
    ui.lastAction = '';
    if (!reply.ok) { toast('The pedal refused ' + meta.name + (reply.message ? ': ' + reply.message : '.')); render(); return false; }
    toast(meta.name + ' is now in the pedal\u2019s library.');
    state.library.loaded = false;
    await ensureLibrary();
    render();
    const load = await modal({
      title: 'Load ' + meta.name + ' into a slot now?',
      body: 'You can also do it later from \u201cLoad from library\u2026\u201d in the Capture inspector.',
      buttons: [{ id: 'later', label: 'Later' }, { id: 'ok', label: 'Choose a slot', primary: true }],
    });
    if (load === 'ok') {
      const item = state.library.user.find(x => x.index === reply.index) || state.library.user.find(x => sameName(x.name, meta.name));
      await loadFromLibrary('capture', { kind: 'user', index: item ? item.index : reply.index, name: meta.name });
    } else render();
    return true;
  }
  window.__uploadCapture = receiveCapture;
  if (window.nanoCloud && window.nanoCloud.onCapture) window.nanoCloud.onCapture(receiveCapture);

  async function receiveCloudIR(bundle) {
    const transferId = String(bundle && bundle.transferId || '');
    const meta = bundle && bundle.meta || {};
    const name = String(meta.name || 'Cloud impulse response');
    let outcome = { ok: false, name };
    try {
      if (!state.connected) {
        const error = 'Connect your Nano Cortex first, then send ' + name + ' again.';
        toast(error);
        outcome.error = error;
        return outcome;
      }
      if (ui.uploading || NanoTransfer.busy) {
        const error = 'Another transfer to the pedal is still running. Try again when it has finished.';
        toast(error);
        outcome.error = error;
        return outcome;
      }
      if (ui.previewBusy || ui.previewing || irAudition.busy || irAudition.active) {
        const error = 'Stop the active preview before sending a Cloud IR.';
        toast(error);
        outcome.error = error;
        return outcome;
      }
      if (!await ensureLibrary()) {
        const error = 'Could not read the Nano Cortex IR library. Refresh it and try again.';
        toast(error);
        outcome.error = error;
        return outcome;
      }
      const existingIR = [...(state.library.irUser || []), ...(state.library.irFactory || [])]
        .find(item => sameName(item.name, name));
      if (existingIR) {
        toast(existingIR.name + ' is already in IRs on pedal.');
        outcome = { ok: true, alreadyOnNano: true, name: existingIR.name, index: existingIR.index, refreshed: true };
        return outcome;
      }
      if (typeof bundle.wav !== 'string' || !bundle.wav) throw new Error('The Cloud IR download has no WAV data.');
      // The shell already checked the WAV (src/cloud-ir.js); these guard the bridge.
      if (bundle.wav.length > 1400000) throw new Error('The IR is larger than 1 MB.');
      const wav = Uint8Array.from(atob(bundle.wav), c => c.charCodeAt(0));
      if (wav.length < 44 || String.fromCharCode(...wav.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...wav.slice(8, 12)) !== 'WAVE') {
        throw new Error('The Cloud IR download is not a WAV file.');
      }
      if (!meta.productId || !meta.filename || !/\.wav$/i.test(meta.filename)) throw new Error('The Cloud IR download is missing its product ID or WAV filename.');

      // No transfer timeout in the shell while the user decides.
      const irStatus = (phase) => { if (transferId && window.nanoCloud && window.nanoCloud.impulseResponseStatus) window.nanoCloud.impulseResponseStatus(transferId, phase); };
      irStatus('confirming');
      const choice = await modal({
        title: 'Send ' + name + ' to the pedal?',
        body: (wav.length / 1024).toFixed(1) + ' KB over Bluetooth. This adds it to “IRs on pedal”; it does not change any preset slot.',
        buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'send', label: 'Send IR', primary: true }],
      });
      if (choice !== 'send') {
        render();
        outcome.cancelled = true;
        return outcome;
      }

      irStatus('sending');
      ui.uploading = true;
      ui.lastAction = 'Sending IR ' + name;
      renderStatus();
      let reply;
      try {
        reply = await NanoTransfer.downloadImpulseResponse({ wav, meta }, (i, n) => {
          ui.lastAction = 'Sending IR ' + name + ': ' + i + ' / ' + n;
          renderStatus();
        });
      } finally {
        ui.uploading = false;
        ui.lastAction = '';
        render();
      }
      if (!reply.ok) {
        const error = 'The pedal refused ' + name + (reply.message ? ': ' + reply.message : '.');
        toast(error);
        outcome.error = error;
        return outcome;
      }

      // type 16 gives the assigned user-IR index. Re-read type 77 so the
      // editor's “IRs on pedal” section immediately contains the new item.
      state.library.loaded = false;
      const refreshed = await ensureLibrary();
      render();
      const libraryItem = refreshed
        ? state.library.irUser.find(item => item.index === reply.index) || state.library.irUser.find(item => sameName(item.name, reply.name || name))
        : null;
      const pedalName = libraryItem && libraryItem.name || reply.name || name;
      if (libraryItem) {
        toast(pedalName + ' is now in IRs on pedal.');
      } else {
        toast(pedalName + ' was sent to the pedal, but its IR list did not refresh. Use Refresh to reload it.');
      }
      outcome = { ok: true, name: pedalName, index: reply.index, refreshed: !!libraryItem };
      return outcome;
    } catch (err) {
      const error = 'Cloud IR transfer failed: ' + String(err && err.message || err);
      toast(error);
      outcome.error = error;
      return outcome;
    } finally {
      if (transferId && window.nanoCloud && window.nanoCloud.completeImpulseResponse) {
        window.nanoCloud.completeImpulseResponse(transferId, outcome);
      }
    }
  }
  window.__receiveCloudIR = receiveCloudIR;
  if (window.nanoCloud && window.nanoCloud.onImpulseResponse) window.nanoCloud.onImpulseResponse(receiveCloudIR);

  // ------------------------------------------------------------------ auditions (from #14)
  // Two ways to hear something on the pedal without storing it: a Cortex Cloud capture (150 → 151, "Live Preview" in
  // the Cloud toolbar) and a library IR (158 → 159, the play button in the Cab / IR inspector). Both end with
  // 148 → 149 (pro/transfer.js stopAudition) and are kept alive with 91 every 20 s. Anything that saves or changes the
  // preset stops them first (stopAnyAudition); docs/INVESTIGATION.md §12.
  const MSG_IR_PREVIEW = 158, MSG_IR_PREVIEW_REPLY = 159;

  // The Cloud toolbar's Live Preview button mirrors this; every exit path pushes it, so the button never sticks.
  let previewToolbar = { active: false, name: '', error: '', phase: 'idle' };
  function notifyPreviewState(active, name = '', error = '', phase = null) {
    previewToolbar = { active: !!active, name: name || '', error: error || '', phase: phase || (active ? 'active' : 'idle') };
    if (shellBridge && shellBridge.previewState) shellBridge.previewState(previewToolbar);
    syncAuditionState();
  }
  // The shell holds a quit while anything is auditioned (src/quit-guard.js), so it is told at once whenever that
  // changes: from here and from render(), which every audition change calls (not from the drawing itself, which waits
  // for an animation frame and doesn't run while the Cloud tab hides this page).
  var auditionSyncReady;   // var: render() may run before the audition state below is set up
  let auditionShown = false;
  function syncAuditionState() {
    if (!auditionSyncReady) return;
    const now = auditioning();
    if (now === auditionShown) return;
    auditionShown = now;
    if (shellBridge && shellBridge.auditionState) shellBridge.auditionState(now);
  }
  window.__auditionShown = () => auditionShown;   // what the shell was last told (UX test)
  // The toolbar state from what is true now (a start or stop in flight shows as starting / stopping).
  function pushPreviewState(error = '') {
    const phase = ui.previewBusy ? (ui.previewing ? 'stopping' : 'starting') : ui.previewing ? 'active' : 'idle';
    notifyPreviewState(ui.previewing, ui.previewing || ui.previewBusy ? ui.previewName : '', error, phase);
  }
  window.__previewToolbar = () => previewToolbar;   // for the UX test
  window.__pushPreviewState = () => pushPreviewState();   // the shell asks after refusing a preview request

  let lastCabIRStateSignature = '';
  function notifyCabIRState(force = false) {
    if (!shellBridge || !shellBridge.cabIRState) return;
    const cabState = { connected: !!state.connected, on: !!(state.connected && state.cabIR.on) };
    const signature = cabState.connected + ':' + cabState.on;
    if (!force && signature === lastCabIRStateSignature) return;
    lastCabIRStateSignature = signature;
    shellBridge.cabIRState(cabState);
  }

  function captureBytes(bundle) {
    return typeof bundle.cns === 'string'
      ? Uint8Array.from(atob(bundle.cns), c => c.charCodeAt(0))
      : Uint8Array.from(bundle.cns || []);
  }

  const irAudition = { active: null, pending: null, busy: false, stopping: false };
  let cabMicPositionWritePromise = Promise.resolve(true);
  function irAuditioning() {
    return Boolean(irAudition.busy || irAudition.pending || irAudition.active);
  }
  const auditioning = () => Boolean(ui.previewing || ui.previewBusy || irAuditioning());
  auditionSyncReady = true;

  // While anything is auditioned the pedal wants type 91 about every 20 s (it answers 92); without it the audition
  // ends after about a minute. One timer for both kinds; it runs until the last audition is confirmed stopped.
  const PREVIEW_KEEP_ALIVE_MS = 20000;
  const PREVIEW_KEEP_ALIVE_TYPE = 91;
  let previewKeepAliveTimer = null;
  let previewKeepAliveInFlight = false;

  function stopPreviewKeepAlive() {
    if (previewKeepAliveTimer !== null) {
      clearInterval(previewKeepAliveTimer);
      previewKeepAliveTimer = null;
      log('Live preview keep-alive stopped.');
    }
    previewKeepAliveInFlight = false;
  }

  async function sendPreviewKeepAlive() {
    if ((!ui.previewing && !irAudition.active) || !state.connected || previewKeepAliveInFlight) return;
    previewKeepAliveInFlight = true;
    try {
      const ok = await writeC304('Preview keep-alive', buildFrame([0x08, 0x03], PREVIEW_KEEP_ALIVE_TYPE));
      if (!ok && (ui.previewing || irAudition.active)) log('ERROR: Preview keep-alive write failed.');
    } finally {
      previewKeepAliveInFlight = false;
    }
  }

  function startPreviewKeepAlive() {
    if (previewKeepAliveTimer !== null) return;
    log('Live preview keep-alive started (every ' + (PREVIEW_KEEP_ALIVE_MS / 1000) + ' s).');
    previewKeepAliveTimer = setInterval(() => { void sendPreviewKeepAlive(); }, PREVIEW_KEEP_ALIVE_MS);
  }
  const stopKeepAliveIfIdle = () => { if (!ui.previewing && !irAudition.active) stopPreviewKeepAlive(); };

  // 158: factory cabs and user IRs use different record fields (3 and 4); field 8 = 1 in every observed Play.
  function irPreviewRequest(item) {
    const nameBytes = Array.from(new TextEncoder().encode(item.name));
    const record = [0x08, ...encodeVarint(item.index), 0x12, ...encodeVarint(nameBytes.length), ...nameBytes];
    const recordField = item.kind === 'irFactory' ? 0x1A : 0x22;
    return buildFrame([recordField, ...encodeVarint(record.length), ...record, 0x40, 0x01], MSG_IR_PREVIEW);
  }
  window.__irPreviewRequest = irPreviewRequest;

  async function startIRPreview(item) {
    if (!state.connected || !state.library.loaded) return false;
    if (irAudition.busy || ui.previewBusy || ui.uploading || NanoTransfer.busy) return false;
    if (!item || !Number.isInteger(item.index) || !item.name) return false;
    if (ui.previewing && !(await stopCapturePreview({ quiet: true }))) { toast('The live preview could not be stopped, so ' + item.name + ' was not previewed.'); return false; }

    irAudition.busy = true;
    irAudition.pending = item;
    irAudition.stopping = false;
    render();
    try {
      // Finish a mic/position write queued before the audition so it cannot reach the pedal after the Play.
      await cabMicPositionWritePromise;
      const reply = await writeAndAwait('Preview IR "' + item.name + '"', irPreviewRequest(item), MSG_IR_PREVIEW_REPLY);
      const status = fieldValue(reply, 3);
      if (!reply || status !== 1) {
        log('IR preview rejected: type 159 index=' + item.index + ' status=' + status);
        toast('The pedal did not accept the IR preview.');
        return false;
      }
      irAudition.active = { kind: item.kind, index: item.index, name: item.name };
      holdIRSlotTargetForPreview();
      startPreviewKeepAlive();
      log('IR preview accepted: type 159 index=' + item.index + ' status=' + status);
      return true;
    } catch (err) {
      log('ERROR: IR preview: ' + err.message);
      toast('IR preview failed: ' + err.message);
      return false;
    } finally {
      irAudition.busy = false;
      irAudition.pending = null;
      releaseIRSlotTargetWhenPreviewFails();
      render();
    }
  }

  // The official app reads the state after a stop; the pedal may then report the preset dirty (115).
  async function refreshAfterIRPreviewStop() {
    if (!state.connected) return;
    if (!(await NanoLive.readCurrentState(6000))) log('IR preview stopped; the current preset state could not be read.');
  }

  // true once the pedal confirmed the stop (149 with this transaction and status 1). Otherwise nothing changes: the
  // IR may still be playing, so it stays marked active and the keep-alive keeps running.
  async function stopIRPreview({ quiet = false, reread = true } = {}) {
    if (!irAudition.active) return !irAudition.busy;
    if (irAudition.busy) return false;
    if (!state.connected) return false;
    irAudition.busy = true;
    irAudition.stopping = true;
    render();
    let result = null, error = '';
    try {
      result = await NanoTransfer.stopAudition('ir');
    } catch (err) {
      error = err.message;
      log('ERROR: stopping IR preview: ' + err.message);
    } finally {
      irAudition.busy = false;
      irAudition.stopping = false;
    }
    if (!result || !result.ok) {
      if (!quiet) toast('The pedal did not confirm stopping the IR preview' + (error ? ': ' + error : '.') + ' It may still be playing.');
      render();
      return false;
    }
    irAudition.active = null;
    stopKeepAliveIfIdle();
    render();
    if (reread) await refreshAfterIRPreviewStop();
    settleIRSlotTargetAfterPreview();
    return true;
  }

  window.__previewIR = startIRPreview;
  window.__stopIRPreview = stopIRPreview;

  // The official Cloud app's Play button sends the capture to a temporary audition cache. It is intentionally not
  // the library upload above: no user-capture record or slot is created or changed.
  async function receivePreview(bundle) {
    const meta = (bundle && bundle.meta) || {};
    const name = meta.name || 'capture';
    const refuse = (error) => { if (error) toast(error); pushPreviewState(error); render(); return false; };
    if (!state.connected) return refuse('Connect your Nano Cortex first, then preview ' + name + '.');
    if (ui.uploading || NanoTransfer.busy) return refuse('Another transfer to the pedal is still running. Try again when it has finished.');
    if (ui.previewBusy || irAudition.busy) return refuse('Wait for the current preview to start or stop, then try again.');
    if (irAudition.active && !(await stopIRPreview({ quiet: true }))) return refuse('The IR preview could not be stopped, so ' + name + ' was not previewed.');
    if (ui.previewing && !(await stopCapturePreview({ quiet: true }))) return refuse('The current live preview could not be stopped, so ' + name + ' was not previewed.');
    let cns;
    try { cns = captureBytes(bundle); } catch { return refuse('The capture download is unreadable.'); }

    ui.previewBusy = true;
    ui.previewName = name;
    ui.lastAction = 'Preparing live preview: ' + name;
    pushPreviewState();
    renderStatus();
    let reply = null, error = '';
    try {
      reply = await NanoTransfer.previewCapture({ cns, meta }, (i, n) => {
        ui.lastAction = 'Previewing ' + name + ': sending ' + i + ' / ' + n;
        renderStatus();
      });
    } catch (err) {
      error = 'Live preview failed: ' + err.message;
    }
    ui.previewBusy = false;
    ui.lastAction = '';
    if (!reply || !reply.ok || !state.connected) {
      ui.previewName = '';
      return refuse(error || (state.connected ? 'The pedal refused the live preview' + (reply && reply.message ? ': ' + reply.message : '.') : ''));
    }
    ui.previewing = true;
    ui.previewName = name;
    startPreviewKeepAlive();
    pushPreviewState();
    toast('Previewing ' + name + '. Click Stop Preview to end it.');
    render();
    return true;
  }

  // After a confirmed stop the state is read again, as the official app does (and as after an IR audition): while the
  // pedal plays a preview its state reports the previewed capture, so without a read the editor kept showing that
  // capture's name after the stop (seen in the native edition on the pedal, 2026-10-24); the read shows the preset's own.
  async function refreshAfterCapturePreviewStop() {
    if (!state.connected) return;
    if (!(await NanoLive.readCurrentState(6000))) log('Live preview stopped; the current preset state could not be read.');
  }

  // true once the pedal confirmed the stop. Otherwise the preview stays marked active (it may still be playing),
  // the keep-alive keeps running, and the toolbar shows Stop Preview again. reread: false skips the state read
  // (quitting).
  async function stopCapturePreview({ quiet = false, reread = true } = {}) {
    if (!ui.previewing) { if (!ui.previewBusy) pushPreviewState(); return !ui.previewBusy; }
    if (ui.previewBusy) return false;
    if (!state.connected) return false;
    ui.previewBusy = true;
    ui.lastAction = 'Stopping live preview';
    pushPreviewState();
    renderStatus();
    let result = null, error = '';
    try {
      result = await NanoTransfer.stopAudition('capture');
    } catch (err) {
      error = err.message;
    }
    ui.previewBusy = false;
    ui.lastAction = '';
    if (!result || !result.ok) {
      const message = 'The pedal did not confirm stopping the live preview' + (error ? ': ' + error : '.') + ' It may still be playing.';
      if (!quiet) toast(message);
      pushPreviewState(quiet ? '' : message);
      render();
      return false;
    }
    ui.previewing = false;
    ui.previewName = '';
    stopKeepAliveIfIdle();
    pushPreviewState();
    if (!quiet) toast('Live preview stopped.');
    render();
    if (reread) await refreshAfterCapturePreviewStop();
    return true;
  }

  // Every action that saves or changes the preset (Save, Save as, switching, Discard, Rename, Delete, footswitch
  // assignment, the slot scan, reordering, deleting an IR) first ends any audition and waits for the pedal's 149.
  // If the stop isn't confirmed the action is refused: the pedal may still be playing the audition.
  async function stopAnyAudition(action) {
    if (!auditioning()) return true;
    if (ui.previewBusy || irAudition.busy) { toast('A preview is starting or stopping. Try ' + action + ' again in a moment.'); return false; }
    const ok = (!ui.previewing || await stopCapturePreview({ quiet: true })) && (!irAudition.active || await stopIRPreview({ quiet: true }));
    if (!ok) toast('The pedal did not confirm stopping the preview, so ' + action + ' did not happen. Stop the preview and try again.');
    return ok;
  }
  window.__stopAnyAudition = stopAnyAudition;
  window.__auditioning = auditioning;

  // Quitting during an audition (src/quit-guard.js): the shell holds the quit and runs this, which ends whatever is
  // auditioned (148) and waits for the pedal's 149. The shell waits at most 1.5 s and quits either way. A start or
  // stop already on its way finishes first; no state read afterwards.
  async function stopAuditionsForQuit() {
    if (!auditioning()) return { active: false, ok: true };
    if (!state.connected) return { active: true, ok: false };
    if (ui.previewBusy || irAudition.busy) await waitUntil(() => !ui.previewBusy && !irAudition.busy, 1400);
    const capture = !ui.previewing || await stopCapturePreview({ quiet: true, reread: false });
    const ir = !irAudition.active || await stopIRPreview({ quiet: true, reread: false });
    return { active: true, ok: capture && ir && !auditioning() };
  }
  window.__stopAuditionsForQuit = stopAuditionsForQuit;

  // The pedal switched presets itself (footswitch) during an audition: end it anyway (the stop is sent, best effort)
  // and forget it, so the keep-alive stops and the toolbar and inspector don't show an audition of the old preset.
  function endAuditionsAfterPedalPresetChange() {
    if (!auditioning()) return;
    log('The pedal changed presets during a preview; ending the preview.');
    for (const [kind, active] of [['capture', ui.previewing], ['ir', !!irAudition.active]]) {
      if (active) NanoTransfer.stopAudition(kind).catch(err => log('Preview stop after a preset change: ' + err.message));
    }
    ui.previewing = false; ui.previewName = '';
    irAudition.active = null;
    stopPreviewKeepAlive();
    if (ui.pendingIRSlotTarget) clearPendingIRSlotTarget();
    pushPreviewState();
    toast('The pedal switched presets, so the preview ended.');
    render();
  }

  window.__previewCapture = receivePreview;
  window.__stopCapturePreview = stopCapturePreview;
  if (window.nanoCloud && window.nanoCloud.onPreview) window.nanoCloud.onPreview(receivePreview);

  window.__getCabIRState = () => ({ connected: !!state.connected, on: !!(state.connected && state.cabIR.on) });
  window.__toggleCabIR = async function () {
    if (!state.connected) {
      const error = 'Connect your Nano Cortex before toggling Cab / IR.';
      toast(error); notifyCabIRState(true); return { ok: false, error };
    }
    const on = !Boolean(state.cabIR.on);
    await selectCabIRSlot(on ? (state.cabIR.lastActiveSlot || 1) : 0);
    render();
    return { ok: true, on: Boolean(state.cabIR.on) };
  };

  // Replies an action waits for (delete ack type 51, footswitch assignment ack type 30): writeAndAwait() sends a
  // frame and resolves with the reply's protobuf fields, or null if the write failed or nothing came within 10 s.
  // While a waiter is registered its reply type is consumed here instead of reaching the core's parsers.
  const replyWaiters = new Map(); // message type -> resolve(fields | null)
  function writeAndAwait(label, frame, replyType, ms = 10000) {
    return new Promise((resolve) => {
      const done = (f) => { clearTimeout(timer); if (replyWaiters.get(replyType) === done) replyWaiters.delete(replyType); resolve(f); };
      const timer = setTimeout(() => done(null), ms);
      replyWaiters.set(replyType, done);
      writeC304(label, frame).then((sent) => { if (!sent) done(null); });
    });
  }
  const fieldValue = (f, n) => (f && f[n] && f[n][0] ? f[n][0].value : 0);
  const coreOnC305ForReplies = window.onC305;
  window.onC305 = function (event, ...rest) {
    try {
      const v = event && event.target && event.target.value;
      const d = v && v.buffer ? new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength || v.buffer.byteLength) : null;
      if (d && presetMoveProtocolPending && frameType(d) === MSG.PresetDirtyStateChanged) {
        log('Ignoring transient preset-dirty notification during preset reorder.');
        return;
      }
      if (d && d.length >= 6 && (d[1] & 0xC0) === 0xC0 && replyWaiters.size) {
        const type = d[d.length - 4] | (d[d.length - 3] << 8) | (d[d.length - 2] << 16) | (d[d.length - 1] << 24);
        const waiter = replyWaiters.get(type);
        if (waiter) { waiter(parseProtoFields(d.slice(2, d.length - 4))); return; }
      }
    } catch { /* fall through to the core */ }
    return coreOnC305ForReplies.apply(this, [event, ...rest]);
  };

  // ------------------------------------------------------------------ session recording
  // Every packet in both directions, with timestamps and the log lines around
  // them, saved as JSON. These recordings are the ground truth for the protocol.
  const rec = { on: false, started: 0, events: [], lines: [] };
  function recordEvent(dir, bytes, label) {
    if (!rec.on) return;
    const e = { t: Date.now() - rec.started, dir, hex: hex(bytes) };
    if (label) e.label = label;
    rec.events.push(e);
  }
  // Wrap the write characteristic once per connection so TX bytes are seen here.
  function tapC304() {
    const c = state.c304;
    if (!c || c.__tapped) return;
    const real = (c.writeValueWithResponse || c.writeValue).bind(c);
    state.c304 = { __tapped: true, writeValueWithResponse: (p) => {
      recordEvent('tx', p, ui.lastTxLabel);
      return Promise.resolve().then(() => real(p)).catch((err) => { writeFailed(err); throw err; });
    } };
  }
  // RX: wrap the core's notification handler (connectNano looks it up by name on connect).
  const coreOnC305 = window.onC305;
  window.onC305 = function (event) {
    if (rec.on) recordEvent('rx', new Uint8Array(event.target.value.buffer.slice(0)));
    return coreOnC305.call(this, event);
  };
  // toFolder: save straight into the recordings folder without asking (Developer tools turned off mid-recording).
  function toggleRecording(toFolder) {
    if (!rec.on && !devTools) return;   // Record is a developer tool
    if (!rec.on) {
      Object.assign(rec, { on: true, started: Date.now(), events: [], lines: [] });
      toast('Recording every packet. Click Record again to save the file.');
    } else {
      rec.on = false;
      const name = 'nano-session-' + new Date(rec.started).toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
      const data = {
        app: 'nano-cortex-editor', recorded: new Date(rec.started).toISOString(), demo: ui.demo,
        device: (state.device && state.device.name) || null, preset: state.selectedPreset,
        events: rec.events, log: rec.lines,
      };
      const json = JSON.stringify(data, null, 1);
      if (toFolder === true && shellBridge && shellBridge.saveRecording) shellBridge.saveRecording(name, json).catch(() => {});
      else {
        const a = el('a', { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: name });
        document.body.append(a); a.click(); a.remove();
      }
      toast('Saving ' + rec.events.length + ' packets as ' + name);
    }
    renderStatus();
  }
  $('recBtn').addEventListener('click', () => toggleRecording());
  window.__rec = rec;

  // ------------------------------------------------------------------ core hooks
  window.log = function (message) {
    const text = String(message);
    const cls = text.startsWith('TX ') ? 'tx' : /^ERROR|failed/i.test(text) ? 'er' : /^RX|C305|CURRENT STATE|FE /.test(text) ? 'rx' : '';
    ui.logs.push({ ts: new Date().toLocaleTimeString(), text, cls, seq: ++ui.logSeq });
    if (ui.logs.length > 1000) ui.logs.splice(0, ui.logs.length - 1000);
    if (cls === 'tx') {
      const label = text.slice(3).split(':')[0];
      if (!ui.scanning) ui.lastAction = 'Sent: ' + label;
      ui.lastTxLabel = label;
    }
    if (rec.on) rec.lines.push({ t: Date.now() - rec.started, text });
    bleTrack(text);
    if (/^Connect failed:/.test(text) && !ble.restart) { ui.connectError = friendlyConnectError(text.replace(/^Connect failed:\s*/, '')); ui.connectHelp = /show(ed)? up|Bluetooth is off/.test(ui.connectError); }
    if (ui.drawerOpen) renderLog();
    renderStatusSoon();
    console.log(text);
  };

  window.setStatus = function (text, connected = false) {
    ui.connText = text;
    if (connected) {
      tapC304();
      if (!ui.demo) bleResult('ok');   // C304/C305 found: the shell remembers this device
      ui.cabIRLoadPaused = false;
      ui.cabIRLoadTimedOut = null;
      const d = window.__dev;
      if (d && !d.settingsRequestedForConnection) {
        // Read the global mute state as soon as the pedal is available so the
        // header control is usable without first opening Settings → Device.
        d.settingsRequestedForConnection = true;
        requestDeviceSettings();
      }
    }
    if (!connected && /disconnect/i.test(text)) {
      releaseLink();
      ui.cabIRLoadPaused = false;
      ui.cabIRLoadTimedOut = null;
      ui.cabIRLoadQueue.length = 0;
      ui.cabIRLoadActive = null;
      ui.slotPreselect = 0;
      ui.captureSlotPreselect = 0;
      state.pendingCabAssignment = null;
      state.presetDirty = false; beginExpressionBoundary();
      NanoLive.reset();
      ui.presetUnknown = false;
      const d = window.__dev;
      if (d) {
        d.info = null; d.alive = null; d.settings = null; d.reading = false;
        d.settingsRequestedForConnection = false;
        d.monitorPending = {}; d.monitorAcks.length = 0;
        clearTimeout(d.monitorReadTimer); d.monitorReadTimer = null;
      }
      const capturePreviewWasActive = ui.previewing || ui.previewBusy;
      const irPreviewWasActive = Boolean(irAudition.active) || irAudition.busy;
      stopPreviewKeepAlive();
      ui.previewing = false;
      ui.previewBusy = false;
      ui.previewName = '';
      irAudition.active = null;
      irAudition.pending = null;
      irAudition.busy = false;
      irAudition.stopping = false;
      if (capturePreviewWasActive) notifyPreviewState(false, '', 'The Nano Cortex disconnected; live preview stopped.');
      if (irPreviewWasActive) log('IR preview ended because the Nano Cortex disconnected.');
      ui.lastAction = ''; state.presetTempo = null;
    }
    if (!connected) { state.exp.loaded = false; state.exp.preset = null; }
    render();
  };

  window.setCaptureVolumeUI = function (db) {
    state.captureVolumeDb = Number(db);
    render();
  };

  window.renderPresetSelect = () => render();
  window.renderExpPanel = () => render();
  window.setExpStatus = (text) => { state.exp.status = text; render(); };
  window.renderCaptureIR = () => render();
  window.renderCaptureIRExtraParams = () => render();
  window.render = render;
  window.toast = (text) => toast(text);
  window.askText = async (message, defaultValue = '') => {
    const input = el('input', { class: 'search', type: 'text', value: defaultValue, 'aria-label': message, spellcheck: 'false' });
    const choice = await modal({ title: message, content: input, focus: input, buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'OK', primary: true }] });
    return choice === 'ok' ? input.value : null;
  };
  window.askConfirm = async (title, text, options = {}) =>
    (await modal({ title, body: text, buttons: [{ id: 'cancel', label: options.cancel || 'Cancel' }, { id: 'ok', label: options.ok || 'OK', primary: true }] })) === 'ok';
  window.showNotice = async (title, text) => { await modal({ title, body: text, buttons: [{ id: 'ok', label: 'OK', primary: true }] }); return true; };
  window.showSaveResult = function (text, kind, detail) {
    if (kind === 'ok') {
      if (ui.demo) demo.store(state.selectedPreset);
      toast('Saved to preset ' + state.selectedPreset + ', ' + presetName(state.selectedPreset));
    } else if (kind === 'error') {
      toast(detail || text);
    } else if (/saving/i.test(text)) {
      ui.clearOverridesOnRead = true;
      ui.lastAction = 'Saving preset ' + state.selectedPreset + '…';
    }
    render();
  };
  window.renderTunerReading = function (reading) {
    $('tunerNote').textContent = reading ? reading.note : '–';
    const cents = reading && reading.valid ? clamp(reading.deviation, -50, 50) : 0;
    const needle = $('tunerNeedle');
    needle.style.left = (50 + cents) + '%';
    needle.style.opacity = reading && reading.valid ? '1' : '0.25';
    $('tunerCents').textContent = reading && reading.valid ? (cents > 0 ? '+' : '') + cents.toFixed(1) + ' ct' : '';
    const box = $('tunerOverlay');
    box.classList.toggle('in-tune', Boolean(reading && reading.valid && (reading.centered || Math.abs(cents) <= 2)));
    box.classList.toggle('flat', Boolean(reading && reading.valid && cents < -2));
    box.classList.toggle('sharp', Boolean(reading && reading.valid && cents > 2));
    renderTuner();
  };
  // Protocol fix, not yet upstream (verified on the pedal 2026-10-08): the cab
  // mic/position write must carry the cab's index in the pedal's factory IR
  // library (field 1 of the record). Upstream sends 0 and the pedal ignores the
  // write. The index comes from the pedal's own cab settings reply, or from the
  // library list when that has been read.
  const coreCabRefresh = window.handleCabIRParamRefreshResponse;
  window.handleCabIRParamRefreshResponse = function (data) {
    try {
      const f = parseProtoFields(data.slice(2, data.length - 4));
      const rec = f[5] && f[5][0] && f[5][0].raw;
      if (rec) { const r = parseProtoFields(rec); if (r[1] && r[1][0]) state.cabIR.libraryIndex = r[1][0].value; }
    } catch { /* the index is only needed for mic/position writes */ }
    return coreCabRefresh.call(this, data);
  };
  window.setCabIRMicPosition = async function (mic, position) {
    if (irAuditioning()) {
      log('Cab mic/position ignored: stop the IR preview first.');
      return false;
    }
    if (!selectedIRIsFactory()) { log('Cab mic/position ignored: current IR is not a factory cab slot.'); return false; }
    const selectedSlot = activeIRSlot();
    const cabName = String((selectedSlot && state.irNames.get(selectedSlot)) || state.currentIR.shortName || '').trim();
    const micName = String(mic || state.cabIR.mic || '').trim();
    const factoryIR = (state.library.irFactory || []).find(x => sameName(x.name, cabName));
    let index = factoryIR ? factoryIR.index : state.cabIR.libraryIndex;
    if (!Number.isInteger(index)) index = null;
    if (!cabName || !micName || !Number.isInteger(index)) { log('Cab mic/position ignored: the cab\'s library index is unknown (read the cab first).'); return false; }
    const pos = clamp(Math.round(Number(position || state.cabIR.position || 1)), 1, 6);
    state.cabIR.mic = micName;
    state.cabIR.position = pos;
    const cab = new TextEncoder().encode(cabName), m = new TextEncoder().encode(micName);
    const inner = [0x08, ...encodeVarint(index), 0x12, cab.length, ...cab, 0x18, pos - 1, 0x22, m.length, ...m];
    const writePromise = writeC304('Cab mic/position ' + micName + ' pos ' + pos, new Uint8Array([inner.length + 6, 0xC0, 0x1A, inner.length, ...inner, 0x5E, 0, 0, 0]));
    cabMicPositionWritePromise = writePromise;
    const written = await writePromise;
    render();
    return written;
  };

  // Gate reduction read-back (verified on the pedal 2026-10-08): the state dump's
  // field 53 is a float32 holding (percent + 108) / 255. Upstream doesn't read it.
  //
  // Library-referenced capture/cab (hardware, 2026-10-08): field 11 (capture position) or field 12 (cab slot)
  // reads 6, one past the range, when the preset plays the item straight from the library. Upstream turns that
  // into capture slot 26 and asks for cab settings of a slot that doesn't exist. The flags are set before the
  // core parse because the core requests the cab settings at its end.
  function expressionRangeFor(key) {
    return state.exp.loaded && state.exp.preset === state.selectedPreset
      ? EXP_RANGES.find(target => target.key === key && state.exp.ranges[key] && state.exp.ranges[key].on) : null;
  }
  function noteExpressionLocalOverride(key, kind, value) {
    if (!state.exp.loaded || state.exp.preset !== state.selectedPreset) return;
    if (kind === 'bypass') {
      if (EXP_BYPASS.some(target => target.key === key && state.exp.bypass[key] && state.exp.bypass[key].on)) {
        ui.expressionLocalOverrides.set('bypass:' + key, { kind, key, value: Boolean(value) });
      }
      return;
    }
    const target = expressionRangeFor(key);
    if (!target) return;
    if (target.block) {
      const param = NanoLive.expressionAmountParam(state.blocks[target.block]);
      if (param && kind === 'param' && value && value.index === param.index) {
        ui.expressionLocalOverrides.set('range:' + key, { kind, key, value: param.value });
      }
    } else if (kind === 'range') {
      ui.expressionLocalOverrides.set('range:' + key, { kind, key, value });
    }
  }
  function restoreExpressionLocalOverrides() {
    let changed = false;
    for (const entry of ui.expressionLocalOverrides.values()) {
      if (entry.kind === 'bypass') {
        const targetDef = EXP_BYPASS.find(target => target.key === entry.key);
        const target = targetDef && NanoLive.expressionTargetState(targetDef);
        if (target && target.get() !== entry.value) { target.set(entry.value); changed = true; }
      } else if (entry.key === 'level') {
        if (state.captureVolumeDb !== entry.value) { state.captureVolumeDb = entry.value; changed = true; }
      } else if (['gain', 'bass', 'mid', 'treble'].includes(entry.key)) {
        if (state.amp[entry.key] !== entry.value) { state.amp[entry.key] = entry.value; changed = true; }
      } else if (entry.key === 'gate' && state.gate.params[0] && state.gate.params[0].value !== entry.value) {
        state.gate.params[0].value = entry.value; changed = true;
      } else if (state.blocks[entry.key]) {
        const param = NanoLive.expressionAmountParam(state.blocks[entry.key]);
        if (param && param.value !== entry.value) { param.value = entry.value; changed = true; }
      }
    }
    return changed;
  }
  const coreApplyFXEnabledStates = window.applyFXEnabledStatesFromCurrentState;
  window.applyFXEnabledStatesFromCurrentState = function (fields) {
    const result = coreApplyFXEnabledStates.apply(this, arguments);
    if (applyPendingBypassTargets()) render();
    return result;
  };
  const coreParseState = window.parseBufferedCurrentState;
  window.parseBufferedCurrentState = function () {
    const bytes = state.stateBytes.slice();
    let src = null;
    const presetLoadBoundary = state.protocol.presetLoad;
    try {
      if (bytes.length) {
        const f = parseProtoFields(bytes);
        const v = (n) => (f[n] && f[n][0] && f[n][0].wire === 0 ? f[n][0].value : 0);
        src = { bank: Math.min(5, Math.max(1, v(9) || 1)), pos: v(11), cab: v(12) };
        state.capture.fromLibrary = src.pos > 5;
        state.cabIR.fromLibrary = src.cab > 5;
      }
    } catch { /* the core parse below logs malformed dumps */ }
    let r;
    try { r = coreParseState.apply(this, arguments); }
    catch (err) { log('ERROR: state parse failed: ' + err.message); }
    if (src && src.pos > 5) {
      Object.assign(state.capture, { selectedSlot: null, lastActiveSlot: null, activeSlot: null });
      log('Capture comes straight from the library: ' + (state.currentCapture.name || 'unknown') + ' (position ' + src.pos + ')');
    } else if (src && src.pos > 0) {
      // The absolute slot is (bank - 1) * 5 + position. Upstream matches by name only, which picks the first
      // of two slots holding the same capture, and falls back to the bare position when names aren't read yet.
      const abs = (src.bank - 1) * 5 + src.pos;
      const name = state.currentCapture.name;
      if (!captureSlotByName(name) || sameName(state.captureNames.get(abs), name)) Object.assign(state.capture, { selectedSlot: abs, lastActiveSlot: abs });
    }
    if (src && src.cab > 5) {
      state.cabIR.selectedSlot = null;
      log('Cab comes straight from the library: ' + (state.currentIR.shortName || 'unknown') + ' (slot ' + src.cab + ')');
    }
    const pendingIRTarget = ui.pendingIRSlotTarget;
    if (pendingIRTarget) {
      if (presetLoadBoundary || Number(state.selectedPreset) !== pendingIRTarget.preset) clearPendingIRSlotTarget(pendingIRTarget);
      else {
        // A read queued by an earlier click can report the previous slot. Keep
        // the newest selection optimistic until the final read-back settles.
        state.cabIR.fromLibrary = false;
        state.cabIR.on = pendingIRTarget.slot > 0;
        state.cabIR.selectedSlot = pendingIRTarget.slot;
        state.cabIR.stateSlot = pendingIRTarget.slot;
        if (pendingIRTarget.slot > 0) state.cabIR.lastActiveSlot = pendingIRTarget.slot;
        if (pendingIRTarget.currentIR) state.currentIR = { ...pendingIRTarget.currentIR };
      }
    } else if (src && src.cab >= 1 && src.cab <= 5) {
      // Field 12 is the exact slot; matching by IR name can select another slot
      // when the same IR is stored more than once.
      state.cabIR.selectedSlot = src.cab;
      state.cabIR.lastActiveSlot = src.cab;
    }
    try {
      const all = parseProtoFields(bytes);
      const fw = all[24] && all[24][0] && all[24][0].wire === 2 ? new TextDecoder().decode(Uint8Array.from(all[24][0].raw)).trim() : '';
      if (/^\d+\.\d+/.test(fw)) state.firmware = fw; // field 24: firmware version string
      const f = all[53];
      const raw = f && f[0] && f[0].wire === 5 ? f[0].raw : null;
      if (raw) {
        const v = new DataView(Uint8Array.from(raw).buffer).getFloat32(0, true);
        const pct = Math.round(v * 255) - 108;
        if (pct >= 0 && pct <= 100) { state.gate.params[0].value = pct; render(); }
      }
    } catch { /* leave the gate knob as it was */ }
    try { tempoFromDump(parseProtoFields(bytes)); } catch { /* keep the tempo shown */ }
    followExp();   // a new preset (app, footswitch) or a fresh connection: read its expression assignments
    // After a preset load or a save the dump is the new reference: local edits of expression targets are in it.
    if (bytes.length && (presetLoadBoundary || ui.clearOverridesOnRead)) {
      ui.clearOverridesOnRead = false;
      ui.expressionLocalOverrides.clear();
    }
    NanoLive.reapplyExpression();   // the dump has the stored values; the pedal's position is on top of them
    if (applyPendingBypassTargets()) render();
    return r;
  };

  const captureSlotByName = (name) => { for (const [i, n] of state.captureNames) if (name && sameName(n, name)) return i; return 0; };
  // A library-referenced cab has no slot to read settings from.
  const coreCabParamRefresh = window.requestCabIRParamRefresh;
  window.requestCabIRParamRefresh = function () {
    if (state.cabIR.fromLibrary) { log('Cab/IR param refresh skipped: the cab comes straight from the library.'); return Promise.resolve(); }
    return coreCabParamRefresh.apply(this, arguments);
  };
  // ---------------- effects the editor doesn't know (newer firmware)
  // The pedal reports only a model id per FX slot (state-dump fields 48–52); names and parameters come from
  // upstream's tables. Upstream turns an id it can't map into an empty slot ("None"). We keep the block at
  // 'None' inside the core, so nothing in core.js writes or reads its parameters, and remember the id in
  // `block.unknownId` so the UI can say what it is. Allowed on such a block: on/off and choosing a known effect.
  const FX_MODEL_FIELDS = { pre1: 48, pre2: 49, post1: 50, post2: 51, post3: 52 };
  const unknownFx = (key) => !!(state.blocks[key] && state.blocks[key].unknownId);
  const loggedUnknown = new Set();
  const coreApplyModels = window.applyFXModelsFromCurrentState;
  window.applyFXModelsFromCurrentState = function (fields) {
    const skipped = state.protocol.skipFXModelApply && !state.protocol.presetLoad;   // the core leaves the models alone
    const r = coreApplyModels.apply(this, arguments);
    if (skipped) return r;
    let fw = '';
    try { fw = fields[24] && fields[24][0] && fields[24][0].wire === 2 ? new TextDecoder().decode(Uint8Array.from(fields[24][0].raw)).trim() : ''; } catch { /* below */ }
    fw = fw || state.firmware || 'unknown';
    for (const [key, n] of Object.entries(FX_MODEL_FIELDS)) {
      const b = state.blocks[key];
      const entry = fields[n] && fields[n][0];
      const raw = entry && entry.raw ? Array.from(entry.raw) : [];
      const id = raw.map(x => x.toString(16).padStart(2, '0').toUpperCase()).join('');
      // An absent field or an all-zero id is an empty slot; a mapped id is a known effect.
      const unknown = raw.some(x => x) && !findModelByCurrentStateID(b, id) && b.model === 'None';
      if (!unknown) { delete b.unknownId; continue; }
      b.unknownId = id;
      b.params = [];
      if (!loggedUnknown.has(key + ':' + id)) { loggedUnknown.add(key + ':' + id); log('Unknown effect id 0x' + id + ' in ' + b.title + ' (firmware ' + fw + ')'); }
    }
    return r;
  };
  // Belt and braces: no parameter write or parameter read for an unknown block, whoever asks.
  const coreSetFXParam = window.setFXParam;
  window.setFXParam = function (blockKey) {
    if (unknownFx(blockKey)) { log('Not writing a parameter of ' + state.blocks[blockKey].title + ': unknown effect'); return Promise.resolve(); }
    return coreSetFXParam.apply(this, arguments);
  };
  const coreNextParamRefresh = window.requestNextFXParamRefresh;
  window.requestNextFXParamRefresh = function () {
    state.paramRefreshQueue = state.paramRefreshQueue.filter(k => !unknownFx(k));
    return coreNextParamRefresh.apply(this, arguments);
  };
  const coreSetFXModel = window.setFXModel;
  window.setFXModel = function (blockKey, modelName) {
    const b = state.blocks[blockKey];
    if (b && b.models.some(m => m.name === modelName && m.id)) delete b.unknownId;   // a known effect replaces it
    return coreSetFXModel.apply(this, arguments);
  };

  // ---------------- firmware newer than the one the editor was tested with
  // Numeric per component, suffixes ignored ("2.2.1+06d34443" is 2.2.1). null when it isn't a version.
  function parseFirmware(s) {
    const m = /^\s*v?(\d+(?:\.\d+)*)/.exec(String(s || ''));
    return m ? m[1].split('.').map(Number) : null;
  }
  // -1, 0 or 1; null when either side isn't a version.
  function compareFirmware(a, b) {
    const x = parseFirmware(a), y = parseFirmware(b);
    if (!x || !y) return null;
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }
  const firmwareIsNewer = (fw) => compareFirmware(fw, COMPAT.testedFirmware) === 1;
  window.__firmware = { parse: parseFirmware, compare: compareFirmware, isNewer: firmwareIsNewer, tested: COMPAT.testedFirmware };
  // Once per firmware version (settings.firmwareWarned), after connecting; a quiet banner, never a modal.
  function checkFirmware() {
    const fw = state.firmware;
    if (!state.connected || !fw || ui.firmwareChecked === fw) return;
    ui.firmwareChecked = fw;
    if (!firmwareIsNewer(fw)) return;
    const version = parseFirmware(fw).join('.');
    if (pref.get('firmwareWarned', '') === version) return;
    pref.set('firmwareWarned', version);
    log('Firmware ' + fw + ' is newer than ' + COMPAT.testedFirmware + ', the version this editor was tested with');
    $('fwNotice').hidden = false;
  }
  $('fwNoticeClose').addEventListener('click', () => { $('fwNotice').hidden = true; });

  // Picking a slot (or bypassing) moves the preset off a library reference.
  for (const [fn, part] of [['setCapture', 'capture'], ['selectCaptureSlot', 'capture'], ['selectCabIRSlot', 'cabIR']]) {
    const core = window[fn];
    window[fn] = function () {
      state[part].fromLibrary = false;
      if (fn !== 'selectCabIRSlot') return core.apply(this, arguments);
      const slot = Number(arguments[0]);
      if (!Number.isInteger(slot) || slot < 0 || slot > 5) return core.apply(this, arguments);
      clearPendingIRSlotTarget();
      const target = {
        slot,
        preset: Number(state.selectedPreset),
        currentIR: { ...state.currentIR },
        holdForPreviewStop: Boolean(irAudition.active || irAudition.busy || irAudition.pending),
      };
      ui.pendingIRSlotTarget = target;
      // Current-state replies are untagged; an older read can arrive after a newer click.
      if (target.holdForPreviewStop) holdIRSlotTargetForPreview();
      else target.timer = setTimeout(() => settlePendingIRSlotTarget(target), 2500);
      return core.apply(this, arguments);
    };
  }

  // Core asks which slot a library item should go into; resolves with the slot or null.
  function noteCabIRLoadSlot(slot) {
    const job = ui.cabIRLoadActive;
    if (!job || !slot) return;
    job.slot = slot;
    job.phase = 'sending';
    render();
  }

  window.chooseSlot = function (kind, itemName) {
    if (kind === 'capture' && ui.captureSlotPreselect) {
      const s = ui.captureSlotPreselect;
      ui.captureSlotPreselect = 0;
      return Promise.resolve(s);
    }
    if (ui.slotPreselect) {
      const s = ui.slotPreselect;
      ui.slotPreselect = 0;
      if (kind === 'cab') noteCabIRLoadSlot(s);
      return Promise.resolve(s);
    }   // "Put a library … in slot N…"
    const isCap = kind === 'capture';
    const count = isCap ? captureSlotCount() : irSlotCount();
    const names = isCap ? state.captureNames : state.irNames;
    let selected = (isCap ? activeCaptureSlot() : activeIRSlot()) || 1;
    const list = el('div', { class: 'slots', role: 'listbox', 'aria-label': 'Slots' });
    const draw = () => list.replaceChildren(...Array.from({ length: count }, (_, i) => i + 1).map(i => el('button', {
      class: 'slot' + (i === selected ? ' on' : ''), role: 'option', 'aria-selected': String(i === selected), dataset: { fk: 'pickslot-' + i },
      onclick: () => { selected = i; draw(); },
    }, el('span', { class: 'n', text: i }), el('span', { class: 't', text: names.get(i) || ((isCap ? 'Capture ' : 'IR ') + i) }), usageBadge(isCap ? 'capture' : 'cab', i))));
    draw();
    return modal({
      title: 'Which slot should hold ' + itemName + '?', wide: true, content: list,
      body: 'Whatever is in that slot on the pedal is replaced' + (ui.usage ? ', for every preset that uses it. Counts show how many presets use each slot (scanned ' + scanTime() + ').' : '.'),
      buttons: [{ id: 'cancel', label: 'Cancel' }, { id: 'ok', label: 'Load into slot', primary: true }],
    }).then(choice => {
      const slot = choice === 'ok' ? selected : null;
      if (kind === 'cab' && slot) noteCabIRLoadSlot(slot);
      return slot;
    });
  };

  // The core owns the protocol parsing and state updates. Observe its response to
  // advance the serialized UI queue as soon as the pedal acknowledges the write.
  const coreCabinetSlotContentResponse = window.handleCabinetSlotContentResponse;
  if (coreCabinetSlotContentResponse) {
    window.handleCabinetSlotContentResponse = function (data) {
      const pending = state.pendingCabAssignment;
      const active = ui.cabIRLoadActive;
      const matchesActive = Boolean(pending && active && pending.slot === active.slot && sameName(pending.name, active.name));
      const timedOut = !pending && ui.cabIRLoadPaused ? ui.cabIRLoadTimedOut : null;
      let accepted = false;
      try {
        const fields = parseProtoFields(Array.from(data.slice(2, data.length - 4)));
        accepted = Boolean(fields[3] && fields[3][0] && fields[3][0].value === 1);
      } catch (err) {
        log('Could not parse the library cab load response: ' + err.message);
      }

      const result = coreCabinetSlotContentResponse.apply(this, arguments);
      if (matchesActive) {
        active.responseReceived = true;
        if (accepted) {
          active.phase = 'activating';
          render();
        } else {
          void finishCabIRLoad(active, false, { acknowledged: true });
        }
      } else if (timedOut) {
        ui.cabIRLoadTimedOut = null;
        ui.cabIRLoadPaused = false;
        if (accepted) {
          state.irNames.set(timedOut.slot, timedOut.name);
          state.currentIR = { shortName: timedOut.name, fullName: timedOut.name, inBank: true, slot: timedOut.slot };
          selectCabIRSlot(timedOut.slot);
          if (ui.demo) demo.pickIR(timedOut.slot);
          toast('Cab ' + timedOut.name + ' loaded into slot ' + timedOut.slot);
        } else {
          toast('The pedal rejected the earlier IR change. You can try again.');
        }
        render();
        startNextCabIRLoad();
      }
      return result;
    };
  }

  function render() {
    syncAuditionState();
    if (ui.knobDragging) {
      ui.renderAfterKnob = true;
      return;
    }
    if (ui.renderQueued) return;
    ui.renderQueued = true;
    requestAnimationFrame(() => {
      ui.renderQueued = false;
      if (ui.knobDragging) {
        ui.renderAfterKnob = true;
        return;
      }
      renderAll();
    });
  }

  // ------------------------------------------------------------------ rendering
  function renderAll() {
    const fk = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fk : null;
    notifyCabIRState();
    renderHead();
    renderSide();
    renderFootswitches();
    renderChain();
    renderExpPill();
    if (!ui.editing && !tempoFocused()) renderInspector();
    metro.presetTempo = state.connected && Number(state.presetTempo) > 0 ? state.presetTempo : null;
    renderTempo();
    renderVeil();
    renderStatus();
    checkFirmware();
    if (fk) {
      const again = document.querySelector('[data-fk="' + CSS.escape(fk) + '"]');
      if (again && again !== document.activeElement) again.focus({ preventScroll: true });
    }
  }

  function renderHead() {
    const t = $('presetTitle');
    const unknown = state.connected && ui.presetUnknown;
    t.replaceChildren(
      el('span', { class: 'num', text: !state.connected ? '' : unknown ? 'Preset ?' : 'Preset ' + state.selectedPreset }),
      el('span', { class: 'name', text: !state.connected ? '' : unknown ? 'Not known yet' : presetName(state.selectedPreset) })
    );
    const dirty = pedalDirtyForUI() && state.connected && !unknown;
    $('dirtyMark').hidden = !dirty;

    const busy = ui.connecting || /requesting|connecting/i.test(ui.connText);

    const cb = $('connectBtn');
    cb.textContent = ui.demo ? 'Exit demo' : state.connected ? 'Disconnect' : busy ? 'Connecting…' : 'Connect';
    cb.disabled = busy && !state.connected;
    cb.className = 'btn' + (!state.connected && !busy ? ' primary' : '');

    $('saveBtn').disabled = !state.connected || unknown;
    $('saveAsBtn').disabled = !state.connected || unknown;
    $('saveBtn').className = 'btn' + (dirty ? ' primary' : '');
    $('discardBtn').hidden = !dirty;
    $('refreshBtn').disabled = !state.connected || ui.demo;
    $('renameBtn').disabled = !state.connected || unknown;
    $('tunerBtn').disabled = !state.connected;
    $('tunerBtn').classList.toggle('on', state.tuner.open);
    renderMuteButton();
  }

  function renderMuteButton() {
    const button = $('muteBtn');
    if (!button) return;
    const settings = state.connected && window.__dev && window.__dev.settings;
    const muted = Boolean(settings && settings.muteInput);
    button.disabled = !settings;
    button.classList.toggle('mute-active', muted);
    button.setAttribute('aria-pressed', String(muted));
  }

  // ------------------------------------------------------------------ preset reordering (from #14)
  // Drag a preset row onto another: 143 { 1: 4, 3: from, 4: to } (0-based; an insertion, the presets in between
  // shift by one), acked by 144 { 1: 6, 3: from, 4: to, 5: 1 }. Then the list and the current state are read back
  // from the pedal like at connect; nothing about the new order or the current preset is assumed. INVESTIGATION §12.
  const MSG_PRESET_MOVE = 143, MSG_PRESET_MOVE_REPLY = 144;
  const REORDER_TIMEOUTS = { list: 20000, state: 6000 };
  window.__reorderTimeouts = REORDER_TIMEOUTS;              // the UX test shortens them
  const canReorder = () => state.connected && !ui.presetReorderBusy && !ui.scanning;
  const presetMoveFrame = (from, to) => buildFrame([0x08, 0x04, 0x18, ...encodeVarint(from), 0x20, ...encodeVarint(to)], MSG_PRESET_MOVE);

  // Edits are dropped when the pedal moves presets around (the phone app asks first, too).
  async function askBeforePresetReorder() {
    if (!isDirtyNow()) return true;
    const current = state.selectedPreset;
    const choice = await modal({
      title: 'Save changes to ' + presetName(current) + '?',
      body: 'Reordering presets can discard edits that haven’t been saved to the pedal.',
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'discard', label: 'Don’t save' },
        { id: 'save', label: 'Save and reorder', primary: true },
      ],
    });
    if (choice === 'save') {
      await doSave();
      if (pedalDirtyForUI()) { toast('Save the current preset before reordering.'); return false; }
      return true;
    }
    if (choice !== 'discard') return false;
    const before = NanoLive.stateReads;
    state.exp.loaded = false;
    await selectPreset(current);
    if (ui.demo) demo.load(current);
    if (!(await waitUntil(() => !state.protocol.presetLoad && NanoLive.stateReads > before, 7000))) {
      toast('The pedal did not confirm reloading the saved preset.');
      return false;
    }
    return true;
  }

  // The preset list and the state again, the way a connect reads them (upstream's metadata read, then the state).
  async function rereadPresetsAfterMove() {
    const before = NanoLive.stateReads;
    state.protocol.metadataLoaded = false;
    await syncMetadataAndState();
    const listed = await waitUntil(() => !state.connected || state.protocol.metadataLoaded, REORDER_TIMEOUTS.list) && state.connected && state.protocol.metadataLoaded;
    const read = await waitUntil(() => !state.connected || (NanoLive.stateReads > before && !state.protocol.presetLoad), REORDER_TIMEOUTS.state + 1000) &&
      state.connected && NanoLive.stateReads > before;
    if (!read && state.stateMode === 'current' && !state.stateBytes.length) state.stateMode = 'idle';
    return { listed: !!listed, read: !!read };
  }

  // Without a state read after a move the editor doesn't know which preset the pedal is on (a move can shift it), so
  // Save, Save as, Discard and Rename stay off until a read succeeds (Refresh, a preset switch, reconnecting).
  const PRESET_UNKNOWN = 'The editor doesn’t know which preset the pedal is on. Refresh (or pick a preset) to read it again.';
  function presetUnknownRefuses() {
    if (!ui.presetUnknown) return false;
    toast(PRESET_UNKNOWN);
    return true;
  }

  async function movePresetOrder(source, destination) {
    if (source === destination || ui.presetReorderBusy || !state.connected) return false;
    if (ui.scanning) { toast('Wait for the slot usage scan to finish before reordering.'); return false; }
    if (state.stateMode !== 'idle' || state.protocol.presetLoad || state.presetLoadTimer || state.pendingParamBlock || state.paramRefreshQueue.length || state.fileBusy || state.saveBusy ||
        gattWriteQueue.length || gattWritePumpRunning || ui.uploading || NanoTransfer.busy) {
      toast('Wait for the current pedal operation to finish before reordering.');
      return false;
    }
    ui.presetReorderBusy = true;
    ui.sideSig = '';
    render();
    try {
      if (!(await stopAnyAudition('the reorder'))) return false;
      if (!(await askBeforePresetReorder()) || !state.connected) return false;
      presetMoveProtocolPending = true;   // the pedal reports 115 dirty, then clean, around a move: not an edit
      const reply = await writeAndAwait('Move preset ' + (source + 1) + ' to position ' + (destination + 1), presetMoveFrame(source, destination), MSG_PRESET_MOVE_REPLY);
      const ackOk = Boolean(reply) && fieldValue(reply, 5) === 1 && fieldValue(reply, 3) === source && fieldValue(reply, 4) === destination;
      log('Preset reorder ' + (ackOk ? 'acknowledged' : 'NOT confirmed') + ': type 144 ' + (reply ? 'source=' + fieldValue(reply, 3) + ' destination=' + fieldValue(reply, 4) + ' status=' + fieldValue(reply, 5) : 'no reply'));
      // Read back whatever happened, confirmed or not: the pedal's order and its current preset are the truth.
      const { listed, read } = await rereadPresetsAfterMove();
      log('Preset reorder read-back: list=' + listed + ', state=' + read);
      if (!read) { ui.presetUnknown = true; render(); }
      if (!ackOk) {
        toast('The pedal did not confirm the move. ' + (listed ? 'The list shows its order as it is now.' : 'Its order could not be read either: Refresh to see it.') + (read ? '' : ' ' + PRESET_UNKNOWN));
        return false;
      }
      if (!listed || !read) {
        toast('Preset moved, but ' + (!listed ? 'the preset list could not be read again (Refresh to see the order)' : 'the current preset could not be read again') + '. ' + (read ? '' : PRESET_UNKNOWN));
        return false;
      }
      toast('Moved preset ' + (source + 1) + ' to position ' + (destination + 1) + '.');
      return true;
    } catch (err) {
      log('ERROR: preset reorder: ' + err.message);
      toast('Preset reorder failed: ' + err.message);
      return false;
    } finally {
      presetMoveProtocolPending = false;
      ui.presetReorderBusy = false;
      ui.sideSig = '';
      render();
    }
  }
  window.__movePresetOrder = movePresetOrder;

  // Dragging a row uses pointer events, not HTML5 drag and drop: during a system drag session the OS owns the cursor
  // (the arrow on macOS), and the closed hand has to show for the whole drag. Press anywhere on a row (the ⋮⋮ grip at
  // its right end is the affordance, not the only handle), move 4 px, drop it on another row; Escape cancels. Near the
  // list's top or bottom edge, or with the wheel, the list scrolls. Only a press on a row of this list starts one, so
  // nothing dropped from elsewhere can move a preset.
  const PRESET_DRAG_THRESHOLD = 4;
  const GRIP_SVG = '<svg viewBox="0 0 6 10" width="6" height="10" fill="currentColor" aria-hidden="true"><circle cx="1" cy="1" r="1"/><circle cx="5" cy="1" r="1"/><circle cx="1" cy="5" r="1"/><circle cx="5" cy="5" r="1"/><circle cx="1" cy="9" r="1"/><circle cx="5" cy="9" r="1"/></svg>';
  let presetDrag = null;   // { from, pointerId, x0, y0, x, y, active, target, ghost, dx, dy, raf }
  window.__presetDrag = () => presetDrag && { from: presetDrag.from, active: presetDrag.active, target: presetDrag.target };
  function presetRowAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    const row = hit && hit.closest ? hit.closest('.preset-row') : null;
    return row && $('presetList').contains(row) ? Number(row.dataset.n) : 0;
  }
  function markPresetDrag() {
    const d = presetDrag && presetDrag.active ? presetDrag : null;
    for (const r of $('presetList').querySelectorAll('.preset-row')) {
      const n = Number(r.dataset.n);
      r.classList.toggle('dragging', !!d && n === d.from);
      r.classList.toggle('drop-target', !!d && n === d.target && n !== d.from);
    }
  }
  function onPresetPointerDown(e) {
    if (e.button !== 0 || e.ctrlKey) return;   // Control-click is the context menu on a Mac
    const row = e.target && e.target.closest ? e.target.closest('.preset-row') : null;
    if (!row || !$('presetList').contains(row) || !canReorder()) return;
    endPresetDrag();
    presetDrag = { from: Number(row.dataset.n), pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, active: false, target: 0, ghost: null, dx: 0, dy: 0, raf: 0 };
    document.addEventListener('pointermove', onPresetPointerMove, true);
    document.addEventListener('pointerup', onPresetPointerUp, true);
    document.addEventListener('pointercancel', onPresetPointerCancel, true);
    document.addEventListener('keydown', onPresetDragKey, true);
    $('presetList').addEventListener('scroll', onPresetDragScroll);
    window.addEventListener('blur', onPresetPointerCancel);
  }
  function beginPresetDrag(d) {
    d.active = true;
    document.documentElement.classList.add('preset-dragging');
    // A copy of the row follows the pointer, held where it was grabbed (what the system drag image did).
    const row = $('presetList').querySelector('.preset-row[data-n="' + d.from + '"]');
    if (row) {
      const r = row.getBoundingClientRect();
      d.dx = d.x0 - r.left; d.dy = d.y0 - r.top;
      const copy = row.cloneNode(true);
      copy.removeAttribute('data-n'); copy.removeAttribute('role'); copy.removeAttribute('aria-selected');
      copy.classList.remove('dragging', 'drop-target');
      d.ghost = el('div', { class: 'preset-ghost', 'aria-hidden': 'true', style: 'width:' + r.width + 'px' }, copy);
      document.body.append(d.ghost);
    }
  }
  function onPresetPointerMove(e) {
    const d = presetDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.active) {
      if (Math.hypot(d.x - d.x0, d.y - d.y0) < PRESET_DRAG_THRESHOLD) return;
      if (!canReorder()) { endPresetDrag(); return; }
      beginPresetDrag(d);
    }
    e.preventDefault();
    if (d.ghost) { d.ghost.style.left = (d.x - d.dx) + 'px'; d.ghost.style.top = (d.y - d.dy) + 'px'; }
    d.target = presetRowAt(d.x, d.y);
    markPresetDrag();
    if (!d.raf) d.raf = requestAnimationFrame(presetAutoScroll);
  }
  function presetAutoScroll() {
    const d = presetDrag;
    if (!d || !d.active) return;
    d.raf = 0;
    const list = $('presetList'), r = list.getBoundingClientRect(), EDGE = 28;
    if (d.x < r.left || d.x > r.right || d.y < r.top - EDGE || d.y > r.bottom + EDGE) return;
    const v = d.y < r.top + EDGE ? -Math.min(16, Math.ceil((r.top + EDGE - d.y) / 2)) : d.y > r.bottom - EDGE ? Math.min(16, Math.ceil((d.y - r.bottom + EDGE) / 2)) : 0;
    if (!v) return;
    const before = list.scrollTop;
    list.scrollTop += v;
    if (list.scrollTop !== before) d.raf = requestAnimationFrame(presetAutoScroll);   // the scroll event updates the target
  }
  function onPresetDragScroll() {
    const d = presetDrag;
    if (!d || !d.active) return;
    d.target = presetRowAt(d.x, d.y);
    markPresetDrag();
  }
  function onPresetPointerUp(e) {
    const d = presetDrag;
    if (!d || e.pointerId !== d.pointerId) return;
    const dropped = d.active ? presetRowAt(e.clientX, e.clientY) : 0;
    const wasDrag = d.active;
    endPresetDrag();
    if (!wasDrag) return;   // a plain click: the row's click handler loads the preset
    e.preventDefault();
    if (!dropped || dropped === d.from || !canReorder()) return;
    void movePresetOrder(d.from - 1, dropped - 1);
  }
  function onPresetPointerCancel() { endPresetDrag(); }
  function onPresetDragKey(e) {
    if (e.key !== 'Escape' || !presetDrag || !presetDrag.active) return;
    e.preventDefault(); e.stopPropagation();
    endPresetDrag();
  }
  function endPresetDrag() {
    const d = presetDrag;
    presetDrag = null;
    document.removeEventListener('pointermove', onPresetPointerMove, true);
    document.removeEventListener('pointerup', onPresetPointerUp, true);
    document.removeEventListener('pointercancel', onPresetPointerCancel, true);
    document.removeEventListener('keydown', onPresetDragKey, true);
    $('presetList').removeEventListener('scroll', onPresetDragScroll);
    window.removeEventListener('blur', onPresetPointerCancel);
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.ghost) d.ghost.remove();
    document.documentElement.classList.remove('preset-dragging');
    if (d.active) suppressPresetClickUntil = Date.now() + 350;   // the click that follows the release loads nothing
    markPresetDrag();
  }

  function renderSide() {
    const q = ui.filter.trim().toLowerCase();
    const names = [];
    for (let i = 1; i <= 64; i++) names.push(presetName(i));
    const sig = [state.connected, state.selectedPreset, ui.presetUnknown, q, canReorder(), names.join('|')].join('#');
    if (sig === ui.sideSig) return;
    ui.sideSig = sig;

    const list = $('presetList');
    list.setAttribute('aria-busy', String(ui.presetReorderBusy));
    $('presetFilter').disabled = !state.connected;
    if (!state.connected) {
      list.replaceChildren(el('div', { class: 'side-empty', text: 'Your presets appear here once the pedal is connected.' }));
      return;
    }
    const rows = [];
    for (let i = 1; i <= 64; i++) {
      const name = presetName(i);
      if (q && !name.toLowerCase().includes(q) && String(i) !== q) continue;
      const empty = /^empty$/i.test(name);
      const grip = el('span', { class: 'grip', title: 'Drag to move this preset', 'aria-hidden': 'true' });
      grip.innerHTML = GRIP_SVG;
      rows.push(el('div', {
        // Drag a row (anywhere on it) onto another to move it there: onPresetPointerDown above. `reorderable` shows
        // the ⋮⋮ grip on the row under the mouse; rows aren't reorderable while a move or the slot scan runs.
        oncontextmenu: (e) => contextMenu(e, [
          { label: i === state.selectedPreset ? 'Current preset' : 'Load', disabled: !state.connected || i === state.selectedPreset, action: () => goToPreset(i) },
          ...(i === state.selectedPreset ? [{ label: 'Discard edits', disabled: !state.connected || !isDirtyNow(), action: () => doDiscard() }] : []),
          { label: 'Rename\u2026', disabled: !state.connected || (i !== state.selectedPreset && pedalDirtyForUI()), action: async () => { if (i !== state.selectedPreset) await goToPreset(i); if (state.selectedPreset === i) doRename(); } },
          '-',
          { label: empty ? 'Save current sound here\u2026' : 'Save current sound over this preset\u2026', disabled: !state.connected || i === state.selectedPreset, action: () => doSaveAs(i) },
          '-',
          ...FOOTSWITCHES.map(f => ({ label: 'Assign to footswitch ' + f.label, disabled: !state.connected || state.presetSlots[f.key] === i - 1, action: () => assignFootswitch(f.key, i - 1) })),
          '-',
          { label: 'Delete\u2026', danger: true, disabled: !state.connected || empty, action: () => doDelete(i) },
        ]),
        class: 'preset-row' + (state.connected && !ui.presetUnknown && i === state.selectedPreset ? ' active' : '') + (empty ? ' empty' : '') + (ui.presetReorderBusy ? ' reorder-pending' : '') + (canReorder() ? ' reorderable' : ''),
        role: 'option',
        'aria-selected': String(state.connected && !ui.presetUnknown && i === state.selectedPreset),
        dataset: { n: i },
        onclick: () => { if (Date.now() > suppressPresetClickUntil) goToPreset(i); },
      }, el('span', { class: 'n', text: i }), el('span', { class: 't', text: name }), grip));
    }
    if (!rows.length) rows.push(el('div', { class: 'side-empty', text: 'No presets match “' + ui.filter + '”.' }));
    list.replaceChildren(...rows);
    if (presetDrag && presetDrag.active) markPresetDrag();   // redrawn mid-drag (a pedal report): keep the styling
  }

  // Footswitches strip under the preset list: IA IB / IIA IIB, each with the preset it loads in 4-Preset mode.
  function renderFootswitches() {
    const slots = state.presetSlots || {};
    const at = (f) => (state.connected && Number.isInteger(slots[f.key]) && slots[f.key] >= 0 && slots[f.key] < 64 ? slots[f.key] + 1 : 0);
    const sig = [state.connected, state.selectedPreset, ...FOOTSWITCHES.map(f => at(f) + ':' + (at(f) ? presetName(at(f)) : ''))].join('#');
    if (sig === ui.fsSig) return;
    ui.fsSig = sig;
    $('fsGrid').replaceChildren(...FOOTSWITCHES.map(f => {
      const n = at(f);
      const name = n ? presetName(n) : '';
      const empty = !n || /^empty$/i.test(name);
      const cell = el('button', {
        class: 'fs-cell' + (n && n === state.selectedPreset ? ' active' : '') + (empty ? ' empty' : ''),
        type: 'button', disabled: state.connected ? null : 'true', dataset: { fk: 'fs-' + f.key },
        title: 'Footswitch ' + f.label + ' \u00b7 click to load, right-click to change',
        'aria-label': 'Footswitch ' + f.label + ': ' + (n ? 'preset ' + n + ', ' + name : 'not assigned'),
        onclick: () => { if (n) goToPreset(n); },
        oncontextmenu: (e) => contextMenu(e, [
          { label: 'Assign current preset', disabled: !state.connected || n === state.selectedPreset, action: () => assignFootswitch(f.key, state.selectedPreset - 1) },
          { label: 'Assign\u2026', disabled: !state.connected, action: () => openFootswitchPicker(f, cell) },
        ]),
      }, el('span', { class: 'k', text: f.label }), el('span', { class: 'n', text: n || '' }), el('span', { class: 't', text: n ? (empty ? 'Empty' : name) : '\u2014' }));
      return cell;
    }));
  }
  function openFootswitchPicker(f, anchor) {
    const presets = Array.from({ length: 64 }, (_, i) => ({ n: i + 1, name: (i + 1) + ' \u00b7 ' + presetName(i + 1), cat: presetName(i + 1) === 'Empty' ? 'Empty slots' : 'Presets' }));
    pickerPopover({
      anchor, color: 'var(--accent)', label: 'Choose the preset for footswitch ' + f.label, placeholder: 'Preset for footswitch ' + f.label,
      items: [...presets.filter(p => p.cat === 'Presets'), ...presets.filter(p => p.cat !== 'Presets')],
      isCurrent: (p) => p.n === state.presetSlots[f.key] + 1,
      emptyText: (q) => 'No presets match \u201c' + q + '\u201d.',
      onPick: (p) => { if (p.n !== state.presetSlots[f.key] + 1) assignFootswitch(f.key, p.n - 1); },
    });
  }

  function scrollPresetIntoView() {
    requestAnimationFrame(() => {
      const row = document.querySelector('.preset-row.active');
      if (row) row.scrollIntoView({ block: 'nearest' });
    });
  }

  function nodeMenu(s, info) {
    const items = [{ label: info.on ? 'Bypass' : 'Enable', disabled: !state.connected || info.none, action: () => { toggleStage(s.key); render(); } }];
    if (/^(pre|post)\d$/.test(s.key)) {
      items.push({ label: info.none ? 'Add an effect\u2026' : 'Change effect\u2026', disabled: !state.connected, action: () => { select(s.key); render(); requestAnimationFrame(() => { const b = document.querySelector('[data-fk="picker-' + s.key + '"]'); if (b) openModelPicker(s.key, b); }); } });
      items.push({ label: 'Clear slot', disabled: !state.connected || info.none, action: () => { chooseModel(s.key, 'None'); render(); } });
    } else if (s.key === 'capture' || s.key === 'cab') {
      // Captures: the library picker. Cabs: the inspector's "From the library" list (its search box).
      items.push({ label: s.key === 'capture' ? 'Pick a capture from the library\u2026' : 'Pick a cab from the library\u2026', disabled: !state.connected, action: () => { select(s.key); render(); requestAnimationFrame(() => {
        if (s.key === 'cab') { const q = document.querySelector('[data-fk="cab-lib-search"]'); if (q) { q.scrollIntoView({ block: 'center' }); q.focus(); } return; }
        const b = document.querySelector('[data-fk="lib-' + s.key + '"]'); if (b) openLibraryPicker(s.key, b);
      }); } });
      if (s.key === 'capture') { const slot = activeCaptureSlot(); items.push({ label: 'Info\u2026', disabled: !state.connected || !slot, action: () => openCaptureInfo(slot, document.querySelector('[data-fk="node-capture"]')) }); }
    }
    return items;
  }

  function renderChain() {
    const chain = $('chain');
    chain.replaceChildren(...STAGES.map((s, idx) => {
      const info = stageInfo(s.key);
      const stomp = el('button', {
        class: 'stomp' + (info.on ? ' on' : ''),
        title: (info.on ? 'Bypass ' : 'Turn on ') + s.title + ' (B)',
        'aria-label': (info.on ? 'Bypass ' : 'Turn on ') + s.title,
        'aria-pressed': String(!!info.on),
        disabled: !state.connected,
        dataset: { fk: 'stomp-' + s.key, stage: s.key },
      }, el('i'));
      return el('div', {
        class: 'node' + (ui.selected === s.key ? ' selected' : '') + (info.on ? '' : ' off') + (info.none ? ' none' : '') + (info.unknown ? ' unknown' : ''),
        style: '--c:' + s.color,
        role: 'button', tabindex: '0',
        'aria-pressed': String(ui.selected === s.key),
        title: s.title + ' (' + (idx + 1) + ')',
        dataset: { fk: 'node-' + s.key, stage: s.key },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(s.key); } },
      },
        el('div', { class: 'top' }, el('span', { class: 'stage', text: s.title }), stomp),
        el('div', { class: 'model', text: info.model }),
        el('div', { class: 'sub', title: info.sub || null, text: info.sub || ' ' }));
    }));
  }

  function stageButtonFromEvent(e) {
    const button = e.target && e.target.closest ? e.target.closest('.stomp') : null;
    if (!button || !$('chain').contains(button)) return null;
    const key = button.dataset.stage;
    return key && stage(key) ? { button, key } : null;
  }

  function stageNodeFromEvent(e, allowStomp = false) {
    const target = e.target;
    const node = target && target.closest ? target.closest('.node') : null;
    if (!node || !$('chain').contains(node) || (!allowStomp && target.closest && target.closest('.stomp'))) return null;
    const key = node.dataset.stage;
    return key && stage(key) ? { node, key } : null;
  }

  // The chain is redrawn when the pedal reports a change. If that happens
  // between a mouse-down and mouse-up, the pressed button is detached and the
  // browser drops its click. Apply physical pointer clicks at mouse-down on
  // the stable chain, then swallow the matching click if one still arrives.
  function onStagePointerDown(e) {
    if (e.button === 2) {
      const node = stageNodeFromEvent(e, true);
      if (!node) return;
      e.preventDefault();
      ui.stageContextNativePending = true;
      contextMenu(e, nodeMenu(stage(node.key), stageInfo(node.key)));
      setTimeout(() => { ui.stageContextNativePending = false; }, 1000);
      return;
    }
    if (e.button !== 0) return;
    const hit = stageButtonFromEvent(e);
    if (hit) {
      if (hit.button.disabled) return;
      const stamp = Date.now();
      ui.stagePointerClicks.set(hit.key, stamp);
      setTimeout(() => {
        if (ui.stagePointerClicks.get(hit.key) === stamp) ui.stagePointerClicks.delete(hit.key);
      }, 1000);
      if (!stageInfo(hit.key).canToggle) select(hit.key); // empty slot: show where to pick an effect
      toggleStage(hit.key);
      return;
    }
    const node = stageNodeFromEvent(e);
    if (!node) return;
    select(node.key);
  }

  function onStageContextMenu(e) {
    const node = stageNodeFromEvent(e, true);
    if (!node) return;
    e.preventDefault();
    e.stopPropagation();
    // Physical right-clicks are opened on pointerdown so a redraw cannot lose
    // them. Suppress the browser's follow-up event; keyboard context-menu
    // commands still arrive here without a menu.
    if (ctx) {
      ui.stageContextNativePending = false;
      return;
    }
    contextMenu(e, nodeMenu(stage(node.key), stageInfo(node.key)));
  }

  function onStageClick(e) {
    const hit = stageButtonFromEvent(e);
    if (hit) {
      const stamp = ui.stagePointerClicks.get(hit.key);
      if (stamp && e.detail > 0 && Date.now() - stamp < 1000) {
        ui.stagePointerClicks.delete(hit.key);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      ui.stagePointerClicks.delete(hit.key);
      e.stopPropagation();
      const info = stageInfo(hit.key);
      if (!info.canToggle) select(hit.key); // empty slot: show where to pick an effect
      toggleStage(hit.key);
      return;
    }
    const node = stageNodeFromEvent(e);
    if (!node) return;
    e.stopPropagation();
    select(node.key);
  }

  function renderExpPill() {
    const b = $('expBtn');
    const n = expAssigned().length;
    b.classList.toggle('selected', ui.selected === 'exp');
    b.setAttribute('aria-pressed', String(ui.selected === 'exp'));
    b.disabled = !state.connected;
    b.title = 'Expression pedal assignments' + (n ? ' (' + n + ' in this preset)' : '') + ' (E)';
    $('expCount').textContent = n ? String(n) : '';
    $('expCount').hidden = !n;
  }

  function select(key) {
    if (ui.selected === key) return;
    ui.selected = key;
    closePopover();
    render();
  }

  // ---------------- inspector
  function renderInspector() {
    const box = $('inspector');
    if (ui.selected === 'exp') { box.style.setProperty('--c', 'var(--accent)'); box.replaceChildren(...inspExp()); return; }
    const s = stage(ui.selected);
    box.style.setProperty('--c', s.color);
    const kids = ui.selected === 'gate' ? inspGate(s)
      : ui.selected === 'capture' ? inspCapture(s)
      : ui.selected === 'cab' ? inspCab(s)
      : inspFX(s);
    box.replaceChildren(...kids);
  }

  function bypassSwitch(key, on, enabled = true) {
    return el('button', {
      class: 'switch' + (on ? ' on' : ''),
      role: 'switch', 'aria-checked': String(!!on),
      disabled: !enabled || !state.connected,
      dataset: { fk: 'switch-' + key, stage: key },
    }, el('span', { class: 'track' }), on ? 'On' : 'Bypassed');
  }

  function inspectorSwitchFromEvent(e) {
    const target = e.target;
    const button = target && target.closest ? target.closest('.switch[data-stage]') : null;
    if (!button || !$('inspector').contains(button)) return null;
    const key = button.dataset.stage;
    return key && stage(key) ? { button, key } : null;
  }

  function onInspectorPointerDown(e) {
    if (e.button !== 0) return;
    const hit = inspectorSwitchFromEvent(e);
    if (!hit || hit.button.disabled) return;
    const stamp = Date.now();
    ui.bypassPointerClicks.set(hit.key, stamp);
    setTimeout(() => {
      if (ui.bypassPointerClicks.get(hit.key) === stamp) ui.bypassPointerClicks.delete(hit.key);
    }, 1000);
    toggleStage(hit.key);
  }

  function onInspectorClick(e) {
    const hit = inspectorSwitchFromEvent(e);
    if (!hit) return;
    const stamp = ui.bypassPointerClicks.get(hit.key);
    if (stamp && e.detail > 0 && Date.now() - stamp < 1000) {
      ui.bypassPointerClicks.delete(hit.key);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    ui.bypassPointerClicks.delete(hit.key);
    e.stopPropagation();
    if (!hit.button.disabled) toggleStage(hit.key);
  }

  function head(s, extra = [], onSwitch = null) {
    return el('div', { class: 'insp-head' },
      el('h1', { text: s.title }),
      ...extra,
      el('div', { class: 'grow' }),
      tempoControl(),
      onSwitch);
  }

  function inspFX(s) {
    const key = s.key;
    const b = state.blocks[key];
    const def = b.models.find(m => m.name === b.model);
    const picker = el('button', {
      class: 'picker-btn', 'aria-haspopup': 'listbox', title: 'Change effect (M)',
      dataset: { fk: 'picker-' + key },
      onclick: (e) => openModelPicker(key, e.currentTarget),
    },
      el('span', { text: b.unknownId ? 'Unknown effect' : b.model === 'None' ? 'Choose an effect' : b.model }),
      el('span', { class: 'cat', text: b.unknownId ? 'Newer firmware?' : b.model === 'None' ? '' : (def ? def.category : '') }),
      el('span', { class: 'chev', text: '▾' }));

    const out = [head(s, [picker], bypassSwitch(key, b.on, !!b.unknownId || !(b.model === 'None' && !b.on)))];

    // An effect the editor's tables don't have (a newer firmware): no knobs, nothing written but on/off.
    if (b.unknownId) {
      out.push(el('p', { class: 'empty-block unknown-block', dataset: { fk: 'unknown-note-' + key } },
        "This effect isn't in the editor's list yet, so its settings can't be edited here. It still plays as saved on the pedal. Update the editor to edit it."));
      return out;
    }

    if (b.model === 'None') {
      out.push(el('p', { class: 'empty-block' },
        el('strong', { text: s.title + ' is empty. ' }),
        'Pick an effect to add it to the chain. ',
        key.startsWith('pre') ? 'Pre slots sit before the capture: drives, compressors, wahs, EQ and pitch.' :
          key === 'post1' ? 'This slot takes modulation and EQ/utility effects.' :
          key === 'post2' ? 'This slot takes delays and EQ/utility effects.' : 'This slot takes reverbs and EQ/utility effects.'));
      return out;
    }

    const params = def && def.displayOrder ? def.displayOrder.map(i => b.params[i]).filter(Boolean) : b.params;
    if (!params.length) {
      out.push(el('p', { class: 'empty-block', text: 'This effect has no adjustable parameters.' }));
      return out;
    }
    const grid = el('div', { class: 'params' });
    params.forEach(p => grid.append(paramControl(key, b, p, s.color)));
    out.push(el('div', { class: 'section' }, grid));
    return out;
  }

  function paramControl(key, block, p, color) {
    const meta = p.meta || { kind: 'range', min: 0, max: 10, step: 0.1, unit: '' };
    const locked = isParamDisabled(block, p);
    const fk = 'p-' + key + '-' + p.index;

    if (meta.kind === 'enum') {
      const commit = (idx) => {
        if (locked || idx === p.value) return;
        p.value = idx;
        setFXParam(key, p);
        noteExpressionLocalOverride(key, 'param', p);
        render();
      };
      if (meta.options.length <= 6) {
        return el('div', { class: 'choice' + (locked ? ' locked' : ''), title: locked ? 'Set by the Sync setting' : null },
          el('span', { class: 'label', text: p.name }),
          el('div', { class: 'seg', role: 'radiogroup', 'aria-label': p.name },
            meta.options.map((o, i) => el('button', {
              class: i === p.value ? 'on' : '', role: 'radio', 'aria-checked': String(i === p.value),
              dataset: { fk: fk + '-' + i }, onclick: () => commit(i),
            }, o))));
      }
      const sel = el('select', {
        class: 'select', 'aria-label': p.name, disabled: locked, dataset: { fk },
        onchange: (e) => commit(Number(e.target.value)),
      }, meta.options.map((o, i) => el('option', { value: i, selected: i === p.value }, o)));
      return el('div', { class: 'choice' + (locked ? ' locked' : '') }, el('span', { class: 'label', text: p.name }), sel);
    }

    const isFreq = meta.unit === 'Hz' && meta.min > 0 && meta.max / meta.min >= 20;
    return knobControl({
      fk, label: p.name, color, locked,
      lockedTip: 'Set by the Sync setting',
      min: meta.min, max: meta.max, step: meta.step || 0.1,
      scale: isFreq ? 'log' : 'lin',
      get: () => Number(p.value),
      fmt: (v) => paramDisplayValue({ ...p, value: v }),
      live: (v) => { p.value = v; noteExpressionLocalOverride(key, 'param', p); },
      send: (v) => { p.value = v; setFXParam(key, p); },
      commit: (v) => { p.value = v; render(); },
    });
  }

  function inspCapture(s) {
    const out = [head(s, [], bypassSwitch('capture', state.capture.on))];

    // amp + level
    const amp = el('div', { class: 'params' });
    [['gain', 'Gain'], ['bass', 'Bass'], ['mid', 'Mid'], ['treble', 'Treble'], ['level', 'Level']].forEach(([k, label]) => {
      amp.append(knobControl({
        fk: 'amp-' + k, label, color: s.color, locked: !state.capture.on, lockedTip: 'Capture is bypassed',
        min: 0, max: 255, step: 1, defaultValue: 128,
        get: () => state.amp[k],
        fmt: (v) => Math.round((v / 255) * 100) + '%',
        parse: (str) => (parseFloat(str) / 100) * 255,
        live: (v) => { state.amp[k] = v; noteExpressionLocalOverride(k, 'range', v); },
        send: (v) => { state.amp[k] = Math.round(v); setAmpKnob(k, state.amp[k]); },
        commit: (v) => { state.amp[k] = Math.round(v); render(); },
      }));
    });
    amp.append(knobControl({
      fk: 'cap-vol', label: 'Capture volume', color: s.color, locked: !state.capture.on, lockedTip: 'Capture is bypassed',
      min: -24, max: 12, step: 0.1, defaultValue: 0,
      get: () => Number(state.captureVolumeDb || 0),
      fmt: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB',
      live: (v) => { state.captureVolumeDb = v; noteExpressionLocalOverride('level', 'range', v); },
      send: (v) => { state.captureVolumeDb = v; setCaptureVolumeDb(v); },
      commit: (v) => { state.captureVolumeDb = v; render(); },
    }));
    out.push(el('div', { class: 'section' }, el('h3', { text: 'Amp' }), amp));

    // slots
    const cur = activeCaptureSlot();
    const slots = el('div', { class: 'slots' + (state.capture.on ? '' : ' disabled'), role: 'listbox', 'aria-label': 'Capture slots' });
    for (let i = 1; i <= captureSlotCount(); i++) {
      slots.append(el('button', {
        class: 'slot' + (i === cur ? ' on' : ''), role: 'option', 'aria-selected': String(i === cur),
        dataset: { fk: 'capslot-' + i }, disabled: !state.connected,
        onclick: () => { if (i !== cur) { setCapture(i); if (ui.demo) demo.pickCapture(i); render(); } },
        oncontextmenu: (e) => { const anchor = e.currentTarget; contextMenu(e, [   // currentTarget is gone by the time an item runs
          { label: i === cur ? 'Loaded in this preset' : 'Load into this preset', disabled: !state.connected || i === cur, action: () => { setCapture(i); if (ui.demo) demo.pickCapture(i); render(); } },
          { label: 'Put a library capture in slot ' + i + '\u2026', disabled: !state.connected, action: () => openLibraryPicker('capture', anchor, i) },
          '-',
          { label: 'Info\u2026', disabled: !state.connected, action: () => openCaptureInfo(i, anchor) },
        ]); },
      }, el('span', { class: 'n', text: i }), el('span', { class: 't', text: state.captureNames.get(i) || ('Capture ' + i) }), usageBadge('capture', i)));
    }
    const fromLib = state.capture.on && state.capture.fromLibrary;
    const lib = !fromLib && state.capture.on && state.currentCapture.inBank === false;
    out.push(el('div', { class: 'section' },
      el('div', { class: 'section-head' }, el('h3', { text: 'Captures on the pedal' }),
        el('button', { class: 'btn ghost small', dataset: { fk: 'usage-capture' }, disabled: !state.connected, 'aria-haspopup': 'dialog',
          title: ui.usage ? 'Which presets use which slot (scanned ' + scanTime() + ')' : 'Scan the presets to see which slots they use',
          onclick: (e) => openUsage(e.currentTarget) }, 'Usage\u2026'),
        el('button', { class: 'btn ghost small', dataset: { fk: 'lib-capture' }, disabled: !state.connected,
          title: 'Pick a capture from the library stored on the pedal and load it into a slot',
          onclick: (e) => openLibraryPicker('capture', e.currentTarget) }, 'Load from library…')),
      fromLib ? el('p', { class: 'note', dataset: { fk: 'cap-from-lib' }, text: 'From the library: ' + (state.currentCapture.name || 'a capture') + '. This preset plays it straight from the pedal\u2019s library, not from a slot; picking a slot below replaces that.' }) : null,
      lib ? el('p', { class: 'note', text: 'Playing a library capture: ' + state.currentCapture.name + '. Manage the library from the Cortex Cloud tab or app.' }) : null,
      !state.capture.on ? el('p', { class: 'note', text: 'Turn the capture back on to pick a slot.' }) : null,
      slots));
    return out;
  }

  function inspCab(s) {
    const on = state.cabIR.on;
    const factory = selectedIRIsFactory();
    const irPreviewing = irAuditioning();
    const irLoad = ui.cabIRLoadActive;
    const irLoadBusy = Boolean(irLoad);
    const micPositionEditable = factory && on && !irPreviewing;
    const micPositionLockTitle = irPreviewing
      ? 'Stop the IR preview to change the microphone or position.'
      : 'Mic and position apply to factory cabs only';
    const out = [head(s, [], bypassSwitch('cab', on))];

    const MICS = ['Condenser 184', 'Condenser 414', 'Dynamic 421', 'Dynamic 57', 'Ribbon 160'];
    const micRow = el('div', { class: 'params wide' },
      el('div', { class: 'choice' + (micPositionEditable ? '' : ' locked'), title: micPositionEditable ? null : micPositionLockTitle },
        el('span', { class: 'label', text: 'Mic' }),
        el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mic' },
          MICS.map(m => el('button', {
            disabled: !micPositionEditable,
            class: sameName(state.cabIR.mic, m) ? 'on' : '', role: 'radio', 'aria-checked': String(sameName(state.cabIR.mic, m)),
            dataset: { fk: 'mic-' + m },
            onclick: () => { if (micPositionEditable && !irAuditioning() && !sameName(state.cabIR.mic, m)) { void setCabIRMicPosition(m, state.cabIR.position); } },
          }, m)))),
      el('div', { class: 'choice' + (micPositionEditable ? '' : ' locked'), title: micPositionEditable ? null : micPositionLockTitle },
        el('span', { class: 'label', text: 'Position' }),
        el('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Mic position' },
          [1, 2, 3, 4, 5, 6].map(n => el('button', {
            disabled: !micPositionEditable,
            class: Number(state.cabIR.position) === n ? 'on' : '', role: 'radio', 'aria-checked': String(Number(state.cabIR.position) === n),
            dataset: { fk: 'pos-' + n },
            onclick: () => { if (micPositionEditable && !irAuditioning() && Number(state.cabIR.position) !== n) { void setCabIRMicPosition(state.cabIR.mic, n); } },
          }, String(n))))));

    const knobs = el('div', { class: 'params' },
      knobControl({
        fk: 'cab-level', label: 'Level', color: s.color, locked: !on, lockedTip: 'Cab / IR is bypassed',
        min: -96, max: 12, step: 0.1, defaultValue: 0, curve: 'db',
        get: () => Number(state.cabIR.levelDb),
        fmt: (v) => (v > 0 ? '+' : '') + Number(v).toFixed(1) + ' dB',
        live: (v) => { state.cabIR.levelDb = v; },
        send: (v) => { setCabIRLevelDb(v); },
        commit: (v) => { render(); },
      }),
      knobControl({
        fk: 'cab-hp', label: 'High pass', color: s.color, locked: !on, lockedTip: 'Cab / IR is bypassed',
        min: 20, max: 800, step: 1, scale: 'log', defaultValue: 20,
        get: () => Number(state.cabIR.highPassHz),
        fmt: (v) => Math.round(v) + ' Hz',
        live: (v) => { state.cabIR.highPassHz = v; },
        send: (v) => { setCabIRHighPassHz(v); },
        commit: (v) => { render(); },
      }),
      knobControl({
        fk: 'cab-lp', label: 'Low pass', color: s.color, locked: !on, lockedTip: 'Cab / IR is bypassed',
        min: 1000, max: 20000, step: 1, scale: 'log', defaultValue: 20000,
        get: () => Number(state.cabIR.lowPassHz),
        fmt: (v) => (v >= 10000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz'),
        parse: (str) => /k/i.test(str) ? parseFloat(str) * 1000 : parseFloat(str),
        live: (v) => { state.cabIR.lowPassHz = v; },
        send: (v) => { setCabIRLowPassHz(v); },
        commit: (v) => { render(); },
      }));

    out.push(el('div', { class: 'section' }, el('h3', { text: 'Tone' }), knobs));
    out.push(el('div', { class: 'section' }, el('h3', { text: 'Microphone' }),
      irPreviewing
        ? el('p', { class: 'note', text: 'Stop the IR preview to change the microphone or position.' })
        : factory ? null : el('p', { class: 'note', text: 'Mic and position only apply to the factory cabs.' }),
      micRow));

    const cur = activeIRSlot();
    const slots = el('div', {
      class: 'slots' + (on ? '' : ' disabled') + (irLoadBusy ? ' loading' : ''),
      role: 'listbox', 'aria-label': 'IR slots', 'aria-busy': String(irLoadBusy),
    });
    for (let i = 1; i <= irSlotCount(); i++) {
      const name = state.irNames.get(i) || ('IR ' + i);
      const loadingThisSlot = Boolean(irLoad && irLoad.slot === i && irLoad.phase !== 'choosing');
      slots.append(el('button', {
        class: 'slot' + (i === cur ? ' on' : '') + (irAudition.active && i === cur ? ' preview-muted' : '') + (loadingThisSlot ? ' ir-loading' : ''),
        role: 'option', 'aria-selected': String(i === cur), 'aria-busy': String(loadingThisSlot),
        title: loadingThisSlot ? 'Loading ' + irLoad.name + ' into this IR slot' : null,
        dataset: { fk: 'irslot-' + i }, disabled: !state.connected || irLoadBusy,
        oncontextmenu: (e) => { const anchor = e.currentTarget; contextMenu(e, [
          { label: i === cur ? 'Loaded in this preset' : 'Load into this preset', disabled: !state.connected || i === cur, action: () => anchor.click() },
          { label: 'Put a library cab in slot ' + i + '\u2026', disabled: !state.connected, action: () => openLibraryPicker('cab', anchor, i) },
        ]); },
        onclick: () => {
          if (i === cur) return;
          Object.assign(state.currentIR, { shortName: name, fullName: name, inBank: true, slot: i });
          selectCabIRSlot(i);
          if (ui.demo) demo.pickIR(i);
          render();
        },
      }, el('span', { class: 'n', text: i }), el('span', { class: 't', text: name }),
        loadingThisSlot ? el('span', { class: 'slot-load-pending', text: '…', 'aria-label': 'Loading' }) : usageBadge('cab', i)));
    }
    const cabFromLib = on && state.cabIR.fromLibrary;
    const loadStatus = irLoad
      ? (irLoad.phase === 'choosing'
        ? 'Choose a slot for ' + irLoad.name + '…'
        : irLoad.phase === 'sending'
          ? 'Loading ' + irLoad.name + ' into IR slot ' + irLoad.slot + '…'
          : 'Activating IR slot ' + irLoad.slot + '…')
      : ui.cabIRLoadPaused ? 'The last IR change was not confirmed. Reconnect before loading another IR.' : '';
    const irQueueCount = ui.cabIRLoadQueue.length;
    out.push(el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h3', { text: 'Cabs and IRs on the pedal' })),
      cabFromLib ? el('p', { class: 'note', dataset: { fk: 'cab-from-lib' }, text: 'From the library: ' + (state.currentIR.shortName || 'a cab') + '. This preset plays it straight from the pedal\u2019s library, not from a slot.' }) : null,
      loadStatus ? el('p', { class: 'note ir-load-status', role: 'status', 'aria-live': 'polite', text: loadStatus + (irLoad && irQueueCount ? ' ' + irQueueCount + ' more queued.' : '') }) : null,
      !on ? el('p', { class: 'note', text: 'Turn the cab back on to pick a slot.' }) : null, slots));
    out.push(el('div', { class: 'section cab-library-section' },
      el('div', { class: 'section-divider' }, el('h3', { text: 'From the library' })),
      el('p', { class: 'library-hint', text: 'Click a cab or IR to choose a slot. Preview auditions it without changing any slot.' }),
      irLibrarySection()));
    return out;
  }

  function inspGate(s) {
    const p = state.gate.params[0];
    return [
      head(s, [], bypassSwitch('gate', state.gate.on)),
      el('div', { class: 'section' },
        el('p', { class: 'note', text: 'The adaptive gate sits at the input, before everything else in the chain.' }),
        el('div', { class: 'params' }, knobControl({
          fk: 'gate-red', label: 'Reduction', color: s.color, locked: !state.gate.on, lockedTip: 'Gate is off',
          min: 0, max: 100, step: 1, defaultValue: 50,
          get: () => Number(p.value),
          fmt: (v) => Math.round(v) + '%',
          live: (v) => { p.value = v; noteExpressionLocalOverride('gate', 'range', v); },
          send: (v) => { p.value = Math.round(v); setGateReduction(p.value); },
          commit: (v) => { p.value = Math.round(v); render(); },
        }))),
    ];
  }

  // ------------------------------------------------------------------ expression pedal
  // Per-preset assignments, read with type 60 → 61 and written as a whole set with type 62 (each 62 replaces
  // the set; docs/INVESTIGATION.md §10). The protocol (state.exp, EXP_RANGES / EXP_BYPASS, expSaveFrame) is
  // upstream's, from core.js; this is the panel, in parity with the native app's ExpressionPanel (same labels,
  // same order, same bytes). Upstream keeps ranges in % and sends Math.round(% × 2.55); the panel keeps the exact
  // raw value as a fractional % (raw × 100 / 255) so a knob step is one raw step and capture volume can show dB.
  const rawOfPct = (pct) => Math.round(clamp(Number(pct) || 0, 0, 100) * 255 / 100);
  const pctOfRaw = (raw) => clamp(Number(raw) || 0, 0, 255) * 100 / 255;
  // Capture volume's raw ↔ dB curve (the same as the native app's Capture.rawToDb / dbToRaw).
  const capRawToDb = (raw) => { const r = clamp(raw, 0, 255); return r <= 128 ? (r / 128) * 24 - 24 : ((r - 128) / 127) * 12; };
  const capDbToRaw = (db) => { const d = clamp(db, -24, 12); return d <= 0 ? Math.round((d + 24) / 24 * 128) : Math.round(128 + d / 12 * 127); };

  // Upstream's decoder rounds the 0–255 values to whole %; re-read them exactly.
  const coreDecodeExp = window.decodeExpAssignments;
  window.decodeExpAssignments = function (data) {
    const out = coreDecodeExp.apply(this, arguments);
    try {
      const f = framePayloadFields(data);
      EXP_RANGES.forEach(r => {
        const rec = f[r.save - 1] && f[r.save - 1][0] && f[r.save - 1][0].wire === 2 ? parseProtoFields(f[r.save - 1][0].raw) : null;
        if (!rec) return;
        const num = (n) => (rec[n] && rec[n][0] ? rec[n][0].value : 0);
        Object.assign(out.ranges[r.key], { min: pctOfRaw(num(2)), max: pctOfRaw(num(3)) });
      });
    } catch { /* keep upstream's rounded values */ }
    return out;
  };

  const EXP_RANGE_TITLES = { gain: 'Gain', bass: 'Bass', mid: 'Mid', treble: 'Treble', level: 'Capture volume', gate: 'Gate reduction' };
  const EXP_SWITCH_MODES = [['heelToe', 'Heel-toe'], ['switch', 'Switch'], ['stop', 'Stop']];
  const expStageKey = (t) => t.block || (t.key === 'gate' ? 'gate' : t.key === 'cab' ? 'cab' : 'capture');
  // In field order (the native app's ExpTarget.all): sweeps 4–13, 21; switches 14–20, 22.
  const expTargets = () => [
    ...EXP_RANGES.slice().sort((a, b) => a.save - b.save).map(t => ({ id: 'range-' + t.key, kind: 'range', t, entry: () => state.exp.ranges[t.key] })),
    ...EXP_BYPASS.slice().sort((a, b) => a.save - b.save).map(t => ({ id: 'bypass-' + t.key, kind: 'bypass', t, entry: () => state.exp.bypass[t.key] })),
  ];
  function expName(x) {
    if (x.kind === 'range') return x.t.block ? stage(x.t.block).title + ' amount' : EXP_RANGE_TITLES[x.t.key];
    return (x.t.block ? stage(x.t.block).title : x.t.key === 'gate' ? 'Gate' : x.t.key === 'cab' ? 'Cab / IR' : 'Capture') + ' on/off';
  }
  // What the target currently holds: the effect in an FX slot, the capture, the cab, the gate.
  function expSub(x) {
    const b = x.t.block && state.blocks[x.t.block];
    if (b) return b.unknownId ? 'Unknown effect' : b.model === 'None' ? 'Empty slot' : b.model;
    if (x.t.key === 'gate') return 'Noise gate';
    if (x.t.key === 'cab') return state.currentIR.shortName || 'Cab / IR';
    return state.currentCapture.name || 'Capture';
  }
  const expAssigned = () => (state.exp.loaded ? expTargets().filter(x => x.entry() && x.entry().on) : []);
  window.__exp = { assigned: () => expAssigned().map(x => x.id) };

  // After a preset (re)load and on connect: read the new preset's set. `force` re-reads the same preset
  // (Discard, a reload in demo mode). Skipped while the usage scan walks the presets.
  function followExp(force = false) {
    if (!state.connected || ui.scanning) return;
    if (force || state.exp.preset !== state.selectedPreset || !state.exp.loaded) requestExpAssignments();
  }

  // One 62 per committed edit (knobs commit on release, so a drag sends one); a queued, unsent 62 is
  // replaced by the newer one. The pedal answers 63 and reports the preset dirty (115); Save commits it.
  function expCommit() {
    if (!state.connected || !state.exp.loaded) return;
    const frame = expSaveFrame();
    if (frame.length - 2 > 255) { toast('Too many expression assignments for one message'); render(); return; }
    writeC304('Save expression assignments (preset ' + state.exp.preset + ')', frame, 'exp-save');
    render();
  }
  // Assign `x`; when it replaces `old` of the same kind, the row keeps its settings (as in the native app).
  function expAssign(x, old = null) {
    const kept = old && old.kind === x.kind ? Object.assign({}, old.entry()) : null;
    if (old) old.entry().on = false;
    if (x.kind === 'range') state.exp.ranges[x.t.key] = Object.assign(defaultExpRange(), kept || {}, { on: true });
    else state.exp.bypass[x.t.key] = Object.assign(defaultExpBypass(), kept || {}, { on: true });
    expCommit();
  }
  function expRemove(x) { x.entry().on = false; expCommit(); }
  function expClearAll() {
    expAssigned().forEach(x => { x.entry().on = false; });
    expCommit();
  }
  // The Add menu, and each card's target menu (`old` = the card's current target).
  function openExpTargets(anchor, old = null) {
    const free = expTargets().filter(x => !(x.entry() && x.entry().on));
    pickerPopover({
      anchor, color: 'var(--accent)', label: old ? 'Change the target' : 'Assign the expression pedal', placeholder: 'Search knobs and blocks',
      items: free.map(x => ({ name: expName(x), cat: x.kind === 'range' ? 'Sweep (heel → toe)' : 'Switch on / off', sub: expSub(x), x })),
      isCurrent: () => false,
      emptyText: (q) => 'Nothing matches “' + q + '”.',
      onPick: (m) => expAssign(m.x, old),
    });
  }

  const expSwitch = (fk, label, on, color, onclick) => el('div', { class: 'choice' },
    el('span', { class: 'label', text: label }),
    el('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), 'aria-label': label,
      disabled: !state.connected, dataset: { fk }, onclick }, el('span', { class: 'track' })));

  function expCard(x) {
    const v = x.entry();
    const k = x.t.key;
    const color = stage(expStageKey(x.t)).color;
    const controls = [];
    if (x.kind === 'range') {
      const db = k === 'level';
      ['min', 'max'].forEach(end => controls.push(knobControl({
        fk: 'exp-' + (end === 'min' ? 'heel' : 'toe') + '-' + k, label: end === 'min' ? 'Heel' : 'Toe', color,
        min: 0, max: 255, step: 1, defaultValue: end === 'min' ? 0 : 255,
        get: () => rawOfPct(v[end]),
        fmt: (raw) => (db ? (capRawToDb(raw) > 0 ? '+' : '') + capRawToDb(raw).toFixed(1) + ' dB' : Math.round(raw / 255 * 100) + '%'),
        parse: (str) => (db ? capDbToRaw(parseFloat(str)) : parseFloat(str) / 100 * 255),
        live: (raw) => { v[end] = pctOfRaw(raw); },
        commit: (raw) => { v[end] = pctOfRaw(raw); expCommit(); },
      })));
      controls.push(expSwitch('exp-invert-' + x.id, 'Invert', v.inverted, color, () => { v.inverted = !v.inverted; expCommit(); }));
    } else {
      controls.push(el('div', { class: 'choice' },
        el('span', { class: 'label', text: 'Switches' }),
        el('div', { class: 'seg', role: 'radiogroup', 'aria-label': expName(x) + ': switches', style: '--c:' + color },
          EXP_SWITCH_MODES.map(([mode, label]) => el('button', {
            class: v.mode === mode ? 'on' : '', role: 'radio', 'aria-checked': String(v.mode === mode),
            dataset: { fk: 'exp-mode-' + k + '-' + mode },
            onclick: () => { if (v.mode !== mode) { v.mode = mode; if (mode === 'switch') v.latch = false; expCommit(); } },
          }, label)))));
      if (v.mode === 'switch') {
        controls.push(expSwitch('exp-latch-' + k, 'Latch', v.latch, color, () => { v.latch = !v.latch; expCommit(); }));
      } else {
        controls.push(knobControl({
          fk: 'exp-delay-' + k, label: 'Delay', color,
          min: 0, max: 2000, step: 1, defaultValue: 600,
          get: () => Number(v.delay),
          fmt: (n) => Math.round(n) + ' ms',
          live: (n) => { v.delay = Math.round(n); },
          commit: (n) => { v.delay = Math.round(n); expCommit(); },
        }));
      }
      if (v.mode !== 'stop') controls.push(expSwitch('exp-invert-' + x.id, 'Invert', v.inverted, color, () => { v.inverted = !v.inverted; expCommit(); }));
    }
    return el('div', { class: 'exp-row', style: '--c:' + color, dataset: { fk: 'exp-row-' + x.id } },
      el('button', { class: 'exp-target', 'aria-haspopup': 'listbox', title: 'Assign this row to another target', disabled: !state.connected,
        dataset: { fk: 'exp-target-' + x.id }, onclick: (e) => openExpTargets(e.currentTarget, x) },
        el('span', { class: 'txt' }, el('span', { class: 'exp-name', text: expName(x) }), el('span', { class: 'exp-sub', title: expSub(x), text: expSub(x) })),
        el('span', { class: 'chev', text: '▾' })),
      el('div', { class: 'exp-controls' }, ...controls),
      el('button', { class: 'btn ghost small exp-remove', disabled: !state.connected, dataset: { fk: 'exp-remove-' + x.id }, title: 'Remove this assignment', onclick: () => expRemove(x) }, 'Remove'));
  }

  function inspExp() {
    const rows = expAssigned();
    const loaded = state.connected && state.exp.loaded && state.exp.preset === state.selectedPreset;
    const n = state.selectedPreset;
    const out = [el('div', { class: 'insp-head' },
      el('h1', { text: 'Expression pedal' }),
      state.connected ? el('span', { class: 'exp-preset', text: 'Preset ' + n + ' · ' + presetName(n) }) : null)];
    const body = !state.connected ? el('p', { class: 'empty-block', text: 'Connect the pedal to see this preset’s expression assignments.' })
      : !loaded ? el('p', { class: 'empty-block', dataset: { fk: 'exp-loading' }, text: /did not send|failed/i.test(state.exp.status) ? state.exp.status : 'Reading the assignments from the pedal…' })
      : !rows.length ? el('p', { class: 'empty-block', dataset: { fk: 'exp-empty' }, text: 'No expression assignments. Plug an expression pedal into EXP/MIDI and assign a knob here.' })
      : el('div', { class: 'exp-list' }, ...rows.map(expCard));
    out.push(el('div', { class: 'section' },
      el('div', { class: 'section-head' }, el('h3', { text: 'Assignments' }),
        el('button', { class: 'btn ghost small', dataset: { fk: 'exp-add' }, disabled: !loaded || rows.length === expTargets().length, 'aria-haspopup': 'listbox',
          title: 'Assign a knob or a block on/off to the expression pedal', onclick: (e) => openExpTargets(e.currentTarget) }, 'Add assignment'),
        el('button', { class: 'btn ghost small', dataset: { fk: 'exp-clear' }, disabled: !loaded || !rows.length,
          title: 'Remove every assignment from this preset', onclick: () => expClearAll() }, 'Clear all')),
      el('p', { class: 'note', text: 'Sweeps follow the pedal from heel to toe; switches turn a block on or off. Edits are live on the pedal: Save (' + keyLabel('⌘S') + ') keeps them in the preset.' }),
      body));
    return out;
  }

  // ------------------------------------------------------------------ knob
  // Vertical drag (Shift = fine), wheel, arrow keys (Shift = ×10),
  // double-click to reset, click the value to type one.
  const A0 = -135, A1 = 135, R = 21, C = 27;
  const polar = (deg) => { const r = (deg - 90) * Math.PI / 180; return [C + R * Math.cos(r), C + R * Math.sin(r)]; };
  const arcPath = (d0, d1) => {
    if (Math.abs(d1 - d0) < 0.01) return '';
    const [x0, y0] = polar(Math.min(d0, d1)), [x1, y1] = polar(Math.max(d0, d1));
    const large = Math.abs(d1 - d0) > 180 ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  };

  function knobControl(o) {
    const { min, max } = o;
    const step = o.step || 0.1;
    const log = o.scale === 'log';
    // 'db' curve: spend most of the travel on the useful top end (-30..+12).
    const db = o.curve === 'db';
    const toNorm = (v) => {
      v = clamp(v, min, max);
      if (log) return Math.log(v / min) / Math.log(max / min);
      if (db) { const k = (max - min); const x = (v - min) / k; return Math.sqrt(x); }
      return (v - min) / (max - min);
    };
    const fromNorm = (n) => {
      n = clamp(n, 0, 1);
      if (log) return min * Math.pow(max / min, n);
      if (db) return min + n * n * (max - min);
      return min + n * (max - min);
    };
    const snap = (v) => roundToStep(clamp(v, min, max), step);
    const zero = min < 0 && max > 0 ? toNorm(0) : 0;

    const root = el('div', {
      class: 'knob' + (o.locked ? ' locked' : ''),
      style: '--c:' + o.color,
      tabindex: o.locked ? '-1' : '0',
      role: 'slider',
      'aria-label': o.label,
      'aria-valuemin': min, 'aria-valuemax': max,
      title: o.locked ? o.lockedTip : 'Drag or scroll to adjust. Shift for fine control. Double-click to reset.',
      dataset: { fk: o.fk },
    });
    const svg = sv('svg', { viewBox: '0 0 54 54', 'aria-hidden': 'true' });
    const bg = sv('path', { class: 'arc-bg', d: arcPath(A0, A1), fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
    const arc = sv('path', { class: 'arc', fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round' });
    const cap = sv('circle', { class: 'cap', cx: C, cy: C, r: 15, 'stroke-width': 1 });
    const ptr = sv('line', { class: 'ptr', 'stroke-width': 2.2, 'stroke-linecap': 'round' });
    svg.append(bg, arc, cap, ptr);
    const label = el('div', { class: 'label', text: o.label });
    let val = el('div', { class: 'val' });
    root.append(label, svg, val);

    let current = snap(o.get());
    const draw = () => {
      const n = toNorm(current);
      const deg = A0 + n * (A1 - A0);
      const zdeg = A0 + zero * (A1 - A0);
      arc.setAttribute('d', arcPath(zdeg, deg));
      const rr = (deg - 90) * Math.PI / 180;
      ptr.setAttribute('x1', (C + 5 * Math.cos(rr)).toFixed(2));
      ptr.setAttribute('y1', (C + 5 * Math.sin(rr)).toFixed(2));
      ptr.setAttribute('x2', (C + 12.5 * Math.cos(rr)).toFixed(2));
      ptr.setAttribute('y2', (C + 12.5 * Math.sin(rr)).toFixed(2));
      if (val.tagName !== 'INPUT') val.textContent = o.fmt(current);
      root.setAttribute('aria-valuenow', current);
      root.setAttribute('aria-valuetext', o.fmt(current));
    };
    draw();
    if (o.locked) return root;

    // `send` is deliberately separate from `commit`: live controls can write every
    // snapped value through the coalescing BLE queue without rebuilding the inspector
    // during a drag. Expression-assignment knobs omit `send` because their type-62
    // message replaces the whole assignment set and should still be committed once.
    const setLive = (v, force = false) => {
      const next = snap(v);
      if (!force && next === current) return false;
      current = next;
      o.live && o.live(current);
      draw();
      o.send && o.send(current);
      return true;
    };
    let pendingCommit = null;
    let changedSinceCommit = false;
    const commitNow = () => {
      clearTimeout(pendingCommit);
      pendingCommit = null;
      if (!changedSinceCommit) return;
      changedSinceCommit = false;
      o.commit(current);
    };
    const commitSoon = () => {
      clearTimeout(pendingCommit);
      pendingCommit = setTimeout(() => { pendingCommit = null; commitNow(); }, 160);
    };

    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      ui.knobDragging = true;
      ui.renderAfterKnob = false;
      root.focus({ preventScroll: true });
      const startY = e.clientY;
      const startN = toNorm(current);
      let moved = false;
      document.body.style.cursor = 'ns-resize';
      const move = (ev) => {
        const dy = startY - ev.clientY;
        if (!moved && Math.abs(dy) < 2) return;
        moved = true;
        const scale = ev.shiftKey ? 0.1 : 1;
        if (setLive(fromNorm(startN + (dy / 180) * scale))) changedSinceCommit = true;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('blur', up);
        document.body.style.cursor = '';
        ui.knobDragging = false;
        const renderAfter = ui.renderAfterKnob;
        ui.renderAfterKnob = false;
        if (moved) commitNow();
        if (renderAfter) render();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      window.addEventListener('blur', up, { once: true });
    });

    svg.addEventListener('dblclick', () => {
      if (o.defaultValue === undefined) return;
      setLive(o.defaultValue, true);
      changedSinceCommit = true;
      commitNow();
    });

    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const n = toNorm(current) + dir * (e.shiftKey ? 0.002 : 0.012);
      let next = fromNorm(n);
      if (snap(next) === current) next = current + dir * step; // always move at least one step
      if (setLive(next)) changedSinceCommit = true;
      commitSoon();
    }, { passive: false });

    root.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // let ⌘↑/⌘↓, ⌘S etc. reach the app
      const big = e.shiftKey || e.key === 'PageUp' || e.key === 'PageDown';
      const dn = big ? 0.1 : 0.01;
      let handled = true;
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'PageUp') {
        const next = fromNorm(toNorm(current) + dn); if (setLive(snap(next) === current ? current + step : next)) changedSinceCommit = true;
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'PageDown') {
        const next = fromNorm(toNorm(current) - dn); if (setLive(snap(next) === current ? current - step : next)) changedSinceCommit = true;
      } else if (e.key === 'Home') { if (setLive(min)) changedSinceCommit = true; }
      else if (e.key === 'End') { if (setLive(max)) changedSinceCommit = true; }
      else if (e.key === 'Enter') { startEdit(); }
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); if (e.key !== 'Enter') commitSoon(); }
    });

    function startEdit() {
      if (val.tagName === 'INPUT') return;
      ui.editing = true;
      const input = el('input', { class: 'val', value: o.fmt(current).replace(/[^0-9.+\-k]/gi, ''), 'aria-label': o.label + ' value' });
      val.replaceWith(input);
      val = input;
      input.focus();
      input.select();
      let done = false;
      const finish = (apply) => {
        if (done) return;
        done = true;
        ui.editing = false;
        if (apply) {
          const parsed = o.parse ? o.parse(input.value) : parseFloat(input.value);
          if (Number.isFinite(parsed)) { if (setLive(parsed)) changedSinceCommit = true; commitNow(); }
        }
        const back = el('div', { class: 'val' });
        input.replaceWith(back);
        val = back;
        back.addEventListener('click', startEdit);
        draw();
        root.focus({ preventScroll: true });
        render();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
    }
    val.addEventListener('click', startEdit);
    return root;
  }

  // ------------------------------------------------------------------ model picker
  let pop = null;
  function closePopover() { if (pop) { pop.remove(); pop = null; } }

  // Right-click menus. `items`: [{ label, action, disabled, danger }] or '-' for a separator.
  let ctx = null;
  function closeContextMenu() { if (ctx) { ctx.remove(); ctx = null; document.removeEventListener('keydown', ctxKey, true); } }
  function ctxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); } }
  function contextMenu(e, items) {
    e.preventDefault(); e.stopPropagation();
    closeContextMenu(); closePopover();
    const menu = el('div', { class: 'ctx', role: 'menu' }, ...items.map(it => it === '-' ? el('div', { class: 'sep' }) : el('button', {
      class: 'ctx-item' + (it.danger ? ' danger' : ''), role: 'menuitem', disabled: it.disabled ? 'true' : null,
      onclick: () => { closeContextMenu(); it.action(); },
    }, it.label)));
    menu.style.visibility = 'hidden';
    const bg = el('div', { class: 'ctx-bg', oncontextmenu: (ev) => { ev.preventDefault(); if (ui.stageContextNativePending) { ui.stageContextNativePending = false; return; } closeContextMenu(); }, onmousedown: (ev) => { if (ev.target === bg) closeContextMenu(); } }, menu);
    document.body.append(bg); ctx = bg;
    requestAnimationFrame(() => {
      if (ctx !== bg) return;
      const bounds = bg.getBoundingClientRect();
      const margin = 8;
      const maxWidth = Math.max(0, bounds.width - margin * 2);
      const maxHeight = Math.max(0, bounds.height - margin * 2);
      menu.style.setProperty('--ctx-max-width', maxWidth + 'px');
      menu.style.setProperty('--ctx-max-height', maxHeight + 'px');
      const r = menu.getBoundingClientRect();
      const pointerX = e.clientX - bounds.left;
      const pointerY = e.clientY - bounds.top;
      const maxLeft = Math.max(margin, bounds.width - r.width - margin);
      const maxTop = Math.max(margin, bounds.height - r.height - margin);
      const left = pointerX + r.width > bounds.width - margin ? pointerX - r.width : pointerX;
      const top = pointerY + r.height > bounds.height - margin ? pointerY - r.height : pointerY;
      menu.style.left = Math.min(Math.max(left, margin), maxLeft) + 'px';
      menu.style.top = Math.min(Math.max(top, margin), maxTop) + 'px';
      menu.style.visibility = '';
      document.addEventListener('keydown', ctxKey, true);
      const first = menu.querySelector('button:not(:disabled)'); if (first) first.focus();
    });
  }
  window.__contextMenu = contextMenu;
  window.__closePopover = closePopover;

  // Searchable popover list, used for effect models and the pedal's library.
  // items: { name, cat, sub?, subNode? }; onPick(item) runs after the popover closed. `sub` is searched and
  // shown as the row tooltip; `subNode` (nodes, e.g. kind icons + author) is shown under the name.
  function pickerPopover({ anchor, label, color, placeholder, items: all, isCurrent, emptyText, onPick }) {
    if (pop) { closePopover(); return; }
    const search = el('input', { class: 'search', type: 'search', placeholder, 'aria-label': placeholder, spellcheck: 'false' });
    const list = el('div', { class: 'pop-list', role: 'listbox' });
    pop = el('div', { class: 'pop', role: 'dialog', 'aria-label': label, style: '--c:' + color }, search, list);
    document.body.append(pop);

    const r = anchor.getBoundingClientRect();
    const top = Math.min(r.bottom + 6, window.innerHeight - 40 - Math.min(460, window.innerHeight * 0.7));
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 328)) + 'px';
    pop.style.top = Math.max(8, top) + 'px';

    let items = [];
    let hl = Math.max(0, all.findIndex(isCurrent));
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      items = all.filter(m => !q || m.name.toLowerCase().includes(q) || m.cat.toLowerCase().includes(q) || (m.sub || '').toLowerCase().includes(q));
      hl = Math.max(0, Math.min(hl, items.length - 1));
      const kids = [];
      let lastCat = null;
      items.forEach((m, i) => {
        if (m.cat !== lastCat) { kids.push(el('div', { class: 'pop-group', text: m.cat })); lastCat = m.cat; }
        // Nodes can only live in one place, so each draw clones the item's subtitle.
        const subKids = m.subNode && [].concat(m.subNode).map(n => n.cloneNode(true));
        kids.push(el('div', {
          class: 'pop-item' + (i === hl ? ' hl' : '') + (isCurrent(m) ? ' cur' : '') + (subKids ? ' two' : ''),
          role: 'option', 'aria-selected': String(i === hl), dataset: { i }, title: m.sub || null,
          onmousemove: () => { if (hl !== i) { hl = i; draw(); } },
          onclick: () => pick(i),
        }, subKids ? el('div', { class: 'txt' }, el('span', { class: 'name', text: m.name }), el('span', { class: 'sub' }, subKids)) : m.name));
      });
      if (!items.length) kids.push(el('div', { class: 'pop-none', text: emptyText(search.value) }));
      list.replaceChildren(...kids);
      const h = list.querySelector('.hl');
      if (h) h.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => {
      const m = items[i];
      if (!m) return;
      closePopover();
      onPick(m);
    };
    search.addEventListener('input', () => { hl = 0; draw(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(items.length - 1, hl + 1); draw(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(0, hl - 1); draw(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(hl); }
      else if (e.key === 'Escape') { e.preventDefault(); closePopover(); anchor.focus(); }
      e.stopPropagation();
    });
    draw();
    search.focus();
  }

  function openModelPicker(key, anchor) {
    const b = state.blocks[key];
    pickerPopover({
      anchor, color: stage(key).color, label: 'Choose an effect for ' + b.title, placeholder: 'Search effects',
      items: b.models.map(m => ({ name: m.name, cat: m.name === 'None' ? 'Empty slot' : (m.category || 'Other') })),
      isCurrent: (m) => !b.unknownId && m.name === b.model,
      emptyText: (q) => 'No effects match “' + q + '”.',
      onPick: (m) => {
        chooseModel(key, m.name);
        const btn = document.querySelector('[data-fk="picker-' + key + '"]');
        if (btn) btn.focus({ preventScroll: true });
      },
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (pop && !pop.contains(e.target) && !e.target.closest('.picker-btn, [data-fk="usage-capture"], [data-fk="metro-levels"], [data-fk="exp-add"], .exp-target')) closePopover();
  });

  // ------------------------------------------------------------------ veil, status, log
  function renderVeil() {
    const v = $('veil');
    if (state.connected) { v.hidden = true; return; }
    v.hidden = false;
    const bt = !!navigator.bluetooth && !window.__FORCE_DEMO; // the web preview can't reach a pedal
    const busy = ui.connecting || /requesting|connecting/i.test(ui.connText);
    const kbd = (t) => el('kbd', { text: t });
    v.replaceChildren(el('div', { class: 'veil-card', role: 'dialog', 'aria-labelledby': 'veilTitle' },
      el('div', { class: 'eyebrow', text: 'Bluetooth' }),
      el('h2', { id: 'veilTitle', text: bt ? 'Connect your Nano Cortex' : 'Bluetooth isn’t available here' }),
      bt ? el('ol', { class: 'steps' },
        el('li', {}, el('b', { text: 'Power on the pedal.' }), ' Close Cortex Cloud on your phone; the pedal takes one connection at a time.'),
        el('li', {}, el('b', { text: 'Make it visible.' }), ' After a power-up, hold ', kbd('EXIT'), ' + ', kbd('CAPTURE'), ' for a second until the Gain ring lights up. After a plain disconnect it stays reachable.'),
        el('li', {}, el('b', { text: 'Connect.' }), ' Allow Bluetooth if your Mac asks; the app picks the pedal by itself.'))
        : el('p', { text: 'This window can’t reach Bluetooth devices. You can still explore the editor with demo data.' }),
      ui.connectError ? el('p', { class: 'err' }, ui.connectError, ui.connectHelp ? [' ', linkEl(LINKS.troubleshooting, 'Troubleshooting', 'veil-troubleshoot')] : null) : null,
      el('div', { class: 'row' },
        bt ? el('button', { class: 'btn primary', disabled: busy, onclick: doConnect, dataset: { fk: 'veil-connect' } }, busy ? 'Connecting…' : 'Connect') : null,
        el('button', { class: 'btn' + (bt ? '' : ' primary'), onclick: () => demo.start(), dataset: { fk: 'veil-demo' } }, 'Explore with demo data')),
      el('p', { class: 'veil-help' }, 'New here? ', linkEl(LINKS.manual, 'Read the manual', 'veil-manual'))));
  }

  const renderStatusSoon = debounce(() => renderStatus(), 60);
  function renderStatus() {
    // Left: the one connection indicator (the header has none): what we're talking to, or that we're connecting.
    const ble = state.connected;
    const busy = !ble && (ui.connecting || /requesting|connecting/i.test(ui.connText));
    $('bleLed').className = 'led' + (ble ? ' on' : busy ? ' busy' : '');
    $('bleText').textContent = ui.demo ? 'Demo data, nothing is sent' : ble ? 'Connected to Nano Cortex' + (state.firmware ? ' · firmware ' + state.firmware : '') : busy ? 'Connecting…' : 'No pedal';
    // Only speaks up when the pedal itself reports something worth knowing.
    const note = ble && ui.presetUnknown ? 'Current preset unknown: Refresh to read it' : ble && pedalDirtyForUI() ? 'Pedal reports unsaved changes' : '';
    $('pcText').textContent = note;
    $('pcText').parentElement.hidden = !note;
    // "Sent: <protocol label>" is a developer detail; progress like "Saving preset 3…" is for everyone.
    $('lastAction').textContent = devTools || !/^Sent: /.test(ui.lastAction) ? ui.lastAction : '';
    $('drawerBtn').classList.toggle('on', ui.drawerOpen);
    $('recBtn').classList.toggle('on', rec.on);
    $('recBtn').textContent = rec.on ? 'Recording ' + rec.events.length : 'Record';
  }

  function renderLog() {
    const v = $('logView');
    const atBottom = v.scrollTop + v.clientHeight >= v.scrollHeight - 8;
    v.replaceChildren(...ui.logs.slice(-300).map(l => el('div', { class: l.cls }, el('span', { class: 'ts', text: l.ts }), l.text)));
    if (atBottom) v.scrollTop = v.scrollHeight;
  }

  function toggleDrawer() {
    if (!ui.drawerOpen && !devTools) return;   // the Activity drawer is a developer tool
    ui.drawerOpen = !ui.drawerOpen;
    $('drawer').classList.toggle('open', ui.drawerOpen);
    if (ui.drawerOpen) { renderLog(); const v = $('logView'); v.scrollTop = v.scrollHeight; }
    renderStatus();
  }

  // ------------------------------------------------------------------ developer tools
  // Settings → General → Advanced → Developer tools (settings.devTools, off by default). Off hides the Activity
  // drawer and ⌘L, Record, the "Sent: …" status text, Raw settings and the hashes (everything marked .dev-only),
  // and the shell drops View → Classic Editor, Reload Current and Developer Tools. The log itself is always kept
  // (ui.logs, and the shell's log file: Help → Show Log File).
  function applyDevTools() {
    document.body.classList.toggle('dev-tools', devTools);
    if (!devTools) {
      if (rec.on) toggleRecording(true);   // stops and saves it to the recordings folder, with the usual toast
      if (ui.drawerOpen) toggleDrawer();
    }
    renderStatus();
  }
  function setDevTools(on) {
    devTools = !!on;
    pref.set('devTools', devTools);
    applyDevTools();
    if (shellBridge && shellBridge.setDevTools) shellBridge.setDevTools(devTools).catch(() => {});
  }
  window.__devTools = { get on() { return devTools; }, set: setDevTools };

  // ------------------------------------------------------------------ updates (desktop app)
  // The shell (src/updates.js) checks GitHub Releases and sends events here; this draws the modal and sends the
  // answers back. Without the shell (the UX test) __updates.event() drives it and the answers collect in
  // __updates.actions.
  //   events: checking | none | error {message} | available {version, notes, url, mode: 'install' | 'notify'}
  //           | progress {percent} | downloaded {version}
  const upd = { box: null, stage: '', version: '', actions: [] };
  function updAnswer(what) {
    upd.actions.push(what);
    if (shellBridge && shellBridge.updateAction) shellBridge.updateAction(what, upd.version).catch(() => {});
  }
  function closeUpdate() {
    const b = upd.box;
    if (!b) return;
    upd.box = null; upd.stage = '';
    b.bg.remove();
    document.removeEventListener('keydown', b.onKey, true);
  }
  // Esc and a click outside mean "not now": Remind me later, or Later once downloaded. Nothing while downloading.
  function updDismiss() {
    if (upd.stage === 'available') { updAnswer('later'); closeUpdate(); }
    else if (upd.stage === 'downloaded') { updAnswer('later'); closeUpdate(); toast('The update installs when you quit.'); }
  }
  function updateModal() {
    if (upd.box) return upd.box;
    const title = el('h2', { dataset: { fk: 'upd-title' } });
    const notes = el('p', { class: 'upd-notes', dataset: { fk: 'upd-notes' } });
    const more = el('p', { class: 'upd-more' });
    const bar = el('div', { class: 'upd-bar' }, el('span'));
    const pct = el('span', { class: 'upd-pct', dataset: { fk: 'upd-pct' } });
    const progress = el('div', { class: 'upd-progress', dataset: { fk: 'upd-progress' }, hidden: true }, bar, pct);
    const row = el('div', { class: 'row' });
    const dialog = el('div', { class: 'modal upd-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'updTitle', dataset: { fk: 'upd-modal' } }, title, notes, more, progress, row);
    title.id = 'updTitle';
    const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) updDismiss(); } }, dialog);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); updDismiss(); return; }
      if (e.key === 'Tab') {
        const f = [...bg.querySelectorAll('button:not(:disabled), a[href]')];
        const i = f.indexOf(document.activeElement);
        e.preventDefault();
        if (f.length) f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(bg);
    upd.box = { bg, title, notes, more, progress, bar, pct, row, onKey };
    return upd.box;
  }
  const updButtons = (b, list) => {
    b.row.replaceChildren(...list.map(([id, label, primary]) => el('button', { class: 'btn' + (primary ? ' primary' : ''), dataset: { fk: 'upd-' + id }, onclick: () => updClick(id) }, label)));
    const p = b.row.querySelector('.primary');
    if (p) p.focus();
  };
  function updClick(id) {
    if (id === 'download') {
      updAnswer('download');
      if (upd.mode === 'install') { upd.stage = 'downloading'; updateEvent({ type: 'progress', percent: 0 }); }
      else closeUpdate();   // the release page opens in the browser
    } else if (id === 'skip') { updAnswer('skip'); closeUpdate(); }
    else if (id === 'later') updDismiss();
    else if (id === 'restart') { updAnswer('restart'); upd.stage = 'restarting'; upd.box.row.replaceChildren(); }
  }
  function updateEvent(ev) {
    if (!ev || !ev.type) return;
    if (ev.type === 'checking') { toast('Checking for updates\u2026'); return; }
    if (ev.type === 'none') { toast('You\u2019re up to date.'); return; }
    if (ev.type === 'error') {
      closeUpdate();
      toast((ev.during === 'download' ? 'The update couldn\u2019t be downloaded: ' : ev.during === 'install' ? 'The update couldn\u2019t be installed: '
        : 'Couldn\u2019t check for updates: ') + ev.message);
      return;
    }
    if (ev.type === 'available') {
      Object.assign(upd, { stage: 'available', version: String(ev.version), mode: ev.mode === 'install' ? 'install' : 'notify' });
      const b = updateModal();
      b.title.textContent = 'Version ' + upd.version + ' is available';
      b.notes.textContent = ev.notes || '';
      b.notes.hidden = !ev.notes;
      b.more.replaceChildren(linkEl(ev.url || LINKS.releases, 'Full release notes', 'upd-notes-link'));
      b.more.hidden = false;
      b.progress.hidden = true;
      updButtons(b, [['skip', 'Skip this version'], ['later', 'Remind me later'],
        upd.mode === 'install' ? ['download', 'Download and install', true] : ['download', 'Download', true]]);
      return;
    }
    if (ev.type === 'progress') {
      if (!upd.box) return;
      upd.stage = 'downloading';
      const p = Math.max(0, Math.min(100, Math.round(ev.percent || 0)));
      upd.box.progress.hidden = false;
      upd.box.bar.firstChild.style.width = p + '%';
      upd.box.pct.textContent = 'Downloading\u2026 ' + p + '\u202f%';
      upd.box.row.replaceChildren();
      return;
    }
    if (ev.type === 'downloaded') {
      Object.assign(upd, { stage: 'downloaded', version: String(ev.version) });
      const b = updateModal();
      b.title.textContent = 'Version ' + upd.version + ' is ready';
      b.notes.hidden = !b.notes.textContent;
      b.more.hidden = !b.more.textContent;
      b.progress.hidden = true;
      updButtons(b, [['later', 'Later'], ['restart', 'Restart to update', true]]);
    }
  }
  window.__updates = { event: updateEvent, close: closeUpdate, get stage() { return upd.stage; }, actions: upd.actions };
  if (shellBridge && shellBridge.onUpdate) shellBridge.onUpdate(updateEvent);

  // ------------------------------------------------------------------ toast + modal
  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // cls: extra class on the dialog. enterSubmits: false lets Enter reach controls in `content` (a settings sheet)
  // instead of meaning "the primary button".
  function modal({ title, body, buttons, content, wide, focus, cls, enterSubmits = true }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const close = (id) => { bg.remove(); document.removeEventListener('keydown', onKey, true); if (prev) prev.focus({ preventScroll: true }); resolve(id); };
      const btns = buttons.map(b => el('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: () => close(b.id) }, b.label));
      const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(null); } },
        el('div', { class: 'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          el('h2', { text: title }), body ? el('p', { text: body }) : null, content || null,
          el('div', { class: 'row' }, btns)));
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
        if (e.key === 'Enter' || e.key === ' ') {
          const i = btns.indexOf(document.activeElement);
          if (i >= 0) { e.preventDefault(); e.stopPropagation(); close(buttons[i].id); return; }
          if (e.key === 'Enter' && !enterSubmits && typingTarget(e.target)) return;   // a typed value commits on Enter (Settings → Device)
          if (e.key === 'Enter' && enterSubmits) { // Enter anywhere else in the dialog = the primary action
            e.preventDefault(); e.stopPropagation();
            close((buttons.find(b => b.primary) || buttons[buttons.length - 1]).id); return;
          }
        }
        if (e.key === 'Tab') { // keep focus inside
          const f = [...bg.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
          const i = f.indexOf(document.activeElement);
          e.preventDefault();
          f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
        }
        e.stopPropagation();
      };
      document.addEventListener('keydown', onKey, true);
      document.body.append(bg);
      if (focus) { focus.focus(); if (focus.select) focus.select(); }
      else (btns.find((_, i) => buttons[i].primary) || btns[btns.length - 1]).focus();
    });
  }

  function showShortcuts() {
    const m = '⌘';   // keyLabel() below turns it into Ctrl+ on Windows and Linux
    const rows = [
      [m + 'S', 'Save to the current preset'],
      ['\u21e7' + m + 'S', 'Save as a new preset, in another slot'],
      [m + ',', 'Settings'],
      [m + '1  /  ' + m + '2', 'Editor / Cortex Cloud tab'],
      ['Right-click', 'A preset: load, rename, save here, delete. A chain node: bypass, change effect, clear. A slot: load, put a library item here, capture info'],
      [m + '↑  /  ' + m + '↓', 'Previous / next preset'],
      ['1 – 8', 'Select a stage in the chain'],
      ['←  /  →', 'Previous / next stage'],
      ['B', 'Bypass or turn on the selected stage'],
      ['E', 'Expression pedal assignments'],
      ['M', 'Change the effect in the selected slot'],
      [m + 'F', 'Filter presets'],
      ...(devTools ? [[m + 'L', 'Show Bluetooth activity'], ['Record', 'In the status bar: record every packet, then save it as JSON']] : []),
      ['T', 'Tuner (Esc closes it)'],
      ['N', 'Metronome (Space starts and stops it)'],
      ['Drag, scroll, arrows', 'Adjust a knob. Hold Shift for fine control'],
      ['Double-click a knob', 'Reset it'],
      ['Click a value', 'Type an exact value'],
    ];
    modal({
      title: 'Keyboard shortcuts', wide: true,
      content: el('div', {}, el('div', { class: 'keys' }, rows.flatMap(([k, d]) => [el('kbd', { text: keyLabel(k) }), el('span', { text: d })])),
        el('p', { class: 'keys-foot' }, linkEl(LINKS.manual, 'Full manual\u2026', 'keys-manual'))),
      buttons: [{ id: 'ok', label: 'Done', primary: true }],
    });
  }

  // ------------------------------------------------------------------ device page + capture info
  // Decoded from the phone app (trace 2026-10-09, docs/INVESTIGATION.md §11). Not in the upstream editor.
  //   46 {1:3 3:unixTime} → 47 {1:1 3:1 4:"" 5:firmware 6:serial 7:hash}            device info
  //   65 {1:3}            → 66 {1:1 3:1 5:name 6:brightness … 15:muteIn 16:muteOut 17:usbDb(f32) …} global settings
  //   67 {1:1 4:brightness 14:usbDb(f32)} → 68 {1:1 3:1}                           write (the app sends both)
  //   67 {1:1 12:muteIn} → 68 {1:1 3:1}; 67 {1:1 13:muteOut} → 68 {1:1 3:1}    monitoring writes (one field, explicit 0/1)
  //   17 {3:captureSlot−1 5:1} → 18 {1:6 3:1 7:{1,2 author} 8:"" 9:hash 10:name 11:record}   capture details
  //   91 {1:3}            → 92 {1:3 3:1 5:"2.2.1+06d34443" 6:serial 7:name}        keep-alive; full firmware + name
  // Settings writes are global: no Save, and the pedal reports nothing dirty (no 115 after them in the trace).
  const DEV_MSG = { ALIVE_REQ: 91, ALIVE: 92, INFO_REQ: 46, INFO: 47, SETTINGS_REQ: 65, SETTINGS: 66, SET: 67, SET_ACK: 68, CAPTURE_REQ: 17, CAPTURE: 18 };
  const DEV_MONITOR = Object.freeze({
    muteInput: { writeField: 12, readField: 15, tag: 0x60, label: 'Mute Input', note: 'Mutes the Guitar Input. USB input remains available.' },
    muteOutput: { writeField: 13, readField: 16, tag: 0x68, label: 'Mute Outputs 1L/2R', note: 'Mutes processed audio to Outputs 1L/2R. USB playback remains available.' },
  });
  const USB_DB = { min: -20, max: 0, step: 0.5 };
  const dev = { info: null, alive: null, settings: null, reading: false, redraw: null, capWait: null,
    monitorPending: {}, monitorAcks: [], monitorReadTimer: null, muteInputRevision: 0,
    settingsRequestedForConnection: false };
  window.__dev = dev;
  // Tuner and Mute Input: the pedal still reports the input muted after the tuner closes, but its audio path needs a
  // fresh off → on edge to mute again (seen on a pedal, #14). So: note the mute when the tuner opens; when it closes,
  // wait for the tuner-off write, let the pedal settle 200 ms, then send off and, 100 ms after that write, on again,
  // unless the user changed the mute meanwhile.
  let tunerMuteSnapshot = null;
  const coreOpenTuner = window.openTuner;
  window.openTuner = function () {
    tunerMuteSnapshot = state.connected && dev.settings ? { muted: Boolean(dev.settings.muteInput), revision: dev.muteInputRevision } : null;
    return coreOpenTuner.apply(this, arguments);
  };
  const coreCloseTuner = window.closeTuner;
  window.closeTuner = function () {
    const wasOpen = state.tuner.open;
    const snapshot = wasOpen ? tunerMuteSnapshot : null;
    if (wasOpen) tunerMuteSnapshot = null;
    const result = coreCloseTuner.apply(this, arguments);
    if (snapshot && snapshot.muted && state.connected) {
      // Writes leave in order, so an empty queue means the tuner-off write (if any) has gone out.
      waitUntil(() => !gattWriteQueue.length && !gattWritePumpRunning, 3000)
        .then(() => new Promise(r => setTimeout(r, 200)))
        .then(() => rearmInputMute(snapshot));
    }
    return result;
  };
  function rearmInputMute(snapshot) {
    if (!state.connected || state.tuner.open || !dev.settings || dev.muteInputRevision !== snapshot.revision) return;
    const off = writeMonitorSetting('muteInput', false);
    const revision = dev.muteInputRevision;
    if (!off) return;
    off.then((sent) => {
      if (!sent) return;
      setTimeout(() => {
        if (!state.connected || state.tuner.open || dev.muteInputRevision !== revision) return;
        writeMonitorSetting('muteInput', true);
      }, 100);
    });
  }
  // Varint that stays exact past 2^31 (the Unix time is close to it).
  const varint = (n) => { const out = []; n = Math.max(0, Math.floor(n)); while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
  // A typed frame whose body may pass 255 bytes: bit 0 of the flags byte is the length's ninth bit.
  const longFrame = (payload, type) => { const body = [...payload, type & 0xFF, (type >> 8) & 0xFF, 0, 0]; return Uint8Array.from([body.length & 0xFF, 0xC0 | ((body.length >> 8) & 1), ...body]); };
  const typeOf = (d) => (d[d.length - 4] | (d[d.length - 3] << 8) | (d[d.length - 2] << 16) | (d[d.length - 1] << 24)) >>> 0;
  const bodyOf = (d) => parseProtoFields(Array.from(d.slice(2, d.length - 4)));
  const pf = {
    int: (f, n) => (f[n] && f[n][0] && f[n][0].wire === 0 ? f[n][0].value : undefined),
    str: (f, n) => (f[n] && f[n][0] && f[n][0].wire === 2 ? new TextDecoder().decode(Uint8Array.from(f[n][0].raw)) : ''),
    f32: (f, n) => (f[n] && f[n][0] && f[n][0].wire === 5 ? new DataView(Uint8Array.from(f[n][0].raw).buffer).getFloat32(0, true) : undefined),
    sub: (f, n) => (f[n] && f[n][0] && f[n][0].wire === 2 ? parseProtoFields(Array.from(f[n][0].raw)) : {}),
    strs: (f, n) => (f[n] || []).filter(x => x.wire === 2).map(x => new TextDecoder().decode(Uint8Array.from(x.raw))),
  };

  function readDevice() {
    if (!state.connected) return;
    dev.reading = true;
    requestDeviceSettings();
    writeC304('Read device info', buildFrame([0x08, 0x03, 0x18, ...varint(Date.now() / 1000)], DEV_MSG.INFO_REQ));
    writeC304('Keep-alive', buildFrame([0x08, 0x03], DEV_MSG.ALIVE_REQ));
    if (dev.redraw) dev.redraw();
  }
  function requestDeviceSettings() {
    if (!state.connected) return;
    writeC304('Read device settings', buildFrame([0x08, 0x03], DEV_MSG.SETTINGS_REQ));
  }
  function requestMonitorRead() {
    clearTimeout(dev.monitorReadTimer);
    dev.monitorReadTimer = setTimeout(() => {
      dev.monitorReadTimer = null;
      requestDeviceSettings();
    }, 20);
  }
  // One write carries both values, like the app: the one not being changed is resent as it is.
  // Coalesced while a slider is dragged (only the latest queued write goes out).
  function writeDeviceSettings(change) {
    const s = dev.settings;
    if (!state.connected || !s) return;
    Object.assign(s, change);
    const b = clamp(Math.round(s.brightness), 0, 255);
    const db = clamp(Math.round(s.usbDb / USB_DB.step) * USB_DB.step, USB_DB.min, USB_DB.max);
    Object.assign(s, { brightness: b, usbDb: db });
    writeC304('Device settings: LED brightness ' + b + ', USB playback ' + db.toFixed(1) + ' dB',
      buildFrame([0x08, 0x01, 0x20, ...varint(b), 0x75, ...float32LE(db)], DEV_MSG.SET), 'device-settings');
  }

  // Monitoring writes are deliberately independent of the brightness/USB write coalescer:
  // each click is a complete, ordered command and never waits for a pedal reply.
  function writeMonitorSetting(key, value) {
    const spec = DEV_MONITOR[key], s = dev.settings;
    if (!state.connected || !s || !spec) return;
    if (key === 'muteInput') dev.muteInputRevision++;
    const previous = Boolean(s[key]);
    const prior = dev.monitorPending[key];
    const seq = (prior ? prior.seq : 0) + 1;
    const pending = { key, value: Boolean(value), previous, seq };
    dev.monitorPending[key] = pending;
    s[key] = pending.value;
    const frame = buildFrame([0x08, 0x01, spec.tag, pending.value ? 1 : 0], DEV_MSG.SET);
    const ack = { ...pending, sent: false };
    dev.monitorAcks.push(ack);
    const writePromise = writeC304('Device monitoring: ' + spec.label + ' ' + (pending.value ? 'ON' : 'OFF'), frame);
    writePromise.then((ok) => {
      ack.sent = ok;
      if (!ok) {
        const i = dev.monitorAcks.indexOf(ack);
        if (i >= 0) dev.monitorAcks.splice(i, 1);
      }
      if (ok || dev.monitorPending[key] !== pending) return;
      delete dev.monitorPending[key];
      s[key] = previous;
      if (key === 'muteInput') renderMuteButton();
      if (dev.redraw) dev.redraw();
    });
    if (key === 'muteInput') renderMuteButton();
    return writePromise;
  }

  function onDeviceInfo(d) {
    const f = bodyOf(d);
    dev.info = { firmware: pf.str(f, 5), serial: pf.str(f, 6), hash: pf.str(f, 7), name: pf.str(f, 4) };
    if (/^\d+\.\d+/.test(dev.info.firmware)) state.firmware = dev.info.firmware;
    log('Device info: firmware ' + (dev.info.firmware || '?') + ', serial ' + (dev.info.serial || '?'));
    dev.reading = !dev.settings;
    if (dev.redraw) dev.redraw();
    renderStatusSoon();
  }
  function onDeviceSettings(d) {
    const f = bodyOf(d);
    const raw = Object.keys(f).map(Number).filter(n => n !== 1 && n !== 3).sort((a, b) => a - b).map(n => {
      const x = f[n][0];
      const v = x.wire === 0 ? String(x.value) : x.wire === 5 ? String(Math.round(pf.f32(f, n) * 100) / 100) : x.wire === 2 ? JSON.stringify(pf.str(f, n)) : hex(x.raw);
      return n + '=' + v;
    });
    // Protobuf leaves out zeros, so an absent field reads 0. A pending local
    // write wins over an older unsolicited/readback report until its value is seen.
    const next = { name: pf.str(f, 5), brightness: pf.int(f, 6) || 0, usbDb: pf.f32(f, 17) || 0, raw };
    for (const [key, spec] of Object.entries(DEV_MONITOR)) {
      const reported = Boolean(pf.int(f, spec.readField) || 0);
      const pending = dev.monitorPending[key];
      if (pending && reported !== pending.value) next[key] = pending.value;
      else {
        next[key] = reported;
        if (pending) delete dev.monitorPending[key];
      }
    }
    dev.settings = next;
    renderMuteButton();
    log('Device settings: "' + dev.settings.name + '", LED brightness ' + dev.settings.brightness + ', USB playback ' + dev.settings.usbDb.toFixed(1) + ' dB, input mute ' + (dev.settings.muteInput ? 'on' : 'off') + ', output mute ' + (dev.settings.muteOutput ? 'on' : 'off'));
    dev.reading = !dev.info;
    if (dev.redraw) dev.redraw();
  }
  function onAlive(d) {
    const f = bodyOf(d);
    dev.alive = { firmware: pf.str(f, 5), serial: pf.str(f, 6), name: pf.str(f, 7) };
    if (ui.previewing || irAudition.active) {
      const accepted = Boolean(f[3] && f[3][0] && f[3][0].value === 1);
      log('Live preview keep-alive ' + (accepted ? 'acknowledged.' : 'was not accepted.'));
    }
    if (dev.redraw) dev.redraw();
  }
  function onSettingsAck(d) {
    const ok = pf.int(bodyOf(d), 3) === 1;
    log('Device settings ' + (ok ? 'confirmed' : 'REFUSED: ' + hex(d)));
    const ack = dev.monitorAcks[0];
    // A type-68 has no setting discriminator. Do not consume a monitoring
    // record until its own queued write has completed; this keeps an earlier
    // brightness/USB ACK from being mistaken for a mute ACK.
    if (!ack || !ack.sent) return;
    dev.monitorAcks.shift();
    const pending = dev.monitorPending[ack.key];
    if (!ok) {
      if (pending && pending.seq === ack.seq) {
        delete dev.monitorPending[ack.key];
        if (dev.settings) dev.settings[ack.key] = ack.previous;
        if (ack.key === 'muteInput') renderMuteButton();
        if (dev.redraw) dev.redraw();
      }
      return;
    }
    requestMonitorRead();
  }
  function onCaptureDetails(d) {
    const f = bodyOf(d);
    const rec = pf.sub(f, 11);           // byte-identical to state field 34 for the active capture
    const by = pf.sub(f, 7), recBy = pf.sub(rec, 4);
    const desc = NanoText.storedDescription(pf.str(f, 8)) || pf.str(rec, 5);   // 18.8, else the record's own field 5
    const info = {
      ok: pf.int(f, 3) === 1,
      name: pf.str(f, 10) || pf.str(rec, 2),
      author: pf.str(by, 2) || pf.str(by, 1) || pf.str(recBy, 2) || pf.str(recBy, 1),
      description: NanoText.captureDescription(desc),   // "", blank, "null" or a bare Cloud ID: none
      cloudId: NanoText.captureCloudId(desc),           // the description is the capture's Cortex Cloud ID
      hash: pf.str(f, 9) || pf.str(rec, 1),
      type: pf.str(rec, 6), instrument: pf.str(rec, 10), tags: pf.strs(rec, 7),
    };
    log('Capture details: "' + info.name + '" by ' + (info.author || '?') + (info.ok ? '' : ' (status ' + pf.int(f, 3) + ')'));
    const w = dev.capWait; dev.capWait = null;
    if (w) w(info);
  }

  // Typed replies. 47/18 are long enough to set the length's ninth bit (flags 0xC1), which the core's frameType()
  // doesn't accept, so they are caught here before the core; 66 also goes on to the core (MIDI channel, field 8).
  const capReassemble = NanoTransfer.makeReassembler();
  const coreOnC305ForDevice = window.onC305;
  window.onC305 = function (event, ...rest) {
    try {
      const v = event && event.target && event.target.value;
      const d = v && v.buffer ? new Uint8Array(v.buffer.slice(0)) : null;
      if (d && d.length >= 6) {
        const flags = d[1];
        if ((flags & 0xC0) === 0xC0) {
          const t = typeOf(d);
          if (t === DEV_MSG.CAPTURE || t === DEV_MSG.INFO) {
            if (rec.on) recordEvent('rx', d);
            log('RX C305: ' + hex(d.slice(0, 24)) + (d.length > 24 ? ' ...' : ''));
            if (t === DEV_MSG.CAPTURE) onCaptureDetails(d); else onDeviceInfo(d);
            return;
          }
        } else if (dev.capWait && state.stateMode === 'idle') {
          // A capture-details reply split over several notifications (a smaller MTU than the 512 seen so far).
          const whole = capReassemble(d);
          if (whole && whole.length >= 4 && typeOf(whole) === DEV_MSG.CAPTURE) { onCaptureDetails(Uint8Array.from([0, 0xC0, ...whole])); return; }
        }
      }
    } catch (err) { log('ERROR: device reply: ' + err.message); }
    return coreOnC305ForDevice.apply(this, [event, ...rest]);
  };
  const coreTypedForDevice = window.handleTypedMessage;
  window.handleTypedMessage = function (data) {
    const t = frameType(data);
    if (t === DEV_MSG.INFO) { onDeviceInfo(data); return true; }
    if (t === DEV_MSG.SET_ACK) { onSettingsAck(data); return true; }
    if (t === DEV_MSG.ALIVE) { onAlive(data); return true; }
    if (t === DEV_MSG.CAPTURE) { onCaptureDetails(data); return true; }
    if (t === DEV_MSG.SETTINGS) { try { onDeviceSettings(data); } catch (err) { log('ERROR: settings parse: ' + err.message); } }
    return coreTypedForDevice.apply(this, arguments);
  };

  // Settings → Device. Built when the tab opens; the reads go out then.
  function devicePage() {
    const page = el('div', { class: 'dev-page', dataset: { fk: 'device-page' } });
    let dragging = false;
    const draw = () => {
      if (dragging) return;   // the reply to a read mid-drag must not yank the slider
      const on = state.connected, s = on ? dev.settings : null, i = (on && dev.info) || {}, k = (on && dev.alive) || {};
      const val = (t, fk, title, mono) => el('span', { class: 'dev-val' + (mono ? ' mono' : ''), text: t || (on && dev.reading ? 'Reading…' : '—'), title: title || null, dataset: { fk } });
      const can = on && !!s;   // each write carries both values, so nothing is sent before a settings read succeeded
      const pct = (v) => Math.round(v / 255 * 100) + '%';
      const bri = el('input', { type: 'range', min: '0', max: '255', step: '1', value: String(s ? s.brightness : 153), 'aria-label': 'LED brightness', dataset: { fk: 'dev-brightness' }, disabled: can ? null : 'true' });
      const briVal = el('span', { class: 'dev-num', text: s ? pct(s.brightness) : '' });
      bri.addEventListener('pointerdown', () => { dragging = true; });
      bri.addEventListener('input', () => { writeDeviceSettings({ brightness: Number(bri.value) }); briVal.textContent = pct(Number(bri.value)); });
      for (const ev of ['change', 'pointerup', 'pointercancel']) bri.addEventListener(ev, () => { dragging = false; });
      const usb = el('input', { type: 'range', min: String(USB_DB.min), max: String(USB_DB.max), step: String(USB_DB.step), value: String(s ? s.usbDb : -6), 'aria-label': 'USB playback volume', dataset: { fk: 'dev-usb' }, disabled: can ? null : 'true' });
      const usbNum = el('input', { class: 'num', type: 'text', inputmode: 'decimal', spellcheck: 'false', value: s ? s.usbDb.toFixed(1) : '', 'aria-label': 'USB playback volume in dB', dataset: { fk: 'dev-usb-num' }, disabled: can ? null : 'true' });
      usb.addEventListener('pointerdown', () => { dragging = true; });
      usb.addEventListener('input', () => { writeDeviceSettings({ usbDb: Number(usb.value) }); usbNum.value = dev.settings.usbDb.toFixed(1); });
      for (const ev of ['change', 'pointerup', 'pointercancel']) usb.addEventListener(ev, () => { dragging = false; });
      const typed = () => {
        const n = parseFloat(String(usbNum.value).replace(',', '.'));
        if (!Number.isFinite(n) || n === dev.settings.usbDb) { usbNum.value = dev.settings.usbDb.toFixed(1); return; }
        writeDeviceSettings({ usbDb: n });
        usbNum.value = dev.settings.usbDb.toFixed(1); usb.value = String(dev.settings.usbDb);
      };
      usbNum.addEventListener('change', typed);
      usbNum.addEventListener('focus', () => usbNum.select());
      usbNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); typed(); usbNum.select(); } });
      const muteInput = toggleSwitch('dev-mute-input', 'Mute Input', !!(s && s.muteInput), (v) => writeMonitorSetting('muteInput', v), !can);
      const muteOutput = toggleSwitch('dev-mute-output', 'Mute Outputs 1L/2R', !!(s && s.muteOutput), (v) => writeMonitorSetting('muteOutput', v), !can);
      const again = el('button', { class: 'btn small', dataset: { fk: 'dev-read' }, disabled: on ? null : 'true', onclick: () => readDevice() }, 'Read again');
      const raw = el('details', { class: 'dev-raw', dataset: { fk: 'dev-raw' } }, el('summary', { text: 'Raw settings' }),
        el('p', { class: 'set-note', text: s ? '66: ' + s.raw.join('  ') : 'Not read yet.' }),
        el('p', { class: 'set-note', text: 'Read only. Other fields are not mapped to settings yet.' }));
      const setting = (title, note, ...ctl) => el('div', { class: 'dev-setting' },
        el('div', { class: 'dev-text' }, el('div', { class: 'dev-title', text: title }), el('div', { class: 'dev-note', text: note })),
        el('div', { class: 'dev-ctl' }, ...ctl));
      const hash = i.hash || '';
      page.replaceChildren(...[
        on ? null : setNote('Connect the pedal to see and change its settings.', 'dev-offline'),
        el('section', {}, el('h3', { text: 'About' }),
          setRow('Name', val((s && s.name) || k.name, 'dev-name')),
          setRow('Firmware', val(k.firmware || i.firmware || (on ? state.firmware : ''), 'dev-firmware')),
          setRow('Serial', val(i.serial || k.serial, 'dev-serial', null, true)),
          devOnly(setRow('Hash', val(hash.length > 16 ? hash.slice(0, 8) + '…' + hash.slice(-6) : hash, 'dev-hash', hash, true)))),
        el('section', {},
          setting('LED brightness', 'The pedal’s LEDs. The manual’s default is 60%.', bri, briVal),
          setting('USB playback volume', 'Audio from the computer over USB. Default −6.0 dB.', usb, usbNum, el('span', { class: 'set-unit', text: 'dB' }))),
        el('section', {},
          el('h3', { text: 'Monitoring' }),
          setting('Mute Guitar Input', DEV_MONITOR.muteInput.note, muteInput),
          setting('Mute Guitar Output', DEV_MONITOR.muteOutput.note, muteOutput)),
        el('section', { class: 'dev-only' }, raw),
        el('div', { class: 'dev-foot' }, setNote('Global settings: they apply on the pedal right away, not per preset.'), again)].filter(Boolean));
    };
    dev.redraw = draw;
    draw();
    readDevice();
    return page;
  }

  // Capture info: "Info…" in the capture node's and the capture slots' context menus. A popover like the native
  // app's: slot, name, author, kind icons, tag chips, description, hash with Copy. slot is 1-based.
  // A capture whose description is just its Cortex Cloud ID gets "Open in Cortex Cloud" there instead: the shell
  // (nanoShell.openCloudCapture → src/main.js) loads that capture's page in the Cloud tab. Nothing goes to the pedal.
  // Without the shell (the web preview) there is no Cloud tab, so no button. The UX test sets its own opener.
  let openCloudCapture = shellBridge && shellBridge.openCloudCapture ? (id) => shellBridge.openCloudCapture(id) : null;
  window.__setCloudCaptureOpener = (fn) => { openCloudCapture = typeof fn === 'function' ? fn : null; };
  const slotLabel = (slot) => Math.ceil(slot / 5) + 'ABCDE'[(slot - 1) % 5];
  const shortHash = (h) => (h && h.length > 16 ? h.slice(0, 8) + '…' + h.slice(-6) : h || '');
  async function openCaptureInfo(slot, anchor) {
    if (!state.connected || !slot) return;
    closePopover();
    const box = el('div', { class: 'cap-body' }, el('p', { class: 'cap-note', text: 'Reading slot ' + slotLabel(slot) + ' from the pedal…' }));
    const p = el('div', { class: 'pop cap-info', role: 'dialog', 'aria-label': 'Capture info', dataset: { fk: 'cap-info' }, style: '--c:' + stage('capture').color },
      el('div', { class: 'cap-eyebrow', text: 'Capture ' + slotLabel(slot), title: 'Slot ' + slot }),
      el('div', { class: 'cap-name', text: state.captureNames.get(slot) || ('Capture ' + slot), dataset: { fk: 'cap-name' } }), box);
    pop = p;
    document.body.append(p);
    const place = () => {
      const r = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : { left: window.innerWidth / 2 - 170, bottom: 120 };
      p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - p.offsetWidth - 8)) + 'px';
      p.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 8)) + 'px';
    };
    place();
    const info = await new Promise((resolve) => {
      const done = (i) => { clearTimeout(timer); resolve(i); };
      const timer = setTimeout(() => { if (dev.capWait === done) dev.capWait = null; resolve(null); }, 4000);
      dev.capWait = done;
      writeC304('Capture details slot ' + slot, buildFrame([0x18, ...varint(slot - 1), 0x28, 0x01], DEV_MSG.CAPTURE_REQ));
    });
    if (pop !== p) return;   // closed meanwhile
    if (!info) { box.replaceChildren(el('p', { class: 'cap-note', text: 'The pedal did not answer. Try again.' })); place(); return; }
    if (info.name) p.querySelector('.cap-name').textContent = info.name;
    const kind = (table, word) => {
      if (!word) return null;
      const k = CAPTURE_KINDS[table][String(word).toLowerCase()];
      if (k === null) return null;   // "default" / "instrument_not_set": unknown
      return el('span', { class: 'cap-kind', dataset: { fk: 'cap-' + table } }, kindIcon(table, word), k ? k.label : String(word).replace(/_/g, ' '));
    };
    const kinds = [kind('type', info.type), kind('instrument', info.instrument)].filter(Boolean);
    const copy = el('button', { class: 'btn ghost small', dataset: { fk: 'cap-copy' }, disabled: info.hash ? null : 'true', onclick: async () => {
      try { await navigator.clipboard.writeText(info.hash); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    } }, 'Copy');
    // replaceChildren() would turn a left-out part (null) into the text "null": that was the "null" under the tags.
    box.replaceChildren(...[
      info.author ? el('div', { class: 'cap-by', dataset: { fk: 'cap-author' } }, 'by ' + info.author) : null,
      kinds.length ? el('div', { class: 'cap-kinds' }, kinds) : null,
      info.tags.length ? el('div', { class: 'chips', dataset: { fk: 'cap-tags' } }, info.tags.map(t => el('span', { class: 'chip', text: t }))) : null,
      info.description ? el('p', { class: 'cap-desc', text: info.description, dataset: { fk: 'cap-desc' } }) : null,
      info.cloudId && openCloudCapture ? el('button', {
        class: 'btn ghost small cap-cloud', type: 'button', dataset: { fk: 'cap-cloud-link' },
        title: 'Open this capture\u2019s page in the Cortex Cloud tab',
        onclick: () => {
          const id = info.cloudId;
          closePopover();
          log('Opening capture ' + id + ' in Cortex Cloud');
          Promise.resolve(openCloudCapture(id)).catch(() => {});
        },
      }, 'Open in Cortex Cloud') : null,
      el('div', { class: 'cap-hash dev-only' }, el('span', { class: 'k', text: 'Hash' }), el('span', { class: 'v', text: shortHash(info.hash) || '—', title: info.hash || null, dataset: { fk: 'cap-hash' } }), copy),
    ].filter(Boolean));
    place();
  }
  window.__openCaptureInfo = openCaptureInfo;

  // ------------------------------------------------------------------ settings
  // ⌘, (Ctrl+, elsewhere), the app menu, or Settings in the status bar. Every change applies at once;
  // Done just closes the sheet.
  let settingsOpen = false;
  function toggleSwitch(fk, label, on, onChange, disabled) {
    const b = el('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': String(!!on), dataset: { fk }, disabled: disabled ? 'true' : null,
      onclick: () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); b.setAttribute('aria-checked', String(v)); onChange(v); },
    }, el('span', { class: 'track' }), el('span', { text: label }));
    return b;
  }
  const setRow = (label, ...ctl) => el('div', { class: 'set-row' }, el('span', { class: 'set-label', text: label }), el('div', { class: 'set-ctl' }, ...ctl));
  const setNote = (text, fk) => el('p', { class: 'set-note', text, dataset: fk ? { fk } : null });
  const devOnly = (node) => { node.classList.add('dev-only'); return node; };

  // tab: 'general' (default), 'device' or 'about'.
  async function openSettings(tab) {
    if (settingsOpen) return;
    if (document.querySelector('.modal-bg')) return;   // another dialog is up
    closePopover(); closeContextMenu();
    if (metro.open) toggleMetro();
    settingsOpen = true;
    const shellInfo = shellBridge ? await shellBridge.getSettings().catch(() => null) : null;
    const desktopOnly = 'Only in the desktop app.';

    // Appearance
    const current = accentOf(pref.get('accent', ACCENTS[0].hex));
    const swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Accent colour' });
    const drawSwatches = (sel) => swatches.replaceChildren(...ACCENTS.map(a => el('button', {
      class: 'swatch' + (a.id === sel.id ? ' on' : ''), role: 'radio', 'aria-checked': String(a.id === sel.id), 'aria-label': a.name, title: a.name,
      style: '--sw:' + a.hex, dataset: { fk: 'accent-' + a.id },
      onclick: () => { drawSwatches(setAccent(a.hex)); swatches.querySelector('.on').focus(); },
    })));
    drawSwatches(current);
    const iconWord = isMac ? 'Dock icon' : 'Window icon';
    const dock = toggleSwitch('set-dock', iconWord + ' follows the accent', pref.get('dockFollowsAccent', true), (v) => {
      pref.set('dockFollowsAccent', v);
      if (shellBridge) shellBridge.setAccent(pref.get('accent', ACCENTS[0].hex), v).catch(() => {});
    }, !shellBridge);

    // Metronome (same "metronome" key as the overlay)
    // Sounds: per role a menu (the built-in voices, the custom sample when set, "Custom sample…"), ▶, and with a custom
    // sample its file name and Reset. Picking a built-in while a sample is set also drops the sample.
    const playIcon = () => { const i = sv('svg', { width: '10', height: '10', viewBox: '0 0 10 10', 'aria-hidden': 'true' }); i.append(sv('path', { d: 'M2.2 1.3v7.4L8.6 5z', fill: 'currentColor' })); return i; };
    const soundMsg = el('p', { class: 'set-note snd-msg', hidden: true, dataset: { fk: 'set-sound-msg' } });
    const showSoundMsg = (text) => { soundMsg.textContent = text || ''; soundMsg.hidden = !text; };
    const soundRow = (role, label) => {
      const ctl = el('div', { class: 'set-ctl' });
      const draw = (focus) => {
        const custom = metro.samples[role];
        const sel = el('select', { class: 'select', 'aria-label': label + ' sound', dataset: { fk: 'set-sound-' + role } },
          VOICE_IDS.map(id => el('option', { value: id, selected: !custom && id === metro.sounds[role] }, VOICES[id].name)),
          custom ? el('option', { value: 'custom', selected: true }, 'Custom') : null,
          el('hr'),
          el('option', { value: 'pick', disabled: samples.bridge ? null : 'true' }, 'Custom sample\u2026'));
        sel.addEventListener('change', async () => {
          const v = sel.value;
          sel.disabled = true;
          if (v === 'pick') { const r = await pickSample(role); if (!r.canceled) showSoundMsg(r.error); }
          else if (VOICE_IDS.includes(v)) { await resetSample(role); metro.sounds[role] = v; saveMetro(); showSoundMsg(''); }
          draw(true);
        });
        ctl.replaceChildren(sel,
          el('button', { class: 'btn small snd-play', title: 'Play', 'aria-label': 'Play ' + label, dataset: { fk: 'set-play-' + role }, onclick: () => previewSound(role) }, playIcon()),
          ...(custom ? [
            el('span', { class: 'set-unit snd-file', text: custom.name, title: custom.name, dataset: { fk: 'set-file-' + role } }),
            el('button', { class: 'btn small', dataset: { fk: 'set-reset-' + role }, onclick: async () => { await resetSample(role); showSoundMsg(''); draw(true); } }, 'Reset'),
          ] : []));
        if (focus) sel.focus();
      };
      draw(false);
      return el('div', { class: 'set-row', dataset: { fk: 'set-snd-' + role } }, el('span', { class: 'set-label', text: label }), ctl);
    };
    const out = el('select', { class: 'select', 'aria-label': 'Audio output', dataset: { fk: 'set-output' } });
    const drawOut = () => {
      out.replaceChildren(...[{ id: '', label: 'System default' }, ...metro.outputs].map(o => el('option', { value: o.id, text: o.label })));
      out.value = metro.outputs.some(o => o.id === metro.output) ? metro.output : '';
    };
    drawOut();
    out.addEventListener('pointerdown', async () => { if (!metro.outputs.length || metro.outputs.some(o => /^Output \d+$/.test(o.label))) { await listOutputs(true); drawOut(); } });
    out.addEventListener('change', (e) => { metro.output = e.target.value; saveMetro(); applyOutput(); renderMetro(); });
    const vol = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(metro.volume), 'aria-label': 'Click volume', dataset: { fk: 'set-volume' } });
    vol.addEventListener('input', () => { metro.volume = Number(vol.value); saveMetro(); renderMetro(); });
    const bpm = el('input', { class: 'num', type: 'number', min: '30', max: '300', step: '1', value: String(metro.bpm), 'aria-label': 'Default tempo', dataset: { fk: 'set-bpm' } });
    bpm.addEventListener('change', () => { setBpm(bpm.value, 'settings'); bpm.value = String(metro.bpm); });
    const follow = toggleSwitch('set-follow-tempo', 'Follow the preset tempo', metro.tempoFollowsPreset, setFollowPreset);
    const beats = el('select', { class: 'select', 'aria-label': 'Beats per bar', dataset: { fk: 'set-beats' },
      onchange: (e) => { metro.beats = clamp(Number(e.target.value) || 4, 1, 7); saveMetro(); renderMetro(); } },
      [1, 2, 3, 4, 5, 6, 7].map(n => el('option', { value: n, selected: n === metro.beats }, String(n))));
    // Advanced metronome defaults: these write the overlay's advanced setup (same key), like the tempo above.
    const opensIn = el('select', { class: 'select', 'aria-label': 'Metronome opens in', dataset: { fk: 'set-opens' },
      onchange: (e) => { metro.opensIn = e.target.value === 'advanced' ? 'advanced' : 'simple'; saveMetro(); } },
      [['simple', 'Simple'], ['advanced', 'Advanced']].map(([v, t]) => el('option', { value: v, selected: v === metro.opensIn }, t)));
    const curPat = patternOf(metro.adv);
    const patSel = el('select', { class: 'select', 'aria-label': 'Default pattern', dataset: { fk: 'set-pattern' },
      onchange: (e) => applyPattern(e.target.value) },
      METRO_PATTERNS.map(p => el('option', { value: p.id, selected: !!curPat && curPat.id === p.id }, p.name)),
      curPat ? null : el('option', { value: 'custom', disabled: true, selected: true }, 'Custom'));
    const subSel = el('select', { class: 'select', 'aria-label': 'Default subdivision', dataset: { fk: 'set-subdiv' },
      onchange: (e) => updateAdv({ sub: Number(e.target.value) }) },
      SUBDIVS.map(d => el('option', { value: d.n, selected: d.n === metro.adv.sub }, d.name)));
    const ciSel = el('select', { class: 'select', 'aria-label': 'Default count-in', dataset: { fk: 'set-countin' },
      onchange: (e) => updateAdv({ countIn: Number(e.target.value) }) },
      [[0, 'Off'], [1, '1 bar'], [2, '2 bars']].map(([v, t]) => el('option', { value: v, selected: v === metro.adv.countIn }, t)));
    const lvls = levelSliders('set-lvl-');

    // Connection: the shell remembers the pedal the picker chose and can request it again at launch.
    const pedal = shellInfo && shellInfo.pedal;
    const pedalLine = setNote(!shellBridge ? 'The browser can\u2019t reconnect by itself: Web Bluetooth needs a click for every connection. The desktop app can.'
      : pedal ? 'Remembered: ' + pedal.name + (pedal.at ? ', since ' + new Date(pedal.at).toLocaleDateString() : '') + '.'
      : 'No pedal remembered yet. Connect once and it is remembered.', 'set-pedal');
    const forget = el('button', { class: 'btn small', dataset: { fk: 'set-forget' }, disabled: !pedal ? 'true' : null, onclick: async () => {
      await shellBridge.forgetPedal();
      forget.disabled = true; pedalLine.textContent = 'Forgotten. The next Connect picks any Nano Cortex nearby and remembers it.';
    } }, 'Forget pedal');
    const auto = toggleSwitch('set-autoconnect', 'Reconnect to the last pedal at launch', shellBridge && pref.get('autoConnect', false), (v) => pref.set('autoConnect', v), !shellBridge);

    // Advanced
    const updSwitch = toggleSwitch('set-autoupdate', 'Check for updates automatically', shellInfo ? shellInfo.autoUpdate !== false : false,
      (v) => { if (shellBridge && shellBridge.setAutoUpdate) shellBridge.setAutoUpdate(v).catch(() => {}); }, !shellBridge);
    const devSwitch = toggleSwitch('set-devtools', 'Developer tools', devTools, setDevTools);
    const drawerAtLaunch = toggleSwitch('set-drawer', 'Show the Activity drawer at launch', pref.get('drawerAtLaunch', false), (v) => pref.set('drawerAtLaunch', v));
    const reveal = el('button', { class: 'btn small', dataset: { fk: 'set-reveal' }, disabled: !shellBridge ? 'true' : null,
      title: shellInfo ? shellInfo.recordingsDir : desktopOnly, onclick: () => shellBridge.revealRecordings() }, 'Show recordings folder');

    const general = el('div', { class: 'settings' },
      el('section', {}, el('h3', { text: 'Appearance' }),
        setRow('Accent colour', swatches),
        setRow('', dock), !shellBridge ? setNote(iconWord + ': ' + desktopOnly.toLowerCase()) : null),
      el('section', {}, el('h3', { text: 'Metronome' }),
        setRow('Output', out),
        setRow('Volume', vol),
        setRow('Default tempo', bpm, el('span', { class: 'set-unit', text: 'BPM' })),
        setRow('', follow),
        setNote('When on and connected, the metronome plays the preset\u2019s tempo and follows preset changes; changing the metronome\u2019s tempo writes it to the preset (Save keeps it).'),
        setRow('Beats per bar', beats),
        setRow('Opens in', opensIn),
        setRow('Pattern', patSel, el('span', { class: 'set-unit', text: 'Advanced mode' })),
        setRow('Subdivision', subSel),
        setRow('Count-in', ciSel),
        ...lvls.map(x => setRow(x.label + ' level', x.r, x.val)),
        el('h4', { class: 'set-sub', text: 'Sounds' }),
        ...SOUND_ROLES.map(([role, label]) => soundRow(role, label)),
        soundMsg),
      el('section', {}, el('h3', { text: 'Connection' }),
        setRow('', auto),
        setRow('', pedalLine, shellBridge ? forget : null)),
      el('section', {}, el('h3', { text: 'Advanced' }),
        setRow('', updSwitch),
        setNote(shellBridge ? 'Checks GitHub for new versions.' : desktopOnly, 'set-autoupdate-note'),
        setRow('', devSwitch),
        setNote('Shows the Activity log, session recording and protocol details. For troubleshooting and development.', 'set-devtools-note'),
        devOnly(setRow('', drawerAtLaunch)),
        devOnly(setRow('Recordings', reveal, el('span', { class: 'set-unit', text: shellInfo ? shellInfo.recordingsDir : desktopOnly })))));

    // About: who made it, where it lives, and the quiet support link. Every link opens in the browser.
    const version = (shellInfo && shellInfo.version) || LINKS.version || '';
    const about = el('div', { class: 'about-page', dataset: { fk: 'about-page' } },
      el('section', {},
        el('div', { class: 'about-name' }, 'Nano Cortex Editor ', el('span', { class: 'about-ver', text: version, dataset: { fk: 'about-version' } })),
        setNote('Made by AJs Creations. Unofficial, free and open source.')),
      el('section', {}, el('h3', { text: 'Links' }),
        el('ul', { class: 'about-links' },
          el('li', {}, linkEl(LINKS.repo, 'GitHub repository', 'about-repo')),
          el('li', {}, linkEl(LINKS.manual, 'Manual', 'about-manual')),
          el('li', {}, linkEl(LINKS.mac, 'Native macOS edition', 'about-mac')),
          el('li', {}, linkEl(LINKS.support, 'Buy me a coffee', 'about-support')))),
      el('section', {},
        setNote('Neural DSP and Nano Cortex are trademarks of Neural DSP Technologies Oy; this project is not affiliated with or endorsed by Neural DSP.', 'about-trademark'),
        setNote('MIT licence, \u00a9 2026 AJs Creations. The Bluetooth protocol layer comes from the community Nano Cortex Editor by DrD85 and nano-cortex-web-editor by choldy (both MIT).', 'about-license')));

    // Tabs: General (the sections above), Device (the pedal's own settings, read when the tab opens) and About.
    let devPage = null;
    const panes = el('div', { class: 'settings-panes' }, general, about);
    const tabs = el('div', { class: 'seg settings-tabs', role: 'tablist', 'aria-label': 'Settings' });
    const showTab = (id) => {
      for (const b of tabs.children) { const on = b.dataset.tab === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); }
      general.hidden = id !== 'general';
      about.hidden = id !== 'about';
      if (id === 'device') { if (!devPage) panes.append(devPage = devicePage()); else readDevice(); }
      if (devPage) devPage.hidden = id !== 'device';
    };
    tabs.append(...[['general', 'General'], ['device', 'Device'], ['about', 'About']].map(([id, label]) =>
      el('button', { role: 'tab', 'aria-selected': 'false', dataset: { tab: id, fk: 'set-tab-' + id }, onclick: () => showTab(id) }, label)));
    showTab(tab === 'device' || tab === 'about' ? tab : 'general');
    const content = el('div', { class: 'settings-body' }, tabs, panes);
    await modal({
      title: 'Settings', wide: true, cls: 'settings-modal', content, enterSubmits: false,
      focus: tab === 'device' || tab === 'about' ? tabs.querySelector('[data-tab="' + tab + '"]') : swatches.querySelector('.on'),
      buttons: [{ id: 'ok', label: 'Done', primary: true }],
    });
    dev.redraw = null;
    settingsOpen = false;
    render();
  }
  window.__openSettings = openSettings;
  if (shellBridge && shellBridge.onOpenSettings) shellBridge.onOpenSettings(openSettings);

  // ------------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-bg')) return;
    const typing = typingTarget(e.target);

    if (modKey(e) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); doSaveAs(); return; }
    if (modKey(e) && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); return; }
    if (modKey(e) && e.key.toLowerCase() === 'l') { e.preventDefault(); if (devTools) toggleDrawer(); return; }
    if (modKey(e) && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (modKey(e) && e.key.toLowerCase() === 'f') { e.preventDefault(); const f = $('presetFilter'); f.focus(); f.select(); return; }
    if (modKey(e) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      if (state.connected) goToPreset(state.selectedPreset + (e.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if (e.key === 'Escape') { if (pop) closePopover(); else if (state.tuner.open) { closeTuner(); renderTuner(); } else if (metro.open) toggleMetro(); else if (typing) e.target.blur(); return; }
    if (metro.open && e.key === ' ' && !typing) { e.preventDefault(); if (metro.running) stopMetro(); else startMetro(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.toLowerCase() === 't') { e.preventDefault(); toggleTuner(); return; }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); toggleMetro(); return; }
    if (state.tuner.open || metro.open) return; // overlays own the keyboard while they're up
    if (e.target.closest && e.target.closest('.knob')) return; // knobs own their arrows

    // Every shortcut below calls preventDefault so the same keypress can't also
    // type into whatever it focuses (e.g. M focusing the effect search box).
    if (/^[1-8]$/.test(e.key)) { e.preventDefault(); select(STAGES[Number(e.key) - 1].key); focusNode(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.closest && e.target.closest('.preset-list')) return;
      const i = STAGES.findIndex(s => s.key === ui.selected);
      const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + STAGES.length) % STAGES.length;
      e.preventDefault(); select(STAGES[n].key); focusNode(); return;
    }
    const k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); if (stage(ui.selected)) toggleStage(ui.selected); return; }
    if (k === 'e') { e.preventDefault(); if (state.connected) openExpPanel(); return; }
    if (k === 'm' && state.blocks[ui.selected]) {
      e.preventDefault();
      const btn = document.querySelector('[data-fk="picker-' + ui.selected + '"]');
      if (btn) openModelPicker(ui.selected, btn);
      return;
    }
    if (e.key === '?') { e.preventDefault(); showShortcuts(); }
  });
  function openExpPanel() { select('exp'); requestExpAssignments(); }
  $('expBtn').addEventListener('click', () => openExpPanel());
  const focusNode = () => requestAnimationFrame(() => {
    const n = document.querySelector('[data-fk="node-' + ui.selected + '"]');
    if (n) n.focus({ preventScroll: true });
  });

  // preset list keyboard
  $('presetList').addEventListener('keydown', (e) => {
    if (!state.connected) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...document.querySelectorAll('.preset-row')].map(r => Number(r.dataset.n));
      if (!rows.length) return;
      const i = rows.indexOf(ui.pendingPreset || state.selectedPreset);
      const next = rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1))))];
      ui.pendingPreset = next;
      document.querySelectorAll('.preset-row').forEach(r => r.classList.toggle('active', Number(r.dataset.n) === next));
      const row = document.querySelector('.preset-row[data-n="' + next + '"]');
      if (row) row.scrollIntoView({ block: 'nearest' });
      goToPresetSoon(next);
    }
  });

  // ------------------------------------------------------------------ wiring
  $('connectBtn').addEventListener('click', doConnect);
  $('refreshBtn').addEventListener('click', () => { refreshLists(); toast('Reading presets and captures from the pedal'); });
  $('saveBtn').addEventListener('click', doSave);
  $('discardBtn').addEventListener('click', doDiscard);
  $('saveAsBtn').addEventListener('click', () => doSaveAs());
  $('drawerBtn').addEventListener('click', toggleDrawer);
  $('keysBtn').addEventListener('click', showShortcuts);
  $('settingsBtn').addEventListener('click', () => openSettings());
  $('supportBtn').addEventListener('click', () => openLink(LINKS.support));
  $('renameBtn').addEventListener('click', doRename);
  $('tunerBtn').addEventListener('click', toggleTuner);
  $('muteBtn').addEventListener('click', () => {
    if (!state.connected || !dev.settings) return;
    writeMonitorSetting('muteInput', !dev.settings.muteInput);
  });
  $('chain').addEventListener('pointerdown', onStagePointerDown);
  $('chain').addEventListener('click', onStageClick, true);
  $('chain').addEventListener('contextmenu', onStageContextMenu, true);
  $('inspector').addEventListener('pointerdown', onInspectorPointerDown);
  $('inspector').addEventListener('click', onInspectorClick, true);
  $('presetList').addEventListener('pointerdown', onPresetPointerDown);
  $('presetFilter').addEventListener('input', (e) => { ui.filter = e.target.value; renderSide(); });
  $('presetFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = document.querySelector('.preset-row');
      if (first) goToPreset(Number(first.dataset.n));
    }
  });
  $('sideToggle').addEventListener('click', () => $('app').classList.toggle('show-side'));
  document.addEventListener('click', (e) => {
    if (e.target.closest('.preset-row')) $('app').classList.remove('show-side');
  });

  // ------------------------------------------------------------------ demo mode
  // Fills the editor with plausible data and a fake Bluetooth characteristic so
  // the whole UI can be used (and tested) without a pedal. Every write still goes
  // through the real protocol code and shows up in Activity, but nothing is sent.
  const demo = (() => {
    const PRESETS = [
      { name: 'Princeton Clean', capture: 4, ir: 1, amp: [110, 140, 130, 150, 150], gate: [false, 30],
        fx: { pre1: ['Opto Comp (M)', true], post1: ['Chorus 229T', true], post2: ['Analog Delay', false], post3: ['Room', true] } },
      { name: 'JP2C Lead', capture: 3, ir: 2, amp: [200, 120, 150, 140, 140], gate: [true, 55],
        fx: { pre1: ['Green 808', true], post2: ['Digital Delay (ST)', true], post3: ['Hall', true] } },
      { name: 'Jubilee Crunch', capture: 1, ir: 2, amp: [170, 130, 160, 150, 135], gate: [true, 40],
        fx: { pre1: ['Chief BD2', false], post3: ['Ambience', true] } },
      { name: '5150 Rhythm', capture: 2, ir: 3, amp: [210, 140, 110, 160, 130], gate: [true, 70],
        fx: { pre1: ['OD250', true], pre2: ['Utility Gate', true], post1: ['Parametric 3', true] } },
      { name: 'VH4 Ambient Lead', capture: 5, ir: 3, amp: [190, 125, 140, 145, 140], gate: [true, 50],
        fx: { pre1: ['Green 808', true], post1: ['MX Flanger', false], post2: ['Dual Delay', true], post3: ['Mind Hall', true] } },
      { name: 'SVT Bass', capture: 6, ir: 4, amp: [120, 170, 120, 120, 150], gate: [false, 25],
        fx: { pre1: ['Legendary 87 (M)', true], pre2: ['Exotic Bass Z Boost', false], post1: ['Graphic 9', true] } },
      { name: 'Tremolo Surf', capture: 4, ir: 1, libCab: '112 Jensen', amp: [100, 130, 120, 170, 150], gate: [false, 20],
        fx: { post1: ['Tremolo', true], post2: ['Tape Delay', true], post3: ['Modulated', true] } },
      { name: 'Funk Wah', capture: 1, ir: 1, amp: [130, 120, 150, 160, 140], gate: [false, 30],
        fx: { pre1: ['Crying Wah', true], pre2: ['VCA Comp (M)', true], post1: ['MX Phase 95', true], post3: ['Room', true] } },
      { name: 'Fuzz Wall', capture: 2, ir: 3, libCapture: 'Fuzz Face Si', amp: [150, 160, 100, 150, 130], gate: [true, 60],
        fx: { pre1: ['Facial Fuzz', true], post2: ['Analog Delay', true], post3: ['Cave', true] } },
      { name: 'Octave Down Riff', capture: 3, ir: 2, amp: [190, 140, 120, 150, 130], gate: [true, 65],
        fx: { pre1: ['Transpose', true], post3: ['Room', true] } },
    ];
    const CAPTURES = ['Silver Jubilee Ch1', '5150 Lead', 'JP2C Ch3', 'Princeton 65', 'VH4 Ch3', 'SVT Classic', 'Plexi 1959 Bright',
      'AC30 Top Boost', 'Deluxe Reverb Vib', 'Dumble ODS', 'Recto Modern', 'JCM800 2203', 'Bassman 59', 'Matchless DC30',
      'Friedman BE100', 'Soldano SLO', 'Orange OR50', 'Two Rock Classic', 'Bogner Ecstasy Blue', 'Hiwatt DR103',
      'Trainwreck Express', 'Fryette Deliverance', 'EVH 5153 Red', 'Darkglass B7K', 'Tone King Imperial'];
    const IRS = ['412 V30/Dynamic 57', '412 Greenback/Ribbon 160', '412 Recto/Condenser 414', '810 SVT/Dynamic 421', '212 Blue/Condenser 184'];
    const IR_NAME = (n) => IRS[n - 1].split('/')[0];
    const FULL_IR = (n) => 'Factory/' + IRS[n - 1].split('/')[1] + '/' + IR_NAME(n);

    const saved = new Map(); // preset -> snapshot JSON
    // Which of the demo's sounds each preset slot holds (a preset move reorders them).
    const origin = Array.from({ length: 64 }, (_, i) => i + 1);
    const moved = { names: null, current: 0 };   // what the next metadata / state read reports after a move
    function movePresets(from, to) {
      if (!(from >= 0 && from < 64 && to >= 0 && to < 64) || from === to) return;
      const after = (i) => (i === from ? to : from < to && i > from && i <= to ? i - 1 : from > to && i >= to && i < from ? i + 1 : i);
      const remap = (map) => { const out = new Map(); for (const [n, v] of map) out.set(after(n - 1) + 1, v); map.clear(); for (const [n, v] of out) map.set(n, v); };
      const names = Array.from({ length: 64 }, (_, i) => presetName(i + 1));
      const o = origin.slice();
      const nextNames = [];
      for (let i = 0; i < 64; i++) { nextNames[after(i)] = names[i]; origin[after(i)] = o[i]; }
      [saved, expSaved, expLive].forEach(remap);
      FS_FIELDS.forEach(([key]) => { fsSlots[key] = after(fsSlots[key]); });
      moved.names = nextNames;
      moved.current = after(state.selectedPreset - 1) + 1;
    }
    // The (demo) pedal's footswitch slots, 0-based preset indices; reported in the state dump as fields 14/15/38/39.
    const fsSlots = { a1: 0, b1: 2, a2: 6, b2: 14 };
    const FS_FIELDS = [['a1', 5], ['b1', 6], ['a2', 7], ['b2', 8]];
    // The footswitch part of a type-2 state dump: 13 current preset, 14 IA, 15 IB, 38 IIA, 39 IIB; zeros omitted.
    function stateDump() {
      const out = [];
      const put = (tag, value) => { if (value) out.push(...tag, ...encodeVarint(value)); };
      put([0x68], state.selectedPreset - 1); put([0x70], fsSlots.a1); put([0x78], fsSlots.b1); put([0xB0, 0x02], fsSlots.a2); put([0xB8, 0x02], fsSlots.b2);
      return buildFrame(out, 2);
    }
    // What the core's state-dump parse does with those fields (the full parse would need a whole dump).
    function applyStateDump() {
      const f = framePayloadFields(stateDump());
      const v = (n) => (f[n] && f[n][0] ? f[n][0].value : 0);
      state.presetSlots = { a1: v(14), b1: v(15), a2: v(38), b2: v(39) };
    }
    // Preset tempos (state-dump field 56). tempoBuf is the preset buffer a scope-0 write changes and Save stores;
    // tempoRun is the running tempo a scope-1 write changes.
    const TEMPOS = [120, 93, 100, 140, 76, 90, 112, 98, 130, 85];
    let tempoBuf = 120, tempoRun = 120;
    // The tempo part of a type-2 state dump (field 56, f32), read by the same parser as a pedal's dump.
    function emitTempo() { tempoRun = tempoBuf; tempoFromDump(parseProtoFields([0xC5, 0x03, ...float32LE(tempoBuf)])); }
    // Expression assignments per preset as the 62 records ([field, bytes]); `expLive` holds unsaved sets.
    // Preset 2 starts with one Gain sweep, 0–100 %.
    const expSaved = new Map([[2, [[4, [0x08, 0x00, 0x10, 0x00, 0x18, 0xFF, 0x01]]]]]);
    const expLive = new Map();
    const expOf = (n) => expLive.get(n) || expSaved.get(n) || [];
    const field = (n, bytes) => [...encodeVarint((n << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
    let running = false;
    let origWait = null;

    // Test hooks for a newer pedal: ?demoFirmware=2.3.0 reports that firmware; ?demoUnknown=post2:7E makes that
    // slot report an effect id the tables don't have (on every preset), through the same model parse as a pedal's dump.
    const qs = new URLSearchParams(location.search);
    const DEMO_FW = /^[\w.+-]{1,32}$/.test(qs.get('demoFirmware') || '') ? qs.get('demoFirmware') : '2.2.1';
    const DEMO_UNKNOWN = (() => {
      const m = /^(pre[12]|post[123]):([0-9a-f]{2}(?:[0-9a-f]{2}){0,3})$/i.exec(qs.get('demoUnknown') || '');
      return m ? { key: m[1], id: m[2].match(/../g).map(h => parseInt(h, 16)) } : null;
    })();
    // The FX model part of a state dump (fields 48–52, plus 24 firmware), applied by the real model parse.
    // Only with ?demoUnknown: the plain demo sets its models directly.
    function reportFxModels() {
      if (!DEMO_UNKNOWN) return;
      const fields = { 24: [{ wire: 2, raw: Array.from(new TextEncoder().encode(DEMO_FW)) }] };
      const on = {};
      Object.entries({ pre1: 48, pre2: 49, post1: 50, post2: 51, post3: 52 }).forEach(([k, n]) => {
        const b = state.blocks[k];
        const m = b.models.find(x => x.name === b.model);
        const unknown = DEMO_UNKNOWN && DEMO_UNKNOWN.key === k;
        const raw = unknown ? DEMO_UNKNOWN.id : (m && m.id ? m.id : null);
        on[k] = unknown ? true : b.on;
        if (raw) fields[n] = [{ wire: 2, raw }];
      });
      const was = state.protocol.presetLoad;
      state.protocol.presetLoad = true;
      try { window.applyFXModelsFromCurrentState(fields); } finally { state.protocol.presetLoad = was; }
      for (const k of FX_BLOCK_KEYS) state.blocks[k].on = on[k];   // field 31, which the dump would carry
    }

    // Library stored on the (demo) pedal.
    const cap = (name, index, author, type = 'amp_head', instrument = 'guitar') => ({ index, name, type, tags: [], instrument, author, description: '', corrupted: false });
    // Types vary so the library picker shows its icon set (CAPTURE_KINDS).
    const FACTORY_TYPES = ['amp_head', 'amp_head', 'amp_head', 'combo', 'amp_combo', 'amp_head', 'pedal', 'pedal'];   // amp_combo: a real pedal's word
    const LIB = {
      factory: ['Plexi 1959 SLP', 'JCM800 2203 Lead', 'Recto Modern Red', 'AC30 TB Normal', 'Deluxe Reverb Clean', 'SVT CL Bass', 'Fuzz Face Si', 'King of Tone']
        .map((n, i) => cap(n, i, 'Neural DSP', FACTORY_TYPES[i], i === 5 ? 'bass' : 'guitar')),
      user: [cap('My Plexi Lead', 0, 'You', 'default', 'instrument_not_set'), cap('Bedroom Clean', 1, 'You', 'preamp')],
      irFactory: ['412 V30', '412 Greenback', '212 Blue', '810 SVT', '112 Jensen'].map((name, index) => ({ index, name })),
      irUser: [{ index: 0, name: 'OwnHammer 412 Mix' }],
    };

    // Answer writes the way the pedal would, through the real notification parsers.
    const reply = (frame) => setTimeout(() => handleTypedMessage(frame), 30);
    const notify = (frame) => setTimeout(() => window.onC305({ target: { value: { buffer: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) } } }), 30);
    const reassemble = NanoTransfer.makeReassembler();
    const hooks = {};   // test hooks (window.__demo.hooks): refuseStop, stopDelay, dropStateReads, quiet115, writeDelay
    // A capture audition on the (demo) pedal. While it plays, a state read reports the previewed capture as the current
    // one, as the pedal does; after the stop the next read reports the preset's own capture again.
    const audition = { capture: '', presetCapture: null };
    const firstField = (fields, n) => fields[n] && fields[n][0];
    const textField = (fields, n) => {
      const x = firstField(fields, n);
      return x && x.wire === 2 ? new TextDecoder().decode(Uint8Array.from(x.raw)) : '';
    };
    const previewReply = (body) => {
      const f = parseProtoFields(body);
      const object = firstField(f, 5);
      const objectFields = object && object.wire === 2 ? parseProtoFields(object.raw) : {};
      const record = firstField(objectFields, 2);
      const recordFields = record && record.wire === 2 ? parseProtoFields(record.raw) : {};
      const name = textField(recordFields, 2) || 'Demo preview';
      const hash = textField(recordFields, 1);
      audition.capture = name;
      const enc = (s) => Array.from(new TextEncoder().encode(s));
      const replyRecord = [0x12, enc(name).length, ...enc(name), 0x1A, enc(hash).length, ...enc(hash)];
      notify(buildFrame([0x08, 0x06, 0x18, 0x01, 0x22, replyRecord.length, ...replyRecord], NanoTransfer.MSG_PREVIEW_CAPTURE_REPLY));
    };
    // 15 { 3: { 1: WAV, 2: MD5 }, 4: product id, 5: file name } → 16 { 1: 6, 3: 1, 4: { 1: index, 2: name } }
    const irDownloadReply = (body) => {
      const f = parseProtoFields(body);
      const name = textField(f, 5).replace(/\.wav$/i, '') || 'Cloud IR';
      const index = LIB.irUser.length;
      LIB.irUser.push({ index, name });
      const enc = Array.from(new TextEncoder().encode(name));
      const record = [0x08, index, 0x12, enc.length, ...enc];
      notify(buildFrame([0x08, 0x06, 0x18, 0x01, 0x22, record.length, ...record], NanoTransfer.MSG_DOWNLOAD_IR_REPLY));
    };
    function onWrite(bytes) {
      // Streamed (multi-write) messages: capture uploads and live previews.
      if (bytes.length >= 2 && (bytes[1] & 0xC0) !== 0xC0) {
        const whole = reassemble(bytes);
        if (!whole) return;
        const t = whole[whole.length - 4] | (whole[whole.length - 3] << 8);
        if (t === NanoTransfer.MSG_UPLOAD_CAPTURE) {
          const f = parseProtoFields(whole.slice(0, whole.length - 4));
          const rec = parseProtoFields(f[4][0].raw);
          const name = new TextDecoder().decode(Uint8Array.from(rec[2][0].raw));
          const hash = new TextDecoder().decode(Uint8Array.from(rec[1][0].raw));
          const index = LIB.user.length;
          LIB.user.push(cap(name, index, rec[4] ? 'Cloud' : 'You', 'pedal'));
          const enc = (s) => Array.from(new TextEncoder().encode(s));
          const record = [0x08, index, 0x12, enc(name).length, ...enc(name), 0x1A, enc(hash).length, ...enc(hash)];
          notify(buildFrame([0x08, 0x06, 0x18, 0x01, 0x22, record.length, ...record], NanoTransfer.MSG_UPLOAD_CAPTURE_REPLY));
        } else if (t === NanoTransfer.MSG_PREVIEW_CAPTURE) previewReply(whole.slice(0, whole.length - 4));
        else if (t === NanoTransfer.MSG_DOWNLOAD_IR) irDownloadReply(Array.from(whole.slice(0, whole.length - 4)));
        return;
      }
      const type = frameType(bytes);
      // State and metadata reads get no reply here; pretend they completed so the
      // core's "one read at a time" guard doesn't block later requests.
      if (state.stateMode === 'current' || state.stateMode === 'metadata') setTimeout(() => { if (state.stateMode !== 'library') state.stateMode = 'idle'; }, 20);
      // A current-state read (1 {1:3 3:1 4:1 5:1}) completes like the core's parse would end it: the preset load is
      // over and the read counts (pro/live-sync.js). Test hook: hooks.dropStateReads leaves it unanswered.
      if (type === 1 && bytes[4] === 0x18 && bytes[5] === 0x01 && !hooks.dropStateReads) {
        setTimeout(() => {
          if (state.stateMode === 'current') state.stateMode = 'idle';
          state.protocol.presetLoad = false;
          if (moved.current) { state.selectedPreset = moved.current; moved.current = 0; applyStateDump(); }   // field 13 and the footswitches
          if (audition.capture) {   // the dump's capture, as the core's parse sets it
            if (!audition.presetCapture) audition.presetCapture = { ...state.currentCapture };
            state.currentCapture = { name: audition.capture, id: '', inBank: [...state.captureNames.values()].some(n => sameName(n, audition.capture)) };
          } else if (audition.presetCapture) { state.currentCapture = audition.presetCapture; audition.presetCapture = null; }
          NanoLive.noteStateRead();
          render();
        }, 20);
      }
      // The metadata read (1 {1:3}): the preset list as the pedal now has it (after a move: in the new order).
      if (type === 1 && bytes.length === 8 && bytes[4] === 0x01) {
        setTimeout(() => {
          if (moved.names) { moved.names.forEach((name, i) => state.presetNames.set(i + 1, name)); moved.names = null; }
          Object.assign(state.protocol, { feSyncComplete: true, metadataLoaded: true });
          if (state.stateMode === 'metadata') state.stateMode = 'idle';
          render();
        }, 20);
      }
      if (type === MSG.SetPresetSlotsRequest) {
        // Field 4 = -1 (parsed as a huge number): a footswitch assignment, not a preset change. Keep the slots
        // the next state dump reports, and ack like the pedal did in the trace (31, then 30 via onC305).
        const f = framePayloadFields(bytes);
        const v = (n) => (f[n] && f[n][0] ? f[n][0].value : -1);
        if (v(4) > 63) {
          FS_FIELDS.forEach(([key, n]) => { if (v(n) >= 0 && v(n) < 64) fsSlots[key] = v(n); });
          notify(buildFrame([0x08, 0x01], 31)); notify(buildFrame([0x08, 0x01, 0x20, 0x01], MSG.SetPresetSlotsResponse));
        } else { reply(buildFrame([0x20, 0x01], MSG.SetPresetSlotsResponse)); notify(buildFrame([], MSG.PresetDirtyStateChanged)); }
      }
      else if (type === 3) notify(buildFrame([], MSG.PresetDirtyStateChanged));   // saved: clean
      else if (type === TEMPO_MSG) {
        const f = framePayloadFields(bytes);
        const scope = f[3] && f[3][0] ? f[3][0].value : 0;
        const bpm = f[5] && f[5][0] ? Math.round(f32(f[5][0].raw)) : null;
        if (bpm !== null) tempoRun = bpm;
        if (bpm !== null && scope === 0) { tempoBuf = bpm; notify(buildFrame([0x18, 0x01], MSG.PresetDirtyStateChanged)); }
        else notify(buildFrame([0x08, 0x01, 0x18, 0x01, 0x2D, ...float32LE(tempoRun)], TEMPO_MSG));   // the echo
      }
      else if (type === MSG.RenamePresetRequest) reply(buildFrame([0x20, 0x01], MSG.RenamePresetResponse));
      else if (type === MSG_PRESET_MOVE) {
        // 143 { 1: 4, 3: from, 4: to } → 144 { 1: 6, 3: from, 4: to, 5: 1 }: the demo pedal moves the preset (and what
        // it stores for it) by insertion; its current preset and footswitches follow the presets.
        const f = framePayloadFields(bytes);
        const from = f[3] ? f[3][0].value : 0, to = f[4] ? f[4][0].value : 0;
        movePresets(from, to);
        notify(buildFrame([0x08, 0x06, 0x18, from, 0x20, to, 0x28, 0x01], MSG_PRESET_MOVE_REPLY));
      }
      else if (type === 50) { const idx = bytes[5]; notify(buildFrame([0x08, 0x01], 31)); notify(buildFrame([0x08, 0x06, 0x18, idx, 0x20, 0x01], 51)); }   // via onC305, where the delete ack is read
      else if (type === MSG.RetrieveExpAssignmentsRequest) {
        // 60 {1:3 3:index} → 64 {1:1 3:2} (meaning unknown, seen in the trace) and 61 {1:1, records at field − 1}.
        const n = framePayloadFields(bytes)[3][0].value + 1;
        reply(buildFrame([0x08, 0x01, 0x18, 0x02], 64));
        reply(buildFrame([0x08, 0x01, ...expOf(n).flatMap(([k, raw]) => field(k - 1, raw))], MSG.RetrieveExpAssignmentsResponse));
      } else if (type === MSG.SaveExpAssignmentsRequest) {
        // 62 replaces the whole set → 63 {1:1 3:1} and 115 dirty (clean again when it matches the saved set).
        const f = framePayloadFields(bytes);
        const n = (f[3] ? f[3][0].value : 0) + 1;
        const recs = Object.keys(f).map(Number).filter(k => k !== 3).sort((a, b) => a - b).map(k => [k, Array.from(f[k][0].raw)]);
        expLive.set(n, recs);
        reply(buildFrame([0x08, 0x01, 0x18, 0x01], 63));
        const dirty = JSON.stringify(recs) !== JSON.stringify(expSaved.get(n) || []);
        reply(buildFrame(dirty ? [0x08, 0x01, 0x18, 0x01] : [0x08, 0x01], MSG.PresetDirtyStateChanged));
      }
      else if ([26, 28, 31, 94, 99, 136].includes(type)) {
        // Demo writes model the pedal: edit writes become dirty only through
        // the simulated pedal's authoritative type-115 report (test hook: hooks.quiet115 leaves it out).
        if (!hooks.quiet115) notify(buildFrame([0x08, 0x01, 0x18, 0x01], MSG.PresetDirtyStateChanged));
      }
      else if (type === NanoLive.MSG.DeleteLibraryIRRequest) {
        const f = framePayloadFields(bytes);
        const record = f[4] && f[4][0] ? parseProtoFields(f[4][0].raw) : {};
        const index = record[1] && record[1][0] ? record[1][0].value : -1;
        const removed = LIB.irUser.some(item => item.index === index);
        if (removed) {
          LIB.irUser = LIB.irUser.filter(item => item.index !== index);
          LIB.irUser.forEach((item, nextIndex) => { item.index = nextIndex; });
        }
        notify(buildFrame([0x08, 0x06, 0x18, removed ? 0x01 : 0x00], NanoLive.MSG.DeleteLibraryIRResponse));
      }
      else if (type === MSG.SetCaptureSlotContentRequest) reply(buildFrame([0x18, 0x01], MSG.SetCaptureSlotContentResponse));
      else if (type === MSG.SetCabinetSlotContentRequest) reply(buildFrame([0x18, 0x01], MSG.SetCabinetSlotContentResponse));
      else if (type === MSG.RetrieveLibraryContentRequest) {
        state.stateMode = 'idle';
        state.library = { ...structuredClone(LIB), loaded: true, requested: true };
        render();
      } else if (type === MSG.TunerMode) {
        const f = framePayloadFields(bytes);
        tunerDemo(Boolean(f[4] && f[4][0] && f[4][0].value));
      } else if (type === NanoTransfer.MSG_PREVIEW_CAPTURE) {
        previewReply(Array.from(bytes.slice(2, bytes.length - 4)));
      } else if (type === NanoTransfer.MSG_DOWNLOAD_IR) {
        irDownloadReply(Array.from(bytes.slice(2, bytes.length - 4)));
      } else if (type === NanoTransfer.MSG_PREVIEW_STOP) {
        // 148 { 2: transaction, 3 or 4: 0 } → 149 { 1: 1, 2: transaction, 3: 1 }. Test hook: answer a refusal (status 0).
        // Test hook: hooks.stopDelay (ms) answers that much later (a slow pedal).
        const f = framePayloadFields(bytes);
        const tx = f[2] && f[2][0] ? f[2][0].value : 0;
        const refused = !!hooks.refuseStop;
        if (!refused && f[3]) audition.capture = '';   // field 3: the capture audition stopped
        const answer = () => notify(buildFrame([0x08, 0x01, 0x10, ...varint(tx), 0x18, refused ? 0x00 : 0x01], NanoTransfer.MSG_PREVIEW_STOP_REPLY));
        if (hooks.stopDelay) setTimeout(answer, hooks.stopDelay); else answer();
      } else if (type === MSG_IR_PREVIEW) {
        // 158 { 3 or 4: { 1: index, 2: name }, 8: 1 } → 159 { 1: 6, 3: 1, 4: { 2: name } } when the item exists.
        const f = framePayloadFields(bytes);
        const rec = f[3] ? f[3][0] : f[4] ? f[4][0] : null;
        const r = rec ? parseProtoFields(rec.raw) : {};
        const list = f[3] ? LIB.irFactory : LIB.irUser;
        const name = textField(r, 2);
        const ok = list.some(x => x.index === (r[1] ? r[1][0].value : 0) && sameName(x.name, name));
        const enc = Array.from(new TextEncoder().encode(name));
        notify(buildFrame([0x08, 0x06, 0x18, ok ? 0x01 : 0x00, 0x22, enc.length + 2, 0x12, enc.length, ...enc], MSG_IR_PREVIEW_REPLY));
      } else if (type === DEV_MSG.ALIVE_REQ || type === DEV_MSG.INFO_REQ || type === DEV_MSG.SETTINGS_REQ || type === DEV_MSG.SET || type === DEV_MSG.CAPTURE_REQ) {
        notify(deviceReply(type, framePayloadFields(bytes)));
      }
    }

    // Device page and capture info, answered the way the pedal did in the 2026-10-09 trace.
    const devStore = { brightness: 153, usbDb: -6, muteInput: false, muteOutput: false };
    const pbStr = (field, text) => { const b = Array.from(new TextEncoder().encode(text)); return [(field << 3) | 2, ...varint(b.length), ...b]; };
    const pbSub = (field, b) => [(field << 3) | 2, ...varint(b.length), ...b];
    const fakeHash = (seed, n) => Array.from({ length: n }, (_, k) => ((seed * 31 + k * 7 + 3) % 16).toString(16)).join('');
    const DEMO_CLOUD_ID = '5D3E0C10-0D00-4A11-8C55-0000000000A5';
    const DEMO_TAGS = { 1: ['Marshall', 'Jubilee', 'Crunch'], 2: ['EVH', '5150', 'High gain'], 3: ['Mesa', 'JP2C', 'Lead'], 4: ['Fender', 'Princeton', 'Clean'] };
    function deviceReply(type, f) {
      const int = (n) => (f[n] && f[n][0] && f[n][0].wire === 0 ? f[n][0].value : 0);
      if (type === DEV_MSG.INFO_REQ) {
        return longFrame([0x08, 0x01, 0x18, 0x01, ...pbStr(4, ''), ...pbStr(5, DEMO_FW), ...pbStr(6, 'NP00XXXXXX'), ...pbStr(7, fakeHash(int(3) % 97, 40))], DEV_MSG.INFO);
      }
      if (type === DEV_MSG.ALIVE_REQ) {
        return longFrame([0x08, 0x03, 0x18, 0x01, ...pbStr(5, DEMO_FW + '+demo'), ...pbStr(6, 'NP00XXXXXX'), ...pbStr(7, 'Neural DSP Nano Cortex')], DEV_MSG.ALIVE);
      }
      if (type === DEV_MSG.SET) {
        if (f[4]) devStore.brightness = int(4);
        if (f[14] && f[14][0].wire === 5) devStore.usbDb = new DataView(Uint8Array.from(f[14][0].raw).buffer).getFloat32(0, true);
        if (f[12]) devStore.muteInput = int(12) !== 0;
        if (f[13]) devStore.muteOutput = int(13) !== 0;
        return longFrame([0x08, 0x01, 0x18, 0x01], DEV_MSG.SET_ACK);
      }
      if (type === DEV_MSG.SETTINGS_REQ) {
        return longFrame([0x08, 0x01, 0x18, 0x01, ...pbStr(5, 'Neural DSP Nano Cortex'), 0x30, ...varint(devStore.brightness), 0x38, 0x01, 0x40, 0x01,
          0x58, 0x00, 0x60, 0x01, 0x68, 0x81, 0x01, 0x70, 0x01,
          ...(devStore.muteInput ? [0x78, 0x01] : []), ...(devStore.muteOutput ? [0x80, 0x01] : []),
          0x8D, 0x01, ...float32LE(devStore.usbDb)], DEV_MSG.SETTINGS);
      }
      // 17 → 18: the slot's capture, with the library's author and kind when the library has it by name.
      const slot = int(3) + 1;
      const name = state.captureNames.get(slot) || ('Capture ' + slot);
      const lib = [...LIB.factory, ...LIB.user].find(x => sameName(x.name, name));
      const bass = /SVT|B7K|Bass/i.test(name);
      const author = lib ? lib.author : 'Neural DSP';
      const kind = lib ? lib.type : ['amp_head', 'combo', 'amp_head', 'combo', 'pedal'][slot % 5];
      const instrument = lib ? lib.instrument : bass ? 'bass' : 'guitar';
      const tags = DEMO_TAGS[slot] || name.split(/\s+/).filter(w => /[a-z]/i.test(w)).slice(0, 2);
      const hash = fakeHash(slot, 64);
      const by = [...pbStr(1, author), ...pbStr(2, author)];
      const record = [...pbStr(1, hash), ...pbStr(2, name), ...pbSub(4, by), ...pbStr(6, kind), ...tags.flatMap(t => pbStr(7, t)), 0x40, 0x04,
        ...pbStr(10, instrument), 0x58, 0x01, ...pbStr(12, '1')];
      // No description: slot 4 answers an empty one (like the traced reply), slot 2 the text "null". Slot 5's description
      // is just a Cortex Cloud ID (made up; capitals, to show it is matched in any case), as some captures on a real
      // pedal have. (Slot 3 keeps one: docs/images/capture-info.png shows it.)
      const desc = slot === 2 ? 'null' : slot === 4 ? '' : slot === 5 ? DEMO_CLOUD_ID : 'Demo capture in slot ' + slot + '.';
      return longFrame([0x08, 0x06, 0x18, 0x01, ...pbSub(7, by), ...pbStr(8, desc), ...pbStr(9, hash), ...pbStr(10, name),
        ...pbSub(11, record)], DEV_MSG.CAPTURE);
    }
    window.__devDemo = {
      store: devStore,
      emitSettings: () => window.handleTypedMessage(deviceReply(DEV_MSG.SETTINGS_REQ, {})),
    };
    let tunerTimer = null;
    function tunerDemo(on) {
      clearInterval(tunerTimer); tunerTimer = null;
      if (!on) return;
      let t = 0;
      tunerTimer = setInterval(() => {
        t += 0.12;
        const cents = 18 * Math.sin(t) + 4 * Math.sin(t * 3.7);
        const note = 'E';
        handleTunerMetering(buildFrame([0x22, note.length, ...new TextEncoder().encode(note), 0x2D, ...float32LE(cents), 0x38, Math.abs(cents) < 2 ? 1 : 0], MSG.TunerMetering));
      }, 120);
    }

    function snapshot() {
      return JSON.stringify({
        blocks: Object.fromEntries(Object.entries(state.blocks).map(([k, b]) => [k, { model: b.model, on: b.on, params: b.params }])),
        capture: { on: state.capture.on, slot: activeCaptureSlot() || state.capture.lastActiveSlot || 1, vol: state.captureVolumeDb || 0,
          lib: state.capture.fromLibrary ? state.currentCapture.name : '' },
        cab: { on: state.cabIR.on, slot: activeIRSlot() || state.cabIR.lastActiveSlot || 1, lib: state.cabIR.fromLibrary ? state.currentIR.shortName : '', mic: state.cabIR.mic, pos: state.cabIR.position,
          level: state.cabIR.levelDb, hp: state.cabIR.highPassHz, lp: state.cabIR.lowPassHz },
        amp: { ...state.amp },
        gate: { on: state.gate.on, r: state.gate.params[0].value },
        tempo: tempoBuf,
      });
    }
    function applySnapshot(json) {
      const s = JSON.parse(json);
      for (const [k, v] of Object.entries(s.blocks)) Object.assign(state.blocks[k], { model: v.model, on: v.on, params: v.params });
      if (s.capture.lib) pickLibraryCapture(s.capture.lib); else pickCapture(s.capture.slot);
      state.capture.on = s.capture.on; state.captureVolumeDb = s.capture.vol;
      if (s.cab.lib) pickLibraryIR(s.cab.lib); else pickIR(s.cab.slot);
      Object.assign(state.cabIR, { on: s.cab.on, mic: s.cab.mic, position: s.cab.pos, levelDb: s.cab.level, highPassHz: s.cab.hp, lowPassHz: s.cab.lp });
      Object.assign(state.amp, s.amp);
      state.gate.on = s.gate.on; state.gate.params[0].value = s.gate.r;
      tempoBuf = s.tempo || 120;
    }
    function fromPreset(n) {
      const p = PRESETS[(n - 1) % PRESETS.length];
      const [gain, bass, mid, treble, level] = p.amp;
      Object.assign(state.amp, { gain, bass, mid, treble, level });
      for (const k of FX_BLOCK_KEYS) {
        const b = state.blocks[k];
        const want = p.fx[k];
        const m = want && b.models.find(x => x.name === want[0]);
        b.model = m ? m.name : 'None';
        b.params = m ? structuredClone(m.params) : [];
        b.on = m ? want[1] : false;
        // nudge defaults so knobs aren't all identical
        b.params.forEach((q, i) => {
          if (q.meta && q.meta.kind === 'range') {
            const t = ((n * 7 + i * 13) % 10) / 10;
            q.value = roundToStep(q.meta.min + (0.25 + t * 0.5) * (q.meta.max - q.meta.min), q.meta.step || 0.1);
          }
        });
      }
      // Presets 11-20 and 21-24 repeat the first ten sounds on other capture slots, so a slot usage scan
      // finds used and free slots; 'Fuzz Wall' and 'Tremolo Surf' play a capture / cab straight from the library.
      if (p.libCapture) pickLibraryCapture(p.libCapture); else pickCapture(p.capture + 6 * Math.floor((n - 1) / 10));
      state.captureVolumeDb = n % 3 === 0 ? -2.5 : 0;
      if (p.libCab) pickLibraryIR(p.libCab); else pickIR(p.ir);
      Object.assign(state.cabIR, { mic: p.libCab ? 'Dynamic 57' : IRS[p.ir - 1].split('/')[1], position: (n % 6) + 1, levelDb: 0, highPassHz: 80, lowPassHz: 9000 });
      state.gate.on = p.gate[0]; state.gate.params[0].value = p.gate[1];
      tempoBuf = TEMPOS[(n - 1) % TEMPOS.length];
    }
    function pickCapture(i) {
      state.capture.on = true; state.capture.selectedSlot = i; state.capture.lastActiveSlot = i; state.capture.fromLibrary = false;
      state.currentCapture = { name: state.captureNames.get(i), id: '', inBank: true };
    }
    function pickLibraryCapture(name) {   // what the pedal reports as capture position 6
      Object.assign(state.capture, { on: true, selectedSlot: null, lastActiveSlot: null, fromLibrary: true });
      state.currentCapture = { name, id: '', inBank: false };
    }
    function pickLibraryIR(name) {        // cab slot 6
      Object.assign(state.cabIR, { on: true, selectedSlot: null, fromLibrary: true });
      state.currentIR = { shortName: name, fullName: 'Factory/Dynamic 57/' + name, inBank: false };
      state.cabIR.libraryIndex = 4;
    }
    function pickIR(i) {
      state.cabIR.on = true; state.cabIR.selectedSlot = i; state.cabIR.lastActiveSlot = i; state.cabIR.fromLibrary = false;
      state.currentIR = { shortName: state.irNames.get(i), fullName: FULL_IR(i), inBank: true, slot: i };
      state.cabIR.mic = IRS[i - 1].split('/')[1];
      state.cabIR.libraryIndex = i + 2; // where the (demo) pedal's library keeps this cab
    }
    function load(n) {
      if (!running) return;
      audition.capture = ''; audition.presetCapture = null;
      if (saved.has(n)) applySnapshot(saved.get(n)); else if (origin[n - 1] <= 24) fromPreset(origin[n - 1]); else blank();
      reportFxModels();
      applyStateDump();
      emitTempo();
      expLive.delete(n);   // a (re)load drops unsaved expression edits, like every other edit
      state.presetDirty = false;   // and the pedal reports the freshly loaded preset clean
      beginExpressionBoundary();
      render();
      followExp(true);
    }
    function blank() {
      for (const k of FX_BLOCK_KEYS) Object.assign(state.blocks[k], { model: 'None', on: false, params: [] });
      pickCapture(1); pickIR(1);
      Object.assign(state.amp, { gain: 128, bass: 128, mid: 128, treble: 128, level: 128 });
      tempoBuf = 120;
    }
    function start() {
      running = true;
      ui.demo = true;
      ui.connectError = '';
      for (let i = 1; i <= 64; i++) state.presetNames.set(i, i <= 24 ? PRESETS[(i - 1) % PRESETS.length].name + (i > 10 ? ' ' + Math.ceil(i / 10) : '') : 'Empty');
      CAPTURES.forEach((c, i) => state.captureNames.set(i + 1, c));
      IRS.forEach((_, i) => state.irNames.set(i + 1, IR_NAME(i + 1)));
      // Test hook: hooks.writeDelay (ms) keeps each write in flight that long.
      state.c304 = { writeValueWithResponse: async (bytes) => { onWrite(bytes); if (hooks.writeDelay) await new Promise(r => setTimeout(r, hooks.writeDelay)); } };
      state.firmware = DEMO_FW;
      origWait = window.waitForPresetState;
      window.waitForPresetState = async () => true; // no state read-back without a pedal
      state.connected = true;
      state.selectedPreset = 2;
      fromPreset(2);
      reportFxModels();
      applyStateDump();
      window.setStatus('Connected', true);
      emitTempo();
      followExp(true);
      window.log('Demo mode: writes are logged here but not sent anywhere.');
      state.presetDirty = false;
      beginExpressionBoundary();
      toast('Demo data loaded. Nothing is sent to a pedal.');
      render();
      scrollPresetIntoView();
    }
    function stop() {
      running = false;
      ui.demo = false;
      audition.capture = ''; audition.presetCapture = null;
      state.c304 = null; state.connected = false;
      if (origWait) window.waitForPresetState = origWait;
      tunerDemo(false);
      if (state.tuner.open) closeTuner(false);
      state.library = { factory: [], user: [], irFactory: [], irUser: [], loaded: false, requested: false };
      state.presetNames.clear(); state.captureNames.clear(); state.irNames.clear();
      blank();
      state.presetDirty = false;
      beginExpressionBoundary();
      window.setStatus('Disconnected');
      render();
    }
    const store = (n) => { saved.set(n, snapshot()); expSaved.set(n, expOf(state.selectedPreset)); expLive.delete(n); };
    const erase = (n) => { saved.delete(n); expSaved.delete(n); expLive.delete(n); state.presetNames.set(n, 'Empty'); };
    return { start, stop, load, store, erase, pickCapture, pickIR, stateDump, hooks, get running() { return running; }, get tempo() { return { buf: tempoBuf, run: tempoRun }; } };
  })();
  window.__demo = demo;

  // ------------------------------------------------------------------ boot
  // index.html writes shortcuts the Mac way; show Ctrl+… on Windows and Linux.
  for (const n of document.querySelectorAll('[title]')) n.title = keyLabel(n.title);
  for (const n of document.querySelectorAll('kbd')) n.textContent = keyLabel(n.textContent);
  applyDevTools();
  render();
  if (devTools && pref.get('drawerAtLaunch', false)) toggleDrawer();
  if (shellBridge) shellBridge.setAccent(pref.get('accent', ACCENTS[0].hex), pref.get('dockFollowsAccent', true)).catch(() => {});
  if (shellBridge && shellBridge.setDevTools) shellBridge.setDevTools(devTools).catch(() => {});   // the menu follows the page's setting
  // A freshly (re)loaded editor runs no preview: tell the Cloud toolbar, which may still show Stop Preview.
  pushPreviewState();
  // Outermost notification handler (installed last; connectAll() attaches whatever window.onC305 is): every layer
  // below, upstream's included, gets a value whose buffer holds exactly the notification.
  window.onC305 = NanoLive.withExactBytes(window.onC305);
  const startDemo = !navigator.bluetooth || window.__FORCE_DEMO || /[?&]demo\b/.test(location.search);
  // Reconnect at launch: the shell grants the user gesture requestDevice() needs and picks the remembered pedal.
  window.__autoConnect = () => { window.__autoConnect = null; ble.autoWhy = 'launch'; ble.next = { auto: true }; return doConnect(); };
  // Sleep and wake (src/main.js, powerMonitor): before the computer sleeps the page disconnects cleanly, so no link is
  // left for macOS to hold; on wake it reconnects the remembered pedal the way the launch reconnect does (an auto scan)
  // whenever it was connected before the sleep. That is not the "Reconnect … at launch" setting, which stays launch-only
  // (the native edition reconnects after any dropped link, wake included). main runs __systemResume with a user gesture
  // (requestDevice() needs one) and says whether a pedal is remembered (the auto scan takes only that one).
  window.__systemSuspend = () => {
    ble.wakeReconnect = false;
    if (ui.demo || !state.connected) return false;
    ble.wakeReconnect = true;
    log('The computer is going to sleep: disconnecting from the pedal.');
    disconnect();
    return true;
  };
  window.__systemResume = (opts = {}) => {
    const was = ble.wakeReconnect;
    ble.wakeReconnect = false;
    if (!was || ui.demo || state.connected || ui.connecting) return false;
    if (!(opts && opts.pedal)) { log('The computer woke up. Click Connect to reconnect to the pedal.'); return false; }
    log('The computer woke up: reconnecting to the remembered pedal.');
    ble.autoWhy = 'wake';
    ble.next = { auto: true };
    doConnect();
    return true;
  };
  if (startDemo) demo.start();
  else if (shellBridge && pref.get('autoConnect', false)) shellBridge.autoConnect().catch(() => {});
})();
