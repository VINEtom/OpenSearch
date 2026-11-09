import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { baseline, idFor, paginationDocuments, repeatedDiagnosis } from '../fixtures/samples.js';
import { seed } from '../scripts/seed.js';
import { config } from '../server/config.js';
import { closePools, getPool, loadDetail, readSnapshot } from '../server/data.js';
import { AppError } from '../server/errors.js';
import { getIndexStatus, readIndexMeta, readManifest, writeManifest } from '../server/index-state.js';
import { parsePatientQuery } from '../server/patient-query.js';
import { searchRecords } from '../server/search.js';
import { syncRecords } from '../server/sync.js';
import { osRequest } from '../server/opensearch.js';
import { TYPE_SOURCES, type IndexStatus, type RecordType, type SearchHit, type SearchParams, type SearchResponse } from '../shared/types.js';

// These tests use only the three disposable demo databases and the dedicated
// local OpenSearch instance. Run serially while no sample writer is active.
const P1_RECORDS = ['P1', 'D1', 'D2', 'R1', 'R2', 'T1', 'O1', 'O4'];
const P2_RECORDS = ['P2', 'D3', 'T2', 'O2'];
const NPC_RECORDS = ['D1', 'D3', 'R1', 'O1', 'O2', 'O3', 'O5'];
const BREATHING_RECORDS = ['R1', 'T1', 'O4'];
const UPDATED_AT = '2026-11-08T00:00:00+08:00';
const BASE_COUNTS = { patient: 3, diagnosis: 4, plan_request: 2, treatment_plan: 2, document: 5 };
let initialized = false;

function recordType(symbol: string): RecordType {
  const types: Record<string, RecordType> = { P: 'patient', D: 'diagnosis', R: 'plan_request', T: 'treatment_plan', O: 'document' };
  const type = types[symbol[0]];
  assert.ok(type, `Unknown sample symbol: ${symbol}`);
  return type;
}

function identity(symbol: string): string {
  const type = recordType(symbol);
  return `${TYPE_SOURCES[type]}:${type}:${idFor(symbol)}`;
}

function assertRecords(response: SearchResponse, symbols: string[]): void {
  assert.equal(response.total, symbols.length);
  assert.deepEqual(response.hits.map((hit) => `${hit.source}:${hit.recordType}:${hit.sourceId}`).sort(), symbols.map(identity).sort());
  assert.equal(new Set(response.hits.map((hit) => hit.id)).size, response.hits.length, 'No duplicate objects');
  assert.ok(response.hits.every((hit) => hit.batchId === response.batchId), 'Every hit belongs to the returned batch');
}

async function query(q: string, params: Omit<SearchParams, 'q'> = {}): Promise<SearchResponse> {
  return searchRecords({ q, ...params });
}

function findHit(response: SearchResponse, symbol: string): SearchHit {
  const hit = response.hits.find((record) => record.sourceId === idFor(symbol));
  assert.ok(hit, `Expected ${symbol} in search results`);
  return hit;
}

async function detail(symbol: string) {
  const type = recordType(symbol);
  return loadDetail(TYPE_SOURCES[type], type, idFor(symbol));
}

async function restoreBaseline(): Promise<IndexStatus> {
  await seed({ reset: true });
  const status = await syncRecords();
  assert.equal(status.state, 'ready');
  assert.equal(status.total, 16);
  assert.ok(status.batchId);
  assert.equal(status.lastAttempt?.status, 'success');
  return status;
}

async function withBaseline(run: (status: IndexStatus) => Promise<void>): Promise<void> {
  const status = await restoreBaseline();
  try {
    await run(status);
  } finally {
    await restoreBaseline();
  }
}

async function withIsolatedManifest(previous: IndexStatus, run: () => Promise<void>): Promise<void> {
  const originalRuntime = config.runtimeDir;
  const temporaryRuntime = await mkdtemp(path.join(os.tmpdir(), 'ois-publication-recovery-'));
  config.runtimeDir = temporaryRuntime;
  try {
    // Status polling in another process must not repair the fixture before this test observes it.
    await writeManifest({ batchId: previous.batchId, syncedAt: previous.syncedAt, total: previous.total, lastAttempt: previous.lastAttempt });
    await run();
  } finally {
    config.runtimeDir = originalRuntime;
    await rm(temporaryRuntime, { recursive: true, force: true });
  }
}

async function assertUnpublished(previous: IndexStatus): Promise<void> {
  const current = await getIndexStatus();
  assert.equal(current.state, 'ready');
  assert.equal(current.batchId, previous.batchId);
  assert.equal(current.syncedAt, previous.syncedAt);
  assert.equal(current.total, 16);
  assert.equal(current.lastAttempt?.status, 'failed');
  assert.ok(current.lastAttempt?.message);
  assertRecords(await query('屏气'), BREATHING_RECORDS);
}

async function expectAppError(operation: Promise<unknown>, code?: string): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AppError, `Expected AppError, received ${String(error)}`);
    if (code) assert.equal(error.code, code);
    assert.ok(error.message);
    return true;
  });
}

async function insertDocument(symbol: string, body = '屏气复核已完成。', title = '复核记录'): Promise<void> {
  await getPool('emr').query(
    `INSERT INTO documents (id, patient_id, document_type, title, body_text, document_on, created_at, updated_at, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 1)`,
    [idFor(symbol), idFor('P1'), '治疗备注', title, body, '2026-11-08', UPDATED_AT],
  );
}

function comparableSnapshot(snapshot: Awaited<ReturnType<typeof readSnapshot>>) {
  return Object.fromEntries(
    Object.entries(snapshot)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, rows]) => [key, [...rows].sort((a, b) => a.id.localeCompare(b.id))]),
  );
}

describe('OIS search integration: real PostgreSQL and OpenSearch', { concurrency: false, timeout: 600_000 }, () => {
  before(async () => {
    assert.deepEqual(config.databases, { pms: 'pms_demo', emr: 'emr_demo', rvs: 'rvs_demo' });
    assert.equal(config.pgPort, 54329, 'Integration tests require the dedicated PostgreSQL port');
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(config.pgHost), 'Integration tests require local PostgreSQL');
    const osUrl = new URL(config.opensearchUrl);
    assert.equal(osUrl.port, '9207', 'Integration tests require the dedicated OpenSearch port');
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(osUrl.hostname), 'Integration tests require local OpenSearch');
    assert.equal(config.indexAlias, 'ois-records');
    for (const source of ['pms', 'emr', 'rvs'] as const) {
      const result = await getPool(source).query('SELECT current_database() AS name');
      assert.equal(result.rows[0].name, config.databases[source]);
    }
    initialized = true;
    await restoreBaseline();
  });

  after(async () => {
    try {
      if (initialized) {
        await restoreBaseline();
        assertRecords(await query('000123'), P1_RECORDS);
        assertRecords(await query('屏气'), BREATHING_RECORDS);
      }
    } finally {
      await closePools();
    }
  });

  it('publishes all 16 available objects with correct source and type totals', async () => {
    const status = await getIndexStatus();
    assert.equal(status.state, 'ready');
    assert.equal(status.total, 16);
    assert.ok(status.syncedAt);
    const responses = await Promise.all(['000123', '00123', '000124'].map((q) => query(q)));
    const hits = responses.flatMap((response) => response.hits);
    assert.equal(hits.length, 16);
    assert.deepEqual(Object.fromEntries(Object.keys(BASE_COUNTS).map((type) => [type, hits.filter((hit) => hit.recordType === type).length])), BASE_COUNTS);
    assert.deepEqual(Object.fromEntries(['pms', 'emr', 'rvs'].map((source) => [source, hits.filter((hit) => hit.source === source).length])), { pms: 3, emr: 11, rvs: 2 });
    assert.ok(!hits.some((hit) => [idFor('R3'), idFor('T3')].includes(hit.sourceId)));
  });

  it('distinguishes first sync failure from zero matches and recovers with a complete first publication', async () => {
    const originalAlias = config.indexAlias;
    const originalRuntime = config.runtimeDir;
    const temporaryRuntime = await mkdtemp(path.join(os.tmpdir(), 'ois-first-sync-'));
    config.indexAlias = `ois-records-first-${randomUUID().slice(0, 8)}`;
    config.runtimeDir = temporaryRuntime;
    let publishedIndex: string | undefined;
    try {
      assert.equal((await getIndexStatus()).state, 'not_synced');
      await expectAppError(query('屏气'), 'NOT_SYNCED');
      await expectAppError(syncRecords({ fault: 'bulk' }), 'SYNC_WRITE_FAILED');
      const failed = await getIndexStatus();
      assert.equal(failed.state, 'not_synced');
      assert.equal(failed.total, null);
      assert.equal(failed.lastAttempt?.status, 'failed');
      await expectAppError(query('屏气'), 'NOT_SYNCED');
      const recovered = await syncRecords();
      publishedIndex = `${config.indexAlias}-${recovered.batchId}`;
      assert.equal(recovered.total, 16);
      assert.equal(recovered.lastAttempt?.status, 'success');
      assertRecords(await query('屏气'), BREATHING_RECORDS);
    } finally {
      try { if (publishedIndex) await osRequest(`/${publishedIndex}`, 'DELETE'); }
      finally {
        config.indexAlias = originalAlias;
        config.runtimeDir = originalRuntime;
        await rm(temporaryRuntime, { recursive: true, force: true });
      }
    }
  });

  it('returns exact expected sets for identifiers, names, titles, types, codes and body text', async () => {
    const cases: [string, string[]][] = [
      ['000123', P1_RECORDS], ['00123', P2_RECORDS], ['林示例', [...P1_RECORDS, ...P2_RECORDS]],
      ['屏气', BREATHING_RECORDS], ['标本', ['O1']], ['病理报告', ['O1']],
      ['REQ-001', ['R1']], ['PLAN-001', ['T1']], ['DEMO-NPC', ['D1', 'D3']],
      ['鼻咽癌', NPC_RECORDS], ['火星探测', []],
    ];
    for (const [q, expected] of cases) assertRecords(await query(q), expected);
    const sameName = await query('林示例');
    assert.deepEqual([...new Set(sameName.hits.map((hit) => hit.radiotherapyNo))].sort(), ['000123', '00123']);
  });

  it('matches patients once, using the date and prescription of the same confirmed diagnosis', async () => {
    await withBaseline(async () => {
      const text = '最近三个月确诊鼻咽癌、处方不少于 20 次';
      const filters = parsePatientQuery(text)!;
      const snapshot = baseline();
      const [npc, lung, suspected] = snapshot.diagnoses;
      npc.diagnosed_on = filters.diagnosedFrom;
      lung.diagnosed_on = filters.diagnosedThrough;
      suspected.diagnosed_on = filters.diagnosedThrough;
      const repeat = { ...repeatedDiagnosis(), diagnosed_on: filters.diagnosedThrough };
      snapshot.diagnoses.push(repeat);
      const [npcRequest, lungRequest, deletedRequest] = snapshot.planRequests;
      npcRequest.prescribed_fractions = 20;
      lungRequest.prescribed_fractions = 30;
      snapshot.planRequests.push(
        { ...npcRequest, id: idFor('R4'), request_no: 'REQ-004', diagnosis_ids: [repeat.id] },
        { ...deletedRequest, id: idFor('R5'), request_no: 'REQ-005', deleted_at: null },
      );
      await seed({ reset: true, snapshot });
      await syncRecords();
      const result = await query(text);
      assert.deepEqual(result.patientFilters, filters);
      assertRecords(result, ['P1']);
      assertRecords(await query('最近3个月确诊鼻咽癌,处方至少21次'), []);
      assertRecords(await query(text, { scope: 'patient', patientId: idFor('P2') }), []);

      const beforeWindow = new Date(filters.diagnosedFrom);
      beforeWindow.setUTCDate(beforeWindow.getUTCDate() - 1);
      await getPool('emr').query('UPDATE diagnoses SET diagnosed_on = $1 WHERE id = ANY($2::uuid[])',
        [beforeWindow.toISOString().slice(0, 10), [npc.id, repeat.id]]);
      await syncRecords();
      assertRecords(await query(text), []);
      assertRecords(await query('屏气'), [...BREATHING_RECORDS, 'R4']);
    });
  });

  it('highlights single Han characters and preserves full-word matching', async () => {
    await withBaseline(async () => {
      await insertDocument('O6', '显示屏已开启。');
      await syncRecords();
      const single = await query('屏');
      const full = await query('屏气');
      assertRecords(single, [...BREATHING_RECORDS, 'O6']);
      assertRecords(full, BREATHING_RECORDS);
      for (const response of [single, full]) {
        for (const hit of response.hits) {
          const match = hit.matchedFields.find((field) => field.field === 'bodyText');
          assert.ok(match);
          assert.deepEqual(match.ranges.map(([start, end]) => match.text.slice(start, end)), [response.q]);
        }
      }
    });
  });

  it('returns explicit matching fields, complete identifier values and usable highlight ranges', async () => {
    const cases: [string, string, string][] = [
      ['屏气', 'R1', 'bodyText'], ['屏气', 'T1', 'bodyText'], ['屏气', 'O4', 'bodyText'],
      ['标本', 'O1', 'title'], ['病理报告', 'O1', 'documentType'], ['REQ-001', 'R1', 'recordNo'],
      ['PLAN-001', 'T1', 'recordNo'], ['DEMO-NPC', 'D1', 'code'], ['000123', 'P1', 'radiotherapyNo'],
    ];
    for (const [q, symbol, field] of cases) {
      const hit = findHit(await query(q), symbol);
      const match = hit.matchedFields.find((item) => item.field === field);
      assert.ok(match, `${symbol} should identify ${field} for ${q}`);
      assert.ok(match.label);
      assert.ok(match.text.includes(q));
      assert.ok(match.ranges.length > 0);
      for (const [start, end] of match.ranges) assert.ok(start >= 0 && end > start && end <= match.text.length);
      if (['recordNo', 'code', 'radiotherapyNo'].includes(field)) assert.equal(match.text, q);
    }
    const diagnosis = findHit(await query('DEMO-NPC'), 'D1');
    assert.equal(diagnosis.codeSystem, 'DEMO-ONCOLOGY');
    assert.equal(diagnosis.codeVersion, '1');
  });

  it('keeps type counts based on keyword, source and patient scope when the selected type changes', async () => {
    assertRecords(await query('屏气', { scope: 'patient', patientId: idFor('P1').toUpperCase() }), BREATHING_RECORDS);
    const emr = await query('屏气', { source: 'emr' });
    assertRecords(emr, ['R1', 'O4']);
    assert.deepEqual(emr.typeCounts, { patient: 0, diagnosis: 0, plan_request: 1, treatment_plan: 0, document: 1 });
    const documents = await query('屏气', { source: 'emr', type: 'document' });
    assertRecords(documents, ['O4']);
    assert.deepEqual(documents.typeCounts, emr.typeCounts);
    assertRecords(await query('鼻咽癌', { scope: 'patient', patientId: idFor('P1') }), ['D1', 'R1', 'O1']);
    const empty = await query('屏气', { scope: 'patient', patientId: idFor('P2') });
    assertRecords(empty, []);
    assert.equal(empty.scope, 'patient');
    assert.equal(empty.patientId, idFor('P2'));
    await detail('P1');
    assertRecords(await query('鼻咽癌'), NPC_RECORDS);
  });

  it('preserves suspected, excluded and family-history context and genuine missing values', async () => {
    const response = await query('鼻咽癌');
    assert.equal(findHit(response, 'D1').confirmationStatus, 'confirmed');
    assert.equal(findHit(response, 'D3').confirmationStatus, 'suspected');
    for (const [symbol, context] of [['O2', '考虑鼻咽癌可能'], ['O3', '已排除鼻咽癌'], ['O5', '父亲曾患鼻咽癌']]) {
      const hit = findHit(response, symbol);
      assert.ok(hit.bodyText?.includes(context));
      assert.ok(hit.matchedFields.some((field) => field.field === 'bodyText' && field.text.includes(context)));
      assert.equal(hit.confirmationStatus, null, 'A mention must not become a diagnosis');
    }
    const patient = await detail('P3');
    const diagnosis = await detail('D4');
    assert.equal(patient.record.birthDate, null);
    assert.equal(diagnosis.record.businessDate, null);
    assert.equal(diagnosis.record.code, null);
    assert.equal(diagnosis.record.codeSystem, null);
    assert.equal(diagnosis.record.codeVersion, null);
    assert.equal(diagnosis.record.confirmationStatus, 'unknown');
  });

  it('follows exact plan, request, diagnosis and source-document UUIDs and keeps same-patient records distinct', async () => {
    for (const [from, to] of [['T1', 'R1'], ['R1', 'D1'], ['D1', 'O1']]) {
      const current = await detail(from);
      assert.equal(current.record.sourceId, idFor(from));
      assert.equal(current.patient.sourceId, idFor('P1'));
      const relation = current.relations.find((item) => item.sourceId === idFor(to));
      assert.ok(relation, `${from} must link to ${to}`);
      assert.equal(relation.recordType, recordType(to));
      assert.equal(relation.source, TYPE_SOURCES[recordType(to)]);
      assert.equal(relation.patientId, idFor('P1'));
      assert.equal(relation.availability, 'available');
    }
    const patient = await detail('P1');
    for (const symbol of ['D1', 'D2', 'R1', 'R2']) {
      assert.ok(patient.relations.some((relation) => relation.sourceId === idFor(symbol)));
      assert.equal((await detail(symbol)).record.sourceId, idFor(symbol));
    }
    assert.deepEqual((await detail('R1')).record.diagnosisIds, [idFor('D1'), idFor('D2')].sort());
    assert.deepEqual((await detail('R2')).record.diagnosisIds, [idFor('D2')]);
    assert.ok(!patient.relations.some((relation) => relation.recordType === 'document' && [idFor('R1'), idFor('R2')].includes(relation.sourceId)));
  });

  it('keeps a valid plan searchable while reporting its deleted request as unavailable', async () => {
    assertRecords(await query('PLAN-002'), ['T2']);
    const plan = await detail('T2');
    assert.equal(plan.record.planRequestId, idFor('R3'));
    const request = plan.relations.find((relation) => relation.sourceId === idFor('R3'));
    assert.ok(request);
    assert.equal(request.availability, 'deleted');
    await expectAppError(detail('R3'), 'DELETED');
    await expectAppError(detail('T3'), 'VOIDED');
    await expectAppError(loadDetail('emr', 'document', idFor('O999')), 'NOT_FOUND');
  });

  it('does not change source records while searching and reading all five record types', async () => {
    const beforeRead = comparableSnapshot(await readSnapshot());
    await query('屏气');
    for (const symbol of ['P1', 'D1', 'R1', 'T1', 'O1', 'P2', 'T2']) await detail(symbol);
    const afterRead = comparableSnapshot(await readSnapshot());
    assert.deepEqual(afterRead, beforeRead, 'All statuses, versions, dates and text must remain unchanged');
  });

  it('ranks an exact plan number above a body reference to that number', async () => {
    await withBaseline(async () => {
      await getPool('emr').query('UPDATE documents SET body_text=$1, revision=revision+1, updated_at=$2 WHERE id=$3', ['引用编号 PLAN-001', UPDATED_AT, idFor('O3')]);
      await syncRecords();
      const response = await query('PLAN-001');
      assertRecords(response, ['T1', 'O3']);
      assert.equal(response.hits[0].sourceId, idFor('T1'));
    });
  });

  it('keeps old indexed content until sync while detail immediately reads the new source revision', async () => {
    await withBaseline(async (initial) => {
      const original = findHit(await query('屏气'), 'O4');
      await getPool('emr').query('UPDATE documents SET body_text=$1, revision=revision+1, updated_at=$2 WHERE id=$3', ['训练记录已更新。', UPDATED_AT, idFor('O4')]);
      const stillIndexed = await query('屏气');
      assertRecords(stillIndexed, BREATHING_RECORDS);
      assert.equal(stillIndexed.batchId, initial.batchId);
      assert.equal(findHit(stillIndexed, 'O4').bodyText, original.bodyText);
      const current = await detail('O4');
      assert.equal(current.record.bodyText, '训练记录已更新。');
      assert.ok(current.record.sourceRevision > original.sourceRevision);
      await syncRecords();
      assertRecords(await query('屏气'), ['R1', 'T1']);
    });
  });

  it('adds a new document without duplicate objects or stale totals', async () => {
    await withBaseline(async () => {
      await insertDocument('O6');
      const status = await syncRecords();
      assert.equal(status.total, 17);
      assertRecords(await query('屏气'), [...BREATHING_RECORDS, 'O6']);
      const added = await detail('O6');
      assert.equal(added.record.bodyText, '屏气复核已完成。');
      assert.equal(added.patient.sourceId, idFor('P1'));
    });
  });

  it('propagates corrected patient data to all eight records while retaining identity and relations', async () => {
    await withBaseline(async () => {
      await getPool('pms').query('UPDATE patients SET name=$1, radiotherapy_no=$2, sex=$3, birth_date=$4, revision=revision+1, updated_at=$5 WHERE id=$6', ['林更新', '000999', 'female', '1990-01-01', UPDATED_AT, idFor('P1')]);
      await syncRecords();
      assertRecords(await query('000123'), []);
      const response = await query('000999');
      assertRecords(response, P1_RECORDS);
      for (const hit of response.hits) {
        assert.equal(hit.patientId, idFor('P1'));
        assert.equal(hit.patientName, '林更新');
        assert.equal(hit.radiotherapyNo, '000999');
        assert.equal(hit.sex, 'female');
        assert.equal(hit.birthDate, '1990-01-01');
        assert.equal(hit.patientRevision, 2);
      }
      assert.deepEqual(findHit(response, 'R1').diagnosisIds, [idFor('D1'), idFor('D2')].sort());
      assert.equal(findHit(response, 'T1').planRequestId, idFor('R1'));
    });
  });

  it('updates diagnosis status and date without filtering text mentions by clinical certainty', async () => {
    await withBaseline(async () => {
      await getPool('emr').query('UPDATE diagnoses SET confirmation_status=$1, diagnosed_on=$2, revision=revision+1, updated_at=$3 WHERE id=$4', ['suspected', '2026-10-10', UPDATED_AT, idFor('D1')]);
      await syncRecords();
      const response = await query('鼻咽癌');
      assertRecords(response, NPC_RECORDS);
      for (const record of [findHit(response, 'D1'), (await detail('D1')).record]) {
        assert.equal(record.confirmationStatus, 'suspected');
        assert.equal(record.businessDate, '2026-10-10');
      }
    });
  });

  it('uses the newly saved diagnosis when a request changes its same-patient association', async () => {
    await withBaseline(async () => {
      await getPool('emr').query('DELETE FROM plan_request_diagnoses WHERE plan_request_id=$1 AND diagnosis_id<>$2', [idFor('R1'), idFor('D2')]);
      await getPool('emr').query('UPDATE plan_requests SET revision=revision+1, updated_at=$1 WHERE id=$2', [UPDATED_AT, idFor('R1')]);
      await syncRecords();
      assert.deepEqual(findHit(await query('REQ-001'), 'R1').diagnosisIds, [idFor('D2')]);
      const current = await detail('R1');
      assert.deepEqual(current.record.diagnosisIds, [idFor('D2')]);
      assert.ok(current.relations.some((relation) => relation.sourceId === idFor('D2')));
      assert.ok(!current.relations.some((relation) => relation.recordType === 'diagnosis' && relation.sourceId === idFor('D1')));
    });
  });

  it('uses the newly saved request and its diagnosis when a plan changes association', async () => {
    await withBaseline(async () => {
      await getPool('rvs').query('UPDATE treatment_plans SET plan_request_id=$1, revision=revision+1, updated_at=$2 WHERE id=$3', [idFor('R2'), UPDATED_AT, idFor('T1')]);
      await syncRecords();
      const hit = findHit(await query('PLAN-001'), 'T1');
      assert.equal(hit.planRequestId, idFor('R2'));
      assert.deepEqual(hit.diagnosisIds, [idFor('D2')]);
      const current = await detail('T1');
      assert.equal(current.record.planRequestId, idFor('R2'));
      assert.ok(current.relations.some((relation) => relation.sourceId === idFor('R2')));
      assert.ok(!current.relations.some((relation) => relation.recordType === 'plan_request' && relation.sourceId === idFor('R1')));
    });
  });

  it('shows a plan status change without treating it as deletion or execution', async () => {
    await withBaseline(async () => {
      await getPool('rvs').query('UPDATE treatment_plans SET status=$1, revision=revision+1, updated_at=$2 WHERE id=$3', ['待复核', UPDATED_AT, idFor('T1')]);
      await syncRecords();
      const response = await query('屏气');
      assertRecords(response, BREATHING_RECORDS);
      assert.equal(findHit(response, 'T1').planStatus, '待复核');
      assert.equal((await detail('T1')).record.planStatus, '待复核');
    });
  });

  for (const field of ['deleted_at', 'voided_at'] as const) {
    it(`removes ${field === 'deleted_at' ? 'deleted' : 'voided'} documents and restores them exactly once`, async () => {
      await withBaseline(async () => {
        await getPool('emr').query(`UPDATE documents SET ${field}=$1, revision=revision+1, updated_at=$1 WHERE id=$2`, [UPDATED_AT, idFor('O4')]);
        await expectAppError(detail('O4'), field === 'deleted_at' ? 'DELETED' : 'VOIDED');
        assert.equal((await syncRecords()).total, 15);
        assertRecords(await query('屏气'), ['R1', 'T1']);
        await getPool('emr').query(`UPDATE documents SET ${field}=NULL, revision=revision+1, updated_at=$1 WHERE id=$2`, [UPDATED_AT, idFor('O4')]);
        assert.equal((await syncRecords()).total, 16);
        assertRecords(await query('屏气'), BREATHING_RECORDS);
        assert.equal((await detail('O4')).record.sourceRevision, 3);
      });
    });
  }

  for (const [symbol, table, field] of [['R1', 'plan_requests', 'voided_at'], ['D1', 'diagnoses', 'deleted_at']] as const) {
    it(`keeps independent children searchable when ${symbol} becomes unavailable`, async () => {
      await withBaseline(async () => {
        await getPool('emr').query(`UPDATE ${table} SET ${field}=$1, revision=revision+1, updated_at=$1 WHERE id=$2`, [UPDATED_AT, idFor(symbol)]);
        assert.equal((await syncRecords()).total, 15);
        assertRecords(await query('PLAN-001'), ['T1']);
        assert.equal((await detail('T1')).record.sourceId, idFor('T1'));
        await expectAppError(detail(symbol), field === 'deleted_at' ? 'DELETED' : 'VOIDED');
      });
    });
  }

  it('excludes all eight records of a deleted patient and restores the complete set', async () => {
    await withBaseline(async () => {
      await getPool('pms').query('UPDATE patients SET deleted_at=$1, revision=revision+1, updated_at=$1 WHERE id=$2', [UPDATED_AT, idFor('P1')]);
      assert.equal((await syncRecords()).total, 8);
      assertRecords(await query('000123'), []);
      assertRecords(await query('00123'), P2_RECORDS);
      await getPool('pms').query('UPDATE patients SET deleted_at=NULL, revision=revision+1, updated_at=$1 WHERE id=$2', [UPDATED_AT, idFor('P1')]);
      assert.equal((await syncRecords()).total, 16);
      assertRecords(await query('000123'), P1_RECORDS);
    });
  });

  it('rejects a same-database request-to-diagnosis association belonging to another patient', async () => {
    await withBaseline(async () => {
      await assert.rejects(
        getPool('emr').query('INSERT INTO plan_request_diagnoses (id, plan_request_id, diagnosis_id, patient_id) VALUES ($1, $2, $3, $4)', [idFor('bad-link'), idFor('R1'), idFor('D3'), idFor('P1')]),
        (error: unknown) => (error as { code?: string }).code === '23503',
      );
      assert.deepEqual((await detail('R1')).record.diagnosisIds, [idFor('D1'), idFor('D2')].sort());
    });
  });

  for (const invalid of ['missing-request', 'different-patient'] as const) {
    it(`rejects a cross-database ${invalid} and preserves the last complete batch`, async () => {
      await withBaseline(async (previous) => {
        if (invalid === 'missing-request') {
          await getPool('rvs').query('UPDATE treatment_plans SET plan_request_id=$1, revision=revision+1, updated_at=$2 WHERE id=$3', [idFor('R999'), UPDATED_AT, idFor('T1')]);
        } else {
          await getPool('rvs').query('UPDATE treatment_plans SET patient_id=$1, revision=revision+1, updated_at=$2 WHERE id=$3', [idFor('P2'), UPDATED_AT, idFor('T1')]);
        }
        await expectAppError(syncRecords(), 'RELATION_ERROR');
        await assertUnpublished(previous);
        await expectAppError(detail('T1'), 'RELATION_ERROR');
      });
    });
  }

  for (const [source, table] of [['pms', 'patients'], ['emr', 'diagnoses'], ['rvs', 'treatment_plans']] as const) {
    it(`does not publish a partial batch when ${source.toUpperCase()} cannot be read`, async () => {
      await withBaseline(async (previous) => {
        const unavailable = `${table}_integration_unavailable`;
        await getPool(source).query(`ALTER TABLE ${table} RENAME TO ${unavailable}`);
        try {
          await expectAppError(syncRecords(), 'SOURCE_UNAVAILABLE');
          await assertUnpublished(previous);
          await expectAppError(detail('O4'), 'SOURCE_UNAVAILABLE');
        } finally {
          await getPool(source).query(`ALTER TABLE ${unavailable} RENAME TO ${table}`);
        }
      });
    });
  }

  it('does not publish when any bulk-index write fails and succeeds after retry', async () => {
    await withBaseline(async (previous) => {
      await expectAppError(syncRecords({ fault: 'bulk' }));
      await assertUnpublished(previous);
      const retried = await syncRecords();
      assert.notEqual(retried.batchId, previous.batchId);
      assert.equal(retried.total, 16);
      assertRecords(await query('屏气'), BREATHING_RECORDS);
    });
  });

  for (const fault of ['afterPublish', 'manifest'] as const) {
    it(`recovers the actual published batch after ${fault}`, async () => {
      await withBaseline(async (previous) => {
        await insertDocument('O6');
        const published = await syncRecords({ fault });
        assert.equal(published.state, 'ready');
        assert.notEqual(published.batchId, previous.batchId);
        assert.equal(published.total, 17);
        const actual = await getIndexStatus();
        assert.equal(actual.batchId, published.batchId);
        assert.equal(actual.lastAttempt?.status, 'success');
        const response = await query('屏气');
        assert.equal(response.batchId, published.batchId);
        assertRecords(response, [...BREATHING_RECORDS, 'O6']);
      });
    });
  }

  for (const storedBatch of ['previous', 'current'] as const) {
    it(`repairs a published batch after metadata failure when the manifest points to the ${storedBatch} batch`, async () => {
      await withBaseline(async (previous) => {
        await withIsolatedManifest(previous, async () => {
          await insertDocument('O6');
          await expectAppError(syncRecords({ fault: 'publishedMetadata' }), 'SYNC_FAILED');
          const failed = await readManifest();
          assert.ok(failed);
          assert.equal(failed.lastAttempt?.status, 'failed');
          assert.equal(failed.batchId, previous.batchId);
          const response = await query('屏气');
          assertRecords(response, [...BREATHING_RECORDS, 'O6']);
          assert.notEqual(response.batchId, previous.batchId);
          assert.equal(failed.lastAttempt.publicationBatchId, response.batchId);
          assert.equal((await readIndexMeta(`${config.indexAlias}-${response.batchId}`)).published, false);
          if (storedBatch === 'current') {
            await writeManifest({ ...failed, batchId: response.batchId, syncedAt: response.syncedAt, total: 17 });
          }

          const recovered = await getIndexStatus();
          assert.equal(recovered.state, 'ready');
          assert.equal(recovered.batchId, response.batchId);
          assert.equal(recovered.total, 17);
          assert.equal(recovered.lastAttempt?.status, 'success');
          const repaired = await readManifest();
          assert.equal(repaired?.batchId, response.batchId);
          assert.equal(repaired?.lastAttempt?.status, 'success');
          assert.equal(repaired?.lastAttempt?.publicationBatchId, undefined);
          assert.equal((await getIndexStatus()).lastAttempt?.status, 'success');
        });
      });
    });
  }

  it('preserves a later genuine failure instead of recovering an earlier uncertain publication', async () => {
    await withBaseline(async (previous) => {
      await withIsolatedManifest(previous, async () => {
        await insertDocument('O6');
        await expectAppError(syncRecords({ fault: 'publishedMetadata' }), 'SYNC_FAILED');
        const published = await query('屏气');
        assertRecords(published, [...BREATHING_RECORDS, 'O6']);
        assert.equal((await readManifest())?.lastAttempt?.publicationBatchId, published.batchId);

        // Start a later attempt before reading status. It repairs the old metadata but genuinely fails its new bulk write.
        await expectAppError(syncRecords({ fault: 'bulk' }), 'SYNC_WRITE_FAILED');
        const latestFailure = await readManifest();
        assert.equal(latestFailure?.lastAttempt?.status, 'failed');
        assert.equal(latestFailure?.lastAttempt?.publicationBatchId, undefined);
        assert.equal((await readIndexMeta(`${config.indexAlias}-${published.batchId}`)).published, true);
        for (let read = 0; read < 2; read += 1) {
          const status = await getIndexStatus();
          assert.equal(status.state, 'ready');
          assert.equal(status.batchId, published.batchId);
          assert.equal(status.total, 17);
          assert.deepEqual(status.lastAttempt, latestFailure?.lastAttempt);
        }
        assertRecords(await query('屏气'), [...BREATHING_RECORDS, 'O6']);
      });
    });
  });

  it('rebuilds unchanged baseline data with a new batch and identical record sets', async () => {
    await withBaseline(async (previous) => {
      const first = await query('000123');
      const rebuilt = await syncRecords();
      assert.notEqual(rebuilt.batchId, previous.batchId);
      assert.equal(rebuilt.total, 16);
      const second = await query('000123');
      assertRecords(second, P1_RECORDS);
      assert.deepEqual(second.hits.map((hit) => hit.id), first.hits.map((hit) => hit.id));
    });
  });

  it('keeps stable 20/5 pagination on the original batch, refreshes to 26 and rejects an expired batch', async () => {
    await withBaseline(async () => {
      const expanded = baseline();
      expanded.documents.push(...paginationDocuments(25));
      await seed({ reset: true, snapshot: expanded });
      await syncRecords();
      const first = await query('分页唯一词');
      const second = await query('分页唯一词', { page: 2, batchId: first.batchId });
      assert.equal(first.total, 25);
      assert.equal(first.pageSize, 20);
      assert.equal(first.hits.length, 20);
      assert.equal(second.hits.length, 5);
      assert.equal(second.batchId, first.batchId);
      const allIds = [...first.hits, ...second.hits].map((hit) => hit.sourceId);
      assert.equal(new Set(allIds).size, 25);
      assert.deepEqual(allIds.slice().sort(), Array.from({ length: 25 }, (_, i) => idFor(`O${101 + i}`)).sort());
      const repeated = await query('分页唯一词', { batchId: first.batchId });
      assert.deepEqual(repeated.hits.map((hit) => hit.sourceId), first.hits.map((hit) => hit.sourceId));

      await insertDocument('O126', '分页唯一词', '分页样例026');
      const published = await syncRecords();
      assert.notEqual(published.batchId, first.batchId);
      const oldSecond = await query('分页唯一词', { page: 2, batchId: first.batchId });
      assert.equal(oldSecond.total, 25);
      assert.deepEqual(oldSecond.hits.map((hit) => hit.sourceId), second.hits.map((hit) => hit.sourceId));
      const refreshed = await query('分页唯一词');
      assert.equal(refreshed.total, 26);
      assert.equal(refreshed.page, 1);
      assert.equal(refreshed.hits.length, 20);
      const newSecond = await query('分页唯一词', { page: 2, batchId: refreshed.batchId });
      assert.equal(newSecond.hits.length, 6);

      // Delete only this test's now-inactive concrete index, never an alias or wildcard.
      const oldIndex = `${config.indexAlias}-${first.batchId}`;
      assert.match(oldIndex, /^ois-records-[a-zA-Z0-9_-]+$/);
      assert.notEqual(first.batchId, (await getIndexStatus()).batchId);
      const removed = await fetch(`${config.opensearchUrl.replace(/\/$/, '')}/${encodeURIComponent(oldIndex)}`, { method: 'DELETE', signal: AbortSignal.timeout(30_000) });
      assert.equal(removed.status, 200, await removed.text());
      await expectAppError(query('分页唯一词', { page: 2, batchId: first.batchId }), 'BATCH_UNAVAILABLE');
      assert.equal((await query('分页唯一词')).total, 26);
    });
  });
});
