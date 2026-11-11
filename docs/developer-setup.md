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
SEARCH_BERT_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/bert-checkpoint
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

BERT 应返回含 `MOD` 和 `CT` 的 JSON，BGE 应返回两个数值，第一项对应俯卧片段，分数应更高。网页端使用新版 EMR 索引，搜索「找成像方式为 CT、备注里说要趴着摆位的定位申请单」，检查 CT 筛选、BERT 核对标记和「相关正文」。BGE 重排当前页的候选单据。普通虚构种子可用放疗号 `000123` 验证基础搜索，应找到「林示例」。当前种子缺少这一组合查询所需的独立定位字段。看到「需要重新同步搜索数据」时，检查当前索引是否由新版代码从 EMR 同步生成。完整验收见 [集成验收文档](search-integration-next-steps.md)。

已在 macOS ARM64 的全新克隆、独立 Compose 数据卷和新建 Python 虚拟环境验证。普通种子通过网页基础搜索。另用带结构化字段的虚构定位单验证 BERT 核对、BGE 重排和相关正文展示。Linux、WSL2 和真实 EMR 连接未在这次验证中测试。

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

模型权重仍按第 3 节另行下载和解压。安装完成后配置相同的四个模型路径，再运行第 4 节的自检。两个环境均使用 CPU。

## 患者字段 BERT 权重

在另一台电脑拉取最新代码后，从 [患者字段 BERT Release](https://github.com/VINEtom/OpenSearch/releases/tag/patient-bert-v1) 下载 `ois-patient-bert-v1.tar.gz` 和 `SHA256SUMS-patient-bert-v1.txt`。在下载目录执行 `sha256sum -c SHA256SUMS-patient-bert-v1.txt`。macOS 可用 `shasum -a 256 -c SHA256SUMS-patient-bert-v1.txt`。然后从项目根目录解压。

```sh
mkdir -p .runtime/models
tar -xzf /path/to/downloads/ois-patient-bert-v1.tar.gz -C .runtime/models
```

在 `.env` 增加下面一行，并把路径换成项目的绝对路径。患者字段模型复用上文的 `SEARCH_BERT_PYTHON` 和 Python 依赖。重启搜索服务后，用「主诊医生为颜艳」检查页面是否显示实际筛选条件。

```dotenv
SEARCH_PATIENT_BERT_MODEL_DIR=/abs/path/OpenSearch/.runtime/models/patient-bert-v1
```
