import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.API_PORT || 4107),
  pgHost: process.env.PGHOST || '127.0.0.1',
  pgPort: Number(process.env.PGPORT || 54329),
  pgUser: process.env.PGUSER || 'ois_demo',
  pgPassword: process.env.PGPASSWORD || 'ois_demo_local',
  databases: { pms: 'pms_demo', emr: 'emr_demo', rvs: 'rvs_demo' },
  opensearchUrl: process.env.OPENSEARCH_URL || 'http://127.0.0.1:9207',
  indexAlias: 'ois-records',
  runtimeDir: path.resolve(process.env.RUNTIME_DIR || '.runtime'),
};
