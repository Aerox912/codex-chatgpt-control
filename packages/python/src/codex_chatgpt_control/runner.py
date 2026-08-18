from __future__ import annotations

import asyncio
import inspect
import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Literal, Protocol

from .agent import Agent
from .models import BackendEvent, ChatGPTRunResult, ChatGPTRunState, SequencePlan
from .operations import AsyncOperationsClient, OperationCollectResult, OperationSubmitResult, OperationsClient
from .untrusted_output import render_untrusted_output_return_envelope


RunResult = ChatGPTRunResult
RunState = ChatGPTRunState


TRANSACTIONAL_OPERATION_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


class TransactionalInputError(ValueError):
    """A high-level transactional option that is unsupported before transport."""

    def __init__(self, field: str, message: str) -> None:
        super().__init__(message)
        self.field = field
        self.message = message


# Never interpolate or stringify caller-controlled mapping keys.  This marker
# is intentionally fixed so malformed/private keys cannot escape through an
# unsupported-result field path or error message.
_UNSAFE_FIELD_MARKER = "<invalid-field>"
_MAX_POLL_INTERVAL_MS = 60_000
_SAFE_BACKEND_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


def _normalize_alias_groups(
    value: Mapping[Any, Any],
    groups: Mapping[str, tuple[str, ...]],
    *,
    prefix: str = "",
) -> dict[str, Any]:
    """Copy one caller-controlled mapping and canonicalize aliases safely.

    Alias ambiguity is rejected within a precedence source, even when the two
    values happen to compare equal.  Higher-level callers may then merge
    already-canonical defaults, embedded options, and explicit options without
    accidentally treating legitimate precedence as a duplicate spelling.
    """

    normalized: dict[str, Any] = {}
    try:
        for key, child in value.items():
            if type(key) is not str:
                raise TransactionalInputError(
                    _UNSAFE_FIELD_MARKER,
                    "transactional options contain a non-string field key.",
                )
            normalized[key] = child
    except TransactionalInputError:
        raise
    except Exception as exc:
        raise TransactionalInputError(
            _UNSAFE_FIELD_MARKER,
            "transactional options could not be read safely.",
        ) from exc

    for canonical, spellings in groups.items():
        present = [spelling for spelling in spellings if spelling in normalized]
        if len(present) > 1:
            raise TransactionalInputError(
                f"{prefix}{canonical}",
                f"{prefix}{canonical} must use exactly one supported spelling.",
            )
        if present and present[0] != canonical:
            normalized[canonical] = normalized.pop(present[0])
    return normalized


_TOP_LEVEL_ALIAS_GROUPS = {
    "operationId": ("operationId", "operation_id"),
    "existingTab": ("existingTab", "existing_tab"),
    "preferExistingTab": ("preferExistingTab", "prefer_existing_tab"),
    "timeoutMs": ("timeoutMs", "timeout_ms"),
    "responseContent": ("responseContent", "response_content"),
    "read": ("read", "response"),
}


def _is_one_of(value: Any, *allowed: Any) -> bool:
    """Compare option values without hashing or invoking arbitrary equality.

    Runner inputs arrive from Python callers and may contain lists, mappings, or
    other unhashable objects where a direct ``value in {…}`` would leak a raw
    ``TypeError``.  Transactional options are deliberately limited to scalar
    wire values, so only exact primitive comparisons are meaningful here.
    """

    for candidate in allowed:
        if candidate is None:
            if value is None:
                return True
        elif isinstance(candidate, bool):
            if type(value) is bool and value is candidate:
                return True
        elif isinstance(candidate, str):
            if type(value) is str and value == candidate:
                return True
        elif type(value) is type(candidate) and value == candidate:
            return True
    return False


def _has_wire_key(value: Mapping[str, Any], *keys: str) -> bool:
    return any(key in value for key in keys)


def _first_unknown_key(value: Mapping[str, Any], allowed: set[str]) -> str | None:
    try:
        for key in value:
            if type(key) is not str:
                return _UNSAFE_FIELD_MARKER
            if key not in allowed:
                return key
    except Exception:
        # Custom Mapping implementations are outside the trusted wire shape;
        # convert an adversarial iterator/key operation into a safe marker.
        return _UNSAFE_FIELD_MARKER
    return None


def _wire_key(value: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in value:
            return value[key]
    return None


def _operation_id_from_input(value: Any, explicit: Any = None) -> Any:
    if explicit is not None:
        return explicit
    if isinstance(value, Mapping):
        try:
            normalized = _normalize_alias_groups(
                value,
                {"operationId": _TOP_LEVEL_ALIAS_GROUPS["operationId"]},
            )
            return normalized.get("operationId")
        except TransactionalInputError:
            raise
        except Exception as exc:
            raise TransactionalInputError(
                _UNSAFE_FIELD_MARKER,
                "runner input could not be read safely.",
            ) from exc
    return None


def _extract_runner_input(value: Any) -> tuple[Any, dict[str, Any]]:
    """Extract the TS-shaped runner envelope without altering legacy inputs."""

    if not isinstance(value, Mapping):
        return value, {}
    try:
        if "input" not in value:
            return value, {}
        options: dict[str, Any] = {}
        for key, child in value.items():
            if type(key) is not str:
                raise TransactionalInputError(
                    _UNSAFE_FIELD_MARKER,
                    "runner input contains a non-string field key.",
                )
            if not _is_one_of(key, "input", "operation_id", "operationId"):
                options[key] = child
        return value["input"], options
    except TransactionalInputError:
        raise
    except Exception as exc:
        raise TransactionalInputError(
            _UNSAFE_FIELD_MARKER,
            "runner input could not be read safely.",
        ) from exc


def _render_prompt(agent: Agent, value: Any) -> tuple[str, list[str]]:
    if isinstance(value, str):
        prompt = value
        files: list[str] = []
    elif isinstance(value, list):
        visible_instructions: list[str] = []
        user_text: list[str] = []
        files = []
        for index, item in enumerate(value):
            if not isinstance(item, Mapping):
                raise TransactionalInputError(f"input[{index}]", "runner input items must be objects.")
            item_type = item.get("type")
            if _is_one_of(item_type, "input_text", "visible_instruction"):
                allowed = {"type", "text"} | ({"role"} if item_type == "input_text" else set())
                unknown = _first_unknown_key(item, allowed)
                if unknown is not None:
                    raise TransactionalInputError(
                        f"input[{index}].{unknown}",
                        "this runner input item contains an unsupported field.",
                    )
                text = item.get("text")
                if not isinstance(text, str):
                    raise TransactionalInputError(f"input[{index}].text", "input text must be a string.")
                if item_type == "input_text":
                    role = item.get("role")
                    if "role" in item and not _is_one_of(role, "user"):
                        raise TransactionalInputError(f"input[{index}].role", "input_text role must be user.")
                (visible_instructions if item_type == "visible_instruction" else user_text).append(text)
            elif item_type == "input_file":
                unknown = _first_unknown_key(item, {"type", "path", "description"})
                if unknown is not None:
                    raise TransactionalInputError(
                        f"input[{index}].{unknown}",
                        "this runner input item contains an unsupported field.",
                    )
                path = item.get("path")
                if not isinstance(path, str) or not path:
                    raise TransactionalInputError(f"input[{index}].path", "input file path must be non-empty.")
                files.append(path)
                description = item.get("description")
                if "description" in item and not isinstance(description, str):
                    raise TransactionalInputError(f"input[{index}].description", "input file description must be a string.")
                if isinstance(description, str) and description.strip():
                    user_text.append(f"Attached file context: {description.strip()}")
            else:
                unknown = _first_unknown_key(item, {"type"})
                if unknown is not None:
                    raise TransactionalInputError(
                        f"input[{index}].{unknown}",
                        "this runner input item contains an unsupported field.",
                    )
                raise TransactionalInputError(f"input[{index}].type", "this runner input item is not supported transactionally.")
        parts: list[str] = []
        if visible_instructions:
            parts.append(f"<visible_instructions>\n{chr(10).join(visible_instructions)}\n</visible_instructions>")
        if user_text:
            parts.append("\n\n".join(user_text))
        prompt = "\n\n".join(parts)
    else:
        raise TransactionalInputError("input", "transactional runner input must be visible text or input items.")

    if not prompt.strip():
        raise TransactionalInputError("input", "transactional runner input must include non-empty visible text.")
    if agent.instructions_mode == "visible_setup_message" and (agent.instructions or "").strip():
        raise TransactionalInputError(
            "agent.instructions_mode",
            "visible_setup_message requires a separate setup turn and is not supported by one transactional operation.",
        )
    if agent.instructions_mode == "visible_prefix" and (agent.instructions or "").strip():
        prompt = (
            "<chatgpt_browser_agent>\n"
            f"Agent name: {agent.name}\n"
            "Instructions:\n"
            f"{agent.instructions or ''}\n"
            "</chatgpt_browser_agent>\n\n"
            f"<user_request>\n{prompt}\n</user_request>"
        )
    return prompt, files


def _thread_target(thread: Any) -> dict[str, Any]:
    if thread is None:
        return {"type": "new"}
    if not isinstance(thread, Mapping):
        raise TransactionalInputError("thread", "thread must be an object.")
    thread = _normalize_alias_groups(
        thread,
        {"conversationId": ("conversationId", "conversation_id")},
        prefix="thread.",
    )
    unknown = _first_unknown_key(thread, {"type", "url", "conversationId", "conversation_id", "query", "title"})
    if unknown is not None:
        raise TransactionalInputError(f"thread.{unknown}", f"thread.{unknown} is not supported transactionally.")
    thread_type = _wire_key(thread, "type")
    if _is_one_of(thread_type, "new", None) and not any(key in thread for key in ("url", "conversationId", "conversation_id", "query", "title")):
        return {"type": "new"}
    if _is_one_of(thread_type, "current", "selected_tab", "selected"):
        return {"type": "selected_tab"}
    if _is_one_of(thread_type, "url") or "url" in thread:
        url = _wire_key(thread, "url")
        if not isinstance(url, str) or not url:
            raise TransactionalInputError("thread.url", "thread.url must be non-empty.")
        return {"type": "url", "url": url}
    if _is_one_of(thread_type, "conversationId", "conversation_id") or "conversationId" in thread or "conversation_id" in thread:
        conversation_id = _wire_key(thread, "conversationId", "conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise TransactionalInputError("thread.conversationId", "thread.conversationId must be non-empty.")
        return {"type": "conversation_id", "conversationId": conversation_id}
    if _is_one_of(thread_type, "search", "title") or "query" in thread or "title" in thread:
        raise TransactionalInputError("thread", "thread search/title selection is not supported transactionally; supply a URL or conversationId.")
    raise TransactionalInputError("thread", "thread selector is not supported transactionally.")


def _existing_tab_target(existing_tab: Any) -> dict[str, Any]:
    if existing_tab is True:
        return {"type": "selected_tab"}
    if existing_tab is False or existing_tab is None:
        return {"type": "new"}
    if not isinstance(existing_tab, Mapping):
        raise TransactionalInputError("existingTab", "existingTab must be a boolean or object.")
    existing_tab = _normalize_alias_groups(
        existing_tab,
        {
            "ifMissing": ("ifMissing", "if_missing"),
            "ifMultiple": ("ifMultiple", "if_multiple"),
            "requireChatGPT": ("requireChatGPT", "require_chatgpt"),
        },
        prefix="existingTab.",
    )
    unknown = _first_unknown_key(existing_tab, {"ifMissing", "if_missing", "ifMultiple", "if_multiple", "requireChatGPT", "require_chatgpt", "target"})
    if unknown is not None:
        raise TransactionalInputError(f"existingTab.{unknown}", f"existingTab.{unknown} is not supported transactionally.")
    require_chatgpt = _wire_key(existing_tab, "requireChatGPT", "require_chatgpt")
    if require_chatgpt is not None and not isinstance(require_chatgpt, bool):
        raise TransactionalInputError("existingTab.requireChatGPT", "requireChatGPT must be a boolean.")
    if require_chatgpt is False:
        raise TransactionalInputError("existingTab.requireChatGPT", "existingTab.requireChatGPT=false is not supported transactionally.")
    for key in ("ifMissing", "ifMultiple"):
        if key in existing_tab and not _is_one_of(existing_tab[key], None, "block"):
            raise TransactionalInputError(f"existingTab.{key}", f"{key} must be block transactionally.")
    target = existing_tab.get("target")
    if target is None or _is_one_of(target, "selected", "selected_tab"):
        return {"type": "selected_tab"}
    if not isinstance(target, Mapping):
        raise TransactionalInputError("existingTab.target", "existingTab.target must be an object.")
    target = _normalize_alias_groups(
        target,
        {
            "tabId": ("tabId", "tab_id"),
            "conversationId": ("conversationId", "conversation_id"),
        },
        prefix="existingTab.target.",
    )
    target_type = target.get("type")
    if _is_one_of(target_type, "selected", "selected_tab"):
        unknown = _first_unknown_key(target, {"type"})
        if unknown is not None:
            raise TransactionalInputError(f"existingTab.target.{unknown}", f"existingTab.target.{unknown} is not supported transactionally.")
        return {"type": "selected_tab"}
    if _is_one_of(target_type, "tabId", "tab_id"):
        unknown = _first_unknown_key(target, {"type", "tabId", "tab_id"})
        if unknown is not None:
            raise TransactionalInputError(f"existingTab.target.{unknown}", f"existingTab.target.{unknown} is not supported transactionally.")
        tab_id = _wire_key(target, "tabId", "tab_id")
        if not isinstance(tab_id, str) or not tab_id:
            raise TransactionalInputError("existingTab.target.tabId", "tabId must be non-empty.")
        return {"type": "tab_id", "tabId": tab_id}
    if _is_one_of(target_type, "conversationId", "conversation_id"):
        unknown = _first_unknown_key(target, {"type", "conversationId", "conversation_id"})
        if unknown is not None:
            raise TransactionalInputError(f"existingTab.target.{unknown}", f"existingTab.target.{unknown} is not supported transactionally.")
        conversation_id = _wire_key(target, "conversationId", "conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise TransactionalInputError("existingTab.target.conversationId", "conversationId must be non-empty.")
        return {"type": "conversation_id", "conversationId": conversation_id}
    if target_type == "url":
        unknown = _first_unknown_key(target, {"type", "url"})
        if unknown is not None:
            raise TransactionalInputError(f"existingTab.target.{unknown}", f"existingTab.target.{unknown} is not supported transactionally.")
        url = target.get("url")
        if not isinstance(url, str) or not url:
            raise TransactionalInputError("existingTab.target.url", "url must be non-empty.")
        return {"type": "url", "url": url}
    raise TransactionalInputError("existingTab.target", "title or unknown existing-tab selection is not supported transactionally.")


def _direct_target(target: Any) -> dict[str, Any]:
    """Validate the Python-only direct target alias before model decoding."""

    if not isinstance(target, Mapping):
        raise TransactionalInputError("target", "target must be an object.")
    target = _normalize_alias_groups(
        target,
        {
            "tabId": ("tabId", "tab_id"),
            "conversationId": ("conversationId", "conversation_id"),
        },
        prefix="target.",
    )
    target_type = _wire_key(target, "type")
    if _is_one_of(target_type, "new"):
        allowed = {"type"}
        if _first_unknown_key(target, allowed) is not None:
            raise TransactionalInputError("target", "new targets cannot contain additional fields.")
        return {"type": "new"}
    if _is_one_of(target_type, "selected", "selected_tab"):
        allowed = {"type"}
        if _first_unknown_key(target, allowed) is not None:
            raise TransactionalInputError("target", "selected-tab targets cannot contain additional fields.")
        return {"type": "selected_tab"}
    if _is_one_of(target_type, "tabId", "tab_id"):
        tab_id = _wire_key(target, "tabId", "tab_id")
        if not isinstance(tab_id, str) or not tab_id:
            raise TransactionalInputError("target.tabId", "tabId must be non-empty.")
        if _first_unknown_key(target, {"type", "tabId", "tab_id"}) is not None:
            raise TransactionalInputError("target", "tab-id targets contain an unsupported field.")
        return {"type": "tab_id", "tabId": tab_id}
    if _is_one_of(target_type, "conversationId", "conversation_id"):
        conversation_id = _wire_key(target, "conversationId", "conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            raise TransactionalInputError("target.conversationId", "conversationId must be non-empty.")
        if _first_unknown_key(target, {"type", "conversationId", "conversation_id"}) is not None:
            raise TransactionalInputError("target", "conversation targets contain an unsupported field.")
        return {"type": "conversation_id", "conversationId": conversation_id}
    if _is_one_of(target_type, "url"):
        url = _wire_key(target, "url")
        if not isinstance(url, str) or not url:
            raise TransactionalInputError("target.url", "url must be non-empty.")
        if _first_unknown_key(target, {"type", "url"}) is not None:
            raise TransactionalInputError("target", "URL targets contain an unsupported field.")
        return {"type": "url", "url": url}
    raise TransactionalInputError("target.type", "target type is not supported transactionally.")


def _configuration(options: Mapping[str, Any], tools: Any) -> dict[str, Any] | None:
    experience = _wire_key(options, "experience")
    if _is_one_of(experience, "work"):
        raise TransactionalInputError("experience", "experience=work is not supported by the transactional chat path.")
    if not _is_one_of(experience, None, "chat"):
        raise TransactionalInputError("experience", "experience must be chat for the transactional chat path.")
    selected = _wire_key(options, "configuration")
    mode = _wire_key(options, "mode")
    if selected is None:
        selected = {}
    if mode is None:
        mode = {}
    if not isinstance(selected, Mapping) or not isinstance(mode, Mapping):
        raise TransactionalInputError("configuration", "configuration and mode must be objects.")
    selected = _normalize_alias_groups(
        selected,
        {
            "modelVersion": ("modelVersion", "model_version", "version"),
            "timeoutMs": ("timeoutMs", "timeout_ms"),
        },
        prefix="configuration.",
    )
    mode = _normalize_alias_groups(
        mode,
        {
            "modelVersion": ("modelVersion", "model_version", "version"),
            "timeoutMs": ("timeoutMs", "timeout_ms"),
        },
        prefix="mode.",
    )
    allowed_configuration_keys = {
        "model",
        "modelVersion",
        "model_version",
        "version",
        "intelligence",
        "effort",
        "speed",
    }
    for source_name, source in (("configuration", selected), ("mode", mode)):
        unknown = _first_unknown_key(source, allowed_configuration_keys | {"timeoutMs", "timeout_ms"})
        if unknown is not None:
            raise TransactionalInputError(f"{source_name}.{unknown}", f"{source_name}.{unknown} is not supported by the transactional high-level path.")
        if _wire_key(source, "timeoutMs", "timeout_ms") is not None:
            raise TransactionalInputError(f"{source_name}.timeoutMs", "timeoutMs is not supported by the transactional high-level path.")
    result: dict[str, Any] = {}
    if experience is not None:
        result["experience"] = experience
    pairs = (("model", "model"), ("modelVersion", "modelVersion"))
    for selected_key, output_key in pairs:
        aliases = ("modelVersion", "model_version", "version") if selected_key == "modelVersion" else (selected_key,)
        first = _wire_key(selected, *aliases)
        second = _wire_key(mode, *aliases)
        for field, value in ((f"configuration.{output_key}", first), (f"mode.{output_key}", second)):
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise TransactionalInputError(field, f"{field} must be a non-empty string.")
        if first is not None and second is not None and first != second:
            raise TransactionalInputError(f"configuration.{output_key}", f"configuration and mode disagree for {output_key}.")
        if first is not None or second is not None:
            result[output_key] = first if first is not None else second
    for axis in ("intelligence", "effort", "speed"):
        first = _wire_key(selected, axis)
        second = _wire_key(mode, axis)
        for field, value in ((f"configuration.{axis}", first), (f"mode.{axis}", second)):
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise TransactionalInputError(field, f"{field} must be a non-empty string.")
        if first is not None and second is not None and first != second:
            raise TransactionalInputError(f"configuration.{axis}", f"configuration and mode disagree for {axis}.")
        if first is not None or second is not None:
            result.setdefault("additional", {})[axis] = first if first is not None else second
    if tools is None:
        tools = _wire_key(options, "tools")
    if tools is not None:
        if not isinstance(tools, list):
            raise TransactionalInputError("tools", "tools must be a list.")
        tool_names: list[str] = []
        for index, tool in enumerate(tools):
            if isinstance(tool, str):
                name = tool
            elif isinstance(tool, Mapping):
                tool = _normalize_alias_groups(
                    tool,
                    {
                        "tool": ("tool", "name"),
                        "timeoutMs": ("timeoutMs", "timeout_ms"),
                    },
                    prefix=f"tools[{index}].",
                )
                unknown = _first_unknown_key(tool, {"tool", "name", "timeoutMs", "timeout_ms"})
                if unknown is not None:
                    raise TransactionalInputError(f"tools[{index}].{unknown}", f"tools[{index}].{unknown} is not supported transactionally.")
                name = _wire_key(tool, "tool", "name")
                if _wire_key(tool, "timeoutMs", "timeout_ms") is not None:
                    raise TransactionalInputError(f"tools[{index}].timeoutMs", "tool timeoutMs is not supported transactionally.")
            else:
                raise TransactionalInputError(f"tools[{index}]", "tool entries must be strings or objects.")
            if not isinstance(name, str) or not name.strip():
                raise TransactionalInputError(f"tools[{index}].tool", "tool must be non-empty.")
            tool_names.append(name)
        if tool_names:
            result["tools"] = tool_names
    return result or None


_TRANSACTIONAL_OPTION_KEYS = {
    "target",
    "thread",
    "existingTab",
    "existing_tab",
    "preferExistingTab",
    "prefer_existing_tab",
    "experience",
    "configuration",
    "mode",
    "tools",
    "files",
    "attachments",
    "wait",
    "timeoutMs",
    "timeout_ms",
    "responseContent",
    "response_content",
    "read",
    "response",
    "copy",
    "download",
    "report",
    "capture",
    "operationId",
}

_READ_OPTION_KEYS = {
    "format",
    "maxChars",
    "max_chars",
    "role",
    # Kept as a Python compatibility alias for callers that supplied capture
    # policy alongside read options before the transactional runner landed.
    "responseContent",
    "response_content",
}

_WAIT_OPTION_KEYS = {
    "timeoutMs",
    "timeout_ms",
    "pollMs",
    "poll_ms",
    "pollIntervalMs",
    "poll_interval_ms",
    "responseContent",
    "response_content",
    "stableMs",
    "stable_ms",
    "afterTurnCount",
    "after_turn_count",
    "afterAssistantTurnCount",
    "after_assistant_turn_count",
    "afterStep",
    "after_step",
    "mode",
}

_CAPTURE_OPTION_KEYS = {
    "responseContent",
    "response_content",
    "responseFormat",
    "response_format",
    "artifacts",
    "outputDirectory",
    "output_directory",
}

_UNSET = object()


def _truncate_js_text(value: str, max_chars: int) -> str:
    """Apply the TS/JavaScript UTF-16 maxChars limit safely.

    JavaScript ``String.slice(0, maxChars)`` counts UTF-16 code units.  Python
    slices Unicode scalar values instead, so convert to UTF-16 to preserve the
    same limit.  If a limit falls inside an astral pair, clamp to the preceding
    complete pair; emitting an unpaired surrogate would make the Python result
    impossible to encode as the UTF-8 wire output used by the SDK.
    """

    encoded = value.encode("utf-16-le")
    if len(encoded) // 2 <= max_chars:
        return value
    prefix = encoded[: max_chars * 2]
    try:
        return prefix.decode("utf-16-le")
    except UnicodeDecodeError:
        return prefix[:-2].decode("utf-16-le")


def _final_output(agent: Agent, output_text: str) -> Any:
    if not output_text:
        return _UNSET
    output = agent.output
    if isinstance(output, Mapping) and output.get("parse") == "json":
        try:
            return json.loads(output_text)
        except (TypeError, ValueError):
            return output_text if output.get("onParseError") == "return_text" else _UNSET
    return output_text


def _prepare_transactional_call(
    agent: Agent,
    value: Any,
    operation_id: Any,
    *,
    options: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], int | None, str]:
    if not isinstance(operation_id, str) or not TRANSACTIONAL_OPERATION_ID_PATTERN.fullmatch(operation_id):
        raise TransactionalInputError("operationId", "operation_id must be a canonical UUID.")
    embedded_operation_id = _operation_id_from_input(value)
    if embedded_operation_id is not None and embedded_operation_id != operation_id:
        raise TransactionalInputError("operationId", "operation_id must match the runner input operationId.")
    raw_input, embedded_options = _extract_runner_input(value)
    # Match the TypeScript runner precedence: explicit invocation fields win,
    # then fields embedded in the run input, then agent defaults.  Normalize
    # default aliases before reading them so ``existing_tab`` and
    # ``model_version`` behave like their camelCase wire equivalents.
    normalized_defaults = _normalize_alias_groups(agent.defaults, _TOP_LEVEL_ALIAS_GROUPS)
    embedded_options = _normalize_alias_groups(embedded_options, _TOP_LEVEL_ALIAS_GROUPS)
    if options is None:
        explicit_options: Mapping[Any, Any] = {}
    elif isinstance(options, Mapping):
        explicit_options = options
    else:
        raise TransactionalInputError("options", "transactional options must be an object.")
    normalized_explicit_options = _normalize_alias_groups(explicit_options, _TOP_LEVEL_ALIAS_GROUPS)
    merged: dict[str, Any] = {
        **normalized_defaults,
        **embedded_options,
        **normalized_explicit_options,
    }
    unknown = _first_unknown_key(merged, _TRANSACTIONAL_OPTION_KEYS)
    if unknown is not None:
        raise TransactionalInputError(
            unknown,
            f"{unknown} is not supported by the transactional high-level path.",
        )
    embedded_option_id = merged.get("operationId")
    if embedded_option_id is not None and embedded_option_id != operation_id:
        raise TransactionalInputError("operationId", "operation_id must match the runner input operationId.")
    prompt, input_files = _render_prompt(agent, raw_input)
    target = merged.get("target")
    if target is not None:
        if any(selector in merged for selector in ("thread", "existingTab", "preferExistingTab")):
            raise TransactionalInputError(
                "target",
                "target cannot be combined with thread, existingTab, or preferExistingTab.",
            )
        target = _direct_target(target)
    if target is None:
        thread = _wire_key(merged, "thread")
        existing_tab = _wire_key(merged, "existingTab", "existing_tab")
        prefer_existing = _wire_key(merged, "preferExistingTab", "prefer_existing_tab")
        if prefer_existing is not None and not isinstance(prefer_existing, bool):
            raise TransactionalInputError("preferExistingTab", "preferExistingTab must be a boolean.")
        if thread is not None and (existing_tab is not None or prefer_existing is True):
            raise TransactionalInputError("thread", "thread cannot be combined with existingTab or preferExistingTab transactionally.")
        if thread is not None:
            target = _thread_target(thread)
        elif prefer_existing is True:
            target = {"type": "selected_tab"}
        elif existing_tab is not None:
            target = _existing_tab_target(existing_tab)
        else:
            target = {"type": "new"}

    wait = _wire_key(merged, "wait")
    if wait is None:
        wait = True
    timeout_ms = _wire_key(merged, "timeoutMs", "timeout_ms")
    response_content = _wire_key(merged, "responseContent", "response_content")
    read = _wire_key(merged, "read", "response")
    max_chars: int | None = None
    response_format = "markdown"
    if isinstance(read, Mapping):
        read = _normalize_alias_groups(
            read,
            {
                "maxChars": ("maxChars", "max_chars"),
                "responseContent": ("responseContent", "response_content"),
            },
            prefix="read.",
        )
        unknown = _first_unknown_key(read, _READ_OPTION_KEYS)
        if unknown is not None:
            raise TransactionalInputError(f"read.{unknown}", f"read.{unknown} is not supported by the transactional runner path.")
        max_chars = _wire_key(read, "maxChars", "max_chars")
        if max_chars is not None and (isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars < 0 or max_chars > 8 * 1024 * 1024):
            raise TransactionalInputError("read.maxChars", "read.maxChars must be between 0 and 8388608.")
        requested_format = _wire_key(read, "format")
        if requested_format is not None:
            if not _is_one_of(requested_format, "markdown", "text"):
                raise TransactionalInputError(
                    "read.format",
                    "read.format must be markdown or text on the transactional runner path.",
                )
            response_format = requested_format
        requested_role = _wire_key(read, "role")
        if requested_role is not None and not _is_one_of(requested_role, "assistant"):
            raise TransactionalInputError("read.role", "read.role=user is not supported by the transactional ask path.")
        requested_read = True
        read_response_content = _wire_key(read, "responseContent", "response_content")
        if read_response_content is not None:
            response_content = read_response_content
    else:
        if read is not None and not isinstance(read, bool):
            raise TransactionalInputError("read", "read must be a boolean or supported options object.")
        requested_read = read is True or read is None
    if response_content is None:
        response_content = "include" if requested_read else "metadata"
    if not _is_one_of(response_content, "include", "metadata"):
        raise TransactionalInputError("responseContent", "response_content must be include or metadata.")
    poll_interval_ms: int | None = None
    if isinstance(wait, Mapping):
        wait = _normalize_alias_groups(
            wait,
            {
                "timeoutMs": ("timeoutMs", "timeout_ms"),
                "pollIntervalMs": ("pollIntervalMs", "poll_interval_ms", "pollMs", "poll_ms"),
                "responseContent": ("responseContent", "response_content"),
                "stableMs": ("stableMs", "stable_ms"),
                "afterTurnCount": ("afterTurnCount", "after_turn_count"),
                "afterAssistantTurnCount": ("afterAssistantTurnCount", "after_assistant_turn_count"),
                "afterStep": ("afterStep", "after_step"),
            },
            prefix="wait.",
        )
        unknown = _first_unknown_key(wait, _WAIT_OPTION_KEYS)
        if unknown is not None:
            raise TransactionalInputError(f"wait.{unknown}", f"wait.{unknown} is not supported by the transactional runner path.")
        timeout_ms = _wire_key(wait, "timeoutMs", "timeout_ms") if timeout_ms is None else timeout_ms
        wait_response_content = _wire_key(wait, "responseContent", "response_content")
        if wait_response_content is not None:
            if not _is_one_of(wait_response_content, "include", "metadata"):
                raise TransactionalInputError("wait.responseContent", "wait.response_content must be include or metadata.")
            response_content = wait_response_content
        poll_value = wait.get("pollIntervalMs")
        if "pollIntervalMs" in wait:
            if isinstance(poll_value, bool) or not isinstance(poll_value, int) or poll_value < 0 or poll_value > _MAX_POLL_INTERVAL_MS:
                raise TransactionalInputError("wait.pollIntervalMs", "wait.pollIntervalMs must be an integer between 0 and 60000.")
            poll_interval_ms = poll_value
        unsupported_wait = {"stableMs", "afterTurnCount", "afterAssistantTurnCount", "afterStep", "mode"}
        if any(key in wait for key in unsupported_wait):
            field = next(key for key in unsupported_wait if key in wait)
            raise TransactionalInputError(f"wait.{field}", f"wait.{field} is not supported by the transactional runner path.")
        wait = True
    if not isinstance(wait, bool):
        raise TransactionalInputError("wait", "wait must be a boolean or supported options object.")
    if timeout_ms is not None and (isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or timeout_ms < 1 or timeout_ms > 86_400_000):
        raise TransactionalInputError("timeoutMs", "timeout_ms must be between 1 and 86400000.")

    if not _is_one_of(_wire_key(merged, "copy"), None, False):
        raise TransactionalInputError("copy", "copy is not supported by the transactional runner path; collect explicitly instead.")
    if not _is_one_of(_wire_key(merged, "download"), None, False):
        raise TransactionalInputError("download", "download is not supported by the transactional runner path; collect explicitly instead.")
    report = _wire_key(merged, "report")
    if not _is_one_of(report, None, False):
        raise TransactionalInputError("report", "report is not supported by the transactional runner path.")

    files: list[dict[str, Any]] = [{"path": path} for path in input_files]
    for field in ("files", "attachments"):
        values = merged.get(field)
        if values is None:
            continue
        if not isinstance(values, list):
            raise TransactionalInputError(field, f"{field} must be a list.")
        for index, file in enumerate(values):
            if isinstance(file, str):
                path = file
                entry: dict[str, Any] = {"path": path}
            elif isinstance(file, Mapping):
                file = _normalize_alias_groups(
                    file,
                    {"displayName": ("displayName", "display_name")},
                    prefix=f"{field}[{index}].",
                )
                unknown = _first_unknown_key(file, {"path", "displayName", "display_name"})
                if unknown is not None:
                    raise TransactionalInputError(f"{field}[{index}].{unknown}", f"{field}[{index}].{unknown} is not supported transactionally.")
                path = file.get("path")
                entry = {"path": path}
                if file.get("display_name") is not None or file.get("displayName") is not None:
                    entry["displayName"] = _wire_key(file, "displayName", "display_name")
                    if not isinstance(entry["displayName"], str) or not entry["displayName"]:
                        raise TransactionalInputError(f"{field}[{index}].displayName", "displayName must be non-empty.")
            else:
                raise TransactionalInputError(f"{field}[{index}]", "file entries must be paths or objects.")
            if not isinstance(path, str) or not path:
                raise TransactionalInputError(f"{field}[{index}].path", "file path must be non-empty.")
            files.append(entry)

    configuration = _configuration(merged, _wire_key(merged, "tools"))
    capture = _wire_key(merged, "capture")
    if capture is None:
        capture = {"responseContent": response_content, "artifacts": "receipt_only"}
    elif not isinstance(capture, Mapping):
        raise TransactionalInputError("capture", "capture must be an object.")
    else:
        capture = _normalize_alias_groups(
            capture,
            {
                "responseContent": ("responseContent", "response_content"),
                "responseFormat": ("responseFormat", "response_format"),
                "outputDirectory": ("outputDirectory", "output_directory"),
            },
            prefix="capture.",
        )
        unknown = _first_unknown_key(capture, _CAPTURE_OPTION_KEYS)
        if unknown is not None:
            raise TransactionalInputError(f"capture.{unknown}", f"capture.{unknown} is not supported by the transactional runner path.")
        artifacts = _wire_key(capture, "artifacts")
        if not _is_one_of(artifacts, None, "receipt_only"):
            raise TransactionalInputError("capture.artifacts", "transactional high-level calls support receipt_only artifacts only.")
        if _has_wire_key(capture, "outputDirectory", "output_directory"):
            output_directory = _wire_key(capture, "outputDirectory", "output_directory")
            if output_directory is not None:
                raise TransactionalInputError("capture.outputDirectory", "capture.outputDirectory is not supported for receipt_only artifacts.")
            raise TransactionalInputError("capture.outputDirectory", "capture.outputDirectory must be omitted for receipt_only artifacts.")
        capture_response_content = _wire_key(capture, "responseContent", "response_content")
        if _has_wire_key(capture, "responseContent", "response_content"):
            if not _is_one_of(capture_response_content, "include", "metadata"):
                raise TransactionalInputError("capture.responseContent", "capture.response_content must be include or metadata.")
            if capture_response_content != response_content:
                raise TransactionalInputError("capture.responseContent", "capture.response_content must match responseContent.")
        else:
            capture["responseContent"] = response_content
        capture["artifacts"] = "receipt_only"
    capture_format_present = "responseFormat" in capture or "response_format" in capture
    capture_format = _wire_key(capture, "responseFormat", "response_format")
    if capture_format_present and capture_format is None:
        raise TransactionalInputError("capture.responseFormat", "capture.response_format must be omitted or markdown/text.")
    if capture_format is not None and not _is_one_of(capture_format, "markdown", "text"):
        raise TransactionalInputError("capture.responseFormat", "capture.response_format must be markdown or text.")
    if capture_format is not None and capture_format != response_format:
        raise TransactionalInputError("capture.responseFormat", "capture.response_format must match read.format.")
    capture["responseFormat"] = response_format
    request: dict[str, Any] = {
        "operation_id": operation_id,
        "surface": "chat",
        "prompt": prompt,
        "target": target,
        "configuration": configuration,
        "files": files or None,
        "capture": capture,
        "timeout_ms": timeout_ms,
    }
    return {key: value for key, value in request.items() if value is not None} | {
        "wait": wait,
        "response_content": response_content,
        **({"poll_interval_ms": poll_interval_ms} if poll_interval_ms is not None else {}),
    }, max_chars, response_format


def _unsupported_run_result(agent: Agent, operation_id: Any, error: TransactionalInputError) -> ChatGPTRunResult:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    op_data = {} if operation_id is None else {"operationId": operation_id} if isinstance(operation_id, str) else {}
    blocked_item = {"type": "run.blocked", "blocker": {"code": "unsupported_operation_input", "fieldPath": error.field, "message": error.message}}
    return ChatGPTRunResult.from_wire({
        "ok": False,
        "status": "unsupported",
        "data": {"outputText": "", **op_data},
        "output_text": "",
        "output": [blocked_item],
        "newItems": [blocked_item],
        "interruptions": [],
        "state": {"id": str(operation_id) if isinstance(operation_id, str) else "unsupported", "resumable": False, **op_data},
        "activeAgentName": agent.name,
        "lastAgentName": agent.name,
        "warnings": [],
        "context": {"timestamp": now},
        "blocker": {"kind": "unknown", "code": "unsupported_operation_input", "fieldPath": error.field, "message": error.message},
        "error": {"name": "OperationInputError", "message": error.message, "recoverable": False},
    })


def _operation_error_run_result(agent: Agent, operation_id: Any, error: Exception) -> ChatGPTRunResult:
    """Return a bounded failure without rendering a backend exception."""

    try:
        static_code = inspect.getattr_static(error, "code", None)
    except Exception:
        static_code = None
    code = (
        static_code
        if type(static_code) is str and _SAFE_BACKEND_CODE_PATTERN.fullmatch(static_code)
        else "operation_error"
    )
    recoverable_codes = {
        "adapter_unavailable",
        "browser_bridge_unavailable",
        "target_evidence_unavailable",
    }
    recoverable = code in recoverable_codes
    status = "blocked" if recoverable else "error"
    safe_label = code.replace("_", " ")
    message = f"Transactional operation failed ({safe_label})."
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    op_data = {"operationId": operation_id} if type(operation_id) is str else {}
    blocker_kind = (
        "browser_bridge_unavailable"
        if code == "browser_bridge_unavailable"
        else "selector_drift"
        if code == "target_evidence_unavailable"
        else "unknown"
    )
    blocker = {
        "kind": blocker_kind,
        "code": code,
        "message": message,
        "recoverable": recoverable,
    }
    blocked_item = {"type": "run.blocked", "blocker": blocker}
    run_wire: dict[str, Any] = {
        "ok": False,
        "status": status,
        "data": {"outputText": "", **op_data},
        "output_text": "",
        "output": [blocked_item] if recoverable else [],
        "newItems": [blocked_item] if recoverable else [],
        "interruptions": [],
        "state": {
            "id": operation_id if type(operation_id) is str else "operation-error",
            "resumable": recoverable,
            **op_data,
        },
        "activeAgentName": agent.name,
        "lastAgentName": agent.name,
        "warnings": [],
        "context": {"timestamp": now},
        "error": {"name": "OperationError", "message": message, "recoverable": recoverable},
    }
    if recoverable:
        run_wire["blocker"] = blocker
    return ChatGPTRunResult.from_wire(run_wire)


def operation_result_to_run_result(
    agent: Agent,
    result: OperationSubmitResult | OperationCollectResult,
    *,
    max_chars: int | None = None,
    response_format: str = "markdown",
    response_content: Literal["include", "metadata"] = "include",
) -> ChatGPTRunResult:
    """Map a validated operation envelope to the legacy run result shape."""

    handle = result.handle.to_wire()
    operation_id = result.operation_id
    status = "ok" if result.status == "completed" else "blocked" if result.status == "blocked" else "partial"
    data: dict[str, Any] = {
        "operationId": operation_id,
        "requestDigest": result.request_digest,
        "handle": handle,
        "operationStatus": result.status,
        "outputText": "",
        "responseFormat": response_format,
    }
    output_text = ""
    receipt = getattr(result, "receipt", None)
    live_response = getattr(result, "live_response", None)
    if receipt is not None:
        receipt_wire = receipt.to_wire()
        data.update({
            "complete": True,
            "submissionState": "submitted",
            "completionState": "complete",
            "generationActive": False,
            "responseDigest": receipt_wire.get("responseDigest"),
            "responseBytes": receipt_wire.get("responseBytes"),
            "artifacts": receipt_wire.get("artifacts", []),
        })
    elif result.status == "pending":
        data.update({
            "pending": True,
            "complete": False,
            "submissionState": "submitted_generating" if result.handle.phase == "generating" else "submitted",
            "completionState": "generating" if result.handle.phase == "generating" else "unknown",
            "generationActive": result.handle.phase == "generating",
        })
    elif result.status in {"blocked", "uncertain"}:
        boundary = result.handle.mutation_boundary
        data.update({
            "complete": False,
            "submissionState": "submitted_unconfirmed" if boundary in {"send_may_have_occurred", "control_may_have_occurred"} else "not_submitted",
            "completionState": "partial" if result.handle.phase in {"uncertain", "capturing"} else "generating" if result.handle.phase == "generating" else "unknown",
            "generationActive": result.handle.phase == "generating",
        })
    if response_content == "include" and live_response is not None:
        output_text = live_response.content
        if max_chars is not None:
            output_text = _truncate_js_text(output_text, max_chars)
        data["responseText"] = output_text
        data["responseBytes"] = live_response.bytes
        data["complete"] = result.status == "completed"
    data["outputText"] = output_text
    effective_response_format = data["responseFormat"]
    blocker_wire = getattr(result, "blocker", None)
    blocker = blocker_wire.to_wire() if blocker_wire is not None else None
    output: list[dict[str, Any]] = []
    if output_text:
        output.append({
            "type": "message.completed" if result.status == "completed" else "message.in_progress",
            "role": "assistant",
            "output_text": output_text,
            "format": effective_response_format,
            **({"completionState": "complete"} if result.status == "completed" else {"completionState": data.get("completionState", "unknown")}),
        })
    if blocker is not None:
        output.append({"type": "run.blocked", "blocker": blocker})
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    state: dict[str, Any] = {
        "id": operation_id,
        "resumable": bool(blocker.get("recoverable", False)) if blocker is not None else result.status != "completed",
        "operationId": operation_id,
        "handle": handle,
        "submissionState": data.get("submissionState"),
        "completionState": data.get("completionState"),
    }
    if output_text:
        data["untrustedOutput"] = render_untrusted_output_return_envelope(
            output_text=output_text,
            source="chatgpt",
            captured_at=now,
            metadata={"result_status": status},
        )
    final_output = _final_output(agent, output_text)
    run_wire: dict[str, Any] = {
        "ok": status == "ok",
        "status": status,
        "data": {key: value for key, value in data.items() if value is not None},
        "output_text": output_text,
        "output": output,
        "newItems": output,
        "interruptions": [],
        "state": {key: value for key, value in state.items() if value is not None},
        "activeAgentName": agent.name,
        "lastAgentName": agent.name,
        "warnings": [],
        "context": {"timestamp": now},
    }
    if final_output is not _UNSET:
        run_wire["finalOutput"] = final_output
    if blocker is not None:
        run_wire["blocker"] = blocker
    return ChatGPTRunResult.from_wire(run_wire)


def run_transactional_sync(
    backend: Any,
    agent: Agent,
    input: Any,
    *,
    operation_id: str | None = None,
    options: Mapping[str, Any] | None = None,
) -> ChatGPTRunResult:
    effective_id: Any = operation_id
    try:
        effective_id = _operation_id_from_input(input, operation_id)
        request = _prepare_transactional_call(agent, input, effective_id, options=options)
    except TransactionalInputError as error:
        return _unsupported_run_result(agent, effective_id, error)
    except Exception:
        return _unsupported_run_result(
            agent,
            effective_id,
            TransactionalInputError(_UNSAFE_FIELD_MARKER, "runner input could not be read safely."),
        )
    request_kwargs, max_chars, response_format = request
    response_content = request_kwargs["response_content"]
    try:
        result = OperationsClient(backend).run(**request_kwargs)
        return operation_result_to_run_result(
            agent,
            result,
            max_chars=max_chars,
            response_format=response_format,
            response_content=response_content,
        )
    except Exception as error:
        return _operation_error_run_result(agent, effective_id, error)


async def run_transactional_async(
    backend: Any,
    agent: Agent,
    input: Any,
    *,
    operation_id: str | None = None,
    options: Mapping[str, Any] | None = None,
) -> ChatGPTRunResult:
    effective_id: Any = operation_id
    try:
        effective_id = _operation_id_from_input(input, operation_id)
        request = _prepare_transactional_call(agent, input, effective_id, options=options)
    except TransactionalInputError as error:
        return _unsupported_run_result(agent, effective_id, error)
    except Exception:
        return _unsupported_run_result(
            agent,
            effective_id,
            TransactionalInputError(_UNSAFE_FIELD_MARKER, "runner input could not be read safely."),
        )
    request_kwargs, max_chars, response_format = request
    response_content = request_kwargs["response_content"]
    try:
        result = await AsyncOperationsClient(backend).run(**request_kwargs)
        return operation_result_to_run_result(
            agent,
            result,
            max_chars=max_chars,
            response_format=response_format,
            response_content=response_content,
        )
    except asyncio.CancelledError:
        raise
    except Exception as error:
        return _operation_error_run_result(agent, effective_id, error)


class RunnerBackend(Protocol):
    def runner_run(self, agent: dict[str, Any], input: Any) -> dict[str, Any]:
        ...

    def runner_plan(self, agent: dict[str, Any], input: Any) -> dict[str, Any]:
        ...

    def runner_stream(self, agent: dict[str, Any], input: Any) -> Iterator[dict[str, Any]]:
        ...


@dataclass
class RunResultStreaming:
    _events: Iterator[dict[str, Any]]
    final_result: ChatGPTRunResult | None = None

    def __iter__(self) -> "RunResultStreaming":
        return self

    def __next__(self) -> BackendEvent:
        event = BackendEvent.from_wire(next(self._events))
        if event.type == "completed" and isinstance(event.result, ChatGPTRunResult):
            self.final_result = event.result
        return event


class Runner:
    def __init__(self, backend: Any) -> None:
        self._backend = backend

    async def run(
        self,
        agent: Agent,
        input: Any,
        *,
        operation_id: str | None = None,
        **operation_options: Any,
    ) -> ChatGPTRunResult:
        try:
            embedded_operation_id = _operation_id_from_input(input)
        except TransactionalInputError as error:
            return _unsupported_run_result(agent, operation_id, error)
        if operation_id is not None or embedded_operation_id is not None:
            return await run_transactional_async(
                self._backend,
                agent,
                input,
                operation_id=operation_id,
                options=operation_options,
            )
        method = self._backend.runner_run
        if inspect.iscoroutinefunction(method):
            result = await method(agent.to_wire(), input)
        else:
            result = await asyncio.to_thread(method, agent.to_wire(), input)
        if inspect.isawaitable(result):
            result = await result
        return ChatGPTRunResult.from_wire(result)

    def run_sync(
        self,
        agent: Agent,
        input: Any,
        *,
        operation_id: str | None = None,
        **operation_options: Any,
    ) -> ChatGPTRunResult:
        try:
            embedded_operation_id = _operation_id_from_input(input)
        except TransactionalInputError as error:
            return _unsupported_run_result(agent, operation_id, error)
        if operation_id is not None or embedded_operation_id is not None:
            return run_transactional_sync(
                self._backend,
                agent,
                input,
                operation_id=operation_id,
                options=operation_options,
            )
        return ChatGPTRunResult.from_wire(self._backend.runner_run(agent.to_wire(), input))

    def plan(self, agent: Agent, input: Any) -> SequencePlan:
        return SequencePlan.from_wire(self._backend.runner_plan(agent.to_wire(), input))

    def run_streamed(self, agent: Agent, input: Any) -> RunResultStreaming:
        return RunResultStreaming(iter(self._backend.runner_stream(agent.to_wire(), input)))
