// Shim of @earendil-works/pi-coding-agent for tool-ctx-forward.test.mts. Everything is
// the real package except the seven built-in tool factories, whose `execute` records
// the 5th `ctx` argument it was called with (globalThis.__piToolCtxReceived).
import * as real from "@earendil-works/pi-coding-agent";

export * from "@earendil-works/pi-coding-agent";

const received = (globalThis.__piToolCtxReceived ??= new Map());
export const outputSchemas = new Map();
const fallbackOutputSchemas = new Map([
	["read", { type: "object" }],
	["bash", { type: "object" }],
]);

function recording(name, factory) {
	return (...factoryArgs) => {
		const definition = factory(...factoryArgs);
		if (name === "read" || name === "bash") {
			// The test dependency predates structured tool outputs; reuse one schema per tool across cwds.
			definition.outputSchema ??= fallbackOutputSchemas.get(name);
			if (!outputSchemas.has(name)) outputSchemas.set(name, definition.outputSchema);
		}
		return {
			...definition,
			async execute(...args) {
				received.set(name, { argc: args.length, ctx: args[4] });
				return { content: [{ type: "text", text: "" }], details: {} };
			},
		};
	};
}

export const createReadToolDefinition = recording("read", real.createReadToolDefinition);
export const createBashToolDefinition = recording("bash", real.createBashToolDefinition);
export const createGrepTool = recording("grep", real.createGrepTool);
export const createFindTool = recording("find", real.createFindTool);
export const createLsTool = recording("ls", real.createLsTool);
export const createWriteTool = recording("write", real.createWriteTool);
export const createEditToolDefinition = recording("edit", real.createEditToolDefinition);
