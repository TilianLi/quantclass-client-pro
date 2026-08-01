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


class TestMarketData(FixtureTestCase):
    def test_load_stock_csv_gbk(self):
        df = fc.load_stock_csv(os.path.join(self.pool_dir, "sh600000.csv"))
        self.assertEqual(len(df), self.N_DAYS)
        self.assertEqual(df.index.name, "交易日期")
        self.assertIn("换手率TTM", df.columns)
        self.assertEqual(df.index[0], pd.Timestamp(self.START))
        self.assertEqual(df.index[-1], pd.Timestamp(self.END))

    def test_hfq_restore_ex_dividend(self):
        # 除权日：前收盘价为除权参考价（5.5），收盘价 5.5 → 真实收益 0
        df = pd.DataFrame(
            {"收盘价": [10.0, 11.0, 5.5], "前收盘价": [10.0, 10.0, 5.5]},
            index=pd.bdate_range("2024-01-02", periods=3),
        )
        hfq_close, ratio = fc.hfq_restore(df)
        np.testing.assert_allclose(hfq_close.to_numpy(), [10.0, 11.0, 11.0], atol=1e-9)
        np.testing.assert_allclose(ratio.to_numpy(), [1.0, 1.0, 2.0], atol=1e-9)

    def test_pool_dir_fallback(self):
        # 只有 stock-trading-data（无 -pro）时回退
        legacy = os.path.join(self.tmp, "LegacyData")
        os.makedirs(os.path.join(legacy, "stock-trading-data"))
        self.assertEqual(
            fc._pool_dir(legacy), os.path.join(legacy, "stock-trading-data")
        )
        self.assertEqual(
            fc._pool_dir(self.data_dir),
            os.path.join(self.data_dir, "stock-trading-data-pro"),
        )
        with self.assertRaises(RuntimeError) as ctx:
            fc._pool_dir(os.path.join(self.tmp, "nonexistent"))
        self.assertIn("ALL_DATA_PATH", str(ctx.exception))

    def test_list_stock_pool_filters(self):
        _, all_codes = fc.list_stock_pool(
            self.data_dir, {"kcb": "0", "cyb": "0", "bj": "0"}
        )
        self.assertEqual(
            all_codes, ["bj430001", "sh600000", "sh680001", "sz300001"]
        )
        _, filtered = fc.list_stock_pool(
            self.data_dir, {"kcb": "1", "cyb": "1", "bj": "1"}
        )
        self.assertEqual(filtered, ["sh600000"])

    def test_load_trade_calendar(self):
        cal = fc.load_trade_calendar(self.data_dir)
        self.assertEqual(len(cal), self.N_DAYS)
        self.assertEqual(cal[0], pd.Timestamp(self.START))


class TestFactorCompute(FixtureTestCase):
    def _load_df(self, code="sh600000"):
        return fc.load_stock_csv(os.path.join(self.pool_dir, code + ".csv"))

    def test_load_custom_factor_module(self):
        module, path = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        self.assertTrue(path.endswith(os.path.join("动量", "动量N.py")))
        self.assertTrue(hasattr(module, "add_factor"))
        # 裸名 → 因子库/名.py
        bare_dir = os.path.join(self.tmp, "bare-lib")
        os.makedirs(bare_dir)
        with open(os.path.join(bare_dir, "动量N.py"), "w", encoding="utf-8") as f:
            f.write(MOM_FACTOR)
        module2, _ = fc.load_custom_factor_module([bare_dir], "动量N")
        self.assertTrue(hasattr(module2, "add_factor"))
        # 找不到 → (None, 候选路径)
        module3, candidates = fc.load_custom_factor_module(
            [self.factor_dir], "不存在因子"
        )
        self.assertIsNone(module3)
        self.assertEqual(len(candidates), 1)

    def test_compute_stock_factor_frame(self):
        df = self._load_df()
        mom_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        bad_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.坏因子")
        specs = [
            {
                "label": "收盘价",
                "name": "收盘价",
                "param": None,
                "kind": "builtin",
                "builtin": fc.BUILTIN_FACTOR_MAP["收盘价"],
            },
            {
                "label": "动量.动量N(10)",
                "name": "动量.动量N",
                "param": 10,
                "kind": "custom",
                "module": mom_mod,
            },
            {
                "label": "动量.坏因子",
                "name": "动量.坏因子",
                "param": None,
                "kind": "custom",
                "module": bad_mod,
            },
        ]
        frame, errors = fc.compute_stock_factor_frame(df, specs)
        self.assertIn("收盘价", frame.columns)
        self.assertIn("动量.动量N(10)", frame.columns)
        # 坏因子不进矩阵，错误被记录（单因子不拖垮整体）
        self.assertNotIn("动量.坏因子", frame.columns)
        self.assertIn("动量.坏因子", errors)
        # builtin 收盘价 = 后复权收盘价
        hfq_close, _ = fc.hfq_restore(df)
        pd.testing.assert_series_equal(frame["收盘价"], hfq_close, check_names=False)
        # 自定义因子收到的是后复权数据：与 hfq 收盘价 pct_change(10) 一致
        expected = hfq_close.pct_change(10)
        pd.testing.assert_series_equal(
            frame["动量.动量N(10)"], expected, check_names=False
        )

    def test_compute_stock_factor_frame_uses_hfq(self):
        # 构造含除权日的数据：自定义因子应基于后复权价，不出现 -50% 假跌幅
        dates = pd.bdate_range("2024-01-02", periods=15)
        closes = [10.0] * 7 + [5.0] * 8
        prevs = [10.0] * 7 + [5.0] + [5.0] * 7  # 第 8 天除权（参考价同步 5.0）
        df = pd.DataFrame(
            {"收盘价": closes, "前收盘价": prevs, "成交额": [1e6] * 15},
            index=dates,
        )
        mom_mod, _ = fc.load_custom_factor_module([self.factor_dir], "动量.动量N")
        specs = [
            {
                "label": "m",
                "name": "动量.动量N",
                "param": 5,
                "kind": "custom",
                "module": mom_mod,
            }
        ]
        frame, errors = fc.compute_stock_factor_frame(df, specs)
        self.assertEqual(errors, {})
        # 后复权价全程不变 → 动量恒为 0；若误用原始价，除权日会出现 -0.5
        np.testing.assert_allclose(frame["m"].dropna().to_numpy(), 0.0, atol=1e-9)

    def test_align_and_build_sections(self):
        # 用内置收盘价因子（全程非 NaN），避免 rolling 预热期干扰截面计数断言
        df = self._load_df()
        specs = [
            {
                "label": "收盘价",
                "name": "收盘价",
                "param": None,
                "kind": "builtin",
                "builtin": fc.BUILTIN_FACTOR_MAP["收盘价"],
            }
        ]
        frame, _ = fc.compute_stock_factor_frame(df, specs)
        section_dates = list(pd.bdate_range(self.START, periods=self.N_DAYS)[::10])
        aligned = fc.align_to_sections(frame, section_dates)
        self.assertEqual(list(aligned.index), section_dates)
        # as-of 语义：截面日取值 = 截至当日最后可见值
        for d in section_dates:
            self.assertEqual(
                aligned.loc[d, "收盘价"],
                frame.loc[:d, "收盘价"].iloc[-1],
            )
        matrices = fc.build_section_matrices(
            {"sh600000": aligned, "sz300001": aligned}, section_dates, min_stocks=2
        )
        self.assertEqual(len(matrices), len(section_dates))
        _, mat = matrices[0]
        self.assertEqual(sorted(mat.index), ["sh600000", "sz300001"])
        # 股票数不足 min_stocks 的截面被剔除
        few = fc.build_section_matrices({"sh600000": aligned}, section_dates, 2)
        self.assertEqual(few, [])


if __name__ == "__main__":
    unittest.main()
