# QuantClass 策略开发 Agent Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 QuantClass 客户端内新增 6 个 MCP tools 并发布 OpenClaw/HermesAgent 可用的 skill package，使 Agent 能基于模板自主开发 A 股策略、回测迭代、提交候选报告等待人工确认。

**Architecture:** 保持 MCP Server 作为 QuantClass 原子能力桥接层；新增策略文件读写、校验、回测评估、候选提交等 tools；Agent 框架通过读取官方 skill package 中的 workflow/prompt/template 自行驱动迭代循环；工作区按 run/variant 独立目录落盘，保留完整历史。

**Tech Stack:** TypeScript, Node 22 内置 `node:test`, esbuild, Zod, QuantClass 内嵌 Python。

---

## 文件结构

```
quantclass-client-pro/
├── src/mcp-server/
│   ├── tools.ts                         # 修改：注册 6 个新 tools
│   ├── strategy-files.ts                # 新增：策略文件 CRUD
│   ├── strategy-validator.ts            # 新增：config.py 校验
│   ├── backtest-evaluator.ts            # 新增：回测结果评估
│   └── review-submitter.ts              # 新增：候选报告生成
├── tests/mcp-server/
│   ├── strategy-files.test.ts           # 新增
│   ├── strategy-validator.test.ts       # 新增
│   ├── backtest-evaluator.test.ts       # 新增
│   └── tools.test.ts                    # 新增
├── resources/agent-skills/
│   ├── openclaw/quantclass-strategy-dev/     # 新增
│   ├── hermes/quantclass-strategy-dev/       # 新增
│   └── README.md                             # 新增
└── package.json                         # 修改：添加 test:mcp 脚本
```

---

## Task 1: 建立 MCP 测试基础设施

**Files:**
- Modify: `package.json`
- Create: `tests/mcp-server/sanity.test.ts`

- [ ] **Step 1: 添加测试脚本**

在 `package.json` 的 `scripts` 中新增：

```json
"test:mcp": "node --test tests/mcp-server/**/*.test.ts"
```

- [ ] **Step 2: 创建 sanity 测试**

创建 `tests/mcp-server/sanity.test.ts`：

```typescript
import { describe, it } from "node:test"
import assert from "node:assert"

describe("sanity", () => {
  it("should pass", () => {
    assert.strictEqual(1 + 1, 2)
  })
})
```

- [ ] **Step 3: 运行测试确认基础设施可用**

Run:

```bash
pnpm test:mcp
```

Expected: 至少 `sanity` 测试通过。

- [ ] **Step 4: Commit**

```bash
git add package.json tests/mcp-server/sanity.test.ts
git commit -m "chore: add mcp test infrastructure using node:test"
```

---

## Task 2: 策略文件管理工具

**Files:**
- Create: `src/mcp-server/strategy-files.ts`
- Create: `tests/mcp-server/strategy-files.test.ts`

- [ ] **Step 1: 编写策略文件工具**

创建 `src/mcp-server/strategy-files.ts`：

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const WORKSPACE_ROOT = process.env.QUANTCLASS_AGENT_WORKSPACE
  ? process.env.QUANTCLASS_AGENT_WORKSPACE
  : join(process.cwd(), "workspace", "agent-strategies")

export interface StrategyVariant {
  runId: string
  variantId: string
  path: string
}

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT
}

export function listRuns(): string[] {
  if (!existsSync(WORKSPACE_ROOT)) return []
  return readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

export function listVariants(runId: string): string[] {
  const runPath = join(WORKSPACE_ROOT, runId)
  if (!existsSync(runPath)) return []
  return readdirSync(runPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("v"))
    .map((d) => d.name)
    .sort()
}

export function readStrategyFile(runId: string, variantId: string, filename: string): string {
  const filePath = join(WORKSPACE_ROOT, runId, variantId, filename)
  if (!existsSync(filePath)) {
    throw new Error(`文件不存在: ${filePath}`)
  }
  return readFileSync(filePath, "utf-8")
}

export function writeStrategyFile(
  runId: string,
  variantId: string,
  filename: string,
  content: string,
): void {
  const dir = join(WORKSPACE_ROOT, runId, variantId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(dir, filename), content, "utf-8")
}

export function listStrategyFiles(runId: string, variantId: string): string[] {
  const dir = join(WORKSPACE_ROOT, runId, variantId)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
}
```

- [ ] **Step 2: 编写测试**

创建 `tests/mcp-server/strategy-files.test.ts`：

```typescript
import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listRuns,
  listVariants,
  readStrategyFile,
  writeStrategyFile,
  listStrategyFiles,
} from "../../src/mcp-server/strategy-files.js"

const TMP = mkdtempSync(join(tmpdir(), "qc-agent-"))
process.env.QUANTCLASS_AGENT_WORKSPACE = TMP

describe("strategy-files", () => {
  after(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("lists empty workspace", () => {
    assert.deepStrictEqual(listRuns(), [])
  })

  it("writes and reads strategy file", () => {
    writeStrategyFile("run-001", "v1", "config.py", "X = 1")
    assert.strictEqual(readStrategyFile("run-001", "v1", "config.py"), "X = 1")
  })

  it("lists variants", () => {
    writeStrategyFile("run-001", "v2", "config.py", "X = 2")
    assert.deepStrictEqual(listVariants("run-001"), ["v1", "v2"])
  })

  it("lists files in variant", () => {
    assert.deepStrictEqual(listStrategyFiles("run-001", "v1"), ["config.py"])
  })

  it("throws on missing file", () => {
    assert.throws(() => readStrategyFile("run-001", "v1", "missing.py"))
  })
})
```

- [ ] **Step 3: 运行测试**

Run:

```bash
pnpm test:mcp tests/mcp-server/strategy-files.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/strategy-files.ts tests/mcp-server/strategy-files.test.ts
git commit -m "feat(mcp): add strategy file CRUD utilities"
```

---

## Task 3: 策略校验器

**Files:**
- Create: `src/mcp-server/strategy-validator.ts`
- Create: `tests/mcp-server/strategy-validator.test.ts`

- [ ] **Step 1: 编写校验器**

创建 `src/mcp-server/strategy-validator.ts`：

```typescript
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

const REQUIRED_VARS = [
  "start_date",
  "end_date",
  "period",
  "strategy_name",
]

export interface ValidationResult {
  valid: boolean
  errors: string[]
  extracted?: Record<string, unknown>
}

export function validateConfigSyntax(source: string): string[] {
  const errors: string[] = []
  try {
    // 用 Python AST 做语法检查
    execFileSync(process.platform === "win32" ? "python" : "python3", [
      "-c",
      "import ast; ast.parse(open(__import__('sys').argv[1], 'r', encoding='utf-8').read())",
      "-",
    ], {
      input: source,
      encoding: "utf-8",
      timeout: 5000,
    })
  } catch (error) {
    errors.push(`语法错误: ${error instanceof Error ? error.message : String(error)}`)
  }
  return errors
}

export function validateConfigVariables(extracted: Record<string, unknown>): string[] {
  const errors: string[] = []
  for (const name of REQUIRED_VARS) {
    if (!(name in extracted)) {
      errors.push(`缺少必填变量: ${name}`)
    }
  }
  return errors
}

export function validateStrategy(configPath: string): ValidationResult {
  if (!existsSync(configPath)) {
    return { valid: false, errors: [`文件不存在: ${configPath}`] }
  }

  const pythonExe = join(process.cwd(), "resources", "python", "python.exe")
  const parseScript = join(process.cwd(), "resources", "parse_config.py")

  try {
    const output = execFileSync(existsSync(pythonExe) ? pythonExe : "python3", [
      parseScript,
      configPath,
      ...REQUIRED_VARS,
    ], {
      encoding: "utf-8",
      timeout: 10000,
    })

    const extracted = JSON.parse(output) as Record<string, unknown>
    if (extracted.__error__) {
      return { valid: false, errors: [String(extracted.__error__)] }
    }

    const missingErrors = validateConfigVariables(extracted)
    if (missingErrors.length > 0) {
      return { valid: false, errors: missingErrors, extracted }
    }

    return { valid: true, errors: [], extracted }
  } catch (error) {
    return {
      valid: false,
      errors: [`校验失败: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `tests/mcp-server/strategy-validator.test.ts`：

```typescript
import { describe, it } from "node:test"
import assert from "node:assert"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateStrategy, validateConfigVariables } from "../../src/mcp-server/strategy-validator.js"

const TMP = mkdtempSync(join(tmpdir(), "qc-validator-"))

describe("strategy-validator", () => {
  after(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("reports missing variables", () => {
    const path = join(TMP, "bad.py")
    writeFileSync(path, "x = 1")
    const result = validateStrategy(path)
    assert.strictEqual(result.valid, false)
    assert.ok(result.errors.some((e) => e.includes("缺少必填变量")))
  })

  it("validates correct config", () => {
    const path = join(TMP, "good.py")
    writeFileSync(
      path,
      `start_date = "2020-01-01"\nend_date = "2024-01-01"\nperiod = "daily"\nstrategy_name = "demo"`,
    )
    const result = validateStrategy(path)
    assert.strictEqual(result.valid, true)
    assert.strictEqual(result.extracted?.strategy_name, "demo")
  })

  it("reports missing start_date", () => {
    const errors = validateConfigVariables({ end_date: "2024-01-01" })
    assert.ok(errors.some((e) => e.includes("start_date")))
  })
})
```

- [ ] **Step 3: 运行测试**

Run:

```bash
pnpm test:mcp tests/mcp-server/strategy-validator.test.ts
```

Expected: PASS。注意：测试依赖 Python 环境；如果 CI 没有 Python，可把 `validateStrategy` 拆出一个 `validateConfigVariables` 纯函数优先测试。

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/strategy-validator.ts tests/mcp-server/strategy-validator.test.ts
git commit -m "feat(mcp): add strategy config validator"
```

---

## Task 4: 回测评估器

**Files:**
- Create: `src/mcp-server/backtest-evaluator.ts`
- Create: `tests/mcp-server/backtest-evaluator.test.ts`

- [ ] **Step 1: 编写评估器**

创建 `src/mcp-server/backtest-evaluator.ts`：

```typescript
export interface Thresholds {
  annual_return_pct?: number
  max_drawdown_pct?: number
  sharpe_ratio?: number
  win_rate_pct?: number
  profit_loss_ratio?: number
}

export interface BacktestPerformance {
  variantId: string
  annual_return_pct?: number
  max_drawdown_pct?: number
  sharpe_ratio?: number
  win_rate_pct?: number
  profit_loss_ratio?: number
}

export interface EvaluationResult {
  passed: boolean
  bestVariantId: string | null
  score: number
  details: Record<string, { value: number; threshold: number | undefined; passed: boolean }>
}

export function evaluateBacktest(
  performances: BacktestPerformance[],
  thresholds: Thresholds,
): EvaluationResult {
  if (performances.length === 0) {
    return { passed: false, bestVariantId: null, score: 0, details: {} }
  }

  const scored = performances.map((p) => {
    const details: EvaluationResult["details"] = {}
    let passCount = 0
    let totalCount = 0

    for (const [key, threshold] of Object.entries(thresholds)) {
      const value = p[key as keyof BacktestPerformance] as number | undefined
      const numericValue = typeof value === "number" ? value : -Infinity
      const passed =
        key === "max_drawdown_pct"
          ? threshold === undefined || numericValue <= threshold
          : threshold === undefined || numericValue >= threshold

      details[key] = { value: numericValue, threshold, passed }
      if (threshold !== undefined) {
        totalCount++
        if (passed) passCount++
      }
    }

    const score = totalCount === 0 ? 0 : passCount / totalCount
    return { ...p, details, score, allPassed: score === 1 }
  })

  const best = scored.reduce((prev, curr) => (curr.score > prev.score ? curr : prev))

  return {
    passed: best.allPassed,
    bestVariantId: best.variantId,
    score: best.score,
    details: best.details,
  }
}
```

- [ ] **Step 2: 编写测试**

创建 `tests/mcp-server/backtest-evaluator.test.ts`：

```typescript
import { describe, it } from "node:test"
import assert from "node:assert"
import { evaluateBacktest } from "../../src/mcp-server/backtest-evaluator.js"

describe("backtest-evaluator", () => {
  it("returns passed when thresholds met", () => {
    const result = evaluateBacktest(
      [
        {
          variantId: "v1",
          annual_return_pct: 20,
          max_drawdown_pct: 15,
          sharpe_ratio: 1.2,
        },
      ],
      {
        annual_return_pct: 15,
        max_drawdown_pct: 20,
        sharpe_ratio: 1.0,
      },
    )
    assert.strictEqual(result.passed, true)
    assert.strictEqual(result.bestVariantId, "v1")
    assert.strictEqual(result.score, 1)
  })

  it("returns not passed and picks best variant", () => {
    const result = evaluateBacktest(
      [
        { variantId: "v1", annual_return_pct: 10, max_drawdown_pct: 25 },
        { variantId: "v2", annual_return_pct: 18, max_drawdown_pct: 18 },
      ],
      {
        annual_return_pct: 15,
        max_drawdown_pct: 20,
      },
    )
    assert.strictEqual(result.passed, false)
    assert.strictEqual(result.bestVariantId, "v2")
    assert.ok(result.score > 0 && result.score < 1)
  })

  it("returns failed on empty input", () => {
    const result = evaluateBacktest([], {})
    assert.strictEqual(result.passed, false)
    assert.strictEqual(result.bestVariantId, null)
  })
})
```

- [ ] **Step 3: 运行测试**

Run:

```bash
pnpm test:mcp tests/mcp-server/backtest-evaluator.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/backtest-evaluator.ts tests/mcp-server/backtest-evaluator.test.ts
git commit -m "feat(mcp): add backtest evaluator with threshold scoring"
```

---

## Task 5: 候选报告生成器

**Files:**
- Create: `src/mcp-server/review-submitter.ts`
- Create: `tests/mcp-server/review-submitter.test.ts`

- [ ] **Step 1: 编写报告生成器**

创建 `src/mcp-server/review-submitter.ts`：

```typescript
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface CandidateReport {
  runId: string
  variantId: string
  performance: Record<string, unknown>
  thresholds: Record<string, number | undefined>
  evaluation: {
    passed: boolean
    score: number
    details: Record<string, { value: number; threshold: number | undefined; passed: boolean }>
  }
  strategyPath: string
  summary: string
}

export function generateCandidateReport(params: CandidateReport): string {
  const lines: string[] = [
    `# 候选策略报告`,
    "",
    `- **Run ID**: ${params.runId}`,
    `- **Variant ID**: ${params.variantId}`,
    `- **策略路径**: ${params.strategyPath}`,
    `- **综合达标**: ${params.evaluation.passed ? "✅ 通过" : "⚠️ 未完全达标（当前最优）"}`,
    `- **得分**: ${(params.evaluation.score * 100).toFixed(1)}%`,
    "",
    "## 绩效指标",
    "",
    "| 指标 | 实际值 | 阈值 | 是否达标 |",
    "|------|--------|------|----------|",
  ]

  for (const [key, detail] of Object.entries(params.evaluation.details)) {
    lines.push(
      `| ${key} | ${detail.value.toFixed(2)} | ${detail.threshold ?? "-"} | ${detail.passed ? "✅" : "❌"} |`,
    )
  }

  lines.push("", "## 策略说明", "", params.summary, "")
  lines.push("---", "请确认是否将该策略导入 QuantClass 并启用实盘交易。")

  return lines.join("\n")
}

export function submitForReview(
  workspaceRoot: string,
  params: CandidateReport,
): { reportPath: string; report: string } {
  const report = generateCandidateReport(params)
  const runDir = join(workspaceRoot, params.runId)
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true })
  }
  const reportPath = join(runDir, "candidate-report.md")
  writeFileSync(reportPath, report, "utf-8")
  return { reportPath, report }
}
```

- [ ] **Step 2: 编写测试**

创建 `tests/mcp-server/review-submitter.test.ts`：

```typescript
import { describe, it, after } from "node:test"
import assert from "node:assert"
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { submitForReview } from "../../src/mcp-server/review-submitter.js"

const TMP = mkdtempSync(join(tmpdir(), "qc-review-"))

describe("review-submitter", () => {
  after(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("generates and writes candidate report", () => {
    const { reportPath, report } = submitForReview(TMP, {
      runId: "run-001",
      variantId: "v3",
      performance: { annual_return_pct: 20 },
      thresholds: { annual_return_pct: 15 },
      evaluation: {
        passed: true,
        score: 1,
        details: {
          annual_return_pct: { value: 20, threshold: 15, passed: true },
        },
      },
      strategyPath: "workspace/agent-strategies/run-001/v3/config.py",
      summary: "动量+ROE 过滤策略，第三版达标。",
    })

    assert.ok(report.includes("候选策略报告"))
    assert.ok(report.includes("动量+ROE"))
    assert.ok(existsSync(reportPath))
    assert.ok(readFileSync(reportPath, "utf-8").includes("run-001"))
  })
})
```

- [ ] **Step 3: 运行测试**

Run:

```bash
pnpm test:mcp tests/mcp-server/review-submitter.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/review-submitter.ts tests/mcp-server/review-submitter.test.ts
git commit -m "feat(mcp): add candidate review report generator"
```

---

## Task 6: 在 MCP Server 注册新 Tools

**Files:**
- Modify: `src/mcp-server/tools.ts`
- Create: `tests/mcp-server/tools.test.ts`

- [ ] **Step 1: 在 tools.ts 中导入新增模块并注册 tools**

在 `src/mcp-server/tools.ts` 顶部添加：

```typescript
import { z } from "zod"
import { listRuns, listVariants, listStrategyFiles, readStrategyFile, writeStrategyFile } from "./strategy-files.js"
import { validateStrategy } from "./strategy-validator.js"
import { evaluateBacktest } from "./backtest-evaluator.js"
import { submitForReview } from "./review-submitter.js"
import { getWorkspaceRoot } from "./strategy-files.js"
```

在 `registerTools` 函数末尾新增 6 个 tools：

```typescript
// 策略文件管理
server.tool(
  "list_strategies",
  "列出策略工作区下的所有 run 和 variant",
  {
    runId: z.string().optional().describe("可选：指定 run ID"),
  },
  async ({ runId }) => {
    try {
      if (runId) {
        const variants = listVariants(runId)
        return {
          content: [{ type: "text", text: JSON.stringify({ runId, variants }, null, 2) }],
        }
      }
      const runs = listRuns()
      return {
        content: [{ type: "text", text: JSON.stringify({ runs }, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `列出策略失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "read_strategy_file",
  "读取指定策略文件内容",
  {
    runId: z.string().describe("Run ID"),
    variantId: z.string().describe("Variant ID，例如 v1"),
    filename: z.string().describe("文件名，例如 config.py"),
  },
  async ({ runId, variantId, filename }) => {
    try {
      const content = readStrategyFile(runId, variantId, filename)
      return {
        content: [{ type: "text", text: content }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `读取失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "write_strategy_file",
  "写入策略文件内容",
  {
    runId: z.string().describe("Run ID"),
    variantId: z.string().describe("Variant ID，例如 v1"),
    filename: z.string().describe("文件名，例如 config.py"),
    content: z.string().describe("文件内容"),
  },
  async ({ runId, variantId, filename, content }) => {
    try {
      writeStrategyFile(runId, variantId, filename, content)
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, path: `${runId}/${variantId}/${filename}` }, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `写入失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "validate_strategy",
  "校验 config.py 策略配置是否合法",
  {
    configFilePath: z.string().describe("config.py 的绝对路径"),
  },
  async ({ configFilePath }) => {
    try {
      const result = validateStrategy(configFilePath)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `校验失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "evaluate_backtest",
  "根据阈值评估多次回测结果，返回最优 variant",
  {
    performances: z.array(z.object({
      variantId: z.string(),
      annual_return_pct: z.number().optional(),
      max_drawdown_pct: z.number().optional(),
      sharpe_ratio: z.number().optional(),
      win_rate_pct: z.number().optional(),
      profit_loss_ratio: z.number().optional(),
    })),
    thresholds: z.object({
      annual_return_pct: z.number().optional(),
      max_drawdown_pct: z.number().optional(),
      sharpe_ratio: z.number().optional(),
      win_rate_pct: z.number().optional(),
      profit_loss_ratio: z.number().optional(),
    }),
  },
  async ({ performances, thresholds }) => {
    try {
      const result = evaluateBacktest(performances, thresholds)
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `评估失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)

server.tool(
  "submit_strategy_for_review",
  "生成候选策略报告并等待人工确认",
  {
    runId: z.string().describe("Run ID"),
    variantId: z.string().describe("Variant ID"),
    performance: z.record(z.unknown()).describe("回测绩效对象"),
    thresholds: z.record(z.number().optional()).describe("阈值对象"),
    evaluation: z.object({
      passed: z.boolean(),
      score: z.number(),
      details: z.record(z.object({
        value: z.number(),
        threshold: z.number().optional(),
        passed: z.boolean(),
      })),
    }),
    strategyPath: z.string().describe("策略文件路径"),
    summary: z.string().describe("策略说明摘要"),
  },
  async (params) => {
    try {
      const { reportPath, report } = submitForReview(getWorkspaceRoot(), params)
      return {
        content: [{ type: "text", text: JSON.stringify({ reportPath, report }, null, 2) }],
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: `生成报告失败: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      }
    }
  },
)
```

- [ ] **Step 2: 运行 TypeScript 类型检查**

Run:

```bash
pnpm typecheck:node
```

Expected: 无类型错误。

- [ ] **Step 3: 编写集成测试**

创建 `tests/mcp-server/tools.test.ts`：

```typescript
import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("mcp tools integration", () => {
  const TMP = mkdtempSync(join(tmpdir(), "qc-tools-"))

  before(() => {
    process.env.QUANTCLASS_AGENT_WORKSPACE = TMP
  })

  after(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it("workspace root is set", async () => {
    const { getWorkspaceRoot } = await import("../../src/mcp-server/strategy-files.js")
    assert.strictEqual(getWorkspaceRoot(), TMP)
  })
})
```

- [ ] **Step 4: 运行全部 MCP 测试**

Run:

```bash
pnpm test:mcp
```

Expected: 全部通过。

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools.ts tests/mcp-server/tools.test.ts
git commit -m "feat(mcp): register 6 new strategy development tools"
```

---

## Task 7: 创建 OpenClaw Skill Package

**Files:**
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/skill.yaml`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/config/thresholds.yaml`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/templates/config.py.tpl`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/workflows/strategy-dev.yaml`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/prompts/init.md`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/prompts/generate.md`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/prompts/evaluate.md`
- Create: `resources/agent-skills/openclaw/quantclass-strategy-dev/prompts/improve.md`

- [ ] **Step 1: 创建 skill.yaml**

```yaml
name: quantclass-strategy-dev
version: 1.0.0
description: 基于模板自动开发 A 股量化策略并回测迭代
author: QuantClass
mcpServers:
  - quantclass
entry:
  prompt: prompts/init.md
  workflow: workflows/strategy-dev.yaml
```

- [ ] **Step 2: 创建 config/thresholds.yaml**

```yaml
thresholds:
  annual_return_pct: 15.0
  max_drawdown_pct: 20.0
  sharpe_ratio: 1.0
  win_rate_pct: 55.0
  profit_loss_ratio: 1.5

iteration:
  max_variants: 20
  max_retries_per_variant: 3
```

- [ ] **Step 3: 创建 templates/config.py.tpl**

```python
# QuantClass 策略模板：{{strategy_type}}
# 由 Agent 自动填充生成

start_date = "{{start_date}}"
end_date = "{{end_date}}"
period = "{{period}}"
strategy_name = "{{strategy_name}}"

# 选股池过滤条件
filter_conditions = {
    "roe_ttm": {{roe_threshold}},
    "market_cap_min": {{market_cap_min}},
}

# 排序/打分因子
factors = [
    {"name": "{{factor_1}}", "weight": {{weight_1}}, "direction": "{{direction_1}}"},
]

# 仓位与调仓参数
position_config = {
    "max_holdings": {{max_holdings}},
    "rebalance_period": "{{rebalance_period}}",
}
```

- [ ] **Step 4: 创建 workflows/strategy-dev.yaml**

```yaml
name: quantclass-strategy-dev
version: 1.0.0
state_machine:
  initial: init
  states:
    init:
      action: read_template_and_thresholds
      transitions:
        - next: generate

    generate:
      action: llm_generate_strategy
      input:
        template: templates/config.py.tpl
      output: workspace/{run_id}/v{n}/config.py
      transitions:
        - next: validate

    validate:
      action: validate_strategy
      transitions:
        - on_success: import
        - on_failure: improve

    import:
      action: import_strategy
      transitions:
        - on_success: backtest
        - on_failure: improve

    backtest:
      action: run_backtest
      transitions:
        - on_success: evaluate

    evaluate:
      action: evaluate_backtest
      transitions:
        - on_met: submit
        - on_not_met: improve
        - on_limit_reached: submit_best

    improve:
      action: llm_improve_strategy
      transitions:
        - next: generate

    submit:
      action: submit_strategy_for_review
      final: true

    submit_best:
      action: submit_strategy_for_review
      final: true
```

- [ ] **Step 5: 创建 prompts/init.md**

```markdown
# QuantClass 策略开发 Agent

你是一个 A 股量化策略开发助手。你的任务是基于模板生成策略配置文件，自动回测迭代，直到满足阈值或达到迭代上限。

## 工作目录

策略文件保存在 QuantClass 客户端工作区：`workspace/agent-strategies/{run_id}/v{n}/config.py`。

## 可用 MCP Tools

- `get_strategy_template`：读取策略模板规范
- `list_strategies` / `read_strategy_file` / `write_strategy_file`：策略文件管理
- `validate_strategy`：校验 config.py
- `import_strategy`：导入策略到 QuantClass
- `set_backtest_config` / `run_backtest` / `get_backtest_performance`：回测
- `evaluate_backtest`：评估多次回测结果
- `submit_strategy_for_review`：生成候选报告等待人工确认

## 安全规则

- 未经用户明确确认，不得调用 `toggle_auto_trading` 开启实盘。
- 每轮 variant 必须独立目录，不得覆盖历史。
- 迭代次数不能超过 `max_variants`。
```

- [ ] **Step 6: 创建 prompts/generate.md**

```markdown
基于以下模板生成 config.py：

{{template}}

用户目标：{{goal}}

{{#if previous}}
上一轮 variant {{previous.variantId}} 未达标：
{{previous.evaluation}}

请针对以下方向改进：
{{previous.improvement_suggestions}}
{{/if}}

请输出完整的 config.py 内容，只输出代码，不要额外解释。
```

- [ ] **Step 7: 创建 prompts/evaluate.md**

```markdown
你收到以下回测绩效：

{{performance}}

阈值要求：

{{thresholds}}

请判断该策略是否达标，并给出改进建议。输出 JSON：

```json
{
  "passed": true,
  "improvement_suggestions": "..."
}
```
```

- [ ] **Step 8: 创建 prompts/improve.md**

```markdown
上一轮策略评估结果：

{{evaluation}}

请根据改进建议，决定下一轮要如何调整模板参数（如因子、阈值、权重、持仓数等）。

只输出需要调整的参数键值对，格式：

```
factor_1: momentum_20d
weight_1: 0.6
roe_threshold: 0.15
```
```

- [ ] **Step 9: Commit**

```bash
git add resources/agent-skills/openclaw/
git commit -m "feat(agent-skills): add OpenClaw quantclass-strategy-dev skill package"
```

---

## Task 8: 创建 HermesAgent Skill Package

**Files:**
- Create: `resources/agent-skills/hermes/quantclass-strategy-dev/` 下所有文件（同 OpenClaw 结构）

- [ ] **Step 1: 复制并适配 Hermes 格式**

将 `resources/agent-skills/openclaw/quantclass-strategy-dev/` 复制到 `resources/agent-skills/hermes/quantclass-strategy-dev/`。

将 `skill.yaml` 修改为 Hermes 风格：

```yaml
skill:
  name: quantclass-strategy-dev
  version: 1.0.0
  description: 基于模板自动开发 A 股量化策略并回测迭代
  author: QuantClass
  mcp:
    servers:
      - quantclass
  memory:
    - key: thresholds
      file: config/thresholds.yaml
    - key: workflow
      file: workflows/strategy-dev.yaml
  prompts:
    init: prompts/init.md
    generate: prompts/generate.md
    evaluate: prompts/evaluate.md
    improve: prompts/improve.md
```

- [ ] **Step 2: Commit**

```bash
git add resources/agent-skills/hermes/
git commit -m "feat(agent-skills): add HermesAgent quantclass-strategy-dev skill package"
```

---

## Task 9: 文档与使用说明

**Files:**
- Create: `resources/agent-skills/README.md`

- [ ] **Step 1: 编写 README**

创建 `resources/agent-skills/README.md`：

```markdown
# QuantClass Agent Skills

本目录包含 QuantClass 官方提供的 Agent Skill Package，支持 OpenClaw 和 HermesAgent 等 MCP-native 框架。

## 当前 Skill

### quantclass-strategy-dev

基于模板自动开发 A 股量化策略，支持：

- 按模板生成 `config.py`
- 自动校验、导入、回测
- 按阈值评估并迭代优化
- 生成候选报告等待人工确认

## 安装方式

### OpenClaw

将 `openclaw/quantclass-strategy-dev` 复制到 OpenClaw 的 skills 目录，或在配置中引用本目录。

### HermesAgent

将 `hermes/quantclass-strategy-dev` 复制到 HermesAgent 的 skills 目录。

## 前置条件

1. QuantClass 客户端已启动，并写入 `~/.quantclass/mcp-port` 和 `~/.quantclass/mcp-token`。
2. AI 客户端已配置 QuantClass MCP server。
3. 工作区目录 `workspace/agent-strategies/` 可写。

## 使用示例

对 Agent 说：

> "基于动量模板，开发一个年化收益>15%、最大回撤<20% 的 A 股选股策略。"

Agent 将自动迭代，达标后生成 `candidate-report.md` 等待确认。
```

- [ ] **Step 2: Commit**

```bash
git add resources/agent-skills/README.md
git commit -m "docs(agent-skills): add README for quantclass agent skills"
```

---

## Task 10: 构建验证

**Files:**
- Verify: `resources/mcp-server/index.js`
- Verify: `resources/agent-skills/` 已包含在构建产物中

- [ ] **Step 1: 运行类型检查**

Run:

```bash
pnpm typecheck:node
```

Expected: 无错误。

- [ ] **Step 2: 运行全部 MCP 测试**

Run:

```bash
pnpm test:mcp
```

Expected: 全部通过。

- [ ] **Step 3: 构建 MCP bundle**

Run:

```bash
pnpm build:mcp
```

Expected: `resources/mcp-server/index.js` 成功生成。

- [ ] **Step 4: 验证 agent-skills 资源可被构建包含**

Run:

```bash
pnpm build:unpack
```

或仅检查 `resources/agent-skills/` 是否出现在 `dist/win-unpacked/resources/` 下。

- [ ] **Step 5: Commit 构建产物变更（如有）**

```bash
git add resources/mcp-server/index.js
git commit -m "chore: rebuild mcp bundle with new strategy tools"
```

---

## 自检清单

- [ ] 新增 6 个 MCP tools 已注册
- [ ] 策略文件读写、校验、评估、报告生成功能均有单元测试
- [ ] OpenClaw 和 HermesAgent skill package 结构完整
- [ ] `pnpm typecheck:node` 通过
- [ ] `pnpm test:mcp` 通过
- [ ] `pnpm build:mcp` 成功
- [ ] 文档 `README.md` 已更新
