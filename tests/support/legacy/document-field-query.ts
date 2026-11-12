import { catalogs, fieldOwners, type Filter } from '../../../server/document-field-query.js';
import type { SimulationFieldCondition } from '../../../shared/types.js';
type Condition = Filter['conditions'][number];
const escapeRegex = (value: string) => value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
const alternatives = (values: string[]) => [...values].sort((a, b) => b.length - a.length).map(escapeRegex).join('|');
const types = alternatives(Object.keys(catalogs));
const typePrefix = new RegExp(`^(?:只看\\s*)?(${types})(?:里|中|内|[,;、]\\s*)\\s*`, 'u');
const typeSuffix = new RegExp(`\\s*(?:的\\s*)?(${types})$`, 'u');
const operators: Record<string, SimulationFieldCondition['operator']> = {
  包含: 'contains', 为: 'eq', 是: 'eq', 等于: 'eq', '=': 'eq', ':': 'eq',
  小于: 'lt', '<': 'lt', 不超过: 'lte', 至多: 'lte', '<=': 'lte', '≤': 'lte',
  大于: 'gt', '>': 'gt', 至少: 'gte', 不少于: 'gte', '>=': 'gte', '≥': 'gte',
};
const labels = alternatives([...fieldOwners.keys(), '定位部位']);
const conditionPattern = new RegExp(`^(${labels})\\s*(${alternatives(Object.keys(operators))})\\s*(.+)$`, 'u');
const additionalCondition = new RegExp(`(?:或者|或|和|以及|同时满足|同时|并满足)\\s*(?=${labels}\\s*(?:${alternatives(Object.keys(operators))}))`, 'u');
const joiner = /\s*(?:并且|且|[,;、])\s*/u;

export function runScoped(query: string, options?: { explicitSingle: true }): Filter | 'review' | undefined {
  let text = query.normalize('NFKC').trim().replace(/^(?:查找|搜索|找)\s*/u, '').replace(/[。！？?!]$/u, '').trim();
  const prefix = typePrefix.exec(text);
  if (prefix) text = text.slice(prefix[0].length);
  const suffix = typeSuffix.exec(text);
  if (suffix) text = text.slice(0, suffix.index).trim();
  if (prefix && suffix && prefix[1] !== suffix[1]) return 'review';
  let type: string | undefined = prefix?.[1] ?? suffix?.[1];
  const explicit = Boolean(type);
  const conditions: Condition[] = [];
  while (text) {
    const match = conditionPattern.exec(text);
    if (!match) return conditions.length ? 'review' : undefined;
    const label = match[1] === '定位部位' ? '扫描部位' : match[1];
    const owners = fieldOwners.get(label) ?? [];
    if (!explicit && (options?.explicitSingle || owners.length !== 1)) return 'review';
    if (type && !owners.includes(type)) return 'review';
    type ??= owners[0];
    const field = catalogs[type]?.find(spec => spec.label === label);
    if (!field) return 'review';

    const operator = operators[match[2]];
    const rest = match[3];
    const enumEntry = operator === 'eq' && field.enum && Object.values(field.enum)
      .map(original => ({ original, normalized: original.normalize('NFKC') }))
      .sort((a, b) => b.normalized.length - a.normalized.length)
      .find(({ normalized }) => {
        if (!rest.startsWith(normalized)) return false;
        const tail = rest.slice(normalized.length);
        return !tail.trim() || joiner.exec(tail)?.index === 0;
      });
    const enumValue = enumEntry ? enumEntry.normalized : undefined;
    const remainder = enumValue ? rest.slice(enumValue.length) : rest;
    if (options?.explicitSingle && additionalCondition.test(remainder)) return 'review';
    const separator = joiner.exec(remainder);
    const rawValue = (enumValue || remainder.slice(0, separator?.index ?? remainder.length)).trim();
    const value = options?.explicitSingle && field.number ? rawValue.replace(/(?<=\d)\s*次$/u, '') : rawValue;
    if (!value || (operator === 'contains' && !field.text) ||
        (operator !== 'eq' && operator !== 'contains' && !field.number) ||
        (field.number && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(value)) ||
        (field.enum && operator === 'eq' && !enumValue) ||
        (field.boolean && value !== '是' && value !== '否')) return 'review';
    conditions.push({ label, operator, value: enumEntry ? enumEntry.original : value });
    if (!separator) break;
    if (options?.explicitSingle) return 'review';
    text = remainder.slice(separator.index + separator[0].length).trim();
    if (!text) return 'review';
  }
  return type && conditions.length ? { type, conditions } : undefined;
}
