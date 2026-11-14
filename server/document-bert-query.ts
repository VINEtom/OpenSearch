import { patientSearchCatalog } from '../shared/patient-search-catalog.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { catalogs, fieldOwners, type Filter } from './document-field-query.js';
import { joinSingleValueFragments, ModelWorker } from './search-models.js';

type Labels = Record<string, { kind: string; label: string; operators: string[] }>;
type Prediction = { intent?: string; confidence?: number; fields?: { field: string; text: string }[] };
type Model = { labels: Labels; predict(query: string): Promise<unknown> };

const models = new Map<string, Model>();

function loadModel(directory = config.documentBertDir): Model | undefined {
  if (!directory) return undefined;
  const existing = models.get(directory);
  if (existing) return existing;
  try {
    const labels = JSON.parse(readFileSync(join(directory, 'labels.json'), 'utf8')) as Labels;
    if (!labels || !Object.keys(labels).length) return undefined;
    const worker = new ModelWorker('patient-bert',
      process.env.SEARCH_BERT_PYTHON || join(config.runtimeDir, 'bert-pilot/venv/bin/python'), directory);
    let pending: Promise<unknown> = Promise.resolve();
    const model: Model = { labels, predict(query) {
      const result = pending.then(() => worker.predict({ query }));
      pending = result.catch(() => undefined);
      return result;
    } };
    models.set(directory, model);
    return model;
  } catch {
    return undefined;
  }
}

const normalize = (value: string) => value.normalize('NFKC').trim();

type VerifyDocumentSplit = (type: string, label: string, value: string) => Promise<string | undefined>;

export async function predictDocumentCondition(query: string, verifySplit?: VerifyDocumentSplit) {
  const text = normalize(query);
  const explicitType = Object.keys(catalogs).some(type => text.includes(type));
  if (explicitType) return predictScopedCondition(query, verifySplit);

  const names = [...fieldOwners.keys()].filter(label => text.includes(label));
  const fields = names.filter(label => !names.some(other => other !== label && other.includes(label)));
  if (fields.length !== 1) return undefined;
  const [label] = fields;
  if (patientSearchCatalog.some(field => field.label !== label && field.label.includes(label) && text.includes(field.label))) {
    return undefined;
  }
  const owners = fieldOwners.get(label) ?? [];
  let condition: Filter['conditions'][number] | undefined;
  for (const type of owners) {
    // Supply the catalogue type as model context, preserving the user's query text.
    const prediction = await predictScopedCondition(`${type} ${query}`, verifySplit);
    if (prediction === 'unavailable') return prediction;
    if (!prediction || prediction === 'review') continue;
    const [parsed] = prediction.conditions;
    if (parsed.label !== label || !text.includes(normalize(parsed.value))) continue;
    if (condition && (condition.operator !== parsed.operator || condition.value !== parsed.value)) return 'review';
    condition = parsed;
  }
  if (!condition) return undefined;
  const { operator, value } = condition;
  const types = owners.filter(type => {
    const spec = catalogs[type].find(field => field.label === label)!;
    return supportsOperator(spec, operator) && (!spec.enum || Object.values(spec.enum).includes(value))
      && (!spec.boolean || ['是', '否', '1', '0'].includes(value));
  });
  return types.length ? { types, conditions: [condition] } : 'review';
}

function supportsOperator(spec: { text?: boolean; number?: boolean }, operator: string) {
  return operator === 'eq' || (operator === 'contains' && spec.text)
    || (spec.number && ['lt', 'lte', 'gt', 'gte'].includes(operator));
}

async function predictScopedCondition(query: string, verifySplit?: VerifyDocumentSplit) {
  const primary = await parseDocumentBertCondition(query, loadModel, verifySplit);
  const fallback = process.env.SEARCH_DOCUMENT_BERT_FALLBACK_MODEL_DIR;
  if (primary !== 'review' || !fallback || fallback === config.documentBertDir) return primary;
  const previous = await parseDocumentBertCondition(query, () => loadModel(fallback), verifySplit);
  return previous && typeof previous === 'object' ? previous : primary;
}

export async function parseDocumentBertCondition(query: string, getModel = loadModel, verifySplit?: VerifyDocumentSplit):
Promise<Filter | 'review' | 'unavailable' | undefined> {
  const text = normalize(query);
  const types = Object.keys(catalogs).filter(type => text.includes(type));
  if (!types.length) return undefined;
  if (!types.some(type => catalogs[type].some(field => text.includes(field.label)))) return undefined;
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
      || prediction.confidence! < .75 || !Array.isArray(prediction.fields) || !prediction.fields.length) return 'review';

  const [field] = prediction.fields;
  if (typeof field?.field !== 'string' || typeof field.text !== 'string') return 'review';
  const [id, operator, extra] = field.field.split('_');
  const definition = candidate.labels[id];
  let value = normalize(field.text);
  if (prediction.fields.length > 1) {
    const joined = joinSingleValueFragments(query, prediction.fields);
    const verified = joined && definition && operator === 'contains'
      ? await verifySplit?.(definition.kind, definition.label, joined) : undefined;
    if (!verified) return 'review';
    value = verified;
  }
  const type = definition?.kind;
  if (!type || !types.includes(type) || !value) return 'review';
  const spec = catalogs[type].find(field => field.label === definition.label);
  if (!spec) return 'review';

  // Catalogue names inside the model's value do not describe the query scope.
  let validScope = false;
  for (let start = text.indexOf(value); start >= 0; start = text.indexOf(value, start + value.length)) {
    const outside = text.slice(0, start) + ' ' + text.slice(start + value.length);
    if (!outside.includes(type) || types.some(other => other !== type && outside.includes(other))) continue;
    const labels = catalogs[type].filter(field => outside.includes(field.label));
    const named = labels.filter(field => !labels.some(other =>
      other.label !== field.label && other.label.includes(field.label)));
    if (named.length === 1 && named[0].label === spec.label && outside.split(spec.label).length === 2) {
      validScope = true;
      break;
    }
  }
  if (!validScope) return 'review';
  const completeNumber = !spec.number || (operator === 'eq' && !Number.isFinite(Number(value))) || (Number.isFinite(Number(value)) &&
    (text.match(/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/gu) ?? []).some(number => number === value));
  const operatorAllowed = supportsOperator(spec, operator);
  if (extra !== undefined || definition?.kind !== type || definition.label !== spec.label
      || !Array.isArray(definition.operators) || !definition.operators.includes(operator)
      || !operatorAllowed || !value || !text.includes(value)
      || !completeNumber
      || (spec.boolean && !['是', '否', '1', '0'].includes(value))) return 'review';
  const enumValue = spec.enum && Object.values(spec.enum).find(original => normalize(original) === value);
  if (spec.enum && enumValue === undefined) return 'review';

  return { type, conditions: [{ label: spec.label, operator, value: enumValue ?? value }] } as Filter;
}
