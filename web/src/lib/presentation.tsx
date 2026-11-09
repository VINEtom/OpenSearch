import React from 'react';
import { DOCUMENT_CATEGORIES, type RecordType, type SearchType, type Source } from '../../../shared/types';

export const TYPE_LABELS: Record<RecordType, string> = {
  patient: '患者', diagnosis: '诊断', plan_request: '计划申请单', treatment_plan: '治疗计划', document: '其他单据',
};
export const TYPES: RecordType[] = ['patient', 'diagnosis', 'plan_request', 'treatment_plan', 'document'];
export const TYPE_SOURCE: Record<RecordType, Source> = {
  patient: 'pms', diagnosis: 'emr', plan_request: 'emr', treatment_plan: 'rvs', document: 'emr',
};
export const SEARCH_CATEGORIES: { id: SearchType; label: string; source: Source }[] = [
  { id: 'patient', label: '患者', source: 'pms' },
  { id: 'diagnosis', label: '诊断', source: 'emr' },
  ...DOCUMENT_CATEGORIES.map(name => ({ id: name, label: name, source: 'emr' as const })),
];
export function categoryLabel(type: string): string {
  return SEARCH_CATEGORIES.find(item => item.id === type)?.label || TYPE_LABELS[type as RecordType] || type;
}
export const SEX_LABELS: Record<string, string> = { female: '女', male: '男', other: '其他', unknown: '未知' };
export const CONFIRM_LABELS: Record<string, string> = { confirmed: '确诊', suspected: '疑似', refuted: '已排除', unknown: '未知' };

export function displayTime(value?: string | null) {
  if (!value) return '尚未同步';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
}

export function rangesFor(text: string, keywords: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  const normalized = text.toLocaleLowerCase();
  for (const word of new Set(keywords.filter(Boolean))) {
    const needle = word.toLocaleLowerCase();
    let index = normalized.indexOf(needle);
    while (index >= 0) {
      ranges.push([index, index + needle.length]);
      index = normalized.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  return ranges;
}

export function Highlight({ text, ranges }: { text: string; ranges: [number, number][] }) {
  const safe = ranges.filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as [number, number])
    .filter(([start, end]) => start < end).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const range of safe) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    parts.push(text.slice(cursor, start), <mark key={index}>{text.slice(start, end)}</mark>);
    cursor = end;
  });
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.7 4.7" /></>,
    arrow: <path d="m9 5 7 7-7 7" />,
    back: <><path d="m10 5-7 7 7 7M3 12h18" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.3 7.3A8 8 0 0 1 18 6l2 2M4 16l2 2a8 8 0 0 0 12.7-1.3" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
    patient: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></>,
    diagnosis: <><path d="M9 3h6v3H9zM7 4H5v17h14V4h-2M8 12h8M8 16h5" /></>,
    plan_request: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" /></>,
    treatment_plan: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 1v4M12 19v4M1 12h4M19 12h4" /></>,
    document: <><path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.document}</svg>;
}
