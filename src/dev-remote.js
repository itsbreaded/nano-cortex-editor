'use strict';

// Rules for the dev remote (NANO_DEV_PORT, from source only; see startDevRemote in main.js). No Electron in here,
// so the UX test can run them: who may talk to the remote, and where /shot may write.
//
// The remote listens on 127.0.0.1, but a web page in any browser on this Mac can still make the browser call it
// (`<img src>`, a no-cors `fetch`, a text/plain POST to /eval) or point its own domain at 127.0.0.1 (DNS rebinding).
// curl and the test harnesses send none of the headers a browser adds, so they are the callers that stay.

const fs = require('fs');
const os = require('os');
const path = require('path');

// A browser attaches Origin to cross-origin and POST requests and the Sec-Fetch-* family to every request it makes,
// image loads and no-cors fetches included. A script cannot remove them. The page cannot set them either.
const BROWSER_HEADERS = ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

function header(headers, name) {   // case-insensitive; undefined when absent
  for (const key of Object.keys(headers || {})) if (key.toLowerCase() === name) return headers[key];
  return undefined;
}

// True for a plain local client (curl, a script); false for anything a browser sent or any other Host name.
function devRemoteRequestAllowed(headers, port) {
  for (const name of BROWSER_HEADERS) if (header(headers, name) !== undefined) return false;
  const host = header(headers, 'host');
  return typeof host === 'string' && ['127.0.0.1:' + port, 'localhost:' + port].includes(host.toLowerCase());
}

// Answers the request itself when it is refused (403, JSON), and says so; the caller returns on true.
function refuseBrowserRequest(req, res, port) {
  if (devRemoteRequestAllowed(req.headers, port)) return false;
  res.statusCode = 403;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: false, error: 'browser requests are refused' }));
  return true;
}

// ---------------------------------------------------------------- /shot?file=

// The deepest part of `p` that exists, resolved through symlinks, plus the rest as written.
function realish(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); }
    catch (err) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = up;
    }
  }
}

function inside(root, target) {
  const rel = path.relative(realish(root), target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The folders /shot may write into: test-output/ and docs/images/ of this checkout, and the OS temp folder
// (plus /tmp, which on macOS is not the same folder as the per-user one).
function shotRoots(repoRoot, tmpDir = os.tmpdir()) {
  const roots = [path.join(repoRoot, 'test-output'), path.join(repoRoot, 'docs', 'images'), tmpDir];
  if (process.platform !== 'win32') roots.push('/tmp');
  return roots;
}

// The absolute path to write for `file` (relative paths start at the repo root), or null when it is not a .png
// inside one of the roots. Symlinks are followed first, so a link inside test-output/ cannot lead out of it.
function devShotPath(file, repoRoot, roots = shotRoots(repoRoot)) {
  if (typeof file !== 'string' || !file || file.includes('\0')) return null;
  if (!file.toLowerCase().endsWith('.png')) return null;
  const target = realish(path.resolve(repoRoot, file));
  try { if (fs.lstatSync(target).isSymbolicLink()) return null; } catch { /* not there yet: fine */ }   // a dangling link would still be followed by the write
  return roots.some((root) => inside(root, target)) ? target : null;
}

module.exports = { devRemoteRequestAllowed, refuseBrowserRequest, devShotPath, shotRoots, BROWSER_HEADERS };
