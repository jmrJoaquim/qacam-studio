const {
  app, BrowserWindow, desktopCapturer, ipcMain, dialog,
  globalShortcut, session, shell, clipboard, net
} = require('electron');
const crypto = require('crypto');
const fsSync = require('fs');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let mainWindow = null;

function safeSend(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && !mainWindow.webContents.isCrashed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (err) {
    console.warn(`Não foi possível enviar "${channel}" para a janela:`, err.message);
  }
}
let statsTimer = null;

// Sessão de gravação atual: os pedaços vão sendo gravados num arquivo temporário,
// assim a memória não cresce durante gravações longas.
let rec = null; // { path, fh }
// Caminhos que o renderer pode pedir para abrir na pasta (somente os que salvamos).
const savedPaths = new Set();

/* ------------------------------------------------------------------ */
/* Janela                                                              */
/* ------------------------------------------------------------------ */
function createWindow() {
  const frameOptions = isWin
    ? {
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#0e0e13', symbolColor: '#e8e8ee', height: 48 }
      }
    : isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 16 } }
      : {};

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1120,
    minHeight: 700,
    title: 'QAcam Studio',
    backgroundColor: '#0b0b0f',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    ...frameOptions,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Essencial: sem isso, o canvas do modo "telas duplas" e o áudio
      // ficam congelados quando a janela do QAcam é minimizada.
      backgroundThrottling: false
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Se a página cair por qualquer motivo, registra o motivo e recarrega em vez de ficar uma janela preta
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('A janela parou de responder:', details.reason, 'código', details.exitCode);
    if (details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      }, 500);
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ------------------------------------------------------------------ */
/* Permissões: só mídia (microfone / captura)                          */
/* ------------------------------------------------------------------ */
function setupPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
}

/* ------------------------------------------------------------------ */
/* Métricas do sistema (CPU calculada por diferença entre amostras)    */
/* ------------------------------------------------------------------ */
function sampleCpu() {
  let idle = 0, total = 0;
  for (const core of os.cpus()) {
    for (const type in core.times) total += core.times[type];
    idle += core.times.idle;
  }
  return { idle, total };
}

function startStats() {
  let prev = sampleCpu();
  statsTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const cur = sampleCpu();
    const dTotal = cur.total - prev.total;
    const dIdle = cur.idle - prev.idle;
    prev = cur;
    const cpu = dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;

    const totalMem = os.totalmem();
    const ram = Math.round(((totalMem - os.freemem()) / totalMem) * 100);

    safeSend('system-stats', {
      cpu: Math.max(0, Math.min(100, cpu)),
      ram
    });
  }, 2000);
}

/* ------------------------------------------------------------------ */
/* Ciclo de vida                                                       */
/* ------------------------------------------------------------------ */
app.whenReady().then(() => {
  setupPermissions();
  createWindow();
  startStats();

  // Atalho global: iniciar / parar gravação mesmo com o app minimizado
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+R', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('toggle-recording');
      }
    });
    if (!ok) console.warn('Atalho global Ctrl+Shift+R já está em uso por outro programa.');
  } catch (err) {
    console.warn('Não foi possível registrar o atalho global:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (statsTimer) clearInterval(statsTimer);
  if (trWorker) trWorker.terminate();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* IPC: fontes de captura                                              */
/* ------------------------------------------------------------------ */
ipcMain.handle('get-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 240, height: 135 }
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      isScreen: source.id.startsWith('screen:'),
      thumbnail: source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : ''
    }));
  } catch (err) {
    console.error('Aviso: Não foi possível obter as fontes de captura:', err);
    return [];
  }
});

/* ------------------------------------------------------------------ */
/* IPC: espaço em disco                                                */
/* ------------------------------------------------------------------ */
ipcMain.handle('get-disk-info', async () => {
  try {
    const stats = await fs.statfs(app.getPath('videos'));
    return { freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch (err) {
    return { freeBytes: null };
  }
});

/* ------------------------------------------------------------------ */
/* IPC: gravação em disco (streaming para arquivo temporário)          */
/* ------------------------------------------------------------------ */
ipcMain.handle('rec-start', async () => {
  try {
    if (rec && rec.fh) { try { await rec.fh.close(); } catch (_) {} }
    const tempPath = path.join(app.getPath('temp'), `qacam-${Date.now()}.webm`);
    const fh = await fs.open(tempPath, 'w');
    rec = { path: tempPath, fh };
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rec-chunk', async (_event, arrayBuffer) => {
  if (!rec || !rec.fh) return { success: false, error: 'Nenhuma gravação ativa.' };
  try {
    await rec.fh.write(Buffer.from(arrayBuffer));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rec-finish', async (_event, defaultName) => {
  if (!rec) return { success: false, error: 'Nenhuma gravação ativa.' };
  const current = rec;
  rec = null;

  try {
    await current.fh.close();
  } catch (err) {
    return { success: false, error: err.message, tempPath: current.path };
  }

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar evidência de gravação',
    defaultPath: path.join(app.getPath('videos'), defaultName || 'Evidencia_QA.webm'),
    buttonLabel: 'Salvar',
    filters: [{ name: 'Vídeo WebM', extensions: ['webm'] }]
  });

  if (canceled || !filePath) {
    // Não perdemos a gravação: ela continua no arquivo temporário.
    savedPaths.add(current.path);
    return { success: false, canceled: true, tempPath: current.path };
  }

  try {
    await fs.copyFile(current.path, filePath);
    await fs.unlink(current.path).catch(() => {});
    savedPaths.add(filePath);
    return { success: true, path: filePath };
  } catch (err) {
    savedPaths.add(current.path);
    return { success: false, error: err.message, tempPath: current.path };
  }
});

ipcMain.handle('rec-discard', async () => {
  if (!rec) return { success: true };
  const current = rec;
  rec = null;
  try { await current.fh.close(); } catch (_) {}
  await fs.unlink(current.path).catch(() => {});
  return { success: true };
});

ipcMain.on('show-in-folder', (_event, filePath) => {
  if (typeof filePath === 'string' && savedPaths.has(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

/* ------------------------------------------------------------------ */
/* IPC: cor dos botões nativos da janela (acompanha o tema)            */
/* ------------------------------------------------------------------ */
ipcMain.on('set-titlebar-theme', (_event, theme) => {
  if (!isWin || !mainWindow || mainWindow.isDestroyed()) return;
  const hex = /^#[0-9a-f]{6}$/i;
  if (!theme || !hex.test(theme.color) || !hex.test(theme.symbolColor)) return;
  try {
    mainWindow.setTitleBarOverlay({ color: theme.color, symbolColor: theme.symbolColor, height: 48 });
    mainWindow.setBackgroundColor(theme.color);
  } catch (err) {
    console.warn('Não foi possível atualizar a barra de título:', err);
  }
});


/* ------------------------------------------------------------------ */
/* Transcrição local (Whisper em um worker_thread)                     */
/* ------------------------------------------------------------------ */
const TR_MODELS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small'
};
let trWorker = null;

function sendTrEvent(msg) {
  safeSend('tr-event', msg);
}

function getTrWorker() {
  if (trWorker) return trWorker;
  // Empacotado, o worker e os módulos nativos ficam em app.asar.unpacked
  const workerPath = path
    .join(__dirname, 'transcriber-worker.js')
    .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

  const worker = new Worker(workerPath);
  worker.on('message', sendTrEvent);
  worker.on('error', (err) => {
    sendTrEvent({ type: 'error', fatal: true, message: err.message });
    trWorker = null;
  });
  worker.on('exit', () => { if (trWorker === worker) trWorker = null; });
  trWorker = worker;
  return worker;
}

let trInitPromise = null;

ipcMain.handle('tr-init', async (_event, opts) => {
  try {
    const model = TR_MODELS[opts && opts.model] || TR_MODELS.base;
    const modelsDir = path.join(app.getPath('userData'), 'models');

    // Baixa (ou confere) os modelos e só então inicia o worker. Os trechos de áudio esperam por isso.
    const diarize = !!(opts && opts.diarize);
    const whisperShare = diarize ? ({ tiny: 0.28, base: 0.44, small: 0.71 }[opts.model] || 0.44) : 1;
    const language = ['pt', 'en', 'es', 'auto'].includes(opts && opts.language) ? opts.language : 'pt';
    const run = async () => {
      await ensureModel(model, modelsDir, (percent) => sendTrEvent({ type: 'progress', percent: Math.round(percent * whisperShare) }));

      let speakerModel = null;
      if (diarize) {
        try {
          await ensureModel(SPEAKER_MODEL, modelsDir,
            (percent) => sendTrEvent({ type: 'progress', percent: Math.round(whisperShare * 100 + percent * (1 - whisperShare)) }),
            SPEAKER_ONNX);
          speakerModel = SPEAKER_MODEL;
        } catch (err) {
          // Sem o modelo de vozes a transcrição continua, só não separa os convidados
          sendTrEvent({ type: 'warning', message: 'Identificação de convidados indisponível: ' + err.message });
        }
      }
      getTrWorker().postMessage({ type: 'init', model, cacheDir: modelsDir, speakerModel, language });
    };
    // Pedidos de início rodam um depois do outro (evita baixar o mesmo arquivo duas vezes ao mesmo tempo)
    trInitPromise = (trInitPromise || Promise.resolve()).catch(() => {}).then(run);
    trInitPromise.catch((err) => sendTrEvent({ type: 'error', fatal: true, message: err.message }));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('tr-segment', (_event, seg) => {
  if (!seg || typeof seg.id !== 'string' || !seg.audio) return;
  const raw = seg.audio;
  const buffer = raw instanceof ArrayBuffer
    ? raw
    : ArrayBuffer.isView(raw)
      ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      : null;
  if (!buffer) return;
  if (!trInitPromise) { sendTrEvent({ type: 'error', id: seg.id, message: 'Transcrição não iniciada.' }); return; }

  trInitPromise
    .then(() => {
      getTrWorker().postMessage({
        type: 'segment',
        id: seg.id,
        source: seg.source === 'sys' ? 'sys' : 'mic',
        start: Number(seg.start) || 0,
        language: ['pt', 'en', 'es', 'auto'].includes(seg.language) ? seg.language : 'pt',
        audio: buffer
      }, [buffer]);
    })
    .catch(() => sendTrEvent({ type: 'error', id: seg.id, message: 'Modelo de transcrição indisponível.' }));
});

/* Texto da transcrição: salvar ao lado do vídeo, salvar como... e copiar */
ipcMain.handle('save-transcript', async (_event, videoPath, text) => {
  try {
    if (typeof videoPath !== 'string' || typeof text !== 'string' || !savedPaths.has(videoPath)) {
      return { success: false, error: 'Caminho inválido.' };
    }
    const outPath = videoPath.replace(/\.[^./\\]+$/, '') + '.txt';
    await fs.writeFile(outPath, text, 'utf8');
    savedPaths.add(outPath);
    return { success: true, path: outPath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-transcript-as', async (_event, defaultName, text) => {
  if (typeof text !== 'string') return { success: false, error: 'Texto inválido.' };
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar transcrição',
    defaultPath: path.join(app.getPath('documents'), defaultName || 'Transcricao.txt'),
    buttonLabel: 'Salvar',
    filters: [{ name: 'Texto', extensions: ['txt'] }]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    await fs.writeFile(filePath, text, 'utf8');
    savedPaths.add(filePath);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-text', (_event, text) => {
  if (typeof text !== 'string' || text.length > 5_000_000) return false;
  clipboard.writeText(text);
  return true;
});

/* ------------------------------------------------------------------ */
/* Download verificado do modelo de transcrição                        */
/* ------------------------------------------------------------------ */
// Usa a rede do Chromium (respeita proxy e certificados do Windows), confere o tamanho e o
// SHA-256 de cada arquivo e retoma downloads interrompidos. Depois de baixado, funciona offline.
const HF_ENDPOINT = process.env.QACAM_HF_ENDPOINT || 'https://huggingface.co';
const MODEL_ONNX = ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'];
const SPEAKER_MODEL = 'Xenova/wavlm-base-plus-sv';          // identifica quem está falando
const SPEAKER_ONNX = ['onnx/model_quantized.onnx'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileOnDisk = (dir, name) => path.join(dir, ...name.split('/'));

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fsSync.createReadStream(filePath)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function listModelFiles(model, onnxFiles) {
  const res = await net.fetch(`${HF_ENDPOINT}/api/models/${model}?blobs=true`);
  if (!res.ok) throw new Error(`o Hugging Face respondeu ${res.status}`);
  const info = await res.json();
  const files = (info.siblings || [])
    .filter((f) => f.rfilename.startsWith('onnx/')
      ? onnxFiles.includes(f.rfilename)
      : /^[^/]+\.(json|txt)$/i.test(f.rfilename))
    .map((f) => ({
      name: f.rfilename,
      size: f.size != null ? f.size : (f.lfs && f.lfs.size) || null,
      sha256: (f.lfs && (f.lfs.sha256 || f.lfs.oid)) || null
    }));
  if (!onnxFiles.every((n) => files.some((f) => f.name === n))) {
    throw new Error('o modelo não tem os arquivos esperados');
  }
  return files;
}

async function downloadFile(model, file, dir, setDone) {
  const dest = fileOnDisk(dir, file.name);
  const part = dest + '.part';
  await fs.mkdir(path.dirname(dest), { recursive: true });
  let lastError = null;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let have = 0;
      try { have = (await fs.stat(part)).size; } catch (_) {}
      if (file.size && have > file.size) { await fs.unlink(part); have = 0; }

      let hash = crypto.createHash('sha256');
      if (have) {
        await new Promise((resolve, reject) => fsSync.createReadStream(part)
          .on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject));
      }

      if (!file.size || have < file.size) {
        const res = await net.fetch(`${HF_ENDPOINT}/${model}/resolve/main/${file.name}`,
          { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (res.status !== 200 && res.status !== 206) throw new Error(`resposta ${res.status}`);
        if (res.status === 200 && have) { await fs.unlink(part); have = 0; hash = crypto.createHash('sha256'); }

        const handle = await fs.open(part, have ? 'a' : 'w');
        try {
          const reader = res.body.getReader();
          let written = have;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await handle.write(value);
            hash.update(value);
            written += value.length;
            setDone(written);
          }
        } finally {
          await handle.close();
        }
      }

      const size = (await fs.stat(part)).size;
      if (file.size && size !== file.size) {
        throw new Error(`o arquivo chegou com ${size} de ${file.size} bytes`);
      }
      if (file.sha256 && hash.digest('hex') !== file.sha256) {
        await fs.unlink(part).catch(() => {});
        setDone(0);
        throw new Error('o arquivo chegou diferente do original (verificação SHA-256 falhou)');
      }
      await fs.rename(part, dest);
      setDone(size);
      return;
    } catch (err) {
      lastError = err;
      await sleep(800 * attempt);
    }
  }
  throw new Error(
    `o download de "${path.basename(file.name)}" não completou depois de 5 tentativas (${lastError.message}). ` +
    'Isso costuma ser antivírus, firewall ou proxy interferindo; tente em outra rede ou desative o escaneamento HTTPS temporariamente.'
  );
}

async function ensureModel(model, modelsDir, onProgress, onnxFiles = MODEL_ONNX) {
  const dir = path.join(modelsDir, ...model.split('/'));
  const manifestPath = path.join(dir, '.qacam-manifest.json');

  // Já instalado e com os tamanhos certos: não precisa de internet
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const ok = await Promise.all(manifest.files.map(async (f) => {
      try { return (await fs.stat(fileOnDisk(dir, f.name))).size === f.size; } catch (_) { return false; }
    }));
    if (ok.length && ok.every(Boolean)) return { downloaded: false };
  } catch (_) { /* sem manifesto: confere abaixo */ }

  let files;
  try {
    files = await listModelFiles(model, onnxFiles);
  } catch (err) {
    throw new Error(`Não foi possível acessar o Hugging Face para baixar o modelo (${err.message}). ` +
      'Verifique a internet, o firewall e o antivírus.');
  }

  const total = files.reduce((n, f) => n + (f.size || 0), 0) || 1;
  const done = {};
  const report = () => onProgress(Math.min(99, Math.floor(100 * Object.values(done).reduce((a, b) => a + b, 0) / total)));
  onProgress(0);

  for (const file of files) {
    const dest = fileOnDisk(dir, file.name);
    // Arquivo que já existe (inclusive de tentativas antigas) só é aproveitado se estiver íntegro
    let good = false;
    try {
      const st = await fs.stat(dest);
      good = (!file.size || st.size === file.size) && (!file.sha256 || (await hashFile(dest)) === file.sha256);
      if (!good) await fs.unlink(dest);
    } catch (_) {}
    if (good) { done[file.name] = file.size || 0; report(); continue; }

    await downloadFile(model, file, dir, (bytes) => { done[file.name] = bytes; report(); });
  }

  await fs.writeFile(manifestPath, JSON.stringify({
    model, savedAt: new Date().toISOString(),
    files: files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 }))
  }), 'utf8');
  return { downloaded: true };
}

module.exports = { ensureModel };
