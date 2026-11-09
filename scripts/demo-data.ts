import { createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { simulation } from '../fixtures/simulation.js';
import { config } from '../server/config.js';
import { closePools } from '../server/data.js';
import { publishRecords, syncRecords } from '../server/sync.js';
import type { RecordDocument, SourceDefect } from '../shared/types.js';
import { initializeDatabases } from './init-db.js';
import { seed } from './seed.js';

const sample = process.argv.includes('--sample');
const capturedPath = path.join(config.runtimeDir, 'captured-search.ndjson');
const metaPath = path.join(config.runtimeDir, 'captured-search.meta.json');

async function loadCaptured(): Promise<{ records: RecordDocument[]; defects: SourceDefect[] }> {
  await access(capturedPath);
  await access(metaPath);
  const records: RecordDocument[] = [];
  const lines = createInterface({ input: createReadStream(capturedPath), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) records.push(JSON.parse(line) as RecordDocument);
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { defects?: SourceDefect[] };
  return { records, defects: meta.defects ?? [] };
}

try {
  if (sample) {
    if (process.env.SOURCE_MODE === 'real') throw new Error('小套虚构样例只写入本机演示库。');
    const snapshot = simulation();
    await initializeDatabases();
    await seed({ reset: true, snapshot });
    const result = await syncRecords();
    console.log(`已生成小套虚构数据并同步，搜索记录 ${result.total} 条。`);
  } else {
    const { records, defects } = await loadCaptured();
    const result = await publishRecords(records, { defects });
    console.log(`已用当前保存的齐全数据重新发布搜索，共 ${result.total} 条。`);
  }
} catch (error) {
  const missing = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
  console.error(missing ? '还没有保存当前搜索数据。请先运行 npm run data:capture。小套虚构数据用 npm run demo:data -- --sample。' : error instanceof Error ? error.message : '生成失败');
  process.exitCode = 1;
} finally {
  await closePools();
}
