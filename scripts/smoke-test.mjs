// Smoke test: proves the QVAC toolchain works on this machine -
// worker starts, model downloads, Whisper transcribes on-device.
// Run: npm run sample (once) then npm run smoke
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, unloadModel, transcribe, WHISPER_TINY } from '@qvac/sdk';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wav = path.join(root, 'sample', 'interview-16k.wav');

if (!fs.existsSync(wav)) {
  console.error('sample/interview-16k.wav not found - run "npm run sample" first.');
  process.exit(1);
}

console.log('▸ Loading WHISPER_TINY (first run downloads ~150 MB)...');
const modelId = await loadModel({
  modelSrc: WHISPER_TINY,
  fallbackSrc: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  modelConfig: { language: 'en', audio_format: 'f32le' },
  onProgress: (p) => {
    const mb = (n) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write('\n');
  },
});
console.log(`▸ Model loaded: ${modelId}`);

console.log('▸ Transcribing on-device...');
const result = await transcribe({ modelId, audioChunk: wav, metadata: true });
const segments = Array.isArray(result) ? result : [];
const joined = segments.map((s) => s.text || '').join(' ').trim();
if (!joined) {
  console.error('No segments returned:', JSON.stringify(result).slice(0, 500));
  process.exit(1);
}
console.log(`▸ ${segments.length} segments`);
for (const s of segments.slice(0, 4)) {
  console.log(`  [${(s.startMs / 1000).toFixed(1)}s -> ${(s.endMs / 1000).toFixed(1)}s] ${s.text}`);
}
console.log('▸ FULL TEXT: ' + joined.slice(0, 400) + (joined.length > 400 ? '...' : ''));

await unloadModel({ modelId });
console.log('▸ Smoke test PASSED - QVAC on-device transcription works.');
process.exit(0);
