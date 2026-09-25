// Stage 4: ask questions across every interview ever indexed.
// Transcript chunks are prefixed with [Interview @ mm:ss] so every citation
// rides inside the stored text; ragIngest/ragSearch embed and retrieve
// on-device, and the local LLM drafts the answer from those excerpts only.
import { ensureModel, serialize, sdk, complete } from './qvac.js';
import { listInterviews, getInterview, saveInterview, getMeta, saveMeta } from './store.js';

export const WORKSPACE = 'offair';

function fmtTime(ms) {
  const t = Math.floor(ms / 1000);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

export function chunkInterview(rec, size = 450) {
  const docs = [];
  let buf = [];
  let len = 0;
  let startMs = null;
  const flush = () => {
    if (!buf.length) return;
    docs.push(`[${rec.name} @ ${fmtTime(startMs)}] ${buf.join(' ').trim()}`);
    buf = [];
    len = 0;
    startMs = null;
  };
  for (const seg of rec.segments) {
    if (startMs === null) startMs = seg.startMs;
    if (len && len + seg.text.length > size) {
      flush();
      startMs = seg.startMs;
    }
    buf.push(seg.text);
    len += seg.text.length;
  }
  flush();
  return docs;
}

export async function ingestAll(onEvent = () => {}) {
  const modelId = await ensureModel('embed-gemma', onEvent);
  const meta = getMeta();
  const ingested = new Set(meta.ingestedIds ?? []);
  const pending = listInterviews().filter((r) => !ingested.has(r.id));

  if (!pending.length) {
    onEvent({ phase: 'status', message: 'Every interview is already indexed' });
    return { ingested: 0 };
  }

  for (const s of pending) {
    const rec = getInterview(s.id);
    if (!rec?.segments?.length) continue;
    const docs = chunkInterview(rec);
    onEvent({ phase: 'status', message: `Indexing “${rec.name}” (${docs.length} chunks) on-device` });
    await serialize(async () => {
      const q = await sdk();
      await q.ragIngest({ modelId, workspace: WORKSPACE, documents: docs, chunk: false });
    });
    rec.ragIngested = Date.now();
    saveInterview(rec);
    ingested.add(rec.id);
  }
  meta.ingestedIds = [...ingested];
  saveMeta(meta);
  return { ingested: pending.length };
}

export async function search(query, onEvent = () => {}) {
  const modelId = await ensureModel('embed-gemma', onEvent);
  onEvent({ phase: 'status', message: 'Searching the local index…' });
  const hits = await serialize(async () => {
    const q = await sdk();
    return q.ragSearch({ modelId, workspace: WORKSPACE, query, topK: 5 });
  });
  const cleanHits = (hits ?? []).map((h) => ({ content: String(h.content ?? ''), score: Number(h.score ?? 0) }));

  if (!cleanHits.length) {
    return { answer: 'Nothing in the index yet — add interviews to the search index first.', hits: [] };
  }

  onEvent({ phase: 'status', message: 'Drafting the cited answer locally…' });
  const context = cleanHits.map((h, i) => `[${i + 1}] ${h.content}`).join('\n---\n');
  const answer = await complete(
    'llm-llama1b',
    'You are a research assistant for a journalist. Answer the question using ONLY the excerpts from past interviews below. Cite inline like [Interview @ mm:ss], reusing the bracket prefix each excerpt carries. If the excerpts do not contain the answer, say exactly that.',
    `QUESTION: ${query}\n\nEXCERPTS:\n${context}`
  );
  return { answer, hits: cleanHits };
}
