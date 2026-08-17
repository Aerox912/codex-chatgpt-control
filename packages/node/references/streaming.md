# Runner Streaming

`chatgpt.runner.run(agent, input, { stream: true })` returns an async iterable of runner milestone events plus a `completed` promise.

```ts
const stream = chatgpt.runner.run(agent, "Reply with hi", { stream: true });

for await (const event of stream) {
  console.log(event.name, event.item.type);
}

const result = await stream.completed;
```

This is not token streaming. Events are emitted for browser-control milestones such as `message_submitted`, `message_completed`, `file_attached`, and `run_blocked`. Do not expect token deltas or OpenAI API stream event parity.

Supplying a caller-owned `operationId` opts the runner into the transactional
submit/collect mapper, but does not change this stream contract. Polling and
long waits belong to operation collection outside short page transactions; use
the returned handle with `operations.inspect`/`operations.collect` for exact
turn recovery. See [Transactional browser operations](2026-08-16-transactional-operations.md).
