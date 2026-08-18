import copy
import json
import unittest
from pathlib import Path
from typing import Any

from codex_chatgpt_control.operation_models import OperationState


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "node" / "contracts" / "v1" / "fixtures"
SEND_ACTION_ID = "33333333-3333-4333-8333-333333333333"
WORK_ACTION_ID = "44444444-4444-4444-8444-444444444444"


def operation_state_fixture() -> dict[str, Any]:
    return json.loads((FIXTURES / "operation-state.json").read_text(encoding="utf-8"))


def work_state(*, outcome: str = "not_satisfied", include_projection: bool = True) -> dict[str, Any]:
    """Create a completed state with a second, independently keyed Work action."""

    state = copy.deepcopy(operation_state_fixture())
    work_action = copy.deepcopy(state["actions"][SEND_ACTION_ID])
    work_action.update(
        {
            "actionId": WORK_ACTION_ID,
            "kind": "work_steer",
            "requestDigest": "hmac-sha256:" + "c" * 64,
            "intentRevision": 8,
            "intentAt": "2026-08-16T00:00:04.000Z",
            "outcome": outcome,
            "receiptRevision": 9,
            "receiptAt": "2026-08-16T00:00:05.000Z",
            "blockerCode": "operation_timeout" if outcome != "satisfied" else None,
        }
    )
    if outcome == "satisfied":
        work_action["evidenceDigest"] = "hmac-sha256:" + "c" * 64
        work_action.pop("blockerCode", None)
    else:
        work_action.pop("evidenceDigest", None)
    state["actions"][WORK_ACTION_ID] = work_action
    state["mutationBoundary"] = "control_may_have_occurred"
    state["updatedAt"] = "2026-08-16T00:00:05.000Z"

    work_baseline = copy.deepcopy(state["ownershipBaselines"][SEND_ACTION_ID])
    work_baseline["actionId"] = WORK_ACTION_ID
    work_baseline["observedAt"] = "2026-08-16T00:00:04.000Z"
    work_baseline["baseline"]["target"]["canonicalThreadUrl"] = {
        "status": "unavailable",
        "reason": "redacted",
    }
    state["ownershipBaselines"][WORK_ACTION_ID] = work_baseline
    if not include_projection:
        state.pop("ownershipBaselines")
        state.pop("submissionWitnesses", None)
        state.pop("submissionWitness", None)
        state["ownershipBaseline"] = work_baseline
    return state


def work_witness() -> dict[str, Any]:
    witness = copy.deepcopy(operation_state_fixture()["submissionWitnesses"][SEND_ACTION_ID])
    witness.update(
        {
            "actionId": WORK_ACTION_ID,
            "actionKind": "work_steer",
            "postSendDeltaDigest": "hmac-sha256:" + "e" * 64,
            "operationUserEvidenceDigest": "hmac-sha256:" + "c" * 64,
            "userTurnId": "user-turn-work",
            "observedAt": "2026-08-16T00:00:05.000Z",
        }
    )
    return witness


class OperationStateParityTests(unittest.TestCase):
    def test_redacted_url_is_accepted_only_for_work_and_only_with_matching_identities(self) -> None:
        accepted = work_state()
        OperationState.from_wire(accepted)

        send_redacted = operation_state_fixture()
        send_redacted["ownershipBaseline"]["baseline"]["target"]["canonicalThreadUrl"] = {
            "status": "unavailable",
            "reason": "redacted",
        }
        send_redacted["ownershipBaselines"][SEND_ACTION_ID]["baseline"]["target"]["canonicalThreadUrl"] = copy.deepcopy(
            send_redacted["ownershipBaseline"]["baseline"]["target"]["canonicalThreadUrl"]
        )
        with self.assertRaises(ValueError):
            OperationState.from_wire(send_redacted)

        for field, value in {
            "provider": "different-provider",
            "browser": "different-browser",
            "tab": "different-tab",
            "conversation": "different-conversation",
        }.items():
            with self.subTest(field=field):
                mismatched = work_state()
                mismatched["ownershipBaselines"][WORK_ACTION_ID]["baseline"]["target"][field]["value"] = value
                with self.assertRaises(ValueError):
                    OperationState.from_wire(mismatched)

        mismatched_scope = work_state()
        mismatched_scope["ownershipBaselines"][WORK_ACTION_ID]["baseline"]["target"]["coordinationScope"] = "provider"
        with self.assertRaises(ValueError):
            OperationState.from_wire(mismatched_scope)

    def test_work_baseline_may_follow_clean_rejection_but_advanced_legacy_projection_fails_closed(self) -> None:
        # Keyed state retains both the original Send projection and the Work
        # baseline, but deliberately has no Work witness.
        keyed = work_state()
        OperationState.from_wire(keyed)

        # A singular compatibility projection cannot prove the original Send
        # for an advanced/completed state. The operation schema was introduced
        # by this migration, so there is no truthful legacy migration path that
        # can synthesize the missing keyed baseline and submission witness.
        singular = work_state(include_projection=False)
        with self.assertRaises(ValueError):
            OperationState.from_wire(singular)

    def test_uncertain_work_and_non_satisfied_send_baselines_are_rejected(self) -> None:
        for include_projection in (True, False):
            with self.subTest(action="work_steer", include_projection=include_projection):
                uncertain_work = work_state(outcome="uncertain", include_projection=include_projection)
                with self.assertRaises(ValueError):
                    OperationState.from_wire(uncertain_work)

            with self.subTest(action="send", include_projection=include_projection):
                rejected_send = operation_state_fixture()
                action = rejected_send["actions"][SEND_ACTION_ID]
                action.update(
                    {
                        "outcome": "not_satisfied",
                        "receiptRevision": 7,
                        "receiptAt": "2026-08-16T00:00:02.000Z",
                        "blockerCode": "operation_timeout",
                    }
                )
                action.pop("evidenceDigest", None)
                rejected_send["phase"] = "ready"
                rejected_send["mutationBoundary"] = "send_may_have_occurred"
                rejected_send.pop("receipt", None)
                rejected_send.pop("submissionWitness", None)
                rejected_send.pop("submissionWitnesses", None)
                if include_projection:
                    rejected_send["ownershipBaselines"] = {
                        SEND_ACTION_ID: copy.deepcopy(rejected_send["ownershipBaseline"])
                    }
                else:
                    rejected_send.pop("ownershipBaselines", None)
                with self.assertRaises(ValueError):
                    OperationState.from_wire(rejected_send)

    def test_witness_requires_satisfied_action_and_exact_keyed_baseline(self) -> None:
        unsatisfied = work_state()
        unsatisfied["submissionWitnesses"][WORK_ACTION_ID] = work_witness()
        with self.assertRaises(ValueError):
            OperationState.from_wire(unsatisfied)

        satisfied = work_state(outcome="satisfied")
        satisfied["submissionWitnesses"][WORK_ACTION_ID] = work_witness()
        OperationState.from_wire(satisfied)

        missing_keyed_baseline = work_state(outcome="satisfied")
        del missing_keyed_baseline["ownershipBaselines"][WORK_ACTION_ID]
        missing_keyed_baseline["submissionWitnesses"][WORK_ACTION_ID] = work_witness()
        with self.assertRaises(ValueError):
            OperationState.from_wire(missing_keyed_baseline)

        projection_conflict = work_state()
        projection_conflict["ownershipBaseline"]["baseline"]["target"]["tab"]["value"] = "different-tab"
        with self.assertRaises(ValueError):
            OperationState.from_wire(projection_conflict)


if __name__ == "__main__":
    unittest.main()
