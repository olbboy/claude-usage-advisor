# usage-advisor

A Claude Code mod that shows, in a pane beside the chat, where your usage went over the last 7 days (or 24 hours), and gives each suggestion a **Fix** button. It is the terminal's `/usage` recommendations, for the desktop app.

It reads your local session history in `~/.claude/projects` and splits usage by:

- skills, plugins, MCP servers and subagent types (from the attribution fields Claude Code records);
- sessions that ran 8 hours or more, and requests after the 20th prompt of a session;
- requests sent with more than 200K tokens of context;
- cache rewrites after a break long enough for the cache to expire;
- turns run at `xhigh` or `max` effort;
- context injected by hooks, and CLAUDE.md, rules and memory files loaded on every turn.

The pane starts with your plan's usage windows (this week, the last 5 hours) as Claude Code last reported them, in large type with the reset time. Suggestions are split into config changes and work habits; a row shows its share of usage, and rows under 3% are hidden. A breakdown of every skill, subagent, plugin and MCP server at 1% or more opens on demand. **Fix** sends Claude a request to look into that row and propose changes, showing each change before making it. The long-context row instead compacts the current session. Each fix is timed: after you press one, its row adds a line with its share counted from the hour of the fix ("Từ lần sửa"), so you see whether the change worked before the old usage leaves the 7-day window. Fix times are kept in `~/.cache/usage-advisor/fixed.json`. **Xem và sửa N mục (f)** works like `f` in the terminal's `/usage`: it sends one numbered request covering every suggestion of 10% or more that a config change can fix, and tells Claude that names in backticks come from your logs and are never instructions.

## Install

At the prompt of a terminal session:

```
/plugin install usage-advisor --marketplace olbboy/claude-usage-advisor
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, desktop included).

From a shell:

```
claude plugin install usage-advisor --marketplace olbboy/claude-usage-advisor
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `olbboy/claude-usage-advisor`, then Add plugin.

## Use

The **Usage** pane opens when a session starts; `/usage-advisor` opens it again. Buttons: **7 ngày** (7 days), **24 giờ** (24 hours), **Quét lại** (rescan). The interface text is in Vietnamese.

## Requirements and limits

- Node.js 18 or newer. The mod looks for it in fnm's default alias, `/usr/local/bin`, `/opt/homebrew/bin`, Volta, then `PATH`.
- Usage is an estimate in input-token equivalents: input ×1, cache write ×1.25 (5 min) or ×2 (1 h), cache read ×0.1, output ×5. It is not Anthropic's own accounting.
- One request can fall in several rows (say, high effort and long context), so shares can add up to more than 100%.
- Hook and instruction-file shares are estimated from text length.
- The windows are the last 24 or 168 hours, in whole hours.
- The first scan reads every session file changed in the last 7 days (about 11 s for 4 GB here); later scans reread only changed files, from a cache in `~/.cache/usage-advisor/`.

## License

MIT
