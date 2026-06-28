# QuantClass Strategy Dev Skill Dogfood Plan

> **For agentic workers:** This is a verification / dogfood walkthrough, not a feature implementation. Execute the steps below and record every friction point, missing tool, wrong path, or broken assumption exposed while pretending to be OpenClaw/HermesAgent consuming the skill package.

**Goal:** Install (or simulate) the `quantclass-strategy-dev` skill package for OpenClaw and HermesAgent, walk through the full strategy-dev workflow end-to-end, and expose real problems before external users see them.

**Approach:** Because OpenClaw/HermesAgent may not be installed in this environment, we will (1) inspect the skill package structure and prompts, (2) build the MCP server bundle, (3) invoke the underlying MCP tools manually in Agent order, and (4) record every failure or ambiguity. If either framework is installed, we will also do a real skill-directory copy and list command.

**Tech Stack:** Electron/Node 22 MCP server, OpenClaw/HermesAgent skill packages (YAML + Markdown), QuantClass local controller API, pnpm, PowerShell/bash.

---

## Task 1: Pre-flight environment check

**Files:**
- Check: `resources/mcp-server/index.js`
- Check: `node --version`
- Check: `~/.quantclass/mcp-port` and `~/.quantclass/mcp-token`

- [ ] **Step 1: Verify Node ≥ 22**

Run: `node --version`
Expected: `v22.x.y`

- [ ] **Step 2: Build MCP server bundle**

Run: `pnpm build:mcp`
Expected: `resources/mcp-server/index.js` exists and no build errors.

- [ ] **Step 3: Check QuantClass client port/token files**

Run (PowerShell): `Test-Path $env:USERPROFILE\.quantclass\mcp-port; Test-Path $env:USERPROFILE\.quantclass\mcp-token`
Expected: Note whether files exist. If not, the MCP server will fall back to port 8787 and most controller endpoints will 401.

- [ ] **Step 4: Check if OpenClaw / HermesAgent CLI exists**

Run: `which openclaw`, `which hermes`, `Get-Command openclaw`, `Get-Command hermes`
Expected: Note installed vs not. If not installed, the dogfood will be a simulation by following the skill workflow and calling MCP tools directly.

---

## Task 2: Inspect skill package structure

**Files:**
- Read: `resources/agent-skills/openclaw/quantclass-strategy-dev/skill.yaml`
- Read: `resources/agent-skills/hermes/quantclass-strategy-dev/skill.yaml`
- Read: `resources/agent-skills/openclaw/quantclass-strategy-dev/workflows/strategy-dev.yaml`
- Read: `resources/agent-skills/openclaw/quantclass-strategy-dev/prompts/*.md`
- Read: `resources/agent-skills/openclaw/quantclass-strategy-dev/config/thresholds.yaml`
- Read: `resources/agent-skills/openclaw/quantclass-strategy-dev/templates/config.py.tpl`

- [ ] **Step 1: Verify both skill packages exist and have matching content**

Check that OpenClaw and Hermes packages contain the same prompts/templates/thresholds. Record any drift.

- [ ] **Step 2: Verify skill.yaml schema is plausible for each framework**

OpenClaw expects `mcpServers`, `entry.prompt`, `entry.workflow`. Hermes expects `skill.mcp.servers`, `skill.memory`, `skill.prompts.*`. Record if any required key is missing or malformed.

- [ ] **Step 3: Verify workflow references match filenames**

Workflow references: `templates/config.py.tpl`, `config/thresholds.yaml`, `workspace/agent-strategies/{run_id}/v{n}/config.py`. Confirm all files exist at those relative paths.

---

## Task 3: Simulate Agent step 0 — read template and thresholds

**Files:**
- Use MCP tool: `get_strategy_template`
- Read directly: `resources/agent-skills/openclaw/quantclass-strategy-dev/templates/config.py.tpl`
- Read directly: `resources/agent-skills/openclaw/quantclass-strategy-dev/config/thresholds.yaml`

- [ ] **Step 1: Call `get_strategy_template` via MCP**

If QuantClass client is running, call the tool. Otherwise note that the tool cannot be exercised.
Expected: JSON with template text and format docs.

- [ ] **Step 2: Confirm template content is complete enough for an LLM to fill**

The template is a 26-line skeleton with placeholders. Check whether an LLM knows valid QuantClass values for `hold_period`, `rebalance_time`, `buy_time`, `sell_time`, `factor_name`, `filter_factor`, etc. Record if prompts provide examples or enums.

- [ ] **Step 3: Confirm thresholds.yaml is loadable**

Parse the YAML. Record if keys match `evaluate_backtest` schema (`annual_return_pct`, `max_drawdown_pct`, `sharpe_ratio`, `win_rate_pct`, `profit_loss_ratio`).

---

## Task 4: Simulate Agent step 1 — generate v1 config.py

**Files:**
- Use MCP tool: `write_strategy_file`
- Verify: `workspace/agent-strategies/dogfood-run/v1/config.py`

- [ ] **Step 1: Generate a realistic v1 config.py from the template**

Use the template placeholders. Fill with reasonable values:
- `backtest_name = "dogfood_momentum_v1"`
- `strategy_name = "momentum"`
- `cap_weight = 1.0`
- `hold_period = "20D"`
- `select_num = 10`
- `offset_list = [0, 1, 2]`
- `rebalance_time = "09:35"`
- `factor_name = "momentum_20d"`, `factor_ascending = False`, `factor_params = None`, `factor_weight = 1.0`
- `filter_factor = "turnover_20d"`, `filter_params = None`, `filter_condition = ">"`, `filter_post = 0.01`
- `buy_time = "open"`, `sell_time = "open"`
- `split_order_amount = 100000`

- [ ] **Step 2: Write the file via MCP `write_strategy_file`**

Call with `runId="dogfood-run"`, `variantId="v1"`, `filename="config.py"`.
Expected: success, directory created, file written.

- [ ] **Step 3: Verify file is readable via `read_strategy_file` and `list_strategies`**

Call `list_strategies` and `read_strategy_file`. Confirm content round-trips.

---

## Task 5: Simulate Agent step 2 — validate config.py

**Files:**
- Use MCP tool: `validate_strategy`

- [ ] **Step 1: Call `validate_strategy` with absolute path**

The tool requires `configFilePath` absolute path. Construct it from `getWorkspaceRoot()` + `/dogfood-run/v1/config.py`.
Expected: valid = true, extracted contains `backtest_name` and `strategy_list`.

- [ ] **Step 2: Test validation failure path**

Write a broken config missing `strategy_list`, call validate. Confirm errors are actionable for an LLM.

---

## Task 6: Simulate Agent step 3 — import strategy

**Files:**
- Use MCP tool: `import_strategy`

- [ ] **Step 1: Call `import_strategy` with the absolute path**

Use the same absolute path as validation.
Expected: success (if QuantClass client + controller running). Record any 401/connection/template mismatch error.

- [ ] **Step 2: Identify path-discovery friction**

The skill workflow tells the Agent to write relative files and then call `import_strategy` with an absolute path, but no MCP tool returns the absolute workspace root. Record whether this is a real blocker for an autonomous Agent.

---

## Task 7: Simulate Agent step 4 — configure and run backtest

**Files:**
- Use MCP tools: `set_backtest_config`, `run_backtest`, `get_backtest_performance`

- [ ] **Step 1: Call `set_backtest_config`**

Set conservative values: `initial_cash=1000000`, `start_date="2024-01-01"`, `end_date=null`, `filter_kcb="1"`, `filter_cyb="0"`, `filter_bj="1"`.
Expected: success or 401 if client not running.

- [ ] **Step 2: Call `run_backtest`**

This may take minutes. If client not running, note that the tool cannot be exercised.
Expected: eventually returns result object.

- [ ] **Step 3: Call `get_backtest_performance`**

After run completes. Expected: JSON with metrics matching `evaluate_backtest` schema.

---

## Task 8: Simulate Agent step 5 — evaluate and iterate

**Files:**
- Use MCP tool: `evaluate_backtest`

- [ ] **Step 1: Call `evaluate_backtest` with fabricated metrics**

Because real backtest may not run, call with two variants:
- v1: annual_return_pct=12, max_drawdown_pct=18, sharpe_ratio=0.9, win_rate_pct=50, profit_loss_ratio=1.3
- v2: annual_return_pct=18, max_drawdown_pct=15, sharpe_ratio=1.2, win_rate_pct=60, profit_loss_ratio=1.8
Thresholds from thresholds.yaml.
Expected: v2 passes, v1 fails, bestVariantId="v2".

- [ ] **Step 2: Confirm evaluator handles edge cases**

Call with empty array, missing metrics, only max_drawdown. Confirm no crashes.

---

## Task 9: Simulate Agent step 6 — submit for review

**Files:**
- Use MCP tool: `submit_strategy_for_review`
- Verify: `workspace/agent-strategies/dogfood-run/candidate-report.md`

- [ ] **Step 1: Call `submit_strategy_for_review`**

Use runId="dogfood-run", variantId="v2", evaluation from Task 8, strategyPath absolute, summary="Momentum factor with turnover filter".
Expected: reportPath returned, markdown file written.

- [ ] **Step 2: Read the generated report**

Confirm it is human-readable and contains all required sections.

---

## Task 10: Real install test (if frameworks available)

**Files:**
- Target dirs: `~/.openclaw/skills/quantclass-strategy-dev`, `~/.hermes/skills/quantclass-strategy-dev`

- [ ] **Step 1: Copy OpenClaw skill package to skills dir**

Run: `Copy-Item -Recurse resources/agent-skills/openclaw/quantclass-strategy-dev $env:USERPROFILE\.openclaw\skills\`
Expected: directory created.

- [ ] **Step 2: List skills via OpenClaw CLI or check dir**

Run: `openclaw skills list` or `ls ~/.openclaw/skills/`
Expected: `quantclass-strategy-dev` present.

- [ ] **Step 3: Copy HermesAgent skill package**

Run: `Copy-Item -Recurse resources/agent-skills/hermes/quantclass-strategy-dev $env:USERPROFILE\.hermes\skills\`
Expected: directory created.

- [ ] **Step 4: List skills via HermesAgent CLI or check dir**

Run: `hermes skills list` or `ls ~/.hermes/skills/`
Expected: `quantclass-strategy-dev` present.

---

## Task 11: Compile findings

**Files:**
- Create: `docs/superpowers/dogfood/2026-06-27-quantclass-strategy-dev-findings.md`

- [ ] **Step 1: Write findings document**

Categories:
- Blockers: things that prevent the workflow from completing.
- Friction: awkward but workaround-able.
- Missing/ambiguous: things the skill should explain or tools it should expose.
- Docs issues: INSTALL.md or prompt inaccuracies.

- [ ] **Step 2: File fixes or create follow-up tasks**

For each blocker/friction, either patch it immediately or create a tracked TODO.

---

## Self-Review

- Spec coverage: The original user request was "install this skill and go through the flow once to expose problems." All workflow states (init → generate → validate → import → backtest → evaluate → submit) are covered.
- Placeholder scan: No TBD/TODO/fill-in-details; all steps include concrete commands and expected values.
- Type consistency: Tool names and parameter keys match `src/mcp-server/tools.ts`.
