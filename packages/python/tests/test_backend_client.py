import unittest

from codex_chatgpt_control.backend import (
    BACKEND_EVENT_SCHEMA_VERSION,
    BACKEND_RESPONSE_SCHEMA_VERSION,
    BackendClient,
)


class RecordingBackendTransport:
    def __init__(self, result: dict | None = None) -> None:
        self.requests: list[dict] = []
        self.result = result or {"ok": True, "status": "ok", "output_text": "backend-ok"}

    def request(self, request: dict) -> dict:
        self.requests.append(request)
        return {
            "schemaVersion": BACKEND_RESPONSE_SCHEMA_VERSION,
            "requestId": request.get("requestId"),
            "ok": True,
            "result": self.result,
        }

    def stream(self, request: dict):
        self.requests.append(request)
        yield {
            "schemaVersion": BACKEND_EVENT_SCHEMA_VERSION,
            "requestId": request.get("requestId"),
            "type": "completed",
            "result": self.result,
        }

    def close(self) -> None:
        pass


class BackendClientTests(unittest.TestCase):
    def test_runner_run_sends_backend_envelope_and_unwraps_result(self) -> None:
        transport = RecordingBackendTransport()
        client = BackendClient(transport=transport)

        result = client.runner_run({"name": "reviewer"}, "Reply with hi.")

        self.assertEqual(result["output_text"], "backend-ok")
        request = transport.requests[0]
        self.assertEqual(request["command"], "runner.run")
        self.assertEqual(request["payload"]["agent"]["name"], "reviewer")
        self.assertEqual(request["payload"]["input"], "Reply with hi.")

    def test_compat_run_accepts_legacy_python_payload(self) -> None:
        transport = RecordingBackendTransport()
        client = BackendClient(transport=transport)

        result = client.run({"agent": {"name": "reviewer"}, "input": "legacy"})

        self.assertEqual(result["status"], "ok")
        self.assertEqual(transport.requests[0]["command"], "runner.run")
        self.assertEqual(transport.requests[0]["payload"]["input"], "legacy")

    def test_stream_returns_backend_events(self) -> None:
        transport = RecordingBackendTransport({"ok": True, "status": "ok"})
        client = BackendClient(transport=transport)

        events = list(client.runner_stream({"name": "reviewer"}, "hi"))

        self.assertEqual(events[-1]["type"], "completed")
        self.assertEqual(transport.requests[0]["command"], "runner.stream")

    def test_fallback_client_ids_use_random_instance_prefixes(self) -> None:
        transport = RecordingBackendTransport()
        first = BackendClient(transport=transport)
        second = BackendClient(transport=transport)

        first.health()
        first.health()
        second.health()
        second.health()

        request_ids = [request["requestId"] for request in transport.requests]
        self.assertEqual(len(request_ids), len(set(request_ids)))
        self.assertTrue(all(request_id.startswith("py_client_") for request_id in request_ids))
        first_prefixes = {request_id.rsplit("_", 1)[0] for request_id in request_ids[:2]}
        second_prefixes = {request_id.rsplit("_", 1)[0] for request_id in request_ids[2:]}
        self.assertEqual(len(first_prefixes), 1)
        self.assertEqual(len(second_prefixes), 1)
        self.assertNotEqual(first_prefixes, second_prefixes)


if __name__ == "__main__":
    unittest.main()
