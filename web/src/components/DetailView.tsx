import React, { useEffect, useRef, useState } from 'react';
import type { DetailResponse, RecordDocument, RecordType, Relation, SearchHit, Source } from '../../../shared/types';
import { errorInfo, readApi, type ErrorInfo } from '../lib/api';
import { CONFIRM_LABELS, displayTime, Highlight, Icon, rangesFor, SEX_LABELS, TYPES, TYPE_LABELS } from '../lib/presentation';

export interface DetailTarget {
  source: Source;
  recordType: RecordType;
  sourceId: string;
  patientId: string;
  title: string;
  patientName?: string;
  radiotherapyNo?: string;
}
export interface DetailFrame {
  key: string;
  target: DetailTarget;
  hit?: SearchHit;
  scroll: number;
}

const fieldAliases: Record<string, string> = {
  name: 'title', diagnosis_name: 'title', summary: 'bodyText', body_text: 'bodyText', notes: 'bodyText',
  radiotherapy_no: 'radiotherapyNo', request_no: 'recordNo', plan_no: 'recordNo', patient_name: 'patientName',
  document_type: 'documentType', code_system: 'codeSystem', code_version: 'codeVersion',
};
const canonicalField = (name: string) => fieldAliases[name] || name;
const availabilityLabels: Record<Relation['availability'], string> = {
  available: '', deleted: '已删除', voided: '已作废', missing: '记录缺失', invalid: '关联异常',
};

function errorTitle(error: ErrorInfo) {
  if (error.code === 'PATIENT_DELETED') return '所属患者已删除';
  if (error.code === 'DELETED') return '该记录已删除';
  if (error.code === 'VOIDED') return '该记录已作废';
  if (error.code === 'NOT_FOUND') return '未找到该记录';
  if (error.code === 'RELATION_ERROR') return '记录关联异常';
  return '详情加载失败';
}

export default function DetailView({ frame, depth, query, syncedAt, onOpen, onBack, onSearch, onScope, onRefresh, onSyncHelp }: {
  frame: DetailFrame;
  depth: number;
  query: string;
  syncedAt?: string;
  onOpen: (target: DetailTarget) => void;
  onBack: () => void;
  onSearch: () => void;
  onScope: (patient: RecordDocument) => void;
  onRefresh: () => void;
  onSyncHelp: () => void;
}) {
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  const target = frame.target;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    const path = target.recordType === 'patient'
      ? `/patients/${encodeURIComponent(target.sourceId)}`
      : `/records/${target.source}/${target.recordType}/${encodeURIComponent(target.sourceId)}`;
    readApi<DetailResponse>(path, controller.signal).then((value) => {
      if (!controller.signal.aborted) setDetail(value);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(errorInfo(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [frame.key, attempt]);

  useEffect(() => {
    if (loading) return;
    const id = requestAnimationFrame(() => {
      if (frame.scroll > 0) window.scrollTo({ top: frame.scroll });
      else if (detail && frame.hit) {
        const matched = rootRef.current?.querySelector('[data-matched="true"]');
        if (matched) matched.scrollIntoView({ block: 'center' });
        else window.scrollTo({ top: 0 });
      } else window.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(id);
  }, [loading, detail, frame.key]);

  const snapshot = frame.hit;
  const relationChanged = !!(detail && snapshot && (detail.record.diagnosisId !== snapshot.diagnosisId
    || detail.record.planRequestId !== snapshot.planRequestId || detail.record.sourceDocumentId !== snapshot.sourceDocumentId));
  const changed = !!(detail && snapshot && (
    detail.record.sourceRevision !== snapshot.sourceRevision || detail.patient.sourceRevision !== snapshot.patientRevision
    || relationChanged
  ));
  const matchedFields = snapshot?.matchedFields || [];
  const tokensForField = (field: string) => matchedFields.filter((match) => canonicalField(match.field) === canonicalField(field))
    .flatMap((match) => match.ranges.map(([start, end]) => match.text.slice(Math.max(0, start), Math.min(match.text.length, end))));
  const matchNames = new Set(matchedFields.map((match) => canonicalField(match.field)));
  const changedMatches = detail && snapshot ? matchedFields.filter((match) => {
    const field = canonicalField(match.field) as keyof RecordDocument;
    return snapshot[field] !== detail.record[field];
  }) : [];
  const highlight = (field: string, value: string) => <Highlight text={value} ranges={rangesFor(value, [...tokensForField(field), query])} />;

  return <main className="main-content detail-view" ref={rootRef}>
    <div className="detail-navigation">
      <button className="text-button back-button" onClick={onBack}><Icon name="back" size={17} />{depth > 1 ? '返回上一详情' : '返回搜索结果'}</button>
      <div className="breadcrumb"><button onClick={onSearch}>全局搜索</button><span>/</span><span>{TYPE_LABELS[target.recordType]}详情</span>{depth > 1 && <span className="depth-label">关联第 {depth - 1} 层</span>}</div>
      {depth > 1 && <button className="text-button" onClick={onSearch}>直接返回搜索结果</button>}
    </div>

    {loading && <div className="panel empty-state" role="status"><span className="spinner" /><h2>正在读取最新详情</h2><p>正在从 {target.source.toUpperCase()} 读取该条记录与关联信息</p></div>}

    {error && <div className="panel empty-state error-state" role="alert">
      <div className="state-icon"><Icon name="info" size={28} /></div>
      <h2>{errorTitle(error)}</h2><p>{error.message}</p>
      <p className="muted">{target.source.toUpperCase()} · {TYPE_LABELS[target.recordType]} · {target.title}</p>
      {target.patientName && <p>患者：{target.patientName} · 放疗号 {target.radiotherapyNo}</p>}
      <div className="button-row"><button className="primary-button" onClick={() => setAttempt((value) => value + 1)}>重试读取</button><button className="secondary-button" onClick={onBack}>返回上一页</button><button className="secondary-button" onClick={onRefresh}>刷新搜索结果</button></div>
    </div>}

    {detail && <>
      {changed && <div className="notice warning" role="status"><Icon name="info" /><div><strong>内容已更新，当前详情与搜索时不同</strong><p>{relationChanged ? '关联信息已有变化。' : ''}来源更新时间 {displayTime(detail.record.updatedAt)} · 搜索数据同步时间 {displayTime(syncedAt)}。可能需要重新同步。</p></div><button className="text-button" onClick={onSyncHelp}>查看同步说明</button></div>}

      <section className="patient-banner" aria-label="所属患者">
        <div className="patient-avatar"><Icon name="patient" size={27} /></div>
        <div className="patient-identity"><div className="eyebrow">{target.recordType === 'patient' ? '患者资料' : '所属患者'}{changed && <span className="patient-change">内容已更新 · 与搜索时不同</span>}</div><h2 data-matched={matchNames.has('patientName') || (target.recordType === 'patient' && matchNames.has('title'))}>{target.recordType === 'patient' ? <span className="patient-title">{highlight('patientName', detail.patient.patientName)}</span> : <button className="patient-title" onClick={() => onOpen({ source: 'pms', recordType: 'patient', sourceId: detail.patient.patientId, patientId: detail.patient.patientId, title: detail.patient.patientName, patientName: detail.patient.patientName, radiotherapyNo: detail.patient.radiotherapyNo })}>{highlight('patientName', detail.patient.patientName)}</button>}<span className="identity-meta">{SEX_LABELS[detail.patient.sex] || detail.patient.sex} · {detail.patient.birthDate || '出生日期未知'}</span></h2></div>
        <div className="patient-number" data-matched={matchNames.has('radiotherapyNo')}><span>放疗号</span><strong>{highlight('radiotherapyNo', detail.patient.radiotherapyNo)}</strong></div>
        <button className="secondary-button" onClick={() => onScope(detail.patient)}><Icon name="search" size={16} />在此患者范围搜索</button>
      </section>

      <div className="detail-columns">
        <article className="panel record-panel">
          <header className="record-heading"><div className="record-badges"><span className={`type-badge ${detail.record.recordType}`}>{TYPE_LABELS[detail.record.recordType]}</span><span className="source-label">{detail.record.source.toUpperCase()}</span><span className="live-label"><span />来源最新内容</span></div><h1>{highlight('title', detail.record.title)}</h1><p className="record-updated"><Icon name="clock" size={14} />来源更新时间 {displayTime(detail.record.updatedAt)}</p></header>
          <div className="detail-fields">
            {detail.fields.map((field) => {
              const name = canonicalField(field.name);
              const matched = matchNames.has(name);
              return <section key={field.name} className={`detail-field ${field.kind === 'paragraph' ? 'paragraph-field' : ''} ${matched ? 'matched-field' : ''}`} data-matched={matched} id={`field-${name}`}>
                <div className="field-label">{field.label}{matched && <span className="match-indicator">原搜索命中字段</span>}</div>
                <div className={`field-value ${field.value == null ? 'muted' : ''}`}>{field.value == null ? '未提供' : highlight(name, name === 'sex' ? SEX_LABELS[field.value] || field.value : name === 'confirmationStatus' ? CONFIRM_LABELS[field.value] || field.value : field.value)}</div>
              </section>;
            })}
          </div>
          {matchedFields.length > 0 && <section className="search-snapshot"><h3><Icon name="search" size={15} />搜索时的命中内容</h3><p>以下内容保留自 {displayTime(syncedAt)} 同步的数据。</p>{changedMatches.length > 0 && <p className="changed-copy">原命中字段已有变化：{changedMatches.map((field) => field.label).join('、')}。上方显示最新内容，仍存在的匹配文字已高亮。</p>}{matchedFields.map((match, index) => <div className="snapshot-match" key={`${match.field}-${index}`}><span>{match.label}</span><p><Highlight text={match.text} ranges={match.ranges} /></p></div>)}</section>}
        </article>

        <aside className="panel relations-panel" aria-label="关联记录">
          <div className="section-heading"><div><h2>关联记录</h2><p>沿原始关联查看完整记录</p></div><span className="count-badge">{detail.relations.length}</span></div>
          {detail.relations.length === 0 && <p className="relation-empty">暂无关联记录</p>}
          {TYPES.map((type) => {
            const relations = detail.relations.filter((relation) => relation.recordType === type);
            if (!relations.length) return null;
            return <section className="relation-group" key={type}><h3><Icon name={type} size={15} />{TYPE_LABELS[type]}<span>{relations.length}</span></h3>{relations.map((relation) => <button className={`relation-card ${relation.availability !== 'available' ? 'relation-unavailable' : ''}`} key={`${relation.source}:${relation.recordType}:${relation.sourceId}`} onClick={() => onOpen({ ...relation, title: relation.title, patientName: detail.patient.patientName, radiotherapyNo: detail.patient.radiotherapyNo })}>
              <span className="relation-card-body"><span className="relation-label">{relation.label} · {relation.source.toUpperCase()}</span><strong>{relation.title}</strong>{relation.recordNo && <span className="mono">{relation.recordNo}</span>}{relation.availability !== 'available' && <span className="unavailable-tag">{availabilityLabels[relation.availability]} · 查看原因</span>}</span><Icon name="arrow" size={16} />
            </button>)}</section>;
          })}
        </aside>
      </div>
    </>}
  </main>;
}
