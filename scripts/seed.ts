import { pathToFileURL } from 'node:url';
import type pg from 'pg';
import { baseline, idFor, paginationDocuments } from '../fixtures/samples.js';
import { assertPrototypeDatabases, closePools, getPool, validateSnapshot, type Snapshot } from '../server/data.js';
import { AppError } from '../server/errors.js';
import { SOURCES, type Source } from '../shared/types.js';

export interface SeedOptions { reset?: boolean; snapshot?: Snapshot }

export async function seed({ reset = false, snapshot = baseline() }: SeedOptions = {}): Promise<void> {
  assertPrototypeDatabases();
  validateSnapshot(snapshot);
  const clients = new Map<Source, pg.PoolClient>();
  const tableNames: Record<Source, string[]> = {
    pms: ['patients'], emr: ['plan_request_diagnoses', 'plan_requests', 'diagnoses', 'documents'], rvs: ['treatment_plans'],
  };
  try {
    for (const source of SOURCES) {
      const client = await getPool(source).connect();
      clients.set(source, client);
      await client.query('BEGIN');
      await client.query(`LOCK TABLE ${tableNames[source].join(', ')} IN ACCESS EXCLUSIVE MODE`);
    }
    if (!reset) {
      for (const source of SOURCES) for (const table of tableNames[source]) {
        const existing = await clients.get(source)!.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (existing.rowCount) throw new AppError('SEED_NOT_EMPTY', '原型库已有记录；如需恢复虚构基线，请显式使用 --reset。', 409);
      }
    }
    if (reset) {
      for (const source of ['rvs', 'emr', 'pms'] as const) {
        for (const table of tableNames[source]) await clients.get(source)!.query(`DELETE FROM ${table}`);
      }
    }
    async function insert(source: Source, table: string, rows: object[]): Promise<void> {
      const common = ['id', 'created_at', 'updated_at', 'revision', 'deleted_at'];
      const clinical = [...common, 'patient_id', 'voided_at'];
      const columnsByTable: Record<string, string[]> = {
        patients: [...common, 'radiotherapy_no', 'name', 'sex', 'birth_date'],
        documents: [...clinical, 'document_type', 'title', 'body_text', 'document_on'],
        diagnoses: [...clinical, 'diagnosis_name', 'code_system', 'code_version', 'code', 'confirmation_status', 'diagnosed_on', 'source_document_id', 'summary'],
        plan_requests: [...clinical, 'request_no', 'title', 'body_text', 'requested_on', 'prescribed_fractions', 'document_type'],
        treatment_plans: [...clinical, 'plan_request_id', 'plan_no', 'name', 'status', 'notes', 'planned_on'],
      };
      const columns = columnsByTable[table];
      for (const row of rows) {
        const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
        await clients.get(source)!.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`, columns.map(column => (row as Record<string, unknown>)[column]));
      }
    }
    await insert('pms', 'patients', snapshot.patients);
    await insert('emr', 'documents', snapshot.documents);
    await insert('emr', 'diagnoses', snapshot.diagnoses);
    await insert('emr', 'plan_requests', snapshot.planRequests);
    const emr = clients.get('emr')!;
    for (const request of snapshot.planRequests) {
      for (const diagnosisId of [...request.diagnosis_ids].sort()) {
        await emr.query(
          'INSERT INTO plan_request_diagnoses (id, plan_request_id, diagnosis_id, patient_id) VALUES ($1, $2, $3, $4)',
          [idFor(`link:${request.id}:${diagnosisId}`), request.id, diagnosisId, request.patient_id],
        );
      }
    }
    await insert('rvs', 'treatment_plans', snapshot.treatmentPlans);
    // Separate databases have separate transactions; a connection failure may require a reset/retry.
    for (const source of SOURCES) await clients.get(source)!.query('COMMIT');
  } catch (error) {
    await Promise.all([...clients.values()].map(client => client.query('ROLLBACK').catch(() => undefined)));
    throw error;
  } finally { for (const client of clients.values()) client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some(argument => !['--reset', '--pagination'].includes(argument))) {
    console.error('用法：tsx scripts/seed.ts [--reset] [--pagination]'); process.exitCode = 1;
  } else {
    const snapshot = baseline();
    if (arguments_.includes('--pagination')) snapshot.documents.push(...paginationDocuments());
    seed({ reset: arguments_.includes('--reset'), snapshot })
      .then(() => console.log(`已导入虚构样例：患者 ${snapshot.patients.length}、诊断 ${snapshot.diagnoses.length}、申请单 ${snapshot.planRequests.length}、计划 ${snapshot.treatmentPlans.length}、其他单据 ${snapshot.documents.length}。`))
      .catch(error => { console.error(`样例导入失败：${error instanceof Error ? error.message : '未知错误'}`); process.exitCode = 1; })
      .finally(closePools);
  }
}
