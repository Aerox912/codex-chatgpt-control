import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  validateOperationCollectWireResult,
  validateOperationControlWireResult,
  validateOperationInspectWireResult,
  validateOperationSubmitWireResult
} from "../../src/operations/wire-results.js";

const CONTRACT_ROOT = fileURLToPath(new URL("../../contracts/v1/", import.meta.url));
const manifest = readJson("manifest.json") as {
  contractVersion: string;
  schemas: Record<string, string>;
  fixtures: Array<{ file: string; schema: string }>;
};

const OPERATION_SCHEMAS = new Set([
  "operationAction",
  "operationArtifactReceipt",
  "operationBlocker",
  "operationCollectRequest",
  "operationControlReceipt",
  "operationControlRequest",
  "operationEvent",
  "operationHandle",
  "operationInspectRequest",
  "operationReceipt",
  "operationRecovery",
  "operationRequest",
  "operationState",
  "operationSubmissionWitness",
  "operationSubmitResult",
  "operationCollectResult",
  "operationInspectResult",
  "operationControlResult"
]);
const MAX_OPERATION_TEXT_LENGTH = 8 * 1024 * 1024;
const INSTANT_SCHEMAS = [
  "operationAction",
  "operationControlReceipt",
  "operationEvent",
  "operationRecovery",
  "operationReceipt",
  "operationState",
  "operationSubmitResult",
  "operationCollectResult",
  "operationInspectResult",
  "operationControlResult"
] as const;

describe("transactional operation contracts", () => {
  it("strictly compiles every operation schema and accepts every registered fixture", () => {
    expect(manifest.contractVersion).toBe("0.2.0");
    const fixtures = manifest.fixtures.filter(fixture => OPERATION_SCHEMAS.has(fixture.schema));
    expect(fixtures).toHaveLength(26);

    for (const fixture of fixtures) {
      const validate = validator(fixture.schema);
      const value = readJson(join("fixtures", fixture.file));
      expect(validate(value), `${fixture.file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("pins the child/parent digest roles of the control result envelope", () => {
    const value = readJson(join("fixtures", "operation-control-result.json")) as Record<string, unknown>;
    const handle = value.handle as Record<string, unknown>;
    const blocker = value.blocker as Record<string, unknown>;

    // JSON Schema cannot express equality between sibling properties. Keep the
    // cross-field invariant executable at the contract boundary instead:
    // requestDigest identifies the child control request, while the reloaded
    // handle and blocker remain bound to the parent operation request.
    expect(value.requestDigest).not.toBe(value.parentRequestDigest);
    expect(value.requestDigest).not.toBe(handle.requestDigest);
    expect(handle.requestDigest).toBe(value.parentRequestDigest);
    expect(blocker.requestDigest).toBe(value.parentRequestDigest);
  });

  it("keeps shared result fixtures valid at both the JSON Schema and runtime boundaries", () => {
    expect(() => validateOperationSubmitWireResult(readJson(join("fixtures", "operation-submit-result.json")))).not.toThrow();
    expect(() => validateOperationCollectWireResult(readJson(join("fixtures", "operation-collect-result.json")))).not.toThrow();
    expect(() => validateOperationInspectWireResult(readJson(join("fixtures", "operation-inspect-result.json")))).not.toThrow();
    expect(() => validateOperationControlWireResult(readJson(join("fixtures", "operation-control-result.json")))).not.toThrow();
  });

  it.each(INSTANT_SCHEMAS)("rejects non-real canonical instants in %s", schemaName => {
    const schemaPath = manifest.schemas[schemaName];
    expect(schemaPath, `${schemaName} must be registered in the contract manifest`).toBeDefined();
    if (schemaPath === undefined) throw new Error(`Missing contract schema: ${schemaName}`);
    const schema = readJson(schemaPath) as { $defs?: Record<string, unknown> };
    const instant = schema.$defs?.instant;
    expect(instant, `${schemaName} must define an instant shape`).toBeDefined();
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(instant as AnySchema);

    expect(validate("2026-00-01T00:00:00.000Z")).toBe(false);
    expect(validate("2026-02-30T00:00:00.000Z")).toBe(false);
    expect(validate("2026-04-31T00:00:00.000Z")).toBe(false);
    expect(validate("2026-01-01T24:00:00.000Z")).toBe(false);
    expect(validate("2026-01-01T00:00:00Z")).toBe(false);
  });

  it("declares response digest/byte pairing in every durable receipt shape", () => {
    const receiptBearingSchemas = [
      "operationCollectResult",
      "operationEvent",
      "operationInspectResult",
      "operationReceipt",
      "operationRecovery",
      "operationState",
      "operationSubmitResult"
    ];

    for (const schemaName of receiptBearingSchemas) {
      const schemaPath = manifest.schemas[schemaName];
      expect(schemaPath, `${schemaName} must be registered in the contract manifest`).toBeDefined();
      if (schemaPath === undefined) throw new Error(`Missing contract schema: ${schemaName}`);
      const schema = readJson(schemaPath);
      const receipts = findResponseShapes(schema);
      expect(receipts.length, `${schemaName} should define at least one receipt shape`).toBeGreaterThan(0);
      for (const receipt of receipts) {
        expect(receipt.dependentRequired).toEqual({
          responseDigest: ["responseBytes"],
          responseBytes: ["responseDigest"]
        });
      }
    }
  });

  it.each([
    {
      label: "raw prompt in durable state",
      schema: "operationState",
      fixture: "operation-state.json",
      mutate: (value: Record<string, unknown>) => { value.rawPrompt = "must never persist"; }
    },
    {
      label: "request-local output path in durable capture policy",
      schema: "operationState",
      fixture: "operation-state.json",
      mutate: (value: Record<string, unknown>) => {
        (value.capturePolicy as Record<string, unknown>).outputDirectory = "/private/output";
      }
    },
    {
      label: "null durable capture policy",
      schema: "operationEvent",
      fixture: "operation-event.json",
      mutate: (value: Record<string, unknown>) => {
        (value.event as Record<string, unknown>).capturePolicy = null;
      }
    },
    {
      label: "raw response in a terminal receipt",
      schema: "operationReceipt",
      fixture: "operation-receipt.json",
      mutate: (value: Record<string, unknown>) => { value.rawResponse = "must never persist"; }
    },
    {
      label: "legacy ambiguous power action",
      schema: "operationAction",
      fixture: "operation-action.json",
      mutate: (value: Record<string, unknown>) => { value.kind = "power_probe"; }
    },
    {
      label: "mismatched repeat policy",
      schema: "operationAction",
      fixture: "operation-action.json",
      mutate: (value: Record<string, unknown>) => { value.repeatPolicy = "read_only"; }
    },
    {
      label: "non-status action without target binding",
      schema: "operationAction",
      fixture: "operation-action.json",
      mutate: (value: Record<string, unknown>) => { delete value.targetDigest; }
    },
    {
      label: "stop carrying a steer prompt",
      schema: "operationControlRequest",
      fixture: "operation-control-request.json",
      mutate: (value: Record<string, unknown>) => {
        value.action = "stop";
        value.steerPrompt = "must be absent";
      }
    },
    {
      label: "control parent without exact generating target",
      schema: "operationControlRequest",
      fixture: "operation-control-request.json",
      mutate: (value: Record<string, unknown>) => {
        const parent = value.parent as Record<string, unknown>;
        parent.phase = "submitted";
        delete parent.targetBindingDigest;
      }
    },
    {
      label: "artifact without versioned source identity",
      schema: "operationArtifactReceipt",
      fixture: "operation-artifact-receipt.json",
      mutate: (value: Record<string, unknown>) => {
        delete value.schemaVersion;
        delete value.sourceIdentityDigest;
      }
    },
    {
      label: "provider coordination without a claim",
      schema: "operationState",
      fixture: "operation-state.json",
      mutate: (value: Record<string, unknown>) => {
        const target = value.target as Record<string, unknown>;
        target.coordinationScope = "provider";
      }
    },
    {
      label: "transfer capture without output directory",
      schema: "operationRequest",
      fixture: "operation-request.json",
      mutate: (value: Record<string, unknown>) => {
        (value.capture as Record<string, unknown>).artifacts = "transfer";
      }
    },
    {
      label: "receipt-only capture with output directory",
      schema: "operationRequest",
      fixture: "operation-request.json",
      mutate: (value: Record<string, unknown>) => {
        (value.capture as Record<string, unknown>).outputDirectory = "/tmp/not-allowed";
      }
    },
    {
      label: "unversioned recovery decision",
      schema: "operationRecovery",
      fixture: "operation-recovery-decision.json",
      mutate: (value: Record<string, unknown>) => { delete value.schemaVersion; }
    },
    {
      label: "submit pending status",
      schema: "operationSubmitResult",
      fixture: "operation-submit-result.json",
      mutate: (value: Record<string, unknown>) => { value.status = "pending"; }
    },
    {
      label: "collect accepted status",
      schema: "operationCollectResult",
      fixture: "operation-collect-result.json",
      mutate: (value: Record<string, unknown>) => { value.status = "accepted"; }
    },
    {
      label: "control accepted status",
      schema: "operationControlResult",
      fixture: "operation-control-result.json",
      mutate: (value: Record<string, unknown>) => { value.status = "accepted"; }
    },
    {
      label: "control pending status",
      schema: "operationControlResult",
      fixture: "operation-control-result.json",
      mutate: (value: Record<string, unknown>) => { value.status = "pending"; }
    },
    {
      label: "accepted submit carrying a receipt",
      schema: "operationSubmitResult",
      fixture: "operation-submit-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.receipt = readJson(join("fixtures", "operation-receipt.json"));
      }
    },
    {
      label: "accepted submit carrying a blocker",
      schema: "operationSubmitResult",
      fixture: "operation-submit-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.blocker = (readJson(join("fixtures", "operation-control-result.json")) as Record<string, unknown>).blocker;
      }
    },
    {
      label: "completed submit carrying a blocker",
      schema: "operationSubmitResult",
      fixture: "operation-submit-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.status = "completed";
        value.receipt = readJson(join("fixtures", "operation-receipt.json"));
        value.blocker = (readJson(join("fixtures", "operation-control-result.json")) as Record<string, unknown>).blocker;
      }
    },
    {
      label: "pending collect carrying a live response",
      schema: "operationCollectResult",
      fixture: "operation-collect-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.status = "pending";
      }
    },
    {
      label: "blocked collect carrying a receipt or live response",
      schema: "operationCollectResult",
      fixture: "operation-collect-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.status = "blocked";
        value.blocker = (readJson(join("fixtures", "operation-control-result.json")) as Record<string, unknown>).blocker;
      }
    },
    {
      label: "completed control carrying a blocker",
      schema: "operationControlResult",
      fixture: "operation-control-result.json",
      mutate: (value: Record<string, unknown>) => {
        value.status = "completed";
        value.receipt = readJson(join("fixtures", "operation-control-receipt.json"));
      }
    },
    {
      label: "operation prompt over the bounded limit",
      schema: "operationRequest",
      fixture: "operation-request.json",
      mutate: (value: Record<string, unknown>) => {
        value.prompt = "x".repeat(MAX_OPERATION_TEXT_LENGTH + 1);
      }
    },
    {
      label: "steer prompt over the bounded limit",
      schema: "operationControlRequest",
      fixture: "operation-control-request.json",
      mutate: (value: Record<string, unknown>) => {
        value.steerPrompt = "x".repeat(MAX_OPERATION_TEXT_LENGTH + 1);
      }
    },
    {
      label: "receipt with response digest but no byte count",
      schema: "operationReceipt",
      fixture: "operation-receipt.json",
      mutate: (value: Record<string, unknown>) => { delete value.responseBytes; }
    },
    {
      label: "receipt with response byte count but no digest",
      schema: "operationReceipt",
      fixture: "operation-receipt.json",
      mutate: (value: Record<string, unknown>) => { delete value.responseDigest; }
    },
    {
      label: "collect live response over the bounded limit",
      schema: "operationCollectResult",
      fixture: "operation-collect-result.json",
      mutate: (value: Record<string, unknown>) => {
        const liveResponse = value.liveResponse as Record<string, unknown>;
        liveResponse.content = "x".repeat(MAX_OPERATION_TEXT_LENGTH + 1);
      }
    },
    {
      label: "receipt with an impossible month",
      schema: "operationReceipt",
      fixture: "operation-receipt.json",
      mutate: (value: Record<string, unknown>) => { value.completedAt = "2026-13-01T00:00:00.000Z"; }
    },
    {
      label: "receipt with an impossible day",
      schema: "operationReceipt",
      fixture: "operation-receipt.json",
      mutate: (value: Record<string, unknown>) => { value.completedAt = "2026-02-30T00:00:00.000Z"; }
    },
    {
      label: "result with an unrecognized live field",
      schema: "operationSubmitResult",
      fixture: "operation-submit-result.json",
      mutate: (value: Record<string, unknown>) => { value.liveResponse = "must never cross the submit boundary"; }
    },
    {
      label: "submission witness without post-send delta digest",
      schema: "operationSubmissionWitness",
      fixture: "operation-submission-witness.json",
      mutate: (value: Record<string, unknown>) => { delete value.postSendDeltaDigest; }
    },
    {
      label: "submission witness with an unsupported action kind",
      schema: "operationSubmissionWitness",
      fixture: "operation-submission-witness.json",
      mutate: (value: Record<string, unknown>) => { value.actionKind = "configuration_set"; }
    },
    {
      label: "submission witness with a malformed target digest",
      schema: "operationSubmissionWitness",
      fixture: "operation-submission-witness.json",
      mutate: (value: Record<string, unknown>) => { value.targetBindingDigest = "sha256:bad"; }
    },
    {
      label: "submission witness with an extra private field",
      schema: "operationSubmissionWitness",
      fixture: "operation-submission-witness.json",
      mutate: (value: Record<string, unknown>) => { value.prompt = "must never persist"; }
    },
    {
      label: "target establishment without post-send delta digest",
      schema: "operationEvent",
      fixture: "operation-target-established-event.json",
      mutate: (value: Record<string, unknown>) => {
        const event = value.event as Record<string, unknown>;
        const establishment = event.establishment as Record<string, unknown>;
        delete establishment.postSendDeltaDigest;
      }
    }
  ])("rejects $label", ({ schema, fixture, mutate }) => {
    const value = structuredClone(readJson(join("fixtures", fixture))) as Record<string, unknown>;
    mutate(value);
    expect(validator(schema)(value)).toBe(false);
  });
});

function validator(schemaName: string): ValidateFunction {
  const schemaPath = manifest.schemas[schemaName];
  if (schemaPath === undefined) throw new Error(`Missing schema ${schemaName}.`);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath) as AnySchema);
}

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(CONTRACT_ROOT, relativePath), "utf8"));
}

function findResponseShapes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(findResponseShapes);
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const properties = record.properties;
  const matches = properties !== null && typeof properties === "object" && !Array.isArray(properties)
    && Object.hasOwn(properties, "responseDigest") && Object.hasOwn(properties, "responseBytes")
    && Object.hasOwn(properties, "contentAvailable")
    ? [record]
    : [];
  return matches.concat(Object.values(record).flatMap(findResponseShapes));
}
