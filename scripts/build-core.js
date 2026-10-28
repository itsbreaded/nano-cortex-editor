// Extracts the protocol layer from the upstream editor (editor/index.html) into
// pro/core.js, leaving the upstream UI behind. Re-run after updating
// editor/index.html from upstream:  npm run build:core
//
// How it works:
//   1. The largest <script> in the upstream page is parsed with acorn.
//   2. Starting from the functions the pro UI calls (ENTRY), every top-level
//      declaration they reference, transitively, is kept. Everything else
//      (upstream render code, DOM wiring, MIDI Learn, MC6 export, …) is dropped.
//      Top-level `state.x = …` initialisers are kept too.
//   3. `$` (upstream's getElementById helper) is replaced by a version that
//      returns a detached dummy element for ids the pro page doesn't have, so
//      stray UI touches inside protocol code can't throw.
//   4. HOOKS are the upstream functions the pro UI redefines on `window`
//      (render, log, toast, …). They must be plain function declarations in the
//      output, otherwise the override would not take effect inside core.js.
//   5. The result is evaluated once in a sandbox to catch load-time errors.
// It fails loudly whenever upstream moved or renamed something the UI needs.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const acorn = require('acorn');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'editor', 'index.html'), 'utf8');

// Everything pro/ui.js calls into (or that must exist for the protocol to run).
const ENTRY = [
  // connection + sync
  'state', 'MSG', 'FX_BLOCK_KEYS', '$', 'connectAll', 'disconnect', 'refreshLists', 'onC305',
  'syncMetadataAndState', 'requestCurrentPresetState', 'waitForPresetState',
  // presets
  'selectPreset', 'savePreset', 'renamePresetTo', 'presetChangeFrame', 'PRESET_CHANGE_ACK',
  // capture / cab
  'setCapture', 'selectCaptureSlot', 'selectCabIRSlot', 'setCaptureVolumeDb',
  'setCabIRLevelDb', 'setCabIRHighPassHz', 'setCabIRLowPassHz', 'setCabIRMicPosition', 'isFactoryCabIR',
  // library
  'requestLibraryContent', 'loadLibraryCapture', 'loadLibraryCab',
  // gate / fx / amp
  'setGateEnabled', 'setGateReduction', 'setFXModel', 'setFXBlockEnabled', 'setFXParam', 'setAmpKnob',
  'paramDisplayValue', 'isParamDisabled', 'roundToStep', 'clamp', 'FX_COLORS',
  // expression pedal assignments (60 read / 61 reply / 62 save); the panel itself is pro/ui.js
  'EXP_RANGES', 'EXP_BYPASS', 'EXP_MODES', 'defaultExpRange', 'defaultExpBypass',
  'requestExpAssignments', 'parseExpAssignments', 'decodeExpAssignments', 'expSaveFrame', 'resetExpRequests', 'writeC304',
  // tuner
  'openTuner', 'closeTuner', 'setTunerOption', 'tunerModeFrame', 'handleTunerMetering',
  // packet helpers (used by the demo mode and tests)
  'buildFrame', 'frameType', 'framePayloadFields', 'parseProtoFields', 'encodeVarint', 'float32LE', 'hex', 'bytesFromHex',
  // hooks the UI overrides
  'log', 'setStatus', 'setCaptureVolumeUI', 'render', 'renderPresetSelect', 'renderCaptureIR', 'renderCaptureIRExtraParams',
  'toast', 'showSaveResult', 'renderTunerReading', 'askText', 'askConfirm', 'showNotice', 'chooseSlot',
  'renderExpPanel', 'setExpStatus',
  // overridden or reached by pro/live-sync.js and pro/ui.js (live pedal sync, auditions, preset moves)
  'handleTypedMessage', 'parseBufferedCurrentState', 'beginPresetLoad', 'applyFXEnabledStatesFromCurrentState',
  'applyFXModelsFromCurrentState', 'handleFXParamRefreshResponse', 'requestNextFXParamRefresh', 'cancelFXParamRefresh',
  'handleCabinetSlotContentResponse', 'normalizedToParamValue', 'normaliseName', 'captureRawToDb', 'blockSlotConfig',
  'gattWriteQueue', 'gattWritePumpRunning', 'waitUntil', 'encodeInt32',
];

// Upstream functions the pro UI replaces on `window`. Must be function declarations.
const HOOKS = [
  'render', 'renderPresetSelect', 'renderCaptureIR', 'renderCaptureIRExtraParams',
  'log', 'setStatus', 'setCaptureVolumeUI', 'toast', 'showSaveResult', 'renderTunerReading',
  'askText', 'askConfirm', 'showNotice', 'chooseSlot', 'renderExpPanel', 'setExpStatus',
];

// ---------------------------------------------------------------- 1. parse
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!scripts.length) throw new Error('No <script> in upstream editor');
const src = scripts.reduce((a, b) => (b.length > a.length ? b : a));

let ast;
try {
  ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
} catch (err) {
  throw new Error('Upstream script does not parse: ' + err.message);
}

// ---------------------------------------------------------------- 2. reachability
function declaredNames(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return [node.id.name];
  if (node.type === 'VariableDeclaration') {
    const names = [];
    const collect = (p) => {
      if (p.type === 'Identifier') names.push(p.name);
      else if (p.type === 'ObjectPattern') p.properties.forEach(q => collect(q.type === 'RestElement' ? q.argument : q.value));
      else if (p.type === 'ArrayPattern') p.elements.forEach(q => q && collect(q.type === 'RestElement' ? q.argument : q));
      else if (p.type === 'AssignmentPattern') collect(p.left);
    };
    node.declarations.forEach(d => collect(d.id));
    return names;
  }
  return [];
}

// Identifier names referenced inside a node. Property names (`a.b`, `{ b: 1 }`)
// are not references, so they are skipped.
function references(node, out = new Set()) {
  if (!node || typeof node.type !== 'string') return out;
  if (node.type === 'Identifier') { out.add(node.name); return out; }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (node.type === 'MemberExpression' && key === 'property' && !node.computed) continue;
    if ((node.type === 'Property' || node.type === 'MethodDefinition' || node.type === 'PropertyDefinition') && key === 'key' && !node.computed) continue;
    if (node.type === 'LabeledStatement' && key === 'label') continue;
    if ((node.type === 'BreakStatement' || node.type === 'ContinueStatement') && key === 'label') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach(x => references(x, out));
    else if (v && typeof v.type === 'string') references(v, out);
  }
  return out;
}

const isStateInit = (node) =>
  node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
  node.expression.left.type === 'MemberExpression' &&
  (() => { let o = node.expression.left; while (o.type === 'MemberExpression') o = o.object; return o.type === 'Identifier' && o.name === 'state'; })();

const top = ast.body.map(node => ({ node, names: declaredNames(node), refs: references(node), stateInit: isStateInit(node) }));
const byName = new Map();
for (const t of top) for (const n of t.names) byName.set(n, t);

const missingEntry = ENTRY.filter(n => !byName.has(n));
if (missingEntry.length) throw new Error('Upstream layout changed: core needs these names but upstream no longer declares them: ' + missingEntry.join(', '));

const hookSet = new Set(HOOKS);
const keep = new Set();
const queue = [...ENTRY];
for (const t of top) if (t.stateInit) { keep.add(t); queue.push(...t.refs); }
while (queue.length) {
  const name = queue.pop();
  const t = byName.get(name);
  if (!t || keep.has(t)) continue;
  keep.add(t);
  // Hooks are replaced by the pro UI, so what their upstream bodies reference is not needed.
  if (!t.names.some(n => hookSet.has(n))) queue.push(...t.refs);
}

for (const h of HOOKS) {
  const t = byName.get(h);
  if (!t || t.node.type !== 'FunctionDeclaration') throw new Error(`Hook ${h} must be an upstream function declaration (the pro UI overrides it on window)`);
}

// ---------------------------------------------------------------- 3. patches
const patches = new Map();
const dollar = byName.get('$');
patches.set(dollar, `// patched by build-core.js: upstream UI code may touch ids the pro page doesn't have.
    // Unknown ids get a detached, hidden dummy element so nothing throws.
    const $ = (() => {
      const stubs = new Map();
      return id => document.getElementById(id) || stubs.get(id) || (stubs.set(id, Object.assign(document.createElement('div'), { hidden: true })), stubs.get(id));
    })();`);

// Hooks become empty declarations: the override point exists, the upstream UI body is gone.
for (const h of HOOKS) {
  const t = byName.get(h);
  if (t.names.length !== 1) throw new Error('Hook ' + h + ' shares a declaration with ' + t.names.join(', '));
  patches.set(t, `    function ${h}() { /* replaced by pro/ui.js */ }`);
}

// ---------------------------------------------------------------- 4. emit
const header = `// GENERATED by scripts/build-core.js from editor/index.html (upstream, MIT,
// github.com/DrD85/nano-cortex-editor). Do not edit by hand.\n`;
const pieces = [];
for (const t of top) {
  if (!keep.has(t)) continue;
  pieces.push(patches.get(t) || src.slice(t.node.start, t.node.end));
}
const out = header + pieces.join('\n\n') + '\n';

// Guarantees the desktop shell relies on.
if (/midiOutput|\.send\(\[0xC0/.test(out)) throw new Error('core.js sends MIDI; the pro UI expects preset switching over BLE only');
for (const h of HOOKS) if (!new RegExp('^\\s*function ' + h + '\\s*\\(', 'm').test(out)) throw new Error('core.js lost hook ' + h);

// ---------------------------------------------------------------- 5. sandbox load
const element = () => ({
  hidden: true, textContent: '', value: '', title: '', disabled: false, style: { setProperty() {} },
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  addEventListener() {}, appendChild() {}, append() {}, remove() {}, focus() {}, select() {},
  getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; },
});
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, DataView, Uint8Array, Float32Array,
  document: { getElementById: () => null, createElement: element, querySelector: () => null, querySelectorAll: () => [], body: element(), addEventListener() {} },
  navigator: { bluetooth: undefined, userAgent: 'sandbox', platform: 'sandbox' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { search: '' },
};
sandbox.window = sandbox;
try {
  vm.runInNewContext(out, sandbox, { filename: 'core.js' });
} catch (err) {
  throw new Error('Generated core.js fails to load: ' + err.stack);
}
for (const n of ['state', 'MSG']) if (typeof sandbox[n] !== 'object') {
  // `const` bindings don't land on the sandbox object; check via a probe instead.
  const probe = vm.runInNewContext(out + `\n;({ state, MSG });`, { ...sandbox });
  if (!probe.state || !probe.MSG) throw new Error('core.js is missing ' + n);
  break;
}

fs.writeFileSync(path.join(root, 'pro', 'core.js'), out);
const dropped = top.filter(t => !keep.has(t) && t.names.length).flatMap(t => t.names);
console.log(`pro/core.js written (${(out.length / 1024).toFixed(1)} KB): kept ${keep.size} of ${top.length} top-level statements; dropped ${dropped.length} declarations`);
if (process.env.CORE_VERBOSE) console.log('dropped: ' + dropped.join(', '));
