"""Train age extraction on fictional queries from the released patient BERT."""

import argparse
import random
import runpy
from pathlib import Path

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

OPERATORS = {
    "AGE_GT": ("大于", "超过", "高于", ">"),
    "AGE_GTE": ("不少于", "至少", "不低于", ">="),
    "AGE_LT": ("小于", "低于", "未满", "<"),
    "AGE_LTE": ("不超过", "至多", "不大于", "<="),
}
LABELS = ["O", "KEYWORD", "FILTER1"] + [
    f"{prefix}-{field}" for field in OPERATORS for prefix in ("B", "I")
]
IDS = {label: index for index, label in enumerate(LABELS)}


def chinese_number(value):
    digits = "零一二三四五六七八九"
    if value < 10:
        return digits[value]
    tens, remainder = divmod(value, 10)
    return (digits[tens] if tens > 1 else "") + "十" + (digits[remainder] if remainder else "")


def examples():
    rng = random.Random(71)
    positives = []
    negatives = []
    for field, comparisons in OPERATORS.items():
        for comparison in comparisons:
            for years in [*range(5, 96, 3), 20, 30, 40, 50]:
                value = rng.choice((str(years), chinese_number(years)))
                prefix = rng.choice(("年龄", "找年龄", "筛选患者，年龄", "患者年龄", "查找年龄"))
                suffix = rng.choice(("岁", "周岁", "岁的患者", "周岁的患者"))
                left = prefix + comparison
                text = left + value + suffix
                positives.append((text, field, len(left), len(left) + len(value)))
                negatives.extend((
                    text + "且主诊医生为林知夏",
                    f"定位申请单总次数{comparison}{value}次",
                    f"备注包含{value}岁",
                ))
    for comparison in OPERATORS["AGE_GT"]:
        for years in (18, 25, 30, 35, 60):
            for value in (str(years), chinese_number(years)):
                prefix = "年龄" + comparison
                text = prefix + value + "岁"
                positives.extend([(text, "AGE_GT", len(prefix), len(prefix) + len(value))] * 8)
                negatives.extend((text + "或四十岁", "排除" + text, text + "且住院科室是放疗科"))
    negatives.extend([
        "年龄", "年龄大于", "年龄大于岁", "30岁", "三十岁", "30", "鼻咽癌", "赵嘉",
        "最近10个月确诊鼻咽癌", "成像方式为CT", "总次数不少于20次的计划申请单",
        "年龄大于30岁或小于20岁", "排除年龄大于30岁的患者", "扫描说明是头部定位测试001",
    ] * 12)
    patient_training = runpy.run_path(str(Path(__file__).with_name("train-patient-bert.py")))
    for generator in ("samples", "intent_samples", "catalog_samples"):
        texts = sorted({patient_training["annotate"](sample)[0] for sample in patient_training[generator]()})
        negatives.extend(rng.sample(texts, min(250, len(texts))))
    rows = positives + [(text, None, 0, 0) for text in negatives]
    rng.shuffle(rows)
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("base")
    parser.add_argument("output")
    args = parser.parse_args()
    torch.manual_seed(71)
    torch.set_num_threads(6)
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(
        args.base, local_files_only=True, ignore_mismatched_sizes=True,
        num_labels=len(LABELS), id2label=dict(enumerate(LABELS)), label2id=IDS,
    ).eval()
    encoder = model.base_model
    examples_to_encode = examples()
    features, targets = [], []
    for start in range(0, len(examples_to_encode), 64):
        rows = examples_to_encode[start:start + 64]
        batch = tokenizer([row[0] for row in rows], padding=True, return_offsets_mapping=True, return_tensors="pt")
        offsets = batch.pop("offset_mapping").tolist()
        with torch.no_grad():
            encoded = encoder(**batch).last_hidden_state
        for hidden, locations, (_, field, first, last) in zip(encoded, offsets, rows):
            features.append(hidden[0])
            targets.append(IDS["FILTER1" if field else "KEYWORD"])
            previous = False
            for index, (left, right) in enumerate(locations[1:], start=1):
                if left == right:
                    continue
                inside = field is not None and first <= left < right <= last
                features.append(hidden[index])
                targets.append(IDS[f"{'I' if previous else 'B'}-{field}"] if inside else IDS["O"])
                previous = inside
    features = torch.stack(features)
    targets = torch.tensor(targets)
    weights = torch.bincount(targets, minlength=len(LABELS)).clamp_min(1).float().pow(-0.5)
    optimizer = torch.optim.AdamW(model.classifier.parameters(), lr=0.003)
    for epoch in range(30):
        for indices in torch.randperm(len(targets)).split(512):
            loss = torch.nn.functional.cross_entropy(model.classifier(features[indices]), targets[indices], weight=weights)
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
        if (epoch + 1) % 10 == 0:
            print(f"epoch={epoch + 1} loss={loss.item():.4f}", flush=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)


if __name__ == "__main__":
    main()
