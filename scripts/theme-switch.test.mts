import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

// On /theme or a light/dark switch Pi swaps the global theme and calls ui.invalidate().
// Rows drawn before the switch must repaint exactly as rows drawn after it.
process.env.COLORTERM = "truecolor";
const agentDir = mkdtempSync(join(tmpdir(), "theme-switch-agent-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ terminalTheme: false, themeAdaptive: false }));
const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container } = await import("@earendil-works/pi-tui");
const themes = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
const { contrastRatio } = await import("../extensions/theme-colors.ts");
themes.initTheme("dark", false);

const tools = new Map<string, any>();
const commands = new Map<string, any>();
const fakePi = { registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command), registerShortcut() {}, on() {}, getThinkingLevel: () => "off", getAllTools: () => [...tools.values()] };
(await import("../extensions/index.ts")).default(fakePi as any);

const cwd = mkdtempSync(join(tmpdir(), "theme-switch-"));
const ui = { requestRender() {} } as any;
test.after(() => {
	themes.setTheme("dark", false);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
});

async function settle(component: any, width = 120): Promise<string> {
	for (let previous = "", same = 0, i = 0; i < 400; i++) {
		const current = component.render(width).join("\n");
		same = current === previous && !current.includes("rendering") ? same + 1 : 0;
		if (same >= 3) return current;
		previous = current;
		await new Promise((done) => setTimeout(done, 10));
	}
	throw new Error("row never settled");
}

function editRow(path: string) {
	const row = new ToolExecutionComponent("edit", `edit-${Math.random()}`, { path, edits: [{ oldText: "const r10 = 10;", newText: "const r10 = 1000;" }] }, { showImages: false }, tools.get("edit"), ui, cwd) as any;
	row.setArgsComplete();
	return row;
}

function groupedRows(expanded: boolean) {
	const chat = new Container();
	for (const [name, args, text] of [["grep", { pattern: "foo" }, "a.ts:1: foo"], ["read", { path: "b.ts" }, "line1\nline2"]] as const) {
		const row = new ToolExecutionComponent(name, `${name}-${Math.random()}`, args, { showImages: false }, tools.get(name), ui, cwd) as any;
		row.setArgsComplete();
		row.updateResult({ content: [{ type: "text", text }], isError: false }, false);
		chat.addChild(row);
	}
	const [group] = chat.children as any[];
	assert.ok(Array.isArray(group?.tools), "rows are grouped");
	if (expanded) group.setExpanded(true);
	return chat;
}

async function assertClaudeDiffPalette(rendered: string, name: string): Promise<void> {
	const backgrounds = [...rendered.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)];
	assert.ok(backgrounds.length > 0, "the diff has tinted row and word backgrounds");
	assert.ok(backgrounds.every((m) => ((+m[1] + +m[2] + +m[3]) > 450) === (name === "light")),
		`${name} diff backgrounds match the theme's appearance`);
	const surface = name === "light" ? { r: 232, g: 233, b: 236 } : { r: 32, g: 35, b: 42 };
	const markers = [...rendered.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m▌/g)];
	assert.ok(markers.length > 0, "the diff has add/delete markers");
	for (const m of markers) {
		assert.ok(contrastRatio({ r: +m[1], g: +m[2], b: +m[3] }, surface) >= 3,
			`${name} add/delete markers stay visible against the surface`);
	}
	const { codeToANSI } = await import("@shikijs/cli");
	const expected = await codeToANSI("const r10 = 1000;", "typescript", `github-${name}`);
	const keyword = /\x1b\[38;2;\d+;\d+;\d+mconst/.exec(expected)?.[0];
	assert.ok(keyword && rendered.includes(keyword), `syntax uses github-${name}`);
}

test("Claude diff uses light colors when adaptive colors are disabled at startup", async () => {
	themes.setTheme("light", false);
	const path = join(cwd, "startup.ts");
	writeFileSync(path, "const r10 = 10;\n");
	await assertClaudeDiffPalette(await settle(editRow(path)), "light");
});

test("an edit diff drawn before a theme switch repaints with the new diff palette", async () => {
	themes.setTheme("dark", false);
	await commands.get("cc-theme").handler("on", { hasUI: true, ui: { theme: themes.theme, notify() {} } });
	const path = join(cwd, "a.ts");
	writeFileSync(path, `${Array.from({ length: 30 }, (_, i) => `const r${i} = ${i};`).join("\n")}\n`);
	const row = editRow(path);
	const dark = await settle(row);
	themes.setTheme("light", false);
	row.invalidate();
	const repainted = await settle(row);
	assert.notEqual(repainted, dark, "the light palette differs");
	assert.equal(repainted, await settle(editRow(path)));
});

for (const width of [120, 200]) {
	test(`Claude diff colors follow dark/light switches at ${width} columns`, async () => {
		await commands.get("cc-theme").handler("off", { hasUI: true, ui: { theme: themes.theme, notify() {} } });
		const path = join(cwd, `fixed-${width}.ts`);
		writeFileSync(path, `${Array.from({ length: 30 }, (_, i) => `const r${i} = ${i};`).join("\n")}\n`);
		const row = editRow(path);
		const outputs: string[] = [];
		for (const name of ["dark", "light", "dark"]) {
			themes.setTheme(name, false);
			row.invalidate();
			const rendered = await settle(row, width);
			await assertClaudeDiffPalette(rendered, name);
			assert.equal(rendered, await settle(editRow(path), width), "existing and new rows use the same palette");
			outputs.push(rendered);
		}
		assert.equal(outputs[0], outputs[2], "switching back restores the dark Claude palette");
		await commands.get("cc-theme").handler("on", { hasUI: true, ui: { theme: themes.theme, notify() {} } });
	});
}

for (const expanded of [false, true]) {
	test(`grouped rows repaint after a theme switch (${expanded ? "expanded" : "collapsed"})`, () => {
		themes.setTheme("dark", false);
		const chat = groupedRows(expanded);
		const dark = chat.render(100).join("\n");
		themes.setTheme("light", false);
		chat.invalidate();
		const repainted = chat.render(100).join("\n");
		assert.notEqual(repainted, dark, "the light palette differs");
		assert.equal(repainted, groupedRows(expanded).render(100).join("\n"));
	});
}
