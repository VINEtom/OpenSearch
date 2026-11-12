import type { SimulationFieldCondition } from '../shared/types.js';
import { documentFieldSpecs, requestFieldSpecs, type FieldSpec } from './sources/record-fields.js';

type Condition = Omit<SimulationFieldCondition, 'numeric'>;
export type Filter = { type: string; conditions: Condition[] };

export const catalogs: Record<string, FieldSpec[]> = {
  ...documentFieldSpecs,
  计划申请单: requestFieldSpecs([]),
  后装申请单: requestFieldSpecs([]),
  全身放疗申请单: requestFieldSpecs([]),
};


export const fieldOwners = new Map<string, string[]>();
for (const [type, fields] of Object.entries(catalogs)) {
  for (const field of fields) fieldOwners.set(field.label, [...fieldOwners.get(field.label) ?? [], type]);
}

export const documentNumericLabels = new Map(Object.entries(catalogs).map(([type, fields]) => [
  type, new Set(fields.filter(field => field.number).map(field => field.label)),
]));
