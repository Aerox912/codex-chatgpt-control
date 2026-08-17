import unittest

from codex_chatgpt_control import AsyncChatGPT, ChatGPT, CommandResult


OPERATION_ID = "123e4567-e89b-42d3-a456-426614174000"
SECRET_ERROR = "/private/transport/socket failed with secret detail"


class RecordingBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []

    def request(self, command: str, payload: dict | None = None):
        payload = payload or {}
        self.requests.append((command, payload))
        return {
            "ok": True,
            "status": "ok",
            "data": {"command": command, "payload": payload},
            "warnings": [],
            "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
        }


class FailingBackend:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []

    def request(self, command: str, payload: dict | None = None):
        self.requests.append((command, payload or {}))
        raise RuntimeError(SECRET_ERROR)


class WorkflowFacadeTests(unittest.TestCase):
    def test_workflow_methods_map_to_backend_commands(self) -> None:
        backend = RecordingBackend()
        chatgpt = ChatGPT(backend=backend)

        calls = [
            (lambda: chatgpt.ask(prompt="hi"), "ask", {"prompt": "hi"}),
            (lambda: chatgpt.ask_in_thread(thread={"type": "current"}, prompt="hi"), "askInThread", {"thread": {"type": "current"}, "prompt": "hi"}),
            (
                lambda: chatgpt.ask_in_thread(
                    thread={"type": "url", "url": "https://chatgpt.com/c/abc-123"},
                    prompt="hi",
                    existing_tab=True,
                ),
                "askInThread",
                {
                    "thread": {"type": "url", "url": "https://chatgpt.com/c/abc-123"},
                    "prompt": "hi",
                    "existingTab": True,
                },
            ),
            (lambda: chatgpt.ask_with_files(prompt="hi", files=["/tmp/a.txt"]), "askWithFiles", {"prompt": "hi", "files": ["/tmp/a.txt"]}),
            (lambda: chatgpt.ask_and_download(prompt="hi", download={"destDir": "/tmp"}), "askAndDownload", {"prompt": "hi", "download": {"destDir": "/tmp"}}),
            (lambda: chatgpt.run_messages(messages=[{"prompt": "one"}]), "runMessages", {"messages": [{"prompt": "one"}]}),
            (lambda: chatgpt.open_thread({"type": "conversationId", "conversationId": "abc"}), "openThread", {"type": "conversationId", "conversationId": "abc"}),
            (lambda: chatgpt.read_latest(format="markdown"), "readLatest", {"format": "markdown"}),
            (lambda: chatgpt.copy_latest(which="latest"), "copyLatest", {"which": "latest"}),
            (lambda: chatgpt.download_latest(dest_dir="/tmp"), "downloadLatest", {"destDir": "/tmp"}),
            (lambda: chatgpt.run_plan({"name": "two-turn"}), "runPlan", {"name": "two-turn"}),
            (lambda: chatgpt.doctor(check=["bridge"]), "doctor", {"check": ["bridge"]}),
            (lambda: chatgpt.create_report({"ok": True}, dest_dir="/tmp"), "createReport", {"result": {"ok": True}, "args": {"destDir": "/tmp"}}),
        ]

        for call, command, payload in calls:
            with self.subTest(command=command):
                result = call()
                self.assertIsInstance(result, CommandResult)
                self.assertEqual(result.data["command"], command)
                self.assertEqual(backend.requests[-1], (command, payload))

    def test_transactional_workflow_transport_failure_retains_only_safe_operation_identity(self) -> None:
        backend = FailingBackend()
        chatgpt = ChatGPT(backend=backend)

        result = chatgpt.ask(operation_id=OPERATION_ID, prompt="private prompt")

        self.assertEqual(result.status, "partial")
        self.assertFalse(result.ok)
        self.assertEqual(result.data["operationId"], OPERATION_ID)
        self.assertEqual(result.data["submissionState"], "submitted_unconfirmed")
        self.assertIsNotNone(result.blocker)
        self.assertIsNotNone(result.error)
        assert result.blocker is not None
        assert result.error is not None
        self.assertEqual(result.blocker["code"], "operation_transport_uncertain")
        self.assertTrue(result.blocker["resumable"])
        self.assertTrue(result.error["recoverable"])
        self.assertNotIn(SECRET_ERROR, str(result.to_wire()))
        self.assertEqual(backend.requests, [("ask", {"operationId": OPERATION_ID, "prompt": "private prompt"})])

    def test_legacy_workflow_transport_failure_preserves_exception_behavior(self) -> None:
        chatgpt = ChatGPT(backend=FailingBackend())
        with self.assertRaisesRegex(RuntimeError, "secret detail"):
            chatgpt.ask(prompt="private prompt")

    def test_transactional_work_transport_failure_uses_the_same_identity_fence(self) -> None:
        chatgpt = ChatGPT(backend=FailingBackend())
        result = chatgpt.work.start(operation_id=OPERATION_ID, prompt="private prompt")

        self.assertEqual(result.status, "partial")
        self.assertEqual(result.data["operationId"], OPERATION_ID)
        self.assertNotIn(SECRET_ERROR, str(result.to_wire()))


class AsyncWorkflowFacadeTests(unittest.IsolatedAsyncioTestCase):
    async def test_transactional_workflow_transport_failure_retains_operation_identity(self) -> None:
        backend = FailingBackend()
        chatgpt = AsyncChatGPT(backend)
        try:
            result = await chatgpt.ask_with_files(
                operation_id=OPERATION_ID,
                prompt="private prompt",
                files=["/private/input.txt"],
            )
        finally:
            await chatgpt.aclose()

        self.assertEqual(result.status, "partial")
        self.assertEqual(result.data["operationId"], OPERATION_ID)
        self.assertIsNotNone(result.blocker)
        assert result.blocker is not None
        self.assertEqual(result.blocker["causeCode"], "operation_transport_error")
        self.assertNotIn(SECRET_ERROR, str(result.to_wire()))
        self.assertEqual(backend.requests[0][0], "askWithFiles")

    async def test_transactional_work_transport_failure_is_mapped_off_loop(self) -> None:
        chatgpt = AsyncChatGPT(FailingBackend())
        try:
            result = await chatgpt.work.steer(
                operation_id=OPERATION_ID,
                control_action_id="223e4567-e89b-42d3-a456-426614174000",
                prompt="private steer",
            )
        finally:
            await chatgpt.aclose()

        self.assertEqual(result.status, "partial")
        self.assertEqual(result.data["operationId"], OPERATION_ID)
        self.assertNotIn(SECRET_ERROR, str(result.to_wire()))


if __name__ == "__main__":
    unittest.main()
