"""Fine-tune the fourth checkpoint on unquoted short and long value pairs offline."""

from argparse import ArgumentParser, Namespace
from collections import Counter, defaultdict
import hashlib
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("round4", Path(__file__).with_name("train-document-bert-round4.py"))
round4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(round4)
trial = round4.trial

QUOTES = frozenset('「」『』“”‘’"\'《》')
TRAIN_PATTERNS = (
    "请帮我查{kind}，条件是{field}{op}{value}",
    "仅筛{kind}，{field}{op}{value}",
    "我想看看{kind}里{field}{op}{value}",
    "筛出{kind}。只要求{field}{op}{value}",
    "麻烦列一下{field}{op}{value}的{kind}",
    "{field}{op}{value}，单据范围限定在{kind}",
)
TRAIN_VALUES = round4.prior.TRAIN_VALUES + (
    ("加垫", "先加垫再把位置记在草图上"),
    ("角度", "把记录里的角度重算一遍"),
    ("回查", "在归档前回查对应编号"),
    ("核对", "换班交接完成后重新核对"),
)
FRESH_PATTERNS = (
    "能从{kind}挑几张给我吗，我要{field}{op}{value}",
    "希望能找到{field}{op}{value}的单子，麻烦只查{kind}",
)
FRESH_VALUES = (
    ("防滑片", "换上加宽防滑片后核对朝向"),
    ("圆点", "圆点需要沿边缘向内移动"),
    ("横档", "换了横档以后重新标出左右位置"),
    ("角标", "确认外侧角标、保留中间刻线"),
    ("纸环", "把纸环换成双层并注明编号"),
    ("红线", "根据上次拍照的位置重画红线"),
)
EXCLUDED_WORDING = ("就行", "即可")
NUMERIC_OPS = {"eq": "应当等于", "lt": "只能低于", "lte": "最大可以取",
               "gt": "得大于", "gte": "最小可以取"}
SET_NAMES = {
    "round1": "第一组", "round2": "第二组", "confidence": "第三组", "new": "第四组",
    "independent": "第五组", "unseen": "第六组", "combination": "组合回归", "round6Holdout": "新独立组",
}
METRIC_COLUMNS = (
    ("truncatedAllowed", "截断错放"), ("overlongAllowed", "过长错放"),
    ("wrongAccepted", "总错放"), ("falseBlocked", "误拦"),
    ("operatorWrongAllowed", "比较符错放"), ("numericOperatorWrongAllowed", "数值比较符错放"),
    ("correctAccepted", "正确放行"),
)


def in_scope(row):
    text = trial.normalize(row["text"])
    return QUOTES.isdisjoint(text) and all(word not in text for word in EXCLUDED_WORDING)


def free_value(field):
    return not any(field.get(key) for key in ("enum", "boolean", "number"))


def build_sets(labels):
    training, holdout = [], []
    owners = Counter(field["label"] for field in labels.values())
    for index, (identifier, field) in enumerate(labels.items()):
        kind, label = field["kind"], field["label"]
        for position, op in enumerate(field["operators"]):
            tag = f"{identifier}_{op}"
            if free_value(field):
                for offset, pattern in enumerate(TRAIN_PATTERNS):
                    phrase = ("恰为", "填的是", "写作", "等于", "所填为", "正好是")[offset] if op == "eq" else (
                        "写有", "包含", "出现了", "内容含有", "记录着", "能找到")[offset]
                    values = TRAIN_VALUES[(index + offset * 5) % len(TRAIN_VALUES)]
                    for value in values:
                        training.append(trial.build_case(pattern, kind, label, phrase, value, tag))
                for offset, pattern in enumerate(FRESH_PATTERNS):
                    phrase = "那一栏填了" if op == "eq" else "里面能读到"
                    values = FRESH_VALUES[(index + offset + position) % len(FRESH_VALUES)]
                    for variant, value in zip(("short", "long"), values):
                        row = trial.build_case(pattern, kind, label, phrase, value, tag)
                        holdout.append(dict(row, pair=f"{tag}:{offset}", variant=variant))
            else:
                values = ("13.625", "73") if field.get("number") else trial.values(field, False)
                for offset, pattern in enumerate(FRESH_PATTERNS):
                    holdout.append(trial.build_case(pattern, kind, label,
                                                   NUMERIC_OPS[op], values[offset % len(values)], tag))
        if owners[label] > 1:
            holdout.append(trial.negative(f"能挑几张给我吗，我要{label}那一栏填了防滑片",
                                          "REVIEW", "缺类型·同名字段"))
        holdout.append(trial.negative(f"翻翻和{label}有关的原始档案", "KEYWORD", "普通关键词"))
    return trial.unique(training), trial.unique(holdout)


def pairs(report, labels):
    groups = defaultdict(list)
    for row in report["cases"]:
        if len(row["spans"]) != 1:
            continue
        start, end, tag = row["spans"][0]
        if not free_value(labels[tag.split("_", 1)[0]]):
            continue
        key = row.get("pair") or (tag, row["text"][:start], row["text"][end:])
        groups[(row["kind"], key)].append(row)
    totals = defaultdict(Counter)
    for (kind, _), rows in groups.items():
        if len(rows) != 2:
            continue
        short, long = sorted((row["expected"][0][1] for row in rows), key=len)
        if short == long or short not in long:
            continue
        totals[kind]["pairs"] += 1
        totals[kind]["bothCorrect"] += all(row["result"] == "correctAccepted" for row in rows)
    return totals


def all_counts(groups):
    total = Counter()
    for group in groups.values():
        total.update(group)
    return total


def write_comparison(path, report):
    lines = ["# 第六轮无引号离线验收", "",
             "各格为第四轮 → 第六轮。两轮使用同一字段目录校验。成对通过要求同一问法的长值和短值均正确放行。统计范围排除引号与含「就行」「即可」的查询。", ""]
    columns = ["单据类型或查询类别", "长短值成对通过"] + [title for _, title in METRIC_COLUMNS]
    for suite, versions in report.items():
        old, new = versions["round4"], versions["round6"]
        lines.extend([f'## {SET_NAMES[suite]}（{len(old["cases"])} 条）', "",
                      "| " + " | ".join(columns) + " |",
                      "| " + " | ".join(["---"] + ["---:"] * (len(columns) - 1)) + " |"])
        for kind in (*old["metrics"], "合计"):
            before, after = (all_counts(version["metrics"]) if kind == "合计" else version["metrics"][kind]
                             for version in (old, new))
            first, second = (all_counts(version["pairs"]) if kind == "合计" else version["pairs"].get(kind, {})
                             for version in (old, new))
            n = first.get("pairs", 0)
            assert n == second.get("pairs", 0)
            fraction = f'{first.get("bothCorrect", 0)}/{n} → {second.get("bothCorrect", 0)}/{n}' if n else "—"
            cells = [fraction] + [f'{before.get(k, 0)} → {after.get(k, 0)}' for k, _ in METRIC_COLUMNS]
            lines.append("| " + " | ".join([kind] + cells) + " |")
        lines.append("")
    path.write_text("\n".join(lines) + "\n")


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("fourth", type=Path)
    parser.add_argument("fifth", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=3)
    args = parser.parse_args()
    fourth, output = args.fourth, args.output
    output.mkdir(parents=True, exist_ok=True)
    labels = trial.read(fourth / "labels.json")
    reports = trial.read(args.fifth / "evaluation.json")
    originals = {name: [row for row in section["round4"]["cases"] if in_scope(row)]
                 for name, section in reports.items()}
    before = {name: len(section["round4"]["cases"]) for name, section in reports.items()}
    assert len(originals["combination"]) == 3 and all(originals.values())
    added, fresh = build_sets(labels)
    previous_training = trial.read(fourth / "training.json")
    replay = round4.prior.make_replay([row for row in previous_training if in_scope(row)])
    training = trial.unique(replay + added)
    normalized = lambda rows: {trial.normalize(row["text"]) for row in rows}
    existing = set().union(*(normalized(section["round4"]["cases"]) for section in reports.values()))
    assert not normalized(training) & existing
    assert not normalized(fresh) & (normalized(training) | existing | normalized(previous_training))
    assert all(in_scope(row) for row in training + fresh)
    assert all(len(row["expected"]) <= 1 for row in training)
    path = output / "holdout.json"
    trial.save(path, fresh)
    trial.save(output / "training.json", training)
    trial.save(output / "labels.json", labels)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    trial.save(output / "manifest.json", dict(holdoutSha256=digest, holdout=len(fresh), training=len(training),
        newExamples=len(added), epochs=args.epochs, threshold=.75,
        regressionCounts={name: dict(original=before[name], inScope=len(rows)) for name, rows in originals.items()}))
    print(f"Frozen {len(fresh)} queries ({digest}); {len(added)} contrast examples.", flush=True)
    trial.load_script("train-simulation-bert").train(Namespace(
        base=fourth / "checkpoint", output=output, catalog_data=labels, learning_rate=2e-5,
        epochs=args.epochs), training)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    load_worker = trial.load_script("audit-simulation-bert").load_worker
    fresh = trial.read(path)
    base = load_worker(str(fourth / "checkpoint"))
    candidate = load_worker(str(output / "checkpoint"))
    originals["round6Holdout"] = round4.catalog_guard(trial.audit(fresh, base, labels, .75), labels)["cases"]
    report = {}
    for name, rows in originals.items():
        queries = [{key: row[key] for key in ("text", "kind", "intent", "spans", "expected",
                                             "pair", "variant") if key in row}
                   for row in rows]
        updated = round4.catalog_guard(trial.audit(queries, candidate, labels, .75), labels)
        report[name] = {version: dict(data, metrics=round4.metrics(data), pairs=pairs(data, labels))
                        for version, data in (("round4", {"cases": rows}), ("round6", updated))}
        print(f"Evaluated {name}: {len(rows)}", flush=True)
    trial.save(output / "evaluation.json", report)
    write_comparison(output / "comparison.md", report)
    for name, section in report.items():
        for row in section["round6"]["cases"]:
            if name == "combination" or row["kind"] == "缺类型·同名字段":
                assert row["result"] != "wrongAccepted", (name, row)


if __name__ == "__main__":
    main()
