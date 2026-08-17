import copy
import json
import unittest
from collections.abc import Iterator, Mapping
from datetime import datetime, timezone
from pathlib import Path

from codex_chatgpt_control import ChatGPT, ChatGPTResponse, ChatGPTRunResult
from codex_chatgpt_control.responses import ResponsesClient, response_from_run_result, validate_responses_create_args


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"
FIXED_NOW = datetime(2026, 6, 6, tzinfo=timezone.utc)


class FakeResponsesBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []

    def request(self, command: str, payload: dict) -> dict:
        self.requests.append((command, payload))
        return {
            "id": "chatgpt-browser-response-ok",
            "object": "chatgpt.browser.response",
            "created_at": 1780704000,
            "status": "ok",
            "output_text": "accepted",
            "output": [],
            "browser_control": {"visibleUi": True, "resultStatus": "ok"},
        }


class FakeOperationResponsesBackend:
    def __init__(self, responses: dict[str, dict]) -> None:
        self.responses = responses
        self.requests: list[tuple[str, dict]] = []

    def request(self, command: str, payload: dict) -> dict:
        self.requests.append((command, copy.deepcopy(payload)))
        return copy.deepcopy(self.responses[command])


class HostileKey:
    def __hash__(self) -> int:
        return 1

    def __str__(self) -> str:
        raise AssertionError("caller-controlled key must not be rendered")

    def __repr__(self) -> str:
        raise AssertionError("caller-controlled key must not be represented")


class HashRaisingKey(HostileKey):
    def __hash__(self) -> int:
        raise TypeError("caller-controlled key must not be hashed")


class HostileArgsMapping(Mapping[object, object]):
    def __init__(self, key: object) -> None:
        self._entries = (("input", "visible request"), (key, {"private": "do not disclose"}))

    def __getitem__(self, key: object) -> object:
        for candidate, value in self._entries:
            if key is candidate or (type(key) is str and type(candidate) is str and key == candidate):
                return value
        raise KeyError

    def __iter__(self) -> Iterator[object]:
        return (key for key, _value in self._entries)

    def __len__(self) -> int:
        return len(self._entries)


class HostileTextDict(Mapping[object, object]):
    def __init__(self) -> None:
        self._key = HostileKey()

    def __getitem__(self, key: object) -> object:
        if key is self._key:
            return "do not disclose"
        raise KeyError

    def __iter__(self) -> Iterator[object]:
        yield self._key

    def __len__(self) -> int:
        return 1


class ExplodingArgsMapping(Mapping[object, object]):
    def __getitem__(self, key: object) -> object:
        raise RuntimeError("private mapping state must not escape")

    def __iter__(self) -> Iterator[object]:
        raise RuntimeError("private mapping state must not escape")

    def __len__(self) -> int:
        return 1


class ResponsesTests(unittest.TestCase):
    def test_accepted_browser_fields_pass_validation(self) -> None:
        validation = validate_responses_create_args({
            "input": "hi",
            "thread": {"type": "new"},
            "existing_tab": True,
            "prefer_existing_tab": True,
            "experience": "work",
            "configuration": {"model": "GPT-5.6 Sol", "effort": "High"},
            "attachments": [{"path": "/tmp/a.txt"}],
            "mode": {"model": "auto"},
            "tools": [{"tool": "web_search"}],
            "text": {"format": "markdown"},
            "stream": False,
            "report": False,
            "instructions": "Visible instruction.",
            "instructions_mode": "visible_prefix",
        })

        self.assertTrue(validation.ok)
        self.assertEqual(validation.unsupported, [])

    def test_api_only_field_returns_unsupported_before_backend_call(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)

        response = client.create(input="hi", temperature=0.2)

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "temperature")
        self.assertEqual(backend.requests, [])

    def test_hidden_instructions_match_node_fixture(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)
        expected = json.loads(
            (FIXTURES / "responses-hidden-instructions-unsupported.json").read_text(encoding="utf-8")
        )["response"]

        response = client.create(input="Visible request.", instructions="Hidden instruction request.")

        self.assertEqual(response.to_wire(), expected)
        self.assertEqual(backend.requests, [])

    def test_visible_prefix_instructions_are_accepted(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)

        response = client.create(
            input="Visible request.",
            instructions="Visible instruction.",
            instructions_mode="visible_prefix",
        )

        self.assertEqual(response.status, "ok")
        self.assertEqual(backend.requests[0][0], "responses.create")
        self.assertEqual(backend.requests[0][1]["instructionsMode"], "visible_prefix")

    def test_unknown_field_matches_node_fixture(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)
        expected = json.loads(
            (FIXTURES / "responses-unknown-field-unsupported.json").read_text(encoding="utf-8")
        )["response"]

        response = client.create(input="Visible request.", unknown_control=True)

        self.assertEqual(response.to_wire(), expected)
        self.assertEqual(backend.requests, [])

    def test_accepted_response_calls_backend(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)

        response = client.create(input="hi", text={"format": "markdown"}, stream=False)

        self.assertIsInstance(response, ChatGPTResponse)
        self.assertEqual(response.output_text, "accepted")
        self.assertEqual(backend.requests, [("responses.create", {
            "input": "hi",
            "text": {"format": "markdown"},
            "stream": False,
        })])

    def test_existing_tab_fields_are_normalized_for_backend(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)

        response = client.create(input="hi", existing_tab=True, prefer_existing_tab=True)

        self.assertEqual(response.status, "ok")
        self.assertEqual(backend.requests[0], ("responses.create", {
            "input": "hi",
            "existingTab": True,
            "preferExistingTab": True,
        }))

    def test_surface_fields_are_normalized_for_backend(self) -> None:
        backend = FakeResponsesBackend()
        client = ResponsesClient(backend=backend, now=lambda: FIXED_NOW)

        response = client.create(
            input="hi",
            experience="work",
            configuration={
                "model": "GPT-5.6 Sol",
                "model_version": "5.6",
            },
        )

        self.assertEqual(response.status, "ok")
        self.assertEqual(backend.requests[0], ("responses.create", {
            "input": "hi",
            "experience": "work",
            "configuration": {
                "model": "GPT-5.6 Sol",
                "modelVersion": "5.6",
            },
        }))

    def test_response_from_run_result_preserves_running_status_metadata(self) -> None:
        result = ChatGPTRunResult.from_wire({
            "ok": False,
            "status": "partial",
            "data": {
                "outputText": "partial",
                "completionState": "generating",
                "generationActive": True,
            },
            "output_text": "partial",
            "output": [{
                "type": "message.in_progress",
                "role": "assistant",
                "preview": "partial",
                "output_text": "partial",
                "format": "markdown",
                "completionState": "generating",
                "generationActive": True,
            }],
            "newItems": [],
            "interruptions": [],
            "state": {
                "id": "state-1",
                "resumable": True,
                "completionState": "generating",
            },
            "activeAgentName": "agent",
            "lastAgentName": "agent",
            "warnings": [],
            "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
        })

        response = response_from_run_result(result, FIXED_NOW)

        self.assertEqual(response.browser_control["completionState"], "generating")
        self.assertEqual(response.browser_control["generationActive"], True)

    def test_chatgpt_exposes_responses_client(self) -> None:
        backend = FakeResponsesBackend()
        chatgpt = ChatGPT(backend=backend)

        response = chatgpt.responses.create(input="hi")

        self.assertEqual(response.output_text, "accepted")
        self.assertEqual(backend.requests[0][0], "responses.create")

    def test_transactional_operation_id_is_validated_before_responses_backend_traffic(self) -> None:
        backend = FakeOperationResponsesBackend({})
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Do not send.",
            operation_id="not-a-uuid",
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.browser_control["operationId"], "not-a-uuid")
        self.assertEqual(backend.requests, [])

    def test_transactional_responses_uses_operation_envelopes_and_preserves_identity(self) -> None:
        submit = json.loads((FIXTURES / "operation-submit-result.json").read_text(encoding="utf-8"))
        collect = json.loads((FIXTURES / "operation-collect-result.json").read_text(encoding="utf-8"))
        backend = FakeOperationResponsesBackend({"operations.submit": submit, "operations.collect": collect})
        operation_id = submit["operationId"]

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Summarize this.",
            operation_id=operation_id,
            instructions="Use concise headings.",
            instructions_mode="visible_prefix",
            thread={"type": "conversationId", "conversationId": "conversation-1"},
        )

        self.assertEqual(response.status, "ok")
        self.assertEqual(response.output_text, "safe answer")
        self.assertEqual(response.browser_control["operationId"], operation_id)
        self.assertEqual(response.browser_control["handle"]["operationId"], operation_id)
        self.assertEqual([command for command, _payload in backend.requests], ["operations.submit", "operations.collect"])
        command, payload = backend.requests[0]
        self.assertEqual(command, "operations.submit")
        self.assertEqual(payload["operationId"], operation_id)
        self.assertEqual(payload["target"], {"type": "conversation_id", "conversationId": "conversation-1"})
        self.assertEqual(payload["capture"], {
            "responseContent": "include",
            "responseFormat": "markdown",
            "artifacts": "receipt_only",
        })
        self.assertIn("<user_request>", payload["prompt"])

    def test_transactional_responses_uses_canonical_runner_conversion(self) -> None:
        submit = json.loads((FIXTURES / "operation-submit-result.json").read_text(encoding="utf-8"))
        collect = json.loads((FIXTURES / "operation-collect-result.json").read_text(encoding="utf-8"))
        backend = FakeOperationResponsesBackend({"operations.submit": submit, "operations.collect": collect})

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Format this.",
            operation_id=submit["operationId"],
            text={"format": "text"},
        )

        payload = backend.requests[0][1]
        self.assertNotIn("text", payload)
        self.assertNotIn("instructionsMode", payload)
        self.assertEqual(payload["capture"], {
            "responseContent": "include",
            "responseFormat": "text",
            "artifacts": "receipt_only",
        })
        self.assertEqual(response.output[0]["format"], "text")

    def test_transactional_responses_rejects_non_operation_capture_formats_before_transport(self) -> None:
        submit = json.loads((FIXTURES / "operation-submit-result.json").read_text(encoding="utf-8"))
        backend = FakeOperationResponsesBackend({})

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Do not send.",
            operation_id=submit["operationId"],
            text={"format": "html"},
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.browser_control["unsupported"][0]["path"], "text.format")
        self.assertEqual(backend.requests, [])

    def test_transactional_responses_propagates_operation_identity_mismatch(self) -> None:
        submit = json.loads((FIXTURES / "operation-submit-result.json").read_text(encoding="utf-8"))
        submit["operationId"] = "22222222-2222-4222-8222-222222222222"
        submit["handle"]["operationId"] = submit["operationId"]
        backend = FakeOperationResponsesBackend({"operations.submit": submit})

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Identity.",
            operation_id="11111111-1111-4111-8111-111111111111",
        )
        self.assertEqual(response.status, "error")
        self.assertEqual(response.output_text, "")

    def test_responses_input_is_a_bounded_documented_json_surface(self) -> None:
        backend = FakeResponsesBackend()
        valid = [
            {"type": "visible_instruction", "text": "Visible instruction."},
            {"type": "input_text", "text": "Visible request.", "role": "user"},
            {"type": "input_file", "path": "/tmp/example.txt", "description": "Example."},
        ]
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(input=valid)
        self.assertEqual(response.status, "ok")
        self.assertEqual(backend.requests[0][1]["input"], valid)

        secret = "PRIVATE ARBITRARY INPUT"
        invalid_inputs = (
            object(),
            {"type": "input_text", "text": secret},
            [object()],
            [{"type": "input_text", "text": object()}],
            [{"type": "unknown", "private": secret}],
        )
        for value in invalid_inputs:
            with self.subTest(value_type=type(value).__name__):
                backend = FakeResponsesBackend()
                response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(input=value)
                self.assertEqual(response.status, "unsupported")
                self.assertEqual(response.unsupported_fields[0]["path"], "input")
                self.assertNotIn(secret, repr(response.to_wire()))
                self.assertEqual(backend.requests, [])

    def test_unhashable_response_format_returns_structured_unsupported(self) -> None:
        backend = FakeResponsesBackend()

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Do not send.",
            text={"format": []},
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "text.format")
        self.assertEqual(backend.requests, [])

    def test_unknown_nested_text_option_returns_structured_unsupported(self) -> None:
        backend = FakeResponsesBackend()

        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Do not send.",
            text={"format": "markdown", "unknown": {"value": []}},
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "text.unknown")
        self.assertEqual(backend.requests, [])

    def test_non_string_top_level_key_uses_safe_marker_without_backend_call(self) -> None:
        backend = FakeResponsesBackend()
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            args=HostileArgsMapping(HostileKey()),
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "<invalid-field>")
        self.assertNotIn("private", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    def test_direct_validation_of_hostile_mapping_uses_safe_marker(self) -> None:
        validation = validate_responses_create_args(HostileArgsMapping(HostileKey()))

        self.assertFalse(validation.ok)
        self.assertEqual(validation.unsupported[0]["path"], "<invalid-field>")
        self.assertNotIn("private", repr(validation.unsupported))

    def test_hash_raising_top_level_key_is_structured_without_backend_call(self) -> None:
        backend = FakeResponsesBackend()
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            args=HostileArgsMapping(HashRaisingKey()),
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "<invalid-field>")
        self.assertNotIn("caller-controlled", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    def test_non_string_text_key_uses_nested_safe_marker_without_rendering(self) -> None:
        backend = FakeResponsesBackend()
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            input="Do not send.",
            text=HostileTextDict(),
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "text.<invalid-field>")
        self.assertNotIn("do not disclose", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    def test_hostile_top_level_mapping_returns_structured_unsupported(self) -> None:
        backend = FakeResponsesBackend()
        response = ResponsesClient(backend=backend, now=lambda: FIXED_NOW).create(
            args=ExplodingArgsMapping(),
        )

        self.assertEqual(response.status, "unsupported")
        self.assertEqual(response.unsupported_fields[0]["path"], "<invalid-field>")
        self.assertNotIn("private mapping state", repr(response.to_wire()))
        self.assertEqual(backend.requests, [])

    def test_response_mapping_emits_untrusted_output_without_request_digest(self) -> None:
        result = ChatGPTRunResult.from_wire({
            "ok": True,
            "status": "ok",
            "data": {
                "outputText": "safe answer",
                "requestDigest": "hmac-sha256:" + "a" * 64,
                "operationId": "11111111-1111-4111-8111-111111111111",
            },
            "output_text": "safe answer",
            "output": [{
                "type": "message.completed",
                "role": "assistant",
                "output_text": "safe answer",
                "format": "markdown",
            }],
            "newItems": [],
            "interruptions": [],
            "state": {"id": "state-1", "resumable": False},
            "activeAgentName": "agent",
            "lastAgentName": "agent",
            "warnings": [],
            "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
        })

        response = response_from_run_result(result, FIXED_NOW)

        self.assertEqual(response.browser_control["operationId"], "11111111-1111-4111-8111-111111111111")
        self.assertNotIn("requestDigest", response.browser_control)
        assert response.untrusted_output is not None
        self.assertEqual(response.untrusted_output["trusted"], False)


if __name__ == "__main__":
    unittest.main()
