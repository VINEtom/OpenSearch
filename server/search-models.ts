import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { SearchHit, SimulationSearchFilters } from '../shared/types.js';
import { normalizeLocalizationSite } from '../shared/simulation-fields.js';
import { config } from './config.js';

const workerScript = fileURLToPath(new URL('../scripts/search-model.py', import.meta.url));

class ModelWorker {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: (value: unknown) => void;
  private retryAfter = 0;

  constructor(private mode: 'bert' | 'reranker', private python: string, private modelDir: string) {}

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

const bert = new ModelWorker('bert',
  process.env.SEARCH_BERT_PYTHON || path.join(config.runtimeDir, 'bert-pilot/venv/bin/python'),
  process.env.SEARCH_BERT_MODEL_DIR || path.join(config.runtimeDir, 'bert-pilot/checkpoint'));
const reranker = new ModelWorker('reranker',
  process.env.SEARCH_BGE_PYTHON || path.join(config.runtimeDir, 'hybrid-pilot/venv/bin/python'),
  process.env.SEARCH_BGE_MODEL_DIR || path.join(config.runtimeDir, 'combined-pilot/reranker'));

export async function confirmWithBert(query: string, filters: SimulationSearchFilters): Promise<boolean> {
  const result = await bert.predict({ query });
  if (!Array.isArray(result)) return false;
  const values = (field: string) => result.filter(item => item?.field === field && typeof item.text === 'string').map(item => item.text as string);
  const modalities = values('MOD');
  const sites = values('SITE');
  return (!filters.imagingModality || (modalities.length === 1 && modalities[0].toUpperCase() === filters.imagingModality))
    && (!filters.localizationSite || (sites.length === 1 && normalizeLocalizationSite(sites[0]) === filters.localizationSite));
}

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
