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
	const notifications: string[] = [];
	const saved: any[] = [];
	let branch: any[] = [];
	const ctx: any = {
		mode,
		hasUI,
		sessionManager: { getBranch: () => branch },
		ui: {
			setTitle: (title: string) => { titles.push(title); },
			notify: (message: string) => { notifications.push(message); },
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
	async function userPrompt(text = "", source: "interactive" | "rpc" = "interactive") {
		await fire("input", { text, source });
		await fire("before_agent_start", { messageType: "user", prompt: text });
	}
	function mockModel(
		responder: (model: any, context: any, options: any) => unknown,
		model: any = { id: "summary-model", provider: "test" },
	) {
		const calls: Array<{ model: any; context: any; options: any }> = [];
		ctx.model = model;
		ctx.modelRegistry = {
			streamSimple(m: any, context: any, options: any) {
				calls.push({ model: m, context, options });
				return { result: () => Promise.resolve().then(() => responder(m, context, options)) };
			},
		};
		return calls;
	}
	t.after(() => fire("session_shutdown"));
	return { ctx, pi, titles, notifications, saved, fire, start, userPrompt, mockModel, setBranch: (entries: any[]) => { branch = entries; } };
}

test("the spinner writes tool activities and keeps the last step without a final response", async (t) => {
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

test("settled tasks show and notify with a fallback title without changing the main prompt", async (t) => {
	const h = harness(t);
	const prompt = "优化**终端完成标题**\n\n相关要求。";
	const promptGuidelines = ["Existing guideline"];
	await h.fire("input", { text: prompt, source: "interactive" });
	await h.fire("before_agent_start", { messageType: "user", prompt, systemPromptOptions: { promptGuidelines } });
	assert.deepEqual(promptGuidelines, ["Existing guideline"]);
	await h.start("bash", { command: "npm test", displaySummary: "验证修复" });
	await h.fire("agent_end", { messages: [
		{ role: "user", content: "Previous request" },
		{ role: "user", content: "优化**终端完成标题**\n\n相关要求。" },
		{ role: "assistant", content: [{ type: "text", text: "**Result**\n\n相关测试全部通过。" }], stopReason: "stop" },
	] });
	assert.deepEqual(h.notifications, []);
	await h.fire("agent_settled");
	await h.fire("agent_settled");
	h.ctx.ui.setTitle("Pi's default title");
	await tick();
	const title = "✓ 优化终端完成标题";
	assert.equal(h.titles.at(-1), title);
	assert.deepEqual(h.notifications, [title]);
	assert.equal(h.saved.at(-1).data.title, title);
	const resumed = harness(t);
	resumed.setBranch([...h.saved]);
	await resumed.fire("session_start", { reason: "reload" });
	await tick();
	assert.equal(resumed.titles.at(-1), title);
	assert.deepEqual(resumed.notifications, []);
	await resumed.start("read", { path: "next.ts" });
	assert.equal(resumed.titles.at(-1), "Reading next.ts");
});

test("native terminal notifications carry the sanitized task summary", async (t) => {
	const tty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const termProgram = process.env.TERM_PROGRAM;
	const kittyWindow = process.env.KITTY_WINDOW_ID;
	t.after(() => {
		if (tty) Object.defineProperty(process.stdout, "isTTY", tty);
		else Reflect.deleteProperty(process.stdout, "isTTY");
		if (termProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = termProgram;
		if (kittyWindow === undefined) delete process.env.KITTY_WINDOW_ID;
		else process.env.KITTY_WINDOW_ID = kittyWindow;
	});
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	const output: string[] = [];
	const originalWrite = process.stdout.write.bind(process.stdout);
	t.mock.method(process.stdout, "write", (chunk: string | Uint8Array, ...args: any[]) => {
		if (typeof chunk !== "string" || !chunk.startsWith("\x1b]")) return originalWrite(chunk, ...args);
		output.push(chunk);
		return true;
	});
	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.KITTY_WINDOW_ID;
	const h = harness(t);
	const event = { messages: [{
		role: "assistant", stopReason: "stop",
		content: [{ type: "text", text: "**\x1b[31m修复标题; 验证通知\x1b[0m**\n\n更多说明。" }],
	}] };
	await h.userPrompt("");
	await h.fire("agent_end", event);
	await h.fire("agent_settled");
	await tick();
	process.env.KITTY_WINDOW_ID = "1";
	await h.userPrompt("");
	await h.fire("agent_end", event);
	await h.fire("agent_settled");
	await tick();
	assert.deepEqual(output, ["\x1b]777;notify;Pi;✓ 修复标题, 验证通知\x07", "\x1b]99;;✓ 修复标题; 验证通知\x1b\\"]);
	assert.deepEqual(h.notifications, []);
});

test("the latest user request is kept across retries", async (t) => {
	const h = harness(t);
	await h.userPrompt("修复 **终端通知**\n\n请运行测试。");
	await h.fire("agent_end", { messages: [
		{ role: "user", content: "Previous request" },
		{ role: "user", content: [{ type: "image" }, { type: "text", text: "修复 **终端通知**\n\n请运行测试。" }] },
		{ role: "assistant", content: [], stopReason: "error" },
	] });
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{
		role: "assistant", stopReason: "stop",
		content: [{ type: "text", text: "已通过重试。" }],
	}] });
	await h.fire("agent_settled");
	await tick();
	assert.equal(h.titles.at(-1), "✓ 修复 终端通知");
	assert.deepEqual(h.notifications, ["✓ 修复 终端通知"]);
});

test("responses without tools produce safe, bounded completion titles", async (t) => {
	for (const [text, expected] of [
		["\n  Answer ready.\r\n\nMore details.", "✓ Answer ready."],
		["", "✓ Completed"],
		["\x1b[31m已完成\x1b[0m\x07\x9c", "✓ 已完成"],
		["🚀".repeat(121), `✓ ${"🚀".repeat(61)}…`],
	]) {
		const h = harness(t);
		await h.userPrompt("");
		await h.fire("agent_end", { messages: [{
			role: "assistant",
			content: [{ type: "thinking", thinking: "Private reasoning" }, { type: "text", text }],
			stopReason: "stop",
		}] });
		await h.fire("agent_settled", { aborted: false });
		await tick();
		assert.equal(h.titles.at(-1), expected);
		assert.equal(h.saved.at(-1).data.title, expected);
	}
});

test("completion titles show Markdown as plain text and survive reload", async (t) => {
	for (const [text, expected] of [
		["## **已修复** `terminal-title.ts`，见[验证结果](https://example.test/checks).\n\n更多说明。", "✓ 已修复 terminal-title.ts，见验证结果."],
		["> - **完成**：*测试*和~~旧问题~~已处理。", "✓ 完成：测试和旧问题已处理。"],
		["---\n\n```ts\nconst name = 'a_b*c';\n```", "✓ const name = 'a_b*c';"],
		["已修复[标题][result]。\n\n[result]: https://example.test/checks", "✓ 已修复标题。"],
		["**更新 `config_a_b`**，保留 `**literal**` 和 \\*星号\\*。", "✓ 更新 config_a_b，保留 **literal** 和 *星号*。"],
		["![验证通过](https://example.test/result.png)", "✓ 验证通过"],
		["1. **已完成**\n2. 下一步", "✓ 已完成"],
		["| **检查** | `结果` |\n| --- | --- |\n| 测试 | 通过 |", "✓ 检查 结果"],
		["**已完成**  \n下一行", "✓ 已完成"],
		["`a < b && c > d`", "✓ a < b && c > d"],
		["---\n\n<!-- done -->", "✓ Completed"],
		["已完成\n\n<!-- pi-terminal-title: 旧标题 -->", "✓ 已完成"],
		[`**${"🚀".repeat(121)}**`, `✓ ${"🚀".repeat(61)}…`],
	]) {
		const h = harness(t);
		await h.userPrompt("");
		await h.fire("agent_end", { messages: [{
			role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
		}] });
		await h.fire("agent_settled");
		await tick();
		assert.equal(h.titles.at(-1), expected, text);
		assert.equal(h.saved.at(-1).data.title, expected);
		const resumed = harness(t);
		resumed.setBranch([...h.saved]);
		await resumed.fire("session_start", { reason: "reload" });
		await tick();
		assert.equal(resumed.titles.at(-1), expected);
	}
});

test("completion waits for settlement and uses the latest run's response", async (t) => {
	const h = harness(t);
	await h.userPrompt("");
	await h.start("bash", { displaySummary: "Running checks" });
	for (const text of ["Intermediate result", "Final result"]) {
		await h.fire("agent_start");
		await h.fire("agent_end", { messages: [{
			role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
		}] });
		await tick();
		assert.deepEqual(h.titles, ["Running checks"], "low-level runs must not announce completion");
		assert.equal(h.saved.length, 1);
	}
	await h.fire("agent_settled", { aborted: false });
	await tick();
	assert.equal(h.titles.at(-1), "✓ Final result");
});

test("failed, aborted and unfinished runs do not reuse an earlier completion", async (t) => {
	for (const stopReason of ["error", "aborted", "length", "toolUse", "stop", undefined]) {
		const h = harness(t);
		await h.userPrompt("");
		await h.start("bash", { displaySummary: "Running checks" });
		await h.fire("agent_end", { messages: [{
			role: "assistant", content: [{ type: "text", text: "Earlier result" }], stopReason: "stop",
		}] });
		await h.fire("agent_start");
		await h.fire("agent_end", { messages: stopReason ? [{
			role: "assistant", content: [{ type: "text", text: "Latest result" }], stopReason,
		}] : [] });
		await h.fire("agent_settled", { aborted: stopReason === "stop" });
		await tick();
		assert.equal(h.titles.at(-1), "Running checks", String(stopReason));
		assert.equal(h.saved.length, 1);
		assert.deepEqual(h.notifications, []);
	}
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
	await h.start("codemode", { code: "return 1", display: { name: "Check files" } }, "outer");
	await h.start("read", { path: "app.ts" }, "child", "outer");
	await h.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
	await h.fire("agent_settled", { aborted: false });
	await tick();
	assert.deepEqual(h.titles, []);
	assert.deepEqual(h.saved, []);
	assert.deepEqual(h.notifications, []);
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

test("declared tool titles take precedence and persist through nested calls", async (t) => {
	const h = harness(t);
	await h.start("codemode", { code: "return 1", display: { name: "检查并修复测试" }, displaySummary: "lower priority" }, "outer");
	await h.start("bash", { command: "npm test" }, "child", "outer");
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
		const calls = h.mockModel(() => ({ stopReason: "stop", content: [{ type: "text", text: "Summary" }] }));
		h.setBranch([entry("Saved step")]);
		await h.fire("session_start");
		await h.userPrompt("Run checks", mode === "rpc" ? "rpc" : "interactive");
		await h.start("bash", { command: "npm test", displaySummary: "Verify tests" });
		await h.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] });
		await h.fire("agent_settled", { aborted: false });
		await tick();
		assert.deepEqual(calls, [], mode);
		assert.deepEqual(h.titles, [], mode);
		assert.deepEqual(h.saved, [], mode);
		assert.deepEqual(h.notifications, [], mode);
	}
});

test("titles are plain, bounded Unicode text safe for a terminal OSC string", async (t) => {
	const h = harness(t);
	await h.start("bash", { displaySummary: "\x1b[31m验证\x1b[0m\n\t\x1b]8;;https://example.test\x1b\\测试\x1b]8;;\x1b\\\x07\x9c" });
	assert.equal(h.titles.at(-1), "验证 测试");
	await h.start("bash", { command: "npm test", displaySummary: "🚀".repeat(121) });
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

test("settled genuine tasks summarize asynchronously once after retries and continuations", async (t) => {
	for (const source of ["interactive", "rpc"] as const) {
		const h = harness(t);
		let resolveSummary!: (value: any) => void;
		const calls = h.mockModel(() => new Promise((resolve) => { resolveSummary = resolve; }));
		await h.userPrompt("Check why **tests** failed\n\nand fix them", source);
		await h.start("bash", { displaySummary: "Running tests" });
		await h.fire("agent_start");
		await h.fire("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "error" }] });
		await h.fire("agent_start");
		await h.fire("agent_end", { messages: [
			{ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Checking logs" }] },
			{ role: "assistant", stopReason: "stop", content: [
				{ type: "thinking", thinking: "Internal" },
				{ type: "text", text: "Fixed the auth test." },
			] },
		] });
		assert.equal(calls.length, 0, "summary starts only on settlement");
		await h.fire("agent_settled", { aborted: false });
		await h.fire("agent_settled", { aborted: false });
		assert.equal(calls.length, 1, "settled retries emit one summary request");
		assert.deepEqual(h.notifications, []);
		assert.equal(h.titles.at(-1), "Running tests");

		const [{ model, context, options }] = calls;
		assert.equal(model, h.ctx.model);
		assert.equal(typeof context.systemPrompt, "string");
		assert.ok(context.systemPrompt.length > 0);
		assert.equal(context.messages.length, 1);
		assert.equal(context.messages[0].role, "user");
		assert.equal(typeof context.messages[0].timestamp, "number");
		assert.deepEqual(JSON.parse(context.messages[0].content), {
			request: "Check why **tests** failed\n\nand fix them",
			reply: "Fixed the auth test.",
		});
		assert.equal(typeof options.maxTokens, "number");
		assert.ok(options.maxTokens > 0);
		assert.equal(options.cacheRetention, "none");
		assert.ok(options.signal instanceof AbortSignal);

		resolveSummary({
			stopReason: "stop",
			content: [{ type: "thinking", thinking: "Draft" }, { type: "text", text: "**Fixed** auth tests" }],
		});
		await tick();
		assert.equal(h.titles.at(-1), "✓ Fixed auth tests", source);
		assert.deepEqual(h.notifications, ["✓ Fixed auth tests"], source);
		assert.equal(h.saved.at(-1).data.title, "✓ Fixed auth tests", source);
	}
});

test("extension triggers and sendUserMessage do not summarize or set completion titles", async (t) => {
	const h = harness(t);
	const calls = h.mockModel(() => ({ stopReason: "stop", content: [{ type: "text", text: "Should not run" }] }));
	await h.start("read", { path: "app.ts" });

	// 1. Idle custom plugin trigger without an input event.
	await h.fire("before_agent_start", { messageType: "custom", prompt: "Scheduled check" });
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
	await h.fire("agent_settled", { aborted: false });
	await tick();

	// 2. Plugin sendUserMessage fires input with source: "extension" before messageType: "user".
	await h.fire("input", { text: "Automated prompt", source: "extension" });
	await h.fire("before_agent_start", { messageType: "user", prompt: "Automated prompt" });
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
	await h.fire("agent_settled", { aborted: false });
	await tick();

	// 3. Handled interactive input that never starts a user turn does not taint a later custom trigger.
	await h.fire("input", { text: "Handled locally", source: "interactive" });
	await h.fire("before_agent_start", { messageType: "custom", prompt: "Custom follow-on" });
	await h.fire("agent_start");
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
	await h.fire("agent_settled", { aborted: false });
	await tick();

	assert.deepEqual(calls, []);
	assert.equal(h.titles.at(-1), "Reading app.ts");
	assert.equal(h.titles.every((title) => title === "Reading app.ts"), true);
	assert.equal(h.saved.length, 1);
	assert.deepEqual(h.notifications, []);
});

test("human queued steer and followUp update active prompt while extension queues do not", async (t) => {
	for (const behavior of ["steer", "followUp"] as const) {
		const h = harness(t);
		const calls = h.mockModel(() => ({ stopReason: "stop", content: [{ type: "text", text: "Updated summary" }] }));
		await h.userPrompt("Initial request");
		await h.fire("agent_start");
		await h.fire("input", { text: "Extension noise", source: "extension", streamingBehavior: behavior });
		await h.fire("input", { text: `Human ${behavior}`, source: behavior === "steer" ? "interactive" : "rpc", streamingBehavior: behavior });
		await h.fire("input", { text: "More extension noise", source: "extension", streamingBehavior: behavior });
		await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
		await h.fire("agent_settled", { aborted: false });
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(JSON.parse(calls[0].context.messages[0].content).request, `Human ${behavior}`);
		assert.equal(h.titles.at(-1), "✓ Updated summary");
	}

	// Fallback path also preserves the original user input over extension queued prompts.
	const h = harness(t);
	await h.userPrompt("Keep user prompt");
	await h.fire("agent_start");
	await h.fire("input", { text: "Extension steer", source: "extension", streamingBehavior: "steer" });
	await h.fire("input", { text: "Extension followUp", source: "extension", streamingBehavior: "followUp" });
	await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Reply" }] }] });
	await h.fire("agent_settled", { aborted: false });
	await tick();
	assert.equal(h.titles.at(-1), "✓ Keep user prompt");
});

test("missing model or API, summary errors, and empty output fall back in order", async (t) => {
	// Missing model / missing streamSimple API
	for (const setup of [
		(h: ReturnType<typeof harness>) => { h.ctx.modelRegistry = { streamSimple() { throw new Error("should not call"); } }; },
		(h: ReturnType<typeof harness>) => { h.ctx.model = { id: "m" }; },
	]) {
		const h = harness(t);
		setup(h);
		await h.userPrompt("**User fallback**\nMore lines");
		await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Reply" }] }] });
		await h.fire("agent_settled", { aborted: false });
		await tick();
		assert.equal(h.titles.at(-1), "✓ User fallback");
	}

	// Summary error, rejected promise, non-stop stopReason, and empty output all fall back: input -> reply -> Completed
	const failureModes: Array<(h: ReturnType<typeof harness>) => void> = [
		(h) => {
			h.ctx.model = { id: "m" };
			h.ctx.modelRegistry = { streamSimple() { throw new Error("sync failure"); } };
		},
		(h) => { h.mockModel(() => Promise.reject(new Error("async failure"))); },
		(h) => { h.mockModel(() => ({ stopReason: "error", content: [{ type: "text", text: "Ignored error text" }] })); },
		(h) => { h.mockModel(() => ({ stopReason: "stop", content: [{ type: "text", text: "   \n<!-- empty -->" }] })); },
	];
	for (const setup of failureModes) {
		for (const [input, reply, expected] of [
			["**Input first**\nSecond", "**Reply second**", "✓ Input first"],
			["   \n<!-- blank -->", "**Reply second**", "✓ Reply second"],
			["", "", "✓ Completed"],
		]) {
			const h = harness(t);
			setup(h);
			await h.userPrompt(input);
			await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: reply }] }] });
			await h.fire("agent_settled", { aborted: false });
			await tick();
			assert.equal(h.titles.at(-1), expected);
			assert.deepEqual(h.notifications, [expected]);
		}
	}
});

test("new run and shutdown invalidate in-flight summaries", async (t) => {
	// New run cancels and ignores stale summary from previous run.
	{
		const h = harness(t);
		let resolveFirst!: (value: any) => void;
		let callIndex = 0;
		const calls = h.mockModel(() => {
			callIndex++;
			if (callIndex === 1) return new Promise((resolve) => { resolveFirst = resolve; });
			return { stopReason: "stop", content: [{ type: "text", text: "Second summary" }] };
		});
		await h.userPrompt("First task");
		await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "First reply" }] }] });
		await h.fire("agent_settled", { aborted: false });
		assert.equal(calls.length, 1);

		await h.userPrompt("Second task");
		await h.fire("agent_start");
		await h.start("read", { path: "next.ts" });
		assert.equal(calls[0].options.signal.aborted, true);

		resolveFirst({ stopReason: "stop", content: [{ type: "text", text: "Stale summary" }] });
		await tick();
		assert.equal(h.titles.at(-1), "Reading next.ts");
		assert.deepEqual(h.notifications, []);
		assert.equal(h.saved.some((s) => s.data.title === "✓ Stale summary"), false);

		await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Second reply" }] }] });
		await h.fire("agent_settled", { aborted: false });
		await tick();
		assert.equal(h.titles.at(-1), "✓ Second summary");
		assert.deepEqual(h.notifications, ["✓ Second summary"]);
	}

	// Shutdown cancels and ignores in-flight summary.
	{
		const h = harness(t);
		let resolvePending!: (value: any) => void;
		const calls = h.mockModel(() => new Promise((resolve) => { resolvePending = resolve; }));
		await h.userPrompt("Task before shutdown");
		await h.fire("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }] });
		await h.fire("agent_settled", { aborted: false });
		assert.equal(calls.length, 1);

		await h.fire("session_shutdown");
		assert.equal(calls[0].options.signal.aborted, true);

		resolvePending({ stopReason: "stop", content: [{ type: "text", text: "Late summary" }] });
		await tick();
		assert.deepEqual(h.titles, []);
		assert.deepEqual(h.saved, []);
		assert.deepEqual(h.notifications, []);
	}
});
