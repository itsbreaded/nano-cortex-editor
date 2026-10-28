// Regenerates the screenshots in docs/images/ for the README and the manual.
//   npm run docs:screenshots            (macOS; a Retina screen gives 2× images)
// Everything runs on demo data in a throwaway session: no pedal, no network, nothing of yours is read or written.
// Each image is cropped to the elements it documents. The Cortex Cloud website itself is never captured; only our
// own toolbar strip is. scripts/docs-images.py then composes the hero image and trims empty space.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.OUT || path.join(ROOT, 'docs', 'images');
const RAW = process.env.RAW || path.join(ROOT, 'test-output', 'docs-raw'); // git-ignored
fs.mkdirSync(RAW, { recursive: true });
const MOD = process.platform === 'darwin' ? 'meta' : 'control';
const W = 1400, H = 900;
fs.mkdirSync(OUT, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nano-docs-user-')));

// Stand-ins for the shell's IPC (src/main.js), so Settings renders as in the app.
ipcMain.handle('settings-get', () => ({ platform: process.platform, accent: '#6954ff', dockFollowsAccent: true, pedal: null, recordingsDir: '~/Downloads' }));
ipcMain.handle('set-accent', () => null);
ipcMain.handle('forget-pedal', () => true);
ipcMain.handle('reveal-recordings', () => true);
ipcMain.handle('auto-connect', () => false);
ipcMain.handle('set-dev-tools', (_e, on) => !!on);
ipcMain.handle('open-external', () => false);

let win, wc;
app.on('window-all-closed', () => {}); // the toolbar window closes before the editor opens
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const js = (code) => wc.executeJavaScript(code);
const frame = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');

async function box(sel) {
  const r = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return {x: b.left + b.width/2, y: b.top + b.height/2}; })()`);
  if (!r) throw new Error('No element for ' + sel);
  return r;
}
async function click(sel, button = 'left') {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
  await sleep(80); await frame();
}
const rightClick = (sel) => click(sel, 'right');
async function drag(sel, dy) {
  const b = await box(sel);
  const x = Math.round(b.x), y = Math.round(b.y);
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 12; i++) { wc.sendInputEvent({ type: 'mouseMove', x, y: Math.round(y - (dy * i) / 12), button: 'left' }); await sleep(12); }
  wc.sendInputEvent({ type: 'mouseUp', x, y: Math.round(y - dy), button: 'left', clickCount: 1 });
  await sleep(80); await frame();
}
async function key(keyCode, modifiers = []) {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (keyCode.length === 1 && !modifiers.includes(MOD)) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await sleep(60); await frame();
}
async function type(text) { for (const ch of text) { wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(8); } await frame(); }
const ctxItem = (label) => `[...document.querySelectorAll(".ctx-item")].find(b => b.textContent.startsWith(${JSON.stringify(label)}))`;
const hideToast = () => js('document.getElementById("toast").classList.remove("show"); 0');

// Capture the union of the selectors' boxes plus padding, clamped to the window.
async function shot(name, sels, pad = 12, target = wc) {
  await target.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); await sleep(150);
  let rect;
  if (sels) {
    rect = await target.executeJavaScript(`(() => { const r = ${JSON.stringify([].concat(sels))}.flatMap(s => [...document.querySelectorAll(s)].slice(0, 1)).map(e => e.getBoundingClientRect()).filter(b => b.width && b.height);
      if (!r.length) return null; const l = Math.min(...r.map(b => b.left)), t = Math.min(...r.map(b => b.top)), R = Math.max(...r.map(b => b.right)), B = Math.max(...r.map(b => b.bottom));
      const x = Math.max(0, Math.floor(l - ${pad})), y = Math.max(0, Math.floor(t - ${pad}));
      return { x, y, width: Math.min(innerWidth, Math.ceil(R + ${pad})) - x, height: Math.min(innerHeight, Math.ceil(B + ${pad})) - y }; })()`);
    if (!rect) throw new Error('Nothing to capture for ' + name + ': ' + sels);
  }
  const img = await target.capturePage(rect);
  const file = name.startsWith('_') ? path.join(RAW, name + '.png') : path.join(OUT, name + '.png');
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote ' + file);
}

async function toolbarShots() {
  const tb = new BrowserWindow({ width: W, height: 44, useContentSize: true, show: true, webPreferences: { preload: path.join(ROOT, 'src', 'toolbar-preload.js'), contextIsolation: true, sandbox: true } });
  await tb.loadFile(path.join(ROOT, 'src', 'toolbar.html'));
  const t = tb.webContents;
  t.send('accent', '#6954ff'); t.send('tab-changed', 'editor'); await sleep(200);
  await shot('_toolbar-editor', null, 0, t);
  t.send('tab-changed', 'cloud');
  t.send('cloud-nav', { canGoBack: true, canGoForward: false, captureId: '00000000-0000-4000-8000-000000000001', pageKind: 'capture' });
  await sleep(200);
  await shot('cloud-toolbar', null, 0, t);
  tb.destroy();
}

async function run() {
  await sleep(800); await hideToast();
  // The real pointer may sit over the new window (a hovered preset row in the first shot); park the page's own at an empty spot.
  wc.sendInputEvent({ type: 'mouseMove', x: 600, y: 760 }); await sleep(100); await frame();
  await shot('_editor-full');
  await shot('header', '.head', 0);
  await shot('sidebar', '.side', 0);
  await shot('chain', '.chain-wrap', 0);
  await shot('inspector-capture', '#inspector', 0);
  await shot('status-bar', '.status', 0);
  await shot('tempo', '.tempo-ctl', 10);
  await shot('footswitches', '.fs-strip', 0);

  // footswitch menu
  await rightClick('[data-fk="fs-b2"]');
  await shot('footswitch-menu', ['.fs-strip', '.ctx'], 8);
  await key('Escape');

  // stages
  await key('1'); await shot('inspector-gate', '#inspector', 0);
  // Cab / IR: wait for the pedal library ("From the library" reads "Reading the pedal library…" until it arrives).
  await key('5');
  await js('requestLibraryContent(); new Promise(r => { const t0 = Date.now(); const f = () => (state.library.loaded || Date.now() - t0 > 6000) ? r() : setTimeout(f, 100); f(); })'); await sleep(300);
  await shot('inspector-cab', '#inspector', 0);
  await click('[data-stage="post2"] .model'); await shot('inspector-fx', '#inspector', 0);
  await key('m'); await sleep(100);
  await shot('effect-picker', ['.pop', '[data-stage="post2"]'], 12);
  await key('Escape');

  // chain node menu
  await rightClick('[data-stage="post2"] .model');
  await shot('node-menu', ['[data-stage="post2"]', '.ctx'], 12);
  await key('Escape');

  // capture: library picker, slot menu, capture info
  await key('4');
  await click('[data-fk="lib-capture"]'); await sleep(300);
  await shot('library-picker', '.pop', 12);
  await key('Escape');
  await rightClick('[data-fk="capslot-3"]');
  await shot('slot-menu', ['[data-fk="capslot-3"]', '.ctx'], 12);
  await js(ctxItem('Info') + '?.click()'); await sleep(300);
  await shot('capture-info', ['[data-fk="capslot-3"]', '.pop.cap-info'], 12);
  await key('Escape');

  // preset row menu, rename, delete
  await rightClick('.preset-row[data-n="3"]');
  await shot('preset-menu', ['.preset-row[data-n="3"]', '.ctx'], 12);
  await key('Escape');
  await click('#renameBtn'); await sleep(100);
  await shot('rename', '.modal', 16);
  await key('Escape');
  await rightClick('.preset-row[data-n="3"]');
  await js(ctxItem('Delete') + '?.click()'); await sleep(150);
  await shot('delete', '.modal', 16);
  await key('Escape');

  // edits: dirty header, discard, save as, unsaved prompt
  await click('.preset-row[data-n="2"]'); await sleep(300); await key('4'); await hideToast();
  await drag('[data-fk="amp-gain"] svg', 40); await hideToast();
  await shot('header-dirty', '.head', 0);
  await shot('knob', '[data-fk="amp-gain"]', 14);
  await click('#discardBtn'); await sleep(100);
  await shot('discard', '.modal', 16);
  await key('Escape');
  await key('s', [MOD, 'shift']); await sleep(150);
  await shot('save-as', '.modal', 16);
  await key('Escape');
  await key('Down', [MOD]); await sleep(150);
  await shot('unsaved-prompt', '.modal', 16);
  await key('Escape');

  // expression
  await click('#expBtn'); await sleep(250);
  await click('[data-fk="exp-add"]'); await sleep(80);
  { const i = await js('[...document.querySelectorAll(".pop-item")].findIndex(e => e.textContent.startsWith("Pre FX 1 on/off"))'); if (i >= 0) await click(`.pop-item[data-i="${i}"]`); await sleep(150); }
  await hideToast();
  await shot('expression', ['.chain-wrap', '#inspector'], 0);
  await key('4');

  // tuner
  await key('t'); await sleep(500);
  await shot('tuner', '#tunerOverlay .tuner-card', 16);
  await key('Escape');

  // metronome
  await key('n'); await sleep(150);
  await shot('metronome-simple', '#metroOverlay .tuner-card', 16);
  await click('[data-fk="metro-mode-advanced"]'); await sleep(100);
  await click('[data-fk="metro-sub-2"]'); await sleep(80);
  await click('[data-fk="metro-ramp"]'); await click('[data-fk="metro-gap"]'); await sleep(80);
  await shot('metronome-trainers', '#metroOverlay .tuner-card', 16);
  await click('[data-fk="metro-levels"]'); await sleep(100);
  await shot('metronome-levels', ['#metroOverlay .tuner-card', '.levels-pop'], 16);
  await key('Escape'); await key('Escape');

  // settings
  await js('void __openSettings()'); await sleep(250);
  await shot('settings-general', '.modal', 16);
  // the bottom of General: Advanced with the Developer tools switch (off, as on a fresh install)
  await js('document.querySelectorAll(".modal *").forEach(e => { if (e.scrollHeight > e.clientHeight + 4) e.scrollTop = e.scrollHeight; }); 0'); await sleep(150);
  await shot('settings-advanced', '.modal', 16);
  await key('Escape');
  await js('void __openSettings("device")'); await sleep(350);
  await shot('settings-device', '.modal', 16);
  await key('Escape');
  await js('void __openSettings("about")'); await sleep(250);
  await shot('settings-about', '.modal', 16);
  await key('Escape');

  // activity (a developer tool: taken with Developer tools on, then back to normal) + shortcuts
  await js('__devTools.set(true); 0'); await sleep(100);
  await key('l', [MOD]); await sleep(300); await hideToast();
  await shot('activity', ['.drawer', '.status'], 0);
  await key('l', [MOD]); await sleep(200);
  await js('__devTools.set(false); 0'); await sleep(100);
  await js('document.activeElement.blur()');
  await key('?'); await sleep(150);
  await shot('shortcuts', '.modal', 16);
  await key('Escape');

  // Send to Nano Cortex: the confirmation in the editor (a made-up capture, never a real Cortex Cloud item)
  const meta = { hash: 'ab'.repeat(32), name: 'Example Capture', cloudUUID: '00000000-0000-4000-8000-000000000001', authorId: 'x', authorName: 'Example Author', deviceType: 'amp_head', gainType: 3, instrumentType: 'guitar', version: '1', tags: [] };
  await js('window.__p = __uploadCapture({ cns: btoa("x".repeat(64)), meta: ' + JSON.stringify(meta) + ' }); 0'); await sleep(200);
  await shot('send-confirm', '.modal', 16);
  await key('Escape'); await sleep(200);

  // connect screen
  await click('#connectBtn'); await sleep(250);
  await shot('connect', '.veil-card', 16);
}

app.whenReady().then(async () => {
  await toolbarShots();
  win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, enableLargerThanScreen: true, backgroundColor: '#121212',
    webPreferences: { preload: path.join(ROOT, 'src', 'editor-preload.js'), contextIsolation: true, sandbox: true, partition: 'docs-shots', backgroundThrottling: false } });
  wc = win.webContents;
  await win.loadFile(path.join(ROOT, 'pro', 'index.html'), { search: 'demo' }).catch((err) => console.log('load: ' + err.message));
  let code = 0;
  try { await run(); } catch (err) { console.error(err); code = 1; }
  app.exit(code);
});
