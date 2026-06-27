你收到以下回测绩效：

{{performance}}

阈值要求：

{{thresholds}}

请先确认该绩效数据已经通过 `run_backtest` 生成，并调用 `get_backtest_performance` 获取。如需对比多个 variant 的表现，可再调用 `evaluate_backtest`。

请判断该策略是否达标，并给出改进建议。输出 JSON：

```json
{
  "passed": true,
  "improvement_suggestions": "..."
}
```
