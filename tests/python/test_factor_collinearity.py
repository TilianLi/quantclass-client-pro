import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import pandas as pd

RESOURCES_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "resources")
)
sys.path.insert(0, RESOURCES_DIR)

import factor_collinearity as fc

CSV_HEADER = (
    "股票代码,股票名称,交易日期,开盘价,最高价,最低价,收盘价,前收盘价,"
    "成交量,成交额,流通市值,市值,换手率TTM"
)

MOM_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    col_name = kwargs["col_name"]
    n = int(param) if param else 10
    df[col_name] = df["收盘价"].pct_change(n)
    return df[[col_name]]
'''

MOM2_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    col_name = kwargs["col_name"]
    n = int(param) if param else 10
    df[col_name] = df["收盘价"].pct_change(n) * 2.0
    return df[[col_name]]
'''

BAD_FACTOR = '''import pandas as pd

fin_cols = []


def add_factor(df, param=None, **kwargs):
    raise RuntimeError("boom")
'''

CONFIG_TEXT = '''backtest_name = "toy"

strategy_list = [
    {
        "name": "toy",
        "factor_list": [
            ["动量.动量N", True, 10, 1.0],
            ["动量.动量N2", True, 10, 1.0],
        ],
        "filter_list": [["异常涨跌停状态", None, "bool:==0", None]],
        "filter_list_post": [],
        "cross_sections": [
            {
                "name": "截面排名差",
                "factor_list": [["流通市值", True, None, 1]],
                "is_sort_asc": True,
                "params": None,
                "args": 1,
            }
        ],
        "hold_period": "2D",
        "offset_list": [0],
        "rebalance_time": "close",
        "select_num": 3,
    }
]
'''

CONFIG_ALL_UNRESOLVED = '''backtest_name = "toy-bad"

strategy_list = [
    {
        "name": "toy-bad",
        "factor_list": [["异常涨跌停状态", True, None, 1]],
        "filter_list": [],
        "filter_list_post": [],
        "cross_sections": [],
        "hold_period": "2D",
        "offset_list": [0],
        "rebalance_time": "close",
        "select_num": 3,
    }
]
'''


def make_prices(seed, n):
    rng = np.random.default_rng(seed)
    rets = rng.normal(0.0005, 0.02, n)
    closes = 10.0 * np.cumprod(1.0 + rets)
    prevs = np.concatenate([[10.0], closes[:-1]])
    return closes, prevs


def make_stock_csv(path, code, dates, closes, prevs, share_mult=1.0):
    """按真实行情格式写 GBK CSV：第一行广告行，第二行表头。"""
    lines = ["广告行：本数据仅供测试", CSV_HEADER]
    for d, c, p in zip(dates, closes, prevs):
        lines.append(
            f"{code},测试股,{d},{c * 0.99:.2f},{c * 1.01:.2f},{c * 0.98:.2f},"
            f"{c:.4f},{p:.4f},1000000,{c * 1e6:.0f},"
            f"{c * 1e8 * share_mult:.0f},{c * 2e8 * share_mult:.0f},1.5"
        )
    with open(path, "w", encoding="gbk", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


class FixtureTestCase(unittest.TestCase):
    """全套玩具 fixture：config + 因子库 + 4 只股票 GBK 行情（tmp 目录动态生成）。"""

    N_DAYS = 60
    START = "2024-01-02"
    END = "2024-03-25"  # bdate_range(START, 60) 的最后一天

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qc-coll-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

        # variant：config.py + 因子库/动量/*.py
        self.variant_dir = os.path.join(self.tmp, "workspace", "run-t", "v1")
        self.factor_dir = os.path.join(self.variant_dir, "因子库")
        mom_dir = os.path.join(self.factor_dir, "动量")
        os.makedirs(mom_dir)
        self.config_path = os.path.join(self.variant_dir, "config.py")
        with open(self.config_path, "w", encoding="utf-8") as f:
            f.write(CONFIG_TEXT)
        self.bad_config_path = os.path.join(self.variant_dir, "config_bad.py")
        with open(self.bad_config_path, "w", encoding="utf-8") as f:
            f.write(CONFIG_ALL_UNRESOLVED)
        for name, src in (
            ("动量N", MOM_FACTOR),
            ("动量N2", MOM2_FACTOR),
            ("坏因子", BAD_FACTOR),
        ):
            with open(os.path.join(mom_dir, name + ".py"), "w", encoding="utf-8") as f:
                f.write(src)
        for d in (self.factor_dir, mom_dir):
            with open(os.path.join(d, "__init__.py"), "w", encoding="utf-8") as f:
                f.write("")

        # 行情：stock-trading-data-pro 下 4 只股票（覆盖沪深京+科创/创业前缀）
        self.data_dir = os.path.join(self.tmp, "QuantData")
        pool = os.path.join(self.data_dir, "stock-trading-data-pro")
        os.makedirs(pool)
        dates = [
            d.strftime("%Y-%m-%d")
            for d in pd.bdate_range(self.START, periods=self.N_DAYS)
        ]
        self.pool_dir = pool
        self.dates = dates
        for i, (code, mult) in enumerate(
            [
                ("sh600000", 1.0),
                ("sh680001", 2.0),
                ("sz300001", 3.0),
                ("bj430001", 4.0),
            ]
        ):
            closes, prevs = make_prices(seed=42 + i, n=self.N_DAYS)
            make_stock_csv(
                os.path.join(pool, code + ".csv"), code, dates, closes, prevs, mult
            )

    def make_params(self, **over):
        params = {
            "config_path": self.config_path,
            "factor_dirs": [self.factor_dir],
            "data_dir": self.data_dir,
            "start_date": self.START,
            "end_date": self.END,
            "filters": {"kcb": "0", "cyb": "0", "bj": "0"},
            "max_sections": 8,
            "corr_threshold": 0.8,
            "min_stocks": 2,
        }
        params.update(over)
        return params


class TestConfigParsing(FixtureTestCase):
    def test_parse_config_vars(self):
        extracted = fc.parse_config_vars(
            self.config_path, ["strategy_list", "backtest_name"]
        )
        self.assertEqual(extracted["backtest_name"], "toy")
        self.assertEqual(len(extracted["strategy_list"]), 1)
        self.assertEqual(
            extracted["strategy_list"][0]["factor_list"][0],
            ["动量.动量N", True, 10, 1.0],
        )

    def test_collect_factor_refs(self):
        extracted = fc.parse_config_vars(
            self.config_path, ["strategy_list", "backtest_name"]
        )
        refs, cross_names = fc.collect_factor_refs(extracted["strategy_list"])
        got = {(r["name"], r["param"]) for r in refs}
        self.assertIn(("动量.动量N", 10), got)  # factor_list: param 在 index 2
        self.assertIn(("动量.动量N2", 10), got)
        self.assertIn(("异常涨跌停状态", None), got)  # filter_list: param 在 index 1
        self.assertIn(("流通市值", None), got)  # cross_sections 输入时序因子
        self.assertEqual(cross_names, ["截面排名差"])

    def test_collect_factor_refs_dedup(self):
        stg = [
            {
                "factor_list": [["动量.动量N", True, 10, 1.0]],
                "filter_list": [["动量.动量N", 10, "pct:<=0.8"]],
                "cross_sections": [],
            }
        ]
        refs, _ = fc.collect_factor_refs(stg)
        self.assertEqual(len(refs), 1)

    def test_hold_period_days(self):
        self.assertEqual(fc.hold_period_days("3D"), 3)
        self.assertEqual(fc.hold_period_days("2W"), 10)
        self.assertEqual(fc.hold_period_days("bad"), 5)
        self.assertEqual(fc.hold_period_days(None), 5)

    def test_compute_rebalance_dates(self):
        cal = pd.bdate_range(self.START, periods=self.N_DAYS)
        stgs = [{"hold_period": "5D", "offset_list": [0]}]
        dates = fc.compute_rebalance_dates(stgs, cal, self.START, self.END, 60)
        self.assertEqual(dates, list(cal[::5]))
        # offset 并集
        union = fc.compute_rebalance_dates(
            [{"hold_period": "10D", "offset_list": [0, 5]}],
            cal,
            self.START,
            self.END,
            60,
        )
        self.assertEqual(union, sorted(set(list(cal[::10]) + list(cal[5::10]))))
        # max_sections 等距抽样：保留首尾
        sampled = fc.compute_rebalance_dates(
            [{"hold_period": "1D", "offset_list": [0]}],
            cal,
            self.START,
            self.END,
            4,
        )
        self.assertEqual(len(sampled), 4)
        self.assertEqual(sampled[0], cal[0])
        self.assertEqual(sampled[-1], cal[-1])


if __name__ == "__main__":
    unittest.main()
