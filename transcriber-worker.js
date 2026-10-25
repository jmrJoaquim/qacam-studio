// Roda dentro de um worker_thread do processo principal do Electron.
// Recebe trechos de áudio (16 kHz, mono) e devolve o texto e, para o áudio do sistema,
// qual "Convidado" falou. Tudo localmente.
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const LANGUAGES = { pt: 'portuguese', en: 'english', es: 'spanish', auto: null };

let transcriber = null;
let loadedModel = null;
let speakerProcessor = null;
let speakerModel = null;
let loadedSpeakerModel = null;
let loading = null;
let queue = Promise.resolve();

const post = (msg) => parentPort.postMessage(msg);

// Erros que indicam arquivo do modelo ilegível
const CORRUPT_MODEL = /protobuf|load model from|invalid (model|onnx)|corrupt|unexpected end|failed to parse|incomplete/i;

/* tr-speakers:start */
// Agrupamento de vozes: cada trecho vira um vetor (impressão da voz) e é comparado com os
// convidados já conhecidos. Valores ajustáveis se houver convidados "repetidos" ou "misturados".
const SAME_SPEAKER = 0.84;     // semelhança mínima para considerar a mesma pessoa
const KEEP_SPEAKER = 0.74;     // tolerância para continuar com quem acabou de falar
const MIN_SECONDS = 1.2;       // trechos mais curtos não têm voz suficiente para comparar
const MAX_SPEAKERS = 8;

const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

// state = { speakers: [{ c: Float32Array, n: number }], last: number }  (last é 1-based; 0 = ninguém ainda)
function chooseSpeaker(state, embedding, seconds) {
  if (!embedding || seconds < MIN_SECONDS) return state.last || 1;

  let best = -1, bestSim = -1;
  state.speakers.forEach((s, i) => {
    const sim = cosine(s.c, embedding);
    if (sim > bestSim) { bestSim = sim; best = i; }
  });

  let index;
  if (best >= 0 && bestSim >= SAME_SPEAKER) index = best;
  else if (state.last && cosine(state.speakers[state.last - 1].c, embedding) >= KEEP_SPEAKER) index = state.last - 1;
  else if (state.speakers.length >= MAX_SPEAKERS) index = best;
  else { state.speakers.push({ c: embedding, n: 1 }); index = state.speakers.length - 1; state.last = index + 1; return state.last; }

  // atualiza a "impressão" média daquela pessoa (com limite para ela poder se adaptar)
  const s = state.speakers[index];
  const merged = new Float32Array(s.c.length);
  const w = Math.min(s.n, 20);
  for (let i = 0; i < merged.length; i++) merged[i] = s.c[i] * w + embedding[i];
  s.c = normalize(merged);
  s.n++;
  state.last = index + 1;
  return state.last;
}

// Para identificar a voz não é preciso ouvir o trecho inteiro: 8 s do meio bastam e custam bem menos
function centralPart(audio, maxSeconds = 8) {
  const max = maxSeconds * 16000;
  if (audio.length <= max) return audio;
  const start = Math.floor((audio.length - max) / 2);
  return audio.subarray(start, start + max);
}
/* tr-speakers:end */

let speakerState = { speakers: [], last: 0 };
let warmedKey = '';

async function configureEnv(cacheDir) {
  const { env } = await import('@huggingface/transformers');
  // O download e a conferência dos arquivos são feitos pelo processo principal; aqui só se lê do disco
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = cacheDir.replace(/\\/g, '/').replace(/\/?$/, '/');
}

async function load(model, cacheDir) {
  if (transcriber && loadedModel === model) return;
  transcriber = null;
  loadedModel = null;

  const { pipeline } = await import('@huggingface/transformers');
  await configureEnv(cacheDir);

  try {
    transcriber = await pipeline('automatic-speech-recognition', model, {
      dtype: 'q8'                     // versão quantizada: menor e mais rápida na CPU
    });
  } catch (err) {
    const message = String((err && err.message) || err);
    if (CORRUPT_MODEL.test(message)) {
      // Força uma nova conferência dos arquivos na próxima vez
      try { fs.rmSync(path.join(cacheDir, ...model.split('/'), '.qacam-manifest.json'), { force: true }); } catch (_) {}
      throw new Error(`${message} (o arquivo do modelo não pôde ser lido; ele será conferido de novo na próxima gravação. ` +
        'Se persistir, escolha outro modelo em Configurações.)');
    }
    throw err;
  }
  loadedModel = model;
}

async function loadSpeaker(model, cacheDir) {
  if (speakerModel && loadedSpeakerModel === model) return;
  speakerModel = null; speakerProcessor = null; loadedSpeakerModel = null;

  const { AutoProcessor, AutoModel } = await import('@huggingface/transformers');
  await configureEnv(cacheDir);
  speakerProcessor = await AutoProcessor.from_pretrained(model);
  speakerModel = await AutoModel.from_pretrained(model, { dtype: 'q8' });
  loadedSpeakerModel = model;
}

// Primeira execução de um modelo é sempre mais lenta (alocação de memória); fazemos uma de aquecimento
async function warmup(language) {
  const key = [loadedModel, loadedSpeakerModel, language].join('|');
  if (key === warmedKey) return;
  try {
    const options = { task: 'transcribe', max_new_tokens: 8 };
    if (LANGUAGES[language]) options.language = LANGUAGES[language];
    await transcriber(new Float32Array(16000 * 2), options);
    if (speakerModel) await embed(Float32Array.from({ length: 16000 * 2 }, () => (Math.random() - 0.5) * 0.05));
    warmedKey = key;
  } catch (_) { /* o aquecimento é opcional */ }
}

async function embed(audio) {
  const inputs = await speakerProcessor(audio);
  const { embeddings } = await speakerModel(inputs);
  return normalize(Float32Array.from(embeddings.data));
}

parentPort.on('message', (msg) => {
  if (msg.type === 'init') {
    speakerState = { speakers: [], last: 0 };   // convidados recomeçam a cada gravação
    loading = (async () => {
      await load(msg.model, msg.cacheDir);
      if (msg.speakerModel) {
        try {
          await loadSpeaker(msg.speakerModel, msg.cacheDir);
        } catch (err) {
          speakerModel = null; speakerProcessor = null; loadedSpeakerModel = null;
          post({ type: 'warning', message: 'Não foi possível carregar a identificação de vozes (' + String((err && err.message) || err) + '). A transcrição segue sem separar os convidados.' });
        }
      } else {
        speakerModel = null; speakerProcessor = null; loadedSpeakerModel = null;
      }
      await warmup(msg.language);
    })();
    loading
      .then(() => post({ type: 'ready' }))
      .catch((err) => post({ type: 'error', fatal: true, message: String((err && err.message) || err) }));
    return;
  }

  if (msg.type === 'segment') {
    // Um trecho por vez, na ordem em que chegaram
    queue = queue.then(async () => {
      try {
        if (!loading) throw new Error('Modelo de transcrição não iniciado.');
        await loading;
        if (!transcriber) throw new Error('Modelo de transcrição indisponível.');

        const startedAt = Date.now();
        const audio = new Float32Array(msg.audio);
        const seconds = audio.length / 16000;

        // Limita o tamanho da resposta: evita que um trecho "trave" repetindo palavras
        const options = { task: 'transcribe', max_new_tokens: Math.min(200, Math.ceil(seconds * 6) + 16) };
        const language = LANGUAGES[msg.language];
        if (language) options.language = language;

        // Texto e identificação da voz rodam ao mesmo tempo (só no áudio do sistema; o microfone é sempre "Você")
        const wantSpeaker = msg.source === 'sys' && !!speakerModel && seconds >= MIN_SECONDS;
        const [out, embedding] = await Promise.all([
          transcriber(audio, options),
          wantSpeaker ? embed(centralPart(audio)).catch(() => null) : null
        ]);
        const text = (Array.isArray(out) ? out.map(o => o.text).join(' ') : out.text || '').trim();

        let speaker = null;
        if (text && msg.source === 'sys' && speakerModel) speaker = chooseSpeaker(speakerState, embedding, seconds);

        post({ type: 'result', id: msg.id, source: msg.source, start: msg.start, text, speaker,
               ms: Date.now() - startedAt, dur: seconds });
      } catch (err) {
        post({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
      }
    });
  }
});
