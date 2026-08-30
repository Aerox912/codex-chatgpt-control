# Changelog

## 0.5.1-alpha.3

- Supports durable operation journals in processless Browser hosts without
  allowing another Node process to reclaim an opaque live lock, while retaining
  normal dead-process recovery where liveness probes are available.
- Keeps named workspace Projects authoritative on the transactional path,
  resolves exact Unicode labels within decorated Project rows, reconciles
  uncertain creation, and never degrades a failed Project route to global Chat.
- Detects Project Chat through the `New chat in <Project>` composer with the
  verified `project_chat_v1` profile and records host-facing browser kind
  independently from provider browser name.
- Exposes `operations.prepare()` before browser acquisition and projects
  creation, upload, and post-Send uncertainty as explicit resumable stages;
  same-ID recovery remains observation-only after a mutation boundary.
- Tracks the current compact Chat configuration state machine across Power,
  Select model, and verified GPT-5.5/GPT-5.6 Sol radio selection, including
  clipped menus and delayed menu closure.
- Guards missing Project ancestors before reading their text so selector drift
  reports promptly instead of waiting on a zero-match locator.
- Reconstructs source URLs from ChatGPT inline reference pills, accepts exact
  restored drafts without refilling, and clears stale pills before replacement.
- Adds the transactional `operations.submit`, `collect`, `inspect`, `control`,
  and `run` surface with durable request identity, monotonic mutation
  boundaries, exact ownership, non-repetition, and redacted recovery receipts.
- Adds capability-aware runtime identity, correlated multiplexed backend
  traffic, process-scoped tab coordination, bounded DOM/file/artifact
  observation, and deterministic configuration restoration.
- Hardens browser acquisition and attachment input scoping, acts-then-throws
  settlement, late deadline behavior, output path validation, journal quotas,
  lifecycle controls, and visible blocker classification.
- Extends release-canary coverage with exact per-scenario tab cleanup and
  independent Chat/Work/configuration postconditions; refreshes all four plugin
  runtime bundles from the qualified source.

## 0.5.1-alpha.2

- Adds confirmation-gated, fail-closed `messages.stop` lifecycle control with
  scoped DOM evidence and a single bounded deadline.
- Hardens uploads, explicit tab reuse, origin checks, localized selectors,
  blocker/mode visibility, and fixture generation against the validated PR
  review findings.
- Qualifies effort-only simplified Chat profiles and waits for delayed scoped
  artifact previews before selecting their exact Download control.
- Adds behavioral stop contracts, expanded regression coverage, rebuilt plugin
  runtimes, portable release helpers, and patched transitive dependency locks.

## 0.5.1-alpha.1

- Fixes current Chat/Work switching through the visible surface-radio group and
  preserves older selector fallbacks.
- Correctly identifies checked Work home state, active Work tasks, and the
  current compound Work configuration opener.
- Adds reusable live-smoke coverage for Chat/Work routing, strict configuration
  verification, Work start/status/wait/read/steer/artifacts, and Work-backed
  Runner and Responses paths.

## 0.5.0-alpha.1

- Adds `experience.detect/open`, `configuration.inspect/apply`, and the Work task lifecycle command group.
- Adds scoped Chat/Work selector profiles, strict configuration postcondition verification, and sanitized profile fixtures.
- Adds runner/Responses experience and configuration inputs plus milestone events.
- Preserves existing `mode`, `modes.set/get`, commands, package imports, and wire fields for backward compatibility.

## 0.3.0-alpha.1

- Hardens mode-menu detection and selection against thread/sidebar action menus, with locale-registry-backed thread-action vetoes and container-scoped menu enumeration.
- Adds the `modes.get` primitive and post-selection verification warnings on `modes.set`.
- Rewrites wait polling around a single combined DOM snapshot per poll; response text is fetched once at completion instead of every poll.
- Adds Windows and Linux clipboard capture with DOM fallback.
- Fixes report `createdAt` to honor the injected clock for deterministic fixtures.

## 0.2.0-alpha.1

- Adds Windows-safe host path validation and cross-platform backend gates.
- Adds localized ChatGPT selector support through the locale-label registry.
- Adds untrusted-output safety envelopes and integrity sidecar verification helpers.

## 0.1.0-alpha.1

- Initial public alpha package metadata and source layout.
