"""Train a document query checkpoint with paired value boundaries and audit it offline."""

from argparse import ArgumentParser, Namespace
from collections import Counter, defaultdict
import hashlib
import importlib.util
from pathlib import Path
import random

spec = importlib.util.spec_from_file_location("document_bert", Path(__file__).with_name("train-document-bert.py"))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)

TRAIN_VALUES = (
    ("复核", "延后到下午复核"),
    ("复核", "复核后补记坐标"),
    ("软垫", "改用薄款软垫固定"),
    ("标记", "保留上方标记再核对"),
    ("重扫", "重扫并记录左侧刻度"),
    ("保持静止", "保持静止、等候提示"),
    ("左侧", "靠近左侧边界"),
    ("颈部", "颈部及锁骨上区"),
    ("腹部", "腹部、盆腔一并记录"),
    ("头部", "右侧头部靠近耳后"),
    ("备注", "备注上写有对照线"),
    ("校对", "更换角度以后再校对"),
)
TRAIN_PATTERNS = (
    "{kind}中请查{field}{op}{value}这一项",
    "只看{kind}，筛选{field}{op}{value}",
    "{field}{op}{value}才算符合，范围是{kind}",
    "请从{kind}里挑出{field}{op}{value}的记录",
    "我想筛{kind}，其中{field}{op}{value}，其他照常",
    "按{field}{op}「{value}」查一下{kind}",
)
FRESH_PAIRS = (
    ("核验", "预约结束后再核验"),
    ("细刻度", "细刻度画在右侧上方"),
    ("薄垫", "使用薄垫并记录侧边"),
    ("胸壁", "胸壁、锁骨下缘一同标明"),
    ("对齐", "等灯光稳定后对齐并拍照"),
    ("肘部", "靠近肘部外侧凹陷"),
)
FRESH_PATTERNS = (
    "能帮我从{kind}捞出{field}{op}{value}的那些记录吗",
    "对{kind}我只提一项要求：{field}{op}{value}即可",
    "要查的是{field}{op}{value}，请仅检索{kind}这一类",
)
FRESH_OPS = {
    "eq": "填的是", "contains": "文字里能看到", "lt": "达不到",
    "lte": "不得高于", "gt": "要超出", "gte": "必须达到或超过",
}


def build_sets(labels):
    training, fresh = [], []
    for index, (identifier, field) in enumerate(labels.items()):
        kind, label = field["kind"], field["label"]
        for position, op in enumerate(field["operators"]):
            tag = f"{identifier}_{op}"
            if not any(field.get(key) for key in ("number", "enum", "boolean")):
                phrases = ("取值为", "恰好填", "是", "正好等于", "为", "恰为") if op == "eq" else (
                    "写有", "包含", "出现了", "提到了", "能看到", "记录了"
                )
                for offset, pattern in enumerate(TRAIN_PATTERNS):
                    values = TRAIN_VALUES[(index + offset * 5) % len(TRAIN_VALUES)]
                    for value in values:
                        training.append(trial.build_case(pattern, kind, label, phrases[offset], value, tag))
                for offset, pattern in enumerate(FRESH_PATTERNS):
                    for value in FRESH_PAIRS[(index + offset + position) % len(FRESH_PAIRS)]:
                        fresh.append(trial.build_case(pattern, kind, label, FRESH_OPS[op], value, tag))
            else:
                values = ("6.625", "43") if field.get("number") else trial.values(field, False)
                for offset, pattern in enumerate(FRESH_PATTERNS[:2]):
                    value = values[(index + offset) % len(values)]
                    fresh.append(trial.build_case(pattern, kind, label, FRESH_OPS[op], value, tag))
        fresh.append(trial.negative(f"有没有以前关于{label}的资料", "KEYWORD", "普通关键词"))
    owners = Counter(field["label"] for field in labels.values())
    for label, count in owners.items():
        if count > 1:
            fresh.append(trial.negative(f"能帮我捞出{label}填的是核验的那些记录吗",
                                       "REVIEW", "缺类型·同名字段"))
    return trial.unique(training), trial.unique(fresh)


def make_replay(previous_rows):
    rng = random.Random(311)
    buckets = defaultdict(list)
    for row in previous_rows:
        key = row["expected"][0][0] if row["expected"] else row["intent"]
        buckets[key].append(row)
    replay = []
    for key, rows in buckets.items():
        # Keep broad comparison coverage and replay all routing negatives.
        replay.extend(rng.sample(rows, min(len(rows), 9)) if "_" in key else rows)
    return replay


def metrics(report):
    grouped = defaultdict(Counter)
    for row in report["cases"]:
        counts = grouped[row["kind"]]
        result = row["result"]
        counts["total"] += 1
        counts[result] += 1
        counts["correctIntent"] += row["predictedIntent"] == row["intent"]
        counts["comparable"] += bool(row["expected"]) and len(row["expected"]) == len(row["predicted"]) == 1
        if len(row["expected"]) == len(row["predicted"]) == 1:
            (expected_tag, expected_value), = row["expected"]
            (actual_tag, actual_value), = row["predicted"]
            truncated = bool(actual_value and actual_value != expected_value and actual_value in expected_value)
            op_wrong = expected_tag.split("_", 1)[1] != actual_tag.split("_", 1)[1]
            counts["truncated"] += truncated
            counts["operatorWrong"] += op_wrong
            if result == "wrongAccepted":
                counts["truncatedAllowed"] += truncated
                counts["operatorWrongAllowed"] += op_wrong
    return grouped


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("first", type=Path)
    parser.add_argument("second", type=Path)
    parser.add_argument("confidence", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=4)
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    labels = trial.read(args.second / "labels.json")
    previous = trial.read(args.second / "training.json")
    pairs, fresh = build_sets(labels)
    training = trial.unique(make_replay(previous) + pairs)
    suites = {
        "round1": trial.read(args.first / "holdout.json"),
        "round2": trial.read(args.second / "fresh.json"),
        "confidence": trial.read(args.confidence / "holdout.json"),
        "combination": trial.read(args.first / "regression.json"),
    }
    keys = lambda rows: {trial.normalize(row["text"]) for row in rows}
    existing_tests = keys([row for rows in suites.values() for row in rows])
    assert not keys(training) & existing_tests
    assert not keys(fresh) & (existing_tests | keys(training) | keys(previous))
    assert all(len(row["expected"]) <= 1 for row in training)
    for name, rows in (("training", training), ("boundary-pairs", pairs), ("holdout", fresh), ("labels", labels)):
        trial.save(output / f"{name}.json", rows)
    frozen = output / "holdout.json"
    digest = hashlib.sha256(frozen.read_bytes()).hexdigest()
    trial.save(output / "manifest.json", dict(holdoutSha256=digest, training=len(training),
               boundaryExamples=len(pairs), holdout=len(fresh), epochs=args.epochs, threshold=.75,
               regressionCounts={key: len(rows) for key, rows in suites.items()}))
    print(f"Frozen {len(fresh)} queries ({digest}). Boundary examples: {len(pairs)}.", flush=True)
    trial.load_script("train-simulation-bert").train(Namespace(
        base=args.second / "checkpoint", output=output, catalog_data=labels,
        learning_rate=3e-5, epochs=args.epochs), training)
    assert hashlib.sha256(frozen.read_bytes()).hexdigest() == digest
    suites["new"] = trial.read(frozen)
    old_report = trial.read(args.second / "evaluation.json")
    confidence_report = trial.read(args.confidence / "evaluation.json")
    load_worker = trial.load_script("audit-simulation-bert").load_worker
    baseline = {
        "round1": old_report["original"], "round2": old_report["fresh"],
        "confidence": confidence_report["new"], "combination": old_report["regression"],
        "new": trial.audit(suites["new"], load_worker(str(args.second / "checkpoint")), labels, .75),
    }
    candidate = load_worker(str(output / "checkpoint"))
    report = {}
    for name, rows in suites.items():
        first = baseline[name]
        second = trial.audit(rows, candidate, labels, .75)
        assert [row["text"] for row in first["cases"]] == [row["text"] for row in second["cases"]]
        report[name] = {"round2": dict(first, metrics=metrics(first)),
                        "round3": dict(second, metrics=metrics(second))}
        print(f"Evaluated {name}: {len(rows)}", flush=True)
    trial.save(output / "evaluation.json", report)


if __name__ == "__main__":
    main()
