// Bundles the pro UI into one self-contained page that runs on demo data, for
// previewing in a browser (no Bluetooth). Output: dist-preview/nano-cortex-editor.html
//   npm run build:preview

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const html = read('pro/index.html');
const css = read('pro/ui.css');
const core = read('pro/core.js');
const live = read('pro/live-sync.js');
const transfer = read('pro/transfer.js');
const ui = read('pro/ui.js');
const links = read('pro/links.js');
const text = read('pro/capture-text.js');

for (const [name, src] of [['core.js', core], ['live-sync.js', live], ['links.js', links], ['capture-text.js', text], ['transfer.js', transfer], ['ui.js', ui]]) {
  if (/<\/script/i.test(src)) throw new Error(name + ' contains "</script", which would break inlining');
}

// Body markup minus the external script tags.
const bodyStart = html.indexOf('<body>') + '<body>'.length;
const bodyEnd = html.indexOf('<script src="core.js">');
if (bodyStart < 6 || bodyEnd < 0) throw new Error('pro/index.html layout changed');
const body = html.slice(bodyStart, bodyEnd).trim();

const out = `<title>Nano Cortex Editor</title>
<style>
${css}
/* preview: single dark look, fill the frame */
:root { color-scheme: dark; }
html, body { background: var(--ws); }
</style>
${body}
<script>window.__FORCE_DEMO = true;</script>
<script>
${core}
</script>
<script>
${live}
</script>
<script>
${links}
</script>
<script>
${text}
</script>
<script>
${transfer}
</script>
<script>
${ui}
</script>
`;

fs.mkdirSync(path.join(root, 'dist-preview'), { recursive: true });
const file = path.join(root, 'dist-preview', 'nano-cortex-editor.html');
fs.writeFileSync(file, out);
console.log('wrote ' + path.relative(root, file) + ' (' + (out.length / 1024).toFixed(0) + ' KB)');
