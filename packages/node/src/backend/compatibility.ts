import {
  BACKEND_COMPATIBILITY_SCHEMA_VERSION,
  BACKEND_REQUEST_SCHEMA_VERSION,
  type BackendCompatibilityReport,
  type BackendCompatibilityWarning,
  type BackendCompatibilityWarningCode,
  type BackendRuntimeIdentity
} from "./protocol.js";

const MAX_WARNINGS = 16;
const MAX_TEXT_LENGTH = 512;
const UNKNOWN_PROVENANCE = "unknown";

export type BackendCompatibilityExpectedIdentity = Partial<Pick<
  BackendRuntimeIdentity,
  "backendSessionId" | "packageName" | "packageVersion" | "runtime" | "runtimeVersion" | "buildDigest"
>>;

/**
 * Compare only explicitly supplied, bounded provenance. Package/runtime
 * differences are diagnostic warnings; protocol/capability rejection is
 * handled by the handshake before browser commands are admitted.
 */
export function compatibilityReportFromHello(
  value: Record<string, unknown>,
  expected: BackendCompatibilityExpectedIdentity | undefined,
  mode: "multiplexed" | "single-flight" | "legacy"
): BackendCompatibilityReport {
  const warnings: BackendCompatibilityWarning[] = [];
  const fields = [
    ["backendSessionId", "backend session identity"],
    ["packageName", "package name"],
    ["packageVersion", "package version"],
    ["runtime", "runtime"],
    ["runtimeVersion", "runtime version"],
    ["buildDigest", "build digest"]
  ] as const;

  for (const [field, label] of fields) {
    const received = boundedString(value[field]);
    const expectedValue = boundedString(expected?.[field]);
    if (received === undefined || received === UNKNOWN_PROVENANCE) {
      warnings.push({
        code: "provenance_unknown",
        ...(field === "backendSessionId" ? {} : { field }),
        ...(received === undefined ? {} : { received }),
        message: `Backend ${label} provenance is unknown.`
      });
      continue;
    }
    if (expectedValue !== undefined && expectedValue !== UNKNOWN_PROVENANCE && expectedValue !== received) {
      const code = mismatchCode(field);
      warnings.push({
        code,
        ...(field === "backendSessionId" ? {} : { field }),
        expected: expectedValue,
        received,
        message: `Backend ${label} differs from the expected runtime (${expectedValue} versus ${received}).`
      });
    }
  }

  const boundedWarnings = warnings.slice(0, MAX_WARNINGS);
  const hasUnknown = boundedWarnings.some(warning => warning.code === "provenance_unknown");
  const protocolVersion = boundedString(value.protocolVersion);
  return snapshot({
    schemaVersion: BACKEND_COMPATIBILITY_SCHEMA_VERSION,
    status: boundedWarnings.some(warning => warning.code !== "provenance_unknown")
      ? "warning"
      : hasUnknown
        ? "unknown"
        : "compatible",
    mode,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...optionalIdentity(value, "backendSessionId"),
    ...optionalIdentity(value, "packageName"),
    ...optionalIdentity(value, "packageVersion"),
    ...optionalIdentity(value, "runtime"),
    ...optionalIdentity(value, "runtimeVersion"),
    ...optionalIdentity(value, "buildDigest"),
    warnings: boundedWarnings
  });
}

export function compatibilityReportFromLegacy(
  version: Record<string, unknown>,
  expected: BackendCompatibilityExpectedIdentity | undefined
): BackendCompatibilityReport {
  const base = compatibilityReportFromHello(
    {
      protocolVersion: version.protocolVersion,
      backendSessionId: version.backendSessionId,
      packageName: version.packageName,
      packageVersion: version.packageVersion,
      runtime: version.runtime,
      runtimeVersion: version.runtimeVersion,
      buildDigest: version.buildDigest
    },
    expected,
    "legacy"
  );
  const warnings = [
    {
      code: "legacy_backend" as const,
      message: "Backend negotiated legacy single-flight compatibility; multiplexing was not advertised."
    },
    ...base.warnings
  ].slice(0, MAX_WARNINGS);
  return snapshot({
    ...base,
    status: "warning",
    warnings
  });
}

export function blockedCompatibilityReport(message = "Backend compatibility negotiation was rejected."): BackendCompatibilityReport {
  return snapshot({
    schemaVersion: BACKEND_COMPATIBILITY_SCHEMA_VERSION,
    status: "blocked",
    mode: "unknown",
    warnings: [{ code: "negotiation_rejected", message: boundedMessage(message) }]
  });
}

/** Validate transport-owned diagnostics before exposing them through a facade. */
export function validateBackendCompatibilityReport(value: unknown): BackendCompatibilityReport {
  if (!isRecord(value)
    || value.schemaVersion !== BACKEND_COMPATIBILITY_SCHEMA_VERSION
    || !isStatus(value.status)
    || !isMode(value.mode)
    || !Array.isArray(value.warnings)
    || value.warnings.length > MAX_WARNINGS) {
    throw new TypeError("Backend compatibility report is malformed.");
  }
  for (const field of ["protocolVersion", "backendSessionId", "packageName", "packageVersion", "runtime", "runtimeVersion", "buildDigest"] as const) {
    if (value[field] !== undefined && boundedString(value[field]) === undefined) {
      throw new TypeError("Backend compatibility report contains an invalid identity field.");
    }
  }
  const warnings: BackendCompatibilityWarning[] = [];
  for (const warning of value.warnings) {
    const message = isRecord(warning) ? boundedString(warning.message) : undefined;
    if (!isRecord(warning)
      || !isWarningCode(warning.code)
      || (warning.field !== undefined && !isField(warning.field))
      || (warning.expected !== undefined && boundedString(warning.expected) === undefined)
      || (warning.received !== undefined && boundedString(warning.received) === undefined)
      || message === undefined) {
      throw new TypeError("Backend compatibility report contains an invalid warning.");
    }
    const expected = boundedString(warning.expected);
    const received = boundedString(warning.received);
    warnings.push({
      code: warning.code,
      ...(warning.field === undefined ? {} : { field: warning.field }),
      ...(expected === undefined ? {} : { expected }),
      ...(received === undefined ? {} : { received }),
      message
    });
  }
  const protocolVersion = boundedString(value.protocolVersion);
  return snapshot({
    schemaVersion: BACKEND_COMPATIBILITY_SCHEMA_VERSION,
    status: value.status,
    mode: value.mode,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...copyOptionalIdentity(value, "backendSessionId"),
    ...copyOptionalIdentity(value, "packageName"),
    ...copyOptionalIdentity(value, "packageVersion"),
    ...copyOptionalIdentity(value, "runtime"),
    ...copyOptionalIdentity(value, "runtimeVersion"),
    ...copyOptionalIdentity(value, "buildDigest"),
    warnings
  });
}

function snapshot(report: BackendCompatibilityReport): BackendCompatibilityReport {
  const warnings = Object.freeze(report.warnings.map(warning => Object.freeze({ ...warning })));
  return Object.freeze({ ...report, warnings });
}

function mismatchCode(field: string): BackendCompatibilityWarningCode {
  switch (field) {
    case "packageName": return "package_name_mismatch";
    case "packageVersion": return "package_version_mismatch";
    case "runtime": return "runtime_mismatch";
    case "runtimeVersion": return "runtime_version_mismatch";
    case "buildDigest": return "build_digest_mismatch";
    default: return "provenance_unknown";
  }
}

function optionalIdentity(value: Record<string, unknown>, field: string): Record<string, string> {
  const result = boundedString(value[field]);
  return result === undefined ? {} : { [field]: result };
}

function copyOptionalIdentity(value: Record<string, unknown>, field: string): Record<string, string> {
  const result = boundedString(value[field]);
  return result === undefined ? {} : { [field]: result };
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedMessage(value: string): string {
  return value.length <= MAX_TEXT_LENGTH ? value : "Backend compatibility negotiation was rejected.";
}

function isStatus(value: unknown): value is BackendCompatibilityReport["status"] {
  return value === "compatible" || value === "warning" || value === "unknown" || value === "blocked";
}

function isMode(value: unknown): value is BackendCompatibilityReport["mode"] {
  return value === "multiplexed" || value === "single-flight" || value === "legacy" || value === "unknown";
}

function isField(value: unknown): value is NonNullable<BackendCompatibilityWarning["field"]> {
  return value === "packageName"
    || value === "packageVersion"
    || value === "runtime"
    || value === "runtimeVersion"
    || value === "buildDigest";
}

function isWarningCode(value: unknown): value is BackendCompatibilityWarningCode {
  return value === "package_name_mismatch"
    || value === "package_version_mismatch"
    || value === "runtime_mismatch"
    || value === "runtime_version_mismatch"
    || value === "build_digest_mismatch"
    || value === "provenance_unknown"
    || value === "legacy_backend"
    || value === "negotiation_rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
