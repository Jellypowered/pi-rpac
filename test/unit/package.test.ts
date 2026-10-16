import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = join(ROOT, "skills", "rpac-review", "SKILL.md");
const LICENSE = join(ROOT, "skills", "rpac-review", "LICENSE");
const UPSTREAM_LICENSE = `MIT License

Copyright (c) 2026 Engineering in the age of AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function frontMatter(text: string): Map<string, string> {
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	assert.ok(match, "skill has YAML front matter");
	const fields = new Map<string, string>();
	for (const line of match[1]!.split("\n")) {
		const entry = line.match(/^([a-zA-Z0-9-]+):\s*(.+)$/);
		if (entry) fields.set(entry[1]!, entry[2]!.replace(/^"|"$/g, ""));
	}
	return fields;
}

test("bundled rpac-review skill has valid discovery metadata and portable instructions", () => {
	const skill = readFileSync(SKILL, "utf8");
	const fields = frontMatter(skill);
	assert.equal(fields.get("name"), "rpac-review");
	assert.equal(fields.get("license"), "MIT");
	assert.match(fields.get("description") ?? "", /report-only RPAC review/);
	for (const section of ["REFINE", "PLAN", "ACT", "Adversarial validation", "CONSOLIDATE", "Completion checklist"]) {
		assert.match(skill, new RegExp(section, "i"), `contains ${section} guidance`);
	}
	for (const action of ["review_scope", "refine_complete", "plan_complete", "task_done", "task_start", "consolidate_complete", "back_to_plan"]) {
		assert.match(skill, new RegExp(`\\b${action}\\b`), `documents ${action}`);
	}
	assert.match(skill, /reviewChecks/);
	assert.match(skill, /same-context review; weaker independence/);
	assert.match(skill, /no sampling or extrapolation/i);
	assert.match(skill, /separate ordinary RPAC workflow/i);
	assert.doesNotMatch(skill, /AzerothCore|WoWMin|playerbots|telemetry|module repository|C\+\+/i);
});

test("rpac-review preserves the exact upstream MIT license and both attributions", () => {
	const skill = readFileSync(SKILL, "utf8");
	assert.equal(readFileSync(LICENSE, "utf8"), UPSTREAM_LICENSE);
	assert.match(skill, /github\.com\/eai-org\/agent-toolkit\/blob\/main\/skills\/self-review\/SKILL\.md/);
	assert.match(skill, /github\.com\/eai-org\/agent-toolkit\/blob\/main\/skills\/fresh-eyes-review\/SKILL\.md/);
	assert.match(readFileSync(LICENSE, "utf8"), /Copyright \(c\) 2026 Engineering in the age of AI/);
});

test("review directives and tool schema use the skill's named actions and payloads", () => {
	const prompts = readFileSync(join(ROOT, "lib", "prompts.ts"), "utf8");
	const extension = readFileSync(join(ROOT, "extensions", "rpac.ts"), "utf8");
	assert.match(prompts, /rpac-review/);
	assert.match(prompts, /reviewItemIds, and reviewChecks/);
	for (const action of ["review_scope", "refine_complete", "plan_complete", "task_done", "task_start", "consolidate_complete", "back_to_plan"]) {
		assert.match(extension, new RegExp(`Type\\.Literal\\("${action}"\\)`), `tool schema exposes ${action}`);
	}
	for (const artifact of ["review-manifest.json", "review-report.md"]) assert.match(skillOrPrompts(prompts), new RegExp(artifact.replace(".", "\\.")));
});

function skillOrPrompts(prompts: string): string {
	return `${readFileSync(SKILL, "utf8")}\n${prompts}`;
}
