import { diagnosisDateRange } from '../../../server/patient-query.js';
import type { PatientAgeFilter, PatientSearchFilters } from '../../../shared/types.js';

const sexCodes = { male: '男', female: '女', other: '其他', unknown: '未知' } as const;
const sexWords: Record<string, keyof typeof sexCodes> = {
  男: 'male', 女: 'female', 其他: 'other', 未知: 'unknown',
  male: 'male', female: 'female', other: 'other', unknown: 'unknown',
};

export function parseSexQuery(query: string): { sex: keyof typeof sexCodes; label: string } | undefined {
  const match = /^性别\s*(?:是|为|=|:|：)?\s*(男|女|其他|未知|male|female|other|unknown)$/iu.exec(query.normalize('NFKC').trim());
  if (!match) return undefined;
  const sex = sexWords[match[1].toLowerCase()] ?? sexWords[match[1]];
  return sex ? { sex, label: sexCodes[sex] } : undefined;
}

const chineseMonths = new Map([...'一二三四五六七八九十'].map((word, index) => [word, index + 1]));
const shanghaiDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function parsePatientQuery(query: string, now = new Date()): PatientSearchFilters | undefined {
  const match = /^最近\s*(\d{1,2}|[一二三四五六七八九十])\s*个?月\s*确诊\s*([\p{Script=Han}A-Za-z0-9-]{1,50})(?:\s*[,，、]\s*处方\s*(?:分次数?\s*)?(?:不少于|至少|不低于)\s*([1-9]\d{0,9})\s*(?:次|个?分次))?\s*。?$/u.exec(query.normalize('NFKC'));
  if (!match) return undefined;
  const [, monthText, diagnosis, fractionText] = match;
  const months = chineseMonths.get(monthText) ?? Number(monthText);
  const minimumFractions = fractionText === undefined ? undefined : Number(fractionText);
  if (months < 1 || (minimumFractions !== undefined && minimumFractions > 2147483647)) return undefined;

  const { diagnosedFrom, diagnosedThrough } = diagnosisDateRange(months, now);
  return { diagnosis, diagnosedFrom, diagnosedThrough, ...(minimumFractions === undefined ? {} : { minimumFractions }) };
}

const ageOperators = new Map<string, PatientAgeFilter['operator']>([
  ['大于', '>'], ['>', '>'], ['至少', '>='], ['不少于', '>='], ['>=', '>='], ['≥', '>='],
  ['小于', '<'], ['<', '<'], ['至多', '<='], ['不超过', '<='], ['<=', '<='], ['≤', '<='],
]);

export function parseAgeQuery(query: string, now = new Date()): PatientAgeFilter | undefined {
  const match = /^年龄\s*(大于|至少|不少于|小于|至多|不超过|>=|<=|>|<|≥|≤)\s*(\d{1,3}|[零一二两三四五六七八九]|[一二两三四五六七八九]?十[一二三四五六七八九]?)\s*(?:周?岁)\s*。?$/u.exec(query.normalize('NFKC').trim());
  if (!match) return undefined;
  const [, comparison, ageText] = match;
  const operator = ageOperators.get(comparison)!;
  const digits = '零一二三四五六七八九';
  const chinese = ageText.replaceAll('两', '二');
  const [tens, ones] = chinese.split('十');
  const years = /^\d/u.test(ageText) ? Number(ageText)
    : ones === undefined ? digits.indexOf(tens)
    : (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
  return { operator, years, asOf: shanghaiDate.format(now) };
}

export function splitAgeQuery(query: string, now = new Date()): { ageFilter: PatientAgeFilter; remaining: string[] } | 'review' | undefined {
  const parts = query.normalize('NFKC').trim().split(/并且|且/u).map(part => part.trim());
  const remaining: string[] = [];
  let ageFilter: PatientAgeFilter | undefined;
  for (const part of parts) {
    const age = parseAgeQuery(part, now);
    if (age) {
      if (ageFilter) return 'review';
      ageFilter = age;
    } else {
      remaining.push(part);
    }
  }
  if (!ageFilter && !/年龄\s*(?:大于|至少|不少于|小于|至多|不超过|[<>≥≤])/u.test(query.normalize('NFKC'))) return undefined;
  if (!ageFilter || remaining.some(part => !part || /或|年龄/u.test(part))) return 'review';
  return { ageFilter, remaining };
}

export function birthDateRange({ operator, years, asOf }: PatientAgeFilter): { lte: string; gt?: string } {
  const [year, month, day] = asOf.split('-').map(Number);
  const cutoffYear = year - years - (operator === '>' || operator === '<=' ? 1 : 0);
  const monthEnd = new Date(Date.UTC(cutoffYear, month, 0)).getUTCDate();
  const cutoff = new Date(Date.UTC(cutoffYear, month - 1, Math.min(day, monthEnd))).toISOString().slice(0, 10);
  return operator === '>' || operator === '>=' ? { lte: cutoff } : { gt: cutoff, lte: asOf };
}
