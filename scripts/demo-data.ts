import { simulation } from '../fixtures/simulation.js';
import { closePools } from '../server/data.js';
import { syncRecords } from '../server/sync.js';
import { initializeDatabases } from './init-db.js';
import { seed } from './seed.js';

if (process.env.SOURCE_MODE === 'real') {
  console.error('模拟数据只写入本机演示库。请运行 npm run demo:data。');
  process.exitCode = 1;
} else {
  const snapshot = simulation();
  try {
    await initializeDatabases();
    await seed({ reset: true, snapshot });
    const result = await syncRecords();
    console.log(`已生成并同步模拟数据：患者 ${snapshot.patients.length}、诊断 ${snapshot.diagnoses.length}、申请单 ${snapshot.planRequests.length}、单据 ${snapshot.documents.length}、搜索记录 ${result.total}。`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '模拟数据生成失败');
    process.exitCode = 1;
  } finally {
    await closePools();
  }
}
