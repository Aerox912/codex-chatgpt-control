import asyncio
import copy
import json
import unittest
from pathlib import Path
from typing import Any

from codex_chatgpt_control import AsyncChatGPT, ChatGPT, OperationHandle, OperationSubmitRequest
from codex_chatgpt_control.operations import (
    OperationCollectResult,
    OperationControlResult,
    OperationInspectResult,
    OperationLiveResponseV1,
    OperationWireState,
    OperationSubmitResult,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"


def fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def submit_variant(status: str) -> dict[str, Any]:
    payload = fixture("operation-submit-result.json")
    payload["status"] = status
    if status == "completed":
        payload["handle"]["revision"] = 10
        payload["handle"]["phase"] = "completed"
        payload["receipt"] = fixture("operation-receipt.json")
    elif status in {"blocked", "uncertain"}:
        payload["blocker"] = fixture("operation-blocker.json")
        # Result blockers are required to describe the fresh handle's
        # phase/boundary; the standalone blocker fixture intentionally uses an
        # uncertain post-Send example, so project it onto this envelope.
        payload["blocker"]["phase"] = payload["handle"]["phase"]
        payload["blocker"]["mutationBoundary"] = payload["handle"]["mutationBoundary"]
    return payload


class FakeOperationBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: dict[str, dict[str, Any]] = {}
        self.compatibility: dict[str, Any] | None = None

    def request(self, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        self.requests.append((command, copy.deepcopy(payload)))
        return copy.deepcopy(self.responses[command])

    def close(self) -> None:
        pass

    def compatibility_report(self) -> dict[str, Any] | None:
        return copy.deepcopy(self.compatibility)


class FakeAsyncOperationBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: dict[str, dict[str, Any]] = {}
        self.compatibility: dict[str, Any] | None = None

    async def request(self, command: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        payload = payload or {}
        self.requests.append((command, copy.deepcopy(payload)))
        await asyncio.sleep(0)
        return copy.deepcopy(self.responses[command])

    def close(self) -> None:
        pass

    def compatibility_report(self) -> dict[str, Any] | None:
        return copy.deepcopy(self.compatibility)


class _SecretKey:
    def __hash__(self) -> int:
        return 1

    def __str__(self) -> str:
        raise AssertionError("str() must not be called for a non-string key")

    def __repr__(self) -> str:
        return "private-secret-key"


class _ArbitraryWireObject:
    def to_wire(self) -> dict[str, str]:
        raise AssertionError("arbitrary to_wire() must never be called")


class OperationClientTests(unittest.TestCase):
    def test_submit_decodes_exact_envelope_and_builds_camel_case_request(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        chatgpt = ChatGPT(backend=backend)

        result = chatgpt.operations.submit(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="Summarize this.",
            target={"type": "conversation_id", "conversation_id": "conversation-1"},
            configuration={"model_version": "model-version"},
            capture={"response_content": "metadata", "artifacts": "receipt_only"},
            timeout_ms=2500,
        )

        self.assertIsInstance(result, OperationSubmitResult)
        self.assertEqual(result.status, "accepted")
        self.assertEqual(result.handle.operation_id, "11111111-1111-4111-8111-111111111111")
        self.assertEqual(backend.requests[0][0], "operations.submit")
        self.assertEqual(backend.requests[0][1]["operationId"], result.operation_id)
        self.assertEqual(backend.requests[0][1]["target"], {"type": "conversation_id", "conversationId": "conversation-1"})
        self.assertEqual(backend.requests[0][1]["configuration"], {"modelVersion": "model-version"})
        self.assertEqual(backend.requests[0][1]["capture"], {
            "responseContent": "metadata",
            "responseFormat": "markdown",
            "artifacts": "receipt_only",
        })

    def test_thread_is_an_idiomatic_alias_for_wire_target(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        ChatGPT(backend=backend).operations.submit(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="Alias.",
            thread={"type": "selected_tab"},
        )
        self.assertEqual(backend.requests[0][1]["target"], {"type": "selected_tab"})

    def test_run_collects_exactly_once_for_accepted_and_never_resubmits(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        chatgpt = ChatGPT(backend=backend)

        result = chatgpt.operations.run(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="Summarize this.",
            target={"type": "new"},
            wait=True,
            timeout_ms=2000,
        )

        self.assertIsInstance(result, OperationCollectResult)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.receipt.response_format, "markdown")  # type: ignore[union-attr]
        self.assertEqual(result.live_response.response_format, "markdown")  # type: ignore[union-attr]
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit", "operations.collect"])
        self.assertEqual(backend.requests[1][1]["handle"]["operationId"], backend.requests[0][1]["operationId"])
        self.assertEqual(backend.requests[1][1]["wait"], True)
        self.assertEqual(backend.requests[1][1]["timeoutMs"], 2000)

    def test_collect_and_run_forward_bounded_poll_interval_as_camel_case(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        handle = OperationHandle.from_wire(fixture("operation-handle.json"))

        ChatGPT(backend=backend).operations.collect(handle=handle, poll_interval_ms=0)
        self.assertEqual(backend.requests[0][1]["pollIntervalMs"], 0)

        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        ChatGPT(backend=backend).operations.run(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="Use a bounded cadence.",
            target={"type": "new"},
            poll_interval_ms=60_000,
        )
        self.assertEqual(backend.requests[-1][1]["pollIntervalMs"], 60_000)

    def test_collect_accepts_camel_case_poll_interval_in_mapping(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        handle = fixture("operation-handle.json")

        ChatGPT(backend=backend).operations.collect(
            request={"handle": handle, "pollIntervalMs": 125},
        )

        self.assertEqual(backend.requests[0][1]["pollIntervalMs"], 125)

    def test_collect_and_run_reject_invalid_poll_interval_before_transport(self) -> None:
        invalid_values = (True, False, -1, 60_001, 1.5, "250")
        for value in invalid_values:
            with self.subTest(value=value):
                backend = FakeOperationBackend()
                with self.assertRaises(ValueError):
                    ChatGPT(backend=backend).operations.collect(
                        handle=fixture("operation-handle.json"),
                        poll_interval_ms=value,  # type: ignore[arg-type]
                    )
                self.assertEqual(backend.requests, [])

                backend = FakeOperationBackend()
                with self.assertRaises(ValueError):
                    ChatGPT(backend=backend).operations.run(
                        operation_id="11111111-1111-4111-8111-111111111111",
                        surface="chat",
                        prompt="Do not send.",
                        target={"type": "new"},
                        poll_interval_ms=value,  # type: ignore[arg-type]
                    )
                self.assertEqual(backend.requests, [])

    def test_collect_rejects_explicit_null_or_conflicting_poll_aliases(self) -> None:
        for request in (
            {"handle": fixture("operation-handle.json"), "pollIntervalMs": None},
            {"handle": fixture("operation-handle.json"), "pollIntervalMs": 100, "poll_interval_ms": 200},
        ):
            with self.subTest(request=request):
                backend = FakeOperationBackend()
                with self.assertRaises((ValueError, TypeError)):
                    ChatGPT(backend=backend).operations.collect(request=request)
                self.assertEqual(backend.requests, [])

    def test_request_conversion_is_bounded_and_privacy_safe_before_transport(self) -> None:
        cases: list[tuple[str, Any, str]] = []

        hostile_key: dict[Any, Any] = {_SecretKey(): "private-key-value"}
        cases.append(("non-string key", hostile_key, "private-key-value"))
        cases.append(("arbitrary to_wire object", _ArbitraryWireObject(), "private-wire-value"))

        cycle: dict[str, Any] = {"type": "new"}
        cycle["cycle"] = cycle
        cases.append(("cycle", cycle, "private-cycle-value"))

        deep: dict[str, Any] = {}
        cursor = deep
        for _ in range(20):
            child: dict[str, Any] = {}
            cursor["nested"] = child
            cursor = child
        cases.append(("depth", {"additional": deep}, "private-depth-value"))

        cases.append(("object excess", {f"private_{index}": index for index in range(10_001)}, "private-object-value"))
        cases.append(("array excess", ["private-array-value"] * 10_001, "private-array-value"))

        for label, value, secret in cases:
            with self.subTest(label=label):
                backend = FakeOperationBackend()
                with self.assertRaises(ValueError) as raised:
                    ChatGPT(backend=backend).operations.submit(
                        operation_id="11111111-1111-4111-8111-111111111111",
                        surface="chat",
                        prompt="Do not send.",
                        target=value,
                    )
                self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
                self.assertNotIn(secret, str(raised.exception))
                self.assertEqual(backend.requests, [])

        # The same bounded converter protects request mappings and catches
        # duplicate snake/camel spellings before Pydantic or the backend.
        duplicate = fixture("operation-request.json")
        duplicate["operation_id"] = duplicate["operationId"]
        backend = FakeOperationBackend()
        with self.assertRaises(ValueError) as raised:
            ChatGPT(backend=backend).operations.submit(request=duplicate)
        self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
        self.assertEqual(backend.requests, [])

        poll_duplicate = {
            "handle": fixture("operation-handle.json"),
            "pollIntervalMs": 125,
            "poll_interval_ms": 125,
        }
        with self.assertRaises(ValueError) as raised:
            ChatGPT(backend=backend).operations.collect(request=poll_duplicate)
        self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
        self.assertEqual(backend.requests, [])

        class SpoofedSubmitRequest(OperationSubmitRequest):
            # Module-name checks are not an authority boundary: callers can
            # assign this value on their own subclass.
            __module__ = OperationSubmitRequest.__module__

        spoofed = SpoofedSubmitRequest.from_wire(fixture("operation-request.json"))
        with self.assertRaises(ValueError) as raised:
            ChatGPT(backend=backend).operations.submit(request=spoofed)
        self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
        self.assertEqual(backend.requests, [])

    def test_request_models_reject_explicit_null_optionals_before_transport(self) -> None:
        optional_fields = ("configuration", "files", "capture", "timeoutMs")
        for field in optional_fields:
            with self.subTest(field=field):
                request = fixture("operation-request.json")
                request[field] = None
                backend = FakeOperationBackend()
                with self.assertRaises(ValueError) as raised:
                    ChatGPT(backend=backend).operations.submit(request=request)
                self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
                self.assertEqual(backend.requests, [])

        handle = fixture("operation-handle.json")
        handle["targetBindingDigest"] = None
        backend = FakeOperationBackend()
        with self.assertRaises(ValueError) as raised:
            ChatGPT(backend=backend).operations.collect(request={"handle": handle})
        self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
        self.assertEqual(backend.requests, [])

        for field in ("wait", "timeoutMs", "pollIntervalMs", "responseContent"):
            with self.subTest(field=field):
                request = {"handle": fixture("operation-handle.json"), field: None}
                backend = FakeOperationBackend()
                with self.assertRaises(ValueError) as raised:
                    ChatGPT(backend=backend).operations.collect(request=request)
                self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
                self.assertEqual(backend.requests, [])

        for field in ("steerPrompt", "timeoutMs"):
            with self.subTest(field=field):
                request = fixture("operation-control-request.json")
                request[field] = None
                backend = FakeOperationBackend()
                with self.assertRaises(ValueError) as raised:
                    ChatGPT(backend=backend).operations.control(request=request)
                self.assertEqual(str(raised.exception), "Transactional operation request is invalid.")
                self.assertEqual(backend.requests, [])

    def test_run_accepts_typed_request_without_replacing_its_id(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        chatgpt = ChatGPT(backend=backend)
        request = OperationSubmitRequest.from_wire(fixture("operation-request.json"))

        result = chatgpt.operations.run(request)

        self.assertIsInstance(result, OperationCollectResult)
        self.assertEqual(backend.requests[0][1]["operationId"], request.operation_id)

    def test_submit_rejects_result_for_different_operation(self) -> None:
        backend = FakeOperationBackend()
        mismatched = fixture("operation-submit-result.json")
        mismatched["operationId"] = "22222222-2222-4222-8222-222222222222"
        mismatched["handle"]["operationId"] = mismatched["operationId"]
        backend.responses["operations.submit"] = mismatched
        chatgpt = ChatGPT(backend=backend)

        with self.assertRaisesRegex(ValueError, "different operationId"):
            chatgpt.operations.submit(
                operation_id="11111111-1111-4111-8111-111111111111",
                surface="chat",
                prompt="Identity matters.",
                target={"type": "new"},
            )

    def test_run_returns_blocked_uncertain_and_completed_submit_envelopes_without_collect(self) -> None:
        for status in ("blocked", "uncertain", "completed"):
            with self.subTest(status=status):
                backend = FakeOperationBackend()
                backend.responses["operations.submit"] = submit_variant(status)
                result = ChatGPT(backend=backend).operations.run(
                    operation_id="11111111-1111-4111-8111-111111111111",
                    surface="chat",
                    prompt="Do not repeat.",
                    target={"type": "new"},
                )
                self.assertIsInstance(result, OperationSubmitResult)
                self.assertEqual(result.status, status)
                self.assertEqual([command for command, _payload in backend.requests], ["operations.submit"])

    def test_malformed_and_unknown_envelope_fields_fail_closed_without_echoing_them(self) -> None:
        backend = FakeOperationBackend()
        malformed = fixture("operation-submit-result.json")
        malformed["privatePromptField"] = "do not echo this"
        backend.responses["operations.submit"] = malformed

        with self.assertRaises(ValueError) as raised:
            ChatGPT(backend=backend).operations.submit(
                operation_id="11111111-1111-4111-8111-111111111111",
                surface="chat",
                prompt="Safe request.",
                target={"type": "new"},
            )
        self.assertNotIn("privatePromptField", str(raised.exception))
        self.assertNotIn("do not echo", str(raised.exception))

    def test_blockers_must_match_the_fresh_handle_phase_and_boundary(self) -> None:
        submit = submit_variant("blocked")
        submit["blocker"]["phase"] = "prepared"
        with self.assertRaises(ValueError):
            OperationSubmitResult.from_wire(submit)

        collect = fixture("operation-collect-result.json")
        collect["status"] = "blocked"
        collect.pop("receipt", None)
        collect.pop("liveResponse", None)
        collect["blocker"] = fixture("operation-blocker.json")
        collect["blocker"]["phase"] = "prepared"
        with self.assertRaises(ValueError):
            OperationCollectResult.from_wire(collect)

        control = fixture("operation-control-result.json")
        control["blocker"]["phase"] = "submitted"
        with self.assertRaises(ValueError):
            OperationControlResult.from_wire(control)

    def test_control_receipt_outcome_blockers_and_result_status_are_coherent(self) -> None:
        receipt = fixture("operation-control-receipt.json")
        receipt["blockerCode"] = "operation_timeout"
        completed = fixture("operation-control-result.json")
        completed["status"] = "completed"
        completed.pop("blocker", None)
        completed["receipt"] = receipt
        # Normalize the standalone receipt fixture onto this result identity.
        completed["receipt"]["requestDigest"] = completed["requestDigest"]
        completed["receipt"]["action"] = completed["action"]
        with self.assertRaises(ValueError):
            OperationControlResult.from_wire(completed)

        blocked = copy.deepcopy(completed)
        blocked["status"] = "blocked"
        blocked["blocker"] = fixture("operation-blocker.json")
        blocked["blocker"]["phase"] = blocked["handle"]["phase"]
        blocked["blocker"]["mutationBoundary"] = blocked["handle"]["mutationBoundary"]
        blocked["receipt"]["outcome"] = "not_satisfied"
        blocked["receipt"].pop("evidenceDigest", None)
        blocked["receipt"].pop("blockerCode", None)
        with self.assertRaises(ValueError):
            OperationControlResult.from_wire(blocked)

        blocked["receipt"]["blockerCode"] = "operation_timeout"
        blocked["status"] = "uncertain"
        with self.assertRaises(ValueError):
            OperationControlResult.from_wire(blocked)

    def test_fresh_collect_handle_and_ephemeral_live_response_are_validated(self) -> None:
        backend = FakeOperationBackend()
        mismatched = fixture("operation-collect-result.json")
        mismatched["handle"]["targetBindingDigest"] = "hmac-sha256:" + "c" * 64
        backend.responses["operations.collect"] = mismatched
        handle = OperationHandle.from_wire(fixture("operation-handle.json"))

        with self.assertRaises(ValueError):
            ChatGPT(backend=backend).operations.collect(handle=handle)

        decoded = OperationCollectResult.from_wire(fixture("operation-collect-result.json"))
        assert decoded.live_response is not None
        self.assertEqual(decoded.live_response.durability, "ephemeral")
        self.assertFalse(decoded.live_response.durable)
        self.assertEqual(decoded.live_response.response_format, "markdown")

        astral = copy.deepcopy(fixture("operation-collect-result.json"))["liveResponse"]
        astral["content"] = "😀"
        astral["bytes"] = 4
        astral["chars"] = 2
        decoded_astral = OperationLiveResponseV1.from_wire(astral)
        self.assertEqual(decoded_astral.chars, 2)
        astral["chars"] = 1
        with self.assertRaises(ValueError):
            OperationLiveResponseV1.from_wire(astral)

        null_format = fixture("operation-collect-result.json")
        null_format["liveResponse"]["responseFormat"] = None
        with self.assertRaises(ValueError):
            OperationCollectResult.from_wire(null_format)

        unavailable = fixture("operation-collect-result.json")
        unavailable["receipt"]["contentAvailable"] = False
        with self.assertRaises(ValueError):
            OperationCollectResult.from_wire(unavailable)

        wrong_bytes = fixture("operation-collect-result.json")
        wrong_bytes["receipt"]["responseBytes"] += 1
        with self.assertRaises(ValueError):
            OperationCollectResult.from_wire(wrong_bytes)

        wrong_format = fixture("operation-collect-result.json")
        wrong_format["liveResponse"]["responseFormat"] = "text"
        with self.assertRaises(ValueError):
            OperationCollectResult.from_wire(wrong_format)

        stale = fixture("operation-collect-result.json")
        stale["handle"]["revision"] = 2
        backend.responses["operations.collect"] = stale
        with self.assertRaisesRegex(ValueError, "stale operation revision"):
            ChatGPT(backend=backend).operations.collect(handle=handle)

    def test_same_revision_handles_cannot_change_phase_or_boundary(self) -> None:
        backend = FakeOperationBackend()
        expected = fixture("operation-handle.json")
        pending = fixture("operation-collect-result.json")
        pending["status"] = "pending"
        pending.pop("receipt", None)
        pending.pop("liveResponse", None)
        pending["handle"].update({
            "revision": expected["revision"],
            "phase": "generating",
            "mutationBoundary": expected["mutationBoundary"],
        })
        backend.responses["operations.collect"] = pending

        with self.assertRaisesRegex(ValueError, "conflicting state"):
            ChatGPT(backend=backend).operations.collect(handle=expected)

        control = fixture("operation-control-result.json")
        parent = copy.deepcopy(control["handle"])
        control["handle"]["phase"] = "submitted"
        control["blocker"]["phase"] = "submitted"
        backend.responses["operations.control"] = control
        with self.assertRaisesRegex(ValueError, "conflicting state"):
            ChatGPT(backend=backend).operations.control(
                control_action_id=control["controlActionId"],
                parent=parent,
                action=control["action"],
                expected_assistant_turn_id=control["expectedAssistantTurnId"],
            )

    def test_inspect_status_and_handle_must_match_the_entire_durable_snapshot(self) -> None:
        wrong_status = fixture("operation-inspect-result.json")
        wrong_status["status"] = "completed"
        with self.assertRaises(ValueError):
            OperationInspectResult.from_wire(wrong_status)

        stale_revision = fixture("operation-inspect-result.json")
        stale_revision["handle"]["revision"] = stale_revision["state"]["revision"] - 1
        with self.assertRaises(ValueError):
            OperationInspectResult.from_wire(stale_revision)

        missing_target = fixture("operation-inspect-result.json")
        del missing_target["handle"]["targetBindingDigest"]
        with self.assertRaises(ValueError):
            OperationInspectResult.from_wire(missing_target)

    def test_inspect_and_control_decode_exact_envelopes(self) -> None:
        backend = FakeOperationBackend()
        backend.responses["operations.inspect"] = fixture("operation-inspect-result.json")
        backend.responses["operations.control"] = fixture("operation-control-result.json")
        backend.compatibility = fixture("backend-compatibility.json")
        chatgpt = ChatGPT(backend=backend)
        parent = copy.deepcopy(backend.responses["operations.control"]["handle"])
        parent["revision"] -= 1
        parent["mutationBoundary"] = "send_may_have_occurred"
        inspect_handle = fixture("operation-inspect-result.json")["handle"]

        state = chatgpt.operations.inspect(handle=inspect_handle)
        control = chatgpt.operations.control(
            control_action_id="22222222-2222-4222-8222-222222222222",
            parent=parent,
            action="stop",
            expected_assistant_turn_id="assistant-turn-1",
        )

        self.assertIsInstance(state, OperationInspectResult)
        self.assertIsInstance(control, OperationControlResult)

        self.assertEqual(state.handle.phase, "generating")
        assert state.compatibility is not None
        self.assertEqual(state.compatibility.warnings[0].code, "build_digest_mismatch")
        self.assertEqual(control.handle.request_digest, parent["requestDigest"])
        self.assertEqual(backend.requests[0][1]["handle"]["operationId"], inspect_handle["operationId"])
        self.assertEqual(backend.requests[1][1]["controlActionId"], "22222222-2222-4222-8222-222222222222")

    def test_wire_state_preserves_baseline_witness_and_response_format(self) -> None:
        state = OperationWireState.from_wire(fixture("operation-state.json"))
        self.assertEqual(state.response_format, "markdown")
        self.assertIsNotNone(state.ownership_baseline)
        self.assertIsNotNone(state.submission_witness)
        assert state.ownership_baseline is not None
        assert state.submission_witness is not None
        self.assertEqual(
            state.submission_witness.baseline_snapshot_digest,
            state.ownership_baseline.baseline.snapshot_digest,
        )

    def test_wire_state_accepts_durable_artifact_transfer_maps(self) -> None:
        state = OperationWireState.from_wire(fixture("operation-artifact-transfer-state.json"))
        self.assertIsNotNone(state.artifact_transfers)
        assert state.artifact_transfers is not None
        self.assertEqual(len(state.artifact_transfers), 2)

        explicit_null = fixture("operation-state.json")
        explicit_null["artifactTransfers"] = None
        with self.assertRaises(ValueError):
            OperationWireState.from_wire(explicit_null)

        nested_null = fixture("operation-state.json")
        nested_null["target"]["conversationId"] = None
        with self.assertRaises(ValueError):
            OperationWireState.from_wire(nested_null)


class AsyncOperationClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_run_matches_sync_submit_then_single_collect(self) -> None:
        backend = FakeAsyncOperationBackend()
        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        result = await AsyncChatGPT(backend).operations.run(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="First.",
            target={"type": "new"},
        )

        self.assertIsInstance(result, OperationCollectResult)
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit", "operations.collect"])

    async def test_async_collect_and_run_forward_poll_interval_and_validate_before_transport(self) -> None:
        backend = FakeAsyncOperationBackend()
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        handle = OperationHandle.from_wire(fixture("operation-handle.json"))
        await AsyncChatGPT(backend).operations.collect(handle=handle, poll_interval_ms=250)
        self.assertEqual(backend.requests[0][1]["pollIntervalMs"], 250)

        backend.responses["operations.submit"] = fixture("operation-submit-result.json")
        backend.responses["operations.collect"] = fixture("operation-collect-result.json")
        await AsyncChatGPT(backend).operations.run(
            operation_id="11111111-1111-4111-8111-111111111111",
            surface="chat",
            prompt="Async cadence.",
            target={"type": "new"},
            poll_interval_ms=1,
        )
        self.assertEqual(backend.requests[-1][1]["pollIntervalMs"], 1)

        backend = FakeAsyncOperationBackend()
        with self.assertRaises(ValueError):
            await AsyncChatGPT(backend).operations.collect(
                handle=handle,
                poll_interval_ms=60_001,
            )
        self.assertEqual(backend.requests, [])

        backend = FakeAsyncOperationBackend()
        with self.assertRaises(ValueError):
            await AsyncChatGPT(backend).operations.run(
                operation_id="11111111-1111-4111-8111-111111111111",
                surface="chat",
                prompt="Do not send.",
                target={"type": "new"},
                poll_interval_ms=True,  # type: ignore[arg-type]
            )
        self.assertEqual(backend.requests, [])

    async def test_async_run_returns_blocked_and_uncertain_without_collect(self) -> None:
        for status in ("blocked", "uncertain"):
            with self.subTest(status=status):
                backend = FakeAsyncOperationBackend()
                backend.responses["operations.submit"] = submit_variant(status)
                result = await AsyncChatGPT(backend).operations.run(
                    operation_id="11111111-1111-4111-8111-111111111111",
                    surface="chat",
                    prompt="No retry.",
                    target={"type": "new"},
                )
                self.assertIsInstance(result, OperationSubmitResult)
                self.assertEqual(result.status, status)
                self.assertEqual([command for command, _payload in backend.requests], ["operations.submit"])


if __name__ == "__main__":
    unittest.main()
