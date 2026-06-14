/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { Button } from "@/renderer/components/ui/button"
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/renderer/components/ui/popover"
import { mcpServerInfoAtom } from "@/renderer/store"
import { useAtom } from "jotai"
import { Check, Copy, ServerCog } from "lucide-react"
import { type FC, useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

export const McpStatusBadge: FC = () => {
	const [mcpInfo, setMcpInfo] = useAtom(mcpServerInfoAtom)
	const [available, setAvailable] = useState(false)
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		const fetchStatus = async () => {
			try {
				const info = await window.electronAPI.getMcpServerInfo()
				setMcpInfo(info)
				const status = await window.electronAPI.getMcpConnectionStatus()
				setAvailable(status.available)
			} catch {
				setAvailable(false)
			}
		}
		fetchStatus()

		window.electronAPI.onMcpStatusChange((_event, status) => {
			setAvailable(status.connected)
		})

		return () => {
			window.electronAPI.removeMcpStatusChangeListener()
		}
	}, [setMcpInfo])

	const configJson = JSON.stringify(
		{
			mcpServers: {
				quantclass: {
					command: "node",
					args: [mcpInfo?.mcpServerPath ?? "<mcp-server-path>"],
					env: {
						QUANTCLASS_PORT: String(mcpInfo?.port ?? 8787),
					},
				},
			},
		},
		null,
		2,
	)

	const handleCopy = useCallback(() => {
		navigator.clipboard.writeText(configJson).then(() => {
			setCopied(true)
			toast.success("MCP 配置已复制到剪贴板")
			setTimeout(() => setCopied(false), 2000)
		})
	}, [configJson])

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
				>
					<span
						className={`h-2 w-2 rounded-full ${available ? "bg-green-500" : "bg-gray-400"}`}
					/>
					<ServerCog className="h-3.5 w-3.5" />
					<span>MCP</span>
				</button>
			</PopoverTrigger>
			<PopoverContent className="w-96" align="start">
				<div className="space-y-3">
					<div className="flex items-center justify-between">
						<h4 className="font-semibold text-sm">MCP Server 配置</h4>
						<span
							className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
								available
									? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
									: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
							}`}
						>
							<span
								className={`h-1.5 w-1.5 rounded-full ${available ? "bg-green-500" : "bg-gray-400"}`}
							/>
							{available ? "可用" : "不可用"}
						</span>
					</div>

					<p className="text-xs text-muted-foreground">
						将以下配置添加到你的 AI 客户端（如 Claude Desktop、Cursor 等）的 MCP
						配置文件中：
					</p>

					<div className="relative">
						<pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto font-mono leading-relaxed">
							{configJson}
						</pre>
						<Button
							variant="ghost"
							size="icon"
							className="absolute top-2 right-2 h-6 w-6"
							onClick={handleCopy}
						>
							{copied ? (
								<Check className="h-3.5 w-3.5 text-green-500" />
							) : (
								<Copy className="h-3.5 w-3.5" />
							)}
						</Button>
					</div>

					<div className="text-xs text-muted-foreground space-y-1">
						<p>
							<span className="font-medium">端口：</span>
							{mcpInfo?.port ?? 8787}
						</p>
						<p>
							<span className="font-medium">脚本路径：</span>
							<span className="break-all">
								{mcpInfo?.mcpServerPath ?? "未获取"}
							</span>
						</p>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
