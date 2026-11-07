/** Conservative single-command inspection policy; not an OS sandbox. */
export function isSafeCommand(command: string): boolean {
	const source = command.trim().replace(/\s+2>\/dev\/null$/, "");
	if (!source || /[\n\r;|&<>$`\\(){}]/.test(source)) return false;
	const tokens = source.match(/"[^"\n]*"|'[^'\n]*'|[^\s'"\n]+/g) ?? [];
	if (tokens.join(" ") !== source.replace(/\s+/g, " ")) return false;
	const [name, ...args] = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
	if (["node", "npm", "python", "python3", "java"].includes(name)) {
		return args.length === 1 && ["-v", "--version", "-version"].includes(args[0]);
	}
	if (name === "pwd") return args.length === 0;
	const options: Record<string, RegExp> = {
		ls: /^-(?:[alhdAF1]+|-(?:all|almost-all|directory|human-readable))$/,
		cat: /^-[nbsETv]+$/,
		head: /^-(?:n|c|\d+)$/,
		tail: /^-(?:n|c|\d+)$/,
		wc: /^-[clwmL]+$/,
		which: /^-a$/,
		rg: /^-(?:[nilsSFiwcv]+|-(?:files|hidden|glob|count|line-number|ignore-case|fixed-strings))$/,
	};
	if (name === "git") {
		const [subcommand, ...rest] = args;
		if (!["status", "diff", "log", "show"].includes(subcommand)) return false;
		return (
			rest.every((arg) =>
				arg.startsWith("-")
					? /^(?:--short|--stat|--name-only|--oneline|--no-ext-diff|--no-textconv|--|-\d+)$/.test(arg)
					: /^[\w./~:@+-]+$/.test(arg),
			) &&
			(subcommand === "status" || (rest.includes("--no-ext-diff") && rest.includes("--no-textconv")))
		);
	}
	const allowed = options[name];
	return !!allowed && args.every((arg) => (arg.startsWith("-") ? allowed.test(arg) : !arg.startsWith("~")));
}
