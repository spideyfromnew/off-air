# OFF/AIR

**An air-gapped interview desk for journalists.** Drop a sensitive interview recording and get a timestamped transcript, a redacted *safe copy* you can share with your editor, a source brief with pull-quotes, and a searchable index across every interview you've ever fed it — with every byte of AI inference running **on your machine** via [QVAC](https://qvac.tether.io).

> Cloud transcription is a subpoena risk. OffAir never lets a source's voice leave the machine.

## Why this exists

Journalists, lawyers and investigators handle recordings that cannot be uploaded anywhere: source identities, whistleblowers, privileged material. Cloud speech-to-text means shipping that audio to a third party — a leak, a subpoena, or a breach away from a burned source. OffAir runs the entire pipeline locally: [QVAC](https://github.com/tetherto/qvac) loads Whisper, a Llama model and an embedding model on your own hardware, and your files never leave the `data/` folder on your disk.

## QVAC Dependency

OffAir uses the **QVAC SDK `@qvac/sdk` version `^0.19.1`** for all local AI inference.

### QVAC SDK Functions Used

| QVAC Function | Purpose |
|---|---|
| `loadModel` | Loads Whisper, Llama, and embedding models locally |
| `transcribe` | Converts interview audio into timestamped text |
| `completion` | Runs local LLM inference for redaction, briefs, claims, quotes, and answers |
| `ragIngest` | Adds interview content to the local semantic search index |
| `ragSearch` | Searches across indexed interviews and returns relevant context |
| `unloadModel` | Unloads models when they are no longer needed to free memory |

All AI inference is performed locally through the QVAC worker. **No cloud AI APIs are used.**

The only network activity is the initial model download. Once the models are cached, OffAir can run offline.

## Install

Prerequisites:

- **Node.js ≥ 22.17** and npm ≥ 10.9
- One of: **Windows 10+** (x64, Vulkan 1.4 driver), **macOS 14+** (Apple Silicon), **Ubuntu 22+** (x64/arm64)
- ~4 GB free RAM for inference, ~2 GB disk for models

```bash
git clone https://github.com/ops63/offair.git
cd offair
npm install
```

## Run

```bash
npm start
```

Open **http://localhost:3000**, then:

1. Give the interview a name, pick a `.wav` file (16 kHz mono recommended), and click **Transcribe on-device**.
2. Click **Run AI redaction scan** — the local LLM proposes redactions; click any chip to disable one you disagree with, or add your own.
3. Click **Generate brief** for the reporter's crib sheet, and **Download safe copy** for the shareable redacted transcript.
4. Click **Add to search index**, then use the search bar to query across every interview.

No sample audio? Generate a fictional two-voice interview locally (uses only Windows' built-in voices):

```bash
npm run sample
```

## First run: model downloads

Models are fetched once, then cached and usable offline:

| Model | Used for | Size |
|---|---|---|
| Whisper base q8 (default) | Transcription | ~80 MB |
| Llama 3.2 1B Instruct Q4_0 | Redaction, briefs, answers | ~800 MB |
| EmbeddingGemma 300M Q4_0 | Semantic search index | ~200 MB |

Downloads use QVAC's model registry; on networks where the P2P registry is unreliable, OffAir falls back to direct HTTP mirrors (configured in `server/qvac.js`).

## Privacy

- All AI inference runs on your machine through the QVAC worker. Nothing is ever sent to a cloud AI service.
- The only network traffic is the **one-time model download**. After that, you can disconnect.
- Transcripts, redaction decisions and audio stay in `data/` (git-ignored, never uploaded).

## Configuration notes

- The QVAC worker can take longer than 30 s to start on first launch (antivirus scanning). OffAir sets `rpcInitTimeoutMs: 120000` in `qvac.config.json` to allow for this.
- Only `.wav` is accepted. Convert other formats with: `ffmpeg -i input.mp3 -ar 16000 -ac 1 output.wav`.
- Model choices live in `server/qvac.js` (Whisper tiny/base/large-v3-turbo; swap the LLM or embedding model the same way).

## Project layout

```
server/
  index.js      Express app: REST API + SSE job progress + static UI
  qvac.js       The only file that touches @qvac/sdk (models, serialized ops)
  transcribe.js audio → timestamped segments (Whisper)
  redact.js     regex + LLM NER redaction with strict exact-substring validation
  brief.js      grounded summary / claims / quotes / follow-ups
  rag.js        chunked ingest + cited cross-interview search
  store.js      JSON persistence under data/
public/         vanilla HTML/CSS/JS UI (no build step)
scripts/        sample-interview generator + smoke test + registry dump
```

## Bounty checklist (QVAC hackathon)

- [x] `@qvac/sdk` declared dependency — **version ^0.19.1 (0.19.1)**
- [x] Calls `loadModel` + `transcribe`, `completion`, `ragIngest`, `ragSearch` (plus `unloadModel`)
- [x] 100% on-device inference; zero cloud AI calls
- [x] Runs end-to-end (see `npm run sample` + `npm start`)
- [x] MIT license
- [x] Original code — not a fork of qvac-examples

## License

[MIT](LICENSE)
