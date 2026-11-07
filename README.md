# pi-taskline

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that puts a
Codex-style status line under the input: **what this session is working on**, and
whether it needs you.

Pi's footer identifies a session by directory only, so five open windows in the
same repo all look alike. This adds one line:

```
⠹  fix login redirect          working
π  fix login redirect          idle
?  fix login redirect          a dialog is waiting for you
✗  fix login redirect          last turn ended in a provider error
```

## Install

As a package (recommended):

```bash
pi install git:github.com/tungmv/pi-taskline
```

Or drop the single file in and reload:

```bash
curl -fsSL https://raw.githubusercontent.com/tungmv/pi-taskline/main/extensions/taskline.ts \
  -o ~/.pi/agent/extensions/taskline.ts
```

Then `/reload` (or restart pi). Opens with `pi-bolt` too — the same layout applies.

## How the label is chosen

Highest priority first:

| Source | When |
|---|---|
| `/title <text>` | you pinned it; stored in the session, survives resume |
| `/name <text>`, `--name` | session name set through pi |
| auto label | first settled turn: one small model call turns your prompt into 2–4 words |
| heuristic label | your first prompt, trimmed — appears instantly, before any model call |

The heuristic is shown while the first turn runs, then the model label replaces
it. Nothing is asked of the model if you already named the session.

It reuses the label on `/reload`, `/resume`, and `/fork` without another model
call, and refreshes it every 10 user messages.

## Commands

| Command | Effect |
|---|---|
| `/title` | show the current label and where it came from |
| `/title <text>` | pin a label for this session |
| `/title auto` | drop the pinned label and regenerate it |
| `/title clear` | forget labels, fall back to the prompt heuristic |

## Configuration

All optional, via environment:

| Variable | Default | Meaning |
|---|---|---|
| `PI_TASKLINE` | `1` | set `0` to disable |
| `PI_TASKLINE_MODEL` | session model | `provider/model-id` used to generate labels |
| `PI_TASKLINE_MAX` | `36` | max label length |
| `PI_TASKLINE_SPIN` | `1` | set `0` for a static marker instead of a spinner |
| `PI_TASKLINE_OSC` | `0` | set `1` to also set the terminal title |

On label cost: at most one small call per session (`maxTokens: 256`,
`reasoning: "off"`, `cacheRetention: "none"`), then one per 10 user messages. Set
`PI_TASKLINE_MODEL` to a cheap model if your session model is expensive.

## Notes

- Only the interactive session paints the line. Subagents run in the same
  process and would otherwise overwrite it, so they are filtered out.
- Headless runs (`-p`, JSON, RPC) have no footer and are skipped.
- The status key is `0-taskline`: pi sorts extension statuses by key, so this
  keeps the line leftmost rather than buried behind other extensions.
- A failed turn leaves `✗` until the next turn starts, so a run that broke
  while you were away is still visible when you come back.

## License

MIT
