const han = { type: 'text', analyzer: 'standard' };

export const recordProperties = {
  id: { type: 'keyword' }, batchId: { type: 'keyword' }, source: { type: 'keyword' }, recordType: { type: 'keyword' },
  sourceDatabase: { type: 'keyword' }, sourceTable: { type: 'keyword' }, sourceId: { type: 'keyword' },
  sourceRevision: { type: 'long' }, patientId: { type: 'keyword' }, patientRevision: { type: 'long' },
  radiotherapyNo: { type: 'keyword' }, patientName: { type: 'text', analyzer: 'cjk', fields: { keyword: { type: 'keyword' }, han } },
  sex: { type: 'keyword' }, birthDate: { type: 'date', format: 'strict_date' }, recordNo: { type: 'keyword' },
  title: { type: 'text', analyzer: 'cjk', fields: { keyword: { type: 'keyword' }, han } },
  bodyText: { type: 'text', analyzer: 'cjk', fields: { han } }, businessDate: { type: 'date', format: 'strict_date' }, updatedAt: { type: 'date' },
  prescribedFractions: { type: 'integer' },
  imagingModality: { type: 'keyword' }, localizationSites: { type: 'keyword' },
  diagnosisFilters: { type: 'nested', properties: {
    name: { type: 'keyword' }, diagnosedOn: { type: 'date', format: 'strict_date' },
    codingSystem: { type: 'keyword' }, code: { type: 'keyword' },
    maxPrescribedFractions: { type: 'integer' },
  } },
  diagnosisIds: { type: 'keyword' }, planRequestId: { type: 'keyword' }, sourceDocumentId: { type: 'keyword' },
  confirmationStatus: { type: 'keyword' }, planStatus: { type: 'keyword' },
  documentType: { type: 'text', analyzer: 'cjk', fields: { keyword: { type: 'keyword' }, han } },
  codeSystem: { type: 'keyword' }, codeVersion: { type: 'keyword' }, code: { type: 'keyword' }, missingFields: { type: 'keyword' },
};
