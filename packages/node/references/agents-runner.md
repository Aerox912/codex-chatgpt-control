# Agents Runner

`ChatGPTAgent` is a browser-control task profile for operating visible ChatGPT web. It is not an OpenAI API Agent, not a model instance, and not a hidden system-prompt container.

`instructions` are visible by default through `instructionsMode: "visible_prefix"`.

Use:

```ts
const chatgpt = createChatGPT({ agent: globalThis.agent });
const reviewer = chatgpt.agent({ name: "reviewer", instructions: "Review deeply." });
const plan = chatgpt.runner.plan(reviewer, {
  input: "Review this design.",
  thread: { type: "new" },
  experience: "chat"
});
const result = await chatgpt.runner.run(reviewer, {
  input: "Review this design.",
  thread: { type: "new" },
  experience: "chat",
  configuration: { intelligence: "Pro" }
});
```

`instructionsMode` controls how instructions are exposed to visible ChatGPT:

- `visible_prefix`: include instructions in the same submitted user message.
- `visible_setup_message`: submit instructions as a separate visible setup turn before the user request.
- `metadata_only`: keep instructions local; they are not sent to ChatGPT.

`runner.run()` returns a `ChatGPTRunResult` with `output_text`, `finalOutput`, `output`, `interruptions`, and `state`. Browser-control blockers are surfaced as resumable interruptions when the underlying command can be retried after user approval, login, or permission repair.

### Transactional runner opt-in

The runner remains on its existing workflow/sequence path unless the caller
supplies a canonical, caller-owned `operationId`:

```ts
const result = await chatgpt.runner.run(reviewer, {
  operationId: "123e4567-e89b-42d3-a456-426614174000",
  input: "Review this design.",
  thread: { type: "conversationId", conversationId: "conversation-id-from-the-caller" },
  response: { format: "markdown" }
});

// Transactional results carry the same operation identity and locator in data.
console.log(result.data?.operationId, result.data?.handle);
```

With an operation ID, the runner reuses the transactional Chat mapper: the
rendered agent instructions remain visible prompt text, target/configuration
precedence is preserved, and the caller receives operation identity in success,
partial, blocker, and structured error data. The transactional path rejects
`visible_setup_message` (it would require a separate setup turn) and `copy`
before browser use. Downloads/reports and unsupported wait/read fields remain
explicitly rejected rather than being silently emulated. Omit the ID to retain
legacy behavior byte-for-behavior.

With no custom operation seam, `createChatGPT()` installs lazy request-local
ChatGPT adapter factories. They still fail closed when the bridge, target
evidence, or required provider primitive is unavailable, and their presence is
not a live-capability claim. For durable recovery, persist the returned handle
and use inspect/collect on the same operation; never retry the runner with a new
ID after an uncertain Send. See [Transactional browser operations](2026-08-16-transactional-operations.md)
for the direct v1 surface and capability boundary.

`experience` and `configuration` are visible product preferences. When present,
the plan emits `experience.open` and strict `configuration.apply` steps before
the prompt. Successful results expose `experience.opened` and
`configuration.applied` milestone items. The legacy `mode` input remains
supported, but new callers should use the surface-aware fields. If both are
present, `configuration` takes precedence and the legacy `mode` request is not
executed.

For milestone streaming, call `chatgpt.runner.run(agent, input, { stream: true })` and iterate events before awaiting `stream.completed`. This is milestone streaming only, not token-delta streaming.

Do not pass API-only model controls such as `temperature`, `logprobs`, `seed`, or hidden system instructions.
