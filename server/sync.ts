import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RECORD_TYPES, type IndexStatus, type RecordType } from '../shared/types.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { projectRecords, readSnapshot, validateSnapshot } from './data.js';
import type { RecordDocument, SourceDefect } from '../shared/types.js';
import { activeBatch, getIndexStatus, INDEX_OWNER, readManifest, writeManifest, type IndexMeta } from './index-state.js';
import { withDiagnosisFilters } from './diagnosis-filters.js';
import { recordProperties } from './mapping.js';
import { osRequest } from './opensearch.js';

export interface SyncOptions { fault?: 'bulk' | 'afterPublish' | 'publishedMetadata' | 'manifest' }

async function acquireLock(): Promise<() => Promise<void>> {
  await mkdir(config.runtimeDir, { recursive: true });
  const lockPath = path.join(config.runtimeDir, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await open(lockPath, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return async () => { await file.close(); await unlink(lockPath).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const { pid } = JSON.parse(await readFile(lockPath, 'utf8')) as { pid: number };
        if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid lock');
        try { process.kill(pid, 0); }
        catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await unlink(lockPath); continue; }
          throw probe;
        }
      } catch { /* A lock without a known exited owner remains protected. */ }
      throw new AppError('SYNC_BUSY', '已有同步任务运行，或同步锁需要检查。', 409);
    }
  }
  throw new AppError('SYNC_BUSY', '同步锁未释放，请稍后重试。', 409);
}

async function recordFailure(message: string, publicationBatchId?: string): Promise<void> {
  const previous = await readManifest();
  await writeManifest({
    batchId: previous?.batchId || null, syncedAt: previous?.syncedAt || null, total: previous?.total ?? null, defects: previous?.defects,
    lastAttempt: { status: 'failed', at: new Date().toISOString(), message, ...(publicationBatchId ? { publicationBatchId } : {}) },
  });
}

export async function syncRecords(options: SyncOptions = {}): Promise<IndexStatus> {
  const snapshot = await readSnapshot();
  validateSnapshot(snapshot, { real: config.sourceMode === 'real' });
  const batchId = `${new Date().toISOString().replace(/\D/g, '')}-${randomUUID().slice(0, 8)}`;
  const records = projectRecords(snapshot, batchId);
  return publishRecords(records, { ...options, batchId, defects: snapshot.defects ?? [], sourceReadAt: snapshot.readAt });
}

export async function publishRecords(records: RecordDocument[], options: SyncOptions & { batchId?: string; defects?: SourceDefect[]; sourceReadAt?: IndexMeta['sourceReadAt'] } = {}): Promise<IndexStatus> {
  const release = await acquireLock();
  let newIndex: string | undefined;
  let publicationAttempted = false;
  let publicationBatchId: string | undefined;
  try {
    const previous = await activeBatch();
    if (previous && !previous.meta.published) {
      await osRequest(`/${previous.index}/_mapping`, 'PUT', { _meta: { ...previous.meta, published: true } });
    }
    const batchId = options.batchId ?? `${new Date().toISOString().replace(/\D/g, '')}-${randomUUID().slice(0, 8)}`;
    const stamped = withDiagnosisFilters(records.map(record => ({ ...record, batchId })));
    newIndex = `${config.indexAlias}-${batchId}`;
    const typeCounts = Object.fromEntries(RECORD_TYPES.map(type => [type, stamped.filter(row => row.recordType === type).length])) as Record<RecordType, number>;
    const simulations = stamped.filter(row => row.recordType === 'document' && row.documentType === '定位申请单');
    const supportsSimulationFilters = simulations.length > 0
      && simulations.every(row => row.imagingModality !== undefined && row.localizationSites !== undefined);
    let meta: IndexMeta = { owner: INDEX_OWNER, batchId, ready: false, published: false, syncedAt: new Date().toISOString(), total: stamped.length, typeCounts, supportsPatientFilters: true, supportsDiagnosisCoding: true, supportsSimulationFilters, sourceReadAt: options.sourceReadAt };
    await osRequest(`/${newIndex}`, 'PUT', {
      settings: { index: { number_of_shards: 1, number_of_replicas: 0, refresh_interval: '-1' } },
      mappings: { dynamic: 'strict', _meta: meta, properties: recordProperties },
    });
    for (let offset = 0; offset < stamped.length; offset += 500) {
      const chunk = stamped.slice(offset, offset + 500);
      const lines = chunk.flatMap((record, i) => [
        JSON.stringify({ index: { _index: newIndex, _id: record.id } }),
        JSON.stringify(options.fault === 'bulk' && offset === 0 && i === 0 ? { ...record, sourceRevision: 'injected-invalid-long' } : record),
      ]).join('\n') + '\n';
      const bulk = await osRequest<{ errors: boolean; items: { index: { status: number; error?: unknown } }[] }>('/_bulk', 'POST', lines, true);
      if (bulk.errors || bulk.items.length !== chunk.length || bulk.items.some(item => item.index.status >= 300 || item.index.error)) {
        throw new AppError('SYNC_WRITE_FAILED', '部分搜索记录写入失败，未发布本批数据。', 503);
      }
    }
    const refreshed = await osRequest<{ _shards: { failed: number } }>(`/${newIndex}/_refresh`, 'POST');
    if (refreshed._shards.failed) throw new AppError('SYNC_WRITE_FAILED', '搜索索引刷新失败，未发布新数据。', 503);
    const check = await osRequest<{
      timed_out: boolean; _shards: { failed: number };
      hits: { total: { value: number; relation: string } };
      aggregations: { types: { buckets: { key: RecordType; doc_count: number }[] } };
    }>(`/${newIndex}/_search?allow_partial_search_results=false`, 'POST', {
      size: 0, track_total_hits: true, query: { match_all: {} }, aggs: { types: { terms: { field: 'recordType', size: 5 } } },
    });
    const actual = Object.fromEntries(check.aggregations.types.buckets.map(bucket => [bucket.key, bucket.doc_count]));
    if (check.timed_out || check._shards.failed || check.hits.total.relation !== 'eq' || check.hits.total.value !== stamped.length || RECORD_TYPES.some(type => (actual[type] || 0) !== typeCounts[type])) {
      throw new AppError('SYNC_VERIFY_FAILED', '新索引数量校验失败，未发布新数据。', 503);
    }
    // Read every tiny prototype document back: validate identifiers, relations and copied data, not only totals.
    for (let offset = 0; offset < stamped.length; offset += 500) {
      const chunk = stamped.slice(offset, offset + 500);
      const verified = await osRequest<{ docs: { found: boolean; _source: unknown }[] }>(`/${newIndex}/_mget`, 'POST', { ids: chunk.map(record => record.id) });
      if (verified.docs.length !== chunk.length || verified.docs.some((doc, i) => !doc.found || JSON.stringify(doc._source) !== JSON.stringify(chunk[i]))) {
        throw new AppError('SYNC_VERIFY_FAILED', '新索引内容校验失败，未发布新数据。', 503);
      }
    }
    for (const type of RECORD_TYPES) {
      const sample = stamped.find(record => record.recordType === type);
      if (!sample) continue;
      const probe = await osRequest<{
        timed_out: boolean; _shards: { failed: number };
        hits: { total: { value: number; relation: string }; hits: { _id: string }[] };
      }>(`/${newIndex}/_search?allow_partial_search_results=false`, 'POST', {
        size: 1, track_total_hits: true, _source: false,
        query: { bool: { filter: [{ term: { recordType: type } }, { term: { radiotherapyNo: sample.radiotherapyNo } }, { term: { id: sample.id } }] } },
      });
      if (probe.timed_out || probe._shards.failed || probe.hits.total.relation !== 'eq' || probe.hits.total.value !== 1 || probe.hits.hits[0]?._id !== sample.id) {
        throw new AppError('SYNC_VERIFY_FAILED', '新索引抽样查询失败，未发布新数据。', 503);
      }
    }
    meta = { ...meta, ready: true, syncedAt: new Date().toISOString() };
    await osRequest(`/${newIndex}/_mapping`, 'PUT', { _meta: meta });
    publicationAttempted = true;
    publicationBatchId = batchId;
    try {
      const actions: unknown[] = previous ? [{ remove: { index: previous.index, alias: config.indexAlias } }] : [];
      actions.push({ add: { index: newIndex, alias: config.indexAlias } });
      await osRequest('/_aliases', 'POST', { actions });
      if (options.fault === 'afterPublish') throw new Error('Injected lost publication response');
    } catch (error) {
      const observed = await activeBatch();
      if (observed?.index !== newIndex) throw error;
    }
    const observed = await activeBatch();
    if (observed?.index !== newIndex) throw new AppError('SYNC_PUBLICATION_UNKNOWN', '尚未确认新批次发布，请重新读取同步状态。', 503);
    await osRequest(`/${newIndex}/_mapping`, 'PUT', {
      _meta: options.fault === 'publishedMetadata' ? 'injected-invalid-metadata' : { ...meta, published: true },
    });
    await osRequest(`/${newIndex}/_settings`, 'PUT', { index: { blocks: { write: true } } }).catch(() => undefined);
    const listed = await osRequest<Record<string, { mappings?: { _meta?: { owner?: string } } }>>(`/${config.indexAlias}-*/_mapping`).catch(() => ({}));
    const keep = new Set([newIndex, previous?.index].filter((name): name is string => !!name));
    for (const [name, body] of Object.entries(listed)) {
      if (keep.has(name) || body.mappings?._meta?.owner !== INDEX_OWNER) continue;
      await osRequest(`/${encodeURIComponent(name)}`, 'DELETE').catch(() => undefined);
    }
    const lastAttempt = { status: 'success' as const, at: meta.syncedAt, message: `完整同步已发布，共 ${stamped.length} 条记录` };
    try {
      if (options.fault === 'manifest') throw new Error('Injected manifest write failure');
      await writeManifest({ batchId, syncedAt: meta.syncedAt, total: stamped.length, defects: options.defects ?? [], lastAttempt });
    } catch {
      // The alias is authoritative; status reading can reconstruct the local manifest.
      return getIndexStatus();
    }
    return { state: 'ready', sourceMode: config.sourceMode, batchId, syncedAt: meta.syncedAt, total: stamped.length, defects: options.defects ?? [], lastAttempt };
  } catch (error) {
    const appError = error instanceof AppError ? error : new AppError('SYNC_FAILED', '同步失败，请检查原型数据源和搜索服务后重试。', 503);
    await recordFailure(appError.message, publicationBatchId).catch(() => {});
    if (newIndex && !publicationAttempted) await osRequest(`/${newIndex}`, 'DELETE').catch(() => {});
    throw appError;
  } finally { await release(); }
}
