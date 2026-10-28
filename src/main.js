// Nano Cortex Editor — desktop shell
//
// Two views in one window:
//   • Editor: the community BLE editor (editor/index.html), unchanged, running in
//     Chromium so Web Bluetooth + Web MIDI work natively.
//   • Cortex Cloud: Neural DSP's own website, so you sign in on their real login
//     page with your own account. The app never sees or stores your password;
//     the session cookie lives in a persistent Chromium profile (encrypted with
//     the macOS Keychain by Chromium itself).

const { app, BaseWindow, WebContentsView, session, shell, ipcMain, dialog, Menu, nativeImage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { renderAccentIcon, normHex, DEFAULT_ACCENT } = require('./accent-icon');
const LINKS = require('../pro/links');   // repo, manual, issues, support: the same constants the editor page uses
const { storedDescription } = require('../pro/capture-text');   // "null" / blank = no description, as in the page
const { menuTemplate, menuLabels } = require('./menu');
const { createActivityLog } = require('./activity-log');
const { randomUUID } = require('crypto');
const { decodeIRPayload, checkWav } = require('./cloud-ir');
const { refuseBrowserRequest, devShotPath } = require('./dev-remote');

// Capture pages live under /cloud/discover/… and under pack pages like /cloud/<pack>/…
const CAPTURE_PAGE = /\/neural-capture\/view\/([0-9a-f-]{36})/i;
const CLOUD_IR_PAGE = /^\/cloud\/profile\/impulses\/?$/i;
const CLOUD_PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOUD_API_CLIENT_HEADERS = Object.freeze({
  'X-Cloud-Api-Client-Type': 'web-cloud',
  'X-Cloud-Api-Client-Version': '1.0.0'
});

const CLOUD_URL = 'https://cloud.neuraldsp.com/cloud/';
const CLOUD_PARTITION = 'persist:cortex-cloud';
const TOOLBAR_HEIGHT = 44;

// Dev remote: lets a terminal drive the editor during hardware sessions.
//   NANO_DEV_PORT=4848 npm start
//   curl -d 'state.selectedPreset' http://127.0.0.1:4848/eval   → runs JS in the editor page
//   curl 'http://127.0.0.1:4848/log?since=0'                    → mirrored Activity log
// Localhost only, off unless the variable is set, never in a packaged build. Requests a browser made (an Origin or
// Sec-Fetch-* header, or a Host other than 127.0.0.1:<port> / localhost:<port>) get a 403, and /shot writes only .png
// files inside test-output/, docs/images/ or the temp folder (src/dev-remote.js).
const DEV_PORT = app.isPackaged ? 0 : Number(process.env.NANO_DEV_PORT || 0);
const devLog = [];

// Hosts the Cloud tab may navigate to. Sign-in may bounce through Neural DSP's
// account pages, so allow the whole neuraldsp.com family; everything else opens
// in your default browser.
const isCloudHost = (url) => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'neuraldsp.com' || hostname.endsWith('.neuraldsp.com'));
  } catch { return false; }
};

// Add a pedal transfer action to each item on the account's own IR list. The
// Cloud page is a React app; its rendered list component retains the same
// product records that came from the account-list API, including productId.
// If Neural DSP changes that page structure, the enhancement quietly stops
// adding buttons while the official Cloud page continues to work normally.
const CLOUD_IR_ACTION_SCRIPT = String.raw`(() => {
  if (window.__nanoCloudIRActions) return;
  const style = document.createElement('style');
  style.id = 'nano-cloud-ir-actions-style';
  style.textContent = '.nano-cloud-ir-row{position:relative!important;padding-right:126px!important}.nano-cloud-ir-send{position:absolute!important;right:8px!important;top:50%!important;transform:translateY(-50%)!important;z-index:5!important;padding:6px 10px!important;border:1px solid #7766ff!important;border-radius:6px!important;background:#6954ff!important;color:#fff!important;font:600 12px/1.2 system-ui,sans-serif!important;white-space:nowrap!important;cursor:pointer!important}.nano-cloud-ir-send:hover{filter:brightness(1.12)!important}.nano-cloud-ir-send:disabled{opacity:.62!important;cursor:wait!important}.nano-cloud-ir-send.nano-cloud-ir-on-nano:disabled{opacity:.9!important;cursor:default!important;background:#252333!important;border-color:#5d5683!important;color:#d5d0ff!important}';
  document.documentElement.appendChild(style);

  const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function productEntries(row) {
    const fiberKey = Object.keys(row).find(key => key.startsWith('__reactFiber'));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
      const entries = fiber.memoizedProps && fiber.memoizedProps.entries;
      if (Array.isArray(entries) && entries.length && entries.every(item => item && item.productId && item.name)) return entries;
    }
    return null;
  }
  function itemName(row) {
    const input = row.querySelector('input[type="checkbox"]');
    return String(input && input.name || '').replace(/\s+checkbox$/i, '').trim();
  }
  function scan() {
    if (!/^\/cloud\/profile\/impulses\/?$/i.test(location.pathname)) return;
    const rows = [...document.querySelectorAll('main li input[type="checkbox"]')]
      .map(input => input.closest('li')).filter(Boolean);
    const lists = new Map();
    for (const row of rows) {
      if (!lists.has(row.parentElement)) lists.set(row.parentElement, []);
      lists.get(row.parentElement).push(row);
    }
    for (const [list, listRows] of lists) {
      const entries = productEntries(listRows[0]);
      if (!entries) continue;
      for (const row of listRows) {
        const name = itemName(row);
        if (!name) continue;
        const rowIndex = [...list.children].indexOf(row);
        let entry = entries[rowIndex];
        if (!entry || entry.name !== name) {
          const occurrence = listRows.slice(0, listRows.indexOf(row) + 1).filter(item => itemName(item) === name).length - 1;
          entry = entries.filter(item => item.name === name)[occurrence];
        }
        if (!entry || entry.name !== name || !idPattern.test(String(entry.productId))) continue;
        let button = row.querySelector(':scope > .nano-cloud-ir-send');
        if (button && button.dataset.productId === String(entry.productId)) continue;
        if (button) button.remove();
        row.classList.add('nano-cloud-ir-row');
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'nano-cloud-ir-send';
        button.textContent = 'Send to Nano';
        button.title = 'Send ' + name + ' to the Nano Cortex IR library';
        button.setAttribute('aria-label', 'Send ' + name + ' to Nano Cortex');
        button.dataset.productId = String(entry.productId);
        button.addEventListener('click', async event => {
          event.preventDefault();
          event.stopPropagation();
          if (button.disabled) return;
          button.disabled = true;
          button.textContent = 'Sending…';
          button.title = 'Fetching and sending ' + name;
          try {
            if (!window.nanoCloudActions || !window.nanoCloudActions.sendImpulseResponse) throw new Error('The Nano Cortex Editor action is unavailable.');
            const result = await window.nanoCloudActions.sendImpulseResponse(String(entry.productId), name);
            if (result && result.alreadyOnNano) {
              button.textContent = 'On Nano';
              button.classList.add('nano-cloud-ir-on-nano');
              button.title = (result.name || name) + ' is already in the Nano Cortex IR library.';
              button.setAttribute('aria-label', (result.name || name) + ' is already on Nano Cortex');
            } else if (result && result.ok && result.refreshed) {
              button.textContent = 'On Nano';
              button.classList.add('nano-cloud-ir-on-nano');
              button.title = (result.name || name) + ' is now in the Nano Cortex IR library.';
              button.setAttribute('aria-label', (result.name || name) + ' is on Nano Cortex');
            } else if (result && result.ok) {
              button.disabled = false;
              button.textContent = 'Sent';
              button.title = name + ' was sent; refresh the pedal library if it is not visible yet.';
              setTimeout(() => { if (button.isConnected) { button.textContent = 'Send to Nano'; } }, 3000);
            } else if (result && result.cancelled) {
              button.disabled = false;
              button.textContent = 'Cancelled';
              setTimeout(() => { if (button.isConnected) button.textContent = 'Send to Nano'; }, 1800);
            } else {
              throw new Error(result && result.error || 'The IR was not sent.');
            }
          } catch (error) {
            button.disabled = false;
            button.textContent = 'Retry';
            button.title = error && error.message || 'The IR was not sent.';
          }
        });
        row.appendChild(button);
      }
    }
  }
  let scheduled = false;
  const scheduleScan = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  };
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.__nanoCloudIRActions = { observer, scan };
  scan();
})();`;

function isCloudIRPage(url) {
  try { return CLOUD_IR_PAGE.test(new URL(url || '').pathname); } catch { return false; }
}

function injectCloudIRActions() {
  if (!cloud || cloud.webContents.isDestroyed() || !isCloudIRPage(cloud.webContents.getURL())) return;
  cloud.webContents.executeJavaScript(CLOUD_IR_ACTION_SCRIPT, true).catch(() => {});
}

// Name and About panel. From source the process is still Electron.app, so the
// Dock keeps Electron's name and icon tooltip; the packaged app (npm run dist)
// carries the real name, bundle id, icon and usage strings from package.json.
app.setName('Nano Cortex Editor');
app.setAboutPanelOptions({
  applicationName: 'Nano Cortex Editor',
  applicationVersion: app.getVersion(),
  version: '',
  copyright: '© 2026 AJs Creations, MIT licence. Unofficial; not affiliated with or endorsed by Neural DSP.',
  credits: 'Protocol layer from the community Nano Cortex Editor (DrD85, MIT) and nano-cortex-web-editor (choldy, MIT). IBM Plex Sans (OFL).\n'
    + 'If this editor saves you time, you can buy me a coffee: ' + LINKS.support,
  iconPath: path.join(__dirname, '..', 'pro', 'assets', 'icon-512.png'),
});

// Web Bluetooth is on by default in Chromium on macOS/Windows; Linux needs this.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let win, toolbar, editor, cloud;
let active = 'editor';
const cloudIRTransfers = new Map();

// ---------- shell settings (userData/settings.json) ----------
// What the main process needs before the editor page has loaded: the accent (for the Dock icon), the
// remembered pedal, Developer tools (for the menu) and the update settings (checked at launch). Everything else
// lives in the editor page's localStorage.
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
let shellSettings = { accent: DEFAULT_ACCENT, dockFollowsAccent: true, pedal: null, devTools: false, autoUpdate: true, skippedVersion: null };
function loadShellSettings() {
  try { Object.assign(shellSettings, JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'))); } catch { /* defaults */ }
}
function saveShellSettings() {
  try { fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true }); fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(shellSettings, null, 1)); }
  catch (err) { console.log('[settings] could not save: ' + err.message); }
}

// Dock (macOS) / window (Windows, Linux) icon in the accent colour, rendered from assets/icon.svg and
// cached per colour under userData/icons/. Off: the stock icon.
const STOCK_ICON = path.join(__dirname, '..', 'pro', 'assets', 'icon-1024.png');
async function applyAppIcon() {
  let file = STOCK_ICON;
  if (shellSettings.dockFollowsAccent) {
    try { file = await renderAccentIcon(shellSettings.accent, path.join(app.getPath('userData'), 'icons')); }
    catch (err) { console.log('[icon] render failed: ' + err.message); }
  }
  if (!fs.existsSync(file)) return null;
  if (process.platform === 'darwin') {
    // A packaged build with the stock purple keeps its bundle icon; from source Electron's own icon is replaced.
    if (app.isPackaged && file === STOCK_ICON) return file;
    app.dock.setIcon(file);
  } else if (win && !win.isDestroyed()) {
    win.setIcon(nativeImage.createFromPath(file));
  }
  return file;
}

// Session recordings (Record in the status bar) default to the fixtures folder from source.
const recordingsDir = () => (app.isPackaged ? app.getPath('downloads') : path.join(__dirname, '..', 'test', 'fixtures', 'sessions'));

function layout() {
  const { width, height } = win.getContentBounds();
  toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  const body = { x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT };
  editor.setBounds(body);
  cloud.setBounds(body);
}

// cloudURL: a page to load in the Cloud tab as it is shown (capture Info → "Open in Cortex Cloud").
function show(tab, cloudURL = '') {
  active = tab;
  editor.setVisible(tab === 'editor');
  cloud.setVisible(tab === 'cloud');
  if (tab === 'cloud' && cloudURL) cloud.webContents.loadURL(cloudURL).catch(() => {});
  else if (tab === 'cloud' && cloud.webContents.getURL() === '') cloud.webContents.loadURL(CLOUD_URL);
  toolbar.webContents.send('tab-changed', tab);
}

// ---------- Bluetooth device picking ----------
// Web Bluetooth's requestDevice() normally shows Chrome's picker. Electron has none, so every scan result comes
// here and src/bt-picker.js decides: the remembered pedal or the first device advertising the Nano's service is
// taken at once, otherwise the editor page shows its chooser. A device is remembered only after the page has found
// the Nano's services on it (bt-result 'ok'); one without them is forgotten (issue #15).
const { createBluetoothPicker } = require('./bt-picker');
let btPicker = null;
const BT_HINT = 'Put the Nano Cortex in pairing mode: hold EXIT + CAPTURE for about a second, until the Gain ring lights up.';
function wireBluetooth(contents) {
  let nativeAbort = null;   // the shell's own chooser, for the Classic Editor (it has none)
  async function showNative(view) {
    if (!view.open) { if (nativeAbort) nativeAbort.abort(); return; }
    if (nativeAbort || !view.devices.length) return;   // a message box can't update; wait for a first device
    nativeAbort = new AbortController();
    const list = view.devices;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message: 'Choose your Nano Cortex', detail: BT_HINT, signal: nativeAbort.signal,
      buttons: [...list.map(d => d.name || 'Unnamed device (' + d.id + ')'), 'Cancel'], cancelId: list.length,
    }).catch(() => ({ response: -1 }));
    nativeAbort = null;
    btPicker.choose(response >= 0 && response < list.length ? list[response].id : '');
  }
  btPicker = createBluetoothPicker({
    store: { get: () => shellSettings.pedal, set: (pedal) => { shellSettings.pedal = pedal; saveShellSettings(); } },
    show: (view) => (view.native || (!view.open && nativeAbort) ? showNative(view) : contents.send('bt-chooser', view)),
    hint: (name) => contents.executeJavaScript('window.__bleHint = ' + JSON.stringify(name)).catch(() => {}),
    // A new requestDevice() needs a user gesture, which executeJavaScript can grant.
    connectAgain: (opts) => contents.executeJavaScript('window.__connectAgain && window.__connectAgain(' + JSON.stringify(opts) + ')', true).catch(() => {}),
    log: (msg) => { activityLog().write('[bluetooth] ' + msg); if (!app.isPackaged) console.log('[bluetooth] ' + msg); },
  });
  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    btPicker.onSelect(devices, callback);
  });
}

function grantDevicePermissions(ses) {
  const allowed = new Set(['bluetooth', 'midi', 'midiSysex']);
  // 'media' (audio only): the metronome's output picker needs microphone
  // permission once, because Chromium hides audio output names without it.
  const audioOnly = (details) => !details || !details.mediaTypes || details.mediaTypes.every(t => t === 'audio');
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) || (permission === 'media' && audioOnly(details))));
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) => allowed.has(permission) || (permission === 'media' && audioOnly(details)));
  ses.setDevicePermissionHandler(() => true);
  // Windows/Linux may ask for a pairing PIN confirmation; macOS handles pairing itself.
  if (ses.setBluetoothPairingHandler) {
    ses.setBluetoothPairingHandler((details, cb) => cb({ confirmed: true }));
  }
}

function createWindow() {
  win = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Nano Cortex Editor',
    backgroundColor: '#121212',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Windows and Linux: the window/taskbar icon (macOS takes it from the bundle or the Dock).
    ...(process.platform !== 'darwin' && fs.existsSync(STOCK_ICON) ? { icon: nativeImage.createFromPath(STOCK_ICON) } : {}),
  });

  // Toolbar
  toolbar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'toolbar-preload.js'), contextIsolation: true, sandbox: true }
  });
  toolbar.webContents.loadFile(path.join(__dirname, 'toolbar.html')).then(sendAccentToToolbar);

  // Editor (local file, needs BLE + MIDI)
  editor = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'editor-preload.js'), contextIsolation: true, sandbox: true, partition: 'persist:editor' }
  });
  grantDevicePermissions(editor.webContents.session);
  wireBluetooth(editor.webContents);
  editor.webContents.on('did-finish-load', () => { if (pendingUpdate && editorFlavor === 'pro') editor.webContents.send('update-event', pendingUpdate); });
  // A page that reloads, navigates or crashes auditions nothing any more (a new page reports changes from false on).
  editor.webContents.on('did-start-navigation', (details) => { if (details && details.isMainFrame && !details.isSameDocument) auditionActive = false; });
  editor.webContents.on('render-process-gone', () => { auditionActive = false; });
  loadEditor('pro');
  editor.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // The editor's Activity log goes to the log file for everyone (Help → Show Log File). Running from source it is
  // also mirrored to the terminal and kept for the dev remote's /log.
  editor.webContents.on('console-message', (e) => {
    const m = e.message ?? e.params?.message;
    if (m == null) return;
    activityLog().write(String(m));
    if (app.isPackaged) return;
    console.log('[editor] ' + m);
    devLog.push({ t: Date.now(), text: String(m) });
    if (devLog.length > 5000) devLog.splice(0, devLog.length - 5000);
  });
  if (DEV_PORT) startDevRemote();
  editor.webContents.session.on('will-download', (_e, item) => {
    const dir = recordingsDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = DEV_PORT ? path.join(dir, item.getFilename())
      : dialog.showSaveDialogSync(win, { defaultPath: path.join(dir, item.getFilename()) });
    if (file) item.setSavePath(file); else item.cancel();
    if (file) item.once('done', (_e, state) => console.log('[download] ' + state + ' ' + file));
  });

  // Cortex Cloud (their real website, persistent login, no device permissions)
  cloud = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'cloud-preload.js'), contextIsolation: true, sandbox: true, partition: CLOUD_PARTITION }
  });
  const cloudSes = session.fromPartition(CLOUD_PARTITION);
  cloudSes.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  cloud.webContents.on('will-navigate', (e, url) => {
    if (!isCloudHost(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  cloud.webContents.setWindowOpenHandler(({ url }) => {
    if (isCloudHost(url)) { cloud.webContents.loadURL(url); }
    else { shell.openExternal(url); }
    return { action: 'deny' };
  });
  // Downloads (captures, IRs, backups) go where you choose.
  cloudSes.on('will-download', (_e, item) => {
    const file = dialog.showSaveDialogSync(win, { defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    if (file) item.setSavePath(file); else item.cancel();
  });
  const pushNav = () => {
    const url = cloud.webContents.getURL();
    toolbar.webContents.send('cloud-nav', {
      canGoBack: cloud.webContents.navigationHistory.canGoBack(),
      canGoForward: cloud.webContents.navigationHistory.canGoForward(),
      captureId: captureIdOf(url),
      pageKind: captureIdOf(url) ? 'capture' : isCloudIRPage(url) ? 'impulse-responses' : /\/preset\/view\//.test(url) ? 'preset' : 'other'
    });
    injectCloudIRActions();
  };
  cloud.webContents.on('did-finish-load', pushNav);
  cloud.webContents.on('did-navigate', pushNav);
  cloud.webContents.on('did-navigate-in-page', pushNav);

  win.contentView.addChildView(editor);
  win.contentView.addChildView(cloud);
  win.contentView.addChildView(toolbar);
  win.on('resize', layout);
  // Closing the window quits the app: during an audition the close waits for the stop, like ⌘Q (quitGuard below).
  win.on('close', (e) => quitGuard.intercept(e));
  // Native content bounds can settle after show (e.g. Windows menus) without a window resize.
  win.contentView.on('bounds-changed', layout);
  layout();
  show('editor');
}

function startDevRemote() {
  require('http').createServer((req, res) => {
    if (refuseBrowserRequest(req, res, DEV_PORT)) return;   // before the body is read or anything runs
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      res.setHeader('Content-Type', 'application/json');
      try {
        const url = new URL(req.url, 'http://x');
        const target = url.searchParams.get('target') === 'cloud' ? cloud : editor;
        if (req.method === 'POST' && url.pathname === '/eval') {
          const value = await target.webContents.executeJavaScript(body, true);
          res.end(JSON.stringify({ ok: true, value: value === undefined ? null : value }));
        } else if (url.pathname === '/send-capture') {
          res.end(JSON.stringify(await sendCaptureToNano(url.searchParams.get('id'))));
        } else if (url.pathname === '/show') {
          show(url.searchParams.get('tab') === 'cloud' ? 'cloud' : 'editor');
          res.end(JSON.stringify({ ok: true, url: cloud.webContents.getURL() }));
        } else if (url.pathname === '/shot') {
          const file = devShotPath(url.searchParams.get('file') || path.join(app.getPath('temp'), 'nano-shot.png'), path.join(__dirname, '..'));
          if (!file) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'file must be a .png inside test-output/, docs/images/ or the temp folder' }));
            return;
          }
          const img = await target.webContents.capturePage();
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, img.toPNG());
          res.end(JSON.stringify({ ok: true, file, url: target.webContents.getURL() }));
        } else if (url.pathname === '/menu') {
          res.end(JSON.stringify({ devTools: shellSettings.devTools, labels: menuLabels(Menu.getApplicationMenu().items.map(function walk(i) { return { label: i.label, submenu: i.submenu ? i.submenu.items.map(walk) : null }; })) }));
        } else if (url.pathname === '/log') {
          const since = Number(url.searchParams.get('since') || 0);
          res.end(JSON.stringify({ next: devLog.length, lines: devLog.slice(since).map(l => l.text) }));
        } else { res.statusCode = 404; res.end('{}'); }
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
      }
    });
  }).listen(DEV_PORT, '127.0.0.1', () => console.log('[dev] remote on http://127.0.0.1:' + DEV_PORT));
}

// The pro UI (pro/) is the default; the original community UI (editor/) stays
// available from View → Classic Editor as a fallback.
let editorFlavor = 'pro';
function loadEditor(flavor) {
  editorFlavor = flavor;
  const file = flavor === 'classic' ? ['..', 'editor', 'index.html'] : ['..', 'pro', 'index.html'];
  editor.webContents.loadFile(path.join(__dirname, ...file));
  buildMenu();
}

// ---------- toolbar IPC ----------
ipcMain.on('show-tab', (_e, tab) => show(tab === 'cloud' ? 'cloud' : 'editor'));
ipcMain.on('cloud-cmd', (_e, cmd) => {
  const wc = cloud.webContents;
  if (cmd === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  if (cmd === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  if (cmd === 'reload') wc.reload();
  if (cmd === 'home') wc.loadURL(CLOUD_URL);
  if (cmd === 'irs') wc.loadURL(CLOUD_URL + 'profile/impulses');
});
ipcMain.on('editor-reload', () => editor.webContents.reload());

// ---------- editor settings IPC (src/editor-preload.js → window.nanoShell) ----------
const fromEditor = (e) => editor && e.sender === editor.webContents;
const fromCloud = (e) => cloud && e.sender === cloud.webContents;
const fromToolbar = (e) => toolbar && e.sender === toolbar.webContents;
ipcMain.handle('settings-get', (e) => (fromEditor(e) ? {
  platform: process.platform, accent: shellSettings.accent, dockFollowsAccent: shellSettings.dockFollowsAccent,
  pedal: shellSettings.pedal, recordingsDir: recordingsDir(), version: app.getVersion(), devTools: shellSettings.devTools,
  logFile: activityLog().file, autoUpdate: shellSettings.autoUpdate !== false, updates: !!updates,
} : null));
// Developer tools (Settings → General → Advanced): the page sends it on every change and at launch; the menu follows.
ipcMain.handle('set-dev-tools', (e, on) => {
  if (!fromEditor(e)) return null;
  on = !!on;
  if (on === shellSettings.devTools) return on;
  shellSettings.devTools = on;
  saveShellSettings();
  if (!on) {
    for (const v of [editor, cloud]) if (v && v.webContents.isDevToolsOpened()) v.webContents.closeDevTools();
    if (editorFlavor === 'classic') loadEditor('pro');   // Classic Editor is a developer view now
  }
  buildMenu();
  return on;
});
// Outside links from the editor page (manual, repo, support): only our own known https links, always in the
// default browser.
const OUTSIDE_HOSTS = new Set(['github.com', 'buymeacoffee.com']);
function openOutside(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && OUTSIDE_HOSTS.has(u.hostname)) { shell.openExternal(u.href); return true; }
  } catch { /* not a URL */ }
  return false;
}
ipcMain.handle('open-external', (e, url) => (fromEditor(e) ? openOutside(String(url)) : false));
// Capture Info → "Open in Cortex Cloud": a capture whose description is its Cortex Cloud product ID. Only a UUID is
// accepted, and only this page is loaded: CLOUD_URL + 'neural-capture/view/' + id, in the Cloud tab, which is shown.
ipcMain.handle('open-cloud-capture', (e, id) => {
  if (!fromEditor(e) || !cloud) return false;
  id = String(id || '').trim();
  if (!CLOUD_PRODUCT_ID.test(id)) return false;
  show('cloud', CLOUD_URL + 'neural-capture/view/' + id.toLowerCase());
  return true;
});
ipcMain.handle('set-accent', async (e, hex, follow) => {
  if (!fromEditor(e)) return null;
  const accent = normHex(hex);
  if (accent) shellSettings.accent = accent;
  if (typeof follow === 'boolean') shellSettings.dockFollowsAccent = follow;
  saveShellSettings();
  sendAccentToToolbar();
  return applyAppIcon();
});
// The tab toolbar is its own page: give it the accent (Send to Nano Cortex lights up in it when clickable).
function sendAccentToToolbar() { if (toolbar && !toolbar.webContents.isDestroyed()) toolbar.webContents.send('accent', shellSettings.accent || '#6954ff'); }
ipcMain.handle('forget-pedal', (e) => { if (!fromEditor(e)) return false; shellSettings.pedal = null; saveShellSettings(); return true; });
ipcMain.handle('reveal-recordings', async (e) => {
  if (!fromEditor(e)) return '';
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
// A recording stopped by turning Developer tools off: straight into the recordings folder, no dialog.
ipcMain.handle('save-recording', async (e, name, json) => {
  if (!fromEditor(e) || !/^nano-session-[\w-]+\.json$/.test(name)) return '';
  const file = path.join(recordingsDir(), name);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, json);
  console.log('[download] completed ' + file);
  return file;
});
// Reconnect at launch: requestDevice() needs a user gesture, which executeJavaScript can grant. The page then tells
// the picker (bt-request, auto) that this scan takes only the remembered pedal.
ipcMain.handle('auto-connect', async (e) => {
  if (!fromEditor(e) || !shellSettings.pedal) return false;
  await editor.webContents.executeJavaScript('window.__autoConnect && window.__autoConnect()', true).catch(() => {});
  return true;
});
// Bluetooth picker (src/bt-picker.js). bt-request is synchronous: the page sends it right before requestDevice(), so
// the picker knows the scan mode before the first 'select-bluetooth-device' event, and the reply is that mode.
ipcMain.on('bt-request', (e, opts) => {
  e.returnValue = fromEditor(e) && btPicker ? btPicker.beginRequest(opts && typeof opts === 'object' ? opts : {}) : null;
});
ipcMain.handle('bt-choose', (e, choice) => (fromEditor(e) && btPicker ? btPicker.choose(String(choice)) : false));
// How connecting to the picked device went: only 'ok' (the Nano's services and characteristics found) remembers it.
ipcMain.handle('bt-result', (e, kind) => (fromEditor(e) && btPicker ? btPicker.result(String(kind)) : null));
// Custom metronome samples (src/metro-samples.js): the dialog, the size check, the reads and the copy into
// userData/metronome-sounds/<role>.<ext> happen here; the page names only the operation and the role.
const { createMetroSamples } = require('./metro-samples');
let metroSamples = null;
ipcMain.handle('metro-sample', (e, op, role) => {
  if (!fromEditor(e)) return null;
  if (!metroSamples) {
    metroSamples = createMetroSamples({
      dir: path.join(app.getPath('userData'), 'metronome-sounds'),
      choose: async (_role, { title, filters }) => {
        const r = await dialog.showOpenDialog(win, { title, message: title, properties: ['openFile'], filters });
        return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
      },
      log: (m) => activityLog().write('[metronome] ' + m),
    });
  }
  return metroSamples.handle(String(op), String(role));
});
function openSettings() {
  show('editor');
  if (editorFlavor === 'pro') editor.webContents.send('open-settings');
}

// ---------- Cortex Cloud capture → pedal ----------
// "Send to Nano Cortex" on a capture page: fetch the capture bundle with the Cloud
// tab's own session, unpack it here, hand the .cns and its metadata to the
// editor page, which confirms and streams it to the pedal.
function captureIdOf(url) { const m = CAPTURE_PAGE.exec(url || ''); return m ? m[1] : null; }

// Minimal POSIX tar reader: returns { name: Buffer }.
function untar(buf) {
  const files = {};
  for (let off = 0; off + 512 <= buf.length;) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.toString('ascii', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = buf[off + 156];
    if (type === 0 || type === 0x30) files[path.basename(name)] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function fetchCaptureBundle(id) {
  const res = await cloud.webContents.session.fetch('https://cloud-api.neuraldsp.com/api/v1/products/' + id + '/download', {
    credentials: 'include', headers: CLOUD_API_CLIENT_HEADERS
  });
  if (!res.ok) throw new Error('Cortex Cloud answered ' + res.status + (res.status === 401 ? ' (not signed in?)' : ''));
  const json = await res.json();
  if (!json.payload) throw new Error('The reply has no capture payload.');
  const files = untar(zlib.gunzipSync(Buffer.from(json.payload, 'base64')));
  const cnsName = Object.keys(files).find(n => n.endsWith('.cns'));
  const jsonName = Object.keys(files).find(n => n.endsWith('.json'));
  if (!cnsName) throw new Error('No .cns file in the bundle (' + Object.keys(files).join(', ') + ').');
  const m = jsonName ? JSON.parse(files[jsonName].toString('utf8')) : {};
  return {
    cns: files[cnsName].toString('base64'),
    meta: {
      hash: m.hash || cnsName.replace(/\.cns$/, ''), name: m.name || json.name, cloudUUID: m.cloudUUID || id,
      authorId: m.authorId, authorName: m.authorName, description: storedDescription(m.description), deviceType: m.deviceType,
      tags: m.tags || [], gainType: m.gainType, instrumentType: m.instrumentType, version: m.version,
    },
  };
}

async function sendCaptureToNano(id) {
  id = id || captureIdOf(cloud.webContents.getURL());
  if (!id) return { ok: false, error: 'Open a capture page in Cortex Cloud first.' };
  try {
    const bundle = await fetchCaptureBundle(id);
    editor.webContents.send('capture-bundle', bundle);
    show('editor');
    return { ok: true, name: bundle.meta.name, bytes: Buffer.from(bundle.cns, 'base64').length };
  } catch (err) {
    dialog.showMessageBox(win, { type: 'warning', message: 'Could not fetch the capture', detail: err.message });
    return { ok: false, error: err.message };
  }
}
ipcMain.handle('send-capture', () => sendCaptureToNano());

function cloudIRFilename(name) {
  const base = String(name || 'cloud-impulse-response')
    .trim().replace(/[\\\/:*?"<>|]+/g, '_').replace(/[. ]+$/g, '').replace(/\.wav$/i, '').trim();
  return (base || 'cloud-impulse-response') + '.wav';
}

async function fetchCloudIRBundle(productId, listedName) {
  if (!CLOUD_PRODUCT_ID.test(String(productId || ''))) throw new Error('This Cloud IR has an invalid product ID.');
  const res = await cloud.webContents.session.fetch(
    'https://cloud-api.neuraldsp.com/api/v1/products/' + productId + '/download',
    { credentials: 'include', headers: CLOUD_API_CLIENT_HEADERS }
  );
  if (!res.ok) throw new Error('Cortex Cloud answered ' + res.status + (res.status === 401 ? ' (sign in to Cortex Cloud first)' : ''));
  let json;
  try { json = await res.json(); } catch { throw new Error('Cortex Cloud returned an unreadable IR download.'); }
  if (!json) throw new Error('The Cloud response has no IR payload.');
  if (json.id && String(json.id).toLowerCase() !== String(productId).toLowerCase()) throw new Error('Cortex Cloud returned a different product than the selected IR.');
  const wav = decodeIRPayload(json.payload);   // at most 1 MB
  checkWav(wav);                               // PCM or float, mono or stereo, 8–192 kHz, with audio data
  const name = String(json.name || listedName || 'Cloud impulse response').trim();
  return {
    wav: wav.toString('base64'),
    meta: { productId: String(productId), name, filename: cloudIRFilename(name) },
  };
}

function finishCloudIRTransfer(transferId, result) {
  const key = String(transferId || '');
  const pending = cloudIRTransfers.get(key);
  if (!pending) return false;
  clearTimeout(pending.timer);
  cloudIRTransfers.delete(key);
  pending.resolve({
    ok: !!(result && result.ok),
    cancelled: !!(result && result.cancelled),
    alreadyOnNano: !!(result && result.alreadyOnNano),
    refreshed: !!(result && result.refreshed),
    index: Number(result && result.index) || 0,
    name: String(result && result.name || '').slice(0, 256),
    error: String(result && result.error || '').slice(0, 500),
  });
  return true;
}

ipcMain.on('cloud-ir-transfer-complete', (event, transferId, result) => {
  if (fromEditor(event)) finishCloudIRTransfer(transferId, result);
});
// The editor reports when its confirmation dialog is open ('confirming': no timeout while the user decides) and when
// the transfer starts ('sending': three minutes from now).
const IR_TRANSFER_TIMEOUT = 3 * 60 * 1000;
function armCloudIRTimeout(transferId) {
  const pending = cloudIRTransfers.get(transferId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => finishCloudIRTransfer(transferId, {
    ok: false, error: 'The editor did not finish the IR transfer. Check its status and try again if needed.'
  }), IR_TRANSFER_TIMEOUT);
}
ipcMain.on('cloud-ir-transfer-status', (event, transferId, phase) => {
  const pending = fromEditor(event) && cloudIRTransfers.get(String(transferId || ''));
  if (!pending) return;
  if (phase === 'confirming') { clearTimeout(pending.timer); pending.timer = null; }
  else if (phase === 'sending') armCloudIRTimeout(String(transferId));
});

ipcMain.handle('send-cloud-ir', async (event, productId, listedName) => {
  const cloudURL = cloud && cloud.webContents.getURL();
  if (!fromCloud(event) || !isCloudHost(cloudURL) || !isCloudIRPage(cloudURL)) return { ok: false, error: 'Open your Cortex Cloud Impulse Responses page first.' };
  if (editorFlavor !== 'pro') return { ok: false, error: 'Switch to the Pro Editor to send an IR to the pedal.' };
  if (!CLOUD_PRODUCT_ID.test(String(productId || ''))) return { ok: false, error: 'This Cloud IR has an invalid product ID.' };
  if (!editor || editor.webContents.isDestroyed()) return { ok: false, error: 'The editor is not ready.' };

  let transferId = '';
  try {
    const bundle = await fetchCloudIRBundle(productId, listedName);
    transferId = randomUUID();
    const response = new Promise(resolve => cloudIRTransfers.set(transferId, { resolve, timer: null }));
    armCloudIRTimeout(transferId);
    editor.webContents.send('cloud-ir-bundle', { ...bundle, transferId });
    show('editor');
    return await response;
  } catch (err) {
    const error = String(err && err.message || err);
    if (transferId) finishCloudIRTransfer(transferId, { ok: false, error });
    return { ok: false, error };
  }
});

// Live audition uses the same Cloud bundle, but the editor sends it through
// the separate type-150 preview path instead of the normal type-13 library
// upload. Keep the editor hidden so the Cloud page remains visible while the
// pedal is auditioning the capture. Every refusal here tells the toolbar too,
// so its Live Preview button never sticks.
function previewRefused(error, { tell = true } = {}) {
  const pro = editorFlavor === 'pro' && editor && !editor.webContents.isDestroyed();
  if (pro) editor.webContents.executeJavaScript('window.__pushPreviewState && window.__pushPreviewState()', true).catch(() => {});
  else if (toolbar && !toolbar.webContents.isDestroyed()) toolbar.webContents.send('preview-state', { active: false, name: '', error: '', phase: 'idle' });
  if (tell) dialog.showMessageBox(win, { type: 'warning', message: 'Could not preview the capture', detail: error });
  return { ok: false, error };
}
async function previewCaptureOnNano(id) {
  if (editorFlavor !== 'pro' || !editor || editor.webContents.isDestroyed()) return previewRefused('Live Preview works in the Pro Editor. Switch back from the Classic Editor (View menu) first.');
  id = id || captureIdOf(cloud.webContents.getURL());
  if (!id) return previewRefused('Open a capture page in Cortex Cloud first.');
  try {
    const bundle = await fetchCaptureBundle(id);
    editor.webContents.send('preview-bundle', bundle);
    return { ok: true, name: bundle.meta.name, bytes: Buffer.from(bundle.cns, 'base64').length };
  } catch (err) {
    dialog.showMessageBox(win, { type: 'warning', message: 'Could not fetch the capture for preview', detail: err.message });
    return previewRefused(err.message, { tell: false });
  }
}
ipcMain.handle('preview-capture', (e) => (fromToolbar(e) ? previewCaptureOnNano() : { ok: false, error: 'Not allowed.' }));
ipcMain.handle('stop-preview', async (e) => {
  if (!fromToolbar(e) || !editor || editor.webContents.isDestroyed()) return false;
  return editor.webContents.executeJavaScript('window.__stopCapturePreview ? window.__stopCapturePreview() : false', true).catch(() => false);
});
ipcMain.handle('get-cab-ir-state', async (e) => {
  if (!fromToolbar(e) || !editor || editor.webContents.isDestroyed()) return { connected: false, on: false };
  return editor.webContents.executeJavaScript(
    'window.__getCabIRState ? window.__getCabIRState() : { connected: false, on: false }',
    true
  ).catch(() => ({ connected: false, on: false }));
});
ipcMain.handle('toggle-cab-ir', async (e) => {
  if (!fromToolbar(e)) return { ok: false, error: 'Not allowed.' };
  if (!editor || editor.webContents.isDestroyed()) return { ok: false, error: 'The editor is not ready.' };
  return editor.webContents.executeJavaScript(
    'window.__toggleCabIR ? window.__toggleCabIR() : { ok: false, error: \'The editor is not ready.\' }',
    true
  ).catch((err) => ({ ok: false, error: err.message }));
});
// ---------- auditions on quit (src/quit-guard.js) ----------
// The page reports whether anything is auditioned (a Live Preview or a library IR). ⌘Q, the menu's Quit or closing the
// window then waits until the page has sent the stop (148) and the pedal confirmed it (149), at most 1.5 s, and quits
// either way, with one "Quit: …" line in the Activity log. So does the update modal's Restart.
let auditionActive = false;
ipcMain.on('audition-state', (e, on) => { if (fromEditor(e)) auditionActive = !!on; });
const { createQuitGuard } = require('./quit-guard');
const quitGuard = createQuitGuard({
  isAuditioning: () => auditionActive && editorFlavor === 'pro' && !!editor && !editor.webContents.isDestroyed(),
  stopAuditions: () => editor.webContents.executeJavaScript('window.__stopAuditionsForQuit ? window.__stopAuditionsForQuit() : { active: false, ok: true }'),
  quit: () => app.quit(),
  log: (line) => { activityLog().write(line); if (!app.isPackaged) console.log('[quit] ' + line); },
});
app.on('before-quit', (e) => quitGuard.intercept(e));

ipcMain.on('preview-state', (event, state) => {
  if (editor && event.sender === editor.webContents && toolbar && !toolbar.webContents.isDestroyed()) {
    toolbar.webContents.send('preview-state', state || { active: false });
  }
});
ipcMain.on('cab-ir-state', (event, state) => {
  if (editor && event.sender === editor.webContents && toolbar && !toolbar.webContents.isDestroyed()) {
    toolbar.webContents.send('cab-ir-state', state || { connected: false, on: false });
  }
});

ipcMain.handle('sign-out', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Sign out', 'Cancel'], cancelId: 1,
    message: 'Sign out of Cortex Cloud?', detail: 'Clears the saved Cortex Cloud session from this app.'
  });
  if (response !== 0) return false;
  await session.fromPartition(CLOUD_PARTITION).clearStorageData();
  cloud.webContents.loadURL(CLOUD_URL);
  return true;
});

// ---------- updates (src/updates.js: electron-updater reading GitHub Releases) ----------
// Only in packaged builds: never from source and never in the UX test, which drives the page's modal itself.
// release.yml uploads the metadata electron-updater reads (latest-mac.yml, latest.yml, latest-linux*.yml) and the
// blockmaps with every release.
const { createUpdates, installMode } = require('./updates');
let updates = null;
let pendingUpdate = null;   // the offer, download or install the page hasn't answered yet: shown again after a reload
function sendUpdate(ev) {
  if (ev.type === 'available' || ev.type === 'progress' || ev.type === 'downloaded') pendingUpdate = ev;
  else if (ev.type === 'error') pendingUpdate = null;
  if (editor && !editor.webContents.isDestroyed()) editor.webContents.send('update-event', ev);
}
function startUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  const write = (level) => (m) => activityLog().write('[updater] ' + (level ? level + ': ' : '') + m);
  autoUpdater.logger = { info: write(''), warn: write('warn'), error: write('error'), debug: () => {} };
  updates = createUpdates({
    updater: autoUpdater,
    store: {
      get: () => ({ auto: shellSettings.autoUpdate !== false, skipped: shellSettings.skippedVersion || null }),
      set: (p) => {
        if ('auto' in p) shellSettings.autoUpdate = !!p.auto;
        if ('skipped' in p) shellSettings.skippedVersion = p.skipped;
        saveShellSettings();
      },
    },
    send: sendUpdate,
    openExternal: (url) => openOutside(url),
    currentVersion: app.getVersion(),
    mode: installMode(process.platform, process.env),
    releaseUrl: (v) => LINKS.releases + '/tag/v' + v,
    log: (m) => activityLog().write('[updates] ' + m),
  });
  updates.start();
}
// Help → Check for Updates…
function checkForUpdates() {
  show('editor');
  if (updates) updates.check(true);
  else sendUpdate({ type: 'error', message: 'Updates are checked only in the installed app.' });
}
ipcMain.handle('update-action', (e, what, version) => {
  if (!fromEditor(e)) return null;
  what = String(what);
  if (what !== 'download') pendingUpdate = null;
  if (!updates) return null;
  if (what === 'restart') return quitGuard.beforeRestart(() => updates.action(what, String(version || ''))).then(() => 'restarting');
  return updates.action(what, String(version || ''));
});
ipcMain.handle('set-auto-update', (e, on) => {
  if (!fromEditor(e)) return null;
  if (updates) return updates.setAuto(!!on);
  shellSettings.autoUpdate = !!on;
  saveShellSettings();
  return !!on;
});

// ---------- Activity log file (Help → Show Log File) ----------
let actLog = null;
function activityLog() {
  if (!actLog) {
    actLog = createActivityLog(path.join(app.getPath('logs'), 'nano-cortex-editor.log'));
    actLog.write('--- Nano Cortex Editor ' + app.getVersion() + ' started (' + process.platform + ' ' + process.arch + ', Electron ' + process.versions.electron + ')');
  }
  return actLog;
}
function showLogFile() { shell.showItemInFolder(activityLog().ensureFile()); }
app.on('will-quit', () => { if (actLog) actLog.flushSync(); });

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate({
    isMac: process.platform === 'darwin', appName: app.name, devTools: shellSettings.devTools, editorFlavor, links: LINKS,
    a: {
      show,
      toggleClassic: () => { loadEditor(editorFlavor === 'classic' ? 'pro' : 'classic'); show('editor'); },
      reload: () => (active === 'cloud' ? cloud : editor).webContents.reload(),
      toggleDevTools: () => (active === 'cloud' ? cloud : editor).webContents.toggleDevTools(),
      openSettings,
      openLink: (url) => shell.openExternal(url),
      showLogFile,
      checkForUpdates,
    },
  })));
}

// ---------- sleep and wake ----------
// Before the computer sleeps the editor disconnects from the pedal cleanly, so macOS has no link left to hold (a held
// link kept the pedal from advertising: 2026-10-20→23). On wake, if it was connected before the sleep, the page
// reconnects the remembered pedal like the launch reconnect (the user gesture requestDevice() needs comes from
// executeJavaScript); not tied to "Reconnect to the last pedal at launch", which stays launch-only (the native edition
// reconnects after any dropped link). Bluetooth needs a moment after wake, hence the delay.
const RESUME_RECONNECT_MS = 3000;
let resumeTimer = null;
function editorPage() { return editorFlavor === 'pro' && editor && !editor.webContents.isDestroyed() ? editor.webContents : null; }
function wirePower() {
  powerMonitor.on('suspend', () => {
    clearTimeout(resumeTimer); resumeTimer = null;
    activityLog().write('[power] the computer is going to sleep');
    const page = editorPage();
    if (page) page.executeJavaScript('window.__systemSuspend && window.__systemSuspend()', true).catch(() => {});
  });
  powerMonitor.on('resume', () => {
    activityLog().write('[power] the computer woke up');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      const page = editorPage();
      if (page) page.executeJavaScript('window.__systemResume && window.__systemResume(' + JSON.stringify({ pedal: !!shellSettings.pedal }) + ')', true).catch(() => {});
    }, RESUME_RECONNECT_MS);
  });
}

app.whenReady().then(() => {
  loadShellSettings();
  // Packaged builds get the icon from build/icon.icns; from source, set the Dock icon by hand.
  // The cached accent icon (if any) replaces it once rendered.
  if (!app.isPackaged && process.platform === 'darwin' && fs.existsSync(STOCK_ICON)) app.dock.setIcon(STOCK_ICON);
  buildMenu();
  createWindow();
  applyAppIcon();
  startUpdates();
  wirePower();
  app.on('activate', () => { if (!win || win.isDestroyed()) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
