// The only module that touches the QVAC SDK. All worker operations are
// serialized (the single worker dislikes overlapping ops), models are loaded
// lazily and cached, and every model gets an HTTP fallbackSrc so first runs
// work even where the P2P registry is unreliable.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.chdir(root); // so qvac.config.json in the project root is always found

let sdkPromise = null;
export function sdk() {
  if (!sdkPromise) sdkPromise = import('@qvac/sdk');
  return sdkPromise;
}

let chain = Promise.resolve();
export function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

// Fallback mirrors are pinned to the exact commits the QVAC registry entries
// point at, so a fallback download is byte-identical to the registry blob and
// passes the SDK's registry-checksum validation. A same-name file from a
// different quantizer (e.g. bartowski vs unsloth Q4_0) FAILS that validation
// and rolls back — discovered the hard way on a fresh setup.
const HF = 'https://huggingface.co';
const WHISPER_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const LLAMA_COMMIT = 'b69aef112e9f895e6f98d7ae0949f72ff09aa401';
const GEMMA_COMMIT = '6661a6504c30d8304af13455cb4a5d4f5bc6011f';

export const MODELS = {
  'whisper-tiny': {
    label: 'Whisper tiny (~75 MB)',
    addon: 'whisper',
    load: (q) => ({
      modelSrc: q.WHISPER_TINY,
      fallbackSrc: `${HF}/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/ggml-tiny.bin`,
      modelConfig: { language: 'en', audio_format: 'f32le', temperature: 0.0 },
    }),
  },
  'whisper-base': {
    label: 'Whisper base q8 (~80 MB)',
    addon: 'whisper',
    load: (q) => ({
      modelSrc: q.WHISPER_BASE_Q8_0,
      fallbackSrc: `${HF}/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/ggml-base-q8_0.bin`,
      modelConfig: { language: 'en', audio_format: 'f32le', temperature: 0.0 },
    }),
  },
  'whisper-turbo': {
    label: 'Whisper large-v3-turbo (~1.5 GB)',
    addon: 'whisper',
    load: (q) => ({
      modelSrc: q.WHISPER_LARGE_V3_TURBO,
      fallbackSrc: `${HF}/ggerganov/whisper.cpp/resolve/${WHISPER_COMMIT}/ggml-large-v3-turbo.bin`,
      modelConfig: { language: 'en', audio_format: 'f32le', temperature: 0.0 },
    }),
  },
  'llm-llama1b': {
    label: 'Llama 3.2 1B Instruct (~800 MB)',
    addon: 'llm',
    load: (q) => ({
      modelSrc: q.LLAMA_3_2_1B_INST_Q4_0,
      fallbackSrc: `${HF}/unsloth/Llama-3.2-1B-Instruct-GGUF/resolve/${LLAMA_COMMIT}/Llama-3.2-1B-Instruct-Q4_0.gguf`,
      modelConfig: { ctx_size: 4096, temp: 0.2, repeat_penalty: 1.1 },
    }),
  },
  'embed-gemma': {
    label: 'EmbeddingGemma 300M (~200 MB)',
    addon: 'embeddings',
    load: (q) => ({
      modelSrc: q.EMBEDDINGGEMMA_300M_Q4_0,
      fallbackSrc: `${HF}/unsloth/embeddinggemma-300m-GGUF/resolve/${GEMMA_COMMIT}/embeddinggemma-300m-Q4_0.gguf`,
      modelConfig: {},
    }),
  },
};

const loaded = new Map(); // key -> modelId

export async function ensureModel(key, onProgress = () => {}) {
  if (loaded.has(key)) return loaded.get(key);
  const spec = MODELS[key];
  if (!spec) throw new Error(`Unknown model key: ${key}`);
  const q = await sdk();
  const args = spec.load(q);
  const modelId = await serialize(() =>
    q.loadModel({
      ...args,
      onProgress: (p) => onProgress({ phase: 'download', label: spec.label, percentage: p.percentage, downloaded: p.downloaded, total: p.total }),
    })
  );
  loaded.set(key, modelId);
  return modelId;
}

export async function unloadModelByKey(key) {
  if (!loaded.has(key)) return;
  const q = await sdk();
  const modelId = loaded.get(key);
  try {
    await serialize(() => q.unloadModel({ modelId, clearStorage: false }));
  } catch {
    /* model may already be gone */
  }
  loaded.delete(key);
}

export async function unloadAll() {
  for (const key of [...loaded.keys()]) await unloadModelByKey(key);
}

export function loadedModels() {
  return [...loaded.keys()];
}

// One-shot completion: loads the LLM if needed, streams internally, returns text.
export async function complete(modelKey, system, user, { maxChars = 6000 } = {}) {
  const modelId = await ensureModel(modelKey);
  return serialize(async () => {
    const q = await sdk();
    const run = q.completion({
      modelId,
      history: [
        { role: 'system', content: system },
        { role: 'user', content: user.slice(0, maxChars) },
      ],
      stream: true,
    });
    let text = '';
    for await (const ev of run.events) {
      if (ev.type === 'contentDelta' && ev.text) text += ev.text;
    }
    let finalText = text;
    try {
      const final = await run.final;
      finalText = text || String(final?.content ?? final?.rawText ?? '');
    } catch {
      /* fall back to collected deltas */
    }
    return finalText.trim();
  });
}
