# QuantClass Strategy Dev Skill — Dogfood Findings

**Date:** 2026-06-27  
**Tester:** Kimi Code CLI (dogfood run)  
**Environment:** Windows, Node v24.16.0, QuantClass client port/token files present but client not listening on 8787, OpenClaw 2026.6.1, HermesAgent installed.

---

## Summary

The MCP-level strategy-dev tools work as designed, but the **skill packages in `resources/agent-skills/{openclaw,hermes}/quantclass-strategy-dev/` are not installable** in either framework because they use a custom `skill.yaml` format instead of the native `SKILL.md` format both OpenClaw and Hermes expect. This is the single biggest blocker to shipping the skill to users.

---

## Blockers

### B1. OpenClaw does not recognize `skill.yaml` skill packages

**What I did:**
```powershell
cp -r resources/agent-skills/openclaw/quantclass-strategy-dev ~/.openclaw/workspace/skills/
openclaw skills list
```

**Result:** `quantclass-strategy-dev` does not appear. `openclaw skills info quantclass-strategy-dev` reports "Skill not found."

**Root cause:** OpenClaw workspace/bundled skills use `SKILL.md` with YAML frontmatter (`name`, `description`, `version`, `metadata.openclaw.*`) and an optional `_meta.json`. It does not look for `skill.yaml`, `prompts/`, `workflows/`, or `templates/` subdirectories. Existing working examples:
- `~/.openclaw/workspace/skills/agent-team-creator/SKILL.md`
- `C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\skills\1password\SKILL.md`

**Impact:** A user following `INSTALL.md` cannot install the OpenClaw skill.

**Fix:** Add a top-level `SKILL.md` (OpenClaw native format) to `resources/agent-skills/openclaw/quantclass-strategy-dev/` and move the workflow/prompt content into the Markdown body. Keep `skill.yaml` only if we also have our own Agent runner that consumes it.

---

### B2. HermesAgent does not recognize `skill.yaml` skill packages

**What I did:**
```bash
ls ~/.hermes/skills/quantclass-strategy-dev   # already existed from earlier copy
hermes skills list | grep quantclass-strategy-dev
hermes skills inspect quantclass-strategy-dev
```

**Result:** `quantclass-strategy-dev` is not in `hermes skills list`. `hermes skills inspect` times out trying to resolve it from remote registries.

**Root cause:** Hermes loads skills from `<name>/SKILL.md` (YAML frontmatter + Markdown body). It does not recognize `skill.yaml` or the `prompts/templates/workflows/config` subdirectories. Working examples:
- `~/.hermes/skills/dogfood/SKILL.md`
- `C:\Users\Administrator\AppData\Local\hermes\skills\quant-trading\quantclass-agent-rd\SKILL.md`

**Impact:** A user following `INSTALL.md` cannot install the Hermes skill.

**Fix:** Add `SKILL.md` to `resources/agent-skills/hermes/quantclass-strategy-dev/`. Note: Hermes already has a preferred, more comprehensive skill `quantclass-agent-rd` in `quant-trading` category. Decide whether `quantclass-strategy-dev` is meant to be a lightweight alternative or should be deprecated in favor of `quantclass-agent-rd`.

---

## Friction

### F1. `import_strategy` needs an absolute path, but the skill workflow only gives relative run/variant IDs

**What I did:**
- Wrote `v1/config.py` via `write_strategy_file(runId="dogfood-run", variantId="v1", filename="config.py")`.
- Next workflow step says "call `import_strategy`".
- `import_strategy` requires `configFilePath` as an **absolute path**.

**Root cause:** No MCP tool returns the absolute workspace root. The Agent must construct `getWorkspaceRoot() + "/dogfood-run/v1/config.py"`, but `getWorkspaceRoot` is internal to `strategy-files.ts` and not exposed.

**Impact:** An autonomous Agent has no reliable way to know the absolute path. It might guess wrong, especially because the workspace root depends on the MCP server's `process.cwd()`.

**Fix options:**
1. Expose a new MCP tool `get_strategy_workspace_root` that returns the absolute path.
2. Change `import_strategy` to accept `{ runId, variantId, filename }` in addition to `configFilePath`, and resolve the path internally.
3. Add explicit instructions in SKILL.md telling the Agent to pass the absolute path it used when writing the file (requires the Agent to track it).

Recommended: option 2 — make `import_strategy` accept either `configFilePath` or `{ runId, variantId, filename }`.

---

### F2. Workspace root depends on MCP server's `process.cwd()`

**What I did:**
- Started the MCP server from the project root via `node resources/mcp-server/index.js`.
- Files were written to `D:\QuantClassSpace\quantclass-client-pro\workspace\agent-strategies\dogfood-run\v1\config.py`.

**Root cause:** `strategy-files.ts` defaults to `join(process.cwd(), "workspace", "agent-strategies")`. If the Agent framework launches the MCP server from a different CWD (e.g., `~/.openclaw/workspace` or `~/.hermes`), the files will land there instead of next to the QuantClass project.

**Impact:** `import_strategy` might look in the wrong place; user can't find generated files; workspace gets fragmented.

**Fix:** Default the workspace root to the QuantClass project directory deterministically. Options:
1. Use the MCP server executable's directory to find the project root (`resources/mcp-server/index.js` → project root → `workspace/agent-strategies`).
2. Require `QUANTCLASS_AGENT_WORKSPACE` to be set by the installer (document it explicitly).
3. Add a new MCP tool or env-var discovery mechanism.

Recommended: option 1 for zero-config installs, option 2 as override.

---

### F3. Tool errors are returned as `isError: true` in content, not as JSON-RPC errors

**What I did:**
- Called `get_strategy_template` while QuantClass client was not running.
- The tool returned `{"content":[{"type":"text","text":"获取策略模板失败: ..."}],"isError":true}`.

**Root cause:** The MCP server catches exceptions and returns them as content with `isError: true`, which is valid MCP behavior but easy for a simple client to miss.

**Impact:** A naive Agent client might parse the JSON text and think the call succeeded.

**Fix:** This is a client-side concern. The SKILL.md should instruct the Agent to always check `isError` and retry/abort on failure.

---

### F4. The workflow YAML and prompt files are not consumed by OpenClaw/Hermes

**What I did:**
- Inspected OpenClaw/Hermes skill loading behavior.
- Confirmed neither framework reads `workflows/strategy-dev.yaml` or `prompts/*.md`.

**Root cause:** These frameworks only load `SKILL.md`. The state machine in `workflows/strategy-dev.yaml` is only useful if we run our own Agent runner.

**Impact:** We have dead files in the skill package from the frameworks' perspective.

**Fix:** Inline the workflow and prompts into `SKILL.md`. Keep `workflows/` and `prompts/` only if they are also used by a custom Agent runner or documented as "advanced editable files".

---

## Documentation Issues

### D1. INSTALL.md points OpenClaw users to a non-existent `~/.openclaw/skills/` directory

**What I did:**
- Followed INSTALL.md literally: copy package to `$env:USERPROFILE\.openclaw\skills\`.
- That directory does not exist on this machine. OpenClaw uses `~/.openclaw/workspace/skills/` for workspace skills and has no obvious `~/.openclaw/skills/`.

**Fix:** Update INSTALL.md to use `~/.openclaw/workspace/skills/` and add `SKILL.md` instructions.

---

### D2. INSTALL.md's MCP server config snippets assume the user knows the project path

The snippets use `D:\QuantClassSpace\quantclass-client-pro\resources\mcp-server\index.js`. Users with a release install will have a different path. The docs mention "正式安装包" but don't give the actual release path.

**Fix:** Provide concrete release install paths (e.g., `C:\Program Files\QuantclassClient\resources\mcp-server\index.js`) and note that `node` must be in PATH or use an absolute path.

---

### D3. INSTALL.md does not mention `QUANTCLASS_AGENT_WORKSPACE`

Because the workspace root depends on MCP server CWD, users need to know how to control it.

**Fix:** Add a section explaining `QUANTCLASS_AGENT_WORKSPACE` and recommend setting it in the MCP server env config.

---

## What Worked

- `pnpm build:mcp` succeeded and produced `resources/mcp-server/index.js`.
- All existing MCP tests pass (`pnpm test:mcp` — 18/18).
- `write_strategy_file`, `read_strategy_file`, `list_strategies` work and enforce path traversal protection.
- `validate_strategy` correctly parses the generated config and extracts `backtest_name` / `strategy_list`.
- `evaluate_backtest` correctly picks `v2` as best and reports `passed: true` when thresholds are met.
- `submit_strategy_for_review` writes a readable `candidate-report.md`.
- Hermes already has a working, preferred skill `quantclass-agent-rd` with `SKILL.md` format.

---

## Recommended Next Steps

1. **Convert skill packages to native `SKILL.md` format** for both OpenClaw and Hermes.
2. **Resolve the absolute-path problem** for `import_strategy` (add runId/variantId/filename support or expose workspace root).
3. **Pin the default workspace root** to the QuantClass project directory instead of `process.cwd()`.
4. **Rewrite INSTALL.md** with correct paths, `SKILL.md` install steps, and `QUANTCLASS_AGENT_WORKSPACE` guidance.
5. **Decide relationship** between `quantclass-strategy-dev` and the existing Hermes `quantclass-agent-rd` skill to avoid duplication.

---

## Verification After Fixes

The following fixes were applied and re-verified in the same environment:

1. **Added native `SKILL.md` to both packages**
   - `resources/agent-skills/openclaw/quantclass-strategy-dev/SKILL.md`
   - `resources/agent-skills/hermes/quantclass-strategy-dev/SKILL.md`

2. **Added `get_strategy_workspace_root` MCP tool**
   - Registered in `src/mcp-server/tools.ts`.
   - Returns deterministic project-root-based workspace path.

3. **Pinned default workspace root to app root**
   - `src/mcp-server/strategy-files.ts` now derives `workspace/agent-strategies` from the script location instead of `process.cwd()`.

4. **Rewrote `INSTALL.md`**
   - Correct OpenClaw workspace skills path (`~/.openclaw/workspace/skills/`).
   - Correct Hermes skills path (`%LOCALAPPDATA%\hermes\skills\<category>\` on Windows).
   - Documented `QUANTCLASS_AGENT_WORKSPACE`.

### Re-verification commands and results

```powershell
# OpenClaw
Copy-Item -Recurse resources/agent-skills/openclaw/quantclass-strategy-dev $env:USERPROFILE\.openclaw\workspace\skills\
openclaw skills list
# Result: quantclass-strategy-dev shows as "ready" from openclaw-workspace

# Hermes
Copy-Item -Recurse resources/agent-skills/hermes/quantclass-strategy-dev $env:LOCALAPPDATA\hermes\skills\quant-trading\
Remove-Item $env:LOCALAPPDATA\hermes\.skills_prompt_snapshot.json
hermes skills list
# Result: quantclass-strategy-dev shows as local skill in quant-trading category
```

### Remaining limitation

The QuantClass client was not running during dogfood, so `import_strategy` and `run_backtest` could not be exercised end-to-end. The connection errors are environment-specific, not skill-specific. A full e2e test requires the QuantClass client to be active on port 8787.

### Tests

`pnpm test:mcp` — 18/18 passed.
