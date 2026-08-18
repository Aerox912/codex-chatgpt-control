import asyncio
import json
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import warnings
from pathlib import Path
from typing import Any, cast

from codex_chatgpt_control.backend import (
    BACKEND_EVENT_SCHEMA_VERSION,
    BACKEND_REQUEST_SCHEMA_VERSION,
    BACKEND_RESPONSE_SCHEMA_VERSION,
    DEFAULT_BACKEND_MAX_IN_FLIGHT,
    MAX_BACKEND_BUFFER_LIMIT,
    MAX_BACKEND_STREAM_QUEUE_BYTES,
    MAX_BACKEND_WRITE_QUEUE_BYTES,
    MIN_BACKEND_MAX_IN_FLIGHT,
    BackendClient,
    BackendProtocolError,
    BackendTransportError,
    StdioBackendTransport,
)
from codex_chatgpt_control.async_client import _ACTIVE_ASYNC_EXECUTION, _AsyncExecution


class StdioBackendTransportTests(unittest.TestCase):
    def test_request_writes_one_envelope_line_and_parses_response(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            seen_path = Path(tmp) / "seen.jsonl"
            transport = StdioBackendTransport(
                command=fake_backend_command(
                    f"""
                    import json
                    import pathlib
                    import sys
                    line = sys.stdin.readline()
                    pathlib.Path({str(seen_path)!r}).write_text(line, encoding="utf-8")
                    request = json.loads(line)
                    print(json.dumps({{
                        "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                        "requestId": request.get("requestId"),
                        "ok": True,
                        "result": {{"seenCommand": request["command"]}},
                    }}), flush=True)
                    """
                )
            )
            try:
                response = transport.request(backend_request("backend.version", request_id="req_one"))
            finally:
                transport.close()

            self.assertEqual(response["result"]["seenCommand"], "backend.version")
            written = seen_path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(written), 1)
            self.assertEqual(json.loads(written[0])["requestId"], "req_one")

    def test_protocol_error_response_raises_protocol_error(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                f"""
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({{
                    "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                    "requestId": request.get("requestId"),
                    "ok": False,
                    "error": {{
                        "code": "unknown_command",
                        "message": "No such command.",
                        "recoverable": False,
                    }},
                }}), flush=True)
                """
            )
        )
        try:
            with self.assertRaises(BackendProtocolError) as error:
                transport.request(backend_request("backend.version"))
        finally:
            transport.close()

        self.assertEqual(error.exception.code, "unknown_command")
        self.assertFalse(error.exception.recoverable)

    def test_nonzero_process_exit_raises_transport_error(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import sys
                sys.stderr.write("backend failed")
                sys.exit(7)
                """
            )
        )
        try:
            with self.assertRaises(BackendTransportError) as error:
                transport.request(backend_request("backend.version"))
        finally:
            transport.close()

        self.assertEqual(error.exception.returncode, 7)
        self.assertNotIn("backend failed", error.exception.stderr)
        self.assertIn("stderr_present=true", error.exception.stderr)

    def test_invalid_json_response_raises_transport_error(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import sys
                sys.stdin.readline()
                print("not-json", flush=True)
                """
            )
        )
        try:
            with self.assertRaises(BackendTransportError) as error:
                transport.request(backend_request("backend.version"))
        finally:
            transport.close()

        self.assertIn("invalid JSON", str(error.exception))

    def test_large_stderr_is_drained_while_waiting_for_stdout(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                f"""
                import json
                import sys
                sys.stderr.write("x" * 200000)
                sys.stderr.flush()
                request = json.loads(sys.stdin.readline())
                print(json.dumps({{
                    "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                    "requestId": request.get("requestId"),
                    "ok": True,
                    "result": {{"stderrDrained": True}},
                }}), flush=True)
                """
            ),
            timeout_seconds=5,
        )
        try:
            response = transport.request(backend_request("backend.version"))
        finally:
            transport.close()

        self.assertEqual(response["result"], {"stderrDrained": True})
        self.assertLessEqual(transport._stderr_bytes, MAX_BACKEND_BUFFER_LIMIT)
        self.assertNotIn("x", transport._read_stderr(transport._process))

    def test_stream_yields_events_until_completed(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                f"""
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({{
                    "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                    "requestId": request.get("requestId"),
                    "type": "run_item_stream_event",
                    "name": "message.submitted",
                    "item": {{"type": "message.submitted"}},
                }}), flush=True)
                print(json.dumps({{
                    "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                    "requestId": request.get("requestId"),
                    "type": "completed",
                    "result": {{"ok": True, "status": "ok"}},
                }}), flush=True)
                """
            )
        )
        try:
            events = list(transport.stream(backend_request("runner.stream", request_id="req_stream")))
        finally:
            transport.close()

        self.assertEqual([event["type"] for event in events], ["run_item_stream_event", "completed"])
        self.assertEqual(events[0]["name"], "message.submitted")

    def test_hello_downgrades_capability_limited_backend_to_single_flight(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                import threading
                import time
                state = {"in_flight": 0, "max_in_flight": 0}
                lock = threading.Lock()
                def emit(request):
                    if request["command"] != "backend.health":
                        return
                    with lock:
                        state["in_flight"] += 1
                        state["max_in_flight"] = max(state["max_in_flight"], state["in_flight"])
                    time.sleep(0.04)
                    print(json.dumps({
                        "schemaVersion": "chatgpt.browser_control.backend_response.v1",
                        "requestId": request["requestId"], "ok": True,
                        "result": {"maxInFlight": state["max_in_flight"]},
                    }), flush=True)
                    with lock:
                        state["in_flight"] -= 1
                for line in sys.stdin:
                    threading.Thread(target=emit, args=(json.loads(line),), daemon=True).start()
                """,
                multiplexing=(False, False),
            ),
            timeout_seconds=2,
        )
        results: list[dict] = []
        errors: list[BaseException] = []
        try:
            def run_one(index: int) -> None:
                try:
                    results.append(transport.request(backend_request("backend.health", request_id=f"single_{index}")))
                except BaseException as exc:
                    errors.append(exc)

            threads = [threading.Thread(target=run_one, args=(index,)) for index in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=2)
            self.assertFalse(errors)
            self.assertEqual(transport._handshake_state, "single-flight")
            self.assertEqual(transport._handshake_generation, 1)
            self.assertEqual(len(results), 4)
            self.assertTrue(all(result["result"]["maxInFlight"] == 1 for result in results))
        finally:
            transport.close()

    def test_stream_close_before_first_iteration_releases_unsent_reservation(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            stream = cast(Any, transport.stream(backend_request("runner.stream", request_id="never_written")))
            stream.close()
            self.assertNotIn("never_written", transport._reservations)
            self.assertNotIn("never_written", transport._unresolved_tombstones)
            self.assertNotIn("never_written", transport._cancelled_reservations)
            self.assertFalse(transport.cancel("unknown_cancel_id"))
            self.assertNotIn("unknown_cancel_id", transport._unresolved_tombstones)
        finally:
            transport.close()

    def test_pending_write_admission_is_bounded_by_count_and_utf8_bytes(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            write_queue_limit=1,
            write_queue_bytes_limit=4,
        )
        try:
            admission = transport._admit_write("utf8", len("é".encode("utf-8")))
            with self.assertRaises(BackendTransportError) as count_error:
                transport._admit_write("count", 1)
            self.assertEqual(count_error.exception.code, "backend_write_queue_overflow")
            transport._release_write(admission)

            admission = transport._admit_write("bytes", 4)
            with self.assertRaises(BackendTransportError) as byte_error:
                transport._admit_write("overflow", 1)
            self.assertEqual(byte_error.exception.code, "backend_write_queue_overflow")
            transport._release_write(admission)
            self.assertEqual(transport._write_queue_bytes, 0)
            self.assertEqual(len(transport._active_writes), 0)
        finally:
            transport.close()

    def test_invalid_json_payload_is_rejected_before_write_without_poisoning_session(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            invalid_values: tuple[Any, ...] = (float("nan"), {"cycle": None})
            for invalid in invalid_values:
                if isinstance(invalid, dict):
                    invalid["cycle"] = invalid
                with self.assertRaises(BackendTransportError) as error:
                    transport.request(backend_request("backend.health", payload={"value": invalid}))
                self.assertEqual(error.exception.code, "invalid_backend_request")
                self.assertNotIn("cycle", str(error.exception))

            healthy = transport.request(backend_request("backend.health", request_id="after_invalid_json"))
            self.assertEqual(healthy["result"]["requestId"], "after_invalid_json")
        finally:
            transport.close()

    def test_hello_identity_drift_is_a_warning_not_silent(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_response.v1", "requestId": request["requestId"], "ok": True, "result": {}}), flush=True)
                """
            ),
            expected_package_name="expected-package",
            expected_package_version="9.9.9",
            expected_build_digest="expected-build",
        )
        try:
            with warnings.catch_warnings(record=True) as observed:
                warnings.simplefilter("always")
                transport.request(backend_request("backend.health", request_id="drift"))
            self.assertEqual(len(observed), 3)
            self.assertTrue(all("drift" in str(item.message) for item in observed))
        finally:
            transport.close()

    def test_hello_retains_build_drift_without_requiring_exact_package_version(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_response.v1", "requestId": request["requestId"], "ok": True, "result": {"requestId": request["requestId"]}}), flush=True)
                """
            ),
            expected_package_name="fixture-backend",
            expected_package_version="0.0.0",
            expected_build_digest="expected-build",
            expected_runtime="node",
            expected_runtime_version="fixture-runtime",
        )
        try:
            response = transport.request(backend_request("backend.health", request_id="compatibility"))
            report = transport.compatibility_report()
        finally:
            transport.close()

        self.assertEqual(response["result"]["requestId"], "compatibility")
        self.assertIsNotNone(report)
        assert report is not None
        self.assertEqual(report["status"], "warning")
        self.assertEqual(report["packageVersion"], "0.0.0")
        self.assertEqual(report["buildDigest"], "fixture-build")
        self.assertEqual([warning["code"] for warning in report["warnings"]], ["build_digest_mismatch"])

    def test_request_id_bounds_and_control_namespace_are_rejected(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command())
        try:
            for request_id in ("", " leading", "trailing ", "line\nfeed", "x" * 4097, "__backend_control__user"):
                with self.subTest(request_id=request_id):
                    with self.assertRaises(BackendTransportError):
                        transport.request(backend_request("backend.health", request_id=request_id))
                    self.assertNotIn(request_id, transport._reservations)
        finally:
            transport.close()

    def test_bounded_frames_reject_oversized_and_unterminated_stdout(self) -> None:
        oversized = StdioBackendTransport(
            command=fake_backend_command(
                """
                import sys
                sys.stdin.readline()
                print("x" * 5000, flush=True)
                """
            ),
            frame_limit_bytes=4096,
        )
        try:
            with self.assertRaises(BackendTransportError) as error:
                oversized.request(backend_request("backend.health", request_id="oversized"))
            self.assertEqual(error.exception.code, "backend_frame_too_large")
        finally:
            oversized.close()

        unterminated = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                sys.stdout.write(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_response.v1", "requestId": request["requestId"], "ok": True, "result": {}}))
                sys.stdout.flush()
                """
            ),
            frame_limit_bytes=4096,
        )
        try:
            with self.assertRaises(BackendTransportError) as error:
                unterminated.request(backend_request("backend.health", request_id="unterminated"))
            self.assertEqual(error.exception.code, "backend_unterminated_frame")
        finally:
            unterminated.close()

    def test_stream_deadline_is_total_across_iterations(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                import time
                request = json.loads(sys.stdin.readline())
                time.sleep(0.01)
                for index in range(2):
                    print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_event.v1", "requestId": request["requestId"], "type": "run_item_stream_event", "name": str(index), "item": {}}), flush=True)
                    time.sleep(0.15)
                print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_event.v1", "requestId": request["requestId"], "type": "completed", "result": {}}), flush=True)
                """
            ),
            timeout_seconds=0.1,
        )
        try:
            stream = transport.stream(backend_request("runner.stream", request_id="total_deadline"))
            self.assertEqual(next(stream)["name"], "0")
            time.sleep(0.06)
            with self.assertRaises(BackendTransportError) as error:
                next(stream)
            self.assertEqual(error.exception.code, "backend_timeout")
            self.assertTrue(error.exception.unresolved)
            self.assertIn("total_deadline", transport._unresolved_tombstones)
        finally:
            transport.close()

    def test_broker_routes_out_of_order_unary_and_stream_messages(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=3,
            max_stream_queue_size=16,
        )
        try:
            first_stream = transport.stream(
                backend_request("runner.stream", request_id="stream_one", payload={"delay": 0.04})
            )
            second_stream = transport.stream(
                backend_request("runner.stream", request_id="stream_two", payload={"delay": 0.01})
            )
            stream_results: dict[str, list[dict]] = {}

            def consume(name: str, source) -> None:
                stream_results[name] = list(source)

            stream_threads = [
                threading.Thread(target=consume, args=("one", first_stream)),
                threading.Thread(target=consume, args=("two", second_stream)),
            ]
            for thread in stream_threads:
                thread.start()

            unary_results: dict[str, str] = {}
            unary_errors: list[BaseException] = []

            def request_one(index: int) -> None:
                try:
                    value = transport.request(
                        backend_request(
                            "backend.health",
                            request_id=f"unary_{index}",
                            payload={"delay": 0.02 if index % 2 else 0.0},
                        )
                    )
                    unary_results[str(index)] = value["result"]["requestId"]
                except BaseException as exc:  # pragma: no cover - assertion below reports details.
                    unary_errors.append(exc)

            unary_threads = [threading.Thread(target=request_one, args=(index,)) for index in range(12)]
            for thread in unary_threads:
                thread.start()
            for thread in [*unary_threads, *stream_threads]:
                thread.join(timeout=3)

            self.assertFalse(unary_errors)
            self.assertEqual(set(unary_results.values()), {f"unary_{index}" for index in range(12)})
            self.assertEqual([event["type"] for event in stream_results["one"]], ["run_item_stream_event", "completed"])
            self.assertEqual([event["type"] for event in stream_results["two"]], ["run_item_stream_event", "completed"])
            self.assertEqual(stream_results["one"][0]["name"], "stream_one:first")
            self.assertEqual(stream_results["two"][0]["name"], "stream_two:first")
        finally:
            transport.close()

    def test_request_id_allocator_is_shared_when_clients_share_transport(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        clients = [BackendClient(transport), BackendClient(transport)]
        request_ids: list[str] = []
        errors: list[BaseException] = []

        def request_one(index: int) -> None:
            try:
                result = clients[index % 2].request("backend.health")
                request_ids.append(result["requestId"])
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        threads = [threading.Thread(target=request_one, args=(index,)) for index in range(10)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=2)
        try:
            self.assertFalse(errors)
            self.assertEqual(len(request_ids), 10)
            self.assertEqual(len(set(request_ids)), 10)
        finally:
            transport.close()

    def test_unknown_id_quarantines_new_work_but_active_routes_can_settle(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=2,
            tombstone_grace_seconds=0.5,
            quarantine_grace_seconds=0.2,
        )
        healthy_result: list[dict] = []
        unknown_result: list[dict] = []
        errors: list[BaseException] = []

        def run_healthy() -> None:
            try:
                healthy_result.append(
                    transport.request(
                        backend_request("backend.health", request_id="active_healthy", payload={"delay": 0.08})
                    )
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        def run_unknown() -> None:
            try:
                unknown_result.append(
                    transport.request(
                        backend_request("unknown_output", request_id="active_unknown", payload={"delay": 0.04})
                    )
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        healthy_thread = threading.Thread(target=run_healthy)
        healthy_thread.start()
        time.sleep(0.02)
        unknown_thread = threading.Thread(target=run_unknown)
        unknown_thread.start()
        try:
            deadline = time.monotonic() + 1.0
            while True:
                with transport._state_lock:
                    quarantined_error = transport._quarantine_error
                if quarantined_error is not None:
                    break
                if time.monotonic() >= deadline:
                    self.fail("backend never entered unknown-request quarantine")
                time.sleep(0.005)
            with self.assertRaises(BackendTransportError) as quarantined:
                transport.request(backend_request("backend.health", request_id="new_during_quarantine"))
            self.assertIn("unknown requestId", str(quarantined.exception))
            self.assertFalse(quarantined.exception.fatal)

            healthy_thread.join(timeout=2)
            unknown_thread.join(timeout=2)
            self.assertFalse(errors)
            self.assertEqual(healthy_result[0]["result"]["requestId"], "active_healthy")
            self.assertEqual(unknown_result[0]["result"]["requestId"], "active_unknown")

            time.sleep(0.3)
            recycled = transport.request(backend_request("backend.health", request_id="after_quarantine"))
            self.assertEqual(recycled["result"]["requestId"], "after_quarantine")
        finally:
            transport.close()

    def test_late_terminal_before_drain_grace_resolves_unresolved_tombstone(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=0.04,
            tombstone_grace_seconds=0.3,
            quarantine_grace_seconds=0.1,
            tombstone_ttl_seconds=0.5,
        )
        try:
            with self.assertRaises(BackendTransportError):
                transport.request(backend_request("hold", request_id="resolvable", payload={"delay": 0.12}))
            self.assertIn("resolvable", transport._unresolved_tombstones)
            time.sleep(0.18)
            self.assertNotIn("resolvable", transport._unresolved_tombstones)
            # Node removes the late-output tombstone once its terminal record is observed;
            # terminal request IDs are reusable and are not retained as cache entries.
            self.assertNotIn("resolvable", transport._unresolved_tombstones)
            self.assertIsNone(transport._tombstone_timer)
            self.assertIsNone(transport._tombstone_timer_deadline)
            healthy = transport.request(backend_request("backend.health", request_id="after_resolve"))
            self.assertEqual(healthy["result"]["requestId"], "after_resolve")
            self.assertIsNone(transport._quarantine_error)
        finally:
            transport.close()

    def test_late_terminal_after_drain_grace_quarantines_and_recycles(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=0.04,
            tombstone_grace_seconds=0.08,
            quarantine_grace_seconds=0.3,
        )
        try:
            with self.assertRaises(BackendTransportError):
                transport.request(backend_request("hold", request_id="expired", payload={"delay": 0.2}))
            time.sleep(0.13)
            self.assertIsNotNone(transport._quarantine_error)
            time.sleep(0.15)  # The late terminal record is drained but cannot resolve the expired tombstone.
            self.assertIn("expired", transport._unresolved_tombstones)
            with self.assertRaises(BackendTransportError) as quarantined:
                transport.request(backend_request("backend.health", request_id="after_expired_grace"))
            self.assertFalse(quarantined.exception.fatal)
            time.sleep(0.4)
            recycled = transport.request(backend_request("backend.health", request_id="after_recycle"))
            self.assertEqual(recycled["result"]["requestId"], "after_recycle")
            self.assertIsNone(transport._tombstone_timer)
            self.assertIsNone(transport._quarantine_timer)
            self.assertIsNone(transport._quarantine_deadline)
        finally:
            transport.close()

    def test_tombstone_bound_quarantines_instead_of_growing_memory(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=2,
            max_tombstones=1,
            quarantine_grace_seconds=0.1,
        )
        try:
            transport.timeout_seconds = 0.04
            with self.assertRaises(BackendTransportError):
                transport.request(backend_request("hold", request_id="bound_one", payload={"delay": 0.2}))
            self.assertEqual(len(transport._unresolved_tombstones), 1)
            with self.assertRaises(BackendTransportError):
                transport.request(backend_request("hold", request_id="bound_two", payload={"delay": 0.2}))
            with self.assertRaises(BackendTransportError) as quarantined:
                transport.request(backend_request("backend.health", request_id="bound_three"))
            self.assertIn("tombstone limit", str(quarantined.exception))
            time.sleep(0.15)
            recycled = transport.request(backend_request("backend.health", request_id="bound_four"))
            self.assertEqual(recycled["result"]["requestId"], "bound_four")
        finally:
            transport.close()

    def test_invalid_json_wakes_all_active_routes_and_recycles(self) -> None:
        transport = StdioBackendTransport(command=malformed_backend_command(), timeout_seconds=2)
        errors: list[BaseException] = []

        def request_one(request_id: str) -> None:
            try:
                transport.request(backend_request("backend.health", request_id=request_id))
            except BaseException as exc:
                errors.append(exc)

        started = time.monotonic()
        threads = [threading.Thread(target=request_one, args=(f"malformed_{index}",)) for index in range(2)]
        for thread in threads:
            thread.start()
        try:
            for thread in threads:
                thread.join(timeout=2)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertTrue(all(isinstance(error, BackendTransportError) for error in errors))
            self.assertEqual(len(errors), 2)
            self.assertTrue(all(error.fatal for error in errors if isinstance(error, BackendTransportError)))
        finally:
            transport.close()

    def test_known_response_and_event_shapes_are_strictly_validated(self) -> None:
        response_transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_response.v1", "requestId": request["requestId"], "ok": True, "result": {}, "unexpected": True}), flush=True)
                """
            )
        )
        try:
            with self.assertRaises(BackendTransportError) as error:
                response_transport.request(backend_request("backend.health", request_id="bad_shape_response"))
            self.assertEqual(error.exception.code, "invalid_backend_message")
            self.assertTrue(error.exception.fatal)
        finally:
            response_transport.close()

        event_transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                print(json.dumps({"schemaVersion": "chatgpt.browser_control.backend_event.v1", "requestId": request["requestId"], "type": "unsupported_event"}), flush=True)
                """
            )
        )
        try:
            stream = event_transport.stream(backend_request("runner.stream", request_id="bad_shape_event"))
            with self.assertRaises(BackendTransportError) as error:
                next(stream)
            self.assertEqual(error.exception.code, "invalid_backend_event")
            self.assertTrue(error.exception.fatal)
        finally:
            event_transport.close()

    def test_cancel_before_worker_registration_reserves_request_id(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        request_id = transport.allocate_request_id()
        try:
            self.assertFalse(transport.cancel(request_id))
            self.assertNotIn(request_id, transport._unresolved_tombstones)
            self.assertIsNone(transport._process)
            healthy = transport.request(backend_request("backend.health", request_id=request_id))
            self.assertEqual(healthy["result"]["requestId"], request_id)
        finally:
            transport.close()

    def test_transport_options_reject_unbounded_or_invalid_values(self) -> None:
        invalid_options = [
            {"timeout_seconds": 0},
            {"timeout_seconds": float("inf")},
            {"timeout_seconds": 2_147_484},
            {"max_stream_queue_size": 0},
            {"max_stream_queue_size": MAX_BACKEND_BUFFER_LIMIT + 1},
            {"max_stream_queue_bytes": 0},
            {"max_stream_queue_bytes": MAX_BACKEND_STREAM_QUEUE_BYTES + 1},
            {"write_queue_limit": 0},
            {"write_queue_limit": MAX_BACKEND_BUFFER_LIMIT + 1},
            {"write_queue_bytes_limit": 0},
            {"write_queue_bytes_limit": MAX_BACKEND_WRITE_QUEUE_BYTES + 1},
            {"frame_limit_bytes": 16 * 1024 * 1024 + 1},
            {"tombstone_ttl_seconds": 0},
            {"tombstone_grace_seconds": -1},
            {"quarantine_grace_seconds": float("nan")},
            {"max_tombstones": 0},
            {"max_tombstones": MAX_BACKEND_BUFFER_LIMIT + 1},
            {"max_in_flight": True},
            {"max_in_flight": 1},
            {"max_in_flight": 2.5},
            {"max_in_flight": MAX_BACKEND_BUFFER_LIMIT + 1},
            {"expected_package_name": " package"},
            {"expected_build_digest": "x" * 513},
        ]
        for options in invalid_options:
            with self.subTest(options=options):
                with self.assertRaises(ValueError):
                    StdioBackendTransport(command=[sys.executable], **options)

    def test_max_in_flight_default_and_lower_bound_match_node_contract(self) -> None:
        transport = StdioBackendTransport(command=[sys.executable])
        self.assertEqual(transport.max_in_flight, DEFAULT_BACKEND_MAX_IN_FLIGHT)
        self.assertEqual(MIN_BACKEND_MAX_IN_FLIGHT, 2)

    def test_handshake_control_route_coexists_with_first_caller_at_minimum(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            max_in_flight=MIN_BACKEND_MAX_IN_FLIGHT,
            timeout_seconds=2,
        )
        control_entered = threading.Event()
        release_control = threading.Event()
        result: list[dict] = []
        errors: list[BaseException] = []
        original_reserve = transport._reserve_request_id

        def reserve_and_hold_control(request_id: str, kind: str, *, control: bool = False) -> None:
            original_reserve(request_id, kind, control=control)  # type: ignore[arg-type]
            if control:
                control_entered.set()
                self.assertTrue(release_control.wait(timeout=2))

        transport._reserve_request_id = reserve_and_hold_control  # type: ignore[method-assign]

        def first_request() -> None:
            try:
                result.append(transport.request(backend_request("backend.health", request_id="first_minimum")))
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        thread = threading.Thread(target=first_request)
        thread.start()
        try:
            self.assertTrue(control_entered.wait(timeout=1))
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), MIN_BACKEND_MAX_IN_FLIGHT)
            with self.assertRaises(BackendTransportError) as saturated:
                transport.request(backend_request("backend.health", request_id="secret_saturated_request"))
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            self.assertNotIn("secret_saturated_request", str(saturated.exception))
            release_control.set()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(errors)
            self.assertEqual(result[0]["result"]["requestId"], "first_minimum")
        finally:
            release_control.set()
            transport._reserve_request_id = original_reserve  # type: ignore[method-assign]
            transport.close()

    def test_unknown_handshake_reserves_control_headroom_before_second_caller(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            max_in_flight=MIN_BACKEND_MAX_IN_FLIGHT,
            timeout_seconds=2,
        )
        caller_reserved = threading.Event()
        release_caller = threading.Event()
        first_result: list[dict] = []
        first_errors: list[BaseException] = []
        original_ensure_handshake = transport._ensure_handshake

        def pause_before_handshake() -> None:
            caller_reserved.set()
            self.assertTrue(release_caller.wait(timeout=2))
            original_ensure_handshake()

        transport._ensure_handshake = pause_before_handshake  # type: ignore[method-assign]

        def first_request() -> None:
            try:
                first_result.append(transport.request(backend_request("backend.health", request_id="headroom_first")))
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                first_errors.append(exc)

        thread = threading.Thread(target=first_request)
        thread.start()
        try:
            self.assertTrue(caller_reserved.wait(timeout=1))
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), 1)
                self.assertEqual(transport._handshake_state, "unknown")
            with self.assertRaises(BackendTransportError) as saturated:
                transport.request(backend_request("backend.health", request_id="headroom_second"))
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            self.assertNotIn("headroom_second", str(saturated.exception))
            release_caller.set()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(first_errors)
            self.assertEqual(first_result[0]["result"]["requestId"], "headroom_first")
        finally:
            release_caller.set()
            transport._ensure_handshake = original_ensure_handshake  # type: ignore[method-assign]
            transport.close()

    def test_admitted_hello_control_uses_full_configured_bound(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            max_in_flight=4,
            timeout_seconds=2,
        )
        control_entered = threading.Event()
        release_control = threading.Event()
        results: list[dict] = []
        errors: list[BaseException] = []
        original_reserve = transport._reserve_request_id

        def reserve_and_hold_control(request_id: str, kind: str, *, control: bool = False) -> None:
            original_reserve(request_id, kind, control=control)  # type: ignore[arg-type]
            if control:
                control_entered.set()
                self.assertTrue(release_control.wait(timeout=2))

        transport._reserve_request_id = reserve_and_hold_control  # type: ignore[method-assign]

        def request_one(request_id: str) -> None:
            try:
                results.append(transport.request(backend_request("backend.health", request_id=request_id)))
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        first = threading.Thread(target=request_one, args=("hello_full_first",))
        second = threading.Thread(target=request_one, args=("hello_full_second",))
        first.start()
        try:
            self.assertTrue(control_entered.wait(timeout=1))
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), 2)
                self.assertEqual(transport._control_reservations, 1)

            # With the hello reservation charged, two more user routes fill
            # the configured bound.  A third additional caller must reject.
            third = threading.Thread(target=request_one, args=("hello_full_third",))
            second.start()
            third.start()
            deadline = time.monotonic() + 1
            while True:
                with transport._state_lock:
                    if {"hello_full_second", "hello_full_third"}.issubset(transport._reservations):
                        transport._assert_admission_invariants_locked()
                        self.assertEqual(transport._admitted_request_count_locked(), 4)
                        self.assertEqual(transport._control_reservations, 1)
                        break
                if time.monotonic() >= deadline:
                    self.fail("two callers were not admitted alongside the active hello")
                time.sleep(0.005)

            with self.assertRaises(BackendTransportError) as saturated:
                transport.request(backend_request("backend.health", request_id="hello_full_rejected"))
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            self.assertNotIn("hello_full_rejected", str(saturated.exception))

            release_control.set()
            first.join(timeout=2)
            second.join(timeout=2)
            third.join(timeout=2)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertFalse(third.is_alive())
            self.assertFalse(errors)
            self.assertEqual({result["result"]["requestId"] for result in results}, {
                "hello_full_first",
                "hello_full_second",
                "hello_full_third",
            })
        finally:
            release_control.set()
            transport._reserve_request_id = original_reserve  # type: ignore[method-assign]
            transport.close()

    def test_mixed_request_and_legacy_waiter_are_bounded_without_double_counting(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                import time
                for line in sys.stdin:
                    request = json.loads(line)
                    time.sleep(float((request.get("payload") or {}).get("delay", 0)))
                    print(json.dumps({
                        "schemaVersion": "chatgpt.browser_control.backend_response.v1",
                        "requestId": request["requestId"], "ok": True,
                        "result": {"requestId": request["requestId"]},
                    }), flush=True)
                """,
                multiplexing=(False, False),
            ),
            max_in_flight=2,
            timeout_seconds=2,
        )
        first_result: list[dict] = []
        first_errors: list[BaseException] = []
        second_result: list[dict] = []
        second_errors: list[BaseException] = []

        def request_first() -> None:
            try:
                first_result.append(
                    transport.request(backend_request("backend.health", request_id="legacy_first", payload={"delay": 0.2}))
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                first_errors.append(exc)

        def request_second() -> None:
            try:
                second_result.append(
                    transport.request(
                        backend_request("backend.health", request_id="legacy_waiter", payload={"delay": 0})
                    )
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                second_errors.append(exc)

        thread = threading.Thread(target=request_first)
        thread.start()
        try:
            deadline = time.monotonic() + 1
            while True:
                with transport._state_lock:
                    transport._assert_admission_invariants_locked()
                    if "legacy_first" in transport._reservations and transport._handshake_state in {"legacy", "single-flight"}:
                        break
                if time.monotonic() >= deadline:
                    self.fail("first legacy request did not reach aggregate admission")
                time.sleep(0.005)

            second = threading.Thread(target=request_second)
            second.start()
            deadline = time.monotonic() + 1
            while True:
                with transport._state_lock:
                    transport._assert_admission_invariants_locked()
                    if {"legacy_first", "legacy_waiter"}.issubset(transport._reservations):
                        self.assertEqual(transport._admitted_request_count_locked(), 2)
                        break
                if time.monotonic() >= deadline:
                    self.fail("legacy waiter did not reach aggregate admission")
                time.sleep(0.005)

            with self.assertRaises(BackendTransportError) as saturated:
                transport.request(backend_request("backend.health", request_id="legacy_rejected"))
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            thread.join(timeout=2)
            second.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertFalse(second.is_alive())
            self.assertFalse(first_errors)
            self.assertFalse(second_errors)
            self.assertEqual(first_result[0]["result"]["requestId"], "legacy_first")
            self.assertEqual(second_result[0]["result"]["requestId"], "legacy_waiter")
            recovered = transport.request(backend_request("backend.health", request_id="legacy_rejected"))
            self.assertEqual(recovered["result"]["requestId"], "legacy_rejected")
        finally:
            transport.close()

    def test_stream_and_legacy_waiter_share_one_aggregate_bound(self) -> None:
        transport = StdioBackendTransport(
            command=fake_backend_command(
                """
                import json
                import sys
                import time
                for line in sys.stdin:
                    request = json.loads(line)
                    payload = request.get("payload") or {}
                    if request["command"] == "runner.stream":
                        time.sleep(float(payload.get("delay", 0)))
                        print(json.dumps({
                            "schemaVersion": "chatgpt.browser_control.backend_event.v1",
                            "requestId": request["requestId"], "type": "completed", "result": {},
                        }), flush=True)
                    else:
                        time.sleep(float(payload.get("delay", 0)))
                        print(json.dumps({
                            "schemaVersion": "chatgpt.browser_control.backend_response.v1",
                            "requestId": request["requestId"], "ok": True,
                            "result": {"requestId": request["requestId"]},
                        }), flush=True)
                """,
                multiplexing=(False, False),
            ),
            max_in_flight=2,
            timeout_seconds=2,
        )
        stream_errors: list[BaseException] = []
        waiter_errors: list[BaseException] = []
        waiter_results: list[dict] = []
        stream = cast(Any, transport.stream(backend_request("runner.stream", request_id="legacy_stream", payload={"delay": 0.15})))

        def consume_stream() -> None:
            try:
                list(stream)
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                stream_errors.append(exc)

        def request_waiter() -> None:
            try:
                waiter_results.append(
                    transport.request(
                        backend_request("backend.health", request_id="stream_legacy_waiter", payload={"delay": 0})
                    )
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                waiter_errors.append(exc)

        stream_thread = threading.Thread(target=consume_stream)
        stream_thread.start()
        try:
            deadline = time.monotonic() + 1
            while True:
                with transport._state_lock:
                    transport._assert_admission_invariants_locked()
                    if "legacy_stream" in transport._reservations and transport._handshake_state in {"legacy", "single-flight"}:
                        break
                if time.monotonic() >= deadline:
                    self.fail("legacy stream did not reach aggregate admission")
                time.sleep(0.005)

            waiter = threading.Thread(target=request_waiter)
            waiter.start()
            deadline = time.monotonic() + 1
            while True:
                with transport._state_lock:
                    transport._assert_admission_invariants_locked()
                    if {"legacy_stream", "stream_legacy_waiter"}.issubset(transport._reservations):
                        self.assertEqual(transport._admitted_request_count_locked(), 2)
                        break
                if time.monotonic() >= deadline:
                    self.fail("legacy waiter did not reach aggregate admission behind stream")
                time.sleep(0.005)

            with self.assertRaises(BackendTransportError) as saturated:
                transport.request(backend_request("backend.health", request_id="stream_legacy_rejected"))
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            stream_thread.join(timeout=2)
            waiter.join(timeout=2)
            self.assertFalse(stream_thread.is_alive())
            self.assertFalse(waiter.is_alive())
            self.assertFalse(stream_errors)
            self.assertFalse(waiter_errors)
            self.assertEqual(waiter_results[0]["result"]["requestId"], "stream_legacy_waiter")
            recovered = transport.request(backend_request("backend.health", request_id="stream_legacy_rejected"))
            self.assertEqual(recovered["result"]["requestId"], "stream_legacy_rejected")
        finally:
            transport.close()

    def test_cancellation_release_frees_aggregate_slot_without_tombstone(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), max_in_flight=2)
        try:
            transport.request(backend_request("backend.health", request_id="prime_cancel_cap"))
            transport.reserve_request_id("held_one", "unary")
            transport.reserve_request_id("held_two", "stream")
            with self.assertRaises(BackendTransportError) as saturated:
                transport.reserve_request_id("held_three", "unary")
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")

            self.assertTrue(transport.cancel("held_one"))
            with self.assertRaises(BackendTransportError):
                transport.reserve_request_id("held_three", "unary")
            self.assertTrue(transport.release_request_id("held_one"))
            transport.reserve_request_id("held_three", "unary")
            self.assertNotIn("held_one", transport._unresolved_tombstones)
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), 2)
        finally:
            transport.close()

    def test_duplicate_request_id_is_reported_before_full_cap(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), max_in_flight=2)
        try:
            transport.request(backend_request("backend.health", request_id="prime_duplicate_cap"))
            transport.reserve_request_id("duplicate_full_cap", "unary")
            transport.reserve_request_id("other_full_cap", "unary")
            with self.assertRaises(BackendTransportError) as duplicate:
                transport.reserve_request_id("duplicate_full_cap", "unary")
            self.assertEqual(duplicate.exception.code, "duplicate_request_id")
        finally:
            transport.close()

    def test_async_pre_reservation_saturation_rejects_before_executor_and_recovers(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), max_in_flight=2)
        client = BackendClient(cast(Any, transport))

        async def exercise() -> None:
            # Complete negotiation first so the recovery request does not need
            # to admit a hello control route alongside its caller route.
            primed = transport.request(backend_request("backend.health", request_id="async_cap_prime"))
            self.assertEqual(primed["result"]["requestId"], "async_cap_prime")
            transport.reserve_request_id("async_held_one", "unary")
            transport.reserve_request_id("async_held_two", "unary")
            with self.assertRaises(BackendTransportError) as saturated:
                await client.request_async("backend.health")
            self.assertEqual(saturated.exception.code, "backend_in_flight_limit")
            self.assertNotIn("async_held_one", str(saturated.exception))
            self.assertNotIn("async_held_two", str(saturated.exception))
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), 2)
            self.assertTrue(transport.release_request_id("async_held_one"))
            response = await client.request_async("backend.health")
            self.assertTrue(response["requestId"].startswith("py_transport_"))

        try:
            asyncio.run(exercise())
        finally:
            client.close()

    def test_control_route_releases_slot_after_protocol_error(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), max_in_flight=2, timeout_seconds=2)
        control_id = "__backend_control__manual_error"
        try:
            transport.request(backend_request("backend.health", request_id="prime_control_cap"))
            response = transport._issue_control(control_id, "bad", {})
            self.assertFalse(response["ok"])
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertNotIn(control_id, transport._reservations)
                self.assertEqual(transport._admitted_request_count_locked(), 0)
            transport.reserve_request_id("after_control_one", "unary")
            transport.reserve_request_id("after_control_two", "unary")
        finally:
            transport.close()

    def test_concurrent_stress_never_exceeds_aggregate_bound(self) -> None:
        max_in_flight = 4
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            max_in_flight=max_in_flight,
            timeout_seconds=2,
        )
        observed_max = 0
        observed_lock = threading.Lock()
        stop_monitor = threading.Event()

        def monitor() -> None:
            nonlocal observed_max
            while not stop_monitor.is_set():
                with transport._state_lock:
                    current = transport._admitted_request_count_locked()
                with observed_lock:
                    observed_max = max(observed_max, current)
                time.sleep(0.001)

        monitor_thread = threading.Thread(target=monitor)
        monitor_thread.start()
        results: list[dict] = []
        errors: list[BaseException] = []

        def request_one(index: int) -> None:
            try:
                results.append(
                    transport.request(
                        backend_request(
                            "backend.health",
                            request_id=f"stress_{index}",
                            payload={"delay": 0.04},
                        )
                    )
                )
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                errors.append(exc)

        threads = [threading.Thread(target=request_one, args=(index,)) for index in range(20)]
        try:
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=3)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            self.assertTrue(results)
            self.assertTrue(errors)
            self.assertTrue(all(
                isinstance(error, BackendTransportError) and error.code == "backend_in_flight_limit"
                for error in errors
            ))
            with observed_lock:
                self.assertLessEqual(observed_max, max_in_flight)
        finally:
            stop_monitor.set()
            monitor_thread.join(timeout=1)
            transport.close()

    def test_duplicate_active_request_id_is_rejected_without_poisoning_session(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        first_result: list[dict] = []
        first_error: list[BaseException] = []

        def first_request() -> None:
            try:
                first_result.append(transport.request(backend_request("hold", request_id="duplicate", payload={"delay": 0.2})))
            except BaseException as exc:  # pragma: no cover - assertion below reports details.
                first_error.append(exc)

        thread = threading.Thread(target=first_request)
        thread.start()
        try:
            time.sleep(0.04)
            with self.assertRaises(BackendTransportError) as duplicate:
                transport.request(backend_request("hold", request_id="duplicate", payload={"delay": 0.2}))
            self.assertIn("already active", str(duplicate.exception))
            thread.join(timeout=2)
            self.assertFalse(first_error)
            self.assertEqual(first_result[0]["result"]["requestId"], "duplicate")
            healthy = transport.request(backend_request("backend.health", request_id="after_duplicate"))
            self.assertEqual(healthy["result"]["requestId"], "after_duplicate")
        finally:
            transport.close()

    def test_timeout_tombstones_late_response_and_keeps_session_usable(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=0.05,
            tombstone_ttl_seconds=0.5,
            max_in_flight=2,
        )
        try:
            with self.assertRaises(BackendTransportError) as timed_out:
                transport.request(backend_request("hold", request_id="late", payload={"delay": 0.25}))
            self.assertIn("timed out", str(timed_out.exception))
            with transport._state_lock:
                transport._assert_admission_invariants_locked()
                self.assertEqual(transport._admitted_request_count_locked(), 0)

            healthy = transport.request(backend_request("backend.health", request_id="after_timeout"))
            self.assertEqual(healthy["result"]["requestId"], "after_timeout")
            time.sleep(0.3)  # Let the old response arrive and be drained by the reader.

            reused = transport.request(backend_request("backend.health", request_id="late"))
            self.assertEqual(reused["result"]["requestId"], "late")
        finally:
            transport.close()

    def test_protocol_error_is_route_local_and_session_remains_usable(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            with self.assertRaises(BackendProtocolError) as protocol_error:
                transport.request(backend_request("bad", request_id="bad_request"))
            self.assertEqual(protocol_error.exception.code, "synthetic_error")
            healthy = transport.request(backend_request("backend.health", request_id="after_protocol_error"))
            self.assertEqual(healthy["result"]["requestId"], "after_protocol_error")
        finally:
            transport.close()

    def test_async_request_cancellation_tombstones_worker_route(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        client = BackendClient(cast(Any, transport))

        async def exercise() -> None:
            task = asyncio.create_task(client.request_async("hold", {"delay": 0.25}))
            await asyncio.sleep(0.04)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            healthy = await client.request_async("backend.health")
            self.assertTrue(healthy["requestId"].startswith("py_transport_"))

        try:
            asyncio.run(exercise())
            time.sleep(0.3)  # The cancelled response must be drained, not misrouted.
        finally:
            client.close()

    def test_async_request_executor_admission_failure_releases_reservation(self) -> None:
        transport = ReservingAsyncTransport()
        client = BackendClient(cast(Any, transport))
        execution = _AsyncExecution(backend_workers=1, stream_workers=1, cleanup_workers=1)
        execution.close()

        async def exercise() -> None:
            token = _ACTIVE_ASYNC_EXECUTION.set(execution)
            try:
                with self.assertRaises(RuntimeError):
                    await client.request_async("backend.health")
            finally:
                _ACTIVE_ASYNC_EXECUTION.reset(token)

        try:
            asyncio.run(exercise())
            self.assertEqual(transport.reservations, set())
            self.assertEqual(transport.released, [transport.last_request_id])
        finally:
            execution.close()

    def test_async_request_queued_cancellation_releases_unsent_reservation(self) -> None:
        transport = QueuedCancellationTransport()
        client = BackendClient(cast(Any, transport))
        execution = _AsyncExecution(backend_workers=1, stream_workers=1, cleanup_workers=1)

        async def exercise() -> None:
            token = _ACTIVE_ASYNC_EXECUTION.set(execution)
            try:
                first = asyncio.create_task(client.request_async("hold"))
                await asyncio.wait_for(asyncio.to_thread(transport.first_started.wait), timeout=1)
                second = asyncio.create_task(client.request_async("queued"))
                await asyncio.wait_for(asyncio.to_thread(transport.second_reserved.wait), timeout=1)
                second.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await second
                self.assertEqual(transport.cancelled, [])
                self.assertNotIn(transport.second_request_id, transport.reservations)
                transport.release_first.set()
                result = await first
                self.assertEqual(result["request"], "hold")
            finally:
                _ACTIVE_ASYNC_EXECUTION.reset(token)

        try:
            asyncio.run(exercise())
        finally:
            execution.close()

    def test_stream_close_early_tombstones_late_events(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            stream = cast(Any, transport.stream(backend_request("runner.stream", request_id="early", payload={"delay": 0.15})))
            first = next(stream)
            self.assertEqual(first["name"], "early:first")
            stream.close()
            time.sleep(0.2)
            healthy = transport.request(backend_request("backend.health", request_id="after_close"))
            self.assertEqual(healthy["result"]["requestId"], "after_close")
        finally:
            transport.close()

    def test_stream_backpressure_fails_only_slow_route_and_reader_continues(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=2,
            max_stream_queue_size=2,
        )
        try:
            stream = transport.stream(backend_request("runner.stream", request_id="flood", payload={"flood": True}))
            with self.assertRaises(BackendTransportError) as overflow:
                list(stream)
            self.assertIn("queue exceeded", str(overflow.exception))
            healthy = transport.request(backend_request("backend.health", request_id="after_flood"))
            self.assertEqual(healthy["result"]["requestId"], "after_flood")
        finally:
            transport.close()

    def test_stream_backpressure_is_bounded_by_utf8_queue_bytes(self) -> None:
        transport = StdioBackendTransport(
            command=concurrent_backend_command(),
            timeout_seconds=2,
            max_stream_queue_size=64,
            max_stream_queue_bytes=512,
        )
        try:
            stream = transport.stream(backend_request("runner.stream", request_id="byte_flood", payload={"flood": True}))
            with self.assertRaises(BackendTransportError) as overflow:
                list(stream)
            self.assertIn("bytes", str(overflow.exception))
            self.assertEqual(overflow.exception.code, "backend_stream_overflow")
            healthy = transport.request(backend_request("backend.health", request_id="after_byte_flood"))
            self.assertEqual(healthy["result"]["requestId"], "after_byte_flood")
        finally:
            transport.close()

    def test_close_wakes_blocked_request(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=30)
        result: list[BaseException] = []

        def blocked_request() -> None:
            try:
                transport.request(backend_request("hold_forever", request_id="blocked"))
            except BaseException as exc:
                result.append(exc)

        thread = threading.Thread(target=blocked_request)
        thread.start()
        try:
            time.sleep(0.05)
            transport.close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(result), 1)
            self.assertIsInstance(result[0], BackendTransportError)
        finally:
            transport.close()

    def test_requests_during_fatal_recycle_fail_before_write_and_reuse_after_recycle(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        transport.request(backend_request("backend.health", request_id="before_fatal_recycle"))
        original_recycle = transport._recycle_process
        recycle_started = threading.Event()
        release_recycle = threading.Event()

        def delayed_recycle(process) -> None:
            recycle_started.set()
            self.assertTrue(release_recycle.wait(timeout=2))
            original_recycle(process)

        transport._recycle_process = delayed_recycle  # type: ignore[method-assign]
        try:
            transport._fail_all(
                BackendTransportError(
                    "synthetic fatal transport failure",
                    fatal=True,
                    unresolved=True,
                    code="synthetic_fatal",
                )
            )
            self.assertTrue(recycle_started.wait(timeout=1))
            with self.assertRaises(BackendTransportError) as during_recycle:
                transport.request(backend_request("backend.health", request_id="during_fatal_recycle"))
            self.assertEqual(during_recycle.exception.code, "synthetic_fatal")
            self.assertTrue(during_recycle.exception.fatal)
            self.assertNotIn("during_fatal_recycle", transport._routes)
            self.assertNotIn("during_fatal_recycle", transport._reservations)

            release_recycle.set()
            deadline = time.monotonic() + 2
            recycled = False
            while time.monotonic() < deadline:
                with transport._state_lock:
                    recycled = transport._process is None and not transport._fatal_cleanup_started
                if recycled:
                    break
                time.sleep(0.005)
            self.assertTrue(recycled)
            after_recycle = transport.request(backend_request("backend.health", request_id="after_fatal_recycle"))
            self.assertEqual(after_recycle["result"]["requestId"], "after_fatal_recycle")
        finally:
            release_recycle.set()
            transport.close()

    def test_many_small_ndjson_frames_are_routed_without_front_deletion_growth(self) -> None:
        frame_count = 12_000
        transport = StdioBackendTransport(
            command=fake_backend_command(
                f"""
                import json
                import sys
                request = json.loads(sys.stdin.readline())
                frames = []
                for index in range({frame_count}):
                    frames.append(json.dumps({{
                        "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                        "requestId": request["requestId"],
                        "type": "run_item_stream_event",
                        "name": str(index),
                        "item": {{"type": "message.completed"}},
                    }}))
                frames.append(json.dumps({{
                    "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                    "requestId": request["requestId"],
                    "type": "completed",
                    "result": {{"frameCount": {frame_count}}},
                }}))
                sys.stdout.write("\\n".join(frames) + "\\n")
                sys.stdout.flush()
                """
            ),
            timeout_seconds=5,
            max_stream_queue_size=frame_count + 2,
        )
        try:
            events = list(transport.stream(backend_request("runner.stream", request_id="many_frames")))
            self.assertEqual(len(events), frame_count + 1)
            self.assertEqual(events[0]["name"], "0")
            self.assertEqual(events[-1]["result"], {"frameCount": frame_count})
        finally:
            transport.close()

    def test_stale_route_cancellation_cannot_cancel_a_reused_request_id(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            stale_stream = cast(Any, transport.stream(
                backend_request("runner.stream", request_id="reused_route", payload={"delay": 0.03})
            ))
            next(stale_stream)
            stale_route = stale_stream._route
            self.assertIsNotNone(stale_route)
            stale_stream.close()
            time.sleep(0.15)

            current_stream = transport.stream(
                backend_request("runner.stream", request_id="reused_route", payload={"delay": 0.01})
            )
            next(current_stream)
            self.assertFalse(
                transport._cancel(
                    "reused_route",
                    stale_route,
                    reason="stale_route_cancel",
                    kind="stream",
                )
            )
            events = list(current_stream)
            self.assertEqual([event["type"] for event in events], ["completed"])
            healthy = transport.request(backend_request("backend.health", request_id="after_stale_cancel"))
            self.assertEqual(healthy["result"]["requestId"], "after_stale_cancel")
        finally:
            transport.close()

    def test_cancelled_pre_reserved_id_cannot_be_reused_until_worker_consumes_cancel(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        request_id = "cancelled_before_worker"
        try:
            transport.reserve_request_id(request_id, "unary")
            self.assertTrue(transport.cancel(request_id))
            with self.assertRaises(BackendTransportError) as duplicate:
                transport.reserve_request_id(request_id, "unary")
            self.assertEqual(duplicate.exception.code, "request_id_reused")

            with self.assertRaises(BackendTransportError) as cancelled:
                transport.request(backend_request("backend.health", request_id=request_id))
            self.assertEqual(cancelled.exception.code, "backend_request_cancelled")
            self.assertNotIn(request_id, transport._unresolved_tombstones)
            self.assertIsNone(transport._tombstone_timer)
            healthy = transport.request(backend_request("backend.health", request_id=request_id))
            self.assertEqual(healthy["result"]["requestId"], request_id)
        finally:
            transport.close()

    def test_cancellation_between_worker_check_and_registration_is_consumed_safely(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        request_id = "cancelled_during_start"
        handshake_entered = threading.Event()
        release_handshake = threading.Event()
        worker_errors: list[BaseException] = []
        original_handshake = transport._ensure_handshake

        def blocked_handshake() -> None:
            handshake_entered.set()
            self.assertTrue(release_handshake.wait(timeout=2))

        transport._ensure_handshake = blocked_handshake  # type: ignore[method-assign]
        try:
            transport.reserve_request_id(request_id, "unary")

            def worker() -> None:
                try:
                    transport.request(backend_request("backend.health", request_id=request_id))
                except BaseException as exc:
                    worker_errors.append(exc)

            thread = threading.Thread(target=worker)
            thread.start()
            self.assertTrue(handshake_entered.wait(timeout=1))
            self.assertTrue(transport.cancel(request_id))
            release_handshake.set()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(worker_errors), 1)
            worker_error = worker_errors[0]
            self.assertIsInstance(worker_error, BackendTransportError)
            assert isinstance(worker_error, BackendTransportError)
            self.assertEqual(worker_error.code, "backend_request_cancelled")
            self.assertNotIn(request_id, transport._cancelled_reservations)
        finally:
            release_handshake.set()
            transport._ensure_handshake = original_handshake  # type: ignore[method-assign]
            transport.close()

        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            healthy = transport.request(backend_request("backend.health", request_id=request_id))
            self.assertEqual(healthy["result"]["requestId"], request_id)
        finally:
            transport.close()

    def test_cancel_after_route_registration_blocks_the_pending_write(self) -> None:
        transport = StdioBackendTransport(command=concurrent_backend_command(), timeout_seconds=2)
        try:
            transport.request(backend_request("backend.health", request_id="prime_cancel_write"))
            request = backend_request("backend.health", request_id="cancel_before_write")
            transport._reserve_request_id("cancel_before_write", "unary")
            route = transport._register("cancel_before_write", "unary")
            self.assertTrue(transport._cancel("cancel_before_write", route, reason="request_cancelled", kind="unary"))
            with self.assertRaises(BackendTransportError) as blocked_write:
                transport._write_json_line(request, perform_handshake=False)
            self.assertEqual(blocked_write.exception.code, "backend_request_cancelled")
            healthy = transport.request(backend_request("backend.health", request_id="after_cancel_write"))
            self.assertEqual(healthy["result"]["requestId"], "after_cancel_write")
        finally:
            transport.close()


def backend_request(command: str, *, request_id: str = "req_test", payload: dict | None = None) -> dict:
    return {
        "schemaVersion": BACKEND_REQUEST_SCHEMA_VERSION,
        "requestId": request_id,
        "command": command,
        "payload": payload or {},
    }


class ReservingAsyncTransport:
    def __init__(self) -> None:
        self.reservations: set[str] = set()
        self.released: list[str | None] = []
        self.last_request_id: str | None = None

    def allocate_request_id(self) -> str:
        self.last_request_id = "reserved_async"
        return self.last_request_id

    def reserve_request_id(self, request_id: str, _kind: str = "unary") -> None:
        self.reservations.add(request_id)

    def release_request_id(self, request_id: str) -> bool:
        self.reservations.discard(request_id)
        self.released.append(request_id)
        return True

    def request(self, _request: dict) -> dict:
        raise AssertionError("executor admission failure must prevent provider invocation")


class QueuedCancellationTransport:
    def __init__(self) -> None:
        self.reservations: set[str] = set()
        self.cancelled: list[str] = []
        self.first_started = threading.Event()
        self.second_reserved = threading.Event()
        self.release_first = threading.Event()
        self._next_id = 0
        self.second_request_id = ""

    def allocate_request_id(self) -> str:
        self._next_id += 1
        request_id = f"queued_{self._next_id}"
        if self._next_id == 2:
            self.second_request_id = request_id
        return request_id

    def reserve_request_id(self, request_id: str, _kind: str = "unary") -> None:
        self.reservations.add(request_id)
        if request_id == self.second_request_id:
            self.second_reserved.set()

    def release_request_id(self, request_id: str) -> bool:
        self.reservations.discard(request_id)
        return True

    def cancel(self, request_id: str) -> bool:
        self.cancelled.append(request_id)
        return True

    def request(self, request: dict) -> dict:
        request_id = request["requestId"]
        if request.get("command") == "hold":
            self.first_started.set()
            self.release_first.wait(timeout=2)
        self.reservations.discard(request_id)
        return {"ok": True, "result": {"request": request["command"]}}


def fake_backend_command(source: str, *, multiplexing: tuple[bool, bool] = (True, True)) -> list[str]:
    return [sys.executable, "-c", textwrap.dedent(with_modern_hello(source, multiplexing=multiplexing))]


def with_modern_hello(source: str, *, multiplexing: tuple[bool, bool] = (True, True)) -> str:
    """Wrap small fixtures with the same lifecycle hello used by Node."""

    prefix = textwrap.dedent(f"""
    import json as _hello_json
    import sys as _hello_sys

    _hello_original_stdin = _hello_sys.stdin
    _hello_first_line = _hello_original_stdin.readline()
    try:
        _hello_first_request = _hello_json.loads(_hello_first_line)
    except Exception:
        _hello_first_request = None

    class _HelloPushback:
        def __init__(self, first, stream):
            self._first = first
            self._stream = stream

        def readline(self, *args):
            if self._first is not None:
                first, self._first = self._first, None
                return first
            return self._stream.readline(*args)

        def __iter__(self):
            return self

        def __next__(self):
            line = self.readline()
            if line == "":
                raise StopIteration
            return line

        def __getattr__(self, name):
            return getattr(self._stream, name)

    if isinstance(_hello_first_request, dict) and _hello_first_request.get("command") == "backend.hello":
        _hello_identity = {{
            "backendSessionId": "python-fixture-session",
            "packageName": "fixture-backend",
            "packageVersion": "0.0.0",
            "runtime": "node",
            "runtimeVersion": "fixture-runtime",
            "buildDigest": "fixture-build",
            "protocolVersion": {BACKEND_REQUEST_SCHEMA_VERSION!r},
        }}
        _hello_capabilities = {{
            **_hello_identity,
            "commands": ["backend.hello", "backend.version", "backend.capabilities", "backend.health", "runner.run", "runner.stream"],
            "transports": ["stdio"],
            "streaming": {{"modes": ["ndjson"], "tokenDeltas": False}},
            "supportedProtocolVersions": [{BACKEND_REQUEST_SCHEMA_VERSION!r}],
            "requestIds": {{"required": True, "scope": "connection"}},
            "multiplexing": {{"unary": {multiplexing[0]!r}, "streams": {multiplexing[1]!r}}},
            "cancellation": {{"supported": False, "requests": False, "streams": False}},
            "tabs": {{
                "stableProviderIdentity": False, "stableBrowserIdentity": False, "stableTabIdentity": False,
                "coordinationScope": "none", "authoritativeClaim": False, "fencing": False, "concurrentTabs": False,
                "stableIdentity": False, "coordination": False, "concurrent": False,
            }},
        }}
        _hello_sys.stdout.write(_hello_json.dumps({{
            "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
            "requestId": _hello_first_request.get("requestId"),
            "ok": True,
            "result": {{**_hello_identity, "accepted": True, "capabilities": _hello_capabilities}},
        }}) + "\\n")
        _hello_sys.stdout.flush()
        _hello_first_line = None
    _hello_sys.stdin = _HelloPushback(_hello_first_line, _hello_original_stdin)

    """)
    return prefix + "\n" + textwrap.dedent(source)


def concurrent_backend_command() -> list[str]:
    return fake_backend_command(
        f"""
        import json
        import sys
        import threading
        import time

        def emit(request):
            request_id = request["requestId"]
            payload = request.get("payload") or {{}}
            delay = float(payload.get("delay", 0))
            if request["command"] == "runner.stream":
                time.sleep(delay)
                print(json.dumps({{
                    "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                    "requestId": request_id,
                    "type": "run_item_stream_event",
                    "name": request_id + ":first",
                    "item": {{"type": "message.completed"}},
                }}), flush=True)
                if payload.get("flood"):
                    for index in range(20):
                        print(json.dumps({{
                            "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                            "requestId": request_id,
                            "type": "run_item_stream_event",
                            "name": request_id + ":flood:" + str(index),
                            "item": {{"type": "message.completed"}},
                        }}), flush=True)
                time.sleep(delay)
                print(json.dumps({{
                    "schemaVersion": {BACKEND_EVENT_SCHEMA_VERSION!r},
                    "requestId": request_id,
                    "type": "completed",
                    "result": {{"requestId": request_id}},
                }}), flush=True)
                return
            if request["command"] == "hold_forever":
                time.sleep(60)
                return
            if request["command"] == "unknown_output":
                print(json.dumps({{
                    "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                    "requestId": "spurious_backend_id",
                    "ok": True,
                    "result": {{"requestId": "spurious_backend_id"}},
                }}), flush=True)
                time.sleep(delay)
            if request["command"] == "bad":
                print(json.dumps({{
                    "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                    "requestId": request_id,
                    "ok": False,
                    "error": {{
                        "code": "synthetic_error",
                        "message": "synthetic protocol failure",
                        "recoverable": True,
                    }},
                }}), flush=True)
                return
            time.sleep(delay)
            print(json.dumps({{
                "schemaVersion": {BACKEND_RESPONSE_SCHEMA_VERSION!r},
                "requestId": request_id,
                "ok": True,
                "result": {{"requestId": request_id}},
            }}), flush=True)

        for line in sys.stdin:
            request = json.loads(line)
            threading.Thread(target=emit, args=(request,), daemon=True).start()
        """
    )


def malformed_backend_command() -> list[str]:
    return fake_backend_command(
        """
        import sys
        import time
        sys.stdin.readline()
        print("not-json", flush=True)
        time.sleep(60)
        """
    )


if __name__ == "__main__":
    unittest.main()
