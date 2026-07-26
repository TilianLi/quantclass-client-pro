# Quantclass Client — AI Agent 开发指南

> 本文档面向需要阅读、修改或扩展 `quantclass-client-pro` 的 AI 编码助手。以下内容均基于项目实际文件，不臆测、不泛化。

## 1. 项目概览

`QuantclassClient`（量化小讲堂客户端）是一款面向量化交易的桌面端 Electron 应用，当前版本 `4.1.0`。它封装了股票数据下载、策略管理、回测、实时数据、实盘交易等能力，并通过 MCP（Model Context Protocol）向外部 AI 客户端暴露本地 API。

- **产品名称**：QuantclassClient
- **技术主线**：Electron + React + TypeScript + Vite
- **仓库地址**：`http://gitlab.quantclass.cn/quantclass_private/download-react.git`
- **官网**：`https://www.quantclass.cn/home`
- **授权许可**：Business Source License 1.1 (BUSL-1.1)，Change Date 2028-08-22，到期后自动转为 GPL-3.0-or-later。生产用途、SaaS/托管、再分发需另行获得商业授权（详见 `LICENSE` 与 `README.md`）。

## 2. 技术栈

### 2.1 核心运行时

| 层级 | 技术 |
|------|------|
| 桌面壳 | Electron 39 + electron-vite 3 |
| 前端框架 | React 18 + TypeScript 5.7 |
| 构建工具 | Vite 5 + esbuild（MCP bundle） |
| 路由 | react-router 7（HashRouter） |
| 状态管理 | jotai + @tanstack/react-query |
| UI 组件 | shadcn/ui（New York）+ Radix UI + HeroUI + TailwindCSS 3 |
| 图表 | recharts |
| 编辑器 | Monaco Editor（@monaco-editor/react） |
| 本地存储 | electron-store |
| 日志 | electron-log + winston（winston-daily-rotate-file） |
| 内嵌 Python | 下载到 `resources/python/${arch}`，用于解析用户 `config.py` |
| 本地 HTTP 服务 | Hono 4.10（@hono/node-server） |
| 数据库 | better-sqlite3（Drizzle ORM / Drizzle Kit，配置见 `drizzle.config.ts`） |
| MCP SDK | @modelcontextprotocol/sdk |
| 校验 | zod（含 drizzle-zod、@hookform/resolvers） |

### 2.2 关键原生依赖

- `better-sqlite3`：SQLite 数据库（构建时 external，见 `electron.vite.config.ts`）。
- `etc-csv-napi`：CSV 解析原生模块。
- `archiver` / `adm-zip`：打包/解包。
- `node-machine-id`、`node-schedule`：机器标识与定时任务。

## 3. 代码组织

项目采用标准的 Electron 多进程结构，源码位于 `src/`。

```text
src/
├── main/                 # 主进程（Node.js + Electron）
│   ├── index.ts          # 应用入口：单例锁、IPC 注册、迁移、窗口、Hono 服务
│   ├── app-lifecycle.ts  # 生命周期、遥测定时器
│   ├── config.ts         # 主进程常量（默认数据路径、日志文件名等）
│   ├── error-handlers.ts # 全局错误处理
│   ├── vars.ts           # 全局变量
│   ├── core/             # 业务核心：dataList、product、runpy、strategy/
│   ├── lib/              # 工具库：WindowManager、db-manager、scheduler、tray、updater、
│   │                     #   tokenStore、userStore、repoManage、telemetry、startup-check 等
│   ├── migration/        # 数据库迁移（runner.ts + migrations/）
│   ├── pythonRunner.ts   # 调用内嵌 Python 解析 config.py
│   ├── request/          # 后端 API 请求封装
│   ├── server/           # Hono 本地 HTTP 服务
│   │   ├── index.ts      # 路由总入口
│   │   ├── controllers/  # 控制器（mcp、notify、product、error、toast）
│   │   ├── middleware/   # 中间件（db、error）
│   │   ├── schema/       # Drizzle schema
│   │   ├── types/        # Hono Env 类型
│   │   └── heartbeat.ts  # 心跳
│   ├── store/            # electron-store 封装
│   └── utils/            # 通用工具函数
├── preload/              # 预加载脚本（安全桥接，contextIsolation 开启）
│   ├── index.ts          # 统一 exposeInMainWorld
│   └── */                # 按领域分 IPC：auth、core、data、emitter、file-sys、kernel-log、
│                         #   mcp、migration、notification、real-trading-backup、repo、
│                         #   startup-check、store、strategy、system、user、windows
├── renderer/             # 渲染进程（React UI）
│   ├── main.tsx / app.tsx
│   ├── index.html、terminal.html   # 两个入口页面
│   ├── page/             # 页面：home、data、data-section、realtime-data、strategy、
│   │                     #   strategy-library-hub、library、backtest、trading、
│   │                     #   trading-section、position、research、research-section、
│   │                     #   settings、subscription、FAQ
│   ├── components/       # 组件（ui/ 为 shadcn 组件）
│   ├── hooks/、context/、store/、layout/、lib/、request/、schemas/、types/、utils/
│   ├── ipc/、constant/、registry/、entry/、icons/、docs/
│   └── global.css、index.css、themes.css、mdx.css、worker.ts
├── mcp-server/           # 独立 MCP Server（stdio 模式）
│   ├── index.ts          # MCP Server 入口
│   ├── tools.ts          # 注册 tools（42 个）
│   ├── resources.ts      # 注册 resources（2 个）
│   ├── client.ts         # 连接 Hono 服务的 HTTP 客户端
│   ├── paths.ts          # 路径解析与穿越校验
│   ├── backtest-evaluator.ts、strategy-files.ts、strategy-validator.ts、factor-check.ts、
│   ├── review-submitter.ts、research-run.ts、backtest-diagnostics.ts、validation-gate.ts、
│   │   walkforward-eval.ts
└── shared/               # 跨进程共享类型（main/preload/renderer 均可引用，见 shared/README.md）
    ├── lib/、types/
    └── constants.ts
```

### 3.1 关键构建产物

- `out/`：electron-vite 输出（main、preload、renderer）。
- `resources/mcp-server/index.js`：`pnpm build:mcp` 用 esbuild 打包的 MCP Server。
- `resources/python/${arch}/`：内嵌 Python 运行时（通过 `pnpm download-python` 下载）。
- `dist/`：electron-builder 最终安装包。

### 3.2 仓库根目录其他值得注意的内容

- `workspace/agent-strategies/`：默认的 AI 策略工作区（可被 `QUANTCLASS_AGENT_WORKSPACE` 覆盖），MCP 策略文件读写限定在此目录内。注意实际生效的工作区可能不在仓库内（例如被覆盖为 `S:\Quantclass\workspace\agent-strategies`），以 `get_strategy_workspace_root` 的返回为准；仓库内目录里可能只有历史 demo run。
- `quantclass-strategy-fetch/`：一个面向 AI Agent 的技能目录（`SKILL.md` + `scripts/` + `references/`），描述"从官网下载分享会策略并导入客户端"的完整工作流，供外部 Agent 加载使用。
- `build_variants.py` / `downloads/`：配合上述技能使用的辅助脚本与工作目录（生成可导入的 `config.py` 变体）。
- `mcp-deploy/`：MCP Server 部署模板与说明（`mcp-config.template.json`）。
- `bin/`：`rebuild.js`（原生模块重建）、`remove.js` / `notarize.js`（electron-builder 钩子）。
- `scripts/`：构建与校验脚本（下载 Python、打包 MCP bundle、校验 tool 注册等）。

## 4. 开发与构建命令

项目使用 **pnpm**，Node.js 要求 `>=22`。`pnpm-workspace.yaml` 将根目录声明为唯一 workspace，并通过 `onlyBuiltDependencies` 控制需要构建的原生依赖。`postinstall` 会执行 `electron-builder install-app-deps`。

### 4.1 首次准备

```bash
pnpm install
pnpm download-python          # Windows：下载当前 arch 的 Python 到 resources/python
pnpm download-python:mac      # macOS：下载 arm64 + x64
```

### 4.2 开发

```bash
pnpm dev:win                  # Windows 开发（chcp 65001 设置 UTF-8 编码）
pnpm dev                      # 通用开发（先清理 node_modules/.vite）
pnpm dev:watch                # watch 模式
pnpm start                    # electron-vite preview
```

### 4.3 构建

```bash
pnpm build                    # electron-vite build（开发/生产取决于 VITE_XBX_ENV）
pnpm build:win                # Windows 完整打包（下载 Python + build:mcp + build + electron-builder）
pnpm build:win:beta           # beta 包脚本（scripts/build-win-beta.cjs），文件名带时间戳
pnpm build:windev             # Windows 开发环境打包
pnpm build:mac                # macOS 双架构打包
pnpm build:linux              # Linux 打包
pnpm build:unpack             # 只生成目录，不打包安装包
pnpm build:mcp                # 打包 MCP Server 到 resources/mcp-server/index.js（esbuild，node22，ESM）
```

### 4.4 发布

```bash
pnpm publish:win
pnpm publish:mac
pnpm publish:linux
```

### 4.5 类型检查

```bash
pnpm typecheck:node           # 主进程 + preload（tsconfig.node.json）
pnpm typecheck:web            # 渲染进程（tsconfig.web.json）
pnpm typecheck                # 全部
```

### 4.6 原生模块重建

```bash
pnpm rebuild                  # 执行 bin/rebuild.js，按需重建 better-sqlite3 / etc-csv-napi
```

### 4.7 校验脚本

```bash
pnpm verify:mcp-tools         # 校验 MCP tool 注册（scripts/verify-mcp-tool-registration.mjs）
```

## 5. MCP（Model Context Protocol）集成

项目包含一个独立的 MCP Server，AI 客户端可通过 stdio 连接并调用本地能力。

### 5.1 运行方式

1. 先启动 QuantClass 客户端一次，主进程会在 `~/.quantclass/mcp-port` 写入实际端口，并在 `~/.quantclass/mcp-token` 写入鉴权 token。
2. AI 客户端配置指向 `resources/mcp-server/index.js`（开发产物）或安装包内的 `resources/mcp-server/index.js`。
3. MCP Server 通过 HTTP 访问本地 Hono 服务（默认 `127.0.0.1:8787`），端口优先级：`QUANTCLASS_PORT` 环境变量 > `~/.quantclass/mcp-port` > 默认 8787。

详细配置参考 `mcp-deploy/README.md` 与 `mcp-deploy/mcp-config.template.json`。

### 5.2 Tool 分组

当前 MCP Server 共注册 **42 个 tools**（`src/mcp-server/tools.ts`），分组如下：

- **系统控制（7 个）**：
  - `get_system_status`：获取系统运行状态
  - `toggle_min_data_schedule`：启停分钟线数据定时任务
  - `exec_min_data`：手动执行一次分钟线数据获取
  - `get_trading_config`：读取交易配置
  - `update_trading_config`：更新交易配置（field 支持 dot-key）
  - `toggle_auto_trading`：启停自动交易
  - `toggle_history_update`：启停历史数据更新

- **实盘数据查询（5 个）**：
  - `get_buy_signals`：买入信号列表
  - `get_sell_signals`：卖出信号列表
  - `get_stock_timing_plans`：个股择时买入/卖出计划
  - `get_account_info`：账户信息
  - `get_trading_info`：Aqua 交易信息

- **回测工具（10 个）**：
  - `get_backtest_config`：回测配置
  - `set_backtest_config`：设置回测配置
  - `run_backtest`：执行回测（含产物校验，响应带内核版本/耗时/产物路径）
  - `run_backtest_async`：异步执行回测（返回 taskId）
  - `get_backtest_task`：查询异步回测任务状态与日志尾部
  - `run_walkforward`：多窗口串行回测（walk-forward 稳健性检查）
  - `get_backtest_result`：回测选股结果
  - `get_backtest_performance`：回测绩效指标（含 parsed 数值字段）
  - `get_backtest_equity_curve`：回测资金曲线
  - `get_backtest_diagnostics`：回测诊断（基于资金曲线计算分年度收益与回撤区间，供 lesson 归因）

- **策略开发闭环（13 个）**：
  - `get_strategy_template`：获取策略开发模板（含可用因子清单）
  - `import_strategy`：导入策略
  - `set_strategy_weight`：设置库内策略组资金占比（单个/批量/一键隔离，三层同步）
  - `list_library_strategies`：列出库内策略组名称与权重
  - `get_strategy_workspace_root`：获取策略工作区根目录
  - `list_strategies`：列出策略 run/variant
  - `read_strategy_file`：读取策略文件
  - `write_strategy_file`：写入策略文件
  - `write_factor_file`：写入自定义因子（时序/截面，AST 白名单静态检查后落盘，自动补 __init__.py）
  - `validate_strategy`：校验 config.py
  - `evaluate_backtest`：评估多次回测结果（最优选择语义：score→年化→低复杂度）
  - `compare_backtest_variants`：按阈值对比多个 variant 绩效并返回最优
  - `submit_strategy_for_review`：生成候选策略报告等待人工确认

- **研究工作流（7 个）**：
  - `create_research_run`：创建研究 run（brief.json：目标、阈值、回测区间、进化轮数；可选 walkforward 多窗口配置）
  - `record_experiment`：追加实验记录到 trace.jsonl（支持 fromLatestBacktest 自动抓绩效与内核版本；verdict/complexity 缺省自动判定与统计；entry.type 区分 dev/validation；brief 含 evolving_n 时返回迭代预算。brief 配置 walkforward 后，带绩效的 dev 条目会被拦截并导向 run_dev_walkforward，仅放行无绩效的失败记录）
  - `get_experiment_trace`：读取实验 trace（支持 tail 截断）
  - `get_run_summary`：汇总实验数、SOTA、validation 结果、阈值差距与指标趋势
  - `run_dev_walkforward`：dev 迭代的 walkforward 稳健性检验（读 brief.walkforward.windows→快照回测配置→逐窗口回测并评估→恢复原配置→按最劣窗口口径汇总写入 type=dev 的 trace 条目，消耗 1 轮迭代预算；失败窗口 score 计 0，全部失败不写 trace）
  - `run_validation`：启动 validation 闸门（快照当前回测配置→切到 brief.validation 窗口→异步回测）
  - `complete_validation`：完成 validation 闸门（恢复原回测配置→记录 type=validation 的样本外结果）

> 指标命名约定：`calmar_ratio`（年化收益/最大回撤，Calmar 口径）是规范字段名；`sharpe_ratio` 是历史误名，作为兼容别名在输入输出中保留，新代码与 brief/threshold 应使用 `calmar_ratio`。SOTA 语义在 `evaluate_backtest`、`compare_backtest_variants`、`get_run_summary`、`record_experiment` 四处统一：先比达标率 score，同分比年化收益，再同分比低复杂度。

### 5.3 Resources

当前注册 **2 个 resources**（`src/mcp-server/resources.ts`）：

- `quantclass://status`：系统状态快照（等价 `get_system_status`）
- `quantclass://config/trading`：交易配置快照（等价 `get_trading_config`）

### 5.4 安全

- 仅监听 `127.0.0.1`，不对外暴露。
- 除 `/mcp/status` 只读状态接口外，其余路由需 `Authorization: Bearer <mcp-token>`。
- 策略文件读写限制在 `QUANTCLASS_AGENT_WORKSPACE`（默认 `workspace/agent-strategies`），并做路径穿越校验（见 `src/mcp-server/paths.ts`）。

## 6. 代码风格与约定

### 6.1 格式化与 lint

- 使用 **Biome**（`@biomejs/biome@1.9.4`）进行格式化和 lint。
- 配置见 `biome.json`：
  - 缩进：`tab`（宽度 2），行宽 80，LF 换行。
  - JavaScript/TypeScript：分号 `asNeeded`、JSX 双引号、`quoteProperties: asNeeded`。
  - `organizeImports` 开启。
  - 规则：`noNonNullAssertion` 关闭、`noExplicitAny` 关闭、`noArrayIndexKey` 关闭、`useExhaustiveDependencies` warn、`noUselessElse` 关闭、`useKeyWithClickEvents` 关闭、`noUnusedImports` info、`useButtonType` warn。
- Git 钩子（`lefthook.yml`）：
  - `pre-commit`（parallel）：对 staged 的 `*.{js,ts,jsx,tsx}` 执行 `biome check --write` 和 `biome format --write`。
  - `commit-msg`：执行 `pnpm commitlint --edit`。

### 6.2 提交规范

- 使用 Conventional Commits（`commitlint.config.js`，extends `@commitlint/config-conventional`），类型枚举：
  `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
- header/body 长度限制已禁用。
- 已配置 commitizen（`cz-conventional-changelog`）辅助提交。
- 外部贡献需按 `CONTRIBUTING.md` 提供 DCO Sign-off。

### 6.3 TypeScript 与路径别名

- `tsconfig.json` 为基础配置（extends `@electron-toolkit/tsconfig`），`tsconfig.node.json` 包含 `src/main`、`src/preload`、`src/shared`，`tsconfig.web.json` 包含 `src/renderer`、`src/shared`，`tsconfig.mcp.json` 包含 `src/mcp-server`。
- 统一路径别名（`electron.vite.config.ts`）：`@/*` 映射到 `src/*`，`@renderer/*` 映射到 `src/renderer/*`，`@/hooks` 和 `@/registry` 映射到渲染进程对应目录。
- 共享类型统一从 `@/shared/types/index.js` 导入，main/preload 中保留 `.js` 扩展名以兼容 Node16/NodeNext 模块解析（用法见 `src/shared/README.md`）。

### 6.4 UI 开发

- 使用 TailwindCSS + shadcn/ui + Radix + HeroUI。
- shadcn/ui 配置见 `components.json`：style 为 `new-york`，CSS 变量模式，baseColor 为 `zinc`。
- 主题变量定义在 `tailwind.config.ts` 与 `src/renderer/global.css`、`themes.css`。
- 中文优先字体栈：`PingFang SC`、`Microsoft YaHei`。
- 渲染进程有两个 HTML 入口：`index.html`（主界面）与 `terminal.html`（终端页），构建时按 manualChunks 拆分 react/charts/icons。

### 6.5 注释与版权

- 新增文件头部建议保留项目版权头：

```typescript
/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */
```

## 7. 测试

测试使用 Node.js 内置测试运行器（`node --test`），通过 `--experimental-strip-types` 直接运行 TypeScript 测试文件。

```bash
pnpm test:mcp                 # 运行 tests/mcp-server/**/*.test.ts
```

当前测试覆盖（`tests/mcp-server/`，共 12 个测试文件）：

- `sanity.test.ts`
- `paths.test.ts`
- `backtest-evaluator.test.ts`
- `backtest-diagnostics.test.ts`
- `validation-gate.test.ts`
- `strategy-files.test.ts`
- `strategy-validator.test.ts`
- `factor-check.test.ts`
- `tools.test.ts`
- `review-submitter.test.ts`
- `research-run.test.ts`
- `walkforward-eval.test.ts`

新增业务逻辑（尤其是 MCP Server 下的纯函数）应补充对应测试。

## 8. 安全注意事项

- **contextIsolation**：已启用；渲染进程通过 preload 暴露的 `electronAPI` 与主进程通信，不要直接在 renderer 中引入 Node/Electron 模块。
- **CSP**：`src/renderer/index.html` 已设置 Content-Security-Policy。
- **路径安全**：文件系统操作（MCP、策略导入等）需校验路径，禁止穿越到工作区之外。
- **Token 安全**：MCP token 写入用户 home 目录 `~/.quantclass/mcp-token`，避免硬编码或日志打印。
- **内嵌 Python**：仅用于解析本地 `config.py`（`resources/parse_config.py`）与因子静态检查（`resources/check_factor.py`），不要执行任意用户输入。
- **自动交易**：涉及真实资金的接口（`toggle_auto_trading`、`exec_min_data` 等）需谨慎变更，建议保留显式确认或白名单校验。

## 9. 部署与发布流程

### 9.1 CI/CD

`.github/workflows/build.yml` 在 `main` 分支推送或 `v*.*.*` tag 时触发：

- 在 `windows-latest` 与 `macos-latest` 上分别执行 `pnpm build:win` / `pnpm build:mac`（ubuntu-latest 已在 matrix 中注释掉）。
- 使用 `secrets.GH_TOKEN`，tag 推送时通过 `softprops/action-gh-release` 将 `dist/**` 发布到 GitHub Release。
- 注意：CI 使用 Node 20（`actions/setup-node`），与本地 `engines >=22` 要求不同，以实际可行为准。

### 9.2 构建注意事项

- Windows 打包可能受杀毒软件/Defender 拦截，必要时加白名单；NSIS 长路径问题可通过组策略开启 Win32 long paths（详细排查步骤见 `README.md`）。
- macOS 签名/公证需要本地 `.env.release.local` 环境变量，并手动执行 `xcrun notarytool` 与 `stapler`（命令见 `README.md`）。
- `electron-builder.yml` 中配置了 `extraResources`：Python 运行时、`parse_config.py`、`check_factor.py`、MCP Server bundle、Monaco Editor 资源等；`asarUnpack` 包含 `resources/**`。
- `electron-builder.beta.yml` 用于内测版打包，安装包文件名带 `BUILD_TIMESTAMP` 时间戳后缀。

## 10. 环境变量

开发/构建中常用的环境变量（由 `electron.vite.config.ts` 的 `define` 注入为 `process.env.*`）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_BASE_URL` | 后端 API 基础地址 | `https://api.quantclass.cn` |
| `VITE_XBX_ENV` | 环境标识 | `development` / `production`（缺省取 vite mode） |
| `VITE_APP_VERSION` | 应用版本 | `3.4.0` |

其他常用运行时变量：`QUANTCLASS_PORT`（MCP HTTP 端口覆盖）、`QUANTCLASS_AGENT_WORKSPACE`（策略工作区路径覆盖）。

本地 `.env.template` 示例包含 AWS 密钥与 `VITE_BASE_URL`。CI 构建时通过 `github.ref_name` 注入 `VITE_APP_VERSION`。

## 11. 常见问题排查

- **构建失败**：优先检查网络（Electron 下载较大）、关闭杀毒软件、清理 NSIS 缓存、重启电脑；遇到 `!include` 错误按 `README.md` 开启 Win32 long paths 并删除 `node_modules` 后重启。
- **MCP 连接不上**：确认客户端已启动，`~/.quantclass/mcp-port` 存在且端口正确；检查 token 文件权限。
- **内嵌 Python 找不到**：先执行 `pnpm download-python`。
- **类型检查跨进程报错**：确认文件是否被正确的 `tsconfig.node.json` 或 `tsconfig.web.json` 包含。

## 12. 许可提示

本仓库源码受 BUSL-1.1 约束。AI 助手在生成或修改代码时，应保留文件头版权声明，并避免建议将本项目用于生产部署、SaaS 托管或再分发，除非已获得商业授权。
