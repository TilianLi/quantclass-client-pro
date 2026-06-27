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
