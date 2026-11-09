import React, { useEffect, useRef, useState } from 'react';
import type { DiagnosisPatientResponse } from '../../../shared/types';
import { errorInfo, readApi } from '../lib/api';
import type { DetailTarget } from './DetailView';

export default function DiagnosisPatientSearch({ hidden, onOpen }: { hidden: boolean; onOpen: (target: DetailTarget) => void }) {
  const [q, setQ] = useState('');
  const [result, setResult] = useState<DiagnosisPatientResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  async function search(value: string, page = 1, batchId?: string) {
    const term = value.trim();
    if (!term) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ q: term, page: String(page) });
    if (batchId) params.set('batchId', batchId);
    try {
      const next = await readApi<DiagnosisPatientResponse>(`/diagnosis-patients?${params}`, controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorInfo(reason).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <main className="main-content search-view" id={hidden ? undefined : 'main-content'} hidden={hidden}>
    <div className="page-heading"><div><h1>按诊断找患者</h1><p>输入完整诊断名称，查看匹配患者及其原始诊断。</p></div></div>
    <section className="panel search-panel" aria-label="诊断查询条件">
      <form className="search-form" onSubmit={event => { event.preventDefault(); void search(q); }}>
        <div className="search-input-wrap">
          <label className="sr-only" htmlFor="diagnosis-query">诊断名称</label>
          <input id="diagnosis-query" value={q} onChange={event => setQ(event.target.value)} placeholder="输入诊断名称，例如鼻咽癌" maxLength={200} />
        </div>
        <button className="primary-button search-submit" type="submit" disabled={!q.trim() || loading}>搜索患者</button>
      </form>
    </section>
    <section className="results-section" aria-label="患者结果" aria-busy={loading}>
      {loading && <p role="status">正在查找患者…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <div className="results-summary"><div>“{result.q}” · 第 {result.page} 页 · 本页 {result.patients.length} 位患者</div></div>}
      {result && !result.patients.length && !error && !loading && <p>未找到匹配的患者。</p>}
      {result && result.patients.length > 0 && <div className="panel result-list">
        {result.patients.map(row => <article className="result-card" key={row.patientId}>
          <div className="result-main">
            <strong>{row.patientName}</strong>
            <div className="result-meta"><span>放疗号 {row.radiotherapyNo}</span><span>{row.diagnosisName}</span><span>{row.diagnosedOn ?? '日期未提供'}</span></div>
          </div>
          <button className="result-open" onClick={() => onOpen({
            source: 'emr', recordType: 'diagnosis', sourceId: row.diagnosisId, patientId: row.patientId,
            title: row.diagnosisName, patientName: row.patientName, radiotherapyNo: row.radiotherapyNo,
          })}>查看原始诊断</button>
        </article>)}
      </div>}
      {result && (result.page > 1 || result.hasNext) && <div className="pagination">
        <button className="secondary-button" disabled={loading || result.page === 1} onClick={() => void search(result.q, result.page - 1, result.batchId)}>上一页</button>
        <button className="secondary-button" disabled={loading || !result.hasNext} onClick={() => void search(result.q, result.page + 1, result.batchId)}>下一页</button>
      </div>}
    </section>
  </main>;
}
