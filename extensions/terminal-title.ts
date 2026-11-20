import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Lexer, type Token, type Tokens } from "marked";

const TITLE_ENTRY_TYPE = "pi-claude-code-ui-terminal-title";
const COMPLETION_GUIDELINE = "After your final reply, leave a blank line and append an HTML comment on its own line: <!-- pi-terminal-title: Short task summary -->. Summarize the task's action and subject in the user's language in at most 50 characters of plain text. Omit status labels, Markdown and trailing punctuation.";
const COMPLETION_LABEL_LIMIT = 62;

function titleText(value: unknown, limit = 120): string {
	if (typeof value !== "string") return "";
	const text = stripVTControlCharacters(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(text);
	return chars.length > limit ? `${chars.slice(0, limit - 1).join("").trimEnd()}…` : text;
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

function firstLine(tokens: Token[]): string | undefined {
	return markdownText(tokens).split(/\r?\n/).find((line) => line.trim());
}

function notifyCompletion(title: string, ctx: ExtensionContext): void {
	try {
		if (process.stdout.isTTY && process.env.KITTY_WINDOW_ID) {
			process.stdout.write(`\x1b]99;;${title}\x1b\\`);
		} else if (process.stdout.isTTY && /^(ghostty|iTerm\.app|WezTerm)$/i.test(process.env.TERM_PROGRAM ?? "")) {
			process.stdout.write(`\x1b]777;notify;Pi;${title.replaceAll(";", ",")}\x07`);
		} else {
			ctx.ui.notify(title, "info");
		}
	} catch { /* A closed terminal must not fail execution. */ }
}

export function installTerminalTitle(
	pi: ExtensionAPI,
	describeActivity: (name: string, args: any) => string,
	isEnabled: () => boolean,
): void {
	let title = "";
	let completionTitle = "";
	let taskSummary = "";
	let pendingWrite: ReturnType<typeof setImmediate> | undefined;
	const namedExecutions = new Set<string>();

	function active(ctx: ExtensionContext): boolean {
		return ctx.mode === "tui" && ctx.hasUI && isEnabled();
	}

	function write(ctx: ExtensionContext): void {
		try {
			if (title && active(ctx)) ctx.ui.setTitle(title);
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
		taskSummary = "";
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
		if (!active(ctx)) return;
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
	pi.on("before_agent_start", (event, ctx) => {
		taskSummary = "";
		if (active(ctx)) event.systemPromptOptions?.promptGuidelines?.push(COMPLETION_GUIDELINE);
	});
	pi.on("agent_start", () => {
		completionTitle = "";
	});
	pi.on("agent_end", (event, ctx) => {
		completionTitle = "";
		if (!active(ctx)) return;

		const messages = (event.messages ?? []).slice().reverse();
		const user = messages.find((message) => message.role === "user");
		if (user) {
			const text = typeof user.content === "string" ? user.content : user.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			taskSummary = titleText(firstLine(Lexer.lex(text)), COMPLETION_LABEL_LIMIT);
		}

		const assistant = messages.find((message) => message.role === "assistant");
		if (assistant?.stopReason !== "stop") return;
		const text = assistant.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const tokens = Lexer.lex(text.trimEnd());
		const last = tokens.at(-1);
		const summary = last?.type === "html" ? /^<!-- pi-terminal-title: ([^\r\n]+?) -->$/.exec(last.raw)?.[1] : undefined;
		const label = titleText(summary, COMPLETION_LABEL_LIMIT) || taskSummary || titleText(firstLine(tokens), COMPLETION_LABEL_LIMIT);
		completionTitle = `✓ ${label || "Completed"}`;
	});
	pi.on("session_start", resume);
	pi.on("session_tree", resume);
	// These events are newer than the type package used by local typecheck.
	const lifecycle = pi as ExtensionAPI & {
		on(event: "session_info_changed" | "agent_settled", handler: (event: { aborted?: boolean }, ctx: ExtensionContext) => void): void;
	};
	lifecycle.on("session_info_changed", reassert);
	lifecycle.on("agent_settled", (event, ctx) => {
		if (!event.aborted && completionTitle && active(ctx)) {
			update(completionTitle, ctx);
			notifyCompletion(completionTitle, ctx);
		}
		completionTitle = "";
		taskSummary = "";
		reassert(event, ctx);
	});
	pi.on("session_shutdown", () => {
		if (pendingWrite) clearImmediate(pendingWrite);
		pendingWrite = undefined;
		title = "";
		completionTitle = "";
		taskSummary = "";
		namedExecutions.clear();
	});
}
