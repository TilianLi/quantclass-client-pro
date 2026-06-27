import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"

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

export function listRuns(): string[] {
	if (!existsSync(WORKSPACE_ROOT)) return []
	return readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
}

export function listVariants(runId: string): string[] {
	const runPath = join(WORKSPACE_ROOT, runId)
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
	const filePath = join(WORKSPACE_ROOT, runId, variantId, filename)
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
	const dir = join(WORKSPACE_ROOT, runId, variantId)
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true })
	}
	writeFileSync(join(dir, filename), content, "utf-8")
}

export function listStrategyFiles(runId: string, variantId: string): string[] {
	const dir = join(WORKSPACE_ROOT, runId, variantId)
	if (!existsSync(dir)) return []
	return readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isFile())
		.map((d) => d.name)
}
