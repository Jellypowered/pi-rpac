#!/usr/bin/env node
// Mock GitHub CLI for RPAC PR review tests.
//
// Driven by environment:
//   MOCK_GH_LOG          file to append every invocation (for "no mutation" assertions)
//   MOCK_GH_UNAUTHED     when set, `gh auth status` fails (exit 1)
//   MOCK_GH_VIEW         JSON body returned by `gh pr view <n> --json ...`
//   MOCK_GH_HEADSHA      head SHA to detach-checkout during `gh pr checkout`
//   MOCK_GH_CHECKOUT_REF ref on origin to fetch during `gh pr checkout`
//
// Supported subcommands: --version, auth status, pr view, pr checkout.
// Any other subcommand is an error (so tests can assert no mutations happened).
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const log = process.env.MOCK_GH_LOG;
if (log) {
	try { fs.appendFileSync(log, args.join(" ") + "\n"); } catch { /* ignore */ }
}

function run(cmd, cmdArgs, cwd) {
	return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const a0 = args[0];
if (a0 === "--version") {
	console.log("gh version 9.9.9-mock");
	process.exit(0);
}
if (a0 === "auth" && args[1] === "status") {
	if (process.env.MOCK_GH_UNAUTHED) {
		process.stderr.write("You are not logged into any GitHub hosts. Run `gh auth login`.\n");
		process.exit(1);
	}
	console.log("Logged in to github.com as mock (mock)");
	process.exit(0);
}
if (a0 === "pr" && args[1] === "view") {
	const view = process.env.MOCK_GH_VIEW;
	if (!view) {
		process.stderr.write("mock gh: no PR metadata (MOCK_GH_VIEW unset)\n");
		process.exit(1);
	}
	console.log(view);
	process.exit(0);
}
if (a0 === "pr" && args[1] === "checkout") {
	const n = args[2];
	const cwd = process.cwd();
	const headRef = process.env.MOCK_GH_CHECKOUT_REF || `refs/pull/${n}/head`;
	// Simulate `gh pr checkout <n>`: fetch the PR head ref, then detached-checkout the head.
	run("git", ["fetch", "origin", headRef], cwd);
	const headSha = process.env.MOCK_GH_HEADSHA;
	if (headSha) {
		run("git", ["checkout", "--detach", headSha], cwd);
	} else {
		run("git", ["checkout", "--detach", "FETCH_HEAD"], cwd);
	}
	console.log("Switched to a new detached HEAD at the PR head (mock gh pr checkout)");
	process.exit(0);
}
process.stderr.write(`mock gh: unhandled (and therefore unauthorized) command: ${args.join(" ")}\n`);
process.exit(1);
