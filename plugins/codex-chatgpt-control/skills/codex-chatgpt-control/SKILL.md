---
name: codex-chatgpt-control
description: Use when Codex agents need to operate visible ChatGPT Chat or Work through the codex-chatgpt-control plugin, including verified configuration, prompts, tasks, progress, steering, files, artifacts, reports, blockers, live smokes, or SDK source work.
---

# ChatGPT Surface Control

Use this skill when a user asks Codex to work with ChatGPT web through a visible browser session, or when a task involves the `codex-chatgpt-control` SDK/plugin.

This skill is for visible, user-directed ChatGPT workflows only. It is not an OpenAI API wrapper, does not call hidden ChatGPT endpoints, and must not bypass login, captcha, product permissions, file permissions, or user confirmation.

Only the primary Codex task may bootstrap or operate the in-app browser, Chrome
surface control, browser confirmations, exact tab identity, or live ChatGPT
submission/read operations. If this skill is running in a Workflow child or
other Codex subagent, stop before browser initialization and return the
visible-surface operation to the parent. A child may prepare a prompt or analyze
output supplied by the parent.

## Required Posture

1. Prefer the plugin-bundled SDK facade from `createChatGPT({ agent })`.
2. Use ChatGPT web through a compatible Codex/browser bridge. Do not use private ChatGPT network calls.
3. In the primary task, treat `globalThis.agent` as host-provided. If it is missing, bootstrap the installed Browser runtime when available; otherwise report a bridge blocker. A child or subagent must return the operation to its parent instead. Automatic SDK discovery prefers the in-app browser and falls back to Chrome.
4. Stop on login, captcha, rate-limit, selector-drift, upload/download permission, or ambiguous confirmation blockers.
5. Ask for explicit user confirmation before public, destructive, third-party, paid, account-level, or externally visible actions.
6. Redact run reports by default. Raw prompt/response content is opt-in only.
7. Attach only files the user approved.
8. Load reference files only for the issue at hand; do not read every reference by default.
9. Route local repository editing, terminal execution, testing, and deployment to official Codex capabilities. This plugin controls visible ChatGPT Chat and Work; it does not replace Codex.
10. When the user requests Chat or Work, call `experience.open` for that
    surface before configuration or submission. Do not assume the currently
    visible pane is already correct.

Codex approval mode and Browser confirmation are separate boundaries. Full
local access or an approve-for-me setting does not waive Browser's action-time
confirmation for sending a ChatGPT message. Never infer that waiver from
`sandbox_mode`, filesystem access, or other turn metadata. If confirmation
requires another turn, preserve the exact controlled tab as a handoff and
re-bootstrap it before re-verifying configuration and submitting once.

## Plugin Runtime

Resolve relative paths from this `SKILL.md` directory. The plugin runtime lives at:

```text
../../runtime/import-chatgpt-control.mjs
```

From a bridge-enabled Codex Node runtime:

```js
const loaderUrl = new URL(
  "../../runtime/import-chatgpt-control.mjs",
  "file:///absolute/path/to/plugins/codex-chatgpt-control/skills/codex-chatgpt-control/SKILL.md"
);
const { importChatGPTControl } = await import(`${loaderUrl.href}?t=${Date.now()}`);
const { createChatGPT } = await importChatGPTControl();

const chatgpt = createChatGPT({
  agent: globalThis.agent,
  reporting: { enabled: true, includeContent: false }
});
```

The plugin loader derives the current Codex workspace automatically and routes
new Chat threads and new Work tasks into the matching workspace-named ChatGPT
Project.
If the Project is missing, stop on the creation confirmation blocker. Set
`confirmCreation: true` only after the user explicitly approves creating it.
When the user explicitly requests a global conversation, use `project: false`
with `confirmGlobal: true`. Unconfirmed opt-outs must remain blocked. Use a
dedicated `workspaceProject: false` client only for an explicitly global workflow.

Project routing is fail-closed. A Project selector-drift blocker, missing
creation confirmation, or lost Project context ends the current workflow
before submission. Never recover by switching to plain/global Chat or Work,
setting `project: false` with `confirmGlobal: true`, creating a
`workspaceProject: false` client, or starting a second unbound client. The fact
that no prompt was submitted only rules out a duplicate; it does not authorize
a global fallback. Only a new, explicit user request for a global conversation
can authorize a separate opt-out workflow.

The plugin loader reads `~/.codex/codex-chatgpt-control/preferences.json`. After
the user explicitly grants durable preapproval for all current and future Codex
workspaces, this preference records it without weakening the public SDK default:

```json
{
  "workspaceProjects": {
    "autoCreate": true
  }
}
```

With that preference, the loader adds `confirmCreation: true` only to derived
workspace Project targets that did not already make an explicit choice. The
runtime still derives a fitting icon and color from each project name.

When using this installed plugin, do not import from an older manually installed skill runtime. Use the plugin-bundled runtime so the installed plugin and SDK stay in sync.

## Browser Bootstrap

Ordinary shells should not have `globalThis.agent`. A `browser_bridge_unavailable` blocker from an ordinary shell is an expected safe result for browser-required calls.

For a live primary-task Codex run, initialize the installed Browser runtime before using the SDK if `globalThis.agent` is missing. A Workflow child or other Codex subagent must stop before browser initialization and return the operation to its parent. Automatic discovery prefers the in-app browser, then falls back to the Chrome extension. If the user explicitly requests a browser, obtain that browser through the Browser skill and pass its handle as `browser` to `createChatGPT(...)`. See `references/bridge-bootstrap.md` when bootstrap details are needed.

Treat Browser bootstrap and instruction loading as internal setup. User-facing progress should say that Codex is connecting to the selected browser; do not narrate Node hosts, globals, runtime imports, or guidance loading unless the user explicitly asks for diagnostics.

Do not diagnose user-open ChatGPT tab availability with `browser.tabs.list()` or `browser.tabs.selected()` alone. When the user says a ChatGPT thread is already open, use `existingTab: true`, an exact `existingTab` policy, or the SDK's existing-tab helpers.

## Basic Runner Flow

```js
const reviewer = chatgpt.agent({
  name: "reviewer",
  instructions: "Review carefully and return Markdown."
});

const result = await chatgpt.runner.run(reviewer, {
  input: "Review this design.",
  thread: { type: "new" },
  experience: "chat",
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

## Chat And Work Surfaces

Detect the visible surface and inspect its actual capability graph:

```js
const surface = await chatgpt.experience.detect();
const configuration = await chatgpt.configuration.inspect({
  experience: surface.data?.experience === "unknown"
    ? undefined
    : surface.data?.experience
});
```

Open a surface explicitly and apply only verified visible controls:

```js
await chatgpt.experience.open({ experience: "work" });
await chatgpt.configuration.apply({
  experience: "work",
  desired: {
    model: "GPT-5.6 Sol",
    effort: "High",
    speed: "Standard"
  },
  strict: true
});
```

The current home UI may expose Chat and Work as radios in a `Select chat
surface` group. An active Work task may hide that group. Use
`experience.open` in both cases: it verifies the checked pane, returns home
only after a bounded current-page hydration grace when necessary, and retains
legacy button/menu/tab/link fallbacks.

In a compact or narrow Chat composer, the closed configuration control may show
only the current value, such as `Pro`. `configuration.inspect` scopes that
opener to the composer and reads both views before deciding that an axis is
unavailable. Current Chat exposes the effort as a `Power` slider in the root
view and the model radios behind `Select model`; application sets and verifies
Power first, then enters the model view, verifies the selected radio, and closes
the menu. Legacy combined Advanced rows remain supported. Do not treat the
collapsed value alone as the complete capability graph.

Selector profiles describe observed UI shapes (`chat_legacy_v1`, `chat_simplified_v1`, `work_basic_v1`, and `work_advanced_v1`). They are not plan or entitlement labels. Treat unavailable controls and rollout differences as structured results instead of guessing.

Start Work exactly once, then poll or steer the same task:

```js
const started = await chatgpt.work.start({
  prompt: "Produce a decision-ready implementation brief.",
  newTask: true,
  wait: false,
  read: false
});

const status = await chatgpt.work.status({ includeArtifacts: true });
await chatgpt.work.steer({
  prompt: "Add a prioritized migration sequence.",
  wait: false,
  read: false
});
const latest = await chatgpt.work.readLatest({ format: "markdown" });
```

`newTask` defaults to true. When an existing Work task is loaded and no unique new-task control can be verified, the SDK blocks instead of appending accidentally. Never resubmit a task after a partial or timeout result; use `work.status`, `work.wait`, or `work.readLatest`.

Use `chatgpt-delegate` for the focused surface-neutral delegation workflow. `chatgpt-pro-consult`, `mode`, and `modes.set/get` remain compatibility aliases for existing callers; new work should use `experience` and `configuration`.

## Common Workflows

Ask in a new or selected thread:

```js
await chatgpt.ask({
  prompt: "Reply with the word hi.",
  wait: true,
  read: { format: "markdown" }
});
```

Continue an existing thread:

```js
await chatgpt.askInThread({
  thread: { type: "url", url: "https://chatgpt.com/c/<conversation-id>" },
  existingTab: true,
  prompt: "Continue from the latest answer.",
  wait: true,
  read: { format: "markdown" }
});
```

Attach approved files:

```js
await chatgpt.askWithFiles({
  thread: { type: "new" },
  files: ["/absolute/path/to/approved-file.pdf"],
  prompt: "Summarize this file.",
  wait: true,
  read: { format: "markdown" },
  report: { enabled: true, includeContent: false }
});
```

Download an exact generated deliverable without accepting another visible
artifact as success:

```js
await chatgpt.askAndDownload({
  prompt: "Create report.csv and provide it as a downloadable file.",
  download: {
    destDir: "/absolute/output/dir",
    filenamePattern: "^report\\.csv$"
  },
  wait: true,
  read: true
});
```

`filenamePattern` is a case-insensitive regular expression. The runtime handles
both direct file links and current filename-button -> artifact-preview ->
Download flows. A mismatch blocks instead of silently accepting an unrelated
image fallback.

Run a diagnostic before long workflows:

```js
const diagnostic = await chatgpt.doctor({
  check: ["bridge", "login", "upload", "download", "clipboard"]
});
```

## Response Capture

Use Markdown by default for human-readable answers and saved artifacts:

```js
const latest = await chatgpt.messages.waitAndRead({
  role: "assistant",
  format: "markdown"
});
```

Use `format: "normalized_text"` only for compact assertions, polling checks, or simple exact-string smoke tests.

For long Chat, Work, Thinking, Deep Research, or file-backed answers, poll with `chatgpt.messages.wait({ responseContent: "metadata", ... })` or `chatgpt.work.wait(...)` so repeated partial polls return status metadata instead of re-emitting the growing answer body. Call the matching `readLatest({ format: "markdown" })` once completion is confirmed.

See `references/response-capture.md` for fidelity warnings and report handling.

## File Upload Permissions

In-app-browser file attachment uses its visible file chooser and Codex confirmation flow. Chrome fallback additionally needs two separate permission gates:

1. Chrome extension gate: open `chrome://extensions`, choose the Codex/browser bridge extension, open Details, and enable `Allow access to file URLs`.
2. Codex app gate: in Codex settings, allow Google Chrome uploads under `Computer Use > Google Chrome > Permissions > Uploads`.

If either gate is missing, stop with a permission blocker and tell the user which gate to check. See `references/file-uploads.md`.

## Blocker Handling

When a run fails, report the structured blocker. Do not retry blindly.

Common blockers:

- `browser_bridge_unavailable`: no bridge-enabled host runtime is available.
- `login_required`: the visible ChatGPT session is not signed in.
- `captcha`: user action is required.
- `permission`: upload/download/clipboard permission is missing.
- `selector_drift`: ChatGPT UI changed and selectors need review.
- `rate_limit`: wait or ask the user how to proceed.
- `needs_confirmation`: the workflow requires explicit user confirmation.

Browser-native deadlines terminate timed-out requests before return, but a
mutation may already have taken effect. For `stop_generation_unverified`,
inspect whether generation is still active and never retry Stop automatically.
For `attachment_outcome_indeterminate` or durable
`ambiguous_file_handoff`, inspect the current composer, do not submit, and
never repeat the attachment automatically.

There is one supervised exception for an operations request after the user
explicitly confirms the retry. Reuse the exact immutable request and operation
ID, keep the exact Project/Chat target, and call:

```js
const retry = await chatgpt.operations.submit(originalRequest, {
  confirmAttachmentRearm: true
});
```

This option is valid only for an uncertain operation whose original
`file_handoff` intent is unresolved. The runtime binds one replacement target,
restages the exact request, verifies read-only that the requested attachment
manifest is absent, and durably spends one rearm intent before the provider
handoff. If the original upload appears, it is accepted without another
handoff. If persistence or the provider result is indeterminate, every later
call is observation-only. Never create a new operation ID, fall back to global
Chat, change the request/files, or call `submit` again to poll; continue from
the returned handle with `operations.collect` or `operations.inspect`.

See `references/troubleshooting.md` before diagnosing selector, tab-claim, upload, or bridge issues.

## Validation

For source changes, run the smallest meaningful gate first. For shared SDK/protocol/plugin changes, broaden to:

```bash
cd packages/node
npm run build
npm run bundle
npm run bundle:backend
npm run bundle:live-smoke
npm run bundle:release-canary
npm run contract:validate
npm run parity:fixtures
npm run test:backend-conformance
npm test
```

Plugin packaging gates:

```bash
node scripts/build-plugin-runtime.mjs --root .
node scripts/check-plugin-runtime.mjs --root .
node scripts/validate-plugin-layout.mjs --root .
python3 /path/to/plugin-creator/scripts/validate_plugin.py plugins/codex-chatgpt-control
```

Use public-export validation before claiming the public plugin package is release-ready.

Run the reusable expansion canary through the installed candidate before
claiming Chat/Work support is live-qualified:

```bash
CHATGPT_E2E_SCENARIOS="chat-work-expansion" npm run smoke:live
```

The canary tests the Chat/Work round trip, both configuration graphs, strict
no-op configuration application, Work start/status/wait/read/steer/artifacts,
Work-backed Runner and Responses calls, and Chat restoration. A real Work
setting change is separate and opt-in; it restores the original effort in a
`finally` path:

```bash
CHATGPT_E2E_CONFIGURATION_MUTATION=1 \
CHATGPT_E2E_SCENARIOS="configuration-mutate-restore" \
npm run smoke:live
```

The packaged runtime also includes
`runtime/node/codex-chatgpt-control-release-canary.bundle.mjs`. Import it from a
bridge-hosted JavaScript call and run `runReleaseCanary(globalThis, { tabId })`
against an exact dedicated ChatGPT tab before publishing. It creates sanitized
Chat/Work profiles, exercises the expansion, mutates/restores Work effort,
verifies a generated CSV download, and restores Chat. Upload remains explicit
via `includeUpload: true`.

For locale drift, use the Node package's existing language loop with
`--auto-switch --all --capture-surfaces`; review the JSONL before using the
`--reviewed` apply gate.
