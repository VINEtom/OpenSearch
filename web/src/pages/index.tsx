import DiagnosisPatientSearch from '../components/DiagnosisPatientSearch';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IndexStatus, RecordDocument, RecordType, SearchHit, SearchParams, SearchResponse, Source } from '../../../shared/types';
import DetailView, { type DetailFrame, type DetailTarget } from '../components/DetailView';
import { errorInfo, readApi, type ErrorInfo } from '../lib/api';
import { CONFIRM_LABELS, displayTime, Highlight, Icon, SEX_LABELS, TYPES, TYPE_LABELS, TYPE_SOURCE } from '../lib/presentation';

interface PatientContext { id: string; name: string; number: string }
interface SearchForm { q: string; scope: 'all' | 'patient'; source: Source | 'all'; type: RecordType | 'all' }
interface SavedState {
  version: 1;
  form: SearchForm;
  patient: PatientContext | null;
  result: SearchResponse | null;
  receivedAt: string | null;
  duration: number | null;
  searchScroll: number;
  stack: DetailFrame[];
}
const STORAGE_KEY = 'ois-search-prototype-session-v1';
const DEFAULT_FORM: SearchForm = { q: '', scope: 'all', source: 'all', type: 'all' };

function loadSession(): SavedState | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') as SavedState | null;
    return value?.version === 1 && value.form && Array.isArray(value.stack) ? value : null;
  } catch { return null; }
}

function sameConditions(form: SearchForm, result: SearchResponse | null, patient: PatientContext | null) {
  return !!result && form.q.trim() === result.q && form.scope === result.scope && form.source === result.source && form.type === result.type && (form.scope !== 'patient' || patient?.id === result.patientId);
}

function ResultCard({ hit, query, onOpen, onPatient }: { hit: SearchHit; query: string; onOpen: () => void; onPatient: () => void }) {
  const titleMatch = hit.matchedFields.find((field) => field.field === 'title');
  const exact = [hit.radiotherapyNo, hit.recordNo, hit.code].some((value) => value != null && value.toLocaleLowerCase() === query.toLocaleLowerCase());
  return <article className="result-card">
    <div className={`result-icon ${hit.recordType}`}><Icon name={hit.recordType} size={22} /></div>
    <div className="result-main">
      <div className="result-title-row"><button className="result-title" onClick={onOpen}>{titleMatch ? <Highlight text={hit.title} ranges={titleMatch.text === hit.title ? titleMatch.ranges : []} /> : hit.title}</button><span className={`type-badge ${hit.recordType}`}>{TYPE_LABELS[hit.recordType]}</span><span className="source-label">{hit.source.toUpperCase()}</span>{exact && <span className="exact-badge">编号精确匹配</span>}</div>
      <div className="result-meta"><button className="patient-link" onClick={onPatient}><Icon name="patient" size={14} />{hit.patientName}</button><span>放疗号 <b className="mono">{hit.radiotherapyNo}</b></span>{hit.recordType === 'patient' && <><span>{SEX_LABELS[hit.sex] || hit.sex}</span><span>出生日期 {hit.birthDate || '未知'}</span></>}{hit.recordNo && <span>{hit.recordType === 'plan_request' ? '申请单号' : '计划编号'} <b className="mono">{hit.recordNo}</b></span>}{hit.confirmationStatus && <span className={`clinical-status ${hit.confirmationStatus}`}>{CONFIRM_LABELS[hit.confirmationStatus] || hit.confirmationStatus}</span>}{hit.planStatus && <span>计划状态：{hit.planStatus}</span>}{hit.documentType && <span>{hit.documentType}</span>}{hit.recordType !== 'patient' && <span>{hit.businessDate || '业务日期未提供'}</span>}</div>
      {hit.code && <div className="result-extra">诊断编码：{hit.codeSystem} {hit.codeVersion} · <span className="mono">{hit.code}</span></div>}
      {(hit.diagnosisId || hit.planRequestId) && <div className="result-extra">{hit.planRequestId ? '已关联来源申请单' : '已关联具体诊断'}<span> · 可在详情中追溯</span></div>}
      <div className="matched-content">{hit.matchedFields.map((field, index) => <div className="match-line" key={`${field.field}-${index}`}><span className="match-label">命中{field.label}</span><p><Highlight text={field.text} ranges={field.ranges} /></p></div>)}</div>
    </div>
    <button className="result-open" onClick={onOpen} aria-label={`查看${TYPE_LABELS[hit.recordType]}详情：${hit.title}`}><span>查看详情</span><Icon name="arrow" size={16} /></button>
  </article>;
}

function SyncHelp({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.showModal();
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);
  return <dialog className="sync-dialog" ref={dialogRef} aria-labelledby="sync-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-heading"><div className="dialog-icon"><Icon name="database" size={24} /></div><button className="icon-button" ref={closeRef} onClick={onClose} aria-label="关闭同步说明"><Icon name="close" /></button></div>
    <h2 id="sync-title">更新搜索数据</h2><p>搜索使用最近一次完整同步的数据，详情读取来源中的最新记录。</p>
    <ol><li>完成虚构源数据修改后，暂停样例写入。</li><li>在原型项目根目录打开终端，执行：</li></ol><pre><code>npm run sync</code></pre><p>同步完整成功后，页面会提示“数据已更新”。点击“刷新结果”即可查看新数据。</p><div className="dialog-note"><Icon name="info" size={17} /><span>同步失败时保留上一批完整数据。请根据终端中的失败原因处理后重新执行。</span></div><button className="primary-button dialog-close" onClick={onClose}>知道了</button>
  </dialog>;
}

export default function SearchPage() {
  const [mode, setMode] = useState<'global' | 'diagnosis'>('global');
  const [initial] = useState(loadSession);
  const [form, setForm] = useState<SearchForm>(initial?.form || DEFAULT_FORM);
  const [patient, setPatient] = useState<PatientContext | null>(initial?.patient || null);
  const [result, setResult] = useState<SearchResponse | null>(initial?.result || null);
  const [receivedAt, setReceivedAt] = useState<string | null>(initial?.receivedAt || null);
  const [duration, setDuration] = useState<number | null>(initial?.duration || null);
  const [stack, setStack] = useState<DetailFrame[]>(initial?.stack || []);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSyncHelp, setShowSyncHelp] = useState(false);
  const [attempted, setAttempted] = useState<SearchParams | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const searchController = useRef<AbortController>();
  const searchScroll = useRef(initial?.searchScroll || 0);
  const firstRender = useRef(true);
  const stateRef = useRef<SavedState>({ version: 1, form, patient, result, receivedAt, duration, searchScroll: searchScroll.current, stack });
  const frame = stack[stack.length - 1];
  const dirty = !!result && !sameConditions(form, result, patient);
  const newerBatch = !!result && !!status?.batchId && status.batchId !== result.batchId;
  const supportedTypes = TYPES.filter((type) => form.source === 'all' || TYPE_SOURCE[type] === form.source);
  const countConditionsMatch = !!result && form.q.trim() === result.q && form.scope === result.scope && form.source === result.source && (form.scope === 'all' || patient?.id === result.patientId);
  const notSynced = status?.state === 'not_synced' || error?.code === 'NOT_SYNCED';
  const lastSyncedAt = status?.syncedAt || result?.syncedAt;

  stateRef.current = { version: 1, form, patient, result, receivedAt, duration, searchScroll: searchScroll.current, stack };

  useEffect(() => {
    const persist = () => {
      const state = stateRef.current;
      const updated = { ...state, searchScroll: state.stack.length ? searchScroll.current : window.scrollY, stack: state.stack.map((item, index) => index === state.stack.length - 1 ? { ...item, scroll: window.scrollY } : item) };
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch { /* A full or disabled session store does not block searching. */ }
    };
    const onScroll = () => { if (!stateRef.current.stack.length) searchScroll.current = window.scrollY; };
    window.addEventListener('pagehide', persist);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('pagehide', persist); window.removeEventListener('scroll', onScroll); };
  }, []);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stateRef.current)); } catch { /* Keep the working session in memory. */ }
  }, [form, patient, result, stack, receivedAt, duration]);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const value = await readApi<IndexStatus>('/index-status', controller.signal);
        if (active) { setStatus(value); setStatusError(false); }
      } catch (reason) {
        if (active && !(reason instanceof Error && reason.name === 'AbortError')) setStatusError(true);
      }
    };
    void poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); controller?.abort(); };
  }, []);

  const runSearch = useCallback(async (params: SearchParams, moveToResults = false) => {
    clearTimeout(timerRef.current);
    searchController.current?.abort();
    if (!params.q.trim()) { setResult(null); setError(null); setLoading(false); return; }
    const controller = new AbortController();
    searchController.current = controller;
    setAttempted(params);
    setError(null);
    setLoading(true);
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value != null && value !== '') query.set(name, String(value));
    const started = performance.now();
    try {
      const value = await readApi<SearchResponse>(`/search?${query}`, controller.signal);
      if (controller.signal.aborted) return;
      setResult(value);
      setReceivedAt(new Date().toISOString());
      setDuration(Math.round(performance.now() - started));
      if (moveToResults) requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ block: 'start' }));
    } catch (reason) {
      if (!controller.signal.aborted) setError(errorInfo(reason));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const formParams = (): SearchParams => ({ ...form, q: form.q.trim(), patientId: form.scope === 'patient' ? patient?.id : undefined, page: 1 });
  const appliedParams = (): SearchParams => result ? { q: result.q, scope: result.scope, patientId: result.patientId, source: result.source, type: result.type, page: 1 } : formParams();

  useEffect(() => {
    if (stack.length) {
      searchController.current?.abort();
      clearTimeout(timerRef.current);
      setLoading(false);
      return;
    }
    if (firstRender.current) {
      firstRender.current = false;
      if (sameConditions(form, result, patient)) {
        if (!stack.length) requestAnimationFrame(() => window.scrollTo({ top: searchScroll.current }));
        return;
      }
    }
    searchController.current?.abort();
    clearTimeout(timerRef.current);
    setLoading(false);
    setError(null);
    if (!form.q.trim()) { setResult(null); return; }
    if (sameConditions(form, result, patient)) return;
    timerRef.current = setTimeout(() => void runSearch(formParams()), 300);
    return () => clearTimeout(timerRef.current);
  }, [form.q, form.scope, form.source, form.type, patient?.id, runSearch]);

  useEffect(() => () => searchController.current?.abort(), []);

  const changeSource = (source: Source | 'all') => setForm((previous) => ({ ...previous, source, type: previous.type !== 'all' && source !== 'all' && TYPE_SOURCE[previous.type] !== source ? 'all' : previous.type }));
  const openDetail = (target: DetailTarget, hit?: SearchHit) => {
    if (frame && frame.target.source === target.source && frame.target.recordType === target.recordType && frame.target.sourceId === target.sourceId) return;
    clearTimeout(timerRef.current);
    searchController.current?.abort();
    setLoading(false);
    if (!stack.length) searchScroll.current = window.scrollY;
    const savedScroll = window.scrollY;
    const patientHit = hit || result?.hits.find((item) => item.patientId === target.patientId);
    const enrichedTarget = { ...target, patientName: target.patientName || patientHit?.patientName, radiotherapyNo: target.radiotherapyNo || patientHit?.radiotherapyNo };
    setStack((previous) => [...previous.map((entry, index) => index === previous.length - 1 ? { ...entry, scroll: savedScroll } : entry), { key: `${target.sourceId}-${Date.now()}`, target: enrichedTarget, hit, scroll: 0 }]);
    window.scrollTo({ top: 0 });
  };
  const returnToSearch = () => {
    setStack([]);
    requestAnimationFrame(() => window.scrollTo({ top: searchScroll.current }));
    if (mode === 'global' && form.q.trim() && !sameConditions(form, result, patient)) {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void runSearch(formParams()), 300);
    }
  };
  const goBack = () => {
    if (stack.length < 2) returnToSearch();
    else setStack((previous) => previous.slice(0, -1));
  };
  const scopePatient = (record: RecordDocument) => {
    setMode('global');
    setPatient({ id: record.patientId, name: record.patientName, number: record.radiotherapyNo });
    setForm((previous) => ({ ...previous, scope: 'patient' }));
    setStack([]);
    window.scrollTo({ top: 0 });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const refreshResults = () => {
    const params = appliedParams();
    setForm({ q: params.q, scope: params.scope || 'all', source: params.source || 'all', type: params.type || 'all' });
    setStack([]);
    searchScroll.current = 0;
    void runSearch(params, true);
  };
  const clearSearch = () => { setForm((previous) => ({ ...previous, q: '' })); inputRef.current?.focus(); };
  const resultScope = result?.scope === 'patient' ? `当前患者：${result.hits[0]?.patientName || (patient && patient.id === result.patientId ? patient.name : '已选患者')} · ${result.hits[0]?.radiotherapyNo || (patient && patient.id === result.patientId ? patient.number : '')}` : '全部患者';
  const batchUnavailable = error?.code === 'BATCH_UNAVAILABLE' || error?.code === 'BATCH_EXPIRED' || error?.code === 'INVALID_BATCH';

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">跳至主要内容</a>
    <header className="app-header"><div className="header-inner"><button className="brand" onClick={() => { setMode('global'); returnToSearch(); }} aria-label="OIS 返回全局搜索"><span className="brand-symbol"><span /><span /></span><strong>OIS</strong><span className="brand-divider" /><span className="brand-name">临床工作台</span></button><nav className="top-nav" aria-label="主导航"><button className={mode === 'global' ? 'active' : ''} onClick={() => { setMode('global'); returnToSearch(); }}><Icon name="search" size={17} />全局搜索</button><button className={mode === 'diagnosis' ? 'active' : ''} onClick={() => { setMode('diagnosis'); setStack([]); window.scrollTo({ top: 0 }); }}>按诊断找患者</button></nav><div className="header-right"><span className="demo-tag"><span />演示数据</span><span className="workspace-label">多来源记录检索</span></div></div></header>
    <div className="sync-strip"><div className="sync-strip-inner"><span><span className={`status-dot ${statusError || status?.state === 'unavailable' ? 'warning-dot' : ''}`} />{statusError || status?.state === 'unavailable' ? `暂时无法读取同步状态${lastSyncedAt ? ` · 最近成功同步 ${displayTime(lastSyncedAt)}` : ''}` : status?.state === 'not_synced' ? '尚未同步搜索数据' : lastSyncedAt ? `最近成功同步 ${displayTime(lastSyncedAt)}` : '正在读取同步状态…'}</span><button className="text-button" onClick={() => setShowSyncHelp(true)}><Icon name="info" size={14} />同步说明</button></div></div>

    {status?.lastAttempt?.status === 'failed' && <div className="main-content status-notice"><div className="notice warning" role="status"><Icon name="info" /><div><strong>最近一次同步失败{status.batchId ? '，继续使用上次完整数据' : ''}</strong><p>{status.lastAttempt.message} · {displayTime(status.lastAttempt.at)}</p></div><button className="text-button" onClick={() => setShowSyncHelp(true)}>查看同步说明</button></div></div>}
    {status?.warning && <div className="main-content status-notice"><div className="notice warning" role="status"><Icon name="info" /><p>{status.warning}</p></div></div>}

    <DiagnosisPatientSearch hidden={mode !== 'diagnosis' || !!frame} onOpen={target => openDetail(target)} />
    {frame ? <div id="main-content"><DetailView frame={frame} depth={stack.length} query={mode === 'global' ? result?.q || '' : ''} syncedAt={mode === 'global' ? result?.syncedAt : undefined} onOpen={openDetail} onBack={goBack} onSearch={() => { setMode('global'); returnToSearch(); }} onScope={scopePatient} onRefresh={mode === 'diagnosis' ? returnToSearch : refreshResults} onSyncHelp={() => setShowSyncHelp(true)} /></div> : mode === 'global' && <main className="main-content search-view" id="main-content">
      <div className="page-heading"><div><div className="eyebrow">跨来源查询</div><h1>全局搜索</h1><p>查找患者、诊断、申请单、治疗计划与单据中的相关内容</p></div><div className="source-overview"><span>PMS<span>患者</span></span><span>EMR<span>诊断与单据</span></span><span>RVS<span>治疗计划</span></span></div></div>

      <section className="panel search-panel" aria-label="搜索条件">
        <div className="scope-row"><span className="control-label">搜索范围</span><div className="scope-options" role="group" aria-label="搜索范围"><button aria-pressed={form.scope === 'all'} className={form.scope === 'all' ? 'selected' : ''} onClick={() => setForm((previous) => ({ ...previous, scope: 'all' }))}>全部患者</button><button aria-pressed={form.scope === 'patient'} className={form.scope === 'patient' ? 'selected' : ''} disabled={!patient} title={!patient ? '在患者详情中选择“在此患者范围搜索”' : `限定为 ${patient.name} · ${patient.number}`} onClick={() => setForm((previous) => ({ ...previous, scope: 'patient' }))}>{patient ? `当前患者：${patient.name} · ${patient.number}` : '当前患者（未选择）'}</button></div>{form.scope === 'patient' && <button className="text-button scope-reset" onClick={() => setForm((previous) => ({ ...previous, scope: 'all' }))}>切回全部患者</button>}</div>
        <form className="search-form" onSubmit={(event) => { event.preventDefault(); void runSearch(formParams()); }}><div className="search-input-wrap"><Icon name="search" size={22} /><label className="sr-only" htmlFor="global-search">姓名、放疗号、记录编号或内容关键词</label><input ref={inputRef} id="global-search" value={form.q} onChange={(event) => setForm((previous) => ({ ...previous, q: event.target.value }))} placeholder="搜索姓名、放疗号、记录编号或内容关键词" autoComplete="off" spellCheck={false} aria-describedby="search-hint" />{form.q && <button type="button" className="icon-button clear-input" onClick={clearSearch} aria-label="清空关键词"><Icon name="close" size={18} /></button>}<kbd>Enter</kbd></div><button className="primary-button search-submit" type="submit"><Icon name="search" size={18} />搜索</button></form>
        <div className="search-helper" id="search-hint"><span>完整编号优先匹配，正文保留原始上下文</span><span>试试：{['屏气', '鼻咽癌', '000123'].map((word) => <button key={word} onClick={() => { setForm((previous) => ({ ...previous, q: word })); inputRef.current?.focus(); }}>{word}</button>)}</span></div>
        <div className="filter-row"><span className="control-label">数据来源</span><div className="filter-options" role="group" aria-label="数据来源">{(['all', 'pms', 'emr', 'rvs'] as const).map((source) => <button key={source} className={form.source === source ? 'selected' : ''} aria-pressed={form.source === source} onClick={() => changeSource(source)}>{source === 'all' ? '全部来源' : source.toUpperCase()}</button>)}</div></div>
      </section>

      <section className="results-section" ref={resultsRef} aria-label="搜索结果" aria-busy={loading}>
        <div className="type-tabs" role="group" aria-label="结果类型"><button className={form.type === 'all' ? 'active' : ''} aria-pressed={form.type === 'all'} onClick={() => setForm((previous) => ({ ...previous, type: 'all' }))}>全部记录{countConditionsMatch && <span>{TYPES.reduce((sum, type) => sum + result!.typeCounts[type], 0)}</span>}</button>{supportedTypes.map((type) => <button key={type} className={form.type === type ? 'active' : ''} aria-pressed={form.type === type} onClick={() => setForm((previous) => ({ ...previous, type }))}>{TYPE_LABELS[type]}{countConditionsMatch && <span>{result!.typeCounts[type]}</span>}</button>)}</div>

        {newerBatch && <div className="notice update-notice" role="status"><Icon name="refresh" /><div><strong>数据已更新，刷新结果查看</strong><p>当前列表和翻页保留原同步批次。刷新后从第一页展示最新结果。</p></div><button className="secondary-button" onClick={refreshResults}>刷新结果</button></div>}
        {(loading || dirty) && <div className="query-progress" role="status">{loading ? <span className="spinner small" /> : <Icon name="clock" size={16} />}<span>{loading ? '正在查询' : error ? '本次查询条件' : '等待查询'}“{form.q.trim()}” · {form.scope === 'patient' ? `当前患者 ${patient?.name}` : '全部患者'} · {form.source === 'all' ? '全部来源' : form.source.toUpperCase()} · {form.type === 'all' ? '全部记录' : TYPE_LABELS[form.type]}</span></div>}

        {error && !notSynced && <div className="notice error-notice" role="alert"><Icon name="info" /><div><strong>{batchUnavailable ? '原查询批次已不可用，请重新查询' : '查询失败'}</strong><p>{error.message}{result ? ` 下方保留上次成功结果（${displayTime(receivedAt)}）。` : ''}</p></div><button className="secondary-button" onClick={() => batchUnavailable ? refreshResults() : void runSearch(attempted || formParams())}>{batchUnavailable ? '重新查询' : '重试'}</button></div>}

        {result && <div className="results-summary"><div><span className="applied-label">{dirty || loading || error ? '当前保留结果' : '搜索结果'}</span><strong>“{result.q}”</strong><span>共 <b>{result.total}</b> 条记录</span><div className="applied-conditions">{resultScope}<i />{result.source === 'all' ? '全部来源' : result.source.toUpperCase()}<i />{result.type === 'all' ? '全部记录' : TYPE_LABELS[result.type]}</div></div><div className="result-timing"><span>本次查询 {duration == null ? '—' : duration} ms</span><span>搜索数据 {displayTime(result.syncedAt)}</span></div></div>}

        {!form.q.trim() && !result && <div className="panel empty-state welcome-state"><div className="state-icon"><Icon name="search" size={30} /></div><h2>从一个关键词开始</h2><p>按患者身份查找全部相关记录，或从正文内容定位具体单据</p><div className="example-grid"><button onClick={() => setForm((previous) => ({ ...previous, q: '000123' }))}><Icon name="patient" size={22} /><strong>查找患者与关联记录</strong><span>放疗号 <b>000123</b></span><Icon name="arrow" size={15} /></button><button onClick={() => setForm((previous) => ({ ...previous, q: '屏气' }))}><Icon name="document" size={22} /><strong>定位正文中的内容</strong><span>内容关键词 <b>屏气</b></span><Icon name="arrow" size={15} /></button></div><div className="clinical-note"><Icon name="info" size={15} />关键词命中表示原文中出现该内容，请结合完整记录及实际诊断状态理解。</div></div>}
        {form.q.trim() && notSynced && !result && <div className="panel empty-state"><div className="state-icon"><Icon name="database" size={30} /></div><h2>尚未同步搜索数据</h2><p>输入条件已保留。完成首次完整同步后即可开始搜索。</p><button className="primary-button" onClick={() => setShowSyncHelp(true)}>查看同步说明</button><button className="text-button" onClick={() => void runSearch(formParams())}>重新查询</button></div>}
        {loading && !result && !notSynced && <div className="panel skeleton-list" aria-hidden="true">{[1, 2, 3].map((item) => <div className="skeleton-row" key={item}><span /><div><i /><i /><i /></div></div>)}</div>}
        {result && result.total === 0 && <div className="panel empty-state"><div className="state-icon"><Icon name="search" size={30} /></div><h2>未找到匹配记录</h2><p>当前条件未匹配到记录。可以换一个关键词，或调整患者范围与来源。</p><div className="button-row"><button className="secondary-button" onClick={() => { inputRef.current?.focus(); inputRef.current?.select(); }}>修改关键词</button><button className="text-button" onClick={clearSearch}>清空关键词</button></div></div>}
        {result && result.hits.length > 0 && <div className="panel result-list">{result.hits.map((hit) => <ResultCard key={hit.id} hit={hit} query={result.q} onOpen={() => openDetail({ source: hit.source, recordType: hit.recordType, sourceId: hit.sourceId, patientId: hit.patientId, title: hit.title }, hit)} onPatient={() => openDetail({ source: 'pms', recordType: 'patient', sourceId: hit.patientId, patientId: hit.patientId, title: hit.patientName }, hit.recordType === 'patient' ? hit : undefined)} />)}</div>}
        {result && result.total > 0 && <div className="pagination"><span>第 {(result.page - 1) * result.pageSize + 1}–{Math.min(result.page * result.pageSize, result.total)} 条，共 {result.total} 条<span className="page-size">每页 20 条</span></span><div><button className="secondary-button" disabled={result.page <= 1 || loading || dirty} onClick={() => void runSearch({ ...appliedParams(), page: result.page - 1, batchId: result.batchId }, true)}>上一页</button><span className="page-counter">{result.page} <span>/ {Math.ceil(result.total / result.pageSize)}</span></span><button className="secondary-button" disabled={result.page * result.pageSize >= result.total || loading || dirty} onClick={() => void runSearch({ ...appliedParams(), page: result.page + 1, batchId: result.batchId }, true)}>下一页</button></div></div>}
      </section>
      <footer className="page-footer"><span>OIS 全局搜索原型 · 全部内容为虚构演示数据</span><span>搜索覆盖 PMS / EMR / RVS</span></footer>
    </main>}
    {showSyncHelp && <SyncHelp onClose={() => setShowSyncHelp(false)} />}
  </div>;
}
