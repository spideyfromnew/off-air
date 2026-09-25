// Debug utility: lists QVAC model registry entries relevant to OffAir.
// Run: node scripts/registry-dump.mjs
import { modelRegistryList } from '@qvac/sdk';

const entries = await modelRegistryList();
const wanted = /whisper|llama-3\.2-1b|embeddinggemma|gte-large/i;

for (const e of entries) {
  const s = JSON.stringify(e);
  if (wanted.test(s)) {
    console.log(JSON.stringify(e, null, 2));
    console.log('---');
  }
}
console.log(`Total registry entries: ${entries.length}`);
process.exit(0);
