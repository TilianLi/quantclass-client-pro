/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_PORT = 8787
const MCP_PORT_FILE = join(homedir(), ".quantclass", "mcp-port")
const MCP_TOKEN_FILE = join(homedir(), ".quantclass", "mcp-token")

/**
 * 解析端口字符串，非法值返回 null。
 */
function parsePort(raw: string | undefined): number | null {
	if (!raw) return null
	const port = Number.parseInt(raw, 10)
	if (Number.isNaN(port) || port <= 0 || port >= 65536) return null
	return port
}

/**
 * MCP Server 端口发现：env → ~/.quantclass/mcp-port → 默认 8787。
 *
 * - env 优先（QUANTCLASS_PORT）
 * - 其次读取 home 目录下的端口文件（主进程 writeMcpPortFile 写入）
 * - 任意读取错误（文件不存在 / 权限 / 解析失败）一律静默回退到默认端口
 */
export function getPort(): number {
	const envPort = parsePort(process.env.QUANTCLASS_PORT)
	if (envPort !== null) return envPort

	try {
		if (existsSync(MCP_PORT_FILE)) {
			const content = readFileSync(MCP_PORT_FILE, "utf-8").trim()
			const filePort = parsePort(content)
			if (filePort !== null) return filePort
		}
	} catch {
		// 文件不存在 / 读取失败 / 解析非法 —— 静默回退默认端口
	}

	return DEFAULT_PORT
}

/**
 * 读取 MCP 鉴权 token（由主进程写入 ~/.quantclass/mcp-token）。
 * 读取失败时返回 null，对应请求不会携带 Authorization 头，
 * 服务端 /status 仍可访问，其他路由会返回 401。
 */
function getToken(): string | null {
	try {
		if (existsSync(MCP_TOKEN_FILE)) {
			return readFileSync(MCP_TOKEN_FILE, "utf-8").trim() || null
		}
	} catch {
		// 文件不存在 / 读取失败 —— 静默返回 null
	}
	return null
}

function getBaseUrl(): string {
	return `http://127.0.0.1:${getPort()}`
}

const REQUEST_TIMEOUT = 10_000

export interface RequestOptions {
	method: "GET" | "POST" | "PUT" | "DELETE"
	path: string
	body?: unknown
	timeoutMs?: number
}

export async function request<T = unknown>(
	options: RequestOptions,
): Promise<T> {
	const { method, path, body, timeoutMs } = options
	const url = `${getBaseUrl()}${path}`

	const controller = new AbortController()
	const timeout = setTimeout(
		() => controller.abort(),
		timeoutMs ?? REQUEST_TIMEOUT,
	)

	try {
		const token = getToken()
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		}
		if (token) {
			headers.Authorization = `Bearer ${token}`
		}

		const response = await fetch(url, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		})

		if (!response.ok) {
			const text = await response.text().catch(() => "")
			throw new Error(
				`QuantClass API 请求失败: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`,
			)
		}

		const contentType = response.headers.get("content-type")
		if (contentType?.includes("application/json")) {
			return (await response.json()) as T
		}
		return (await response.text()) as unknown as T
	} catch (error) {
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				const actualTimeout = timeoutMs ?? REQUEST_TIMEOUT
				throw new Error(
					`QuantClass API 请求超时: ${method} ${path} (${actualTimeout}ms)。请确认 QuantClass 客户端正在运行。`,
				)
			}
			if (
				error.message.includes("ECONNREFUSED") ||
				error.message.includes("fetch failed")
			) {
				throw new Error(
					`无法连接到 QuantClass 客户端 (${url})。请确认应用已启动并且端口配置正确。`,
				)
			}
			throw error
		}
		throw new Error(`未知错误: ${String(error)}`)
	} finally {
		clearTimeout(timeout)
	}
}

export async function get<T = unknown>(
	path: string,
	timeoutMs?: number,
): Promise<T> {
	return request<T>({ method: "GET", path, timeoutMs })
}

export async function post<T = unknown>(
	path: string,
	body?: unknown,
	timeoutMs?: number,
): Promise<T> {
	return request<T>({ method: "POST", path, body, timeoutMs })
}

export async function put<T = unknown>(
	path: string,
	body?: unknown,
): Promise<T> {
	return request<T>({ method: "PUT", path, body })
}
