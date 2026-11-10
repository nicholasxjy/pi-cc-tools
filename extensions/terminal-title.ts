import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const TITLE_ENTRY_TYPE = "pi-claude-code-ui-terminal-title";

function titleText(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = stripVTControlCharacters(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(text);
	return chars.length > 120 ? `${chars.slice(0, 119).join("").trimEnd()}…` : text;
}

export function installTerminalTitle(
	pi: ExtensionAPI,
	describeActivity: (name: string, args: any) => string,
	isEnabled: () => boolean,
): void {
	let title = "";
	let pendingWrite: ReturnType<typeof setImmediate> | undefined;
	const namedExecutions = new Set<string>();

	function write(ctx: ExtensionContext): void {
		try {
			if (title && ctx.mode === "tui" && ctx.hasUI && isEnabled()) ctx.ui.setTitle(title);
		} catch { /* A closed terminal must not fail execution. */ }
	}

	function reassert(_event: unknown, ctx: ExtensionContext): void {
		if (pendingWrite) clearImmediate(pendingWrite);
		// Pi applies its own title after these handlers; keep the latest step afterward.
		pendingWrite = setImmediate(() => {
			pendingWrite = undefined;
			write(ctx);
		});
		pendingWrite.unref();
	}

	function resume(event: unknown, ctx: ExtensionContext): void {
		title = "";
		namedExecutions.clear();
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type !== "custom" || entry.customType !== TITLE_ENTRY_TYPE) continue;
				title = titleText((entry.data as { title?: unknown } | undefined)?.title);
				if (title) break;
			}
		} catch { /* A session without saved state keeps Pi's title. */ }
		reassert(event, ctx);
	}

	pi.on("tool_execution_start", (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || !isEnabled()) return;
		const parent = (event as typeof event & { parentToolCallId?: string }).parentToolCallId;
		if (parent && namedExecutions.has(parent)) {
			namedExecutions.add(event.toolCallId);
			return;
		}
		const declared = titleText(event.args?.display?.name) || titleText(event.args?.displaySummary);
		if (declared) namedExecutions.add(event.toolCallId);
		const next = declared || titleText(describeActivity(event.toolName, event.args));
		if (!next || next === title) return;
		title = next;
		write(ctx);
		try {
			pi.appendEntry(TITLE_ENTRY_TYPE, { title });
		} catch { /* Keep the live title when the session cannot save it. */ }
	});
	pi.on("tool_execution_end", (event) => {
		namedExecutions.delete(event.toolCallId);
	});
	pi.on("session_start", resume);
	pi.on("session_tree", resume);
	// These events are newer than the type package used by local typecheck.
	const lifecycle = pi as ExtensionAPI & {
		on(event: "session_info_changed" | "agent_settled", handler: typeof reassert): void;
	};
	lifecycle.on("session_info_changed", reassert);
	lifecycle.on("agent_settled", reassert);
	pi.on("session_shutdown", () => {
		if (pendingWrite) clearImmediate(pendingWrite);
		pendingWrite = undefined;
		title = "";
		namedExecutions.clear();
	});
}
