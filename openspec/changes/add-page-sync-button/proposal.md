## Why

更新搜索数据现在只能在项目根目录执行 `npm run sync`。页面只显示同步时间和说明，操作的人要离开网页才能发起同步。

## What Changes

- 在同步状态条提供「同步数据」按钮，调用与命令行相同的全量同步。
- 同步进行中按钮不可再次点击。成功后沿用现有「数据已更新」提示，不自动替换当前结果。失败时保留上一批完整数据并显示原因。
- 命令行同步保留。

## Capabilities

### Modified Capabilities

- `ois-global-search`：可以从页面发起手动全量同步。

## Impact

搜索后端增加 `POST /api/prototype/sync`。页面同步说明改为先介绍按钮，命令行作为同一操作的另一种入口。
