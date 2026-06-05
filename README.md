# Codex Status Line

Unofficial VS Code extension that shows local Codex activity in the status bar.

This extension is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, Microsoft, Claude, or Claude Code.

![Codex Status Line status bar screenshot](./Screenshot%202026-06-05%20105841.png)

## Features

- Shows a compact Codex status bar item.
- Shows the current state or quota usage in the VS Code bottom status bar.
- Shows folder, git branch, model, context usage, 5-hour quota, and weekly quota when available.
- Can print the current state to the integrated terminal with `Codex Status Line: Print Status To Terminal`.
- Can bind the active integrated terminal to a specific Codex session with `Codex Status Line: Bind Active Terminal To Session`.
- Supports `idle`, `running`, `waiting`, `error`, and `unknown` states.
- Provides a details command from the status bar item.
- Reads status from an optional local JSON file.
- Sends no telemetry and performs no remote upload by default.

## Configuration

`codexStatusLine.enabled`: show or hide the status bar item.

`codexStatusLine.refreshIntervalMs`: local refresh interval in milliseconds.

`codexStatusLine.statusFilePath`: optional local JSON file path.

Example status file:

```json
{
  "state": "running",
  "detail": "Processing request",
  "model": "gpt-5.5",
  "context": {
    "tokensRemaining": 12345,
    "tokensUsed": 7655,
    "tokenBudget": 20000
  },
  "limits": {
    "fiveHour": {
      "percentUsed": 62,
      "resetsIn": "2h 10m"
    },
    "weekly": {
      "percentUsed": 14,
      "resetsIn": "3d"
    }
  }
}
```

The `state` value must be one of `idle`, `running`, `waiting`, `error`, or `unknown`.

When context quota fields are present, the bottom status bar shows a compact segmented label instead of the activity state, for example:

```text
$(folder) Status_line_extension | $(git-branch) main | $(sparkle) gpt-5.5 | C <bar> 38% | 5H <bar> 62% | W 14% <bar>
```

The visible label stays compact: token counts and quota reset hints remain available from the tooltip and details command instead of being shown directly in the status bar. The status item does not apply quota warning or error background colors.

These values come from the configured local status source. The extension does not query OpenAI, ChatGPT, or Codex internals for quota data.

## Codex Status Writer

This repo includes a local companion writer that can keep `codex-status.json` updated from Codex CLI session logs. It reads the newest `*.jsonl` rollout file under `%USERPROFILE%\.codex\sessions` by default, parses `token_count` events, and writes the nested status JSON consumed by the extension.

Build first:

```powershell
npm run compile
```

Run once:

```powershell
npm run write-status -- --status-file .\codex-status.json
```

Keep updating while Codex is running:

```powershell
npm run write-status -- --status-file .\codex-status.json --watch --interval-ms 2000
```

Useful options:

```text
--codex-home <path>     Codex home directory, defaulting to CODEX_HOME or %USERPROFILE%\.codex
--sessions-dir <path>   Explicit sessions directory to scan
--session-file <path>   Explicit rollout JSONL file to read
--status-file <path>    Status JSON path to write
--watch                 Repeat until stopped
--interval-ms <ms>      Watch interval, minimum 500 ms
```

When Codex logs expose `context_remaining`, the writer calculates context usage from `model_context_window - context_remaining`. Otherwise it uses `last_token_usage.input_tokens` divided by `model_context_window`. Cumulative `total_token_usage.input_tokens` is used only as a fallback because it can include usage outside the active context window.

## Active Terminal Matching

When Codex session logs are available, the extension prefers the Codex session associated with the active VS Code terminal. It uses local session metadata only:

- If the active terminal exposes a current working directory through VS Code shell integration, the extension selects the newest Codex session log with the same `cwd`.
- If terminal shell integration has not reported a `cwd`, the extension uses the first workspace root as a best-effort directory hint.
- If no matching session is found for the active terminal, the extension shows `C 0%` instead of reusing another terminal's session.

Multiple Codex terminals can run in the same folder, and Codex logs do not currently expose a VS Code terminal id or terminal process id. In that case, run `Codex Status Line: Bind Active Terminal To Session` from the command palette and choose the session that should drive the active terminal's status. Bindings are kept for the current VS Code session and cleared when the terminal closes.

## Limitations

- Context usage updates only after the active terminal has produced a Codex `token_count` event. A newly opened or newly switched terminal can show `C 0%` until Codex activity in that terminal writes new session-log data.
- Context usage is best-effort, not exact. Codex local logs currently expose token-count metadata rather than a stable terminal-to-session API or the literal `/statusline` output, so the extension estimates context usage from `context_remaining` when available, then `last_token_usage.input_tokens`.
- The 5-hour and weekly quota percentages are more direct because they come from Codex `rate_limits.used_percent` fields in the same local `token_count` events.
- VS Code does not expose reliable terminal scrollback/output to extensions, so this extension cannot run `/statusline` and parse the printed text from an existing terminal.
- Automatic terminal matching depends on VS Code shell integration, terminal working directory, and Codex session-log timestamps. If multiple Codex sessions run in the same folder, use `Codex Status Line: Bind Active Terminal To Session` for a more reliable mapping.
- The extension reads local Codex session logs from the current machine only. It does not query a remote service and cannot show usage for sessions running elsewhere.

## Privacy

By default, this extension does not send source code, prompts, terminal output, local paths, or usage telemetry to any remote service. When `codexStatusLine.statusFilePath` is configured, the extension reads that local JSON file to compute the status bar state.

The companion writer is also local-only. It parses Codex `token_count`, model, and rate-limit metadata from local rollout logs and writes token counts to the configured status file. It does not make network requests or upload prompts.

Error details are sanitized before display so raw prompts, source code, terminal output, and local paths are not shown in the status bar tooltip.

## Local Installation

Build and package:

```powershell
npm install
npm run compile
npm run package
```

Install the generated VSIX:

```powershell
code --install-extension .\codex-status-line-0.0.6.vsix
```
