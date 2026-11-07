/**
 * taskline — a Codex-style status line under the input: what this session is working on.
 *
 * Pi's footer identifies a session by directory only, so several open windows
 * look identical. This renders one status line through `ctx.ui.setStatus()`:
 *
 *   ⠹  fix login redirect        working
 *   π  fix login redirect        idle
 *   ?  fix login redirect        a dialog is waiting for you
 *   ✗  fix login redirect        last turn ended in a provider error
 *
 * Label sources, highest priority first:
 *   1. `/title <text>`            manual label (persisted in the session)
 *   2. `/name <text>` / --name    session name set through Pi
 *   3. auto label                 first prompt + one small model call
 *   4. heuristic label            first prompt, trimmed, no model call
 *
 * Commands:
 *   /title                show the current label and where it came from
 *   /title <text>         pin a label for this session
 *   /title auto           drop the pinned label and regenerate it
 *   /title clear          forget labels, fall back to the prompt heuristic
 *
 * Configuration (environment):
 *   PI_TASKLINE=0               disable the extension
 *   PI_TASKLINE_MODEL=prov/id   model used to generate labels
 *   PI_TASKLINE_MAX=36          max label length
 *   PI_TASKLINE_SPIN=0          static marker instead of a spinner
 *   PI_TASKLINE_OSC=1           also set the terminal title (off by default)
 *
 * Install: copy to ~/.pi/agent/extensions/taskline.ts (auto-discovered), then
 * `/reload`. Or install the package: pi install git:github.com/tungmv/pi-taskline
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENABLED = process.env.PI_TASKLINE !== "0";
const OSC_TITLE = process.env.PI_TASKLINE_OSC === "1";
const SPIN = process.env.PI_TASKLINE_SPIN !== "0";
const MAX_LABEL = Number.parseInt(process.env.PI_TASKLINE_MAX ?? "", 10) || 36;
const REGEN_AFTER_MESSAGES = 10;
const SPINNER_MS = 200;

/** Sorted first among extension statuses so the line reads as the title. */
const STATUS_KEY = "0-taskline";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MARK = { idle: "π", working: "◆", prompt: "?", error: "✗" } as const;

type Mode = keyof typeof MARK;

/** Cheap models, tried in order before falling back to the session model. */
const MODEL_PREFERENCE = [
	/haiku/,
	/gpt-5\.\d+-nano/,
	/gpt-5-nano/,
	/nano/,
	/flash-fast/,
	/-flash/,
	/mini/,
	/small/,
	/instant/,
];

const TITLE_PROMPT = [	"You label terminal tabs for coding sessions.",
	"Given the conversation so far, reply with a 2-4 word label describing what the session is about.",
	"Rules: plain ASCII words, no quotes, no trailing punctuation, no emojis, no filler like 'session' or 'task'.",
	"Examples: fix login redirect, refactor session store, review pr 812.",
	"Reply with only the label.",
].join(" ");

type Ctx = ExtensionContext;

// Extension state. Reset on every session_start.
let manualLabel: string | undefined;
let autoLabel: string | undefined;
let heuristicLabel: string | undefined;
let mode: Mode = "idle";
let generating = false;
let generatedAtMessageCount = -1;
let spinnerIndex = 0;
let spinnerTimer: ReturnType<typeof setInterval> | undefined;
let disposed = false;
let lastPainted: string | undefined;
// Subagents share this module state; only the interactive root may paint.
let rootSession: string | undefined;

function sessionKey(ctx: Ctx | undefined): string | undefined {
	if (!ctx) return undefined;
	try {
		return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}

/** True for the session this extension attached to, not a subagent run. */
function isRoot(ctx: Ctx | undefined): boolean {
	const key = sessionKey(ctx);
	return Boolean(key && rootSession && key === rootSession);
}

/** Trailing words that read badly when a label is cut short. */
const TRAILING_STOPWORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);

function trimmed(text: string): string {
	const words = text.split(" ").filter(Boolean);
	while (words.length > 1 && TRAILING_STOPWORDS.has(words[words.length - 1].toLowerCase())) words.pop();
	return words.join(" ");
}

/** Collapse to a single short line, dropping control characters and quotes. */
function clean(raw: unknown, max = MAX_LABEL): string {
	if (typeof raw !== "string") return "";
	let text = raw
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/[“”„«»]/g, "")
		.replace(/^[\s"'`*_#>-]+|[\s"'`*_#.;:,!?-]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	// Drop list/formatting noise a small model may leave behind.
	text = text.replace(/^(label|title)\s*[:\-]\s*/i, "").trim();
	if (Array.from(text).length > max) {
		const cut = Array.from(text).slice(0, max);
		const lastSpace = cut.lastIndexOf(" ");
		text = trimmed((lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).join("").trim());
	}
	return text;
}

/** Keep labels uniform: lowercase the first word unless it is an acronym. */
function normalizeGenerated(label: string): string {
	if (!label) return label;
	const [first, ...rest] = label.split(" ");
	if (!first || first !== first.toUpperCase()) {
		return [first.charAt(0).toLowerCase() + first.slice(1), ...rest].join(" ");
	}
	return label;
}

function cwdName(): string {
	const parts = process.cwd().split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? "pi";
}

function messageText(message: any): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part: any) => part && part.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join(" ");
}

/** True for prompts a human typed at the keyboard, not injected context. */
function isRealUserTurn(message: any): boolean {
	if (message?.role !== "user") return false;
	if (message.customType) return false;
	return messageText(message).trim().length > 0;
}

function userTexts(ctx: Ctx): string[] {
	const texts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type !== "message") continue;
		if (!isRealUserTurn(entry.message)) continue;
		texts.push(messageText(entry.message).trim());
	}
	return texts;
}

/**
 * Strip the boilerplate openers usually carry (paths, XML-ish context blocks,
 * request framing) so the heuristic label is about the goal.
 */
function heuristicFrom(text: string): string {
	let value = text;
	value = value.replace(/```[\s\S]*?```/g, " ");
	value = value.replace(/<[^>]{1,80}>/g, " ");
	value = value.replace(/^[@\w./-]+\.(md|ts|tsx|js|py|json|txt)\s+/g, "");
	value = value.replace(/^(please|pls|can you|could you|i want to|i need to|help me|let's|lets)\s+/i, "");
	return clean(value, Math.min(MAX_LABEL, 32));
}
function pickModel(ctx: Ctx): any {
	const override = process.env.PI_TASKLINE_MODEL?.trim();
	if (override) {
		const [provider, ...rest] = override.split("/");
		const id = rest.join("/");
		const found = id ? ctx.modelRegistry.find(provider, id) : ctx.modelRegistry.find(provider, provider);
		if (found) return found;
	}
	// A label is four words: prefer a cheap configured model over the session one.
	let available: any[] = [];
	try {
		available = (ctx.modelRegistry.getAvailable() as any[]) ?? [];
	} catch {
		available = [];
	}
	for (const pattern of MODEL_PREFERENCE) {
		const match = available.find((model) => {
			const haystack = `${model?.provider ?? ""}/${model?.id ?? ""}`.toLowerCase();
			if (!pattern.test(haystack)) return false;
			if (model?.input && Array.isArray(model.input) && !model.input.includes("text")) return false;
			try {
				return ctx.modelRegistry.hasConfiguredAuth(model) !== false;
			} catch {
				return true;
			}
		});
		if (match) return match;
	}
	return ctx.model ?? undefined;
}

/** Session name set with /name or --name, cleaned for display. */
function sessionLabel(ctx?: Ctx): string {
	try {
		return clean(ctx ? ctx.sessionManager.getSessionName() : undefined);
	} catch {
		return "";
	}
}

/** The label for this session; empty when nothing is known yet. */
function activeLabel(ctx?: Ctx): string {
	return manualLabel || sessionLabel(ctx) || autoLabel || heuristicLabel || "";
}

function shortLabel(text: string, max: number): string {
	const chars = Array.from(text);
	if (chars.length <= max) return text;
	return trimmed(chars.slice(0, max - 1).join("").trimEnd()) + "…";
}

function glyph(ctx: Ctx, text: string): string {
	const theme = ctx.ui.theme;
	switch (mode) {
		case "working":
			return theme.fg("accent", SPIN ? SPINNER[spinnerIndex % SPINNER.length] : MARK.working);
		case "prompt":
			return theme.fg("warning", MARK.prompt);
		case "error":
			return theme.fg("error", MARK.error);
		default:
			return theme.fg("success", MARK.idle);
	}
}

/** One status line: marker + label. The footer already shows the directory. */
function renderStatus(ctx: Ctx, label: string): string {
	const theme = ctx.ui.theme;
	return `${glyph(ctx, label)}  ${theme.fg("text", shortLabel(label, MAX_LABEL))}`;
}

function paint(ctx: Ctx | undefined): void {
	if (!ENABLED || disposed || !ctx || !isRoot(ctx)) return;
	const label = activeLabel(ctx);
	// With no label yet the footer's directory line already identifies the tab.
	const text = label ? renderStatus(ctx, label) : undefined;
	if (text === lastPainted) return;
	lastPainted = text;
	try {
		ctx.ui.setStatus(STATUS_KEY, text);
		if (OSC_TITLE && label) ctx.ui.setTitle(`${MARK[mode]} ${shortLabel(label, MAX_LABEL)}`);
	} catch {
		// Session replacement invalidates the context; the next event repaints.
	}
}

function repaint(ctx: Ctx | undefined): void {
	lastPainted = undefined;
	paint(ctx);
}

function stopSpinner(): void {
	if (spinnerTimer) {
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	}
}

function startSpinner(ctx: Ctx): void {
	stopSpinner();
	if (!SPIN) return;
	spinnerIndex = 0;
	spinnerTimer = setInterval(() => {
		spinnerIndex++;
		// Force a repaint: only the glyph changes frame to frame.
		lastPainted = undefined;
		paint(ctx);
	}, SPINNER_MS);
	if (typeof spinnerTimer.unref === "function") spinnerTimer.unref();
}

function setMode(ctx: Ctx | undefined, next: Mode): void {
	if (mode === next) return;
	mode = next;
	if (next === "working" && ctx) {
		startSpinner(ctx);
	} else {
		stopSpinner();
		spinnerIndex = 0;
	}
	repaint(ctx);
}

function restorePersistedLabel(ctx: Ctx): void {
	manualLabel = undefined;
	autoLabel = undefined;
	heuristicLabel = undefined;
	generatedAtMessageCount = -1;
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry?.type !== "custom" || entry.customType !== "taskline") continue;
		const data = entry.data as { manual?: string; auto?: string } | undefined;
		manualLabel = clean(data?.manual) || undefined;
		autoLabel = clean(data?.auto) || undefined;
	}
	const texts = userTexts(ctx);
	// The opening request defines the session; later prompts are often just "ok".
	if (texts.length > 0) heuristicLabel = heuristicFrom(texts[0]) || undefined;
}

function persist(pi: ExtensionAPI): void {
	try {
		pi.appendEntry("taskline", { manual: manualLabel, auto: autoLabel });
	} catch {
		// Append failed (shutting down); the label still applies to this process.
	}
}

async function generateLabel(pi: ExtensionAPI, ctx: Ctx, force = false): Promise<void> {
	if (!ENABLED || generating || !isRoot(ctx)) return;
	// An explicit /title, /name, or --name outranks anything generated here.
	if (!force && (manualLabel || sessionLabel(ctx))) return;
	const texts = userTexts(ctx);
	if (texts.length === 0) return;
	if (!force && autoLabel && texts.length - generatedAtMessageCount < REGEN_AFTER_MESSAGES) return;
	const model = pickModel(ctx);
	if (!model) return;

	const tail = texts.slice(-2).map((text) => shortLabel(text, 400)).join("\n---\n");
	const prompt = `First request:\n${shortLabel(texts[0], 900)}\n\nLatest request:\n${tail}\n\nLabel:`;

	generating = true;
	try {
		const response: any = await (ctx.modelRegistry as any).complete(
			model,
			{
				systemPrompt: TITLE_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ maxTokens: 256, temperature: 0.2, reasoning: "off", cacheRetention: "none" },
		);
		if (disposed) return;
		if (response?.stopReason === "aborted" || response?.stopReason === "error") return;
		const text = Array.isArray(response?.content)
			? response.content
					.filter((part: any) => part?.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text)
					.join(" ")
			: String(response?.content ?? "");
		const label = normalizeGenerated(clean(text));
		if (!label) return;
		autoLabel = label;
		generatedAtMessageCount = texts.length;
		persist(pi);
		repaint(ctx);
	} catch {
		// Label generation is cosmetic; never surface an error for it.
	} finally {
		generating = false;
	}
}

function lastAssistantStopReason(ctx: Ctx): string | undefined {
	try {
		const branch = ctx.sessionManager.getBranch() as any[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const message = branch[i]?.message;
			if (message?.role !== "assistant") continue;
			return typeof message.stopReason === "string" ? message.stopReason : undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export default function (pi: ExtensionAPI): void {
	if (!ENABLED) return;

	pi.on("session_start", async (event, ctx) => {
		disposed = false;
		// Headless runs (-p, JSON, RPC) have no footer to paint.
		if (ctx.hasUI !== true || ctx.mode !== "tui") return;
		// Subagents start with reason "startup" in this same process; they must not
		// overwrite the status line of the session that spawned them.
		if ((event as any)?.reason === "startup" && rootSession) return;
		rootSession = sessionKey(ctx) ?? rootSession ?? "root";
		restorePersistedLabel(ctx);
		mode = "idle";
		stopSpinner();
		repaint(ctx);
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		repaint(ctx);
	});

	// Show a label as soon as the first prompt is typed, before any model runs.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isRoot(ctx)) return;
		const prompt = (event as any)?.messageType === "user" ? String((event as any).prompt ?? "") : "";
		if (prompt && !heuristicLabel) {
			heuristicLabel = heuristicFrom(prompt) || undefined;
			repaint(ctx);
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!isRoot(ctx)) return;
		setMode(ctx, "working");
	});

	pi.on("ui_prompt_start", async (_event, ctx) => {
		if (!isRoot(ctx)) return;
		setMode(ctx, "prompt");
	});

	pi.on("ui_prompt_end", async (_event, ctx) => {
		if (!isRoot(ctx)) return;
		setMode(ctx, "idle");
	});

	pi.on("agent_settled", async (event, ctx) => {
		if (!isRoot(ctx)) return;
		setMode(ctx, lastAssistantStopReason(ctx) === "error" ? "error" : "idle");
		if ((event as any)?.aborted) return;
		void generateLabel(pi, ctx);
	});

	// Older Pi builds stop at agent_end; keep the marker from sticking on working.
	pi.on("agent_end", async (event, ctx) => {
		if (!isRoot(ctx)) return;
		if ((event as any)?.willContinue === true) return;
		const timer = setTimeout(() => {
			if (mode !== "working" || disposed) return;
			let idle = false;
			try {
				idle = ctx.isIdle();
			} catch {
				return;
			}
			if (!idle) return;
			setMode(ctx, lastAssistantStopReason(ctx) === "error" ? "error" : "idle");
			void generateLabel(pi, ctx);
		}, 1500);
		if (typeof timer.unref === "function") timer.unref();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopSpinner();
		if (isRoot(ctx)) {
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// Context already torn down.
			}
		}
		disposed = true;
		lastPainted = undefined;
	});

	pi.registerCommand("title", {
		description: "Show or set this session's status line label (usage: /title [text|auto|clear])",
		handler: async (rawArgs, ctx) => {
			const arg = String(rawArgs ?? "").trim();
			if (!arg) {
				const source = manualLabel
					? "manual"
					: sessionLabel(ctx)
						? "session name"
						: autoLabel
							? "auto"
							: heuristicLabel
								? "prompt"
								: "directory";
				ctx.ui.notify(`Title: ${activeLabel(ctx) || cwdName()} — from ${source}`, "info");
				return;
			}
			if (arg === "auto") {
				manualLabel = undefined;
				autoLabel = undefined;
				persist(pi);
				await generateLabel(pi, ctx, true);
				repaint(ctx);
				ctx.ui.notify(`Title: ${activeLabel(ctx) || cwdName()}`, "info");
				return;
			}
			if (arg === "clear") {
				manualLabel = undefined;
				autoLabel = undefined;
				persist(pi);
				repaint(ctx);
				ctx.ui.notify(`Title: ${activeLabel(ctx) || cwdName()}`, "info");
				return;
			}
			const label = clean(arg);
			if (!label) {
				ctx.ui.notify("Usage: /title <text> | /title auto | /title clear", "warning");
				return;
			}
			manualLabel = label;
			persist(pi);
			repaint(ctx);
			ctx.ui.notify(`Title: ${label}`, "info");
		},
	});
}
