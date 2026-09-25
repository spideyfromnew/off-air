// OffAir server — local web UI + API. Every AI call goes through QVAC
// on-device; there is no cloud AI anywhere in this codebase.
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { saveAudio, saveInterview, getInterview, listInterviews, audioPathFor, newId, UPLOADS_DIR } from './store.js';
import { transcribeInterview } from './transcribe.js';
import { regexFindings, llmFindings, mergeFindings, assignLabels, applyFindings } from './redact.js';
import { generateBrief } from './brief.js';
import { ingestAll, search } from './rag.js';
import { loadedModels, unloadAll, MODELS } from './qvac.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

// ---------- job bus (Server-Sent Events) ----------
const jobs = new Map();
function newJob() {
  const id = randomUUID();
  jobs.set(id, { listeners: new Set(), events: [] });
  return id;
}
function jobEmit(jobId, evt) {
  const job = jobs.get(jobId);
  if (!job) return;
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  job.events.push(line);
  for (const res of job.listeners) res.write(line);
}
app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  for (const line of job.events) res.write(line);
  job.listeners.add(res);
  req.on('close', () => job.listeners.delete(res));
});
function runJob(jobId, fn) {
  (async () => {
    await fn();
    jobEmit(jobId, { phase: 'done' });
  })()
    .catch((err) => {
    console.error(err);
    jobEmit(jobId, { phase: 'error', message: String(err?.message ?? err) });
  });
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname || '.wav').toLowerCase()}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ---------- status ----------
app.get('/api/status', (req, res) => {
  res.json({
    models: Object.fromEntries(Object.entries(MODELS).map(([k, v]) => [k, { label: v.label, loaded: loadedModels().includes(k) }])),
    sdk: '@qvac/sdk ^0.19.1',
  });
});

// ---------- interviews ----------
app.get('/api/interviews', (req, res) => res.json(listInterviews()));

app.get('/api/interviews/:id', (req, res) => {
  const rec = getInterview(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  res.json({ ...rec, redacted: applyFindings(rec.segments, rec.findings) });
});

app.post('/api/interviews', upload.single('audio'), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No audio file received.' });
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (ext !== '.wav') {
    fs.unlinkSync(file.path);
    return res.status(400).json({
      error: 'Only .wav is accepted. Convert first: ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav',
    });
  }

  const id = newId();
  fs.copyFileSync(file.path, audioPathFor(id));
  fs.unlinkSync(file.path);

  const rec = {
    id,
    name: String(req.body?.name || path.basename(file.originalname || id, ext)).slice(0, 80),
    createdAt: Date.now(),
    whisperKey: req.body?.whisper || 'whisper-base',
    segments: [],
    findings: [],
    llmRedactionRun: false,
    brief: null,
    ragIngested: false,
  };
  saveInterview(rec);

  const jobId = newJob();
  runJob(jobId, async () => {
    jobEmit(jobId, { phase: 'status', message: 'Starting the on-device pipeline' });
    const segments = await transcribeInterview({
      audioPath: audioPathFor(id),
      whisperKey: rec.whisperKey,
      onEvent: (e) => jobEmit(jobId, e),
    });
    rec.segments = segments;
    rec.findings = assignLabels(regexFindings(segments.map((s) => s.text).join(' ')), segments.map((s) => s.text).join(' '));
    saveInterview(rec);
    jobEmit(jobId, { phase: 'status', message: `Regex pass flagged ${rec.findings.length} item(s)` });
    jobEmit(jobId, { phase: 'interview', id });
  });

  res.json({ id, jobId });
});

app.post('/api/interviews/:id/llm-redact', (req, res) => {
  const rec = getInterview(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  if (!rec.segments?.length) return res.status(400).json({ error: 'Transcribe the interview first.' });
  const jobId = newJob();
  runJob(jobId, async () => {
    const full = rec.segments.map((s) => s.text).join(' ');
    const found = await llmFindings(full, 'llm-llama1b', (e) => jobEmit(jobId, e));
    rec.findings = assignLabels(mergeFindings(rec.findings, found), full);
    rec.llmRedactionRun = true;
    saveInterview(rec);
    jobEmit(jobId, { phase: 'interview', id: rec.id });
  });
  res.json({ jobId });
});

app.post('/api/interviews/:id/brief', (req, res) => {
  const rec = getInterview(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  if (!rec.segments?.length) return res.status(400).json({ error: 'Transcribe the interview first.' });
  const jobId = newJob();
  runJob(jobId, async () => {
    rec.brief = await generateBrief(rec.segments, 'llm-llama1b', (e) => jobEmit(jobId, e));
    saveInterview(rec);
    jobEmit(jobId, { phase: 'interview', id: rec.id });
  });
  res.json({ jobId });
});

app.post('/api/interviews/:id/findings', (req, res) => {
  const rec = getInterview(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const text = String(req.body?.text ?? '').trim();
  const enabled = req.body?.enabled !== false;
  if (!text) return res.status(400).json({ error: 'text required' });
  const existing = rec.findings.find((f) => f.text.toLowerCase() === text.toLowerCase());
  if (existing) {
    existing.enabled = enabled;
  } else {
    rec.findings.push({ type: 'manual', text, enabled: true, source: 'manual' });
  }
  rec.findings = assignLabels(rec.findings, rec.segments.map((s) => s.text).join(' '));
  saveInterview(rec);
  res.json({ ok: true });
});

app.get('/api/interviews/:id/export', (req, res) => {
  const rec = getInterview(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  const fmt = (ms) => {
    const t = Math.floor(ms / 1000);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };
  const body = applyFindings(rec.segments, rec.findings)
    .map((s) => `[${fmt(s.startMs)}] ${s.text}`)
    .join('\n');
  res.setHeader('Content-Disposition', `attachment; filename="${rec.name.replace(/[^\w.-]+/g, '_') || 'interview'}-safe-copy.txt"`);
  res.type('text/plain').send(
    `SAFE COPY — identifying details redacted on-device by OffAir (QVAC)\nInterview: ${rec.name}\nGenerated: ${new Date().toISOString()}\n\n${body}\n`
  );
});

// ---------- cross-interview search ----------
app.post('/api/ingest', (req, res) => {
  const jobId = newJob();
  runJob(jobId, async () => {
    const r = await ingestAll((e) => jobEmit(jobId, e));
    jobEmit(jobId, { phase: 'status', message: `Indexed ${r.ingested} interview(s)` });
  });
  res.json({ jobId });
});

app.post('/api/search', (req, res) => {
  const query = String(req.body?.query ?? '').trim().slice(0, 400);
  if (!query) return res.status(400).json({ error: 'query required' });
  const jobId = newJob();
  runJob(jobId, async () => {
    const result = await search(query, (e) => jobEmit(jobId, e));
    jobEmit(jobId, { phase: 'search', result });
  });
  res.json({ jobId });
});

// ---------- start / stop ----------
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort > 0 ? envPort : 3000;
const server = app.listen(PORT, () => {
  console.log(`\n  OFF/AIR — air-gapped interview desk`);
  console.log(`  ▸ Local UI:  http://localhost:${PORT}`);
  console.log(`  ▸ All inference runs on this machine via QVAC. No cloud. No API keys.\n`);
});

async function shutdown() {
  console.log('\n▸ Shutting down — unloading models…');
  try {
    await unloadAll();
  } catch {
    /* */
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
