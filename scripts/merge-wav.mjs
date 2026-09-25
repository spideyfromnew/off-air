// Concatenates the per-line WAVs from scripts/make-sample.ps1 into one
// sample/interview-16k.wav (16 kHz, 16-bit, mono PCM), with short pauses
// between speakers. Pure Node - no ffmpeg required.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = path.join(root, '.tmp-sample');
const SR = 16000;

const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.wav')).sort();

if (files.length === 0) {
  console.error('No per-line WAVs found in .tmp-sample - run "npm run sample" fully.');
  process.exit(1);
}

function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file} is not a WAV file`);
  }
  // Walk chunks to find fmt + data
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bitsPerSample: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${file} missing fmt or data chunk`);
  return { fmt, data };
}

const silenceMs = 450;
const silence = Buffer.alloc(Math.round((SR * silenceMs) / 1000) * 2);

const chunks = [];
let totalSamples = 0;
let fmtRef = null;
for (const f of files) {
  const { fmt, data } = readWav(path.join(tmp, f));
  if (fmt.sampleRate !== SR || fmt.bitsPerSample !== 16 || fmt.channels !== 1) {
    throw new Error(`${f}: expected 16 kHz / 16-bit / mono, got ${fmt.sampleRate} / ${fmt.bitsPerSample} / ${fmt.channels}`);
  }
  fmtRef = fmt;
  chunks.push(data);
  totalSamples += data.length / 2;
  chunks.push(silence);
  totalSamples += silence.length / 2;
}

const dataSize = totalSamples * 2;
const header = Buffer.alloc(44);
header.write('RIFF', 0, 'ascii');
header.writeUInt32LE(36 + dataSize, 4);
header.write('WAVE', 8, 'ascii');
header.write('fmt ', 12, 'ascii');
header.writeUInt32LE(16, 16);
header.writeUInt16LE(fmtRef.audioFormat, 20);
header.writeUInt16LE(fmtRef.channels, 22);
header.writeUInt32LE(fmtRef.sampleRate, 24);
header.writeUInt32LE(fmtRef.sampleRate * 2, 28); // byte rate = sr * channels * bytes/sample
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36, 'ascii');
header.writeUInt32LE(dataSize, 40);

const outDir = path.join(root, 'sample');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'interview-16k.wav');
fs.writeFileSync(out, Buffer.concat([header, ...chunks]));

console.log(`Wrote ${out} (${(dataSize / 2 / SR).toFixed(1)} s of audio, ${files.length} lines)`);
