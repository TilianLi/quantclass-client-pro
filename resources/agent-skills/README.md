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
