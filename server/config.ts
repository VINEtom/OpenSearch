import 'dotenv/config';
import path from 'node:path';

const sourceMode: 'demo' | 'real' = process.env.SOURCE_MODE === 'real' ? 'real' : 'demo';
const jump = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key.startsWith('JUMP_') && value));

export const config = {
  port: Number(process.env.API_PORT || 4107),
  pgHost: process.env.PGHOST || '127.0.0.1',
  pgPort: Number(process.env.PGPORT || 54329),
  pgUser: process.env.PGUSER || 'ois_demo',
  pgPassword: process.env.PGPASSWORD || 'ois_demo_local',
  databases: { pms: 'pms_demo', emr: 'emr_demo', rvs: 'rvs_demo' },
  sourceMode,
  real: {
    host: process.env.REAL_PGHOST || '',
    port: Number(process.env.REAL_PGPORT || 5432),
    user: process.env.REAL_PGUSER || '',
    password: process.env.REAL_PGPASSWORD || '',
    databases: {
      pms: process.env.REAL_PMS_DATABASE || 'RTCloudPmsDB',
      emr: process.env.REAL_EMR_DATABASE || 'RTCloudEmrDBVNext',
    },
  },
  jump,
  opensearchUrl: process.env.OPENSEARCH_URL || 'http://127.0.0.1:9207',
  indexAlias: 'ois-records',
  runtimeDir: path.resolve(process.env.RUNTIME_DIR || '.runtime'),
};
