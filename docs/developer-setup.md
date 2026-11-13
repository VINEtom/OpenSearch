# 在另一台电脑上启动 OIS 搜索

以下命令使用 POSIX shell。在 Windows 上可通过 WSL2 执行。先用虚构数据启动网页，再按需要配置 PMS、EMR 和本地模型。

## 1. 下载代码并启动基础服务

准备 Git、Docker（含 Compose）和 Node.js 22.22.3（见 `.nvmrc`）。启动 Docker 后，在终端执行：

```sh
git clone https://github.com/VINEtom/OpenSearch.git
cd OpenSearch
node --version
docker info
npm ci
[ -f .env ] || cp .env.example .env
npm run infra:up
```

确认 `node --version` 输出 `v22.22.3`，`docker info` 能连接到 Server。使用 Colima 时，应先启动对应 profile，并通过 `docker context use <context>` 选中它。

默认端口 54329、9207、4107、8107 需可用。若要和另一套实例并行，调整 Compose 的宿主机端口、`.env` 中的数据库、OpenSearch 和 API 端口，并同步修改 `web/.umirc.ts` 的代理目标和 `package.json` 的网页端口。

Compose 会启动本机 PostgreSQL（54329）和 OpenSearch（9207）。已有项目时，在自己的开发分支安排同步，并保留原有 `.env`。

## 2. 选择数据来源

- **用虚构数据开发。** 保持 `.env` 中的 `SOURCE_MODE=demo`。在新建的空库中依次运行 `npm run db:init`、`npm run db:seed`、`npm run sync`。
- **连接开发环境的 PMS 和 EMR。** 在 `.env` 设置 `SOURCE_MODE=real`，填入 `REAL_PGHOST`、`REAL_PGPORT`、`REAL_PGUSER`、`REAL_PGPASSWORD`、`REAL_PMS_DATABASE` 和 `REAL_EMR_DATABASE`。使用能读两个开发库的账号，执行 `npm run sync`。

### 更新单据字段内搜索索引

拉取包含字面匹配的代码后，使用上面与本机数据源对应的配置执行 `npm run sync`。同步会创建新批次，校验记录后再切换本机索引别名。新批次会索引单据字段的连续原文，包括超过 512 字符的正文。只重启服务时，旧批次中的长字段仍按短语匹配。

同步完成后打开索引同步状态，确认批次已更新，再用本机有数据的单据验证字段筛选和高亮。若使用与本次验收相同的快照，「找中止原因包含ddd的计划申请单」应返回 3 条，包括字段值为 `dddd` 的记录。

运行 `npm run dev` 后打开 [搜索网页](http://127.0.0.1:8107)，也可以查看 [API 健康状态](http://127.0.0.1:4107/api/prototype/health)和[索引同步状态](http://127.0.0.1:4107/api/prototype/index-status)。基础搜索和同步可以在 `.env` 设置 `SEARCH_MODELS=off`，无需 Python。

## 3. 启用 BERT 和 BGE

在运行 Node 搜索后端的同一台机器或容器准备 Python。本机验证使用 Python 3.13.12。可在 [GitHub Release](https://github.com/VINEtom/OpenSearch/releases/tag/search-models-v1) 下载两套模型及校验文件。把两个压缩包和 `SHA256SUMS.txt` 放在同一目录。下载中断或校验失败时，从 Release 重新下载失败的文件。若 GitHub CLI 下载出现 EOF，可在 Release 页面用浏览器重下该文件，再运行校验。已有 GitHub CLI 时，也可用 `gh release download search-models-v1 -R VINEtom/OpenSearch --pattern <文件名> --dir <下载目录> --clobber` 只重试单个文件。在下载目录校验通过后，再解压到项目内的 `.runtime/models`：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

以下命令从项目根目录运行，将 `/path/to/downloads` 换成实际下载目录：

```sh
python3.13 --version
mkdir -p .runtime/models
tar -xzf /path/to/downloads/ois-bert-checkpoint.tar.gz -C .runtime/models
tar -xzf /path/to/downloads/ois-bge-reranker.tar.gz -C .runtime/models
python3.13 -m venv .runtime/bert-venv
python3.13 -m venv .runtime/bge-venv
.runtime/bert-venv/bin/python -m pip install torch==2.15.0 transformers==5.22.2
.runtime/bge-venv/bin/python -m pip install onnxruntime==1.31.1 numpy==2.5.4 tokenizers==0.23.3
```

在 `.env` 填入以下配置，把 `/abs/path/OpenSearch` 换成项目的绝对路径。若已有 `SEARCH_MODELS=off`，删除该行或改为 `SEARCH_MODELS=on`。

```dotenv
SEARCH_BERT_PYTHON=/abs/path/OpenSearch/.runtime/bert-venv/bin/python
SEARCH_BGE_PYTHON=/abs/path/OpenSearch/.runtime/bge-venv/bin/python
SEARCH_BGE_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/bge-reranker
```

重启 `npm run dev`。搜索后端会按需加载模型。将 `.env` 和包含业务记录的本地快照留在本机。

## 4. 验证模型和网页

先从项目根目录直接检查两个推理脚本能否加载权重：

```sh
printf '%s\n' '{"query":"找成像方式为 CT 的定位申请单"}' |
  .runtime/bert-venv/bin/python scripts/search-model.py bert .runtime/models/bert-checkpoint
printf '%s\n' '{"query":"趴着摆位","passages":["患者俯卧，面朝下","患者仰卧，面朝上"]}' |
  .runtime/bge-venv/bin/python scripts/search-model.py reranker .runtime/models/bge-reranker
```

旧版定位 BERT 的自检输出包含 `MOD` 和 `CT`，该权重可用于离线对照。网页使用下文的患者和单据模型配置。BGE 自检应返回两个数值，俯卧片段分数更高。网页可先用虚构种子的放疗号 `000123` 验证关键词搜索，再使用带独立单据字段的测试批次验证「找成像方式为 CT 的定位申请单」。页面应展示筛选条件及命中字段。看到「需要重新同步搜索数据」时，检查索引批次是否支持单据字段筛选。

## WSL2 x64 离线安装 Python 依赖

在 WSL 终端运行 `uname -m` 和 `python3.13 --version`。离线包适用于输出 `x86_64`、使用 CPython 3.13 的 Linux 发行版，要求 glibc 2.28 或更新版本。如果 WSL 里还没有 Python 3.13，可以从同一个 Release 下载 Astral 的便携 CPython 压缩包 `cpython-3.13.18+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz` 和 `SHA256SUMS-cpython-wsl2.txt`。在下载目录执行 `sha256sum -c SHA256SUMS-cpython-wsl2.txt`，然后在项目根目录解压并把它加到当前终端的 PATH：

```sh
mkdir -p .runtime/python313
tar -xzf /path/to/downloads/cpython-3.13.18+20261026-x86_64-unknown-linux-gnu-install_only.tar.gz -C .runtime/python313
export PATH="$PWD/.runtime/python313/python/bin:$PATH"
python3.13 --version
```

该解释器自带 `venv` 和创建虚拟环境所需的 pip。创建虚拟环境后保留解压目录，因为虚拟环境会引用其中的解释器。原包来自 [Astral 发布页](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)。

从[模型 Release](https://github.com/VINEtom/OpenSearch/releases/tag/search-models-v1)下载 `ois-python-wheels-linux-x86_64-cp313.tar.gz` 和 `SHA256SUMS-linux-x86_64-cp313.txt`，在下载目录校验：

```sh
sha256sum -c SHA256SUMS-linux-x86_64-cp313.txt
```

在项目根目录执行以下命令。将 `/path/to/downloads` 换成实际下载目录：

```sh
mkdir -p .runtime/wheels
tar -xzf /path/to/downloads/ois-python-wheels-linux-x86_64-cp313.tar.gz -C .runtime/wheels
python3.13 -m venv .runtime/bert-venv
python3.13 -m venv .runtime/bge-venv
.runtime/bert-venv/bin/python -m pip install --no-index --find-links .runtime/wheels/bert 'torch==2.15.0+cpu' transformers==5.22.2
.runtime/bge-venv/bin/python -m pip install --no-index --find-links .runtime/wheels/bge onnxruntime==1.31.1 numpy==2.5.4 tokenizers==0.23.3
```

模型权重仍按第 3 节另行下载和解压。安装完成后配置对应的 Python 和模型路径，再运行第 4 节的自检。两个环境均使用 CPU。

## 当前全局搜索的 BERT 权重

从 [OIS Search BERT v4](https://github.com/VINEtom/OpenSearch/releases/tag/ois-search-bert-v4) 下载四个权重包和 `SHA256SUMS-ois-search-bert-v4.txt`，放在同一目录。包内包含患者模型、单据主模型、单据后备模型和诊断模型。四套权重共用 `SEARCH_BERT_PYTHON`。BGE Reranker 按第 3 节安装。

在下载目录执行校验。macOS 可使用 `shasum -a 256 -c SHA256SUMS-ois-search-bert-v4.txt`。

```sh
sha256sum -c SHA256SUMS-ois-search-bert-v4.txt
```

在项目根目录解压，将路径替换为实际下载目录。

```sh
mkdir -p .runtime/models
for model in patient document document-fallback diagnosis; do
  tar -xzf "/path/to/downloads/ois-${model}-bert-v4.tar.gz" -C .runtime/models
done
```

在 `.env` 中配置解压后的绝对路径。两套单据权重各自使用包内的 `labels.json`。单据主模型要求改写时，服务使用后备模型复核。

```dotenv
SEARCH_PATIENT_BERT_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/ois-patient-bert-v4
SEARCH_DOCUMENT_BERT_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/ois-document-bert-v4
SEARCH_DOCUMENT_BERT_FALLBACK_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/ois-document-fallback-bert-v4
SEARCH_DIAGNOSIS_BERT_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/ois-diagnosis-bert-v4
```

重启搜索服务后，可用「主诊医生为颜艳」「找总次数不少于20次的计划申请单」和「诊断名称是C50.9未特指的乳腺恶性肿瘤」检查三个搜索入口。结果数量取决于本机索引批次。

构建执行 `npm run build`。保留同一份 `web/dist` 和对应的服务端源码，启动时可用 `WEB_DIST_DIR` 指向构建产物。集成环境使用独立的 `OPENSEARCH_INDEX_ALIAS` 和 `RUNTIME_DIR`。

明确单条件模型暂不可用时，接口返回 `503 DOCUMENT_MODEL_UNAVAILABLE`，页面提示稍后重试。多个明确字段或模型结果未通过校验时，返回 `400 INVALID_QUERY`。省略单据类型时，单据模型不执行字段筛选。

患者资料和单据搜索由模型提取明确单条件。配置 `SEARCH_DIAGNOSIS_BERT_MODEL_DIR` 指向补训后的诊断权重目录，可在本地验证按确诊日期和索引中的诊断名称找患者。

回归脚本读取测试数据的预期 ID，并验证筛选条件、命中值和错误状态。传入三个使用同一构建的集成实例地址，分别对应边界数据、脱敏快照和缺失模型目录。最后两个参数为边界样本和脱敏快照的预期 JSON。

```sh
node --import tsx scripts/verify-document-bert-release.ts \
  EDGE_URL SNAPSHOT_URL UNAVAILABLE_URL EDGE_FIXTURES SNAPSHOT_EXPECTED
```
