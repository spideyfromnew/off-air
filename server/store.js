// Local persistence: every interview lives as a JSON file under data/.
// Nothing here ever talks to the network - this is the "off the record" part.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(root, 'data');
const INTERVIEWS_DIR = path.join(DATA_DIR, 'interviews');
export const AUDIO_DIR = path.join(DATA_DIR, 'audio');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const META_FILE = path.join(DATA_DIR, 'meta.json');

for (const dir of [DATA_DIR, INTERVIEWS_DIR, AUDIO_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function newId() {
  return crypto.randomBytes(5).toString('hex');
}

export function audioPathFor(id) {
  return path.join(AUDIO_DIR, `${id}.wav`);
}

export function saveAudio(id, buffer) {
  fs.writeFileSync(audioPathFor(id), buffer);
}

export function saveInterview(rec) {
  fs.writeFileSync(path.join(INTERVIEWS_DIR, `${rec.id}.json`), JSON.stringify(rec, null, 2));
}

export function getInterview(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(INTERVIEWS_DIR, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function summary(rec) {
  const { segments, findings, brief, ...rest } = rec;
  return {
    ...rest,
    segmentCount: segments?.length ?? 0,
    findingCount: (findings ?? []).filter((f) => f.enabled !== false).length,
    hasBrief: Boolean(brief),
  };
}

export function listInterviews() {
  return fs
    .readdirSync(INTERVIEWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return summary(JSON.parse(fs.readFileSync(path.join(INTERVIEWS_DIR, f), 'utf8')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}
