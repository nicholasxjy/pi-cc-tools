import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Lexer, type Token, type Tokens } from "marked";

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

function markdownText(tokens: Token[]): string {
	return tokens.map((token) => {
		if (token.type === "html") return "";
		if (token.type === "br" || token.type === "space" || token.type === "hr") return "\n";
		if (token.type === "list") return markdownText(token.items);
		if (token.type === "table") {
			const rows: Tokens.TableCell[][] = [token.header, ...token.rows];
			return `${rows.map((row) => row.map((cell) => markdownText(cell.tokens)).join(" ")).join("\n")}\n`;
		}
		const text = "tokens" in token && token.tokens ? markdownText(token.tokens) : "text" in token ? token.text : "";
		return ["paragraph", "heading", "blockquote", "list_item", "code"].includes(token.type) ? `${text}\n` : text;
	}).join("");
}

export function installTerminalTitle(
	pi: ExtensionAPI,
	describeActivity: (name: string, args: any) => string,
	isEnabled: () => boolean,
): void {
	let title = "";
	let completionTitle = "";
	let pendingWrite: ReturnType<typeof setImmediate> | undefined;
	const namedExecutions = new Set<string>();

	function write(ctx: ExtensionContext): void {
		try {
			if (title && ctx.mode === "tui" && ctx.hasUI && isEnabled()) ctx.ui.setTitle(title);
		} catch { /* A closed terminal must not fail execution. */ }
	}

	function update(next: string, ctx: ExtensionContext): void {
		if (!next || next === title) return;
		title = next;
		write(ctx);
		try {
			pi.appendEntry(TITLE_ENTRY_TYPE, { title });
		} catch { /* Keep the live title when the session cannot save it. */ }
	}

	function reassert(_event: unknown, ctx: ExtensionContext): void {
		if (pendingWrite) clearImmediate(pendingWrite);
		// Pi applies its own title after these handlers; keep the latest title afterward.
		pendingWrite = setImmediate(() => {
			pendingWrite = undefined;
			write(ctx);
		});
		pendingWrite.unref();
	}

	function resume(event: unknown, ctx: ExtensionContext): void {
		title = "";
		completionTitle = "";
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
		update(declared || titleText(describeActivity(event.toolName, event.args)), ctx);
	});
	pi.on("tool_execution_end", (event) => {
		namedExecutions.delete(event.toolCallId);
	});
	pi.on("agent_start", () => {
		completionTitle = "";
	});
	pi.on("agent_end", (event) => {
		completionTitle = "";
		for (let i = (event.messages?.length ?? 0) - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role !== "assistant") continue;
			if (message.stopReason === "stop") {
				const text = message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				const summary = markdownText(Lexer.lex(text))
					.split(/\r?\n/)
					.find((line) => line.trim());
				completionTitle = titleText(`✓ ${summary?.trim() || "Completed"}`);
			}
			break;
		}
	});
	pi.on("session_start", resume);
	pi.on("session_tree", resume);
	// These events are newer than the type package used by local typecheck.
	const lifecycle = pi as ExtensionAPI & {
		on(event: "session_info_changed" | "agent_settled", handler: (event: { aborted?: boolean }, ctx: ExtensionContext) => void): void;
	};
	lifecycle.on("session_info_changed", reassert);
	lifecycle.on("agent_settled", (event, ctx) => {
		if (!event.aborted && completionTitle && ctx.mode === "tui" && ctx.hasUI && isEnabled()) {
			update(completionTitle, ctx);
		}
		completionTitle = "";
		reassert(event, ctx);
	});
	pi.on("session_shutdown", () => {
		if (pendingWrite) clearImmediate(pendingWrite);
		pendingWrite = undefined;
		title = "";
		completionTitle = "";
		namedExecutions.clear();
	});
}
