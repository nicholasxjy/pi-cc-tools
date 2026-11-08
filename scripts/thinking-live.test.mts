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
