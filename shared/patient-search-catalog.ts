import catalog from './patient-search-catalog.json';

type CatalogEntry = { id: string; label: string; indexField?: string };
export const patientSearchCatalog: ReadonlyArray<CatalogEntry> = catalog;
export const patientSearchFieldById = new Map(patientSearchCatalog.map(field => [field.id, field]));

export const patientSexLabels: Readonly<Record<string, string>> = { male: '男', female: '女', other: '其他', unknown: '未知' };
