"""Train a local token classifier for patient search, using fictional queries."""

import argparse
import json
import random
import re
from pathlib import Path
from collections import Counter, defaultdict
from itertools import combinations

import torch
from transformers import AutoModelForTokenClassification, AutoTokenizer

CATALOG = json.loads((Path(__file__).resolve().parents[1] / "shared/patient-search-catalog.json").read_text())
FIELD_IDS = {row["label"]: row["id"] for row in CATALOG}
ALIASES = {"SEX": FIELD_IDS["性别"], "DOCTOR": FIELD_IDS["主诊医生"], "DEPARTMENT": FIELD_IDS["住院科室"]}
LABELS = ["O", "KEYWORD", "REVIEW", "FILTER1", "FILTER2", "FILTER3"] + [
    f"{prefix}-{field}"
    for field in [*(row["id"] for row in CATALOG), "REJECT"]
    for prefix in ("B", "I")
]
MARKUP = re.compile(r"<([A-Z0-9]+)>([^<>]+)</\1>")


def annotate(template):
    text = ""
    spans = []
    cursor = 0
    for match in MARKUP.finditer(template):
        text += template[cursor:match.start()]
        start = len(text)
        text += match[2]
        spans.append((start, len(text), ALIASES.get(match[1], match[1])))
        cursor = match.end()
    return text + template[cursor:], spans


def samples():
    rng = random.Random(313)
    names = ["林知夏", "许明远", "沈宁", "王雨晴", "陈牧", "韩松", "宋长青", "邓一帆"]
    departments = ["放疗科", "肿瘤内科", "耳鼻喉科", "头颈外科", "骨科", "综合病区"]
    for _ in range(95):
        d = f"<DOCTOR>{rng.choice(names)}</DOCTOR>"
        p = f"<DEPARTMENT>{rng.choice(departments)}</DEPARTMENT>"
        s = f"<SEX>{rng.choice(['男', '女', '男性', '女性'])}</SEX>"
        yield rng.choice([
            f"帮我找主诊医生为{d}的患者",
            f"主诊医生选{d}，患者有哪些",
            f"住院科室在{p}的患者",
            f"筛一下患者，住院科室填的是{p}",
            f"患者按性别选{s}",
            f"列出所有{s}患者",
            f"主诊医生是{d}并且住院科室为{p}的患者",
            f"在{p}住院，主诊医生是{d}，只看{s}患者",
            f"住院科室为{p}且是{s}的患者",
        ])
        yield rng.choice([
            f"患者主诊医生<REJECT>不是</REJECT>{d}",
            f"<REJECT>排除</REJECT>{p}住院的患者",
            f"<REJECT>不要</REJECT>{s}患者",
            f"找<REJECT>主管医生</REJECT>为{d}的患者",
            f"住院科室是{p}，主诊<REJECT>不要</REJECT>{d}",
            f"查<REJECT>张医生</REJECT>主诊的患者",
            "林知夏", "患者的备注提到骨科", "定位方式是 CT", "放疗号 000123",
        ])
    # Systematic coverage across value and phrasing combinations.
    for name in names:
        for department in departments:
            yield f"找<DEPARTMENT>{department}</DEPARTMENT>住院且<DOCTOR>{name}</DOCTOR>主诊的患者"
    for name in names:
        yield f"由<DOCTOR>{name}</DOCTOR>担任主诊医生的患者"
        yield f"查<DOCTOR>{name}</DOCTOR>主诊的<SEX>女性</SEX>患者"

    for name in names:
        yield name
        for verb in ("是", "为", "填的是", "选"):
            yield f"主诊医生{verb}<DOCTOR>{name}</DOCTOR>"
            yield f"主诊医生{verb}<DOCTOR>{name}</DOCTOR>的患者"
        yield f"主诊医生<REJECT>不是</REJECT>{name}"
        yield f"{name}在备注中提到呼吸内科"
        for department in departments:
            yield f"看看<DOCTOR>{name}</DOCTOR>主诊、<DEPARTMENT>{department}</DEPARTMENT>住院的病人"
            yield f"查<DOCTOR>{name}</DOCTOR>主诊、在<DEPARTMENT>{department}</DEPARTMENT>住院的患者"
            yield f"找<DOCTOR>{name}</DOCTOR>主诊但<REJECT>别选</REJECT>{department}住院的患者"
    for department in departments:
        yield f"住院科室是<DEPARTMENT>{department}</DEPARTMENT>"
        yield f"住院科室为<DEPARTMENT>{department}</DEPARTMENT>"
    for sex in ("男", "女", "男性", "女性"):
        yield f"性别是<SEX>{sex}</SEX>"
    for phrase in ["不属于", "但不要", "排除", "别给我", "之外", "不在"]:
        for department in departments:
            yield f"主诊是<DOCTOR>林知夏</DOCTOR>，<REJECT>{phrase}</REJECT>{department}住院的患者"
    for row in CATALOG:
        label, field = row["label"], row["id"]
        if label in ALIASES:
            continue
        if label in ("性别", "主诊医生", "住院科室"):
            continue
        values = ("示例值甲", "测试值乙", "00127") if label not in ("出生日期", "放疗号", "姓名") else {
            "出生日期": ("1980-01-02", "1973-12-30", "1962-03-01"),
            "放疗号": ("00011", "00022", "00033"),
            "姓名": ("沈秋", "罗远", "高星"),
        }[label]
        for value in values:
            yield f"查{label}为<{field}>{value}</{field}>的患者"
            yield f"筛选患者，{label}填的是<{field}>{value}</{field}>"


def intent_samples():
    rng = random.Random(2049)
    names = ["高秋水", "徐琛", "孟岚", "谢文松", "叶微", "丁知远", "何月", "吕明哲", "戴安", "熊静"]
    departments = ["心血管内科", "普外科", "泌尿外科", "感染科", "老年医学科", "眼科", "血液内科", "胸外科"]
    for name in names:
        doctor = f"<DOCTOR>{name}</DOCTOR>"
        for text in (name, f"搜索{name}", f"姓名关键词{name}", f"查找包含{name}的相关记录"):
            yield text
        for text in (f"主诊为{doctor}", f"由{doctor}主诊的病人", f"谁是{doctor}主诊的患者", f"主诊医生填的是{doctor}"):
            yield text
    for label in departments:
        department = f"<DEPARTMENT>{label}</DEPARTMENT>"
        yield f"住院科室填的是{department}"
        yield f"在{department}收治过的患者"
    for sex in ("男性", "女性", "男", "女"):
        yield f"只筛选性别为<SEX>{sex}</SEX>的病人"
        yield f"麻烦给我<SEX>{sex}</SEX>患者"
    for _ in range(175):
        name, department_name = rng.choice(names), rng.choice(departments)
        doctor = f"<DOCTOR>{name}</DOCTOR>"
        department = f"<DEPARTMENT>{department_name}</DEPARTMENT>"
        sex = f"<SEX>{rng.choice(['男', '女', '男性', '女性'])}</SEX>"
        yield rng.choice((
            f"看看{department}的住院病人，主诊是{doctor}",
            f"查主诊是{doctor}且由{department}收治的病人",
            f"住院在{department}并且由{doctor}主诊",
            f"{department}住院的{sex}患者，主诊为{doctor}",
            f"给我{department}收治、{doctor}主诊的{sex}病人",
            f"只看{sex}，主诊是{doctor}，在{department}住院",
        ))
        yield rng.choice((
            f"备注里写到{name}和{department_name}",
            f"查同时包含{name}和{department_name}的记录",
            f"<REJECT>排除</REJECT>主诊为{name}的病人",
            f"主诊是{doctor}，{department_name}住院的<REJECT>不要</REJECT>",
            f"找{sex}患者，住院科室<REJECT>不得是</REJECT>{department_name}",
            f"在{department}住院的患者，主诊<REJECT>不能是</REJECT>{name}",
            f"找由<REJECT>{name[0]}大夫</REJECT>主诊的病人",
            f"看看<REJECT>{name[0]}医生</REJECT>主诊、{department}住院的患者",
        ))
    for number in ("000411", "018003", "72777", "034277"):
        yield number


def catalog_samples():
    rng = random.Random(484)
    groups = {
        "性别": ["男", "女性", "其他", "未知"],
        "民族": ["回族", "壮族", "满族"],
        "国籍": ["新加坡", "日本", "泰国"],
        "证件类型": ["身份证", "军官证", "居住证"],
        "医保": ["职工医保", "自费", "商业保险"],
        "患者类型": ["门诊", "急诊", "日间"],
        "放疗类型": ["近距离放疗", "立体定向放疗", "质子治疗"],
        "特殊情况": ["听力障碍", "需要翻译", "需陪同"],
        "研究入组": ["对照组", "第二队列", "未入组"],
        "婚育史": ["未婚", "已育", "离异"],
        "饮酒史": ["从未饮酒", "已戒酒", "规律饮酒"],
        "吸烟史": ["已戒烟", "偶尔吸烟", "既往吸烟"],
        "签名方式": ["电子签名", "代签", "指纹签名"],
        "医生组": ["头颈组", "腹部组", "骨盆组"],
        "患者来源": ["急诊转入", "外院转入", "自行就诊"],
        "病区": ["南区三病区", "东区一病区", "住院五区"],
        "床号": ["A-08", "C-32", "D-03"],
        "转诊医院": ["晨杉医院", "东岭医院", "柳湾医院"],
        "入院备注": ["上午办理入院", "带纸质材料", "提前电话通知"],
        "地址标签": ["单位", "临时地址", "通讯地址"],
        "工作单位": ["青禾实验室", "海林设计院", "青桐出版社"],
        "职业": ["工程师", "设计师", "维修工"],
        "备注": ["需无障碍通道", "联系家属", "携带影像资料"],
        "联系人": ["江原 父亲 010-00000318", "魏岚 配偶 010-00000641", "田雨 姐姐 010-00000423"],
        "拼音": ["miaoyu", "zhouning", "shenhai"],
        "拼音首字母": ["MY", "ZN", "SH"],
        "邮箱": ["demo-a@example.test", "demo-b@example.test", "demo-c@example.test"],
        "身高": ["156", "181", "167.5"],
        "体重": ["51.2", "76.8", "82"],
        "体温": ["36.2", "37.1", "36.5"],
        "子女数": ["0", "1", "4"],
        "住院次数": ["1", "2", "5"],
    }
    names = ["罗云岚", "傅原", "任月明", "吴一夏", "程江", "魏秋宁"]
    departments = ["风湿科", "消化科", "神经外科病区", "呼吸科", "妇科"]
    available = {}
    for field in CATALOG:
        label, field_id = field["label"], field["id"]
        if label in groups:
            values = groups[label]
        elif label.endswith("医生") or label in {"姓名", "物理师", "登记人"}:
            values = names
        elif label.endswith("科室"):
            values = departments
        elif label in {"出生日期", "入院时间", "出院时间", "预计入院", "登记时间"}:
            years = (1964, 1979, 1994) if label == "出生日期" else (2023, 2024, 2025)
            values = [f"{year}-0{month}-1{day}" for year, month, day in zip(years, range(1, 4), range(4, 7))]
        elif "电话" in label or label == "传真":
            values = [f"021-00000{rng.randrange(200, 800)}" for _ in range(3)]
        elif label.endswith("地址"):
            values = ["样例市紫松路23号", "样例市松竹路6号", "样例市青禾巷12号"]
        elif "号" in label:
            values = [f"00{rng.randrange(1000, 9900)}", f"T-{rng.randrange(100, 900)}", str(rng.randrange(10000, 90000))]
        else:
            raise ValueError(f"Missing synthetic value generator for {label}")
        available[label] = [(value, f"<{field_id}>{value}</{field_id}>") for value in values]
        for raw, value in available[label]:
            yield f"筛出{label}写作{value}的患者"
            yield f"{label}为{value}"
            yield f"患者资料中的{label}填写{value}"
            yield f"查询{label}为{value}的患者"
            yield raw
            yield f"关键词搜索{raw}"
            yield f"{label}<REJECT>不是</REJECT>{raw}的病人"
    labels = list(available)
    for index, first in enumerate(labels):
        for offset in (1, 7, 13, 29, 37, 53, 61):
            second = labels[(index + offset) % len(labels)]
            a = rng.choice(available[first])[1]
            b = rng.choice(available[second])[1]
            yield rng.choice((
                f"查{first}填{a}、同时{second}为{b}的患者",
                f"{first}为{a}且{second}为{b}",
                f"请筛选{first}为{a}，同时要求{second}填{b}",
                f"列出{first}是{a}并且{second}为{b}的患者",
            ))
    for index, first in enumerate(labels):
        second, third = (labels[(index + offset) % len(labels)] for offset in (11, 39))
        a, b, c = (rng.choice(available[label])[1] for label in (first, second, third))
        yield f"筛选患者：{first}为{a}，{second}为{b}，同时{third}为{c}"



def contrast_samples():
    rng = random.Random(425)
    groups = {
        "患者类型": ["住院", "门诊", "急诊", "日间", "留观"],
        "病区": ["住院一病区", "门诊观察区", "急诊留观区", "东区六病区"],
        "住院科室": ["血液科", "皮肤科", "眼科", "心内科", "康复科"],
        "转诊科室": ["血液科", "皮肤科", "眼科", "心内科", "康复科"],
        "医保": ["城镇职工医保", "异地医保", "居民基本医保", "商业医疗保险"],
        "签名方式": ["本人手写", "电子签字", "纸质签名", "家属代签", "签名确认"],
        "特殊情况": ["需协助行走", "需要翻译陪同", "行动需要辅助", "沟通需手语"],
        "医生组": ["头颈放疗组", "骨盆肿瘤组", "乳腺治疗组", "胸腹治疗组"],
        "住院医生": ["费晓冬", "凌北辰", "卫子怡", "许如松"],
        "主诊医生": ["费晓冬", "凌北辰", "卫子怡", "许如松"],
        "饮酒史": ["偶尔饮用白酒", "既往饮酒", "已停止饮酒", "很少饮酒"],
        "拼音": ["feixiaodong", "lingbeichen", "weiziyi", "xurusong"],
        "拼音首字母": ["FXD", "LBC", "WZY", "XRS"],
        "联系人": ["白玉 姐姐 010-00000811", "安乔 兄长 010-00000812", "叶莹 母亲 010-00000813"],
        "家庭电话": ["010-00000841", "021-00000845", "020-00000849"],
        "其他电话": ["010-00000842", "021-00000846", "020-00000850"],
        "患者卡号2": ["K2-071", "K2-086", "K2-095"],
    }

    def tagged(label, value):
        key = FIELD_IDS[label]
        return f"<{key}>{value}</{key}>"

    for label, values in groups.items():
        for raw in values:
            value = tagged(label, raw)
            yield f"{label}是{value}"
            yield f"筛选{label}为{value}的患者"
            yield f"只看{label}填了{value}的患者"
            yield f"患者资料里{label}填的是{value}"
            yield f"看一下{label}填写{value}的人"
            yield f"按{label}找{value}"
            yield raw
            yield f"在记录中搜索{raw}"
            yield f"{label}<REJECT>不是</REJECT>{raw}的患者"
    for left, right in (
        ("患者类型", "病区"), ("住院科室", "转诊科室"), ("住院医生", "主诊医生"),
        ("拼音", "拼音首字母"), ("家庭电话", "其他电话"), ("患者类型", "患者卡号2"),
        ("特殊情况", "医生组"), ("签名方式", "医保"), ("联系人", "其他电话"),
    ):
        for first in groups[left]:
            for second in groups[right]:
                a, b = tagged(left, first), tagged(right, second)
                yield rng.choice((
                    f"{left}是{a}、{right}为{b}的患者",
                    f"找{right}填了{b}同时{left}是{a}的患者",
                    f"请筛选{left}为{a}，且{right}等于{b}",
                ))
                yield f"{right}是{b}，{left}<REJECT>不能是</REJECT>{first}"


PUBLIC_ENUMS = {
    "性别": {"male": "男性", "female": "女性", "other": "其他", "unknown": "未知"},
    "患者类型": {value: value for value in ("门诊", "住院", "急诊", "日间", "随诊")},
    "证件类型": {value: value for value in ("身份证", "护照", "军官证", "居住证", "通行证")},
    "签名方式": {value: value for value in ("手写签名", "电子签名", "代签", "指纹签名")},
}


def source_shape(label, value):
    if value in PUBLIC_ENUMS.get(label, {}):
        return ("enum", PUBLIC_ENUMS[label][value])
    if label in {"姓名", "联系人", "物理师", "登记人"} or label.endswith("医生"):
        return ("name", 2 if len(value) <= 2 else 3)
    if "电话" in label or label == "传真":
        return ("phone", 1 if "-" in value else 0)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return ("date", 0)
    if "号" in label and value.isascii():
        if value.isdigit():
            return ("digits", min(20, max(3, len(value))))
        return ("identifier", 0)
    if label in {"身高", "体重", "体温", "子女数", "住院次数"} and re.fullmatch(r"\d+(?:\.\d+)?", value):
        return ("number", int("." in value))
    return ("text", 0)


def snapshot_samples(snapshot):
    """Read patient rows locally; use only aggregate shapes and field co-occurrence."""
    shapes, pairs = defaultdict(Counter), Counter()
    patient_count = 0
    with snapshot.open(encoding="utf-8") as source:
        for line in source:
            record = json.loads(line)
            if record.get("recordType") != "patient":
                continue
            patient_count += 1
            fields = {item["label"]: item["value"] for item in record.get("patientFields", [])}
            fields.update(姓名=record.get("patientName"), 放疗号=record.get("radiotherapyNo"),
                          出生日期=record.get("birthDate"), 性别=record.get("sex"))
            present = set()
            for label, value in fields.items():
                if label in FIELD_IDS and isinstance(value, str) and value.strip():
                    present.add(label)
                    shapes[label][source_shape(label, value)] += 1
            pairs.update(combinations(sorted(present), 2))
    if not patient_count:
        raise ValueError("Patient snapshot has no patient records")

    pools = defaultdict(set)
    labels = {field_id: label for label, field_id in FIELD_IDS.items()}
    for template in [*catalog_samples(), *contrast_samples()]:
        _, spans = annotate(template)
        if len(spans) == 1 and spans[0][2] in labels:
            start, end, field_id = spans[0]
            text, _ = annotate(template)
            pools[labels[field_id]].add(text[start:end])
    rng = random.Random(4711)
    surname = ["顾", "景", "祁", "莫", "宁", "路", "闻", "万"]
    given = ["霁", "萤", "桐", "远", "悠", "昭", "晓", "亦"]
    eligible = {label: [(shape, count) for shape, count in counter.items() if count >= 20]
                for label, counter in shapes.items()}
    frequent_pairs = [(pair, count) for pair, count in pairs.most_common(320)
                      if count >= 20 and all(eligible[label] for label in pair)]
    print(f"Profiled patients: {patient_count}; usable field distributions: {sum(map(bool, eligible.values()))}; frequent field pairs: {len(frequent_pairs)}", flush=True)

    def fake(label):
        options = eligible[label]
        kind, parameter = rng.choices([item[0] for item in options], [item[1] for item in options])[0]
        if kind == "enum":
            return parameter
        if kind == "name" and label != "联系人":
            return rng.choice(surname) + "".join(rng.choices(given, k=parameter - 1))
        if kind == "phone":
            suffix = f"{rng.randrange(100, 699):03d}"
            return ("010-00000" if parameter else "00000000") + suffix
        if kind == "date":
            return f"{rng.randrange(1960, 2025)}-{rng.randrange(1, 13):02d}-{rng.randrange(1, 29):02d}"
        if kind == "digits":
            return "00" + "".join(rng.choices("0123456789", k=parameter - 2))
        if kind == "identifier":
            return f"TEST-{rng.randrange(1000, 9999)}"
        if kind == "number":
            bounds = {"身高": (150, 191), "体重": (45, 95), "体温": (36, 39)}
            base = str(rng.randrange(*bounds.get(label, (0, 7))))
            return f"{base}.{rng.randrange(10)}" if parameter else base
        return rng.choice(sorted(pools[label]))

    def tagged(label, value):
        field_id = FIELD_IDS[label]
        return f"<{field_id}>{value}</{field_id}>"

    for label, options in eligible.items():
        if not options:
            continue
        for _ in range(8):
            raw = fake(label)
            value = tagged(label, raw)
            yield rng.choice((
                f"按{label}筛选{value}的患者",
                f"给我{label}登记为{value}的病人",
                f"{label}填{value}的患者有哪些",
                f"查询{label}记为{value}的患者",
            ))
            yield raw
            yield f"<REJECT>剔除</REJECT>{label}为{raw}的患者"
    for (left, right), _ in frequent_pairs:
        a, b = tagged(left, fake(left)), tagged(right, fake(right))
        yield rng.choice((
            f"查{left}为{a}并且{right}填{b}的患者",
            f"给我{right}是{b}、{left}登记为{a}的患者",
            f"{left}登记为{a}，同时{right}是{b}",
        ))


def boundary_samples():
    rng = random.Random(628)
    fields = {
        "患者类型": ["治疗", "测试", "科研", "住院", "门诊", "急诊"],
        "签名方式": ["手写签名", "在文件上签字", "同意委托方式", "电子签名", "委托他人签名"],
        "证件类型": ["身份证", "社保卡", "驾驶证"],
        "放疗类型": ["光子", "电子", "后装", "质子"],
        "住院科室": ["内科", "神经内科", "放射治疗科", "康复医学科"],
        "主诊医生": ["祁春晓", "汪晴", "黎明辉", "景秋月"],
        "病历号": ["00063717", "00035018", "00091436"],
    }

    def tag(label, raw):
        key = FIELD_IDS[label]
        return f"<{key}>{raw}</{key}>"

    for label, values in fields.items():
        for raw in values:
            marked = tag(label, raw)
            for verb in ("是", "填的是", "填写", "登记为", "记录为", "记作", "请选择"):
                yield f"{label}{verb}{marked}"
                yield f"只看{label}{verb}{marked}的病人"
            yield raw
            yield f"备注里写着{raw}"
            for suffix in ("以外", "之外", "除外", "不算"):
                yield f"{label}为{raw}<REJECT>{suffix}</REJECT>"
                yield f"查{label}是{raw}<REJECT>{suffix}</REJECT>的患者"
            for prefix in ("除了", "不含", "除开", "不要", "排除"):
                yield f"<REJECT>{prefix}</REJECT>{label}为{raw}的患者"

    for _ in range(160):
        left, right = rng.sample(list(fields), 2)
        a, b = rng.choice(fields[left]), rng.choice(fields[right])
        yield f"只看{left}为{tag(left, a)}、{right}是{tag(right, b)}的患者"
        yield f"{left}填写{tag(left, a)}，{right}是{b}<REJECT>以外</REJECT>的患者"
        yield f"{left}为{a}<REJECT>之外</REJECT>，同时{right}为{tag(right, b)}"
        yield f"{left}是{tag(left, a)}，{right}<REJECT>别包括</REJECT>{b}"


def punctuation_and_type_samples():
    rng = random.Random(1139)
    initials = ["GY", "KZM", "YL", "NYL", "QS", "YC", "FXD", "ZQ"]
    names = ["郝溪", "虞萍", "齐元青", "冯晓冬", "程青瑜"]
    departments = ["神经内科", "老年康复科", "胸外科", "眼科", "疼痛科", "内分泌科"]

    def tag(label, value):
        key = FIELD_IDS[label]
        return f"<{key}>{value}</{key}>"

    for raw in initials:
        initial = tag("拼音首字母", raw)
        for mark in (",", "，", "、", "；", "。"):
            person = tag("物理师", rng.choice(names))
            yield f"拼音首字母是{initial}{mark}且物理师为{person}的患者"
            yield f"找拼音首字母为{initial}{mark}请按患者显示"
            yield f"拼音首字母填写{initial}{mark}"
        yield raw
        yield f"备注出现了{raw}这个缩写"

    for label, values in {
        "吸烟史": ("从不吸烟", "从来不吸烟", "偶尔吸烟", "从未吸烟", "目前不吸烟", "已戒烟"),
        "饮酒史": ("从不饮酒", "偶尔饮酒", "从未饮酒", "目前不饮酒", "已戒酒"),
        "签名方式": ("手写签名", "电子签名", "本人纸质签名", "代签"),
    }.items():
        for raw in values:
            marked = tag(label, raw)
            for verb in ("填了", "填写", "是", "记录为", "登记为"):
                yield f"筛出{label}{verb}{marked}的患者"
                yield f"帮我找{label}{verb}{marked}的患者"
                yield f"只查{label}{verb}{marked}"
                yield f"查{label}{verb}{marked}，主诊医生是{tag('主诊医生', rng.choice(names))}的患者"
            yield f"{label}为{raw}<REJECT>之外</REJECT>的患者"
            yield f"备注中提到{raw}"
    for raw in ("治疗", "测试", "科研"):
        patient_type = tag("患者类型", raw)
        for value in departments:
            department = tag("住院科室", value)
            doctor = tag("主诊医生", rng.choice(names))
            yield f"选{patient_type}患者，住院科室是{department}"
            yield f"只看{patient_type}患者，在{department}住院"
            yield f"找{patient_type}类型的病人，住院科室填{department}"
            yield f"筛{patient_type}患者，同时住院科室登记为{department}"
            yield f"给我{patient_type}的患者，且由{doctor}主诊"
            yield f"找{patient_type}患者，{department}住院且主诊医生是{doctor}"
            yield f"查{department}住院的{patient_type}患者"
            yield f"选{patient_type}患者，<REJECT>排除</REJECT>在{value}住院的人"
        yield f"备注提到{raw}患者"
        yield f"搜索{raw}相关记录"


def intent(spans):
    if any(field == "REJECT" for _, _, field in spans):
        return "REVIEW"
    return f"FILTER{len(spans)}" if spans else "KEYWORD"


HOLDOUT = [
    "主诊医生是<DOCTOR>颜艳</DOCTOR>",
    "颜艳",
    "主诊医生<REJECT>并非</REJECT>颜艳",
    "请帮我筛出主诊医生是<DOCTOR>赵嘉</DOCTOR>的患者",
    "哪些患者是在<DEPARTMENT>康复医学科</DEPARTMENT>住院的",
    "麻烦只看<SEX>男性</SEX>患者",
    "我想查<DOCTOR>周雨桐</DOCTOR>主诊且在<DEPARTMENT>呼吸内科</DEPARTMENT>住院的患者",
    "<DEPARTMENT>消化内科</DEPARTMENT>收治的<SEX>女性</SEX>患者，主诊是<DOCTOR>郑文博</DOCTOR>",
    "主诊医生<REJECT>不包括</REJECT>赵嘉的患者",
    "想找<REJECT>刘医生</REJECT>担任主诊的患者",
    "赵嘉",
    "找<DOCTOR>赵嘉</DOCTOR>主诊、在<DEPARTMENT>放疗科</DEPARTMENT>住院的患者",
    "赵嘉在备注里提到了呼吸内科",
    "查主诊医生为<DOCTOR>周雨桐</DOCTOR>，但<REJECT>别选</REJECT>住院科室是呼吸内科的患者",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--typed-catalog", action="store_true")
    parser.add_argument("--contrast", action="store_true")
    parser.add_argument("--boundaries", action="store_true")
    parser.add_argument("--punctuation-and-type", action="store_true")
    parser.add_argument("--patient-snapshot", type=Path)
    parser.add_argument("--learning-rate", type=float, default=5e-5)
    args = parser.parse_args()
    torch.manual_seed(313)
    torch.set_num_threads(6)
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    tokenizer = AutoTokenizer.from_pretrained(args.base, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(
        args.base, local_files_only=True, id2label=dict(enumerate(LABELS)),
        label2id={label: i for i, label in enumerate(LABELS)},
    ).to(device)
    training = [*samples(), *intent_samples()]
    if args.typed_catalog:
        training.extend(catalog_samples())
    if args.contrast:
        training.extend(contrast_samples())
    if args.patient_snapshot:
        training.extend(snapshot_samples(args.patient_snapshot))
    if args.boundaries:
        training.extend(boundary_samples())
    if args.punctuation_and_type:
        training.extend(punctuation_and_type_samples())
    rows = [annotate(row) for row in dict.fromkeys(training)]
    print(f"Training examples: {len(rows)}", flush=True)
    batch = tokenizer([row[0] for row in rows], padding=True, return_offsets_mapping=True, return_tensors="pt")
    offsets = batch.pop("offset_mapping").tolist()
    all_labels = []
    for positions, (_, spans) in zip(offsets, rows):
        labels = []
        for a, b in positions:
            span = next((span for span in spans if a < span[1] and b > span[0]), None)
            labels.append(-100 if a == b else LABELS.index(f"{'B' if a <= span[0] else 'I'}-{span[2]}") if span else 0)
        labels[0] = LABELS.index(intent(spans))
        all_labels.append(labels)
    batch["labels"] = torch.tensor(all_labels)
    optim = torch.optim.AdamW(model.parameters(), lr=args.learning_rate)
    for epoch in range(args.epochs):
        model.train()
        for ids in torch.randperm(len(rows)).split(16):
            loss = model(**{key: val[ids].to(device) for key, val in batch.items()}).loss
            loss.backward()
            optim.step()
            optim.zero_grad()
        print(f"epoch {epoch + 1}/{args.epochs}", flush=True)
    model.save_pretrained(args.output)
    tokenizer.save_pretrained(args.output)
    model.eval()
    report = []
    for template in HOLDOUT:
        text, expected = annotate(template)
        inputs = tokenizer(text, return_offsets_mapping=True, return_tensors="pt")
        positions = inputs.pop("offset_mapping")[0].tolist()
        with torch.inference_mode():
            labels = model(**inputs.to(device)).logits[0].argmax(-1).tolist()
        actual = []
        for (a, b), label in zip(positions, labels):
            if a == b or "-" not in LABELS[label]:
                continue
            prefix, field = LABELS[label].split("-")
            if prefix == "I" and actual and actual[-1][2] == field and not text[actual[-1][1]:a].strip():
                actual[-1] = (actual[-1][0], b, field)
            else:
                actual.append((a, b, field))
        report.append({"text": text, "expected": expected, "actual": actual, "expectedIntent": intent(expected), "actualIntent": LABELS[labels[0]], "exact": expected == actual and intent(expected) == LABELS[labels[0]]})
    (args.output / "holdout-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(f"Exact holdout matches: {sum(row['exact'] for row in report)}/{len(report)}")


if __name__ == "__main__":
    main()
