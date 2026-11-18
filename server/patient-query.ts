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

export function currentPatientDate(now = new Date()): string {
  return shanghaiDate.format(now);
}

const chineseDigits = '零一二三四五六七八九';
const ageNumbers = new Map<string, number>();

function chineseUnderHundred(value: number, omitLeadingOne = true): string {
  if (value < 10) return chineseDigits[value];
  const tens = Math.floor(value / 10);
  const units = value % 10;
  return (tens === 1 && omitLeadingOne ? '' : chineseDigits[tens]) + '十' + (units ? chineseDigits[units] : '');
}

for (let years = 0; years <= 150; years++) {
  if (years < 100) {
    ageNumbers.set(chineseUnderHundred(years), years);
    ageNumbers.set(chineseUnderHundred(years, false), years);
  } else {
    const remainder = years - 100;
    ageNumbers.set('一百' + (remainder ? (remainder < 10 ? '零' : '') + chineseUnderHundred(remainder, false) : ''), years);
  }
}

export function ageYears(value: string): number | undefined {
  const normalized = value.normalize('NFKC').trim().replaceAll('〇', '零').replaceAll('两', '二');
  if (/^[0-9]{1,3}$/u.test(normalized)) {
    const years = Number(normalized);
    return years <= 150 ? years : undefined;
  }
  return ageNumbers.get(normalized);
}

export function diagnosisDateRange(months: number, now = new Date()) {
  const diagnosedThrough = currentPatientDate(now);
  const [year, month, day] = diagnosedThrough.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  const diagnosedFrom = new Date(Date.UTC(year, month - 1 - months, Math.min(day, monthEnd))).toISOString().slice(0, 10);
  return { diagnosedFrom, diagnosedThrough };
}
