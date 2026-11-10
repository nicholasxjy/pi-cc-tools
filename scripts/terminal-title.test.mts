import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);
const spinner = (await import("../extensions/spinner.ts")).default;

const entry = (title: unknown) => ({ type: "custom", customType: "pi-claude-code-ui-terminal-title", data: { title } });

function configure(settings: Record<string, unknown>, scope: "project" | "user" = "user") {
	const path = scope === "project"
		? join(process.cwd(), ".pi", "settings.json")
		: join(process.env.PI_CODING_AGENT_DIR!, "settings.json");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(settings));
	const bustKey = Symbol.for("pi-claude-style-tools:spinner-settings-bust");
	(globalThis as any)[bustKey] = ((globalThis as any)[bustKey] ?? 0) + 1;
}

test.beforeEach((t) => {
	const dir = mkdtempSync(join(tmpdir(), "terminal-title-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	t.mock.method(process, "cwd", () => dir);
	configure({});
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});
});

function harness(t: test.TestContext, mode = "tui", hasUI = true) {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const titles: string[] = [];
	const saved: any[] = [];
	let branch: any[] = [];
	const ctx = {
		mode,
		hasUI,
		sessionManager: { getBranch: () => branch },
		ui: {
			setTitle: (title: string) => { titles.push(title); },
			setWorkingMessage() {},
		},
	};
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		appendEntry(customType: string, data: unknown) {
			const savedEntry = { type: "custom", customType, data };
			saved.push(savedEntry);
			branch.push(savedEntry);
		},
		getThinkingLevel: () => "off",
	};
	spinner(pi as any);
	async function fire(name: string, event: any = {}) {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	}
	async function start(toolName: string, args: any, toolCallId = "call", parentToolCallId?: string) {
		await fire("tool_execution_start", { toolName, args, toolCallId, parentToolCallId });
	}
	t.after(() => fire("session_shutdown"));
	return { ctx, pi, titles, saved, fire, start, setBranch: (entries: any[]) => { branch = entries; } };
}

test("the spinner writes tool activities and keeps the last step after completion", async (t) => {
	const h = harness(t);
	for (const [tool, args, expected] of [
		["read", { path: "/project/src/app.ts" }, "Reading app.ts"],
		["edit", { path: "/project/src/app.ts" }, "Editing app.ts"],
		["bash", { command: "npm test" }, "Running npm test"],
		["grep", { pattern: "TODO" }, "Searching for TODO"],
		["ask_user_question", {}, "Waiting for your answer"],
	] as const) {
		await h.start(tool, args);
		assert.equal(h.titles.at(-1), expected);
	}
	await h.fire("tool_execution_end", { toolCallId: "call" });
	await h.fire("agent_end");
	await h.fire("agent_settled");
	await tick();
	assert.equal(h.titles.at(-1), "Waiting for your answer");
	assert.equal(h.saved.length, 5, "only a changed step creates a session entry");
});

test("terminalTitle accepts booleans from project and agent settings", async (t) => {
	for (const scope of ["project", "user"] as const) {
		for (const value of [false, true, "false"]) {
			configure({}, "project");
			configure({}, "user");
			configure({ terminalTitle: value }, scope);
			const h = harness(t);
			await h.start("read", { path: "app.ts" });
			assert.deepEqual(h.titles, value === false ? [] : ["Reading app.ts"], `${scope}: ${value}`);
			assert.equal(h.saved.length, value === false ? 0 : 1);
		}
	}
});

test("disabled terminalTitle suppresses tool, resume, tree and lifecycle writes", async (t) => {
	configure({ terminalTitle: false });
	const h = harness(t);
	h.setBranch([entry("Saved step")]);
	for (const event of ["session_start", "session_tree", "session_info_changed", "agent_settled"]) {
		await h.fire(event);
		await tick();
	}
	await h.start("fabric_exec", { display: { name: "Milestone" } }, "outer");
	await h.start("read", { path: "app.ts" }, "child", "outer");
	assert.deepEqual(h.titles, []);
	assert.deepEqual(h.saved, []);
});

test("disabling terminalTitle suppresses already scheduled writes", async (t) => {
	const h = harness(t);
	await h.start("read", { path: "app.ts" });
	await h.fire("session_info_changed");
	configure({ terminalTitle: false });
	await tick();
	await h.start("read", { path: "next.ts" });
	await h.fire("agent_settled");
	await tick();
	assert.deepEqual(h.titles, ["Reading app.ts"]);
	assert.equal(h.saved.length, 1);
});

test("declared milestones win and nested calls cannot replace them", async (t) => {
	const h = harness(t);
	await h.start("fabric_exec", { display: { name: "检查并修复测试" }, displaySummary: "lower priority" }, "outer");
	await h.start("codemode", { code: "return 1" }, "child", "outer");
	await h.start("read", { path: "package.json" }, "grandchild", "child");
	await h.fire("tool_execution_end", { toolCallId: "grandchild" });
	await h.fire("tool_execution_end", { toolCallId: "child" });
	await h.fire("tool_execution_end", { toolCallId: "outer" });
	assert.deepEqual(h.titles, ["检查并修复测试"]);
	await h.start("bash", { command: "npm test", displaySummary: "验证修复" });
	await h.start("bash", { command: "npm test", displaySummary: "验证修复" });
	assert.deepEqual(h.titles, ["检查并修复测试", "验证修复"]);
	assert.equal(h.saved.length, 2, "duplicate titles are neither written nor saved again");
	await h.start("read", { path: "README.md" }, "next", "outer");
	assert.equal(h.titles.at(-1), "Reading README.md", "a completed parent no longer protects its title");
});

test("unnamed codemode calls expose the activity of their nested tools", async (t) => {
	const h = harness(t);
	await h.start("codemode", { code: "await tools.read({path: 'app.ts'})" }, "outer");
	await h.start("read", { path: "app.ts" }, "child", "outer");
	assert.deepEqual(h.titles, ["Running Codemode", "Reading app.ts"]);
});

test("resume and tree navigation restore only the active branch", async (t) => {
	const h = harness(t);
	h.setBranch([entry("Earlier step"), { ...entry("unrelated"), customType: "other" }, entry("Latest step"), entry(42)]);
	await h.fire("session_start", { reason: "resume" });
	assert.deepEqual(h.titles, [], "restoration waits for Pi to apply its default title");
	await tick();
	assert.deepEqual(h.titles, ["Latest step"]);
	h.setBranch([entry("Other branch")]);
	await h.fire("session_tree");
	await tick();
	assert.equal(h.titles.at(-1), "Other branch");
	h.setBranch([]);
	await h.fire("session_tree");
	await tick();
	const count = h.titles.length;
	await h.fire("agent_settled");
	await tick();
	assert.equal(h.titles.length, count, "an empty branch must not reassert another branch's title");
	assert.equal(h.saved.length, 0, "restoration does not append entries");
});

test("saved steps survive reload and Pi retitling after rename or settlement", async (t) => {
	const first = harness(t);
	await first.start("bash", { command: "npm test", displaySummary: "Verify tests" });
	const resumed = harness(t);
	resumed.setBranch([...first.saved]);
	await resumed.fire("session_start", { reason: "reload" });
	await tick();
	assert.deepEqual(resumed.titles, ["Verify tests"]);
	for (const event of ["session_info_changed", "agent_settled"]) {
		await resumed.fire(event);
		resumed.ctx.ui.setTitle("Pi's default title");
		await tick();
		assert.equal(resumed.titles.at(-1), "Verify tests");
	}
	await resumed.fire("session_info_changed");
	await resumed.start("read", { path: "next.ts" });
	await tick();
	assert.equal(resumed.titles.at(-1), "Reading next.ts", "deferred writes use the latest step");
});

test("shutdown cancels pending title writes", async (t) => {
	const h = harness(t);
	h.setBranch([entry("Saved step")]);
	await h.fire("session_start");
	await h.fire("session_shutdown");
	await tick();
	assert.deepEqual(h.titles, []);
});

test("RPC, print, JSON and contexts without UI do not write or record titles", async (t) => {
	for (const [mode, hasUI] of [["rpc", true], ["print", false], ["json", false], ["tui", false]] as const) {
		const h = harness(t, mode, hasUI);
		h.setBranch([entry("Saved step")]);
		await h.fire("session_start");
		await h.start("bash", { command: "npm test", displaySummary: "Verify tests" });
		await h.fire("agent_settled");
		await tick();
		assert.deepEqual(h.titles, [], mode);
		assert.deepEqual(h.saved, [], mode);
	}
});

test("titles are plain, bounded Unicode text safe for a terminal OSC string", async (t) => {
	const h = harness(t);
	await h.start("bash", { displaySummary: "\x1b[31m验证\x1b[0m\n\t\x1b]8;;https://example.test\x1b\\测试\x1b]8;;\x1b\\\x07\x9c" });
	assert.equal(h.titles.at(-1), "验证 测试");
	await h.start("fabric_exec", { display: { name: "🚀".repeat(121) } });
	assert.equal(h.titles.at(-1), `${"🚀".repeat(119)}…`);
	assert.equal(Array.from(h.titles.at(-1)!).length, 120);
	assert.equal(h.saved.at(-1).data.title, h.titles.at(-1));
});

test("title output or persistence failures do not interrupt execution", async (t) => {
	const h = harness(t);
	h.pi.appendEntry = () => { throw new Error("read-only session"); };
	await h.start("bash", { displaySummary: "Still visible" });
	assert.deepEqual(h.titles, ["Still visible"]);
	h.ctx.ui.setTitle = () => { throw new Error("closed terminal"); };
	await h.start("read", { path: "app.ts" });
	await h.fire("session_info_changed");
	await tick();
	h.ctx.sessionManager.getBranch = () => { throw new Error("unavailable session"); };
	await h.fire("session_start");
	await tick();
});
