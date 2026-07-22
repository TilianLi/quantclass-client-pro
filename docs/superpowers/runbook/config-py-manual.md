# config.py 编写手册（给 AI 的策略配置指南）

> 适用：QuantClass 选股/综合策略库（aqua/zeus 内核），经 MCP 工作流开发与回测策略。
> 配套：`research-agent-runbook.md`（循环流程）、`docs/superpowers/mcp-issues-2026-07-21.md`（平台问题）。
> 语义来源：get_strategy_template 契约 + 框架源码语义确认 + e2e 实测。

## 1. config.py 是什么

策略入口文件。解析器用 AST **只提取顶层变量的字面量**（先 `literal_eval`，失败才 fallback eval——一律写字面量，不要写表达式）。必填两个顶层变量：

```python
backtest_name = "run-demo_v1"
strategy_list = [ { ... }, ... ]
```

可选：`re_timing`（资金曲线再择时，一般不需要，不写）。

## 2. 命名约定（关系到 isolate 与权重匹配，别随意）

- `backtest_name = "{runId}_{variantId}"`（如 `run-dd20_v2`）。isolate 用正则 `^(.*_v)\d+$` 提取分组前缀 `{runId}_v`，自动移除同组旧 variant
- `strategy_list` 里每个策略的 `name` **也设为 `{runId}_{variantId}`**（多策略可加后缀 `_a`/`_b`，保持 `{runId}_v` 前缀）。原因：默认选股库下 isolate/权重匹配的是 store 条目的 `name`
- `runId` 本身不要以 `_v数字` 结尾（会与分组前缀歧义）

## 3. strategy 字段全表

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 策略名（见 §2 命名约定） |
| `cap_weight` | 是 | 资金占比 0-1。MCP 导入时会被重置（默认 0），写 1 即可 |
| `hold_period` | 是 | 持仓周期：`"3D"`/`"5D"`/`"10D"`/`"2W"`（D/W/M，数字+单位） |
| `select_num` | 是 | 选股数量（如 20）。后置过滤可能使实际持仓少于此数 |
| `offset_list` | 是 | 换仓偏移列表，如 `[0]` 或 `[0,1]`。`hold_period`+offset 组成持仓周期名（`3_0`）。**多 offset = 分批进场**，资金按 `(i+1)/n` 递增目标仓位（如 `[0,1]` 首批 1/2、次批满仓） |
| `rebalance_time` | 是 | 换仓时间，三选一（见 §4） |
| `factor_list` | 是 | 排序因子列表，元组 `[因子名, 排序方向, 参数, 权重]`（见 §5） |
| `filter_list` | 是 | 前置过滤，元组 `[因子名, 参数, "方法:范围", 排序方向]`（见 §6），可空列表 |
| `filter_list_post` | 否 | 后置过滤（选出后再删减），同 filter_list 格式，常规写 `[]` |
| `timing` | 是 | 大盘择时，无则 `None`。配置结构见 §7 |
| `buy_time` | 是 | 买入时间（如 `"14:50:00"`，zeus 2.2 实盘/成交参数） |
| `sell_time` | 是 | 卖出时间 |
| `split_order_amount` | 是 | 拆单金额 6000-12000（zeus 2.2 拆单成交用） |
| `stock_timing_list` | 否 | 个股择时列表（见 §7 警告） |

## 4. rebalance_time 语义（源码确认）

| 值 | 行为 |
|----|------|
| `"close"` | 选股日收盘卖、**同日**收盘买（日内尾盘换仓） |
| `"open"` | 次日开盘卖、开盘买（日内早盘换仓） |
| `"close-open"` | 选股日收盘卖、**次日**开盘买（隔日换仓） |

zeus 2.2 成交价用 `["t_wap", 时间, 拆单间隔, 拆单金额, 1.005]` 模型（拆单 + 价格浮动 1.005），该模型属 2.2 黑盒部分；配置里的 `buy_time`/`sell_time` 与 `rebalance_time` 共同决定成交时点。

## 5. factor_list（排序因子）

元组结构：`[因子名, 排序方向, 参数, 权重]`

```python
"factor_list": [
    ["市值", True, None, 1.0],        # 升序：市值越小越优先，权重 1.0
    ["规模.成交额Mean", True, 5, 0.3], # 升序：5 日成交额均值越小越优先
    ["波动.波动率20", True, 20, 0.5],  # 升序：20 日波动率越小越优先
]
```

- 排序方向：`True`=升序（值小排前），`False`=降序。小市值/低波动/低换手类因子都用升序
- 参数：因子的计算参数（如 5、20 日窗口）；无参数写 `None`
- 权重：排序合成时的相对权重

## 6. filter_list（过滤条件，源码确认语义）

元组结构：`[因子名, 参数, "方法:范围", 排序方向]`。条件按交易日期做**当日全市场截面**运算，三种方法：

| 方法 | 精确定义 | 示例 |
|------|----------|------|
| `pct` | **分位数排名**（0,1]，不是百分比！ | `pct:<=0.5` + 升序 = 因子值在全市场最小 50% 内 |
| `rank` | 绝对名次（最小=1） | `rank:<=100` = 因子值最小的前 100 只 |
| `val` | 因子原始值直接比较 | `val:>-0.05`、`val:==0`、`val:<20` |

- 比较符支持 `>= <= == != > <`
- 第 4 元素（排序方向）只在 pct/rank 下生效（pct:<= 要留小值用 True 升序；val 下无实际作用，照写 True）
- **前置过滤（filter_list）**：排名选股之前作用于全市场，且内核自动叠加强制过滤（剔除 ST/S/\*/退、上市天数不足、一字涨停等）
- **常见误区**：`pct:<=0.3` 不是「因子值 ≤ 0.3」，而是「分位数排名 ≤ 30%」。想按原始值过滤用 `val:`

```python
"filter_list": [
    ["市值", None, "pct:<=0.5"],               # 市值最小的一半
    ["波动.波动率20", 20, "pct:<=0.25", True],  # 波动率最小的 25%
    ["动量.动量20", 20, "val:>-0.05", True],    # 20 日动量 > -5%（绝对值）
]
```

## 7. 择时（timing / stock_timing_list）

- `timing = None` 是最常见选择；大盘择时信号结构参考 `get_strategy_template` 的 `timingExamples`
- **个股择时（stock_timing_list）高危**：`period` 用 `"1H"`（小时线）配小时级因子；用 `"1D"` 必须保证对应因子也按日线计算，否则报「kline 与因子行数不一致」（e2e 实踩，内核层错误、反馈极差）。**初次开发策略不要碰个股择时**

## 8. 因子引用契约

- `类目.名`（如 `动量.动量20`）→ `因子库/类目/名.py`；裸名（如 `市值`）→ `因子库/名.py` 或内核内置因子
- 解析顺序：`因子库` 优先于 `截面因子库`，同名先命中先用
- **子目录必须含 `__init__.py`**（内核按 Python 模块 import，缺则 ModuleNotFoundError 全崩）
- **自定义因子走 `write_factor_file` 闸门**（受限开放）：写入前强制 AST 静态检查（仅纯计算库 + `fin_cols`/`add_factor` 契约，禁 IO/网络/exec 等），自动补 `__init__.py`；绕过工具手工放置的因子会被 `validate_strategy` 用同一套检查拦截。因子契约：

```python
import pandas as pd

fin_cols = []  # 需要财务数据列时在此声明，否则留空

def add_factor(df: pd.DataFrame, param=None, **kwargs) -> pd.DataFrame:
    col_name = kwargs['col_name']
    df[col_name] = df['收盘价'].pct_change(20)  # 你的计算
    return df[[col_name]]
```

- 也可用因子（无需自己写）：
  - 内核内置因子：`收盘价`、`换手率`、`流通市值`、`近期停牌天数`、`异常涨跌停状态` 等（不可枚举，以 validate 通过为准）
  - real_trading 文件因子（随导入变化）：`市值`、`动量.动量20`、`波动.波动率20`、`规模.成交额Mean` 等，`get_strategy_template` 的 `availableFactors` 可查当前清单
- 验证手段：`validate_strategy` 会检查每个引用因子的文件存在性，报「因子文件不存在: X」即换个可用因子
- 因子计算用**后复权**数据，模拟成交用**原始价**（除权日靠 `前收盘价` 衔接）——理解指标时要知道这个双轨制

## 9. 完整示例（经 e2e 实盘回测验证，年化 15.49%/回撤 -22.95%）

```python
# QuantClass 选股策略配置
# run-dd20 v2: 小市值低波动+3D短持仓+动量>-5%过滤+低波动过滤0.25

backtest_name = "run-dd20_v2"

strategy_list = [
    {
        "name": "run-dd20_v2",
        "cap_weight": 1,
        "hold_period": "3D",
        "select_num": 20,
        "offset_list": [0],
        "rebalance_time": "close",
        "factor_list": [
            ["市值", True, None, 1.0],
            ["规模.成交额Mean", True, 5, 0.3],
            ["波动.波动率20", True, 20, 0.5],
        ],
        "filter_list": [
            ["市值", None, "pct:<=0.5"],
            ["波动.波动率20", 20, "pct:<=0.25", True],
            ["动量.动量20", 20, "val:>-0.05", True],
        ],
        "filter_list_post": [],
        "timing": None,
        "buy_time": "14:50:00",
        "sell_time": "14:50:00",
        "split_order_amount": 10000,
    }
]
```

## 10. 常见错误与排障

| 错误 | 原因与处理 |
|------|-----------|
| `缺少必填变量: backtest_name/strategy_list` | 顶层变量没写成字面量或缺失 |
| `因子文件不存在: X` | X 不在内置/因子库中，换可用因子（§8） |
| `择时信号文件不存在: X` | 信号名不在 real_trading/信号库 |
| `因子子目录缺少 __init__.py` | 自定义因子目录缺包结构（本期不应出现，勿自定义因子） |
| `kline 与因子行数不一致` | 个股择时 period 与因子频率不匹配（§7） |
| `语法错误: ...` | config.py 不是合法 Python 字面量结构 |
| 校验过但回测崩溃报因子依赖 | 引用的因子文件存在但其内部 import 失败（「缺少依赖」），换因子 |

## 11. 编写→验证→启用流程

1. `get_strategy_template` 查格式与可用信号（首次）
2. 写 config.py（本手册）→ `validate_strategy`（valid=true 才可继续，失败按 §10 修，单 variant ≤3 次）
3. `import_strategy` 导入（不传 capWeight）→ `set_strategy_weight(name, 1)` 启用、其他组设 0 隔离
4. `run_backtest` → `get_backtest_performance` 取 `data.parsed` 读指标

## 12. 指标口径速查（判断结果时用）

- **年化收益**：按自然日年化（`净值末^(365/日历天数)-1`）
- **最大回撤**：净值对历史高点的最大跌幅（负值），评估按绝对值
- **胜率（含0/去0）**：含0=盈利周期/全部；去0=盈利/非零周期；涨跌幅=0 计入亏损
- **盈亏收益比**：盈利周期平均涨幅 ÷ 亏损周期平均涨幅绝对值
- **每周期平均收益**：资金曲线每根 bar（日级=每交易日）涨跌幅的算术平均，不是换仓周期
