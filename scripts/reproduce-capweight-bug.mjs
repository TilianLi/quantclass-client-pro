/**
 * 复现并验证 MCP import_strategy capWeight 修复。
 *
 * 提取 mcp.ts 中策略导入的权重处理逻辑，用模拟数据验证：
 * 修复前 kernelStrategies 使用原始 strategyData，capWeight 不生效；
 * 修复后 kernelStrategies 使用 resetCapWeight 后的数据，capWeight 生效。
 */

// 模拟 parsePythonConfig 返回的 strategy_list（选股策略）
const mockStrategyList = [
  {
    name: "策略A",
    cap_weight: 0.3,
    hold_period: 5,
    offset_list: [0, 1],
    select_num: 10,
    factor_list: [],
    filter_list: [],
    rebalance_time: "close-open",
  },
  {
    name: "策略B",
    cap_weight: 0.7,
    hold_period: 10,
    offset_list: [0],
    select_num: 20,
    factor_list: [],
    filter_list: [],
    rebalance_time: "close-open",
  },
]

const genSelectStgInfoForKernel = (strategy, includeInfo = true) => {
  return {
    name: strategy.name,
    cap_weight: strategy.cap_weight,
    hold_period: strategy.hold_period,
    offset_list: strategy.offset_list,
    select_num: Number.parseInt(String(strategy.select_num)),
    factor_list: strategy.factor_list,
    filter_list: strategy.filter_list,
    ...(strategy.filter_list_post !== undefined
      ? { filter_list_post: strategy.filter_list_post }
      : {}),
    ...(strategy.cross_sections !== undefined
      ? { cross_sections: strategy.cross_sections }
      : {}),
    ...(strategy.stock_timing_list !== undefined
      ? { stock_timing_list: strategy.stock_timing_list }
      : {}),
    rebalance_time: strategy.rebalance_time,
    timing: strategy.timing ?? null,
    scalein_targets: strategy.scalein_targets ?? null,
    override: strategy.override ?? null,
    ...(includeInfo ? { info: strategy.info ?? {} } : {}),
  }
}

// 修复前 mcp.ts 中的 resetCapWeight 实现
function resetCapWeightBefore(strategies, weight) {
  if (Array.isArray(strategies)) {
    return strategies.map((item) => {
      if (item && typeof item === "object") {
        const obj = { ...item, cap_weight: weight }
        if ("strategy_list" in obj && Array.isArray(obj.strategy_list)) {
          obj.strategy_list = obj.strategy_list.map((s) => ({
            ...s,
            cap_weight: s.cap_weight ?? 1,
          }))
        }
        if ("strategy_pool" in obj && Array.isArray(obj.strategy_pool)) {
          obj.strategy_pool = resetCapWeightBefore(obj.strategy_pool, weight)
        }
        return obj
      }
      return item
    })
  }
  return strategies
}

// 修复后 mcp.ts 中的 resetCapWeight 实现（嵌套 strategy_list 也应用 weight）
function resetCapWeightAfter(strategies, weight) {
  if (Array.isArray(strategies)) {
    return strategies.map((item) => {
      if (item && typeof item === "object") {
        const obj = { ...item, cap_weight: weight }
        if ("strategy_list" in obj && Array.isArray(obj.strategy_list)) {
          obj.strategy_list = obj.strategy_list.map((s) => ({
            ...s,
            cap_weight: weight,
          }))
        }
        if ("strategy_pool" in obj && Array.isArray(obj.strategy_pool)) {
          obj.strategy_pool = resetCapWeightAfter(obj.strategy_pool, weight)
        }
        return obj
      }
      return item
    })
  }
  return strategies
}

// 修复前 select 库的 kernelStrategies 生成
function buildSelectKernelBefore(strategyData, weight) {
  const finalStrategies = resetCapWeightBefore(strategyData, weight)
  const kernelStrategies = strategyData.map((s) =>
    genSelectStgInfoForKernel(s, false),
  )
  return { finalStrategies, kernelStrategies }
}

// 修复后 select 库的 kernelStrategies 生成
function buildSelectKernelAfter(strategyData, weight) {
  const weightedStrategyData = resetCapWeightAfter(strategyData, weight)
  const finalStrategies = weightedStrategyData
  const kernelStrategies = weightedStrategyData.map((s) =>
    genSelectStgInfoForKernel(s, false),
  )
  return { finalStrategies, kernelStrategies }
}

function printCapWeights(label, strategies) {
  console.log(`\n${label}:`)
  for (const s of strategies) {
    console.log(`  ${s.name}: cap_weight = ${s.cap_weight}`)
  }
}

console.log("=== 选股策略库 (libraryType=select), capWeight=1 ===")
const { kernelStrategies: kBeforeSelect } = buildSelectKernelBefore(
  mockStrategyList,
  1,
)
const { kernelStrategies: kAfterSelect } = buildSelectKernelAfter(
  mockStrategyList,
  1,
)
printCapWeights("修复前 kernelStrategies", kBeforeSelect)
printCapWeights("修复后 kernelStrategies", kAfterSelect)

const beforeAllOne = kBeforeSelect.every((s) => s.cap_weight === 1)
const afterAllOne = kAfterSelect.every((s) => s.cap_weight === 1)

console.log("\n=== 验证结果 ===")
console.log(
  `修复前所有策略 cap_weight 均为 1: ${beforeAllOne} (实际: [${kBeforeSelect.map((s) => s.cap_weight).join(", ")}])`,
)
console.log(
  `修复后所有策略 cap_weight 均为 1: ${afterAllOne} (实际: [${kAfterSelect.map((s) => s.cap_weight).join(", ")}])`,
)

if (!beforeAllOne && afterAllOne) {
  console.log("\n✅ 修复有效：capWeight=1 现在会正确写入内核策略配置。")
  process.exit(0)
} else {
  console.log("\n❌ 修复验证失败")
  process.exit(1)
}
