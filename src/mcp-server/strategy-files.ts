/**
 * quantclass-client
 * Copyright (c) 2025 量化小讲堂
 *
 * Licensed under the Business Source License 1.1 (BUSL-1.1).
 * Additional Use Grant: None
 * Change Date: 2028-08-22 | Change License: GPL-3.0-or-later
 * See the LICENSE file and https://mariadb.com/bsl11/
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"

const WORKSPACE_ROOT = process.env.QUANTCLASS_AGENT_WORKSPACE
	? process.env.QUANTCLASS_AGENT_WORKSPACE
	: join(process.cwd(), "workspace", "agent-strategies")

export interface StrategyVariant {
	runId: string
	variantId: string
	path: string
}

export function getWorkspaceRoot(): string {
	return WORKSPACE_ROOT
}

function assertSafePathComponent(name: string, label: string): void {
	if (!name || typeof name !== "string") {
		throw new Error(`${label} 不能为空`)
	}
	if (name.includes("..") || name.includes("/") || name.includes("\\")) {
		throw new Error(`${label} 包含非法字符: ${name}`)
	}
}

function assertInsideWorkspace(targetPath: string): string {
	const resolvedRoot = resolve(WORKSPACE_ROOT)
	const resolvedTarget = resolve(targetPath)
	const rel = relative(resolvedRoot, resolvedTarget)
	if (rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`路径超出工作区: ${targetPath}`)
	}
	return resolvedTarget
}

export function listRuns(): string[] {
	if (!existsSync(WORKSPACE_ROOT)) return []
	return readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
}

export function listVariants(runId: string): string[] {
	assertSafePathComponent(runId, "runId")
	const runPath = assertInsideWorkspace(join(WORKSPACE_ROOT, runId))
	if (!existsSync(runPath)) return []
	return readdirSync(runPath, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.startsWith("v"))
		.map((d) => d.name)
		.sort()
}

export function readStrategyFile(
	runId: string,
	variantId: string,
	filename: string,
): string {
	assertSafePathComponent(runId, "runId")
	assertSafePathComponent(variantId, "variantId")
	assertSafePathComponent(filename, "filename")
	const filePath = assertInsideWorkspace(
		join(WORKSPACE_ROOT, runId, variantId, filename),
	)
	if (!existsSync(filePath)) {
		throw new Error(`文件不存在: ${filePath}`)
	}
	return readFileSync(filePath, "utf-8")
}

export function writeStrategyFile(
	runId: string,
	variantId: string,
	filename: string,
	content: string,
): void {
	assertSafePathComponent(runId, "runId")
	assertSafePathComponent(variantId, "variantId")
	assertSafePathComponent(filename, "filename")
	const dir = assertInsideWorkspace(join(WORKSPACE_ROOT, runId, variantId))
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	const filePath = assertInsideWorkspace(join(dir, filename))
	writeFileSync(filePath, content, "utf-8")
}

export function listStrategyFiles(runId: string, variantId: string): string[] {
	assertSafePathComponent(runId, "runId")
	assertSafePathComponent(variantId, "variantId")
	const dir = assertInsideWorkspace(join(WORKSPACE_ROOT, runId, variantId))
	if (!existsSync(dir)) return []
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => d.name)
}
