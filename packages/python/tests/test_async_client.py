import asyncio
import copy
import json
import threading
import time
import unittest
from collections.abc import Iterator, Mapping
from pathlib import Path

from codex_chatgpt_control.async_client import (
    AsyncChatGPT,
    AsyncRunResultStreaming,
    _ACTIVE_ASYNC_EXECUTION,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"
# Windows' default event-loop clock commonly advances in roughly 15.6 ms
# increments. Keep timeout-path tests short, but comfortably above one tick so
# a successful retry is not mistaken for a hung close on that platform.
TEST_CLOSE_TIMEOUT_SECONDS = 0.1


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class FakeAsyncBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.stream_requests: list[tuple[str, dict]] = []

    async def request(self, command: str, payload: dict | None = None):
        payload = payload or {}
        self.requests.append((command, payload))
        if command == "runner.run":
            return run_result(payload["agent"]["name"], "async-ok")
        if command == "runner.plan":
            return {
                "name": f"agent-run:{payload['agent']['name']}",
                "steps": [{"id": "ask", "command": "messages.ask", "args": {"text": payload["input"]}}],
            }
        if command == "responses.create":
            return {
                "id": "chatgpt-browser-async",
                "object": "chatgpt.browser.response",
                "created_at": 1780704000,
                "status": "ok",
                "output_text": "async-response",
                "output": [],
                "browser_control": {"visibleUi": True, "resultStatus": "ok"},
            }
        if command == "commands":
            return [{
                "name": "runner.run",
                "layer": "workflow",
                "summary": "Run agent.",
                "risk": "medium",
                "args": {},
                "defaults": {},
                "retryPolicy": "retry-safe",
                "blockers": [],
                "examples": [],
            }]
        if command == "describe":
            return {
                "name": payload["name"],
                "layer": "workflow",
                "summary": "Describe command.",
                "risk": "medium",
                "args": {},
                "defaults": {},
                "retryPolicy": "retry-safe",
                "blockers": [],
                "examples": [],
            }
        if command == "help":
            return "help text"
        return command_result({"command": command, "payload": payload})

    async def stream(self, command: str, payload: dict | None = None):
        payload = payload or {}
        self.stream_requests.append((command, payload))
        yield {
            "schemaVersion": "chatgpt.browser_control.backend_event.v1",
            "type": "run_item_stream_event",
            "name": "message_completed",
            "item": {"type": "message.completed"},
        }
        yield {
            "schemaVersion": "chatgpt.browser_control.backend_event.v1",
            "type": "completed",
            "result": run_result(payload["agent"]["name"], "stream-ok"),
        }


class FakeLegacyAsyncTransport:
    def __init__(self) -> None:
        self.requests = []

    async def run(self, payload: dict) -> dict:
        self.requests.append(payload)
        return run_result(payload["agent"]["name"], "legacy-ok")


class FakeAsyncOperationBackend:
    def __init__(self, responses: dict[str, dict]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict]] = []

    async def request(self, command: str, payload: dict | None = None):
        self.requests.append((command, copy.deepcopy(payload or {})))
        await asyncio.sleep(0)
        return copy.deepcopy(self.responses[command])


class CloseFenceBackend(FakeAsyncBackend):
    def __init__(self) -> None:
        super().__init__()
        self.close_started = asyncio.Event()
        self.release_close = asyncio.Event()

    async def close(self) -> None:
        self.close_started.set()
        await self.release_close.wait()


class NativeContextBackend(FakeAsyncBackend):
    def __init__(self) -> None:
        super().__init__()
        self.execution_seen = None

    async def request(self, command: str, payload: dict | None = None):
        self.execution_seen = _ACTIVE_ASYNC_EXECUTION.get()
        return await super().request(command, payload)


class AwaitableReturningCloseBackend(FakeAsyncBackend):
    def __init__(self) -> None:
        super().__init__()
        self.close_calls = 0
        self.first_close_started = asyncio.Event()
        self.closed = False

    def close(self):
        self.close_calls += 1

        async def finish() -> None:
            if self.close_calls == 1:
                self.first_close_started.set()
                await asyncio.Event().wait()
            self.closed = True

        return finish()


class HostileAsyncKey:
    def __hash__(self) -> int:
        raise TypeError("caller-controlled key must not be hashed")

    def __str__(self) -> str:
        raise AssertionError("caller-controlled key must not be rendered")

    def __repr__(self) -> str:
        raise AssertionError("caller-controlled key must not be represented")


class HostileAsyncMapping(Mapping[object, object]):
    def __init__(self) -> None:
        self._entries = (
            ("input", "visible request"),
            (HostileAsyncKey(), {"private": "do not disclose"}),
        )

    def __getitem__(self, key: object) -> object:
        for candidate, value in self._entries:
            if key is candidate or (type(key) is str and type(candidate) is str and key == candidate):
                return value
        raise KeyError

    def __iter__(self) -> Iterator[object]:
        return (key for key, _value in self._entries)

    def __len__(self) -> int:
        return len(self._entries)


class HostileAsyncTextDict(Mapping[object, object]):
    def __init__(self) -> None:
        self._key = HostileAsyncKey()

    def __getitem__(self, key: object) -> object:
        if key is self._key:
            return "do not disclose"
        raise KeyError

    def __iter__(self) -> Iterator[object]:
        yield self._key

    def __len__(self) -> int:
        return 1


class ExplodingAsyncMapping(Mapping[object, object]):
    def __getitem__(self, key: object) -> object:
        raise RuntimeError("private mapping state must not escape")

    def __iter__(self) -> Iterator[object]:
        raise RuntimeError("private mapping state must not escape")

    def __len__(self) -> int:
        return 1


class AsyncClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_runner_uses_backend_protocol_request(self) -> None:
        backend = FakeAsyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)
        agent = chatgpt.agent(name="reviewer", instructions="Review deeply.")

        result = await chatgpt.runner.run(agent, input="hi")

        self.assertEqual(result.final_output, "async-ok")
        self.assertEqual(backend.requests[0][0], "runner.run")
        self.assertEqual(backend.requests[0][1]["agent"]["kind"], "chatgpt_browser_agent")
        self.assertEqual(backend.requests[0][1]["input"], "hi")

    async def test_async_runner_plan_and_stream_use_backend_protocol(self) -> None:
        backend = FakeAsyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)
        agent = chatgpt.agent(name="planner")

        plan = await chatgpt.runner.plan(agent, "draft")
        stream = chatgpt.runner.run_streamed(agent, "hi")
        events = [event async for event in stream]

        self.assertEqual(plan.name, "agent-run:planner")
        self.assertEqual(backend.requests[0][0], "runner.plan")
        self.assertEqual(backend.stream_requests[0][0], "runner.stream")
        self.assertEqual(events[0].name, "message_completed")
        self.assertIsNotNone(stream.final_result)
        assert stream.final_result is not None
        self.assertEqual(stream.final_result.final_output, "stream-ok")

    async def test_async_responses_create_uses_backend_protocol(self) -> None:
        backend = FakeAsyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)

        response = await chatgpt.responses.create(
            {
                "input": "hi",
                "thread": {"type": "new"},
                "text": {"format": "normalized_text"},
                "stream": False,
            }
        )

        self.assertEqual(response.object, "chatgpt.browser.response")
        self.assertEqual(response.status, "ok")
        self.assertEqual(response.output_text, "async-response")
        self.assertEqual(backend.requests[0][0], "responses.create")

    async def test_async_responses_keyword_aliases_are_normalized_before_transport(self) -> None:
        backend = FakeAsyncBackend()

        response = await AsyncChatGPT(backend).responses.create(
            input="hi",
            existing_tab=True,
            prefer_existing_tab=True,
        )

        self.assertEqual(response.status, "ok")
        self.assertEqual(backend.requests[0][1]["existingTab"], True)
        self.assertEqual(backend.requests[0][1]["preferExistingTab"], True)

    async def test_async_responses_merges_args_before_normalizing_aliases_like_sync(self) -> None:
        backend = FakeAsyncBackend()

        response = await AsyncChatGPT(backend).responses.create(
            {"input": "hi", "existingTab": False},
            existing_tab=True,
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "existing_tab")
        self.assertEqual(backend.requests, [])

    async def test_async_responses_unsupported_fields_do_not_submit(self) -> None:
        backend = FakeAsyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)

        response = await chatgpt.responses.create({"input": "hi", "temperature": 0.2})

        self.assertEqual(response.status, "unsupported")
        self.assertEqual([field["path"] for field in response.unsupported_fields], ["temperature"])
        self.assertEqual(backend.requests, [])

    async def test_async_responses_hostile_mapping_uses_safe_marker_without_transport(self) -> None:
        backend = FakeAsyncBackend()
        response = await AsyncChatGPT(backend).responses.create(HostileAsyncMapping())

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "<invalid-field>")
        self.assertNotIn("private", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    async def test_async_responses_hostile_text_key_uses_nested_safe_marker(self) -> None:
        backend = FakeAsyncBackend()
        response = await AsyncChatGPT(backend).responses.create(
            input="Do not send.",
            text=HostileAsyncTextDict(),
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "text.<invalid-field>")
        self.assertNotIn("do not disclose", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    async def test_async_responses_hostile_mapping_iterator_is_structured(self) -> None:
        backend = FakeAsyncBackend()
        response = await AsyncChatGPT(backend).responses.create(ExplodingAsyncMapping())

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "<invalid-field>")
        self.assertNotIn("private mapping state", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    async def test_async_workflows_primitives_reports_and_commands_use_backend_protocol(self) -> None:
        backend = FakeAsyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)

        ask = await chatgpt.ask(prompt="hi")
        bootstrap = await chatgpt.session.bootstrap(prefer_existing_tab=False)
        experience = await chatgpt.experience.detect()
        opened = await chatgpt.experience.open(experience="work")
        configuration = await chatgpt.configuration.apply(
            experience="work",
            desired={"model": "GPT-5.6 Sol", "model_version": "5.6"},
        )
        work_start = await chatgpt.work.start(prompt="Analyze.", new_task=True)
        work_status = await chatgpt.work.status(include_artifacts=False)
        work_artifact = await chatgpt.work.artifacts.list_latest(kind="image")
        status = await chatgpt.messages.status(max_preview_chars=120)
        stopped = await chatgpt.messages.stop(confirm_stop=True)
        artifact = await chatgpt.artifacts.wait(kind="image", require_download=True)
        project_sources = await chatgpt.projects.sources.plan_add(
            project_url="https://chatgpt.com/g/g-p-example/project",
            files=["/tmp/a.txt"],
        )
        mode_set = await chatgpt.modes.set(model="Pro")
        mode_get = await chatgpt.modes.get()
        report = await chatgpt.reports.redact({"prompt": "private"})
        commands = await chatgpt.commands()
        described = await chatgpt.describe("runner.run")
        help_text = await chatgpt.help()

        self.assertEqual(ask.data["command"], "ask")
        self.assertEqual(bootstrap.data["command"], "session.bootstrap")
        self.assertEqual(experience.data["command"], "experience.detect")
        self.assertEqual(opened.data["command"], "experience.open")
        self.assertEqual(configuration.data["command"], "configuration.apply")
        self.assertEqual(work_start.data["command"], "work.start")
        self.assertEqual(work_status.data["command"], "work.status")
        self.assertEqual(work_artifact.data["command"], "artifacts.listLatest")
        self.assertEqual(status.data["command"], "messages.status")
        self.assertEqual(stopped.data["command"], "messages.stop")
        self.assertEqual(artifact.data["command"], "artifacts.wait")
        self.assertEqual(project_sources.data["command"], "projects.sources.planAdd")
        self.assertEqual(mode_set.data["command"], "modes.set")
        self.assertEqual(mode_get.data["command"], "modes.get")
        self.assertEqual(report.data["command"], "reports.redact")
        self.assertEqual(commands[0].name, "runner.run")
        self.assertEqual(described.name, "runner.run")
        self.assertEqual(help_text, "help text")
        self.assertEqual([request[0] for request in backend.requests], [
            "ask",
            "session.bootstrap",
            "experience.detect",
            "experience.open",
            "configuration.apply",
            "work.start",
            "work.status",
            "artifacts.listLatest",
            "messages.status",
            "messages.stop",
            "artifacts.wait",
            "projects.sources.planAdd",
            "modes.set",
            "modes.get",
            "reports.redact",
            "commands",
            "describe",
            "help",
        ])
        self.assertEqual(
            next(payload for command, payload in backend.requests if command == "configuration.apply"),
            {
                "experience": "work",
                "desired": {"model": "GPT-5.6 Sol", "modelVersion": "5.6"},
            },
        )
        self.assertEqual(next(payload for command, payload in backend.requests if command == "modes.set"), {"model": "Pro"})
        self.assertEqual(next(payload for command, payload in backend.requests if command == "modes.get"), {})

    async def test_legacy_async_runner_fallback_still_runs(self) -> None:
        transport = FakeLegacyAsyncTransport()
        chatgpt = AsyncChatGPT(transport=transport)
        agent = chatgpt.agent(name="legacy")

        result = await chatgpt.runner.run(agent, input="hi")

        self.assertEqual(result.final_output, "legacy-ok")
        self.assertEqual(transport.requests[0]["agent"]["kind"], "chatgpt_browser_agent")

    async def test_transactional_async_runner_validates_before_transport_and_matches_sync_envelope(self) -> None:
        backend = FakeAsyncOperationBackend({})
        chatgpt = AsyncChatGPT(backend)
        result = await chatgpt.runner.run(
            chatgpt.agent(name="reviewer"),
            {"operation_id": "not-a-uuid", "input": "Do not send."},
        )

        self.assertEqual(result.status, "unsupported")
        self.assertEqual(backend.requests, [])

    async def test_async_runner_hostile_mapping_operation_detection_is_structured(self) -> None:
        backend = FakeAsyncBackend()

        result = await AsyncChatGPT(backend).runner.run(
            AsyncChatGPT(backend).agent(name="reviewer"),
            ExplodingAsyncMapping(),
        )

        self.assertEqual(result.status, "unsupported")
        self.assertIsNotNone(result.blocker)
        assert result.blocker is not None
        self.assertEqual(result.blocker["fieldPath"], "<invalid-field>")
        self.assertNotIn("private mapping state", repr(result.to_wire()))
        self.assertEqual(backend.requests, [])

    async def test_transactional_async_responses_collect_once_and_preserve_identity(self) -> None:
        submit = fixture("operation-submit-result.json")
        collect = fixture("operation-collect-result.json")
        backend = FakeAsyncOperationBackend({"operations.submit": submit, "operations.collect": collect})
        operation_id = submit["operationId"]
        response = await AsyncChatGPT(backend).responses.create(
            input="Summarize this.",
            operation_id=operation_id,
            thread={"type": "conversationId", "conversationId": "conversation-1"},
        )

        self.assertEqual(response.status, "ok")
        self.assertEqual(response.browser_control["operationId"], operation_id)
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit", "operations.collect"])
        self.assertEqual(backend.requests[0][1]["operationId"], operation_id)

    async def test_close_request_fences_fresh_backend_calls_and_streams(self) -> None:
        backend = CloseFenceBackend()
        chatgpt = AsyncChatGPT(backend, close_timeout_seconds=1)
        existing_stream = chatgpt.runner.run_streamed(chatgpt.agent(name="existing"), "input")

        close_task = asyncio.create_task(chatgpt.aclose())
        await asyncio.wait_for(backend.close_started.wait(), timeout=1)

        with self.assertRaisesRegex(RuntimeError, "closed"):
            await chatgpt.ask(prompt="must not start")
        with self.assertRaisesRegex(RuntimeError, "closed"):
            await chatgpt.responses.create(input="must not start")
        with self.assertRaisesRegex(RuntimeError, "closed"):
            chatgpt.runner.run_streamed(chatgpt.agent(name="new"), "must not start")
        self.assertEqual(backend.requests, [])

        # A stream acquired before the close fence remains allowed to perform
        # bounded cleanup, and the close task can then complete normally.
        await existing_stream.aclose()
        backend.release_close.set()
        await close_task
        self.assertTrue(chatgpt._close_complete)

    async def test_native_async_backend_receives_owning_execution_context(self) -> None:
        backend = NativeContextBackend()
        chatgpt = AsyncChatGPT(backend)

        result = await chatgpt.ask(prompt="context")

        self.assertEqual(result.data["command"], "ask")
        self.assertIs(backend.execution_seen, chatgpt._execution)

    async def test_awaitable_returning_close_is_loop_affine_and_retryable(self) -> None:
        backend = AwaitableReturningCloseBackend()
        chatgpt = AsyncChatGPT(backend, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(chatgpt.aclose())
        await asyncio.wait_for(backend.first_close_started.wait(), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task
        self.assertFalse(chatgpt._close_complete)
        self.assertIsNone(chatgpt._backend_close_task)
        self.assertEqual(backend.close_calls, 1)

        await chatgpt.aclose()
        self.assertTrue(chatgpt._close_complete)
        self.assertEqual(backend.close_calls, 2)
        self.assertTrue(backend.closed)

    async def test_sync_backend_request_runs_off_event_loop(self) -> None:
        backend = SlowSyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)
        ticked = asyncio.Event()

        async def ticker() -> None:
            await asyncio.sleep(0.02)
            ticked.set()

        request_task = asyncio.create_task(chatgpt.ask(prompt="slow"))
        ticker_task = asyncio.create_task(ticker())
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        result = await request_task
        await ticker_task

        self.assertEqual(result.data["command"], "ask")

    async def test_blocked_stream_worker_cannot_starve_owned_unary_worker(self) -> None:
        backend = GatedSyncBackend()
        chatgpt = AsyncChatGPT(
            transport=backend,
            backend_workers=1,
            stream_workers=1,
            cleanup_workers=1,
        )
        stream = chatgpt.runner.run_streamed(chatgpt.agent(name="blocked"), "input")
        next_task = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(asyncio.to_thread(backend.next_started.wait), timeout=1)

        # The stream step occupies the only stream worker. Unary work uses the
        # separate owned backend pool and must remain schedulable.
        result = await chatgpt.ask(prompt="unrelated unary")
        self.assertEqual(result.data["command"], "ask")

        await stream.aclose()
        with self.assertRaises(StopAsyncIteration):
            await next_task
        await chatgpt.aclose()

    async def test_client_close_detaches_hostile_stream_worker_without_waiting(self) -> None:
        backend = GatedSyncBackend()
        chatgpt = AsyncChatGPT(transport=backend, stream_workers=1, cleanup_workers=1)
        stream = chatgpt.runner.run_streamed(chatgpt.agent(name="detached"), "input")
        next_task = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(asyncio.to_thread(backend.next_started.wait), timeout=1)

        await chatgpt.aclose()
        self.assertFalse(next_task.done())

        await stream.aclose()
        with self.assertRaises(StopAsyncIteration):
            await next_task

    async def test_hung_provider_aclose_is_hard_bounded_and_retryable(self) -> None:
        source = HangingAsyncCloseSource()
        release_close = asyncio.Event()
        source.release = release_close
        stream = AsyncRunResultStreaming(_events=source, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(stream.aclose())
        await asyncio.wait_for(source.started.wait(), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task
        self.assertFalse(stream._closed)
        self.assertTrue(stream._stream_acquired)
        # The provider suppresses cancellation, so its loop-affine task must
        # remain tracked until an external release; this is the unavoidable
        # residual for a cancellation-hostile async coroutine.
        self.assertTrue(stream._close_source_tasks)

        release_close.set()
        await asyncio.wait_for(source.finished.wait(), timeout=1)
        while stream._stream_acquired:
            await asyncio.sleep(0)
        self.assertTrue(source.closed)
        self.assertTrue(stream._closed)

    async def test_cancellation_responsive_close_is_retired_before_retry(self) -> None:
        source = ResponsiveAsyncCloseSource()
        stream = AsyncRunResultStreaming(_events=source, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(stream.aclose())
        await asyncio.wait_for(source.started.wait(), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task
        self.assertEqual(source.close_attempts, 1)
        self.assertFalse(stream._close_source_tasks)

        await stream.aclose()
        self.assertEqual(source.close_attempts, 2)
        self.assertTrue(source.closed)

    async def test_awaitable_returning_stream_close_is_cancelable_and_single_flight(self) -> None:
        source = AwaitableReturningAsyncCloseSource()
        stream = AsyncRunResultStreaming(_events=source, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(stream.aclose())
        await asyncio.wait_for(source.first_started.wait(), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task
        self.assertFalse(stream._close_source_tasks)
        self.assertEqual(source.close_attempts, 1)

        await stream.aclose()
        self.assertEqual(source.close_attempts, 2)
        self.assertTrue(source.closed)

    async def test_hung_sync_close_stays_single_flight_and_releases_late(self) -> None:
        source = HangingSyncCloseSource()
        stream = AsyncRunResultStreaming(_events=source, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(stream.aclose())
        await asyncio.wait_for(asyncio.to_thread(source.started.wait), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task
        self.assertTrue(stream._close_source_tasks)

        source.release.set()
        await asyncio.wait_for(asyncio.to_thread(source.finished.wait), timeout=1)
        while stream._stream_acquired:
            await asyncio.sleep(0)
        self.assertTrue(stream._closed)
        self.assertTrue(source.closed)

    async def test_client_close_is_hard_bounded_for_hostile_async_backend(self) -> None:
        backend = HangingAsyncBackendClose()
        chatgpt = AsyncChatGPT(backend, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)
        close_task = asyncio.create_task(chatgpt.aclose())
        await asyncio.wait_for(backend.started.wait(), timeout=1)

        with self.assertRaises(TimeoutError):
            await close_task
        self.assertTrue(chatgpt._close_requested)
        self.assertFalse(chatgpt._close_complete)
        self.assertFalse(chatgpt._closed)
        assert chatgpt._backend_close_task is not None
        pending_close_task = chatgpt._backend_close_task
        self.assertFalse(chatgpt._backend_close_task.done())

        # A second caller must await the same hostile close rather than
        # concurrently invoking the provider again.
        retry_task = asyncio.create_task(chatgpt.aclose())
        with self.assertRaises(TimeoutError):
            await retry_task
        self.assertEqual(backend.close_attempts, 1)
        self.assertIs(chatgpt._backend_close_task, pending_close_task)

        backend.release.set()
        await asyncio.wait_for(backend.finished.wait(), timeout=1)
        await chatgpt.aclose()
        self.assertTrue(chatgpt._close_complete)
        self.assertTrue(chatgpt._closed)
        self.assertEqual(backend.close_attempts, 1)

    async def test_cancellation_responsive_client_close_can_retry_after_timeout(self) -> None:
        backend = ResponsiveAsyncBackendClose()
        chatgpt = AsyncChatGPT(backend, close_timeout_seconds=TEST_CLOSE_TIMEOUT_SECONDS)

        close_task = asyncio.create_task(chatgpt.aclose())
        await asyncio.wait_for(backend.started.wait(), timeout=1)
        with self.assertRaises(TimeoutError):
            await close_task

        self.assertTrue(chatgpt._close_requested)
        self.assertFalse(chatgpt._close_complete)
        self.assertFalse(chatgpt._closed)
        self.assertEqual(backend.close_attempts, 1)
        self.assertIsNone(chatgpt._backend_close_task)

        # The cancellation-responsive first attempt was retired, so an
        # explicit retry may safely invoke the provider exactly once more.
        await chatgpt.aclose()
        self.assertEqual(backend.close_attempts, 2)
        self.assertTrue(backend.closed)
        self.assertTrue(chatgpt._close_complete)
        self.assertTrue(chatgpt._closed)

        # Successful close is idempotent and must not call the backend again.
        await chatgpt.aclose()
        self.assertEqual(backend.close_attempts, 2)

    async def test_concurrent_client_close_callers_share_one_backend_close(self) -> None:
        backend = HangingAsyncBackendClose()
        chatgpt = AsyncChatGPT(backend, close_timeout_seconds=1)

        first = asyncio.create_task(chatgpt.aclose())
        await asyncio.wait_for(backend.started.wait(), timeout=1)
        second_entered = asyncio.Event()

        async def concurrent_close() -> None:
            second_entered.set()
            await chatgpt.aclose()

        second = asyncio.create_task(concurrent_close())
        await asyncio.wait_for(second_entered.wait(), timeout=1)
        self.assertFalse(second.done())
        self.assertEqual(backend.close_attempts, 1)

        backend.release.set()
        await asyncio.gather(first, second)
        self.assertTrue(backend.finished.is_set())
        self.assertTrue(chatgpt._close_complete)
        self.assertTrue(chatgpt._closed)
        self.assertEqual(backend.close_attempts, 1)

    async def test_distinct_closeable_iterator_and_iterable_are_both_closed(self) -> None:
        iterable = DistinctCloseableIterable()
        stream = AsyncRunResultStreaming(_events=iterable)

        event = await stream.__anext__()
        self.assertEqual(event.name, "message_completed")
        await stream.aclose()

        self.assertTrue(iterable.closed)
        self.assertIsNotNone(iterable.iterator)
        assert iterable.iterator is not None
        self.assertTrue(iterable.iterator.closed)

    async def test_sync_stream_next_runs_off_event_loop_and_aclose_closes_source(self) -> None:
        backend = SlowSyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)
        stream = chatgpt.runner.run_streamed(chatgpt.agent(name="slow"), "input")
        ticked = asyncio.Event()

        async def ticker() -> None:
            await asyncio.sleep(0.02)
            ticked.set()

        ticker_task = asyncio.create_task(ticker())
        event = await stream.__anext__()
        await asyncio.wait_for(ticked.wait(), timeout=0.1)
        await stream.aclose()
        await ticker_task

        self.assertEqual(event.name, "message_completed")
        self.assertIsNotNone(backend.last_stream)
        assert backend.last_stream is not None
        self.assertTrue(backend.last_stream.closed)

    async def test_cancelled_sync_stream_next_closes_route_without_blocking_loop(self) -> None:
        backend = SlowSyncBackend(block_until_closed=True)
        chatgpt = AsyncChatGPT(transport=backend)
        stream = chatgpt.runner.run_streamed(chatgpt.agent(name="cancel"), "input")
        task = asyncio.create_task(stream.__anext__())
        await asyncio.sleep(0.02)
        task.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNotNone(backend.last_stream)
        assert backend.last_stream is not None
        self.assertTrue(backend.last_stream.closed)

    async def test_async_facade_preserves_explicit_shared_sync_broker_lifecycle(self) -> None:
        backend = SharedSyncBackend()
        backend.open()
        chatgpt = AsyncChatGPT(transport=backend)

        results = await asyncio.gather(*(chatgpt.ask(prompt=f"request-{index}") for index in range(4)))

        self.assertEqual(len(results), 4)
        self.assertEqual(backend.open_count, 1)
        self.assertEqual(len(backend.requests), 4)

    async def test_terminal_sync_stream_event_closes_source_without_extra_iteration(self) -> None:
        backend = SlowSyncBackend()
        chatgpt = AsyncChatGPT(transport=backend)
        stream = chatgpt.runner.run_streamed(chatgpt.agent(name="terminal"), "input")

        await stream.__anext__()
        terminal = await stream.__anext__()

        self.assertEqual(terminal.type, "completed")
        self.assertIsNotNone(stream.final_result)
        self.assertIsNotNone(backend.last_stream)
        assert backend.last_stream is not None
        self.assertTrue(backend.last_stream.closed)

    async def test_cancelled_stream_factory_closes_late_async_source(self) -> None:
        factory_started = asyncio.Event()
        release_factory = asyncio.Event()
        source = AsyncCloseTrackingSource()

        async def factory() -> AsyncCloseTrackingSource:
            factory_started.set()
            await release_factory.wait()
            return source

        stream = AsyncRunResultStreaming(_events_factory=factory)
        task = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(factory_started.wait(), timeout=1)
        task.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(source.closed)

        release_factory.set()
        await asyncio.wait_for(source.closed_event.wait(), timeout=1)
        self.assertTrue(source.closed)

    async def test_cancelled_stream_factory_closes_late_sync_source(self) -> None:
        factory_started = threading.Event()
        release_factory = threading.Event()
        source = SyncCloseTrackingSource()

        def sync_factory() -> SyncCloseTrackingSource:
            factory_started.set()
            release_factory.wait()
            return source

        async def factory() -> SyncCloseTrackingSource:
            return await asyncio.to_thread(sync_factory)

        stream = AsyncRunResultStreaming(_events_factory=factory)
        task = asyncio.create_task(stream.__anext__())
        await asyncio.wait_for(asyncio.to_thread(factory_started.wait), timeout=1)
        task.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(source.closed)

        release_factory.set()
        await asyncio.wait_for(asyncio.to_thread(source.closed_event.wait), timeout=1)
        self.assertTrue(source.closed)

    async def test_stream_aclose_failure_remains_retryable(self) -> None:
        source = FlakyAsyncCloseSource()
        stream = AsyncRunResultStreaming(_events=source)

        with self.assertRaisesRegex(RuntimeError, "close failed"):
            await stream.aclose()
        self.assertFalse(stream._closed)
        self.assertEqual(source.close_attempts, 1)

        await stream.aclose()

        self.assertTrue(stream._closed)
        self.assertTrue(source.closed)
        self.assertEqual(source.close_attempts, 2)


def run_result(agent_name: str, output_text: str) -> dict:
    return {
        "ok": True,
        "status": "ok",
        "output_text": output_text,
        "finalOutput": output_text,
        "output": [],
        "newItems": [],
        "interruptions": [],
        "state": {"id": "state-async", "resumable": False},
        "activeAgentName": agent_name,
        "lastAgentName": agent_name,
        "warnings": [],
        "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
    }


def command_result(data: dict) -> dict:
    return {
        "ok": True,
        "status": "ok",
        "data": data,
        "warnings": [],
        "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
    }


class SlowSyncBackend:
    def __init__(self, *, block_until_closed: bool = False) -> None:
        self.block_until_closed = block_until_closed
        self.last_stream: "SlowSyncEventIterator | None" = None

    def request(self, command: str, payload: dict | None = None) -> dict:
        time.sleep(0.08)
        return command_result({"command": command, "payload": payload or {}})

    def runner_stream(self, _agent: dict, _input: object) -> "SlowSyncEventIterator":
        self.last_stream = SlowSyncEventIterator(block_until_closed=self.block_until_closed)
        return self.last_stream


class GatedSyncBackend:
    def __init__(self) -> None:
        self.next_started = threading.Event()
        self.release_next = threading.Event()
        self.stream: GatedSyncIterator | None = None

    def request(self, command: str, payload: dict | None = None) -> dict:
        return command_result({"command": command, "payload": payload or {}})

    def runner_stream(self, _agent: dict, _input: object) -> "GatedSyncIterator":
        self.stream = GatedSyncIterator(self.next_started, self.release_next)
        return self.stream


class GatedSyncIterator:
    def __init__(self, started: threading.Event, release: threading.Event) -> None:
        self.started = started
        self.release = release
        self.closed = False

    def __iter__(self) -> "GatedSyncIterator":
        return self

    def __next__(self) -> dict:
        self.started.set()
        self.release.wait()
        raise StopIteration

    def close(self) -> None:
        self.closed = True
        self.release.set()


class SharedSyncBackend:
    def __init__(self) -> None:
        self.open_count = 0
        self.requests: list[tuple[str, dict]] = []

    def open(self) -> None:
        self.open_count += 1

    def request(self, command: str, payload: dict | None = None) -> dict:
        time.sleep(0.02)
        self.requests.append((command, payload or {}))
        return command_result({"command": command})


class SlowSyncEventIterator:
    def __init__(self, *, block_until_closed: bool) -> None:
        self.block_until_closed = block_until_closed
        self.closed = False
        self._index = 0

    def __iter__(self) -> "SlowSyncEventIterator":
        return self

    def __next__(self) -> dict:
        if self.block_until_closed:
            while not self.closed:
                time.sleep(0.01)
            raise StopIteration
        time.sleep(0.08)
        if self._index == 0:
            self._index += 1
            return {
                "schemaVersion": "chatgpt.browser_control.backend_event.v1",
                "type": "run_item_stream_event",
                "name": "message_completed",
                "item": {"type": "message.completed"},
            }
        if self._index == 1:
            self._index += 1
            return {
                "schemaVersion": "chatgpt.browser_control.backend_event.v1",
                "type": "completed",
                "result": run_result("slow", "done"),
            }
        raise StopIteration

    def close(self) -> None:
        self.closed = True


class AsyncCloseTrackingSource:
    def __init__(self) -> None:
        self.closed = False
        self.closed_event = asyncio.Event()

    async def aclose(self) -> None:
        self.closed = True
        self.closed_event.set()


class SyncCloseTrackingSource:
    def __init__(self) -> None:
        self.closed = False
        self.closed_event = threading.Event()

    def close(self) -> None:
        self.closed = True
        self.closed_event.set()


class FlakyAsyncCloseSource:
    def __init__(self) -> None:
        self.closed = False
        self.close_attempts = 0

    async def aclose(self) -> None:
        self.close_attempts += 1
        if self.close_attempts == 1:
            raise RuntimeError("close failed")
        self.closed = True


class HangingAsyncCloseSource:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.finished = asyncio.Event()
        self.release: asyncio.Event | None = None
        self.closed = False

    async def aclose(self) -> None:
        self.started.set()
        assert self.release is not None
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                # Model a provider that ignores cancellation. Async stream
                # cleanup must still return at its configured hard bound.
                continue
        self.closed = True
        self.finished.set()


class ResponsiveAsyncCloseSource:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.close_attempts = 0
        self.closed = False

    async def aclose(self) -> None:
        self.close_attempts += 1
        if self.close_attempts == 1:
            self.started.set()
            await asyncio.Event().wait()
        self.closed = True


class AwaitableReturningAsyncCloseSource:
    def __init__(self) -> None:
        self.first_started = asyncio.Event()
        self.close_attempts = 0
        self.closed = False

    def aclose(self):
        self.close_attempts += 1

        async def finish() -> None:
            if self.close_attempts == 1:
                self.first_started.set()
                await asyncio.Event().wait()
            self.closed = True

        return finish()


class HangingSyncCloseSource:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()
        self.closed = False

    def close(self) -> None:
        self.started.set()
        self.release.wait()
        self.closed = True
        self.finished.set()


class HangingAsyncBackendClose:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.finished = asyncio.Event()
        self.close_attempts = 0

    async def close(self) -> None:
        self.close_attempts += 1
        self.started.set()
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                continue
        self.finished.set()


class ResponsiveAsyncBackendClose:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.close_attempts = 0
        self.closed = False

    async def close(self) -> None:
        self.close_attempts += 1
        self.started.set()
        if self.close_attempts == 1:
            # Let the first attempt be canceled cleanly. It deliberately does
            # not complete the backend close, so the caller must retry.
            await asyncio.Event().wait()
        self.closed = True


class DistinctCloseableIterable:
    def __init__(self) -> None:
        self.closed = False
        self.iterator: DistinctCloseableIterator | None = None

    def __iter__(self) -> "DistinctCloseableIterator":
        self.iterator = DistinctCloseableIterator()
        return self.iterator

    def close(self) -> None:
        self.closed = True


class DistinctCloseableIterator:
    def __init__(self) -> None:
        self.closed = False
        self._done = False

    def __iter__(self) -> "DistinctCloseableIterator":
        return self

    def __next__(self) -> dict:
        if self._done:
            raise StopIteration
        self._done = True
        return {
            "schemaVersion": "chatgpt.browser_control.backend_event.v1",
            "type": "run_item_stream_event",
            "name": "message_completed",
            "item": {"type": "message.completed"},
        }

    def close(self) -> None:
        self.closed = True


if __name__ == "__main__":
    unittest.main()
