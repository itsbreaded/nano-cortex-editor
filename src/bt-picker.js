// Picks the device for the editor page's navigator.bluetooth.requestDevice(). Electron has no picker of its own:
// src/main.js hands every 'select-bluetooth-device' event to onSelect(), and the chooser is drawn by the editor page
// (pro/ui.js, "Bluetooth chooser"). No Electron in here, so the UX test drives it with fake devices.
//
// Rules (issue #15):
//  • A device is remembered (settings.json `pedal`) only once the editor has found the Nano's services and
//    characteristics on it: the page reports 'ok'. Picking a device is not enough.
//  • A device that answers without the Nano's service is never picked automatically again this session, and if it
//    was the remembered one it is forgotten. The chooser then opens again.
//  • Scans start as 'nano' scans: the page filters requestDevice() on the Nano's services (A002/A003), so only
//    devices that advertise them are listed, and the first one is taken. 'all' (every device nearby) is the fallback,
//    offered in the chooser; a pedal found that way is remembered with via: 'all' and later scans start there.
//  • The chooser lists every device seen, Nano-like names first, then unnamed devices, then the rest, then the ones
//    that already failed the service check. It keeps updating while it is open and never cuts the list short.

const NANO_LIKE = /nano|cortex|ndsp|neural/i;           // sorted first
const NANO_NAME = /nano\s*cortex|neural\s*dsp|ndsp/i;   // the pedal ("Neural DSP Nano Cortex"): picked without asking
const SCAN_MS = 60000;      // Chromium scans this long per requestDevice() (BluetoothDeviceChooserController)
const CHOOSER_MS = 1500;    // a scan runs this long before the chooser opens
const AUTO_MS = 5000;       // reconnect at launch: how long to look for the remembered pedal

// Chromium names a device without a name after its address ("Unknown or Unsupported Device (AA:BB:…)"), or leaves
// it empty. Either way it is unnamed here.
function realName(name, id) {
  name = String(name || '').trim();
  return !name || (id && name.includes(id)) ? '' : name;
}

// The chooser's order. Ties keep the order in which devices were first seen, so rows don't jump around.
function sortDevices(devices, { remembered = null, notNano = new Set() } = {}) {
  const rank = (d) => (notNano.has(d.id) ? 3 : d.id === remembered || NANO_LIKE.test(d.name) ? 0 : !d.name ? 1 : 2);
  return devices
    .map((d, i) => ({ d, i, r: rank(d) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ d }) => ({ id: d.id, name: d.name, nano: NANO_LIKE.test(d.name), remembered: d.id === remembered, notNano: notNano.has(d.id) }));
}

// store: { get() → pedal | null, set(pedal | null) }, the remembered pedal { id, name, at, via }.
// show(view): draw, update or close ({ open: false }) the chooser. view.native: the page has no chooser (Classic
//   Editor), so the shell shows its own.
// hint(name): tell the page why a request is about to be cancelled (returns a promise).
// connectAgain(opts): start a new request from the page, with a user gesture.
function createBluetoothPicker({ store, show, hint = async () => {}, connectAgain = () => {}, log = () => {},
  timers = { setTimeout, clearTimeout }, now = Date.now, chooserMs = CHOOSER_MS, autoMs = AUTO_MS, scanMs = SCAN_MS }) {
  let next = null;            // what the page said about the request it is about to make
  let req = null;             // the request being answered
  let chosen = null;          // the device handed to the page, until the page says how connecting went
  const notNano = new Set();  // devices that answered without the Nano's service, this session

  // The page calls this (synchronously) right before requestDevice(). Returns the scan mode it should use.
  function beginRequest({ want = null, auto = false, choose = false, notice = '' } = {}) {
    if (req && !req.done) finish(req, '');   // a request the page abandoned (reloaded mid-scan)
    const pedal = store.get();
    const mode = want === 'all' || want === 'nano' ? want : pedal && pedal.via === 'all' ? 'all' : 'nano';
    next = { mode, auto: !!auto, choose: !!choose, notice: notice === 'not-nano' ? 'not-nano' : '', native: false };
    chosen = null;
    return mode;
  }

  function start(opts) {
    const r = { ...opts, callback: null, seen: new Map(), done: false, open: false, scanning: true, timers: [] };
    const later = (fn, ms) => r.timers.push(timers.setTimeout(fn, ms));
    if (r.auto) {
      // Reconnect at launch takes only the remembered pedal and never shows a chooser.
      later(async () => { if (r.done) return; await hint('auto-none'); finish(r, ''); }, autoMs);
    } else {
      later(() => openChooser(r), r.choose ? 0 : chooserMs);
      later(() => { r.scanning = false; if (r.open && !r.done) push(r); }, scanMs);
    }
    log('scan started (' + r.mode + (r.auto ? ', at launch' : '') + ')');
    return r;
  }

  // Every 'select-bluetooth-device' event: the full list so far and a callback that takes a deviceId ('' cancels).
  function onSelect(devices, callback) {
    if (!req || req.done) {
      // No word from the page (the Classic Editor has no chooser): every device, in the shell's own dialog.
      req = start(next || { mode: 'all', auto: false, choose: false, notice: '', native: true });
      next = null;
    }
    const r = req;
    r.callback = callback;
    let changed = false;
    for (const d of devices || []) {
      const id = String(d.deviceId || '');
      if (!id) continue;
      const name = realName(d.deviceName, id);
      const had = r.seen.get(id);
      if (!had) { r.seen.set(id, { id, name }); changed = true; }
      else if (name && had.name !== name) { had.name = name; changed = true; }
    }
    const pick = autoPick(r);
    if (pick) { finish(r, pick, 'auto'); return; }
    if (changed && r.open) push(r);
  }

  function autoPick(r) {
    const pedal = store.get();
    const ok = [...r.seen.values()].filter(d => !notNano.has(d.id));
    const mine = pedal && ok.find(d => d.id === pedal.id);
    if (mine) return mine.id;
    if (r.auto) return null;
    // A 'nano' scan lists only devices that advertise the Nano's service.
    const named = ok.find(d => NANO_NAME.test(d.name));
    if (r.mode === 'nano') return (named || ok[0] || {}).id || null;
    return named ? named.id : null;
  }

  function view(r) {
    const pedal = store.get();
    return {
      open: true, mode: r.mode, scanning: r.scanning, notice: r.notice, native: r.native,
      devices: sortDevices([...r.seen.values()], { remembered: pedal && pedal.id, notNano }),
    };
  }
  function push(r) { show(view(r)); }
  function openChooser(r) {
    if (r.done || r.open) return;
    r.open = true;
    log('chooser opened (' + r.seen.size + ' device' + (r.seen.size === 1 ? '' : 's') + ' so far)');
    push(r);
  }

  function finish(r, id, how = 'user') {
    if (r.done) return;
    r.done = true;
    r.timers.forEach(t => timers.clearTimeout(t));
    if (r.open) show({ open: false });
    const d = id ? r.seen.get(id) : null;
    chosen = d ? { id: d.id, name: d.name, via: r.mode } : null;
    log(d ? 'picked ' + (d.name || 'an unnamed device') + ' (' + how + ', ' + r.mode + ' scan, ' + r.seen.size + ' seen)' : 'request ended without a device');
    if (r.callback) r.callback(d ? d.id : '');
  }

  // The page's chooser: a deviceId, or anything else to cancel ('' / 'rescan' / 'all': the page starts the next scan).
  function choose(choice) {
    if (!req || req.done) return false;
    finish(req, req.seen.has(choice) ? choice : '');
    return true;
  }

  // The page, once connecting is over: 'ok' (C304/C305 found), 'no-service' (the device has no Nano service),
  // 'failed' (anything else, nothing learned) or 'cancelled'.
  function result(kind) {
    const c = chosen;
    chosen = null;
    if (req && !req.done && kind !== 'ok') finish(req, '');   // the request ended on the page's side: close the chooser
    if (!c) return { remembered: false, forgot: false };
    if (kind === 'ok') {
      notNano.delete(c.id);
      store.set({ id: c.id, name: c.name || 'Nano Cortex', at: new Date(now()).toISOString(), via: c.via });
      log('remembered ' + (c.name || 'the pedal') + ' (' + c.via + ' scan)');
      return { remembered: true, forgot: false };
    }
    if (kind === 'no-service') {
      notNano.add(c.id);
      const pedal = store.get();
      const forgot = !!(pedal && pedal.id === c.id);
      if (forgot) store.set(null);
      log((c.name || 'an unnamed device') + ' has no Nano Cortex service' + (forgot ? '; forgot it' : '') + '; choosing again');
      connectAgain({ want: c.via, choose: true, notice: 'not-nano' });
      return { remembered: false, forgot };
    }
    return { remembered: false, forgot: false };
  }

  return {
    beginRequest, onSelect, choose, result,
    get pending() { return !!(req && !req.done); },
    get chosen() { return chosen; },
    notNano,
  };
}

module.exports = { createBluetoothPicker, sortDevices, realName, NANO_LIKE, NANO_NAME, SCAN_MS, CHOOSER_MS, AUTO_MS };
