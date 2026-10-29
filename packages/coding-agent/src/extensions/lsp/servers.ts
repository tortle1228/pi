/** Which language server checks which file: the built-in servers, merged with the `lsp.servers` setting. */

import { extname } from "node:path";
import type { LspServerSettings } from "../../core/settings-schema.ts";

export interface LspServerConfig {
	/** Settings key and the name shown to the model, such as `typescript`. */
	name: string;
	/** Command and arguments that start the server on stdio. */
	command: string[];
	/** Lowercase file extensions with the dot. */
	extensions: string[];
	initializationOptions?: unknown;
}

const BUILT_IN_SERVERS: readonly LspServerConfig[] = [
	{
		name: "typescript",
		command: ["typescript-language-server", "--stdio"],
		extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
	},
	{ name: "pyright", command: ["pyright-langserver", "--stdio"], extensions: [".py", ".pyi"] },
	{ name: "rust-analyzer", command: ["rust-analyzer"], extensions: [".rs"] },
	{ name: "gopls", command: ["gopls"], extensions: [".go"] },
];

/** The servers to use: built-ins changed or removed by `settings`, then servers the settings add. */
export function resolveServers(settings: Record<string, LspServerSettings> | undefined): LspServerConfig[] {
	const servers: LspServerConfig[] = [];
	const names = new Set([...BUILT_IN_SERVERS.map((server) => server.name), ...Object.keys(settings ?? {})]);
	for (const name of names) {
		const builtIn = BUILT_IN_SERVERS.find((server) => server.name === name);
		const override = settings?.[name];
		if (override?.disabled) continue;
		const command = override?.command ?? builtIn?.command;
		const extensions = override?.extensions ?? builtIn?.extensions;
		// A new server needs both; settings validation cannot express that across built-in names.
		if (!command?.length || !extensions?.length) continue;
		servers.push({
			name,
			command,
			extensions: extensions.map((extension) => extension.toLowerCase()),
			initializationOptions: override?.initializationOptions ?? builtIn?.initializationOptions,
		});
	}
	return servers;
}

/** The first server that checks `filePath`, by extension. */
export function findServer(servers: readonly LspServerConfig[], filePath: string): LspServerConfig | undefined {
	const extension = extname(filePath).toLowerCase();
	return servers.find((server) => server.extensions.includes(extension));
}

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".go": "go",
};

/** The LSP language identifier of `filePath`; the extension without its dot for unknown ones. */
export function languageId(filePath: string): string {
	const extension = extname(filePath).toLowerCase();
	return LANGUAGE_IDS[extension] ?? extension.slice(1);
}
