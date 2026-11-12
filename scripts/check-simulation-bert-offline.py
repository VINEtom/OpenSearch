"""Compare source-text checks with the existing offline schema gate."""

from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import sys
import unicodedata


COMPARATORS = {
    "eq": ("取值是", "一栏填的是", "登记的是", "登记成了", "填写为", "等于", "填了", "为", "是", "取", "="),
    "contains": ("里记着", "有这样一段", "这栏提及", "出现过", "包含", "提到", "写有", "写了", "写到", "能看到"),
    "lt": ("小于", "低于", "不到", "未达到", "还没到", "必须低于", "必须小过", "还不足", "不足", "必须少于", "<"),
    "lte": ("不高于", "不超过", "至多", "上限是", "封顶在", "最高允许", "不得多于", "最多只能到", "不能超过", "最多可为", "最多等于", "<=", "≤"),
    "gt": ("大于", "高于", "超过", "超出", "超出了", "必须高于", "须多过", "必须超过", "必须严格高于", "应超过", ">"),
    "gte": ("不少于", "不低于", "至少", "下限为", "下限是", "最低得有", "不得少于", "起码得有", "不能低于", "最低不能少于", "最少为", ">=", "≥"),
}
OP_BY_WORD = {word: op for op, words in COMPARATORS.items() for word in words}
OP_PATTERN = re.compile("|".join(map(re.escape, sorted(OP_BY_WORD, key=len, reverse=True))))
NUMBER = r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)"
POSTFIX = {
    ("要比", "少"): "lt", ("不能比", "多"): "lte",
    ("要比", "多"): "gt", ("不能比", "少"): "gte",
    ("须比", "更低"): "lt", ("须比", "更高"): "gt",
}
POSTFIX_PATTERN = re.compile(rf"(要比|不能比|须比)\s*({NUMBER})\s*(更低|更高|少|多)")
UNSUPPORTED = re.compile(
    r"或者|或(?!者)|任意(?:一个|一种)|二选一|要么|也可以|也行|"
    r"排除|排掉|剔除|去掉|过滤掉|不要|不查|不看|不包含|不是|并非|不等于"
)
JOIN = re.compile(r"(?:，|,|；|;|、)?\s*(?:而且还得|也要满足|同时还得|另外还要|还要求|同时满足|还需|并且|同时|另外|加上|且(?!不含))\s*|[，,；;、]")
TAIL = re.compile(
    r"\s*(?:的?(?:定位(?:申请单|申请|资料|记录|单据|单)?|记录|单据|单子)"
    r"(?:这些要求都符合的|都满足的|都符合的)?|这些要求都符合的|这些要求都满足的|这些要求都满足的定位申请|"
    r"符合的单子|的挑出来|也得满足|这些要求都满足的定位申请)?[。？?！!]?\s*$"
)


def source_checker(catalog):
    label_map = {spec["label"]: field for field, spec in catalog.items()}
    for alias, name in {
        "层厚": "CT层厚", "管电压": "CT千伏", "管电流": "CT毫安", "扫描区域": "扫描部位",
        "治疗区域": "治疗部位", "影像类型": "成像方式", "固定方法": "固定说明", "扫描要求": "扫描说明",
    }.items():
        label_map[alias] = label_map[name]
    names = "|".join(map(re.escape, sorted(label_map, key=len, reverse=True)))
    label_pattern = re.compile(names)
    modality = re.compile(r"(?:限|仅|只用|采用)\s*(PET-CT|CBCT|CT|MR)\s*(?:成像|定位)")
    modality_tail = re.compile(r"的\s*(PET-CT|CBCT|CT|MR)(?=定位)")
    modality_id = label_map["成像方式"] + "_eq"

    enum_values_with_separator = {
        field: sorted({
            unicodedata.normalize("NFKC", value)
            for value in spec.get("enum", {}).values() if "、" in value
        }, key=len, reverse=True)
        for field, spec in catalog.items()
    }

    def split_clauses(query):
        protected = []
        for hit in label_pattern.finditer(query):
            values = enum_values_with_separator[label_map[hit.group()]]
            if not values:
                continue
            after = query[hit.end():].lstrip().removeprefix("的").lstrip()
            operator = OP_PATTERN.match(after)
            if not operator or OP_BY_WORD[operator[0]] != "eq":
                continue
            remainder = after[operator.end():].lstrip()
            start = len(query) - len(remainder)
            for value in values:
                if not remainder.startswith(value):
                    continue
                end = start + len(value)
                if TAIL.fullmatch(query[end:]) or JOIN.match(query, end):
                    protected.append((start, end))
                    break

        start = 0
        for separator in JOIN.finditer(query):
            if separator.group() == "、" and any(
                left <= separator.start() < right for left, right in protected
            ):
                continue
            yield query[start:separator.start()]
            start = separator.end()
        yield query[start:]

    def compare(query, actual):
        query = unicodedata.normalize("NFKC", query)
        if UNSUPPORTED.search(query):
            return "review_or_exclusion"
        supplied = Counter(actual)
        evidence = Counter()
        saw_condition = False
        for clause in split_clauses(query):
            if not clause.strip():
                continue
            recognized = False
            for hit in label_pattern.finditer(clause):
                field = label_map[hit.group()]
                after = clause[hit.end():].lstrip().removeprefix("的").lstrip()
                comparison = OP_PATTERN.match(after)
                postfix = POSTFIX_PATTERN.match(after)
                if postfix and (postfix[1], postfix[3]) in POSTFIX:
                    op = POSTFIX[(postfix[1], postfix[3])]
                    value = postfix[2]
                    remainder = after[postfix.end():]
                elif comparison:
                    op = OP_BY_WORD[comparison[0]]
                    remainder = after[comparison.end():].lstrip()
                    if catalog[field].get("number"):
                        numeric = re.match(NUMBER, remainder)
                        if not numeric:
                            return "unreadable_value"
                        value, remainder = numeric[0], remainder[numeric.end():]
                    else:
                        tag = field + "_" + op
                        possible = [v for t, v in supplied if t == tag and remainder.startswith(v)
                                    and (TAIL.fullmatch(remainder[len(v):]) or modality_tail.match(remainder[len(v):]))]
                        if len(possible) != 1:
                            return "value_or_operator_mismatch"
                        value = possible[0]
                        remainder = remainder[len(value):]
                else:
                    continue
                evidence[(field + "_" + op, value)] += 1
                recognized = True
                tail_modality = modality_tail.match(remainder)
                if tail_modality:
                    evidence[(modality_id, tail_modality[1])] += 1
                    remainder = remainder[tail_modality.end():]
                if not TAIL.fullmatch(remainder):
                    return "unverified_clause"
                break
            if not recognized:
                implicit = modality.search(clause)
                if implicit and TAIL.fullmatch(clause[implicit.end():]):
                    evidence[(modality_id, implicit[1])] += 1
                    recognized = True
            if not recognized and not TAIL.fullmatch(clause) and (saw_condition or label_pattern.search(clause)):
                return "unverified_clause"
            saw_condition |= recognized
        if not evidence:
            return "no_explicit_filter"
        if evidence != supplied:
            return "condition_mismatch"
        return "accepted"

    return compare


def summary(rows):
    positives = [r for r in rows if r["expected"]]
    result = {"cases": len(rows), "valid_filter_requests": len(positives)}
    for name, gate in [
        ("model", "declared"), ("before", "passes_schema"), ("after", "passes_source"),
    ]:
        result[name] = {
            "false_allow": sum(r[gate] and r["wrong_if_executed"] for r in rows),
            "correct_allow": sum(r[gate] and not r["wrong_if_executed"] for r in rows),
            "correct_prediction_blocked": sum(not r[gate] and not r["wrong_if_executed"] for r in positives),
            "valid_request_not_correctly_executed": sum(not r[gate] or r["wrong_if_executed"] for r in positives),
        }
    result["new_false_block"] = sum(r["passes_schema"] and not r["passes_source"]
                                    and not r["wrong_if_executed"] for r in positives)
    return result


def main(root):
    spec = importlib.util.spec_from_file_location("audit", Path(__file__).with_name("audit-simulation-bert.py"))
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    out = root / "simulation-bert-v5-guard"
    fresh = json.loads((out / "holdout.json").read_text())
    previous = root / "simulation-bert-v5-audit"
    catalog = {f"F{i:02}": spec for i, spec in enumerate(json.loads((root / "simulation-bert-v1/catalog.json").read_text()))}
    predict = audit.load_worker(root / "simulation-bert-v5/checkpoint")
    compare = source_checker(catalog)
    groups = {}
    for index in range(1, 6):
        old = json.loads((root / f"simulation-bert-v{index}/holdout.json").read_text())
        groups[f"round_{index}"] = [
            {"query": item["text"], "intent": item["intent"],
             "expected": [[tag, item["text"][start:end]] for start, end, tag in item["spans"]]}
            for item in old
        ]
    groups["audit_72"] = json.loads((previous / "holdout.json").read_text())
    groups["new_holdout"] = fresh
    for key, cases in groups.items():
        rows = audit.audit(cases, predict, catalog)
        for row in rows:
            actual = [(field["field"], field["text"]) for field in row["prediction"].get("fields", [])]
            reason = compare(row["query"], actual)
            row["source_check"] = reason
            row["passes_source"] = row["passes_schema"] and reason == "accepted"
        groups[key] = rows
    metrics = {key: summary(rows) for key, rows in groups.items()}
    metrics["first_five"] = summary([row for i in range(1, 6) for row in groups[f"round_{i}"]])
    metrics["target_categories"] = {
        key: {category: summary([r for r in groups[key] if r["category"] == category])
              for category in sorted({r["category"] for r in groups[key]})}
        for key in ("audit_72", "new_holdout")
    }
    report = {"summary": metrics, "cases": groups}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(metrics, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
