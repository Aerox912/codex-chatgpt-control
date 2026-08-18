from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


BACKEND_PROTOCOL = "chatgpt.browser_control.backend_request.v1"
BACKEND_COMMANDS = [
    "backend.hello",
    "backend.version",
    "backend.capabilities",
    "backend.health",
    "runner.run",
    "runner.stream",
    "responses.create",
    "runPlan",
    "reports.create",
    "commands",
]


def backend_identity() -> dict[str, str]:
    return {
        "backendSessionId": "python-live-smoke-fixture-session",
        "packageName": "fixture-backend",
        "packageVersion": "0.0.0",
        "runtime": "python",
        "runtimeVersion": "fixture-runtime",
        "buildDigest": "fixture-build",
        "protocolVersion": BACKEND_PROTOCOL,
    }


def backend_capabilities() -> dict[str, Any]:
    return {
        **backend_identity(),
        "commands": BACKEND_COMMANDS,
        "transports": ["stdio"],
        "streaming": {"modes": ["ndjson"], "tokenDeltas": False},
        "supportedProtocolVersions": [BACKEND_PROTOCOL],
        "requestIds": {"required": True, "scope": "connection"},
        "multiplexing": {"unary": True, "streams": True},
        "cancellation": {"supported": False, "requests": False, "streams": False},
        "tabs": {
            "stableProviderIdentity": False,
            "stableBrowserIdentity": False,
            "stableTabIdentity": False,
            "coordinationScope": "none",
            "authoritativeClaim": False,
            "fencing": False,
            "concurrentTabs": False,
            "stableIdentity": False,
            "coordination": False,
            "concurrent": False,
        },
    }


def run_result() -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "output_text": "hi",
        "finalOutput": "hi",
        "output": [],
        "newItems": [],
        "interruptions": [],
        "state": {"id": "run_fake", "resumable": False},
        "activeAgentName": "fake-agent",
        "lastAgentName": "fake-agent",
        "warnings": [],
        "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
    }


def command_result(data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "data": data or {},
        "warnings": [],
        "context": {"timestamp": "2026-06-06T00:00:00.000Z"},
    }


def response(request: dict[str, Any], result: Any) -> dict[str, Any]:
    return {
        "schemaVersion": "chatgpt.browser_control.backend_response.v1",
        "requestId": request.get("requestId"),
        "ok": True,
        "result": result,
    }


def event(request: dict[str, Any], payload: dict[str, Any]) -> None:
    value = {
        "schemaVersion": "chatgpt.browser_control.backend_event.v1",
        "requestId": request.get("requestId"),
        **payload,
    }
    print(json.dumps(value), flush=True)


def handle(request: dict[str, Any]) -> Any:
    command = request["command"]
    payload = request.get("payload") or {}
    if command == "backend.hello":
        return {**backend_identity(), "accepted": True, "capabilities": backend_capabilities()}
    if command == "backend.version":
        return {"name": "fixture-backend", **backend_identity()}
    if command == "backend.capabilities":
        return backend_capabilities()
    if command == "backend.health":
        return {"ok": True, "status": "ok", "timestamp": "2026-06-06T00:00:00.000Z"}
    if command == "commands":
        return [{"name": "runner.run", "layer": "workflow"}]
    if command == "runner.run":
        return run_result()
    if command == "responses.create":
        return {
            "id": "chatgpt-browser-fake",
            "object": "chatgpt.browser.response",
            "created_at": 1780704000,
            "status": "ok",
            "output_text": "hi",
            "output": [],
            "browser_control": {"visibleUi": True, "resultStatus": "ok"},
        }
    if command == "runPlan":
        result = command_result({"responseText": "hi"})
        result["steps"] = [
            {"id": "ask", "command": "messages.ask", "status": "ok", "ok": True},
        ]
        return result
    if command == "reports.create":
        args = payload.get("args") or {}
        dest_dir = Path(args.get("destDir") or os.getcwd())
        dest_dir.mkdir(parents=True, exist_ok=True)
        path = dest_dir / "fake-redacted-report.json"
        path.write_text('{"data":"[redacted:99 chars]"}\n', encoding="utf-8")
        return command_result({
            "path": str(path),
            "bytes": path.stat().st_size,
            "includeContent": False,
        })
    return {}


def main() -> int:
    for line in sys.stdin:
        request = json.loads(line)
        if request["command"] == "runner.stream":
            event(request, {
                "type": "run_item_stream_event",
                "name": "message_completed",
                "item": {"type": "message.completed"},
            })
            event(request, {"type": "completed", "result": run_result()})
            continue
        print(json.dumps(response(request, handle(request))), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
