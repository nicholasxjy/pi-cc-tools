import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

import "./ts-resolve-loader.mjs";
register("./ts-resolve-loader.mjs", import.meta.url);

import { buildBashCommandPresentation, getLastBashOutputLine } from "../extensions/bash-command.ts";
import { detectBashFileEdit } from "../extensions/bash-file-edit.ts";

process.env.COLORTERM = "truecolor";

const agentDir = mkdtempSync(join(tmpdir(), "ui-perf-opt-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "ui-perf-opt-project-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousCwd = process.cwd();
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(projectDir, ".pi"), { recursive: true });
process.chdir(projectDir);

let clockNow = Date.now();
mock.method(Date, "now", () => clockNow);

function writeUserSettings(data: Record<string, unknown>) {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(data));
	clockNow += 6_000;
}

function writeProjectSettings(data: Record<string, unknown>) {
	writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify(data));
	clockNow += 6_000;
}

writeUserSettings({
	terminalTheme: false,
	themeAdaptive: false,
	spinnerVerbColor: "accent",
	bashOutputMode: "summary",
	readOutputMode: "summary",
	searchOutputMode: "count",
});
writeProjectSettings({
	terminalTheme: false,
	themeAdaptive: true,
	spinnerVerbColor: "success",
	bashOutputMode: "preview",
	bashCollapsedLines: 2,
	readOutputMode: "preview",
	searchOutputMode: "preview",
	liveToolPreview: false,
});

const { AssistantMessageComponent, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const { Container, Markdown, visibleWidth } = await import("@earendil-works/pi-tui");
const themes = await import("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");
themes.initTheme("dark", false);
const initialToolSuccessBg = themes.theme.getBgAnsi("toolSuccessBg");
assert.notEqual(initialToolSuccessBg, "\x1b[49m");

const tools = new Map<string, any>();
const commands = new Map<string, any>();
const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
const fakePi = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	registerCommand: (name: string, command: any) => commands.set(name, command),
	registerShortcut() {},
	on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	getThinkingLevel: () => "off",
	getAllTools: () => [...tools.values()],
};
(await import("../extensions/index.ts")).default(fakePi as any);

// Register a sample MCP tool and OpenAI-style tool for error/override checks.
const sampleMcpTool = {
	name: "mcp__demo__echo",
	label: "mcp__demo__echo",
	description: "Demo MCP tool",
	promptSnippet: "Run demo echo",
	promptGuidelines: ["Use demo echo carefully"],
	outputSchema: { type: "object" },
	parameters: {},
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};
const sampleWebfetchTool = {
	name: "webfetch",
	label: "Webfetch",
	description: "Fetch a URL",
	promptSnippet: "Fetch URL",
	parameters: {},
	execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};
const origGetAllTools = fakePi.getAllTools;
fakePi.getAllTools = () => [sampleMcpTool, sampleWebfetchTool, ...origGetAllTools()];
for (const handler of handlers.get("session_start") ?? []) {
	await handler({ reason: "startup" }, { hasUI: false, ui: {} });
}

const spinnerHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
(await import("../extensions/spinner.ts")).default({
	on: (event: string, handler: any) => spinnerHandlers.set(event, [...(spinnerHandlers.get(event) ?? []), handler]),
	registerCommand() {},
	registerShortcut() {},
	getThinkingLevel: () => "off",
} as any);

test.after(async () => {
	for (const handler of spinnerHandlers.get("session_shutdown") ?? []) await handler({}, {});
	mock.restoreAll();
	process.chdir(previousCwd);
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
});

const plain = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/[\uE000\uE001]/g, "");
const ui = { requestRender() {} } as any;

function row(name: string, args: any, text: string, isError = false, expanded = false) {
	const comp = new ToolExecutionComponent(name, `${name}-${Math.random()}`, args, { showImages: false }, tools.get(name), ui, projectDir) as any;
	comp.setArgsComplete();
	comp.setExpanded(expanded);
	comp.updateResult({ content: [{ type: "text", text }], isError }, false);
	return comp;
}

test("project .pi/settings.json overrides user settings for tool output modes and spinner", async () => {
	// Project has bashOutputMode: "preview", bashCollapsedLines: 2, liveToolPreview: false (overriding user "summary").
	const bash = row("bash", { command: "echo lines" }, "alpha\nbeta\ngamma\ndelta", false, false);
	const bashLines = bash.render(100).map(plain).join("\n");
	assert.match(bashLines, /Done \(4 lines\)/);
	assert.match(bashLines, /alpha/);
	assert.match(bashLines, /beta/);
	assert.doesNotMatch(bashLines, /gamma/);

	// Spinner project settings override user themeAdaptive=false and spinnerVerbColor=accent.
	let working = "";
	const spinnerCtx = {
		hasUI: true,
		cwd: projectDir,
		ui: {
			theme: themes.theme,
			setWorkingMessage: (msg?: string) => { working = msg ?? ""; },
			notify() {},
		},
	};
	for (const fn of spinnerHandlers.get("agent_start") ?? []) await fn({}, spinnerCtx);
	for (const fn of spinnerHandlers.get("turn_start") ?? []) await fn({}, spinnerCtx);
	assert.ok(working.startsWith(themes.theme.getFgAnsi("success")), "project spinnerVerbColor=success overrides user accent");

	// message_update deltas must not resolve theme colors on every chunk.
	const origGetFgAnsi = themes.theme.getFgAnsi.bind(themes.theme);
	let fgLookups = 0;
	const spyTheme = new Proxy(themes.theme as any, {
		get(target, prop) {
			if (prop === "getFgAnsi") {
				return (k: any) => {
					fgLookups++;
					return origGetFgAnsi(k);
				};
			}
			return Reflect.get(target, prop);
		},
	});
	spinnerCtx.ui.theme = spyTheme;
	try {
		for (let i = 0; i < 10; i++) {
			for (const fn of spinnerHandlers.get("message_update") ?? []) {
				await fn({ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" } }, spinnerCtx);
			}
		}
		assert.equal(fgLookups, 0, "streaming text deltas must not re-query theme.getFgAnsi");
	} finally {
		for (const fn of spinnerHandlers.get("turn_end") ?? []) await fn({}, spinnerCtx);
		for (const fn of spinnerHandlers.get("agent_end") ?? []) await fn({ messages: [] }, spinnerCtx);
	}
});

test("readOutputMode and searchOutputMode control collapsed output while keeping errors visible", () => {
	try {
		writeProjectSettings({ terminalTheme: false, readOutputMode: "summary", searchOutputMode: "count" });
		const readSummary = plain(row("read", { path: "a.ts" }, "one\ntwo").render(100).join("\n"));
		assert.match(readSummary, /2 lines loaded/);
		assert.doesNotMatch(readSummary, /ctrl\+o to toggle/);

		const grepCount = plain(row("grep", { pattern: "x" }, "a.ts:1: x\nb.ts:2: x").render(100).join("\n"));
		assert.match(grepCount, /2 matches/);
		assert.doesNotMatch(grepCount, /ctrl\+o to toggle/);

		writeProjectSettings({ terminalTheme: false, readOutputMode: "hidden", searchOutputMode: "hidden", mcpOutputMode: "hidden" });
		const readHidden = row("read", { path: "a.ts" }, "one\ntwo").render(100).map(plain).filter((l: string) => l.trim());
		assert.equal(readHidden.length, 1);
		assert.match(readHidden[0], /Read a\.ts/);

		const grepHidden = row("grep", { pattern: "x" }, "a.ts:1: x").render(100).map(plain).filter((l: string) => l.trim());
		assert.equal(grepHidden.length, 1);
		assert.match(grepHidden[0], /Grep/);

		// Errors stay visible even in hidden mode.
		const mcpErr = plain(row("mcp__demo__echo", {}, "boom", true, false).render(100).join("\n"));
		assert.match(mcpErr, /boom/);
	} finally {
		writeProjectSettings({
			terminalTheme: false,
			themeAdaptive: true,
			spinnerVerbColor: "success",
			bashOutputMode: "preview",
			bashCollapsedLines: 2,
			readOutputMode: "preview",
			searchOutputMode: "preview",
			liveToolPreview: false,
		});
	}
});

test("grep, find, ls render errors in red and expanded mcp/openai errors do not duplicate line 1", () => {
	const errAnsi = themes.theme.getFgAnsi("error");
	for (const [name, args, errText] of [
		["grep", { pattern: "foo" }, "rg: invalid regex"],
		["find", { pattern: "*.ts" }, "Permission denied"],
		["ls", { path: "missing" }, "ENOENT: no such directory"],
	] as const) {
		const rendered = row(name, args, errText, true, false).render(100).join("\n");
		assert.ok(rendered.includes(`${errAnsi}${errText}`), `${name} renders error in red`);
		assert.doesNotMatch(plain(rendered), /\d+ (?:matches|files|entries)/);
	}

	const multiErr = "Line 1 error\nLine 2 detail";
	for (const name of ["mcp__demo__echo", "webfetch"]) {
		const expanded = plain(row(name, { url: "https://example.test" }, multiErr, true, true).render(100).join("\n"));
		const firstLineMatches = expanded.match(/Line 1 error/g) ?? [];
		assert.equal(firstLineMatches.length, 1, `${name} expanded error does not duplicate line 1:\n${expanded}`);
		assert.match(expanded, /Line 2 detail/);
	}

	assert.equal(tools.get("mcp__demo__echo").promptSnippet, "Run demo echo");
	assert.deepEqual(tools.get("mcp__demo__echo").promptGuidelines, ["Use demo echo carefully"]);
	assert.deepEqual(tools.get("mcp__demo__echo").outputSchema, { type: "object" });
	assert.equal(tools.get("webfetch").promptSnippet, "Fetch URL");
});

test("/cc-spinner, /cc-tools default restoration, and /cc-tools border alias behave cleanly", async () => {
	const ccSpinner = commands.get("cc-spinner");
	const verbCompletions = ccSpinner.getArgumentCompletions("verb ac");
	assert.deepEqual(verbCompletions.map((c: any) => c.value), ["verb accent"]);

	writeProjectSettings({ terminalTheme: false, spinnerVerbColor: "accent", spinnerStatusColor: "accent" });
	const notes: string[] = [];
	const cmdCtx = { hasUI: true, ui: { theme: themes.theme, notify: (m: string) => notes.push(m), getToolsExpanded: () => false, setToolsExpanded() {}, requestRender() {} } };
	await ccSpinner.handler("preview", cmdCtx);
	assert.match(notes.at(-1)!, /accent.*\(verb, status\)/);

	const ccTools = commands.get("cc-tools");
	const intentCompletions = ccTools.getArgumentCompletions("intent ");
	const modelDesc = intentCompletions.find((c: any) => c.value === "intent model")?.description ?? "";
	const offDesc = intentCompletions.find((c: any) => c.value === "intent off")?.description ?? "";
	assert.match(modelDesc, /\(default[;)]/);
	assert.doesNotMatch(offDesc, /\(default[;)]/);

	// Tool background restoration: default restores original toolSuccessBg while keeping userMessageBg transparent.
	await ccTools.handler("border", cmdCtx);
	assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).toolBackground, "outlines");
	assert.equal(themes.theme.getBgAnsi("toolSuccessBg"), "\x1b[49m");
	await ccTools.handler("default", cmdCtx);
	assert.equal(themes.theme.getBgAnsi("toolSuccessBg"), initialToolSuccessBg);
	assert.equal(themes.theme.getBgAnsi("userMessageBg"), "\x1b[49m");
});

test("assistant text preserves mid-line ###, narrow fenced boxes stay within width, and bash helpers handle edge cases", () => {
	// Mid-line ### preserved while leading ### heading marker is stripped.
	const msg = {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text: "### Heading\n\nKeep `###` and mid-line ### text.\n\n```typescript-very-long-language-name\nconst x = 1;\n```" }],
	};
	const comp = new AssistantMessageComponent(msg as any, false);
	for (const width of [16, 24, 80]) {
		const lines = comp.render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `width ${width} overflowed (${visibleWidth(line)}): ${JSON.stringify(plain(line))}`);
		}
	}
	const renderedText = comp.render(80).map(plain).join("\n");
	assert.match(renderedText, /Keep ### and mid-line ### text\./);
	assert.doesNotMatch(renderedText, /^ *● *###/m);

	// getLastBashOutputLine reverse scan edge cases
	assert.equal(getLastBashOutputLine("first\r\nsecond\r\n\r\n"), "second");
	assert.equal(getLastBashOutputLine("\x1b[32mline1\x1b[0m\r\x1b]0;title\x07  progress 50%  \r"), "progress 50%");
	assert.equal(getLastBashOutputLine("\r\n  \t \r\n"), undefined);

	// echo -e leaves content undefined so disk snapshot is used instead of literal backslash escapes
	assert.deepEqual(detectBashFileEdit('echo -e "a\\nb" > out.txt'), {
		kind: "write",
		via: "echo",
		paths: ["out.txt"],
		content: undefined,
	});
	assert.deepEqual(detectBashFileEdit('echo -ne "a\\nb" > out.txt'), {
		kind: "write",
		via: "echo",
		paths: ["out.txt"],
		content: undefined,
	});
});

test("hovering grouped tool rows and thinking blocks reuses layout/Markdown caches", () => {
	const chat = new Container();
	const firstRead = row("read", { path: "cached-1.ts" }, "line 1\nline 2", false, false);
	const secondRead = row("read", { path: "cached-2.ts" }, "line 1\nline 2", false, false);
	chat.addChild(firstRead);
	chat.addChild(secondRead);
	const [group] = chat.children as any[];
	const first = group.render(100);
	const cachedLines = group.cachedLines;
	assert.ok(Array.isArray(cachedLines), "ToolGroupComponent cachedLines populated");
	group.handleMouse({ type: "move", button: "none", x: 3, y: 1, width: 100, height: first.length });
	assert.equal(group.cachedLines, cachedLines, "hover move on ToolGroupComponent must not clear cachedLines");

	const mdSpy = mock.method(Markdown.prototype, "render");
	try {
		const thinkingMsg = {
			role: "assistant",
			stopReason: "pending",
			content: [{ type: "thinking", thinking: "Inspecting cache reuse across hover events." }],
		};
		const assistant = new AssistantMessageComponent(thinkingMsg as any, false) as any;
		const lines = assistant.render(100);
		const afterFirstRender = mdSpy.mock.callCount();
		assert.ok(afterFirstRender >= 1);
		const y = lines.findIndex((line: string) => /Thinking:/.test(plain(line)));
		assert.ok(y >= 0);
		assistant.handleMouse({ type: "move", button: "none", x: 5, y, width: 100, height: lines.length });
		assistant.render(100);
		assert.equal(mdSpy.mock.callCount(), afterFirstRender, "hovering ThinkingParagraph must not re-render Markdown");
	} finally {
		mdSpy.mock.restore();
	}
});

test("summarize() in buildBashCommandPresentation is Unicode-safe without O(n) Array.from scanning", () => {
	const emojiLine = "😀".repeat(200);
	const pres = buildBashCommandPresentation(emojiLine);
	assert.equal(Array.from(pres.headline).length, 180);
	assert.ok(!/[\uD800-\uDFFF]/.test(pres.headline.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")), "no unpaired surrogate");
	const exactEmoji = "😀".repeat(180);
	assert.equal(buildBashCommandPresentation(exactEmoji).headline, exactEmoji);
});

test("settings writes preserve 0600 permissions under umask 022 and keep symlinks intact", async () => {
	const prevUmask = process.umask(0o022);
	const ccTools = commands.get("cc-tools");
	const settingsFile = join(agentDir, "settings.json");
	const targetFile = join(agentDir, "real-settings.json");
	const backupContent = readFileSync(settingsFile, "utf8");
	const origMode = statSync(settingsFile).mode & 0o777;
	try {
		chmodSync(settingsFile, 0o600);
		await ccTools.handler("intent off", { hasUI: false });
		assert.equal(statSync(settingsFile).mode & 0o777, 0o600, "0600 file permissions preserved under umask 022");

		writeFileSync(targetFile, JSON.stringify({ themeAdaptive: true }), { mode: 0o600 });
		chmodSync(targetFile, 0o600);
		rmSync(settingsFile);
		symlinkSync(targetFile, settingsFile);

		await ccTools.handler("intent local", { hasUI: false });
		assert.equal(lstatSync(settingsFile).isSymbolicLink(), true, "settings.json remains a symlink");
		assert.equal(JSON.parse(readFileSync(targetFile, "utf8")).bashIntent, "local", "target file updated through symlink");
		assert.equal(statSync(targetFile).mode & 0o777, 0o600, "symlink target permissions remain 0600");
	} finally {
		if (lstatSync(settingsFile).isSymbolicLink()) rmSync(settingsFile);
		writeFileSync(settingsFile, backupContent);
		chmodSync(settingsFile, origMode);
		rmSync(targetFile, { force: true });
		process.umask(prevUmask);
	}
});

test("write, edit, and bash resolve relative paths consistently with ctx.cwd", async () => {
	const sessionCwd = mkdtempSync(join(tmpdir(), "ui-perf-session-cwd-"));
	const origFile = join(projectDir, "shared.txt");
	const sessFile = join(sessionCwd, "shared.txt");
	writeFileSync(origFile, "orig line 1\norig line 2\n");
	writeFileSync(sessFile, "sess line 1\nsess line 2\n");
	const sessionCtx = { cwd: sessionCwd };
	try {
		const writeTool = tools.get("write");
		const wRes = await writeTool.execute("w-cwd-1", { path: "shared.txt", content: "sess line 1\nsess updated\n" }, undefined, undefined, sessionCtx);
		assert.equal(readFileSync(origFile, "utf8"), "orig line 1\norig line 2\n", "registration cwd file untouched by write");
		assert.equal(readFileSync(sessFile, "utf8"), "sess line 1\nsess updated\n", "ctx.cwd file written");
		assert.equal(wRes.details?._type, "diff", "write diffed against ctx.cwd file rather than registration cwd");

		const editTool = tools.get("edit");
		const eRes = await editTool.execute("e-cwd-1", { path: "shared.txt", edits: [{ oldText: "sess updated", newText: "sess edited" }] }, undefined, undefined, sessionCtx);
		assert.equal(readFileSync(origFile, "utf8"), "orig line 1\norig line 2\n", "registration cwd file untouched by edit");
		assert.equal(readFileSync(sessFile, "utf8"), "sess line 1\nsess edited\n", "ctx.cwd file edited");
		assert.deepEqual(eRes.details?.preview, [{ oldLine: 2, newLine: 2 }]);

		const bashTool = tools.get("bash");
		const bRes = await bashTool.execute("b-cwd-1", { command: 'echo "sess from bash" > shared.txt' }, undefined, undefined, sessionCtx);
		assert.equal(readFileSync(origFile, "utf8"), "orig line 1\norig line 2\n", "registration cwd file untouched by bash");
		assert.equal(readFileSync(sessFile, "utf8"), "sess from bash\n", "bash executed in ctx.cwd");
		assert.equal(bRes.details?.fileEdits?.[0]?.created, false, "bash file edit snapshot used ctx.cwd existing file");
		assert.equal(bRes.details?.fileEdits?.[0]?.diff?.removed, 2);
	} finally {
		rmSync(origFile, { force: true });
		rmSync(sessionCwd, { recursive: true, force: true });
	}
});

test("write overwriting a >2MB existing file records overwrite instead of new", async () => {
	const bigPath = join(projectDir, "big-existing.txt");
	writeFileSync(bigPath, "a".repeat(2_000_001));
	try {
		const writeTool = tools.get("write");
		const comp = new ToolExecutionComponent("write", "write-big-1", { path: "big-existing.txt", content: "small replacement\nline 2" }, { showImages: false }, writeTool, ui, projectDir) as any;
		comp.setArgsComplete();
		const callText = plain(comp.render(100).join("\n"));
		assert.match(callText, /Write big-existing\.txt/, "header identifies existing file as Write, not Create");

		const result = await writeTool.execute("write-big-1", { path: "big-existing.txt", content: "small replacement\nline 2" }, undefined, undefined, { cwd: projectDir });
		assert.equal(result.details?._type, "overwrite");
		assert.equal(result.details?.previousBytes, 2_000_001);
		comp.updateResult(result, false);
		const rendered = plain(comp.render(100).join("\n"));
		assert.match(rendered, /Overwritten/);
		assert.doesNotMatch(rendered, /new file/);
		assert.doesNotMatch(rendered, /\+small replacement/);
	} finally {
		rmSync(bigPath, { force: true });
	}
});

test("effective-scope commands update project overrides and stay consistent on status/reset", async () => {
	const overrideProject = mkdtempSync(join(tmpdir(), "ui-perf-override-"));
	mkdirSync(join(overrideProject, ".pi"), { recursive: true });
	const projSettingsPath = join(overrideProject, ".pi", "settings.json");
	writeFileSync(projSettingsPath, JSON.stringify({
		groupToolCalls: true,
		spinnerVerbColor: "success",
		thinkingMode: "full",
		themeAdaptive: false,
	}));
	const notes: string[] = [];
	const cmdCtx = {
		cwd: overrideProject,
		hasUI: true,
		ui: {
			theme: themes.theme,
			notify: (m: string) => notes.push(m),
			getToolsExpanded: () => false,
			setToolsExpanded() {},
			requestRender() {},
			invalidate() {},
		},
	};
	const ccTools = commands.get("cc-tools");
	const ccSpinner = commands.get("cc-spinner");
	const ccTheme = commands.get("cc-theme");
	try {
		await ccTools.handler("group off", cmdCtx);
		assert.match(notes.at(-1)!, /Tool grouping: off.*\.pi\/settings\.json/);
		await ccTools.handler("group status", cmdCtx);
		assert.match(notes.at(-1)!, /Tool grouping: off/);
		await ccTools.handler("status", cmdCtx);
		assert.match(notes.at(-1)!, /Tool grouping: off/);

		await ccSpinner.handler("verb accent", cmdCtx);
		assert.match(notes.at(-1)!, /Spinner verb → accent.*\.pi\/settings\.json/);
		await ccSpinner.handler("preview", cmdCtx);
		assert.match(notes.at(-1)!, /Current: verb=accent/);

		await ccSpinner.handler("reset", cmdCtx);
		await ccSpinner.handler("preview", cmdCtx);
		assert.match(notes.at(-1)!, /Current: verb=borderAccent, status=muted/);

		await ccTools.handler("thinking live", cmdCtx);
		await ccTools.handler("thinking status", cmdCtx);
		assert.match(notes.at(-1)!, /Thinking: live/);

		await ccTheme.handler("on", cmdCtx);
		await ccTheme.handler("status", cmdCtx);
		assert.match(notes.at(-1)!, /Theme adaptive: on/);
	} finally {
		for (const handler of handlers.get("turn_start") ?? []) {
			await handler({}, { cwd: projectDir, hasUI: false, ui: {} });
		}
		rmSync(overrideProject, { recursive: true, force: true });
	}
});

test("edit replacing aa -> bc on aaa localizes non-overlapping occurrence instead of null preview", async () => {
	const editPath = join(projectDir, "overlap.txt");
	writeFileSync(editPath, "line 1\nline 2\naaa\nline 4\n");
	try {
		const editTool = tools.get("edit");
		const args = { path: "overlap.txt", edits: [{ oldText: "aa", newText: "bc" }] };
		const comp = new ToolExecutionComponent("edit", "edit-overlap-1", args, { showImages: false }, editTool, ui, projectDir) as any;
		comp.setArgsComplete();
		comp.markExecutionStarted();
		const result = await editTool.execute("edit-overlap-1", args, undefined, undefined, { cwd: projectDir });
		assert.deepEqual(result.details?.preview, [{ oldLine: 3, newLine: 3 }]);
		assert.equal(result.details?.editLine, 3);
		comp.updateResult(result, false);
		const settled = plain(comp.render(100).join("\n"));
		assert.match(settled, /at line 3/);
	} finally {
		rmSync(editPath, { force: true });
	}
});
