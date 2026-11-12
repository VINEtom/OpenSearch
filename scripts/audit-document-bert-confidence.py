"""Measure whether model confidence and consistency catch unsafe document filters."""

from argparse import ArgumentParser
from collections import Counter, defaultdict
import hashlib
import importlib.util
from pathlib import Path
import unicodedata

spec = importlib.util.spec_from_file_location("document_bert", Path(__file__).with_name("train-document-bert.py"))
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)

OPERATORS = {
    "eq": "必须正好填", "contains": "文本提及", "lt": "必须小过",
    "lte": "不得超出", "gt": "须多过", "gte": "不能低过",
}
TEMPLATES = (
    "我只想看这批{kind}，其中{field}{op}{value}，其他照旧",
    "给我筛一下{kind}，只按{field}{op}{value}来查",
    "按{field}{op}{value}帮我找一下，范围限定在{kind}",
)


def freeze(labels):
    owners = Counter(field["label"] for field in labels.values())
    rows = []
    for index, (identifier, field) in enumerate(labels.items()):
        label, kind = field["label"], field["kind"]
        if field.get("number"):
            values = ("11.375", "64")
        elif field.get("enum") or field.get("boolean"):
            values = trial.values(field, False)
        elif "部位" in label:
            values = ("右侧颈肩交界", "左侧耳后、颈上区")
        else:
            values = ("先放好加厚软垫再复核", "记录右侧刻度、稍后复查")
        for number, op in enumerate(field["operators"]):
            template = TEMPLATES[(index + number) % len(TEMPLATES)]
            value = values[(index + number) % len(values)]
            rows.append(trial.build_case(template, kind, label, OPERATORS[op], value, f"{identifier}_{op}"))
        if owners[label] > 1:
            rows.append(trial.negative(f"给我筛一下，{label}{OPERATORS['eq']}{values[0]}",
                                       "REVIEW", "缺类型·同名字段"))
        else:
            rows.append(trial.build_case("给我筛一下，{field}{op}{value}", kind, label, OPERATORS["eq"],
                                         values[0], f"{identifier}_eq"))
        rows.append(trial.negative(f"{label}的历史资料", "KEYWORD", "普通关键词"))
    return trial.unique(rows)


def load_scorer(path):
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(path, local_files_only=True).eval()

    def score(text):
        text = unicodedata.normalize("NFKC", text)
        batch = tokenizer(text, return_offsets_mapping=True, truncation=True, max_length=512, return_tensors="pt")
        offsets = batch.pop("offset_mapping")[0].tolist()
        with torch.inference_mode():
            scores, labels = model(**batch).logits[0].softmax(-1).max(-1)
        tags = [model.config.id2label[index] for index in labels.tolist()]
        confidence = scores.tolist()
        spans = []
        for index, ((start, end), tag) in enumerate(zip(offsets, tags)):
            if start == end or "-" not in tag:
                continue
            prefix, field = tag.split("-", 1)
            if prefix == "I" and spans and spans[-1]["field"] == field and not text[spans[-1]["end"]:start].strip():
                spans[-1]["end"] = end
                spans[-1]["confidence"] = min(spans[-1]["confidence"], confidence[index])
            else:
                spans.append(dict(field=field, start=start, end=end, confidence=confidence[index]))
        return dict(intent=tags[0], confidence=confidence[0], spans=spans,
                    fields=[[span["field"], trial.normalize(text[span["start"]:span["end"]])] for span in spans])
    return score


def evaluate(rows, score):
    totals = defaultdict(lambda: defaultdict(Counter))
    details = []
    for row in rows:
        baseline = row["result"]
        accepted = baseline in ("correctAccepted", "wrongAccepted")
        checks = {"现有校验": accepted, "意图≥0.999": accepted and row["confidence"] >= .999}
        if accepted:
            text = row["text"]
            evidence = score(text)
            assert evidence["fields"] == row["predicted"] and evidence["intent"] == row["predictedIntent"]
            token_min = min(span["confidence"] for span in evidence["spans"])
            views = [score("请查询：" + text), score(text + "。")]
            stable = all(view["fields"] == row["predicted"] and view["intent"] == row["predictedIntent"]
                         for view in views)
            checks.update({"取值标签≥0.90": token_min >= .90, "两种改写一致": stable,
                           "一致且取值标签≥0.90": stable and token_min >= .90})
        else:
            token_min = None
            checks.update(dict.fromkeys(("取值标签≥0.90", "两种改写一致", "一致且取值标签≥0.90"), False))
        results = {}
        for name, allowed in checks.items():
            result = baseline if allowed or not accepted else ("falseBlocked" if row["expected"] else "correctBlocked")
            totals[name][row["kind"]][result] += 1
            results[name] = result
        details.append(dict(row, tokenConfidence=token_min, checks=results))
    return {"summary": totals, "cases": details}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("first", type=Path)
    parser.add_argument("second", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    labels = trial.read(args.second / "labels.json")
    rows = freeze(labels)
    seen = set()
    for directory, names in ((args.first, ("holdout", "regression")), (args.second, ("training", "fresh"))):
        for name in names:
            seen.update(trial.normalize(row["text"]) for row in trial.read(directory / f"{name}.json"))
    assert not seen.intersection(trial.normalize(row["text"]) for row in rows)
    frozen = args.output / "holdout.json"
    trial.save(frozen, rows)
    digest = hashlib.sha256(frozen.read_bytes()).hexdigest()
    print(f"Frozen {len(rows)} queries, SHA-256 {digest}", flush=True)
    trial.save(args.output / "manifest.json", dict(holdoutSha256=digest, holdout=len(rows)))
    scorer = load_scorer(args.second / "checkpoint")
    def predict(request):
        result = scorer(request["query"])
        return dict(intent=result["intent"], confidence=result["confidence"],
                    fields=[dict(field=tag, text=value) for tag, value in result["fields"]])
    previous = trial.read(args.second / "evaluation.json")
    assert hashlib.sha256(frozen.read_bytes()).hexdigest() == digest
    previous["new"] = trial.audit(trial.read(frozen), predict, labels, .75)
    report = {}
    for key in ("original", "fresh", "regression", "new"):
        report[key] = evaluate(previous[key]["cases"], scorer)
        print(f"Evaluated {key}: {len(report[key]['cases'])}", flush=True)
    trial.save(args.output / "evaluation.json", report)


if __name__ == "__main__":
    main()
