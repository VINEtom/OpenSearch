import type { PatientAgeFilter } from '../shared/types.js';

export function birthDateRange({ operator, years, asOf }: PatientAgeFilter): { lte: string; gt?: string } {
  const [year, month, day] = asOf.split('-').map(Number);
  const cutoffYear = year - years - (operator === '>' || operator === '<=' ? 1 : 0);
  const monthEnd = new Date(Date.UTC(cutoffYear, month, 0)).getUTCDate();
  const cutoff = new Date(Date.UTC(cutoffYear, month - 1, Math.min(day, monthEnd))).toISOString().slice(0, 10);
  return operator === '>' || operator === '>=' ? { lte: cutoff } : { gt: cutoff, lte: asOf };
}

const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function diagnosisDateRange(months: number, now = new Date()) {
  const diagnosedThrough = shanghaiDate.format(now);
  const [year, month, day] = diagnosedThrough.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  const diagnosedFrom = new Date(Date.UTC(year, month - 1 - months, Math.min(day, monthEnd))).toISOString().slice(0, 10);
  return { diagnosedFrom, diagnosedThrough };
}
