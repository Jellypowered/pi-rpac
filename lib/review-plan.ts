// Validate explicit item assignments in a human plan against the canonical tool task list.
import type { PlanTaskSpec } from "./machine.ts";

export function validateReviewAssignments(text: string, tasks: PlanTaskSpec[]): void {
	let task: number | null = null;
	let ids: string[] = [];
	let explicit = false;
	const finish = () => {
		if (task === null || !explicit) return;
		const expected = [...(tasks[task - 1]?.reviewItemIds ?? [])].sort();
		const actual = [...new Set(ids)].sort();
		if (!tasks[task - 1] || JSON.stringify(expected) !== JSON.stringify(actual)) {
			throw new Error(`Written review plan task ${task} assigns different manifest items than the registered task list. Reconcile the plan and reviewItemIds before requesting approval.`);
		}
	};
	let collecting = false;
	for (const line of text.split(/\r?\n/)) {
		const heading = line.match(/^#{2,4}\s+(?:Task\s+)?(\d+)(?:\s*[.—:)]|\.\s)/i);
		if (heading) { finish(); task = Number(heading[1]); ids = []; explicit = false; collecting = false; continue; }
		if (/^#{1,4}\s/.test(line)) { finish(); task = null; ids = []; explicit = false; collecting = false; continue; }
		if (task === null) continue;
		if (/reviewItemIds|Assigned manifest items|Assigned (?:IDs|items)/i.test(line)) { explicit = true; collecting = true; }
		if (collecting) {
			ids.push(...(line.match(/\bri-[a-f0-9]{20}\b/g) ?? []));
			if (!line.trim()) collecting = false;
		}
	}
	finish();
}
