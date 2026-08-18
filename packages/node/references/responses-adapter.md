# Responses Adapter

`chatgpt.responses.create()` is a narrow convenience wrapper around visible ChatGPT browser control. It returns a Responses-shaped object with `object: "chatgpt.browser.response"`, but it is not the OpenAI Responses API and does not support hidden model controls.

Accepted fields:

- `input`
- `operationId` (TypeScript transactional opt-in; caller-owned canonical UUID)
- `thread`
- `existingTab`
- `preferExistingTab`
- `experience`
- `configuration`
- `attachments`
- `mode` (legacy compatibility)
- `tools`
- `text.format`
- `stream: false`
- `report`
- `instructions` only with `instructionsMode: "visible_prefix"`

Rejected API-only fields return `status: "unsupported"` before any prompt is submitted. The response includes `browser_control.unsupported[]` with `path`, `reason`, and `alternative`.

```ts
const response = await chatgpt.responses.create({
  operationId: "123e4567-e89b-42d3-a456-426614174000",
  input: "Summarize the latest plan.",
  thread: { type: "conversationId", conversationId: "abc-123" },
  experience: "chat",
  configuration: { intelligence: "High" },
  text: { format: "markdown" },
  stream: false
});
```

In the TypeScript adapter, supplying `operationId` selects the additive
transactional runner path and returns the operation ID and fresh handle in
`response.browser_control` when the mapper reaches the operation boundary.
Omitting it retains the legacy Responses/runner path. The transactional path
still accepts only visible-prefix instructions, rejects API-only fields before
browser use, and does not provide token-delta streaming. With no custom seam,
the client creates a lazy request-local ChatGPT adapter; it fails closed when
the bridge, target evidence, or required provider primitive is unavailable.
Use
[Transactional browser operations](2026-08-16-transactional-operations.md) for
submit/collect/inspect/control recovery and capability rules.

The Python `ResponsesClient` accepts the idiomatic `operation_id` alias and
returns the same operation ID and fresh handle in `browser_control`. It validates
transactional combinations before transport and never resubmits an accepted
operation.

`experience` and `configuration` represent visible product controls, not API
model selection. Configuration is strict through the runner plan and must
verify the visible postcondition. Existing callers may continue to pass
`mode`; new callers should prefer the surface-aware fields.

Use `chatgpt.runner.run()` for lower-level browser-control workflows, multi-step command planning, attachments, downloads, reports, and explicit interruption handling.
