import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

const root = mkdtempSync(join(tmpdir(), "resource-lifecycle-"));
const previousCwd = process.cwd();
const previousEnv = { ...process.env };
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_CC_UI_CACHE_DIR = root;
process.env.PI_CC_UI_INTENT_HELPER = join(root, "unused-helper");
writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false, bashIntent: "local" }));
const { AssistantMessageComponent, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Loader } = await import("@earendil-works/pi-tui");
const { initTheme, theme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const intent = await import("../extensions/bash-intent.ts");
const intentKey = Symbol.for("pi-claude-style-tools:bash-intent-local");
const tools = new Map<string, any>();
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {}, on() {},
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
} as any);
const spinner = await import("../extensions/spinner.ts");
test.after(() => {
	intent.resetLocalIntentsForTests();
	process.chdir(previousCwd);
	for (const key of ["PI_CODING_AGENT_DIR", "PI_CC_UI_CACHE_DIR", "PI_CC_UI_INTENT_HELPER"]) {
		if (previousEnv[key] === undefined) delete process.env[key];
		else process.env[key] = previousEnv[key];
	}
	rmSync(root, { recursive: true, force: true });
});

test("module reloads retain only one terminal input listener and exit hook", async (t) => {
	const dataListeners = new Set(process.stdin.listeners("data"));
	const exitListeners = new Set(process.listeners("exit"));
	t.after(() => {
		for (const fn of process.stdin.listeners("data")) if (!dataListeners.has(fn)) process.stdin.removeListener("data", fn as any);
		for (const fn of process.listeners("exit")) if (!exitListeners.has(fn)) process.removeListener("exit", fn as any);
		delete (globalThis as any)[Symbol.for("pi-claude-style-tools:terminal-theme-focus")];
		if (dataListeners.size === 0) process.stdin.pause();
	});
	for (let i = 0; i < 6; i++) {
		const terminal = await import(`../extensions/terminal-theme.ts?resource-reload=${i}`);
		terminal.startFocusResync({}, () => false);
	}
	assert.equal(process.stdin.listenerCount("data") - dataListeners.size, 1);
	assert.equal(process.listenerCount("exit") - exitListeners.size, 1);
});

test("reloading local intent support does not accumulate exit hooks", async () => {
	const before = process.listenerCount("exit");
	for (let i = 0; i < 6; i++) await import(`../extensions/bash-intent.ts?resource-reload=${i}`);
	assert.equal(process.listenerCount("exit"), before);
});

test("a bash row keeps one label subscription across redraws, and disabling releases it", () => {
	intent.configureLocalIntents(true);
	const row = new ToolExecutionComponent("bash", "watched", { command: "echo pending-label" }, {}, tools.get("bash"), { requestRender() {} } as any, root) as any;
	row.markExecutionStarted();
	for (let i = 0; i < 100; i++) row.invalidate();
	const state = (globalThis as any)[intentKey];
	assert.equal(state.watchers.get("echo pending-label")?.size, 1);
	intent.configureLocalIntents(false);
	assert.equal(state.watchers.size, 0);
});

test("a ready helper that stops replying cannot accumulate unbounded requests", () => {
	intent.configureLocalIntents(true);
	const state = (globalThis as any)[intentKey];
	let writes = 0;
	state.status = "ready";
	state.child = { stdin: { write() { writes++; }, end() {} }, kill() {} };
	try {
		for (let i = 0; i < 1000; i++) intent.requestLocalIntent(`echo stalled-${i}`);
		assert.equal(state.inFlight.size, 20);
		assert.equal(writes, 20);
	} finally {
		intent.configureLocalIntents(false);
	}
});

for (const [mode, hasUI] of [["json", false], ["rpc", true]] as const) {
	test(`${mode} turns and streaming updates do not schedule display timers`, async (t) => {
		const handlers = new Map<string, any[]>();
		spinner.default({ on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, getThinkingLevel: () => "off" } as any);
		const ctx = { mode, hasUI, ui: {} };
		const fire = async (event: string, payload: any = {}) => {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
		};
		const timers = t.mock.method(globalThis, "setTimeout");
		try {
			await fire("turn_start");
			await fire("message_update", { assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(4000) } });
			await fire("message_update", { assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
			await fire("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "reasoning" } });
			await fire("turn_end");
			assert.equal(timers.mock.callCount(), 0);
		} finally {
			await fire("session_shutdown");
		}
	});
}

test("a stopped Loader and reload leave no global strong reference to the UI", async () => {
	const ui = { requestRender() {} };
	const loader = new Loader(ui as any, (text: string) => theme.fg("accent", text), (text: string) => text, "working");
	loader.stop();
	(globalThis as any)[Symbol.for("pi-claude-style-tools:active-ui")] = ui;
	await import("../extensions/spinner.ts?clear-previous-ui");
	assert.notEqual((globalThis as any)[Symbol.for("pi-claude-style-tools:active-ui")], ui);
});


test("thinking shares Loader redraws without adding timers, and stopping the Loader stops both animations", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let now = 1_700_000;
	t.mock.method(Date, "now", () => now);
	const timeouts = t.mock.method(globalThis, "setTimeout");
	const component = new AssistantMessageComponent({ role: "assistant", stopReason: "pending", content: [{ type: "thinking", thinking: "Shared animation clock." }] } as any);
	const frames: string[] = [];
	const ui = { requestRender() { frames.push(component.render(80).join("\n")); } };
	const loader = new Loader(ui as any, (text: string) => text, (text: string) => text, "working");
	t.after(() => loader.stop());
	assert.equal(timeouts.mock.callCount(), 1);
	const initial = frames[0];
	assert.match(initial, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	assert.match(loader.render(80).join("\n"), /· working/);
	for (let i = 1; i <= 10; i++) {
		now += 170;
		t.mock.timers.tick(170);
		assert.equal(frames.length, i + 1);
		assert.equal(timeouts.mock.callCount(), i + 1, "only the existing Loader timer is rescheduled");
		assert.doesNotMatch(loader.render(80).join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "the working line retains its own glyph family");
	}
	assert.equal(new Set(frames).size, 10);
	loader.stop();
	const redraws = frames.length;
	now += 1000;
	t.mock.timers.tick(1000);
	assert.equal(frames.length, redraws, "no independent thinking timer remains after Loader.stop()");
});
