// Conservative shell syntax shared by inspection and explicitly approved host checks.
// Not a shell interpreter or sandbox. Unsupported expansion/substitution fails closed.
export function shellSegments(command: string): string[] | null {
	const segments: string[] = [];
	let current = "", quote: "'" | '"' | null = null, escaped = false;
	const flush = () => { if (current.trim()) segments.push(current.trim()); current = ""; };
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (escaped) { current += ch; escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { current += ch; escaped = true; continue; }
		if (quote) {
			if (quote === '"' && (ch === "`" || (ch === "$" && command[i + 1] === "("))) return null;
			current += ch; if (ch === quote) quote = null; continue;
		}
		if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
		if (ch === "`" || ((ch === "$" || ch === "<" || ch === ">") && command[i + 1] === "(")) return null;
		if (ch === "&" && (current.endsWith(">") || command[i + 1] === ">")) { current += ch; continue; }
		if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") { flush(); if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++; continue; }
		current += ch;
	}
	if (quote || escaped) return null;
	flush(); return segments;
}
/** Decode literal arguments for policy checks; never execute their contents. */
export function shellWords(command: string): string[] | null {
	const words: string[] = []; let word = "", started = false, quote: string | null = null, escaped = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (escaped) { word += ch; started = true; escaped = false; continue; }
		if (ch === "\\" && quote !== "'") { escaped = true; started = true; continue; }
		if (quote !== "'" && (ch === "`" || (ch === "$" && /[A-Za-z_0-9{(@*?!#-]/.test(command[i + 1] ?? "")))) return null;
		if (quote) { if (ch === quote) quote = null; else word += ch; started = true; continue; }
		if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
		if (/\s/.test(ch)) { if (started) { words.push(word); word = ""; started = false; } continue; }
		word += ch; started = true;
	}
	if (quote || escaped) return null;
	if (started) words.push(word);
	return words;
}

export function inspectionSpecialCase(command: string): boolean | null {
	const words = shellWords(command);
	if (!words?.length) return null;
	const [exe, ...args] = words;
	if (["grep", "egrep", "fgrep", "zgrep"].includes(exe!)) return true; // patterns are data, not commands
	if (exe === "rg") {
		const values = new Set(["--regexp", "--glob", "--iglob", "--type", "--type-not", "--context", "--after-context", "--before-context", "--max-count", "--max-depth", "--color", "--encoding", "--file", "-e", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-f"]);
		const flags = new Set(["--no-config", "--line-number", "--hidden", "--no-ignore", "--no-ignore-vcs", "--files", "--files-with-matches", "--files-without-match", "--fixed-strings", "--ignore-case", "--case-sensitive", "--smart-case", "--word-regexp", "--count", "--count-matches", "--heading", "--no-heading", "--multiline", "--multiline-dotall", "--pcre2", "--json", "--no-messages", "--stats", "--text", "--binary", "--follow", "--null", "--null-data", "--only-matching", "--invert-match", "--quiet", "--version"]);
		for (let i = 0; i < args.length; i++) {
			const arg = args[i]!; if (arg === "--") break;
			if (values.has(arg)) { if (++i >= args.length) return false; continue; }
			if (arg.startsWith("--")) { const key = arg.split("=")[0]!; if (!flags.has(arg) && !(arg.includes("=") && values.has(key))) return false; }
			else if (arg.startsWith("-") && arg !== "-" && !/^-[nrilLIvHhSswFcCABCgtemuUoP0zaq]+$/.test(arg) && !/^-[egtfTABCm].+/.test(arg)) return false;
		}
		return true;
	}
	if (exe === "sed") {
		let i = 0; if (!["-n", "--quiet", "--silent"].includes(args[i] ?? "")) return false;
		i++; if (args[i] === "-e") i++;
		if (!/^(?:\d+|\$)(?:,(?:\d+|\$))?p$/.test(args[i++] ?? "")) return false;
		if (args[i] === "--") i++;
		return args.slice(i).every(arg => !arg.startsWith("-"));
	}
	if (exe === "git" && args[0] === "--version") return args.length === 1;
	if (exe === "git" && args[0] === "worktree") return args[1] === "list" && args.slice(2).every(arg => ["--porcelain", "-z", "-v", "--verbose"].includes(arg));
	if (exe === "git" && args[0] === "ls-files") return args.every(arg => !/^--(?:output|exec|ext-diff|textconv)(?:=|$)/.test(arg));
	return null;
}
