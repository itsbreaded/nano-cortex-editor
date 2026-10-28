// The app's outside links, in one place: the editor page loads this as a script (window.NANO_LINKS) and the main
// process requires it for the Help menu and the About panel. Every one of them opens in the default browser,
// never inside the app.
(function (root) {
  const REPO = 'https://github.com/AJs-Creations/nano-cortex-editor';
  const MANUAL = REPO + '/blob/main/docs/MANUAL.md';
  const NANO_LINKS = Object.freeze({
    version: '1.2.1',   // keep in step with package.json (the UX test checks)
    repo: REPO,
    releases: REPO + '/releases',
    manual: MANUAL,
    troubleshooting: MANUAL + '#15-troubleshooting',
    issues: REPO + '/issues/new/choose',
    license: REPO + '/blob/main/LICENSE',
    mac: 'https://github.com/AJs-Creations/nano-cortex-editor-mac',
    support: 'https://buymeacoffee.com/ajscreations',
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = NANO_LINKS;
  else root.NANO_LINKS = NANO_LINKS;
})(typeof window !== 'undefined' ? window : globalThis);
