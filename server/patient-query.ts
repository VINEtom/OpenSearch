import type { PatientSearchFilters } from '../shared/types.js';

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

  const diagnosedThrough = shanghaiDate.format(now);
  const [year, month, day] = diagnosedThrough.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(year, month - months, 0)).getUTCDate();
  const diagnosedFrom = new Date(Date.UTC(year, month - 1 - months, Math.min(day, monthEnd))).toISOString().slice(0, 10);
  return { diagnosis, diagnosedFrom, diagnosedThrough, ...(minimumFractions === undefined ? {} : { minimumFractions }) };
}
