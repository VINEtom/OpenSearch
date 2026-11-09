import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { assertPrototypeDatabases, closePools, getPool } from '../server/data.js';
import { SOURCES } from '../shared/types.js';

const planRequestDiagnosisMigration = `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'plan_requests'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) = 'UNIQUE (id, patient_id)'
  ) THEN
    ALTER TABLE plan_requests ADD CONSTRAINT plan_requests_id_patient_key UNIQUE (id, patient_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS plan_request_diagnoses (
  id uuid PRIMARY KEY,
  plan_request_id uuid NOT NULL,
  diagnosis_id uuid NOT NULL,
  patient_id uuid NOT NULL,
  UNIQUE (plan_request_id, diagnosis_id),
  FOREIGN KEY (plan_request_id, patient_id) REFERENCES plan_requests(id, patient_id) ON DELETE RESTRICT,
  FOREIGN KEY (diagnosis_id, patient_id) REFERENCES diagnoses(id, patient_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS plan_request_diagnoses_diagnosis_idx ON plan_request_diagnoses(diagnosis_id, patient_id);
CREATE INDEX IF NOT EXISTS plan_request_diagnoses_request_idx ON plan_request_diagnoses(plan_request_id, patient_id);

DO $$
DECLARE link_constraint name;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plan_requests' AND column_name = 'diagnosis_id'
  ) THEN
    INSERT INTO plan_request_diagnoses (id, plan_request_id, diagnosis_id, patient_id)
    SELECT gen_random_uuid(), id, diagnosis_id, patient_id FROM plan_requests AS request
    WHERE NOT EXISTS (
      SELECT 1 FROM plan_request_diagnoses AS link
      WHERE link.plan_request_id = request.id AND link.diagnosis_id = request.diagnosis_id
    );
    FOR link_constraint IN
      SELECT constraint_row.conname FROM pg_constraint AS constraint_row
      JOIN pg_attribute AS attribute ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = ANY (constraint_row.conkey)
      WHERE constraint_row.conrelid = 'plan_requests'::regclass AND constraint_row.contype = 'f' AND attribute.attname = 'diagnosis_id'
    LOOP
      EXECUTE format('ALTER TABLE plan_requests DROP CONSTRAINT %I', link_constraint);
    END LOOP;
    DROP INDEX IF EXISTS plan_requests_diagnosis_idx;
    ALTER TABLE plan_requests DROP COLUMN diagnosis_id;
  END IF;
END $$;
`;

export async function initializeDatabases(): Promise<void> {
  assertPrototypeDatabases();
  // postgres is used only as the maintenance database for CREATE DATABASE.
  const admin = new pg.Client({ host: config.pgHost, port: config.pgPort, user: config.pgUser,
    password: config.pgPassword, database: 'postgres', connectionTimeoutMillis: 5000,
    application_name: 'ois-search-prototype-init' });
  try {
    await admin.connect();
    for (const source of SOURCES) {
      const name = config.databases[source];
      const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      if (existing.rowCount === 0) {
        try { await admin.query(`CREATE DATABASE "${name}"`); }
        catch (error) { if ((error as { code?: string }).code !== '42P04') throw error; }
      }
    }
  } finally { await admin.end(); }
  const common = await readFile(new URL('./schema/common.sql', import.meta.url), 'utf8');
  for (const source of SOURCES) {
    const schema = await readFile(new URL(`./schema/${source}.sql`, import.meta.url), 'utf8');
    const client = await getPool(source).connect();
    try {
      await client.query('BEGIN');
      await client.query(common);
      await client.query(schema);
      if (source === 'emr') await client.query(planRequestDiagnosisMigration);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initializeDatabases().then(() => console.log('已初始化 pms_demo、emr_demo、rvs_demo；已有记录保持不变。'))
    .catch(error => { console.error(`初始化失败：${error instanceof Error ? error.message : '未知错误'}`); process.exitCode = 1; })
    .finally(closePools);
}
