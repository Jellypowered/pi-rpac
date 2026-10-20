import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { HostApprovalView } from "../../lib/approval-ui.ts";

function fixture() {
	let rows = 12, renders = 0;
	const answers: boolean[] = [];
	const review = ["START-AUDIT", ...Array.from({ length: 200 }, (_, i) => `file-${i} 配置🙂 ${"a".repeat(64)}`), "END-AUDIT"].join("\n");
	const view = new HostApprovalView(review, "NOT a sandbox. Allow host access?", () => rows, () => renders++, answer => answers.push(answer));
	return { view, answers, resize: (height: number) => { rows = height; }, renders: () => renders };
}

test("large audits scroll to the bottom while controls stay visible and all rows fit", () => {
	const f = fixture();
	const first = f.view.render(40);
	assert.equal(first.length, 12);
	assert.match(first.join("\n"), /START-AUDIT/);
	assert.match(first.at(-1)!, /Enter:next Esc:cancel/);
	f.view.handleInput("\x1b[6~"); // PageDown
	assert.notDeepEqual(f.view.render(40), first);
	f.view.handleInput("\x1b[F"); // End
	assert.match(f.view.render(40).join("\n"), /END-AUDIT/);
	f.resize(8);
	f.view.invalidate();
	f.view.render(24);
	f.view.handleInput("\x1b[F");
	const narrow = f.view.render(24);
	assert.equal(narrow.length, 8);
	assert.ok(narrow.every(line => visibleWidth(line) <= 24));
	assert.match(narrow.join("\n"), /END-AUDIT/);
	assert.match(narrow.at(-1)!, /Esc:cancel/);
	f.view.handleInput("\x1b[H"); // Home
	assert.match(f.view.render(24).join("\n"), /START-AUDIT/);
	f.view.handleMouse({ type: "wheel", button: "none", x: 1, y: 1, screenX: 1, screenY: 1, width: 24, height: 8, shift: false, alt: false, ctrl: false, wheelDelta: 3 });
	assert.doesNotMatch(f.view.render(24).slice(1, -2).join("\n"), /START-AUDIT/);
	assert.ok(f.renders() > 0);
});

test("approval requires the rendered confirmation screen and an explicit Y, never Enter", () => {
	const f = fixture();
	f.view.render(80); f.view.handleInput("y"); assert.deepEqual(f.answers, []);
	f.view.handleInput("\r"); f.view.handleInput("y");
	assert.deepEqual(f.answers, [], "queued Y cannot approve a screen not yet rendered");
	const confirmation = f.view.render(80);
	assert.match(confirmation.join("\n"), /NOT a sandbox/);
	assert.match(confirmation.at(-1)!, /Y:allow B:back Esc:no/);
	f.view.handleInput("\r"); assert.deepEqual(f.answers, []);
	f.view.handleInput("b"); assert.match(f.view.render(80).join("\n"), /START-AUDIT/);
	f.view.handleInput("\r"); f.view.render(80); f.view.handleInput("y");
	f.view.handleInput("\x1b"); f.view.handleInput("y");
	assert.deepEqual(f.answers, [true]);
	const uppercase = fixture(); uppercase.view.render(80);
	uppercase.view.handleInput("\r"); uppercase.view.render(80); uppercase.view.handleInput("Y");
	assert.deepEqual(uppercase.answers, [true], "the displayed uppercase Y shortcut works too");
});

test("Esc/Ctrl-C cancel both screens; tiny terminals cannot approve", () => {
	for (const confirmation of [false, true]) for (const key of ["\x1b", "\x03"]) {
		const f = fixture(); f.view.render(40);
		if (confirmation) { f.view.handleInput("\r"); f.view.render(40); }
		f.view.handleInput(key); assert.deepEqual(f.answers, [false]);
	}
	const f = fixture(); f.resize(3);
	assert.ok(f.view.render(10).every(line => visibleWidth(line) <= 10));
	f.view.handleInput("\r"); f.view.handleInput("y"); assert.deepEqual(f.answers, []);
	f.resize(12); f.view.render(40); f.view.handleInput("\r"); f.view.render(40);
	f.resize(2); assert.ok(f.view.render(40).length <= 2);
	f.view.handleInput("y"); assert.deepEqual(f.answers, []);
	f.view.handleInput("\x1b"); assert.deepEqual(f.answers, [false]);
});
