from __future__ import annotations

import hashlib
import hmac
import json
import unittest
import unicodedata
from pathlib import Path
from typing import Any


def vector_path() -> Path:
    packages_root = Path(__file__).resolve().parents[2]
    relative = Path("contracts") / "v1" / "vectors" / "operation-request-digest-v1.json"
    # Private source keeps the TypeScript authority beside the Python facade;
    # the public mirror exports it as packages/node. Build the private name in
    # pieces so public package-name sanitization cannot rewrite this test-only
    # layout probe into a path which exists in neither tree.
    candidates = (
        packages_root / "node" / relative,
        packages_root / ("chatgpt-" + "browser-control") / relative,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("operation request digest vector is missing")


VECTOR_PATH = vector_path()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def keyed_digest(key: bytes, domain: str, value: Any) -> str:
    digest = hmac.new(key, digestmod=hashlib.sha256)
    digest.update(domain.encode("utf-8"))
    digest.update(b"\0")
    digest.update(canonical_json(value).encode("utf-8"))
    return f"hmac-sha256:{digest.hexdigest()}"


class OperationRequestDigestVectorTests(unittest.TestCase):
    def test_fixed_key_vector_matches_the_typescript_authority(self) -> None:
        vector = json.loads(VECTOR_PATH.read_text(encoding="utf-8"))
        key = bytes.fromhex(vector["keyHex"])
        request = vector["input"]
        expected = vector["expected"]
        file = request["files"][0]

        prompt_digest = keyed_digest(
            key,
            "codex-chatgpt-control/prompt/v1",
            request["prompt"],
        )
        display_name_digest = keyed_digest(
            key,
            "codex-chatgpt-control/file-display-name/v1",
            unicodedata.normalize("NFC", file["displayName"]),
        )
        content_digest = keyed_digest(
            key,
            "codex-chatgpt-control/file-content-sha256/v1",
            file["contentSha256"].lower(),
        )
        projected = {
            "schemaVersion": "chatgpt.browser_control.operation_request_identity.v1",
            "operationId": request["operationId"],
            "surface": request["surface"],
            "target": request["target"],
            "prompt": {
                "digest": prompt_digest,
                "bytes": len(request["prompt"].encode("utf-8")),
            },
            "configuration": request["configuration"],
            "tools": request["tools"],
            "files": [{
                "displayNameDigest": display_name_digest,
                "bytes": file["bytes"],
                "contentDigest": content_digest,
            }],
            "capturePolicy": {
                "responseContent": request["capturePolicy"]["responseContent"],
                "responseFormat": request["capturePolicy"]["responseFormat"],
                "artifacts": request["capturePolicy"]["artifacts"],
            },
            "behavior": request["behavior"],
        }
        canonical_input = canonical_json(projected)
        request_digest = keyed_digest(
            key,
            "codex-chatgpt-control/operation-request/v1",
            projected,
        )

        self.assertEqual(prompt_digest, expected["promptDigest"])
        self.assertEqual(display_name_digest, expected["displayNameDigest"])
        self.assertEqual(content_digest, expected["contentDigest"])
        self.assertEqual(canonical_input, expected["canonicalInput"])
        self.assertEqual(request_digest, expected["requestDigest"])
        self.assertNotIn("ignored-by-request-identity", canonical_input)


if __name__ == "__main__":
    unittest.main()
