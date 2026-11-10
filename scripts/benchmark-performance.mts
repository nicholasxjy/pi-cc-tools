import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

const root = mkdtempSync(join(tmpdir(), "pi-cc-performance-"));
const previousCwd = process.cwd();
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
process.chdir(root);
writeFileSync(join(root, "settings.json"), JSON.stringify({ terminalTheme: false, groupToolCalls: true, bashIntent: "off", diffLayout: "unified" }));

const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container } = await import("@earendil-works/pi-tui");
const { initTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const tools = new Map<string, any>();
const handlers = new Map<string, any[]>();
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {},
	on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
} as any);
async function fire(event: string) {
	for (const handler of handlers.get(event) ?? []) await handler({}, { hasUI: false, ui: {} });
}
let id = 0;
function row(name: string, args: any) {
	return new ToolExecutionComponent(name, `bench-${++id}`, args, { showImages: false }, tools.get(name), { requestRender() {} } as any, root) as any;
}
const results: Array<{ name: string; iterations: number; msPerOperation: number; cpuMsPerOperation: number }> = [];
function measure(name: string, iterations: number, work: (index: number) => void) {
	const cpu = process.cpuUsage();
	const start = performance.now();
	for (let i = 0; i < iterations; i++) work(i);
	const duration = performance.now() - start;
	const used = process.cpuUsage(cpu);
	results.push({ name, iterations, msPerOperation: duration / iterations, cpuMsPerOperation: (used.user + used.system) / 1000 / iterations });
}
try {
	await fire("agent_start");
	const chat = new Container();
	for (let i = 0; i < 200; i++) {
		const tool = row("read", { path: `file-${i}.ts` });
		tool.setArgsComplete();
		tool.markExecutionStarted();
		chat.addChild(tool);
	}
	chat.render(100);
	measure("running-group-200-warm", 200, () => { chat.render(100); });
	await fire("agent_end");

	const text = Array.from({ length: 20_000 }, (_, i) => `output-${i}`).join("\n");
	const stream = row("read", { path: "stream.log" });
	let output = text;
	stream.updateResult({ content: [{ type: "text", text: output }] }, true);
	measure("append-to-20000-lines", 100, (i) => {
		output += `\nappended-${i}`;
		stream.updateResult({ content: [{ type: "text", text: output }] }, true);
	});

	const script = row("fabric_exec", { code: "return 1;" });
	const result = { content: [{ type: "text", text }], details: { success: true } };
	measure("fabric-20000-lines-first", 1, () => { script.updateResult(result, false); script.render(100); });
	measure("fabric-20000-lines-invalidate", 5, () => { script.invalidate(); script.render(100); });

	const oldText = Array.from({ length: 5000 }, (_, i) => `old${i}`).join(" ");
	const newText = Array.from({ length: 5000 }, (_, i) => `new${i}`).join(" ");
	const diff = { lines: [
		{ type: "del", oldNum: 1, newNum: null, content: oldText },
		{ type: "add", oldNum: null, newNum: 1, content: newText },
	], added: 1, removed: 1, chars: oldText.length + newText.length };
	const cpu = process.cpuUsage();
	const start = performance.now();
	const edit = row("write", { path: "large.txt", content: newText });
	edit.setArgsComplete();
	edit.updateResult({ content: [{ type: "text", text: "done" }], details: { _type: "diff", summary: "+1 -1", diff } }, false);
	for (let i = 0; i < 20; i++) {
		edit.render(100);
		await setImmediate();
		if (typeof edit.rendererState._wdt === "string" && !edit.rendererState._wdt.includes("rendering diff")) break;
	}
	if (!edit.rendererState._wdt || edit.rendererState._wdt.includes("rendering diff")) throw new Error("Diff did not settle");
	const used = process.cpuUsage(cpu);
	results.push({ name: "replace-5000-unrelated-words", iterations: 1, msPerOperation: performance.now() - start, cpuMsPerOperation: (used.user + used.system) / 1000 });
	const oldLines = Array.from({ length: 1500 }, (_, i) => `before-${i}`).join("\n");
	const newLines = Array.from({ length: 1500 }, (_, i) => `after-${i}`).join("\n");
	const path = join(root, "replacement.txt");
	writeFileSync(path, oldLines);
	const lineStart = performance.now();
	const lineCpu = process.cpuUsage();
	await tools.get("write").execute("benchmark-replacement", { path, content: newLines });
	const lineUsed = process.cpuUsage(lineCpu);
	results.push({ name: "replace-1500-lines", iterations: 1, msPerOperation: performance.now() - lineStart, cpuMsPerOperation: (lineUsed.user + lineUsed.system) / 1000 });
	const preview = script.resultRendererComponent.children[1];
	console.log(JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, width: 100,
		retainedPreviewRows: preview.toolCachedLines.length, results }, null, 2));
} finally {
	await fire("session_shutdown");
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
}
