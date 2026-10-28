const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  platform: process.platform,
  showTab: (tab) => ipcRenderer.send('show-tab', tab),
  cloud: (cmd) => ipcRenderer.send('cloud-cmd', cmd),
  reloadEditor: () => ipcRenderer.send('editor-reload'),
  signOut: () => ipcRenderer.invoke('sign-out'),
  sendCapture: () => ipcRenderer.invoke('send-capture'),
  previewCapture: () => ipcRenderer.invoke('preview-capture'),
  stopPreview: () => ipcRenderer.invoke('stop-preview'),
  getCabIRState: () => ipcRenderer.invoke('get-cab-ir-state'),
  toggleCabIR: () => ipcRenderer.invoke('toggle-cab-ir'),
  onTab: (fn) => ipcRenderer.on('tab-changed', (_e, tab) => fn(tab)),
  onCloudNav: (fn) => ipcRenderer.on('cloud-nav', (_e, state) => fn(state)),
  onPreviewState: (fn) => ipcRenderer.on('preview-state', (_e, state) => fn(state)),
  onCabIRState: (fn) => ipcRenderer.on('cab-ir-state', (_e, state) => fn(state)),
  onAccent: (fn) => ipcRenderer.on('accent', (_e, hex) => fn(hex))
});
