# Troubleshooting

Report structured blockers instead of retrying blindly.

Useful checks:

- `chatgpt.doctor({ check: ["bridge", "login", "upload", "download", "clipboard"] })`
- `chatgpt.help()`
- `chatgpt.commands()`
- `chatgpt.describe("<command-name>")`

Common interpretations:

- `browser_bridge_unavailable`: the process does not have a bridge-enabled `globalThis.agent`.
- `login_required`: the visible ChatGPT session needs user login.
- `captcha`: the user must resolve an interactive challenge.
- `selector_drift`: the ChatGPT UI changed or the selected surface is unsupported.
- `permission`: upload, download, or clipboard permission is missing.
- `rate_limit`: wait or ask the user how to proceed.
- `partial`: a workflow submitted or progressed but did not fully complete.

`unsafe_chatgpt_origin` with `visibleText: "The current tab URL could not be
verified."` can mean that the in-app Browser released the prepared tab while
Codex paused for action-time confirmation. Current runtimes reclaim only the
exact tab whose stable provider ID matches the original controlled tab, then
re-verify its ChatGPT origin. An observed non-ChatGPT origin still fails closed
and is never reclaimed automatically. The `https://chatgpt.com/projects` path
is allowlisted because origin validation is path-independent.

If a prompt was already submitted and the read timed out, do not resubmit. Reuse the same visible thread and run another bounded read.

For generated files, current ChatGPT may expose a filename button that opens an
artifact preview before its Download control appears. Use
`filenamePattern: "^expected\\.csv$"` when the name is known. The plugin handles
that two-step UI and copies path-only Chrome downloads into `destDir`;
`download_filename_not_found` means it intentionally rejected an unrelated
artifact fallback.
