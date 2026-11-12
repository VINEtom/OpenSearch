"""Train and independently evaluate a local BERT model for simulation conditions."""

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import random
import unicodedata

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer


OPERATORS = {
    "lt": ("小于", "低于", "<"),
    "lte": ("至多", "不超过", "<="),
    "gt": ("大于", "高于", ">"),
    "gte": ("至少", "不少于", ">="),
    "eq": ("为", "是", "等于"),
    "contains": ("包含", "提到", "写了"),
}
HOLDOUT_OPERATOR = {
    "lt": "不到", "lte": "不高于", "gt": "超过",
    "gte": "不低于", "eq": "取值是", "contains": "出现过",
}
ALIASES = {
    "CT层厚": "层厚", "CT千伏": "管电压", "CT毫安": "管电流",
    "扫描部位": "扫描区域", "治疗部位": "治疗区域",
    "成像方式": "影像类型", "固定说明": "固定方法", "扫描说明": "扫描要求",
}


def read_catalog(path):
    specs = json.loads(path.read_text())
    assert len(specs) == len({item["label"] for item in specs}) == 60
    return {
        f"F{index:02}": {
            **spec, "operators": (("eq", "lt", "lte", "gt", "gte") if spec.get("number")
                                  else ("eq", "contains") if spec.get("text") else ("eq",)),
        }
        for index, spec in enumerate(specs)
    }


def values(spec, holdout=False):
    label = spec["label"]
    if spec.get("number"):
        if label == "CT层厚":
            return ["3", "2.7"] if holdout else ["1", "2", "2.5", "4", "5", "10"]
        return ["3.7", "72"] if holdout else ["1", "2", "5", "15", "80", "120"]
    if spec.get("boolean"):
        return ["是", "否"]
    if spec.get("enum"):
        return list(dict.fromkeys(spec["enum"].values()))
    if label == "成像方式":
        return ["CT", "MR"] if holdout else ["CT", "MR", "PET-CT", "CBCT"]
    if spec.get("text"):
        return ["保持平稳呼吸", "托架上加软垫"] if holdout else ["平静呼吸", "屏气", "俯卧摆位", "加软垫"]
    if "部位" in label or "器官" in label or label.startswith("扫描上") or label.startswith("扫描下"):
        return ["膝部", "锁骨"] if holdout else ["头部", "颈部", "胸部", "腹部"]
    if spec.get("lookup") == "doctor":
        return ["周示例", "沈示例"] if holdout else ["陈示例", "林示例", "许示例"]
    if label.endswith("时间"):
        return ["2032-05-19", "2033-06-07"] if holdout else ["2029-01-02", "2030-03-04", "2031-04-05"]
    if label == "技术":
        return ["SBRT", "VMAT"] if holdout else ["IMRT", "VMAT", "3DCRT", "SRS"]
    return ["演示甲组", "模拟青组"] if holdout else ["虚构A组", "模拟B室", "测试C型"]


def render(parts, prefix, joiner, suffix, held=False, style=0):
    text = prefix
    spans = []
    for index, (field, name, op, value) in enumerate(parts):
        if index:
            text += joiner
        name = unicodedata.normalize("NFKC", name)
        value = unicodedata.normalize("NFKC", value)
        verb = HOLDOUT_OPERATOR[op] if held else OPERATORS[op][style % len(OPERATORS[op])]
        text += name + ("的" if held and style == 1 else "") + verb
        start = len(text)
        text += value
        spans.append([start, len(text), f"{field}_{op}"])
    return {"text": text + suffix, "spans": spans, "intent": f"FILTER{len(spans)}"}


def training_rows(catalog):
    rng = random.Random(23)
    singles = []
    for field, spec in catalog.items():
        names = [spec["label"]]
        if spec["label"] in ALIASES:
            names.append(ALIASES[spec["label"]])
        singles.extend((field, name, op, value) for name in names for op in spec["operators"] for value in values(spec))
    for n, part in enumerate(singles):
        for style in range(3):
            yield render([part], ("", "筛选", "帮我找")[style], "", ("", "的定位单", "的定位申请单")[style], style=style + n)
    for n in range(1000):
        count = 3 if n % 4 == 0 else 2
        parts = rng.sample(singles, count)
        if len({part[0] for part in parts}) == count:
            yield render(parts, ("", "帮我找")[n % 2], ("且", "，同时", "并且")[n % 3], ("的单子", "的定位申请单")[n % 2], style=n)
    for field, name, _, value in singles[::3]:
        yield {"text": f"排除{name}为{value}的定位单", "spans": [], "intent": "REVIEW"}
        yield {"text": f"{name}为{value}或者其他定位单", "spans": [], "intent": "REVIEW"}
    for word in ("头部", "屏气", "定位申请单", "CT", "MR", "病程", "成像方式", "扫描部位", "层厚", "固定说明", "VMAT"):
        yield {"text": word, "spans": [], "intent": "KEYWORD"}
        yield {"text": f"搜索{word}", "spans": [], "intent": "KEYWORD"}


def holdout_rows(catalog):
    entries = list(catalog.items())
    for index, (field, spec) in enumerate(entries):
        name = ALIASES.get(spec["label"], spec["label"]) if index % 2 else spec["label"]
        for op in spec["operators"]:
            part = (field, name, op, values(spec, True)[index % len(values(spec, True))])
            yield render([part], "能否列出", "", "的定位记录？", held=True)
        other, other_spec = entries[(index + 17) % len(entries)]
        op = spec["operators"][index % len(spec["operators"])]
        other_op = other_spec["operators"][-1]
        yield render([(field, name, op, values(spec, True)[0]),
                      (other, other_spec["label"], other_op, values(other_spec, True)[-1])],
                     "给我看看", "、还要求", "的定位单据", held=True, style=1)
    yield {"text": "找层厚不到3的CT定位单", "intent": "FILTER2", "spans": [
        [5, 6, next(k for k, s in entries if s["label"] == "CT层厚") + "_lt"],
        [7, 9, next(k for k, s in entries if s["label"] == "成像方式") + "_eq"],
    ]}
    for text in ("除了采用VMAT的定位记录", "CT或者MR的定位单都行", "不要扫描区域在锁骨的单据"):
        yield {"text": text, "spans": [], "intent": "REVIEW"}
    for text in ("胸部 CT", "看看平稳呼吸", "扫描要求", "仰卧定位记录"):
        yield {"text": text, "spans": [], "intent": "KEYWORD"}


def tagged_query(parts, prefix, separator, suffix):
    text, spans = prefix, []
    for index, (field, name, op, wording, value) in enumerate(parts):
        if index:
            text += separator
        text += unicodedata.normalize("NFKC", name + wording)
        value = unicodedata.normalize("NFKC", value)
        start = len(text)
        text += value
        spans.append([start, len(text), f"{field}_{op}"])
    return {"text": text + suffix, "spans": spans, "intent": f"FILTER{len(spans)}"}


def second_round_rows(catalog):
    entries = list(catalog.items())
    numbers = [(field, spec) for field, spec in entries if spec.get("number")]
    aliases = {spec["label"]: field for field, spec in entries}
    modality = aliases["成像方式"]
    contrast = {
        "lt": ["不到", "低于", "小于"],
        "lte": ["不高于", "不超过", "最多"],
        "gt": ["超过", "高于", "大于"],
        "gte": ["不低于", "不少于", "至少"],
    }
    for index, (field, spec) in enumerate(numbers):
        names = {spec["label"], ALIASES.get(spec["label"], spec["label"])}
        for name in sorted(names):
            for value in ("1.6", "2.25", "3", "4.8", "12.5", "72"):
                for op, forms in contrast.items():
                    for form in forms:
                        condition = (field, name, op, form, value)
                        ct = (modality, "", "eq", "", "CT")
                        yield tagged_query([condition, ct], "找", "的", "定位单")
                        yield tagged_query([ct, condition], "请筛出", "定位单中", "的记录")
                        yield tagged_query([condition], "只看", "", "的单据")
    for index, (field, spec) in enumerate(entries):
        name = spec["label"]
        for offset in (1, 3, 17):
            other, other_spec = entries[(index + offset) % len(entries)]
            other_name = other_spec["label"]
            for number in range(3):
                op = spec["operators"][number % len(spec["operators"])]
                other_op = other_spec["operators"][number % len(other_spec["operators"])]
                left = (field, name, op, OPERATORS[op][number], values(spec)[number % len(values(spec))])
                right = (other, other_name, other_op, OPERATORS[other_op][number], values(other_spec)[number % len(values(other_spec))])
                yield tagged_query([left], "请筛", "", "的定位申请")
                yield tagged_query([left, right], "请筛", "，还要求", "的定位申请")
                yield tagged_query([right, left], "请筛", "，还要求", "的定位申请")
                if op == other_op == "eq" and bool(spec.get("number")) == bool(other_spec.get("number")):
                    yield tagged_query([(other, other_name, op, left[3], left[4])], "请筛", "", "的定位申请")


def second_holdout(catalog):
    entries = list(catalog.items())
    verbs = {"eq": "填写为", "contains": "写有", "lt": "未达到", "lte": "封顶在", "gt": "超出", "gte": "下限为"}
    def part(entry, op):
        field, spec = entry
        value = "6.35" if spec.get("number") else values(spec, True)[-1]
        return field, spec["label"], op, verbs[op], value
    for index, entry in enumerate(entries):
        other = entries[(index + 13) % len(entries)]
        left = part(entry, entry[1]["operators"][-1])
        right = part(other, other[1]["operators"][index % len(other[1]["operators"])])
        conditions = [right, left] if index % 2 else [left, right]
        if index % 5 == 0:
            third = entries[(index + 29) % len(entries)]
            conditions.append(part(third, third[1]["operators"][0]))
        yield tagged_query(conditions, "麻烦核一下", "；另外", "这些要求都满足的定位申请。")
        if entry[1].get("number"):
            for op in ("lt", "lte", "gt", "gte"):
                yield tagged_query([part(entry, op)], "只列出", "", "的定位资料。")
    for text, intent in [
        ("能看一下CT吗", "KEYWORD"), ("帮我看看固定方法", "KEYWORD"),
        ("不要成像方式为MR的定位申请", "REVIEW"), ("技术为VMAT或IMRT都可以", "REVIEW"),
    ]:
        yield {"text": text, "spans": [], "intent": intent}


def third_round_rows(catalog):
    entries = list(catalog.items())
    rng = random.Random(97)
    verbs = {
        **OPERATORS, "lt": ("低于", "不到", "未达到"),
        "lte": ("至多", "不高于", "封顶在"),
        "gt": ("大于", "超过", "超出"),
        "gte": ("至少", "不低于", "下限为"),
        "eq": ("取值是", "填写为", "等于"),
        "contains": ("出现过", "写有", "包含"),
    }
    for index, primary in enumerate(entries):
        for style in range(6):
            parts = [primary, *rng.sample(entries[:index] + entries[index + 1:], 2)]
            conditions = []
            for offset, (field, spec) in enumerate(parts):
                op = spec["operators"][(style + offset) % len(spec["operators"])]
                name = ALIASES.get(spec["label"], spec["label"]) if style % 2 else spec["label"]
                candidates = values(spec)
                value = candidates[(index + style + offset) % len(candidates)]
                conditions.append((field, name, op, verbs[op][style % 3], value))
            if style % 2:
                conditions.reverse()
            for length in (1, 2, 3):
                yield tagged_query(conditions[:length], ("找一下", "请筛出", "看下")[style % 3],
                                   ("并且", "，另外", "、还要求")[style % 3], "的定位申请")


def third_holdout(catalog):
    entries = list(catalog.items())
    verbs = {"eq": "一栏填的是", "contains": "里记着", "lt": "还没到",
             "lte": "上限是", "gt": "超出了", "gte": "最低得有"}
    for index in range(len(entries)):
        def condition(offset):
            field, spec = entries[(index + offset) % len(entries)]
            op = spec["operators"][(index // 3 + offset) % len(spec["operators"])]
            value = "8.45" if spec.get("number") else values(spec, True)[index % len(values(spec, True))]
            return field, spec["label"], op, verbs[op], value
        parts = [condition(0), condition(11), condition(27)]
        for length in (1, 2, 3):
            yield tagged_query(parts[:length], "麻烦把符合要求的定位申请列一下，", "；也要满足", "。")
    for text, intent in [
        ("定位记录", "KEYWORD"), (" CT 扫描", "KEYWORD"),
        ("排除固定说明中出现屏气的记录", "REVIEW"), ("层厚小于3或大于5", "REVIEW"),
    ]:
        yield {"text": text, "spans": [], "intent": intent}


def fourth_round_rows(catalog):
    entries = list(catalog.items())
    compare = {
        "lt": ("必须低于", "不到", "还没到"),
        "lte": ("上限是", "最高允许", "不高于"),
        "gt": ("必须高于", "超过", "超出了"),
        "gte": ("下限是", "最低得有", "不低于"),
    }
    prefaces = ("麻烦把符合要求的定位申请列一下，", "请帮忙核一下定位记录，", "先看定位申请，")
    for index, (field, spec) in enumerate(entries):
        for style, prefix in enumerate(prefaces):
            name = spec["label"]
            op = spec["operators"][style % len(spec["operators"])]
            wording = compare[op][style] if op in compare else ("里记着" if op == "contains" else "一栏填的是")
            for value in (*values(spec), *values(spec, True)):
                part = (field, name, op, wording, value)
                yield tagged_query([part], prefix, "", "，麻烦把符合的列出来。")
            if not spec.get("number"):
                continue
            other, other_spec = entries[(index + 13) % len(entries)]
            other_part = (other, other_spec["label"], "eq", "为", values(other_spec)[style % len(values(other_spec))])
            for value in ("1.25", "2.75", "8.45", "16.8", "120.5"):
                for op, forms in compare.items():
                    part = (field, name, op, forms[style], value)
                    yield tagged_query([part], prefix, "", "。")
                    yield tagged_query([other_part, part], prefix, "；也要满足", "。")


def fourth_holdout(catalog):
    entries = list(catalog.items())
    verbs = {"eq": "登记的是", "contains": "有这样一段", "lt": "必须小过",
             "lte": "不得多于", "gt": "须多过", "gte": "不得少于"}

    def condition(index, op_index, forced=None):
        field, spec = entries[index % len(entries)]
        op = forced or spec["operators"][op_index % len(spec["operators"])]
        value = "7.26" if spec.get("number") else values(spec, True)[op_index % len(values(spec, True))]
        return field, spec["label"], op, verbs[op], value

    for index, (_, spec) in enumerate(entries):
        first = condition(index, index // 2)
        parts = [first, condition(index + 23, index), condition(index + 41, index)]
        for count in (1, 2, 3):
            selected = parts[:count]
            if index % 2:
                selected.reverse()
            yield tagged_query(selected, "定位单据帮我核对一下，只列出", "，而且还得", "这些要求都符合的。")
        if spec.get("number"):
            for op in ("lt", "lte", "gt", "gte"):
                yield tagged_query([condition(index, index, op)], "可否只挑", "", "的定位单据？")


def fifth_round_rows(catalog):
    entries = list(catalog.items())
    rng = random.Random(127)
    forms = {
        "eq": ("登记的是", "填了", "取"),
        "contains": ("有这样一段", "写到", "能看到"),
        "lt": ("必须小过", "不足", "低于"),
        "lte": ("不得多于", "最多只能到", "不能超过"),
        "gt": ("须多过", "必须超过", "高于"),
        "gte": ("不得少于", "起码得有", "不能低于"),
    }
    frames = (
        ("定位单据帮我核对一下，只列出", "，而且还得", "这些要求都符合的。"),
        ("定位申请想筛一遍，先看", "，另外还要", "的那些单子"),
        ("麻烦找一下", "并且", "的定位单据"),
        ("只查", "；同时满足", "的定位记录"),
    )
    for index, primary in enumerate(entries):
        for style, frame in enumerate(frames):
            conditions = []
            for offset, (field, spec) in enumerate([primary, *rng.sample(entries[:index] + entries[index+1:], 2)]):
                op = spec["operators"][(index + style + offset) % len(spec["operators"])]
                candidates = values(spec) + values(spec, True)
                value = candidates[(index + style + offset) % len(candidates)]
                conditions.append((field, spec["label"], op, forms[op][style % 3], value))
            if style % 2:
                conditions.reverse()
            for count in (1, 2, 3):
                yield tagged_query(conditions[:count], *frame)
        field, spec = primary
        if spec.get("number"):
            other, other_spec = entries[(index + 19) % len(entries)]
            anchor = (other, other_spec["label"], "eq", "填了", values(other_spec)[0])
            for value in ("1.75", "3.05", "7.26", "52.4"):
                for op in ("lt", "lte", "gt", "gte"):
                    for style, wording in enumerate(forms[op]):
                        part = (field, spec["label"], op, wording, value)
                        frame = frames[style]
                        yield tagged_query([part], *frame)
                        yield tagged_query([part, anchor] if style % 2 else [anchor, part], *frame)


def fifth_holdout(catalog):
    entries = list(catalog.items())
    verbs = {"eq": "登记成了", "contains": "这栏提及", "lt": "还不足",
             "lte": "最多可为", "gt": "必须严格高于", "gte": "最低不能少于"}
    frames = (
        ("帮忙从定位资料中找一下，", "，加上", "符合的单子。"),
        ("我查定位单，只考虑", "；还需", "的记录"),
        ("看看哪些定位申请是", "，同时还得", "。"),
    )

    def condition(index, op_index, forced=None):
        field, spec = entries[index % len(entries)]
        op = forced or spec["operators"][op_index % len(spec["operators"])]
        candidates = values(spec, True)
        value = "9.63" if spec.get("number") else candidates[op_index % len(candidates)]
        return field, spec["label"], op, verbs[op], value

    for index, (_, spec) in enumerate(entries):
        parts = [condition(index, index // 2), condition(index + 7, index), condition(index + 31, index)]
        for count in (1, 2, 3):
            selected = parts[:count]
            if index % 2:
                selected.reverse()
            yield tagged_query(selected, *frames[(index + count) % len(frames)])
        if spec.get("number"):
            for op in ("lt", "lte", "gt", "gte"):
                yield tagged_query([condition(index, index, op)], "请把定位档案中", "", "的挑出来")
    for text, intent in [
        ("帮我看看仰卧的资料", "KEYWORD"), ("胸部磁共振", "KEYWORD"),
        ("成像方式可以是CT也可以是MR", "REVIEW"), ("不看任何屏气定位单", "REVIEW"),
    ]:
        yield {"text": text, "spans": [], "intent": intent}


def evaluate(checkpoint, rows, output):
    spec = importlib.util.spec_from_file_location("worker", Path(__file__).with_name("search-model.py"))
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    predict = worker.load_bert(checkpoint, patient_mode=True)
    counts = Counter()
    details = []
    for row in rows:
        expected = [(tag, row["text"][start:end]) for start, end, tag in row["spans"]]
        prediction = predict({"query": row["text"]}) or {}
        actual = [(field["field"], field["text"]) for field in prediction.get("fields", [])]
        exact = Counter(expected) == Counter(actual) and prediction.get("intent") == row["intent"]
        group = "组合" if len(expected) > 1 else "单条件" if expected else row["intent"]
        counts[group + "_总数"] += 1
        counts[group + "_完整正确"] += exact
        remaining = list(actual)
        errors = Counter()
        for tag, value in expected:
            field, op = tag.split("_")
            candidates = [
                next((item for item in remaining if item == (tag, value)), None),
                next((item for item in remaining if item[0].split("_")[0] == field), None),
                next((item for item in remaining if item[1] == value), None),
            ]
            matched = next((item for item in candidates if item), None)
            if matched is None:
                errors["漏条件"] += 1
                continue
            remaining.remove(matched)
            actual_field, actual_op = matched[0].split("_")
            errors["错字段"] += field != actual_field
            errors["错比较符"] += op != actual_op
            errors["比较方向反转"] += (op in {"lt", "lte"} and actual_op in {"gt", "gte"}) or (op in {"gt", "gte"} and actual_op in {"lt", "lte"})
            errors["错值"] += value != matched[1]
        errors["多余条件"] += len(remaining)
        errors["意图错误"] += prediction.get("intent") != row["intent"]
        if expected:
            errors["条件数量错误"] += prediction.get("intent") != f"FILTER{len(expected)}"
            errors["输出数量错误"] += len(actual) != len(expected)
        counts.update({group + "_" + key: value for key, value in errors.items()})
        details.append({"query": row["text"], "expectedIntent": row["intent"], "expected": expected,
                        "prediction": prediction, "exact": exact, "errors": dict(errors)})
    output.write_text(json.dumps({"summary": counts, "cases": details}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(counts, ensure_ascii=False), flush=True)


def train(args, rows):
    labels = ["O", "KEYWORD", "REVIEW", "FILTER1", "FILTER2", "FILTER3"] + [
        f"{prefix}-{field}_{op}" for field, spec in args.catalog_data.items() for op in spec["operators"] for prefix in ("B", "I")
    ]
    ids = {label: index for index, label in enumerate(labels)}
    torch.manual_seed(23)
    torch.set_num_threads(6)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(
        args.base, local_files_only=True, id2label=dict(enumerate(labels)), label2id=ids,
        ignore_mismatched_sizes=True,
    ).to(device)
    batch = tokenizer([row["text"] for row in rows], padding=True, return_offsets_mapping=True, return_tensors="pt")
    offsets = batch.pop("offset_mapping").tolist()
    targets = []
    for positions, row in zip(offsets, rows):
        row_targets = []
        for start, end in positions:
            span = next((span for span in row["spans"] if start < span[1] and end > span[0]), None)
            row_targets.append(-100 if start == end else ids[f"{'B' if start <= span[0] else 'I'}-{span[2]}"] if span else 0)
        row_targets[0] = ids[row["intent"]]
        targets.append(row_targets)
    batch["labels"] = torch.tensor(targets)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    print(f"Training {len(rows)} queries on {device}", flush=True)
    model.train()
    for epoch in range(args.epochs):
        losses = []
        for selection in torch.randperm(len(rows)).split(24):
            selected = {key: value[selection].to(device) for key, value in batch.items()}
            width = int(selected["attention_mask"].sum(dim=1).max().item())
            loss = model(**{key: value[:, :width].contiguous() for key, value in selected.items()}).loss
            loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            losses.append(loss.item())
        print(f"epoch {epoch + 1}/{args.epochs}, loss {sum(losses)/len(losses):.4f}", flush=True)
    model.save_pretrained(args.output / "checkpoint")
    tokenizer.save_pretrained(args.output / "checkpoint")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", type=Path, required=True)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--previous", type=Path, help="First round directory to reuse for second-round preparation and comparison")
    parser.add_argument("--fourth-round", type=Path, help="Fourth-round directory for fifth-round training and comparison")
    parser.add_argument("--third-round", type=Path, help="Third-round directory for fourth-round training and comparison")
    parser.add_argument("--second-round", type=Path, help="Second-round directory for third-round preparation and comparison")
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    parser.add_argument("--evaluate-checkpoint", type=Path, help="Evaluate another checkpoint on the frozen holdout")
    args = parser.parse_args()
    args.catalog_data = read_catalog(args.catalog)
    args.output.mkdir(parents=True, exist_ok=True)
    training_file = args.output / "training.json"
    holdout_file = args.output / "holdout.json"
    if args.prepare:
        training = list({row["text"]: row for row in training_rows(args.catalog_data)}.values())
        holdout = list(holdout_rows(args.catalog_data))
        old_holdout = []
        if args.previous:
            old_holdout = json.loads((args.previous / "holdout.json").read_text())
            holdout = list(second_holdout(args.catalog_data))
            assert not {row["text"] for row in old_holdout} & {row["text"] for row in holdout}
            reserved = {row["text"] for row in [*old_holdout, *holdout]}
            training = list({row["text"]: row for row in [*training, *second_round_rows(args.catalog_data)]
                             if row["text"] not in reserved}.values())
        if args.second_round:
            assert args.previous, "--second-round requires --previous"
            old_holdout.extend(json.loads((args.second_round / "holdout.json").read_text()))
            holdout = list(third_holdout(args.catalog_data))
            assert not {row["text"] for row in old_holdout} & {row["text"] for row in holdout}
            reserved = {row["text"] for row in [*old_holdout, *holdout]}
            pairs = [row for row in second_round_rows(args.catalog_data) if row["intent"] == "FILTER2"]
            replay = random.Random(97).sample(pairs, 500)
            training = list({row["text"]: row for row in [*training_rows(args.catalog_data), *replay, *third_round_rows(args.catalog_data)]
                             if row["text"] not in reserved}.values())
        if args.third_round:
            assert args.previous and args.second_round, "--third-round requires both earlier rounds"
            old_holdout.extend(json.loads((args.third_round / "holdout.json").read_text()))
            holdout = list(fourth_holdout(args.catalog_data))
            reserved = {row["text"] for row in [*old_holdout, *holdout]}
            assert not {row["text"] for row in old_holdout} & {row["text"] for row in holdout}
            replay = json.loads((args.third_round / "training.json").read_text())
            training = list({row["text"]: row for row in [*replay, *fourth_round_rows(args.catalog_data)]
                             if row["text"] not in reserved}.values())
        if args.fourth_round:
            assert args.previous and args.second_round and args.third_round, "--fourth-round requires earlier rounds"
            old_holdout.extend(json.loads((args.fourth_round / "holdout.json").read_text()))
            holdout = list(fifth_holdout(args.catalog_data))
            reserved = {row["text"] for row in [*old_holdout, *holdout]}
            assert not {row["text"] for row in old_holdout} & {row["text"] for row in holdout}
            replay = json.loads((args.fourth_round / "training.json").read_text())
            training = list({row["text"]: row for row in [*replay, *fifth_round_rows(args.catalog_data)]
                             if row["text"] not in reserved}.values())
        assert not {row["text"] for row in training} & {row["text"] for row in [*holdout, *old_holdout]}
        for path, rows in [(training_file, training), (holdout_file, holdout)]:
            with path.open("x") as stream:
                json.dump(rows, stream, ensure_ascii=False, indent=2)
        print(f"{len(training)} training, {len(holdout)} holdout queries", flush=True)
        return
    if args.base:
        train(args, json.loads(training_file.read_text()))
    checkpoint = args.evaluate_checkpoint or args.output / "checkpoint"
    report = "baseline-on-new.json" if args.evaluate_checkpoint else "evaluation.json"
    evaluate(checkpoint, json.loads(holdout_file.read_text()), args.output / report)
    if args.previous and not args.evaluate_checkpoint:
        evaluate(checkpoint, json.loads((args.previous / "holdout.json").read_text()),
                 args.output / "regression-on-original.json")
    if args.second_round and not args.evaluate_checkpoint:
        evaluate(checkpoint, json.loads((args.second_round / "holdout.json").read_text()),
                 args.output / "regression-on-second.json")
        if args.third_round:
            evaluate(checkpoint, json.loads((args.third_round / "holdout.json").read_text()),
                     args.output / "regression-on-third.json")
            if args.fourth_round:
                evaluate(checkpoint, json.loads((args.fourth_round / "holdout.json").read_text()),
                         args.output / "regression-on-fourth.json")
                evaluate(args.fourth_round / "checkpoint", json.loads(holdout_file.read_text()),
                         args.output / "fourth-on-new.json")
            else:
                evaluate(args.third_round / "checkpoint", json.loads(holdout_file.read_text()), args.output / "third-on-new.json")
        else:
            evaluate(args.previous / "checkpoint", json.loads(holdout_file.read_text()), args.output / "first-on-new.json")
            evaluate(args.second_round / "checkpoint", json.loads(holdout_file.read_text()), args.output / "second-on-new.json")


if __name__ == "__main__":
    main()
