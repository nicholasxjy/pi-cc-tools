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
const { AssistantMessageComponent, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container } = await import("@earendil-works/pi-tui");
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

for (const mode of ["unified", "split", "auto"]) {
	const width = mode === "unified" ? 100 : 240;
	test(`a single oversized Unicode diff only segments visible text in ${mode} layout`, async (t) => {
		layout(mode);
		const segment = Intl.Segmenter.prototype.segment;
		let graphemes = 0;
		t.mock.method(Intl.Segmenter.prototype, "segment", function (this: Intl.Segmenter, input: string) {
			const segments = segment.call(this, input);
			if (input.length < 4096) return segments;
			return {
				containing: segments.containing.bind(segments),
				*[Symbol.iterator]() {
					for (const part of segments) {
						graphemes++;
						yield part;
					}
				},
			};
		});
		const tail = "宽🙂e\u0301".repeat(10_000);
		const oldText = `before ${tail}`;
		const newText = `after ${tail}`;
		const start = performance.now();
		const row = await renderDiff(oldText, newText, width);
		t.diagnostic(`single Unicode diff: ${(performance.now() - start).toFixed(2)} ms; ${graphemes} long-input graphemes visited`);
		assert.ok(graphemes < 2000, "layout must stop segmenting after the visible wrap budget, including width measurement");
		const output = plain(row.render(width).join("\n"));
		assert.match(output, /before/);
		assert.match(output, /after/);
		assert.match(output, /宽🙂e\u0301/);
		assert.match(output, /›/);
		const shorter = await renderDiff(`before ${tail.slice(0, 6000)}`, `after ${tail.slice(0, 6000)}`, width);
		assert.deepEqual(row.render(width), shorter.render(width), "hidden suffix length must not change the visible text, styles or truncation");
	});
}

test("short diff lines keep emoji intact across syntax color changes", async () => {
	layout("unified");
	const faces = "👩\x1b[31m‍💻\x1b[0m".repeat(30);
	const row = await renderDiff(`before ${faces} END`, `after ${faces} END`, 100);
	const output = plain(row.render(100).join("\n"));
	assert.ok(output.includes("👩‍💻".repeat(30)));
	assert.match(output, /END/);
	assert.doesNotMatch(output, /›/);
});

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


test("diff history yields to input while previews settle and reuses layout during streaming", async (t) => {
	layout("unified");
	const chat = new Container();
	const rows = Array.from({ length: 40 }, (_, index) => {
		const row = new ToolExecutionComponent("write", `history-${index}`, { path: `history-${index}.txt`, content: "after" }, {}, tools.get("write"), { requestRender() {} } as any, root) as any;
		row.setArgsComplete();
		const lines = Array.from({ length: 40 }, (_, i) => ({
			type: i % 2 ? "add" : "del", oldNum: i % 2 ? null : i + 1, newNum: i % 2 ? i + 1 : null,
			content: `const value${index}_${Math.floor(i / 2)} = ${i % 2 ? "after" : "before"}; ${"shared context ".repeat(50)}`,
		}));
		row.updateResult({ content: [], details: { _type: "diff", summary: "+20 -20", diff: { lines, added: 20, removed: 20, chars: 60_000 } } }, false);
		chat.addChild(row);
		return row;
	});
	const start = performance.now();
	const input = setImmediate().then(() => {
		const settled = rows.filter((row) => row.rendererState._wdt && !row.rendererState._wdt.includes("rendering diff")).length;
		t.diagnostic(`input callback after ${(performance.now() - start).toFixed(2)} ms; ${settled}/${rows.length} previews already computed`);
		assert.ok(settled < rows.length, "diff previews must yield to input instead of draining the entire history in microtasks");
	});
	chat.render(100);
	await input;
	for (let i = 0; i < 200; i++) {
		chat.render(100);
		await setImmediate();
		if (rows.every((row) => row.rendererState._wdt && !row.rendererState._wdt.includes("rendering diff"))) break;
	}
	assert.ok(rows.every((row) => row.rendererState._wdt && !row.rendererState._wdt.includes("rendering diff")), "all queued previews eventually finish");
	chat.render(100);
	const stream = new AssistantMessageComponent();
	chat.addChild(stream);
	const calls = t.mock.method(wordDiff, "diff");
	const frameStart = performance.now();
	for (let i = 0; i < 50; i++) {
		stream.updateContent({ role: "assistant", stopReason: "pending", content: [{ type: "text", text: `Streaming ${i}` }] } as any, true);
		chat.render(100);
	}
	t.diagnostic(`streaming with 40 settled diffs: ${((performance.now() - frameStart) / 50).toFixed(3)} ms/frame`);
	assert.equal(calls.mock.callCount(), 0, "streaming and scrolling must reuse settled word analysis");
});

test("a failed preview does not stall subsequent diffs", async (t) => {
	layout("unified");
	const original = wordDiff.diff;
	let fail = true;
	t.mock.method(wordDiff, "diff", function (this: any, ...args: any[]) {
		if (fail) {
			fail = false;
			throw new Error("preview failed");
		}
		return original.apply(this, args);
	});
	const failed = await renderDiff("before", "after", 100);
	assert.doesNotMatch(plain(failed.render(100).join("\n")), /rendering diff/);
	const next = await renderDiff("const count = 1;", "const count = 2;", 100);
	assert.match(plain(next.render(100).join("\n")), /const count = 2;/);
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
