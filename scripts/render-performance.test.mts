import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import test, { mock } from "node:test";
import { queryObjects } from "node:v8";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

const agentDir = mkdtempSync(join(tmpdir(), "render-performance-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCwd = process.cwd();
process.env.PI_CODING_AGENT_DIR = agentDir;
process.chdir(agentDir);
let now = Date.now();
mock.method(Date, "now", () => now);
function settings(extra: Record<string, unknown> = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ terminalTheme: false, groupToolCalls: true, ...extra }));
	now += 5001;
}
settings();
test.beforeEach(() => settings());

const { AssistantMessageComponent, ToolExecutionComponent, UserMessageComponent } = await import("@earendil-works/pi-coding-agent");
const { Container } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const tools = new Map<string, any>();
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {}, on() {},
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
} as any);

test.after(() => {
	mock.restoreAll();
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
const message = (text?: string, streaming = false) => ({
	role: "assistant", stopReason: streaming ? "pending" : "toolUse",
	content: [{ type: "thinking", thinking: "Inspect the renderer." }, ...(text ? [{ type: "text", text }] : [])],
	_piClaudeStyleThinkingDurationMs: 1000,
});
function tool(id: string, name = "read") {
	const args = name === "bash" ? { command: "echo streaming" } : { path: `${id}.ts` };
	return new ToolExecutionComponent(name, id, args, { showImages: false }, tools.get(name), { requestRender() {} } as any, agentDir) as any;
}

test("warm history renders do not inspect settled messages again", (t) => {
	const chat = new Container();
	let inspections = 0;
	for (let i = 0; i < 500; i++) {
		const row = new AssistantMessageComponent(message(`Answer ${i}.`) as any, true) as any;
		chat.addChild(row);
	}
	const expected = chat.render(100);
	for (const row of chat.children as any[]) {
		const last = row.lastMessage;
		Object.defineProperty(row, "lastMessage", { configurable: true, get() { inspections++; return last; } });
	}
	const start = performance.now();
	for (let i = 0; i < 50; i++) chat.render(100);
	t.diagnostic(`500-message warm render: ${((performance.now() - start) / 50).toFixed(3)} ms/frame; ${inspections} history inspections`);
	assert.deepEqual(chat.render(100), expected);
	assert.equal(inspections, 0, "unchanged history should not be scanned on input, scroll, or animation frames");
});

test("thinking still merges when a stream ends or a separator is removed", () => {
	const chat = new Container();
	chat.addChild(new AssistantMessageComponent(message() as any, true));
	const streaming = new AssistantMessageComponent();
	streaming.updateContent(message(undefined, true) as any, true);
	chat.addChild(streaming);
	assert.equal((plain(chat.render(100)).match(/Thought for/g) ?? []).length, 1);
	streaming.updateContent(message() as any, false);
	assert.match(plain(chat.render(100)), /Thought for 2s/);

	const separator = new UserMessageComponent("Keep these thoughts apart.");
	chat.addChild(separator);
	chat.addChild(new AssistantMessageComponent(message() as any, true));
	chat.render(100);
	chat.removeChild(separator);
	assert.match(plain(chat.render(100)), /Thought for 3s/);
});

test("unchanged partial output is not rescanned when a tool invalidates", (t) => {
	const row = tool("stream");
	const text = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
	const result = { content: [{ type: "text", text }] };
	row.updateResult(result, true);
	row.render(100);
	const start = performance.now();
	for (let i = 0; i < 10; i++) row.invalidate();
	t.diagnostic(`20,000-line partial invalidation: ${((performance.now() - start) / 10).toFixed(3)} ms/update`);
	const originalIndexOf = String.prototype.indexOf;
	let scans = 0;
	const spy = t.mock.method(String.prototype, "indexOf", function (this: string, search: string, from?: number) {
		if (search === "\n" && this.length === text.length) scans++;
		return originalIndexOf.call(this, search, from);
	});
	for (let i = 0; i < 10; i++) row.invalidate();
	t.diagnostic(`10 unchanged output updates: ${scans} line scans`);
	spy.mock.restore();
	assert.equal(scans, 0, "blinking and redraws must reuse the line count for unchanged output");
	assert.equal(row.rendererState._liveLineCount, 20_000);
	result.content[0].text += "\nnew line";
	row.updateResult(result, true);
	assert.equal(row.rendererState._liveLineCount, 20_001, "in-place result updates must refresh the count");
	row.updateResult(result, false);
	assert.equal(row.rendererState._liveLineCount, undefined);
	assert.equal(row.rendererState._liveOutputCache, undefined, "completion releases the live preview cache");
});

for (const name of ["read", "bash"]) {
	test(`${name} live previews keep their tail, expansion cap, and exact line count`, () => {
		settings({ liveToolPreview: true, liveToolPreviewLines: 2, expandedPreviewMaxLines: 3 });
		const row = tool(`preview-${name}`, name);
		const text = Array.from({ length: 20 }, (_, i) => `output-${i + 1}`).join("\r\n\r\n");
		row.updateResult({ content: [{ type: "text", text }] }, true);
		let output = plain(row.render(100));
		assert.match(output, /output-19/);
		assert.match(output, /output-20/);
		assert.doesNotMatch(output, /output-1\b/);
		assert.equal(row.rendererState._liveLineCount, 20);
		assert.equal(row.rendererState._liveOutputCache.collected.lines.length, 2);

		row.setExpanded(true);
		output = plain(row.render(100));
		assert.match(output, /output-1\b/);
		assert.match(output, /output-3\b/);
		assert.doesNotMatch(output, /output-4\b/);
		assert.match(output, /17 more lines/);
		assert.match(output, /display capped at 3 lines/);
		assert.equal(row.rendererState._liveLineCount, 20);
		assert.equal(row.rendererState._liveOutputCache.collected.lines.length, 3);

		settings({ liveToolPreview: false });
		row.invalidate();
		assert.doesNotMatch(plain(row.render(100)), /output-/);
		assert.equal(row.rendererState._liveOutputCache.collected.lines.length, 0);
	});
}

test("detached transcripts and tool groups can be garbage collected", async () => {
	mock.reset(); // Mock call stacks retain their callers, including the UI components.
	const refs = (() => {
		const chat = new Container();
		chat.addChild(new AssistantMessageComponent(message("A detached answer.") as any, true));
		for (let i = 0; i < 2; i++) {
			const row = tool(`detached-${i}`);
			row.updateResult({ content: [{ type: "text", text: "done" }] }, false);
			chat.addChild(row);
		}
		assert.equal(chat.children.length, 2);
		return [new WeakRef(chat), new WeakRef(chat.children[1])];
	})();
	await setImmediate(); // WeakRef targets stay alive until the end of their creation job.
	queryObjects(Container, { format: "count" }); // Performs a full GC without --expose-gc.
	assert.deepEqual(refs.map((ref) => ref.deref()?.constructor.name), [undefined, undefined], "global UI registries must not retain detached histories");
});
