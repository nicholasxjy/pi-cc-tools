process.env.FORCE_COLOR = "3";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
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
const hljs = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("highlight.js/lib/index.js");
const { Container, visibleWidth } = await import("@earendil-works/pi-tui");
const { initTheme, setTheme } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const fabricDefinition = {
	name: "fabric_exec", label: "Fabric", description: "Execute TypeScript using Pi core tools and MCP servers.",
	renderShell: "self", modelOnly: true,
	prepareArguments: (args: any) => args,
	execute: async () => ({ content: [], details: { success: true } }),
	renderCall() { throw new Error("Fabric call must use the codemode renderer"); },
	renderResult() { throw new Error("Fabric result must use the codemode renderer"); },
};
const mcpDefinition = { name: "mcp_status", description: "MCP server status", execute: async () => ({ content: [] }) };
const tools = new Map<string, any>([[fabricDefinition.name, fabricDefinition], [mcpDefinition.name, mcpDefinition]]);
const beforeAgentStart: Array<() => unknown> = [];
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {},
	on(event: string, handler: () => unknown) { if (event === "before_agent_start") beforeAgentStart.push(handler); },
	getThinkingLevel: () => "off", getAllTools: () => [...tools.values()],
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
function row(code = script, finished: any = result(), complete = true, name = "codemode", extraArgs = {}) {
	const component = new ToolExecutionComponent(name, `${name}-${Math.random()}`, { code, ...extraArgs }, { showImages: false }, tools.get(name), { requestRender() {} } as any, agentDir) as any;
	if (complete) component.setArgsComplete();
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

test("streamed JavaScript is highlighted in its first visible frame", () => {
	settings();
	const code = 'const progressiveCodemode = "first";';
	const component = row(code, result(), false);
	const line = component.render(100).find((line: string) => plain(line).includes("progressiveCodemode"));
	assert.match(line, /\x1b\[38;2;\d+;\d+;\d+m"first"/, "strings have syntax color before arguments finish streaming");
});

test("codemode highlights JavaScript without changing text, wrapping or preview limits", () => {
	settings(2);
	const code = 'const highlighted = "ok";\n\n// comment\ntext(highlighted);';
	const component = row(code);
	assert.equal(plain(component.rendererState._codemodeHighlight.text), code);
	assert.ok(visible(component, 40).some((line) => /2 more lines/.test(line)));
	component.setExpanded(true);
	const lines = component.render(40) as string[];
	assert.match(lines.find((line) => plain(line).includes("const highlighted"))!, /\x1b\[38;2;\d+;\d+;\d+mconst/);
	assert.ok(new Set(lines.join("\n").match(/\x1b\[38;2;\d+;\d+;\d+m/g)).size >= 4, "keywords, strings and comments have distinct colors");
	assert.ok(lines.every((line) => visibleWidth(line) <= 40));
});

test("identical calls share tokenization during streaming; redraws and resizing reuse it", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const code = 'const cachedCodemode = "shared";\ntext(cachedCodemode);';
	const first = row(code, result(), false);
	const second = row(code);
	assert.equal(first.rendererState._codemodeHighlight.text, second.rendererState._codemodeHighlight.text);
	for (let i = 0; i < 10; i++) {
		first.updateResult(result(), false);
		first.setExpanded(i % 2 === 0);
		first.invalidate();
		first.render(i % 2 === 0 ? 40 : 100);
	}
	row(code);
	assert.equal(tokenizer.mock.calls.filter((call) => call.arguments[0] === code).length, 1);
});

test("streaming keeps syntax colors through completion and hidden previews do not tokenize", async (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const component = row("const streamedCodemode =", result(), false);
	component.setExpanded(true);
	const chunks = [
		'const streamedCodemode = "incomplete',
		'const streamedCodemode = "complete";',
		'const streamedCodemode = "complete";\n/* comment\nstill comment',
		'const streamedCodemode = "complete";\n/* comment\nstill comment */\ntext(`value: ${streamedCodemode}`);',
	];
	for (const code of chunks) {
		component.updateArgs({ code });
		const text = component.rendererState._codemodeHighlight.text;
		assert.equal(plain(text), code, "every chunk is visible immediately without losing characters");
		assert.match(text, /\x1b\[38;2;\d+;\d+;\d+mconst/);
		assert.match(text, /\x1b\[38;2;\d+;\d+;\d+m"(?:incomplete|complete)/);
		assert.equal(tokenizer.mock.calls.filter((call) => call.arguments[0] === code).length, 1);
	}
	const before = component.render(100);
	component.setArgsComplete();
	assert.deepEqual(component.render(100), before, "completion does not recolor the script");
	await new Promise(setImmediate);
	assert.deepEqual(component.render(100), before, "no delayed highlighter replaces the preview");

	settings(0);
	const hiddenCode = 'const hiddenCodemode = "hidden";';
	const hidden = row(hiddenCode);
	assert.equal(hidden.rendererState._codemodeHighlight, undefined);
	assert.equal(tokenizer.mock.calls.filter((call) => call.arguments[0] === hiddenCode).length, 0);
	hidden.setExpanded(true);
	assert.ok(visible(hidden).some((line) => line.includes("const hiddenCodemode")));
	assert.equal(tokenizer.mock.calls.filter((call) => call.arguments[0] === hiddenCode).length, 1);
});

test("large scripts keep a readable preview without tokenization", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const code = '// large codemode script\n' + 'text("large");\n'.repeat(2500);
	const component = row(code);
	assert.equal(component.rendererState._codemodeHighlight, undefined);
	assert.ok(visible(component).some((line) => line.includes("large codemode script")));
	assert.equal(tokenizer.mock.callCount(), 0);
});

test("code and theme changes discard stale highlighting", () => {
	settings();
	const component = row('const oldCodemode = "old";');
	component.updateArgs({ code: 'const newCodemode = "new";' });
	assert.ok(visible(component).some((line) => line.includes("newCodemode")));
	assert.ok(!visible(component).some((line) => line.includes("oldCodemode")));
	const dark = component.render(100).join("\n");
	try {
		setTheme("light", false);
		component.invalidate();
		const light = component.render(100).join("\n");
		assert.notEqual(light, dark);
		const fresh = row('const newCodemode = "new";');
		assert.equal(light, fresh.render(100).join("\n"));
	} finally {
		setTheme("dark", false);
	}
});

test("a tokenizer failure falls back to text and a later call retries", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight", () => { throw new Error("tokenizer unavailable"); });
	const code = 'const retryCodemode = "retry";';
	const failed = row(code);
	assert.ok(visible(failed).some((line) => line.includes(code)));
	tokenizer.mock.restore();
	const retried = row(code);
	assert.match(retried.render(100).find((line: string) => plain(line).includes("const retryCodemode")), /\x1b\[38;2;\d+;\d+;\d+mconst/);
});

// Mirrors fabric_exec's content/details envelopes from src/fabric-exec-tool.ts and src/audit/details.ts.
function fabricResult(text = output, success = true) {
	return {
		content: [{ type: "text", text }],
		details: {
			success, kernel: "typescript", phases: [],
			audits: [{ ref: "pi.read", provider: "pi", tool: "read", args: { path: "package.json" }, result: "{}", success: true }],
		},
		...(success ? {} : { isError: true }),
	};
}

function fabricRow(args: any = { code: script }, finished: any = fabricResult(), complete = true) {
	return row("", finished, complete, "fabric_exec", args);
}

test("Fabric uses codemode previews and the default shell even with its own renderers", () => {
	settings();
	const component = fabricRow({ code: script, display: { name: "Inspect package" } });
	const lines = visible(component);
	assert.match(lines[0], /● Fabric Inspect package$/);
	assert.equal(component.getRenderShell(), "default");
	assert.equal(codeLines(lines).length, 5);
	assert.equal(outputLines(lines).length, 5);
	assert.equal(lines.filter((line) => /7 more lines.*ctrl\+o/.test(line)).length, 2);
	assert.ok(lines.some((line) => /Completed$/.test(line)));
	assert.equal(lines[0].indexOf("Fabric"), visible(row())[0].indexOf("Codemode"));
});

test("Fabric shares preview settings, wrapping and expansion limits with codemode", () => {
	settings(2, { previewLines: 9, expandedPreviewMaxLines: 8 });
	const component = fabricRow();
	assert.equal(codeLines(visible(component)).length, 2);
	assert.equal(outputLines(visible(component)).length, 2);
	component.setExpanded(true);
	assert.equal(codeLines(visible(component)).length, 8);
	assert.equal(outputLines(visible(component)).length, 8);
	assert.equal(visible(component).filter((line) => /display capped at 8 lines/.test(line)).length, 2);
	component.setExpanded(false);
	assert.equal(outputLines(visible(component)).length, 2);

	settings(0, { expandedPreviewMaxLines: 8 });
	component.invalidate();
	assert.equal(codeLines(visible(component)).length + outputLines(visible(component)).length, 0);
	assert.ok(visible(component).some((line) => /Completed.*ctrl\+o/.test(line)));
	component.setExpanded(true);
	assert.equal(outputLines(visible(component)).length, 8);

	settings();
	const long = "中abcdef".repeat(100);
	const wrapped = fabricRow({ code: long }, fabricResult(long));
	for (const width of [40, 80]) {
		assert.equal(visible(wrapped, width).filter((line) => /中abcdef/.test(line)).length, 10);
		assert.ok(wrapped.render(width).every((line: string) => visibleWidth(line) <= width));
	}
});

test("Fabric stays outside groups while other tools keep grouping", () => {
	settings();
	const chat = new Container();
	const ordinary = (name: string) => new ToolExecutionComponent(name, name, {}, undefined, undefined, { requestRender() {} } as any, agentDir);
	chat.addChild(ordinary("read"));
	chat.addChild(ordinary("find"));
	const first = fabricRow();
	const second = fabricRow();
	chat.addChild(first);
	chat.addChild(second);
	chat.addChild(ordinary("mcp_status"));
	chat.addChild(ordinary("web_search"));
	assert.equal(chat.children.length, 4);
	assert.equal(chat.children[1], first);
	assert.equal(chat.children[2], second);
	assert.equal(outputLines(chat.render(100).map(plain)).length, 10);
});

test("Fabric partial, failed and detached results retain their text and status", () => {
	settings();
	const component = fabricRow();
	component.updateResult({ content: [{ type: "text", text: "Reading package.json" }], details: { audits: [], phases: [], progress: "Reading package.json" } }, true);
	assert.equal(codeLines(visible(component)).length, 5);
	assert.ok(!visible(component).some((line) => /Completed|Done/.test(line)));
	component.updateResult(fabricResult(), false);
	assert.equal(outputLines(visible(component)).length, 5);
	const failed = visible(fabricRow({ code: "throw new Error();" }, fabricResult("Runtime error: broken", false)));
	assert.ok(failed.some((line) => /Failed$/.test(line)));
	assert.ok(failed.some((line) => /Runtime error: broken/.test(line)));
	const empty = visible(fabricRow({ code: "return;" }, fabricResult("(no output)")));
	assert.ok(empty.some((line) => /Completed$/.test(line)));
	const detached = visible(fabricRow({ code: "await pi.bash({command: 'build'});" }, { content: [{ type: "text", text: "Fabric program running in background. Task ID: task-1" }] }));
	assert.ok(detached.some((line) => /Done$/.test(line)));
	assert.ok(detached.some((line) => /Task ID: task-1/.test(line)));
});

test("Fabric preserves raw output, audits and image blocks across expansion and history replay", () => {
	settings(20);
	const raw = "Script completed\nWall time 0.1 seconds\nOutput:\nkeep this";
	const original: any = fabricResult(raw);
	original.content.push({ type: "image", mimeType: "image/png", data: "aW1hZ2U=" });
	const before = structuredClone(original);
	const args = { code: script.split("\n"), display: "Inspect package" };
	const component = fabricRow(args, original);
	assert.ok(visible(component).some((line) => /Script completed/.test(line)), "Fabric output has no native codemode envelope to strip");
	component.setExpanded(true);
	visible(component);
	component.setExpanded(false);
	const resumed = fabricRow(JSON.parse(JSON.stringify(args)), JSON.parse(JSON.stringify(original)), false);
	assert.deepEqual(visible(resumed), visible(component));
	assert.deepEqual(original, before);
	assert.equal(codeLines(visible(resumed)).length, 12);
});

test("Fabric highlights TypeScript while streaming and respects the recorded Python kernel", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const code = 'const fabricManifest: string = "package.json";';
	const streamed = fabricRow({ code }, fabricResult(), false);
	assert.equal(plain(streamed.rendererState._codemodeHighlight.text), code);
	assert.ok(tokenizer.mock.calls.some((call) => call.arguments[0] === code && call.arguments[1].language === "typescript"));
	const python = 'def fabric_preview():\n    return "ok"';
	const finished = fabricResult("ok");
	finished.details.kernel = "python";
	const component = fabricRow({ code: python }, finished);
	assert.equal(plain(component.rendererState._codemodeHighlight.text), python);
	assert.ok(tokenizer.mock.calls.some((call) => call.arguments[0] === python && call.arguments[1].language === "python"));
});

test("Fabric's MCP description does not replace its definition; other MCP tools still wrap", async () => {
	for (const handler of beforeAgentStart) await handler();
	assert.equal(tools.get("fabric_exec"), fabricDefinition);
	assert.notEqual(tools.get("mcp_status"), mcpDefinition);
	assert.equal(tools.get("fabric_exec").prepareArguments, fabricDefinition.prepareArguments);
	assert.equal(tools.get("fabric_exec").execute, fabricDefinition.execute);
	assert.equal(tools.get("fabric_exec").modelOnly, true);
});
