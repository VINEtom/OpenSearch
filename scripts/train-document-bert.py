"""Train and audit a candidate document query model entirely offline."""

from argparse import ArgumentParser, Namespace
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import unicodedata


def load_script(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def read(path):
    return json.loads(path.read_text())


def operators(field):
    return ["eq"] + (["contains"] if field.get("text") else []) + (
        ["lt", "lte", "gt", "gte"] if field.get("number") else []
    )


TRAIN_PATTERNS = [
    "找{field}{op}{value}的{kind}", "{kind}里{field}{op}{value}",
    "搜索{kind}，{field}{op}{value}", "{field}{op}{value}，只看{kind}",
    "查{kind}中{field}{op}{value}的记录", "{kind}：{field}{op}{value}",
    "{kind}中有哪些记录的{field}{op}{value}", "只显示{field}{op}{value}的{kind}",
    "在{kind}里筛选{field}{op}{value}", "{field}{op}{value}，单据是{kind}",
    "帮我找{kind}，要求{field}{op}{value}", "我只查{kind}的{field}{op}{value}",
]
TRAIN_OPS = {
    "eq": ("是", "为", "等于", "设为"), "contains": ("包含", "含有", "里有", "提到"),
    "lt": ("小于", "少于", "低于", "不到"), "lte": ("不超过", "至多", "小于等于", "最多"),
    "gt": ("大于", "多于", "高于", "超过"), "gte": ("不少于", "至少", "大于等于", "不低于"),
}
TEST_OPS = {
    "eq": ("取值为", "刚好是"), "contains": ("字样写了", "出现了"),
    "lt": ("还要比这个值低：", "要比这个数小："), "lte": ("最多允许到", "上限含"),
    "gt": ("还要比这个值高：", "要比这个数大："), "gte": ("最少得达到", "下限含"),
}


def values(field, test):
    if field.get("number"):
        return ("3.25", "17", "47") if test else ("1", "2.5", "5", "8", "12", "20", "30", "120")
    if field.get("enum"):
        return tuple(dict.fromkeys(str(value) for value in field["enum"].values()))
    if field.get("boolean"):
        return ("是", "否")
    if field["label"] in {"扫描部位", "靶区部位", "治疗部位"}:
        return ("头部", "盆腔") if test else ("胸部", "腹部", "颈部", "胸、腹部")
    return ("复核软垫", "保留标记") if test else ("保持静止", "提前复核", "重新摆位", "模拟甲组", "头部、颈部")


def build_case(pattern, kind, label, phrase, value, tag):
    text = pattern.format(kind=kind, field=label, op=phrase, value=value)
    start = len(pattern.split("{value}")[0].format(kind=kind, field=label, op=phrase))
    return {"text": text, "kind": kind, "intent": "FILTER1", "spans": [[start, start + len(value), tag]],
            "expected": [[tag, value]]}


def negative(text, intent, group):
    return {"text": text, "kind": group, "intent": intent, "spans": [], "expected": []}


def prepare(catalog, baseline):
    owners = defaultdict(list)
    labels = {}
    train, test, regression = [], [], []
    for kind, fields in catalog.items():
        assert len({field["label"] for field in fields}) == len(fields)
        for field in fields:
            label = field["label"]
            identifier = f"F{len(labels):03d}"
            owners[label].append((kind, identifier))
            labels[identifier] = dict(field, kind=kind, operators=operators(field))
            for op in operators(field):
                tag = f"{identifier}_{op}"
                train_values = values(field, False)
                for index in range(max(len(TRAIN_PATTERNS), len(train_values))):
                    train.append(build_case(TRAIN_PATTERNS[index % len(TRAIN_PATTERNS)], kind, label,
                                            TRAIN_OPS[op][index % 4], train_values[index % len(train_values)], tag))
                test_values = values(field, True)
                for index, template in enumerate((
                    "从{kind}挑一批出来，我关心的是{field}{op}{value}这一项",
                    "单据限定为{kind}；想看的记录得满足{field}{op}{value}",
                )):
                    test.append(build_case(template, kind, label, TEST_OPS[op][index],
                                           test_values[index % len(test_values)], tag))
                if field.get("enum"):
                    for value in test_values:
                        if "、" in value:
                            test.append(build_case("麻烦在{kind}中按{field}{op}{value}查一下", kind, label,
                                                   TEST_OPS[op][0], value, tag))
    for label, entries in owners.items():
        for kind, identifier in entries:
            field = labels[identifier]
            for op in field["operators"]:
                for template, phrase in (("{field}{op}{value}", TRAIN_OPS[op][0]),
                                         ("帮我筛{field}{op}{value}", TRAIN_OPS[op][1])):
                    value = values(field, False)[0]
                    if len(entries) > 1:
                        row = build_case(template, kind, label, phrase, value, f"{identifier}_{op}")
                        train.append(negative(row["text"], "REVIEW", "缺类型·同名字段"))
                    else:
                        train.append(build_case(template, kind, label, phrase, value, f"{identifier}_{op}"))
                if len(entries) == 1:
                    test.append(build_case("我只关心{field}{op}{value}这一项", kind, label,
                                           TEST_OPS[op][0], values(field, True)[0], f"{identifier}_{op}"))
            if len(entries) > 1:
                text = f"我只关心{label}取值为{values(field, True)[0]}这一项"
                test.append(negative(text, "REVIEW", "缺类型·同名字段"))
        for text in (label, f"看看{label}", f"{label}相关记录"):
            train.append(negative(text, "KEYWORD", "普通关键词"))
        test.append(negative(f"{label}历史资料", "KEYWORD", "普通关键词"))
    for text in ("屏气", "头部", "鼻咽癌", "俯卧固定", "赵嘉", "CT", "定位申请单"):
        test.append(negative(text, "KEYWORD", "普通关键词"))
    for text in ("赵嘉", "颜艳", "模拟患者甲", "盆腔", "头颈部", "仰卧", "局部扫描", "普通复查"):
        if text != "赵嘉":
            train.append(negative(text, "KEYWORD", "普通关键词"))
    for case in baseline["regression"]:
        expected = case["expected"]
        if not isinstance(expected, dict) or len(expected["conditions"]) < 2:
            continue
        spans = []
        for condition in expected["conditions"]:
            label = condition["label"]
            identifier = dict(owners[label])[expected["type"]]
            spans.append([f"{identifier}_{condition['operator']}", condition["value"]])
        regression.append({"text": case["query"], "kind": expected["type"],
                           "intent": f"FILTER{len(spans)}", "spans": [], "expected": spans})
    return labels, unique(train), unique(test), regression


def unique(rows):
    result = {}
    for row in rows:
        previous = result.setdefault(row["text"], row)
        assert previous == row, (previous, row)
    return list(result.values())


def normalize(value):
    return unicodedata.normalize("NFKC", value).strip()


def valid(tag, value, labels):
    field_id, _, op = tag.partition("_")
    field = labels.get(field_id)
    return bool(field and value and op in field["operators"]
                and (not field.get("number") or re.fullmatch(r"[+-]?(?:\d+(?:\.\d+)?|\.\d+)", value))
                and (not field.get("enum") or value in map(lambda v: normalize(str(v)), field["enum"].values()))
                and (not field.get("boolean") or value in ("是", "否")))


def audit(rows, model, labels, minimum_confidence):
    totals = defaultdict(Counter)
    cases = []
    for row in rows:
        prediction = model({"query": row["text"]}) or {"fields": [], "intent": "UNKNOWN", "confidence": 0}
        fields = [[field["field"], normalize(field["text"])] for field in prediction["fields"]]
        expected = [[tag, normalize(value)] for tag, value in row["expected"]]
        intent = prediction["intent"]
        raw = re.fullmatch(r"FILTER[123]", intent) is not None
        valid_fields = all(valid(tag, value, labels) for tag, value in fields)
        types = {labels[tag.split("_")[0]]["kind"] for tag, _ in fields} if valid_fields else set()
        accepted = raw and len(fields) == int(intent[-1]) and valid_fields and len(types) == 1
        accepted = accepted and prediction["confidence"] >= minimum_confidence
        correct = intent == row["intent"] and Counter(map(tuple, fields)) == Counter(map(tuple, expected))
        result = ("correctAccepted" if correct else "wrongAccepted") if accepted else (
            "falseBlocked" if expected else "correctBlocked"
        )
        count = totals[row["kind"]]
        count[result] += 1
        count["total"] += 1
        count["correctIntent"] += intent == row["intent"]
        count["rawWrongFilterIntent"] += raw and not correct
        count["wrongTypeAccepted"] += bool(accepted and expected and row["kind"] not in types)
        cases.append(dict(row, predicted=fields, predictedIntent=intent,
                          confidence=prediction["confidence"], result=result))
    return {"summary": totals, "cases": cases}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=5)
    args = parser.parse_args()
    path = args.output
    labels, train, test, regression = prepare(read(path / "catalog.json"), read(args.baseline))
    training_queries = {normalize(row["text"]) for row in train}
    assert not training_queries & {normalize(row["text"]) for row in test + regression}
    assert len(regression) == 3
    for name, data in (("labels", labels), ("training", train), ("holdout", test), ("regression", regression)):
        save(path / (name + ".json"), data)
    digest = hashlib.sha256((path / "holdout.json").read_bytes()).hexdigest()
    save(path / "manifest.json", {"holdoutSha256": digest, "training": len(train), "holdout": len(test),
                                  "regression": len(regression), "epochs": args.epochs, "threshold": 0.75})
    print(f"Frozen {len(test)} independent queries and {len(regression)} regression queries: {digest}", flush=True)
    load_script("train-simulation-bert").train(
        Namespace(base=args.base, output=path, catalog_data=labels, learning_rate=5e-5, epochs=args.epochs),
        train,
    )
    assert hashlib.sha256((path / "holdout.json").read_bytes()).hexdigest() == digest
    model = load_script("audit-simulation-bert").load_worker(str(path / "checkpoint"))
    report = {name: audit(read(path / (name + ".json")), model, labels, 0.75)
              for name in ("holdout", "regression")}
    save(path / "evaluation.json", report)
    print(json.dumps({key: section["summary"] for key, section in report.items()}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
