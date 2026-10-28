// Update notifications from GitHub Releases through electron-updater. No Electron in here: src/main.js passes the
// updater, the settings store and send() (to the editor page, which draws the modal), so the UX test drives it with
// a fake updater.
//
//  • Checks FIRST_MS after launch and every DAY_MS while "Check for updates automatically" is on, and on Help →
//    Check for Updates… (manual: it also says "up to date" or shows the error).
//  • An update is offered with three choices: download and install it, skip that version (never offered again by
//    the automatic checks; a newer one is), or be reminded later (the next scheduled check or launch asks again).
//  • Nothing downloads by itself (autoDownload off). Once the user has downloaded an update, it installs on
//    restart, or when the app quits if they chose Later (autoInstallOnAppQuit).
//  • mode 'install': the macOS zip (Squirrel.Mac, Developer ID builds), the Windows NSIS installer and the Linux
//    AppImage update themselves. mode 'notify': the Windows portable exe and the Linux deb only link to the release.

const FIRST_MS = 10 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Where an update can be installed by the app itself. electron-builder's portable launcher sets
// PORTABLE_EXECUTABLE_FILE and an AppImage runs with APPIMAGE set; anything else on Linux is the deb.
function installMode(platform, env) {
  if (platform === 'darwin') return 'install';
  if (platform === 'win32') return env.PORTABLE_EXECUTABLE_FILE ? 'notify' : 'install';
  return env.APPIMAGE ? 'install' : 'notify';
}

// GitHub's release feed gives the notes as HTML (or a list of { version, note }). The modal shows plain text: the
// first few lines, cut at `max` characters.
function notesExcerpt(notes, max = 360) {
  if (Array.isArray(notes)) notes = notes.map(n => (n && n.note) || '').join('\n');
  const text = String(notes || '')
    .replace(/<\s*hr\b[^>]*>/gi, '\n---\n')
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
  const lines = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (/^-{3,}$/.test(line)) break;   // the release body's footer (install notes, trademark) starts after a rule
    if (line) lines.push(line.replace(/^[-*] /, '• '));
  }
  let out = lines.join('\n');
  if (out.length > max) {
    const cut = out.lastIndexOf(' ', max - 1);
    out = out.slice(0, cut > max * 0.6 ? cut : max - 1).trimEnd() + '…';
  }
  return out;
}

// store: { get() → { auto, skipped }, set(patch) }. send(event): to the editor page. openExternal(url).
function createUpdates({ updater, store, send, openExternal, currentVersion, mode, releaseUrl, log = () => {},
  timers = { setTimeout, clearTimeout, setInterval, clearInterval }, firstMs = FIRST_MS, everyMs = DAY_MS }) {
  const st = { checking: false, manual: false, offered: null, downloading: false, downloaded: null, first: null, every: null };

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = mode === 'install';   // only ever installs what the user chose to download

  updater.on('update-available', (info) => {
    const version = String(info.version);
    if (!st.manual && store.get().skipped === version) { log('update ' + version + ' is available but skipped'); return; }
    st.offered = version;
    log('update ' + version + ' is available' + (st.manual ? ' (asked)' : ''));
    send({ type: 'available', version, current: currentVersion, notes: notesExcerpt(info.releaseNotes), url: releaseUrl(version), mode });
  });
  updater.on('update-not-available', () => { if (st.manual) send({ type: 'none', current: currentVersion }); });
  updater.on('download-progress', (p) => { if (st.downloading) send({ type: 'progress', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }); });
  updater.on('update-downloaded', (info) => {
    st.downloading = false;
    st.downloaded = String(info.version);
    log('update ' + st.downloaded + ' downloaded');
    send({ type: 'downloaded', version: st.downloaded });
  });
  // On macOS 'update-downloaded' comes when the zip is in; Squirrel.Mac checks its signature after that and can still
  // refuse it. So an error after the download means the update can't be installed: say so and offer nothing to restart.
  updater.on('error', (err) => {
    const message = String((err && err.message) || err).split('\n')[0];
    const during = st.downloading ? 'download' : st.downloaded ? 'install' : 'check';
    log('update error (' + during + '): ' + message);
    if (st.manual || during !== 'check') send({ type: 'error', message, during });
    st.downloading = false;
    st.downloaded = null;
  });

  async function check(manual = false) {
    if (st.downloaded) { if (manual) send({ type: 'downloaded', version: st.downloaded }); return; }
    if (st.downloading || st.checking) return;
    st.checking = true;
    st.manual = !!manual;
    if (manual) send({ type: 'checking' });
    try {
      const result = await updater.checkForUpdates();
      if (result == null && manual) send({ type: 'error', message: 'Updates are checked only in the installed app.' });
    } catch (err) {
      // The 'error' event has already told the page (manual checks only).
    } finally {
      st.checking = false;
      st.manual = false;
    }
  }

  // The modal's buttons.
  function action(what, version) {
    version = String(version || st.offered || '');
    if (what === 'download') {
      if (mode !== 'install') { openExternal(releaseUrl(version)); return 'opened'; }
      if (st.downloading || st.downloaded) return 'busy';
      st.downloading = true;
      log('downloading update ' + version);
      Promise.resolve(updater.downloadUpdate()).catch(() => { /* reported by the 'error' event */ });
      return 'downloading';
    }
    if (what === 'skip') { store.set({ skipped: version }); log('skipping update ' + version); return 'skipped'; }
    if (what === 'restart') { if (st.downloaded) updater.quitAndInstall(false, true); return 'restarting'; }
    return 'later';   // 'later': asked again at the next check; after a download it installs when the app quits
  }

  function schedule() {
    unschedule();
    if (!store.get().auto) return;
    st.first = timers.setTimeout(() => check(false), firstMs);
    st.every = timers.setInterval(() => check(false), everyMs);
  }
  function unschedule() {
    if (st.first) timers.clearTimeout(st.first);
    if (st.every) timers.clearInterval(st.every);
    st.first = st.every = null;
  }
  function setAuto(on) {
    store.set({ auto: !!on });
    if (on) { if (!st.every) schedule(); } else unschedule();
    return !!on;
  }

  return { start: schedule, stop: unschedule, check, action, setAuto, get state() { return { ...st }; } };
}

module.exports = { createUpdates, installMode, notesExcerpt, FIRST_MS, DAY_MS };
