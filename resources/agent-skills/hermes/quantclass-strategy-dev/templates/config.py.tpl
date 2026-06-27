# QuantClass 选股策略配置
# 由 Agent 基于模板生成

backtest_name = "{{backtest_name}}"

strategy_list = [
    {
        "name": "{{strategy_name}}",
        "cap_weight": {{cap_weight}},
        "hold_period": "{{hold_period}}",
        "select_num": {{select_num}},
        "offset_list": {{offset_list}},
        "rebalance_time": "{{rebalance_time}}",
        "factor_list": [
            ["{{factor_name}}", {{factor_ascending}}, {{factor_params}}, {{factor_weight}}],
        ],
        "filter_list": [
            ["{{filter_factor}}", {{filter_params}}, "{{filter_condition}}", {{filter_post}}],
        ],
        "filter_list_post": [],
        "timing": None,
        "buy_time": "{{buy_time}}",
        "sell_time": "{{sell_time}}",
        "split_order_amount": {{split_order_amount}},
    }
]
