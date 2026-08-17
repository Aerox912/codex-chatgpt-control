---
title: Transactional browser operations
date: 2026-08-16
type: reference
status: preview
---

# Transactional browser operations (v1)

This is the canonical reference for the additive transactional operation
surface. It describes the versioned request/result contract, the TypeScript
and Python facades, and the boundary between the new operation path and the
existing browser-control primitives.

## Status and current boundary

The v1 journal, strict wire validators, recovery state machine, browser-adapter
seams, Node backend commands, and direct Python sync/async clients are present
in the source tree. This is a preview contract, not a claim that every
provider/browser primitive is live.

In the current source, `createChatGPT()` opens the operation journal lazily.
`chatgpt.operations.inspect(handle)` is deliberately browser-free and can
inspect an authenticated local record. When no custom operation seam is
supplied, browser-touching `submit`, non-terminal `collect`, and `control` use
lazy request-local ChatGPT factories. Browser attachment happens only after
the journal has accepted the operation; recovery attaches by the authenticated
durable tab ID and never falls back to the selected tab. Missing bridge access,
target evidence, or a required provider primitive fails closed instead of
routing through the legacy command sequence. Supplying any custom adapter seam
is an all-or-nothing integration choice so a custom provider is never combined
with part of the default recovery path. The current ordinary backend capability
response still advertises no stable provider/browser/tab identity,
authoritative tab claim, fencing, or concurrent-tab guarantee.

Therefore:

- Contract, validation, journal, and browser-free inspection claims are
  deterministic source/test claims.
- A live submit/collect/control claim requires a bridge-enabled default runtime
  or a complete custom adapter, an authorized page, target evidence, and the
  provider primitives needed by that operation, followed by the relevant live
  smoke.
- A browser bridge blocker, unavailable primitive, missing target evidence, or
  runtime mismatch is a structured boundary result; it is not evidence that
  ChatGPT itself is unavailable.

The authenticated journal records a complete redacted ownership baseline
before each non-repeatable Send or Work-steer intent. New records retain these
in `ownershipBaselines[actionId]`; `ownershipBaseline` remains the compatibility
projection of the original Send. Only after the exact post-action user-turn
delta has been observed does the journal append the immutable keyed witness in
`submissionWitnesses[actionId]`; `submissionWitness` likewise remains the
original-Send compatibility projection. Each witness contains action/target
identities and digests, never prompt text, DOM, response text, URLs, or local
paths. A satisfied Work steer requires its exact baseline+witness pair, a clean
non-mutating `not_satisfied` steer retains its baseline but has no witness, and
an unresolved/uncertain steer blocks a later steer. Collection authenticates
and classifies against the latest satisfied causal action rather than silently
falling back to the original Send. A durable witness carries
`baselineSnapshotDigest`, the digest of its complete pre-action ownership
snapshot, alongside the post-action delta digest. The state reducer, service,
collector, and Python model require that value to equal the keyed durable
baseline; a witness cannot be replayed against a different action or baseline.
A legacy target-establishment
projection may be read without `postSendDeltaDigest`, but that record cannot
establish a new target or prove submitted ownership; every newly emitted
submission witness and target-establishment event must carry its required
causal evidence.

There is intentionally no permissive migration from a proof-less experimental
snapshot into `submitted`, `generating`, `capturing`, or `completed`. Those
phases require both keyed records for the original Send. A snapshot that only
has the compatibility projections fails closed and must be inspected or
explicitly discarded by its owner; the runtime cannot reconstruct a pre-Send
baseline or post-Send delta after the fact.

## Identity model

There are several intentionally different identities:

| Identity | Owner and purpose | Safe to persist/echo? |
| --- | --- | --- |
| `operationId` | Caller-owned canonical UUID. It names one immutable logical operation and opts high-level helpers into this path. | Yes, as an opaque identity. Never generate a replacement when recovering. |
| `requestDigest` | Journal-keyed digest of the canonical request plus file manifest. It detects a changed retry. | Yes, as a digest; not as a substitute for the request. |
| `handle` | Fresh locator containing operation identity, digest, surface, revision, phase, mutation boundary, and optional target-binding digest. | Yes, as a versioned locator. It is not an authority token. |
| transport `requestId` | Backend connection identity used to demultiplex one NDJSON call. | Diagnostic only; it is not operation identity. |
| `backendSessionId` | Runtime/backend owner identity used by coordination and capability diagnostics. | Diagnostic only. |
| target binding | Authenticated provider/browser/tab/thread evidence bound to the journal record. | Persist only in its redacted/digest form defined by the contract. |

The caller owns `operationId` and must reuse it for a retry or recovery. A
different prompt, target, configuration, or file manifest under the same ID
does not create a second operation: the journal returns an identity mismatch.
The journal and action-intent CAS rules make a repeated same-ID submit
observation/recovery path unable to activate Send twice.

The TypeScript journal remains the runtime authority for request-digest
computation. Its digest primitive is
`HMAC-SHA-256(key, UTF8(domain + "\0" + canonicalJson(value)))`, returned with
the `hmac-sha256:` prefix. Every operation and journal domain uses the stable
`codex-chatgpt-control/.../v1` namespace in both private-source and exported
public builds; package-name rewriting must never alter persisted identity.
Canonical JSON sorts object keys lexicographically,
retains array order, normalizes negative zero, uses explicit internal markers
for `undefined`, dates, and bytes, and rejects caller objects containing those
reserved marker keys. The request projection binds schema/operation/surface,
target, keyed prompt digest plus UTF-8 length, configuration/tools, ordered
keyed file-name/content digests plus byte counts, path-free capture policy, and
behavior. `capturePolicy.outputDirectory` is intentionally excluded because a
separate transfer action binds destination authority. The privacy-safe fixed-key
golden vector at
`contracts/v1/vectors/operation-request-digest-v1.json` freezes the canonical
bytes, nested domains, and final digest. Node computes it in production; Node
and a test-only Python reference both verify the same vector so the Python
facade does not become a second runtime authority.

## Canonical direct surface

The backend wire commands are exactly:

- `operations.submit`
- `operations.collect`
- `operations.inspect`
- `operations.control`

`operations.run` is an SDK-only composition of one `submit` followed by at
most one `collect`; it is not a fifth backend command and must not be treated
as an independently idempotent provider primitive.

### Submit request

The request is strict JSON. Optional properties are omitted rather than sent
as `null`.

```ts
const request = {
  schemaVersion: "chatgpt.browser_control.operation_request.v1",
  operationId: "123e4567-e89b-42d3-a456-426614174000", // caller-owned UUID
  surface: "chat",
  prompt: "Summarize the visible thread.",
  target: {
    type: "conversation_id",
    conversationId: "conversation-id-from-the-caller"
  },
  configuration: {
    experience: "chat",
    modelVersion: "visible-version-label",
    reasoning: "high",
    tools: ["web_search"]
  },
  capture: {
    responseContent: "metadata",
    responseFormat: "markdown",
    artifacts: "receipt_only"
  }
};

// The default client captures the visible ChatGPT runtime lazily after the
// journal accepts the operation. A custom adapter configuration must provide
// the complete submit/recovery/control set; missing proof still fails closed.
const submitted = await chatgpt.operations.submit(request);
```

`surface` is `chat` or `work`. The target is one of `{ type: "new" }`,
`{ type: "selected_tab" }`, `{ type: "tab_id", tabId }`,
`{ type: "conversation_id", conversationId }`, or
`{ type: "url", url }`. `files` contains request-only absolute host-local
paths; the operation client fingerprints and revalidates them before a file
handoff. `capture.responseContent` is `include` or `metadata`; artifact
capture is `receipt_only` or `transfer`, with an explicit request-only
`outputDirectory` required for transfer.

`capture.responseFormat` is an immutable request-identity field and accepts
only `markdown` (the default) or `text`. `markdown` is reconstructed from
semantic DOM structure for the exact owned assistant turn; `text` is the
formatter's normalized visible text. The bounded transient `innerHTML` used
for that one exact turn is formatted immediately and is never written to the
journal, durable receipt, snapshot, or report. Collection fails closed when
the requested format, exact assistant ID, provider shape, or content bounds
cannot be proven.

Once a request is created, its capture contract is copied into the
path-free `capturePolicy` field on the `operation_created` event and materialized
state. The durable shape is exactly `{ responseContent, responseFormat,
artifacts }`; `responseFormat` defaults to `markdown`, omitted capture defaults
to `include` plus `receipt_only`, and request-local `outputDirectory` is never
persisted. A restart therefore retains an `artifacts: "transfer"` obligation
even when the original destination is unavailable; recovery must not silently
rewrite it to `receipt_only`.

In the TypeScript in-process facade, `submit` returns a fresh `handle` plus a
service-native submission result. `submission.kind` is one of the explicit
submitted/already-submitted/completed-receipt/blocked/uncertain/cancelled
outcomes. The backend and Python facades convert this to the strict
`operation_submit_result.v1` envelope:

- `accepted`: submission was reconciled or was already durably submitted; it
  is not completion.
- `completed`: a durable receipt is already available.
- `blocked`: the mutation boundary is known not to have crossed.
- `uncertain`: a handoff or Send may have crossed a non-repeatable boundary;
  observe/recover, do not resubmit.

### Collect and inspect

Always carry forward the freshest returned handle. `inspect` reads the
authenticated journal and does not use a browser. `collect` addresses only the
operation-owned assistant turn; it never falls back to “latest response” or
submits a prompt. A backend/Python flow is shaped like this:

```python
from codex_chatgpt_control import ChatGPT

# backend is an already-configured BackendClient or compatible test double.
chatgpt = ChatGPT(backend=backend)
submitted = chatgpt.operations.submit(
    operation_id="123e4567-e89b-42d3-a456-426614174000",
    surface="chat",
    prompt="Summarize the visible thread.",
    target={"type": "conversation_id", "conversationId": "conversation-id-from-the-caller"},
    capture={"responseContent": "metadata", "responseFormat": "markdown", "artifacts": "receipt_only"},
)

handle = submitted.handle
if submitted.status == "accepted":
    inspected = chatgpt.operations.inspect(handle=handle)
    collected = chatgpt.operations.collect(
        handle=inspected.handle,
        wait=False,
        response_content="metadata",
    )
    print(collected.status)  # completed, pending, blocked, or uncertain
```

The versioned wire envelopes carry `operationId`, `requestDigest`, and a fresh
handle on every result. Completed results carry a durable receipt. Blocked or
uncertain results carry a redacted blocker with phase and mutation boundary.
An included raw response is a separately marked ephemeral `liveResponse`; it
is not part of durable state or a receipt.

`inspect` reports `completed`, `pending`, or `uncertain` from the durable phase.
`collect` reports `completed`, `pending`, `blocked`, or `uncertain`.
`control` reports `completed`, `blocked`, or `uncertain` and is covered below.

### Control

`control` is operation-bound and requires a fresh generating parent handle, an
exact assistant turn ID, and a caller-owned `controlActionId`. Its action is
`stop` or `steer`; it does not accept a generic “latest” target. Control has
its own action digest but returns the parent operation identity and a fresh
parent handle. A failed or uncertain control result is never an instruction
to repeat Stop/steer automatically.

## Recovery and retry rules

The safe recovery loop is:

1. Persist the latest redacted handle and the caller-owned `operationId` in the
   caller's own recovery record.
2. Call `inspect` after a timeout, process restart, or lost response.
3. If the operation is not terminal, call `collect` with that handle to observe
   the owned turn. Use `responseContent: "metadata"` while polling when raw
   text is not needed.
4. For an uncertain handoff or Send, inspect the visible target/postcondition
   and reconcile the durable action intent. Do not call `submit` again with a
   new ID or a changed request.
5. Use `control` only with the exact current generating handle and assistant
   turn ID, after an explicit caller decision.

Handles are locators, not bearer authority. After a restart, a configured
`handleAdapterFactory` must rebuild a target-bound adapter only after the
journal authenticates the handle. If stable target evidence, page affinity,
or an authoritative provider claim cannot be proven, the result must remain a
blocker/uncertain outcome. A handle does not authorize taking over another
tab, conversation, or user's turn.

## High-level opt-in behavior

The legacy path remains the compatibility boundary. TypeScript high-level
helpers select the transactional mapper only when a caller supplies a
canonical `operationId`; with no ID they retain the existing workflow/runner
sequence. Unsupported transactional fields are rejected before browser use,
and the result carries the supplied operation ID in success, blocker, partial,
or structured error data.

| Surface | With caller-owned `operationId` | Without it / current limitation |
| --- | --- | --- |
| `chatgpt.ask`, `askInThread`, `askWithFiles` | One transactional submit/collect composition. Target must be explicit enough for the mapper; response capture is metadata or Markdown/text. | Existing workflow sequence, unchanged compatibility behavior. |
| `askAndDownload` | Download is rejected before browser use; collect the operation and use an explicit artifact-transfer operation when that adapter is available. | Existing download workflow remains available. |
| `runner.run` | Same transactional mapper as Chat. Agent instructions use the rendered visible prompt semantics; `visible_setup_message` and `copy` are rejected because they require additional/legacy turns. Stream events remain milestones only. | Existing runner plan/sequence behavior. |
| `responses.create` (TypeScript) | `operationId` opts into the same runner mapper. `instructions` are visible-prefix text only; API-only fields remain unsupported; operation ID and handle are returned in `browser_control`. | Existing narrow Responses-shaped runner adapter. |
| `work.start` (TypeScript) | Uses `surface: "work"`, returns operation ID/handle and exact owned-turn state. Wait/read is collect-only; unsupported configuration/wait fields fail before browser use. | Existing Work command path. |
| `work.steer` (TypeScript) | Requires the generating Work handle, matching operation ID, control action ID, and exact assistant turn ID; the parent operation is never resubmitted. | Existing Work steer primitive. |
| Python `chatgpt.operations` | Direct sync/async v1 envelopes and field aliases are parity facades over the shared Node backend. Python Runner/Responses also use this facade when given `operation_id`. | Calls without an operation ID retain the legacy Python runner/Responses paths. |

The current transactional mapper intentionally does not claim support for
`visible_setup_message`, copy/download/report side effects, arbitrary API model
controls, title/history search targets, or wait semantics that are not tied to
the owned turn. Rejections are input results, not browser attempts.

## Work, Runner, and Responses semantics

Rendered agent instructions remain visible prompt content. The transactional
runner does not turn them into hidden system messages and does not change the
legacy rendering/precedence rules for target, configuration, wait, or read
values. It does not promise token deltas: all runner streaming is milestone
streaming (`message.in_progress`, `message.completed`, and related setup or
blocker milestones).

Work start is a single operation on the Work surface. A `read` request means
“collect this operation-owned turn”, not “read whichever response is latest”.
Work steer is a separate operation-bound control action. It cannot combine
steer with a second wait/read request, and it must not be used to submit the
original Work prompt again.

The TypeScript and Python Responses adapters accept a caller-owned operation ID
(`operationId` / `operation_id`) and route it through the same one-submit,
at-most-one-collect mapper. Both preserve operation identity and the fresh
handle in their browser-control metadata; malformed or API-only combinations
are rejected before backend traffic, and an accepted operation is never
resubmitted internally.

Direct collect calls and high-level transactional waits may set a bounded
`pollIntervalMs` (`poll_interval_ms` in Python; Runner wait objects also accept
the documented poll aliases). It affects only the sleep between observation
attempts, accepts integers from `0` through `60000`, and does not hold the
browser/tab coordinator while sleeping.

## Per-tab and shared-browser coordination

The coordinator is deliberately short-lived at the browser boundary:

- One target binding captures one explicit page and stable provider/browser/tab
  evidence. Every read or mutation re-checks page/target affinity before acting.
- A short page transaction acquires a process-local tab actor when stable
  provider/browser/tab identities and concurrent-tab capability are proven.
  An authoritative claim/fencing token additionally upgrades that binding to
  provider coordination scope; it is not fabricated as a prerequisite for
  safe coordination among cooperating callers in this one process.
- If those capabilities are absent or downgraded, the resource scope is the
  process-local browser actor. The implementation must not infer safe
  per-tab concurrency from an unverified tab label.
- Hashing/revalidation, journal I/O, report work, polling, and sleeps occur
  outside the coordinator actor. A long ChatGPT generation therefore does not
  hold the tab/browser scheduler lock.
- A deadline or cancellation quarantines an in-flight callback until it
  settles; callers must not start a duplicate non-repeatable action merely
  because the host request returned.
- The process-local coordinator only coordinates cooperating callers in one
  process. It is not a provider-level or cross-process fencing guarantee.

The public package exports `createProcessTabCoordinator`/`ProcessTabCoordinator`
and `createOperationRuntimeContext`/`OperationRuntimeContext` because the
public browser-adapter options accept injected coordinator and runtime-context
instances. Integrations should inject these only with provider evidence that
matches the negotiated identity and concurrency capabilities.

The current default backend advertises `tabs.coordinationScope: "none"` and
`tabs.concurrentTabs: false`. A future/provider-backed integration may
advertise stronger capabilities, but callers must check the negotiated
`backend.hello`/`backend.capabilities` result and retain the conservative
scope when identity or fencing is unavailable. Concurrent operations against a
shared browser are not categorically forbidden; they are allowed only where
the provider capability and target-binding evidence prove that the distinct
tab actors are safe.

## Version and capability checks

Before relying on an operation or concurrency guarantee, negotiate the backend
identity/capabilities. Check at least:

- `protocolVersion` and `supportedProtocolVersions`;
- the four `operations.*` command names;
- package/runtime/build identity (`packageVersion`, `runtimeVersion`,
  `buildDigest`), retaining `unknown` as unknown rather than guessing;
- request IDs, multiplexing, and cancellation claims; and
- `tabs` identity, coordination scope, authoritative claim/fencing, and
  `concurrentTabs`.

A package/runtime/build value that is old or unknown is a warning for
  diagnostics and deployment policy. It is not proof of incompatibility. A
  proven protocol mismatch, unsupported required command, failed capability
  intersection, or an adapter that cannot satisfy target/page affinity is a
  blocker (`runtime_incompatible`, `backend_unavailable`, or the more specific
  target blocker). Do not turn a version warning into a live-support claim.

## Bounded transport and artifact I/O

Multiplexing does not mean unbounded buffering. Node and Python persistent
clients bound each stream by event count and encoded UTF-8 bytes, isolate an
overflow to that correlated route, and retain bounded tombstones for expected
late terminal records. The Node client additionally bounds aggregate queued
stdin frames by count and bytes. A queued request is re-authorized immediately
before its frame is written; cancellation before that point prevents the late
write. A started stdin write that never settles forces process teardown, and a
second unresolved write generation fails closed rather than accumulating
unbounded promise chains.

Operation artifact transfer is streaming and holds only a bounded provider
chunk plus filesystem buffers. Provider `open`, `next`, and `return` calls have
hard request/deadline boundaries and a 30-second internal fallback when the
caller supplies no shorter bound. Late settlements are observed but never
retried. One provider chunk is limited to 8 MiB and one artifact to 65,536
chunks; the built-in 64 KiB adapters need at most 8,192 chunks for the 512 MiB
artifact ceiling. This admits an immediately terminal empty artifact while an
infinite sequence of empty/tiny chunks fails closed. Local output uses a
restrictive operation-owned temporary file, hashes while writing, syncs before
exclusive installation, and never overwrites an unrelated destination.

The transactional artifact provider has a stricter capability boundary than
the legacy download helpers. Browser-backed enumeration and acquisition require
a bounded `page.evaluate` implementation plus a causal download-event waiter.
For bytes, `DownloadLike.createReadStream()` is preferred. A completed local
`path()` is accepted only when it names an absolute regular file that can be
opened with `O_NOFOLLOW`, retained by file descriptor, and proven to keep the
same file identity and bounded size. A provider exposing only `saveAs(path)` is
rejected without calling it: pure Node cannot prevent that pathname capability
from being redirected after validation. Custom adapters must implement these
operation capabilities explicitly; support for legacy `saveAs()` elsewhere in
the SDK does not imply transactional artifact-transfer support.

## Privacy, retention, and redaction

The operation boundary is designed so durable state contains identities,
digests, counts, phases, action intents/receipts, redacted blockers, target
evidence, and artifact metadata—not raw prompts, local input paths, or raw
assistant text. Request-only paths are replaced by bounded placeholders before
the service persists a request. File contents are fingerprinted locally and
revalidated before handoff; hashes are diagnostics, not content transfer.

The local journal is authenticated and append-only in normal operation, uses a
state-root key and restricted local file permissions, and defaults to a 64 MiB
state quota. Quota admission also has fixed fail-closed scan ceilings of 65,536
directory entries and 256 MiB of observed file data. Exceeding the configured
state quota returns `journal_quota_exceeded`; exceeding either hard scan ceiling
returns `journal_scan_limit`. Neither condition deletes unresolved or terminal
deduplication evidence automatically. Completed receipts may be compacted;
explicit pruning leaves an
authenticated tombstone so expiry is distinguishable from “not found”. These
are local retention mechanisms, not a promise of indefinite history. Raw
response text, when requested, is an explicitly ephemeral value and is never a
durable receipt. Keep live reports, prompts, responses, paths, account data,
and credentials out of public fixtures and durable docs.

## Compatibility boundary

The existing `ask`, `runner`, Work, Responses, message, attachment, download,
and report primitives are still supported where documented. The transactional
surface is additive and does not silently rewrite callers that omit
`operationId`. Legacy primitives do not acquire operation journaling,
submit-once recovery, operation handles, or cross-process concurrency merely
because the same client also exposes `chatgpt.operations`.

Use the direct v1 surface when the caller needs durable identity, exact target
ownership, inspect/collect recovery, or an auditable mutation boundary. Use
the legacy surface when its broader visible workflow semantics are required
and the caller accepts the legacy retry/timeout boundary. Do not mix the two
paths for one logical Send unless the caller has an explicit, reviewed bridge
between their identities.
