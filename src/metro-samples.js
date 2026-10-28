// Custom metronome samples (Settings → Metronome → Sounds), the shell's side. No Electron here: main.js passes the
// folder and the file dialog, the UX test a temporary folder and a stub dialog.
//
// The page never names a path. It asks for a role; this side shows the dialog, checks and reads the file, and hands
// the page the bytes. Only after the page has decoded them does `save` copy them (the bytes read here, not a path
// from the page) to <dir>/<role>.<ext>, so a rejected pick never replaces a working sample. `load` returns the stored
// copy of one role, `reset` deletes it, `discard` forgets a pick the page rejected.
const fs = require('fs');
const path = require('path');

const ROLES = ['accent', 'main', 'sub'];
const LABELS = { accent: 'Accent', main: 'Main beat', sub: 'Subdivision' };
// What Chromium's decodeAudioData reads on macOS, Windows and Linux alike (Electron 38: WAV, MP3, AAC/M4A, FLAC,
// Ogg Vorbis and Opus; checked on all three), plus AIFF, which Chromium can't decode and pro/ui.js reads itself
// (uncompressed only). ALAC inside .m4a doesn't decode either; the page rejects it like any other unreadable file.
const EXTS = ['wav', 'aif', 'aiff', 'aifc', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus'];
const FILTERS = [{ name: 'Audio', extensions: EXTS }];
const MAX_BYTES = 5 * 1024 * 1024;

// dir: the samples folder (created on the first save). choose(role, { title, filters }): resolves to a file path, or
// null when cancelled.
function createMetroSamples({ dir, choose, log = () => {} }) {
  const pending = new Map();   // role → { name, ext, bytes }: picked, not yet accepted by the page
  const extOf = (file) => path.extname(file).slice(1).toLowerCase();
  const storedFiles = (role) => {
    try { return fs.readdirSync(dir).filter(f => path.parse(f).name === role && EXTS.includes(extOf(f))); }
    catch { return []; }
  };
  const removeStored = (role) => { for (const f of storedFiles(role)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* gone */ } } };

  async function pick(role) {
    pending.delete(role);
    const file = await choose(role, { title: 'Custom sample: ' + LABELS[role], filters: FILTERS });
    if (!file) return { canceled: true };
    const name = path.basename(file), ext = extOf(file);
    if (!EXTS.includes(ext)) return { error: 'type', name };
    let size;
    try { size = (await fs.promises.stat(file)).size; } catch { return { error: 'read', name }; }
    if (size > MAX_BYTES) return { error: 'size', name, size };
    let bytes;
    try { bytes = await fs.promises.readFile(file); } catch { return { error: 'read', name }; }
    pending.set(role, { name, ext, bytes });
    return { name, ext, bytes };
  }
  async function save(role) {
    const p = pending.get(role);
    if (!p) return { error: 'nothing' };
    pending.delete(role);
    const file = role + '.' + p.ext;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      removeStored(role);
      await fs.promises.writeFile(path.join(dir, file), p.bytes);
    } catch (err) { log('could not copy ' + p.name + ': ' + err.message); return { error: 'write', name: p.name }; }
    log(LABELS[role] + ': ' + p.name + ' copied to ' + file);
    return { ok: true, name: p.name, file };
  }
  async function load(role) {
    const f = storedFiles(role)[0];
    if (!f) return { missing: true };
    try {
      const file = path.join(dir, f);
      if ((await fs.promises.stat(file)).size > MAX_BYTES) return { error: 'size', file: f };
      return { ext: extOf(f), file: f, bytes: await fs.promises.readFile(file) };
    } catch { return { missing: true }; }
  }
  function reset(role) {
    pending.delete(role);
    removeStored(role);
    return { ok: true };
  }
  // The one entry point (IPC 'metro-sample'): op is pick | save | load | reset | discard, role one of ROLES.
  async function handle(op, role) {
    if (!ROLES.includes(role)) return { error: 'role' };
    if (op === 'pick') return pick(role);
    if (op === 'save') return save(role);
    if (op === 'load') return load(role);
    if (op === 'reset') return reset(role);
    if (op === 'discard') { pending.delete(role); return { ok: true }; }
    return { error: 'op' };
  }
  return { handle, dir, storedFiles };
}

module.exports = { createMetroSamples, ROLES, LABELS, EXTS, FILTERS, MAX_BYTES };
