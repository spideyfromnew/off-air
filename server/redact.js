// Stage 2: source protection. Two passes:
//   1. Regex — emails, phone numbers, URLs, social handles (deterministic).
//   2. Local LLM — people, orgs, places, IDs (JSON NER with strict validation).
// Findings are merged, labeled (PERSON-1, ORG-2, ...) and applied as redactions.
// The journalist reviews everything in the UI before sharing — human in the loop.
import { complete } from './qvac.js';

const RULES = [
  { type: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'phone', re: /\+?\d[\d\s().-]{6,}\d/g, keep: (m) => (m.match(/\d/g) || []).length >= 7 },
  { type: 'url', re: /https?:\/\/\S+|www\.\S+/gi },
  { type: 'handle', re: /\s@[A-Za-z0-9_]{3,}/g },
];

export function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function regexFindings(fullText) {
  const out = new Map();
  for (const rule of RULES) {
    for (const m of fullText.matchAll(rule.re)) {
      const text = m[0].trim();
      if (!text) continue;
      if (rule.keep && !rule.keep(text)) continue;
      if (!out.has(text.toLowerCase())) out.set(text.toLowerCase(), { type: rule.type, text, enabled: true, source: 'regex' });
    }
  }
  return [...out.values()];
}

const LLM_TYPES = new Set(['person', 'org', 'place', 'phone', 'id', 'date']);
// Small models love labeling calendar months as “place” — these are never
// identifying on their own.
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;

const SYS = `You find personally identifying information in interview transcripts.
Reply with ONLY a JSON array, no explanations, no markdown fences.
Each item is an object: {"type": "person"|"org"|"place"|"phone"|"id", "text": "..."}.
The value of "text" must be copied character-for-character from the transcript, same capitalization. Include full names of people, company or organization names, street or place names, and phone numbers. Do NOT include job titles, generic nouns, or event dates.

Example:
TRANSCRIPT:
"""
An engineer named Sarah Chen at Northgate Energy flagged the invoice on Tuesday.
"""
JSON array:
[{"type": "person", "text": "Sarah Chen"}, {"type": "org", "text": "Northgate Energy"}]

If there is nothing to report, reply []`;

export function chunkForLlm(fullText, size = 900) {
  const sentences = fullText.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > size && cur) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += (cur ? ' ' : '') + s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

export async function llmFindings(fullText, modelKey, onEvent = () => {}) {
  const chunks = chunkForLlm(fullText);
  const out = new Map();
  for (let i = 0; i < chunks.length; i++) {
    onEvent({ phase: 'status', message: `LLM scan: chunk ${i + 1}/${chunks.length}` });
    let arr = null;
    try {
      const answer = await complete(modelKey, SYS, `TRANSCRIPT:\n"""\n${chunks[i]}\n"""\n\nJSON array:`);
      arr = extractJsonArray(answer);
    } catch {
      arr = null; // LLM pass is best-effort; regex findings always remain
    }
    if (!arr) continue;
    for (const item of arr) {
      // Small models sometimes echo prompt placeholders or wrap values in
      // quotes — sanitize before the exact-substring check.
      const raw = String(item?.text ?? '').replace(/<[^>]*>/g, '').replace(/^["'\s]+|["'\s]+$/g, '').trim();
      const text = raw;
      const type = String(item?.type ?? '').toLowerCase();
      // Strict guards against small-model junk: no mega-spans, no sentence
      // globs, phones must contain digits ("March" is not a phone number).
      if (text.length < 2 || text.length > 60) continue;
      if (/[.?!]/.test(text)) continue;
      if (type === 'phone' && !/\d/.test(text)) continue;
      if (MONTHS.test(text)) continue;
      if (!LLM_TYPES.has(type)) continue;
      if (!chunks[i].includes(text)) continue; // must be a real substring — no hallucinated spans
      if (!out.has(text.toLowerCase())) {
        out.set(text.toLowerCase(), { type: type === 'date' ? 'id' : type, text, enabled: true, source: 'llm' });
      }
    }
  }
  return [...out.values()];
}

export function mergeFindings(existing, incoming) {
  const map = new Map();
  for (const f of [...(existing ?? []), ...incoming]) {
    const key = f.text.toLowerCase();
    if (!map.has(key)) map.set(key, f);
  }
  return [...map.values()];
}

// Assign stable labels; existing labels are preserved so toggling a finding
// never renumbers the others.
export function assignLabels(findings, fullText) {
  const lower = fullText.toLowerCase();
  const unlabeled = findings.filter((f) => !f.label);
  unlabeled.sort((a, b) => {
    const ia = lower.indexOf(a.text.toLowerCase());
    const ib = lower.indexOf(b.text.toLowerCase());
    return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
  });
  for (const f of unlabeled) {
    const prefix = (f.type || 'item').toUpperCase();
    let n = 1;
    let label = `${prefix}-${n}`;
    const taken = new Set(findings.map((x) => x.label).filter(Boolean));
    while (taken.has(label)) label = `${prefix}-${++n}`;
    f.label = label;
  }
  return findings;
}

export function applyFindings(segments, findings) {
  const active = (findings ?? []).filter((f) => f.enabled !== false && f.label);
  const compiled = active.map((f) => ({ label: f.label, re: new RegExp(escapeRegExp(f.text), 'gi') }));
  return segments.map((seg) => {
    let text = seg.text;
    for (const c of compiled) text = text.replace(c.re, c.label);
    return { ...seg, text };
  });
}
