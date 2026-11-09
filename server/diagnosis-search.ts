import { getPool } from './data.js';
import { AppError } from './errors.js';
import { resolveBatch } from './index-state.js';
import { osRequest } from './opensearch.js';
import { assertCompleteResponse, validateSearchParams } from './search.js';
import type { DiagnosisPatientResponse, RecordDocument } from '../shared/types.js';

const demoCodes = new Map([['鼻咽癌', 'DEMO-NPC'], ['肺癌', 'DEMO-LUNG']]);
const PAGE_SIZE = 20;

export async function findPatientsByDiagnosis(input: Record<string, unknown>): Promise<DiagnosisPatientResponse> {
  if (Object.keys(input).some(key => !['q', 'page', 'batchId'].includes(key))) {
    throw new AppError('INVALID_QUERY', '查询包含不支持的参数。');
  }
  const { q, page, batchId } = validateSearchParams(input);
  const code = demoCodes.get(q);
  const exactName = { term: { 'title.keyword': q } };
  const diagnosis = code ? {
    bool: {
      should: [
        { bool: { filter: [{ term: { code } }, { term: { codeSystem: 'DEMO-ONCOLOGY' } }, { term: { codeVersion: '1' } }] } },
        { bool: { filter: [exactName], must_not: [{ exists: { field: 'code' } }] } },
      ],
      minimum_should_match: 1,
    },
  } : exactName;

  try {
    const batch = await resolveBatch(batchId);
    const response = await osRequest<Parameters<typeof assertCompleteResponse>[0]>(
      `/${encodeURIComponent(batch.index)}/_search?allow_partial_search_results=false`, 'POST', {
        from: (page - 1) * PAGE_SIZE, size: page === 500 ? PAGE_SIZE : PAGE_SIZE + 1, track_total_hits: true,
        query: { bool: { filter: [{ term: { recordType: 'diagnosis' } }, { term: { confirmationStatus: 'confirmed' } }, diagnosis] } },
        collapse: { field: 'patientId' },
        sort: [{ businessDate: { order: 'desc', missing: '_last' } }, { id: 'asc' }],
        _source: ['patientId', 'sourceId', 'title', 'businessDate'],
      },
    );
    assertCompleteResponse(response);
    const hits = response.hits.hits.slice(0, PAGE_SIZE).map(hit => hit._source as Pick<RecordDocument, 'patientId' | 'sourceId' | 'title' | 'businessDate'>);
    const patients = hits.length ? (await getPool('pms').query<{ id: string; name: string; radiotherapy_no: string }>(
      'SELECT id, name, radiotherapy_no FROM patients WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL',
      [hits.map(hit => hit.patientId)],
    )).rows : [];
    const byId = new Map(patients.map(patient => [patient.id, patient]));
    return {
      q, page, batchId: batch.meta.batchId, hasNext: page < 500 && response.hits.hits.length > PAGE_SIZE,
      patients: hits.flatMap(hit => {
        const patient = byId.get(hit.patientId);
        return patient ? [{
          patientId: patient.id, patientName: patient.name, radiotherapyNo: patient.radiotherapy_no,
          diagnosisId: hit.sourceId, diagnosisName: hit.title, diagnosedOn: hit.businessDate,
        }] : [];
      }),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('SEARCH_UNAVAILABLE', '暂时无法按诊断查找患者，请重试。', 503);
  }
}
