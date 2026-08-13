<!-- codex-workflow-id: viettran-edgeAI/codex_workflow -->
<!-- codex-workflow-managed-start -->
# AGENTS.md

## Project Context


## Design Principles

- Keep modules cohesive, interfaces explicit, coupling minimal, and behavior
  testable, replaceable, and reusable.
- Define proportionate acceptance and verification before implementation. Keep
  related tests cohesive; never weaken coverage, assertions, or failure
  visibility to save time or tokens.
- Preserve unrelated user work and use verified facts in durable documentation.

Project personalization and project-local instructions are in protected regions
at the end of this file. They override conflicting workflow defaults, but not
higher-level instructions.

## Working State

- `deployment state`: planning or executing a broad, possibly multi-session
  deployment plan.
- `leaf state`: work outside that plan, including general questions and small,
  bounded edits or operations.

## Project Documentation

The durable project documents are under `agent_docs/`:

- `project_overview.md`: goals, architecture, workflow, and major decisions.
- `project_core_tech.md`: concise special technology or architecture notes.
- `project_structure.md`: layout, modules, components, and ownership.
- `project_progress.md`: goal, overall progress, current position, next milestone.
- `project_diary.md`: lasting decisions, discarded approaches, and lessons.
- `latest_session_work.md`: detailed handoff evidence and continuation point.
- Module-specific documents, when present.

`project_progress.md` and `latest_session_work.md` may be edited only in
`deployment state` or when the user explicitly requests it. The main agent owns
them during normal execution. During automatic deployment closure, the single
`end_of_session` worker owns reconciliation of the complete documentation
framework; no other worker participates in that closure update.

Keep raw logs, temporary reasoning, and short-lived checkpoints out of durable
documents. Never delete a main project document without warning the user and
receiving a second explicit confirmation.

## Route Selection

There are three routes:

- **Light**: leaf-state work. The main agent works directly; no subagents.
- **Medium**: deployment-state work performed by the main agent. Explorer and
  the dedicated End-of-Session worker are the only subagent exceptions. Read
  `~/.codex/codex_workflow/medium_route.md`.
- **Heavy**: deployment-state work orchestrated through specialized workers.
  Read `~/.codex/codex_workflow/heavy_route.md`.

The user selects the route for the session. If unspecified, use Light; do not
infer Medium or Heavy. Light implies `leaf state`; Medium and Heavy imply
`deployment state` only for substantive work. Their direct fast path remains
`leaf state`. Keep the selected route until the user changes it or the session
ends.

## Context Loading

- In Light, inspect only material needed for the current task.
- Before initializing deployment state, classify the request. Questions and
  small or odd bounded tasks use the direct main-agent fast path even when
  Medium or Heavy is selected: call no worker, including Explorer and
  `end_of_session`, and produce no worker statistics.
- For every substantive Medium or Heavy deployment, read the selected route and
  `explorer_companion.md`, then initialize or reuse the single persistent
  Explorer.
- Give Explorer the session goal, known constraints, investigation questions,
  and boundaries. It reads the foundational project documents and relevant
  repository context, then returns the planning brief defined in its contract.
- In Medium, the main agent uses that brief to narrow its direct implementation
  inspection. In Heavy, Explorer is the default gateway for repository,
  architecture, dependency, and external research; the main agent normally
  consumes the brief rather than repeating discovery.
- The main agent may inspect any critical source or evidence, but should do so
  only when it materially affects a decision, resolves uncertainty or
  contradiction, or validates a high-risk integration boundary.
- Resolve stale or conflicting project status with targeted evidence. Load only
  relevant module documentation and avoid replaying raw logs, large diffs,
  directory listings, or complete source files into the main context.
- Before the final response that completes, pauses, or blocks each substantive
  Medium or Heavy deployment, run the automatic handoff defined in
  `end_of_session.md` exactly once. Its worker inherits recent main-agent
  context and performs the complete documentation-framework update. The
  handoff is not a user command.

## Platform Paths

Workflow documents use `/` as a platform-neutral separator. Translate paths to
the current operating system and shell when running filesystem commands.
<!-- codex-workflow-managed-end -->

<!-- codex-workflow-project-personalization-start -->
<!-- codex-workflow-project-personalization-end -->

<!-- codex-workflow-project-local-instructions-start -->
# codex-chatgpt-control Agent Instructions

## Public Repo Boundary

- This is a public alpha SDK for user-directed workflows in visible ChatGPT web
  sessions. Keep all guidance safe for public contributors.
- Do not add private OpenAI account details, cookies, tokens, internal browser
  bridge state, unpublished package credentials, or private run transcripts to
  the repo.
- This project is unofficial. Do not phrase docs, package metadata, or examples
  as if the project is endorsed by OpenAI.

## Architecture

- The Node package is the runtime authority for browser control, backend
  commands, live-smoke orchestration, safety redaction, and contract fixtures.
- The Python package is a parity client over the same backend protocol. It
  should not diverge into a separate browser automation implementation.
- Shared behavior changes must update contracts, fixtures, docs, examples, and
  both language surfaces when applicable.

## Safety Model

- Keep the visible-session boundary: this is not a scraping framework, private
  ChatGPT API wrapper, background automation service, or bulk extraction tool.
- Live browser tests can touch a real user session. Run them only when the user
  asks for live validation or when the task clearly requires it.
- Redact prompts, responses, filenames, account identifiers, and local paths in
  reports unless the user explicitly wants a local private artifact.

## Local Commands

From the repository root:

```bash
npm run node:test
npm run node:build
npm run node:bundle
npm run node:contracts
npm run python:test
npm run python:compile
npm run release:check-version
npm run release:check-names
npm run release:check-node-pack
```

For Node package work:

```bash
cd packages/node
npm test
npm run build
npm run bundle
npm run bundle:backend
npm run contract:validate
npm run docs:drift
npm run parity:fixtures
npm run parity:suite
npm run test:backend-conformance
```

For Python package work:

```bash
cd packages/python
python -m pip install -e ".[dev]"
python -m unittest discover -s tests
python -m compileall -q src examples
```

## Definition Of Done

- The narrow visible-session safety model is preserved.
- Node/Python parity has been checked for API, protocol, fixture, and docs
  changes.
- The smallest meaningful tests pass, and broader contract/parity gates pass
  for shared behavior changes.
- Any live-smoke blocker is reported as a blocker path, not papered over with
  cached or unrelated browser evidence.
<!-- codex-workflow-project-local-instructions-end -->
