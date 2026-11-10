import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = process.env.PI_AGENT_ROOT ?? resolve(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "../..");
const agentDir = mkdtempSync(join(tmpdir(), "thinking-live-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ terminalTheme: false }));

test.after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(agentDir, { recursive: true, force: true });
});

const { initTheme } = await import(`${root}/dist/modes/interactive/theme/theme.js`);
initTheme("dark", false);
const { AssistantMessageComponent } = await import(`${root}/dist/modes/interactive/components/assistant-message.js`);
const { loadExtensions } = await import(`${root}/dist/core/extensions/loader.js`);
const { extensions, errors, runtime } = await loadExtensions([
	fileURLToPath(new URL("../extensions/index.ts", import.meta.url)),
], process.cwd());
assert.deepEqual(errors, []);
runtime.getThinkingLevel = () => "high";
const ctx = { ui: { invalidate() {}, requestRender() {} } };
const emit = async (name: string, event: any) => {
	for (const handler of extensions[0].handlers.get(name) ?? []) await handler(event, ctx);
};
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "");

test("default live thinking collapses only when thinking ends", async (t) => {
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const message: any = { role: "assistant", content: [], stopReason: "pending" };
	const component = new AssistantMessageComponent();
	const render = () => component.render(100).map(plain).join("\n");
	await emit("message_start", { message });
	message.content.push({ type: "thinking", thinking: "Inspect the renderer before answering." });
	await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start" } });
	component.updateContent(message, true);
	assert.match(render(), /Inspect the renderer/);

	await emit("message_update", { message, assistantMessageEvent: { type: "thinking_end" } });
	component.updateContent(message, true);
	assert.match(render(), /Thought for 1s/, "thinking_end must collapse even within the same millisecond");
	assert.doesNotMatch(render(), /Inspect the renderer/);
	message.content.push({ type: "text", text: "The answer." });
	await emit("message_update", { message, assistantMessageEvent: { type: "text_start" } });
	component.updateContent(message, true);
	const done = render();
	assert.match(done, /Thought for 1s/, done);
	assert.doesNotMatch(done, /Inspect the renderer/, done);
	assert.match(done, /The answer\./, done);

	message.stopReason = "stop";
	await emit("message_end", { message });
	component.updateContent(message, false);
	assert.match(render(), /Thought for 1s/);
	assert.doesNotMatch(render(), /Inspect the renderer/);
});

const setMode = (mode: string) => extensions[0].commands.get("cc-tools").handler(`thinking ${mode}`, { hasUI: false, ui: {} });
const finishedMessage = () => ({
	role: "assistant", content: [{ type: "thinking", thinking: "Completed reasoning." }], stopReason: "stop",
});
const visible = (component: any) => component.render(100).map(plain).join("\n");

test("thinking modes control restored messages with either Pi visibility setting", async () => {
	for (const mode of ["live", "latest", "full"]) {
		await setMode(mode);
		for (const hide of [false, true]) {
			const component = new AssistantMessageComponent(finishedMessage(), hide);
			const text = visible(component);
			if (mode === "full") {
				assert.match(text, /Completed reasoning\./, text);
				assert.doesNotMatch(text, /Thought for/, text);
			} else {
				assert.match(text, /Thought for 1s/, text);
				assert.doesNotMatch(text, /Completed reasoning\./, text);
			}
			assert.equal(component.hideThinkingBlock, hide, "rendering preserves Pi's visibility state");
		}
	}
});

test("explicit visibility toggles work until a thinking mode is selected", async () => {
	await setMode("live");
	const component = new AssistantMessageComponent(finishedMessage());
	assert.match(visible(component), /Thought for 1s/);
	component.setHideThinkingBlock(false);
	assert.match(visible(component), /Completed reasoning\./);
	assert.match(visible(new AssistantMessageComponent(finishedMessage())), /Completed reasoning\./);
	component.setHideThinkingBlock(true);
	assert.match(visible(component), /Thought for 1s/);
	component.setHideThinkingBlock(false);
	await setMode("live");
	component.updateContent(component.lastMessage);
	assert.match(visible(component), /Thought for 1s/);
	component.setHideThinkingBlock(false);
	await emit("session_start", {});
	assert.match(visible(new AssistantMessageComponent(finishedMessage())), /Thought for 1s/);
});

test("clicking thinking toggles its visibility while streaming and after completion", async () => {
	await setMode("live");
	for (const stopReason of ["pending", "stop"]) {
		const message = { ...finishedMessage(), stopReason };
		const component = new AssistantMessageComponent(message);
		const click = () => {
			const lines: string[] = component.render(100);
			const y = lines.findIndex((line) => /Thinking|Thought for/.test(plain(line)));
			assert.ok(y >= 0, lines.join("\n"));
			assert.ok(component.handleMouse({ type: "click", button: "left", x: 5, y, width: 100, height: lines.length, clickCount: 1 })?.handled);
		};
		const original = visible(component);
		click();
		assert.notEqual(visible(component), original);
		component.updateContent(message);
		assert.notEqual(visible(component), original, "stream updates preserve the click override");
		click();
		assert.equal(visible(component), original);
	}
});

test("live thinking stays visible when the component receives a fresh streaming snapshot", async () => {
	await setMode("live");
	const component = new AssistantMessageComponent();
	for (const thinking of ["First reasoning fragment.", "First reasoning fragment. Still thinking."]) {
		// The UI's streaming flag is authoritative even without shared event metadata.
		const snapshot = { role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop" };
		component.updateContent(snapshot, true);
		const live = visible(component);
		assert.ok(live.includes(thinking), live);
		assert.doesNotMatch(live, /Thought for/, live);
		component.invalidate();
		assert.doesNotMatch(visible(component), /Thought for/, "a redraw must keep streaming thinking visible");
	}
	component.updateContent(component.lastMessage, false);
	assert.match(visible(component), /Thought for 1s/);
	assert.doesNotMatch(visible(component), /First reasoning fragment/);
});


test("live thinking animates only its gutter and reuses the Markdown cache in every mode", async (t) => {
	const { Markdown, visibleWidth } = await import("@earendil-works/pi-tui");
	let now = 1_700_000;
	t.mock.method(Date, "now", () => now);
	const markdown = t.mock.method(Markdown.prototype, "render");
	const timers = t.mock.method(globalThis, "setTimeout");
	for (const mode of ["live", "latest", "full"]) {
		await setMode(mode);
		const message = { role: "assistant", stopReason: "pending", content: [{ type: "thinking", thinking: "Reasoning line.\n\n".repeat(200) }] };
		const original = structuredClone(message);
		const component = new AssistantMessageComponent();
		component.updateContent(message, true);
		const first = component.render(100);
		const snapshot = [...first];
		const renders = markdown.mock.callCount();
		const scheduled = timers.mock.callCount();
		const frames = new Set<string>();
		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			now += 170;
			const lines = component.render(100);
			assert.equal(component.render(100), lines, "redraws within one frame reuse the same array");
			const row = lines.findIndex((line: string) => plain(line).includes("Thinking:"));
			const glyph = plain(lines[row]).trimStart()[0];
			frames.add(glyph);
			assert.match(glyph, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
			assert.ok(lines[row].includes(`\x1b]8686;s\x07 `), "the spinner stays inside the copy-excluded gutter");
			assert.equal(visibleWidth(lines[row]), 100);
			assert.deepEqual(lines.slice(row + 1), first.slice(row + 1), "the body stays unchanged between frames");
		}
		t.diagnostic(`${mode}: 200-paragraph thinking, ${((performance.now() - start) / 1000).toFixed(3)} ms/frame including assertions`);
		assert.equal(frames.size, 10);
		assert.equal(markdown.mock.callCount(), renders, "animation must not re-render Markdown");
		assert.equal(timers.mock.callCount(), scheduled, "animation must not schedule display timers");
		assert.deepEqual(first, snapshot, "later frames must not mutate earlier render arrays");
		assert.deepEqual(message, original, "animation must not enter canonical message content");
	}
});

test("manually collapsed live thinking keeps its spinner and respects narrow widths", async (t) => {
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	await setMode("live");
	let now = 1_700_000;
	t.mock.method(Date, "now", () => now);
	const component = new AssistantMessageComponent({ role: "assistant", stopReason: "pending", content: [{ type: "thinking", thinking: "Live reasoning." }] });
	const lines = component.render(100);
	const y = lines.findIndex((line: string) => plain(line).includes("Thinking:"));
	assert.ok(component.handleMouse({ type: "click", button: "left", x: 5, y, width: 100, height: lines.length, clickCount: 1 })?.handled);
	const first = visible(component);
	assert.match(first, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking…/);
	assert.doesNotMatch(first, /Live reasoning/);
	now += 170;
	assert.notEqual(visible(component), first);
	for (const width of [0, 1, 2, 3, 4, 10, 100]) {
		for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
	}
});

test("thinking completion and abort stop the spinner, including before the UI rebuilds", async (t) => {
	await setMode("live");
	let now = 1_700_000;
	t.mock.method(Date, "now", () => now);
	for (const end of ["thinking_end", "message_end", "aborted"]) {
		const message: any = { role: "assistant", stopReason: "pending", content: [{ type: "thinking", thinking: "Reasoning to finish." }] };
		await emit("message_start", { message });
		await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start" } });
		const component = new AssistantMessageComponent();
		component.updateContent(message, true);
		assert.match(visible(component), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking:/);
		now += 1700;
		if (end === "thinking_end") {
			await emit("message_update", { message, assistantMessageEvent: { type: end } });
			assert.doesNotMatch(visible(component), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		} else {
			message.stopReason = end === "aborted" ? "aborted" : "stop";
			await emit("message_end", { message });
		}
		component.updateContent(message, end === "thinking_end");
		const done = component.render(100);
		assert.match(done.map(plain).join("\n"), /Thought for/);
		assert.doesNotMatch(done.map(plain).join("\n"), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		now += 170;
		assert.equal(component.render(100), done, "finished thinking returns the cached static output");
	}
});
