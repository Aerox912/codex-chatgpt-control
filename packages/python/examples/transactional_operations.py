"""Build and validate a v1 operation request without opening a browser.

This example intentionally stops at the strict local wire boundary. It does
not start the Node backend, claim a tab, submit a prompt, or persist a
conversation. Use it to inspect the exact camelCase request shape before
connecting an explicitly configured backend/adapter.
"""

from __future__ import annotations

import json

from codex_chatgpt_control.operation_models import (
    REQUEST_SCHEMA,
    NewTarget,
    OperationCapturePolicy,
    OperationConfiguration,
    OperationSubmitRequest,
)


def main() -> None:
    request = OperationSubmitRequest(
        schema_version=REQUEST_SCHEMA,
        operation_id="123e4567-e89b-42d3-a456-426614174000",
        surface="chat",
        prompt="Summarize the visible thread.",
        target=NewTarget(type="new"),
        configuration=OperationConfiguration(
            experience="chat",
            tools=["web_search"],
        ),
        capture=OperationCapturePolicy(
            response_content="metadata",
            artifacts="receipt_only",
        ),
    )

    print(json.dumps(request.to_wire(), indent=2, sort_keys=True))
    print("Validated locally; no browser or backend call was made.")


if __name__ == "__main__":
    main()
