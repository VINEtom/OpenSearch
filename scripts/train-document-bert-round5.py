"""Train and evaluate independent value start and end heads in the offline pilot."""

from argparse import ArgumentParser
from collections import Counter, defaultdict
import hashlib
import importlib.util
import unicodedata
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F
from transformers import AutoModelForTokenClassification, AutoTokenizer

spec = importlib.util.spec_from_file_location("round4", Path(__file__).with_name("train-document-bert-round4.py"))
round4 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(round4)
trial = round4.trial

TRAIN_PATTERNS = (
    ("请查{kind}中{field}{op}{value}{ending}", "就行"),
    ("{kind}里{field}{op}{value}{ending}，麻烦帮我列出来", "就够了"),
    ("{field}{op}{value}{ending}，我只要{kind}", "即可"),
    ("能帮我找{field}{op}{value}{ending}的{kind}吗", "便可"),
    ("{kind}中只需要{field}{op}{value}{ending}", "也可以"),
    ("筛一下{kind}，{field}{op}{value}{ending}", "算符合"),
)
HOLDOUT_PATTERNS = (
    ("请帮我在{kind}里翻出{field}{op}{value}{ending}的单子", "就符合我的要求"),
    ("只要{field}{op}{value}{ending}，帮我查一下{kind}吧", "便能入选"),
    ("这次只看{kind}。{field}{op}{value}{ending}，有这样的单吗", "就纳入"),
)
HOLDOUT_VALUES = (
    ("转接块", "装上转接块以后再校准"),
    ("长边线", "用细笔标明长边线并拍照"),
    ("左后角", "左后角靠上方、与中线对齐"),
    ("方形垫", "取下圆垫后换成方形垫"),
    ("对齐线", "对齐线下移半格后记录"),
    ("贴纸", "在托板上重新贴好贴纸"),
)
TRAIN_VALUES = round4.prior.TRAIN_VALUES + (
    ("指示灯", "指示灯亮后记下刻度"),
    ("短线", "把短线画在右缘并确认"),
    ("透明垫", "放入透明垫后压平"),
    ("边框", "对照边框与横向刻度"),
)


def free_value(field):
    return not any(field.get(key) for key in ("enum", "boolean", "number"))


def build_sets(labels):
    train, holdout = [], []
    owners = Counter(field["label"] for field in labels.values())
    for index, (identifier, field) in enumerate(labels.items()):
        kind, label = field["kind"], field["label"]
        for position, op in enumerate(field["operators"]):
            tag = f"{identifier}_{op}"
            if free_value(field):
                for offset, (pattern, ending) in enumerate(TRAIN_PATTERNS):
                    short, long = TRAIN_VALUES[(index + offset * 5) % len(TRAIN_VALUES)]
                    phrase = ("恰为", "填的是", "记作")[offset % 3] if op == "eq" else (
                        "提到", "写着", "内容含有")[offset % 3]
                    for template, value in triplet(pattern, ending, short, long, "「", "」"):
                        train.append(trial.build_case(template, kind, label, phrase, value, tag))
                for offset, (pattern, ending) in enumerate(HOLDOUT_PATTERNS):
                    short, long = HOLDOUT_VALUES[(index + offset + position) % len(HOLDOUT_VALUES)]
                    phrase = "所填的是" if op == "eq" else "文字写到了"
                    for case, (template, value) in enumerate(triplet(pattern, ending, short, long, "『", "』")):
                        row = trial.build_case(template, kind, label, phrase, value, tag)
                        row.update(pair=f"{tag}:{offset}", variant=("short", "long", "quoted")[case])
                        holdout.append(row)
            else:
                phrases = dict(eq="设定值为", lt="严格低于", lte="上界可等于", gt="严格高于", gte="下界可等于")
                values = ("8.375", "57") if field.get("number") else trial.values(field, False)
                for offset, (pattern, ending) in enumerate(HOLDOUT_PATTERNS[:2]):
                    holdout.append(trial.build_case(pattern.replace("{ending}", ending), kind, label,
                                                   phrases[op], values[offset % len(values)], tag))
        if owners[label] > 1:
            holdout.append(trial.negative(f"能查一下{label}所填的是转接块的单吗", "REVIEW", "缺类型·同名字段"))
        holdout.append(trial.negative(f"查查{label}相关的旧档案", "KEYWORD", "普通关键词"))
    return trial.unique(train), trial.unique(holdout)


def triplet(pattern, ending, short, long, left, right):
    plain = pattern.replace("{ending}", ending)
    quoted = pattern.replace("{value}{ending}", left + "{value}" + right)
    return ((plain, short), (plain, long), (quoted, short + ending))


def boundary_head(size):
    return nn.Sequential(nn.LayerNorm(size * 2), nn.Linear(size * 2, 128), nn.GELU(), nn.Linear(128, 2))


def encode(model, inputs):
    hidden = model.base_model(**inputs, output_hidden_states=True).hidden_states
    return torch.cat((hidden[-4], hidden[-1]), dim=-1)


def fit(model, tokenizer, rows, device, epochs):
    tokens = tokenizer([row["text"] for row in rows], padding=True, return_offsets_mapping=True, return_tensors="pt")
    offsets = tokens.pop("offset_mapping")
    mask = offsets[..., 1] > offsets[..., 0]
    labels = []
    for positions, row in zip(offsets.tolist(), rows):
        start, end, _ = row["spans"][0]
        overlap = [i for i, (left, right) in enumerate(positions) if left < end and start < right]
        assert overlap and positions[overlap[0]][0] == start and positions[overlap[-1]][1] == end, row
        labels.append((overlap[0], overlap[-1]))
    targets = torch.tensor(labels, device=device)
    chunks = []
    with torch.no_grad():
        for indices in torch.arange(len(rows)).split(64):
            inputs = {key: value[indices].to(device) for key, value in tokens.items()}
            chunks.append(encode(model, inputs).to(device="cpu", dtype=torch.float16))
    features = torch.cat(chunks)
    del chunks
    head = boundary_head(model.config.hidden_size).to(device)
    optimizer = torch.optim.AdamW(head.parameters(), lr=8e-4)
    for epoch in range(epochs):
        losses = []
        for indices in torch.randperm(len(rows)).split(96):
            valid = mask[indices].to(device)
            logits = head(features[indices].to(device=device, dtype=torch.float32)).masked_fill(~valid[..., None], -1e4)
            loss = F.cross_entropy(logits, targets[indices])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            losses.append(loss.item())
        print(f"boundary epoch {epoch + 1}/{epochs}: {sum(losses) / len(losses):.4f}", flush=True)
    return head.to("cpu").eval()


def refine(base_predict, model, tokenizer, head, labels):
    def predict(request):
        result = base_predict(request)
        if not result or result["intent"] != "FILTER1" or len(result["fields"]) != 1:
            return result
        field = result["fields"][0]
        if not free_value(labels[field["field"].split("_", 1)[0]]):
            return result
        text = trial.normalize(request["query"])
        inputs = tokenizer(text, return_offsets_mapping=True, return_tensors="pt")
        offsets = inputs.pop("offset_mapping")[0]
        valid = offsets[:, 1] > offsets[:, 0]
        with torch.inference_mode():
            start, end = head(encode(model, inputs))[0].T
            scores = start[:, None] + end[None, :]
            order = torch.ones_like(scores, dtype=torch.bool).triu()
            scores = scores.masked_fill(~(order & valid[:, None] & valid[None, :]), -torch.inf)
            first, last = divmod(scores.argmax().item(), len(offsets))
        value = text[offsets[first, 0]:offsets[last, 1]]
        return dict(result, fields=[dict(field, text=value)])

    return predict


def pair_metrics(report):
    groups = defaultdict(dict)
    for row in report["cases"]:
        pair = row.get("pair")
        if not pair and len(row["spans"]) == 1:
            start, end, tag = row["spans"][0]
            if "『" not in row["text"]:
                pair = (tag, row["text"][:start], row["text"][end:])
        if pair:
            groups[(row["kind"], pair)][row.get("variant", row["text"])] = row["result"] == "correctAccepted"
    totals = defaultdict(Counter)
    for (kind, _), results in groups.items():
        if "short" in results and "long" in results:
            totals[kind]["pairs"] += 1
            totals[kind]["bothCorrect"] += results["short"] and results["long"]
            totals[kind]["allThreeCorrect"] += all(results.values()) and len(results) == 3
        elif len(results) == 2:
            totals[kind]["pairs"] += 1
            totals[kind]["bothCorrect"] += all(results.values())
    return totals


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("previous", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--epochs", type=int, default=12)
    args = parser.parse_args()
    previous, output = args.previous, args.output
    output.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(513)
    torch.set_num_threads(4)
    labels = trial.read(previous / "labels.json")
    previous_results = trial.read(previous / "evaluation.json")
    suites = {name: [{key: row[key] for key in ("text", "kind", "intent", "spans", "expected")}
                     for row in section["round4Guarded"]["cases"]] for name, section in previous_results.items()}
    additional, holdout = build_sets(labels)
    replay = [row for row in trial.read(previous / "training.json") if len(row["spans"]) == 1
              and free_value(labels[row["spans"][0][2].split("_", 1)[0]])]
    # Preserve tokenizer-aligned offsets after normalizing the training text.
    training = []
    for row in trial.unique(replay + additional):
        start, end, tag = row["spans"][0]
        text = row["text"]
        training.append(dict(row, text=trial.normalize(text), spans=[[
            len(unicodedata.normalize("NFKC", text[:start])), len(unicodedata.normalize("NFKC", text[:end])), tag]]))
    keys = lambda rows: {trial.normalize(row["text"]) for row in rows}
    prior_tests = set().union(*(keys(rows) for rows in suites.values()))
    assert not keys(training) & prior_tests
    assert not keys(holdout) & (prior_tests | keys(training) | keys(trial.read(previous / "training.json")))
    path = output / "holdout.json"
    trial.save(path, holdout)
    trial.save(output / "training.json", training)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    trial.save(output / "manifest.json", dict(holdoutSha256=digest, holdout=len(holdout),
        training=len(training), newExamples=len(additional), epochs=args.epochs, baseline=str(previous)))
    print(f"Frozen {len(holdout)} queries ({digest}); training {len(training)} value spans.", flush=True)

    checkpoint = previous / "checkpoint"
    tokenizer = AutoTokenizer.from_pretrained(checkpoint, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(checkpoint, local_files_only=True).eval()
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    head = fit(model.to(device), tokenizer, training, device, args.epochs)
    torch.save(head.state_dict(), output / "boundary-head.pt")
    model.to("cpu")
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    suites["unseen"] = trial.read(path)
    base = trial.load_script("audit-simulation-bert").load_worker(str(checkpoint))
    candidate = refine(base, model, tokenizer, head, labels)
    report = {}
    for name, rows in suites.items():
        old = (previous_results[name]["round4Guarded"] if name in previous_results
               else round4.catalog_guard(trial.audit(rows, base, labels, .75), labels))
        updated = round4.catalog_guard(trial.audit(rows, candidate, labels, .75), labels)
        report[name] = {version: dict(data, metrics=round4.metrics(data), pairs=pair_metrics(data))
                        for version, data in (("round4", old), ("round5", updated))}
        print(f"Evaluated {name}: {len(rows)}", flush=True)
    trial.save(output / "evaluation.json", report)
    for name, section in report.items():
        for row in section["round5"]["cases"]:
            if name == "combination" or row["kind"] == "缺类型·同名字段":
                assert row["result"] != "wrongAccepted", (name, row)


if __name__ == "__main__":
    main()
