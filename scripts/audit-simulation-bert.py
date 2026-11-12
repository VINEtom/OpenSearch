"""Audit a simulation BERT checkpoint without sending queries to search."""

from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import sys

def load_worker(path):
    spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("search-model.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker.load_bert(path, patient_mode=True)


def fresh_cases(catalog):
    ids = {spec["label"]: field for field, spec in catalog.items()}
    cases = []
    operators = {"要比{value}少": "lt", "不能比{value}多": "lte",
                 "要比{value}多": "gt", "不能比{value}少": "gte"}
    numbers = ["CT层厚", "CT千伏", "CT毫安", "饮水量", "饮水时间"]
    for index, label in enumerate(numbers):
        for wording, op in operators.items():
            value = ("2.85", "108", "155", "185", "12")[index]
            clause = label + wording.format(value=value)
            expected = [[ids[label] + "_" + op, value]]
            cases.append({"category": "boundary", "query": "请挑出" + clause + "的定位记录", "intent": "FILTER1", "expected": expected})
            cases.append({"category": "boundary", "query": "限CT成像，" + clause + "也得满足",
                          "intent": "FILTER2", "expected": [[ids["成像方式"] + "_eq", "CT"], *expected]})
    for category, intent, queries in [
        ("keyword", "KEYWORD", ["胸部磁共振检查", "平稳呼吸", "头颈部摆位", "上次的CT影像", "定位中心", "固定泡沫垫",
                                "低剂量扫描", "计划系统", "薄层重建", "胸腹部增强", "金属标记", "上腹部俯卧"]),
        ("or", "REVIEW", ["CT或磁共振的定位单都可以", "成像方式为MR或PET-CT", "头部或者颈部的扫描记录",
                          "层厚低于2或超过5均可", "CT千伏为100或120", "请找头部或胸部的定位单",
                          "扫描部位为腹部或治疗部位为盆腔", "要么用CT要么用MR",
                          "是否门控为是或是否增强为增强", "技术为VMAT或者SBRT都行"]),
        ("exclude", "REVIEW", ["请排除成像方式为MR的单子", "剔除扫描部位为头部的定位记录",
                               "不查固定备注提到软垫的单", "列出CT定位但排除使用门控的",
                               "请排除层厚小于3的定位申请", "过滤掉制模设备为模拟甲组的记录",
                               "不要摆位为头先仰卧 HFS的记录", "排除技术为IMRT的病例定位单",
                               "请剔除扫描说明里写着俯卧的单据", "先选CT定位单，再排除扫描部位为颈部的单据"]),
    ]:
        cases.extend({"category": category, "query": query, "intent": intent, "expected": []} for query in queries)
    return cases


def partition(expected, actual):
    missing = list((Counter(expected) - Counter(actual)).elements())
    added = list((Counter(actual) - Counter(expected)).elements())
    replacements = []
    for wanted in list(missing):
        same_field = next((got for got in added if got[0].split("_")[0] == wanted[0].split("_")[0]), None)
        match = same_field or next((got for got in added if got[1] == wanted[1]), None)
        if match:
            missing.remove(wanted)
            added.remove(match)
            replacements.append([wanted, match])
    return {"missing": missing, "added": added, "replacements": replacements}


def passes_schema(actual, catalog):
    for tag, value in actual:
        field, _, op = tag.partition("_")
        spec = catalog.get(field)
        if not spec or not value.strip():
            return False
        permitted = {"eq", "lt", "lte", "gt", "gte"} if spec.get("number") else {"eq", "contains"} if spec.get("text") else {"eq"}
        if op not in permitted:
            return False
        if spec.get("number") and not re.fullmatch(r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)", value):
            return False
        if spec.get("boolean") and value not in {"是", "否"}:
            return False
        if spec.get("enum") and value not in spec["enum"].values():
            return False
    return True


def audit(cases, predict, catalog):
    rows = []
    for case in cases:
        prediction = predict({"query": case["query"]}) or {}
        expected = list(map(tuple, case["expected"]))
        actual = [(f["field"], f["text"]) for f in prediction.get("fields", [])]
        intent = prediction.get("intent", "")
        predicted_count = int(intent[-1]) if intent in {"FILTER1", "FILTER2", "FILTER3"} else 0
        same_conditions = Counter(expected) == Counter(actual)
        declared = predicted_count > 0 and bool(actual)
        passes = declared and predicted_count == len(actual) and prediction.get("confidence", 0) >= 0.75
        difference = partition(expected, actual)
        rows.append({**case, "prediction": prediction, "difference": difference,
                     "exact": same_conditions and intent == case["intent"],
                     "count_wrong": bool(expected) and predicted_count != len(expected),
                     "same_conditions": same_conditions,
                     "wrong_if_executed": not expected or not same_conditions,
                     "declared": declared, "passes_count_confidence": passes,
                     "passes_schema": passes and passes_schema(actual, catalog)})
    return rows


def summarize(rows):
    gates = ("declared", "passes_count_confidence", "passes_schema")
    return {"total": len(rows), "exact": sum(row["exact"] for row in rows),
            **{gate: {"admitted": sum(row[gate] for row in rows),
                      "wrong": sum(row[gate] and row["wrong_if_executed"] for row in rows)} for gate in gates}}


def main(root):
    directories = [root / f"simulation-bert-v{i}" for i in range(1, 6)]
    output = root / "simulation-bert-v5-audit"
    output.mkdir(exist_ok=True)
    catalog = {f"F{i:02}": spec for i, spec in enumerate(json.loads((directories[0] / "catalog.json").read_text()))}
    groups = []
    reserved = set()
    for directory in directories:
        rows = json.loads((directory / "holdout.json").read_text())
        cases = [{"query": row["text"], "intent": row["intent"],
                  "expected": [[tag, row["text"][start:end]] for start, end, tag in row["spans"]]} for row in rows]
        groups.append(cases)
        reserved.update(case["query"] for case in cases)
    training = json.loads((directories[-1] / "training.json").read_text())
    reserved.update(row["text"] for row in training)
    fresh = fresh_cases(catalog)
    assert len({case["query"] for case in fresh}) == len(fresh)
    assert not reserved & {case["query"] for case in fresh}
    frozen = output / "holdout.json"
    if frozen.exists():
        assert json.loads(frozen.read_text()) == fresh
    else:
        frozen.write_text(json.dumps(fresh, ensure_ascii=False, indent=2) + "\n")
    predict = load_worker(directories[-1] / "checkpoint")
    regression = [audit(cases, predict, catalog) for cases in groups]
    counts = [row for row in regression[-1] if row["count_wrong"]]
    assert len(counts) == 40
    fresh_rows = audit(fresh, predict, catalog)
    summary = {
        "regression": [summarize(rows) for rows in regression],
        "count_errors": {
            "total": len(counts),
            "count_only": sum(row["same_conditions"] for row in counts),
            "missing": sum(bool(row["difference"]["missing"]) for row in counts),
            "added": sum(bool(row["difference"]["added"]) for row in counts),
            "replacements": sum(bool(row["difference"]["replacements"]) for row in counts),
            **summarize(counts),
        },
        "fresh": summarize(fresh_rows),
        "fresh_by_category": {category: summarize([r for r in fresh_rows if r["category"] == category])
                              for category in sorted({r["category"] for r in fresh_rows})},
    }
    report = {"summary": summary, "count_error_cases": counts, "regression": regression, "fresh": fresh_rows,
              "catalog_labels": {field: spec["label"] for field, spec in catalog.items()}}
    (output / "audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main(Path(sys.argv[1]))
