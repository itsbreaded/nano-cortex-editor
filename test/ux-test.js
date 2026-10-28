// UX test: drives the pro editor (demo data) with real mouse, wheel and
// keyboard input, checks UI state and the Bluetooth packets each action
// produces, and saves a screenshot per step to test-output/.
//   npm run test:ux            (macOS / Windows)
//   xvfb-run -a npm run test:ux   (Linux without a display)
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const PAGE = process.env.PAGE || path.join(__dirname, '..', 'pro', 'index.html');
const OUT = process.env.OUT || path.join(__dirname, '..', 'test-output');
const MOD = process.platform === 'darwin' ? 'meta' : 'control'; // ⌘ on Mac, Ctrl elsewhere
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const consoleErrors = [];
const LINKS = require('../pro/links');
const opened = [];   // outside links the page tried to open (handed to the window-open handler below, never shown)
let win, wc;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const js = (code) => wc.executeJavaScript(code);
const frame = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

// ---------------------------------------------------------------- waiting on conditions, not on the clock
// Every wait below returns as soon as its condition holds; the timeout only bounds a failure. GitHub's
// macOS VMs are several times slower than a desktop Mac and stall now and then, so the bound is generous.
const TIMEOUT = Number(process.env.UX_TIMEOUT) || 5000;
// Polls `cond` (an async function, or page JS as a string) until it is truthy; returns its last value.
async function waitFor(cond, { timeout = TIMEOUT, interval = 20 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await (typeof cond === 'string' ? js(cond) : cond());
    if (v) return v;
    if (Date.now() - t0 > timeout) { console.log('  … waited ' + timeout + ' ms in vain for: ' + String(cond).replace(/\s+/g, ' ').slice(0, 140)); return v; }
    await sleep(interval);
  }
}
// Waits until page JS `code` returns the same value twice, `gap` ms apart (a transition has finished).
async function stable(code, { gap = 100, timeout = TIMEOUT } = {}) {
  let prev = await js(code);
  for (const t0 = Date.now(); Date.now() - t0 < timeout;) {
    await sleep(gap);
    const v = await js(code);
    if (v === prev) return v;
    prev = v;
  }
  return prev;
}
// check() once `cond` holds (or the timeout passes). For conditions that become true after an async reply.
async function checkSoon(name, cond, detail) {
  const ok = await waitFor(cond);
  check(name, ok, typeof detail === 'function' ? await detail() : (detail || ''));
}

async function box(sel) {
  // Waits for the element (a popover or dialog may still be opening on a slow machine).
  const r = await waitFor(() => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'nearest'}); const b = e.getBoundingClientRect(); return {x: b.left + b.width/2, y: b.top + b.height/2, w: b.width, h: b.height}; })()`));
  if (!r) throw new Error('No element for ' + sel);
  await frame();
  return r;
}
async function hitOk(sel, x, y) {
  return js(`(() => { const t = document.elementFromPoint(${x}, ${y}); const e = document.querySelector(${JSON.stringify(sel)}); return !!(t && e && (e === t || e.contains(t))); })()`);
}
async function click(sel, opts = {}) {
  const b = await box(sel);
  const x = Math.round(b.x + (opts.dx || 0)), y = Math.round(b.y + (opts.dy || 0));
  if (!opts.dx && !opts.dy && !(await hitOk(sel, x, y))) check('click target not obscured: ' + sel, false, 'something else is on top');
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: opts.count || 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: opts.count || 1 });
  await sleep(40); await frame();
}
async function clickWhileReceiving(sel, receive) {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  // Deliver the report before the demo write can finish and release the
  // optimistic target; the redraw itself is allowed to happen while pressed.
  await receive();
  await sleep(35); await frame();
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await sleep(40); await frame();
}
async function rightClickWhileReceiving(sel, receive) {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
  await receive();
  await sleep(35); await frame();
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  const afterRelease = await js('!!document.querySelector(".ctx")');
  await sleep(40); await frame();
  const afterWait = await js('!!document.querySelector(".ctx")');
  return { afterRelease, afterWait };
}
async function rightClick(sel) {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
  await sleep(60); await frame();
}
const ctxItem = (label) => `[...document.querySelectorAll(".ctx-item")].find(b => b.textContent.startsWith(${JSON.stringify(label)}))`;
async function dblclick(sel) {
  await click(sel, { count: 1 });
  await click(sel, { count: 2 });
}
async function drag(sel, dy, modifiers = [], beforeUp = null) {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  if (!(await hitOk(sel, x, y))) check('drag target not obscured: ' + sel, false, 'something else is on top');
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    wc.sendInputEvent({ type: 'mouseMove', x, y: Math.round(y - (dy * i) / steps), modifiers, button: 'left' });
    await sleep(12);
  }
  if (beforeUp) await beforeUp();
  wc.sendInputEvent({ type: 'mouseUp', x, y: Math.round(y - dy), button: 'left', clickCount: 1 });
  await sleep(60); await frame();
}
async function wheel(sel, deltaY, n = 1) {
  const b = await box(sel);
  for (let i = 0; i < n; i++) {
    wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(b.x), y: Math.round(b.y), deltaX: 0, deltaY, canScroll: true });
    await sleep(20);
  }
  await frame();
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1 && !modifiers.includes(MOD)) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(40); await frame();
}
async function type(text) {
  for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(8); }
  await frame();
}
async function shot(name) {
  await frame(); await sleep(120);
  const img = await wc.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
}
// Packets: the Activity log numbers every line (logSeq), so a mark survives the log's trim of old lines.
const txCount = () => js('__ui.logSeq');
const lastTx = () => js('(__ui.logs.filter(l => l.cls === "tx").slice(-1)[0] || {}).text || ""');
const txSince = async (n) => js(`__ui.logs.filter(l => l.cls === "tx" && l.seq > ${n}).map(l => l.text)`);
const lastTxSeq = () => js('(__ui.logs.filter(l => l.cls === "tx").slice(-1)[0] || { seq: 0 }).seq');
// The core's GATT write queue is empty and no FX parameter read is in flight.
const writesIdle = () => js('gattWriteQueue.length === 0 && !gattWritePumpRunning && !state.pendingParamBlock && !state.paramRefreshQueue.length');
// Waits until the writes have stopped: the queue is idle and no packet went out for `quiet` ms.
async function settle({ quiet = 350, timeout = TIMEOUT } = {}) {
  const t0 = Date.now();
  let last = await lastTxSeq(), since = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(25);
    const n = await lastTxSeq();
    if (n !== last) { last = n; since = Date.now(); }
    else if (Date.now() - since >= quiet && await writesIdle()) return true;
  }
  console.log('  … writes did not settle within ' + timeout + ' ms');
  return false;
}
// A mark for txSince() taken once earlier writes have left (so they can't be counted as this step's).
async function mark(opts) { await settle(opts); return txCount(); }
// The packets sent since `n0`, once `ready(packets)` holds (by default: at least one was sent) and the
// writes have settled, so exact counts see every packet that is coming and nothing from the next step.
async function txWait(n0, ready = (tx) => tx.length > 0, opts) {
  await waitFor(async () => ready(await txSince(n0)), opts);
  await settle(opts);
  return txSince(n0);
}

// Reload the editor page (demo restarts) and wait until it has booted.
async function reloadPage() {
  const loaded = new Promise(r => wc.once('did-finish-load', r));
  wc.reload();
  await loaded; await waitFor('typeof __ui !== "undefined" && __ui.demo && state.connected'); await settle(); await frame();
}
// A typed frame as the Activity log prints it: [len] C0 [payload] [u32 LE type].
const hexBytes = (bytes) => bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const frameHex = (payload, type) => { const f = [0, 0xC0, ...payload, type & 255, (type >> 8) & 255, 0, 0]; f[0] = f.length - 2; return hexBytes(f); };
const utf8 = (text) => [...Buffer.from(text, 'utf8')];
const toastText = () => js('document.getElementById("toast").textContent');
// Computed colours come back as rgb(…) or, for color-mix(), as color(srgb r g b) in 0..1.
const rgbOf = (css) => {
  let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(css || '');
  if (m) return [+m[1], +m[2], +m[3]];
  m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/.exec(css || '');
  return m ? [m[1] * 255, m[2] * 255, m[3] * 255].map(Math.round) : null;
};

async function run() {
  // ---------------------------------------------------------------- boot
  await waitFor('typeof __ui !== "undefined" && __ui.demo && state.connected'); await settle();
  // Start like a fresh install (a previous run may have left an accent, a sound or a tempo behind).
  if (await js('Object.keys(localStorage).some(k => k.startsWith("settings.") || k === "metronome")')) {
    await js('Object.keys(localStorage).filter(k => k.startsWith("settings.") || k === "metronome").forEach(k => localStorage.removeItem(k))');
    await reloadPage();
  }
  check('a fresh install opens the metronome at 100 BPM', (await js('__metro.state.bpm')) === 100, String(await js('__metro.state.bpm')));
  check('demo starts automatically with ?demo', await js('__ui.demo && state.connected'));
  check('veil really hidden when connected', await js('getComputedStyle(document.getElementById("veil")).display === "none"'));
  check('header shows preset name', (await js('document.querySelector(".preset-title .name").textContent')) === 'JP2C Lead');
  check('8 chain nodes', (await js('document.querySelectorAll(".node").length')) === 8);
  check('chain nodes have gaps for the cable', await js(`(() => { const r = [...document.querySelectorAll('.node')].map(n => n.getBoundingClientRect()); return r.every((b, i) => i === 0 || b.left - r[i-1].right >= 16); })()`));
  const clipped = async () => js(`[...document.querySelectorAll('.node .stage, .node .sub')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent)`);
  check('no node label is truncated at 1400px', (await clipped()).length === 0, JSON.stringify(await clipped()));
  check('64 presets listed', (await js('document.querySelectorAll(".preset-row").length')) === 64);
  check('active preset row highlighted', (await js('document.querySelector(".preset-row.active .t").textContent')) === 'JP2C Lead');
  check('default inspector is Capture', (await js('document.querySelector(".insp-head h1").textContent')) === 'Capture');
  // Effect slots take their category's colour; Reverb is soft pink, so a delay next to a reverb no longer looks the same.
  const nodeColour = (k) => js(`(() => { const n = document.querySelector('[data-fk="node-${k}"]'); return n ? [n.style.getPropertyValue('--c').trim().toLowerCase(), getComputedStyle(n.querySelector('.stage')).color, n.querySelector('.model').textContent] : null; })()`);
  const delayNode = await nodeColour('post2'), reverbNode = await nodeColour('post3');
  check('a reverb\'s chain node is soft pink (#f570d6), the delay next to it stays #00ffdd', reverbNode && reverbNode[0] === '#f570d6' && reverbNode[1] === 'rgb(245, 112, 214)' && delayNode && delayNode[0] === '#00ffdd' && delayNode[1] === 'rgb(0, 255, 221)', JSON.stringify([delayNode, reverbNode]));
  check('every reverb model takes the reverb colour (the category map, not a model list)', await js(`state.blocks.post3.models.filter(m => m.category === 'Reverb').length > 3 && (() => { const b = state.blocks.post3, was = b.model; const ok = b.models.filter(m => m.category === 'Reverb').every(m => { b.model = m.name; return __stageColor('post3') === '#f570d6'; }); b.model = was; return ok; })()`));
  await shot('01-capture');

  // ---------------------------------------------------------------- developer tools: off by default
  // Settings → General → Advanced → Developer tools. Off (a fresh install): no Record, no Activity, no ⌘L, no
  // "Sent: …", no hashes or raw settings, and the shell's menu has no Classic Editor / Reload / Developer Tools.
  const shown = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0; })()`);
  const settingsUp = () => js('!!document.querySelector(".modal.settings-modal")');
  check('Developer tools are off on a fresh install', await js('!__devTools.on && !document.body.classList.contains("dev-tools") && localStorage.getItem("settings.devTools") === null'));
  check('dev tools off: no Record or Activity button in the status bar', !(await shown('#recBtn')) && !(await shown('#drawerBtn')) && await shown('#settingsBtn') && await shown('#keysBtn') && await shown('#supportBtn'));
  await js('document.activeElement.blur()');
  await key('l', [MOD]);
  check('dev tools off: ⌘L does nothing', await js('!__ui.drawerOpen && !document.getElementById("drawer").classList.contains("open")'));
  await js('document.getElementById("recBtn").click()');
  check('dev tools off: Record cannot be armed', await js('!__rec.on'));
  let dn = await mark();
  await dblclick('[data-fk="amp-gain"] svg');
  await txWait(dn);
  check('dev tools off: the log is still kept, the status bar shows no "Sent: …"', /^Sent: /.test(await js('__ui.lastAction')) && (await js('document.getElementById("lastAction").textContent')) === '' && (await txSince(dn)).length >= 1, await js('document.getElementById("lastAction").textContent'));
  await js('state.presetDirty = false; render(); document.activeElement.blur()'); await frame();
  await key('?'); await waitFor('!!document.querySelector(".modal .keys")');
  check('dev tools off: the shortcuts sheet has no ⌘L or Record row', await js('!!document.querySelector(".modal .keys") && ![...document.querySelectorAll(".modal .keys kbd")].some(k => /^(⌘|Ctrl\\+)L$/.test(k.textContent) || k.textContent === "Record")'));
  await key('Escape');
  await js('document.activeElement.blur()');
  await key(',', [MOD]); await waitFor(settingsUp);
  check('dev tools off: Settings → Advanced shows the switch, off, with its detail', await js('(() => { const b = document.querySelector(\'[data-fk="set-devtools"]\'); return !!b && b.textContent === "Developer tools" && b.getAttribute("aria-checked") === "false" && b.closest("section").querySelector("h3").textContent === "Advanced"; })()') && (await js('document.querySelector(\'[data-fk="set-devtools-note"]\').textContent')) === 'Shows the Activity log, session recording and protocol details. For troubleshooting and development.');
  check('dev tools off: no "Show the Activity drawer at launch" or recordings folder', !(await shown('[data-fk="set-drawer"]')) && !(await shown('[data-fk="set-reveal"]')));
  await click('[data-fk="set-tab-device"]');
  await waitFor(async () => (await js('document.querySelector(\'[data-fk="dev-serial"]\')?.textContent')) === 'NP00XXXXXX');
  check('dev tools off: Settings → Device has no Hash row and no Raw settings', !(await shown('[data-fk="dev-hash"]')) && !(await shown('[data-fk="dev-raw"]')) && await shown('[data-fk="dev-serial"]') && await shown('[data-fk="dev-brightness"]'));
  await key('Escape'); await waitFor(async () => !(await settingsUp())); await settle();
  await rightClick('[data-fk="capslot-1"]');
  await js(ctxItem('Info') + '.click()');
  await waitFor('!!document.querySelector(\'[data-fk="cap-author"]\')');
  check('dev tools off: capture Info… has no Hash line or Copy button', !(await shown('[data-fk="cap-hash"]')) && !(await shown('[data-fk="cap-copy"]')) && await shown('[data-fk="cap-author"]'));
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")'); await settle();
  // the shell's menu (src/menu.js builds the template main.js uses)
  const { menuTemplate, menuLabels } = require('../src/menu');
  const menuFor = (devTools, isMac = true) => menuLabels(menuTemplate({ isMac, appName: 'Nano Cortex Editor', devTools, editorFlavor: 'pro', links: LINKS, a: new Proxy({}, { get: () => () => {} }) }));
  for (const mac of [true, false]) {
    const off = menuFor(false, mac), on = menuFor(true, mac);
    check('menu (' + (mac ? 'macOS' : 'Windows and Linux') + ', dev tools off): no Classic Editor, Reload Current or Developer Tools; Help → Show Log File', !off.includes('Classic Editor') && !off.includes('Reload Current') && !off.includes('Developer Tools') && off.includes('Show Log File'), off.join(','));
    check('menu (' + (mac ? 'macOS' : 'Windows and Linux') + ', dev tools on): Classic Editor, Reload Current and Developer Tools are back; Show Log File stays', on.includes('Classic Editor') && on.includes('Reload Current') && on.includes('Developer Tools') && on.includes('Show Log File'), on.join(','));
  }
  // the log file on disk (src/activity-log.js, written by main for everyone): batched, capped at 2 MB, one old file
  {
    const { createActivityLog, rotateIfNeeded, MAX_BYTES } = require('../src/activity-log');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-log-'));
    const file = path.join(dir, 'activity.log');
    check('the log file cap is 2 MB', MAX_BYTES === 2 * 1024 * 1024);
    const lg = createActivityLog(file, { max: 4096, flushMs: 50 });
    lg.write('TX Amp gain = 128: 0A C0 08 01', new Date(0));
    check('log lines are batched, not written per line', !fs.existsSync(file));
    await lg.flush();
    check('the log file is written with timestamps', fs.readFileSync(file, 'utf8') === '1970-01-01T00:00:00.000Z TX Amp gain = 128: 0A C0 08 01\n', JSON.stringify(fs.readFileSync(file, 'utf8')));
    for (let round = 0; round < 7; round++) { for (let i = 0; i < 10; i++) lg.write('RX line ' + round + '.' + i + ' ' + 'x'.repeat(40)); await lg.flush(); }
    const files = fs.readdirSync(dir).sort();
    const size = (f) => fs.statSync(path.join(dir, f)).size;
    check('rotation keeps the current file under the cap and one old file', files.join(',') === 'activity.1.log,activity.log' && size('activity.log') <= 4096 && size('activity.1.log') > 4096, files.map(f => f + ':' + size(f)).join(','));
    check('the newest lines are in activity.log', /RX line 6\.9 /.test(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, 'y'.repeat(5000));
    check('rotateIfNeeded moves an oversized file to activity.1.log, replacing the old one', rotateIfNeeded(file, 4096) && !fs.existsSync(file) && size('activity.1.log') === 5000 && !rotateIfNeeded(file, 4096));
    lg.write('after rotation'); lg.flushSync();
    check('writing continues in a fresh activity.log', fs.readFileSync(file, 'utf8').endsWith(' after rotation\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- developer tools: on (once, with the real switch)
  await key(',', [MOD]); await waitFor(settingsUp);
  await click('[data-fk="set-devtools"]');
  check('the Developer tools switch is stored (settings.devTools)', (await js('localStorage.getItem("settings.devTools")')) === 'true' && await js('__devTools.on && document.body.classList.contains("dev-tools")'));
  check('dev tools on: the Activity-at-launch and recordings rows appear live in Settings', await shown('[data-fk="set-drawer"]') && await shown('[data-fk="set-reveal"]'));
  await click('[data-fk="set-tab-device"]');
  await waitFor(() => shown('[data-fk="dev-hash"]'));
  check('dev tools on: Settings → Device shows Hash and Raw settings', await shown('[data-fk="dev-hash"]') && await shown('[data-fk="dev-raw"]'));
  await key('Escape'); await waitFor(async () => !(await settingsUp())); await settle();
  check('dev tools on: Record and Activity are back in the status bar', await shown('#recBtn') && await shown('#drawerBtn'));
  check('dev tools on: the status bar shows the last "Sent: …"', /^Sent: /.test(await js('document.getElementById("lastAction").textContent')));

  // ---------------------------------------------------------------- capture amp knob
  // double-click reset (also puts Gain mid-travel for the drag tests)
  let n0 = await mark();
  await dblclick('[data-fk="amp-gain"] svg');
  check('double-click resets Gain to 50%', (await js('state.amp.gain')) === 128, String(await js('state.amp.gain')));
  check('reset is sent', (await txWait(n0, tx => tx.some(t => /Amp gain = 128/.test(t)))).some(t => /Amp gain = 128/.test(t)));
  await js('state.presetDirty = false; render()'); await frame();

  n0 = await mark();
  const gain0 = await js('state.amp.gain');
  await drag('[data-fk="amp-gain"] svg', 40, [], async () => {
    const live = await waitFor(async () => (await txSince(n0)).some(t => /Amp gain/.test(t)));
    check('drag sends Gain while the pointer is held', live && (await txSince(n0)).some(t => /Amp gain/.test(t)), JSON.stringify(await txSince(n0)));
    await js('window.__activeKnob = document.querySelector("[data-fk=amp-gain]"); render()');
    await frame();
    check('a readback render waits for the active knob drag', await js('window.__activeKnob === document.querySelector("[data-fk=amp-gain]") && __ui.knobDragging'));
  });
  const gain1 = await js('state.amp.gain');
  check('dragging Gain up raises it', gain1 > gain0, gain0 + ' → ' + gain1);
  let tx = await txWait(n0);
  check('drag sends the final Gain value', tx.some(t => t.includes('Amp gain = ' + gain1 + ':')), JSON.stringify(tx));
  check('edit marks preset dirty', await js('!document.getElementById("dirtyMark").hidden && getComputedStyle(document.getElementById("dirtyMark")).display !== "none"'));
  check('Save button highlights when dirty', await js('document.getElementById("saveBtn").classList.contains("primary")'));

  // shift drag = fine
  const g2 = await js('state.amp.gain');
  await drag('[data-fk="amp-gain"] svg', 40, ['shift']);
  const g3 = await js('state.amp.gain');
  const coarse = gain1 - gain0, fine = g3 - g2;
  check('shift-drag moves ~10x less', fine > 0 && fine * 5 < coarse, `normal Δ${coarse}, fine Δ${fine}`);

  // tiny jitter (<2px) on mousedown is not treated as a drag
  n0 = await mark();
  await drag('[data-fk="amp-gain"] svg', 1);
  await settle();
  check('1px wobble is ignored (no write)', (await txSince(n0)).length === 0);

  // wheel: each changed value is sent live; the 160 ms quiet period only commits the UI edit.
  n0 = await mark();
  const v0 = await js('state.captureVolumeDb');
  await wheel('[data-fk="cap-vol"]', 100, 5); // +deltaY here = scroll up (verified)
  tx = await txWait(n0);
  const v1 = await js('state.captureVolumeDb');
  check('wheel up raises capture volume', v1 > v0, v0 + ' → ' + v1);
  check('5 wheel ticks → live writes with the final value', tx.length >= 1 && tx.every(t => /Capture volume/.test(t)) && tx[tx.length - 1].includes('Capture volume ' + v1.toFixed(1) + ' dB'), v1 + ' ' + JSON.stringify(tx));

  // keyboard on knob
  await click('[data-fk="amp-bass"] .label');
  const b0 = await js('state.amp.bass');
  n0 = await mark();
  await key('Up'); await key('Up'); await key('Up', ['shift']);
  tx = await txWait(n0);
  const b1 = await js('state.amp.bass');
  check('arrow keys adjust focused knob', b1 > b0, b0 + ' → ' + b1);
  check('knob keeps focus after re-render', await js('document.activeElement && document.activeElement.dataset.fk === "amp-bass"'));
  check('arrow keys send a live write', tx.length >= 1);

  // ---------------------------------------------------------------- pedal-originated live parameter reports
  const rxLiveParameter = (id, raw, omitId = false) => js(`(() => {
    const value = ${raw};
    const idField = ${omitId} ? [] : [0x18, ${id}];
    const payload = [0x08, 0x01, ...idField, ...(value ? [0x20, ...encodeVarint(value)] : []), 0x30, 0x01];
    const d = buildFrame(payload, 26);
    window.onC305({ target: { value: { buffer: d.buffer } } });
  })()`);
  const ampBeforePedal = await js('({...state.amp})');
  const capBeforePedal = await js('state.captureVolumeDb');
  const gateBeforePedal = await js('state.gate.params[0].value');
  const ampReports = [['gain', 0x00, 201, true], ['level', 0x01, 73], ['bass', 0x02, 182], ['mid', 0x03, 37], ['treble', 0x04, 224]];
  for (const [key, id, raw, omitId] of ampReports) {
    await rxLiveParameter(id, raw, omitId); await frame();
    check('pedal report updates ' + key, (await js(`state.amp.${key}`)) === raw, String(await js(`state.amp.${key}`)));
  }
  await rxLiveParameter(0x00, 0, true); await frame();
  check('pedal zero-gain report updates gain when both zero fields are omitted', await js('state.amp.gain === 0 && document.querySelector("[data-fk=amp-gain]").getAttribute("aria-valuenow") === "0"'));
  check('pedal MID report redraws the active knob', await js('document.querySelector("[data-fk=amp-mid]").getAttribute("aria-valuenow") === "37" && document.querySelector("[data-fk=amp-mid] .val").textContent === "15%"'));
  const capRaw = 191;
  await rxLiveParameter(0x0A, capRaw); await frame();
  check('pedal report updates capture volume', await js(`Math.abs(state.captureVolumeDb - (((${capRaw} - 128) / 127) * 12)) < 1e-9 && document.querySelector('[data-fk="cap-vol"] .val').textContent === '+6.0 dB'`));
  await js('__ui.selected = "gate"; render()'); await frame();
  await rxLiveParameter(0x0B, 158); await frame();
  check('pedal report updates gate reduction', await js('state.gate.params[0].value === 50 && document.querySelector("[data-fk=gate-red] .val").textContent === "50%"'));

  // Type 99 is the contextual FX parameter report: the block slot and
  // parameter index identify any effect parameter, while field 5 carries the
  // pedal's raw 0..255 value as a float32. Keep this test on a non-selected
  // block so it also verifies that switching to that block later uses the
  // value received from the pedal.
  const rxFXParameter = (blockSlot, paramIndex, raw) => js(`(() => {
    const payload = [0x08, 0x01, ...((${blockSlot}) ? [0x18, ${blockSlot}] : []), ...((${paramIndex}) ? [0x20, ${paramIndex}] : []), ...((${raw}) ? [0x2D, ...float32LE(${raw})] : [])];
    const d = buildFrame(payload, 99);
    window.onC305({ target: { value: { buffer: d.buffer } } });
  })()`);
  const rxFXEnable = (enableSlot, enabled, includeState = true) => js(`(() => {
    const payload = [0x08, 0x01, 0x18, ${enableSlot}, ...(${includeState} ? [0x20, ${enabled ? 0 : 1}] : [])];
    const d = buildFrame(payload, 31);
    window.onC305({ target: { value: { buffer: d.buffer } } });
  })()`);
  const rxPresetDirty = (dirty = true) => js(`(() => {
    const payload = [0x08, 0x01, ...(${dirty} ? [0x18, 0x01] : [])];
    const d = buildFrame(payload, 115);
    window.onC305({ target: { value: { buffer: d.buffer } } });
  })()`);
  const fxReportKeys = ['pre1', 'pre2', 'post1', 'post2', 'post3'];
  const fxBeforePedal = await js(`JSON.stringify(Object.fromEntries(${JSON.stringify(fxReportKeys)}.map(key => [key, { model: state.blocks[key].model, on: state.blocks[key].on, params: state.blocks[key].params }])))`);
  await js(`(() => {
    const b = state.blocks.pre2;
    const m = b.models.find(x => x.name === 'Green 808');
    b.model = m.name;
    b.params = structuredClone(m.params);
    b.on = true;
    __ui.selected = 'capture';
    render();
  })()`);
  await frame();
  await js(`(() => { for (const key of ${JSON.stringify(fxReportKeys)}) { const b = state.blocks[key]; const m = b.models.find(x => x.name !== 'None' && x.params && x.params.length); if (m && (!b.params || !b.params.length)) { b.model = m.name; b.params = structuredClone(m.params); } } render(); })()`);
  await frame();
  const fxReportRaw = [17, 51, 102, 153, 204];
  for (let slot = 0; slot < fxReportKeys.length; slot++) {
    const key = fxReportKeys[slot];
    const raw = fxReportRaw[slot];
    await rxFXParameter(slot, 0, raw); await frame();
    const expected = await js(`normalizedToParamValue(state.blocks.${key}.params[0], ${raw} / 255)`);
    check('pedal FX report updates ' + key + ' from slot ' + slot, await js(`state.blocks.${key}.params[0].value === ${expected}`), String(await js(`state.blocks.${key}.params[0].value`)));
  }
  await rxFXParameter(1, 0, 68); await frame();
  check('pedal FX report updates a non-selected effect parameter', await js('state.blocks.pre2.params[0].value === 2.7 && __ui.selected === "capture"'), String(await js('state.blocks.pre2.params[0].value')));
  await rxFXParameter(1, 1, 184); await frame();
  const expectedFXParam1 = await js('normalizedToParamValue(state.blocks.pre2.params[1], 184 / 255)');
  check('pedal FX report updates a non-zero parameter index', await js(`state.blocks.pre2.params[1].value === ${expectedFXParam1}`), String(await js('state.blocks.pre2.params[1].value')));
  await js('__ui.selected = "pre2"; render()'); await frame();
  check('opening the changed effect shows its pedal values', await js(`document.querySelector('[data-fk="p-pre2-0"]').getAttribute('aria-valuenow') === '2.7' && document.querySelector('[data-fk="p-pre2-1"]').getAttribute('aria-valuenow') === '${expectedFXParam1}'`));
  n0 = await mark();
  await rxFXParameter(1, 1, 196); await rxLiveParameter(0x06, 196); await frame(); await sleep(220);
  tx = await txSince(n0);
  check('FX parameter companion report does not trigger a full preset refresh', !tx.some(t => /^TX Current preset state request/.test(t)), JSON.stringify(tx));
  await js('__ui.selected = "capture"; render()'); await frame();
  n0 = await mark();
  await rxFXEnable(5, false); await frame();
  check('pedal FX bypass report updates the matching effect immediately', await js('state.blocks.pre2.on === false && !document.querySelector("[data-stage=pre2] .stomp").classList.contains("on")'));
  await rxPresetDirty(true); await frame(); await sleep(220);
  tx = await txSince(n0);
  check('FX bypass dirty companion preserves the effective pedal state', await js('state.blocks.pre2.on === false && !document.querySelector("[data-stage=pre2] .stomp").classList.contains("on")'));
  check('contextual FX bypass and dirty companion do not trigger a full preset refresh', !tx.some(t => /^TX Current preset state request/.test(t)), JSON.stringify(tx));
  // A manual refresh is authoritative once no local bypass target is pending.
  await js('window.applyFXEnabledStatesFromCurrentState({ 31: [{ wire: 2, raw: [0, 0, 0, 1, 1] }] }); render()');
  await frame();
  check('saved preset refresh restores the saved pedal bypass state', await js('state.blocks.pre2.on === true && document.querySelector("[data-stage=pre2] .stomp").classList.contains("on")'));
  await rxFXEnable(5, true, false); await frame();
  check('omitted bypass state defaults to enabled', await js('state.blocks.pre2.on === true && document.querySelector("[data-stage=pre2] .stomp").classList.contains("on")'));

  n0 = await mark();
  await js(`(() => {
    const report = stateValue => {
      const payload = [0x08, 0x01, 0x18, 0x05, 0x20, stateValue];
      const d = buildFrame(payload, 31);
      window.onC305({ target: { value: { buffer: d.buffer } } });
    };
    const toggle = () => document.querySelector('[data-stage=pre2] .stomp').click();
    toggle();
    report(0);
    // A stale state report from the previous write can briefly put the
    // canonical block back on. The next click must still invert the latest
    // local target, not that stale value.
    state.blocks.pre2.on = true;
    toggle();
    report(1);
    toggle();
  })()`);
  await frame(); await settle();
  const rapidBypassTx = (await txSince(n0)).filter(t => /^TX Pre FX 2 (OFF|ON)/.test(t)).map(t => t.match(/^TX Pre FX 2 (OFF|ON)/)[1]);
  check('rapid off/on/off bypass clicks keep the visible state and writes', rapidBypassTx.join('|') === 'OFF|ON|OFF' && await js('state.blocks.pre2.on === false && document.querySelector("[data-stage=pre2] .stomp").getAttribute("aria-pressed") === "false" && __ui.pendingBypassTargets.size === 0'), JSON.stringify(rapidBypassTx));
  await js('state.blocks.pre2.on = true; __ui.pendingBypassTargets.clear(); render()'); await frame(); await settle();
  n0 = await mark();
  await clickWhileReceiving('[data-stage=pre2] .stomp', async () => {
    await rxFXEnable(5, true);
    await rxFXEnable(5, true);
  });
  await settle();
  const pressBypassTx = (await txSince(n0)).filter(t => /^TX Pre FX 2 (OFF|ON)/.test(t)).map(t => t.match(/^TX Pre FX 2 (OFF|ON)/)[1]);
  const pressBypassState = await js('JSON.stringify({ on: state.blocks.pre2.on, aria: document.querySelector("[data-stage=pre2] .stomp").getAttribute("aria-pressed"), pending: __ui.pendingBypassTargets.size })');
  check('a bypass click survives a redraw during mouse press', pressBypassTx.join('|') === 'OFF' && await js('state.blocks.pre2.on === false && document.querySelector("[data-stage=pre2] .stomp").getAttribute("aria-pressed") === "false"'), JSON.stringify({ tx: pressBypassTx, state: JSON.parse(pressBypassState) }));
  await js('state.blocks.pre2.on = true; __ui.pendingBypassTargets.clear(); __ui.selected = "capture"; render()'); await frame(); await settle();
  await click('[data-stage=pre2] .stomp');
  await clickWhileReceiving('[data-stage=post3]', async () => {
    await rxFXEnable(5, true);
    await rxFXEnable(5, true);
  });
  check('selecting another chain node survives incoming bypass redraws', await js('__ui.selected === "post3"'), await js('__ui.selected'));
  await js('state.blocks.pre2.on = true; __ui.pendingBypassTargets.clear(); __ui.selected = "pre2"; render()'); await frame(); await settle();
  const contextMenuTiming = await rightClickWhileReceiving('[data-fk=node-pre2]', async () => {
    await rxFXEnable(5, true);
    await rxFXEnable(5, true);
  });
  check('chain context menu survives an incoming redraw during right-click', contextMenuTiming.afterRelease && contextMenuTiming.afterWait && await js('!!document.querySelector(".ctx")'), JSON.stringify(contextMenuTiming));
  await key('Escape');
  await rightClick('[data-stage=pre2] .stomp');
  check('right-clicking a chain bypass opens the node menu', await js('!!document.querySelector(".ctx") && !!document.querySelector(".ctx-item")'));
  await key('Escape');
  await js('state.blocks.pre2.on = true; __ui.pendingBypassTargets.clear(); __ui.selected = "pre2"; render()'); await frame(); await settle();
  n0 = await mark();
  await clickWhileReceiving('.inspector .switch', async () => {
    await rxFXEnable(5, true);
    await rxFXEnable(5, true);
  });
  await settle();
  const inspectorBypassTx = (await txSince(n0)).filter(t => /^TX Pre FX 2 (OFF|ON)/.test(t)).map(t => t.match(/^TX Pre FX 2 (OFF|ON)/)[1]);
  check('inspector bypass click survives an incoming redraw', inspectorBypassTx.join('|') === 'OFF' && await js('state.blocks.pre2.on === false && document.querySelector("[data-fk=switch-pre2]").getAttribute("aria-checked") === "false"'), JSON.stringify(inspectorBypassTx));
  await js(`const before = ${fxBeforePedal}; Object.entries(before).forEach(([key, value]) => Object.assign(state.blocks[key], value)); __ui.selected = "capture"; render()`);
  await frame();

  await js('__ui.selected = "capture"; render()'); await frame();
  await js(`Object.assign(state.amp, ${JSON.stringify(ampBeforePedal)}); state.captureVolumeDb = ${capBeforePedal}; state.gate.params[0].value = ${gateBeforePedal}; render()`);
  await frame();

  n0 = await mark();
  await js(`(() => { const d = buildFrame([0x08, 0x01], 31); for (let i = 0; i < 3; i++) window.onC305({ target: { value: { buffer: d.buffer } } }); })()`);
  tx = await txWait(n0, tx => tx.some(t => /^TX Current preset state request/.test(t)));
  check('pedal state changes trigger one coalesced full refresh', tx.filter(t => /^TX Current preset state request/.test(t)).length === 1, JSON.stringify(tx));

  // Type 64 is the live expression-pedal position report. It must update the
  // assigned amount and heel/toe bypass state without waiting for Refresh.
  const pre1BeforeExpression = await js('JSON.stringify({ model: state.blocks.pre1.model, on: state.blocks.pre1.on, params: state.blocks.pre1.params })');
  const expBeforeExpression = await js('JSON.stringify({ loaded: state.exp.loaded, preset: state.exp.preset, ranges: state.exp.ranges, bypass: state.exp.bypass })');
  await js(`(() => {
    const b = state.blocks.pre1;
    const m = b.models.find(x => x.name === 'Transpose');
    b.model = m.name;
    b.params = structuredClone(m.params);
    b.on = true;
    state.exp.loaded = true;
    state.exp.preset = state.selectedPreset;
    state.exp.pending = null;
    state.exp.ranges = { pre1: { on: true, inverted: false, min: 0, max: 100 } };
    state.exp.bypass = { pre1: { on: true, mode: 'heelToe', inverted: false, delay: 600, latch: false } };
    state.connected = false;
    __ui.selected = 'capture';
    render();
  })()`);
  await frame();
  const rxExpressionPosition = raw => js(`(() => {
    const payload = [0x08, 0x01, 0x18, 0x02, ...(${raw} ? [0x20, ...encodeVarint(${raw})] : [])];
    window.onC305({ target: { value: { buffer: buildFrame(payload, 64).buffer } } });
  })()`);
  await rxExpressionPosition(0); await frame();
  check('expression heel updates the assigned effect amount', await js('state.blocks.pre1.params[1].value === -12 && document.querySelector("[data-stage=pre1] .stomp").getAttribute("aria-pressed") === "false"'));
  await rxExpressionPosition(255); await frame();
  check('expression toe updates the assigned effect amount', await js('state.blocks.pre1.params[1].value === 12 && document.querySelector("[data-stage=pre1] .stomp").getAttribute("aria-pressed") === "true"'));
  await js(`(() => {
    Object.assign(state.blocks.pre1, ${pre1BeforeExpression});
    Object.assign(state.exp, ${expBeforeExpression});
    state.connected = true;
    NanoLive.reset();
    render();
  })()`);
  await frame();
  // Only assigned FX blocks are read back while the pedal moves, and an Amount only moves on screen when its
  // parameter is known (Mix, Amount, Transpose → Semitones); otherwise the read-back shows the real value.
  const expSaved2 = await js('JSON.stringify({ loaded: state.exp.loaded, preset: state.exp.preset, ranges: state.exp.ranges, bypass: state.exp.bypass })');
  const pre2Saved = await js('JSON.stringify({ model: state.blocks.pre2.model, on: state.blocks.pre2.on, params: state.blocks.pre2.params })');
  await js('state.exp.loaded = true; state.exp.preset = state.selectedPreset; state.exp.pending = null; state.exp.ranges = {}; state.exp.bypass = {}; 0');
  check('with nothing assigned to the expression pedal there is nothing to read back', JSON.stringify(await js('NanoLive.expressionReadbackKeys()')) === '[]');
  n0 = await mark();
  await rxExpressionPosition(200); await settle();
  check('… so a pedal move sends no parameter reads', !(await txSince(n0)).some(t => /param refresh/.test(t)), JSON.stringify(await txSince(n0)));
  const vague = await js(`(() => {
    const b = state.blocks.pre2;
    const m = b.models.find(x => x.name !== 'None' && x.params && x.params.length && !x.params.some(p => /^(mix|amount)$/i.test(p.name)));
    b.model = m.name; b.params = structuredClone(m.params); b.on = true;
    state.exp.ranges = { pre2: { on: true, inverted: false, min: 0, max: 100 } };
    render();
    return { model: m.name, values: JSON.stringify(b.params.map(p => p.value)) };
  })()`);
  n0 = await mark();
  await rxExpressionPosition(255);
  tx = await txWait(n0, t => t.some(x => /^TX Pre FX 2 param refresh/.test(x)));
  check('an effect whose Amount parameter isn\'t known (' + vague.model + ') is not animated but read back', (await js('JSON.stringify(state.blocks.pre2.params.map(p => p.value))')) === vague.values && JSON.stringify(await js('NanoLive.expressionReadbackKeys()')) === '["pre2"]' && tx.some(t => /^TX Pre FX 2 param refresh/.test(t)), JSON.stringify(tx));
  await js(`(() => { Object.assign(state.exp, ${expSaved2}); Object.assign(state.blocks.pre2, ${pre2Saved}); NanoLive.reset(); render(); })()`);
  await settle();

  // type exact value
  await click('[data-fk="cap-vol"] .val');
  check('clicking value opens an input', await js('document.querySelector("[data-fk=cap-vol] input.val") !== null'));
  await key('a', [MOD]);
  await type('-6.5');
  n0 = await txCount();
  await key('Return');
  check('typed value applied', (await js('state.captureVolumeDb')) === -6.5, String(await js('state.captureVolumeDb')));
  check('typed value sent', (await txWait(n0, tx => tx.some(t => /Capture volume -6.5 dB/.test(t)))).some(t => /Capture volume -6.5 dB/.test(t)));
  check('value input closes after Enter', await js('document.querySelector("[data-fk=cap-vol] input.val") === null'));
  // escape cancels
  await click('[data-fk="cap-vol"] .val');
  await key('a', [MOD]); await type('9');
  await key('Escape');
  check('Escape cancels typed value', (await js('state.captureVolumeDb')) === -6.5);
  // out of range clamps
  await click('[data-fk="cap-vol"] .val');
  await key('a', [MOD]); await type('99'); await key('Return');
  check('out-of-range typed value clamps to max', (await js('state.captureVolumeDb')) === 12, await js('JSON.stringify({v: state.captureVolumeDb, ed: __ui.editing, ae: document.activeElement.outerHTML.slice(0,120)})'));

  // capture slot pick
  n0 = await mark();
  await click('[data-fk="capslot-5"]');
  tx = await txWait(n0, tx => tx.some(t => /capture change 5/.test(t)));
  check('clicking capture slot sends change', tx.some(t => /capture change 5/.test(t)), JSON.stringify(tx));
  await checkSoon('capture node shows new capture', async () => (await js('document.querySelector("[data-stage=capture] .model").textContent')) === 'VH4 Ch3');
  await shot('02-capture-edited');

  // ---------------------------------------------------------------- select stages
  await click('[data-stage="pre1"] .model');
  check('clicking node selects it', (await js('document.querySelector(".insp-head h1").textContent')) === 'Pre FX 1');
  check('selected node outlined', await js('document.querySelector("[data-stage=pre1]").classList.contains("selected")'));
  await shot('03-pre1');

  // keyboard stage nav from body
  await js('document.activeElement.blur()');
  await key('8');
  check('key 8 selects Post FX 3', (await js('__ui.selected')) === 'post3');
  await key('Left');
  check('← selects previous stage', (await js('__ui.selected')) === 'post2');
  await key('Right'); await key('Right');
  check('→ wraps to Gate', (await js('__ui.selected')) === 'gate');
  await key('4');

  // ---------------------------------------------------------------- FX param drag on post3
  await key('8');
  const firstKnob = await js('document.querySelector(".inspector .knob")?.dataset.fk');
  n0 = await mark();
  await drag(`[data-fk="${firstKnob}"] svg`, 40, [], async () => {
    const live = await waitFor(async () => (await txSince(n0)).some(t => /Post FX 3 param/.test(t)));
    check('FX knob sends while the pointer is held', live && (await txSince(n0)).some(t => /Post FX 3 param/.test(t)), JSON.stringify(await txSince(n0)));
  });
  tx = await txWait(n0);
  check('FX knob drag sends live param writes', tx.length >= 1 && tx.every(t => /Post FX 3 param/.test(t)), JSON.stringify(tx));

  // ---------------------------------------------------------------- model picker
  await js('document.activeElement.blur()');
  await key('m');
  check('M opens model picker', await js('!!document.querySelector(".pop")'));
  check('picker search is focused', await js('document.activeElement.classList.contains("search") && !!document.activeElement.closest(".pop")'));
  check('post3 picker offers reverbs, not delays', await js('[...document.querySelectorAll(".pop-item")].some(x => x.textContent === "Cave") && ![...document.querySelectorAll(".pop-item")].some(x => x.textContent === "Tape Delay")'));
  await type('cav');
  check('search filters list', (await js('document.querySelectorAll(".pop-item").length')) === 1);
  await shot('04-picker');
  n0 = await txCount();
  await key('Return');
  check('Enter picks model', (await js('state.blocks.post3.model')) === 'Cave');
  check('popover closes after pick', await js('!document.querySelector(".pop")'));
  tx = await txWait(n0, tx => tx.some(t => /Post FX 3 model select Cave/.test(t)));
  check('model change sent', tx.some(t => /Post FX 3 model select Cave/.test(t)), JSON.stringify(tx));
  check('inspector shows Cave params', (await js('[...document.querySelectorAll(".inspector .knob .label")].map(x=>x.textContent).join(",")')).includes('Decay'));
  // escape closes, no change
  await click('.picker-btn');
  await type('zzz');
  check('empty search shows message', await js('!!document.querySelector(".pop-none")'));
  await key('Escape');
  check('Escape closes picker without change', await js('!document.querySelector(".pop") && state.blocks.post3.model === "Cave"'));
  // click outside closes
  await click('.picker-btn');
  await click('.chain-wrap', { dy: -58 });   // the strip above the nodes: the middle of the row may be a node
  check('click outside closes picker', await js('!document.querySelector(".pop")'));
  // mouse pick
  await click('.picker-btn');
  check('picker opens on click', await js('!!document.querySelector(".pop")'));
  const third = await js('document.querySelectorAll(".pop-item")[2]?.textContent');
  await click('.pop-item[data-i="2"]');
  check('mouse click picks the clicked model', await js('!document.querySelector(".pop")') && (await js('state.blocks.post3.model')) === third, third + ' vs ' + await js('state.blocks.post3.model'));

  // ---------------------------------------------------------------- bypass
  await js('document.activeElement.blur()');
  const on0 = await js('state.blocks.post3.on');
  n0 = await mark();
  await key('b');
  check('B toggles bypass', (await js('state.blocks.post3.on')) === !on0);
  check('bypass sent', (await txWait(n0, tx => tx.some(t => /Post FX 3 (ON|OFF)/.test(t)))).some(t => /Post FX 3 (ON|OFF)/.test(t)));
  check('node LED reflects bypass', (await js('document.querySelector("[data-stage=post3] .stomp").classList.contains("on")')) === !on0);
  // stomp click on another node doesn't select it
  n0 = await mark();
  await click('[data-stage="pre1"] .stomp');
  tx = await txWait(n0, tx => tx.some(t => /Pre FX 1 (ON|OFF)/.test(t)));
  check('stomp click toggles without selecting', (await js('__ui.selected')) === 'post3' && tx.some(t => /Pre FX 1/.test(t)), JSON.stringify(tx));
  n0 = await mark();
  await click('[data-stage="pre1"] .stomp'); // put it back
  // Turning a block on reads its parameters back 250 ms later; let that read go out before the next step.
  await txWait(n0, tx => tx.some(t => /Pre FX 1 (ON|OFF)/.test(t)) && (!/Pre FX 1 ON/.test(tx.join()) || tx.some(t => /Pre FX 1 param refresh/.test(t))));
  // stomp on an empty slot: selects it and explains
  n0 = await mark();
  await click('[data-stage="post1"] .stomp');
  check('stomp on empty slot selects it', (await js('__ui.selected')) === 'post1');
  await settle();
  check('stomp on empty slot explains, sends nothing', (await js('document.getElementById("toast").textContent')).includes('Choose an effect') && (await txSince(n0)).length === 0, (await js('document.getElementById("toast").textContent')) + ' ' + JSON.stringify(await txSince(n0)));
  await key('8');
  // set a slot to None
  await key('2');
  await key('m'); await type('none'); await key('Return');
  check('choosing None empties the slot', await js('state.blocks.pre1.model === "None" && !state.blocks.pre1.on'), await js('state.blocks.pre1.model'));
  check('empty slot shows guidance', await js('!!document.querySelector(".empty-block")'));
  await key('b');
  check('cannot turn on an empty slot', await js('!state.blocks.pre1.on'));
  check('explains why via toast', (await js('document.getElementById("toast").textContent')).includes('Choose an effect'));
  await shot('05-empty-slot');

  // ---------------------------------------------------------------- sync-locked params (Tape Delay)
  await key('7');
  await key('m'); await type('tape'); await key('Return');
  const lockInfo = await js(`(() => {
    const knobs = [...document.querySelectorAll('.inspector .knob')];
    const t = knobs.find(k => k.querySelector('.label').textContent === 'Delay Time');
    const s = [...document.querySelectorAll('.inspector .choice, .inspector .knob')].find(k => k.querySelector('.label').textContent.startsWith('Sync Note'));
    return { time: t && t.classList.contains('locked'), note: s && s.classList.contains('locked') };
  })()`);
  check('Sync off: Delay Time free, Sync Note locked', lockInfo.time === false && lockInfo.note === true, JSON.stringify(lockInfo));
  await click('.inspector .choice .seg button:not(.on)');
  const lock2 = await js(`(() => {
    const t = [...document.querySelectorAll('.inspector .knob')].find(k => k.querySelector('.label').textContent === 'Delay Time');
    return t && t.classList.contains('locked');
  })()`);
  check('turning Sync on locks Delay Time', lock2 === true || lock2 === undefined, String(lock2));
  await shot('06-tape-delay');

  // ---------------------------------------------------------------- cab
  await key('5');
  check('Cab inspector', (await js('document.querySelector(".insp-head h1").textContent')) === 'Cab / IR');
  check('mic switch stays on one line', await js(`(() => { const b = [...document.querySelectorAll('[data-fk^="mic-"]')].map(x => x.getBoundingClientRect().top); return Math.max(...b) - Math.min(...b) < 2; })()`));
  check('position switch stays on one line', await js(`(() => { const b = [...document.querySelectorAll('[data-fk^="pos-"]')].map(x => x.getBoundingClientRect().top); return Math.max(...b) - Math.min(...b) < 2; })()`));
  n0 = await mark();
  const micNow = await js('state.cabIR.mic');
  const micNext = micNow === 'Condenser 414' ? 'Dynamic 57' : 'Condenser 414';
  await click(`[data-fk="mic-${micNext}"]`);
  tx = await txWait(n0, tx => tx.some(t => /^TX Cab mic\/position/.test(t)));
  check('mic click sends', tx.length >= 1 && (await js('state.cabIR.mic')) === micNext, micNow + ' → ' + await js('state.cabIR.mic'));
  check('mic packet carries the cab\'s library index (type 94)', tx.some(t => /^TX Cab mic\/position [^:]+: [0-9A-F]{2} C0 1A [0-9A-F]{2} 08 0[1-9] 12 .* 5E 00 00 00$/.test(t)), JSON.stringify(tx));
  n0 = await mark();
  await click(`[data-fk="mic-${micNext}"]`);
  await settle();
  check('clicking the current mic sends nothing', (await txSince(n0)).length === 0);
  const lp0 = await js('state.cabIR.lowPassHz');
  n0 = await mark();
  await drag('[data-fk="cab-lp"] svg', -30, [], async () => {
    const live = await waitFor(async () => (await txSince(n0)).some(t => /^TX Cab\/IR low pass/.test(t)));
    check('cab low pass sends while the pointer is held', live && (await txSince(n0)).some(t => /^TX Cab\/IR low pass/.test(t)), JSON.stringify(await txSince(n0)));
  });
  const lp1 = await js('state.cabIR.lowPassHz');
  check('low pass drag (log scale) lowers cutoff sensibly', lp1 < lp0 && lp1 > 3000, lp0 + ' → ' + lp1);
  tx = await txWait(n0);
  check('low pass drag sends live writes', tx.length >= 1 && tx.every(t => /^TX Cab\/IR low pass/.test(t)), JSON.stringify(tx));
  n0 = await mark();
  await click('[data-fk="irslot-4"]');
  check('IR slot click sends', (await txWait(n0, tx => tx.some(t => /Cab\/IR slot select 4/.test(t)))).some(t => /Cab\/IR slot select 4/.test(t)));
  await shot('07-cab');
  check('cab node subtitle not truncated', (await clipped()).length === 0, JSON.stringify(await clipped()));

  // ---------------------------------------------------------------- gate
  await key('1');
  check('Gate inspector', (await js('document.querySelector(".insp-head h1").textContent')) === 'Gate');
  n0 = await mark();
  await click('.inspector .switch');
  check('gate switch sends', (await txWait(n0, tx => tx.some(t => /Gate (ON|OFF)/.test(t)))).some(t => /Gate (ON|OFF)/.test(t)));
  if (!(await js('state.gate.on'))) {
    n0 = await mark();
    await click('[data-fk="switch-gate"]');
    await txWait(n0, tx => tx.some(t => /Gate ON/.test(t)));
  }
  const gate0 = await js('state.gate.params[0].value');
  n0 = await mark();
  await drag('[data-fk="gate-red"] svg', 20, [], async () => {
    const live = await waitFor(async () => (await txSince(n0)).some(t => /^TX Gate reduction/.test(t)));
    check('gate reduction sends while the pointer is held', live && (await txSince(n0)).some(t => /^TX Gate reduction/.test(t)), JSON.stringify(await txSince(n0)));
  });
  const gate1 = await js('state.gate.params[0].value');
  tx = await txWait(n0);
  check('gate reduction drag sends live writes', gate1 > gate0 && tx.length >= 1 && tx.every(t => /^TX Gate reduction/.test(t)), gate0 + ' → ' + gate1 + ' ' + JSON.stringify(tx));
  await shot('08-gate');

  // ---------------------------------------------------------------- preset switching with unsaved changes
  const p0 = await js('state.selectedPreset');
  await key('Down', [MOD]);
  check('dirty + next preset asks first', await js('!!document.querySelector(".modal")'));
  await shot('09-unsaved-modal');
  await key('Escape');
  check('Escape keeps current preset', (await js('state.selectedPreset')) === p0 && await js('!document.querySelector(".modal")'));
  await key('Down', [MOD]);
  await click('.modal .btn:nth-of-type(2)'); // Don't save
  await checkSoon('Don’t save switches preset', async () => (await js('state.selectedPreset')) === p0 + 1);
  await checkSoon('dirty cleared after switch', 'document.getElementById("dirtyMark").hidden');
  await checkSoon('header follows preset', async () => (await js('document.querySelector(".preset-title .name").textContent')) === 'Jubilee Crunch');
  await settle();
  // discarded edits don't stick
  await key('Up', [MOD]);
  await checkSoon('discarded edits are gone when returning', async () => (await js('state.selectedPreset')) === p0 && (await js('state.blocks.post3.model')) === 'Hall', () => js('state.blocks.post3.model'));
  await settle();

  // Discard: throw away the live edits and reload the current preset as saved on the pedal
  await js('document.activeElement.blur()');
  const discardPreset = await js('state.selectedPreset');
  check('Discard hidden when there is nothing to discard', await js('document.getElementById("discardBtn").hidden'));
  await key('4');
  const gainSaved = await js('state.amp.gain');
  await drag('[data-fk="amp-gain"] svg', 30);
  const gainEdited = await js('state.amp.gain');
  check('Discard appears once the preset is edited', gainEdited !== gainSaved && await js('!document.getElementById("discardBtn").hidden'), gainSaved + ' → ' + gainEdited);
  await shot('09b-discard');
  check('Discard is an outlined secondary button, not the accent', await js('(() => { const b = document.getElementById("discardBtn"); return b.classList.contains("outline") && !b.classList.contains("primary") && b.nextElementSibling.id === "saveBtn"; })()'));
  await rightClick(`.preset-row[data-n="${discardPreset}"]`);
  check('current preset menu offers Discard edits', await js('(() => { const b = [...document.querySelectorAll(".ctx-item")].find(x => x.textContent === "Discard edits"); return !!b && !b.disabled; })()'));
  await key('Escape');
  n0 = await mark();
  await click('#discardBtn');
  check('Discard asks first', await js('(document.querySelector(".modal h2") || {}).textContent') === 'Discard edits to ' + await js('document.querySelector(".preset-title .name").textContent') + '?');
  await key('Escape');
  await settle();
  check('Escape keeps the edits', await js('!document.querySelector(".modal")') && (await js('state.amp.gain')) === gainEdited && (await txSince(n0)).length === 0);
  await click('#discardBtn');
  await click('.modal .btn.primary');
  tx = await txWait(n0, tx => tx.some(t => /^TX Preset change \d+:/.test(t)));
  const discardTx = tx.filter(t => /^TX Preset change \d+:/.test(t));
  check('Discard reloads the current preset (one preset change)', discardTx.length === 1 && discardTx[0].startsWith('TX Preset change ' + discardPreset + ':'), JSON.stringify(tx));
  await checkSoon('Discard restores the saved values', async () => (await js('state.amp.gain')) === gainSaved && (await js('state.selectedPreset')) === discardPreset, async () => gainSaved + ' vs ' + await js('state.amp.gain'));
  await checkSoon('Discard clears dirty and hides itself', 'document.getElementById("dirtyMark").hidden && document.getElementById("discardBtn").hidden');
  await checkSoon('Discard confirms with toast', async () => (await js('document.getElementById("toast").textContent')) === 'Edits discarded; preset ' + discardPreset + ' reloaded');
  await rightClick(`.preset-row[data-n="${discardPreset}"]`);
  check('Discard edits is disabled in the menu when clean', await js('(() => { const b = [...document.querySelectorAll(".ctx-item")].find(x => x.textContent === "Discard edits"); return !!b && b.disabled; })()'));
  await key('Escape');

  // save flow
  await js('document.activeElement.blur()');
  await key('4');
  await drag('[data-fk="amp-gain"] svg', 30);
  n0 = await mark();
  await key('s', [MOD]);
  // the save waits for the pedal's state read-back (150 ms + reply)
  check('Ctrl/⌘S saves', (await txWait(n0, tx => tx.some(t => /save preset/.test(t)))).some(t => /save preset/.test(t)));
  await checkSoon('save clears dirty', 'document.getElementById("dirtyMark").hidden');
  await checkSoon('save confirms with toast', async () => (await js('document.getElementById("toast").textContent')).startsWith('Saved to preset'));
  const savedGain = await js('state.amp.gain');
  const savedPreset = await js('state.selectedPreset');
  await key('Down', [MOD]);
  check('no prompt after saving', await js('!document.querySelector(".modal")'));
  await waitFor(async () => (await js('state.selectedPreset')) === savedPreset + 1); await settle();
  await key('Up', [MOD]);
  await checkSoon('saved edits persist (demo)', async () => (await js('state.selectedPreset')) === savedPreset && (await js('state.amp.gain')) === savedGain);
  await settle();

  // save as (another slot): the chosen slot gets the write, the app switches to it, the source is untouched
  const fromPreset = await js('state.selectedPreset');
  await drag('[data-fk="amp-gain"] svg', 15);
  const liveGain = await js('state.amp.gain');
  n0 = await mark();
  await key('s', [MOD, 'shift']);
  check('⇧⌘S opens Save as', await js('!!document.querySelector(".modal .slots.presets")'));
  await shot('09b-save-as');
  check('Save as suggests an empty slot', await js('document.querySelector(".modal .slot.on .t").classList.contains("empty")'));
  await js('document.querySelector(".modal input").value = "Copy Test"');
  await click('[data-fk="saveas-30"]');
  check('picking a used slot is allowed, an empty one shows no warning', await js('document.querySelector(".modal p.warn").textContent') === '');
  await click('.modal .btn.primary');
  check('Save as writes the chosen slot', (await txWait(n0, tx => tx.some(t => /save preset 30/.test(t)))).some(t => /save preset 30/.test(t)));
  await checkSoon('Save as switches to the copy', async () => (await js('state.selectedPreset')) === 30);
  await checkSoon('Save as names the copy', async () => (await js('state.presetNames.get(30)')) === 'Copy Test');
  await checkSoon('the copy carries the live edit', async () => (await js('state.amp.gain')) === liveGain);
  await checkSoon('Save as leaves no dirty mark', 'document.getElementById("dirtyMark").hidden');
  await settle();
  await js(`document.querySelector('.preset-row[data-n="${fromPreset}"]').scrollIntoView({ block: 'center' })`); await frame();
  await click(`.preset-row[data-n="${fromPreset}"]`);
  await checkSoon('the source preset is back to its saved state', async () => (await js('state.selectedPreset')) === fromPreset && (await js('state.amp.gain')) === savedGain, async () => `preset ${await js('state.selectedPreset')} gain ${await js('state.amp.gain')} vs ${savedGain}`);
  await settle();

  // save-and-switch
  await drag('[data-fk="amp-mid"] svg', 20);
  const midBefore = await js('state.amp.mid');
  check('knob keeps focus after drag', await js('document.activeElement?.dataset.fk === "amp-mid"'));
  await key('Down', [MOD]);
  check('⌘↓ with a knob focused goes to the app, not the knob', await js('!!document.querySelector(".modal")') && (await js('state.amp.mid')) === midBefore);
  n0 = await txCount();
  await key('Return'); // primary = Save and switch
  await txWait(n0, tx => tx.some(t => /save preset/.test(t)));
  await checkSoon('Enter in modal = Save and switch', async () => (await txSince(n0)).some(t => /save preset/.test(t)) && (await js('state.selectedPreset')) === 3);
  await settle();

  // ---------------------------------------------------------------- context menus
  await rightClick('.preset-row[data-n="5"]');
  check('right-click on a preset row opens a menu', await js('!!document.querySelector(".ctx")'));
  check('preset menu has Load, Rename and Save here', await js('[...document.querySelectorAll(".ctx-item")].map(b => b.textContent).join("|")') === 'Load|Rename…|Save current sound over this preset…|Assign to footswitch IA|Assign to footswitch IB|Assign to footswitch IIA|Assign to footswitch IIB|Delete…');
  await key('Escape');
  check('Esc closes the menu', await js('!document.querySelector(".ctx")'));
  await rightClick('.preset-row[data-n="25"]');
  await js(ctxItem('Save current sound here') + '.click()');
  await checkSoon('"Save current sound here…" opens Save as on that slot', async () => (await js('document.querySelector(".modal .slot.on .n")?.textContent')) === '25');
  await key('Escape'); await waitFor('!document.querySelector(".modal")');
  await rightClick('[data-fk="node-pre1"]');
  const nodeMenuText = await js('[...document.querySelectorAll(".ctx-item")].map(b => b.textContent).join("|")');
  const wasOn = await js('state.blocks.pre1.on');
  check('node menu offers Bypass/Enable, Change effect, Clear slot', nodeMenuText === (wasOn ? 'Bypass' : 'Enable') + '|Change effect…|Clear slot', JSON.stringify(nodeMenuText));
  n0 = await mark();
  await js(ctxItem(wasOn ? 'Bypass' : 'Enable') + '.click()');
  tx = await txWait(n0, tx => tx.some(t => /Pre FX 1 (ON|OFF)/.test(t)));
  check('node menu toggles the block and sends the enable write', tx.length >= 1 && (await js('state.blocks.pre1.on')) === !wasOn, JSON.stringify(tx));
  await rightClick('[data-fk="node-pre1"]');
  n0 = await txCount();
  await js(ctxItem(wasOn ? 'Enable' : 'Bypass') + '.click()');
  await checkSoon('node menu toggles it back', async () => (await js('state.blocks.pre1.on')) === wasOn);
  await txWait(n0, tx => tx.some(t => /Pre FX 1 (ON|OFF)/.test(t)) && (!/Pre FX 1 ON/.test(tx.join()) || tx.some(t => /Pre FX 1 param refresh/.test(t))));
  await click('[data-fk="node-capture"]'); await waitFor('document.querySelector(".insp-head h1")?.textContent === "Capture"');
  await rightClick('[data-fk="capslot-7"]');
  const slotMenuText = await js('[...document.querySelectorAll(".ctx-item")].map(b => b.textContent).join("|")');
  check('slot menu offers Load, Put a library capture and Info', slotMenuText === 'Load into this preset|Put a library capture in slot 7…|Info…', JSON.stringify(slotMenuText) + ' slot7=' + await js('!!document.querySelector(\'[data-fk="capslot-7"]\')'));
  await js(ctxItem('Put a library capture') + '?.click()');
  await checkSoon('"Put a library capture in slot 7…" opens the library picker', '!!document.querySelector(".pop") && document.querySelectorAll(".pop-item").length > 0', async () => 'pop=' + await js('!!document.querySelector(".pop")') + ' items=' + await js('document.querySelectorAll(".pop-item").length'));
  const libPick = await js('(() => { const it = [...document.querySelectorAll(".pop-item")].find(x => !x.classList.contains("cur")); if (!it) return ""; const name = (it.querySelector(".name") || it).textContent.replace(/Current$/, "").trim(); it.click(); return name; })()');
  await checkSoon('the picked capture lands in slot 7 without the slot chooser', async () => libPick !== '' && (await js('state.captureNames.get(7)')) === libPick && await js('!document.querySelector(".modal")'), async () => 'picked=' + JSON.stringify(libPick) + ' slot7=' + await js('state.captureNames.get(7)') + ' modal=' + await js('!!document.querySelector(".modal")'));
  await settle();
  await js('__closePopover(); __ui.slotPreselect = 0'); await key('Escape');
  await key('s', [MOD]); await waitFor('!state.presetDirty'); await settle();   // the slot load marked the preset dirty; save so the list tests start clean
  // delete a preset (type 50 → 51), from the row menu, confirmed in a dialog
  await rightClick('.preset-row[data-n="24"]');
  await js(ctxItem('Delete') + '?.click()');
  await checkSoon('Delete… asks first', async () => (await js('document.querySelector(".modal h2")?.textContent') || '').startsWith('Delete preset 24'));
  n0 = await txCount();
  await click('.modal .btn.primary');
  tx = await txWait(n0, tx => tx.some(t => /^TX Delete preset 24:/.test(t)));
  check('delete sends type 50 for that slot', tx.some(t => /^TX Delete preset 24: 08 C0 08 02 18 17 32 00 00 00$/.test(t)), JSON.stringify(tx));
  await checkSoon('the slot reads Empty afterwards', async () => (await js('state.presetNames.get(24)')) === 'Empty' && await js('document.querySelector(\'.preset-row[data-n="24"]\').classList.contains("empty")'));
  await rightClick('.preset-row[data-n="24"]');
  check('Delete… is disabled on an empty slot', await js(ctxItem('Delete') + '?.disabled === true'));
  await key('Escape');
  check('no overlay left behind by the menus', await js('!document.querySelector(".ctx-bg, .pop, .modal-bg")'), 'left: ' + await js('[...document.querySelectorAll(".ctx-bg, .pop, .modal-bg")].map(e => e.className).join(",")') + ' top@row10: ' + await js('(() => { const r = document.querySelector(\'.preset-row[data-n="10"]\').getBoundingClientRect(); const e = document.elementFromPoint(r.x + 5, r.y + 5); return e ? e.className + "/" + e.tagName : "none"; })()'));

  // ---------------------------------------------------------------- footswitches (4-Preset mode slots IA IB IIA IIB)
  // Assigning = type 29 with field 4 = -1, the slot's field (5-8) = preset index, the rest -1, field 9 = 0
  // (docs/INVESTIGATION.md §8). The expected bytes are built from that pattern; IA = 14 is the trace's frame verbatim.
  const NEG1 = 'FF FF FF FF FF FF FF FF FF 01';
  const fsHex = (slotField, idx) => ['36 C0 18 00 20', NEG1, ...[5, 6, 7, 8].map(f => (f * 8).toString(16).toUpperCase() + ' ' + (f === slotField ? idx.toString(16).toUpperCase().padStart(2, '0') : NEG1)), '48 00 1D 00 00 00'].join(' ');
  check('assignment frame for IA = preset index 14 equals the phone app\'s bytes', (await js('hex(__footswitchFrame("a1", 14))')) === '36 C0 18 00 20 ' + NEG1 + ' 28 0E 30 ' + NEG1 + ' 38 ' + NEG1 + ' 40 ' + NEG1 + ' 48 00 1D 00 00 00' && (await js('hex(__footswitchFrame("b1", 0))')) === fsHex(6, 0), await js('hex(__footswitchFrame("a1", 14))'));
  await js('state.presetDirty = false; render()'); await frame();
  const fsCells = () => js('[...document.querySelectorAll(".fs-cell")].map(c => [...c.children].map(x => x.textContent).join(" ")).join("|")');
  const pn = async (n) => js('state.presetNames.get(' + n + ')');
  check('footswitch strip shows IA, IB, IIA, IIB with the demo presets', (await fsCells()) === ['IA 1 ' + await pn(1), 'IB 3 ' + await pn(3), 'IIA 7 ' + await pn(7), 'IIB 15 ' + await pn(15)].join('|'), await fsCells());
  check('footswitch cells sit in a 2 × 2 grid (I on top, II below, 6 px / 8 px gaps, ~44 px tall)', await js(`(() => { const r = [...document.querySelectorAll('.fs-cell')].map(c => c.getBoundingClientRect()); return r.length === 4 && r[0].top === r[1].top && r[2].top === r[3].top && r[2].top > r[0].bottom - 1 && r[1].left > r[0].right - 1 && r[2].top - r[0].bottom === 8 && r[1].left - r[0].right === 6 && r.every(b => b.height >= 42 && b.height <= 46); })()`));
  check('footswitch cells are two lines (label and number, then the name) and names like "Princeton Clean" fit untruncated', await js(`[...document.querySelectorAll('.fs-cell')].every(c => { const k = c.querySelector('.k').getBoundingClientRect(), n = c.querySelector('.n').getBoundingClientRect(), t = c.querySelector('.t'); return Math.abs(k.top - n.top) < 2 && n.left >= k.right - 0.5 && t.getBoundingClientRect().top >= k.bottom - 1 && (c.dataset.fk === 'fs-b2' || t.scrollWidth <= t.clientWidth); })`), await js(`[...document.querySelectorAll('.fs-cell .t')].map(t => t.textContent + ':' + t.scrollWidth + '/' + t.clientWidth).join(' ')`));
  n0 = await mark();
  await click('[data-fk="fs-a2"]');
  tx = (await txWait(n0, tx => tx.some(t => /^TX Preset change \d+:/.test(t)))).filter(t => /^TX Preset change \d+:/.test(t));
  await waitFor(async () => (await js('state.selectedPreset')) === 7);
  check('clicking footswitch IIA loads preset 7 (one preset change, slot byte 9:2)', tx.length === 1 && /^TX Preset change 7: .* 48 02 1D 00 00 00$/.test(tx[0]) && (await js('state.selectedPreset')) === 7, JSON.stringify(tx));
  await checkSoon('the current preset\'s footswitch cell is highlighted', async () => (await js('[...document.querySelectorAll(".fs-cell.active")].map(c => c.dataset.fk).join()')) === 'fs-a2');
  await rightClick('[data-fk="fs-b2"]');
  check('footswitch menu offers Assign current preset and Assign…', (await js('[...document.querySelectorAll(".ctx-item")].map(b => b.textContent).join("|")')) === 'Assign current preset|Assign…');
  n0 = await mark();
  await js(ctxItem('Assign current preset') + '.click()');
  tx = (await txWait(n0, tx => tx.some(t => /^TX Assign/.test(t)))).filter(t => /^TX Assign/.test(t));   // the core follows the type-31 notice with a state read, like the app
  check('"Assign current preset" on IIB sends exactly the assignment frame', tx.length === 1 && tx[0] === 'TX Assign preset 7 to footswitch IIB: ' + fsHex(8, 6), JSON.stringify(tx));
  await checkSoon('IIB then shows preset 7, highlighted with IIA', async () => (await js('[...document.querySelector(\'[data-fk="fs-b2"]\').children].map(x => x.textContent).join(" ")')) === 'IIB 7 ' + await pn(7) && (await js('document.querySelectorAll(".fs-cell.active").length')) === 2 && (await js('document.getElementById("toast").textContent')) === 'Preset 7 on footswitch IIB' && await js('__ui.logs.some(l => l.text === "Assigned preset 7 to footswitch IIB")'));
  check('(demo) the next state dump reports IIB = preset index 6', (await js('(() => { const f = parseProtoFields(Array.from(__demo.stateDump()).slice(2, -4)); return f[39] && f[39][0].value; })()')) === 6);
  await shot('xx-footswitches');
  await rightClick('.preset-row[data-n="7"]');
  check('preset-row menu: "Assign to footswitch" is disabled for slots already holding the preset', await js(ctxItem('Assign to footswitch IIA') + '.disabled && ' + ctxItem('Assign to footswitch IIB') + '.disabled && !' + ctxItem('Assign to footswitch IA') + '.disabled'));
  await key('Escape');
  await rightClick('[data-fk="fs-a1"]');
  await js(ctxItem('Assign…') + '.click()'); await waitFor('document.querySelectorAll(".pop .pop-item").length > 0');
  check('"Assign…" opens a preset picker, non-empty presets first', await js('(() => { const g = [...document.querySelectorAll(".pop .pop-group")].map(x => x.textContent); return document.querySelectorAll(".pop .pop-item").length === 64 && g[0] === "Presets" && g[1] === "Empty slots"; })()'), await js('[...document.querySelectorAll(".pop .pop-group")].map(x => x.textContent).join()'));
  n0 = await mark();
  await js('[...document.querySelectorAll(".pop .pop-item")].find(x => x.textContent.startsWith("15 ")).click()');
  tx = (await txWait(n0, tx => tx.some(t => /^TX Assign/.test(t)))).filter(t => /^TX Assign/.test(t));
  await waitFor(async () => (await js('state.presetSlots.a1')) === 14);
  check('picking preset 15 for IA sends the phone app\'s frame byte for byte', tx.length === 1 && tx[0] === 'TX Assign preset 15 to footswitch IA: 36 C0 18 00 20 ' + NEG1 + ' 28 0E 30 ' + NEG1 + ' 38 ' + NEG1 + ' 40 ' + NEG1 + ' 48 00 1D 00 00 00' && (await js('state.presetSlots.a1')) === 14, JSON.stringify(tx));
  await js('state.presetSlots = { ...state.presetSlots, b2: 20 }; render()'); await frame();   // stale on purpose
  n0 = await mark();
  await click('[data-fk="fs-a1"]');
  tx = (await txWait(n0, tx => tx.some(t => /^TX Preset change \d+:/.test(t)))).filter(t => /^TX Preset change \d+:/.test(t));
  await waitFor(async () => (await js('state.selectedPreset')) === 15 && (await js('state.presetSlots.b2')) === 6 && (await js('[...document.querySelectorAll(".fs-cell.active")].map(c => c.dataset.fk).join()')) === 'fs-a1');
  check('a preset switch re-reads the slots from the (demo) state dump', (await js('state.selectedPreset')) === 15 && tx.length === 1 && / 48 00 1D 00 00 00$/.test(tx[0]) && (await js('state.presetSlots.b2')) === 6 && (await js('[...document.querySelectorAll(".fs-cell.active")].map(c => c.dataset.fk).join()')) === 'fs-a1', JSON.stringify(tx) + ' ' + JSON.stringify(await js('state.presetSlots')));

  // an assignment drops unsaved edits on the pedal, so it asks first like a preset switch
  await js('state.presetDirty = true; render()'); await frame();
  await rightClick('[data-fk="fs-b1"]');
  await js(ctxItem('Assign current preset') + '.click()'); await waitFor('!!document.querySelector(".modal h2")');
  check('assigning with unsaved edits asks first (Save changes to …?)', (await js('document.querySelector(".modal h2")?.textContent') || '').startsWith('Save changes to ') && (await js('[...document.querySelectorAll(".modal button")].map(b => b.textContent).join("|")')) === 'Cancel|Don’t save|Save and assign', await js('[...document.querySelectorAll(".modal button")].map(b => b.textContent).join("|")'));
  n0 = await mark();
  await key('Escape'); await settle();
  check('Escape cancels: nothing sent, edits kept', (await txSince(n0)).length === 0 && await js('!document.querySelector(".modal") && state.presetDirty === true') && (await js('state.presetSlots.b1')) === 2, JSON.stringify(await txSince(n0)));
  await rightClick('[data-fk="fs-b1"]');
  await js(ctxItem('Assign current preset') + '.click()'); await waitFor('!!document.querySelector(".modal button")');
  n0 = await mark();
  await js('[...document.querySelectorAll(".modal button")].find(b => b.textContent === "Don’t save").click()');
  tx = (await txWait(n0, tx => tx.some(t => /^TX Assign/.test(t)))).filter(t => /^TX /.test(t) && !/state request|Expression assignments request/.test(t));
  await waitFor(async () => (await js('state.presetDirty')) === false && (await js('state.presetSlots.b1')) === 14);
  check('"Don’t save" sends just the assignment and clears the edits', tx.length === 1 && tx[0] === 'TX Assign preset 15 to footswitch IB: ' + fsHex(6, 14) && (await js('state.presetDirty')) === false && (await js('state.presetSlots.b1')) === 14, JSON.stringify(tx));

  // ---------------------------------------------------------------- preset list
  await click('.preset-row[data-n="7"]');
  await checkSoon('click preset row loads it', async () => (await js('state.selectedPreset')) === 7);
  await settle();
  await key('f', [MOD]);
  check('Ctrl/⌘F focuses filter', await js('document.activeElement.id === "presetFilter"'));
  await type('surf');
  check('filter narrows list', (await js('document.querySelectorAll(".preset-row").length')) >= 1 && (await js('[...document.querySelectorAll(".preset-row .t")].every(x => /surf/i.test(x.textContent))')));
  await js('{ const f=document.getElementById("presetFilter"); f.value=""; f.dispatchEvent(new Event("input")); }');
  await type('qqq');
  check('no-match message', await js('!!document.querySelector(".side-empty")'));
  await js('{ const f=document.getElementById("presetFilter"); f.value=""; f.dispatchEvent(new Event("input")); }');
  // keyboard in list
  await click('.preset-row[data-n="10"]'); await waitFor(async () => (await js('state.selectedPreset')) === 10); await settle();
  await key('Down'); await key('Down');
  await checkSoon('arrow keys in list step through presets (debounced)', async () => (await js('state.selectedPreset')) === 12, () => js('String(state.selectedPreset)'));
  await settle();
  const writesForPresets = (await js('__ui.logs.filter(l=>/external preset change ack|Current preset state request/.test(l.text)).length'));
  check('preset list keeps focus', await js('document.activeElement.id === "presetList"'));

  // ---------------------------------------------------------------- preset switching over Bluetooth
  n0 = await mark();
  await click('.preset-row[data-n="5"]');
  await checkSoon('preset click switches over Bluetooth', async () => (await js('state.selectedPreset')) === 5);
  tx = await txWait(n0, tx => tx.some(t => /^TX Preset change 5:/.test(t)));
  check('preset change packet sent (SetPresetSlotsRequest, type 29)', tx.some(t => /^TX Preset change 5: .*1D 00 00 00$/.test(t)), JSON.stringify(tx));
  check('status bar names the pedal and firmware, nothing redundant', (await js('document.getElementById("bleText").textContent')) === 'Demo data, nothing is sent' && await js('document.getElementById("pcText").parentElement.hidden'));
  check('one connection indicator: none in the header, the status bar LED is on', await js('!document.querySelector(".head .led, #conn, #status, #dot") && document.getElementById("bleLed").className === "led on"'));
  await js('state.presetDirty = true; render()'); await frame();
  check('pedal-reported unsaved changes show in the status bar', await js('!document.getElementById("pcText").parentElement.hidden && /unsaved/.test(document.getElementById("pcText").textContent)'));
  await click('.preset-row[data-n="6"]');
  await waitFor('!!document.querySelector(".modal")');
  check('pedal-reported dirty state also asks before switching', await js('state.selectedPreset === 5 && !!document.querySelector(".modal")'));
  await key('Escape');
  await checkSoon('cancelling the pedal-dirty switch keeps the current preset', 'state.selectedPreset === 5 && !document.querySelector(".modal")');
  await js('state.presetDirty = false; render()'); await frame();
  await checkSoon('(demo) pedal confirms the preset change', '__ui.logs.some(l => /Preset change confirmed/.test(l.text))');

  // ---------------------------------------------------------------- rename
  const oldName = await js('state.presetNames.get(state.selectedPreset)');
  await click('#renameBtn');
  check('Rename opens a dialog with the current name', (await js('document.querySelector(".modal input")?.value')) === oldName, String(await js('document.querySelector(".modal input")?.value')));
  n0 = await txCount();
  await type('Big Lead 5'); await key('Return');
  tx = await txWait(n0, tx => tx.some(t => /^TX Rename preset/.test(t)));
  check('rename sends RenamePresetRequest (type 111)', tx.some(t => /^TX Rename preset 5 to "Big Lead 5": .*6F 00 00 00$/.test(t)), JSON.stringify(tx));
  await checkSoon('header shows the new name', async () => (await js('document.querySelector(".preset-title .name").textContent')) === 'Big Lead 5');
  await checkSoon('preset list shows the new name', async () => (await js('document.querySelector(".preset-row.active .t").textContent')) === 'Big Lead 5');
  await click('#renameBtn'); await type('abc'); await key('Return');
  await checkSoon('too-short name is refused', async () => (await js('document.getElementById("toast").textContent')).includes('4 characters') && (await js('state.presetNames.get(5)')) === 'Big Lead 5');

  // ---------------------------------------------------------------- tuner
  await js('document.activeElement.blur()');
  n0 = await mark();
  await key('t');
  await checkSoon('T opens the tuner', '!document.getElementById("tunerOverlay").hidden && state.tuner.open');
  tx = await txWait(n0, tx => tx.some(t => /^TX Tuner on/.test(t)));
  check('tuner on packet sent (type 127)', tx.some(t => /^TX Tuner on \(440 Hz\): .*7F 00 00 00$/.test(t)), JSON.stringify(tx));
  await checkSoon('tuner shows a reading (demo)', async () => (await js('document.getElementById("tunerNote").textContent')) === 'E');
  await click('#tunerMute');
  check('mute resends the tuner settings', (await txWait(n0, tx => tx.some(t => /^TX Tuner settings \(440 Hz, muted\)/.test(t)))).some(t => /^TX Tuner settings \(440 Hz, muted\)/.test(t)));
  await key('5'); await frame();
  check('stage shortcuts are off while the tuner is up', (await js('__ui.selected')) !== 'cab');
  n0 = await txCount();
  await key('Escape');
  await checkSoon('Escape closes the tuner', 'document.getElementById("tunerOverlay").hidden && !state.tuner.open');
  check('tuner off packet sent', (await txWait(n0, tx => tx.some(t => /^TX Tuner off: /.test(t)))).some(t => /^TX Tuner off: /.test(t)));
  await click('#tunerBtn');
  await checkSoon('Tuner button opens the tuner and lights up', 'state.tuner.open && document.getElementById("tunerBtn").classList.contains("on")');
  await click('#tunerClose');
  await checkSoon('Close button ends the tuner and the Tuner button un-lights', '!state.tuner.open && !document.getElementById("tunerBtn").classList.contains("on")');
  await settle();

  // ---------------------------------------------------------------- header Mute and the tuner's mute re-arm
  // Mute Input is a global setting (67 {1:1 12:0|1}, read back as 66 field 15). The pedal still reports it on after the
  // tuner closes but needs a fresh off → on to mute again, so closing the tuner sends both (after the tuner-off write).
  const MUTE_IN = (on) => frameHex([0x08, 0x01, 0x60, on ? 1 : 0], 67);
  await checkSoon('the header Mute button is ready once the device settings are read at connect', '!document.getElementById("muteBtn").disabled && document.getElementById("muteBtn").getAttribute("aria-pressed") === "false"');
  n0 = await mark();
  await click('#muteBtn');
  tx = await txWait(n0, t => t.some(x => x.endsWith(': ' + MUTE_IN(true))));
  tx = tx.filter(x => /Mute Input/.test(x));
  check('header Mute sends Mute Input on, exactly 67 {1:1 12:1}', tx.length === 1 && tx[0] === 'TX Device monitoring: Mute Input ON: ' + MUTE_IN(true), JSON.stringify(tx));
  await checkSoon('… and turns red, pressed (read back from 66 field 15)', 'document.getElementById("muteBtn").classList.contains("mute-active") && document.getElementById("muteBtn").getAttribute("aria-pressed") === "true" && __dev.settings.muteInput === true');
  await click('#tunerBtn');
  await checkSoon('the tuner opens while the input is muted', 'state.tuner.open');
  n0 = await mark();
  await click('#tunerClose');
  tx = (await txWait(n0, t => t.filter(x => /^TX (Tuner off|Device monitoring: Mute Input)/.test(x)).length >= 3)).filter(x => /^TX (Tuner off|Device monitoring: Mute Input)/.test(x)).map(x => x.split(': ').pop());
  check('closing the tuner re-arms the mute: Tuner off, then Mute Input off and on again', JSON.stringify(tx) === JSON.stringify([frameHex([0x20, 0x00], 127), MUTE_IN(false), MUTE_IN(true)]), JSON.stringify(tx));
  await checkSoon('the mute is still on afterwards', '__dev.settings.muteInput === true && document.getElementById("muteBtn").classList.contains("mute-active")');
  n0 = await mark();
  await click('#muteBtn');
  tx = await txWait(n0, t => t.some(x => x.endsWith(': ' + MUTE_IN(false))));
  tx = tx.filter(x => /Mute Input/.test(x));
  check('header Mute again sends Mute Input off (an explicit 0)', tx.length === 1 && tx[0].endsWith(': ' + MUTE_IN(false)), JSON.stringify(tx));
  await checkSoon('… and the button is back to normal', '!document.getElementById("muteBtn").classList.contains("mute-active") && __dev.settings.muteInput === false');
  await click('#tunerBtn'); await checkSoon('tuner up again, input not muted', 'state.tuner.open');
  n0 = await mark();
  await click('#tunerClose'); await waitFor('!state.tuner.open');
  await settle({ quiet: 600 });
  check('without the mute, closing the tuner sends only Tuner off', JSON.stringify((await txSince(n0)).map(x => x.split(': ')[0])) === JSON.stringify(['TX Tuner off']), JSON.stringify(await txSince(n0)));

  // ---------------------------------------------------------------- metronome
  await js('document.activeElement.blur()');
  await key('n');
  await checkSoon('N opens the metronome', '!document.getElementById("metroOverlay").hidden && __metro.state.open');
  await js('__metro.setBpm(240)');
  await key(' '); await sleep(1600);
  const beats = await js('__metro.state.count');
  check('Space starts it and beats advance (240 BPM, ~1.6 s, audio start-up tolerated)', (await js('__metro.state.running')) && beats >= 3 && beats <= 8, String(beats));
  check('beat indicator follows the count', await js('document.querySelectorAll("#metroBeats span").length === 4 && !!document.querySelector("#metroBeats span.on")'));
  await key(' ');
  await checkSoon('Space stops it', '!__metro.state.running');
  await js('__metro.state.taps = [2000, 1500, 1000, 500].map(d => performance.now() - d); __metro.tap()'); await frame(); // 5 taps, 500 ms apart
  check('tap tempo averages the gaps', Math.abs((await js('__metro.state.bpm')) - 120) <= 3, String(await js('__metro.state.bpm')));
  await key('Escape');
  await checkSoon('Escape closes the metronome', 'document.getElementById("metroOverlay").hidden && !__metro.state.open');
  check('BPM is remembered', (await js('JSON.parse(localStorage.getItem("metronome")).bpm')) === 120);
  check('output selector offers the system default', await js('document.querySelector("#metroOut option").value === "" && document.querySelector("#metroOut option").textContent === "System default"'));

  // ---------------------------------------------------------------- advanced metronome
  const M = (code) => js('(() => { const m = __metro, s = m.state; return ' + code + '; })()');
  const advShown = () => js('!document.getElementById("metroAdv").hidden && getComputedStyle(document.getElementById("metroAdv")).display !== "none"');
  const evs = (setup, bar = 0) => js(`__ui.metroBarEvents(${JSON.stringify(setup)}, ${bar}).map(e => [e.offsetBeats, e.role])`);
  const near = (a, b) => a.length === b.length && a.every((e, i) => Math.abs(e[0] - b[i][0]) < 1e-4 && e[1] === b[i][1]);
  check('a fresh install: Simple mode, levels at 100 %, no stored advanced setup needed', await M('s.mode === "simple" && s.opensIn === "simple" && s.levels.accent === 1 && s.levels.main === 1 && s.levels.sub === 1'));
  await js('document.activeElement.blur()');
  await key('n'); await waitFor('!document.getElementById("metroOverlay").hidden');
  check('the overlay header has a Simple / Advanced switch, Simple selected', (await js('[...document.querySelectorAll("#metroMode button")].map(b => b.textContent + (b.classList.contains("on") ? "*" : "")).join(",")')) === 'Simple*,Advanced');
  check('Simple hides the advanced controls (no sections, Levels, bar counter)', !(await advShown()) && await js('document.getElementById("metroLevels").hidden && document.getElementById("metroStatus").hidden && !document.getElementById("metroBeatsLbl").hidden'));
  await shot('19-metro-simple');
  const hOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? Math.round(e.getBoundingClientRect().height) : -1; })()`);
  check('metronome header: "Metronome" label left, Simple / Advanced right, one line', await js('(() => { const l = document.querySelector("#metroOverlay .metro-title").getBoundingClientRect(), m = document.getElementById("metroMode").getBoundingClientRect(), c = document.querySelector("#metroOverlay .tuner-card").getBoundingClientRect(); return document.querySelector("#metroOverlay .metro-title").textContent === "Metronome" && l.left - c.left < 30 && c.right - m.right < 30 && Math.abs((l.top + l.bottom) / 2 - (m.top + m.bottom) / 2) < 2; })()'));
  check('Simple: Beats / Volume / Output share one row, controls 30 px tall', await js('(() => { const b = ["metroBeatsLbl", "metroVol", "metroOut"].map(id => document.getElementById(id).closest(".metro-field").getBoundingClientRect()); return b.every(r => Math.abs(r.bottom - b[0].bottom) < 2); })()') && (await hOf('#metroBeatsLbl .stepper')) === 30 && (await hOf('#metroOut')) === 30 && (await hOf('#metroDown')) === 30 && (await hOf('#metroTap')) === 30);
  check('the Volume label carries its value as a faint note', /^Volume\s*60\u202f%$/.test(await js('document.querySelector(".metro-vol h4").textContent')), await js('document.querySelector(".metro-vol h4").textContent'));
  await click('#metroBeatsLbl button[data-d="1"]');
  check('the Beats stepper + adds a beat (5 dots), − takes it back', await js('__metro.state.beats === 5 && document.querySelectorAll("#metroBeats span").length === 5'));
  await click('#metroBeatsLbl button[data-d="-1"]');
  check('… and back to 4', await js('__metro.state.beats === 4 && document.getElementById("metroBeatsSel").value === "4"'));
  await js('{ const r = document.getElementById("metroTempo"); r.value = "150"; r.dispatchEvent(new Event("input")); }');
  check('the tempo slider sets the BPM', await js('__metro.state.bpm === 150 && document.getElementById("metroBpm").value === "150"'));
  await js('__metro.setBpm(120)');
  await click('[data-fk="metro-mode-advanced"]'); await waitFor(advShown);
  check('the Advanced switch shows the controls', await advShown() && (await js('[...document.querySelectorAll("#metroAdv h4")].map(h => h.firstChild.textContent).join("|")')) === 'Beats|Note value|Pattern|Accents|Subdivision|Swing|Count-in' && (await js('[...document.querySelectorAll("#metroAdv .metro-trow .switch")].map(b => b.textContent).join("|")')) === 'Tempo trainer|Gap trainer' && await js('!!document.querySelector(\'[data-fk="metro-countin-0"]\')'));
  check('the Accents label has the hint beside it', (await js('document.querySelector("#metroAdv .metro-hint").textContent')) === 'Click a beat to cycle accent, normal, soft, mute' && await js('(() => { const h = document.querySelector("#metroAdv .metro-hint").getBoundingClientRect(), l = document.querySelector("#metroAdv .metro-hint").parentElement.getBoundingClientRect(); return Math.abs(h.bottom - l.bottom) < 3; })()'));
  check('Beats / Note value / Pattern and Subdivision / Swing / Count-in share three columns', await js('(() => { const x = (fk) => Math.round(document.querySelector(`[data-fk="${fk}"]`).closest(".metro-field").getBoundingClientRect().left); return x("metro-adv-beats") === x("metro-sub-1") && x("metro-note") === x("metro-swing") && x("metro-pattern") === x("metro-countin-0") && x("metro-note") - x("metro-adv-beats") > 100; })()'));
  const advH = await js('["[data-fk=\\"metro-adv-beats\\"]", "[data-fk=\\"metro-note\\"]", "[data-fk=\\"metro-pattern\\"]", "[data-fk=\\"metro-cell-0\\"]", "[data-fk=\\"metro-sub-1\\"]", "[data-fk=\\"metro-countin-0\\"]", "[data-fk=\\"metro-ramp-target\\"]", "#metroLevels", "#metroOut"].map(q => { const e = document.querySelector(q); const t = e.closest(".stepper") || (e.tagName === "BUTTON" && e.parentElement.classList.contains("seg") ? e.parentElement : e); return Math.round(t.getBoundingClientRect().height); }).join()');
  check('Advanced: one 30 px control height (stepper, pills, drop-downs, cells, Levels…)', advH === '30,30,30,30,30,30,30,30,30', advH);
  check('the trainer sentences share columns (to / play, steppers line up)', await js('(() => { const l = (fk) => Math.round(document.querySelector(`[data-fk="${fk}"]`).closest(".stepper").getBoundingClientRect().left); return l("metro-ramp-target") === l("metro-gap-play") && l("metro-ramp-step") === l("metro-gap-mute"); })()'));
  check('bar counter left and signature right on one baseline', await js('(() => { const a = document.getElementById("metroStatus").getBoundingClientRect(), b = document.getElementById("metroSig").getBoundingClientRect(); return Math.abs(a.bottom - b.bottom) < 1 && b.left > a.right + 200; })()') && (await js('document.getElementById("metroSig").textContent')) === '4/4');
  check('Volume / Output / Levels… share one bottom line', await js('(() => { const b = ["metroVol", "metroOut", "metroLevels"].map(id => document.getElementById(id).getBoundingClientRect().bottom); return Math.max(...b) - Math.min(...b) < 2; })()'));
  check('Advanced shows Levels… and the bar counter, hides the Simple beats select', await js('!document.getElementById("metroLevels").hidden && !document.getElementById("metroStatus").hidden && document.getElementById("metroBeatsLbl").hidden'));
  const cardW = await js('document.querySelector("#metroOverlay .tuner-card").getBoundingClientRect().width');
  check('the advanced card grows to ~640 px', cardW > 600 && cardW <= 642, String(cardW));
  check('advanced defaults: 4/4, beat 1 accented', (await js('document.querySelector(\'[data-fk="metro-pattern"]\').value')) === '4/4' && (await js('[...document.querySelectorAll(".metro-cell")].map(c => c.classList[1]).join()')) === 'accent,normal,normal,normal');
  check('beats per bar goes 1–16 and the note value offers 4 / 8 / 16', (await js('(() => { const i = document.querySelector(\'[data-fk="metro-adv-beats"]\'); return i.min + "-" + i.max; })()')) === '1-16' && (await js('[...document.querySelectorAll(\'[data-fk="metro-note"] button\')].map(o => o.dataset.v).join()')) === '4,8,16');
  check('the Pattern select offers 4/4, 3/4, 6/8, 5/4, 7/8, 12/8', (await js('[...document.querySelectorAll(\'[data-fk="metro-pattern"] option:not(:disabled)\')].map(o => o.textContent).join("|")')) === '4/4|3/4|6/8 (3+3)|5/4 (3+2)|7/8 (2+2+3)|12/8 (4×3)');
  const setSel = (fk, v) => js(`{ const s = document.querySelector('[data-fk="${fk}"]'); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event("change")); }`);
  const cells = () => js('[...document.querySelectorAll(".metro-cell")].map(c => c.classList[1]).join()');
  await setSel('metro-pattern', '5/4'); await frame();
  check('the 5/4 (3+2) preset sets the cells (accent soft soft normal soft)', (await cells()) === 'accent,soft,soft,normal,soft' && await M('s.adv.beats === 5 && s.adv.note === 4'));
  await setSel('metro-pattern', '7/8'); await frame();
  check('the 7/8 (2+2+3) preset sets the cells and the note value 8', (await cells()) === 'accent,soft,normal,soft,normal,soft,soft' && await M('s.adv.note === 8') && (await js('document.querySelector(\'[data-fk="metro-note"] button.on\')?.dataset.v')) === '8' && (await js('document.getElementById("metroSig").textContent')) === '7/8');
  await setSel('metro-pattern', '12/8'); await frame();
  check('the 12/8 (4×3) preset makes twelve cells in four groups of three', (await cells()) === 'accent,soft,soft,normal,soft,soft,normal,soft,soft,normal,soft,soft');
  await setSel('metro-pattern', '4/4'); await frame();
  const roles = [];
  for (let i = 0; i < 4; i++) { await click('[data-fk="metro-cell-1"]'); roles.push(await js('__metro.state.adv.pattern[1]')); }
  check('clicking a cell cycles its role: Normal → Soft → Mute → Accent → Normal', roles.join() === 'soft,mute,accent,normal', roles.join());
  await click('[data-fk="metro-cell-2"]'); await frame();
  check('an edited pattern shows as Custom', (await js('document.querySelector(\'[data-fk="metro-pattern"]\').value')) === 'custom' && (await js('document.querySelector(\'[data-fk="metro-cell-2"] .r\').textContent')) === 'Soft');
  await setSel('metro-adv-beats', 16); await frame();
  check('beats per bar goes up to 16 (new cells are Normal, edits kept)', (await js('document.querySelectorAll(".metro-cell").length')) === 16 && await M('s.adv.pattern[2] === "soft" && s.adv.pattern[15] === "normal"'));
  await setSel('metro-pattern', '4/4'); await frame();

  // the pure event generator
  const T = 1 / 3;
  check('metroBarEvents: 5/4 (3+2) with triplets', near(await evs({ beats: 5, pattern: ['accent', 'soft', 'soft', 'normal', 'soft'], sub: 3 }),
    [0, 1, 2, 3, 4].flatMap((b) => [[b, ['accent', 'soft', 'soft', 'normal', 'soft'][b]], [b + T, 'sub'], [b + 2 * T, 'sub']])), JSON.stringify(await evs({ beats: 5, pattern: ['accent', 'soft', 'soft', 'normal', 'soft'], sub: 3 })));
  const sw = async (swing) => (await evs({ beats: 2, sub: 2, swing })).map(e => e[0]);
  check('swing for 2: off-beat at 0.5 (0 %), 0.583 (50 %), 2/3 (100 %)', near((await sw(0)).map(x => [x, '']), [0, 0.5, 1, 1.5].map(x => [x, ''])) && Math.abs((await sw(50))[1] - 7 / 12) < 1e-4 && Math.abs((await sw(100))[1] - 2 / 3) < 1e-4 && Math.abs((await sw(100))[3] - 5 / 3) < 1e-4, JSON.stringify([await sw(0), await sw(50), await sw(100)]));
  check('swing for 4: 16ths pair up inside each half beat (100 % → 0, 1/3, 1/2, 5/6)', near(await evs({ beats: 1, sub: 4, swing: 100 }), [[0, 'accent'], [1 / 3, 'sub'], [0.5, 'sub'], [5 / 6, 'sub']]), JSON.stringify(await evs({ beats: 1, sub: 4, swing: 100 })));
  check('swing does nothing for triplets', near(await evs({ beats: 1, sub: 3, swing: 100 }), [[0, 'accent'], [T, 'sub'], [2 * T, 'sub']]));
  check('a muted cell stays in the list as mute (the indicator still lights)', near(await evs({ beats: 3, pattern: ['accent', 'mute', 'normal'] }), [[0, 'accent'], [1, 'mute'], [2, 'normal']]));
  const ciSetup = { beats: 3, pattern: ['accent', 'soft', 'soft'], sub: 2, countIn: 2 };
  check('count-in bars are plain clicks without subdivisions, then the pattern', near(await evs(ciSetup, 0), [[0, 'accent'], [1, 'normal'], [2, 'normal']]) && near(await evs(ciSetup, 1), [[0, 'accent'], [1, 'normal'], [2, 'normal']]) && (await evs(ciSetup, 2)).length === 6 && (await evs(ciSetup, 2))[1][1] === 'sub');
  const gapSetup = { beats: 2, sub: 2, countIn: 1, gap: { on: true, play: 2, mute: 1 } };
  const gapBars = [];
  for (let b = 0; b < 8; b++) gapBars.push([...new Set((await evs(gapSetup, b)).map(e => e[1] === 'mute' ? 'mute' : 'play'))].join('/'));
  check('gap trainer mutes the right bars (1-bar count-in, play 2, rest 1)', gapBars.join() === 'play,play,play,mute,play,play,mute,play', gapBars.join());
  check('a rest bar keeps every event (beats and subs) as mute', near(await evs(gapSetup, 3), [[0, 'mute'], [0.5, 'mute'], [1, 'mute'], [1.5, 'mute']]));
  check('tempo trainer rule: +5 every 2 bars from 96, stopping at 110', (await js('[0,1,2,3,4,5,6,7,8].map(m => __metro.rampBpm({ ramp: { on: true, target: 110, step: 5, every: 2 } }, 96, m)).join()')) === '96,96,101,101,106,106,110,110,110');
  check('the generator is exposed on window.__ui', await js('typeof __ui.metroBarEvents === "function"'));

  // subdivision / swing / count-in controls
  await click('[data-fk="metro-sub-3"]');
  check('subdivision 3 disables swing', await js('document.querySelector(\'[data-fk="metro-swing"]\').disabled') && await M('s.adv.sub === 3'));
  await click('[data-fk="metro-sub-2"]');
  await js('{ const r = document.querySelector(\'[data-fk="metro-swing"]\'); r.value = "60"; r.dispatchEvent(new Event("input")); }');
  check('subdivision 2 enables swing and the slider sets it', await js('!document.querySelector(\'[data-fk="metro-swing"]\').disabled') && await M('s.adv.sub === 2 && s.adv.swing === 60'));
  await click('[data-fk="metro-countin-1"]');
  check('count-in buttons set 0 / 1 / 2 bars', await M('s.adv.countIn === 1') && await js('document.querySelector(\'[data-fk="metro-countin-1"]\').classList.contains("on")'));

  // a real run: count-in, pattern with sub pips, then the gap trainer through the scheduler
  await js('__metro.setBpm(300)');
  await js('document.activeElement.blur()');
  // 300 BPM: one 4-beat bar takes 0.8 s, so the count-in shows first and bar 1 follows; wait for each state.
  await key(' ');
  await checkSoon('advanced run: the count-in shows in the bar counter', async () => /^Count-in 1 \/ 1$/.test(await js('document.getElementById("metroStatus").textContent')), () => js('document.getElementById("metroStatus").textContent'));
  await waitFor(() => M('s.scheduled.filter(e => e.bar === 1).length === 8 && s.scheduled.some(e => e.bar >= 2)'));
  await checkSoon('advanced run: beat pips with smaller sub pips, the bar counter counts', async () => await js('document.querySelectorAll("#metroBeats .pip").length === 4 && document.querySelectorAll("#metroBeats .subpip").length === 4') && /^Bar \d+/.test(await js('document.getElementById("metroStatus").textContent')), () => js('document.getElementById("metroStatus").textContent'));
  check('advanced run: the scheduler played count-in clicks, then the pattern with swung subs', await M(`(() => { const ev = s.scheduled; const ci = ev.filter(e => e.bar === 0), b1 = ev.filter(e => e.bar === 1); return ci.length === 4 && ci.every(e => e.role !== "sub") && b1.length === 8 && Math.abs(b1[1].offsetBeats - 0.6) < 1e-4 && b1[1].role === "sub"; })()`), await M('JSON.stringify(s.scheduled.slice(0, 12).map(e => [e.bar, e.offsetBeats, e.role]))'));
  await key(' '); await waitFor('!__metro.state.running');
  await js('(() => { const m = __metro.state; m.adv = __metro.normSetup({ beats: 1, sub: 1, countIn: 0, gap: { on: true, play: 1, mute: 2 } }); })()');
  await key(' ');
  await waitFor(() => M('s.scheduled.some(e => e.bar >= 6) && s.count >= 7'));
  const gapRun = await M('s.scheduled.map(e => e.bar + ":" + e.role).join()');
  check('gap trainer through the scheduler: bars 0, 3, 6 play, the rest are muted', /^0:accent,1:mute,2:mute,3:accent,4:mute,5:mute,6:accent/.test(gapRun), gapRun);
  check('the beat indicator keeps running through the rests', await M('s.count >= 7'), String(await M('s.count')));
  await key(' '); await waitFor('!__metro.state.running');
  // the tempo trainer
  await js('(() => { const m = __metro.state; m.adv = __metro.normSetup({ beats: 1, sub: 1, ramp: { on: true, target: 250, step: 5, every: 1 } }); })()');
  await js('__metro.setBpm(240)'); await frame();
  check('the trainer shows its range before starting', (await js('document.getElementById("metroRamp").textContent')) === 'ramps 240 → 250');
  await key(' ');
  await checkSoon('while running it shows "ramping 240 → 250"', async () => (await js('document.getElementById("metroRamp").textContent')) === 'ramping 240 → 250');
  // 1-beat bars at ~245 BPM: the ramp reaches 250 after two bars; wait until a few bars ran at the target.
  await waitFor(() => M('s.scheduled.filter(e => e.bpm === 250).length >= 3'));
  const bpms = await M('[...new Set(s.scheduled.map(e => e.bpm))].join()');
  check('the tempo ramp steps the BPM a bar at a time and stops at the target', bpms === '240,245,250', bpms);
  check('the ramped tempo is the stored BPM', await M('s.bpm === 250') && (await js('JSON.parse(localStorage.getItem("metronome")).bpm')) === 250);
  await key(' '); await waitFor('!__metro.state.running');
  check('the tempo has one source the scheduler reads (preset tempo ready for later)', await M('s.tempoFollowsPreset === false && m.effectiveBpm() === 250 && (s.presetTempo = 99, s.tempoFollowsPreset = true, m.effectiveBpm() === 99) && (s.tempoFollowsPreset = false, s.presetTempo = null, m.effectiveBpm() === 250)'));
  const hookSeen = await M('(() => { const seen = [], app = s.onTempoChange; s.onTempoChange = (b, src) => seen.push(b + src); m.setBpm(121); s.onTempoChange = app; return seen.join(); })()');
  check('a user tempo change calls the onTempoChange hook', hookSeen === '121user', hookSeen);
  check('every role has a sound source (muted has none)', await M('["accent","normal","soft","sub"].every(r => typeof m.soundFor(r).play === "function") && m.soundFor("mute") === null'));

  // Levels
  await js('(() => { const m = __metro.state; m.adv = __metro.normSetup({}); })()'); await js('__metro.setBpm(120)');
  await click('[data-fk="metro-levels"]'); await waitFor('!!document.querySelector(".levels-pop")');
  check('Levels… opens a popover with Accent, Main ticks and Subdivisions', (await js('[...document.querySelectorAll(".levels-pop .lvl-row span:first-child")].map(s => s.textContent).join("|")')) === 'Accent|Main ticks|Subdivisions');
  check('the Levels popover sits above the overlay', await js('(() => { const p = document.querySelector(".levels-pop"); const b = p.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest(".levels-pop") === p; })()'));
  await js('{ const r = document.querySelector(\'[data-fk="lvl-accent"]\'); r.value = "0.5"; r.dispatchEvent(new Event("input", { bubbles: true })); const q = document.querySelector(\'[data-fk="lvl-sub"]\'); q.value = "0.25"; q.dispatchEvent(new Event("input", { bubbles: true })); }');
  await shot('21-metro-levels');
  check('level sliders persist in the metronome key', await js('(() => { const l = JSON.parse(localStorage.getItem("metronome")).levels; return l.accent === 0.5 && l.main === 1 && l.sub === 0.25; })()'));
  check('levels multiply the click gains per role', await M('Math.abs(m.roleGain("accent") - s.volume * 0.5) < 1e-9 && Math.abs(m.roleGain("normal") - s.volume) < 1e-9 && Math.abs(m.roleGain("sub") - s.volume * 0.25 * 0.5) < 1e-9 && m.roleGain("mute") === 0'));
  await key('Escape'); await waitFor('!document.querySelector(".levels-pop")');
  check('Escape closes the Levels popover first, the overlay stays', !(await js('!!document.querySelector(".levels-pop")')) && await M('s.open'));
  await click('[data-fk="metro-sub-2"]'); await setSel('metro-pattern', '6/8'); await frame();
  await shot('20-metro-advanced');
  check('the signature line names the subdivision', (await js('document.getElementById("metroSig").textContent')) === '6/8 · eighths');
  await click('[data-fk="metro-ramp"]'); await click('[data-fk="metro-gap"]'); await click('[data-fk="metro-sub-3"]'); await setSel('metro-pattern', '5/4');
  await click('[data-fk="metro-cell-3"]'); await click('[data-fk="metro-cell-3"]'); await click('[data-fk="metro-countin-1"]');
  check('accent cells show the level by fill strength (accent brighter than soft, mute dashed)', await js(`(() => { const lum = (fk) => { const c = getComputedStyle(document.querySelector('[data-fk="' + fk + '"]')).backgroundColor; const m = c.match(/[\\d.]+/g).map(Number); const k = c.startsWith('color(') ? 255 : 1; return (m[0] + m[1] + m[2]) * k; }; const cs = getComputedStyle(document.querySelector('[data-fk="metro-cell-3"]')); return lum('metro-cell-0') > lum('metro-cell-1') + 60 && cs.borderTopStyle === 'dashed' && document.querySelector('[data-fk="metro-cell-3"]').classList.contains('mute'); })()`));
  check('the trainers turn on: sentences at full strength, the ramp status sits beside BPM', await js('!document.querySelector(".metro-trow.off") && !document.getElementById("metroRamp").hidden') && await js('(() => { const a = document.getElementById("metroRamp").getBoundingClientRect(), b = document.querySelector(".metro-sub span").getBoundingClientRect(); return Math.abs(a.top - b.top) < 4; })()'));
  await shot('20b-metro-advanced-trainers');
  check('the advanced card with trainers on still fits a 900 px window', await js('(() => { const c = document.querySelector("#metroOverlay .tuner-card"); return c.scrollHeight <= c.clientHeight + 1 && c.getBoundingClientRect().bottom <= innerHeight; })()'));
  await click('[data-fk="metro-ramp"]'); await click('[data-fk="metro-gap"]'); await click('[data-fk="metro-countin-0"]'); await click('[data-fk="metro-sub-2"]'); await setSel('metro-pattern', '6/8'); await frame();
  check('the advanced card fits a 900 px tall window without scrolling', await js('(() => { const c = document.querySelector("#metroOverlay .tuner-card"); return c.scrollHeight <= c.clientHeight + 1 && c.getBoundingClientRect().bottom <= innerHeight; })()'), await js('(() => { const c = document.querySelector("#metroOverlay .tuner-card"); return c.scrollHeight + " vs " + c.clientHeight; })()'));
  await click('[data-fk="metro-mode-simple"]'); await waitFor(async () => !(await advShown()));
  check('switching back to Simple hides them again, 4 plain beat dots', !(await advShown()) && (await js('document.querySelectorAll("#metroBeats > span").length')) === 4 && (await js('document.querySelectorAll("#metroBeats .pip").length')) === 0);
  await key('Escape'); await waitFor('!__metro.state.open');
  await key('n'); await waitFor('__metro.state.open');
  check('without "Opens in: Advanced" the overlay reopens in Simple', await M('s.mode === "simple"'));
  await key('Escape'); await waitFor('!__metro.state.open');

  // ---------------------------------------------------------------- preset tempo (type 145, state-dump field 56)
  // Bodies from the phone-app trace (docs/INVESTIGATION.md §9): {3: scope, 4: 0, 5: bpm f32, 6: 0}.
  const tempoHex = (scope, bpm) => { const f = Buffer.alloc(4); f.writeFloatLE(bpm); return ['0F', 'C0', '18', '0' + scope, '20', '00', '2D', ...[...f].map(b => b.toString(16).toUpperCase().padStart(2, '0')), '30', '00', '91', '00', '00', '00'].join(' '); };
  check('tempo bodies equal the trace (live 120, preset 93)', tempoHex(1, 120) === '0F C0 18 01 20 00 2D 00 00 F0 42 30 00 91 00 00 00' && tempoHex(0, 93) === '0F C0 18 00 20 00 2D 00 00 BA 42 30 00 91 00 00 00'
    && (await js('Array.from(__tempo.frame(1, 120)).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")')) === tempoHex(1, 120));
  const tempoTx = (list) => list.filter(t => /^TX (Live|Preset) tempo /.test(t)).map(t => t.split(': ')[1]);
  const tempoVal = () => js('document.querySelector(\'[data-fk="tempo-bpm"]\').value');
  const cleanSlate = () => js('state.presetDirty = false; render()');
  const tempoOrigin = await js('state.selectedPreset');
  await cleanSlate(); await frame();
  await click('.preset-row[data-n="1"]');
  await checkSoon('the Tempo field sits in the inspector\'s top row and shows the preset tempo (field 56, demo 120)', async () => (await tempoVal()) === '120' && await js('state.selectedPreset === 1 && state.presetTempo === 120 && !!document.querySelector(".insp-head .tempo-ctl")'), tempoVal);
  // The tempo commits into the preset 0.8 s after the last step (COMMIT_STEP); these waits don't settle,
  // so each check reads its packets before that timer fires.
  n0 = await mark();
  await click('[data-fk="tempo-down"]'); await click('[data-fk="tempo-up"]');
  let tt = tempoTx(await waitFor(async () => { const t = await txSince(n0); return tempoTx(t).includes(tempoHex(1, 120)) && t; }) || []);
  check('− / + send live tempo writes (3:1), the last one exactly the live 120 body', tt.length >= 1 && tt[tt.length - 1] === tempoHex(1, 120) && tt.every(h => h.startsWith('0F C0 18 01')), JSON.stringify(tt));
  check('live writes do not mark the preset dirty', !(await js('state.presetDirty')));
  await txWait(n0, tx => tempoTx(tx).includes(tempoHex(0, 120)));
  await waitFor('state.presetDirty');
  tt = tempoTx(await txSince(n0));
  check('the steps are committed (one 3:0 with 120) about 0.8 s after they settle', tt[tt.length - 1] === tempoHex(0, 120) && tt.filter(h => h.startsWith('0F C0 18 00')).length === 1 && await js('state.presetDirty'), JSON.stringify(tt));
  await cleanSlate(); await frame();
  // Scrub: drag sideways on the TEMPO label, 1 BPM per 4 px.
  n0 = await mark();
  {
    const b = await box('[data-fk="tempo-scrub"]');
    const x = Math.round(b.x), y = Math.round(b.y);
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) { wc.sendInputEvent({ type: 'mouseMove', x: x + i * 4, y, button: 'left' }); await sleep(12); }
    wc.sendInputEvent({ type: 'mouseUp', x: x + 40, y, button: 'left', clickCount: 1 });
    await frame();
  }
  await waitFor(async () => (await tempoVal()) === '130' && tempoTx(await txSince(n0)).includes(tempoHex(1, 130)));
  tt = tempoTx(await txSince(n0));
  check('dragging the TEMPO label sideways scrubs it live (+40 px = 130)', (await tempoVal()) === '130' && tt.length >= 1 && tt.every(h => h.startsWith('0F C0 18 01')) && tt[tt.length - 1] === tempoHex(1, 130), (await tempoVal()) + ' ' + JSON.stringify(tt));
  await checkSoon('the pedal\'s echo (rx 145) is read without an error', () => js('__ui.logs.some(l => /^RX C305: 0D C0 08 01 18 01 2D 00 00 F0 42 91/.test(l.text))'));
  await click('[data-fk="tempo-bpm"]'); await js('document.querySelector(\'[data-fk="tempo-bpm"]\').select()');
  n0 = await txCount();
  await type('93'); await key('Return');
  tt = tempoTx(await txWait(n0, tx => tempoTx(tx).length >= 2));
  check('Enter sends exactly the preset 93 body (3:0) at once (cancelling the pending scrub commit), after a live 93', tt.length === 2 && tt[0] === tempoHex(1, 93) && tt[1] === tempoHex(0, 93), JSON.stringify(tt));
  await checkSoon('the commit marks the preset dirty (the pedal\'s 115)', async () => await js('state.presetDirty && !document.getElementById("dirtyMark").hidden') && (await tempoVal()) === '93');
  await click('[data-fk="tempo-up"]'); await click('[data-fk="tempo-up"]'); await waitFor(async () => (await tempoVal()) === '95');
  await shot('xx-tempo');
  n0 = await txCount();
  await key('s', [MOD]);
  tx = await txWait(n0, tx => tx.some(t => /^TX save preset 1/.test(t)));
  tt = tempoTx(tx);
  check('Save right after a step commits the tempo first (one 3:0 with 95), then saves', tt.length === 1 && tt[0] === tempoHex(0, 95) && tx.some(t => /^TX save preset 1/.test(t)), JSON.stringify(tx));
  await checkSoon('after Save the preset is clean and the demo pedal stored 95', '!state.presetDirty && __demo.tempo.buf === 95');
  await click('.preset-row[data-n="4"]');
  await checkSoon('switching presets updates the field (preset 4: 140)', async () => (await tempoVal()) === '140', tempoVal);
  await settle();
  await click('.preset-row[data-n="1"]');
  await checkSoon('… and back: preset 1 kept the saved 95', async () => (await tempoVal()) === '95', tempoVal);
  await settle();
  // Unsolicited rx 145 (tempo changed on the pedal: hold footswitch I and tap), with field 4 = 1.
  const rx145 = (bpm) => js(`(() => { const f = new Uint8Array(new Float32Array([${bpm}]).buffer); const d = new Uint8Array([0x0F, 0xC0, 0x08, 0x01, 0x18, 0x01, 0x20, 0x01, 0x2D, ...f, 0x91, 0, 0, 0]); window.onC305({ target: { value: { buffer: d.buffer } } }); })()`);
  await rx145(110); await frame();
  check('an unsolicited rx 145 (4:1 read like 4:0) updates the field', (await tempoVal()) === '110' && await js('__ui.logs.some(l => l.text === "Pedal tempo: 110 BPM")'), await tempoVal());
  await click('.preset-row[data-n="1"]'); await js('__demo.load(1)'); await settle();

  // Metronome follows the preset tempo (Settings → Metronome), off by default.
  check('"Follow the preset tempo" is off by default', !(await js('__metro.state.tempoFollowsPreset')));
  await key('n'); await waitFor('__metro.state.open');
  n0 = await mark();
  await click('#metroUp'); await js('{ const r = document.getElementById("metroTempo"); r.value = "150"; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); }');
  await settle();
  check('with the sync off, the metronome sends nothing to the pedal and keeps its own BPM', tempoTx(await txSince(n0)).length === 0 && (await js('document.getElementById("metroBpm").value')) === '150' && await js('document.getElementById("metroFollow").hidden'));
  await key('Escape'); await waitFor('!__metro.state.open');
  await js('void __openSettings()'); await waitFor('!!document.querySelector(\'[data-fk="set-follow-tempo"]\')');
  check('Settings → Metronome has "Follow the preset tempo"', (await js('document.querySelector(\'[data-fk="set-follow-tempo"]\')?.textContent')) === 'Follow the preset tempo');
  await click('[data-fk="set-follow-tempo"]');
  await key('Escape'); await waitFor('!document.querySelector(".modal")');
  await checkSoon('the switch turns the sync on and is remembered', () => js('__metro.state.tempoFollowsPreset && JSON.parse(localStorage.getItem("settings.metroFollowsPreset")) === true'));
  await key('n'); await waitFor('__metro.state.open');
  await waitFor('document.getElementById("metroBpm").value === "95"');
  check('with the sync on, the metronome BPM is the preset tempo (95) and the overlay says so', (await js('document.getElementById("metroBpm").value')) === '95' && await js('__metro.effectiveBpm() === 95 && !document.getElementById("metroFollow").hidden && document.getElementById("metroFollow").textContent === "♩ follows preset"'), await js('document.getElementById("metroBpm").value'));
  await shot('xx-tempo-metro');
  // Each metronome change commits into the preset 1.5 s later (COMMIT_METRO): read before that, no settling.
  n0 = await mark();
  await click('#metroUp');
  await waitFor(async () => tempoTx(await txSince(n0)).length >= 1 && (await tempoVal()) === '96');
  tt = tempoTx(await txSince(n0));
  check('metronome + writes the tempo live to the pedal (96)', tt.length === 1 && tt[0] === tempoHex(1, 96) && (await tempoVal()) === '96', JSON.stringify(tt));
  n0 = await txCount();
  await js('{ const r = document.getElementById("metroTempo"); r.value = "100"; r.dispatchEvent(new Event("input")); r.dispatchEvent(new Event("change")); }');
  await waitFor(async () => tempoTx(await txSince(n0)).length >= 1);
  tt = tempoTx(await txSince(n0));
  check('the metronome slider goes live at once (100), nothing into the preset yet', tt.length >= 1 && tt.every(h => h === tempoHex(1, 100)) && !(await js('state.presetDirty')), JSON.stringify(tt));
  await txWait(n0, tx => tempoTx(tx).includes(tempoHex(0, 100)));
  await waitFor('state.presetDirty');
  tt = tempoTx(await txSince(n0));
  check('… and commits 100 into the preset about 1.5 s later', tt[tt.length - 1] === tempoHex(0, 100) && tt.filter(h => h.startsWith('0F C0 18 00')).length === 1 && await js('state.presetDirty'), JSON.stringify(tt));
  n0 = await txCount();
  await js('__metro.setBpm(104, "trainer")');
  await sleep(1700);   // longer than COMMIT_METRO (1.5 s): proves no commit into the preset follows
  await settle();
  tt = tempoTx(await txSince(n0));
  check('a tempo-trainer step goes to the pedal live only', tt.length === 1 && tt[0] === tempoHex(1, 104) && await js('__metro.effectiveBpm() === 104'), JSON.stringify(tt));
  await rx145(132); await frame();
  await waitFor('document.getElementById("metroBpm").value === "132"');
  check('a tempo change on the pedal moves the metronome', (await js('document.getElementById("metroBpm").value')) === '132' && await js('__metro.effectiveBpm() === 132'));
  await key('Escape'); await waitFor('!__metro.state.open');
  await cleanSlate(); await frame(); await settle();
  await click('.preset-row[data-n="4"]');
  await checkSoon('a preset switch moves the metronome to the new preset\'s tempo (140)', '__metro.effectiveBpm() === 140');
  await js('__tempo.setFollow(false)');
  await key('n'); await waitFor('__metro.state.open');
  n0 = await mark();
  await click('#metroUp'); await settle();
  check('sync off again: the metronome is independent and sends nothing', tempoTx(await txSince(n0)).length === 0 && await js('__metro.effectiveBpm() === __metro.state.bpm && document.getElementById("metroFollow").hidden'));
  await key('Escape'); await waitFor('!__metro.state.open');
  await cleanSlate(); await frame();
  await click('.preset-row[data-n="' + tempoOrigin + '"]'); await waitFor(async () => (await js('state.selectedPreset')) === tempoOrigin); await settle();

  // ---------------------------------------------------------------- pedal library
  await key('4'); await frame();
  // A capture whose type word we don't know yet: no icon, but the raw word stays in the row's tooltip.
  await js('window.__kindDebug = []; window.__origDebug = console.debug; console.debug = (...a) => { __kindDebug.push(a.join(" ")); }; state.library.user.push({ index: 99, name: "Zz Mystery", type: "mystery_box", instrument: "guitar", author: "Tester" }); 1');
  await click('[data-fk="lib-capture"]');
  await checkSoon('library picker lists the pedal\'s captures', async () => (await js('document.querySelectorAll(".pop .pop-item").length')) >= 8, () => js('String(document.querySelectorAll(".pop .pop-item").length)'));
  const rowOf = (name) => `[...document.querySelectorAll(".pop .pop-item")].find(x => x.querySelector(".name")?.textContent === ${JSON.stringify(name)})`;
  const kinds = (name) => js(`(() => { const r = ${rowOf(name)}; return r ? [...r.querySelectorAll(".sub .kind")].map(k => k.title).join("|") + "/" + (r.querySelector(".sub .author")?.textContent || "") : "missing"; })()`);
  check('capture row shows type and instrument icons, then the author', (await kinds('Plexi 1959 SLP')) === 'Amp head|Guitar/Neural DSP', await kinds('Plexi 1959 SLP'));
  check('kind icons are inline 14 px line drawings', await js(`(() => { const s = ${rowOf('Plexi 1959 SLP')}.querySelector(".sub .kind svg"); const r = s.getBoundingClientRect(); return s.getAttribute("viewBox") === "0 0 16 16" && s.getAttribute("fill") === "none" && Math.round(r.width) === 14 && Math.round(r.height) === 14; })()`));
  check('combo, pedal, preamp and bass get their own icons', (await kinds('AC30 TB Normal')) === 'Combo|Guitar/Neural DSP' && (await kinds('King of Tone')) === 'Pedal|Guitar/Neural DSP' && (await kinds('Bedroom Clean')) === 'Preamp|Guitar/You' && (await kinds('SVT CL Bass')) === 'Amp head|Bass/Neural DSP', [await kinds('AC30 TB Normal'), await kinds('King of Tone'), await kinds('Bedroom Clean'), await kinds('SVT CL Bass')].join(', '));
  check('a default / instrument_not_set capture has no icons, just the author', (await kinds('My Plexi Lead')) === '/You', await kinds('My Plexi Lead'));
  check('an amp_combo capture (a real pedal\'s word for a combo) gets the combo icon, labelled Combo, and logs nothing', (await kinds('Deluxe Reverb Clean')) === 'Combo|Guitar/Neural DSP' && (await js(`${rowOf('Deluxe Reverb Clean')}.querySelector(".sub .kind").innerHTML === ${rowOf('AC30 TB Normal')}.querySelector(".sub .kind").innerHTML`)) && (await js('__kindDebug.filter(l => /amp_combo/.test(l)).length')) === 0, await kinds('Deluxe Reverb Clean'));
  check('an unknown type word: no icon, raw word in the row tooltip, logged once', (await kinds('Zz Mystery')) === 'Guitar/Tester' && /mystery_box/.test(await js(`${rowOf('Zz Mystery')}.title`)) && (await js('__kindDebug.filter(l => /unknown capture kind mystery_box/.test(l)).length')) === 1, await js(`${rowOf('Zz Mystery')}?.title`) + ' ' + await js('JSON.stringify(__kindDebug)'));
  check('every capture row has a subtitle line', await js('document.querySelectorAll(".pop .pop-item.two").length === document.querySelectorAll(".pop .pop-item").length'));
  await shot('xx-library-kinds');
  await type('combo'); await frame();
  check('searching a type word ("combo") finds the combo captures', (await js('[...document.querySelectorAll(".pop .pop-item .name")].map(x => x.textContent).join("|")')) === 'AC30 TB Normal|Deluxe Reverb Clean', await js('[...document.querySelectorAll(".pop .pop-item .name")].map(x => x.textContent).join("|")'));
  for (let i = 0; i < 5; i++) await key('Backspace');
  await js('console.debug = __origDebug; state.library.user.pop(); 1');
  await type('plexi'); await frame();
  const libName = await js('document.querySelector(".pop-item .name")?.textContent');
  check('library search filters', (await js('document.querySelectorAll(".pop-item").length')) === 2 && /plexi/i.test(libName || ''), String(libName));
  await key('Return');
  await checkSoon('slot chooser appears', '!!document.querySelector(".modal .slots")');
  await click('.modal [data-fk="pickslot-9"]');
  n0 = await txCount();
  await key('Return');
  tx = await txWait(n0, tx => tx.some(t => /^TX Load library capture/.test(t)));
  check('load-into-slot packet sent (SetCaptureSlotContentRequest, type 80)', tx.some(t => /^TX Load library capture "Plexi 1959 SLP" into slot 9: .*50 00 00 00$/.test(t)), JSON.stringify(tx));
  await checkSoon('slot 9 now holds the library capture', async () => (await js('state.captureNames.get(9)')) === libName, () => js('String(state.captureNames.get(9))'));
  await checkSoon('capture node shows it', async () => (await js('document.querySelector("[data-stage=capture] .model").textContent')) === libName);
  await checkSoon('no popover or dialog left open', '!document.querySelector(".pop") && !document.querySelector(".modal")');
  await key('5'); await frame();
  await waitFor('document.querySelectorAll(".cab-library-section .library-item").length >= 5');
  check('cab library rows show plain names with preview controls', await js('(() => { const rows = [...document.querySelectorAll(".cab-library-section .library-row")]; return rows.length >= 5 && rows[0].querySelector(".library-item")?.textContent === "412 V30" && rows[0].querySelector(".library-preview")?.getAttribute("aria-label") === "Preview 412 V30" && !rows[0].querySelector(".kind"); })()'), await js('document.querySelector(".cab-library-section .library-row")?.outerHTML'));
  await js('window.__libNode = document.querySelector(".cab-library-content")');
  await click('[data-fk="cab-lib-search"]'); await type('412'); await js('render()'); await frame(); await js('render()'); await frame();
  check('the cab library search keeps focus and its list is not rebuilt by redraws', await js('document.activeElement === document.querySelector("[data-fk=cab-lib-search]") && document.querySelector(".cab-library-content") === window.__libNode && document.activeElement.value === "412" && [...document.querySelectorAll(".cab-library-section .library-row")].filter(r => !r.hidden).length >= 2 && [...document.querySelectorAll(".cab-library-section .library-row")].filter(r => !r.hidden).every(r => /412/.test(r.textContent))'));
  for (let i = 0; i < 3; i++) await key('Backspace');
  check('… its caret stayed at the end: three Backspaces clear it and every cab and IR shows again', await js('document.querySelector("[data-fk=cab-lib-search]").value === "" && [...document.querySelectorAll(".cab-library-section .library-row")].every(r => !r.hidden)'), await js('document.querySelector("[data-fk=cab-lib-search]").value + " / hidden " + [...document.querySelectorAll(".cab-library-section .library-row")].filter(r => r.hidden).length'));
  await js('document.activeElement.blur(); delete window.__libNode'); await frame();
  await rightClick('[data-fk="node-cab"]');
  await js(ctxItem('Pick a cab from the library') + '.click()');
  await checkSoon('the cab node menu\'s "Pick a cab from the library…" goes to the library search', 'document.activeElement === document.querySelector("[data-fk=cab-lib-search]")');
  await js('document.activeElement.blur()'); await frame();
  await key('4'); await frame();

  // ---------------------------------------------------------------- slot usage scan
  // Preset 5 is dirty now (slot 9 load above). The scan switches presets, so it must refuse.
  check('Usage… sits next to Load from library…', await js('document.querySelector(\'[data-fk="usage-capture"]\')?.nextElementSibling?.dataset.fk === "lib-capture"'));
  await click('[data-fk="usage-capture"]'); await waitFor('!!document.querySelector(".pop.usage-pop")');
  check('Usage… opens the slot usage menu', await js('!!document.querySelector(".pop.usage-pop") && document.querySelector(\'[data-fk="usage-scan"]\')?.textContent === "Scan slot usage…"'));
  check('scan is disabled while there are unsaved edits, and says why', await js('document.querySelector(\'[data-fk="usage-scan"]\').disabled && /discard/.test(document.querySelector(\'[data-fk="usage-why"]\')?.textContent || "")'));
  await shot('10a-usage-dirty');
  await key('Escape');
  check('Escape closes the usage menu', await js('!document.querySelector(".pop")'));
  await key('s', [MOD]); await waitFor('!state.presetDirty'); await settle();   // save: the scan may run now
  const origin = await js('state.selectedPreset');
  const saved = await js('[...Array(64).keys()].map(i => i + 1).filter(i => !/^empty$/i.test(state.presetNames.get(i))).length');
  // partial: stop it after a few presets
  await click('[data-fk="usage-capture"]'); await waitFor('!!document.querySelector(\'[data-fk="usage-scan"]\')');
  check('scan is enabled once the edits are saved', await js('!document.querySelector(\'[data-fk="usage-scan"]\').disabled && !document.querySelector(\'[data-fk="usage-why"]\')'));
  // Stop it from inside the page as soon as the third preset is being scanned: a round trip from this
  // process can take longer than scanning the rest on a slow VM, so polling from here could miss the window.
  const armStop = js(`new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => {
    const m = /^Scanning presets (\\d+)\\//.exec(__ui.lastAction || '');
    if ((m && +m[1] >= 3) || Date.now() - t0 > ${TIMEOUT}) { clearInterval(iv); document.querySelector('[data-fk="usage-stop"]')?.click(); res(m ? +m[1] : -1); }
  }, 1); })`);
  await click('[data-fk="usage-scan"]');
  const stoppedAt = await armStop;
  await waitFor('!__ui.scanning', { timeout: 15000 });
  await checkSoon('Stop scan ends early and says it was partial', async () => await js('__ui.usage && !__ui.usage.complete') && /^Partial scan: stopped after \d+ of \d+ presets$/.test(await js('document.querySelector(\'[data-fk="usage-partial"]\')?.textContent || ""')), async () => 'stop at ' + stoppedAt + ': ' + await js('document.querySelector(".usage-pop")?.textContent'));
  await checkSoon('a stopped scan still returns to the origin preset', async () => (await js('state.selectedPreset')) === origin);
  await settle();
  // full scan
  n0 = await txCount();
  await js('document.querySelector(\'[data-fk="usage-scan"]\').click()');
  let progress = '';
  for (const t0 = Date.now(); Date.now() - t0 < 30000 && await js('__ui.scanning');) { const a = await js('document.getElementById("lastAction").textContent'); if (/^Scanning presets \d+\/\d+…$/.test(a)) progress = a; await sleep(15); }
  await waitFor('__ui.usage && __ui.usage.complete'); await settle();
  check('status bar shows scan progress ("Scanning presets 12/25…")', progress !== '', progress);
  const usage = await js('__ui.usage');
  check('scan covers every saved preset and completes', usage.complete && usage.scanned === saved && usage.total === saved, JSON.stringify({ scanned: usage.scanned, total: usage.total, saved }));
  tx = (await txSince(n0)).filter(t => /^TX Preset change \d+:/.test(t));
  check('scan switches through the presets over Bluetooth and ends on the origin', tx.length === saved && /^TX Preset change (\d+):/.exec(tx[tx.length - 1])[1] === String(origin), tx.length + ' switches: ' + tx.map(t => /change (\d+)/.exec(t)[1]).join(','));
  check('scan returns to the origin preset', (await js('state.selectedPreset')) === origin && (await js('document.querySelector(".preset-title .name").textContent')) === 'Big Lead 5');
  check('scan leaves no unsaved edits', await js('!state.presetDirty && document.getElementById("dirtyMark").hidden'));
  check('result says when the scan ran', new RegExp('^Scanned: \\d{1,2}:\\d{2}.*, ' + saved + ' presets$').test(await js('document.querySelector(\'[data-fk="usage-date"]\')?.textContent || ""')), await js('document.querySelector(\'[data-fk="usage-date"]\')?.textContent'));
  check('result lists the presets that use the current capture slot', (await js('document.querySelector(\'[data-fk="usage-feeds"]\')?.textContent')) === 'Slot 9 feeds: 5 Big Lead 5, 12 JP2C Lead 2, 20 Octave Down Riff 2', await js('document.querySelector(\'[data-fk="usage-feeds"]\')?.textContent'));
  // computed from the scan itself: the delete check earlier in the run empties preset 24, which frees its slot
  const expectedFree = 'Free capture slots: ' + Array.from({ length: 25 }, (_, i) => i + 1).filter(n => !(usage.captures[n] || []).length).join(', ');
  check('result lists the free capture slots', (await js('document.querySelector(\'[data-fk="usage-free"]\')?.textContent')) === expectedFree && expectedFree.includes('14'), await js('document.querySelector(\'[data-fk="usage-free"]\')?.textContent') + ' vs ' + expectedFree);
  check('result lists the free cab slots', (await js('document.querySelector(\'[data-fk="usage-free-cab"]\')?.textContent')) === 'Free cab slots: 5', await js('document.querySelector(\'[data-fk="usage-free-cab"]\')?.textContent'));
  check('presets playing a library capture (position 6) are listed apart', JSON.stringify(usage.library) === '[9,19]' && (await js('document.querySelector(\'[data-fk="usage-library"]\')?.textContent')) === 'Captures from the library: 9 Fuzz Wall, 19 Fuzz Wall 2', JSON.stringify(usage.library));
  check('presets playing a library cab (slot 6) are listed apart', JSON.stringify(usage.cabLibrary) === '[7,17]' && !Object.values(usage.cabs).flat().includes(7), JSON.stringify(usage.cabLibrary));
  check('library presets are not counted under any slot', !Object.values(usage.captures).flat().some(n => n === 9 || n === 19) && !usage.captures[26]);
  await shot('10b-usage-result');
  await key('Escape');
  check('capture slot buttons show how many presets use them, with the presets in the tooltip', (await js('document.querySelector(\'[data-fk="capslot-9"] .uses\')?.textContent')) === '3' && /^Used by 3 presets: 5 Big Lead 5, 12 JP2C Lead 2, 20 Octave Down Riff 2$/.test(await js('document.querySelector(\'[data-fk="capslot-9"] .uses\').title')), await js('document.querySelector(\'[data-fk="capslot-9"] .uses\')?.title'));
  check('unused capture slots are marked free', await js('document.querySelector(\'[data-fk="capslot-17"] .uses.free\')?.textContent === "free" && !document.querySelector(\'[data-fk="capslot-5"] .uses:not(.free)\')'));
  await key('5'); await frame();
  check('IR slot buttons show counts too', await js('/^\\d+$/.test(document.querySelector(\'[data-fk="irslot-1"] .uses\')?.textContent || "") && document.querySelector(\'[data-fk="irslot-5"] .uses\')?.textContent === "free"'), await js('[1,2,3,4,5].map(i => document.querySelector(`[data-fk="irslot-${i}"] .uses`)?.textContent).join(",")'));
  await key('4'); await frame();
  await click('[data-fk="lib-capture"]'); await waitFor('document.querySelectorAll(".pop .pop-item").length > 0');
  await type('king'); await key('Return'); await waitFor('!!document.querySelector(\'.modal [data-fk="pickslot-9"]\')');
  check('the slot chooser shows the usage counts', (await js('document.querySelector(\'.modal [data-fk="pickslot-9"] .uses\')?.textContent')) === '3' && await js('document.querySelector(\'.modal [data-fk="pickslot-20"] .uses\')?.textContent === "free"'));
  await shot('10c-usage-chooser');
  await key('Escape');
  await checkSoon('cancelling the chooser loads nothing', '!document.querySelector(".modal") && !state.presetDirty');
  // a preset that plays a capture straight from the library
  await click('.preset-row[data-n="9"]');
  await checkSoon('library capture: the node says "From the library", not a slot', async () => (await js('document.querySelector("[data-stage=capture] .sub").textContent')) === 'From the library: Fuzz Face Si', () => js('document.querySelector("[data-stage=capture] .sub").textContent'));
  check('library capture: the inspector says so and no slot is lit', /^From the library: Fuzz Face Si\./.test(await js('document.querySelector(\'[data-fk="cap-from-lib"]\')?.textContent || ""')) && await js('!document.querySelector(".inspector .slot.on")'));
  await settle();
  await click('.preset-row[data-n="7"]');
  await checkSoon('library cab: the node says "From the library"', async () => (await js('document.querySelector("[data-stage=cab] .sub").textContent')) === 'From the library: 112 Jensen', () => js('document.querySelector("[data-stage=cab] .sub").textContent'));
  await settle();
  await click(`.preset-row[data-n="${origin}"]`); await waitFor(async () => (await js('state.selectedPreset')) === origin); await settle();

  // ---------------------------------------------------------------- session recording
  await click('#recBtn'); await frame();
  check('Record arms the recorder', await js('__rec.on && document.getElementById("recBtn").classList.contains("on")'));
  await dblclick('[data-fk="amp-bass"] svg');
  await checkSoon('TX packets are recorded with their label', () => js('__rec.events.some(e => e.dir === "tx" && /Amp bass/.test(e.label) && /^[0-9A-F]{2}( [0-9A-F]{2})+$/.test(e.hex))'), JSON.stringify(await js('__rec.events.slice(-2)')));
  await js('handleTypedMessage(buildFrame([0x20, 0x01], MSG.SetPresetSlotsResponse))'); // a reply from the pedal
  await click('#recBtn');
  // the file arrives through a download; wait until it is complete JSON
  const recFile = await waitFor(async () => fs.readdirSync(OUT).find(f => { if (!/^nano-session-.*\.json$/.test(f)) return false; try { JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); return true; } catch { return false; } }));
  const recData = recFile ? JSON.parse(fs.readFileSync(path.join(OUT, recFile), 'utf8')) : null;
  check('stopping saves a JSON session file', !!recData && Array.isArray(recData.events) && recData.events.length >= 1 && Array.isArray(recData.log), String(recFile));
  check('recorder is off again', await js('!__rec.on && document.getElementById("recBtn").textContent === "Record"'));

  // ---------------------------------------------------------------- state dump read-back
  // A pedal state dump with gate reduction 70% in field 53 (fixed32 (70+108)/255) and the gate enabled.
  await js('state.stateBytes = Array.from(bytesFromHex("08 01 18 7F 20 7F 28 7F 30 7F 38 7F 40 36 48 03 AD 03 B3 B2 32 3F")); parseBufferedCurrentState()');
  await frame();
  check('gate reduction is read from the state dump (field 53)', (await js('state.gate.params[0].value')) === 70, String(await js('state.gate.params[0].value')));
  check('gate on is read from the state dump (field 54 absent)', await js('state.gate.on === true'));
  await js('state.stateBytes = Array.from(bytesFromHex("08 01 18 7F 20 7F 28 7F 30 7F 38 7F 40 36 48 03 C2 01 05 32 2E 33 2E 30 AD 03 B3 B2 32 3F")); parseBufferedCurrentState()'); await frame();
  check('firmware is read from the state dump (field 24)', (await js('state.firmware')) === '2.3.0', String(await js('state.firmware')));
  await js('state.firmware = "2.2.1"; render()');
  // Capture position 6 in bank 5 and cab slot 6: both straight from the library (PROTOCOL-NOTES §8, native repo).
  // fields: 9 bank 5, 11 position 6, 12 cab 6, 13 current preset, 32 {2: capture name}, 33 {2: IR short name}
  n0 = await txCount();
  await js(`(() => {
    const enc = (s) => Array.from(new TextEncoder().encode(s));
    const sub = (s) => [0x12, enc(s).length, ...enc(s)];
    const cap = sub('Rodent+SV 3'), ir = sub('110 US PRN C10R');
    state.stateBytes = [0x48, 5, 0x58, 6, 0x60, 6, 0x68, state.selectedPreset - 1, 0x82, 0x02, cap.length, ...cap, 0x8A, 0x02, ir.length, ...ir];
    parseBufferedCurrentState();
  })()`);
  await frame();
  await waitFor(async () => (await js('document.querySelector("[data-stage=cab] .sub").textContent')) === 'From the library: 110 US PRN C10R'); await settle();
  check('state dump: capture position 6 means "from the library", not slot 26', await js('state.capture.fromLibrary && state.capture.on && state.capture.activeSlot === null') && (await js('document.querySelector("[data-stage=capture] .sub").textContent')) === 'From the library: Rodent+SV 3', await js('document.querySelector("[data-stage=capture] .sub").textContent'));
  check('state dump: cab slot 6 means "from the library"', await js('state.cabIR.fromLibrary') && (await js('document.querySelector("[data-stage=cab] .sub").textContent')) === 'From the library: 110 US PRN C10R', await js('document.querySelector("[data-stage=cab] .sub").textContent'));
  check('state dump: no cab settings request for a library cab', !(await txSince(n0)).some(t => /Cab\/IR param refresh/.test(t)) && await js('__ui.logs.some(l => /param refresh skipped: the cab comes straight from the library/.test(l.text))'), JSON.stringify(await txSince(n0)));
  await js('state.stateBytes = [0x48, 2, 0x58, 3, 0x60, 2, 0x68, state.selectedPreset - 1]; parseBufferedCurrentState()'); await frame();
  await checkSoon('state dump: bank 2 position 3 is capture slot 8 and clears the library flags', '!state.capture.fromLibrary && !state.cabIR.fromLibrary && state.capture.selectedSlot === 8', () => js('String(state.capture.selectedSlot)'));
  await settle();
  await js('__demo.load(state.selectedPreset)'); await frame(); await settle();

  // ---------------------------------------------------------------- capture upload (Cortex Cloud → pedal)
  // Framing: a message that fits in one write is the ordinary `len C0 … type` frame.
  check('single-write stream frame equals the classic frame', (await js('[...NanoTransfer.chunks([1, 2, 3], 13)[0]].join(",")')) === '7,192,1,2,3,13,0,0,0');
  const fr = await js('NanoTransfer.chunks(Array.from({ length: 1100 }, (_, i) => i & 255), 13).map(c => [c.length, c[0], c[1]])');
  check('1.1 KB message streams as 3 writes of 500 bytes, last one padded', JSON.stringify(fr) === JSON.stringify([[500, 242, 0x41], [500, 242, 0x01], [500, 108, 0x80]]), JSON.stringify(fr));
  const meta = { hash: 'ab'.repeat(32), name: 'Test Capture', cloudUUID: '00000000-0000-4000-8000-000000000001', authorId: 'x', authorName: 'Tester', deviceType: 'pedal', gainType: 3, instrumentType: 'guitar', version: '1', tags: ['#test'] };
  n0 = await mark();
  // Not returned: executeJavaScript would otherwise wait for the whole upload flow (which waits for our keypress).
  await js('window.__uploadDone = __uploadCapture({ cns: btoa(String.fromCharCode(...Array.from({ length: 1200 }, (_, i) => i & 255))), meta: ' + JSON.stringify(meta) + ' }); 0');
  await checkSoon('upload asks for confirmation first', '!!document.querySelector(".modal") && /Send Test Capture/.test(document.querySelector(".modal h2").textContent)');
  await key('Return');
  tx = (await txWait(n0, tx => tx.filter(t => /^TX Capture upload/.test(t)).length >= 3)).filter(t => /^TX Capture upload/.test(t));
  check('upload streams the capture in 500-byte writes (first 0x41, last 0x80)', tx.length === 3 && /^TX Capture upload "Test Capture" 1\/3: [0-9A-F]{2} 41 /.test(tx[0]) && /^TX Capture upload "Test Capture" 3\/3: [0-9A-F]{2} 8[01] /.test(tx[2]), JSON.stringify(tx.map(t => t.slice(0, 60))));
  await checkSoon('(demo) pedal accepts and the reply is parsed', '__ui.logs.some(l => /Capture upload accepted: "Test Capture" user index 2/.test(l.text))', async () => JSON.stringify(await js('__ui.logs.slice(-6).map(l => l.text.slice(0, 90))')));
  await checkSoon('library is refreshed and lists it under user captures with that index', '(state.library.user.find(x => x.name === "Test Capture") || {}).index === 2');
  await checkSoon('then offers to load it into a slot', '!!document.querySelector(".modal") && /Load Test Capture/.test(document.querySelector(".modal h2").textContent)');
  await key('Return');
  await checkSoon('slot chooser opens for the new capture', '!!document.querySelector(".modal .slots")');
  await click('.modal [data-fk="pickslot-3"]'); n0 = await txCount();
  await key('Return');
  tx = await txWait(n0, tx => tx.some(t => /^TX Load library capture "Test Capture"/.test(t)), { timeout: 10000 });
  await checkSoon('new capture loads into slot 3 (user id 2)', async () => tx.some(t => /^TX Load library capture "Test Capture" into slot 3: .* 2A .* 08 02 12 /.test(t)) && (await js('state.captureNames.get(3)')) === 'Test Capture', JSON.stringify(tx));
  await checkSoon('upload flow finished cleanly', '!document.querySelector(".modal") && !__ui.uploading');
  await settle();

  // ---------------------------------------------------------------- live capture preview and keep-alive
  // Use the real preview transfer and timer, with the demo pedal answering the same type 151/149/92 messages.
  const previewMeta = { hash: 'cd'.repeat(32), name: 'Test Preview', cloudUUID: '00000000-0000-4000-8000-000000000002', authorId: 'x', authorName: 'Tester', deviceType: 'pedal', gainType: 3, instrumentType: 'guitar', version: '1', tags: ['#test'] };
  const previewSlot = await js('state.capture.selectedSlot');
  await js(`(() => {
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    window.__previewTimerTest = { originalSetInterval, originalClearInterval, callback: null, ms: null, id: null, cleared: false };
    window.setInterval = (fn, ms) => { __previewTimerTest.callback = fn; __previewTimerTest.ms = ms; __previewTimerTest.id = 9171; return __previewTimerTest.id; };
    window.clearInterval = id => { if (id === __previewTimerTest.id) __previewTimerTest.cleared = true; };
  })()`);
  n0 = await mark();
  const previewResult = await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`);
  await settle();
  tx = await txSince(n0);
  check('live preview sends the type-150 transfer', previewResult === true && tx.some(t => /^TX Capture preview "Test Preview" 1\/1: .* 96 00 00 00$/.test(t)), JSON.stringify(tx));
  check('live preview becomes active without changing the loaded slot', await js('__ui.previewing && !__ui.previewBusy') && (await js('state.capture.selectedSlot')) === previewSlot);
  check('live preview starts a 20-second keep-alive timer', await js('__previewTimerTest.ms === 20000 && typeof __previewTimerTest.callback === "function"'), await js('String(__previewTimerTest.ms)'));
  n0 = await mark();
  await js('__previewTimerTest.callback()');
  tx = await txWait(n0, t => t.some(x => /^TX Preview keep-alive:/.test(x)));
  check('keep-alive sends the confirmed type-91 frame', tx.length === 1 && tx[0] === 'TX Preview keep-alive: 06 C0 08 03 5B 00 00 00', JSON.stringify(tx));
  await checkSoon('keep-alive type-92 response is acknowledged', '__ui.logs.some(l => l.text === "Live preview keep-alive acknowledged.")');
  n0 = await mark();
  const stopResult = await js('__stopCapturePreview()');
  await settle();
  tx = await txSince(n0);
  check('stopping preview sends type 148 and receives confirmation', stopResult === true && tx.some(t => /^TX Stop capture preview: .* 94 00 00 00$/.test(t)) && await js('__ui.logs.some(l => /Capture preview stop confirmed/.test(l.text))'), JSON.stringify(tx));
  check('stopping preview clears the keep-alive timer', await js('__previewTimerTest.cleared && !__ui.previewing && !__ui.previewBusy'));
  await js('__previewTimerTest.callback()'); await settle();
  check('a stopped preview does not send another keep-alive', !(await txSince(n0)).some(t => /^TX Preview keep-alive:/.test(t)));
  await js('window.setInterval = __previewTimerTest.originalSetInterval; window.clearInterval = __previewTimerTest.originalClearInterval; delete window.__previewTimerTest');

  // ---------------------------------------------------------------- streamed transfers: one at a time
  check('MD5 for the 150/15 messages matches the reference (empty, "abc")', (await js('NanoTransfer.md5Hex(new Uint8Array()) + " " + NanoTransfer.md5Hex(new TextEncoder().encode("abc"))')) === 'd41d8cd98f00b204e9800998ecf8427e 900150983cd24fb0d6963f7d28e17f72');
  n0 = await mark();
  const mutex = await js(`(async () => {
    const meta = ${JSON.stringify(previewMeta)};
    const preview = NanoTransfer.previewCapture({ cns: new Uint8Array(3000), meta });
    const busy = NanoTransfer.busy;
    let err = '';
    try { await NanoTransfer.downloadImpulseResponse({ wav: new Uint8Array(64), meta: { name: 'Mutex IR', productId: '00000000-0000-4000-8000-000000000003', filename: 'Mutex IR.wav' } }); }
    catch (e) { err = e.message; }
    const r = await preview;
    const stop = await NanoTransfer.stopAudition('capture');
    return { busy, err, ok: r.ok, stopped: stop.ok, after: NanoTransfer.busy };
  })()`);
  tx = await txWait(n0, t => t.some(x => /^TX Stop capture preview/.test(x)));
  check('stream mutex: a Cloud IR (15) is refused while a capture preview (150) streams; the 150 completes', mutex.busy === 'capture preview' && /Another transfer to the pedal is still running/.test(mutex.err) && mutex.ok && mutex.stopped && mutex.after === '' && !tx.some(t => /Cloud IR download/.test(t)) && (() => { const parts = tx.filter(t => /^TX Capture preview "Test Preview" \d+\/\d+:/.test(t)); const m = parts.length && /\/(\d+):/.exec(parts[0]); return parts.length > 1 && m && Number(m[1]) === parts.length; })(), JSON.stringify(mutex) + ' ' + JSON.stringify(tx.map(t => t.slice(0, 50))));

  // ---------------------------------------------------------------- Cloud IR checks in the shell (src/cloud-ir.js), no network
  {
    const cloudIR = require('../src/cloud-ir');
    const wavOf = ({ format = 3, channels = 1, rate = 48000, bits = 32, data = 16, fmt = true, extensible = false, cut = 0, riff = 'RIFF' } = {}) => {
      const fmtLen = extensible ? 40 : 16;
      const chunks = [];
      if (fmt) {
        const f = Buffer.alloc(8 + fmtLen);
        f.write('fmt ', 0); f.writeUInt32LE(fmtLen, 4);
        f.writeUInt16LE(extensible ? 0xFFFE : format, 8); f.writeUInt16LE(channels, 10); f.writeUInt32LE(rate, 12);
        f.writeUInt32LE(rate * channels * bits / 8, 16); f.writeUInt16LE(channels * bits / 8, 20); f.writeUInt16LE(bits, 22);
        if (extensible) { f.writeUInt16LE(22, 24); f.writeUInt16LE(format, 32); }
        chunks.push(f);
      }
      if (data) { const d = Buffer.alloc(8 + data); d.write('data', 0); d.writeUInt32LE(data + cut, 4); chunks.push(d); }
      else { const l = Buffer.alloc(8 + 28); l.write('LIST', 0); l.writeUInt32LE(28, 4); chunks.push(l); }
      const body = Buffer.concat(chunks);
      const head = Buffer.alloc(12); head.write(riff, 0); head.writeUInt32LE(body.length + 4, 4); head.write('WAVE', 8);
      return Buffer.concat([head, body]);
    };
    const why = (opts) => { try { cloudIR.checkWav(wavOf(opts)); return 'ok'; } catch (e) { return e.message; } };
    check('Cloud IR check: a mono 48 kHz float WAV (the traced kind) passes', why() === 'ok', why());
    check('Cloud IR check: 24-bit PCM stereo at 44.1 kHz and WAVE_FORMAT_EXTENSIBLE float pass', why({ format: 1, bits: 24, channels: 2, rate: 44100 }) === 'ok' && why({ extensible: true }) === 'ok', why({ format: 1, bits: 24, channels: 2, rate: 44100 }) + ' / ' + why({ extensible: true }));
    check('Cloud IR check: a compressed WAV (format 2) is refused with the reason', /not PCM or floating-point audio \(WAV format 2\)/.test(why({ format: 2, bits: 16 })), why({ format: 2, bits: 16 }));
    check('Cloud IR check: 6 channels are refused', /6 channels; the pedal takes mono or stereo/.test(why({ channels: 6 })), why({ channels: 6 }));
    check('Cloud IR check: a 4 kHz or 384 kHz sample rate is refused', /sample rate \(4000 Hz\)/.test(why({ rate: 4000 })) && /384000 Hz/.test(why({ rate: 384000 })), why({ rate: 4000 }));
    check('Cloud IR check: 8-bit PCM is refused', /8-bit PCM samples/.test(why({ format: 1, bits: 8 })), why({ format: 1, bits: 8 }));
    check('Cloud IR check: no format chunk, no audio, a cut-short chunk or not RIFF are refused', /no format chunk/.test(why({ fmt: false, data: 64 })) && /no audio data/.test(why({ data: 0 })) && /cut short/.test(why({ cut: 100 })) && /not a WAV file/.test(why({ riff: 'RIFX' })), [why({ fmt: false, data: 64 }), why({ data: 0 }), why({ cut: 100 }), why({ riff: 'RIFX' })].join(' / '));
    const big = (() => { try { cloudIR.decodeIRPayload('A'.repeat(1500000)); return 'ok'; } catch (e) { return e.message; } })();
    check('Cloud IR check: a payload over 1 MB is refused before decoding', /larger than 1 MB/.test(big) && cloudIR.decodeIRPayload(wavOf().toString('base64')).length === wavOf().length, big);
  }

  // ---------------------------------------------------------------- Cortex Cloud IR → the pedal's library (15 → 16), and deleting it (82 → 83)
  // A minimal valid WAV: RIFF/WAVE, fmt (float, mono, 48 kHz), 4 samples.
  const wav = (() => {
    const b = Buffer.alloc(44 + 16);
    b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(48000 * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
    b.write('data', 36); b.writeUInt32LE(16, 40);
    return b.toString('base64');
  })();
  const irMeta = { name: 'Demo Cloud IR', productId: '00000000-0000-4000-8000-000000000004', filename: 'Demo Cloud IR.wav' };
  n0 = await mark();
  await js(`window.__irDone = __receiveCloudIR({ wav: ${JSON.stringify(wav)}, meta: ${JSON.stringify(irMeta)} }); 0`);
  await checkSoon('a Cloud IR asks for confirmation first', '!!document.querySelector(".modal") && /Send Demo Cloud IR to the pedal/.test(document.querySelector(".modal h2").textContent)');
  await key('Return');
  tx = await txWait(n0, t => t.some(x => /^TX Cloud IR download/.test(x)));
  const irOutcome = await js('window.__irDone');
  check('the IR goes out as one type-15 message and the (demo) pedal adds it (16), then the library is read again', tx.some(t => /^TX Cloud IR download "Demo Cloud IR" 1\/1: [0-9A-F]{2} C0 08 06 1A .* 0F 00 00 00$/.test(t)) && irOutcome.ok && irOutcome.refreshed && irOutcome.index === 1 && tx.some(t => /^TX Library content request/.test(t)) && await js('state.library.irUser.some(x => x.name === "Demo Cloud IR" && x.index === 1)'), JSON.stringify(irOutcome) + ' ' + JSON.stringify(tx.map(t => t.slice(0, 60))));
  n0 = await mark();
  await js(`window.__irAgain = null; __receiveCloudIR({ wav: ${JSON.stringify(wav)}, meta: ${JSON.stringify(irMeta)} }).then(r => { window.__irAgain = r; }); 0`);
  await waitFor('!!window.__irAgain || !!document.querySelector(".modal")');
  if (await js('!!document.querySelector(".modal")')) { await key('Escape'); await waitFor('!!window.__irAgain'); }
  const irAgain = await js('window.__irAgain');
  await settle();
  check('sending it again finds it on the pedal by name and sends nothing', irAgain.alreadyOnNano === true && await js('!document.querySelector(".modal")') && !(await txSince(n0)).some(t => /Cloud IR download/.test(t)), JSON.stringify(irAgain));

  // Delete it again: right-click → Delete…; the library is read again right before the 82, which carries the user index and name.
  await key('5'); await frame();
  const userRow = '[...document.querySelectorAll(".cab-library-section .library-row")].find(r => r.querySelector(".library-item span")?.textContent === "Demo Cloud IR")';
  await waitFor(`!!(${userRow})`);
  await js('state.irNames.set(5, "Demo Cloud IR"); render()'); await frame();
  await js(`(() => { const r = ${userRow}; r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })); })()`);
  await waitFor('!!document.querySelector(".ctx")');
  await js(ctxItem('Delete') + '.click()');
  await checkSoon('Delete asks first and says an IR slot holds that IR', '!!document.querySelector(".modal") && /Delete IR “Demo Cloud IR” from the pedal/.test(document.querySelector(".modal h2").textContent) && /IR slot 5/.test(document.querySelector(".modal").textContent)', () => js('document.querySelector(".modal")?.textContent'));
  n0 = await mark();
  await key('Return');
  tx = (await txWait(n0, t => t.some(x => /^TX Delete IR/.test(x)))).filter(t => /^TX (Library content request|Delete IR)/.test(t));
  const del82 = frameHex([0x08, 0x02, 0x22, 2 + 2 + utf8('Demo Cloud IR').length, 0x08, 0x01, 0x12, utf8('Demo Cloud IR').length, ...utf8('Demo Cloud IR')], 82);
  check('IR delete: the library is read right before, then 82 carries the user index and name (exact bytes)', tx.length >= 2 && /^TX Library content request/.test(tx[0]) && tx[1] === 'TX Delete IR Demo Cloud IR: ' + del82, JSON.stringify(tx) + ' expected ' + del82);
  await checkSoon('the (demo) pedal confirms (83) and the IR is gone from the list', async () => (await toastText()) === 'Demo Cloud IR deleted from the pedal IR library.' && await js('!state.library.irUser.some(x => x.name === "Demo Cloud IR")'));
  await js('state.irNames.set(5, "212 Blue"); render()'); await settle();

  // ---------------------------------------------------------------- IR audition (158 → 159), and every audition stops before Save or a switch
  await waitFor('document.querySelectorAll(".cab-library-section .library-preview").length >= 6');
  const firstPreview = '.cab-library-section .library-row .library-preview';
  n0 = await mark();
  await click(firstPreview);
  tx = await txWait(n0, t => t.some(x => /^TX Preview IR/.test(x)));
  const play412 = frameHex([0x1A, 4 + utf8('412 V30').length, 0x08, 0x00, 0x12, utf8('412 V30').length, ...utf8('412 V30'), 0x40, 0x01], 158);
  check('previewing a factory cab sends 158 with the record in field 3 (exact bytes), nothing else', tx.length === 1 && tx[0] === 'TX Preview IR "412 V30": ' + play412, JSON.stringify(tx));
  await checkSoon('the (demo) pedal accepts it (159): the row plays, the keep-alive runs', async () => await js('!!document.querySelector(".cab-library-section .library-row.previewing .library-preview.playing")') && await js(`__ui.logs.some(l => l.seq > ${n0} && /Live preview keep-alive started/.test(l.text))`));
  const userPlay = await js('hex(__irPreviewRequest({ kind: "irUser", index: 0, name: "OwnHammer 412 Mix" }))');
  check('a user IR goes in field 4 instead (exact bytes)', userPlay === frameHex([0x22, 4 + utf8('OwnHammer 412 Mix').length, 0x08, 0x00, 0x12, utf8('OwnHammer 412 Mix').length, ...utf8('OwnHammer 412 Mix'), 0x40, 0x01], 158), userPlay);
  // Save while it plays: the stop (148 with field 4 = 0, confirmed by a 149 with the same transaction) goes first.
  await js('state.presetDirty = false; document.activeElement.blur(); render()');
  n0 = await mark();
  await key('s', [MOD]);
  tx = (await txWait(n0, t => t.some(x => /^TX save preset/.test(x)))).filter(t => /^TX (Stop IR preview|save preset|Preview keep-alive)/.test(t));
  check('Save during an IR audition sends the stop first (148 {2:tx 4:0}), then saves', tx.length === 2 && /^TX Stop IR preview: [0-9A-F]{2} C0 10 ([0-9A-F]{2} )+20 00 94 00 00 00$/.test(tx[0]) && /^TX save preset/.test(tx[1]), JSON.stringify(tx));
  await checkSoon('… the audition is over: row back to Play, keep-alive stopped', async () => await js('!document.querySelector(".library-preview.playing")') && await js(`__ui.logs.some(l => l.seq > ${n0} && /Live preview keep-alive stopped/.test(l.text))`));
  await settle();
  // The pedal doesn't confirm the stop: Save and a preset switch are refused and the audition stays shown as playing.
  n0 = await mark();
  await click(firstPreview);
  await checkSoon('previewing again', '!!document.querySelector(".library-preview.playing")');
  await js('__demo.hooks.refuseStop = true; state.presetDirty = false; render()');
  n0 = await mark();
  await key('s', [MOD]);
  await txWait(n0, t => t.some(x => /^TX Stop IR preview/.test(x)));
  check('a refused stop refuses Save: nothing saved, the IR still shows as playing, the user is told', !(await txSince(n0)).some(t => /^TX save preset/.test(t)) && await js('!!document.querySelector(".library-preview.playing")') && /did not confirm stopping the preview, so Save did not happen/.test(await toastText()), (await toastText()) + ' ' + JSON.stringify(await txSince(n0)));
  const presetBefore = await js('state.selectedPreset');
  const otherPreset = presetBefore === 1 ? 2 : 1;
  n0 = await mark();
  await click(`.preset-row[data-n="${otherPreset}"]`);
  await txWait(n0, t => t.some(x => /^TX Stop IR preview/.test(x)));
  check('… and refuses a preset switch: no 29 sent, still on the same preset', !(await txSince(n0)).some(t => /^TX Preset change/.test(t)) && (await js('state.selectedPreset')) === presetBefore && /the preset switch did not happen/.test(await toastText()), (await toastText()) + ' ' + JSON.stringify(await txSince(n0)));
  await js('__demo.hooks.refuseStop = false');
  n0 = await mark();
  await click(`.preset-row[data-n="${otherPreset}"]`);
  tx = (await txWait(n0, t => t.some(x => /^TX Preset change/.test(x)))).filter(t => /^TX (Stop IR preview|Preset change \d)/.test(t));
  check('once the pedal confirms, the switch goes ahead: stop first, then the preset change', tx.length === 2 && /^TX Stop IR preview/.test(tx[0]) && /^TX Preset change \d+:/.test(tx[1]) && (await js('state.selectedPreset')) === otherPreset, JSON.stringify(tx));
  await settle();
  // A preset change on the pedal itself (footswitch) during an audition: it is stopped and forgotten.
  await click(firstPreview);
  await checkSoon('previewing once more', '!!document.querySelector(".library-preview.playing")');
  n0 = await mark();
  await js('window.onC305({ target: { value: { buffer: buildFrame([0x18, 0x00, 0x20, state.selectedPreset - 1], MSG.SetPresetSlotsRequest).buffer } } })');
  tx = await txWait(n0, t => t.some(x => /^TX Stop IR preview/.test(x)));
  await checkSoon('a footswitch preset change ends the audition (stop sent, keep-alive off, row back to Play)', async () => tx.some(t => /^TX Preset change ack/.test(t)) && await js('!document.querySelector(".library-preview.playing")') && await js(`__ui.logs.some(l => l.seq > ${n0} && /Live preview keep-alive stopped/.test(l.text))`), () => JSON.stringify(tx));
  await settle();
  // Capture preview: a refused stop keeps it honest (still previewing) and the toolbar shows Stop Preview with the error.
  n0 = await mark();
  check('capture preview starts', (await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`)) === true && await js('__previewToolbar().active && __previewToolbar().phase === "active"'));
  await js('__demo.hooks.refuseStop = true');
  const refusedStop = await js('__stopCapturePreview()');
  check('a refused capture-preview stop leaves it previewing and the toolbar on Stop Preview, with the reason', refusedStop === false && await js('__ui.previewing && !__ui.previewBusy && __previewToolbar().active && __previewToolbar().phase === "active" && /did not confirm/.test(__previewToolbar().error)'), JSON.stringify(await js('__previewToolbar()')));
  await js('__demo.hooks.refuseStop = false');
  check('a confirmed stop sets the toolbar back to idle', (await js('__stopCapturePreview()')) === true && await js('!__ui.previewing && !__previewToolbar().active && __previewToolbar().phase === "idle"'), JSON.stringify(await js('__previewToolbar()')));
  await key('4'); await frame(); await settle();

  // ---------------------------------------------------------------- after a capture preview stops, the state is read again
  // While the pedal plays a preview its state names the previewed capture; the native edition kept showing that name
  // after the stop until the next state read (seen on the pedal, 2026-10-24). The demo pedal reports it the same way.
  const nodeModel = (k) => js(`document.querySelector('[data-fk="node-${k}"] .model')?.textContent || ''`);
  const ownCapture = await nodeModel('capture');
  check('a capture preview starts (re-read)', (await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`)) === true && ownCapture !== '' && ownCapture !== 'Test Preview', ownCapture);
  n0 = await mark();
  await js('window.onC305({ target: { value: { buffer: buildFrame([0x08, 0x01], 31).buffer } } })');   // "something changed": one state read
  await txWait(n0, t => t.some(x => /^TX Current preset state request/.test(x)));
  await checkSoon('during a preview a state read names the previewed capture (as the pedal reports it)', async () => (await nodeModel('capture')) === 'Test Preview', async () => await nodeModel('capture'));
  await js('__demo.hooks.refuseStop = true');
  n0 = await mark();
  check('a refused stop (re-read)', (await js('__stopCapturePreview({ quiet: true })')) === false);
  await settle();
  check('… reads nothing: the preview may still be playing', !(await txSince(n0)).some(t => /^TX Current preset state request/.test(t)) && (await nodeModel('capture')) === 'Test Preview', JSON.stringify(await txSince(n0)));
  await js('__demo.hooks.refuseStop = false');
  n0 = await mark();
  check('stopping the preview (re-read)', (await js('__stopCapturePreview()')) === true);
  tx = (await txWait(n0, t => t.some(x => /^TX Current preset state request/.test(x)))).filter(t => /^TX (Stop capture preview|Current preset state request)/.test(t));
  const confirmedAt = await js(`(__ui.logs.find(l => l.seq > ${n0} && /^Capture preview stop confirmed/.test(l.text)) || {}).seq || 0`);
  const readAt = await js(`(__ui.logs.find(l => l.seq > ${n0} && /^TX Current preset state request/.test(l.text)) || {}).seq || 0`);
  check('after a confirmed capture-preview stop the state is read again: 148, the 149, then one state request', tx.length === 2 && /^TX Stop capture preview/.test(tx[0]) && /^TX Current preset state request: 0C C0 08 03 18 01 20 01 28 01 01 00 00 00$/.test(tx[1]) && confirmedAt > 0 && readAt > confirmedAt, JSON.stringify(tx) + ' ' + confirmedAt + '/' + readAt);
  check('… and the chain shows the preset\'s own capture again, not the previewed one', (await nodeModel('capture')) === ownCapture, await nodeModel('capture'));
  await settle();

  // ---------------------------------------------------------------- quitting during an audition (src/quit-guard.js)
  // The shell's guard with the real page: the page reports whether anything is auditioned (nanoShell.auditionState;
  // here __auditionShown()), and the guard runs __stopAuditionsForQuit() as main does with executeJavaScript.
  {
    const { createQuitGuard, QUIT_CAP_MS, QUIT_LINES } = require('../src/quit-guard');
    const quitEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });
    const makeGuard = (opts = {}) => {
      const g = { quits: 0, lines: [], shown: false, t0: 0, quitAt: 0, nexts: 0 };
      g.guard = createQuitGuard({
        isAuditioning: () => g.shown,
        stopAuditions: opts.stop || (() => js('__stopAuditionsForQuit()')),
        quit: () => { g.quits++; g.quitAt = Date.now(); },
        log: (line) => g.lines.push(line),
        ...(opts.capMs ? { capMs: opts.capMs } : {}),
      });
      g.sync = async () => { g.shown = await js('__auditionShown()'); return g.shown; };
      g.quit = () => { g.t0 = Date.now(); const e = quitEvent(); g.guard.intercept(e); return e; };
      return g;
    };
    check('the quit guard waits at most 1.5 s', QUIT_CAP_MS === 1500);
    check('quit lines, word for word the native edition\'s: "Quit: stopped the preview first (the pedal confirmed in N ms).", "Quit: the pedal did not confirm stopping the preview; quitting anyway.", "Quit: the pedal did not answer the preview stop within 1.5 s; quitting anyway."',
      QUIT_LINES.stopped(42.4) === 'Quit: stopped the preview first (the pedal confirmed in 42 ms).' && QUIT_LINES.notConfirmed === 'Quit: the pedal did not confirm stopping the preview; quitting anyway.' && QUIT_LINES.timedOut(QUIT_CAP_MS) === 'Quit: the pedal did not answer the preview stop within 1.5 s; quitting anyway.');
    const stoppedLine = (lines) => lines.length === 1 && /^Quit: stopped the preview first \(the pedal confirmed in \d+ ms\)\.$/.test(lines[0]);
    let g = makeGuard();
    n0 = await mark();
    await g.sync();
    let e = g.quit();
    check('quitting with nothing auditioned is not held (no stop, no line)', !g.shown && !e.prevented && g.quits === 0 && g.lines.length === 0 && (await txSince(n0)).length === 0);

    // A Live Preview playing: the quit waits for the stop and the pedal's confirmation, then quits once.
    check('a capture preview starts (quit)', (await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`)) === true);
    check('… and the page has told the shell that something is auditioned', await g.sync());
    n0 = await mark();
    e = g.quit();
    const again = quitEvent(); g.guard.intercept(again);   // ⌘Q again, or the window's close that follows
    check('quitting during a Live Preview is held (and so is a second quit or the window close meanwhile)', e.prevented && again.prevented && g.quits === 0);
    await waitFor(() => g.quits > 0, { timeout: 4000 });
    tx = await txWait(n0, t => t.some(x => /^TX Stop capture preview/.test(x)));
    check('… the page sends the stop (148) once, the pedal confirms (149), then the app quits, once', g.quits === 1 && tx.filter(t => /^TX Stop capture preview: .* 94 00 00 00$/.test(t)).length === 1 && await js(`__ui.logs.some(l => l.seq > ${n0} && /^Capture preview stop confirmed/.test(l.text))`) && g.quitAt - g.t0 < QUIT_CAP_MS, JSON.stringify(tx) + ' ' + (g.quitAt - g.t0) + ' ms');
    check('… with one Activity line: "Quit: stopped the preview first (the pedal confirmed in N ms)."', stoppedLine(g.lines), JSON.stringify(g.lines));
    check('… no state read on the way out, the keep-alive stopped, nothing auditioned any more', !tx.some(t => /^TX Current preset state request/.test(t)) && await js(`!__ui.previewing && !__ui.previewBusy && __ui.logs.some(l => l.seq > ${n0} && /Live preview keep-alive stopped/.test(l.text))`) && !(await g.sync()), JSON.stringify(tx));
    e = g.quit();
    check('once it has run, the next quit goes through', !e.prevented && g.quits === 1);

    // A library IR audition: the IR stop (148 with field 4).
    g = makeGuard();
    check('an IR audition starts (quit)', (await js('__previewIR({ kind: "irFactory", index: 0, name: "412 V30" })')) === true && await g.sync());
    n0 = await mark();
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 4000 });
    tx = await txWait(n0, t => t.some(x => /^TX Stop IR preview/.test(x)));
    check('quitting during an IR audition sends the IR stop (148 {2:tx 4:0}) and quits after the confirmation', e.prevented && g.quits === 1 && tx.filter(t => /^TX Stop IR preview: [0-9A-F]{2} C0 10 ([0-9A-F]{2} )+20 00 94 00 00 00$/.test(t)).length === 1 && stoppedLine(g.lines) && await js('!document.querySelector(".library-preview.playing")'), JSON.stringify(tx) + ' ' + JSON.stringify(g.lines));
    await settle();

    // A pedal that refuses the stop: quit anyway, at once, and say so.
    g = makeGuard();
    await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`);
    await g.sync();
    await js('__demo.hooks.refuseStop = true');
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 4000 });
    check('a pedal that refuses the stop: the app still quits, without waiting out the 1.5 s, and the line says the pedal did not confirm', e.prevented && g.quits === 1 && g.quitAt - g.t0 < QUIT_CAP_MS && JSON.stringify(g.lines) === JSON.stringify([QUIT_LINES.notConfirmed]), (g.quitAt - g.t0) + ' ms ' + JSON.stringify(g.lines));
    await js('__demo.hooks.refuseStop = false');
    check('(the preview is stopped for real afterwards)', (await js('__stopCapturePreview({ quiet: true })')) === true);
    await settle();

    // A slow pedal: one that answers within 1.5 s is waited for; one that doesn't is not.
    g = makeGuard();
    await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`);
    await g.sync();
    await js('__demo.hooks.stopDelay = 400');
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 4000 });
    check('a slow pedal (answers after 0.4 s): the quit waits for it, then quits with "Quit: stopped the preview first (the pedal confirmed in N ms)."', e.prevented && g.quits === 1 && g.quitAt - g.t0 >= 380 && g.quitAt - g.t0 < QUIT_CAP_MS && stoppedLine(g.lines) && Number(/in (\d+) ms/.exec(g.lines[0])[1]) >= 380, (g.quitAt - g.t0) + ' ms ' + JSON.stringify(g.lines));
    await settle();
    g = makeGuard();
    await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`);
    await g.sync();
    await js('__demo.hooks.stopDelay = 2600');
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 4000 });
    check('a pedal that answers after 2.6 s: the app quits at the 1.5 s cap, with "Quit: the pedal did not answer the preview stop within 1.5 s; quitting anyway."', e.prevented && g.quits === 1 && g.quitAt - g.t0 >= QUIT_CAP_MS - 50 && g.quitAt - g.t0 < QUIT_CAP_MS + 1000 && JSON.stringify(g.lines) === JSON.stringify([QUIT_LINES.timedOut(QUIT_CAP_MS)]), (g.quitAt - g.t0) + ' ms ' + JSON.stringify(g.lines));
    await waitFor('!__ui.previewing && !__ui.previewBusy', { timeout: 4000 });
    await js('__demo.hooks.stopDelay = 0');
    check('(that preview ends when the late confirmation arrives)', await js('!__ui.previewing && !__ui.previewBusy'));
    await settle();

    // The page is gone or hung: never blocks quitting.
    g = makeGuard({ stop: () => Promise.reject(new Error('Render frame was disposed before WebFrameMain could be accessed')) });
    g.shown = true;
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 1000 });
    check('the editor page gone (executeJavaScript fails): quits at once, "did not confirm" line', e.prevented && g.quits === 1 && g.quitAt - g.t0 < 300 && JSON.stringify(g.lines) === JSON.stringify([QUIT_LINES.notConfirmed]), (g.quitAt - g.t0) + ' ms');
    g = makeGuard({ stop: () => new Promise(() => {}), capMs: 250 });
    g.shown = true;
    e = g.quit();
    await waitFor(() => g.quits > 0, { timeout: 2000 });
    check('a page that never answers: quits at the cap ("did not answer … within 0.3 s")', e.prevented && g.quits === 1 && g.quitAt - g.t0 >= 240 && JSON.stringify(g.lines) === JSON.stringify(['Quit: the pedal did not answer the preview stop within 0.3 s; quitting anyway.']), (g.quitAt - g.t0) + ' ms');
    g = makeGuard({ stop: () => Promise.resolve({ active: false, ok: true }) });
    g.shown = true;   // the shell thought so, but the page says nothing plays: quit, no line
    g.quit();
    await waitFor(() => g.quits > 0, { timeout: 1000 });
    check('the page says nothing is auditioned after all: quits, no line', g.quits === 1 && g.lines.length === 0);

    // The update modal's Restart: the stop first, then the updater (which quits by itself).
    g = makeGuard();
    await js(`__previewCapture({ cns: [1, 2, 3, 4], meta: ${JSON.stringify(previewMeta)} })`);
    await g.sync();
    n0 = await mark();
    await g.guard.beforeRestart(() => { g.nexts++; });
    tx = await txWait(n0, t => t.some(x => /^TX Stop capture preview/.test(x)));
    e = g.quit();
    check('Restart (update) during an audition: the stop goes first, then the updater runs; its quit is not held again', g.nexts === 1 && g.quits === 0 && !e.prevented && tx.some(t => /^TX Stop capture preview/.test(t)) && stoppedLine(g.lines), JSON.stringify(tx));
    g = makeGuard();
    await g.sync();
    await g.guard.beforeRestart(() => { g.nexts++; });
    check('Restart with nothing auditioned runs the updater at once', g.nexts === 1 && g.lines.length === 0);
    await settle();
  }

  // ---------------------------------------------------------------- write coalescing
  // Deterministic: the first write leaves at once, the next five queue behind it under one key and merge.
  n0 = await mark();
  await js('(async () => { const w = []; for (let i = 0; i < 6; i++) w.push(setAmpKnob("gain", 100 + i)); await Promise.all(w); })()');
  const burst = await txWait(n0, tx => tx.length >= 2);
  check('6 rapid writes to one knob coalesce to first + latest', burst.length === 2 && /Amp gain = 100:/.test(burst[0]) && /Amp gain = 105:/.test(burst[1]), JSON.stringify(burst));
  await js('__ui.sideSig = ""; render()'); await frame();

  // ---------------------------------------------------------------- drawer, shortcuts
  await key('l', [MOD]);
  check('Ctrl/⌘L opens activity', await js('document.getElementById("drawer").classList.contains("open")'));
  await js('document.getElementById("toast").classList.add("show"); document.getElementById("toast").textContent = "Placement check"');
  await stable('JSON.stringify([document.getElementById("toast").getBoundingClientRect(), document.getElementById("drawer").getBoundingClientRect()])');   // both have finished sliding in
  check('toast sits above the open Activity drawer', await js('document.getElementById("toast").getBoundingClientRect().bottom <= document.getElementById("drawer").getBoundingClientRect().top'));
  await shot('10-activity');
  await js('document.getElementById("toast").classList.remove("show")');
  await key('l', [MOD]);
  await js('document.activeElement.blur()');
  await key('?');
  check('? opens shortcuts', await js('!!document.querySelector(".modal .keys")'));
  check('(dev tools on) the shortcuts sheet lists ⌘L', await js('[...document.querySelectorAll(".modal .keys kbd")].some(k => /^(⌘|Ctrl\\+)L$/.test(k.textContent) && k.nextElementSibling.textContent === "Show Bluetooth activity")'));
  check('(dev tools on) the shortcuts sheet lists Record', await js('[...document.querySelectorAll(".modal .keys kbd")].some(k => k.textContent === "Record" && k.nextElementSibling.textContent === "In the status bar: record every packet, then save it as JSON")'));
  check('the shortcuts sheet lists each shortcut once (Settings appears a single time)', await js('(() => { const k = [...document.querySelectorAll(".modal .keys kbd")].map(x => x.textContent + "|" + x.nextElementSibling.textContent); return new Set(k).size === k.length && k.filter(x => x.endsWith("|Settings")).length === 1; })()'));
  check('the shortcuts sheet ends with "Full manual…" pointing at the manual', (await js('(() => { const a = document.querySelector(\'[data-fk="keys-manual"]\'); return a ? a.textContent + "|" + a.href : ""; })()')) === 'Full manual\u2026|' + LINKS.manual);
  await shot('11-shortcuts');
  await key('Escape');

  // ---------------------------------------------------------------- settings
  const settingsOpen = () => js('!!document.querySelector(".modal.settings-modal")');
  await js('document.activeElement.blur()');
  await key(',', [MOD]);
  await checkSoon('Ctrl/⌘, opens Settings', settingsOpen);
  check('Settings has Appearance, Metronome, Connection and Advanced', (await js('[...document.querySelectorAll(".settings h3")].map(h => h.textContent).join("|")')) === 'Appearance|Metronome|Connection|Advanced');
  check('the accent offers the seven Cortex Control colours, Purple selected', (await js('[...document.querySelectorAll(".swatch")].map(b => b.getAttribute("aria-label")).join(",")')) === 'Purple,Teal,Green,Orange,Yellow,Red,Blue' && await js('document.querySelector(".swatch.on").getAttribute("aria-label") === "Purple"'));
  await shot('17-settings');
  await key('Escape');
  await checkSoon('Esc closes Settings', async () => !(await settingsOpen()));
  check('Settings sits in the status bar, left of Shortcuts', await js('document.getElementById("settingsBtn").nextElementSibling.id === "keysBtn" && !!document.getElementById("settingsBtn").closest(".status")'));
  await click('#settingsBtn');
  await checkSoon('the status-bar Settings button opens it', settingsOpen);

  // accent
  const purpleRow = await js('getComputedStyle(document.querySelector(".preset-row.active")).backgroundColor');
  check('active preset row is the old purple by default (#2a2456)', (() => { const c = rgbOf(purpleRow); return !!c && Math.abs(c[0] - 42) <= 6 && Math.abs(c[1] - 36) <= 6 && Math.abs(c[2] - 86) <= 8; })(), purpleRow);
  await click('[data-fk="accent-orange"]');
  await checkSoon('choosing Orange sets --accent on :root', async () => (await js('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()')) === '#ff7000');
  check('--accent-hi and --focus follow it (lighter shades)', await js('(() => { const s = getComputedStyle(document.documentElement); const h = s.getPropertyValue("--accent-hi").trim(), f = s.getPropertyValue("--focus").trim(); return /^#ff[89a-f][0-9a-f][0-9a-f]{2}$/.test(h) && /^#ff[a-f][0-9a-f][0-9a-f]{2}$/.test(f) && h !== f; })()'), await js('getComputedStyle(document.documentElement).getPropertyValue("--accent-hi") + " " + getComputedStyle(document.documentElement).getPropertyValue("--focus")'));
  check('the choice is stored (settings.accent)', (await js('JSON.parse(localStorage.getItem("settings.accent"))')) === '#ff7000');
  check('Orange shows as selected', await js('document.querySelector(".swatch.on").getAttribute("aria-label") === "Orange"'));
  await key('Escape'); await waitFor(async () => !(await settingsOpen()));
  await js('state.presetDirty = true; render()'); await frame();
  check('the Save button\'s background follows the accent', (await js('getComputedStyle(document.getElementById("saveBtn")).backgroundColor')) === 'rgb(255, 112, 0)', await js('getComputedStyle(document.getElementById("saveBtn")).backgroundColor'));
  check('text on the light accent turns dark for contrast', (await js('getComputedStyle(document.getElementById("saveBtn")).color')) === 'rgb(18, 18, 18)', await js('getComputedStyle(document.getElementById("saveBtn")).color'));
  await shot('18-orange-accent');
  await js('state.presetDirty = false; render()'); await frame();
  const orangeRow = rgbOf(await js('getComputedStyle(document.querySelector(".preset-row.active")).backgroundColor'));
  check('the active preset row colour follows the accent', !!orangeRow && orangeRow[0] > orangeRow[1] && orangeRow[1] > orangeRow[2] && orangeRow[0] > 50, JSON.stringify(orangeRow));
  const orangeNum = rgbOf(await js('getComputedStyle(document.querySelector(".preset-row.active .n")).color'));
  check('the active row number follows it too', !!orangeNum && orangeNum[0] > 240 && orangeNum[2] < orangeNum[1], JSON.stringify(orangeNum));
  const led = rgbOf(await js('getComputedStyle(document.querySelector(".brand .brand-led")).stroke'));
  check('the header mark\'s LED arc follows the accent', !!led && led[0] === 255 && led[2] < 80, JSON.stringify(led));

  // metronome
  await click('#settingsBtn'); await waitFor(settingsOpen);
  check('Connection: reconnect at launch is shown disabled, with the reason, outside the desktop app', await js('document.querySelector(\'[data-fk="set-autoconnect"]\').disabled && /Web Bluetooth/.test(document.querySelector(\'[data-fk="set-pedal"]\').textContent)'));
  const soundRows = () => js('[...document.querySelectorAll(\'[data-fk^="set-snd-"]\')].map(r => r.querySelector(".set-label").textContent + ": " + [...r.querySelector("select").options].map(o => o.textContent).join(",")).join(" | ")');
  check('Metronome → Sounds: Accent, Main beat and Subdivision, each with Click, Woodblock, Tick, Beep, Cowbell and Custom sample…',
    (await soundRows()) === ['Accent', 'Main beat', 'Subdivision'].map(l => l + ': Click,Woodblock,Tick,Beep,Cowbell,Custom sample…').join(' | ') && (await js('document.querySelector(".set-sub").textContent')) === 'Sounds', await soundRows());
  check('a sound row without a custom sample is just its menu and ▶ (no stray text)', await js('[...document.querySelectorAll(\'[data-fk^="set-snd-"] .set-ctl\')].every(c => c.childNodes.length === 2 && c.children.length === 2 && c.textContent === c.querySelector("select").textContent)'));
  check('outside the desktop app "Custom sample…" is disabled', await js('[...document.querySelectorAll(\'[data-fk^="set-sound-"] option[value=pick]\')].every(o => o.disabled)'));
  await setSel('set-sound-main', 'tick');
  await click('[data-fk="set-play-main"]');
  await checkSoon('▶ plays that role\'s sound', async () => (await js('__metro.state.lastVoice')) === 'tick');
  await setSel('set-sound-main', 'woodblock');
  check('each role\'s sound is stored with the metronome settings', await js('(() => { const m = JSON.parse(localStorage.getItem("metronome")); return m.sounds.main === "woodblock" && m.sounds.accent === "click" && m.sounds.sub === "click" && !("sound" in m); })()'));
  await js('{ const b = document.querySelector(\'[data-fk="set-bpm"]\'); b.value = "200"; b.dispatchEvent(new Event("change")); const v = document.querySelector(\'[data-fk="set-volume"]\'); v.value = "0.4"; v.dispatchEvent(new Event("input")); }');
  check('default tempo and volume land in the overlay\'s stored keys', await js('(() => { const m = JSON.parse(localStorage.getItem("metronome")); return m.bpm === 200 && m.volume === 0.4; })()'));
  await click('[data-fk="set-drawer"]');
  check('"Show the Activity drawer at launch" is stored', (await js('JSON.parse(localStorage.getItem("settings.drawerAtLaunch"))')) === true);
  // advanced metronome defaults
  const metroLabels = await js('[...[...document.querySelectorAll(".settings section")].find(x => x.querySelector("h3").textContent === "Metronome").querySelectorAll(".set-label")].map(l => l.textContent)');
  check('Settings → Metronome adds Opens in, Pattern, Subdivision, Count-in and the three levels', ['Opens in', 'Pattern', 'Subdivision', 'Count-in', 'Accent level', 'Main ticks level', 'Subdivisions level'].every(l => metroLabels.includes(l)), metroLabels.join('|'));
  check('Settings shows the levels set in the popover', await js('document.querySelector(\'[data-fk="set-lvl-accent"]\').value === "0.5" && document.querySelector(\'[data-fk="set-lvl-sub"]\').value === "0.25"'));
  check('Opens in defaults to Simple', (await js('document.querySelector(\'[data-fk="set-opens"]\').value')) === 'simple');
  for (const [fk, v] of [['set-opens', 'advanced'], ['set-pattern', '7/8'], ['set-subdiv', '3'], ['set-countin', '2']]) await js(`{ const s = document.querySelector('[data-fk="${fk}"]'); s.value = "${v}"; s.dispatchEvent(new Event("change")); }`);
  await js('{ const r = document.querySelector(\'[data-fk="set-lvl-main"]\'); r.value = "0.8"; r.dispatchEvent(new Event("input")); }');
  check('Settings pattern, subdivision and count-in set the advanced setup', await js('(() => { const m = JSON.parse(localStorage.getItem("metronome")); return m.opensIn === "advanced" && m.adv.beats === 7 && m.adv.note === 8 && m.adv.sub === 3 && m.adv.countIn === 2; })()'));
  check('the Settings level sliders are the same levels (stored)', (await js('JSON.parse(localStorage.getItem("metronome")).levels.main')) === 0.8);
  await key('Escape'); await waitFor(async () => !(await settingsOpen()));
  await js('document.activeElement.blur()');
  await key('n'); await waitFor('__metro.state.open');
  check('the metronome overlay shows the settings (200 BPM, volume 0.4)', await js('document.getElementById("metroBpm").value === "200" && document.getElementById("metroVol").value === "0.4"'));
  check('Settings "Opens in: Advanced" is honoured', await js('__metro.state.mode === "advanced" && !document.getElementById("metroAdv").hidden && document.querySelectorAll(".metro-cell").length === 7'));
  await key(' ');
  await checkSoon('the metronome schedules each role\'s sound (main beats: Woodblock, accents: Click) and still runs',
    '__metro.state.running && __metro.state.count >= 1 && __metro.state.scheduled.some(e => e.role === "accent") && __metro.state.scheduled.some(e => e.role === "normal") && __metro.state.scheduled.every(e => e.sound === ({ accent: "click", normal: "woodblock", soft: "woodblock", sub: "click", mute: null })[e.role])',
    () => js('JSON.stringify({ r: __metro.state.running, c: __metro.state.count, ev: __metro.state.scheduled.slice(0, 8).map(e => e.role + ":" + e.sound) })'));
  await key(' ');
  await checkSoon('and still stops', '!__metro.state.running');
  await key('Escape'); await waitFor('!__metro.state.open');

  // persistence across a reload
  await reloadPage();
  check('the accent survives a reload', (await js('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()')) === '#ff7000' && (await js('getComputedStyle(document.querySelector(".preset-row.active")).boxShadow')).includes('rgb(255, 112, 0)'));
  check('the sounds and tempo survive a reload', await js('__metro.state.sounds.main === "woodblock" && __metro.state.sounds.accent === "click" && __metro.state.bpm === 200'));
  check('the Activity drawer opens at launch when set', await js('document.getElementById("drawer").classList.contains("open")'));
  check('the advanced setup, levels and Opens in survive a reload', await js('(() => { const s = __metro.state; return s.opensIn === "advanced" && s.adv.pattern.join() === "accent,soft,normal,soft,normal,soft,soft" && s.adv.note === 8 && s.adv.sub === 3 && s.adv.countIn === 2 && s.levels.accent === 0.5 && s.levels.main === 0.8 && s.levels.sub === 0.25; })()'));
  await js('document.activeElement.blur()');
  await key('n'); await waitFor('__metro.state.open');
  await checkSoon('after a reload the overlay opens in Advanced with the remembered pattern', () => js('__metro.state.mode === "advanced" && document.querySelector(\'[data-fk="metro-pattern"]\').value === "7/8" && document.querySelector(\'[data-fk="metro-sub-3"]\').classList.contains("on")'));
  await key('Escape'); await waitFor('!__metro.state.open');
  // back to the defaults for the rest of the run (and the next one)
  await js('__accent.set("#6954ff"); localStorage.removeItem("settings.drawerAtLaunch"); __metro.state.sounds = { accent: "click", main: "click", sub: "click" }; __metro.state.volume = 0.6; __metro.state.opensIn = "simple"; __metro.state.mode = "simple"; __metro.state.adv = __metro.normSetup({}); Object.assign(__metro.state.levels, { accent: 1, main: 1, sub: 1 }); __metro.setBpm(100)');
  await key('l', [MOD]);
  check('Purple restores the original colours', (await js('getComputedStyle(document.documentElement).getPropertyValue("--accent-hi").trim()')) === '#7b68ff' && (await js('getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim()')) === '#ffffff');

  // ---------------------------------------------------------------- custom metronome samples
  // The shell's side (src/metro-samples.js) with a temporary folder and a stub file dialog. The test carries the page's
  // requests to it as the IPC does: the page's bridge (set through __metro.samples.setBridge, which also runs the
  // launch-time load) queues { op, role }, the pump below answers with the real module, bytes as base64.
  {
    const { createMetroSamples, EXTS, MAX_BYTES } = require('../src/metro-samples');
    const sdir = path.join(OUT, 'metronome-sounds'), srcDir = path.join(OUT, 'sample-sources');
    for (const d of [sdir, srcDir]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(srcDir, { recursive: true });
    // Test files, generated here: 16-bit PCM WAV (by default a decaying 1 kHz tone) and 16-bit AIFF (a known ramp).
    const tone = (i, _c, rate) => Math.round(12000 * Math.sin(2 * Math.PI * 1000 * i / rate) * Math.exp(-8 * i / rate));
    const wavBytes = (seconds, channels = 1, rate = 44100, value = tone) => {
      const n = Math.round(seconds * rate), data = Buffer.alloc(n * channels * 2);
      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) data.writeInt16LE(value(i, c, rate), (i * channels + c) * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
      h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
      return Buffer.concat([h, data]);
    };
    const aiffBytes = (seconds, rate = 44100) => {
      const n = Math.round(seconds * rate), data = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) data.writeInt16BE(-16000 + (i % 100) * 10, i * 2);
      const comm = Buffer.alloc(26), e = Math.floor(Math.log2(rate));
      comm.write('COMM', 0); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(1, 8); comm.writeUInt32BE(n, 10); comm.writeUInt16BE(16, 14);
      comm.writeUInt16BE(16383 + e, 16); comm.writeBigUInt64BE(BigInt(rate) << BigInt(63 - e), 18);   // the rate as an 80-bit float
      const ssnd = Buffer.alloc(16); ssnd.write('SSND', 0); ssnd.writeUInt32BE(8 + data.length, 4);
      const body = Buffer.concat([Buffer.from('AIFF'), comm, ssnd, data]), form = Buffer.alloc(8);
      form.write('FORM', 0); form.writeUInt32BE(body.length, 4);
      return Buffer.concat([form, body]);
    };
    const source = (name, bytes) => { const f = path.join(srcDir, name); fs.writeFileSync(f, bytes); return f; };
    const stored = () => fs.existsSync(sdir) ? fs.readdirSync(sdir).sort().join(',') : '';
    let nextPick = null;
    const dialogs = [];
    const shell = createMetroSamples({ dir: sdir, choose: async (role, opts) => { dialogs.push({ role, ...opts }); return nextPick; } });
    let pumping = true;
    const pump = (async () => {
      while (pumping) {
        let q = [];
        try { q = await js('typeof __sb === "undefined" ? [] : __sb.q.splice(0)'); } catch { /* reloading */ }
        for (const c of q) {
          const r = await shell.handle(c.op, c.role);
          const out = r && r.bytes ? { ...r, bytes: Buffer.from(r.bytes).toString('base64') } : r;
          try { await js(`__sb.done(${c.id}, ${JSON.stringify(out)})`); } catch { /* reloading */ }
        }
        await sleep(15);
      }
    })();
    // The bridge, as the preload's nanoShell.metroSample would be; resolves to the roles the launch-time load gave up on.
    const connectShell = () => js(`(() => {
      window.__sb = { n: 0, q: [], wait: {}, done(id, r) { if (r && r.bytes) r.bytes = Uint8Array.from(atob(r.bytes), c => c.charCodeAt(0)); this.wait[id](r); delete this.wait[id]; } };
      return __metro.samples.setBridge((op, role) => new Promise((res) => { const id = ++__sb.n; __sb.wait[id] = res; __sb.q.push({ id, op, role }); }));
    })()`);
    // Every buffer the page starts, with the gain it goes through, and every toast.
    const instrument = () => js(`(() => {
      window.__plays = []; window.__toasts = []; window.__cuts = [];
      new MutationObserver(() => __toasts.push(document.getElementById('toast').textContent)).observe(document.getElementById('toast'), { childList: true, characterData: true, subtree: true });
      const P = AudioContext.prototype, make = P.createBufferSource;
      if (P.__wrapped) return; P.__wrapped = true;
      P.createBufferSource = function () {
        const n = make.call(this), connect = n.connect.bind(n), start = n.start.bind(n);
        let gain = null;
        n.connect = (d, ...a) => { if (d instanceof GainNode) gain = d.gain.value; return connect(d, ...a); };
        const stop = n.stop.bind(n), play = { buffer: null, at: 0, gain: null, stop: null };
        n.start = (at, ...a) => { Object.assign(play, { buffer: n.buffer, at, gain }); __plays.push(play); if (__plays.length > 1000) __plays.shift(); return start(at, ...a); };
        n.stop = (t) => { play.stop = t; return stop(t); };
        return n;
      };
      const ramp = AudioParam.prototype.linearRampToValueAtTime;   // a cut is the only ramp to exactly 0
      AudioParam.prototype.linearRampToValueAtTime = function (v, t) { if (v === 0) __cuts.push(t); return ramp.call(this, v, t); };
    })()`);
    const toastNow = () => js('document.getElementById("toast").classList.contains("show") ? document.getElementById("toast").textContent : ""');
    const refusal = () => js('(() => { const m = document.querySelector(\'[data-fk="set-sound-msg"]\'); return m && !m.hidden && m.getClientRects().length ? m.textContent : ""; })()');
    const metroStore = () => js('JSON.parse(localStorage.getItem("metronome") || "{}")');
    const openSet = async () => { await click('#settingsBtn'); await waitFor(settingsOpen); };
    const closeSet = async () => { await key('Escape'); await waitFor(async () => !(await settingsOpen())); };
    const choose = async (role, file) => {   // "Custom sample…" in the role's menu, with the stub dialog answering `file`
      nextPick = file;
      const before = dialogs.length;
      await setSel('set-sound-' + role, 'pick');
      await waitFor(async () => dialogs.length > before && await js(`!document.querySelector('[data-fk="set-sound-${role}"]').disabled`));
      await frame();
    };

    await instrument();
    check('samples: the launch-time load has nothing to do on a fresh install', (await connectShell()).length === 0 && (await js('__toasts.length')) === 0);
    await openSet();
    check('samples: in the desktop app "Custom sample…" is enabled', await js('[...document.querySelectorAll(\'[data-fk^="set-sound-"] option[value=pick]\')].every(o => !o.disabled)'));

    // Pick a WAV for the main beat: copied into the data folder, stored, shown, decoded once and used.
    const clickWav = wavBytes(0.25);
    const clickSrc = source('My Click.wav', clickWav);
    await choose('main', clickSrc);
    await checkSoon('samples: picking a WAV for Main beat copies it to metronome-sounds/main.wav', async () => stored() === 'main.wav' && fs.readFileSync(path.join(sdir, 'main.wav')).equals(clickWav), stored);
    check('samples: the dialog is the shell\'s, for that role, filtered to the audio types', dialogs.length === 1 && dialogs[0].role === 'main' && dialogs[0].title === 'Custom sample: Main beat'
      && JSON.stringify(dialogs[0].filters) === JSON.stringify([{ name: 'Audio', extensions: EXTS }]) && ['wav', 'aif', 'aiff', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus'].every(x => EXTS.includes(x)), JSON.stringify(dialogs[0]));
    check('samples: the choice is stored with the metronome settings (file name only)', JSON.stringify((await metroStore()).samples) === '{"main":{"name":"My Click.wav"}}', JSON.stringify((await metroStore()).samples));
    check('samples: the row shows "Custom", the file name and Reset', await js('(() => { const r = document.querySelector(\'[data-fk="set-snd-main"]\'); return r.querySelector("select").value === "custom" && r.querySelector(\'[data-fk="set-file-main"]\').textContent === "My Click.wav" && r.querySelector(\'[data-fk="set-reset-main"]\').textContent === "Reset"; })()'));
    check('samples: no toast for a sample under 2 s', !/trimmed/.test(await toastNow()), await toastNow());
    check('samples: decoded once into an AudioBuffer (0.25 s, mono)', await js('(() => { const b = __metro.samples.buffers.main; return b instanceof AudioBuffer && Math.abs(b.duration - 0.25) < 0.002 && b.numberOfChannels === 1; })()'));
    check('samples: main and soft beats use it, accents and subdivisions keep their built-in sound', await M('m.soundFor("normal").buffer === m.samples.buffers.main && m.soundFor("soft").buffer === m.samples.buffers.main && m.soundFor("normal").id === "sample" && m.soundFor("accent").id === "click" && m.soundFor("sub").id === "click"'));
    await js('__plays.length = 0');
    await click('[data-fk="set-play-main"]');
    await checkSoon('samples: ▶ plays the sample at the main level and the volume', () => js('__plays.some(p => p.buffer === __metro.samples.buffers.main && Math.abs(p.gain - __metro.state.volume * __metro.state.levels.main) < 1e-6)'), () => js('JSON.stringify(__plays.map(p => p.gain))'));

    // Subdivision too; a long stereo file for the accent is cut to its first 2 s, with a toast, and mixed to mono.
    await choose('sub', source('Sub Tick.wav', wavBytes(0.1)));
    const longHit = wavBytes(3, 2, 48000, (_i, c) => (c ? -8192 : 16384));   // left +0.5, right −0.25
    await choose('accent', source('Long Hit.wav', longHit));
    await checkSoon('samples: a 3 s file is trimmed to 2 s, and says so', async () => (await toastNow()) === '“Long Hit.wav” is trimmed to its first 2 seconds.', toastNow);
    check('samples: stereo is mixed to mono by averaging, not normalised (+0.5 and −0.25 → +0.125), faded out where cut',
      await js('(() => { const b = __metro.samples.buffers.accent, d = b.getChannelData(0); return b.numberOfChannels === 1 && b.length === 96000 && Math.abs(d[1000] - 0.125) < 1e-3 && Math.abs(d[95999]) < 1e-3 && d[95700] > 0.12; })()'),
      await js('(() => { const b = __metro.samples.buffers.accent, d = b.getChannelData(0); return b.numberOfChannels + " ch, " + b.length + ", " + d[1000] + " … " + d[95999]; })()'));
    check('samples: the copy is the whole file', fs.readFileSync(path.join(sdir, 'accent.wav')).equals(longHit), stored());
    await js('document.querySelector(\'[data-fk="set-snd-sub"]\').scrollIntoView({ block: "center" })');
    await shot('metro-samples-settings');
    // Picking a built-in sound while a sample is set drops the sample (and its copy).
    await setSel('set-sound-accent', 'beep');
    await checkSoon('samples: choosing a built-in sound instead deletes the copy', async () => stored() === 'main.wav,sub.wav' && await js('!__metro.samples.buffers.accent && __metro.state.sounds.accent === "beep" && !__metro.state.samples.accent && !document.querySelector(\'[data-fk="set-reset-accent"]\')'), stored);
    await setSel('set-sound-accent', 'click');
    await closeSet();

    // The scheduler plays the samples like the built-ins: same times, the role's level times the volume.
    await js('Object.assign(__metro.state.levels, { accent: 1, main: 0.5, sub: 0.25 }); __metro.state.adv = __metro.normSetup({ beats: 4, pattern: ["accent", "normal", "soft", "normal"], sub: 2 }); __metro.setBpm(240)');
    await js('document.activeElement.blur()');
    await key('n'); await waitFor('__metro.state.open');
    await click('[data-fk="metro-mode-advanced"]');
    await js('__plays.length = 0; __cuts.length = 0');
    await key(' ');
    await waitFor(() => M('s.scheduled.filter(e => e.role === "soft").length >= 2 && s.scheduled.filter(e => e.role === "sub").length >= 8'));
    await key(' '); await waitFor('!__metro.state.running');
    const run = await js(`(() => {
      const B = __metro.samples.buffers, v = __metro.state.volume, ev = __metro.state.scheduled.slice(), plays = __plays.slice();
      const want = { normal: [B.main, v * 0.5], soft: [B.main, v * 0.5 * 0.45], sub: [B.sub, v * 0.25 * 0.5] };
      const bad = [];
      for (const e of ev) {
        if (e.role === 'accent') { if (e.sound !== 'click') bad.push('accent ' + e.sound); continue; }
        const [buf, gain] = want[e.role];
        const p = plays.filter(p => p.buffer === buf && Math.abs(p.at - e.at) < 1e-6);
        if (e.sound !== 'sample' || p.length !== 1 || Math.abs(p[0].gain - gain) > 1e-6) bad.push(e.role + '@' + e.at + ' ' + e.sound + ' ' + p.map(x => x.gain));
      }
      return { n: ev.length, bad };
    })()`);
    check('samples: every main, soft and sub event starts its sample exactly at the scheduled time, at level × volume (soft quieter)', run.n >= 12 && run.bad.length === 0, JSON.stringify(run).slice(0, 300));
    const cuts = await js(`(() => {
      const ev = __metro.state.scheduled.filter(e => e.gain > 0), plays = __plays.slice(), bad = [];
      ev.slice(0, -1).forEach((e, i) => {
        const want = ev[i + 1].at + 0.005;
        if (Math.abs((e.cut || 0) - want) > 1e-9) bad.push(e.role + '@' + e.at + ' cut ' + e.cut);
        if (!__cuts.some(t => Math.abs(t - want) < 1e-9)) bad.push('no fade to 0 at ' + want);
        const p = plays.find(p => Math.abs(p.at - e.at) < 1e-9 && p.buffer && p.buffer.length > 4000);
        if (e.sound === 'sample' && (!p || Math.abs(p.stop - want) > 1e-9)) bad.push(e.role + '@' + e.at + ' stop ' + (p && p.stop));
      });
      return { n: ev.length, bad };
    })()`);
    check('samples: each click, sample or built-in, is cut where the next one starts (5 ms fade; a sample stops there)', cuts.n >= 12 && cuts.bad.length === 0, JSON.stringify(cuts).slice(0, 300));
    await js('Object.assign(__metro.state.levels, { accent: 1, main: 1, sub: 1 }); __metro.state.adv = __metro.normSetup({}); __metro.setBpm(100)');
    await click('[data-fk="metro-mode-simple"]');
    await key('Escape'); await waitFor('!__metro.state.open');

    // Re-picking replaces the copy (an AIFF now: Chromium can't decode it, the page reads it itself).
    await openSet();
    await choose('main', source('Clave.aiff', aiffBytes(0.2)));
    await checkSoon('samples: re-picking overwrites the role\'s copy (main.wav → main.aiff)', async () => stored() === 'main.aiff,sub.wav' && (await js('__metro.state.samples.main.name')) === 'Clave.aiff', stored);
    check('samples: uncompressed AIFF is read (0.2 s at 44.1 kHz, first samples exact)', await js('(() => { const b = __metro.samples.buffers.main, d = b.getChannelData(0); return b.sampleRate === 44100 && b.length === 8820 && Math.abs(d[0] + 16000 / 32768) < 1e-6 && Math.abs(d[1] + 15990 / 32768) < 1e-6; })()'),
      await js('(() => { const b = __metro.samples.buffers.main; return b && b.sampleRate + " " + b.length + " " + b.getChannelData(0)[0]; })()'));
    // Rejected files change nothing.
    const unchanged = async () => stored() === 'main.aiff,sub.wav' && await js('__metro.state.samples.main.name === "Clave.aiff" && __metro.samples.buffers.main.length === 8820 && document.querySelector(\'[data-fk="set-sound-main"]\').value === "custom"');
    await js('__toasts.length = 0');
    await choose('main', source('not-audio.mp3', Buffer.from('these are notes, not audio\n'.repeat(40))));
    await checkSoon('samples: a file that isn\'t audio is refused, the reason in a line under the rows', async () => (await refusal()) === '“not-audio.mp3” isn’t audio the metronome can play.', refusal);
    check('samples: … not as a toast, and the current sample stays', await unchanged() && (await js('__toasts.length')) === 0, stored());
    await js('document.querySelector(\'[data-fk="set-sound-msg"]\').scrollIntoView({ block: "center" })');
    await shot('metro-samples-refused');
    const huge = source('huge.wav', Buffer.concat([wavBytes(0.1), Buffer.alloc(MAX_BYTES)]));
    await choose('main', huge);
    await checkSoon('samples: a file over 5 MB is refused with its reason', async () => (await refusal()) === '“huge.wav” is larger than 5 MB.', refusal);
    check('samples: … before it is read, and the current sample stays', MAX_BYTES === 5 * 1024 * 1024 && fs.statSync(huge).size > MAX_BYTES && await unchanged() && (await js('__toasts.length')) === 0, stored());
    await choose('main', null);
    check('samples: cancelling the dialog changes nothing, quietly', await unchanged() && (await js('__toasts.length')) === 0);
    // Reset: back to the built-in sound, the copy deleted.
    await click('[data-fk="set-reset-main"]');
    await checkSoon('samples: Reset returns Main beat to its built-in sound and deletes the copy (and clears the refusal line)', async () => stored() === 'sub.wav' && await M('!s.samples.main && !m.samples.buffers.main && m.soundFor("normal").id === "click"') && !(await refusal())
      && await js('document.querySelector(\'[data-fk="set-sound-main"]\').value === "click" && !document.querySelector(\'[data-fk="set-file-main"]\')'), stored);

    // The shell side only takes a known role and operation; the page never names a path.
    const guards = [await shell.handle('pick', '../../etc/passwd'), await shell.handle('load', 'main/../../x'), await shell.handle('read', 'main'), await shell.handle('save', 'main')];
    check('samples: the shell refuses unknown roles and operations, and a save without a pick', guards.map(g => g.error).join() === 'role,role,op,nothing' && dialogs.every(d => ['accent', 'main', 'sub'].includes(d.role)), JSON.stringify(guards));

    // The copy survives the original moving away.
    await choose('main', clickSrc);
    await waitFor(async () => stored() === 'main.wav,sub.wav');
    await closeSet();
    fs.rmSync(srcDir, { recursive: true, force: true });
    await reloadPage(); await instrument();
    const lost0 = await connectShell();
    check('samples: at launch the copies are decoded (the originals are gone), no toast', lost0.length === 0 && (await js('__toasts.length')) === 0 && await M('m.samples.buffers.main.length === 12000 && m.samples.buffers.sub instanceof AudioBuffer && m.soundFor("normal").id === "sample"'), JSON.stringify(lost0));

    // Missing or broken copies at launch: the built-in sound, one quiet toast, and the setting goes back.
    fs.rmSync(path.join(sdir, 'main.wav'));
    fs.writeFileSync(path.join(sdir, 'sub.wav'), 'not a wave');
    await reloadPage(); await instrument();
    const lost = await connectShell();
    check('samples: a missing and an unreadable copy at launch fall back to the built-in sounds', lost.join() === 'main,sub' && await M('m.soundFor("normal").id === "click" && m.soundFor("sub").id === "click" && Object.keys(s.samples).length === 0') && JSON.stringify((await metroStore()).samples) === '{}', JSON.stringify(lost));
    await waitFor('__toasts.length > 0');
    check('samples: … with one toast', (await js('__toasts.length')) === 1 && (await js('__toasts[0]')) === 'Couldn’t load the custom metronome sounds for Main beat and Subdivision; using the built-in ones.', await js('JSON.stringify(__toasts)'));
    check('samples: … and the broken copy is deleted', stored() === '', stored());
    await reloadPage(); await instrument();
    check('samples: the next launch is quiet', (await connectShell()).length === 0 && (await js('__toasts.length')) === 0);

    pumping = false; await Promise.race([pump, sleep(3000)]);
    await js('delete window.__sb');
    for (const d of [sdir, srcDir]) fs.rmSync(d, { recursive: true, force: true });
  }

  // the Dock / window icon, rendered the way the shell does it
  const { renderAccentIcon } = require('../src/accent-icon');
  const iconDir = path.join(OUT, 'icons');
  fs.rmSync(iconDir, { recursive: true, force: true });
  const ringPixel = (file) => { const img = nativeImage.createFromPath(file); const { width } = img.getSize(); const b = img.toBitmap(); const x = Math.round(width / 2), y = Math.round(width * 212 / 1024); const i = (y * width + x) * 4; return { size: width, rgb: [b[i + 2], b[i + 1], b[i]] }; };
  const orangeIcon = await renderAccentIcon('#FF7000', iconDir);
  const op = ringPixel(orangeIcon);
  check('the accent icon renders the LED ring in the accent (orange)', op.size === 1024 && op.rgb[0] > 200 && op.rgb[1] > 60 && op.rgb[1] < 170 && op.rgb[2] < 80, JSON.stringify(op));
  const pp = ringPixel(await renderAccentIcon('#6954ff', iconDir));
  check('the purple icon keeps the purple ring', pp.rgb[2] > 200 && pp.rgb[0] < 150, JSON.stringify(pp));
  const t0 = Date.now(); const again = await renderAccentIcon('#ff7000', iconDir);
  check('icons are cached per colour', again === orangeIcon && Date.now() - t0 < 100 && fs.readdirSync(iconDir).length === 2, fs.readdirSync(iconDir).join(','));

  // ---------------------------------------------------------------- expression pedal assignments
  // Bodies are the phone app's, byte for byte (trace 2026-10-09, docs/INVESTIGATION.md §10): preset 62 = index 0x3D.
  const expTx = async (n) => (await txSince(n)).filter(t => /^TX Save expression assignments/.test(t)).map(t => t.split(': ').pop());
  const expReads = async (n) => (await txSince(n)).filter(t => /^TX Expression assignments request/.test(t)).map(t => t.split(': ').pop());
  await js('state.presetDirty = false; render()'); await frame();
  await click('.preset-row[data-n="2"]'); await waitFor('state.selectedPreset === 2'); await settle();
  check('the chain has an EXP pill ahead of In', await js('(() => { const p = document.getElementById("expBtn").getBoundingClientRect(), o = document.querySelector(".chain-row .io").getBoundingClientRect(); return p.right < o.left && Math.abs((p.top + p.bottom) / 2 - (o.top + o.bottom) / 2) < 4; })()'));
  await checkSoon('the EXP pill counts preset 2\'s demo assignment', async () => (await js('document.getElementById("expCount").textContent')) === '1');
  n0 = await mark();
  await click('#expBtn');
  await waitFor(async () => (await expReads(n0)).length > 0); await settle();
  check('opening the Expression panel reads the set (60 {1:3 3:1})', (await expReads(n0)).some(h => h === '08 C0 08 03 18 01 3C 00 00 00'), JSON.stringify(await expReads(n0)));
  await waitFor('!!document.querySelector(\'[data-fk="exp-row-range-gain"]\')');
  check('the Expression panel opens in the inspector', (await js('document.querySelector(".insp-head h1").textContent')) === 'Expression pedal' && await js('document.getElementById("expBtn").classList.contains("selected")'));
  check('the panel names the preset', (await js('document.querySelector(".exp-preset").textContent')) === 'Preset 2 \u00b7 JP2C Lead');
  check('the demo Gain sweep is listed with Heel 0% / Toe 100% and its capture', await js('(() => { const r = document.querySelector(\'[data-fk="exp-row-range-gain"]\'); return !!r && r.querySelector(".exp-name").textContent === "Gain" && r.querySelector(".exp-sub").textContent === state.currentCapture.name && document.querySelector(\'[data-fk="exp-heel-gain"] .val\').textContent === "0%" && document.querySelector(\'[data-fk="exp-toe-gain"] .val\').textContent === "100%"; })()'));
  await shot('17-expression');
  check('the Expression row fits the inspector', await js('(() => { const i = document.getElementById("inspector"); return i.scrollWidth <= i.clientWidth + 1; })()'));

  // switching presets re-reads (preset 62 is empty in the demo)
  n0 = await mark();
  await click('.preset-row[data-n="62"]');
  await waitFor(async () => (await expReads(n0)).includes('08 C0 08 03 18 3D 3C 00 00 00')); await settle();
  await waitFor('!!document.querySelector(\'[data-fk="exp-empty"]\')');
  check('switching presets re-reads the assignments (60 {1:3 3:61})', (await expReads(n0)).includes('08 C0 08 03 18 3D 3C 00 00 00'), JSON.stringify(await expReads(n0)));
  check('an empty set shows the empty state', (await js('document.querySelector(\'[data-fk="exp-empty"]\')?.textContent || ""')) === 'No expression assignments. Plug an expression pedal into EXP/MIDI and assign a knob here.');
  check('the panel stays open across the switch', (await js('document.querySelector(".insp-head h1").textContent')) === 'Expression pedal');
  check('the EXP pill count is gone on an empty preset', await js('document.getElementById("expCount").hidden'));
  check('nothing marked dirty yet', await js('document.getElementById("dirtyMark").hidden'));

  const addTarget = async (name) => {
    await click('[data-fk="exp-add"]');
    const i = await waitFor(async () => { const k = await js(`[...document.querySelectorAll('.pop-item')].findIndex(e => e.textContent.startsWith(${JSON.stringify(name)}))`); return k >= 0 ? k + 1 : 0; }) - 1;
    if (i < 0) throw new Error('no Expression target ' + name);
    await click(`.pop-item[data-i="${i}"]`);
  };
  // Every expression edit sends one 62 with the whole set; wait for it and for the writes to settle.
  const expWait = async (n) => { await waitFor(async () => (await expTx(n)).length > 0); await settle(); return expTx(n); };
  n0 = await mark();
  await addTarget('Gain');
  await expWait(n0);
  check('adding a Gain sweep sends exactly the app\'s 62 (gain 0–255)', JSON.stringify(await expTx(n0)) === JSON.stringify(['0F C0 18 3D 22 07 08 00 10 00 18 FF 01 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  await checkSoon('an expression edit marks the preset dirty', '!document.getElementById("dirtyMark").hidden');
  await checkSoon('the demo pedal answers 115 dirty', 'state.presetDirty === true');
  n0 = await mark();
  await addTarget('Bass');
  await expWait(n0);
  check('adding Bass sends the whole set again (gain + bass)', JSON.stringify(await expTx(n0)) === JSON.stringify(['18 C0 18 3D 22 07 08 00 10 00 18 FF 01 2A 07 08 00 10 00 18 FF 01 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  n0 = await mark();
  await drag('[data-fk="exp-toe-bass"] svg', -40);
  const dragTx = await expWait(n0);
  check('dragging a range knob sends one 62 when released', dragTx.length === 1 && /2A 07 08 00 10 00 18 [0-9A-F]{2} /.test(dragTx[0]) && !/2A 07 08 00 10 00 18 FF 01/.test(dragTx[0]), JSON.stringify(dragTx));
  check('the Toe value follows the drag', (await js('state.exp.ranges.bass.max')) < 100, String(await js('state.exp.ranges.bass.max')));
  n0 = await mark();
  await click('[data-fk="exp-invert-range-bass"]');
  await expWait(n0);
  check('Invert sets field 1 of the range', /2A 07 08 01 10 00 18 /.test((await expTx(n0)).pop() || ''), JSON.stringify(await expTx(n0)));
  n0 = await mark();
  await click('[data-fk="exp-target-range-bass"]'); await waitFor('[...document.querySelectorAll(".pop-item")].some(e => e.textContent === "Mid")');
  { const i = await js('[...document.querySelectorAll(".pop-item")].findIndex(e => e.textContent === "Mid")'); await click(`.pop-item[data-i="${i}"]`); }
  await expWait(n0);
  check('the target menu moves the row to Mid, keeping its settings', /^.. C0 18 3D 22 07 08 00 10 00 18 FF 01 32 07 08 01 10 00 18 /.test((await expTx(n0)).pop() || '') && JSON.stringify(await js('__exp.assigned()')) === JSON.stringify(['range-gain', 'range-mid']), JSON.stringify(await expTx(n0)));
  n0 = await mark();
  await addTarget('Capture volume');
  await expWait(n0);
  check('Capture volume shows dB (heel −24.0 dB, toe +12.0 dB)', (await js('document.querySelector(\'[data-fk="exp-heel-level"] .val\').textContent')) === '-24.0 dB' && (await js('document.querySelector(\'[data-fk="exp-toe-level"] .val\').textContent')) === '+12.0 dB');
  check('Capture volume is field 13', /6A 07 08 00 10 00 18 FF 01 3E 00 00 00$/.test((await expTx(n0)).pop() || ''), JSON.stringify(await expTx(n0)));
  await click('[data-fk="exp-remove-range-level"]');
  await click('[data-fk="exp-remove-range-mid"]');
  await addTarget('Bass');
  n0 = await mark();
  await click('[data-fk="exp-remove-range-bass"]');
  await expWait(n0);
  check('Remove sends the set without it', JSON.stringify(await expTx(n0)) === JSON.stringify(['0F C0 18 3D 22 07 08 00 10 00 18 FF 01 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  n0 = await mark();
  await click('[data-fk="exp-clear"]');
  await expWait(n0);
  check('Clear all sends the bare preset index (62 {3:61})', JSON.stringify(await expTx(n0)) === JSON.stringify(['06 C0 18 3D 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  await checkSoon('after Clear all the empty state is back', '!!document.querySelector(\'[data-fk="exp-empty"]\')');
  await checkSoon('a cleared set reports the preset clean again (115)', 'state.presetDirty === false');
  await checkSoon('reverting the expression edits clears the UI dirty state', '!!document.getElementById("dirtyMark").hidden && !!document.getElementById("discardBtn").hidden && !state.presetDirty');
  const revertedPreset = await js('state.selectedPreset');
  await click(`.preset-row[data-n="${revertedPreset + 1}"]`);
  await checkSoon('switching after reverting does not ask for confirmation', async () => (await js('state.selectedPreset')) === revertedPreset + 1 && await js('!document.querySelector(".modal")'));
  await click(`.preset-row[data-n="${revertedPreset}"]`);
  await checkSoon('returning after the clean switch restores the preset', async () => (await js('state.selectedPreset')) === revertedPreset);
  await settle();

  n0 = await mark();
  await addTarget('Capture on/off');
  await expWait(n0);
  check('a Capture bypass defaults to heel-toe 600 ms, as the app sends it', JSON.stringify(await expTx(n0)) === JSON.stringify(['0F C0 18 3D 72 07 0A 05 08 00 10 D8 04 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  await click('[data-fk="exp-remove-bypass-capture"]');
  n0 = await mark();
  await addTarget('Pre FX 2 on/off');
  await click('[data-fk="exp-mode-pre2-switch"]');
  await waitFor(async () => (await expTx(n0)).pop() === '0F C0 18 3D 8A 01 06 12 04 08 00 10 00 3E 00 00 00'); await settle();
  check('Pre FX 2 bypass as a switch sends latch off', (await expTx(n0)).pop() === '0F C0 18 3D 8A 01 06 12 04 08 00 10 00 3E 00 00 00', JSON.stringify(await expTx(n0)));
  n0 = await mark();
  await click('[data-fk="exp-latch-pre2"]');
  await expWait(n0);
  check('the Latch toggle sends the app\'s latch-on body', JSON.stringify(await expTx(n0)) === JSON.stringify(['0F C0 18 3D 8A 01 06 12 04 08 00 10 01 3E 00 00 00']), JSON.stringify(await expTx(n0)));
  await checkSoon('the Latch switch shows On', async () => (await js('document.querySelector(\'[data-fk="exp-latch-pre2"]\').getAttribute("aria-checked")')) === 'true');
  await shot('18-expression-switch');
  await key('b');
  check('B on the Expression panel does nothing (no stage to bypass)', (await js('document.querySelector(".insp-head h1").textContent')) === 'Expression pedal');

  // the demo pedal keeps the set per preset until a reload drops unsaved edits
  await js('state.presetDirty = false; render()'); await frame(); await settle();
  await click('.preset-row[data-n="2"]');
  await checkSoon('preset 2 still has its own Gain sweep', async () => JSON.stringify(await js('__exp.assigned()')) === JSON.stringify(['range-gain']), async () => JSON.stringify(await js('__exp.assigned()')));
  await settle();
  await key('1');
  check('1 leaves the Expression panel for the Gate', (await js('document.querySelector(".insp-head h1").textContent')) === 'Gate');
  n0 = await mark();
  await key('e');
  await waitFor(async () => (await expReads(n0)).length > 0); await settle();
  check('E opens the Expression panel and reads the set', (await js('document.querySelector(".insp-head h1").textContent')) === 'Expression pedal' && (await expReads(n0)).length === 1, JSON.stringify(await expReads(n0)));
  await key('4');
  // ---------------------------------------------------------------- Settings → Device, capture info
  // Bodies from the phone-app trace 2026-10-09 (docs/INVESTIGATION.md §11).
  const BRIGHT_153 = '0E C0 08 01 20 99 01 75 00 00 C0 C0 43 00 00 00';   // 67 {1:1 4:153 14:-6.0}
  const MUTE_INPUT_ON = '08 C0 08 01 60 01 43 00 00 00';                    // 67 {1:1 12:1} → 66.15
  const MUTE_OUTPUT_ON = '08 C0 08 01 68 01 43 00 00 00';                   // 67 {1:1 13:1} → 66.16
  const val = (fk) => js(`document.querySelector('[data-fk="${fk}"]')?.textContent || ''`);
  await js('document.activeElement.blur()');
  n0 = await mark();
  await click('#settingsBtn'); await waitFor(settingsOpen);
  check('Settings has General, Device and About tabs, General first', (await js('[...document.querySelectorAll(".settings-tabs [role=tab]")].map(b => b.textContent + (b.classList.contains("on") ? "*" : "")).join("|")')) === 'General*|Device|About');
  await settle();
  check('nothing is read from the pedal before the Device tab opens', (await txSince(n0)).length === 0);
  await click('[data-fk="set-tab-device"]');
  let sent = await txWait(n0, tx => tx.some(t => /^TX Read device settings/.test(t)) && tx.some(t => /^TX Read device info/.test(t)));
  check('opening the Device tab reads the settings (65) and the device info (46 with the clock)', sent.some(t => /^TX Read device settings: 06 C0 08 03 41 00 00 00$/.test(t)) && sent.some(t => /^TX Read device info: 0C C0 08 03 18( [0-9A-F]{2}){5} 2E 00 00 00$/.test(t)), JSON.stringify(sent));
  check('the General sections are hidden on the Device tab', await js('document.querySelector(".settings").hidden && !document.querySelector(".dev-page").hidden'));
  await checkSoon('Device: About shows the name, firmware (from the keep-alive 92) and serial', async () => (await val('dev-name')) === 'Neural DSP Nano Cortex' && (await val('dev-firmware')) === '2.2.1+demo' && (await val('dev-serial')) === 'NP00XXXXXX', async () => [await val('dev-name'), await val('dev-firmware'), await val('dev-serial')].join(' / '));
  check('Device: the hash is shortened, the full one in the tooltip', /^[0-9a-f]{8}…[0-9a-f]{6}$/.test(await val('dev-hash')) && (await js('document.querySelector(\'[data-fk="dev-hash"]\').title.length')) === 40);
  await checkSoon('Device: LED brightness reads 153 = 60 %, USB playback −6.0 dB', () => js('document.querySelector(\'[data-fk="dev-brightness"]\').value === "153" && document.querySelector(\'[data-fk="dev-brightness"]\').nextElementSibling.textContent === "60%" && document.querySelector(\'[data-fk="dev-usb-num"]\').value === "-6.0"'));
  check('Device: Raw settings is collapsed and lists the 66 fields', await js('(() => { const d = document.querySelector(\'[data-fk="dev-raw"]\'); return !d.open && /6=153/.test(d.textContent) && /17=-6(?![\\d.])/.test(d.textContent) && /13=129/.test(d.textContent); })()'), await js('document.querySelector(\'[data-fk="dev-raw"]\').textContent'));
  check('Device: no stray text above About', (await js('document.querySelector(".dev-page").firstChild.tagName')) === 'SECTION');
  check('Device: monitoring readback starts unmuted', await js('__dev.settings.muteInput === false && __dev.settings.muteOutput === false && document.querySelector(\'[data-fk="dev-mute-input"]\').getAttribute("aria-checked") === "false" && document.querySelector(\'[data-fk="dev-mute-output"]\').getAttribute("aria-checked") === "false"'));
  check('Device: brightness, USB volume and monitoring switches are editable', (await js('document.querySelectorAll(".dev-page input").length')) === 3 && await js('document.querySelectorAll(".dev-page [role=switch]").length === 2 && document.querySelector(\'[data-fk="dev-mute-input"]\').textContent === "Mute Input" && document.querySelector(\'[data-fk="dev-mute-output"]\').textContent === "Mute Outputs 1L/2R"'));
  await shot('xx-device');
  // brightness by keyboard: one step up and back to 153
  await js('document.querySelector(\'[data-fk="dev-brightness"]\').focus()');
  n0 = await mark();
  await key('Right'); await waitFor(async () => (await txSince(n0)).length >= 1);
  await key('Left');
  sent = await txWait(n0, tx => /LED brightness 153/.test(tx[tx.length - 1] || ''));
  check('LED brightness 154 is sent with the USB volume (67 {4:154 14:-6.0})', /: 0E C0 08 01 20 9A 01 75 00 00 C0 C0 43 00 00 00$/.test(sent[0] || ''), JSON.stringify(sent));
  check('moving LED brightness to 153 sends exactly 08 01 20 99 01 75 00 00 C0 C0', (sent[sent.length - 1] || '').endsWith(': ' + BRIGHT_153) && /LED brightness 153/.test(sent[sent.length - 1]), JSON.stringify(sent));
  check('the % follows the slider', (await js('document.querySelector(\'[data-fk="dev-brightness"]\').nextElementSibling.textContent')) === '60%');
  // USB volume: typed
  n0 = await mark();
  await click('[data-fk="dev-usb-num"]');
  await key('a', [MOD]); await type('-8.2'); await key('Return');
  sent = await txWait(n0);
  await waitFor('document.querySelector(\'[data-fk="dev-usb-num"]\').value === "-8.0"');
  check('typing −8.2 dB rounds to the 0.5 dB step and sends −8.0 (f32 00 00 00 C1)', sent.length === 1 && sent[0].endsWith(': 0E C0 08 01 20 99 01 75 00 00 00 C1 43 00 00 00') && (await js('document.querySelector(\'[data-fk="dev-usb-num"]\').value')) === '-8.0', JSON.stringify(sent));
  check('Enter in the dB field doesn\'t close Settings', await settingsOpen());
  n0 = await mark();
  await key('a', [MOD]); await type('-6'); await key('Return');
  sent = await txWait(n0);
  check('USB playback −6.0 dB sends exactly 08 01 20 99 01 75 00 00 C0 C0', sent.length === 1 && sent[0].endsWith(': ' + BRIGHT_153), JSON.stringify(sent));
  await checkSoon('the slider follows the typed value', async () => (await js('document.querySelector(\'[data-fk="dev-usb"]\').value')) === '-6');
  n0 = await mark();
  await js('{ const r = document.querySelector(\'[data-fk="dev-usb"]\'); for (let i = 1; i <= 10; i++) { r.value = String(-6 - i * 0.5); r.dispatchEvent(new Event("input")); } }');
  sent = await txWait(n0, tx => tx.some(t => t.includes('USB playback -11.0 dB')));
  check('dragging the USB slider coalesces the writes, the last value wins', sent.length >= 1 && sent.length <= 3 && sent[sent.length - 1].includes('USB playback -11.0 dB'), JSON.stringify(sent));
  await checkSoon('the pedal acknowledged every write (68)', async () => (await js('__ui.logs.filter(l => /Device settings confirmed/.test(l.text)).length')) >= 4);
  // read again: the (demo) pedal reports what was written
  n0 = await mark();
  await click('[data-fk="dev-read"]');
  sent = await txWait(n0, tx => tx.length >= 3);
  check('Read again re-sends 65, 46 and the keep-alive 91', sent.length === 3 && /Read device settings/.test(sent[0]) && /Read device info/.test(sent[1]) && /Keep-alive: 06 C0 08 03 5B 00 00 00$/.test(sent[2]), JSON.stringify(sent));
  await checkSoon('the read-back shows the stored values (153, −11.0 dB)', () => js('document.querySelector(\'[data-fk="dev-brightness"]\').value === "153" && document.querySelector(\'[data-fk="dev-usb-num"]\').value === "-11.0"'));

  // Monitoring: one-field writes, ACK-triggered readback, external updates and rapid stale reports.
  await js('state.presetDirty = false; render()'); await frame();
  n0 = await mark();
  await click('[data-fk="dev-mute-input"]');
  sent = await txWait(n0, tx => tx.some(t => t.endsWith(': ' + MUTE_INPUT_ON)));
  check('Mute Input writes only field 12 with an explicit 1', sent.some(t => t.endsWith(': ' + MUTE_INPUT_ON)) && sent.some(t => /^TX Device monitoring: Mute Input ON/.test(t)), JSON.stringify(sent));
  check('Mute Input ACK is logged and does not dirty the preset', await js('__ui.logs.some(l => /Device settings confirmed/.test(l.text)) && state.presetDirty === false'), await js('JSON.stringify({ dirty: state.presetDirty, value: __dev.settings.muteInput })'));
  await checkSoon('Mute Input readback updates the switch', () => js('__dev.settings.muteInput === true && document.querySelector(\'[data-fk="dev-mute-input"]\').getAttribute("aria-checked") === "true"'));
  n0 = await mark();
  await click('[data-fk="dev-mute-output"]');
  sent = await txWait(n0, tx => tx.some(t => t.endsWith(': ' + MUTE_OUTPUT_ON)));
  check('Mute Outputs 1L/2R writes only field 13 with an explicit 1', sent.some(t => t.endsWith(': ' + MUTE_OUTPUT_ON)) && sent.some(t => /^TX Device monitoring: Mute Outputs 1L\/2R ON/.test(t)), JSON.stringify(sent));
  await checkSoon('Mute Outputs 1L/2R readback updates the switch without dirty state', () => js('__dev.settings.muteOutput === true && document.querySelector(\'[data-fk="dev-mute-output"]\').getAttribute("aria-checked") === "true" && state.presetDirty === false'));
  n0 = await mark();
  await click('[data-fk="dev-mute-output"]');
  sent = await txWait(n0, tx => tx.some(t => t.endsWith(': 08 C0 08 01 68 00 43 00 00 00')));
  check('Mute Outputs 1L/2R writes an explicit 0 when turned off', sent.some(t => t.endsWith(': 08 C0 08 01 68 00 43 00 00 00')), JSON.stringify(sent));

  // An unsolicited type-66 report is authoritative when no local write is pending.
  await js('__devDemo.store.muteInput = false; __devDemo.store.muteOutput = false; __devDemo.emitSettings(); 0');
  await checkSoon('external monitoring updates apply to both switches', () => js('__dev.settings.muteInput === false && __dev.settings.muteOutput === false && document.querySelector(\'[data-fk="dev-mute-input"]\').getAttribute("aria-checked") === "false" && document.querySelector(\'[data-fk="dev-mute-output"]\').getAttribute("aria-checked") === "false"'));

  // Two clicks and an older incoming report occur synchronously; the stale report must not block or undo the latest click.
  n0 = await mark();
  await js('(() => { const b = document.querySelector(\'[data-fk="dev-mute-input"]\'); b.click(); __devDemo.store.muteInput = false; __devDemo.emitSettings(); document.querySelector(\'[data-fk="dev-mute-input"]\').click(); })()');
  sent = await txWait(n0, tx => tx.filter(t => /^TX Device monitoring: Mute Input /.test(t)).length >= 2);
  check('rapid Mute Input toggles stay responsive and preserve the latest value', sent.filter(t => /^TX Device monitoring: Mute Input /.test(t)).length === 2 && sent.some(t => t.endsWith(': ' + MUTE_INPUT_ON)) && sent.some(t => t.endsWith(': 08 C0 08 01 60 00 43 00 00 00')) && await js('__dev.settings.muteInput === false && document.querySelector(\'[data-fk="dev-mute-input"]\').getAttribute("aria-checked") === "false"'), JSON.stringify(sent));

  await click('[data-fk="dev-usb-num"]');
  n0 = await txCount();
  await key('a', [MOD]); await type('-6'); await key('Return'); await txWait(n0);
  await key('Escape');
  await checkSoon('Esc closes Settings from the Device tab', async () => !(await settingsOpen()));
  await js('__openSettings("device"); 0');
  await checkSoon('Settings can open straight on the Device tab', () => js('document.querySelector(\'[data-fk="set-tab-device"]\').classList.contains("on") && !!document.querySelector(".dev-page:not([hidden])")'));
  await key('Escape'); await waitFor(async () => !(await settingsOpen())); await settle();

  // ---------------------------------------------------------------- outside links: support, About, manual
  // Every one opens in the default browser: no shell bridge here, so the page calls window.open, which the
  // handler in this file records and denies (the app's handler gives it to shell.openExternal).
  check('the links file matches package.json\'s version', LINKS.version === require('../package.json').version, LINKS.version);
  check('"♥ Support" sits at the right end of the status bar, after Activity', await js('(() => { const b = document.getElementById("supportBtn"); return !!b && b.textContent === "\u2665 Support" && b.previousElementSibling.id === "drawerBtn" && !b.nextElementSibling && b.title === "Support the project on Buy Me a Coffee (opens your browser)"; })()'));
  check('"♥ Support" is styled like the other status-bar buttons (no accent, no fill)', await js(`(() => {
    const s = getComputedStyle(document.getElementById("supportBtn")), k = getComputedStyle(document.getElementById("keysBtn"));
    const acc = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
    return s.color === k.color && s.backgroundColor === k.backgroundColor && s.fontWeight === k.fontWeight && s.fontSize === k.fontSize && !s.color.includes(acc) && s.backgroundColor === "rgba(0, 0, 0, 0)"; })()`), await js('JSON.stringify([getComputedStyle(document.getElementById("supportBtn")).color, getComputedStyle(document.getElementById("supportBtn")).backgroundColor])'));
  opened.length = 0;
  n0 = await mark();
  await click('#supportBtn');
  await checkSoon('clicking "♥ Support" opens exactly the Buy Me a Coffee link, outside the app', () => opened.length === 1 && opened[0] === LINKS.support, () => JSON.stringify(opened));
  check('Support sends nothing to the pedal and changes nothing on screen', (await txSince(n0)).length === 0 && await js('!document.querySelector(".modal-bg") && !document.querySelector(".pop")') && BrowserWindow.getAllWindows().length === 1);
  await js('__openSettings("about"); 0');
  await waitFor('!!document.querySelector(\'[data-fk="about-page"]:not([hidden])\')');
  check('Settings → About shows the name and version', (await js('document.querySelector(".about-name")?.textContent')) === 'Nano Cortex Editor ' + LINKS.version && (await js('document.querySelector(\'[data-fk="about-version"]\').textContent')) === LINKS.version);
  check('Settings → About says who made it and carries the trademark note and licence', /Made by AJs Creations/.test(await js('document.querySelector(".about-page").textContent')) && /not affiliated with or endorsed by Neural DSP/.test(await val('about-trademark')) && /MIT/.test(await val('about-license')));
  const aboutLinks = await js('[...document.querySelectorAll(".about-links a")].map(a => a.textContent + "|" + a.href)');
  check('Settings → About links: repository, manual, native edition, Buy me a coffee', JSON.stringify(aboutLinks) === JSON.stringify(['GitHub repository|' + LINKS.repo, 'Manual|' + LINKS.manual, 'Native macOS edition|' + LINKS.mac, 'Buy me a coffee|' + LINKS.support]), JSON.stringify(aboutLinks));
  await shot('xx-settings-about');
  opened.length = 0;
  await click('[data-fk="about-support"]');
  await checkSoon('About → Buy me a coffee opens the link outside the app (Settings stays open)', async () => opened.length === 1 && opened[0] === LINKS.support && await settingsOpen(), () => JSON.stringify(opened));
  opened.length = 0;
  await click('[data-fk="about-manual"]');
  await checkSoon('About → Manual opens the manual', () => opened[0] === LINKS.manual, () => JSON.stringify(opened));
  await key('Escape'); await waitFor(async () => !(await settingsOpen())); await settle();

  // capture info from the slot grid and the chain node
  await click('[data-fk="node-capture"]');
  await rightClick('[data-fk="capslot-1"]');
  check('the capture slot menu offers Info…', await js(ctxItem('Info') + ' && !' + ctxItem('Info') + '.disabled'));
  n0 = await mark();
  await js(ctxItem('Info') + '.click()');
  sent = await txWait(n0);
  check('Info… on slot 1 sends 17 {3:0 5:1} (08 C0 18 00 28 01 11 00 00 00)', sent.length === 1 && sent[0].endsWith(': 08 C0 18 00 28 01 11 00 00 00'), JSON.stringify(sent));
  await waitFor('!!document.querySelector(\'[data-fk="cap-author"]\') && !!document.querySelector(\'[data-fk="cap-tags"] .chip\')');
  await stable('JSON.stringify(document.querySelector(".pop.cap-info")?.getBoundingClientRect())');
  check('capture info is a popover by the slot: Capture 1A, name, author and kind icons', await js('(() => { const p = document.querySelector(".pop.cap-info"), a = document.querySelector(\'[data-fk="capslot-1"]\').getBoundingClientRect(), r = p && p.getBoundingClientRect(); return !!p && p.querySelector(".cap-eyebrow").textContent === "Capture 1A" && p.querySelector(".cap-name").textContent === "Silver Jubilee Ch1" && Math.abs(r.top - a.bottom - 6) < 2; })()') && (await val('cap-author')) === 'by Neural DSP' && await js('!!document.querySelector(\'[data-fk="cap-type"] .kind\') && !!document.querySelector(\'[data-fk="cap-instrument"] .kind\')'), (await val('cap-author')) + ' / ' + (await js('document.querySelector(".cap-kinds")?.textContent')));
  check('capture info shows the tags as chips', (await js('[...document.querySelectorAll(\'[data-fk="cap-tags"] .chip\')].map(c => c.textContent).join(",")')) === 'Marshall,Jubilee,Crunch');
  check('capture info shows the description and the full hash', /slot 1/.test(await val('cap-desc')) && /^[0-9a-f]{8}…[0-9a-f]{6}$/.test(await val('cap-hash')) && (await js('document.querySelector(\'[data-fk="cap-hash"]\').title.length')) === 64 && await js('!!document.querySelector(\'[data-fk="cap-copy"]\')'));
  await shot('xx-capture-info');
  await key('Escape');
  await checkSoon('Esc closes capture info', '!document.querySelector(".cap-info")');
  // Slot 2 answers "null" for its description, as a real pedal does for a capture without one: nothing is shown.
  await rightClick('[data-fk="capslot-2"]');
  await js(ctxItem('Info') + '.click()');
  await waitFor('!!document.querySelector(\'[data-fk="cap-author"]\') && !!document.querySelector(\'[data-fk="cap-tags"] .chip\')');
  check('a capture whose description is "null" shows no description (no empty paragraph either)', await js('!document.querySelector(\'[data-fk="cap-desc"]\') && ![...document.querySelectorAll(".cap-info p")].some(p => /null/i.test(p.textContent) || !p.textContent.trim()) && !/null/i.test(document.querySelector(".cap-info").textContent)'), await js('document.querySelector(".cap-info")?.textContent'));
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")');
  // Slot 4 answers an empty description, like the traced pedal reply: no "null" either (the panel used to make one).
  await rightClick('[data-fk="capslot-4"]');
  await js(ctxItem('Info') + '.click()');
  await waitFor('!!document.querySelector(\'[data-fk="cap-author"]\') && !!document.querySelector(\'[data-fk="cap-tags"] .chip\')');
  check('a capture with an empty description shows no description and no stray "null"', await js('!document.querySelector(\'[data-fk="cap-desc"]\') && !/null/i.test(document.querySelector(".cap-info").textContent) && [...document.querySelector(".cap-body").childNodes].every(n => n.nodeType === 1)'), await js('document.querySelector(".cap-info")?.textContent'));
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")');
  // Slot 5's description is just a Cortex Cloud product ID, as some captures on a real pedal have ("Darkglass
  // MT900V2 1", 2026-10-24). No bare ID is shown; in the desktop app "Open in Cortex Cloud" takes its place.
  const DEMO_CLOUD_ID = '5d3e0c10-0d00-4a11-8c55-0000000000a5';
  const openInfo = async (slot) => {
    await rightClick(`[data-fk="capslot-${slot}"]`);
    await js(ctxItem('Info') + '.click()');
    await waitFor('!!document.querySelector(\'[data-fk="cap-author"]\') && !!document.querySelector(\'[data-fk="cap-tags"] .chip\')');
    await stable('JSON.stringify(document.querySelector(".pop.cap-info")?.getBoundingClientRect())');
  };
  const cloudOf = (v) => js(`NanoText.captureCloudId(${JSON.stringify(v)})`);
  const NT = require('../pro/capture-text');
  check('captureCloudId: the whole (trimmed) description must be one UUID; returned in lowercase',
    (await cloudOf(' 4CD7F0D5-B0E2-4C8C-AA79-A9B856D71CF5 ')) === '4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5' && (await cloudOf('4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5')) === '4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5'
    && (await cloudOf('See 4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5')) === null && (await cloudOf('4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5 4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5')) === null
    && (await cloudOf('4cd7f0d5b0e24c8caa79a9b856d71cf5')) === null && (await cloudOf('4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf')) === null && (await cloudOf('zcd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5')) === null
    && (await cloudOf('')) === null && (await cloudOf(null)) === null && (await cloudOf('null')) === null && NT.captureCloudId('4CD7F0D5-B0E2-4C8C-AA79-A9B856D71CF5') === '4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5');
  const shownOf = (v) => js(`NanoText.captureDescription(${JSON.stringify(v)})`);
  check('a description that is a bare Cloud ID counts as no description (shown, searched); a real text with an ID in it is kept',
    (await shownOf(' 4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5 ')) === '' && (await shownOf('From 4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5')) === 'From 4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5' && NT.captureDescription('4CD7F0D5-B0E2-4C8C-AA79-A9B856D71CF5') === '');
  check('… but it is still stored and sent as it is: a capture record keeps its Cloud ID as field 5 (only "null" and blanks go out empty)', await js(`(() => { const m = { hash: 'ab', name: 'N', cloudUUID: 'u', authorId: 'a', authorName: 'b', deviceType: 'pedal', tags: [], instrumentType: 'guitar', version: '1' };
    return new TextDecoder().decode(Uint8Array.from(NanoTransfer.captureRecord({ ...m, description: '4CD7F0D5-B0E2-4C8C-AA79-A9B856D71CF5' }))).includes('4CD7F0D5-B0E2-4C8C-AA79-A9B856D71CF5'); })()`) && NT.storedDescription(' NULL ') === '' && NT.storedDescription('4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5') === '4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5');
  await openInfo(5);
  check('without the desktop shell (the web preview) a Cloud-ID description shows nothing: no ID, no button', await js(`!document.querySelector('[data-fk="cap-desc"]') && !document.querySelector('[data-fk="cap-cloud-link"]') && !/${DEMO_CLOUD_ID}/i.test(document.querySelector(".cap-info").textContent)`), await js('document.querySelector(".cap-info")?.textContent'));
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")');
  // The desktop app's opener (nanoShell.openCloudCapture → main), recorded here instead.
  await js('window.__cloudOpened = []; __setCloudCaptureOpener((id) => { __cloudOpened.push(id); return Promise.resolve(true); }); 0');
  await openInfo(5);
  const cloudBtn = await js(`(() => { const b = document.querySelector('[data-fk="cap-cloud-link"]'); if (!b) return null; const by = document.querySelector('[data-fk="cap-author"]').getBoundingClientRect();
    const r = document.createRange(); r.selectNodeContents(b); const t = r.getBoundingClientRect(), s = getComputedStyle(b);
    return { text: b.textContent, cls: b.className, tag: b.tagName, title: b.title, textLeft: Math.round(t.left), byLeft: Math.round(by.left), size: s.fontSize, bg: s.backgroundColor, color: s.color,
      dim: getComputedStyle(document.documentElement).getPropertyValue('--dim').trim(), panelText: document.querySelector('.cap-info').textContent, desc: !!document.querySelector('[data-fk="cap-desc"]'),
      afterTags: !!b.previousElementSibling && b.previousElementSibling.matches('[data-fk="cap-tags"]') }; })()`);
  check('a capture whose description is its Cloud ID: Info shows "Open in Cortex Cloud" where the description would be (a small ghost button, no ID)',
    !!cloudBtn && cloudBtn.text === 'Open in Cortex Cloud' && cloudBtn.tag === 'BUTTON' && /\bbtn\b/.test(cloudBtn.cls) && /\bghost\b/.test(cloudBtn.cls) && /\bsmall\b/.test(cloudBtn.cls) && !cloudBtn.desc && cloudBtn.afterTags
    && !new RegExp(DEMO_CLOUD_ID, 'i').test(cloudBtn.panelText) && cloudBtn.size === '12px' && cloudBtn.bg === 'rgba(0, 0, 0, 0)' && cloudBtn.title === 'Open this capture\u2019s page in the Cortex Cloud tab', JSON.stringify(cloudBtn));
  check('… link-style: its text lines up with "by …" above it', !!cloudBtn && Math.abs(cloudBtn.textLeft - cloudBtn.byLeft) <= 1, JSON.stringify(cloudBtn && [cloudBtn.textLeft, cloudBtn.byLeft]));
  await shot('xx-capture-info-cloud');
  {
    const r = await js('(() => { const b = document.querySelector(".pop.cap-info").getBoundingClientRect(); return { x: Math.floor(b.left) - 12, y: Math.floor(b.top) - 12, width: Math.ceil(b.width) + 24, height: Math.ceil(b.height) + 24 }; })()');
    fs.writeFileSync(path.join(OUT, 'xx-capture-info-cloud-panel.png'), (await wc.capturePage(r)).toPNG());
  }
  n0 = await mark();
  await click('[data-fk="cap-cloud-link"]');
  await checkSoon('clicking it asks the shell to open exactly that capture (lowercase ID) and closes Info', async () => JSON.stringify(await js('__cloudOpened')) === JSON.stringify([DEMO_CLOUD_ID]) && await js('!document.querySelector(".cap-info")'), async () => JSON.stringify(await js('__cloudOpened')));
  await settle();
  check('… and nothing is sent to the pedal', (await txSince(n0)).length === 0, JSON.stringify(await txSince(n0)));
  await openInfo(1);
  check('a capture with a real description keeps it and has no Cloud button', /slot 1/.test(await val('cap-desc')) && await js('!document.querySelector(\'[data-fk="cap-cloud-link"]\')'));
  {
    // The description comes from the reply (18.8), else from the capture record it carries (field 5), as in the native
    // edition: a Cloud ID in the record counts the same.
    const ID = '4cd7f0d5-b0e2-4c8c-aa79-a9b856d71cf5';
    const recBytes = [0x0A, 0x02, ...utf8('ab'), 0x12, 0x09, ...utf8('Darkglass'), 0x2A, 36, ...utf8(ID.toUpperCase())];
    const reply = (desc) => frameHex([0x08, 0x06, 0x18, 0x01, ...(desc === null ? [] : [0x42, utf8(desc).length, ...utf8(desc)]), 0x52, 0x09, ...utf8('Darkglass'), 0x5A, recBytes.length, ...recBytes], 18);
    const details = (h) => js(`(() => { let got = null; __dev.capWait = (i) => { got = i; }; const b = Uint8Array.from(${JSON.stringify(h)}.split(' ').map(x => parseInt(x, 16))); onC305({ target: { value: { buffer: b.buffer } } }); return got; })()`);
    const viaNull = await details(reply('null')), viaNone = await details(reply(null)), viaText = await details(reply('Tight and dry'));
    check('Info: 18.8 "null" or missing → the record\'s field 5; a Cloud ID there gives "Open in Cortex Cloud" too; a real 18.8 wins',
      !!viaNull && viaNull.description === '' && viaNull.cloudId === ID && !!viaNone && viaNone.cloudId === ID && !!viaText && viaText.description === 'Tight and dry' && viaText.cloudId === null,
      JSON.stringify([viaNull && [viaNull.description, viaNull.cloudId], viaNone && viaNone.cloudId, viaText && [viaText.description, viaText.cloudId]]));
  }
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")');
  await js('__setCloudCaptureOpener(null); delete window.__cloudOpened; 0');
  // Library rows (the Cab / IR inspector's list): a description that is only a Cloud ID is neither shown nor searched.
  await click('[data-fk="node-cab"]');
  await js(`state.library.irUser.push({ index: 99, name: 'Cloud ID IR', description: '${DEMO_CLOUD_ID.toUpperCase()}' }); render()`);
  const idRow = await waitFor(() => js(`(() => { const r = [...document.querySelectorAll('.cab-library-section .library-row')].find(x => x.textContent.includes('Cloud ID IR')); return r ? { search: r.dataset.search, text: r.textContent, title: r.title || '', titles: [...r.querySelectorAll('[title]')].map(e => e.title).join(' ') } : null; })()`));
  check('a library row whose description is a bare Cloud ID: no ID in its detail line, tooltip or search text', !!idRow && !new RegExp(DEMO_CLOUD_ID, 'i').test(idRow.search + ' ' + idRow.text + ' ' + idRow.title + ' ' + idRow.titles) && /cloud id ir/.test(idRow.search), JSON.stringify(idRow));
  await js(`state.library.irUser = state.library.irUser.filter(x => x.index !== 99); render()`); await frame();
  await click('[data-fk="node-capture"]');
  const descOf = (v) => js(`NanoText.captureDescription(${JSON.stringify(v)})`);
  check('a description of "null" (any case), blanks or nothing counts as none; real text is kept', (await descOf('null')) === '' && (await descOf(' NULL ')) === '' && (await descOf('Null')) === '' && (await descOf('   ')) === '' && (await descOf(null)) === '' && (await js('NanoText.captureDescription(undefined)')) === '' && (await descOf('Not null at all')) === 'Not null at all' && require('../pro/capture-text').captureDescription(' null ') === '');
  check('sending a capture never writes "null" as its description (field 5 goes out empty)', await js(`(() => { const m = { hash: 'ab', name: 'N', cloudUUID: 'u', authorId: 'a', authorName: 'b', deviceType: 'pedal', tags: [], instrumentType: 'guitar', version: '1' };
    const a = NanoTransfer.captureRecord({ ...m, description: 'null' }), b = NanoTransfer.captureRecord({ ...m, description: '' }), c = NanoTransfer.captureRecord({ ...m, description: 'Warm' });
    return JSON.stringify(a) === JSON.stringify(b) && !new TextDecoder().decode(Uint8Array.from(a)).includes('null') && new TextDecoder().decode(Uint8Array.from(c)).includes('Warm'); })()`));
  const curSlot = await js('state.capture.selectedSlot');
  await rightClick('[data-fk="node-capture"]');
  n0 = await mark();
  await js(ctxItem('Info') + '?.click()');
  sent = await txWait(n0);
  await waitFor('!!document.querySelector(".cap-info")');
  check('Info… on the capture node asks for the active slot', sent.length === 1 && sent[0].endsWith(': 08 C0 18 ' + (curSlot - 1).toString(16).toUpperCase().padStart(2, '0') + ' 28 01 11 00 00 00') && await js('!!document.querySelector(".cap-info")'), curSlot + ' ' + JSON.stringify(sent));
  await key('Escape'); await waitFor('!document.querySelector(".cap-info")');
  await js('state.capture.fromLibrary = true; render()'); await frame();
  await rightClick('[data-fk="node-capture"]');
  check('Info… is greyed out when the capture comes straight from the library', await js(ctxItem('Info') + '?.disabled === true'));
  await key('Escape'); await js('state.capture.fromLibrary = false; render()'); await frame();
  // the real pedal's long reply (flags C1: the length's ninth bit), copied from a recorded phone-app session
  // (factory capture "CA John's Ch1 1"; the 64-hex capture hash replaced by a synthetic one of the same length)
  const reply18 = { hex: '2E C1 08 06 18 01 3A 16 0A 09 4E 65 75 72 61 6C 44 53 50 12 09 4E 65 75 72 61 6C 44 53 50 42 00 4A 40 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 52 0F 43 41 20 4A 6F 68 6E 27 73 20 43 68 31 20 31 5A B6 01 0A 40 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 30 31 32 33 34 35 36 37 38 39 61 62 63 64 65 66 12 0F 43 41 20 4A 6F 68 6E 27 73 20 43 68 31 20 31 22 16 0A 09 4E 65 75 72 61 6C 44 53 50 12 09 4E 65 75 72 61 6C 44 53 50 32 08 61 6D 70 5F 68 65 61 64 3A 0A 4D 65 73 61 62 6F 6F 67 69 65 3A 04 4A 50 32 43 3A 04 4D 65 73 61 3A 06 42 6F 6F 67 69 65 3A 04 4A 6F 68 6E 3A 08 50 65 74 72 75 63 63 69 40 04 52 06 67 75 69 74 61 72 58 01 62 01 31 68 00 12 00 00 00' };
  const parsed = await js(`(() => { let got = null; __dev.capWait = (i) => { got = i; }; const b = Uint8Array.from(${JSON.stringify(reply18.hex)}.split(' ').map(h => parseInt(h, 16))); onC305({ target: { value: { buffer: b.buffer } } }); return got; })()`);
  check('the traced 18 reply parses: name, author, amp_head, guitar, tags', !!parsed && parsed.name === "CA John's Ch1 1" && parsed.author === 'NeuralDSP' && parsed.type === 'amp_head' && parsed.instrument === 'guitar' && parsed.tags.join(',') === 'Mesaboogie,JP2C,Mesa,Boogie,John,Petrucci' && parsed.hash === '0123456789abcdef'.repeat(4), JSON.stringify(parsed));
  // a type-66 settings reply from the same session (device name, LED brightness 153, USB −6 dB)
  const reply66 = { hex: '36 C0 08 01 18 01 2A 16 4E 65 75 72 61 6C 20 44 53 50 20 4E 61 6E 6F 20 43 6F 72 74 65 78 30 99 01 38 01 40 01 58 00 60 01 68 81 01 70 01 8D 01 00 00 C0 C0 42 00 00 00' };
  const devBefore = await js('JSON.stringify(__dev.settings)');
  await js(`(() => { const b = Uint8Array.from(${JSON.stringify(reply66.hex)}.split(' ').map(h => parseInt(h, 16))); onC305({ target: { value: { buffer: b.buffer } } }); })()`);
  check('the traced 66 reply parses: name, brightness 153, USB −6.0 dB', await js('__dev.settings.name === "Neural DSP Nano Cortex" && __dev.settings.brightness === 153 && __dev.settings.usbDb === -6'), await js('JSON.stringify(__dev.settings)'));
  await js(`__dev.settings = ${devBefore}`);

  // ---------------------------------------------------------------- developer tools: off again, live
  for (const f of fs.readdirSync(OUT)) if (/^nano-session-.*\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  await js('document.activeElement.blur()');
  await click('#recBtn');
  await key('l', [MOD]);
  check('(dev tools on) recording and the Activity drawer are running', await js('__rec.on && __ui.drawerOpen'));
  await key(',', [MOD]); await waitFor(settingsOpen);
  await click('[data-fk="set-devtools"]');
  check('turning Developer tools off stops the recording and closes the drawer', await js('!__rec.on && !__ui.drawerOpen && !document.getElementById("drawer").classList.contains("open")'));
  check('turning it off hides the Activity-at-launch row live', !(await shown('[data-fk="set-drawer"]')) && (await js('localStorage.getItem("settings.devTools")')) === 'false');
  await key('Escape'); await waitFor(async () => !(await settingsOpen()));
  check('turning it off hides Record, Activity and "Sent: …" at once', !(await shown('#recBtn')) && !(await shown('#drawerBtn')) && !/^Sent: /.test(await js('document.getElementById("lastAction").textContent')));
  const stopped = await waitFor(async () => fs.readdirSync(OUT).find(f => { if (!/^nano-session-.*\.json$/.test(f)) return false; try { JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')); return true; } catch { return false; } }));
  check('the stopped recording is saved, as clicking Record would', !!stopped, String(stopped));
  await js('document.activeElement.blur()');
  await key('l', [MOD]);
  check('⌘L does nothing again', await js('!__ui.drawerOpen'));
  await settle();

  // ---------------------------------------------------------------- unsaved-changes prompts: an edit still on its way counts
  // The pedal's 115 comes after an edit lands. An edit write queued or in flight, or sent < 300 ms ago without a 115
  // since, makes the switch prompt ask (the header's mark stays the pedal's).
  await js('state.presetDirty = false; __demo.hooks.quiet115 = true; render()'); await settle();
  check('an edit write that just went out counts as unsaved for the prompts, before any 115', await js('(() => { setAmpKnob("bass", 141); return __isDirtyForPrompt() && !state.presetDirty; })()'));
  await sleep(450);
  check('… and no longer once 300 ms pass without a 115 (the pedal says clean)', await js('!__isDirtyForPrompt() && !state.presetDirty'));
  await js('__demo.hooks.writeDelay = 1500'); await frame();
  const latencyFrom = await js('state.selectedPreset');
  const latencyTo = latencyFrom === 1 ? 2 : 1;
  await js('__ui.selected = "capture"; render()'); await frame();
  await click('[data-fk="amp-bass"] .label');
  n0 = await txCount();
  await key('Up');
  await click(`.preset-row[data-n="${latencyTo}"]`);
  await checkSoon('switching right after an edit (its write still in flight) asks "Save changes to …?"', '!!document.querySelector(".modal h2") && /^Save changes to /.test(document.querySelector(".modal h2").textContent)');
  await key('Escape');
  await checkSoon('… Escape keeps the preset', async () => (await js('state.selectedPreset')) === latencyFrom && await js('!document.querySelector(".modal")'));
  await js('__demo.hooks.writeDelay = 0; __demo.hooks.quiet115 = false; state.presetDirty = false; render()'); await settle();
  await waitFor('!__isDirtyForPrompt()');   // the held write has landed and its 300 ms are over

  // ---------------------------------------------------------------- preset reordering (143 → 144, then list and state read back)
  // Real mouse input: press on a row (its name, or with `grip` its ⋮⋮ grip), move in steps, release on another row.
  // The list is scrolled first so both rows are on screen and clear of the auto-scroll edges.
  const rowSel = (n, part = '') => `#presetList .preset-row[data-n="${n}"]${part ? ' ' + part : ''}`;
  const centreOf = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  async function dragRow(from, to, { grip = false, beforeUp = null } = {}) {
    const fit = await js(`(() => {
      const l = document.getElementById('presetList'), a = l.querySelector('.preset-row[data-n="${from}"]'), b = l.querySelector('.preset-row[data-n="${to}"]');
      if (!a || !b) return 'missing';
      const lb = l.getBoundingClientRect(), ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      l.scrollTop += (Math.min(ra.top, rb.top) + Math.max(ra.bottom, rb.bottom)) / 2 - (lb.top + lb.bottom) / 2;
      // Both rows whole on screen, and their centres (where the pointer goes) out of the auto-scroll edges unless the
      // list can't scroll that way anyway.
      const canUp = l.scrollTop > 0, canDown = l.scrollTop < l.scrollHeight - l.clientHeight - 1;
      const rows = [a, b].map(r => r.getBoundingClientRect());
      const ok = rows.every(r => r.top >= lb.top - 0.5 && r.bottom <= lb.bottom + 0.5 && (!canUp || r.top + r.height / 2 >= lb.top + 28) && (!canDown || r.top + r.height / 2 <= lb.bottom - 28));
      return ok ? 'ok' : 'too far apart for the list (' + Math.round(lb.height) + ' px)';
    })()`);
    if (fit !== 'ok') check('drag harness: rows ' + from + ' and ' + to + ' fit on screen together', false, fit);
    await frame();
    const a = await centreOf(rowSel(from, grip ? '.grip' : '.t')), b = await centreOf(rowSel(to, '.t'));
    wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y }); await frame();
    wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
    const steps = 10;
    for (let k = 1; k <= steps; k++) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + (b.x - a.x) * k / steps), y: Math.round(a.y + (b.y - a.y) * k / steps), button: 'left' });
      await sleep(12);
    }
    await frame();
    if (beforeUp) await beforeUp(b);
    wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(40); await frame();
  }
  // Text dragged in from elsewhere (an HTML5 drop, not a press on a row).
  const dropText = (to, text) => js(`(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(String(text))});
    const dst = document.querySelector('#presetList .preset-row[data-n="${to}"]');
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  })()`);
  const allNames = () => js('[...Array(64).keys()].map(i => state.presetNames.get(i + 1))');
  const namesBefore = await allNames();
  // A taller window for this section: the move back drags row 2 onto row 22 with the filter off, both on screen.
  win.setContentSize(1400, 1000);
  await waitFor('innerHeight === 1000'); await frame();
  await js('document.activeElement.blur()');
  await js('{ const f = document.getElementById("presetFilter"); f.value = ""; f.dispatchEvent(new Event("input")); f.blur(); }'); await frame();
  // The grip: ⋮⋮ on the row under the mouse only. Rows show the arrow; the open hand only over the grip.
  const gripInfo = (n) => js(`(() => {
    const r = document.querySelector('#presetList .preset-row[data-n="${n}"]'), g = r && r.querySelector('.grip'), s = g && g.querySelector('svg');
    if (!s) return null;
    const rb = r.getBoundingClientRect(), sb = s.getBoundingClientRect(), gb = g.getBoundingClientRect();
    return { vis: getComputedStyle(g).visibility, color: getComputedStyle(g).color, row: getComputedStyle(r).cursor, name: getComputedStyle(r.querySelector('.t')).cursor, grip: getComputedStyle(g).cursor,
      w: Math.round(sb.width), h: Math.round(sb.height), right: Math.round(rb.right - sb.right), dy: Math.round((sb.top + sb.bottom - rb.top - rb.bottom) / 2),
      hitW: Math.round(gb.width), hitH: Math.round(gb.height), hitRight: Math.round(rb.right - gb.right), nameRight: Math.round(rb.right - r.querySelector('.t').getBoundingClientRect().right) };
  })()`);
  await js(`document.getElementById('presetList').scrollTop = 0`); await frame();
  let pt = await centreOf(rowSel(3, '.t'));
  wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); await frame();
  let gr3 = await gripInfo(3), gr4 = await gripInfo(4);
  check('preset rows: the ⋮⋮ grip is hidden on a row the mouse is not over', gr4 && gr4.vis === 'hidden', JSON.stringify(gr4));
  check('preset rows: the grip shows on the row under the mouse: right end (8 px in), 6 × 10, centred, faint', gr3 && gr3.vis === 'visible' && gr3.w === 6 && gr3.h === 10 && gr3.right === 8 && Math.abs(gr3.dy) <= 1 && gr3.color === 'rgb(97, 97, 97)' && gr3.nameRight === 20, JSON.stringify(gr3));
  check('preset rows: a row shows the arrow cursor, not the pointing hand', gr3.row === 'default' && gr3.name === 'default', JSON.stringify(gr3));
  pt = await centreOf(rowSel(3, '.grip'));
  wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); await frame();
  gr3 = await gripInfo(3);
  check('preset rows: the grip shows the open hand (a 20 × 28 target to the row\'s edge) and brightens', gr3.grip === 'grab' && gr3.hitW === 20 && gr3.hitH === 28 && gr3.hitRight === 0 && gr3.color === 'rgb(171, 171, 171)' && (await js(`document.elementFromPoint(${pt.x}, ${pt.y}).closest('.grip') !== null`)), JSON.stringify(gr3));
  await shot('xx-preset-grip');
  pt = await centreOf(rowSel(3, '.t'));
  wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y }); await frame();
  await shot('xx-preset-grip-row');
  // While dragging: the closed hand everywhere, the source dimmed, a copy of the row under the pointer, the target outlined.
  n0 = await mark();
  let during = null;
  await dragRow(3, 6, { beforeUp: async (b) => {
    during = await js(`({ html: document.documentElement.classList.contains('preset-dragging'), under: getComputedStyle(document.elementFromPoint(${b.x}, ${b.y})).cursor,
      body: getComputedStyle(document.body).cursor, drag: __presetDrag(), ghost: !!document.querySelector('.preset-ghost .preset-row'),
      src: document.querySelector('#presetList .preset-row[data-n="3"]').classList.contains('dragging'), dst: document.querySelector('#presetList .preset-row[data-n="6"]').classList.contains('drop-target'),
      grips: [...document.querySelectorAll('#presetList .grip')].every(g => getComputedStyle(g).visibility === 'hidden') })`);
    await key('Escape');
  } });
  check('dragging a preset row shows the closed hand (grabbing) all the way, with a copy of the row; the source dims, the target is outlined', during && during.html && during.under === 'grabbing' && during.body === 'grabbing' && during.drag && during.drag.active && during.drag.from === 3 && during.drag.target === 6 && during.ghost && during.src && during.dst && during.grips, JSON.stringify(during));
  await settle();
  check('Escape cancels a row drag: nothing sent, no preset loaded, the cursor and the styling are back', (await txSince(n0)).length === 0 && (await js('state.selectedPreset')) !== 6 && await js('!document.documentElement.classList.contains("preset-dragging") && !document.querySelector(".preset-ghost, #presetList .dragging, #presetList .drop-target") && !__presetDrag()'), JSON.stringify(await txSince(n0)));
  // Near the list's bottom edge it scrolls (the system drag did that too); released outside the rows, nothing moves.
  await js(`document.getElementById('presetList').scrollTop = 0`); await frame();
  const scroll0 = await js('document.getElementById("presetList").scrollTop');
  n0 = await mark();
  await dragRow(2, 3, { beforeUp: async (b) => {
    const lb = await js('(() => { const r = document.getElementById("presetList").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 6) }; })()');
    wc.sendInputEvent({ type: 'mouseMove', x: lb.x, y: lb.y, button: 'left' });
    await waitFor(async () => (await js('document.getElementById("presetList").scrollTop')) > scroll0 + 40);
    wc.sendInputEvent({ type: 'mouseMove', x: lb.x + 400, y: lb.y, button: 'left' });   // over the chain, off the list
    await frame();
    b.x = lb.x + 400; b.y = lb.y;
  } });
  await settle();
  check('a row dragged to the list\'s bottom edge scrolls the list; dropped off the rows, nothing is sent', (await js('document.getElementById("presetList").scrollTop')) > scroll0 + 40 && (await txSince(n0)).length === 0 && await js('!__presetDrag() && !document.querySelector(".preset-ghost")'), String(await js('document.getElementById("presetList").scrollTop')) + ' ' + JSON.stringify(await txSince(n0)));
  // No grip without rows (the filter matches nothing).
  await click('#presetFilter'); await type('zzzz'); await frame();
  check('no grip on the "No presets match" list', await js('!document.querySelector("#presetList .grip") && !!document.querySelector("#presetList .side-empty")'));
  await js('{ const f = document.getElementById("presetFilter"); f.value = ""; f.dispatchEvent(new Event("input")); f.blur(); }'); await frame();
  await click('#presetFilter'); await type('Lead'); await frame();
  const leadRows = await js('[...document.querySelectorAll(".preset-row")].map(r => Number(r.dataset.n))');
  const mvFrom = leadRows[leadRows.length - 1], mvTo = leadRows[0];
  check('a filter is active for the drag (several rows match "Lead")', leadRows.length >= 3 && mvFrom > mvTo + 1, JSON.stringify(leadRows));
  await click(`.preset-row[data-n="${mvFrom}"]`);
  await checkSoon('(the preset to move is the current one)', `state.selectedPreset === ${mvFrom} && !document.querySelector(".modal")`); await settle();
  // Text dragged in from elsewhere (not a row of this list) is ignored.
  n0 = await mark();
  await dropText(mvTo, mvFrom);
  await settle();
  check('an external text drop on a preset row sends nothing', (await txSince(n0)).length === 0, JSON.stringify(await txSince(n0)));
  // While the slot usage scan runs, rows can't be dragged (no grip, a drag does nothing) and a move is refused.
  await js('__ui.scanning = true; __ui.sideSig = ""; render()'); await frame();
  n0 = await txCount();
  let scanDrag = null;
  await dragRow(mvFrom, mvTo, { beforeUp: async (b) => { scanDrag = await js(`({ drag: __presetDrag(), html: document.documentElement.classList.contains('preset-dragging'), grip: getComputedStyle(document.querySelector('#presetList .preset-row[data-n="${mvTo}"] .grip')).visibility })`); } });
  const scanMove = await js(`__movePresetOrder(${mvFrom - 1}, ${mvTo - 1})`);
  check('reordering is refused while the slot scan runs (rows not draggable, nothing sent)', scanMove === false && await js('[...document.querySelectorAll("#presetList .preset-row")].every(r => !r.classList.contains("reorderable"))') && !scanDrag.drag && !scanDrag.html && scanDrag.grip === 'hidden' && (await txSince(n0)).filter(t => /^TX Move preset/.test(t)).length === 0 && /scan/.test(await toastText()), await toastText() + ' ' + JSON.stringify(scanDrag));
  await js('__ui.scanning = false; __ui.sideSig = ""; render()'); await frame();
  check('rows are draggable again', await js('[...document.querySelectorAll("#presetList .preset-row")].every(r => r.classList.contains("reorderable"))'));
  await click(`.preset-row[data-n="${mvFrom}"]`);   // the drag above loaded nothing, but make sure
  await checkSoon('(still on the preset to move)', `state.selectedPreset === ${mvFrom} && !document.querySelector(".modal")`); await settle();
  // The move: absolute 0-based indices even with the filter on; then the list and the state are read again.
  n0 = await mark();
  await dragRow(mvFrom, mvTo);
  tx = (await txWait(n0, t => t.some(x => /^TX Current preset state request/.test(x)), { timeout: 10000 })).filter(t => /^TX (Move preset|FE metadata request|Current preset state request)/.test(t));
  check('a real mouse drag from the row\'s name (not the grip) moves the preset: 143 goes out', tx.some(t => /^TX Move preset/.test(t)), JSON.stringify(tx));
  check('the drop sends 143 with absolute 0-based indices (exact bytes), then reads the list and the state', tx.length >= 3 && tx[0] === `TX Move preset ${mvFrom} to position ${mvTo}: ` + frameHex([0x08, 0x04, 0x18, mvFrom - 1, 0x20, mvTo - 1], 143) && /^TX FE metadata request/.test(tx[1]) && /^TX Current preset state request/.test(tx[2]), JSON.stringify(tx));
  await checkSoon('the moved preset is now at its new position and the others shifted by one (as the pedal listed them)', async () => {
    const now = await allNames();
    const want = namesBefore.slice(); const [m] = want.splice(mvFrom - 1, 1); want.splice(mvTo - 1, 0, m);
    return JSON.stringify(now) === JSON.stringify(want);
  }, async () => JSON.stringify((await allNames()).slice(0, 26)));
  await checkSoon('the current preset (the one moved) is where the pedal\'s state read says: the header follows', async () => (await js('state.selectedPreset')) === mvTo && (await js('document.querySelector(".preset-title .num").textContent')) === 'Preset ' + mvTo && /^Moved preset/.test(await toastText()), async () => (await js('state.selectedPreset')) + ' ' + await toastText());
  await settle();
  // Moving it back (filter off), but the state read after it fails: the current preset is unknown and Save & co. stay off.
  await js('{ const f = document.getElementById("presetFilter"); f.value = ""; f.dispatchEvent(new Event("input")); f.blur(); }'); await frame();
  await js('__reorderTimeouts.state = 700; __reorderTimeouts.list = 4000; __demo.hooks.dropStateReads = true');
  n0 = await mark();
  await dragRow(mvTo, mvFrom, { grip: true });
  tx = await txWait(n0, t => t.some(x => /^TX Move preset/.test(x)));
  check('dragging by the ⋮⋮ grip moves a preset too', tx.some(t => t.startsWith(`TX Move preset ${mvTo} to position ${mvFrom}: `)), JSON.stringify(tx));
  await checkSoon('a failed read after a move marks the current preset unknown (header, status bar, toast)', async () => await js('__ui.presetUnknown && document.querySelector(".preset-title .num").textContent === "Preset ?" && !document.querySelector(".preset-row.active")') && /Current preset unknown/.test(await js('document.getElementById("pcText").textContent')) && /doesn’t know which preset/.test(await toastText()), async () => (await toastText()) + ' | ' + await js('document.getElementById("pcText").textContent'));
  check('… Save, Save as and Rename are off and Discard hidden', await js('["saveBtn", "saveAsBtn", "renameBtn"].every(id => document.getElementById(id).disabled) && document.getElementById("discardBtn").hidden'));
  n0 = await txCount();
  await js('state.presetDirty = true; document.activeElement.blur(); render()');
  await key('s', [MOD]); await settle();
  check('… and ⌘S saves nothing', !(await txSince(n0)).some(t => /^TX save preset/.test(t)));
  await js('__demo.hooks.dropStateReads = false; __reorderTimeouts.state = 6000; __reorderTimeouts.list = 20000; state.presetDirty = false');
  check('a successful state read clears it', (await js('NanoLive.readCurrentState(3000)')) === true && await js('!__ui.presetUnknown && !document.getElementById("saveBtn").disabled'));
  await checkSoon('the order is back as it was', async () => JSON.stringify(await allNames()) === JSON.stringify(namesBefore) && (await js('state.selectedPreset')) === mvFrom);
  win.setContentSize(1400, 900);
  await waitFor('innerHeight === 900'); await frame();
  await settle();

  // ---------------------------------------------------------------- disconnected / demo exit
  await click('#connectBtn');
  await checkSoon('Exit demo shows connect screen', '!document.getElementById("veil").hidden');
  check('connect screen offers Connect + demo', (await js('[...document.querySelectorAll(".veil-card .btn")].map(b=>b.textContent).join("|")')).includes('Explore with demo data'));
  check('connect screen: "New here? Read the manual" points at the manual', (await js('(() => { const a = document.querySelector(\'[data-fk="veil-manual"]\'); return a ? a.parentElement.textContent + "|" + a.href : ""; })()')) === 'New here? Read the manual|' + LINKS.manual);
  check('connect screen: no Troubleshooting link without an error', await js('!document.querySelector(\'[data-fk="veil-troubleshoot"]\')'));
  for (const [raw, what] of [['NotFoundError: User cancelled the requestDevice() chooser.', null], ['NotFoundError: Bluetooth adapter not available.', 'Bluetooth unavailable']]) {
    await js(`log(${JSON.stringify('Connect failed: ' + raw)}); render()`); await frame();
    const t = await js('(() => { const a = document.querySelector(\'[data-fk="veil-troubleshoot"]\'); return a ? a.textContent + "|" + a.href : ""; })()');
    if (what) check('connect error (' + what + ') links Troubleshooting in the manual', t === 'Troubleshooting|' + LINKS.troubleshooting, t);
    else check('a cancelled chooser has no Troubleshooting link', t === '', t);
  }
  await js('window.__bleHint = "none-found"; log("Connect failed: NotFoundError: x"); render()'); await frame();
  check('connect error (pedal not found) links Troubleshooting in the manual', (await js('document.querySelector(\'[data-fk="veil-troubleshoot"]\')?.href')) === LINKS.troubleshooting && /No Nano Cortex showed up/.test(await js('document.querySelector(".veil-card .err").textContent')));
  await shot('xx-connect-error');
  await js('__ui.connectError = ""; render()'); await frame();
  await shot('12-disconnected');
  check('disconnected sidebar explains instead of listing fake presets', (await js('document.querySelectorAll(".preset-row").length')) === 0 && (await js('document.querySelector(".side-empty")?.textContent || ""')).includes('once the pedal is connected'));
  check('status bar cleared on disconnect', (await js('document.getElementById("lastAction").textContent')) === '');
  check('status bar says No pedal when disconnected', (await js('document.getElementById("bleText").textContent')) === 'No pedal' && (await js('document.getElementById("bleLed").className')) === 'led');
  await js('__ui.connecting = true; render()'); await frame();
  check('status bar says Connecting… with a busy LED', (await js('document.getElementById("bleText").textContent')) === 'Connecting…' && (await js('document.getElementById("bleLed").className')) === 'led busy');
  await js('__ui.connecting = false; render()'); await frame();
  await js('__openSettings("device"); 0');
  await checkSoon('Settings → Device without a pedal: explains, controls disabled, nothing sent', () => js('!!document.querySelector(\'[data-fk="dev-offline"]\') && [...document.querySelectorAll(".dev-page input, .dev-page button")].every(x => x.disabled) && document.querySelector(\'[data-fk="dev-serial"]\').textContent === "\u2014"'));
  await key('Escape'); await waitFor(async () => !(await settingsOpen()));
  check('Save disabled while disconnected', await js('document.getElementById("saveBtn").disabled'));
  await key('s', [MOD]);
  check('⌘S while disconnected explains', (await js('document.getElementById("toast").textContent')).includes('Connect'));
  // ---------------------------------------------------------------- no stale Bluetooth link (fake pedals, no demo)
  // 2026-10-20→23: "Disconnected" for two days while macOS still held a link to the pedal, which then stopped
  // advertising. The page now releases the link whenever it decides it is disconnected, and before every scan. The
  // fake pedals below stand in for Web Bluetooth device objects (the page's real connect code runs on them).
  {
    const addedBluetooth = await js(`(() => { if (navigator.bluetooth) return false; Object.defineProperty(navigator, 'bluetooth', { configurable: true, value: { requestDevice: () => Promise.reject(new Error('NotFoundError: no Bluetooth here')) } }); render(); return true; })()`);
    await js(`(() => {
      window.__bt = { seq: [], fakes: [], browserRequest: __ble.requestDevice || null };
      window.__fakePedal = (opts = {}) => {
        const f = { name: opts.name || 'Neural DSP Nano Cortex', disconnects: 0, writes: [], fail: '', stubborn: opts.stubborn || 0, services: opts.services !== false };
        const listeners = new Set();
        const c304 = { uuid: C304_UUID, writeValueWithResponse: async (b) => { if (f.fail) throw new Error(f.fail); f.writes.push(hex(b)); } };
        const c305 = { uuid: C305_UUID, startNotifications: async () => c305, addEventListener() {}, removeEventListener() {} };
        const service = { getCharacteristic: async (u) => { if (u === C304_UUID) return c304; if (u === C305_UUID) return c305; throw new Error('No Characteristics matching UUID ' + u); }, getCharacteristics: async () => [] };
        const id = 'FAKE-' + (__bt.fakes.length + 1);
        const device = {
          id, name: f.name,
          addEventListener: (t, fn) => { if (t === 'gattserverdisconnected') listeners.add(fn); },
          removeEventListener: (t, fn) => { if (t === 'gattserverdisconnected') listeners.delete(fn); },
          gatt: {
            connected: false,
            connect: async () => { __bt.seq.push(id + ' connect'); device.gatt.connected = true; return server; },
            // stubborn: that many calls leave it connected (the OS holding on)
            disconnect: () => { f.disconnects++; __bt.seq.push(id + ' disconnect'); if (f.stubborn > 0) { f.stubborn--; return; } const was = device.gatt.connected; device.gatt.connected = false; if (was) f.emit(); },
          },
        };
        const server = { device, connected: true, getPrimaryService: async (u) => { if (!f.services) throw new Error('No Services matching UUID ' + u + ' found in Device.'); return service; } };
        f.emit = () => { for (const fn of [...listeners]) fn({ type: 'gattserverdisconnected', target: device }); };
        f.listening = () => listeners.size;
        f.device = device; f.id = id;
        __bt.fakes.push(f);
        return f;
      };
      // The next requestDevice() returns this fake.
      __bt.offer = (f) => { __ble.requestDevice = async () => { __bt.seq.push('requestDevice'); return f.device; }; };
      // Nothing of it is kept: not as the page's device, not in the list of device objects to release.
      __bt.released = (f) => !f.device.gatt.connected && state.device !== f.device && !__ble.devices.has(f.device) && f.listening() === 0 && f.disconnects > 0;
    })()`);
    const connectFake = async (k, opts) => {
      await js(`window.${k} = __fakePedal(${JSON.stringify(opts || {})}); __bt.offer(${k}); 0`);
      // The connect screen is drawn on the next frame after a disconnect (until then the old, hidden one is there).
      await waitFor('!__ui.connecting && !state.connected && !document.getElementById("veil").hidden && !!document.querySelector(\'[data-fk="veil-connect"]\') && !document.querySelector(\'[data-fk="veil-connect"]\').disabled && document.querySelector(\'[data-fk="veil-connect"]\').getBoundingClientRect().height > 0');
      await frame();
      await click('[data-fk="veil-connect"]');
    };
    const btLog = async (n, re) => js(`__ui.logs.some(l => l.seq > ${n} && ${re}.test(l.text))`);
    await js('__ui.connectError = ""; render()'); await frame();
    await connectFake('fakeA');
    await checkSoon('a fake pedal connects through the page\'s real connect code (no demo)', () => js('state.connected && !__ui.demo && state.device === fakeA.device && fakeA.device.gatt.connected'));

    // (a) the link drops, but the OS still holds it: Chromium reports gattserverdisconnected while gatt.connected is true.
    n0 = await txCount();
    await js('fakeA.emit()');
    await checkSoon('the link drops (gattserverdisconnected) while the OS still holds it: Disconnected, gatt.disconnect() called, no reference kept', () => js('!state.connected && __bt.released(fakeA) && state.server === null && state.c304 === null && state.c305 === null'), async () => JSON.stringify(await js('({ connected: state.connected, gatt: fakeA.device.gatt.connected, disconnects: fakeA.disconnects, kept: __ble.devices.has(fakeA.device), dev: !!state.device })')));
    check('… the Activity log says the link was released while it was still open', await btLog(n0, '/^Bluetooth link to Neural DSP Nano Cortex released \\(it was still open\\)\\.$/'));

    // (a) a write fails because the link is gone (no event came): disconnected and released.
    await connectFake('fakeB');
    await waitFor('state.connected && state.device === fakeB.device');
    await settle();
    n0 = await txCount();
    await js(`fakeB.fail = 'NotSupportedError: GATT operation failed for unknown reason.'; writeC304('Test write', bytesFromHex('06 C0 08 03 5B 00 00 00')).then(() => { fakeB.fail = ''; }); 0`);
    await waitFor(`__ui.logs.some(l => l.seq > ${n0} && /^ERROR: BLE write failed for "Test write"/.test(l.text))`);
    await settle();
    check('a write refused while the link is still up changes nothing (still connected, nothing released)', await js('state.connected && state.device === fakeB.device && fakeB.disconnects === 0 && fakeB.device.gatt.connected'));
    n0 = await txCount();
    await js(`fakeB.device.gatt.connected = false; fakeB.fail = 'NetworkError: GATT Server is disconnected. Cannot perform GATT operations. (Re)connect first with \`device.gatt.connect\`.'; writeC304('Test write', bytesFromHex('06 C0 08 03 5B 00 00 00')); 0`);
    await checkSoon('a write that fails because the link is gone (no event): Disconnected, gatt.disconnect() called, no reference kept', () => js('!state.connected && __bt.released(fakeB)'));
    check('… and says so in the Activity log, after the write error', await btLog(n0, '/^The Bluetooth link is gone \\(a write failed\\); disconnecting\\.$/') && await js(`(() => { const a = __ui.logs.find(l => l.seq > ${n0} && /^ERROR: BLE write failed/.test(l.text)), b = __ui.logs.find(l => l.seq > ${n0} && /^The Bluetooth link is gone/.test(l.text)); return !!a && !!b && a.seq < b.seq; })()`));
    await js('fakeB.fail = ""');

    // (a) an explicit Disconnect.
    await connectFake('fakeC');
    await waitFor('state.connected && state.device === fakeC.device');
    await click('#connectBtn');
    await checkSoon('Disconnect: gatt.disconnect(), Disconnected, no reference kept', () => js('!state.connected && __bt.released(fakeC)'));

    // (a) a connect that fails half-way: the device has no Nano service, but its GATT link was opened.
    await connectFake('fakeD', { services: false, name: 'JBL Flip 5' });
    await checkSoon('a connect that fails half-way (no Nano service) leaves no link open', () => js('!state.connected && !__ui.connecting && __bt.released(fakeD)'), async () => JSON.stringify(await js('({ gatt: fakeD.device.gatt.connected, n: fakeD.disconnects, dev: state.device && state.device.id })')));
    await js('__ui.connectError = ""; render()'); await frame();

    // (b) before every requestDevice(): an older device object that still reports a connection is disconnected.
    await connectFake('fakeE', { stubborn: 1 });
    await waitFor('state.connected && state.device === fakeE.device');
    n0 = await txCount();
    await js('fakeE.emit()');
    await waitFor('!state.connected');
    check('a link that stays open after gatt.disconnect() (the OS holding on) is kept to be tried again, and logged', await js('fakeE.device.gatt.connected && __ble.devices.has(fakeE.device) && state.device === null && fakeE.disconnects === 1') && await btLog(n0, '/still reports a connection \\(tried again before the next scan\\)/'));
    await js('__bt.seq.length = 0');
    await connectFake('fakeF');
    await waitFor('state.connected && state.device === fakeF.device');
    const seq = await js('__bt.seq.slice()');
    check('the next Connect disconnects it before requestDevice(), then connects the new one', seq.indexOf(await js('fakeE.id') + ' disconnect') === 0 && seq.indexOf('requestDevice') === 1 && await js('__bt.released(fakeE)'), JSON.stringify(seq));

    // (c) the computer sleeps and wakes (main's powerMonitor runs these hooks).
    n0 = await txCount();
    check('sleep while connected: the page disconnects cleanly', (await js('__systemSuspend()')) === true && await js('!state.connected && __bt.released(fakeF)') && await btLog(n0, '/^The computer is going to sleep: disconnecting from the pedal\\.$/'));
    // Not the launch setting: it is off here, and the wake reconnects anyway (as the native edition does after any
    // dropped link).
    await js('localStorage.setItem("settings.autoConnect", "false"); __bt.offer(fakeF); __bt.seq.length = 0; 0');
    n0 = await txCount();
    check('wake after a sleep while connected, a pedal remembered: reconnects like the launch reconnect (an auto scan), whatever "Reconnect … at launch" says', (await js('__systemResume({ pedal: true })')) === true && JSON.stringify(await js('__ble.requests.slice(-1)[0]')) === JSON.stringify({ auto: true }) && await btLog(n0, '/^The computer woke up: reconnecting to the remembered pedal\\.$/'));
    await checkSoon('… and is connected to the pedal again', () => js('state.connected && state.device === fakeF.device && fakeF.device.gatt.connected'));
    check('wake without having slept does nothing', (await js('__systemResume({ pedal: true })')) === false);
    await js('__systemSuspend(); 0');
    let requests = await js('__ble.requests.length');
    n0 = await txCount();
    check('wake with no remembered pedal: no scan, the Activity log says to click Connect', (await js('__systemResume({ pedal: false })')) === false && (await js('__ble.requests.length')) === requests && !(await js('state.connected')) && await btLog(n0, '/^The computer woke up\\. Click Connect to reconnect to the pedal\\.$/'));
    check('sleep while disconnected: nothing to do, and no reconnect on wake', (await js('__systemSuspend()')) === false && (await js('__systemResume({ pedal: true })')) === false && (await js('__ble.requests.length')) === requests);
    await js('__ble.autoWhy = "wake"; window.__bleHint = "auto-none"; log("Connect failed: NotFoundError: User cancelled the requestDevice() chooser."); __ble.autoWhy = ""; render()'); await frame();
    check('a pedal that doesn\'t show up after wake: the connect screen says so (with the Troubleshooting link)', (await js('document.querySelector(".veil-card .err")?.textContent || ""')) === 'Your Nano Cortex didn’t show up after the computer woke up. Power it on (and close Cortex Cloud on your phone), then click Connect. Troubleshooting', await js('document.querySelector(".veil-card .err")?.textContent || ""'));
    await js(`localStorage.removeItem("settings.autoConnect"); __ui.connectError = ""; __ble.requestDevice = __bt.browserRequest; delete window.__fakePedal; delete window.fakeA; delete window.fakeB; delete window.fakeC; delete window.fakeD; delete window.fakeE; delete window.fakeF; delete window.fakeG; ${addedBluetooth ? 'delete navigator.bluetooth;' : ''} render()`); await frame();
    check('the fake pedals left nothing connected or remembered', await js('!state.connected && !state.device && [...__ble.devices].every(d => !d.gatt.connected) && __bt.fakes.every(f => !f.device.gatt.connected)'));
    await js('delete window.__bt; 0');
  }
  await click('.veil-card .btn:last-child');
  await checkSoon('demo restarts from connect screen', 'state.connected && __ui.demo');
  await settle();

  // ---------------------------------------------------------------- narrow window
  win.setContentSize(820, 700);
  await waitFor('innerWidth === 820'); await stable('JSON.stringify([innerWidth, innerHeight, document.documentElement.scrollWidth, document.querySelector(".chain-wrap")?.scrollWidth])');
  await shot('13-narrow');
  check('narrow: chain scrolls instead of squashing', await js('document.querySelector(".chain-wrap").scrollWidth > document.querySelector(".chain-wrap").clientWidth'));
  check('narrow: no page-level horizontal scroll', await js('document.documentElement.scrollWidth <= window.innerWidth'), await js('JSON.stringify([...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest(".chain-wrap")).slice(0,6).map(e => e.tagName + "." + e.className + ":" + Math.round(e.getBoundingClientRect().right)))'));
  await click('#sideToggle');
  check('narrow: Presets button reveals sidebar', await js('getComputedStyle(document.querySelector(".side")).display !== "none"'));
  await shot('14-narrow-side');
  await click('.preset-row[data-n="4"]');
  check('narrow: picking a preset closes sidebar', await js('getComputedStyle(document.querySelector(".side")).display === "none"'));
  // phone width
  win.setContentSize(420, 860);
  await waitFor('innerWidth === 420'); await stable('JSON.stringify([innerWidth, innerHeight, document.documentElement.scrollWidth, document.querySelector(".chain-wrap")?.scrollWidth])');
  await shot('15-phone');
  check('phone: no page-level horizontal scroll', await js('document.documentElement.scrollWidth <= window.innerWidth'));
  check('phone: header fits on one row', await js('(() => { const h = document.querySelector(".head"); return h.scrollWidth <= h.clientWidth + 1; })()'));
  check('phone: status bar fits', await js('(() => { const h = document.querySelector(".status"); return h.scrollWidth <= h.clientWidth + 1; })()'));
  check('phone: inspector content fits its width', await js('(() => { const i = document.getElementById("inspector"); return i.scrollWidth <= i.clientWidth + 1; })()'), String(await js('document.getElementById("inspector").scrollWidth + " vs " + document.getElementById("inspector").clientWidth')));
  await key('5');
  await shot('16-phone-cab');
  check('phone: cab controls fit', await js('(() => { const i = document.getElementById("inspector"); return i.scrollWidth <= i.clientWidth + 1; })()'), String(await js('document.getElementById("inspector").scrollWidth + " vs " + document.getElementById("inspector").clientWidth')));
  await key('4');
  win.setContentSize(1400, 900);
  await waitFor('innerWidth === 1400'); await stable('JSON.stringify([innerWidth, innerHeight, document.documentElement.scrollWidth, document.querySelector(".chain-wrap")?.scrollWidth])');

  // ---------------------------------------------------------------- render cost sanity
  const t = await js(`(() => { const t0 = performance.now(); for (let i=0;i<20;i++){ __ui.sideSig=''; render(); } return new Promise(r => requestAnimationFrame(() => r(performance.now()-t0))); })()`);
  check('full render is fast', t < 120, t.toFixed(1) + ' ms');

  // ---------------------------------------------------------------- the Activity drawer never opens at launch while dev tools are off
  await js('localStorage.setItem("settings.drawerAtLaunch", "true"); localStorage.setItem("settings.devTools", "false")');
  await reloadPage();
  check('with Developer tools off, "Activity at launch" does not open the drawer', await js('!__ui.drawerOpen && !__devTools.on && !document.body.classList.contains("dev-tools")'));
  await js('localStorage.removeItem("settings.drawerAtLaunch"); localStorage.removeItem("settings.devTools")');

  // ---------------------------------------------------------------- shortcut labels per platform
  // ⌘ on macOS, Ctrl on Windows and Linux. The page's own platform first, then the others via ?platform=… (labels only;
  // the key handlers keep following the real platform).
  const labelsFor = async (plat) => {
    const loaded = new Promise(r => wc.once('did-finish-load', r));
    await win.loadURL('file://' + PAGE + '?demo' + (plat ? '&platform=' + plat : ''));
    await loaded; await waitFor('typeof __ui !== "undefined" && __ui.demo && state.connected'); await settle(); await frame();
    await js('document.activeElement.blur()');
    await key('?'); await waitFor('!!document.querySelector(".modal .keys")');
    const r = await js(`({ kbd: document.querySelector("#saveBtn kbd").textContent, saveTitle: document.getElementById("saveBtn").title,
      saveAsTitle: document.getElementById("saveAsBtn").title, settingsTitle: document.getElementById("settingsBtn").title,
      sheet: [...document.querySelectorAll(".modal .keys kbd")].map(k => k.textContent) })`);
    await key('Escape'); await waitFor('!document.querySelector(".modal")');
    return r;
  };
  const expectLabels = (name, r, mac) => {
    const S = mac ? '\u2318S' : 'Ctrl+S', SS = mac ? '\u21e7\u2318S' : 'Ctrl+Shift+S', C = mac ? '\u2318,' : 'Ctrl+,';
    check(name + ': the Save button shows ' + S, r.kbd === S && r.saveTitle.endsWith('(' + S + ')'), r.kbd + ' | ' + r.saveTitle);
    check(name + ': tooltips use ' + (mac ? '\u2318 and \u21e7' : 'Ctrl and Shift'), r.saveAsTitle.endsWith('(' + SS + ')') && r.settingsTitle === 'Settings (' + C + ')', r.saveAsTitle + ' | ' + r.settingsTitle);
    check(name + ': the shortcuts sheet lists ' + S + ' and ' + SS, r.sheet.includes(S) && r.sheet.includes(SS) && r.sheet.includes(C), r.sheet.join(' , '));
    check(name + ': no ' + (mac ? 'Ctrl' : '\u2318, \u21e7 or \u2325') + ' left in the labels', mac ? !/Ctrl/.test(r.sheet.join() + r.kbd + r.saveTitle) : !/[\u2318\u21e7\u2325]/.test(r.sheet.join() + r.kbd + r.saveTitle + r.saveAsTitle + r.settingsTitle));
  };
  const hostMac = process.platform === 'darwin';
  expectLabels('labels on this platform (' + process.platform + ')', await labelsFor(''), hostMac);
  for (const plat of hostMac ? ['win', 'linux'] : ['mac']) expectLabels('labels with ?platform=' + plat, await labelsFor(plat), plat === 'mac');
  if (!hostMac) await labelsFor('linux');   // the page is on mac labels after the loop above
  check('keyLabel off-Mac: \u2325\u2318I → Ctrl+Alt+I, \u2318\u2191 → Ctrl+\u2191', (await js('__keyLabel("\u2325\u2318I / \u2318\u2191")')) === 'Ctrl+Alt+I / Ctrl+\u2191');
  await labelsFor('');

  // ---------------------------------------------------------------- newer firmware, unknown effects
  // Version comparison: numeric per component, suffixes ignored, anything else is "not newer".
  const fwCases = { '2.2.1': false, '2.2.2': true, '2.3.0': true, '3.0': true, '2.2.1+abc': false, '2.10.0': true, '2.2': false, '2.1.9': false, garbage: false, '': false };
  for (const [v, want] of Object.entries(fwCases)) check('firmware ' + JSON.stringify(v) + (want ? ' is' : ' is not') + ' newer than 2.2.1', (await js(`__firmware.isNewer(${JSON.stringify(v)})`)) === want);
  check('firmware compare: 2.10.0 > 2.9.9, 3.0 = 3.0.0, garbage → null', (await js('[__firmware.compare("2.10.0", "2.9.9"), __firmware.compare("3.0", "3.0.0"), __firmware.compare("x", "2.2.1")].join()')) === '1,0,');
  check('the tested firmware is 2.2.1', (await js('__firmware.tested')) === '2.2.1');
  check('firmware 2.2.1 (plain demo): no newer-firmware notice', await js('document.getElementById("fwNotice").hidden'));
  await js('localStorage.removeItem("settings.firmwareWarned")');
  const loadDemo = async (query) => {
    const loaded = new Promise(r => wc.once('did-finish-load', r));
    await win.loadURL('file://' + PAGE + '?demo' + query);
    await loaded; await waitFor('typeof __ui !== "undefined" && __ui.demo && state.connected'); await settle(); await frame();
  };
  await loadDemo('&demoFirmware=2.2.1');
  check('firmware 2.2.1 reported: no notice, nothing remembered', await js('document.getElementById("fwNotice").hidden && localStorage.getItem("settings.firmwareWarned") === null'));
  await loadDemo('&demoFirmware=2.3.0&demoUnknown=post2:7E');
  const NOTICE = 'This firmware is newer than the editor has been tested with. Some new effects may not be editable until this app is updated.';
  await checkSoon('firmware 2.3.0: the notice shows under the header', 'document.getElementById("fwNotice").hidden === false');
  check('the notice has the agreed text and no modal', (await js('document.querySelector("#fwNotice .txt").textContent')) === NOTICE && !(await js('!!document.querySelector(".modal")')));
  check('the notice remembers firmware 2.3.0', (await js('localStorage.getItem("settings.firmwareWarned")')) === '"2.3.0"');
  const unknownLog = () => js('__ui.logs.filter(l => l.text === "Unknown effect id 0x7E in Post FX 2 (firmware 2.3.0)").length');
  check('one log line for the unknown id', (await unknownLog()) === 1, String(await unknownLog()));
  check('unknown effect: node title and subtitle', (await js('document.querySelector("[data-stage=post2] .model").textContent + " | " + document.querySelector("[data-stage=post2] .sub").textContent')) === 'Unknown effect | Newer firmware?');
  check('unknown effect: the subtitle is not clipped', await js('(() => { const e = document.querySelector("[data-stage=post2] .sub"); return e.scrollWidth <= e.clientWidth + 1; })()'), await js('(() => { const e = document.querySelector("[data-stage=post2] .sub"); return e.scrollWidth + " > " + e.clientWidth; })()'));
  check('unknown effect: no parameter or refresh packet for Post FX 2 since connecting', (await js('__ui.logs.filter(l => l.cls === "tx" && /^TX Post FX 2/.test(l.text)).length')) === 0);
  await shot('newer-firmware');
  await click('[data-fk="fw-notice-close"]');
  check('Dismiss hides the notice', await js('document.getElementById("fwNotice").hidden'));
  let m0 = await mark();
  await click('[data-stage=post2]');
  check('unknown effect: inspector note', (await js('document.querySelector("[data-fk=unknown-note-post2]")?.textContent')) === "This effect isn't in the editor's list yet, so its settings can't be edited here. It still plays as saved on the pedal. Update the editor to edit it.");
  check('unknown effect: no knobs, picker says Unknown effect', await js('!document.querySelector(".inspector .knob") && document.querySelector("[data-fk=picker-post2]").textContent.startsWith("Unknown effect")'));
  await shot('unknown-effect');
  await settle();
  check('selecting the unknown block sends nothing', (await txSince(m0)).length === 0, (await txSince(m0)).join(' | '));
  m0 = await mark();
  await click('[data-fk="switch-post2"]');
  await txWait(m0);
  const off = await txSince(m0);
  check('unknown effect: the switch sends the enable write (off)', off.length === 1 && off[0] === 'TX Post FX 2 OFF: 0A C0 08 01 18 07 20 01 1F 00 00 00', off.join(' | '));
  m0 = await mark();
  await click('[data-fk="switch-post2"]');
  await txWait(m0); await settle({ quiet: 600 });
  const on = await txSince(m0);
  check('unknown effect: on sends the enable write and no parameter refresh', on.length === 1 && on[0] === 'TX Post FX 2 ON: 0A C0 08 01 18 07 20 00 1F 00 00 00', on.join(' | '));
  m0 = await mark();
  await js('setFXParam("post2", { index: 0, value: 1, meta: { kind: "range", min: 0, max: 10, step: 0.1 } }); state.paramRefreshQueue = ["post2"]; requestNextFXParamRefresh();');
  await settle();
  check('unknown effect: parameter writes and refresh requests are refused', (await txSince(m0)).length === 0, (await txSince(m0)).join(' | '));
  await click('[data-fk="exp-pill"]');
  await waitFor('!!document.querySelector(\'[data-fk="exp-add"]:not([disabled])\')');
  await click('[data-fk="exp-add"]');
  await waitFor('!!document.querySelector(".pop")');
  check('expression targets: Post FX 2 shows as Unknown effect', await js('[...document.querySelectorAll(".pop-item")].some(x => x.textContent.startsWith("Post FX 2") && x.title === "Unknown effect")'));
  await key('Escape'); await waitFor('!document.querySelector(".pop")');
  await click('[data-stage=post2]');
  m0 = await mark();
  await click('[data-fk="picker-post2"]');
  await waitFor('!!document.querySelector(".pop")');
  check('picker: nothing is marked current for the unknown effect', await js('!document.querySelector(".pop-item.cur")'));
  await type('Tape Delay'); await key('Return');
  await txWait(m0, (tx) => tx.some(t => /model select/.test(t)));
  check('picking a known effect replaces the unknown one', (await js('document.querySelector("[data-stage=post2] .model").textContent')) === 'Tape Delay' && (await txSince(m0)).some(t => t.startsWith('TX Post FX 2 model select Tape Delay')), (await txSince(m0)).join(' | '));
  check('a known effect shows its knobs again', await js('!!document.querySelector(".inspector .knob") && !document.querySelector("[data-fk=unknown-note-post2]")'));
  await loadDemo('&demoFirmware=2.3.0&demoUnknown=post2:7E');
  check('reconnecting on 2.3.0: the notice does not come back', await js('document.getElementById("fwNotice").hidden'));
  check('reconnecting: the unknown effect is reported again', (await js('document.querySelector("[data-stage=post2] .model").textContent')) === 'Unknown effect');
  await js('localStorage.removeItem("settings.firmwareWarned")');
  await loadDemo('');

  // ---------------------------------------------------------------- Bluetooth chooser (issue #15)
  // The shell's picker (src/bt-picker.js) with fake devices, its chooser drawn by this page and answered with real
  // clicks. The test carries the messages between them, as the shell's IPC does: views to __bleChooser.show(),
  // the page's choices (__ble.choices) and connect results (__ble.results) back to the picker.
  {
    const { createBluetoothPicker, sortDevices, realName } = require('../src/bt-picker');
    const dev = (deviceId, deviceName = '') => ({ deviceId, deviceName });
    const OTHERS = [dev('AA:01', 'JBL Flip 5'), dev('AA:02', 'Razer Nomv2X LE'), dev('AA:03', 'Bose QC45'), dev('AA:04'),
      dev('AA:05', 'Logitech MX Keys'), dev('AA:06', 'Nanoleaf Shapes'), dev('AA:07', 'Unknown or Unsupported Device (AA:07)'),
      dev('AA:08', 'Galaxy Buds2'), dev('AA:09', 'Sonos Roam'), dev('AA:0A', 'Cortex Speaker'), dev('AA:0B', 'Apple Watch'), dev('AA:0C')];
    const NANO = dev('NN:01', 'Neural DSP Nano Cortex');
    let saved = null;
    let pageQueue = Promise.resolve();
    const makePicker = () => {
      const p = { again: [], hints: [], picked: [] };
      p.picker = createBluetoothPicker({
        store: { get: () => saved, set: (v) => { saved = v; } },
        show: (view) => { pageQueue = pageQueue.then(() => js('__bleChooser.show(' + JSON.stringify(view) + ')')); },
        hint: async (h) => { p.hints.push(h); }, connectAgain: (o) => p.again.push(o), chooserMs: 40, autoMs: 150,
      });
      p.cb = (id) => p.picked.push(id);
      return p;
    };
    const synced = async () => { await pageQueue; await frame(); };
    const toShell = async (p) => {   // the page's answers, as the preload bridge would carry them
      for (const c of await js('__ble.choices.splice(0)')) p.picker.choose(c);
      for (const k of await js('__ble.results.splice(0)')) p.picker.result(k);
    };
    const chooserUp = () => js('!!document.querySelector(".bt-chooser")');
    const rowsText = () => js('[...document.querySelectorAll(".bt-row")].map(r => r.querySelector(".name").textContent + (r.querySelector(".tag") ? " [" + r.querySelector(".tag").textContent + "]" : "") + (r.textContent === r.querySelector(".name").textContent + (r.querySelector(".tag")?.textContent || "") ? "" : " <stray text>"))');
    // The core's log lines when the picked device has no A002/A003 (from the issue's log).
    const failNoService = () => js(`(() => { for (const u of ['0000a002', '0000a003']) log('Service unavailable ' + u + '-0000-1000-8000-00805f9b34fb: No Services matching UUID ' + u + '-0000-1000-8000-00805f9b34fb found in Device.');
      log('Connect failed: C304/C305 not found under A002/A003'); })()`);
    await js('__ble.choices.length = 0; __ble.results.length = 0');

    // Order and names
    const order = sortDevices(OTHERS.map(d => ({ id: d.deviceId, name: realName(d.deviceName, d.deviceId) })), { notNano: new Set(['AA:02']) }).map(d => d.id);
    check('chooser order: Nano-like names, then unnamed devices, then the rest, then devices that failed the service check',
      order.join() === 'AA:06,AA:0A,AA:04,AA:07,AA:0C,AA:01,AA:03,AA:05,AA:08,AA:09,AA:0B,AA:02', order.join());
    check('a name made from the address ("Unknown or Unsupported Device (…)") counts as unnamed', realName('Unknown or Unsupported Device (AA:07)', 'AA:07') === '' && realName('Neural DSP Nano Cortex', 'NN:01') === 'Neural DSP Nano Cortex');

    // A fresh install scans for the Nano's service; a pedal found that way is taken at once, even without a name.
    let p = makePicker();
    check('with nothing remembered, Connect scans for the Nano Cortex service only ("nano" scan)', p.picker.beginRequest({}) === 'nano');
    p.picker.onSelect([dev('NN:02')], p.cb);
    check('"nano" scan: the first device offering the service is picked without a chooser, even unnamed', p.picked.join() === 'NN:02' && !(await chooserUp()));
    check('picking it does not remember it yet', saved === null);
    await js('__ui.demo = false; setStatus("Connected", true); __ui.demo = true'); await toShell(p);
    check('remembered once the editor found C304/C305 on it (the page reports "ok")', saved && saved.id === 'NN:02' && saved.via === 'nano' && saved.name === 'Nano Cortex', JSON.stringify(saved));
    saved = null;

    // Nothing found yet: the chooser waits, with the pairing hint and the way to every device.
    p = makePicker();
    p.picker.beginRequest({});
    p.picker.onSelect([], p.cb);
    await waitFor(chooserUp); await synced();
    check('"nano" scan, nothing yet: "Looking for your Nano Cortex" with the pairing hint',
      (await js('document.querySelector("[data-fk=bt-title]").textContent')) === 'Looking for your Nano Cortex'
      && /^Put the Nano Cortex in pairing mode: hold EXIT \+ CAPTURE for about a second, until the Gain ring lights up\./.test(await js('document.querySelector("[data-fk=bt-hint]").textContent')),
      await js('document.querySelector("[data-fk=bt-hint]").textContent'));
    check('"nano" scan: an empty list explains itself and offers Show all Bluetooth devices', await js('!!document.querySelector("[data-fk=bt-empty]") && !document.querySelector("[data-fk=bt-all]").hidden'));
    await shot('bt-chooser-waiting');
    await click('[data-fk="bt-all"]');
    check('Show all Bluetooth devices closes the chooser and asks for an "all" scan', !(await chooserUp()) && JSON.stringify(await js('__ble.choices')) === '["all"]');
    await toShell(p);
    check('… which cancels the filtered request (the page starts the next one)', p.picked.join() === '' && p.picked.length === 1);

    // Every device nearby: all listed, sorted, live, nothing remembered by picking.
    p = makePicker();
    check('the fallback list is an "all" scan', p.picker.beginRequest({ want: 'all' }) === 'all');
    p.picker.onSelect(OTHERS.slice(0, 3), p.cb);
    await waitFor(chooserUp); await synced();
    check('"all" scan: no Nano-like name, so the chooser opens', (await js('document.querySelector("[data-fk=bt-title]").textContent')) === 'Choose your Nano Cortex' && (await js('document.querySelector("[data-fk=bt-all]").hidden')));
    p.picker.onSelect(OTHERS, p.cb);
    await synced();
    const listed = await rowsText();
    check('more than 8 devices: all 12 are listed (no cap)', listed.length === 12, listed.length + ': ' + listed.join(' | '));
    check('the list updates while the chooser stays open', await chooserUp() && /Scanning… 12 devices nearby\./.test(await js('document.querySelector("[data-fk=bt-status]").textContent')));
    check('in the chooser: Nano-like names first, then unnamed devices, then the rest',
      listed.slice(0, 5).join(' | ') === 'Nanoleaf Shapes [Looks like a Nano Cortex] | Cortex Speaker [Looks like a Nano Cortex] | Unnamed device · …AA04 | Unnamed device · …AA07 | Unnamed device · …AA0C'
      && listed[5] === 'JBL Flip 5', listed.join(' | '));
    check('the list scrolls instead of growing past the window', await js('(() => { const l = document.querySelector(".bt-list"); return l.scrollHeight > l.clientHeight + 20 && document.querySelector(".bt-chooser").getBoundingClientRect().bottom <= innerHeight; })()'));
    await shot('bt-chooser-all');
    const razer = await js('[...document.querySelectorAll(".bt-row")].findIndex(r => r.dataset.id === "AA:02")');
    await click('[data-fk="bt-dev-' + razer + '"]');   // scrolled into view, then a real click
    await toShell(p);
    check('clicking a row picks that device', p.picked.join() === 'AA:02' && !(await chooserUp()));
    await failNoService(); await toShell(p);
    check('a non-Nano pick is not remembered (its services were not found)', saved === null && p.picker.notNano.has('AA:02'));
    check('… and the chooser is asked for again, with a notice', JSON.stringify(p.again) === '[{"want":"all","choose":true,"notice":"not-nano"}]', JSON.stringify(p.again));
    p.picker.beginRequest(p.again[0]);
    p.picker.onSelect(OTHERS, p.cb);
    await waitFor(chooserUp); await synced();
    const again = await rowsText();
    check('the device that failed sorts last, marked "Not a Nano Cortex", and the notice says why',
      again[again.length - 1] === 'Razer Nomv2X LE [Not a Nano Cortex]' && /isn’t a Nano Cortex/.test(await js('document.querySelector("[data-fk=bt-notice]").textContent')), again.join(' | '));
    p.picker.onSelect([...OTHERS, NANO], p.cb);
    await synced();
    check('the Nano Cortex turning up while the chooser is open is picked by its name, and the chooser closes', p.picked.join() === 'AA:02,NN:01' && !(await chooserUp()));
    await js('__ui.demo = false; setStatus("Connected", true); __ui.demo = true'); await toShell(p);
    check('found via the full list: remembered with via "all", so the next scan starts there', saved && saved.id === 'NN:01' && saved.name === 'Neural DSP Nano Cortex' && saved.via === 'all' && p.picker.beginRequest({}) === 'all', JSON.stringify(saved));
    p.picker.onSelect([NANO], p.cb);
    check('the remembered pedal is picked at once', p.picked.slice(-1)[0] === 'NN:01');
    await js('__ui.connectError = ""; render()');

    // 1.0.0 remembered a Razer headset: the service failure forgets it and the chooser opens again.
    saved = { id: 'AA:02', name: 'Razer Nomv2X LE', at: '2026-10-17T13:47:35.739Z' };
    p = makePicker();
    p.picker.beginRequest({ want: 'all' });
    p.picker.onSelect(OTHERS, p.cb);
    check('a remembered device is picked without asking', p.picked.join() === 'AA:02');
    await failNoService(); await toShell(p);
    check('a service failure (No Services matching A002/A003) clears the remembered device', saved === null);
    check('… and asks for the chooser again', p.again.length === 1 && p.again[0].choose === true);
    p.picker.beginRequest(p.again[0]);
    p.picker.onSelect(OTHERS, p.cb);
    await waitFor(chooserUp); await synced();
    check('the forgotten device is not picked again; the chooser opens at once', p.picked.join() === 'AA:02' && await chooserUp());
    await key('Escape'); await toShell(p);
    check('Esc cancels the chooser', !(await chooserUp()) && p.picked.join() === 'AA:02,');
    await js('__ui.connectError = ""; render()');

    // A dropped link while looking for the services proves nothing: the remembered pedal stays.
    saved = { id: 'NN:01', name: 'Neural DSP Nano Cortex', at: '2026-10-20T10:00:00.000Z', via: 'nano' };
    p = makePicker();
    p.picker.beginRequest({});
    p.picker.onSelect([NANO], p.cb);
    await js(`(() => { log('Requesting Nano Cortex...'); log('Service unavailable 0000a002-0000-1000-8000-00805f9b34fb: GATT Server is disconnected. Cannot retrieve services.'); log('Connect failed: C304/C305 not found under A002/A003'); })()`);
    await toShell(p);
    check('a dropped link during service discovery keeps the remembered pedal', saved && saved.id === 'NN:01' && p.again.length === 0);
    await js('__ui.connectError = ""; render()');

    // Scan again, and reconnect at launch.
    p = makePicker();
    p.picker.beginRequest({ want: 'all' });
    p.picker.onSelect([dev('AA:01', 'JBL Flip 5')], p.cb);
    await waitFor(chooserUp); await synced();
    await click('[data-fk="bt-rescan"]');
    check('Scan again closes the chooser and asks for a new scan', !(await chooserUp()) && (await js('__ble.choices.slice(-1)[0]')) === 'rescan');
    await toShell(p);
    check('… cancelling the running request first', p.picked.join() === '');
    p = makePicker();
    p.picker.beginRequest({ auto: true });
    p.picker.onSelect([dev('NN:03', 'Neural DSP Nano Cortex'), ...OTHERS], p.cb);
    await waitFor(() => p.picked.length > 0, { timeout: 2000 });
    check('reconnect at launch takes only the remembered pedal: another Nano is not picked, no chooser', p.picked.join() === '' && p.hints.join() === 'auto-none' && !(await chooserUp()));
    saved = null;
    await js('__ble.choices.length = 0; __ble.results.length = 0; __ui.connectError = ""; render()');
  }

  // ---------------------------------------------------------------- update notifications
  // src/updates.js (the shell's side) with a fake electron-updater and fake timers; its events drive the page's modal
  // (__updates.event, as the preload bridge does) and the modal's answers (__updates.actions) go back to it.
  {
    const { createUpdates, installMode, notesExcerpt, FIRST_MS, DAY_MS } = require('../src/updates');
    const { EventEmitter } = require('events');
    check('updates: the macOS zip, the NSIS installer and the AppImage install themselves; the portable exe and the deb only link to the release',
      installMode('darwin', {}) === 'install' && installMode('win32', {}) === 'install' && installMode('win32', { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\nce.exe' }) === 'notify'
      && installMode('linux', { APPIMAGE: '/home/x/nce.AppImage' }) === 'install' && installMode('linux', {}) === 'notify');
    const HTML = '<h3>Fixed</h3>\n<ul>\n<li>Connecting on a computer with many Bluetooth devices (<a href="https://github.com/x">#15</a>).</li>\n<li>Only a real Nano Cortex is remembered &amp; reused.</li>\n</ul>\n<hr>\n<p>macOS builds are signed with a Developer ID.</p>';
    check('release notes become plain text: headings, bullets, entities; the footer after the rule is left out',
      notesExcerpt(HTML) === 'Fixed\n• Connecting on a computer with many Bluetooth devices (#15).\n• Only a real Nano Cortex is remembered & reused.', JSON.stringify(notesExcerpt(HTML)));
    const long = notesExcerpt('word '.repeat(200), 100);
    check('long release notes are cut at a word with an ellipsis', long.length <= 100 && long.endsWith('…') && !/wor…$/.test(long), JSON.stringify(long));

    let settings = { auto: true, skipped: null };
    let pageQueue = Promise.resolve();
    const make = (mode) => {
      const u = new EventEmitter();
      u.calls = []; u.onCheck = null;
      u.checkForUpdates = async () => { u.calls.push('check'); if (u.onCheck) return u.onCheck(); return {}; };
      u.downloadUpdate = async () => { u.calls.push('download'); };
      u.quitAndInstall = (...a) => u.calls.push('quitAndInstall ' + a.join(','));
      const t = { timers: [], setTimeout: (fn, ms) => t.timers.push({ fn, ms, every: false, on: true }), setInterval: (fn, ms) => t.timers.push({ fn, ms, every: true, on: true }) };
      t.clearTimeout = t.clearInterval = (id) => { if (t.timers[id - 1]) t.timers[id - 1].on = false; };
      const r = { u, t, opened: [], events: [] };
      r.up = createUpdates({
        updater: u, store: { get: () => settings, set: (patch) => Object.assign(settings, patch) },
        send: (ev) => { r.events.push(ev); pageQueue = pageQueue.then(() => js('__updates.event(' + JSON.stringify(ev) + ')')); },
        openExternal: (url) => r.opened.push(url), currentVersion: '1.0.1', mode, releaseUrl: (v) => LINKS.releases + '/tag/v' + v, timers: t,
      });
      return r;
    };
    const synced = async () => { await pageQueue; await frame(); };
    const answer = async (r) => { for (const a of await js('__updates.actions.splice(0)')) r.up.action(a); };   // the page's answers, as the bridge carries them
    const modalUp = () => js('!!document.querySelector(".upd-modal")');
    const buttons = () => js('[...document.querySelectorAll(".upd-modal .row button")].map(b => b.textContent).join("|")');
    const toastText = () => js('document.getElementById("toast").classList.contains("show") ? document.getElementById("toast").textContent : ""');
    const offer = async (r, version, notes = HTML) => { r.u.emit('update-available', { version, releaseNotes: notes }); await synced(); };

    let r = make('install');
    check('updates: nothing downloads by itself; a download the user started installs on quit', r.u.autoDownload === false && r.u.autoInstallOnAppQuit === true);
    r.up.start();
    check('updates: the first check ' + FIRST_MS / 1000 + ' s after launch, then every 24 hours', r.t.timers.length === 2 && r.t.timers[0].ms === FIRST_MS && !r.t.timers[0].every && r.t.timers[1].ms === DAY_MS && r.t.timers[1].every && DAY_MS === 86400000);
    r.t.timers[0].fn();
    check('the scheduled check asks the updater', r.u.calls.join() === 'check');

    await offer(r, '1.0.2');
    check('an update opens the modal: the new version, a notes excerpt and a link to the full notes',
      await modalUp() && (await js('document.querySelector("[data-fk=upd-title]").textContent')) === 'Version 1.0.2 is available'
      && (await js('document.querySelector("[data-fk=upd-notes]").textContent')).startsWith('Fixed\n• Connecting on a computer')
      && (await js('document.querySelector("[data-fk=upd-notes-link]").href')) === LINKS.releases + '/tag/v1.0.2');
    check('the three choices: Skip this version, Remind me later, Download and install', (await buttons()) === 'Skip this version|Remind me later|Download and install', await buttons());
    await shot('update-available');
    await click('[data-fk="upd-later"]'); await answer(r);
    check('Remind me later closes the modal and stores nothing', !(await modalUp()) && settings.skipped === null);
    r.t.timers[1].fn(); await offer(r, '1.0.2');
    check('… and the next scheduled check offers it again', await modalUp());
    await click('[data-fk="upd-skip"]'); await answer(r);
    check('Skip this version closes the modal and stores the version', !(await modalUp()) && settings.skipped === '1.0.2');
    const n0 = r.events.length;
    r.t.timers[1].fn(); await offer(r, '1.0.2');
    check('a skipped version is never offered by the automatic checks', r.events.length === n0 && !(await modalUp()));
    await offer(r, '1.0.3');
    check('a newer version is offered again', await modalUp() && (await js('document.querySelector("[data-fk=upd-title]").textContent')) === 'Version 1.0.3 is available');
    await key('Escape'); await answer(r);
    check('Esc means Remind me later', !(await modalUp()) && settings.skipped === '1.0.2');

    // Download and install: progress, then Restart to update / Later.
    await offer(r, '1.0.3');
    await click('[data-fk="upd-download"]'); await answer(r);
    check('Download and install starts the download and shows progress', r.u.calls.includes('download') && await js('!document.querySelector("[data-fk=upd-progress]").hidden') && (await buttons()) === '');
    r.u.emit('download-progress', { percent: 42.4 }); await synced();
    check('the progress bar follows the download', (await js('document.querySelector("[data-fk=upd-pct]").textContent')) === 'Downloading… 42\u202f%' && (await js('document.querySelector(".upd-bar > span").style.width')) === '42%');
    await key('Escape');
    check('Esc does nothing while downloading', await modalUp());
    await shot('update-downloading');
    r.u.emit('update-downloaded', { version: '1.0.3' }); await synced();
    check('downloaded: "Version 1.0.3 is ready" with Later and Restart to update', (await js('document.querySelector("[data-fk=upd-title]").textContent')) === 'Version 1.0.3 is ready' && (await buttons()) === 'Later|Restart to update', await buttons());
    await click('[data-fk="upd-later"]'); await answer(r);
    check('Later closes it and says the update installs on quit', !(await modalUp()) && (await toastText()) === 'The update installs when you quit.' && !r.u.calls.some(c => c.startsWith('quitAndInstall')));
    const c0 = r.u.calls.length;
    await r.up.check(true); await synced();
    check('Check for Updates… after a download offers the restart again, without checking', (await buttons()) === 'Later|Restart to update' && r.u.calls.length === c0, (await buttons()) + ' ' + r.u.calls.join());
    await click('[data-fk="upd-restart"]'); await answer(r);
    check('Restart to update quits and installs (and relaunches)', r.u.calls.includes('quitAndInstall false,true'));
    await js('__updates.close()');

    // Manual checks answer; automatic ones stay quiet unless there is something to offer.
    r = make('install');
    r.u.onCheck = () => { r.u.emit('update-not-available', { version: '1.0.1' }); return {}; };
    await r.up.check(true); await synced();
    check('Check for Updates…: "You’re up to date."', (await toastText()) === 'You’re up to date.' && r.events.map(e => e.type).join() === 'checking,none');
    r.u.onCheck = () => { r.u.emit('error', new Error('Cannot find latest-mac.yml in the latest release artifacts\nstack…')); throw new Error('x'); };
    await r.up.check(true); await synced();
    check('Check for Updates…: an error shows as a toast', (await toastText()) === 'Couldn’t check for updates: Cannot find latest-mac.yml in the latest release artifacts', await toastText());
    const e0 = r.events.length;
    await r.up.check(false); await synced();
    check('an automatic check that fails says nothing', r.events.length === e0);
    r.u.onCheck = () => { r.u.emit('update-available', { version: '1.0.2', releaseNotes: HTML }); return {}; };   // the updater emits during the check
    await r.up.check(true); await synced();
    r.u.onCheck = null;
    check('Check for Updates… offers a skipped version (it was asked for)', await modalUp() && (await js('document.querySelector("[data-fk=upd-title]").textContent')) === 'Version 1.0.2 is available');
    await click('[data-fk="upd-download"]'); await answer(r);
    r.u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED')); await synced();
    check('a failed download closes the modal with a toast', !(await modalUp()) && (await toastText()) === 'The update couldn’t be downloaded: net::ERR_INTERNET_DISCONNECTED', await toastText());
    // macOS: the zip is in ('update-downloaded'), then Squirrel.Mac refuses its signature (seen with ad-hoc builds).
    r.u.onCheck = () => { r.u.emit('update-available', { version: '1.0.3', releaseNotes: '' }); return {}; };
    await r.up.check(true); await synced(); r.u.onCheck = null;
    await click('[data-fk="upd-download"]'); await answer(r);
    r.u.emit('update-downloaded', { version: '1.0.3' }); await synced();
    r.u.emit('error', new Error('Error: Code signature at URL file:///x/Nano%20Cortex%20Editor.app/ did not pass validation: code failed to satisfy specified code requirement(s)')); await synced();
    check('an install refused after the download (Squirrel.Mac) closes the modal: nothing to restart', !(await modalUp()) && /^The update couldn’t be installed: Error: Code signature/.test(await toastText()) && r.up.state.downloaded === null, await toastText());
    await r.up.check(true); await synced();
    check('… and the next Check for Updates… checks again', r.u.calls.filter(c => c === 'check').length >= 3);

    // Notify only (the portable exe, the deb): Download opens the release page.
    r = make('notify');
    check('notify-only builds never install on quit', r.u.autoInstallOnAppQuit === false);
    await offer(r, '1.0.3');
    check('notify-only: Skip this version, Remind me later, Download', (await buttons()) === 'Skip this version|Remind me later|Download', await buttons());
    await click('[data-fk="upd-download"]'); await answer(r);
    check('notify-only: Download opens the release page and downloads nothing', !(await modalUp()) && r.opened.join() === LINKS.releases + '/tag/v1.0.3' && !r.u.calls.includes('download'));

    // The setting: off stops the schedule, on starts it again.
    r = make('install');
    r.up.start();
    r.up.setAuto(false);
    check('turning automatic checks off stores it and cancels the schedule', settings.auto === false && r.t.timers.every(x => !x.on));
    const r2 = make('install'); r2.up.start();
    check('with automatic checks off, nothing is scheduled at launch', r2.t.timers.length === 0);
    r2.up.setAuto(true);
    check('turning them on schedules them again', settings.auto === true && r2.t.timers.filter(x => x.on).length === 2);
    settings = { auto: true, skipped: null };

    // Settings → General → Advanced, and the Help menu.
    await key(',', [MOD]);
    await waitFor('!!document.querySelector(\'[data-fk="set-autoupdate"]\')');
    check('Settings → Advanced: "Check for updates automatically", disabled outside the desktop app',
      (await js('document.querySelector(\'[data-fk="set-autoupdate"]\').textContent')) === 'Check for updates automatically' && await js('document.querySelector(\'[data-fk="set-autoupdate"]\').disabled')
      && (await js('document.querySelector(\'[data-fk="set-autoupdate-note"]\').textContent')) === 'Only in the desktop app.');
    await key('Escape'); await waitFor('!document.querySelector(".modal")');
    const help = menuFor(false).join(',');
    check('Help → Check for Updates…', /Show Log File,-,Check for Updates…,Support the Project…/.test(help), help);
  }

  // ---------------------------------------------------------------- dev remote hardening (src/dev-remote.js)
  // No window involved: who the remote answers (not a browser, not another Host name) and where /shot may write.
  {
    const { devRemoteRequestAllowed, refuseBrowserRequest, devShotPath, shotRoots } = require('../src/dev-remote');
    const http = require('http');
    const os = require('os');
    const curl = { host: '127.0.0.1:4848', 'user-agent': 'curl/8.7.1', accept: '*/*' };
    const ok = (extra, port = 4848, base = curl) => devRemoteRequestAllowed({ ...base, ...extra }, port);
    check('dev remote: a plain curl (127.0.0.1 or localhost, with the right port) is allowed',
      ok({}) && ok({ host: 'localhost:4848' }) && ok({ host: 'LocalHost:4848' }) && ok({ 'content-type': 'application/x-www-form-urlencoded' }));
    check('dev remote: any Origin header is refused, whatever its value or spelling',
      !ok({ origin: 'https://example.com' }) && !ok({ Origin: 'https://example.com' }) && !ok({ ORIGIN: 'null' }) && !ok({ origin: '' }) && !ok({ origin: 'http://127.0.0.1:4848' }));
    check('dev remote: any Sec-Fetch-Site / -Mode / -Dest header is refused (an <img> or a no-cors fetch carries them)',
      !ok({ 'sec-fetch-site': 'cross-site' }) && !ok({ 'Sec-Fetch-Mode': 'no-cors' }) && !ok({ 'SEC-FETCH-DEST': 'image' }) && !ok({ 'sec-fetch-site': 'same-origin' }));
    check('dev remote: a Host that is not exactly 127.0.0.1:<port> or localhost:<port> is refused (DNS rebinding)',
      !ok({ host: 'attacker.example:4848' }) && !ok({ host: 'attacker.example' }) && !ok({ host: '127.0.0.1' }) && !ok({ host: '127.0.0.1:4849' }) && !ok({ host: 'localhost' })
      && !ok({ host: '127.0.0.1.attacker.example:4848' }) && !ok({ host: 'localhost.attacker.example:4848' }) && !ok({ host: '127.0.0.1:4848.attacker.example' })
      && !ok({ host: '[::1]:4848' }) && !ok({ host: '0.0.0.0:4848' }) && !ok({ host: '' }) && !ok({ host: ['127.0.0.1:4848', 'attacker.example'] })
      && !devRemoteRequestAllowed({ 'user-agent': 'curl' }, 4848) && !devRemoteRequestAllowed(undefined, 4848));
    check('dev remote: the port in Host must be the remote\'s own', ok({ host: '127.0.0.1:4881' }, 4881) && !ok({ host: '127.0.0.1:4848' }, 4881));

    // The same rules over a real socket: Node's own client sends exactly the headers given.
    const server = http.createServer((req, res) => {
      if (refuseBrowserRequest(req, res, server.address().port)) return;
      res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true,"ran":true}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const call = (headers, method = 'GET') => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/eval', method, headers }, (res) => {
        let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      rq.on('error', reject); rq.end(method === 'POST' ? '1+1' : undefined);
    });
    const plain = await call({}), withOrigin = await call({ Origin: 'https://example.com' }, 'POST');
    const fetchImg = await call({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' });
    const rebound = await call({ Host: 'attacker.example:' + port }), viaName = await call({ Host: 'localhost:' + port });
    server.close();
    check('dev remote over HTTP: a plain request runs; Origin, Sec-Fetch-* and a foreign Host get 403 {ok:false,error:"browser requests are refused"} and nothing runs',
      plain.status === 200 && JSON.parse(plain.body).ran === true && viaName.status === 200
      && [withOrigin, fetchImg, rebound].every((r) => r.status === 403 && r.body === '{"ok":false,"error":"browser requests are refused"}'),
      JSON.stringify([plain, withOrigin, fetchImg, rebound, viaName]));

    // /shot: a .png inside test-output/, docs/images/ or a temp folder, nothing else.
    const shotBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nano-devshot-')));
    const repo = path.join(shotBase, 'repo'), outside = path.join(shotBase, 'outside');
    fs.mkdirSync(path.join(repo, 'test-output'), { recursive: true }); fs.mkdirSync(path.join(repo, 'docs', 'images'), { recursive: true }); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(repo, 'test-output', 'link-out'));
    fs.symlinkSync(path.join(outside, 'later.png'), path.join(repo, 'test-output', 'dangling.png'));
    fs.symlinkSync(path.join(outside, 'target.png'), path.join(repo, 'test-output', 'to-file.png')); fs.writeFileSync(path.join(outside, 'target.png'), 'x');
    const tmp = path.join(shotBase, 'tmp'); fs.mkdirSync(tmp);
    // Explicit roots: the real list also has /tmp, which on Linux CI holds this fixture, and the "outside" cases must stay outside.
    const roots = [path.join(repo, 'test-output'), path.join(repo, 'docs', 'images'), tmp];
    check('dev remote /shot: the folders are test-output/, docs/images/ and the temp folder (plus /tmp off Windows)',
      shotRoots(repo, tmp).slice(0, 3).join('|') === roots.join('|') && (process.platform === 'win32' || shotRoots(repo, tmp)[3] === '/tmp'));
    const sp = (f) => devShotPath(f, repo, roots);
    check('dev remote /shot: a .png in test-output/, docs/images/ or the temp folder is written (relative paths start at the repo root; not-yet-existing folders are fine)',
      sp('test-output/a.png') === path.join(repo, 'test-output', 'a.png') && sp(path.join(repo, 'docs', 'images', 'x.PNG')) === path.join(repo, 'docs', 'images', 'x.PNG')
      && sp(path.join(tmp, 'nano-shot.png')) === path.join(tmp, 'nano-shot.png') && sp('test-output/new-dir/deep/a.png') === path.join(repo, 'test-output', 'new-dir', 'deep', 'a.png')
      && devShotPath(path.join(os.tmpdir(), 'nano-shot.png'), repo) === path.join(fs.realpathSync(os.tmpdir()), 'nano-shot.png')   // the default roots include the real OS temp folder
      && (process.platform === 'win32' || devShotPath('/tmp/nano-shot.png', repo) === path.join(fs.realpathSync('/tmp'), 'nano-shot.png')));
    check('dev remote /shot: not a .png, outside the three folders, or reaching out by ".." or by a symlink is refused (400 in the server)',
      sp('test-output/a.txt') === null && sp('test-output/a.png.sh') === null && sp('test-output/png') === null && sp('test-output/') === null && sp('') === null && sp(undefined) === null && sp(null) === null
      && sp('/etc/passwd.png') === null && sp(path.join(outside, 'x.png')) === null && sp('src/main.png') === null && sp('package.png') === null && sp('docs/x.png') === null
      && sp('test-output/../src/x.png') === null && sp('test-output/../../outside/x.png') === null && sp('../outside/x.png') === null
      && sp(path.join(repo, 'test-output') + '.png') === null && sp(path.join(repo, 'test-output-evil', 'a.png')) === null
      && sp('test-output/link-out/x.png') === null && sp('test-output/dangling.png') === null && sp('test-output/to-file.png') === null
      && sp('test-output/a\0.png') === null && sp(path.join(os.homedir(), 'Desktop', 'x.png')) === null && sp(path.join(os.homedir(), '.ssh', 'authorized_keys.png')) === null);
    fs.rmSync(shotBase, { recursive: true, force: true });
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
}

app.whenReady().then(async () => {
  // backgroundThrottling off: on macOS an occluded window gets almost no animation
  // frames, and every step here waits for one.
  // enableLargerThanScreen: CI runners (macOS) have a small display, and the layout checks need the full 1400×900.
  win = new BrowserWindow({ width: 1400, height: 900, useContentSize: true, show: true, enableLargerThanScreen: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  wc = win.webContents;
  wc.setWindowOpenHandler(({ url }) => { opened.push(url); return { action: 'deny' }; });
  wc.on('console-message', (e) => {
    const level = e.level ?? e.params?.level;
    const msg = e.message ?? e.params?.message;
    if (level === 'error' || level === 3) consoleErrors.push(String(msg));
  });
  wc.on('preload-error', (_e, p, err) => consoleErrors.push('preload ' + err));
  for (const f of fs.readdirSync(OUT)) if (/^nano-session-.*\.json$/.test(f)) fs.unlinkSync(path.join(OUT, f));
  wc.session.on('will-download', (_e, item) => item.setSavePath(path.join(OUT, item.getFilename())));
  console.log('window content size: ' + win.getContentSize().join('×') + ', screen work area: ' + JSON.stringify(require('electron').screen.getPrimaryDisplay().workAreaSize));
  await win.loadURL('file://' + PAGE + '?demo');
  try { await run(); }
  catch (err) { check('harness crashed', false, err.stack); }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  app.exit(failed.length ? 1 : 0);
});
