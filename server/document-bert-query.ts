import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { catalogs, type Filter } from './document-field-query.js';
import { ModelWorker } from './search-models.js';

type Labels = Record<string, { kind: string; label: string; operators: string[] }>;
type Prediction = { intent?: string; confidence?: number; fields?: { field: string; text: string }[] };
type Model = { labels: Labels; predict(query: string): Promise<unknown> };

let model: Model | undefined;
let pending: Promise<unknown> = Promise.resolve();

function loadModel(): Model | undefined {
  if (model) return model;
  const directory = config.documentBertDir;
  if (!directory) return undefined;
  try {
    const labels = JSON.parse(readFileSync(join(directory, 'labels.json'), 'utf8')) as Labels;
    if (!labels || !Object.keys(labels).length) return undefined;
    const worker = new ModelWorker('patient-bert',
      process.env.SEARCH_BERT_PYTHON || join(config.runtimeDir, 'bert-pilot/venv/bin/python'), directory);
    model = { labels, predict(query) {
      const result = pending.then(() => worker.predict({ query }));
      pending = result.catch(() => undefined);
      return result;
    } };
    return model;
  } catch {
    return undefined;
  }
}

const normalize = (value: string) => value.normalize('NFKC').trim();

export async function parseDocumentBertCondition(query: string, getModel = loadModel):
Promise<Filter | 'review' | 'unavailable' | undefined> {
  const text = normalize(query);
  const types = Object.keys(catalogs).filter(type => text.includes(type));
  const [type] = types;
  if (!type) return undefined;
  if (types.length > 1) return 'review';

  const explicitFields = catalogs[type].filter(field => text.includes(field.label));
  // A label embedded in a longer catalog label names the longer field.
  const fields = explicitFields.filter(field => !explicitFields.some(other =>
    other.label !== field.label && other.label.includes(field.label)));
  if (!fields.length) return undefined;
  if (fields.length !== 1 || text.split(fields[0].label).length !== 2) return 'review';
  const [spec] = fields;
  const candidate = getModel();
  if (!candidate) return 'unavailable';

  let prediction: Prediction | undefined;
  try {
    prediction = await candidate.predict(query) as Prediction | undefined;
  } catch {
    return 'unavailable';
  }
  if (!prediction) return 'unavailable';
  if (prediction.intent !== 'FILTER1' || !Number.isFinite(prediction.confidence)
      || prediction.confidence! < .75 || !Array.isArray(prediction.fields) || prediction.fields.length !== 1) return 'review';

  const [field] = prediction.fields;
  if (typeof field?.field !== 'string' || typeof field.text !== 'string') return 'review';
  const [id, operator, extra] = field.field.split('_');
  const definition = candidate.labels[id];
  const value = normalize(field.text);
  const completeNumber = !spec.number || (Number.isFinite(Number(value)) &&
    (text.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []).some(number => number === value));
  const operatorAllowed = operator === 'eq' || (operator === 'contains' && spec.text)
    || (spec.number && ['lt', 'lte', 'gt', 'gte'].includes(operator));
  if (extra !== undefined || definition?.kind !== type || definition.label !== spec.label
      || !Array.isArray(definition.operators) || !definition.operators.includes(operator)
      || !operatorAllowed || !value || !text.includes(value)
      || !completeNumber
      || (spec.boolean && value !== '是' && value !== '否')) return 'review';
  const enumValue = spec.enum && Object.values(spec.enum).find(original => normalize(original) === value);
  if (spec.enum && enumValue === undefined) return 'review';

  return { type, conditions: [{ label: spec.label, operator, value: enumValue ?? value }] } as Filter;
}
