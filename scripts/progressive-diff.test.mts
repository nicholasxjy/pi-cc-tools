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

const root = mkdtempSync(join(tmpdir(), "diff-streaming-"));
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.chdir(root);
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false, diffCollapsedLines: 3 }));
const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
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
const rowFor = (name: string, args: any = {}) => new ToolExecutionComponent(name, `streaming-${id++}`, args, {}, tools.get(name), { requestRender() {} } as any, root) as any;
async function settle(row: any, field: string) {
	for (let i = 0; i < 100; i++) {
		const output = plain(row.render(100));
		await setImmediate();
		if (row.rendererState[field] && !output.includes("rendering")) return output;
	}
	throw new Error("Diff did not settle");
}

for (const name of ["write", "edit", "apply_patch"]) {
	test(`${name} argument streaming reuses the header layout without rendering file content`, (t) => {
		const row = rowFor(name);
		const history = Array.from({ length: 50_000 }, (_, i) => `line-${i}`).join("\n");
		const words = t.mock.method(wordDiff, "diff");
		const lines = t.mock.method(lineDiff, "diff");
		let previous: string[] | undefined;
		const start = performance.now();
		for (let i = 0; i < 50; i++) {
			const text = `${history}\nlatest-${i}`;
			row.updateArgs(name === "write" ? { path: "large.txt", content: text }
				: name === "edit" ? { path: "large.txt", edits: [{ oldText: "before", newText: text }] }
				: { patchText: `*** Begin Patch\n*** Add File: large.txt\n${text}` });
			const output = plain(row.render(100));
			assert.match(output, /large\.txt/);
			assert.doesNotMatch(output, /Progressive output|line-0\b|latest-/);
			const layout = row.callRendererComponent.render(98);
			if (previous) assert.equal(layout, previous, "unchanged header must reuse its line layout");
			previous = layout;
		}
		t.diagnostic(`50,000 existing lines: ${((performance.now() - start) / 50).toFixed(3)} ms/update`);
		assert.equal(words.mock.callCount(), 0);
		assert.equal(lines.mock.callCount(), 0);
		row.updateResult({ content: [{ type: "text", text: "Operation aborted" }], isError: true }, false);
		assert.match(plain(row.render(100)), /Operation aborted/);
	});
}

test("write keeps exact file content and shows its completed diff", async () => {
	const content = "    const value = 1;\r\n\r\nend";
	const row = rowFor("write", { path: "new.ts", content });
	row.setArgsComplete();
	const result = await tools.get("write").execute("write-stream", { path: "new.ts", content });
	row.updateResult(result, false);
	assert.equal(readFileSync(join(root, "new.ts"), "utf8"), content);
	assert.match(await settle(row, "_nft"), /const value = 1;/);
});

test("edit waits for complete arguments before localization and shows every operation", async () => {
	writeFileSync(join(root, "edit.ts"), "first\nbefore\nlast\n");
	const row = rowFor("edit", { path: "edit.ts" });
	row.updateArgs({ path: "edit.ts", edits: [{ oldText: "before", newText: "aft" }] });
	assert.equal(row.rendererState._editLocalized, undefined);
	row.updateArgs({ path: "edit.ts", edits: [{ oldText: "before", newText: "after" }, { oldText: "last", newText: "latest" }] });
	row.setArgsComplete();
	const output = await settle(row, "_ptBody");
	assert.match(output, /Edit 1\/2.*at line 2/);
	assert.match(output, /Edit 2\/2.*at line 3/);
	assert.match(output, /after/);
	assert.match(output, /latest/);
});

test("apply_patch shows the parsed diff once arguments are complete", async () => {
	const row = rowFor("apply_patch");
	row.updateArgs({ patch_text: "*** Begin Patch\n*** Add File: streamed.txt\n+first\n+second\n*** End Patch" });
	row.setArgsComplete();
	const output = await settle(row, "_applyPatchPreviewBody");
	assert.match(output, /first/);
	assert.match(output, /second/);
});

for (const name of ["write", "edit", "apply_patch"]) {
	test(`${name} content changes refresh the cache and supersede queued previews`, async () => {
		const args: any = name === "write" ? { path: "refresh.txt", content: "initial" }
			: name === "edit" ? { path: "missing.txt", edits: [{ oldText: "before", newText: "initial" }] }
			: { patchText: "*** Begin Patch\n*** Add File: refresh.txt\n+initial\n*** End Patch" };
		const row = rowFor(name, args);
		row.setArgsComplete();
		if (name === "write") row.updateResult({ content: [], details: { _type: "new", filePath: "refresh.txt", lines: 1 } }, false);
		const field = name === "write" ? "_nft" : name === "edit" ? "_ptBody" : "_applyPatchPreviewBody";
		await settle(row, field);
		for (const text of ["obsolete", "newest"]) {
			if (name === "write") args.content = text;
			else if (name === "edit") args.edits[0].newText = text;
			else args.patchText = `*** Begin Patch\n*** Add File: refresh.txt\n+${text}\n*** End Patch`;
			row.updateArgs(args);
			row.render(100);
		}
		const output = await settle(row, field);
		assert.match(output, /newest/);
		assert.doesNotMatch(output, /initial|obsolete/);
	});

	test(`${name} settled previews do not hash unchanged source again`, async (t) => {
		const content = "shared context ".repeat(4000);
		const args = name === "write" ? { path: "cached.txt", content }
			: name === "edit" ? { path: "missing.txt", edits: [{ oldText: "before", newText: content }] }
			: { patchText: `*** Begin Patch\n*** Add File: cached.txt\n+${content}\n*** End Patch` };
		const row = rowFor(name, args);
		// Resumed writes have a final result without ever receiving setArgsComplete().
		if (name !== "write") row.setArgsComplete();
		if (name === "write") row.updateResult({ content: [], details: { _type: "new", filePath: "cached.txt", lines: 1 } }, false);
		const field = name === "write" ? "_nft" : name === "edit" ? "_ptBody" : "_applyPatchPreviewBody";
		await settle(row, field);
		const original = String.prototype.charCodeAt;
		const split = String.prototype.split;
		let scanned = 0;
		let splits = 0;
		String.prototype.split = function (this: string, ...args: any[]) {
			if (this.length >= content.length) splits++;
			return split.apply(this, args as any);
		};
		String.prototype.charCodeAt = function (this: string, index: number) {
			if (this.length >= content.length) scanned++;
			return original.call(this, index);
		};
		const start = performance.now();
		try {
			for (let i = 0; i < 10; i++) {
				row.invalidate();
				row.render(100);
			}
		} finally {
			String.prototype.charCodeAt = original;
			String.prototype.split = split;
		}
		t.diagnostic(`10 unchanged preview invalidations: ${scanned} source characters hashed, ${splits} full-source splits; ${(performance.now() - start).toFixed(2)} ms`);
		assert.equal(splits, 0, "resumed history must reuse final summaries without splitting the file again");
		assert.equal(scanned, 0, "warm diff redraws must reuse source identity rather than hash the whole file");
	});
}
