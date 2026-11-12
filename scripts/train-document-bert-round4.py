"""Train value endings and evaluate catalog checks in the offline document pilot."""

from argparse import ArgumentParser, Namespace
from collections import Counter, defaultdict
from pathlib import Path
import hashlib
import importlib.util
import re

spec = importlib.util.spec_from_file_location("round3", Path(__file__).with_name("train-document-bert-round3.py"))
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
trial = prior.trial

ENDINGS = ("即可", "就行", "便可", "也可以", "就够了", "算符合")
PATTERNS = (
    "{kind}只要{field}{op}{value}{ending}",
    "请从{kind}里找，{field}{op}{value}{ending}，麻烦列出来",
    "{field}{op}{value}{ending}，单据选{kind}",
    "我要的{kind}里，{field}{op}{value}{ending}",
    "在{kind}里按{field}{op}{value}{ending}",
    "请帮忙筛{kind}，{field}{op}{value}{ending}。",
)
FRESH = (
    "能否在{kind}中只留{field}{op}{value}{ending}？",
    "{field}{op}{value}{ending}。请限定到{kind}。",
    "劳烦把{kind}里{field}{op}{value}{ending}的列给我",
)
NEW_ENDINGS = ("便行", "就满足要求", "就能纳入")
NEW_VALUES = ("校验纸", "取出校验纸后核对编号", "浅色条", "用浅色条注明转角",
              "对照点", "重新记录对照点的位置")


def paired_sets(labels):
    training, fresh = [], []
    owners = Counter(field["label"] for field in labels.values())
    for index, (identifier, field) in enumerate(labels.items()):
        kind, label = field["kind"], field["label"]
        for position, op in enumerate(field["operators"]):
            tag = f"{identifier}_{op}"
            free = not any(field.get(key) for key in ("number", "enum", "boolean"))
            if free:
                for offset, pattern in enumerate(PATTERNS):
                    short, long = prior.TRAIN_VALUES[(index + offset * 5) % len(prior.TRAIN_VALUES)]
                    ending = ENDINGS[offset]
                    phrase = ("填的是", "恰为", "是", "记为", "写作", "取值为")[offset] if op == "eq" else (
                        "文字里能看到", "包含", "提到", "写有", "记有", "出现了"
                    )[offset]
                    outside = pattern.replace("{ending}", ending)
                    quoted = pattern.replace("{value}{ending}", "「{value}」")
                    for template, value in ((outside, short), (outside, long), (quoted, short + ending)):
                        training.append(trial.build_case(template, kind, label, phrase, value, tag))
                for offset, pattern in enumerate(FRESH):
                    start = 2 * ((index + offset + position) % 3)
                    short, long = NEW_VALUES[start:start + 2]
                    ending = NEW_ENDINGS[offset]
                    phrase = "所填内容为" if op == "eq" else "内容出现这段字"
                    for template, value in (
                        (pattern.replace("{ending}", ending), short),
                        (pattern.replace("{ending}", ending), long),
                        (pattern.replace("{value}{ending}", "『{value}』"), short + ending),
                    ):
                        fresh.append(trial.build_case(template, kind, label, phrase, value, tag))
            else:
                phrase = {"eq": "准确填的是", "lt": "必须低过", "lte": "至多允许",
                          "gt": "应当超过", "gte": "至少要有"}[op]
                values = ("7.875", "52") if field.get("number") else trial.values(field, False)
                for offset, pattern in enumerate(FRESH[:2]):
                    fresh.append(trial.build_case(pattern.replace("{ending}", NEW_ENDINGS[offset]),
                                                 kind, label, phrase, values[offset % len(values)], tag))
        if owners[label] > 1:
            fresh.append(trial.negative(f"劳烦筛一下，{label}所填内容为校验纸便行", "REVIEW", "缺类型·同名字段"))
        fresh.append(trial.negative(f"翻一下旧的{label}资料", "KEYWORD", "普通关键词"))
    return trial.unique(training), trial.unique(fresh)


def catalog_guard(report, labels):
    owners = defaultdict(set)
    for field in labels.values():
        owners[field["label"]].add(field["kind"])
    kinds = set().union(*owners.values())
    aliases = {"定位部位": "扫描部位"}
    names = sorted(set(owners) | aliases.keys(), key=lambda label: (-len(label), label))
    catalog_labels = re.compile("|".join(re.escape(trial.normalize(label)) for label in names))
    # The experimental endpoint accepts a single filter. A second field or
    # an explicit conjunction outside the extracted value requires review.
    conjunction = re.compile(r"并且|同时满足|而且|且|或者|或是|(?<!达)或(?!超过)")
    checked = []
    for original in report["cases"]:
        row = dict(original)
        if row["result"] not in ("correctAccepted", "wrongAccepted"):
            checked.append(row)
            continue
        text = trial.normalize(row["text"])
        spans = row["predicted"]
        reason = None
        if len(spans) != 1:
            reason = "multipleConditions"
        else:
            tag, value = spans[0]
            selected = labels[tag.split("_", 1)[0]]
            # Remove only the occurrence after the field when identifiable.
            anchor = text.find(trial.normalize(selected["label"]))
            anchor = anchor + len(trial.normalize(selected["label"])) if anchor >= 0 else 0
            value_start = text.find(value, anchor)
            outside = text[:value_start] + " " + text[value_start + len(value):] if value_start >= 0 else text
            explicit = {kind for kind in kinds if trial.normalize(kind) in outside}
            mentioned = {aliases.get(label, label) for label in catalog_labels.findall(outside)}
            if explicit and explicit != {selected["kind"]}:
                reason = "typeConflict"
            elif not explicit and (len(owners[selected["label"]]) > 1 or any(len(owners[name]) > 1 for name in mentioned)):
                reason = "ambiguousType"
            elif len(mentioned) > 1 or conjunction.search(outside):
                reason = "possibleMultipleConditions"
        if reason:
            row["guardReason"] = reason
            row["result"] = "falseBlocked" if row["expected"] else "correctBlocked"
        checked.append(row)
    return {"cases": checked}


def metrics(report):
    grouped = prior.metrics(report)
    for row in report["cases"]:
        if len(row["expected"]) != 1 or len(row["predicted"]) != 1:
            continue
        (tag, expected), = row["expected"]
        (_, actual), = row["predicted"]
        overlong = expected != actual and expected in actual
        counts = grouped[row["kind"]]
        counts["overlong"] += overlong
        counts["overlongAllowed"] += overlong and row["result"] == "wrongAccepted"
        if tag.split("_", 1)[1] in {"lt", "lte", "gt", "gte"}:
            counts["numericOperatorWrongAllowed"] += (row["result"] == "wrongAccepted"
                and tag.split("_", 1)[1] != row["predicted"][0][0].split("_", 1)[1])
    return grouped


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=4)
    args = parser.parse_args()
    previous, output = args.previous, args.output
    output.mkdir(parents=True, exist_ok=True)
    labels = trial.read(previous / "labels.json")
    previous_results = trial.read(previous / "evaluation.json")
    suites = {name: [{key: row[key] for key in ("text", "kind", "intent", "spans", "expected")}
                     for row in section["round3"]["cases"]] for name, section in previous_results.items()}
    ending, fresh = paired_sets(labels)
    prior_training = trial.read(previous / "training.json")
    training = trial.unique(prior.make_replay(prior_training) + ending)
    keys = lambda rows: {trial.normalize(row["text"]) for row in rows}
    prior_tests = set().union(*(keys(rows) for rows in suites.values()))
    assert not keys(training) & prior_tests
    assert not keys(fresh) & (prior_tests | keys(training) | keys(prior_training))
    for name, content in (("training", training), ("ending-examples", ending), ("holdout", fresh), ("labels", labels)):
        trial.save(output / f"{name}.json", content)
    holdout = output / "holdout.json"
    digest = hashlib.sha256(holdout.read_bytes()).hexdigest()
    trial.save(output / "manifest.json", dict(holdoutSha256=digest, training=len(training), endingExamples=len(ending),
               holdout=len(fresh), epochs=args.epochs, threshold=.75))
    print(f"Frozen {len(fresh)} queries ({digest}); {len(ending)} value-ending examples.", flush=True)
    trial.load_script("train-simulation-bert").train(Namespace(base=previous / "checkpoint",
        output=output, catalog_data=labels, learning_rate=2e-5, epochs=args.epochs), training)
    assert hashlib.sha256(holdout.read_bytes()).hexdigest() == digest
    load_worker = trial.load_script("audit-simulation-bert").load_worker
    baseline = load_worker(str(previous / "checkpoint"))
    candidate = load_worker(str(output / "checkpoint"))
    suites["independent"] = trial.read(holdout)
    report = {}
    for name, rows in suites.items():
        old = (previous_results[name]["round3"] if name in previous_results else trial.audit(rows, baseline, labels, .75))
        raw = trial.audit(rows, candidate, labels, .75)
        guarded = catalog_guard(raw, labels)
        report[name] = {version: dict(data, metrics=metrics(data)) for version, data in
                        (("round3", old), ("round4", raw), ("round4Guarded", guarded))}
        print(f"Evaluated {name}: {len(rows)}", flush=True)
    trial.save(output / "evaluation.json", report)
    for name, section in report.items():
        for row in section["round4Guarded"]["cases"]:
            if name == "combination" or row["kind"] == "缺类型·同名字段":
                assert row["result"] != "wrongAccepted", (name, row)


if __name__ == "__main__":
    main()
