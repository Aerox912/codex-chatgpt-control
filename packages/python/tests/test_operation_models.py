import copy
import json
import traceback
import unittest
from pathlib import Path
from typing import Any

from codex_chatgpt_control.operation_models import (
    ARTIFACT_SCHEMA,
    ARTIFACT_TRANSFER_INTENT_SCHEMA,
    ARTIFACT_TRANSFER_RECEIPT_SCHEMA,
    BLOCKER_SCHEMA,
    COLLECT_SCHEMA,
    CONTROL_RECEIPT_SCHEMA,
    CONTROL_REQUEST_SCHEMA,
    EVENT_SCHEMA,
    HANDLE_SCHEMA,
    INSPECT_SCHEMA,
    MAX_OWNERSHIP_BASELINES,
    MAX_PROMPT_BYTES,
    MAX_JSON_UTF8_BYTES,
    RECOVERY_DECISION_SCHEMA,
    RECOVERY_OBSERVATION_SCHEMA,
    RECEIPT_SCHEMA,
    REQUEST_SCHEMA,
    SUBMISSION_WITNESS_SCHEMA,
    TURN_SCHEMA,
    ConversationIdTarget,
    OperationActionIntent,
    OperationActionRecord,
    ArtifactTransferIntent,
    ArtifactTransferReceipt,
    BackendCompatibilityReport,
    OperationArtifactReceipt,
    OperationBlocker,
    OperationCollectRequest,
    OperationCapturePolicy,
    OperationConfiguration,
    OperationDurableCapturePolicy,
    OperationControlReceipt,
    OperationControlRequest,
    OperationEventEnvelope,
    OperationHandle,
    OperationInputFile,
    OperationInspectRequest,
    OperationJournalSnapshot,
    OperationReceipt,
    OperationRecoveryObservation,
    OperationState,
    OperationSubmissionWitness,
    OperationTargetEstablishment,
    OperationSubmitRequest,
    RecoveryObserveActionPostcondition,
    validate_recovery_payload,
)


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"


def load_json(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class OperationModelTests(unittest.TestCase):
    def test_compatibility_report_is_bounded_and_round_trips_camel_case(self) -> None:
        fixture = load_json("backend-compatibility.json")
        report = BackendCompatibilityReport.from_wire(fixture)

        self.assertEqual(report.status, "warning")
        self.assertEqual(report.mode, "multiplexed")
        self.assertEqual(report.package_version, "0.5.1-alpha.2")
        self.assertEqual(report.warnings[0].code, "build_digest_mismatch")
        self.assertEqual(report.to_wire(), fixture)

        malformed = dict(fixture)
        malformed["warnings"] = [{
            "code": "build_digest_mismatch",
            "message": "x" * 513,
        }]
        with self.assertRaises(ValueError):
            BackendCompatibilityReport.from_wire(malformed)

    def test_all_operation_fixtures_round_trip_with_wire_aliases(self) -> None:
        models = {
            "operation-request.json": OperationSubmitRequest,
            "operation-handle.json": OperationHandle,
            "operation-collect-request.json": OperationCollectRequest,
            "operation-inspect-request.json": OperationInspectRequest,
            "operation-control-request.json": OperationControlRequest,
            "operation-control-receipt.json": OperationControlReceipt,
            "operation-artifact-receipt.json": OperationArtifactReceipt,
            "operation-artifact-transfer-intent-event.json": OperationEventEnvelope,
            "operation-artifact-transfer-receipt-event.json": OperationEventEnvelope,
            "operation-artifact-transfer-state.json": OperationState,
            "operation-receipt.json": OperationReceipt,
            "operation-blocker.json": OperationBlocker,
            "operation-event.json": OperationEventEnvelope,
            "operation-action-prepared-event.json": OperationEventEnvelope,
            "operation-ownership-baseline-event.json": OperationEventEnvelope,
            "operation-state.json": OperationState,
            "operation-submission-witness.json": OperationSubmissionWitness,
            "operation-submission-witness-event.json": OperationEventEnvelope,
            "operation-target-established-event.json": OperationEventEnvelope,
        }
        for filename, model in models.items():
            with self.subTest(filename=filename):
                fixture = load_json(filename)
                parsed = model.from_wire(fixture)
                self.assertEqual(parsed.to_wire(), fixture)
                self.assertTrue(all("_" not in key for key in parsed.to_wire()))

    def test_nested_aliases_are_idiomatic_in_python(self) -> None:
        request = OperationSubmitRequest.from_wire(load_json("operation-request.json"))
        self.assertEqual(request.schema_version, REQUEST_SCHEMA)
        self.assertEqual(request.operation_id, "11111111-1111-4111-8111-111111111111")
        assert isinstance(request.target, ConversationIdTarget)
        self.assertEqual(request.target.conversation_id, "conversation-1")
        self.assertEqual(request.configuration.model_version, "model-version")  # type: ignore[union-attr]
        self.assertEqual(request.files[0].display_name, "example.txt")  # type: ignore[index,union-attr]
        self.assertEqual(request.capture.artifacts, "receipt_only")  # type: ignore[union-attr]

        collect = OperationCollectRequest.from_wire(load_json("operation-collect-request.json"))
        self.assertEqual(collect.poll_interval_ms, 250)
        self.assertEqual(collect.to_wire()["pollIntervalMs"], 250)

        state = OperationState.from_wire(load_json("operation-state.json"))
        self.assertEqual(state.mutation_boundary, "send_may_have_occurred")
        self.assertEqual(state.response_format, "markdown")
        self.assertEqual(state.capture_policy.response_content, "metadata")  # type: ignore[union-attr]
        self.assertEqual(state.capture_policy.artifacts, "receipt_only")  # type: ignore[union-attr]
        self.assertEqual(state.target.evidence_profile.stable_user_turn_id, "required")  # type: ignore[union-attr]
        action = next(iter(state.actions.values()))
        self.assertEqual(action.repeat_policy, "observe_only_after_intent")
        self.assertEqual(action.intent_revision, 6)
        self.assertEqual(state.ownership_baseline.action_id, action.action_id)  # type: ignore[union-attr]
        self.assertEqual(state.ownership_baselines[action.action_id].action_id, action.action_id)  # type: ignore[index,union-attr]
        self.assertEqual(state.submission_witnesses[action.action_id].action_id, action.action_id)  # type: ignore[index,union-attr]
        self.assertEqual(state.submission_witness.post_send_delta_digest, "hmac-sha256:" + "d" * 64)  # type: ignore[union-attr]

    def test_transactional_response_format_aliases_and_enum_are_strict(self) -> None:
        request = OperationSubmitRequest.from_wire(load_json("operation-request.json"))
        self.assertEqual(request.capture.response_format, "markdown")  # type: ignore[union-attr]
        self.assertEqual(request.capture.to_wire()["responseFormat"], "markdown")  # type: ignore[union-attr]

        text_request = load_json("operation-request.json")
        text_request["capture"]["responseFormat"] = "text"
        parsed_text = OperationSubmitRequest.from_wire(text_request)
        self.assertEqual(parsed_text.capture.response_format, "text")  # type: ignore[union-attr]

        bad_request = load_json("operation-request.json")
        bad_request["capture"]["responseFormat"] = "html"
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(bad_request)

        receipt = OperationReceipt.from_wire(load_json("operation-receipt.json"))
        self.assertEqual(receipt.response_format, "markdown")
        bad_receipt = load_json("operation-receipt.json")
        bad_receipt["responseFormat"] = "visible_text"
        with self.assertRaises(ValueError):
            OperationReceipt.from_wire(bad_receipt)

        null_receipt = load_json("operation-receipt.json")
        null_receipt["responseFormat"] = None
        with self.assertRaises(ValueError):
            OperationReceipt.from_wire(null_receipt)

        null_state = load_json("operation-state.json")
        null_state["responseFormat"] = None
        with self.assertRaises(ValueError):
            OperationState.from_wire(null_state)

        null_baselines = load_json("operation-state.json")
        null_baselines["ownershipBaselines"] = None
        with self.assertRaises(ValueError):
            OperationState.from_wire(null_baselines)

        policy = OperationCapturePolicy.from_wire({
            "responseContent": "metadata",
            "responseFormat": "text",
            "artifacts": "receipt_only",
        })
        self.assertEqual(policy.response_format, "text")

        durable_policy = OperationDurableCapturePolicy.from_wire({
            "responseContent": "metadata",
            "responseFormat": "text",
            "artifacts": "transfer",
        })
        self.assertEqual(durable_policy.to_wire(), {
            "responseContent": "metadata",
            "responseFormat": "text",
            "artifacts": "transfer",
        })

    def test_durable_capture_policy_is_closed_path_free_and_rejects_nulls(self) -> None:
        state = load_json("operation-state.json")
        self.assertNotIn("outputDirectory", state["capturePolicy"])
        self.assertNotIn("/tmp/example", json.dumps(state))

        unknown = copy.deepcopy(state)
        unknown["capturePolicy"]["outputDirectory"] = "/private/secret"
        with self.assertRaises(ValueError):
            OperationState.from_wire(unknown)

        explicit_null = copy.deepcopy(state)
        explicit_null["capturePolicy"]["responseFormat"] = None
        with self.assertRaises(ValueError):
            OperationState.from_wire(explicit_null)

        missing_format = copy.deepcopy(state)
        missing_format["capturePolicy"].pop("responseFormat")
        with self.assertRaises(ValueError):
            OperationState.from_wire(missing_format)

        event = load_json("operation-event.json")
        event["event"]["capturePolicy"]["outputDirectory"] = "/private/secret"
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(event)

        event_null = load_json("operation-event.json")
        event_null["event"]["capturePolicy"] = None
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(event_null)

    def test_recovery_observation_and_discriminated_decision_parse(self) -> None:
        observation = validate_recovery_payload(load_json("operation-recovery-observation.json"))
        self.assertIsInstance(observation, OperationRecoveryObservation)
        assert isinstance(observation, OperationRecoveryObservation)
        self.assertEqual(observation.schema_version, RECOVERY_OBSERVATION_SCHEMA)
        self.assertEqual(observation.turn.status, "owned_assistant_terminal")

        decision = validate_recovery_payload(load_json("operation-recovery-decision.json"))
        self.assertIsInstance(decision, RecoveryObserveActionPostcondition)
        assert isinstance(decision, RecoveryObserveActionPostcondition)
        self.assertEqual(decision.schema_version, RECOVERY_DECISION_SCHEMA)
        self.assertFalse(decision.may_repeat_action)

    def test_journal_snapshot_wraps_redacted_state(self) -> None:
        state = load_json("operation-state.json")
        snapshot = {
            "schemaVersion": TURN_SCHEMA,
            "lastEventDigest": "hmac-sha256:" + "9" * 64,
            "state": state,
        }
        parsed = OperationJournalSnapshot.from_wire(snapshot)
        self.assertEqual(parsed.last_event_digest, snapshot["lastEventDigest"])
        self.assertEqual(parsed.to_wire(), snapshot)

    def test_public_models_are_strict_and_unknown_nested_keys_are_rejected(self) -> None:
        payload = load_json("operation-handle.json")
        payload["unexpected"] = True
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(payload)

    def test_wire_decoding_rejects_python_aliases_but_constructors_remain_ergonomic(self) -> None:
        handle = load_json("operation-handle.json")
        handle["target_binding_digest"] = handle["targetBindingDigest"]
        with self.assertRaisesRegex(ValueError, "^Invalid transactional operation wire payload\\.$"):
            OperationHandle.from_wire(handle)

        request = load_json("operation-request.json")
        request["configuration"]["model_version"] = request["configuration"]["modelVersion"]
        with self.assertRaisesRegex(ValueError, "^Invalid transactional operation wire payload\\.$"):
            OperationSubmitRequest.from_wire(request)

        constructor_args: dict[str, Any] = {
            "schema_version": HANDLE_SCHEMA,
            "operation_id": handle["operationId"],
            "request_digest": handle["requestDigest"],
            "surface": handle["surface"],
            "revision": handle["revision"],
            "phase": handle["phase"],
            "mutation_boundary": handle["mutationBoundary"],
            "target_binding_digest": handle["targetBindingDigest"],
        }
        constructed = OperationHandle(**constructor_args)
        self.assertEqual(constructed.to_wire(), load_json("operation-handle.json"))
        configuration_args: dict[str, Any] = {"model_version": "python-friendly"}
        configuration = OperationConfiguration(**configuration_args)
        self.assertEqual(configuration.model_version, "python-friendly")
        self.assertEqual(configuration.to_wire(), {"modelVersion": "python-friendly"})

    def test_optional_wire_null_policy_is_recursive_and_table_driven(self) -> None:
        cases: list[tuple[str, Any, str, Any]] = [
            (
                "nested configuration",
                OperationSubmitRequest,
                "configuration",
                load_json("operation-request.json"),
            ),
            (
                "handle target digest",
                OperationHandle,
                "targetBindingDigest",
                load_json("operation-handle.json"),
            ),
            (
                "collect wait",
                OperationCollectRequest,
                "wait",
                load_json("operation-collect-request.json"),
            ),
            (
                "control timeout",
                OperationControlRequest,
                "timeoutMs",
                load_json("operation-control-request.json"),
            ),
            (
                "receipt response digest",
                OperationReceipt,
                "responseDigest",
                load_json("operation-receipt.json"),
            ),
            (
                "submission witness user turn",
                OperationSubmissionWitness,
                "userTurnId",
                load_json("operation-submission-witness.json"),
            ),
            (
                "materialized state receipt",
                OperationState,
                "receipt",
                load_json("operation-state.json"),
            ),
        ]

        for label, model, field, payload in cases:
            with self.subTest(label=label):
                candidate = copy.deepcopy(payload)
                if label == "nested configuration":
                    candidate["configuration"]["model"] = None
                else:
                    candidate[field] = None
                with self.assertRaisesRegex(ValueError, "^Invalid transactional operation wire payload\\.$"):
                    model.from_wire(candidate)

    def test_ownership_baseline_cap_applies_to_direct_construction_and_wire_decode(self) -> None:
        state = load_json("operation-state.json")
        baseline = next(iter(state["ownershipBaselines"].values()))
        oversized = copy.deepcopy(state)
        oversized["ownershipBaselines"] = {
            f"{index:08x}-1111-4111-8111-111111111111": copy.deepcopy(baseline)
            for index in range(1, MAX_OWNERSHIP_BASELINES + 2)
        }

        with self.assertRaisesRegex(ValueError, "at most 64"):
            OperationState(**oversized)
        with self.assertRaisesRegex(ValueError, "^Invalid transactional operation wire payload\\.$"):
            OperationState.from_wire(oversized)

    def test_unknown_wire_diagnostics_are_fixed_even_for_nested_and_discriminated_errors(self) -> None:
        secret_key = "attacker-controlled-private-key-" + ("x" * 1024)
        request = load_json("operation-request.json")
        request[secret_key] = {"private": "value"}
        with self.assertRaises(ValueError) as raised:
            OperationSubmitRequest.from_wire(request)
        self.assertEqual(str(raised.exception), "Invalid transactional operation wire payload.")
        self.assertNotIn(secret_key, str(raised.exception))
        self.assertNotIn(secret_key, repr(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertNotIn(secret_key, "".join(traceback.format_exception(raised.exception)))

        nested = load_json("operation-request.json")
        nested["configuration"][secret_key] = "private"
        with self.assertRaises(ValueError) as raised:
            OperationSubmitRequest.from_wire(nested)
        self.assertEqual(str(raised.exception), "Invalid transactional operation wire payload.")
        self.assertNotIn(secret_key, str(raised.exception))
        self.assertNotIn(secret_key, repr(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertNotIn(secret_key, "".join(traceback.format_exception(raised.exception)))

        decision = load_json("operation-recovery-decision.json")
        decision[secret_key] = "private"
        with self.assertRaises(ValueError) as raised:
            validate_recovery_payload(decision)
        self.assertEqual(str(raised.exception), "Invalid transactional operation wire payload.")
        self.assertNotIn(secret_key, str(raised.exception))
        self.assertNotIn(secret_key, repr(raised.exception))
        self.assertIsNone(raised.exception.__cause__)
        self.assertNotIn(secret_key, "".join(traceback.format_exception(raised.exception)))

        nested = load_json("operation-collect-request.json")
        nested["handle"]["unexpected"] = True
        with self.assertRaises(ValueError):
            OperationCollectRequest.from_wire(nested)

        state = load_json("operation-state.json")
        state["actions"][next(iter(state["actions"]))]["unexpected"] = True
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

        state = load_json("operation-state.json")
        state["ownershipBaseline"]["baseline"]["target"]["provider"]["unexpected"] = True
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

        state = load_json("operation-state.json")
        state["ownershipBaseline"]["actionId"] = "44444444-4444-4444-8444-444444444444"
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

        state = load_json("operation-state.json")
        state["ownershipBaseline"]["baseline"]["target"]["canonicalThreadUrl"]["value"] = "https://user:secret@chatgpt.com/c/sanitized"
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

    def test_exact_schema_literals_and_digest_uuid_invariants(self) -> None:
        for model, filename, field in [
            (OperationHandle, "operation-handle.json", "schemaVersion"),
            (OperationReceipt, "operation-receipt.json", "schemaVersion"),
            (OperationBlocker, "operation-blocker.json", "schemaVersion"),
        ]:
            with self.subTest(model=model.__name__):
                payload = load_json(filename)
                payload[field] = "wrong.version"
                with self.assertRaises(ValueError):
                    model.from_wire(payload)

        bad_uuid = load_json("operation-handle.json")
        bad_uuid["operationId"] = "not-an-id"
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(bad_uuid)

        bad_digest = load_json("operation-handle.json")
        bad_digest["requestDigest"] = "sha256:" + "a" * 64
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(bad_digest)

        bad_revision = load_json("operation-handle.json")
        bad_revision["revision"] = 0
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(bad_revision)

    def test_request_only_raw_fields_are_not_present_on_durable_models(self) -> None:
        durable_models = [OperationHandle, OperationArtifactReceipt, OperationReceipt, OperationBlocker, OperationState]
        forbidden = {"prompt", "response", "path", "output_directory", "outputDirectory"}
        for model in durable_models:
            with self.subTest(model=model.__name__):
                self.assertTrue(forbidden.isdisjoint(model.model_fields))
                self.assertTrue(forbidden.isdisjoint(model.model_json_schema().get("properties", {})))

        request = OperationSubmitRequest.from_wire(load_json("operation-request.json"))
        self.assertEqual(request.prompt, "Summarize the attached report.")
        self.assertEqual(request.files[0].path, "/tmp/example.txt")  # type: ignore[index,union-attr]

    def test_capture_policy_and_control_cross_field_guards(self) -> None:
        transfer = load_json("operation-request.json")
        transfer["capture"] = {
            "responseContent": "metadata",
            "artifacts": "transfer",
        }
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(transfer)

        receipt_only = load_json("operation-request.json")
        receipt_only["capture"]["outputDirectory"] = "/tmp/output"
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(receipt_only)

        stop = load_json("operation-control-request.json")
        stop["action"] = "stop"
        with self.assertRaises(ValueError):
            OperationControlRequest.from_wire(stop)

        steer = load_json("operation-control-request.json")
        steer.pop("steerPrompt")
        with self.assertRaises(ValueError):
            OperationControlRequest.from_wire(steer)

        wrong_parent = load_json("operation-control-request.json")
        wrong_parent["parent"]["phase"] = "submitted"
        with self.assertRaises(ValueError):
            OperationControlRequest.from_wire(wrong_parent)

    def test_request_models_use_omission_not_explicit_null_for_optional_fields(self) -> None:
        submit_optional = ("configuration", "files", "capture", "timeoutMs")
        for field in submit_optional:
            with self.subTest(model="submit", field=field):
                payload = load_json("operation-request.json")
                payload[field] = None
                with self.assertRaises(ValueError):
                    OperationSubmitRequest.from_wire(payload)

        configuration = load_json("operation-request.json")["configuration"]
        assert configuration is not None
        for field in ("experience", "model", "modelVersion", "reasoning", "mode", "tools", "additional"):
            with self.subTest(model="configuration", field=field):
                payload = copy.deepcopy(configuration)
                payload[field] = None
                with self.assertRaises(ValueError):
                    OperationConfiguration.from_wire(payload)

        input_file = load_json("operation-request.json")["files"][0]
        input_file["displayName"] = None
        with self.assertRaises(ValueError):
            OperationInputFile.from_wire(input_file)

        for field in ("responseFormat", "outputDirectory"):
            with self.subTest(model="capture", field=field):
                payload: dict[str, Any] = {
                    "responseContent": "metadata",
                    "responseFormat": "markdown",
                    "artifacts": "receipt_only",
                }
                payload[field] = None
                with self.assertRaises(ValueError):
                    OperationCapturePolicy.from_wire(payload)

        handle = load_json("operation-handle.json")
        handle["targetBindingDigest"] = None
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(handle)

        for field in ("wait", "timeoutMs", "pollIntervalMs", "responseContent"):
            with self.subTest(model="collect", field=field):
                payload = {"handle": load_json("operation-handle.json"), field: None}
                with self.assertRaises(ValueError):
                    OperationCollectRequest.from_wire(payload)

        for field in ("steerPrompt", "timeoutMs"):
            with self.subTest(model="control", field=field):
                payload = load_json("operation-control-request.json")
                payload[field] = None
                with self.assertRaises(ValueError):
                    OperationControlRequest.from_wire(payload)

    def test_request_model_alias_duplicates_are_rejected(self) -> None:
        payload = load_json("operation-collect-request.json")
        payload["poll_interval_ms"] = payload["pollIntervalMs"]
        with self.assertRaises(ValueError):
            OperationCollectRequest.from_wire(payload)

        payload = load_json("operation-request.json")
        payload["timeout_ms"] = payload.get("timeoutMs", 2500)
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(payload)

    def test_action_repeat_policy_and_receipt_postconditions_are_strict(self) -> None:
        action = load_json("operation-action.json")
        action["repeatPolicy"] = "reconcile_set_to_value"
        with self.assertRaises(ValueError):
            OperationActionRecord.from_wire(action)

        intent = {
            "actionId": "33333333-3333-4333-8333-333333333333",
            "kind": "send",
            "repeatPolicy": "observe_only_after_intent",
            "requestDigest": "hmac-sha256:" + "a" * 64,
            "targetDigest": "hmac-sha256:" + "b" * 64,
        }
        parsed = OperationActionIntent.from_wire(intent)
        self.assertEqual(parsed.target_digest, intent["targetDigest"])

        satisfied = copy.deepcopy(load_json("operation-action.json"))
        satisfied.pop("evidenceDigest")
        with self.assertRaises(ValueError):
            OperationActionRecord.from_wire(satisfied)

        satisfied_event = {
            "type": "action_receipt",
            "actionId": "33333333-3333-4333-8333-333333333333",
            "outcome": "satisfied",
            "observedAt": "2026-08-16T00:00:02.000Z",
        }
        from codex_chatgpt_control.operation_models import OperationActionReceiptEvent

        with self.assertRaises(ValueError):
            OperationActionReceiptEvent.from_wire(satisfied_event)

    def test_submission_witness_and_target_establishment_are_strict(self) -> None:
        witness = load_json("operation-submission-witness.json")
        parsed = OperationSubmissionWitness.from_wire(witness)
        self.assertEqual(parsed.schema_version, SUBMISSION_WITNESS_SCHEMA)
        self.assertEqual(parsed.action_kind, "send")
        self.assertEqual(parsed.baseline_snapshot_digest, "hmac-sha256:" + "12" * 32)
        self.assertEqual(parsed.to_wire(), witness)

        missing_delta = copy.deepcopy(witness)
        del missing_delta["postSendDeltaDigest"]
        with self.assertRaises(ValueError):
            OperationSubmissionWitness.from_wire(missing_delta)

        missing_baseline_digest = copy.deepcopy(witness)
        del missing_baseline_digest["baselineSnapshotDigest"]
        with self.assertRaises(ValueError):
            OperationSubmissionWitness.from_wire(missing_baseline_digest)

        extra = copy.deepcopy(witness)
        extra["prompt"] = "must never persist"
        with self.assertRaises(ValueError):
            OperationSubmissionWitness.from_wire(extra)

        bad_action = copy.deepcopy(witness)
        bad_action["actionKind"] = "configuration_set"
        with self.assertRaises(ValueError):
            OperationSubmissionWitness.from_wire(bad_action)

        bad_digest = copy.deepcopy(witness)
        bad_digest["targetBindingDigest"] = "sha256:" + "a" * 64
        with self.assertRaises(ValueError):
            OperationSubmissionWitness.from_wire(bad_digest)

        wrong_baseline_digest = copy.deepcopy(load_json("operation-state.json"))
        wrong_baseline_digest["submissionWitness"]["baselineSnapshotDigest"] = "hmac-sha256:" + "9" * 64
        with self.assertRaises(ValueError):
            OperationState.from_wire(wrong_baseline_digest)

        missing_baseline = copy.deepcopy(load_json("operation-state.json"))
        del missing_baseline["ownershipBaseline"]
        del missing_baseline["ownershipBaselines"]
        with self.assertRaises(ValueError):
            OperationState.from_wire(missing_baseline)

        legacy_projection_only = copy.deepcopy(load_json("operation-state.json"))
        del legacy_projection_only["ownershipBaselines"]
        del legacy_projection_only["submissionWitnesses"]
        with self.assertRaisesRegex(ValueError, "Invalid transactional operation wire payload"):
            OperationState.from_wire(legacy_projection_only)

        target_event = load_json("operation-target-established-event.json")
        strict_establishment = OperationTargetEstablishment.from_wire(target_event["event"]["establishment"])
        self.assertEqual(strict_establishment.post_send_delta_digest, "hmac-sha256:" + "d" * 64)
        parsed_event = OperationEventEnvelope.from_wire(target_event)
        self.assertEqual(parsed_event.event.type, "target_established")
        self.assertEqual(parsed_event.event.establishment.post_send_delta_digest, "hmac-sha256:" + "d" * 64)  # type: ignore[union-attr]

        missing_target_delta = copy.deepcopy(target_event)
        del missing_target_delta["event"]["establishment"]["postSendDeltaDigest"]
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(missing_target_delta)

    def test_per_action_submission_witnesses_preserve_send_projection_and_steer_causality(self) -> None:
        state = copy.deepcopy(load_json("operation-state.json"))
        steer_id = "44444444-4444-4444-8444-444444444444"
        steer_action = copy.deepcopy(state["actions"]["33333333-3333-4333-8333-333333333333"])
        steer_action.update({
            "actionId": steer_id,
            "kind": "work_steer",
            "requestDigest": "hmac-sha256:" + "c" * 64,
            "intentRevision": 8,
            "receiptRevision": 9,
            "evidenceDigest": "hmac-sha256:" + "c" * 64,
        })
        state["actions"][steer_id] = steer_action
        state["mutationBoundary"] = "control_may_have_occurred"
        baseline = copy.deepcopy(state["ownershipBaselines"]["33333333-3333-4333-8333-333333333333"])
        baseline["actionId"] = steer_id
        state["ownershipBaselines"][steer_id] = baseline
        steer_witness = copy.deepcopy(state["submissionWitnesses"]["33333333-3333-4333-8333-333333333333"])
        steer_witness.update({
            "actionId": steer_id,
            "actionKind": "work_steer",
            "postSendDeltaDigest": "hmac-sha256:" + "e" * 64,
            "operationUserEvidenceDigest": "hmac-sha256:" + "c" * 64,
            "userTurnId": "user-turn-steer",
        })
        state["submissionWitnesses"][steer_id] = steer_witness

        parsed = OperationState.from_wire(state)
        self.assertEqual(parsed.submission_witness.action_id, "33333333-3333-4333-8333-333333333333")  # type: ignore[union-attr]
        self.assertEqual(parsed.submission_witnesses[steer_id].action_kind, "work_steer")  # type: ignore[index,union-attr]

        mismatched_key = copy.deepcopy(state)
        mismatched_key["submissionWitnesses"]["55555555-5555-4555-8555-555555555555"] = mismatched_key["submissionWitnesses"].pop(steer_id)
        with self.assertRaisesRegex(ValueError, "Invalid transactional operation wire payload"):
            OperationState.from_wire(mismatched_key)

        projection_mismatch = copy.deepcopy(state)
        projection_mismatch["submissionWitness"]["postSendDeltaDigest"] = "hmac-sha256:" + "e" * 64
        with self.assertRaisesRegex(ValueError, "Invalid transactional operation wire payload"):
            OperationState.from_wire(projection_mismatch)

        explicit_null = copy.deepcopy(state)
        explicit_null["submissionWitnesses"] = None
        with self.assertRaises(ValueError):
            OperationState.from_wire(explicit_null)

    def test_ownership_baseline_is_coherent_before_submitted_even_without_a_submission_witness(self) -> None:
        state = copy.deepcopy(load_json("operation-state.json"))
        state.pop("submissionWitness")
        state.pop("submissionWitnesses", None)
        state["phase"] = "send_pending"
        state.pop("receipt")
        OperationState.from_wire(state)

        wrong_operation = copy.deepcopy(state)
        wrong_operation["ownershipBaseline"]["operationId"] = "22222222-2222-4222-8222-222222222222"
        with self.assertRaises(ValueError):
            OperationState.from_wire(wrong_operation)

        wrong_action = copy.deepcopy(state)
        wrong_action["ownershipBaseline"]["actionId"] = "22222222-2222-4222-8222-222222222222"
        with self.assertRaises(ValueError):
            OperationState.from_wire(wrong_action)

        wrong_target = copy.deepcopy(state)
        wrong_target["ownershipBaseline"]["baseline"]["target"]["tab"]["value"] = "different-tab"
        with self.assertRaises(ValueError):
            OperationState.from_wire(wrong_target)

        before_intent = copy.deepcopy(state)
        before_intent["ownershipBaseline"]["observedAt"] = "2026-08-16T00:00:00.000Z"
        with self.assertRaises(ValueError):
            OperationState.from_wire(before_intent)

        uncertain_action = copy.deepcopy(state)
        action = uncertain_action["actions"]["33333333-3333-4333-8333-333333333333"]
        action["outcome"] = "uncertain"
        action["blockerCode"] = "ambiguous_submit"
        action.pop("evidenceDigest")
        with self.assertRaises(ValueError):
            OperationState.from_wire(uncertain_action)

    def test_atomic_action_prepared_is_closed_and_preserves_child_control_digest_role(self) -> None:
        atomic = load_json("operation-action-prepared-event.json")
        parsed = OperationEventEnvelope.from_wire(atomic)
        self.assertEqual(parsed.event.type, "action_prepared")
        self.assertEqual(parsed.event.baseline.request_digest, parsed.event.action.request_digest)  # type: ignore[union-attr]

        work_steer = copy.deepcopy(atomic)
        action = work_steer["event"]["action"]
        action["actionId"] = "44444444-4444-4444-8444-444444444444"
        action["kind"] = "work_steer"
        action["requestDigest"] = "hmac-sha256:" + "c" * 64
        work_steer["event"]["baseline"]["actionId"] = action["actionId"]
        child = OperationEventEnvelope.from_wire(work_steer)
        self.assertEqual(child.event.action.request_digest, "hmac-sha256:" + "c" * 64)  # type: ignore[union-attr]
        self.assertEqual(child.event.baseline.request_digest, "hmac-sha256:" + "a" * 64)  # type: ignore[union-attr]

        for mutation in (
            lambda value: value["event"].update({"rawPrompt": "private"}),
            lambda value: value["event"]["baseline"].update({"nullField": None}),
            lambda value: value["event"]["baseline"].update({"observedAt": "2026-08-16T00:00:02.000Z"}),
            lambda value: value["event"]["baseline"].update({"actionId": "55555555-5555-4555-8555-555555555555"}),
        ):
            hostile = copy.deepcopy(atomic)
            mutation(hostile)
            with self.assertRaises(ValueError):
                OperationEventEnvelope.from_wire(hostile)

    def test_per_action_baseline_map_is_strict_and_cannot_replace_send_projection(self) -> None:
        state = copy.deepcopy(load_json("operation-state.json"))
        state["ownershipBaselines"]["33333333-3333-4333-8333-333333333333"]["targetBindingDigest"] = "hmac-sha256:" + "9" * 64
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

        state = copy.deepcopy(load_json("operation-state.json"))
        state["ownershipBaselines"]["33333333-3333-4333-8333-333333333333"]["prompt"] = "must never persist"
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

    def test_artifact_conditional_receipts_and_strict_enums(self) -> None:
        transferred = load_json("operation-artifact-receipt.json")
        transferred.pop("sha256")
        with self.assertRaises(ValueError):
            OperationArtifactReceipt.from_wire(transferred)

        partial = load_json("operation-artifact-receipt.json")
        partial["status"] = "partial"
        with self.assertRaises(ValueError):
            OperationArtifactReceipt.from_wire(partial)

        receipt = load_json("operation-control-receipt.json")
        receipt["outcome"] = "satisfied"
        receipt.pop("evidenceDigest")
        with self.assertRaises(ValueError):
            OperationControlReceipt.from_wire(receipt)

        blocker_on_success = load_json("operation-artifact-receipt.json")
        blocker_on_success["blockerCode"] = "artifact_unavailable"
        with self.assertRaises(ValueError):
            OperationArtifactReceipt.from_wire(blocker_on_success)

    def test_durable_transfer_events_and_state_round_trip_with_python_aliases(self) -> None:
        intent_event = OperationEventEnvelope.from_wire(load_json("operation-artifact-transfer-intent-event.json"))
        receipt_event = OperationEventEnvelope.from_wire(load_json("operation-artifact-transfer-receipt-event.json"))
        self.assertEqual(intent_event.event.intent.schema_version, ARTIFACT_TRANSFER_INTENT_SCHEMA)  # type: ignore[union-attr]
        self.assertEqual(receipt_event.event.receipt.schema_version, ARTIFACT_TRANSFER_RECEIPT_SCHEMA)  # type: ignore[union-attr]

        state = OperationState.from_wire(load_json("operation-artifact-transfer-state.json"))
        self.assertEqual(len(state.artifact_transfers or {}), 2)
        first = state.artifact_transfers["66666666-6666-4666-8666-666666666666"]  # type: ignore[index,union-attr]
        self.assertEqual(first.intent.transfer_action_id, "66666666-6666-4666-8666-666666666666")
        self.assertEqual(first.intent.kind, "file")
        self.assertIsNone(first.receipt)
        self.assertEqual(state.actions[first.intent.transfer_action_id].kind, "local_output_commit")

        self.assertEqual(
            state.to_wire(),
            load_json("operation-artifact-transfer-state.json"),
        )

    def test_durable_transfer_receipts_are_closed_and_status_invariants_are_strict(self) -> None:
        transferred = load_json("operation-artifact-transfer-receipt-event.json")
        transferred["event"]["receipt"].pop("sha256")
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(transferred)

        partial = load_json("operation-artifact-transfer-receipt-event.json")
        partial["event"]["receipt"]["status"] = "partial"
        partial["event"]["receipt"].pop("outputKey", None)
        partial["event"]["receipt"].pop("bytes", None)
        partial["event"]["receipt"].pop("sha256", None)
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(partial)

        null_optional = load_json("operation-artifact-transfer-receipt-event.json")
        null_optional["event"]["receipt"]["blockerCode"] = None
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(null_optional)

        private = load_json("operation-artifact-transfer-intent-event.json")
        private["event"]["intent"]["outputDirectory"] = "/private/secret"
        with self.assertRaises(ValueError):
            OperationEventEnvelope.from_wire(private)

        self.assertNotIn("outputDirectory", json.dumps(load_json("operation-artifact-transfer-state.json")))
        for model in (ArtifactTransferIntent, ArtifactTransferReceipt):
            with self.subTest(model=model.__name__):
                self.assertTrue({"prompt", "response", "path", "outputDirectory"}.isdisjoint(model.model_fields))

    def test_durable_transfer_state_rejects_receipt_without_intent_duplicate_tuple_and_action_drift(self) -> None:
        missing_intent = copy.deepcopy(load_json("operation-artifact-transfer-state.json"))
        transfer = missing_intent["artifactTransfers"]["66666666-6666-4666-8666-666666666666"]
        transfer.pop("intent")
        transfer["receipt"] = load_json("operation-artifact-transfer-receipt-event.json")["event"]["receipt"]
        with self.assertRaises(ValueError):
            OperationState.from_wire(missing_intent)

        duplicate = copy.deepcopy(load_json("operation-artifact-transfer-state.json"))
        source_id = "66666666-6666-4666-8666-666666666666"
        duplicate_id = "88888888-8888-4888-8888-888888888888"
        duplicate["revision"] = 7
        duplicate["actions"][duplicate_id] = copy.deepcopy(duplicate["actions"][source_id])
        duplicate["actions"][duplicate_id]["actionId"] = duplicate_id
        duplicate["actions"][duplicate_id]["intentRevision"] = 7
        duplicate["artifactTransfers"][duplicate_id] = copy.deepcopy(duplicate["artifactTransfers"][source_id])
        duplicate["artifactTransfers"][duplicate_id]["intent"]["transferActionId"] = duplicate_id
        with self.assertRaises(ValueError):
            OperationState.from_wire(duplicate)

        drifted = copy.deepcopy(load_json("operation-artifact-transfer-state.json"))
        drifted["actions"][source_id]["kind"] = "download"
        with self.assertRaises(ValueError):
            OperationState.from_wire(drifted)

        wrong_request = copy.deepcopy(load_json("operation-artifact-transfer-state.json"))
        wrong_request["artifactTransfers"][source_id]["intent"]["requestDigest"] = "hmac-sha256:" + "9" * 64
        with self.assertRaises(ValueError):
            OperationState.from_wire(wrong_request)

    def test_terminal_capture_policy_reconciles_transfer_obligations(self) -> None:
        zero_artifact_transfer = copy.deepcopy(load_json("operation-state.json"))
        zero_artifact_transfer["capturePolicy"]["artifacts"] = "transfer"
        parsed_zero = OperationState.from_wire(zero_artifact_transfer)
        self.assertEqual(parsed_zero.capture_policy.artifacts, "transfer")  # type: ignore[union-attr]

        transfer_state = copy.deepcopy(load_json("operation-artifact-transfer-state.json"))
        transfer_id = "66666666-6666-4666-8666-666666666666"
        transfer_state["artifactTransfers"] = {
            transfer_id: copy.deepcopy(transfer_state["artifactTransfers"][transfer_id])
        }
        transfer_receipt = load_json("operation-artifact-transfer-receipt-event.json")["event"]["receipt"]
        transfer_state["artifactTransfers"][transfer_id]["receipt"] = transfer_receipt
        transfer_action = transfer_state["actions"][transfer_id]
        transfer_action.update({
            "outcome": "satisfied",
            "receiptRevision": 7,
            "receiptAt": "2026-08-16T00:00:04.000Z",
            "evidenceDigest": transfer_receipt["destinationIdentityDigest"],
        })
        transfer_state["phase"] = "completed"
        transfer_state["revision"] = 7
        transfer_state["updatedAt"] = "2026-08-16T00:00:06.000Z"
        transfer_state["receipt"] = {
            "schemaVersion": RECEIPT_SCHEMA,
            "operationId": transfer_state["operationId"],
            "requestDigest": transfer_state["requestDigest"],
            "targetBindingDigest": transfer_state["actions"]["33333333-3333-4333-8333-333333333333"]["targetDigest"],
            "userTurnId": "user-turn-1",
            "userTurnEvidenceDigest": "hmac-sha256:" + "c" * 64,
            "assistantTurnId": transfer_receipt["assistantTurnId"],
            "ownershipEvidenceDigest": "hmac-sha256:" + "e" * 64,
            "responseDigest": "hmac-sha256:" + "f" * 64,
            "responseBytes": 12,
            "responseFormat": "markdown",
            "finishReason": "stop",
            "contentAvailable": False,
            "artifacts": [{
                "schemaVersion": ARTIFACT_SCHEMA,
                "operationId": transfer_receipt["operationId"],
                "artifactKey": "artifact-0",
                "assistantTurnId": transfer_receipt["assistantTurnId"],
                "sourceIdentityDigest": transfer_receipt["sourceIdentityDigest"],
                "kind": transfer_receipt["kind"],
                "ordinal": transfer_receipt["ordinal"],
                "outputKey": transfer_receipt["outputKey"],
                "bytes": transfer_receipt["bytes"],
                "sha256": transfer_receipt["sha256"],
                "status": "transferred",
            }],
            "completedAt": "2026-08-16T00:00:05.000Z",
        }
        parsed_transfer = OperationState.from_wire(transfer_state)
        self.assertEqual(parsed_transfer.receipt.artifacts[0].status, "transferred")  # type: ignore[union-attr]

        missing_terminal_witness = copy.deepcopy(transfer_state)
        missing_terminal_witness["receipt"]["artifacts"] = []
        with self.assertRaises(ValueError):
            OperationState.from_wire(missing_terminal_witness)

        receipt_only_misuse = copy.deepcopy(transfer_state)
        receipt_only_misuse["capturePolicy"]["artifacts"] = "receipt_only"
        with self.assertRaises(ValueError):
            OperationState.from_wire(receipt_only_misuse)

        altered_rich_facts = copy.deepcopy(transfer_state)
        altered_rich_facts["receipt"]["artifacts"][0]["bytes"] += 1
        with self.assertRaises(ValueError):
            OperationState.from_wire(altered_rich_facts)

    def test_work_steer_cannot_replace_the_original_send_causality(self) -> None:
        steer_only = copy.deepcopy(load_json("operation-state.json"))
        action = next(iter(steer_only["actions"].values()))
        action["kind"] = "work_steer"
        steer_only["mutationBoundary"] = "control_may_have_occurred"
        steer_only.pop("submissionWitness", None)
        steer_only.pop("submissionWitnesses", None)
        steer_only.pop("ownershipBaseline", None)
        steer_only.pop("ownershipBaselines", None)

        with self.assertRaisesRegex(ValueError, "Invalid transactional operation wire payload"):
            OperationState.from_wire(steer_only)

    def test_direct_wire_decoder_rejects_hostile_or_private_payloads_without_echoing(self) -> None:
        secret = "PRIVATE PROMPT VALUE"

        class HostileDict(dict[str, Any]):
            def items(self) -> Any:
                raise RuntimeError(secret)

            def __iter__(self) -> Any:
                raise RuntimeError(secret)

        hostile = HostileDict(load_json("operation-request.json"))
        with self.assertRaises(ValueError) as raised:
            OperationSubmitRequest.from_wire(hostile)
        self.assertEqual(str(raised.exception), "Invalid transactional operation wire payload.")
        self.assertNotIn(secret, str(raised.exception))

        oversized = load_json("operation-request.json")
        oversized["prompt"] = secret + ("x" * MAX_PROMPT_BYTES)
        with self.assertRaises(ValueError) as raised:
            OperationSubmitRequest.from_wire(oversized)
        self.assertEqual(str(raised.exception), "Invalid transactional operation wire payload.")
        self.assertNotIn(secret, str(raised.exception))

    def test_receipt_metadata_bounds_and_identity_pairing(self) -> None:
        receipt = load_json("operation-receipt.json")
        receipt["contentAvailable"] = True
        receipt["responseDigest"] = "hmac-sha256:" + "a" * 64
        receipt.pop("responseBytes")
        with self.assertRaises(ValueError):
            OperationReceipt.from_wire(receipt)

        artifact = load_json("operation-artifact-receipt.json")
        receipt["responseBytes"] = 12
        receipt["artifacts"] = [artifact, copy.deepcopy(artifact)]
        with self.assertRaises(ValueError):
            OperationReceipt.from_wire(receipt)

        too_many = load_json("operation-receipt.json")
        too_many["artifacts"] = [
            {
                **artifact,
                "artifactKey": f"artifact-{index}",
                "ordinal": index,
            }
            for index in range(33)
        ]
        with self.assertRaises(ValueError):
            OperationReceipt.from_wire(too_many)

    def test_request_json_url_and_file_inputs_are_bounded(self) -> None:
        request = load_json("operation-request.json")
        request["target"] = {"type": "url", "url": "https://user:secret@chatgpt.com/c/example"}
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        request = load_json("operation-request.json")
        request["configuration"]["additional"] = {"temperature": float("nan")}
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        request = load_json("operation-request.json")
        request["files"] = [{"path": f"/tmp/{index}"} for index in range(257)]
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

    def test_prompt_and_steer_prompt_accept_exact_utf8_byte_boundary(self) -> None:
        request = load_json("operation-request.json")
        request["prompt"] = "a" * MAX_PROMPT_BYTES
        parsed_request = OperationSubmitRequest.from_wire(request)
        self.assertEqual(len(parsed_request.prompt.encode("utf-8")), MAX_PROMPT_BYTES)

        control = load_json("operation-control-request.json")
        control["steerPrompt"] = "a" * MAX_PROMPT_BYTES
        parsed_control = OperationControlRequest.from_wire(control)
        self.assertEqual(len(parsed_control.steer_prompt.encode("utf-8")), MAX_PROMPT_BYTES)  # type: ignore[union-attr]

    def test_prompt_and_steer_prompt_reject_one_byte_over_limit(self) -> None:
        request = load_json("operation-request.json")
        request["prompt"] = "a" * (MAX_PROMPT_BYTES + 1)
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        control = load_json("operation-control-request.json")
        control["steerPrompt"] = "a" * (MAX_PROMPT_BYTES + 1)
        with self.assertRaises(ValueError):
            OperationControlRequest.from_wire(control)

    def test_multibyte_prompt_limits_use_utf8_bytes_not_character_count(self) -> None:
        # U+1F642 is four UTF-8 bytes. The over-limit value still has fewer
        # characters than the byte cap, so a character-count check would miss it.
        multibyte = "🙂" * (MAX_PROMPT_BYTES // 4 + 1)
        self.assertLess(len(multibyte), MAX_PROMPT_BYTES)
        self.assertGreater(len(multibyte.encode("utf-8")), MAX_PROMPT_BYTES)

        request = load_json("operation-request.json")
        request["prompt"] = multibyte
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        control = load_json("operation-control-request.json")
        control["steerPrompt"] = multibyte
        with self.assertRaises(ValueError):
            OperationControlRequest.from_wire(control)

    def test_other_bounded_text_and_additional_json_use_utf8_byte_limits(self) -> None:
        request = load_json("operation-request.json")
        request["files"] = [{"path": "🙂" * 1025}]
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        request = load_json("operation-request.json")
        request["configuration"]["model"] = "🙂" * 65
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        request = load_json("operation-request.json")
        request["configuration"]["additional"] = {"value": "x" * (MAX_JSON_UTF8_BYTES + 1)}
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

        request = load_json("operation-request.json")
        request["prompt"] = "\ud800"
        with self.assertRaises(ValueError):
            OperationSubmitRequest.from_wire(request)

    def test_real_instants_and_materialized_state_coherence_are_validated(self) -> None:
        action = load_json("operation-action.json")
        action["intentAt"] = "2026-02-31T00:00:00.000Z"
        with self.assertRaises(ValueError):
            OperationActionRecord.from_wire(action)

        state = load_json("operation-state.json")
        state["mutationBoundary"] = "none"
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

    def test_target_provider_scope_requires_claim_and_profile(self) -> None:
        state = load_json("operation-state.json")
        target = state["target"]
        target["coordinationScope"] = "provider"
        target["evidenceProfile"]["authoritativeTabClaim"] = "unavailable"
        with self.assertRaises(ValueError):
            OperationState.from_wire(state)

        target = copy.deepcopy(load_json("operation-state.json"))["target"]
        target.pop("tabClaimEvidenceDigest", None)
        target["coordinationScope"] = "provider"
        with self.assertRaises(ValueError):
            from codex_chatgpt_control.operation_models import OperationTarget

            OperationTarget.from_wire(target)

    def test_strict_model_rejects_coercion(self) -> None:
        payload = load_json("operation-handle.json")
        payload["revision"] = "3"
        with self.assertRaises(ValueError):
            OperationHandle.from_wire(payload)

        payload = load_json("operation-collect-request.json")
        payload["wait"] = 1
        with self.assertRaises(ValueError):
            OperationCollectRequest.from_wire(payload)

        for value in (True, 1.5, -1, 60_001, None):
            payload = load_json("operation-collect-request.json")
            payload["pollIntervalMs"] = value
            with self.subTest(poll_interval_ms=value):
                with self.assertRaises(ValueError):
                    OperationCollectRequest.from_wire(payload)

    def test_constants_match_contract_literals(self) -> None:
        self.assertEqual(load_json("operation-artifact-receipt.json")["schemaVersion"], ARTIFACT_SCHEMA)
        self.assertEqual(load_json("operation-blocker.json")["schemaVersion"], BLOCKER_SCHEMA)
        self.assertEqual(load_json("operation-collect-request.json")["schemaVersion"], COLLECT_SCHEMA)
        self.assertEqual(load_json("operation-control-receipt.json")["schemaVersion"], CONTROL_RECEIPT_SCHEMA)
        self.assertEqual(load_json("operation-control-request.json")["schemaVersion"], CONTROL_REQUEST_SCHEMA)
        self.assertEqual(load_json("operation-event.json")["schemaVersion"], EVENT_SCHEMA)
        self.assertEqual(load_json("operation-handle.json")["schemaVersion"], HANDLE_SCHEMA)
        self.assertEqual(load_json("operation-inspect-request.json")["schemaVersion"], INSPECT_SCHEMA)
        self.assertEqual(load_json("operation-receipt.json")["schemaVersion"], RECEIPT_SCHEMA)
        self.assertEqual(load_json("operation-request.json")["schemaVersion"], REQUEST_SCHEMA)
        self.assertEqual(load_json("operation-state.json")["schemaVersion"], TURN_SCHEMA)


if __name__ == "__main__":
    unittest.main()
