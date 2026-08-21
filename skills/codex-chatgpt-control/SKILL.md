---
name: codex-chatgpt-control
description: Use when Codex agents need to operate visible ChatGPT Chat or Work through the codex-chatgpt-control SDK, including verified configuration, prompts, tasks, progress, steering, files, artifacts, reports, blockers, and source smokes.
---

# codex-chatgpt-control

Use this skill when a user asks Codex to operate ChatGPT web through a visible browser session, or when a task involves the `codex-chatgpt-control` SDK.

This skill is for visible, user-directed ChatGPT workflows only. It is not an OpenAI API wrapper, does not call hidden ChatGPT endpoints, and must not bypass login, captcha, product permissions, file permissions, or user confirmation.

## Required Posture

1. Prefer the SDK facade from `createChatGPT({ agent })`.
2. Use ChatGPT web through a compatible Codex/browser bridge. Do not use private ChatGPT network calls.
3. Treat `globalThis.agent` as host-provided. If it is missing, initialize an installed Codex Browser runtime when available; otherwise report a bridge blocker. Automatic SDK discovery prefers the in-app browser and falls back to Chrome.
4. Stop on login, captcha, rate-limit, selector-drift, upload/download permission, or ambiguous confirmation blockers.
5. Ask for explicit user confirmation before public, destructive, third-party, paid, account-level, or externally visible actions.
6. Redact run reports by default. Raw prompt/response content is opt-in only.
7. Attach only files the user approved.
8. Use official Codex capabilities for local repository editing, commands, tests, branches, and deployment. This SDK controls visible ChatGPT surfaces.
9. When the user requests Chat or Work, call `experience.open` before
   configuration or submission. Do not assume the currently visible pane is
   already the requested experience.

## Runtime Requirements

Deterministic local checks need:

- Node.js 20 or newer
- npm
- a source checkout of `codex-chatgpt-control`

Real browser-control runs also need:

- a signed-in visible ChatGPT web session in the Codex in-app browser or Chrome
- a compatible Codex/browser bridge exposing `globalThis.agent`
- permission to use or open a visible ChatGPT tab

Ordinary shells should not have `globalThis.agent`. A `browser_bridge_unavailable` blocker from an ordinary shell is an expected safe result for browser-required calls.

Treat Browser bootstrap and instruction loading as internal setup. User-facing progress should say that Codex is connecting to the selected browser; do not narrate Node hosts, globals, runtime imports, or guidance loading unless the user explicitly asks for diagnostics.

## File Upload Permissions

In-app-browser file attachment uses its visible file chooser and Codex confirmation flow. Chrome fallback additionally needs two separate permission gates:

1. Chrome extension gate: open `chrome://extensions`, choose the Codex/browser bridge extension, open **Details**, and enable **Allow access to file URLs**.
2. Codex app gate: in Codex settings, allow Google Chrome uploads under **Computer Use > Google Chrome > Permissions > Uploads**. Use the narrowest setting that fits the workflow; unattended smoke tests may need the always-allow setting.

If either gate is missing, stop with a permission blocker and tell the user which gate to check.

## Host-Local Attachment Paths

Attachment paths must be absolute on the machine running the Node backend. Use the path form for that host operating system. On Linux/WSL backends, use paths such as `/home/you/file.pdf` or `/mnt/c/work/file.pdf`. On Windows backends, use fully qualified paths such as `C:\Users\you\file.pdf`. If a Windows-looking path is rejected on macOS/Linux, do not retry with the same string. Convert it to the backend host's real path, for example `/home/you/file.pdf` for a Linux/WSL backend.

Use `chatgpt.files.preflight({ paths })` before long file workflows when local path validity is uncertain. It does not open ChatGPT or upload files; it validates host-local file metadata and returns structured blockers/warnings.

## Source Setup

From a source checkout:

```bash
cd packages/node
npm ci
npm test
npm run build
npm run bundle
npm run bundle:backend
```

Then use the built bundle from a bridge-enabled host runtime:

```ts
import { createChatGPT } from "/absolute/path/to/codex-chatgpt-control/packages/node/dist/codex-chatgpt-control.bundle.mjs";

const workspacePath = typeof globalThis.nodeRepl?.cwd === "string"
  ? globalThis.nodeRepl.cwd
  : undefined;
const chatgpt = createChatGPT({
  agent: globalThis.agent,
  ...(workspacePath === undefined ? {} : { workspaceProject: { path: workspacePath } })
});
```

This routes new Chat threads and new Work tasks into a matching workspace-named ChatGPT Project.
If the Project is missing, stop on the creation confirmation blocker. Set
`confirmCreation: true` only after the user explicitly approves creating it.
Use `project: false` with `confirmGlobal: true` only when the user explicitly
requests a global conversation. Unconfirmed opt-outs must remain blocked.

The installed plugin loader can persist an explicit blanket approval in
`~/.codex/codex-chatgpt-control/preferences.json` as
`{ "workspaceProjects": { "autoCreate": true } }`. Only record it after the
user approves automatic creation for all current and future Codex workspaces.
The public SDK remains confirmation-gated when that preference is absent.

Prefer normal package imports in projects that depend on the published npm package:

```ts
import { createChatGPT } from "codex-chatgpt-control";
```

## Basic Runner Flow

```ts
const reviewer = chatgpt.agent({
  name: "reviewer",
  instructions: "Review carefully and return Markdown."
});

const result = await chatgpt.runner.run(reviewer, {
  input: "Review this design.",
  thread: { type: "new" },
  response: { format: "markdown" }
});

if (!result.ok) {
  console.log(JSON.stringify(result.interruptions ?? result, null, 2));
} else {
  console.log(result.output_text);
}
```

New-thread workflows open a fresh controlled ChatGPT tab by default. Use `preferExistingTab: true` only for intentional broad reuse, or `existingTab` for a user-identified open tab.

Instructions are visible prompt text by default. Use `instructionsMode` intentionally:

- `visible_prefix`: include instructions in the submitted user message.
- `visible_setup_message`: submit instructions as a separate visible setup turn.
- `metadata_only`: keep instructions local; they are not sent to ChatGPT.

## Common Workflows

Inspect the visible Chat or Work surface:

```ts
const surface = await chatgpt.experience.detect();
const capabilities = await chatgpt.configuration.inspect();
```

If a specific surface was requested, open it explicitly even when detection
already returned a value:

```ts
await chatgpt.experience.open({ experience: "work" });
```

Current ChatGPT can expose Chat and Work as radios in a `Select chat surface`
group and can hide that group inside an active Work task. The SDK verifies the
checked pane, gives the current conversation a bounded hydration grace before
returning home when required, and retains older selector fallbacks.

In a compact or narrow Chat composer, the closed configuration control may show
only the current value, such as `Pro`. `configuration.inspect` scopes that
opener to the composer, opens it without changing the selection, and reads the
visible model and effort rows before deciding that an axis is unavailable. Do
not treat the collapsed value alone as the complete capability graph.

Apply strict Work configuration and start a task once:

```ts
await chatgpt.configuration.apply({
  experience: "work",
  desired: {
    model: "GPT-5.6 Sol",
    effort: "High",
    speed: "Standard"
  },
  strict: true
});

await chatgpt.work.start({
  prompt: "Produce a decision-ready implementation brief.",
  newTask: true,
  wait: false,
  read: false
});
```

After submission use `chatgpt.work.status`, `work.wait`, `work.steer`,
`work.readLatest`, and `work.artifacts`; do not resubmit after an ambiguous
timeout. Existing `mode` inputs and `modes.set/get` remain supported, while new
code should prefer `experience` and strict `configuration`.

Ask in a new or selected thread:

```ts
await chatgpt.ask({
  prompt: "Reply with the word hi.",
  wait: true,
  read: { format: "markdown" }
});
```

Continue an existing thread:

```ts
await chatgpt.askInThread({
  thread: { type: "url", url: "https://chatgpt.com/c/<conversation-id>" },
  existingTab: true,
  prompt: "Continue from the latest answer.",
  wait: true,
  read: { format: "markdown" }
});
```

When the user says the ChatGPT thread is already open, pass `existingTab: true` or an exact existing-tab policy such as `existingTab: { url: "https://chatgpt.com/c/<conversation-id>" }`. A `thread: { type: "url" }` selector by itself means "navigate to this URL"; it does not express "claim the user-open tab".

Attach approved files:

```ts
const preflight = await chatgpt.files.preflight({
  paths: ["/absolute/host/path/to/approved-file.pdf"]
});

await chatgpt.askWithFiles({
  thread: { type: "new" },
  files: ["/absolute/host/path/to/approved-file.pdf"],
  prompt: "Summarize this file.",
  wait: true,
  read: { format: "markdown" },
  report: { enabled: true, includeContent: false }
});
```

Plan append-only Project Sources changes before mutating a ChatGPT Project:

```ts
const plan = await chatgpt.projects.sources.planAdd({
  projectUrl: "https://chatgpt.com/g/g-p-example/project",
  files: ["/absolute/host/path/to/approved-source.md"]
});

const added = await chatgpt.projects.sources.add({
  projectUrl: "https://chatgpt.com/g/g-p-example/project",
  files: ["/absolute/host/path/to/approved-source.md"],
  confirmMutation: true
});
```

`planAdd` does not open ChatGPT or read file contents. `add` operates only through the visible Project Sources UI and returns `needs_confirmation` unless `confirmMutation: true` is supplied after user approval.

Run a diagnostic before long workflows:

```ts
const diagnostic = await chatgpt.doctor({
  check: ["bridge", "login", "upload", "download", "clipboard", "file_preflight"],
  files: ["/absolute/host/path/to/approved-file.pdf"]
});
```

Use opt-in scenario checks before targeted workflows:

```ts
await chatgpt.doctor({
  check: ["existing_tab"],
  existingTab: {
    target: { type: "conversationId", conversationId: "<conversation-id>" },
    ifMissing: "block"
  }
});

await chatgpt.doctor({
  check: ["localization", "reports"],
  report: { destDir: "/absolute/host/reports" }
});
```

`localization` verifies locale-registry readiness without changing the account language; it is not yet proof that every localized selector path is wired.

## Response Capture

Use Markdown by default for human-readable answers and saved artifacts:

```ts
const latest = await chatgpt.messages.waitAndRead({
  role: "assistant",
  format: "markdown"
});
```

Use `format: "normalized_text"` only for compact assertions, polling checks, or simple exact-string smoke tests.

For long Pro, Thinking, Deep Research, or file-backed answers, poll with `chatgpt.messages.wait({ responseContent: "metadata", ... })` so repeated partial polls return status metadata instead of re-emitting the growing answer body. Call `readLatest({ format: "markdown" })` once the wait confirms completion.

If the user or calling workflow explicitly decides to supersede a still-running Chat response, use `chatgpt.messages.stop({ confirmStop: true })`. Never infer confirmation from a timeout and never use stop as automatic retry recovery. Preserve and report `needs_confirmation`, selector-drift, ambiguity, or unverified-postcondition results; do not replace the SDK with a broad button click.

## Python Client

The Python package is a protocol client over the Node backend. Build the backend first:

```bash
cd packages/node
npm run bundle:backend
```

Then run Python from `packages/python`:

```bash
python -m pip install -e .[dev]
python scripts/live_smoke.py --mode ordinary-shell
```

Point Python at an explicit backend command:

```python
from codex_chatgpt_control import Agent, BackendClient, Runner, StdioBackendTransport

backend = BackendClient(StdioBackendTransport(
    command=["node", "../node/dist/codex-chatgpt-control-backend.mjs"]
))
runner = Runner(backend)
```

## Blocker Handling

When a run fails, report the structured blocker. Do not retry blindly.

Common blockers:

- `browser_bridge_unavailable`: no bridge-enabled host runtime is available.
- `login_required`: the visible ChatGPT session is not signed in.
- `captcha`: user action is required.
- `permission`: upload/download/clipboard permission is missing.
- `selector_drift`: ChatGPT UI changed and selectors need review.
- `rate_limit`: wait or ask the user how to proceed.

## Validation

For source changes, run:

```bash
cd packages/node
npm test
npm run build
npm run bundle
npm run bundle:backend
npm run contract:validate
npm run parity:fixtures
```

For Python parity changes, also run:

```bash
cd packages/python
python -m unittest discover -s tests
python -m compileall -q src examples
python scripts/live_smoke.py --mode ordinary-shell
```

Before claiming the expansion is live-qualified, run its reusable canary from
a bridge-enabled runtime:

```bash
CHATGPT_E2E_SCENARIOS="chat-work-expansion" npm run smoke:live
```

The opt-in configuration mutation canary restores the original Work effort and
Chat pane in a `finally` path:

```bash
CHATGPT_E2E_CONFIGURATION_MUTATION=1 \
CHATGPT_E2E_SCENARIOS="configuration-mutate-restore" \
npm run smoke:live
```
