import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

const root = mkdtempSync(join(tmpdir(), "diff-performance-"));
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false }));
const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { initTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const { wordDiff } = await import(new URL("./diff/word.js", import.meta.resolve("diff")).href);
const { lineDiff } = await import(new URL("./diff/line.js", import.meta.resolve("diff")).href);
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
function layout(value: string) {
	writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false, diffLayout: value }));
	clockOffset += 5001;
}
const tools = new Map<string, any>();
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {}, on() {},
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
} as any);
test.after(() => {
	Date.now = realNow;
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

async function renderDiff(oldText: string, newText: string, width: number, chars = oldText.length + newText.length) {
	const row = new ToolExecutionComponent("write", `diff-${width}`, { path: "fixture.txt", content: newText }, {}, tools.get("write"), { requestRender() {} } as any, root) as any;
	row.setArgsComplete();
	row.updateResult({ content: [{ type: "text", text: "done" }], details: {
		_type: "diff", summary: "+1 -1", diff: { lines: [
			{ type: "del", oldNum: 1, newNum: null, content: oldText },
			{ type: "add", oldNum: null, newNum: 1, content: newText },
		], added: 1, removed: 1, chars },
	} }, false);
	for (let i = 0; i < 20; i++) {
		row.render(width);
		await setImmediate();
		if (row.rendererState._wdt && !row.rendererState._wdt.includes("rendering diff")) return row;
	}
	throw new Error("Diff did not settle");
}

for (const width of [100, 240]) {
	test(`long-line differences have bounded word analysis at width ${width}`, async (t) => {
		layout(width === 240 ? "split" : "unified");
		const calls = t.mock.method(wordDiff, "diff");
		const oldText = Array.from({ length: 2000 }, (_, i) => `old${i}`).join(" ");
		const newText = Array.from({ length: 2000 }, (_, i) => `new${i}`).join(" ");
		const start = performance.now();
		const row = await renderDiff(oldText, newText, width);
		t.diagnostic(`unrelated long-line diff: ${(performance.now() - start).toFixed(2)} ms`);
		assert.match(plain(row.render(width).join("\n")), /old0/);
		assert.match(plain(row.render(width).join("\n")), /new0/);
		const bounded = await renderDiff(Array.from({ length: 200 }, (_, i) => `left${i}`).join(" "), Array.from({ length: 200 }, (_, i) => `right${i}`).join(" "), width);
		const lines = plain(bounded.render(width).join("\n")).split("\n");
		assert.equal(lines.some((line) => line.includes("left0") && line.includes("right0")), width === 240, "exercise both unified and forced split layouts");
		assert.ok(calls.mock.callCount() > 0, "small enough input reaches the bounded analyzer");
		assert.ok(calls.mock.calls.every((call: any) => call.arguments[2]?.maxEditLength > 0), "word diff must have a computation budget, or skip oversized lines");
	});
}

test("a large replacement has bounded presentation work and writes the exact requested content", async (t) => {
	const oldText = Array.from({ length: 1500 }, (_, i) => `old-${i}`).join("\n");
	const newText = Array.from({ length: 1500 }, (_, i) => `new-${i}`).join("\n");
	const path = join(root, "replace.txt");
	writeFileSync(path, oldText);
	const calls = t.mock.method(lineDiff, "diff");
	const result = await tools.get("write").execute("large-replacement", { path, content: newText });
	assert.equal(readFileSync(path, "utf8"), newText, "presentation limits must never change the file write");
	assert.equal(result.details.diff.added, 1500);
	assert.equal(result.details.diff.removed, 1500);
	assert.ok(calls.mock.callCount() > 0);
	assert.ok(calls.mock.calls.every((call: any) => call.arguments[2]?.maxEditLength > 0), "line diff must have a computation budget");
});

test("normal edits analyze words once, including when syntax highlighting is capped", async (t) => {
	layout("unified");
	const calls = t.mock.method(wordDiff, "diff");
	for (const chars of [32, 64_000]) {
		const before = calls.mock.callCount();
		const row = await renderDiff("const count = 1;", "const count = 2;", 100, chars);
		assert.equal(calls.mock.callCount() - before, 1);
		assert.match(row.rendererState._wdt, /1/);
		assert.match(row.rendererState._wdt, /2/);
		assert.ok((row.rendererState._wdt.match(/\x1b\[48;/g) ?? []).length > 2);
	}
});


test("edit summaries survive resizing and expansion", async (t) => {
	const args = { path: "missing.txt", edits: [{ oldText: "before\n", newText: "after\n" }] };
	const row = new ToolExecutionComponent("edit", "resize-summary", args, {}, tools.get("edit"), { requestRender() {} } as any, root) as any;
	row.updateResult({ content: [], details: { preview: null } }, false);
	await setImmediate();
	row.render(100);
	await setImmediate();
	row.render(100);
	const calls = t.mock.method(lineDiff, "diff");
	for (const width of [101, 102, 80, 100]) {
		row.render(width);
		await setImmediate();
		row.setExpanded(!row.expanded);
		row.invalidate();
		row.render(width);
		await setImmediate();
	}
	assert.equal(calls.mock.callCount(), 0, "layout changes must not regenerate the parsed diff");
});
