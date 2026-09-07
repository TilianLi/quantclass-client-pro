# quantclass-client
# Copyright (c) 2025 量化小讲堂
#
# Licensed under the Business Source License 1.1 (BUSL-1.1).
# Additional Use Grant: None
# Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
# See the LICENSE file and https://mariadb.com/bsl11/
"""
check_factor.py — 因子源码静态检查（语法 + AST 白名单 + 接口提取）

用法: python check_factor.py <source.py>
输出: JSON {"ok": bool, "errors": [...], "warnings": [...], "interface": {...}}

因子契约（与内核 factor_hub 一致）:
    import pandas as pd
    fin_cols = []
    def add_factor(df, param=None, **kwargs):
        col_name = kwargs["col_name"]
        df[col_name] = ...
        return df[[col_name]]
"""

import ast
import json
import sys

# 仅允许纯计算库；os/sys/subprocess/socket/requests 等一律拒绝
ALLOWED_IMPORTS = {
    "pandas", "numpy", "math", "statistics", "typing", "datetime",
    "functools", "itertools", "collections", "dataclasses", "enum",
    "abc", "numbers",
}

# 截面因子额外允许：core（内核自身库）与 scipy（科学计算）
CROSS_EXTRA_IMPORTS = {"core", "scipy"}

FORBIDDEN_CALLS = {
    "open", "exec", "eval", "__import__", "compile", "input",
    "breakpoint", "exit", "quit", "globals", "locals", "vars",
}

FORBIDDEN_ATTRS = {
    "__globals__", "__builtins__", "__import__", "__subclasses__",
    "__base__", "__bases__", "__mro__", "__code__", "__closure__",
    "__getattribute__", "__dict__", "__class__",
}

# 数据中心常见行情/ID 列（仅用于提示，非强制）
COMMON_COLUMNS = {
    "开盘价", "收盘价", "最高价", "最低价", "成交额", "成交量",
    "前收盘价", "复权因子", "开盘价_复权", "收盘价_复权",
    "最高价_复权", "最低价_复权", "涨跌幅", "换手率", "总市值", "流通市值",
    "交易日期", "股票代码",
}


def check(path, kind="factor"):
    errors = []
    warnings = []

    if kind not in ("factor", "cross_factor"):
        return {
            "ok": False,
            "errors": [f"未知因子类型: {kind}（支持 factor / cross_factor）"],
            "warnings": [],
            "interface": {},
        }
    allowed_imports = ALLOWED_IMPORTS | (
        CROSS_EXTRA_IMPORTS if kind == "cross_factor" else set()
    )

    try:
        with open(path, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as e:
        return {"ok": False, "errors": [f"读取失败: {e}"], "warnings": [], "interface": {}}

    try:
        tree = ast.parse(source)
    except SyntaxError as e:
        return {"ok": False, "errors": [f"语法错误: {e}"], "warnings": [], "interface": {}}

    has_add_factor = False
    fin_cols = None
    ov_cols = None
    referenced = set()
    assigned = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                root = a.name.split(".")[0]
                if root not in allowed_imports:
                    errors.append(f"禁止的 import: {a.name}（仅允许纯计算库）")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root not in allowed_imports:
                errors.append(f"禁止的 from import: {node.module}（仅允许纯计算库）")
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name) and func.id in FORBIDDEN_CALLS:
                errors.append(f"禁止调用: {func.id}()")
        elif isinstance(node, ast.Attribute):
            if node.attr in FORBIDDEN_ATTRS:
                errors.append(f"禁止访问属性: {node.attr}")
        elif isinstance(node, ast.FunctionDef) and node.name == "add_factor":
            has_add_factor = True
            if len(node.args.args) < 1:
                errors.append("add_factor 签名缺少 df 参数")
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in ("fin_cols", "ov_cols"):
                    target = t.id
                    if isinstance(node.value, (ast.List, ast.Tuple)):
                        value = [
                            elt.value
                            for elt in node.value.elts
                            if isinstance(elt, ast.Constant) and isinstance(elt.value, str)
                        ]
                        if target == "fin_cols":
                            fin_cols = value
                        else:
                            ov_cols = value
                    else:
                        warnings.append(f"{target} 应为字符串列表字面量")
                # 记录 df['临时列'] = ... 的本地赋值（后续读取不再告警）
                elif (
                    isinstance(t, ast.Subscript)
                    and isinstance(t.value, ast.Name)
                    and t.value.id == "df"
                    and isinstance(t.slice, ast.Constant)
                    and isinstance(t.slice.value, str)
                ):
                    assigned.add(t.slice.value)
        elif isinstance(node, ast.Subscript):
            # 收集 df['列名'] 引用（仅基名为 df 的约定数据帧）
            v, s = node.value, node.slice
            if (
                isinstance(v, ast.Name)
                and v.id == "df"
                and isinstance(s, ast.Constant)
                and isinstance(s.value, str)
            ):
                referenced.add(s.value)

    if not has_add_factor:
        errors.append("缺少 add_factor(df, param=None, **kwargs) 函数")
    if fin_cols is None:
        errors.append("缺少模块级 fin_cols 列表（无财务列需求时写 fin_cols = []）")
    if kind == "cross_factor" and ov_cols is None:
        errors.append("截面因子缺少模块级 ov_cols 列表（无额外数据列需求时写 ov_cols = []）")

    for col in sorted(referenced - assigned):
        if col not in COMMON_COLUMNS:
            warnings.append(f"引用非常见数据列: '{col}'（请确认数据中心存在该列或在 fin_cols 声明）")

    return {
        "ok": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "interface": {
            "kind": kind,
            "add_factor": has_add_factor,
            "fin_cols": fin_cols,
            "ov_cols": ov_cols,
            "referenced_columns": sorted(referenced),
        },
    }


if __name__ == "__main__":
    # ensure_ascii=True：输出纯 ASCII（\uXXXX 转义），
    # 避免 Windows GBK 控制台下 Node 端按 utf-8 解码出现乱码
    kind = sys.argv[2] if len(sys.argv) > 2 else "factor"
    print(json.dumps(check(sys.argv[1], kind), ensure_ascii=True))
