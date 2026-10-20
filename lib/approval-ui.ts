// Height-bounded host-consent UI. Scrolling uses Pi's native ScrollView state;
// this component reserves header/footer rows and clips only the body viewport.
import { ScrollView, Text, matchesKey, truncateToWidth, stripTerminalSequences, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export class HostApprovalView implements Component {
	private readonly review: ScrollView;
	private readonly confirmation: ScrollView;
	private confirming = false;
	private usable = false;
	private finished = false;
	private pageSize = 1;
	private readonly rows: () => number;
	private readonly requestRender: () => void;
	private readonly done: (approved: boolean) => void;
	private readonly style: (text: string) => string;

	constructor(
		review: string,
		confirmation: string,
		rows: () => number,
		requestRender: () => void,
		done: (approved: boolean) => void,
		style: (text: string) => string = text => text,
	) {
		this.rows = rows; this.requestRender = requestRender; this.done = done; this.style = style;
		this.review = new ScrollView(new Text(stripTerminalSequences(review), 0, 0), { scrollbar: "hidden" });
		this.confirmation = new ScrollView(new Text(stripTerminalSequences(confirmation), 0, 0), { scrollbar: "hidden" });
	}

	private get scroll(): ScrollView { return this.confirming ? this.confirmation : this.review; }
	private finish(approved: boolean): void {
		if (this.finished) return;
		this.finished = true;
		this.done(approved);
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width)), height = Math.max(0, Math.floor(this.rows()));
		this.usable = w >= 24 && height >= 6;
		if (!this.usable) return ["Enlarge terminal to review", "Esc: cancel (not approved)"].slice(0, height).map(line => truncateToWidth(line, w));
		const body = this.scroll.render(w);
		this.pageSize = height - 3;
		this.scroll.updateLayout(body.length, this.pageSize, this.requestRender);
		const start = this.scroll.scrollTop, visible = body.slice(start, start + this.pageSize);
		while (visible.length < this.pageSize) visible.push("");
		return [
			this.style(truncateToWidth(this.confirming ? "Confirm host execution" : "Review host execution", w)),
			...visible,
			truncateToWidth(`${start + 1}-${Math.min(start + this.pageSize, body.length)}/${body.length}  ↑↓ PgUp/PgDn Home/End`, w),
			this.style(truncateToWidth(this.confirming ? "Y:allow B:back Esc:no" : "Enter:next Esc:cancel", w)),
		];
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.finish(false); return; }
		if (!this.usable) return;
		if (!this.confirming && matchesKey(data, "return")) {
			this.confirming = true;
			this.confirmation.scrollToStart();
			// Approval must wait for the confirmation screen to be rendered.
			this.usable = false;
		} else if (this.confirming && (matchesKey(data, "y") || matchesKey(data, "shift+y"))) {
			this.finish(true); return;
		} else if (this.confirming && matchesKey(data, "b")) {
			this.confirming = false;
			this.usable = false;
		} else if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.pageSize);
		else if (matchesKey(data, "home")) this.scroll.scrollToStart();
		else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
		else return;
		this.requestRender();
	}

	handleMouse(event: TuiMouseEvent): { handled: boolean; render: boolean } | undefined {
		if (event.type !== "wheel" || !this.usable || this.finished) return undefined;
		this.scroll.scrollBy(event.wheelDelta ?? 0);
		this.requestRender();
		return { handled: true, render: true };
	}

	invalidate(): void { this.review.invalidate(); this.confirmation.invalidate(); }
}
