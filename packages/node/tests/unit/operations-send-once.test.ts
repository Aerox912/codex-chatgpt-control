import { describe, expect, it, vi } from "vitest";
import type { LocatorLike, PageLike } from "../../src/types.js";
import {
  executePreparedSendOnce,
  prepareSendOnce,
  recoverSendOnce,
  runSendOnce,
  verifyPreparedSendOnce,
  type SendOnceObservers,
  type SendOncePrepared,
  type SendOncePreconditionObservation,
  type SendOncePostconditionRequest
} from "../../src/operations/send-once.js";
import type {
  SubmissionExpectedEnvelope,
  SubmissionFinalTransactionResult
} from "../../src/operations/submission.js";

const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const TARGET_DIGEST = `hmac-sha256:${"b".repeat(64)}`;
const CONFIG_DIGEST = `hmac-sha256:${"c".repeat(64)}`;
const COMPOSER_DIGEST = `hmac-sha256:${"d".repeat(64)}`;
const BASELINE_DIGEST = `hmac-sha256:${"e".repeat(64)}`;
const EVIDENCE_DIGEST = `hmac-sha256:${"f".repeat(64)}`;
const USER_TURN_DIGEST = `hmac-sha256:${"1".repeat(64)}`;
const USER_TURN_ID = "user-turn-after-send";

function expected(): SubmissionExpectedEnvelope {
  return {
    surface: "chat",
    targetBindingDigest: TARGET_DIGEST,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST,
    attachmentManifest: {
      count: 0,
      orderPolicy: "exact",
      identities: []
    }
  };
}

function exactPrecondition(overrides: Partial<Extract<SendOncePreconditionObservation, { status: "exact" }>> = {}): Extract<SendOncePreconditionObservation, { status: "exact" }> {
  return {
    status: "exact",
    targetBindingDigest: TARGET_DIGEST,
    configurationReceiptDigest: CONFIG_DIGEST,
    composerReceiptDigest: COMPOSER_DIGEST,
    attachments: { count: 0, orderPolicy: "exact", identityDigests: [] },
    baseline: { userTurnEvidenceDigest: BASELINE_DIGEST },
    evidenceDigest: EVIDENCE_DIGEST,
    ...overrides
  };
}

function submitted(status: "submitted" | "already_submitted" = "submitted"): SubmissionFinalTransactionResult {
  return {
    status,
    targetBindingDigest: TARGET_DIGEST,
    evidenceDigest: EVIDENCE_DIGEST,
    userTurnId: USER_TURN_ID,
    userTurnEvidenceDigest: USER_TURN_DIGEST,
    postSendDeltaDigest: BASELINE_DIGEST
  };
}

function pageWithButton(options: Readonly<{
  count?: number;
  visible?: boolean[];
  enabled?: boolean;
  onClick?: () => Promise<void>;
}> = {}): { page: PageLike; clickCount: () => number } {
  let clicks = 0;
  const count = options.count ?? 1;
  const visible = options.visible ?? Array.from({ length: count }, () => true);
  const locatorFor = (index: number): LocatorLike => ({
    count: async () => count,
    nth: (childIndex: number) => locatorFor(childIndex),
    isVisible: async () => visible[index] ?? false,
    evaluate: async <T>() => (options.enabled ?? true) as T,
    click: async () => {
      clicks += 1;
      await options.onClick?.();
    }
  });
  const locator = locatorFor(0);
  return {
    page: { getByRole: () => locator },
    clickCount: () => clicks
  };
}

function observers(options: Readonly<{
  preconditions?: SendOncePreconditionObservation[];
  postcondition?: SubmissionFinalTransactionResult;
  onPostcondition?: (request: SendOncePostconditionRequest) => void;
}> = {}): SendOnceObservers {
  const preconditions = [...(options.preconditions ?? [exactPrecondition()])];
  return {
    observePrecondition: async () => preconditions.shift() ?? exactPrecondition(),
    observePostcondition: async request => {
      options.onPostcondition?.(request);
      return options.postcondition ?? submitted();
    }
  };
}

function request(
  page: PageLike,
  observer: SendOnceObservers,
  mode: "mutate_once" | "observe_only" = "mutate_once",
  extra: Partial<{
    signal: AbortSignal;
    deadlineAt: number;
    transaction: <T>(callback: () => Promise<T>) => Promise<T>;
  }> = {}
) {
  return {
    page,
    operationId: OPERATION_ID,
    requestDigest: REQUEST_DIGEST,
    surface: "chat" as const,
    actionId: "22222222-2222-4222-8222-222222222222",
    mode,
    expected: expected(),
    observers: observer,
    ...extra
  };
}

describe("operation-aware Send activation", () => {
  it("keeps prepare, durable persistence, activation, and verification in separate phases", async () => {
    const phases: string[] = [];
    let actorHeld = false;
    const fake = pageWithButton({ onClick: async () => { phases.push(`click:${actorHeld}`); } });
    const phaseObservers: SendOnceObservers = {
      observePrecondition: async request => {
        phases.push(`prepare-or-recheck:${request.mode}:${actorHeld}`);
        return exactPrecondition();
      },
      observePostcondition: async request => {
        phases.push(`verify:${request.activation}:${actorHeld}`);
        return submitted("already_submitted");
      }
    };
    const preparedResult = await prepareSendOnce({
      page: fake.page,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      expected: expected(),
      observers: phaseObservers
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;

    phases.push(`persist:${actorHeld}`);
    const execution = await executePreparedSendOnce({
      page: fake.page,
      prepared: preparedResult.prepared,
      observers: phaseObservers,
      transaction: async callback => {
        actorHeld = true;
        phases.push("actor:start");
        try {
          return await callback();
        } finally {
          actorHeld = false;
          phases.push("actor:end");
        }
      }
    });
    expect(execution.status).toBe("activated");
    if (execution.status !== "activated") return;
    const receipt = await verifyPreparedSendOnce({
      page: fake.page,
      prepared: execution.prepared,
      observers: phaseObservers,
      activation: execution.activation,
      mutationMayHaveOccurred: execution.mutationMayHaveOccurred
    });
    expect(receipt.status).toBe("already_submitted");
    expect(phases).toEqual([
      "prepare-or-recheck:mutate_once:false",
      "persist:false",
      "actor:start",
      "prepare-or-recheck:mutate_once:true",
      "click:true",
      "actor:end",
      "verify:activated:false"
    ]);
    expect(fake.clickCount()).toBe(1);
  });

  it("fails closed when the final recheck drifts after preparation", async () => {
    const fake = pageWithButton();
    let preconditionCalls = 0;
    const observer: SendOnceObservers = {
      observePrecondition: async () => {
        preconditionCalls += 1;
        return preconditionCalls === 1
          ? exactPrecondition()
          : { status: "mismatch", code: "composer_drift", evidenceDigest: EVIDENCE_DIGEST };
      },
      observePostcondition: async () => submitted()
    };
    const preparedResult = await prepareSendOnce({
      page: fake.page,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      expected: expected(),
      observers: observer
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;
    const execution = await executePreparedSendOnce({
      page: fake.page,
      prepared: preparedResult.prepared,
      observers: observer
    });
    expect(execution).toEqual({
      status: "blocked",
      result: { status: "blocked", blockerCode: "composer_drift", evidenceDigest: EVIDENCE_DIGEST }
    });
    expect(fake.clickCount()).toBe(0);
  });

  it("rejects a changed ownership baseline without activating Send", async () => {
    const fake = pageWithButton();
    let preconditionCalls = 0;
    const observer: SendOnceObservers = {
      observePrecondition: async () => {
        preconditionCalls += 1;
        return preconditionCalls === 1
          ? exactPrecondition({ baseline: { userTurnId: "before", userTurnEvidenceDigest: BASELINE_DIGEST } })
          : exactPrecondition({ baseline: { userTurnId: "other-user", userTurnEvidenceDigest: BASELINE_DIGEST } });
      },
      observePostcondition: async () => submitted()
    };
    const preparedResult = await prepareSendOnce({
      page: fake.page,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      expected: expected(),
      observers: observer
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;
    const execution = await executePreparedSendOnce({ page: fake.page, prepared: preparedResult.prepared, observers: observer });
    expect(execution).toEqual({ status: "blocked", result: { status: "blocked", blockerCode: "concurrent_user_turn" } });
    expect(fake.clickCount()).toBe(0);
  });

  it("deep-clones and freezes the prepared identity against provider mutation", async () => {
    const fake = pageWithButton();
    const providerObservation = exactPrecondition();
    const preparedResult = await prepareSendOnce({
      page: fake.page,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      expected: expected(),
      observers: {
        observePrecondition: async () => providerObservation,
        observePostcondition: async () => submitted()
      }
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;
    const prepared: SendOncePrepared = preparedResult.prepared;
    (providerObservation.baseline as { userTurnEvidenceDigest: string }).userTurnEvidenceDigest = `hmac-sha256:${"9".repeat(64)}`;
    expect(prepared.baseline.userTurnEvidenceDigest).toBe(BASELINE_DIGEST);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.expected)).toBe(true);
    expect(Object.isFrozen(prepared.expected.attachmentManifest)).toBe(true);
    expect(Object.isFrozen(prepared.baseline)).toBe(true);
  });

  it("awaits click settlement after cancellation and never overlaps a second activation", async () => {
    const controller = new AbortController();
    let releaseClick!: () => void;
    let clickStarted!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const clickStart = new Promise<void>(resolve => { clickStarted = resolve; });
    const fake = pageWithButton({
      onClick: async () => {
        clickStarted();
        await clickGate;
      }
    });
    const observer: SendOnceObservers = {
      observePrecondition: async () => exactPrecondition(),
      observePostcondition: async () => submitted()
    };
    const preparedResult = await prepareSendOnce({
      page: fake.page,
      operationId: OPERATION_ID,
      requestDigest: REQUEST_DIGEST,
      surface: "chat",
      actionId: "22222222-2222-4222-8222-222222222222",
      expected: expected(),
      observers: observer,
      signal: controller.signal
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;
    let settled = false;
    const executionPromise = executePreparedSendOnce({
      page: fake.page,
      prepared: preparedResult.prepared,
      observers: observer,
      signal: controller.signal
    }).then(result => {
      settled = true;
      return result;
    });
    await clickStart;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseClick();
    await expect(executionPromise).resolves.toMatchObject({ status: "activated" });
    expect(fake.clickCount()).toBe(1);
  });

  it("releases the short transaction before each postcondition probe and sleep", async () => {
    const fake = pageWithButton();
    const phases: string[] = [];
    let actorHeld = false;
    let probes = 0;
    const result = await runSendOnce(request(fake.page, {
      observePrecondition: async () => exactPrecondition(),
      observePostcondition: async observation => {
        probes += 1;
        phases.push(`probe:${observation.attempt}:${actorHeld}`);
        return probes === 1
          ? { result: { status: "blocked", blockerCode: "target_evidence_unavailable" }, retryable: true }
          : submitted();
      },
      sleep: async () => {
        phases.push(`sleep:${actorHeld}`);
      },
      maxPostconditionAttempts: 3,
      postconditionIntervalMs: 0
    }, "mutate_once", {
      transaction: async callback => {
        actorHeld = true;
        try {
          return await callback();
        } finally {
          actorHeld = false;
        }
      }
    }));

    expect(result).toMatchObject({ status: "submitted" });
    expect(phases).toEqual(["probe:1:false", "sleep:false", "probe:2:false"]);
    expect(fake.clickCount()).toBe(1);
  });

  it("keeps one activation when cancellation arrives after the click", async () => {
    const controller = new AbortController();
    const fake = pageWithButton({ onClick: async () => controller.abort() });
    const result = await runSendOnce(request(fake.page, {
      observePrecondition: async () => exactPrecondition(),
      observePostcondition: async () => ({
        result: { status: "blocked", blockerCode: "target_evidence_unavailable" },
        retryable: true
      }),
      maxPostconditionAttempts: 3,
      postconditionIntervalMs: 0
    }, "mutate_once", { signal: controller.signal }));

    expect(result).toMatchObject({ status: "uncertain", quarantine: "caller" });
    expect(fake.clickCount()).toBe(1);
  });

  it("bounds timeout reconciliation without allowing a second Send", async () => {
    vi.useFakeTimers();
    try {
      const deadlineAt = Date.now() + 10;
      const fake = pageWithButton({
        onClick: async () => {
          await vi.advanceTimersByTimeAsync(11);
        }
      });
      let probes = 0;
      const result = await runSendOnce(request(fake.page, {
        observePrecondition: async () => exactPrecondition(),
        observePostcondition: async () => {
          probes += 1;
          return {
            result: { status: "blocked", blockerCode: "target_evidence_unavailable" },
            retryable: true
          };
        },
        sleep: async () => undefined,
        maxPostconditionAttempts: 4,
        postconditionIntervalMs: 1,
        postconditionTimeoutMs: 100
      }, "mutate_once", { deadlineAt }));

      expect(result).toMatchObject({ status: "uncertain", quarantine: "caller" });
      expect(probes).toBe(1);
      expect(fake.clickCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clicks one unique enabled Send control exactly once", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers()));
    expect(result).toMatchObject({ status: "submitted", targetBindingDigest: TARGET_DIGEST });
    expect(fake.clickCount()).toBe(1);
  });

  it("does not click an ambiguous visible control", async () => {
    const fake = pageWithButton({ count: 2, visible: [true, true] });
    const result = await runSendOnce(request(fake.page, observers()));
    expect(result).toEqual({ status: "blocked", blockerCode: "ambiguous_submit" });
    expect(fake.clickCount()).toBe(0);
  });

  it("distinguishes an unavailable or disabled control without trying another selector", async () => {
    const fake = pageWithButton({ enabled: false });
    const result = await runSendOnce(request(fake.page, observers()));
    expect(result).toEqual({ status: "blocked", blockerCode: "send_control_unavailable" });
    expect(fake.clickCount()).toBe(0);
  });

  it("never retries a clean no-op whose postcondition cannot prove a turn", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers({
      postcondition: { status: "blocked", blockerCode: "ambiguous_submit" }
    })));
    expect(result).toEqual({ status: "uncertain", quarantine: "caller" });
    expect(fake.clickCount()).toBe(1);
  });

  it("reconciles an acts-then-throws activation observation-only", async () => {
    const fake = pageWithButton({ onClick: async () => { throw new Error("provider-private-error"); } });
    const activations: string[] = [];
    const result = await runSendOnce(request(fake.page, observers({
      postcondition: submitted("already_submitted"),
      onPostcondition: value => activations.push(value.activation)
    })));
    expect(result).toMatchObject({ status: "already_submitted", userTurnId: USER_TURN_ID });
    expect(activations).toEqual(["activation_threw"]);
    expect(fake.clickCount()).toBe(1);
  });

  it("does not activate when the final staging revalidation drifts", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers({
      preconditions: [
        exactPrecondition(),
        { status: "mismatch", code: "composer_drift", evidenceDigest: EVIDENCE_DIGEST }
      ]
    })));
    expect(result).toEqual({ status: "blocked", blockerCode: "composer_drift", evidenceDigest: EVIDENCE_DIGEST });
    expect(fake.clickCount()).toBe(0);
  });

  it("performs an already-submitted observation without requiring or clicking Send", async () => {
    const fake = pageWithButton({ enabled: false });
    const activations: string[] = [];
    const result = await runSendOnce(request(fake.page, observers({
      postcondition: submitted("already_submitted"),
      onPostcondition: value => activations.push(value.activation)
    }), "observe_only"));
    expect(result).toMatchObject({ status: "already_submitted", userTurnId: USER_TURN_ID });
    expect(activations).toEqual(["not_attempted"]);
    expect(fake.clickCount()).toBe(0);
  });

  it("returns a deterministic cancellation before activation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers(), "mutate_once", { signal: controller.signal }));
    expect(result).toEqual({ status: "blocked", blockerCode: "operation_cancelled" });
    expect(fake.clickCount()).toBe(0);
  });

  it("returns a deterministic timeout before activation", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers(), "mutate_once", { deadlineAt: Date.now() - 1 }));
    expect(result).toEqual({ status: "blocked", blockerCode: "operation_timeout" });
    expect(fake.clickCount()).toBe(0);
  });

  it("memoizes a caller transaction callback so an accidental wrapper retry cannot click twice", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers(), "mutate_once", {
      transaction: async callback => {
        await callback();
        return callback();
      }
    }));
    expect(result).toMatchObject({ status: "submitted" });
    expect(fake.clickCount()).toBe(1);
  });

  it("does not observe while a broken transaction wrapper leaves the mutation callback active", async () => {
    let releaseClick!: () => void;
    let reportClickStarted!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const clickStarted = new Promise<void>(resolve => { reportClickStarted = resolve; });
    const fake = pageWithButton({
      onClick: async () => {
        reportClickStarted();
        await clickGate;
      }
    });
    let probes = 0;
    let callbackPromise: Promise<unknown> | undefined;

    let resultSettled = false;
    const resultPromise = runSendOnce(request(fake.page, {
      observePrecondition: async () => exactPrecondition(),
      observePostcondition: async () => {
        probes += 1;
        return submitted();
      }
    }, "mutate_once", {
      transaction: async callback => {
        callbackPromise = callback();
        void callbackPromise.catch(() => undefined);
        await clickStarted;
        throw new Error("non-conforming wrapper rejected before callback settlement");
      }
    })).finally(() => { resultSettled = true; });

    await clickStarted;
    await Promise.resolve();
    expect(resultSettled).toBe(false);
    expect(probes).toBe(0);
    expect(fake.clickCount()).toBe(1);

    releaseClick();
    await expect(resultPromise).resolves.toEqual({ status: "uncertain", quarantine: "provider" });
    await callbackPromise;
  });

  it("awaits a callback when a broken transaction wrapper resolves before the click", async () => {
    let releaseClick!: () => void;
    let reportClickStarted!: () => void;
    const clickGate = new Promise<void>(resolve => { releaseClick = resolve; });
    const clickStarted = new Promise<void>(resolve => { reportClickStarted = resolve; });
    const fake = pageWithButton({
      onClick: async () => {
        reportClickStarted();
        await clickGate;
      }
    });
    let settled = false;
    const resultPromise = runSendOnce(request(fake.page, observers(), "mutate_once", {
      transaction: async callback => {
        void callback().catch(() => undefined);
        await clickStarted;
        return undefined as never;
      }
    })).finally(() => { settled = true; });

    await clickStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.clickCount()).toBe(1);
    releaseClick();
    await expect(resultPromise).resolves.toEqual({ status: "uncertain", quarantine: "provider" });
    expect(fake.clickCount()).toBe(1);
  });

  it("maps an exact callback envelope with the wrong target to a target blocker", async () => {
    const fake = pageWithButton();
    const result = await runSendOnce(request(fake.page, observers({
      preconditions: [
        exactPrecondition({ targetBindingDigest: `hmac-sha256:${"0".repeat(64)}` })
      ]
    })));
    expect(result).toEqual({ status: "blocked", blockerCode: "target_binding_mismatch" });
    expect(fake.clickCount()).toBe(0);
  });

  it("does not trust malformed callback output or a mismatched target/turn", async () => {
    const malformed = pageWithButton();
    const malformedResult = await runSendOnce(request(malformed.page, observers({
      postcondition: { status: "submitted", targetBindingDigest: "wrong", evidenceDigest: EVIDENCE_DIGEST, userTurnId: USER_TURN_ID, userTurnEvidenceDigest: USER_TURN_DIGEST }
    })));
    expect(malformedResult).toEqual({ status: "uncertain", quarantine: "caller" });
    expect(malformed.clickCount()).toBe(1);

    const sameTurn = pageWithButton();
    const sameTurnResult = await runSendOnce(request(sameTurn.page, observers({
      preconditions: [
        exactPrecondition({ baseline: { userTurnId: USER_TURN_ID, userTurnEvidenceDigest: BASELINE_DIGEST } }),
        exactPrecondition({ baseline: { userTurnId: USER_TURN_ID, userTurnEvidenceDigest: BASELINE_DIGEST } })
      ],
      postcondition: submitted()
    })));
    expect(sameTurnResult).toEqual({ status: "uncertain", quarantine: "caller" });
    expect(sameTurn.clickCount()).toBe(1);
  });

  it("rejects a mismatched surface and a non-semantic selector surface before activation", async () => {
    const mismatch = pageWithButton();
    const mismatchRequest = request(mismatch.page, observers());
    const mismatchResult = await runSendOnce({
      ...mismatchRequest,
      expected: { ...mismatchRequest.expected, surface: "work" }
    });
    expect(mismatchResult).toEqual({ status: "blocked", blockerCode: "port_protocol_violation" });
    expect(mismatch.clickCount()).toBe(0);

    const nonSemantic = pageWithButton();
    const nonSemanticResult = await runSendOnce(request(
      { locator: () => nonSemantic.page.getByRole!("button") },
      observers()
    ));
    expect(nonSemanticResult).toEqual({ status: "blocked", blockerCode: "port_protocol_violation" });
    expect(nonSemantic.clickCount()).toBe(0);
  });
});
