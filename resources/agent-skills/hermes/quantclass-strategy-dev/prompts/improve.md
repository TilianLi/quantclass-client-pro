上一轮策略评估结果：

{{evaluation}}

请根据改进建议，生成下一轮的完整 config.py 内容。工作流会重新生成整个配置文件，因此你必须输出完整的 config.py，而不能只输出参数差异。

输出要求：
- 基于 QuantClass 模板格式输出完整 config.py。
- 为每个占位符填充有效值，确保能被 `import_strategy` 导入并执行 `run_backtest`。
- 只输出代码，不要额外解释。
