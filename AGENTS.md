# Quantclass Client — AI Agent 开发指南

> 本文档面向需要阅读、修改或扩展 `quantclass-client-pro` 的 AI 编码助手。以下内容均基于项目实际文件，不臆测、不泛化。

## 1. 项目概览

`QuantclassClient`（量化小讲堂客户端）是一款面向量化交易的桌面端 Electron 应用，当前版本 `3.6.6`。它封装了股票数据下载、策略管理、回测、实时数据、实盘交易等能力，并通过 MCP（Model Context Protocol）向外部 AI 客户端暴露本地 API。

- **产品名称**：QuantclassClient
- **技术主线**：Electron + React + TypeScript + Vite
- **仓库地址**：`http://gitlab.quantclass.cn/quantclass_private/download-react.git`
- **官网**：`https://www.quantclass.cn/home`
- **授权许可**：Business Source License 1.1 (BUSL-1.1)，Change Date 2028-08-22，到期后自动转为 GPL-3.0-or-later。生产用途、SaaS/托管、再分发需另行获得商业授权。

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
| 本地存储 | electron-store |
| 日志 | electron-log + winston |
| 内嵌 Python | 下载到 `resources/python/${arch}`，用于解析用户 `config.py` |
| 本地 HTTP 服务 | Hono 4.10 |
| 数据库 | better-sqlite3（Drizzle ORM / Drizzle Kit） |
| MCP SDK | @modelcontextprotocol/sdk |

### 2.2 关键原生依赖

- `better-sqlite3`：SQLite 数据库。
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
│   ├── core/             # 业务核心：策略、数据列表、运行 Python、产品等
│   ├── lib/              # 工具库：窗口管理、数据库、调度器、托盘、更新等
│   ├── migration/        # 数据库迁移脚本
│   ├── pythonRunner.ts   # 调用内嵌 Python 解析 config.py
│   ├── request/          # 后端 API 请求封装
│   ├── server/           # Hono 本地 HTTP 服务
│   │   ├── index.ts      # 路由总入口
│   │   ├── controllers/  # 控制器（mcp、notify、product、error、toast、heartbeat）
│   │   ├── middleware/   # 中间件（db、error）
│   │   ├── schema/       # Drizzle schema
│   │   └── types/        # Hono Env 类型
│   ├── store/            # electron-store 封装
│   └── utils/            # 通用工具函数
├── preload/              # 预加载脚本（安全桥接）
│   ├── index.ts          # 统一 exposeInMainWorld
│   └── */                # 按领域分 IPC：auth、core、data、file-sys、kernel-log、mcp…
├── renderer/             # 渲染进程（React UI）
│   ├── main.tsx / app.tsx
│   ├── page/             # 页面：home、data、realtime-data、strategy、library、backtest、trading、position、settings、FAQ、subscription
│   ├── components/       # 组件（ui/ 为 shadcn 组件）
│   ├── hooks/、context/、store/、types/、utils/
│   ├── index.html、terminal.html
│   └── constant/、ipc/
├── mcp-server/           # 独立 MCP Server（stdio 模式）
│   ├── index.ts          # MCP Server 入口
│   ├── tools.ts          # 注册 tools
│   ├── resources.ts      # 注册 resources
│   ├── client.ts         # 连接 Hono 服务的 HTTP 客户端
│   ├── backtest-evaluator.ts、strategy-files.ts、strategy-validator.ts、review-submitter.ts
└── shared/               # 跨进程共享类型（main/preload/renderer 均可引用）
    ├── lib/、types/
    └── constants.ts
```

### 3.1 关键构建产物

- `out/`：electron-vite 输出（main、preload、renderer）。
- `resources/mcp-server/index.js`：`build:mcp` 用 esbuild 打包的 MCP Server。
- `resources/python/${arch}/`：内嵌 Python 运行时（通过 `pnpm download-python` 下载）。
- `dist/`：electron-builder 最终安装包。

## 4. 开发与构建命令

项目使用 **pnpm**，Node.js 要求 `>=22`。`pnpm-workspace.yaml` 将根目录声明为唯一 workspace，`pnpm-workspace.yaml` 中通过 `onlyBuiltDependencies` 控制需要构建的原生依赖。

### 4.1 首次准备

```bash
pnpm install
pnpm download-python          # Windows：下载当前 arch 的 Python 到 resources/python
pnpm download-python:mac      # macOS：下载 arm64 + x64
```

### 4.2 开发

```bash
pnpm dev:win                  # Windows 开发（设置 UTF-8 编码）
pnpm dev                      # 通用开发
pnpm dev:watch                # watch 模式
```

### 4.3 构建

```bash
pnpm build                    # electron-vite build（开发/生产取决于 VITE_XBX_ENV）
pnpm build:win                # Windows 完整打包（下载 Python + build:mcp + build + electron-builder）
pnpm build:win:beta           # beta 包脚本，文件名带时间戳
pnpm build:windev             # Windows 开发环境打包
pnpm build:mac                # macOS 双架构打包
pnpm build:linux              # Linux 打包
pnpm build:unpack             # 只生成目录，不打包安装包
pnpm build:mcp                # 打包 MCP Server 到 resources/mcp-server/index.js
```

### 4.4 发布

```bash
pnpm publish:win
pnpm publish:mac
pnpm publish:linux
```

### 4.5 类型检查

```bash
pnpm typecheck:node           # 主进程 + preload
pnpm typecheck:web            # 渲染进程
pnpm typecheck                # 全部
```

### 4.6 原生模块重建

```bash
pnpm rebuild                  # 执行 bin/rebuild.js，按需重建 better-sqlite3 / etc-csv-napi
```

## 5. MCP（Model Context Protocol）集成

项目包含一个独立的 MCP Server，AI 客户端可通过 stdio 连接并调用本地能力。

### 5.1 运行方式

1. 先启动 QuantClass 客户端一次，主进程会在 `~/.quantclass/mcp-port` 写入实际端口，并在 `~/.quantclass/mcp-token` 写入鉴权 token。
2. AI 客户端配置指向 `resources/mcp-server/index.js`（开发产物）或安装包内的 `resources/mcp-server/index.js`。
3. MCP Server 通过 HTTP 访问本地 Hono 服务（默认 `127.0.0.1:8787`），端口优先级：`QUANTCLASS_PORT` 环境变量 > `~/.quantclass/mcp-port` > 默认 8787。

详细配置参考 `mcp-deploy/README.md` 与 `mcp-deploy/mcp-config.template.json`。

### 5.2 Tool 分组

当前 MCP Server 共注册 **27 个 tools**，分组如下：

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

- **回测工具（6 个）**：
  - `get_backtest_config`：回测配置
  - `set_backtest_config`：设置回测配置
  - `run_backtest`：执行回测
  - `get_backtest_result`：回测选股结果
  - `get_backtest_performance`：回测绩效指标
  - `get_backtest_equity_curve`：回测资金曲线

- **策略开发闭环（9 个）**：
  - `get_strategy_template`：获取策略开发模板
  - `import_strategy`：导入策略
  - `get_strategy_workspace_root`：获取策略工作区根目录
  - `list_strategies`：列出策略 run/variant
  - `read_strategy_file`：读取策略文件
  - `write_strategy_file`：写入策略文件
  - `validate_strategy`：校验 config.py
  - `evaluate_backtest`：评估多次回测结果
  - `submit_strategy_for_review`：生成候选策略报告等待人工确认

### 5.3 Resources

当前注册 **2 个 resources**：

- `quantclass://status`：系统状态快照（等价 `get_system_status`）
- `quantclass://config/trading`：交易配置快照（等价 `get_trading_config`）

### 5.4 安全

- 仅监听 `127.0.0.1`，不对外暴露。
- 除 `/mcp/status` 只读状态接口外，其余路由需 `Authorization: Bearer <mcp-token>`。
- 策略文件读写限制在 `QUANTCLASS_AGENT_WORKSPACE`（默认 `workspace/agent-strategies`），并做路径穿越校验。

## 6. 代码风格与约定

### 6.1 格式化与 lint

- 使用 **Biome**（`@biomejs/biome@1.9.4`）进行格式化和 lint。
- 配置见 `biome.json`：
  - 缩进：`tab`，行宽 80，LF 换行。
  - TypeScript：分号 `asNeeded`、JSX 双引号。
  - 规则：`noNonNullAssertion` 关闭、`noExplicitAny` 关闭、`noArrayIndexKey` 关闭、`useExhaustiveDependencies` warn、`noUselessElse` 关闭、`useKeyWithClickEvents` 关闭。
- Git 提交前钩子（`lefthook.yml`）会自动对 staged 文件执行 `biome check --write` 和 `biome format --write`。

### 6.2 提交规范

- 使用 Conventional Commits，类型枚举见 `commitlint.config.js`：
  `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、`ci`、`chore`、`revert`。
- header/body 长度限制已禁用。
- 外部贡献需按 `CONTRIBUTING.md` 提供 DCO Sign-off。

### 6.3 TypeScript 与路径别名

- `tsconfig.json` 为基础配置，`tsconfig.node.json` 包含 `src/main`、`src/preload`、`src/shared`，`tsconfig.web.json` 包含 `src/renderer`、`src/shared`，`tsconfig.mcp.json` 包含 `src/mcp-server`。
- 统一路径别名：`@/*` 映射到 `src/*`，`@renderer/*` 映射到 `src/renderer/*`，`@/hooks` 和 `@/registry` 映射到渲染进程对应目录。
- 共享类型统一从 `@/shared/types/index.js` 导入，main/preload 中保留 `.js` 扩展名以兼容 Node16/NodeNext 模块解析。

### 6.4 UI 开发

- 使用 TailwindCSS + shadcn/ui + Radix + HeroUI。
- shadcn/ui 配置见 `components.json`：style 为 `new-york`，CSS 变量模式，baseColor 为 `zinc`。
- 主题变量定义在 `tailwind.config.ts` 与 `src/renderer/global.css`。
- 中文优先字体栈：`PingFang SC`、`Microsoft YaHei`。

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

当前测试覆盖：

- `tests/mcp-server/sanity.test.ts`
- `tests/mcp-server/backtest-evaluator.test.ts`
- `tests/mcp-server/strategy-files.test.ts`
- `tests/mcp-server/strategy-validator.test.ts`
- `tests/mcp-server/tools.test.ts`
- `tests/mcp-server/review-submitter.test.ts`

新增业务逻辑（尤其是 MCP Server 下的纯函数）应补充对应测试。

## 8. 安全注意事项

- **contextIsolation**：已启用；渲染进程通过 preload 暴露的 `electronAPI` 与主进程通信，不要直接在 renderer 中引入 Node/Electron 模块。
- **CSP**：`src/renderer/index.html` 已设置 Content-Security-Policy。
- **路径安全**：文件系统操作（MCP、策略导入等）需校验路径，禁止穿越到工作区之外。
- **Token 安全**：MCP token 写入用户 home 目录 `~/.quantclass/mcp-token`，避免硬编码或日志打印。
- **内嵌 Python**：仅用于解析本地 `config.py`，不要执行任意用户输入。
- **自动交易**：涉及真实资金的接口（`toggle_auto_trading`、`exec_min_data` 等）需谨慎变更，建议保留显式确认或白名单校验。

## 9. 部署与发布流程

### 9.1 CI/CD

`.github/workflows/build.yml` 在 `main` 分支推送或 `v*.*.*` tag 时触发：

- 在 `windows-latest` 与 `macos-latest` 上分别执行 `pnpm build:win` / `pnpm build:mac`。
- 使用 `secrets.GH_TOKEN` 发布 GitHub Release。

### 9.2 构建注意事项

- Windows 打包可能受杀毒软件/Defender 拦截，必要时加白名单；NSIS 长路径问题可通过组策略开启 Win32 long paths。
- macOS 签名/公证需要本地 `.env.release.local` 环境变量，并手动执行 `xcrun notarytool` 与 `stapler`（见 `README.md`）。
- `electron-builder.yml` 中配置了 `extraResources`：Python 运行时、`parse_config.py`、MCP Server bundle、Monaco Editor 资源等。
- `electron-builder.beta.yml` 用于内测版打包，安装包文件名带 `BUILD_TIMESTAMP` 时间戳后缀。

## 10. 环境变量

开发/构建中常用的环境变量（由 `electron.vite.config.ts` 的 `define` 注入）：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `VITE_BASE_URL` | 后端 API 基础地址 | `https://api.quantclass.cn` |
| `VITE_XBX_ENV` | 环境标识 | `development` / `production` |
| `VITE_APP_VERSION` | 应用版本 | `3.4.0` |

本地 `.env.template` 示例包含 AWS 密钥与 `VITE_BASE_URL`。CI 构建时通过 `github.ref_name` 注入 `VITE_APP_VERSION`。

## 11. 常见问题排查

- **构建失败**：优先检查网络（Electron 下载较大）、关闭杀毒软件、清理 NSIS 缓存、重启电脑。
- **MCP 连接不上**：确认客户端已启动，`~/.quantclass/mcp-port` 存在且端口正确；检查 token 文件权限。
- **内嵌 Python 找不到**：先执行 `pnpm download-python`。
- **类型检查跨进程报错**：确认文件是否被正确的 `tsconfig.node.json` 或 `tsconfig.web.json` 包含。

## 12. 许可提示

本仓库源码受 BUSL-1.1 约束。AI 助手在生成或修改代码时，应保留文件头版权声明，并避免建议将本项目用于生产部署、SaaS 托管或再分发，除非已获得商业授权。
