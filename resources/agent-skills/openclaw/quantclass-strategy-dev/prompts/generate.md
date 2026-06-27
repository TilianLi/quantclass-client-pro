基于以下模板生成 config.py：

{{template}}

用户目标：{{goal}}

{{#if previous}}
上一轮 variant {{previous.variantId}} 未达标：
{{previous.evaluation}}

请针对以下方向改进：
{{previous.improvement_suggestions}}
{{/if}}

请为模板中的每个占位符填充符合 QuantClass 规范的合理值，输出一份完整、可直接被 QuantClass `import_strategy` 导入并执行 `run_backtest` 的 config.py 文件。只输出代码，不要额外解释。

注意：
- `cap_weight`、`select_num`、`factor_weight` 等数值字段必须是合法 Python 数值。
- `offset_list` 必须是整数列表，例如 `[0, 1, 2]`。
- `factor_params` 与 `filter_params` 必须是合法的 Python 表达式（dict、list 或 None）。
- `hold_period`、`rebalance_time`、`buy_time`、`sell_time` 必须是被 QuantClass 支持的字符串格式。
- 不要保留模板占位符，必须生成可直接运行的配置。
