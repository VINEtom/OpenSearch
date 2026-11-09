import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../server/config.js';
import { assertPrototypeDatabases, closePools, getPool } from '../server/data.js';
import { SOURCES } from '../shared/types.js';

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
