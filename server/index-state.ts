import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexStatus, RecordType, Source, SyncAttempt } from '../shared/types.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import { OpenSearchError, osRequest } from './opensearch.js';

export const INDEX_OWNER = 'ois-search-prototype';
export const BATCH_PATTERN = /^\d{17}-[a-f0-9]{8}$/;
export interface IndexMeta {
  owner: string;
  batchId: string;
  ready: boolean;
  published: boolean;
  syncedAt: string;
  total: number;
  typeCounts: Record<RecordType, number>;
  sourceReadAt?: Partial<Record<Source, string>>;
}
export interface ActiveBatch { index: string; meta: IndexMeta }
interface Manifest { batchId: string | null; syncedAt: string | null; total: number | null; lastAttempt: SyncAttempt | null }

export async function readManifest(): Promise<Manifest | null> {
  try { return JSON.parse(await readFile(path.join(config.runtimeDir, 'sync-state.json'), 'utf8')) as Manifest; }
  catch { return null; }
}

export async function writeManifest(manifest: Manifest): Promise<void> {
  await mkdir(config.runtimeDir, { recursive: true });
  const target = path.join(config.runtimeDir, 'sync-state.json');
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await rename(temp, target);
}

export async function readIndexMeta(index: string): Promise<IndexMeta> {
  const data = await osRequest<Record<string, { mappings: { _meta?: IndexMeta } }>>(`/${encodeURIComponent(index)}/_mapping`);
  const meta = data[index]?.mappings._meta;
  if (!meta || meta.owner !== INDEX_OWNER || !meta.ready || `${config.indexAlias}-${meta.batchId}` !== index) {
    throw new AppError('INVALID_INDEX', '搜索批次尚未完整发布，请重新同步。', 503);
  }
  return meta;
}

export async function activeBatch(): Promise<ActiveBatch | null> {
  let aliases: Record<string, unknown>;
  try { aliases = await osRequest<Record<string, unknown>>(`/_alias/${config.indexAlias}`); }
  catch (error) { if (error instanceof OpenSearchError && error.status === 404) return null; throw error; }
  const names = Object.keys(aliases);
  if (names.length !== 1 || !names[0].startsWith(`${config.indexAlias}-`)) {
    throw new AppError('INVALID_INDEX', '搜索索引状态异常，请检查同步状态。', 503);
  }
  return { index: names[0], meta: await readIndexMeta(names[0]) };
}

export async function resolveBatch(batchId?: string): Promise<ActiveBatch> {
  const current = await activeBatch();
  if (!batchId) {
    if (!current) throw new AppError('NOT_SYNCED', '尚未同步搜索数据，请先运行本地同步脚本。', 409);
    return current;
  }
  if (!BATCH_PATTERN.test(batchId)) throw new AppError('BATCH_UNAVAILABLE', '原查询批次已不可用，请重新查询。', 409);
  if (current?.meta.batchId === batchId) return current;
  const index = `${config.indexAlias}-${batchId}`;
  try {
    const meta = await readIndexMeta(index);
    if (!meta.published) throw new Error('Unpublished batch');
    return { index, meta };
  } catch (error) {
    if (error instanceof OpenSearchError && error.status !== 404) throw error;
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    throw new AppError('BATCH_UNAVAILABLE', '原查询批次已不可用，请重新查询。', 409);
  }
}

export async function getIndexStatus(): Promise<IndexStatus> {
  const manifest = await readManifest();
  try {
    const current = await activeBatch();
    if (!current) return { state: 'not_synced', batchId: null, syncedAt: null, total: null, lastAttempt: manifest?.lastAttempt || null };
    const { batchId, syncedAt, total } = current.meta;
    const recoveredPublication = manifest?.lastAttempt?.status === 'failed'
      && manifest.lastAttempt.publicationBatchId === batchId;
    const lastAttempt = !recoveredPublication && manifest?.lastAttempt && manifest.lastAttempt.at >= syncedAt
      ? manifest.lastAttempt
      : { status: 'success' as const, at: syncedAt, message: '完整同步已发布' };
    let warning: string | undefined;
    if (manifest?.batchId !== batchId || recoveredPublication) {
      try { await writeManifest({ batchId, syncedAt, total, lastAttempt }); }
      catch { warning = '搜索数据已发布，但本地同步记录暂时无法保存。'; }
    }
    return { state: 'ready', batchId, syncedAt, total, lastAttempt, ...(warning ? { warning } : {}) };
  } catch {
    return { state: 'unavailable', batchId: null, syncedAt: null, total: null, lastAttempt: manifest?.lastAttempt || null, warning: '无法读取搜索服务状态，请检查本地服务后重试。' };
  }
}
