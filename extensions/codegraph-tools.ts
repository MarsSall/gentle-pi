import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEGRAPH_OPERATION = {
	INIT: "init",
	QUERY: "query",
	EXPLORE: "explore",
} as const;

const CODEGRAPH_STATUS = {
	UNAVAILABLE: "unavailable",
	FAILED: "failed",
} as const;

type CodeGraphOperation =
	(typeof CODEGRAPH_OPERATION)[keyof typeof CODEGRAPH_OPERATION];
type CodeGraphStatus = (typeof CODEGRAPH_STATUS)[keyof typeof CODEGRAPH_STATUS];

export interface CodeGraphToolParameters {
	operation: CodeGraphOperation;
	query?: string;
	limit?: number;
}

export interface CodeGraphCommandResult {
	stdout: string;
	stderr: string;
}

export interface CodeGraphRunOptions {
	cwd: string;
	signal?: AbortSignal;
	maxBuffer: number;
}

interface CodeGraphFallbackDetails {
	status: CodeGraphStatus;
	operation: CodeGraphOperation;
	cwd: string;
	args: string[];
	fallback: string;
}

export type CodeGraphRunner = (
	args: readonly string[],
	options: CodeGraphRunOptions,
) => Promise<CodeGraphCommandResult>;

const CODEGRAPH_TOOL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["operation"],
	properties: {
		operation: { type: "string", enum: Object.values(CODEGRAPH_OPERATION) },
		query: { type: "string", minLength: 1, maxLength: 2_000 },
		limit: { type: "integer", minimum: 1, maximum: 20 },
	},
} as const;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const MAX_OUTPUT_CHARS = 100_000;
const PROCESS_MAX_BUFFER = MAX_OUTPUT_CHARS * 2;
const FALLBACK_INSTRUCTIONS = "Use read, grep, and find for this exploration.";
const execFileAsync = promisify(execFile);

type ExecFileResult = Promise<CodeGraphCommandResult>;
type ExecFileFunction = (
	file: string,
	args: string[],
	options: { cwd: string; signal?: AbortSignal; maxBuffer: number },
) => ExecFileResult;

interface CodeGraphRunnerDependencies {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	execFile?: ExecFileFunction;
}

function pathEnvironment(env: NodeJS.ProcessEnv): string {
	const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
	return key === undefined ? "" : (env[key] ?? "");
}

function isInside(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
	);
}

function regularRealFile(path: string, root?: string): string {
	const link = lstatSync(path);
	if (link.isSymbolicLink() || !link.isFile())
		throw new Error(`${path} is not a regular file.`);
	const resolved = realpathSync(path);
	if (root !== undefined && !isInside(root, resolved))
		throw new Error(`${path} escapes its package root.`);
	return resolved;
}

function packageEntryFromPrefix(prefix: string): string | undefined {
	try {
		const shimNames = ["codegraph.cmd", "codegraph"];
		if (
			!shimNames.some((name) => {
				try {
					regularRealFile(join(prefix, name));
					return true;
				} catch {
					return false;
				}
			})
		)
			return undefined;

		const packageRoot = realpathSync(
			join(prefix, "node_modules", "@colbymchenry", "codegraph"),
		);
		if (!lstatSync(packageRoot).isDirectory()) return undefined;
		const packageJson = regularRealFile(
			join(packageRoot, "package.json"),
			packageRoot,
		);
		const metadata = JSON.parse(readFileSync(packageJson, "utf8")) as {
			bin?: unknown;
		};
		let bin: unknown;
		if (typeof metadata.bin === "string") {
			bin = metadata.bin;
		} else if (typeof metadata.bin === "object" && metadata.bin !== null) {
			bin = (metadata.bin as Record<string, unknown>).codegraph;
		}
		if (typeof bin !== "string" || bin.length === 0 || isAbsolute(bin))
			return undefined;
		return regularRealFile(join(packageRoot, bin), packageRoot);
	} catch {
		return undefined;
	}
}

function resolveWindowsCodeGraphEntry(env: NodeJS.ProcessEnv): string {
	for (const rawEntry of pathEnvironment(env).split(";")) {
		const prefix = rawEntry.trim().replace(/^"|"$/g, "");
		if (prefix.length === 0) continue;
		const entry = packageEntryFromPrefix(prefix);
		if (entry !== undefined) return entry;
	}
	const error = Object.assign(
		new Error(
			"No safe CodeGraph npm package entry could be resolved from PATH.",
		),
		{ code: "ENOENT" },
	);
	throw error;
}

export function createCodeGraphRunner(
	dependencies: CodeGraphRunnerDependencies = {},
): CodeGraphRunner {
	const platform = dependencies.platform ?? process.platform;
	const env = dependencies.env ?? process.env;
	const execute =
		dependencies.execFile ?? (execFileAsync as unknown as ExecFileFunction);
	// Keep this callback async so resolver errors preserve the runner's rejected-Promise contract.
	return async (args, options) => {
		const commandArgs = [...args];
		const file = platform === "win32" ? process.execPath : "codegraph";
		if (platform === "win32")
			commandArgs.unshift(resolveWindowsCodeGraphEntry(env));
		return execute(file, commandArgs, {
			cwd: options.cwd,
			signal: options.signal,
			maxBuffer: options.maxBuffer,
		});
	};
}

function resolveWorkspaceCwd(cwd: string): string {
	const resolved = realpathSync(cwd);
	if (!lstatSync(resolved).isDirectory()) {
		throw new Error(
			"CodeGraph can run only in the current workspace directory.",
		);
	}
	if (
		resolved === realpathSync(homedir()) ||
		resolved === realpathSync(tmpdir())
	) {
		throw new Error(
			"CodeGraph requires a real Git project root equal to the current workspace, not HOME or a temporary directory.",
		);
	}
	try {
		const root = realpathSync(
			execFileSync("git", ["rev-parse", "--show-toplevel"], {
				cwd: resolved,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		);
		if (root !== resolved) {
			throw new Error(
				"CodeGraph requires a real Git project root equal to the current workspace.",
			);
		}
		return resolved;
	} catch (error) {
		if (error instanceof Error && /real Git project root/.test(error.message))
			throw error;
		throw new Error(
			"CodeGraph requires a real Git project root equal to the current workspace.",
		);
	}
}

function assertSafeIndexDirectory(cwd: string): void {
	try {
		const index = lstatSync(join(cwd, ".codegraph"));
		if (index.isSymbolicLink() || !index.isDirectory()) {
			throw new Error(
				"CodeGraph .codegraph must be a real directory when it already exists.",
			);
		}
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		)
			return;
		throw error;
	}
}

function resolveLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new Error(
			`CodeGraph limit must be an integer between 1 and ${MAX_LIMIT}.`,
		);
	}
	return limit;
}

function requireQuery(query: string | undefined): string {
	if (typeof query !== "string" || query.trim().length === 0) {
		throw new Error(
			"CodeGraph query is required for query and explore operations.",
		);
	}
	if (query.length > 2_000) {
		throw new Error("CodeGraph query must not exceed 2000 characters.");
	}
	return query;
}

function commandArguments(
	parameters: CodeGraphToolParameters,
	cwd: string,
): string[] {
	switch (parameters.operation) {
		case CODEGRAPH_OPERATION.INIT:
			return [CODEGRAPH_OPERATION.INIT, cwd];
		case CODEGRAPH_OPERATION.QUERY: {
			const query = requireQuery(parameters.query);
			return [
				CODEGRAPH_OPERATION.QUERY,
				"--path",
				cwd,
				"--limit",
				String(resolveLimit(parameters.limit)),
				"--",
				query,
			];
		}
		case CODEGRAPH_OPERATION.EXPLORE: {
			const query = requireQuery(parameters.query);
			return [
				CODEGRAPH_OPERATION.EXPLORE,
				"--path",
				cwd,
				"--max-files",
				String(resolveLimit(parameters.limit)),
				"--",
				query,
			];
		}
	}
}

function truncateOutput(output: string): string {
	return output.length <= MAX_OUTPUT_CHARS
		? output
		: `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[CodeGraph output truncated]`;
}

function codeGraphFailureDetails(
	error: unknown,
	operation: CodeGraphOperation,
	cwd: string,
	args: readonly string[],
): CodeGraphFallbackDetails {
	const status =
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
			? CODEGRAPH_STATUS.UNAVAILABLE
			: CODEGRAPH_STATUS.FAILED;
	return {
		status,
		operation,
		cwd,
		args: [...args],
		fallback: FALLBACK_INSTRUCTIONS,
	};
}

function codeGraphFailureMessage(status: CodeGraphStatus): string {
	return status === CODEGRAPH_STATUS.UNAVAILABLE
		? `CodeGraph is unavailable because the codegraph binary was not found. ${FALLBACK_INSTRUCTIONS}`
		: `CodeGraph failed to run. ${FALLBACK_INSTRUCTIONS}`;
}

const runCodeGraphCommand = createCodeGraphRunner();

export function createCodeGraphTool(
	runner: CodeGraphRunner = runCodeGraphCommand,
) {
	return {
		name: "codegraph",
		label: "CodeGraph",
		description:
			"Initialize, search, or explore the CodeGraph index for the current Pi workspace only. This tool never accepts a project path or shell command.",
		promptSnippet:
			"Initialize and query CodeGraph for the current workspace without shell access",
		promptGuidelines: [
			"Use operation init before querying when the current workspace has no .codegraph index.",
			"Use query for symbol search and explore for source plus call paths. Do not use this tool to run arbitrary commands or target another directory.",
		],
		parameters: CODEGRAPH_TOOL_PARAMETERS,
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			parameters: CodeGraphToolParameters,
			signal: AbortSignal | undefined,
			_onUpdate: undefined,
			ctx: ExtensionContext,
		) {
			const cwd = resolveWorkspaceCwd(ctx.cwd);
			assertSafeIndexDirectory(cwd);
			const args = commandArguments(parameters, cwd);
			try {
				const result = await runner(args, {
					cwd,
					signal,
					maxBuffer: PROCESS_MAX_BUFFER,
				});
				const output = truncateOutput(
					[result.stdout, result.stderr].filter(Boolean).join("\n"),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: output || "CodeGraph completed without output.",
						},
					],
					details: { operation: parameters.operation, cwd, args },
				};
			} catch (error: unknown) {
				const details = codeGraphFailureDetails(
					error,
					parameters.operation,
					cwd,
					args,
				);
				return {
					content: [
						{
							type: "text" as const,
							text: codeGraphFailureMessage(details.status),
						},
					],
					details,
				};
			}
		},
	};
}

export function registerCodeGraphTool(pi: ExtensionAPI): void {
	pi.registerTool(createCodeGraphTool());
}

export default function codeGraphTools(pi: ExtensionAPI): void {
	registerCodeGraphTool(pi);
}
