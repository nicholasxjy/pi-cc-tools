import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

const agentDir = mkdtempSync(join(tmpdir(), "codemode-preview-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCwd = process.cwd();
process.env.PI_CODING_AGENT_DIR = agentDir;
process.chdir(agentDir);
let now = Date.now();
mock.method(Date, "now", () => now);
function settings(value?: unknown, extra: Record<string, unknown> = {}) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ terminalTheme: false, codemodePreviewLines: value, ...extra }));
	now += 5001; // Expire the settings cache without waiting.
}
settings();

const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container, visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
(await import("../extensions/index.ts")).default({
	registerTool() {}, registerCommand() {}, registerShortcut() {}, on() {},
	getThinkingLevel: () => "off", getAllTools: () => [],
} as any);

test.after(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	mock.restoreAll();
	rmSync(agentDir, { recursive: true, force: true });
});

const plain = (line: string) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/[\uE000\uE001]/g, "");
const visible = (row: any, width = 100): string[] => row.render(width).map(plain).map((line: string) => line.trim()).filter(Boolean);
const script = Array.from({ length: 12 }, (_, i) => `text("code-${i + 1}");`).join("\n");
const output = Array.from({ length: 12 }, (_, i) => `output-${i + 1}`).join("\n");
function result(text = output, isError = false, details?: unknown) {
	return {
		content: [
			{ type: "text", text: `Script ${isError ? "failed" : "completed"}\nWall time 0.1 seconds\nOutput:\n` },
			{ type: "text", text },
		],
		isError, details,
	};
}
function row(code = script, finished = result()) {
	const component = new ToolExecutionComponent("codemode", `codemode-${Math.random()}`, { code }, { showImages: false }, undefined, { requestRender() {} } as any, agentDir) as any;
	component.setArgsComplete();
	component.updateResult(finished, false);
	return component;
}
const codeLines = (lines: string[]) => lines.filter((line) => line.includes('text("code-'));
const outputLines = (lines: string[]) => lines.filter((line) => /output-\d/.test(line));

test("codemode defaults to five script and output lines, excluding its status header", () => {
	settings();
	const lines = visible(row());
	assert.equal(codeLines(lines).length, 5);
	assert.equal(outputLines(lines).length, 5);
	assert.equal(lines.filter((line) => /7 more lines.*ctrl\+o/.test(line)).length, 2);
	assert.ok(lines.some((line) => /Completed · 0.1s/.test(line)));
	assert.ok(!lines.some((line) => /Wall time|Output:|Script completed/.test(line)));
});

test("codemodePreviewLines overrides the default independently of previewLines", () => {
	settings(2, { previewLines: 9 });
	const lines = visible(row());
	assert.equal(codeLines(lines).length, 2);
	assert.equal(outputLines(lines).length, 2);
	assert.equal(lines.filter((line) => /10 more lines/.test(line)).length, 2);
});

test("zero hides both previews while expansion still reveals their content", () => {
	settings(0);
	const component = row();
	const lines = visible(component);
	assert.equal(codeLines(lines).length + outputLines(lines).length, 0);
	assert.ok(lines.some((line) => /Completed.*ctrl\+o/.test(line)));
	component.setExpanded(true);
	assert.equal(codeLines(visible(component)).length, 12);
	assert.equal(outputLines(visible(component)).length, 12);
});

for (const value of [-1, 1.5, "2", null]) {
	test(`invalid preview setting ${JSON.stringify(value)} falls back to five`, () => {
		settings(value);
		assert.equal(outputLines(visible(row())).length, 5);
	});
}

test("short content has no unnecessary truncation hint", () => {
	settings();
	const lines = visible(row('text("ok");', result("ok")));
	assert.ok(lines.some((line) => line.includes('text("ok");')));
	assert.ok(lines.some((line) => /└ ok$/.test(line)));
	assert.ok(!lines.some((line) => /more lines/.test(line)));
});

test("long lines wrap before the five-line limit, including after resizing", () => {
	settings();
	const long = "中abcdef".repeat(100);
	const component = row(long, result(long));
	for (const width of [40, 80, 40]) {
		const lines = visible(component, width);
		assert.equal(lines.filter((line) => /中abcdef/.test(line)).length, 10, `five lines per preview at width ${width}`);
		assert.equal(lines.filter((line) => /more lines/.test(line)).length, 2);
		assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
	}
});

test("expanding and collapsing uses the existing expansion cap", () => {
	settings(5, { expandedPreviewMaxLines: 8 });
	const component = row();
	component.setExpanded(true);
	let lines = visible(component);
	assert.equal(codeLines(lines).length, 8);
	assert.equal(outputLines(lines).length, 8);
	assert.equal(lines.filter((line) => /display capped at 8 lines/.test(line)).length, 2);
	component.setExpanded(false);
	lines = visible(component);
	assert.equal(codeLines(lines).length, 5);
	assert.equal(outputLines(lines).length, 5);
});

test("codemode remains visible between adjacent tools and consecutive codemode calls", () => {
	settings();
	const chat = new Container();
	const read = new ToolExecutionComponent("read", "read-before", { path: "a.ts" }, undefined, undefined, { requestRender() {} } as any, agentDir);
	const first = row();
	const second = row();
	chat.addChild(read);
	chat.addChild(first);
	chat.addChild(second);
	assert.deepEqual(chat.children, [read, first, second]);
	assert.equal(outputLines(chat.render(100).map(plain)).length, 10);
});

test("partial updates retain the script preview and final updates reveal output", () => {
	settings();
	const component = row();
	component.updateResult({ content: [], details: { calls: [{ name: "read", status: "running" }] }, isError: false }, true);
	assert.equal(codeLines(visible(component)).length, 5);
	assert.equal(outputLines(visible(component)).length, 0);
	component.updateResult(result(), false);
	assert.equal(outputLines(visible(component)).length, 5);
});

test("failed and empty results retain their status; ordinary text is not stripped", () => {
	settings();
	const failed = visible(row("", result("Script error: broken", true)));
	assert.ok(failed.some((line) => /Failed · 0.1s/.test(line)));
	assert.ok(failed.some((line) => /Script error: broken/.test(line)));
	const empty = visible(row("", result("")));
	assert.ok(empty.some((line) => /Completed · 0.1s/.test(line)));
	assert.ok(!empty.some((line) => /more lines/.test(line)));
	const ordinary = "Script completed\nWall time unknown seconds\nOutput:\nkeep this";
	const lines = visible(row("", { content: [{ type: "text", text: ordinary }], isError: false, details: undefined }));
	assert.ok(lines.some((line) => /Wall time unknown seconds/.test(line)));
	assert.ok(lines.some((line) => /keep this/.test(line)));
});

test("full output paths stay visible and rendering preserves the original result", () => {
	settings();
	const original = result(output, false, { fullOutputPath: "/tmp/codemode-full.txt", calls: [{ name: "read", status: "ok" }] });
	const before = structuredClone(original);
	const component = row(script, original);
	assert.ok(visible(component).some((line) => /Full output: \/tmp\/codemode-full.txt/.test(line)));
	component.setExpanded(true);
	visible(component);
	assert.deepEqual(original, before);
});
