"""Evaluate a patient BERT checkpoint on a fixed synthetic catalog benchmark."""

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / "shared/patient-search-catalog.json").read_text())
VALUES = dict(zip("""
性别 姓名 放疗号 出生日期 拼音 拼音首字母 病历号 诊疗号 民族 国籍 证件类型 证件号码 医保 医保号 身高
患者类型 放疗类型 特殊情况 研究入组 主诊医生 主管医生 住院医生 物理师 婚育史 饮酒史 吸烟史 子女数 签名方式
门诊号 挂号号 就诊卡号 患者卡号1 患者卡号2 患者卡号3 患者卡号4 住院次数 医生组 患者来源 住院科室
入院时间 出院时间 病区 床号 住院号 转诊医院 转诊科室 预计入院 入院备注 家庭电话 联系电话 其他电话 办公电话
邮箱 传真 其他号码 户籍地址 居住地址 地址标签 工作单位 单位地址 职业 备注 登记时间 登记人 首诊医生 推荐医生
体重 体温 联系人
""".split(), """
女性|陆澄|000582|1987-04-06|lucheng|LC|000742|ZX-831|汉族|中国|护照|TEST-9524|居民医保|YB-0781|172
|住院|外照射|行动不便|观察组|陶青禾|纪晓星|程向晚|孟溪|已婚|偶尔饮酒|从不吸烟|2|手写签名
|MZ-483|GH-604|JZ-052|K1-031|K2-064|K3-028|K4-057|3|胸部放疗组|门诊转入|内分泌科
|2026-02-14|2026-02-21|北区二病区|B-17|ZY-072|星桥医院|神经内科|2026-03-17|下午办理入院|010-00000101|010-00000102|010-00000103|010-00000104
|sample@example.test|010-00000105|QT-019|示例市青林路12号|示例市白石路8号|常住|星桥研究所|示例市南山路9号|教师|需要轮椅协助|2026-03-01|季兰|叶知远|苏筱
|63.5|36.8|阮小禾 母亲 010-00000106
""".replace("\n", "").split("|"), strict=True))


def cases():
    assert {field["label"] for field in CATALOG} == VALUES.keys()
    for field in CATALOG:
        label, field_id = field["label"], field["id"]
        value = VALUES[label]
        expected = {field_id: value}
        for query in (
            f"{label}是{value}",
            f"帮我筛出{label}填了{value}的患者",
            f"只看{label}记录为{value}的病人",
        ):
            yield "single", query, "FILTER1", expected
        yield "keyword", value, "KEYWORD", {}
        yield "negative", f"{label}不等于{value}的患者", "REVIEW", {}
    for i, first in enumerate(CATALOG):
        second = CATALOG[(i + 17) % len(CATALOG)]
        left, right = first["label"], second["label"]
        a, b = VALUES[left], VALUES[right]
        yield "pair", f"{left}是{a}，且{right}是{b}的患者", "FILTER2", {first["id"]: a, second["id"]: b}


def assess(result):
    # Mirrors the common acceptance gates in server/search-models.ts for these valid synthetic values.
    intent = result["intent"]
    fields = result["fields"]
    spans = {item["field"]: item["text"].strip() for item in fields}
    if re.fullmatch(r"FILTER[123]", intent):
        count = int(intent[-1])
        if result["confidence"] < .75 or len(fields) != count or len(spans) != count or "REJECT" in spans:
            return "REVIEW", {}
        return intent, spans
    return intent, {}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("checkpoint", type=Path, nargs="?")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--cases", type=Path, help="Optional JSON cases in the generated four-column format")
    args = parser.parse_args()
    rows = json.loads(args.cases.read_text()) if args.cases else list(cases())
    if not args.checkpoint:
        json.dump(rows, sys.stdout, ensure_ascii=False, indent=2)
        return
    spec = importlib.util.spec_from_file_location("worker", ROOT / "scripts/search-model.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    model = worker.load_bert(args.checkpoint, patient_mode=True)
    counts = {}
    details = []
    single_by_field = {field["id"]: {"label": field["label"], "passed": 0, "total": 0} for field in CATALOG}
    for category, query, intent, expected in rows:
        actual_intent, actual = assess(model({"query": query}))
        passed = (actual_intent, actual) == (intent, expected)
        stats = counts.setdefault(category, Counter())
        stats["total"] += 1
        stats["passed"] += passed
        stats["wrong_filter"] += actual_intent.startswith("FILTER") and not passed
        if category == "single":
            field = single_by_field[next(iter(expected))]
            field["total"] += 1
            field["passed"] += passed
        details.append({"category": category, "query": query, "expectedIntent": intent, "expected": expected,
                        "actualIntent": actual_intent, "actual": actual, "passed": passed})
    if args.output:
        args.output.write_text(json.dumps({"summary": counts, "singleByField": single_by_field, "cases": details}, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(counts, ensure_ascii=False))


if __name__ == "__main__":
    main()
