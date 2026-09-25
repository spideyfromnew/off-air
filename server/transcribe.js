// Stage 1: audio -> timestamped segments, 100% on-device via QVAC Whisper.
import { ensureModel, unloadModelByKey, serialize, sdk } from './qvac.js';

export async function transcribeInterview({ audioPath, whisperKey, onEvent = () => {} }) {
  onEvent({ phase: 'status', message: 'Loading Whisper (first run downloads the model)' });
  const modelId = await ensureModel(whisperKey, onEvent);
  onEvent({ phase: 'status', message: 'Transcribing on-device… nothing leaves this machine' });

  const raw = await serialize(async () => {
    const q = await sdk();
    return q.transcribe({ modelId, audioChunk: audioPath, metadata: true });
  });

  const segments = (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      text: String(s?.text ?? '').trim(),
      startMs: Math.max(0, s?.startMs | 0),
      endMs: Math.max(0, s?.endMs | 0),
    }))
    .filter((s) => s.text);

  onEvent({ phase: 'status', message: `Transcribed ${segments.length} segments — unloading Whisper` });
  await unloadModelByKey(whisperKey);
  return segments;
}
