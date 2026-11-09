import express from 'express';
import { config } from './config.js';
import { AppError } from './errors.js';
import { getIndexStatus } from './index-state.js';
import { searchRecords, validateSearchParams } from './search.js';
import { closePools, loadDetail } from './data.js';
import { RECORD_TYPES, SOURCES, TYPE_SOURCES, type RecordType, type Source } from '../shared/types.js';

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.get('/api/prototype/health', (_req, res) => { res.json({ ok: true, app: 'ois-search-prototype' }); });
app.get('/api/prototype/index-status', async (_req, res) => { res.json(await getIndexStatus()); });
app.get('/api/prototype/search', async (req, res) => {
  res.json(await searchRecords(validateSearchParams(req.query as Record<string, unknown>)));
});
function checkId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new AppError('INVALID_QUERY', '记录标识格式不正确。');
}
app.get('/api/prototype/patients/:id', async (req, res) => {
  checkId(req.params.id);
  res.json(await loadDetail('pms', 'patient', req.params.id));
});
app.get('/api/prototype/records/:source/:type/:id', async (req, res) => {
  const { source, type, id } = req.params;
  if (!SOURCES.includes(source as Source) || !RECORD_TYPES.includes(type as RecordType) || TYPE_SOURCES[type as RecordType] !== source) throw new AppError('INVALID_QUERY', '来源与对象类型不匹配。');
  checkId(id);
  res.json(await loadDetail(source as Source, type as RecordType, id));
});
app.use('/api', (_req, res) => { res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } }); });
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const problem = error instanceof AppError ? error : new AppError('INTERNAL_ERROR', '服务暂时无法完成请求，请重试。', 500);
  if (!(error instanceof AppError)) console.error(error instanceof Error ? error.message : 'Unhandled request error');
  res.status(problem.status).json({ error: { code: problem.code, message: problem.message } });
});

const server = app.listen(config.port, '127.0.0.1', () => console.log(`OIS prototype API: http://127.0.0.1:${config.port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  server.close(() => { void closePools().finally(() => process.exit(0)); });
});
