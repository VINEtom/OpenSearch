import { createWriteStream } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { config } from '../server/config.js';
import { readManifest } from '../server/index-state.js';
import { osRequest } from '../server/opensearch.js';
import type { RecordDocument } from '../shared/types.js';

const filePath = path.join(config.runtimeDir, 'captured-search.ndjson');
const metaPath = path.join(config.runtimeDir, 'captured-search.meta.json');

interface ScrollPage {
  _scroll_id: string;
  hits: { hits: { _source: RecordDocument }[] };
}

const first = await osRequest<ScrollPage>(`/${config.indexAlias}/_search?scroll=2m`, 'POST', {
  size: 500, query: { match_all: {} }, sort: ['_doc'],
});
await mkdir(config.runtimeDir, { recursive: true });
const temp = `${filePath}.tmp`;
const stream = createWriteStream(temp, { mode: 0o600 });
let total = 0;
let scrollId = first._scroll_id;
let hits = first.hits.hits;
try {
  while (hits.length) {
    for (const hit of hits) {
      stream.write(`${JSON.stringify(hit._source)}\n`);
      total += 1;
    }
    const next = await osRequest<ScrollPage>('/_search/scroll', 'POST', { scroll: '2m', scroll_id: scrollId });
    scrollId = next._scroll_id;
    hits = next.hits.hits;
  }
  stream.end();
  await once(stream, 'finish');
  await rename(temp, filePath);
  const manifest = await readManifest();
  await writeFile(metaPath, JSON.stringify({ total, capturedAt: new Date().toISOString(), defects: manifest?.defects ?? [] }, null, 2), { mode: 0o600 });
  console.log(`已保存当前搜索数据 ${total} 条到 ${filePath}`);
} finally {
  await osRequest('/_search/scroll', 'DELETE', { scroll_id: scrollId }).catch(() => undefined);
}
