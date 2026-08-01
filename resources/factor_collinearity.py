"""
因子共线性 / 真实复杂度度量（研究用近似口径）。

用法: python factor_collinearity.py <params_json_path>
params JSON 字段:
  config_path     variant 的 config.py 绝对路径
  factor_dirs     自定义时序因子库目录列表（通常为 <variant>/因子库）
  data_dir        QuantData 根目录（其下含 stock-trading-data-pro/）
  start_date      回测开始日期 YYYY-MM-DD
  end_date        回测结束日期 YYYY-MM-DD 或 null（= 今天）
  filters         {"kcb": "0/1", "cyb": "0/1", "bj": "0/1"}，1=过滤该板块
  max_sections    调仓日截面抽样上限（默认 60）
  corr_threshold  高相关对阈值 |ρ|（默认 0.8）
  min_stocks      截面最少股票数（默认 30，测试可调小）
结果 JSON 写 stdout（UTF-8）；业务错误也输出 {"ok": false, "error": ...}。
"""

import importlib.util
import json
import os
import subprocess
import sys
import time
import warnings

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARSE_CONFIG_SCRIPT = os.path.join(SCRIPT_DIR, "parse_config.py")

CAVEAT = "研究用近似口径：复权/停牌处理与闭源内核不保证逐位一致，数值用于相对比较"


def _deps_error(exc):
    return {
        "ok": False,
        "error": (
            f"内嵌 Python 缺少依赖: {exc}。请执行 "
            "resources/python/<arch>/python.exe -m pip install pandas numpy"
            "（或重跑 scripts/download-python.cjs）"
        ),
        "caveat": CAVEAT,
    }


try:
    import numpy as np
    import pandas as pd
except ImportError as _exc:  # pragma: no cover - 环境缺依赖时的兜底提示
    sys.stdout.buffer.write(
        json.dumps(_deps_error(_exc), ensure_ascii=False).encode("utf-8")
    )
    sys.exit(1)

# 内置因子映射表：name -> (mode, csv 列名)
# mode=price: 价量列，需后复权还原；mode=raw: 直接取列。
# 未覆盖的内置因子（近期停牌天数、异常涨跌停状态等，官方称不可枚举）
# 进 unresolved_factors，映射表随使用逐步补全。
BUILTIN_FACTOR_MAP = {
    "收盘价": ("price", "收盘价"),
    "开盘价": ("price", "开盘价"),
    "最高价": ("price", "最高价"),
    "最低价": ("price", "最低价"),
    "成交额": ("raw", "成交额"),
    "成交量": ("raw", "成交量"),
    "流通市值": ("raw", "流通市值"),
    "市值": ("raw", "市值"),
    "换手率": ("raw", "换手率TTM"),
}


def emit(obj):
    sys.stdout.buffer.write(json.dumps(obj, ensure_ascii=False).encode("utf-8"))


def analyze_or_error(params):
    """run_analysis 的业务异常统一转为 ok:false JSON（由 main 输出）。"""
    try:
        return run_analysis(params)
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}", "caveat": CAVEAT}


def parse_config_vars(config_path, var_names):
    """子进程调 parse_config.py（AST 提取 config.py 顶层变量），返回 dict。"""
    proc = subprocess.run(
        [sys.executable, PARSE_CONFIG_SCRIPT, config_path, *var_names],
        capture_output=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "parse_config.py 调用失败: "
            + proc.stderr.decode("utf-8", "replace")[:500]
        )
    data = json.loads(proc.stdout.decode("utf-8"))
    if "__error__" in data:
        raise RuntimeError(str(data["__error__"]))
    return data


def _ref_key(name, param):
    return f"{name}|{json.dumps(param, ensure_ascii=False)}"


def ref_label(ref):
    """因子在报告中的展示名：带参数时 '名称(参数)'，区分同因子不同参数。"""
    return ref["name"] if ref["param"] in (None, "") else f"{ref['name']}({ref['param']})"


def _add_ref(refs, name, param):
    if not isinstance(name, str) or not name:
        return
    refs.setdefault(_ref_key(name, param), {"name": name, "param": param})


def collect_factor_refs(strategy_list):
    """
    从 strategy_list 收集时序因子引用（按 name+param 去重）与截面产出因子名。
    factor_list 条目: [name, asc, param, weight]；filter 条目: [name, param, cond, asc?]；
    cross_sections 条目: {"name": 截面因子名, "factor_list": [factor_list 条目, ...]}。
    返回 (refs: list[dict(name, param)], cross_factor_names: list[str])。
    """
    refs = {}
    cross_names = []
    for stg in strategy_list or []:
        if not isinstance(stg, dict):
            continue
        for key in ("factor_list", "filter_list", "filter_list_post"):
            for item in stg.get(key) or []:
                if not isinstance(item, list) or not item:
                    continue
                param = item[2] if key == "factor_list" else (
                    item[1] if len(item) > 1 else None
                )
                _add_ref(refs, item[0], param)
        for cs in stg.get("cross_sections") or []:
            if not isinstance(cs, dict):
                continue
            cname = cs.get("name")
            if isinstance(cname, str) and cname and cname not in cross_names:
                cross_names.append(cname)
            for item in cs.get("factor_list") or []:
                if not isinstance(item, list) or not item:
                    continue
                param = item[2] if len(item) > 2 else None
                _add_ref(refs, item[0], param)
    return list(refs.values()), cross_names


def hold_period_days(hold_period):
    """'3D'->3（交易日步进），'2W'->10（按 5 交易日/周折算），无法解析->5。"""
    if not isinstance(hold_period, str):
        return 5
    s = hold_period.strip().upper()
    try:
        if s.endswith("D"):
            return max(1, int(s[:-1]))
        if s.endswith("W"):
            return max(1, int(s[:-1])) * 5
    except ValueError:
        pass
    return 5


def compute_rebalance_dates(strategy_list, trade_dates, start_date, end_date, max_sections):
    """
    各 strategy 按 hold_period（交易日步进）+ offset_list 生成调仓日，取并集；
    总数超 max_sections 时等距抽样（保留首尾）。
    trade_dates: 已排序的 DatetimeIndex（全市场交易日历）。
    """
    start_ts = pd.Timestamp(start_date)
    end_ts = pd.Timestamp(end_date)
    window = trade_dates[(trade_dates >= start_ts) & (trade_dates <= end_ts)]
    if len(window) == 0:
        return []
    picked = set()
    for stg in strategy_list or []:
        if not isinstance(stg, dict):
            continue
        step = hold_period_days(stg.get("hold_period"))
        offsets = stg.get("offset_list") or [0]
        for off in offsets:
            try:
                off = int(off)
            except (TypeError, ValueError):
                off = 0
            idx = off % step
            while idx < len(window):
                picked.add(window[idx])
                idx += step
    dates = sorted(picked)
    if max_sections and len(dates) > max_sections:
        sel = np.linspace(0, len(dates) - 1, max_sections).round().astype(int)
        dates = [dates[i] for i in sorted(set(sel))]
    return dates
