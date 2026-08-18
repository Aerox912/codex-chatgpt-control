import asyncio
import copy
import json
import time
import unittest
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

from codex_chatgpt_control import Agent, ChatGPT, ChatGPTRunResult, Runner, SequencePlan


class FakeBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict, object]] = []

    def runner_run(self, agent: dict, input: object) -> dict:
        self.requests.append(("runner.run", agent, input))
        return run_result(agent["name"], "backend-ok")

    def runner_plan(self, agent: dict, input: object) -> dict:
        self.requests.append(("runner.plan", agent, input))
        return {
            "name": f"agent-run:{agent['name']}",
            "policy": {"stopOnError": True, "returnPartial": True},
            "steps": [
                {"id": "bootstrap", "command": "session.bootstrap"},
                {"id": "ask", "command": "messages.ask", "args": {"text": input}},
            ],
        }


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def require_data(result: ChatGPTRunResult) -> dict[str, Any]:
    assert result.data is not None
    return result.data


def require_blocker(result: ChatGPTRunResult) -> dict[str, Any]:
    assert result.blocker is not None
    return result.blocker


class FakeOperationBackend:
    def __init__(self, responses: dict[str, dict[str, Any]]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict[str, Any]]] = []

    def request(self, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        self.requests.append((command, copy.deepcopy(payload or {})))
        return copy.deepcopy(self.responses[command])


class RunnerTests(unittest.IsolatedAsyncioTestCase):
    def test_run_sync_calls_backend_runner_run(self) -> None:
        backend = FakeBackend()
        runner = Runner(backend=backend)
        agent = Agent(name="reviewer")

        result = runner.run_sync(agent, "hi")

        self.assertIsInstance(result, ChatGPTRunResult)
        self.assertEqual(result.final_output, "backend-ok")
        self.assertEqual(backend.requests[0], ("runner.run", agent.to_wire(), "hi"))

    async def test_run_async_calls_backend_runner_run(self) -> None:
        backend = FakeBackend()
        runner = Runner(backend=backend)
        agent = Agent(name="reviewer")

        result = await runner.run(agent, "hi")

        self.assertEqual(result.final_output, "backend-ok")
        self.assertEqual(backend.requests[0][0], "runner.run")

    async def test_hostile_mapping_membership_fails_closed_before_legacy_or_operation_transport(self) -> None:
        class ExplodingMapping(Mapping[str, Any]):
            def __getitem__(self, key: str) -> Any:
                raise AssertionError("mapping access must be contained")

            def __iter__(self) -> Iterator[str]:
                raise AssertionError("mapping iteration must be contained")

            def __len__(self) -> int:
                return 1

            def __contains__(self, key: object) -> bool:
                raise AssertionError("mapping membership must be contained")

        agent = Agent(name="reviewer")

        sync_backend = FakeBackend()
        sync_result = Runner(backend=sync_backend).run_sync(agent, ExplodingMapping())
        self.assertEqual(sync_result.status, "unsupported")
        self.assertEqual(require_blocker(sync_result)["fieldPath"], "<invalid-field>")
        self.assertEqual(sync_backend.requests, [])

        async_backend = FakeBackend()
        async_result = await Runner(backend=async_backend).run(agent, ExplodingMapping())
        self.assertEqual(async_result.status, "unsupported")
        self.assertEqual(require_blocker(async_result)["fieldPath"], "<invalid-field>")
        self.assertEqual(async_backend.requests, [])

    def test_chatgpt_run_aliases_runner_run(self) -> None:
        backend = FakeBackend()
        chatgpt = ChatGPT(backend=backend)
        agent = chatgpt.agent(name="reviewer")

        result = chatgpt.run(agent, "hi")

        self.assertEqual(result.final_output, "backend-ok")
        self.assertEqual(backend.requests[0][0], "runner.run")

    def test_chatgpt_runner_plan_calls_backend_runner_plan(self) -> None:
        backend = FakeBackend()
        chatgpt = ChatGPT(backend=backend)
        agent = chatgpt.agent(name="planner")

        plan = chatgpt.runner.plan(agent, "draft plan")

        self.assertIsInstance(plan, SequencePlan)
        self.assertEqual(plan.name, "agent-run:planner")
        self.assertEqual(backend.requests[0][0], "runner.plan")

    def test_transactional_runner_validates_operation_id_before_backend_traffic(self) -> None:
        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {"operation_id": "not-a-uuid", "input": "Do not send."},
        )

        self.assertEqual(result.status, "unsupported")
        self.assertEqual(result.data, {"outputText": "", "operationId": "not-a-uuid"})
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_sends_exact_operation_envelope_and_maps_blocker(self) -> None:
        operation_id = "11111111-1111-4111-8111-111111111111"
        blocked = fixture("operation-submit-result.json")
        blocked["status"] = "blocked"
        blocked["blocker"] = fixture("operation-blocker.json")
        blocked["handle"]["phase"] = blocked["blocker"]["phase"]
        blocked["handle"]["mutationBoundary"] = blocked["blocker"]["mutationBoundary"]
        backend = FakeOperationBackend({"operations.submit": blocked})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer", instructions="Review deeply."),
            {
                "operation_id": operation_id,
                "input": "Summarize this.",
                "thread": {"type": "conversationId", "conversationId": "conversation-1"},
                "wait": False,
                "read": False,
            },
        )

        self.assertEqual(result.status, "blocked")
        self.assertEqual(require_data(result)["operationId"], operation_id)
        self.assertEqual(require_blocker(result)["code"], "ambiguous_submit")
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit"])
        command, payload = backend.requests[0]
        self.assertEqual(command, "operations.submit")
        self.assertEqual(payload["schemaVersion"], "chatgpt.browser_control.operation_request.v1")
        self.assertEqual(payload["operationId"], operation_id)
        self.assertEqual(payload["surface"], "chat")
        self.assertEqual(payload["target"], {"type": "conversation_id", "conversationId": "conversation-1"})
        self.assertEqual(payload["capture"], {
            "responseContent": "metadata",
            "responseFormat": "markdown",
            "artifacts": "receipt_only",
        })
        self.assertIn("<chatgpt_browser_agent>", payload["prompt"])

    def test_transactional_runner_maps_pending_collect_without_resubmitting(self) -> None:
        accepted = fixture("operation-submit-result.json")
        pending = fixture("operation-collect-result.json")
        pending["status"] = "pending"
        pending["handle"]["phase"] = "generating"
        pending.pop("receipt", None)
        pending.pop("liveResponse", None)
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": pending})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {"operationId": accepted["operationId"], "input": "Wait.", "wait": False, "read": False},
        )

        self.assertEqual(result.status, "partial")
        self.assertEqual(require_data(result)["operationId"], accepted["operationId"])
        self.assertEqual(require_data(result)["completionState"], "generating")
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit", "operations.collect"])

    def test_transactional_runner_forwards_wait_poll_interval_aliases(self) -> None:
        for field in ("pollMs", "poll_ms", "pollIntervalMs", "poll_interval_ms"):
            with self.subTest(field=field):
                accepted = fixture("operation-submit-result.json")
                completed = fixture("operation-collect-result.json")
                backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})
                result = ChatGPT(backend=backend).runner.run(
                    Agent(name="reviewer"),
                    {
                        "operationId": accepted["operationId"],
                        "input": "Use this cadence.",
                        "wait": {field: 0},
                    },
                )

                self.assertEqual(result.status, "ok")
                self.assertEqual(backend.requests[1][1]["pollIntervalMs"], 0)

    def test_transactional_runner_rejects_malformed_wait_poll_interval_before_transport(self) -> None:
        invalid_values = (True, False, -1, 60_001, 1.5, "250")
        for value in invalid_values:
            with self.subTest(value=value):
                backend = FakeOperationBackend({})
                result = ChatGPT(backend=backend).runner.run(
                    Agent(name="reviewer"),
                    {
                        "operationId": "11111111-1111-4111-8111-111111111111",
                        "input": "Do not send.",
                        "wait": {"poll_ms": value},
                    },
                )
                self.assertEqual(result.status, "unsupported")
                self.assertEqual(require_blocker(result)["fieldPath"], "wait.pollIntervalMs")
                self.assertEqual(backend.requests, [])

        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Do not send.",
                "wait": {"pollMs": 100, "poll_interval_ms": 200},
            },
        )
        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "wait.pollIntervalMs")
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_binds_requested_text_format_to_capture_identity(self) -> None:
        accepted = fixture("operation-submit-result.json")
        completed = fixture("operation-collect-result.json")
        completed["receipt"]["responseFormat"] = "text"
        completed["liveResponse"]["responseFormat"] = "text"
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": accepted["operationId"],
                "input": "Preserve plain text.",
                "response": {"format": "text"},
            },
        )

        self.assertEqual(backend.requests[0][1]["capture"]["responseFormat"], "text")
        self.assertEqual(result.output[0]["format"], "text")

    def test_transactional_runner_rejects_conflicting_capture_and_read_formats(self) -> None:
        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Do not send.",
                "capture": {"responseFormat": "text"},
            },
        )

        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "capture.responseFormat")
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_rejects_null_capture_format(self) -> None:
        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Do not send.",
                "capture": {"responseFormat": None},
            },
        )

        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "capture.responseFormat")
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_applies_agent_defaults_and_preserves_artifact_receipts(self) -> None:
        accepted = fixture("operation-submit-result.json")
        completed = fixture("operation-collect-result.json")
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})
        agent = Agent(
            name="reviewer",
            defaults={
                "thread": {"type": "conversationId", "conversationId": "conversation-1"},
                "experience": "chat",
                "configuration": {"model_version": "5.6"},
                "wait": False,
                "read": False,
            },
        )

        result = ChatGPT(backend=backend).runner.run(
            agent,
            {"operationId": accepted["operationId"], "input": "Use defaults."},
        )

        submit_payload = backend.requests[0][1]
        self.assertEqual(submit_payload["target"], {"type": "conversation_id", "conversationId": "conversation-1"})
        self.assertEqual(submit_payload["configuration"]["experience"], "chat")
        self.assertEqual(submit_payload["configuration"]["modelVersion"], "5.6")
        self.assertEqual(submit_payload["capture"]["responseContent"], "metadata")
        self.assertEqual(require_data(result)["artifacts"], completed["receipt"]["artifacts"])
        self.assertEqual(result.output_text, "")
        self.assertNotIn("responseText", require_data(result))
        self.assertNotIn("untrustedOutput", require_data(result))
        self.assertIsNone(result.final_output)

    def test_transactional_runner_rejects_result_identity_mismatch(self) -> None:
        mismatched = fixture("operation-submit-result.json")
        mismatched["operationId"] = "22222222-2222-4222-8222-222222222222"
        mismatched["handle"]["operationId"] = mismatched["operationId"]
        backend = FakeOperationBackend({"operations.submit": mismatched})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {"operation_id": "11111111-1111-4111-8111-111111111111", "input": "Identity."},
        )
        self.assertEqual(result.status, "error")
        self.assertIsNone(result.blocker)
        self.assertEqual(result.to_wire()["error"]["name"], "OperationError")

    def test_transactional_runner_rejects_duplicate_aliases_and_conflicting_targets_before_transport(self) -> None:
        operation_id = "11111111-1111-4111-8111-111111111111"
        cases = {
            "operation id": {"operationId": operation_id, "operation_id": operation_id},
            "existing tab": {"existingTab": True, "existing_tab": True},
            "prefer existing": {"preferExistingTab": True, "prefer_existing_tab": True},
            "timeout": {"timeoutMs": 10, "timeout_ms": 10},
            "response content": {"responseContent": "metadata", "response_content": "metadata"},
            "read": {"read": True, "response": True},
            "thread conversation": {"thread": {"type": "conversationId", "conversationId": "one", "conversation_id": "one"}},
            "direct tab": {"target": {"type": "tabId", "tabId": "one", "tab_id": "one"}},
            "direct conversation": {"target": {"type": "conversationId", "conversationId": "one", "conversation_id": "one"}},
            "existing policy": {"existingTab": {"ifMissing": "block", "if_missing": "block"}},
            "existing target": {"existingTab": {"target": {"type": "tabId", "tabId": "one", "tab_id": "one"}}},
            "configuration version": {"configuration": {"modelVersion": "one", "version": "one"}},
            "configuration timeout": {"configuration": {"timeoutMs": 10, "timeout_ms": 10}},
            "tool name": {"tools": [{"tool": "web_search", "name": "web_search"}]},
            "tool timeout": {"tools": [{"tool": "web_search", "timeoutMs": 10, "timeout_ms": 10}]},
            "read max": {"read": {"maxChars": 10, "max_chars": 10}},
            "read content": {"read": {"responseContent": "metadata", "response_content": "metadata"}},
            "wait timeout": {"wait": {"timeoutMs": 10, "timeout_ms": 10}},
            "wait poll": {"wait": {"pollMs": 10, "poll_interval_ms": 10}},
            "wait content": {"wait": {"responseContent": "metadata", "response_content": "metadata"}},
            "wait stable": {"wait": {"stableMs": 10, "stable_ms": 10}},
            "wait turn count": {"wait": {"afterTurnCount": 1, "after_turn_count": 1}},
            "capture content": {"capture": {"responseContent": "metadata", "response_content": "metadata"}},
            "capture format": {"capture": {"responseFormat": "markdown", "response_format": "markdown"}},
            "capture output": {"capture": {"outputDirectory": "/tmp/a", "output_directory": "/tmp/a"}},
            "file display": {"files": [{"path": "/tmp/a", "displayName": "a", "display_name": "a"}]},
        }
        for label, options in cases.items():
            with self.subTest(label=label):
                backend = FakeOperationBackend({})
                result = ChatGPT(backend=backend).runner.run(
                    Agent(name="reviewer"),
                    {"operationId": operation_id, "input": "Do not send.", **options},
                )
                self.assertEqual(result.status, "unsupported")
                self.assertEqual(require_blocker(result)["code"], "unsupported_operation_input")
                self.assertEqual(backend.requests, [])

        for selector in (
            {"thread": {"type": "new"}},
            {"existingTab": False},
            {"preferExistingTab": False},
        ):
            backend = FakeOperationBackend({})
            result = ChatGPT(backend=backend).runner.run(
                Agent(name="reviewer"),
                {
                    "operationId": operation_id,
                    "input": "Do not send.",
                    "target": {"type": "new"},
                    **selector,
                },
            )
            self.assertEqual(result.status, "unsupported")
            self.assertEqual(require_blocker(result)["fieldPath"], "target")
            self.assertEqual(backend.requests, [])

        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(
                name="reviewer",
                defaults={"configuration": {"modelVersion": "one", "model_version": "one"}},
            ),
            {"operationId": operation_id, "input": "Do not send."},
        )
        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "configuration.modelVersion")
        self.assertEqual(backend.requests, [])

    def test_transactional_alias_precedence_remains_intentional_across_sources(self) -> None:
        accepted = fixture("operation-submit-result.json")
        completed = fixture("operation-collect-result.json")
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})
        agent = Agent(name="reviewer", defaults={"existing_tab": True})

        result = ChatGPT(backend=backend).runner.run(
            agent,
            {
                "operationId": accepted["operationId"],
                "input": "Use the higher-precedence selector.",
                "existing_tab": False,
            },
        )

        self.assertEqual(result.status, "ok")
        self.assertEqual(backend.requests[0][1]["target"], {"type": "new"})

    def test_transactional_backend_exceptions_are_bounded_for_sync_and_async_callers(self) -> None:
        secret = "PRIVATE PROVIDER PROMPT"

        class RaisingBackend:
            def request(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
                raise RuntimeError(secret)

        operation_input = {
            "operationId": "11111111-1111-4111-8111-111111111111",
            "input": "Attempt once.",
        }
        sync_result = ChatGPT(backend=RaisingBackend()).runner.run(Agent(name="reviewer"), operation_input)
        self.assertEqual(sync_result.status, "error")
        self.assertIsNone(sync_result.blocker)
        self.assertEqual(sync_result.to_wire()["error"]["name"], "OperationError")
        self.assertNotIn(secret, repr(sync_result.to_wire()))

        class BridgeError(RuntimeError):
            def __init__(self) -> None:
                super().__init__(secret)
                self.code = "browser_bridge_unavailable"

        class BridgeBackend:
            def request(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
                raise BridgeError()

        blocked = ChatGPT(backend=BridgeBackend()).runner.run(Agent(name="reviewer"), operation_input)
        self.assertEqual(blocked.status, "blocked")
        self.assertEqual(require_blocker(blocked)["code"], "browser_bridge_unavailable")
        self.assertNotIn(secret, repr(blocked.to_wire()))

    async def test_transactional_backend_exceptions_are_bounded_for_async_callers(self) -> None:
        secret = "PRIVATE ASYNC PROVIDER PROMPT"

        class RaisingBackend:
            def request(self, command: str, payload: dict[str, Any]) -> dict[str, Any]:
                raise RuntimeError(secret)

        result = await Runner(RaisingBackend()).run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Attempt once.",
            },
        )
        self.assertEqual(result.status, "error")
        self.assertIsNone(result.blocker)
        self.assertEqual(result.to_wire()["error"]["name"], "OperationError")
        self.assertNotIn(secret, repr(result.to_wire()))

    async def test_async_legacy_runner_does_not_block_the_event_loop(self) -> None:
        class BlockingBackend(FakeBackend):
            def runner_run(self, agent: dict, input: object) -> dict:
                time.sleep(0.15)
                return run_result(agent["name"], "backend-ok")

        started = time.monotonic()

        async def tick() -> float:
            await asyncio.sleep(0.01)
            return time.monotonic() - started

        result, tick_elapsed = await asyncio.gather(
            Runner(BlockingBackend()).run(Agent(name="reviewer"), "hi"),
            tick(),
        )
        self.assertEqual(result.final_output, "backend-ok")
        self.assertLess(tick_elapsed, 0.1)

    def test_transactional_runner_reports_unhashable_option_values_without_raw_type_errors(self) -> None:
        cases = {
            "input item type": {"input": [{"type": [], "text": "bad"}]},
            "thread type": {"input": "Do not send.", "thread": {"type": {}}},
            "existing tab policy": {"input": "Do not send.", "existingTab": {"ifMissing": []}},
            "existing tab target type": {"input": "Do not send.", "existingTab": {"target": {"type": []}}},
            "direct target type": {"input": "Do not send.", "target": {"type": []}},
            "experience": {"input": "Do not send.", "experience": []},
            "read format": {"input": "Do not send.", "read": {"format": []}},
            "wait response content": {"input": "Do not send.", "wait": {"responseContent": []}},
            "response content": {"input": "Do not send.", "responseContent": []},
            "capture artifacts": {"input": "Do not send.", "capture": {"artifacts": []}},
            "report": {"input": "Do not send.", "report": []},
        }

        for label, value in cases.items():
            with self.subTest(label=label):
                backend = FakeOperationBackend({})
                try:
                    result = ChatGPT(backend=backend).runner.run(
                        Agent(name="reviewer"),
                        {"operationId": "11111111-1111-4111-8111-111111111111", **value},
                    )
                except TypeError as exc:
                    self.fail(f"{label} leaked raw TypeError: {exc}")
                self.assertEqual(result.status, "unsupported")
                self.assertEqual(require_blocker(result)["code"], "unsupported_operation_input")
                self.assertEqual(backend.requests, [])

    def test_transactional_runner_rejects_input_item_shape_extras_and_bad_descriptions(self) -> None:
        cases = (
            {"type": "input_text", "text": "hello", "role": "assistant"},
            {"type": "input_text", "text": "hello", "role": None},
            {"type": "input_text", "text": "hello", "path": "private"},
            {"type": "visible_instruction", "text": "hello", "role": "user"},
            {"type": "input_file", "path": "/tmp/example.txt", "description": ["not text"]},
            {"type": "input_file", "path": "/tmp/example.txt", "description": None},
        )
        for item in cases:
            with self.subTest(item=item):
                backend = FakeOperationBackend({})
                result = ChatGPT(backend=backend).runner.run(
                    Agent(name="reviewer"),
                    {
                        "operationId": "11111111-1111-4111-8111-111111111111",
                        "input": [item],
                    },
                )
                self.assertEqual(result.status, "unsupported")
                self.assertEqual(require_blocker(result)["code"], "unsupported_operation_input")
                self.assertEqual(backend.requests, [])

    def test_transactional_runner_uses_safe_marker_for_non_string_mapping_keys(self) -> None:
        class HostileKey:
            def __str__(self) -> str:
                raise AssertionError("must not stringify hostile keys")

        hostile = HostileKey()
        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Do not send.",
                hostile: "private value",
            },
        )
        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "<invalid-field>")
        self.assertNotIn("private value", str(result.blocker))
        self.assertEqual(backend.requests, [])

        backend = FakeOperationBackend({})
        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": [{"type": "input_text", "text": "hello", hostile: "private value"}],
            },
        )
        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "input[0].<invalid-field>")
        self.assertNotIn("private value", str(result.blocker))
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_rejects_unknown_options_before_transport(self) -> None:
        backend = FakeOperationBackend({})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": "11111111-1111-4111-8111-111111111111",
                "input": "Do not send.",
                "unknownOption": {"nested": True},
            },
        )

        self.assertEqual(result.status, "unsupported")
        self.assertEqual(require_blocker(result)["fieldPath"], "unknownOption")
        self.assertEqual(backend.requests, [])

    def test_transactional_runner_maps_output_items_and_utf16_max_chars(self) -> None:
        accepted = fixture("operation-submit-result.json")
        completed = fixture("operation-collect-result.json")
        text = "😀abc"
        completed["liveResponse"]["content"] = text
        completed["liveResponse"]["bytes"] = len(text.encode("utf-8"))
        completed["liveResponse"]["chars"] = len(text.encode("utf-16-le")) // 2
        completed["receipt"]["responseBytes"] = completed["liveResponse"]["bytes"]
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer"),
            {
                "operationId": accepted["operationId"],
                "input": "Capture this.",
                "read": {"maxChars": 2},
            },
        )

        self.assertEqual(result.output_text, "😀")
        self.assertEqual(require_data(result)["responseText"], "😀")
        self.assertEqual(require_data(result)["responseBytes"], len(text.encode("utf-8")))
        self.assertEqual(result.new_items, result.output)
        self.assertEqual(result.output[0]["format"], "markdown")
        self.assertEqual(require_data(result)["responseFormat"], "markdown")
        self.assertEqual(require_data(result)["untrustedOutput"]["trusted"], False)

    def test_transactional_runner_applies_agent_json_output_parsing(self) -> None:
        accepted = fixture("operation-submit-result.json")
        completed = fixture("operation-collect-result.json")
        text = '{"answer":"safe"}'
        completed["liveResponse"]["content"] = text
        completed["liveResponse"]["bytes"] = len(text.encode("utf-8"))
        completed["liveResponse"]["chars"] = len(text.encode("utf-16-le")) // 2
        completed["receipt"]["responseBytes"] = completed["liveResponse"]["bytes"]
        backend = FakeOperationBackend({"operations.submit": accepted, "operations.collect": completed})

        result = ChatGPT(backend=backend).runner.run(
            Agent(name="reviewer", output={"parse": "json"}),
            {"operationId": accepted["operationId"], "input": "Return JSON."},
        )

        self.assertEqual(result.final_output, {"answer": "safe"})
        self.assertEqual(result.output_text, text)


def run_result(agent_name: str, output_text: str) -> dict:
    return {
        "ok": True,
        "status": "ok",
        "output_text": output_text,
        "finalOutput": output_text,
        "output": [],
        "newItems": [],
        "interruptions": [],
        "state": {"id": "state-runner", "resumable": False},
        "activeAgentName": agent_name,
        "lastAgentName": agent_name,
        "warnings": [],
        "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
    }


if __name__ == "__main__":
    unittest.main()
