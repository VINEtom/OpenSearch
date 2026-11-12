"""Replay and contrast single-condition document queries for the second offline trial."""

from argparse import ArgumentParser, Namespace
from collections import Counter
import hashlib
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("document_bert", Path(__file__).with_name("train-document-bert.py"))
load = importlib.util.module_from_spec(spec)
spec.loader.exec_module(load)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def error_analysis(rows, labels):
    counts = Counter()
    examples = []
    for row in rows:
        if row["result"] != "wrongAccepted":
            continue
        if not row["expected"] or len(row["predicted"]) != len(row["expected"]):
            issue = "unexpectedFilter" if not row["expected"] else "wrongConditionCount"
            counts[issue] += 1
            examples.append(dict(row, issues=[issue]))
            continue
        (expected_tag, expected_value), = row["expected"]
        (actual_tag, actual_value), = row["predicted"]
        expected_id, expected_op = expected_tag.split("_")
        actual_id, actual_op = actual_tag.split("_")
        wanted, found = labels[expected_id], labels[actual_id]
        issues = []
        if expected_value != actual_value:
            issues.append("truncated" if actual_value in expected_value else
                          "overextended" if expected_value in actual_value else "otherValue")
        if expected_op != actual_op:
            issues.append("operator")
            counts[f"{expected_op}->{actual_op}"] += 1
        if wanted["kind"] != found["kind"]:
            issues.append("sameNameCrossType" if wanted["label"] == found["label"] else "otherCrossType")
        if wanted["label"] != found["label"]:
            issues.append("field")
        counts.update(issues)
        examples.append(dict(row, issues=issues))
    return {"total": len(examples), "counts": counts, "cases": examples}


PAIR_TEMPLATES = (
    "从{kind}里挑记录，我需要{field}{op}{value}这一栏",
    "单据限定为{kind}；请筛满足{field}{op}{value}的记录",
    "{kind}按这一项查：{field}{op}{value}",
    "把{field}{op}{value}的记录找出来，只看{kind}",
    "想看的{kind}需要{field}{op}{value}，就按这一项查",
    "{kind}中我关心的是{field}{op}「{value}」",
    "只看{kind}，其中{field}{op}{value}",
    "{field}{op}{value}这一项符合就行，单据类型为{kind}",
)
PAIR_OPS = {
    "eq": ("恰好为", "刚好是", "取值为", "等于"),
    "contains": ("字样写了", "出现了", "内容带有", "包含"),
    "lt": ("比这个值低：", "要比这个数小：", "不含上限", "严格少于"),
    "lte": ("最多允许到", "上限含", "不高于", "不比这个数大："),
    "gt": ("比这个值高：", "要比这个数大：", "不含下限", "严格多于"),
    "gte": ("最少得达到", "下限含", "不小于", "不比这个数小："),
}
FRESH_OPS = {
    "eq": ("恰为", "正好取"), "contains": ("能找到这段字：", "写有"),
    "lt": ("得低过", "必须不足"), "lte": ("最高可到", "允许等于上界"),
    "gt": ("得高过", "必须超出"), "gte": ("最低可为", "允许等于下界"),
}
FRESH_TEMPLATES = (
    "帮我挑一批{kind}出来吧，条件就一个：{field}{op}{value}。",
    "{field}{op}{value}才算符合，请从{kind}里挑。",
)


def get_values(field, fresh):
    if field.get("number"):
        return ("9.75", "38") if fresh else ("4.125", "26", "31.5", "92")
    if field.get("enum") or field.get("boolean"):
        return load.values(field, False)
    if field["label"] in {"扫描部位", "靶区部位", "治疗部位"}:
        return ("上腹部", "左侧头颈部") if fresh else ("左侧胸部", "左侧胸", "头颈、锁骨区", "头颈")
    return ("改用短款软垫", "延后到下午复核") if fresh else (
        "请复核软垫位置", "请复核软垫", "低位、左侧标记", "低位标记"
    )


def build_sets(labels):
    training, fresh = [], []
    owners = Counter(field["label"] for field in labels.values())
    for identifier, field in labels.items():
        kind, label = field["kind"], field["label"]
        values = get_values(field, False)
        fresh_values = get_values(field, True)
        for op in field["operators"]:
            tag = f"{identifier}_{op}"
            for index, template in enumerate(PAIR_TEMPLATES):
                phrase = PAIR_OPS[op][index % 4]
                for value_index in (index % len(values), (index + 1) % len(values)):
                    training.append(load.build_case(template, kind, label, phrase, values[value_index], tag))
            for index, template in enumerate(FRESH_TEMPLATES):
                fresh.append(load.build_case(template, kind, label, FRESH_OPS[op][index],
                                             fresh_values[index % len(fresh_values)], tag))
        value = fresh_values[0]
        if owners[label] > 1:
            fresh.append(load.negative(f"帮我挑一批吧，条件就一个：{label}恰为{value}。", "REVIEW", "缺类型·同名字段"))
            training.append(load.negative(f"请按这一项查：{label}取值为{values[0]}", "REVIEW", "缺类型·同名字段"))
        else:
            for op in field["operators"]:
                fresh.append(load.build_case("我想要满足{field}{op}{value}的记录。", kind, label,
                                             FRESH_OPS[op][0], value, f"{identifier}_{op}"))
        training.append(load.negative(f"历史{label}", "KEYWORD", "普通关键词"))
        fresh.append(load.negative(f"以前的{label}资料", "KEYWORD", "普通关键词"))
    return load.unique(training), load.unique(fresh)


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=5)
    args = parser.parse_args()
    previous, output = args.previous, args.output
    output.mkdir(parents=True, exist_ok=True)
    labels = load.read(previous / "labels.json")
    # The trainer uses mapping order to assign token classification IDs.
    load.save(output / "labels.json", labels)
    first_report = load.read(previous / "evaluation.json")
    load.save(output / "round1-errors.json", error_analysis(first_report["holdout"]["cases"], labels))
    paired, fresh = build_sets(labels)
    original = load.read(previous / "holdout.json")
    regression = load.read(previous / "regression.json")
    training = load.unique(load.read(previous / "training.json") + paired)
    sets = [{load.normalize(row["text"]) for row in rows} for rows in (training, original, regression, fresh)]
    assert not sets[0].intersection(sets[1] | sets[2] | sets[3])
    assert not sets[3].intersection(sets[1] | sets[2])
    for name, rows in (("training", training), ("paired", paired), ("fresh", fresh)):
        load.save(output / f"{name}.json", rows)
    frozen = output / "fresh.json"
    sha = digest(frozen)
    load.save(output / "manifest.json", dict(training=len(training), paired=len(paired), fresh=len(fresh),
              freshSha256=sha, previousHoldoutSha256=digest(previous / "holdout.json"), epochs=args.epochs,
              threshold=0.75))
    print(f"Frozen {len(fresh)} independent queries: {sha}. Paired examples: {len(paired)}.", flush=True)
    load.load_script("train-simulation-bert").train(Namespace(
        base=previous / "checkpoint", output=output, catalog_data=labels,
        learning_rate=4e-5, epochs=args.epochs), training)
    assert digest(frozen) == sha
    evaluate(previous, output, labels, original, regression, load.read(frozen))


def evaluate(previous, output, labels, original, regression, fresh):
    load_worker = load.load_script("audit-simulation-bert").load_worker
    model = load_worker(str(output / "checkpoint"))
    old_model = load_worker(str(previous / "checkpoint"))
    report = {name: load.audit(rows, model, labels, .75) for name, rows in
              (("original", original), ("regression", regression), ("fresh", fresh))}
    report["round1OnFresh"] = load.audit(fresh, old_model, labels, .75)
    load.save(output / "evaluation.json", report)
    write_error_report(output, report, labels)


def write_error_report(output, report, labels):
    load.save(output / "round2-errors.json", {
        key: error_analysis(report[key]["cases"], labels) for key in ("original", "fresh", "round1OnFresh")
    })


if __name__ == "__main__":
    main()
