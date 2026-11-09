import { syncRecords } from '../server/sync.js';
import { closePools } from '../server/data.js';

try {
  const result = await syncRecords();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : '同步失败');
  process.exitCode = 1;
} finally { await closePools(); }
