import { patientSearchEnumValues } from '../shared/patient-search-enums.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { PatientCatalogCondition, PatientSearchFilters, SearchHit } from '../shared/types.js';
import { patientSearchFieldById } from '../shared/patient-search-catalog.js';
import { config } from './config.js';
import { diagnosisAliases, diagnosisName, diagnosisValueSet, indexedDiagnosisTerms } from './diagnosis-terminology.js';
import { diagnosisDateRange } from './patient-query.js';

const workerScript = fileURLToPath(new URL('../scripts/search-model.py', import.meta.url));

export class ModelWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: (value: unknown) => void;
  private retryAfter = 0;

  constructor(private mode: 'bert' | 'patient-bert' | 'reranker', private python: string, private modelDir: string) {}

  async predict(payload: object): Promise<unknown> {
    if (process.env.SEARCH_MODELS === 'off' || this.pending || Date.now() < this.retryAfter) return undefined;
    const cold = !this.child;
    if (!this.child) {
      if ((path.isAbsolute(this.python) && !existsSync(this.python)) || !existsSync(this.modelDir)) return undefined;
      const child = spawn(this.python, [workerScript, this.mode, this.modelDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
      });
      this.child = child;
      child.stderr.resume();
      child.once('error', () => this.reset(child));
      child.once('exit', () => this.reset(child));
      child.stdin.on('error', () => this.reset(child));
      createInterface({ input: child.stdout }).on('line', line => {
        if (this.child !== child) return;
        try { this.pending?.(JSON.parse(line)); }
        catch { this.reset(child); }
      });
    }
    const child = this.child;
    return new Promise(resolve => {
      const timeout = setTimeout(() => this.reset(child), cold ? 30000 : 2500);
      this.pending = value => {
        clearTimeout(timeout);
        this.pending = undefined;
        resolve(value);
      };
      child.stdin.write(JSON.stringify(payload) + '\n');
    });
  }

  private reset(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = undefined;
    this.retryAfter = Date.now() + 30000;
    this.pending?.(undefined);
    child.kill();
  }
}

const reranker = new ModelWorker('reranker',
  process.env.SEARCH_BGE_PYTHON || path.join(config.runtimeDir, 'hybrid-pilot/venv/bin/python'),
  process.env.SEARCH_BGE_MODEL_DIR || path.join(config.runtimeDir, 'combined-pilot/reranker'));

function passages(body: string): string[] {
  const chunks = [];
  for (const line of body.split(/\r?\n/u)) {
    const text = line.trim();
    for (let start = 0; start < text.length; start += 144) {
      chunks.push(text.slice(start, start + 180));
      if (start + 180 >= text.length) break;
    }
  }
  return chunks.length <= 4 ? chunks : [...chunks.slice(0, 2), ...chunks.slice(-2)];
}

export async function rerankHits(query: string, hits: SearchHit[]): Promise<SearchHit[]> {
  const candidates = hits.flatMap((hit, index) => passages(hit.bodyText ?? '').map(text => ({ index, text })));
  if (!candidates.length) return hits;
  const scores = await reranker.predict({ query, passages: candidates.map(item => item.text) });
  if (!Array.isArray(scores) || scores.length !== candidates.length || !scores.every(Number.isFinite)) return hits;
  const best = new Map<number, { score: number; text: string }>();
  candidates.forEach(({ index, text }, i) => {
    const score = scores[i] as number;
    if (score > (best.get(index)?.score ?? -Infinity)) best.set(index, { score, text });
  });
  return hits.map((hit, index) => ({ hit, match: best.get(index) }))
    .sort((a, b) => (b.match?.score ?? -Infinity) - (a.match?.score ?? -Infinity))
    .map(({ hit, match }) => match ? { ...hit, semanticPassage: match.text } : hit);
}

const patientBert = new ModelWorker('patient-bert',
  process.env.SEARCH_BERT_PYTHON || path.join(config.runtimeDir, 'bert-pilot/venv/bin/python'),
  process.env.SEARCH_PATIENT_BERT_MODEL_DIR || path.join(config.runtimeDir, 'patient-bert-pilot/catalog-checkpoint'));

export async function predictPatientConditions(query: string): Promise<PatientCatalogCondition[] | 'review' | undefined> {
  if (!process.env.SEARCH_PATIENT_BERT_MODEL_DIR) return undefined;
  const prediction = await patientBert.predict({ query }) as {
    intent?: string; confidence?: number; fields?: { field: string; text: string }[];
  } | undefined;
  if (!prediction?.intent || prediction.intent === 'KEYWORD') return undefined;
  if (prediction.intent === 'REVIEW') return 'review';
  const expected = { FILTER1: 1, FILTER2: 2, FILTER3: 3 }[prediction.intent];
  if (!expected || !Number.isFinite(prediction.confidence) || prediction.confidence! < 0.75
    || !Array.isArray(prediction.fields) || prediction.fields.length !== expected) return 'review';

  const fields: PatientCatalogCondition[] = [];
  const sex: Record<string, string> = { 男: 'male', 男性: 'male', 女: 'female', 女性: 'female', 其他: 'other', 未知: 'unknown' };
  for (const item of prediction.fields) {
    const field = patientSearchFieldById.get(item.field);
    const raw = item.text.trim();
    if (!field || !raw || fields.some(entry => entry.id === field.id)) return 'review';
    const allowedValues = patientSearchEnumValues.get(field.label);
    if (allowedValues && !allowedValues.has(raw)) return 'review';
    if (field.indexField === 'birthDate') {
      const timestamp = Date.parse(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw) || !Number.isFinite(timestamp)
        || new Date(timestamp).toISOString().slice(0, 10) !== raw) return 'review';
    }
    const value = field.indexField === 'sex' ? sex[raw] : raw;
    if (!value) return 'review';
    fields.push({ id: field.id, value });
  }
  return fields;
}


const diagnosisModelDir = process.env.SEARCH_DIAGNOSIS_BERT_MODEL_DIR;
const diagnosisBert = diagnosisModelDir && new ModelWorker('patient-bert',
  process.env.SEARCH_BERT_PYTHON || path.join(config.runtimeDir, 'bert-pilot/venv/bin/python'),
  diagnosisModelDir);
let diagnosisPending: Promise<unknown> = Promise.resolve();

export async function predictDiagnosisFilters(query: string, index: string): Promise<PatientSearchFilters | 'review' | undefined> {
  const normalizedQuery = query.normalize('NFKC');
  if (!diagnosisBert || !normalizedQuery.includes('月') || !/\d/u.test(normalizedQuery)) return undefined;
  const pending = diagnosisPending.then(() => diagnosisBert.predict({ query }));
  diagnosisPending = pending.catch(() => undefined);
  const prediction = await pending as {
    intent?: string; confidence?: number; fields?: { field: string; text: string }[];
  } | undefined;
  if (!prediction?.intent || prediction.intent === 'KEYWORD') return undefined;
  if (!Number.isFinite(prediction.confidence) || prediction.confidence! < 0.75) return 'review';
  if (prediction.intent !== 'FILTER3' || !prediction.fields) return 'review';

  const monthFields = prediction.fields.filter(item => item.field === 'MONTHS_value');
  const statusFields = prediction.fields.filter(item => item.field === 'STATUS_value');
  const diseaseParts = prediction.fields.filter(item => item.field === 'DIAGNOSIS_value')
    .map(item => item.text.normalize('NFKC'));
  const monthText = monthFields[0]?.text;
  const months = Number(monthText);
  if (monthFields.length !== 1 || statusFields.length !== 1 || statusFields[0].text !== '确诊'
    || !diseaseParts.length || !Number.isInteger(months) || months < 1 || months > 99) return 'review';

  const terms = await indexedDiagnosisTerms(index);
  const names = new Set([...diagnosisAliases, ...terms.map(diagnosisName)]);
  const candidates = [...names].filter(name => name && normalizedQuery.includes(name));
  const fullNames = candidates.filter(name => !candidates.some(other => other !== name && other.includes(name)));
  const [diagnosis] = fullNames;
  if (fullNames.length !== 1 || !diseaseParts.every(part => part && diagnosis.includes(part))) return 'review';
  const numbers = normalizedQuery.replace(diagnosis, '').match(/\d+/gu);
  if (numbers?.length !== 1 || numbers[0] !== monthText) return 'review';

  const dates = diagnosisDateRange(months);
  if (diagnosisValueSet(diagnosis)) return { diagnosis, ...dates, codingSystems: ['ICD-10', 'ICD-11'] };
  const indexedDiagnosisTitles = [...new Set(terms.filter(term => diagnosisName(term) === diagnosis).map(term => term.title))];
  return { diagnosis, ...dates, indexedDiagnosisTitles };
}
