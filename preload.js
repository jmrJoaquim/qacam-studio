const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  // Fontes e sistema
  getSources: () => ipcRenderer.invoke('get-sources'),
  getDiskInfo: () => ipcRenderer.invoke('get-disk-info'),
  onSystemStats: (callback) =>
    ipcRenderer.on('system-stats', (_event, stats) => callback(stats)),

  // Gravação em disco (os pedaços são gravados durante a captura)
  recStart: () => ipcRenderer.invoke('rec-start'),
  recChunk: (arrayBuffer) => ipcRenderer.invoke('rec-chunk', arrayBuffer),
  recFinish: (defaultName) => ipcRenderer.invoke('rec-finish', defaultName),
  recDiscard: () => ipcRenderer.invoke('rec-discard'),
  showInFolder: (filePath) => ipcRenderer.send('show-in-folder', filePath),

  // Atalho global (Ctrl+Shift+R)
  onToggleRecording: (callback) =>
    ipcRenderer.on('toggle-recording', () => callback()),

  // Transcrição local
  trInit: (opts) => ipcRenderer.invoke('tr-init', opts),
  trSegment: (segment) => ipcRenderer.send('tr-segment', segment),
  onTranscribeEvent: (callback) =>
    ipcRenderer.on('tr-event', (_event, msg) => callback(msg)),
  saveTranscript: (videoPath, text) => ipcRenderer.invoke('save-transcript', videoPath, text),
  saveTranscriptAs: (defaultName, text) => ipcRenderer.invoke('save-transcript-as', defaultName, text),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // Janela
  setTitleBarTheme: (theme) => ipcRenderer.send('set-titlebar-theme', theme)
});
