// The application menu as a template (no Electron in here, so the UX test can check it). With Developer tools off
// (Settings → General → Advanced) View has no Classic Editor, Reload Current or Developer Tools; Help → Show Log File
// is there for everyone.
//   a: { show(tab), toggleClassic(), reload(), toggleDevTools(), openSettings(), openLink(key), showLogFile(), checkForUpdates() }
function menuTemplate({ isMac, appName, devTools, editorFlavor, links, a }) {
  const settingsItem = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', enabled: editorFlavor === 'pro', click: a.openSettings };
  const devItems = devTools ? [
    { type: 'separator' },
    { label: 'Classic Editor', type: 'checkbox', checked: editorFlavor === 'classic', click: a.toggleClassic },
    { type: 'separator' },
    { label: 'Reload Current', accelerator: 'CmdOrCtrl+R', click: a.reload },
    { label: 'Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: a.toggleDevTools },
  ] : [];
  return [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: 'about' }, { type: 'separator' }, settingsItem, { type: 'separator' },
        { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    isMac ? { role: 'editMenu' } : {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' }, { type: 'separator' }, settingsItem,
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Editor', accelerator: 'CmdOrCtrl+1', click: () => a.show('editor') },
        { label: 'Cortex Cloud', accelerator: 'CmdOrCtrl+2', click: () => a.show('cloud') },
        ...devItems,
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Manual', click: () => a.openLink(links.manual) },
        { label: 'GitHub Repository', click: () => a.openLink(links.repo) },
        { label: 'Report an Issue', click: () => a.openLink(links.issues) },
        { label: 'Show Log File', click: a.showLogFile },
        { type: 'separator' },
        { label: 'Check for Updates…', click: a.checkForUpdates },
        { label: 'Support the Project…', click: () => a.openLink(links.support) },
      ],
    },
  ];
}

// Every label in a template, depth first (for tests and the dev remote).
const menuLabels = (items) => items.flatMap(i => [i.label || i.role || (i.type === 'separator' ? '-' : '?'), ...(i.submenu ? menuLabels(i.submenu) : [])]);

module.exports = { menuTemplate, menuLabels };
