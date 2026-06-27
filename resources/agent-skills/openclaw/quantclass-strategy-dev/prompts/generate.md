基于以下模板生成 config.py：

{{template}}

用户目标：{{goal}}

{{#if previous}}
上一轮 variant {{previous.variantId}} 未达标：
{{previous.evaluation}}

请针对以下方向改进：
{{previous.improvement_suggestions}}
{{/if}}

请输出完整的 config.py 内容，只输出代码，不要额外解释。
