// Narrow bridge for actions added to the signed-in Cortex Cloud page.
// The page can request a specific IR transfer; the main process validates the
// sender, route, product ID, and Cloud response before forwarding any bytes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nanoCloudActions', {
  sendImpulseResponse: (productId, name) => ipcRenderer.invoke(
    'send-cloud-ir', String(productId || ''), String(name || '')
  ),
});
