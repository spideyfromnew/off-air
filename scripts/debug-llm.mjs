// Debug: call the local LLM through server/qvac.js and dump the raw answer.
import { complete, unloadAll } from '../server/qvac.js';

const SYS = 'Reply with ONLY a JSON array of {"type":"person","text":"<exact substring>"}. If nothing, reply []';
const USER = 'TRANSCRIPT:\n"""\nThe engineer named Daniel Kovac pushed the award to Meridian Pipeworks.\n"""\n\nJSON array:';

const answer = await complete('llm-llama1b', SYS, USER);
console.log('RAW ANSWER:', JSON.stringify(answer));
await unloadAll();
process.exit(0);
