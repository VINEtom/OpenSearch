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

type VerifyDocumentValue = (type: string, label: string, value: string, contains: boolean) => Promise<string | undefined>;

export async function predictDocumentCondition(query: string, verifySplit?: VerifyDocumentSplit, verifyValue?: VerifyDocumentValue) {
  const scoped = await predictDocumentCandidate(query, verifySplit, verifyValue);
  if (scoped === 'unavailable' || (scoped && typeof scoped === 'object' && 'types' in scoped)) return scoped;

  const original = scoped && typeof scoped === 'object' ? scoped.conditions[0] : undefined;
  if (original && scoped && typeof scoped === 'object') {
    const spec = catalogs[scoped.type].find(field => field.label === original.label);
    if ((fieldOwners.get(original.label)?.length ?? 0) < 2 ||
      (original.operator !== 'contains' && (original.operator !== 'eq' || spec?.number || spec?.enum || spec?.boolean))) return scoped;
  }

  // Retry the model with the scope mention masked. The original scope still controls retrieval.
  const text = normalize(query);
  const types = Object.keys(catalogs).filter(type => text.includes(type))
    .sort((a, b) => text.lastIndexOf(b) - text.lastIndexOf(a));
  for (const type of types) {
    const at = scoped && typeof scoped === 'object' && scoped.type !== type ? -1 : text.lastIndexOf(type);
    if (at < 0) continue;
    const remainder = (text.slice(0, at) + ' ' + text.slice(at + type.length)).trim();
    const candidate = await predictDocumentCandidate(remainder, verifySplit, verifyValue);
    if (!candidate || typeof candidate !== 'object') continue;
    const [condition] = candidate.conditions;
    if (!('types' in candidate) && verifyValue) {
      for (const owner of fieldOwners.get(condition.label) ?? []) {
        const value = await verifyValue(owner, condition.label, condition.value, condition.operator === 'contains');
        if (value && value.length > condition.value.length && remainder.includes(normalize(value))) condition.value = value;
      }
    }
    const spec = catalogs[type].find(field => field.label === condition.label);
    if (!spec || !supportsOperator(spec, condition.operator)
      || (spec.enum && !Object.values(spec.enum).includes(condition.value))
      || (spec.boolean && !['是', '否', '1', '0'].includes(condition.value))) continue;
    // Other type mentions must belong to the verified value for scope to be unambiguous.
    const withoutValue = remainder.replace(normalize(condition.value), ' ');
    if (withoutValue === remainder || Object.keys(catalogs).some(name => withoutValue.includes(name))) continue;
    if (original && (original.label !== condition.label || original.operator !== condition.operator
        || !condition.value.includes(original.value) || condition.value === original.value)) continue;
    if (original) {
      const owners = fieldOwners.get(condition.label) ?? [];
      const verified = await Promise.all(owners.map(owner =>
        verifyValue?.(owner, condition.label, condition.value, condition.operator === 'contains')));
      if (!verified.includes(condition.value)) continue;
    }
    return { type, conditions: [condition] };
  }
  return scoped;
}

async function predictDocumentCandidate(query: string, verifySplit?: VerifyDocumentSplit, verifyValue?: VerifyDocumentValue) {
  const text = normalize(query);
  const explicitType = Object.keys(catalogs).some(type => text.includes(type));
  const scoped = explicitType ? await predictScopedCondition(query, verifySplit) : undefined;
  if (scoped === 'unavailable' || (scoped && typeof scoped === 'object')) return scoped;

  const names = [...fieldOwners.keys()].filter(label => text.includes(label));
  const fields = names.filter(label => !names.some(other => other !== label && other.includes(label)));
  if (fields.length !== 1) return scoped;
  const [label] = fields;
  if (text === label) return undefined;
  if (patientSearchCatalog.some(field => field.label !== label && field.label.includes(label) && text.includes(field.label))) {
    return undefined;
  }
  const owners = fieldOwners.get(label) ?? [];
  let condition: Filter['conditions'][number] | undefined;
  for (const type of owners) {
    // Supply the catalogue type as model context, preserving the user's query text.
    let prediction = await predictScopedCondition(`${type} ${query}`, verifySplit);
    if (!prediction || prediction === 'review') prediction = await predictScopedCondition(`${query}的${type}`, verifySplit);
    if (prediction === 'unavailable') return prediction;
    if (!prediction || prediction === 'review') continue;
    const [parsed] = prediction.conditions;
    if (parsed.label !== label || !text.includes(normalize(parsed.value))) continue;
    if (parsed.operator === 'eq' || parsed.operator === 'contains') {
      parsed.value = await verifyValue?.(type, label, parsed.value, parsed.operator === 'contains') ?? parsed.value;
    }
    if (explicitType) {
      const outside = text.replace(normalize(parsed.value), ' ');
      if (Object.keys(catalogs).some(name => outside.includes(name))) continue;
    }
    if (condition && condition.operator !== parsed.operator) return 'review';
    if (condition && condition.value.includes(parsed.value)) continue;
    if (condition && !parsed.value.includes(condition.value)) return 'review';
    condition = parsed;
  }
  if (!condition) return scoped;
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
