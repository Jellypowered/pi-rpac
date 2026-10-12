// Child process for the load-under-lock (lost update) test.
// Usage: node rmw-child.ts <root> <iterations>
// Each iteration runs a full load → mutate → save cycle under the state lock,
// appending a uniquely-tagged checkpoint. Without correct locking, concurrent
// runs lose updates.
import { updateActive } from "../../lib/store.ts";
import { nowIso } from "../../lib/util.ts";

const [root, k] = process.argv.slice(2, 4);
if (!root || !k) {
	console.error("usage: rmw-child.ts <root> <iterations>");
	process.exit(3);
}
const iterations = Number(k);
try {
	for (let i = 0; i < iterations; i++) {
		updateActive(root, (s) => {
			s.checkpoints.push({ at: nowIso(), what: `c-${process.pid}-${i}` });
		});
	}
	process.exit(0);
} catch (err) {
	console.error(String(err));
	process.exit(1);
}
