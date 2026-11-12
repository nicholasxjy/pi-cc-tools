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

const root = mkdtempSync(join(tmpdir(), "progressive-diff-"));
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false, diffCollapsedLines: 3 }));
const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const { wordDiff } = await import(new URL("./diff/word.js", import.meta.resolve("diff")).href);
const { lineDiff } = await import(new URL("./diff/line.js", import.meta.resolve("diff")).href);
const tools = new Map<string, any>([["apply_patch", { name: "apply_patch", description: "Apply a patch", parameters: {}, execute() {} }]]);
const handlers = new Map<string, any[]>();
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {},
	on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
} as any);
for (const handler of handlers.get("before_agent_start") ?? []) await handler({}, { hasUI: false });
test.after(() => {
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
});
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");
let id = 0;
const rowFor = (name: string, args: any = {}) => new ToolExecutionComponent(name, `progressive-${id++}`, args, {}, tools.get(name), { requestRender() {} } as any, root) as any;

async function settle(row: any) {
	for (let i = 0; i < 100; i++) {
		const output = plain(row.render(100));
		await setImmediate();
		if (row.rendererState._ptBody && !output.includes("rendering")) return output;
	}
	throw new Error("Diff did not settle");
}

test("write content appears as it arrives, keeps whitespace, and clears on completion", async () => {
	const row = rowFor("write", { path: "new.ts" });
	assert.doesNotMatch(plain(row.render(100)), /Progressive output/);
	row.updateArgs({ path: "new.ts", content: "    const value =" });
	assert.match(plain(row.render(100)), /Progressive output[\s\S]*\+    const value =/);
	row.updateArgs({ path: "new.ts", content: "    const value = 1;\r\n\r\nend" });
	assert.match(plain(row.render(100)), /\+    const value = 1;/);
	assert.match(plain(row.render(100)), /\+end/);
	row.setArgsComplete();
	assert.match(plain(row.render(100)), /Progressive output/);
	const result = await tools.get("write").execute("write-stream", { path: "new.ts", content: "    const value = 1;\r\n\r\nend" });
	row.updateResult(result, false);
	assert.equal(row.rendererState._progressiveDiff, undefined);
	assert.doesNotMatch(plain(row.render(100)), /Progressive output/);
	assert.equal(readFileSync(join(root, "new.ts"), "utf8"), "    const value = 1;\r\n\r\nend");
	await setImmediate();
});

test("edit streams the latest operation without caching incomplete file localization", async (t) => {
	writeFileSync(join(root, "edit.ts"), "first\nbefore\nlast\n");
	const row = rowFor("edit", { path: "edit.ts" });
	const words = t.mock.method(wordDiff, "diff");
	const lines = t.mock.method(lineDiff, "diff");
	row.updateArgs({ path: "edit.ts", edits: [{ oldText: "before" }] });
	assert.match(plain(row.render(100)), /-before/);
	row.updateArgs({ path: "edit.ts", edits: [{ oldText: "before", newText: "aft" }] });
	assert.match(plain(row.render(100)), /\+aft/);
	row.updateArgs({ path: "edit.ts", edits: [{ oldText: "before", newText: "after" }, { oldText: "last", newText: "latest" }] });
	assert.match(plain(row.render(100)), /\+latest/);
	assert.equal(row.rendererState._editLocalized, undefined);
	assert.equal(words.mock.callCount(), 0);
	assert.equal(lines.mock.callCount(), 0);
	row.setArgsComplete();
	const output = await settle(row);
	assert.doesNotMatch(output, /Progressive output/);
	assert.match(output, /Edit 1\/2.*at line 2/);
	assert.match(output, /Edit 2\/2.*at line 3/);
	assert.match(output, /after/);
	assert.match(output, /latest/);
});

test("apply_patch streams incomplete patch text and switches to the parsed diff", async () => {
	const row = rowFor("apply_patch");
	const patchText = "*** Begin Patch\n*** Add File: streamed.txt\n+first\n+secon";
	row.updateArgs({ patchText });
	assert.match(plain(row.render(100)), /Apply Patch streamed.txt/);
	assert.match(plain(row.render(100)), /Progressive output[\s\S]*\+secon/);
	row.updateArgs({ patch_text: `${patchText}d\n*** End Patch` });
	row.setArgsComplete();
	for (let i = 0; i < 100; i++) {
		row.render(100);
		await setImmediate();
		if (row.rendererState._applyPatchPreviewBody?.includes("second")) break;
	}
	const output = plain(row.render(100));
	assert.doesNotMatch(output, /Progressive output/);
	assert.match(output, /first/);
	assert.match(output, /second/);
});

for (const name of ["write", "edit", "apply_patch"]) {
	test(`${name} streaming work stays bounded as a large argument grows`, async (t) => {
		const row = rowFor(name);
		const history = Array.from({ length: 50_000 }, (_, i) => `line-${i}`).join("\n");
		const split = String.prototype.split;
		let fullSplits = 0;
		const spy = t.mock.method(String.prototype, "split", function (this: string, ...args: any[]) {
			if (this.length >= history.length) fullSplits++;
			return split.apply(this, args as any);
		});
		const words = t.mock.method(wordDiff, "diff");
		const lines = t.mock.method(lineDiff, "diff");
		const start = performance.now();
		for (let i = 0; i < 50; i++) {
			const text = `${history}\nlatest-${i}`;
			const args = name === "write" ? { path: "large.txt", content: text }
				: name === "edit" ? { path: "large.txt", edits: [{ oldText: "before", newText: text }] }
				: { patchText: `*** Begin Patch\n*** Add File: large.txt\n${text}` };
			row.updateArgs(args);
			const output = plain(row.render(100));
			assert.match(output, new RegExp(`latest-${i}\\b`));
			assert.doesNotMatch(output, /line-0\b/);
			assert.match(output, /earlier content omitted/);
		}
		t.diagnostic(`50,000 existing lines: ${((performance.now() - start) / 50).toFixed(3)} ms/update`);
		spy.mock.restore();
		assert.equal(fullSplits, 0);
		assert.equal(words.mock.callCount(), 0);
		assert.equal(lines.mock.callCount(), 0);
		const cache = row.rendererState._progressiveDiff;
		row.invalidate();
		row.render(100);
		assert.equal(row.rendererState._progressiveDiff, cache, "redraws reuse the visible preview");
		row.setExpanded(true);
		assert.match(plain(row.render(100)), /line-49900/);
		row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
		assert.doesNotMatch(plain(row.render(100)), /Progressive output/);
		assert.equal(row.rendererState._progressiveDiff, undefined);
		await setImmediate();
	});
}

test("progressive rows keep CJK and emoji inside the terminal width", () => {
	const row = rowFor("write");
	for (const ending of ["", "\n"]) {
		row.updateArgs({ path: "unicode.txt", content: `old head\n  ${"宽👩‍💻e\u0301".repeat(10_000)}${ending}` });
		for (const width of [40, 100]) {
			const output = plain(row.render(width));
			assert.match(output, /宽👩‍💻e\u0301/);
			assert.doesNotMatch(output, /\uFFFD|old head/);
			assert.ok(output.split("\n").every((line) => visibleWidth(line) <= width));
		}
	}
});
