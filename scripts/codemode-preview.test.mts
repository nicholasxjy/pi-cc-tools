process.env.FORCE_COLOR = "3";
process.env.COLORTERM = "truecolor";
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
const { Container, Text, visibleWidth } = await import("@earendil-works/pi-tui");
const { getThemeByName, initTheme, setTheme, setThemeInstance } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
initTheme("dark", false);
const tools = new Map<string, any>();
const previousPreviewTheme = process.env.CODE_PREVIEW_THEME;
(await import("../extensions/index.ts")).default({
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand() {}, registerShortcut() {}, on() {},
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
function toolRow(name: string, args: unknown, definition?: any) {
	return new ToolExecutionComponent(name, `${name}-${Math.random()}`, args, { showImages: false }, definition, { requestRender() {} } as any, agentDir) as any;
}
function row(code = script, finished: any = result(), complete = true) {
	const component = toolRow("codemode", { code });
	if (complete) component.setArgsComplete();
	component.updateResult(finished, false);
	return component;
}
const codeLines = (lines: string[]) => lines.filter((line) => line.includes('text("code-'));
const outputLines = (lines: string[]) => lines.filter((line) => /output-\d/.test(line));

test("codemode shows five script lines and folds the output by default", () => {
	settings();
	const lines = visible(row());
	assert.equal(codeLines(lines).length, 5);
	assert.equal(outputLines(lines).length, 0);
	assert.equal(lines.filter((line) => /7 more lines.*ctrl\+o/.test(line)).length, 1);
	assert.ok(lines.some((line) => /Completed · 0.1s/.test(line)));
	assert.ok(!lines.some((line) => /Wall time|Output:|Script completed/.test(line)));
});

test("codemodePreviewLines overrides the default independently of previewLines", () => {
	settings(2, { previewLines: 9 });
	const lines = visible(row());
	assert.equal(codeLines(lines).length, 2);
	assert.equal(outputLines(lines).length, 0);
	assert.equal(lines.filter((line) => /10 more lines/.test(line)).length, 1);
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
		assert.equal(codeLines(visible(row())).length, 5);
	});
}

test("short content has no unnecessary truncation hint", () => {
	settings();
	const lines = visible(row('text("ok");', result("ok")));
	assert.ok(lines.some((line) => line.includes('text("ok");')));
	assert.ok(lines.some((line) => /Output · Completed.*ctrl\+o/.test(line)));
	assert.ok(!lines.includes("ok"));
	assert.ok(!lines.some((line) => /more lines/.test(line)));
});

test("long lines wrap before the five-line limit, including after resizing", () => {
	settings();
	const long = "中abcdef".repeat(100);
	const component = row(long, result(long));
	for (const width of [40, 80, 40]) {
		const lines = visible(component, width);
		assert.equal(lines.filter((line) => /中abcdef/.test(line)).length, 5, `five source lines at width ${width}`);
		assert.equal(lines.filter((line) => /more lines/.test(line)).length, 1);
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
	assert.equal(outputLines(lines).length, 0);
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
	assert.equal(codeLines(chat.render(100).map(plain)).length, 10);
	assert.equal(outputLines(chat.render(100).map(plain)).length, 0);
});

test("Fabric gets the VS Code light/dark pair unless a preview theme is already set", () => {
	assert.equal(process.env.CODE_PREVIEW_THEME, previousPreviewTheme || "light-plus/dark-plus");
});

test("Fabric can resolve diff backgrounds when a custom theme's message and tool rows are transparent", () => {
	const tokens = ["userMessageBg", "toolSuccessBg", "toolErrorBg"] as const;
	const native = {
		renderCall() { return new Text("Fabric", 0, 0); },
		renderResult(_result: unknown, _options: unknown, theme: any) {
			return new Text(tokens.map((token) => theme.getBgAnsi(token) + token + "\x1b[49m").join("\n"), 0, 0);
		},
	};
	try {
		for (const style of ["transparent", "outlines", "default"]) {
			settings(undefined, { toolBackground: style });
			const row = toolRow("fabric_exec", { code: "" }, native);
			row.updateResult({ content: [], details: { success: true } });
			for (const variant of ["dark", "light", "dark"]) {
				const theme = Object.assign(getThemeByName(variant)!, { name: "custom" });
				const panel = theme.getBgAnsi("toolSuccessBg");
				setThemeInstance(theme);
				row.invalidate();
				const rendered = row.render(80).join("\n");
				for (const token of tokens) {
					const color = new RegExp(`\\x1b\\[48;2;(\\d+);(\\d+);(\\d+)m${token}`).exec(rendered);
					assert.ok(color, `${style} supplies a concrete ${token} to Fabric`);
					assert.equal(color.slice(1).reduce((sum, n) => sum + Number(n), 0) > 450, variant === "light");
				}
				assert.equal(theme.getBgAnsi("userMessageBg"), "\x1b[49m", "the outer row stays transparent");
				if (style === "default") assert.ok(rendered.includes(panel + "toolSuccessBg"));
			}
		}
	} finally {
		setTheme("dark", false);
		settings();
	}
});

test("Fabric's registered renderer keeps its live activity and expanded transcript inside the tool row", () => {
	settings(0);
	const call = new Text("", 0, 0);
	const result = new Text("", 0, 0);
	const definition = {
		renderCall(args: any, _theme: any, ctx: any) {
			assert.ok(ctx.lastComponent === undefined || ctx.lastComponent === call);
			ctx.state.source = args.code;
			call.setText(ctx.expanded ? `fabric · TypeScript\n${args.code}` : "Inspect sources\nCheck the configured mode");
			return call;
		},
		renderResult(value: any, options: any, _theme: any, ctx: any) {
			assert.ok(ctx.lastComponent === undefined || ctx.lastComponent === result);
			assert.equal(ctx.state.source, 'return "ok"');
			const status = options.isPartial ? "Running" : value.details?.success === false ? "Failed" : "Tools";
			result.setText(`${status}\n${value.details?.progress ?? value.content[0].text}`);
			return result;
		},
	};
	const fabric = toolRow("fabric_exec", 'return "ok"', definition);
	fabric.updateResult({ content: [], details: { progress: "read src/config.ts" } }, true);
	assert.deepEqual(visible(fabric), ["● Fabric Inspect sources", "Check the configured mode", "└ Running", "read src/config.ts"]);
	fabric.updateResult({ content: [{ type: "text", text: "Nested tool output" }], details: { success: true } });
	fabric.setExpanded(true);
	assert.deepEqual(visible(fabric), ["● Fabric · TypeScript", 'return "ok"', "└ Tools", "Nested tool output"]);
	for (const width of [20, 44, 80]) {
		assert.ok(fabric.render(width).every((line: string) => visibleWidth(line) <= width));
	}
	fabric.setExpanded(false);
	const rejected = { content: [{ type: "text", text: "§42§ Invalid arguments" }], isError: true };
	fabric.updateResult(rejected);
	assert.deepEqual(visible(fabric).slice(-2), ["└ Failed", "Invalid arguments"]);
	assert.equal(rejected.content[0].text, "§42§ Invalid arguments");
	assert.equal("details" in rejected, false);
});

test("native Fabric source has kernel syntax colors without ordinals, before wrapping", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const sourceLines = ['const greeting = "你好";', "", "/* first", "123 */", "  if (greeting) {", "    return greeting;", "  }", "42"];
	const code = sourceLines.join("\n");
	const native = {
		renderCall(args: any, theme: any, ctx: any) {
			const title = theme.fg("toolTitle", "Fabric");
			const objective = theme.fg("dim", "123");
			return { invalidate() {}, render(width: number) {
				if (!ctx.expanded) return [title, objective];
				const lines = args.code.split("\n").map((line: string, i: number) =>
					`${theme.fg("dim", String(i + 1).padStart(2))} ${theme.fg("muted", line || " ")}`);
				return new Text([title, objective, ...lines].join("\n"), 0, 0).render(width);
			} };
		},
		renderResult(_value: any, _options: any, theme: any) {
			return new Text(`${theme.fg("dim", "1")} ${theme.fg("muted", "numbered output")}`, 0, 0);
		},
	};
	const fabric = toolRow("fabric_exec", { code }, native);
	visible(fabric);
	assert.equal(tokenizer.mock.callCount(), 0, "compact cards do not tokenize hidden scripts");
	fabric.setExpanded(true);
	fabric.updateResult({ content: [], details: { kernel: "typescript" } });
	const lines = fabric.render(80) as string[];
	const displayed = lines.map(plain).map((line) => line.trimEnd());
	const objective = displayed.findIndex((line) => line.trim() === "123");
	const indent = " ".repeat(displayed[objective].indexOf("123"));
	assert.deepEqual(displayed.slice(objective + 1, objective + 1 + sourceLines.length),
		sourceLines.map((line) => line ? indent + line : ""));
	assert.ok(displayed.some((line) => line.trim() === "└ 1 numbered output"));
	assert.match(lines.find((line) => plain(line).includes("greeting"))!, /\x1b\[38;2;\d+;\d+;\d+m"你好"/);
	assert.match(lines.find((line) => plain(line).includes("123 */"))!, /\x1b\[38;2;\d+;\d+;\d+m *123 \*\//);
	assert.ok(fabric.render(18).every((line: string) => visibleWidth(line) <= 18));
	fabric.updateResult({ content: [], details: { kernel: "python" } });
	visible(fabric);
	assert.deepEqual(tokenizer.mock.calls.filter((call) => call.arguments[0] === code).map((call) => call.arguments[1].language), ["typescript", "python"]);
});

test("Fabric without a registered renderer keeps its standalone code and output previews", () => {
	settings(2);
	const fabric = toolRow("fabric_exec", { display: { name: "Inspect sources" }, code: script });
	const chat = new Container();
	const read = toolRow("read", { path: "a.ts" });
	chat.addChild(read);
	chat.addChild(fabric);
	assert.deepEqual(chat.children, [read, fabric]);
	assert.ok(visible(fabric).some((line) => /Fabric.*Inspect sources/.test(line)));
	assert.equal(codeLines(visible(fabric)).length, 2);
	fabric.setArgsComplete();
	fabric.updateResult({ content: [{ type: "text", text: output }], details: { kernel: "typescript", success: true } });
	assert.equal(outputLines(visible(fabric)).length, 2);
	fabric.setExpanded(true);
	assert.equal(codeLines(visible(fabric)).length, 12);
	assert.equal(outputLines(visible(fabric)).length, 12);
});

test("Fabric previews its accepted shorthand arguments while they stream", () => {
	settings();
	const fabric = toolRow("fabric_exec", 'return "early"');
	assert.ok(visible(fabric).some((line) => line.endsWith('return "early"')));
	fabric.updateArgs({ display: "Inspect files", code: ["files = []", "return files"] });
	assert.ok(visible(fabric).some((line) => line.endsWith("Fabric Inspect files")));
	assert.ok(visible(fabric).some((line) => line.endsWith("return files")));
	fabric.updateArgs({ display: '{"name":"Count files"}', code: "return 0" });
	assert.ok(visible(fabric).some((line) => line.endsWith("Fabric Count files")));
});

test("Fabric renders raw output literally, even when it begins with a native codemode header", () => {
	settings();
	const fabric = toolRow("fabric_exec", { code: 'return "text"' });
	const literal = "Script failed\nWall time 1 seconds\nOutput:\nreturned verbatim";
	fabric.updateResult({ content: [{ type: "text", text: literal }], details: { success: true } });
	const lines = visible(fabric);
	assert.ok(lines.some((line) => line.endsWith("Script failed")));
	assert.ok(lines.some((line) => line.endsWith("returned verbatim")));
	assert.ok(!lines.some((line) => line.includes("Failed · 1s")));
	fabric.updateResult({ content: [{ type: "text", text: "Type errors; code was not executed:" }], isError: true });
	assert.ok(visible(fabric).some((line) => line.endsWith("Failed")));
	assert.ok(visible(fabric).some((line) => line.includes("Type errors")));
});

test("Fabric selects its live or recorded kernel and caches identical source per language", (t) => {
	settings();
	const tokenizer = t.mock.method(hljs, "highlight");
	const code = 'return "shared between kernels"';
	const ts = toolRow("fabric_exec", { code });
	const py = toolRow("fabric_exec", { code }, { parameters: { properties: { code: { description: "Python async function body executed by Monty" } } } });
	row(code);
	const languages = () => tokenizer.mock.calls.filter((call) => call.arguments[0] === code).map((call) => call.arguments[1].language);
	assert.deepEqual(languages(), ["typescript", "python", "javascript"]);
	const tsHighlight = ts.rendererState._codemodeHighlight;
	const pyHighlight = py.rendererState._codemodeHighlight;
	ts.updateResult({ content: [], details: { kernel: "python" } });
	py.updateResult({ content: [], details: { kernel: "typescript" } });
	assert.deepEqual(ts.rendererState._codemodeHighlight, pyHighlight);
	assert.deepEqual(py.rendererState._codemodeHighlight, tsHighlight);
	assert.equal(languages().length, 3);
});

test("live and replayed Codemode rows show icon-first bold names and fold only the script output", () => {
	settings(2, { liveToolPreview: true });
	const code = 'return "source marker";';
	const calls = [
		{ id: "c/1", name: "read", args: "a.txt", status: "ok" },
		{ id: "c/2", name: "read", args: "b.txt", status: "error", error: "nested failure text" },
		{ id: "c/3", name: "bash", status: "cancelled" },
	];
	const details = { calls, callPreviews: { "c/1": "legacy child output", "c/2": "nested failure text" } };
	const component = row(code);
	component.updateResult({ content: [{ type: "text", text: "partial script output" }], details: { ...details, calls: [{ ...calls[0], status: "running" }, calls[1]] } }, true);
	assert.deepEqual(visible(component).slice(1), [`└ ${code}`, "… read a.txt", "✗ read b.txt"]);
	component.updateResult(result("script output", false, details));
	for (const expanded of [false, true, false]) {
		component.setExpanded(expanded);
		const lines = visible(component);
		assert.deepEqual(lines.slice(1, 5), [`└ ${code}`, "✓ read a.txt", "✗ read b.txt", "⊘ bash"]);
		assert.match(lines[5], /Output · Completed · 0.1s/);
		assert.deepEqual(lines.slice(6), expanded ? ["script output"] : []);
		const rendered = component.render(100) as string[];
		for (const name of ["read", "bash"]) {
			const matches = rendered.filter((line) => plain(line).includes(name));
			assert.ok(matches.every((line) => line.includes(`\x1b[1m${name}\x1b[22m`)));
		}
		assert.ok(component.render(30).every((line: string) => visibleWidth(line) <= 30));
	}
});

test("zero source lines keep all nested calls visible and history errors are status-only", () => {
	settings(0);
	const calls = Array.from({ length: 12 }, (_, i) => ({ name: `tool${i}`, status: "ok" }));
	const component = row(script, result("", false, { calls }));
	component.updateResult(result("", false, { calls: [calls[0], { ...calls[1], status: "error", error: "old error" }, ...calls.slice(2)] }));
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		const lines = visible(component);
		assert.equal(lines.filter((line) => /^[✓✗] tool/.test(line)).length, 12);
		assert.ok(lines.includes("✗ tool1"));
		assert.ok(!lines.some((line) => line.includes("old error")));
	}
});

test("failed and empty results retain their status; ordinary text is not stripped", () => {
	settings();
	const failed = row("", result("Script error: broken", true));
	assert.ok(visible(failed).some((line) => /Output · Failed · 0.1s.*ctrl\+o/.test(line)));
	assert.ok(!visible(failed).includes("Script error: broken"));
	failed.setExpanded(true);
	assert.ok(visible(failed).includes("Script error: broken"));
	const empty = visible(row("", result("")));
	assert.ok(empty.some((line) => /Completed · 0.1s/.test(line)));
	assert.ok(!empty.some((line) => /Output|ctrl\+o|more lines/.test(line)));
	const ordinary = "Script completed\nWall time unknown seconds\nOutput:\nkeep this";
	const component = row("", { content: [{ type: "text", text: ordinary }], isError: false, details: undefined });
	component.setExpanded(true);
	const lines = visible(component);
	assert.ok(lines.some((line) => /Wall time unknown seconds/.test(line)));
	assert.ok(lines.some((line) => /keep this/.test(line)));
});

test("full output paths expand with the script output and rendering preserves the original result", () => {
	settings();
	const original = result(output, false, { fullOutputPath: "/tmp/codemode-full.txt", calls: [{ name: "read", status: "ok" }] });
	const before = structuredClone(original);
	const component = row(script, original);
	assert.ok(!visible(component).some((line) => line.includes("codemode-full.txt")));
	component.setExpanded(true);
	assert.ok(visible(component).some((line) => line.includes("Full output: /tmp/codemode-full.txt")));
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

test("large completed output reuses its preview and retains only visible rendered rows", () => {
	settings(5, { expandedPreviewMaxLines: 5 });
	const text = Array.from({ length: 20_000 }, (_, i) => `bounded-output-${i}`).join("\n");
	const component = row("return 1;", result(text));
	assert.equal(component.resultRendererComponent.children.length, 1, "folded output needs only a heading");
	component.setExpanded(true);
	const first = component.render(100);
	const preview = component.resultRendererComponent.children[1];
	assert.equal(preview.toolCachedLines.length, 5, "hidden padded rows must not remain in the layout cache");
	for (let i = 0; i < 5; i++) {
		component.invalidate();
		assert.deepEqual(component.render(100), first);
		assert.equal(component.resultRendererComponent.children[1], preview, "unchanged output reuses its layout");
	}
	assert.ok(visible(component).some((line) => /19995 more lines/.test(line)));
	component.updateResult(result("changed-output"), false);
	assert.ok(visible(component).some((line) => /changed-output/.test(line)));
	assert.ok(!visible(component).some((line) => /bounded-output/.test(line)));
});
