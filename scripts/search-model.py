"""Local inference worker. One JSON request and response per line."""

import json
from pathlib import Path
import sys
import unicodedata


def load_bert(model_dir):
    import torch
    from transformers import AutoModelForTokenClassification, AutoTokenizer

    torch.set_num_threads(4)
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True)
    model = AutoModelForTokenClassification.from_pretrained(model_dir, local_files_only=True).eval()

    def predict(request):
        text = unicodedata.normalize("NFKC", request["query"])
        batch = tokenizer(text, return_offsets_mapping=True, truncation=True, max_length=512, return_tensors="pt")
        offsets = batch.pop("offset_mapping")[0].tolist()
        with torch.inference_mode():
            labels = model(**batch).logits[0].argmax(-1).tolist()
        spans = []
        for (start, end), label_id in zip(offsets, labels):
            label = model.config.id2label[label_id]
            if start == end or label == "O":
                continue
            prefix, field = label.split("-", 1)
            if prefix == "I" and spans and spans[-1][0] == field and spans[-1][2] == start:
                spans[-1][2] = end
            else:
                spans.append([field, start, end])
        return [{"field": field, "text": text[start:end]} for field, start, end in spans]

    return predict


def load_reranker(model_dir):
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = Tokenizer.from_file(str(model_dir / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512, strategy="only_second")
    tokenizer.enable_padding(pad_id=1, pad_token="<pad>")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(model_dir / "model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])

    def predict(request):
        tokens = tokenizer.encode_batch([(request["query"], passage) for passage in request["passages"]])
        inputs = {
            "input_ids": np.asarray([token.ids for token in tokens], dtype=np.int64),
            "attention_mask": np.asarray([token.attention_mask for token in tokens], dtype=np.int64),
            "token_type_ids": np.asarray([token.type_ids for token in tokens], dtype=np.int64),
        }
        logits = session.run(None, {item.name: inputs[item.name] for item in session.get_inputs()})[0]
        if logits.shape != (len(tokens), 1):
            raise ValueError("Unexpected reranker output shape")
        return logits[:, 0].tolist()

    return predict


if __name__ == "__main__":
    mode, directory = sys.argv[1:]
    predict = {"bert": load_bert, "reranker": load_reranker}[mode](Path(directory))
    for line in sys.stdin:
        try:
            result = predict(json.loads(line))
            print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
        except Exception:
            print("null", flush=True)
