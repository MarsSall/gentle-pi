import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import codeGraphTools, {
	createCodeGraphRunner,
	createCodeGraphTool,
	type CodeGraphRunner,
} from "../extensions/codegraph-tools.ts";

function fakeGlobalPackage(t: test.TestContext): {
	prefix: string;
	entry: string;
} {
	const prefix = mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-global-"));
	t.after(() => rmSync(prefix, { recursive: true, force: true }));
	const root = join(prefix, "node_modules", "@colbymchenry", "codegraph");
	const entry = join(root, "dist", "cli.js");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(prefix, "codegraph.cmd"), "npm shim");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ bin: { codegraph: "dist/cli.js" } }),
	);
	writeFileSync(entry, "console.log('codegraph')");
	return { prefix, entry };
}

function workspace(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-")));
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	return cwd;
}

test("Windows runner resolves an npm global package from PATH without losing argument boundaries", async (t) => {
	const { prefix, entry } = fakeGlobalPackage(t);
	const hostile = "symbol & whoami | echo hacked > owned $(calc)";
	const signal = new AbortController().signal;
	const calls: Array<{
		file: string;
		args: string[];
		options: Record<string, unknown>;
	}> = [];
	const runner = createCodeGraphRunner({
		platform: "win32",
		env: { PATH: prefix },
		execFile: async (file, args, options) => {
			calls.push({ file, args, options });
			return { stdout: "safe", stderr: "" };
		},
	});

	const result = await runner(["query", "--", hostile], {
		cwd: prefix,
		signal,
		maxBuffer: 1234,
	});

	assert.deepEqual(result, { stdout: "safe", stderr: "" });
	assert.deepEqual(calls, [
		{
			file: process.execPath,
			args: [entry, "query", "--", hostile],
			options: { cwd: prefix, signal, maxBuffer: 1234 },
		},
	]);
});

test("runner preserves direct shell-free Unix execution", async () => {
	const signal = new AbortController().signal;
	const calls: Array<{
		file: string;
		args: string[];
		options: Record<string, unknown>;
	}> = [];
	const runner = createCodeGraphRunner({
		platform: "linux",
		execFile: async (file, args, options) => {
			calls.push({ file, args, options });
			return { stdout: "ok", stderr: "" };
		},
	});

	await runner(["query", "--", "a;b"], { cwd: "/repo", signal, maxBuffer: 99 });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.args[2], "a;b");
	assert.deepEqual(calls, [
		{
			file: "codegraph",
			args: ["query", "--", "a;b"],
			options: { cwd: "/repo", signal, maxBuffer: 99 },
		},
	]);
	assert.equal(calls[0]?.options.signal, signal);
});

test("Windows runner reports unavailable when no safe npm package can be resolved", async (t) => {
	const empty = mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-empty-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	let calls = 0;
	const runner = createCodeGraphRunner({
		platform: "win32",
		env: { PATH: empty },
		execFile: async () => {
			calls += 1;
			return { stdout: "unexpected", stderr: "" };
		},
	});

	await assert.rejects(
		() => runner([], { cwd: empty, maxBuffer: 1 }),
		(error: NodeJS.ErrnoException) => {
			assert.equal(error.code, "ENOENT");
			assert.match(error.message, /safe CodeGraph npm package entry/i);
			return true;
		},
	);
	assert.equal(calls, 0);
});

test("Windows runner rejects malformed metadata and package-bin escapes", async (t) => {
	for (const bin of [undefined, "../outside.js"] as const) {
		const { prefix } = fakeGlobalPackage(t);
		const root = join(prefix, "node_modules", "@colbymchenry", "codegraph");
		writeFileSync(
			join(root, "package.json"),
			bin === undefined ? "{" : JSON.stringify({ bin }),
		);
		writeFileSync(
			join(prefix, "node_modules", "@colbymchenry", "outside.js"),
			"outside",
		);
		const runner = createCodeGraphRunner({
			platform: "win32",
			env: { PATH: prefix },
			execFile: async () => ({ stdout: "unexpected", stderr: "" }),
		});
		await assert.rejects(
			() => runner([], { cwd: prefix, maxBuffer: 1 }),
			(error: NodeJS.ErrnoException) => error.code === "ENOENT",
		);
	}
});

test("Windows runner rejects a symlinked package bin that escapes its package root", async (t) => {
	const { prefix, entry } = fakeGlobalPackage(t);
	const outside = join(prefix, "outside.js");
	writeFileSync(outside, "outside");
	rmSync(entry);
	try {
		symlinkSync(outside, entry, "file");
	} catch (error: unknown) {
		t.skip(`symlinks unavailable: ${String(error)}`);
		return;
	}
	const runner = createCodeGraphRunner({
		platform: "win32",
		env: { PATH: prefix },
		execFile: async () => ({ stdout: "unexpected", stderr: "" }),
	});
	await assert.rejects(
		() => runner([], { cwd: prefix, maxBuffer: 1 }),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});

test("CodeGraph tool rejects non-project, nested-project, HOME, and temporary workspaces before init", async (t) => {
	const nonProject = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-non-project-")));
	t.after(() => rmSync(nonProject, { recursive: true, force: true }));
	const root = workspace(t);
	const nested = join(root, "nested");
	mkdirSync(nested);
	let calls = 0;
	const tool = createCodeGraphTool(async () => {
		calls += 1;
		return { stdout: "unexpected", stderr: "" };
	});
	for (const cwd of [nonProject, nested, homedir(), tmpdir()]) {
		await assert.rejects(
			() => tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext),
			/real Git project root equal to the current workspace/i,
		);
	}
	assert.equal(calls, 0);
});

test("CodeGraph tool runs only fixed cwd-scoped init, query, and explore commands", async (t) => {
	const cwd = workspace(t);
	const calls: Array<{ args: readonly string[]; cwd: string }> = [];
	const runner: CodeGraphRunner = async (args, options) => {
		calls.push({ args, cwd: options.cwd });
		return { stdout: "indexed", stderr: "" };
	};
	const tool = createCodeGraphTool(runner);
	const ctx = { cwd } as ExtensionContext;

	for (const parameters of [
		{ operation: "init" },
		{ operation: "query", query: "buildGentlePrompt", limit: 4 },
		{ operation: "explore", query: "review gate", limit: 3 },
	] as const) {
		const result = await tool.execute("test", parameters, undefined, undefined, ctx);
		assert.deepEqual(result.content, [{ type: "text", text: "indexed" }]);
	}

	assert.deepEqual(calls, [
		{ args: ["init", cwd], cwd },
		{
			args: ["query", "--path", cwd, "--limit", "4", "--", "buildGentlePrompt"],
			cwd,
		},
		{
			args: ["explore", "--path", cwd, "--max-files", "3", "--", "review gate"],
			cwd,
		},
	]);
});

test("CodeGraph tool rejects pre-existing .codegraph symlinks and non-directories", async (t) => {
	for (const kind of ["symlink", "file"] as const) {
		const cwd = workspace(t);
		const indexPath = join(cwd, ".codegraph");
		if (kind === "symlink") {
			const outside = join(cwd, "outside");
			mkdirSync(outside);
			symlinkSync(outside, indexPath);
		} else {
			writeFileSync(indexPath, "not an index directory");
		}
		let calls = 0;
		const tool = createCodeGraphTool(async () => {
			calls += 1;
			return { stdout: "unexpected", stderr: "" };
		});

		await assert.rejects(
			() => tool.execute("test", { operation: "init" }, undefined, undefined, { cwd } as ExtensionContext),
			/must be a real directory/i,
		);
		assert.equal(calls, 0, `${kind} index must not execute CodeGraph`);
	}
});

test("CodeGraph tool passes hyphen-leading queries after the option terminator", async (t) => {
	const cwd = workspace(t);
	const calls: Array<readonly string[]> = [];
	const tool = createCodeGraphTool(async (args) => {
		calls.push(args);
		return { stdout: "safe", stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	await tool.execute("test", { operation: "query", query: "--help" }, undefined, undefined, ctx);

	assert.deepEqual(calls, [
		["query", "--path", cwd, "--limit", "10", "--", "--help"],
	]);
});

test("CodeGraph tool returns structured fallback instructions when the binary is unavailable", async (t) => {
	const cwd = workspace(t);
	const unavailable = Object.assign(new Error("spawn codegraph ENOENT"), { code: "ENOENT" });
	const tool = createCodeGraphTool(async () => {
		throw unavailable;
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "query", query: "symbol" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{
		type: "text",
		text: "CodeGraph is unavailable because the codegraph binary was not found. Use read, grep, and find for this exploration.",
	}]);
	assert.deepEqual(result.details, {
		status: "unavailable",
		operation: "query",
		cwd,
		args: ["query", "--path", cwd, "--limit", "10", "--", "symbol"],
		fallback: "Use read, grep, and find for this exploration.",
	});
});

test("CodeGraph tool returns fallback instructions when CodeGraph fails", async (t) => {
	const cwd = workspace(t);
	const tool = createCodeGraphTool(async () => {
		throw new Error("CodeGraph exited with status 1");
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "explore", query: "call path" }, undefined, undefined, ctx);

	assert.deepEqual(result.content, [{
		type: "text",
		text: "CodeGraph failed to run. Use read, grep, and find for this exploration.",
	}]);
	assert.deepEqual(result.details, {
		status: "failed",
		operation: "explore",
		cwd,
		args: ["explore", "--path", cwd, "--max-files", "10", "--", "call path"],
		fallback: "Use read, grep, and find for this exploration.",
	});
});

test("CodeGraph tool configures a process buffer above the returned-output truncation threshold", async (t) => {
	const cwd = workspace(t);
	let maxBuffer = 0;
	const tool = createCodeGraphTool(async (_args, options) => {
		maxBuffer = options.maxBuffer;
		return { stdout: "x".repeat(100_001), stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	const result = await tool.execute("test", { operation: "explore", query: "large result" }, undefined, undefined, ctx);

	assert.ok(maxBuffer > 100_000);
	assert.match(result.content[0]?.text ?? "", /\[CodeGraph output truncated\]$/);
});

test("CodeGraph tool rejects incomplete or oversized query requests before running a process", async (t) => {
	const cwd = workspace(t);
	let calls = 0;
	const tool = createCodeGraphTool(async () => {
		calls += 1;
		return { stdout: "unexpected", stderr: "" };
	});
	const ctx = { cwd } as ExtensionContext;

	await assert.rejects(
		() => tool.execute("test", { operation: "query" }, undefined, undefined, ctx),
		/query is required/i,
	);
	await assert.rejects(
		() => tool.execute("test", { operation: "explore", query: "x", limit: 21 }, undefined, undefined, ctx),
		/between 1 and 20/i,
	);
	assert.equal(calls, 0);
});

test("CodeGraph tool registration exposes a single constrained custom tool", () => {
	const tools: Array<{ name: string; parameters: Record<string, unknown> }> = [];
	const pi = {
		registerTool(tool: { name: string; parameters: Record<string, unknown> }) {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;

	codeGraphTools(pi);

	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.name, "codegraph");
	assert.deepEqual(tools[0]?.parameters, {
		type: "object",
		additionalProperties: false,
		required: ["operation"],
		properties: {
			operation: { type: "string", enum: ["init", "query", "explore"] },
			query: { type: "string", minLength: 1, maxLength: 2_000 },
			limit: { type: "integer", minimum: 1, maximum: 20 },
		},
	});
});
