// Stops an audition before the app quits. Quitting during a Live Preview (capture, type 150) or a library IR preview
// (158) used to drop the Bluetooth link and leave the pedal to time out the audition. No Electron in here: src/main.js
// wires it to 'before-quit' and the window's 'close' (closing the window quits the app), and the UX test drives it
// with the real editor page and a fake app.
//
//   isAuditioning()  → what the editor page last reported (nanoShell.auditionState), synchronously
//   stopAuditions()  → a promise from the page (window.__stopAuditionsForQuit): { active, ok }; it sends the stop (148)
//                      and waits for the pedal's confirmation (149)
//   quit()           → quit for real (app.quit())
//   log(line)        → one Activity line per held quit (QUIT_LINES, word for word the native edition's)
//
// intercept(event): while nothing is auditioned it does nothing. Otherwise it holds the quit (event.preventDefault()),
// asks the page to stop, and quits once the page has answered or capMs have passed, whichever comes first, so a pedal
// that doesn't answer, or a page that is gone, never blocks quitting. A quit or close while that runs is held as well;
// once it has run, every later quit goes through.

const QUIT_CAP_MS = 1500;
const QUIT_LINES = Object.freeze({
  stopped: (ms) => 'Quit: stopped the preview first (the pedal confirmed in ' + Math.round(ms) + ' ms).',
  notConfirmed: 'Quit: the pedal did not confirm stopping the preview; quitting anyway.',
  timedOut: (capMs) => 'Quit: the pedal did not answer the preview stop within ' + (capMs / 1000).toFixed(1) + ' s; quitting anyway.',
});

function createQuitGuard({ isAuditioning, stopAuditions, quit, log = () => {}, timers = { setTimeout, clearTimeout }, now = Date.now, capMs = QUIT_CAP_MS }) {
  let phase = 'idle';   // 'stopping' while the page stops the audition, then 'done'

  const auditioning = () => { try { return !!isAuditioning(); } catch { return false; } };

  // Stops the audition (capped), writes the line, then runs next(), once. A refused stop, a page that is gone and a
  // pedal that answers too late all end in a quit; the line says which.
  function stopThen(next) {
    phase = 'stopping';
    const t0 = now();
    let timer = null;
    const capped = new Promise((resolve) => { timer = timers.setTimeout(() => resolve({ active: true, ok: false, timedOut: true }), capMs); });
    const asked = Promise.resolve()
      .then(() => stopAuditions())
      .then((r) => r || { active: true, ok: false }, (err) => ({ active: true, ok: false, error: String((err && err.message) || err) }));
    return Promise.race([asked, capped]).then((r) => {
      timers.clearTimeout(timer);
      if (r.active !== false) log(r.ok ? QUIT_LINES.stopped(now() - t0) : r.timedOut ? QUIT_LINES.timedOut(capMs) : QUIT_LINES.notConfirmed);
      phase = 'done';
      try { next(); } catch (err) { log('Quitting failed: ' + ((err && err.message) || err)); }
      return r;
    });
  }

  // 'before-quit' and the window's 'close'. true when this quit is held.
  function intercept(event) {
    if (phase === 'done') return false;
    if (phase === 'stopping') { event.preventDefault(); return true; }   // ⌘Q again, or the close that follows
    if (!auditioning()) return false;
    event.preventDefault();
    stopThen(quit);
    return true;
  }

  // The update modal's Restart: the updater quits by itself, so the audition is stopped first, then next() runs it.
  function beforeRestart(next) {
    if (phase === 'stopping') return Promise.resolve(null);   // a quit is already on its way
    if (phase === 'done' || !auditioning()) { phase = 'done'; next(); return Promise.resolve(null); }
    return stopThen(next);
  }

  return { intercept, beforeRestart, get phase() { return phase; } };
}

module.exports = { createQuitGuard, QUIT_CAP_MS, QUIT_LINES };
