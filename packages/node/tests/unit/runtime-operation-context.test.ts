import { describe, expect, it } from "vitest";
import {
  createOperationRuntimeContext,
  OperationRuntimeContext,
  OperationRuntimeContextError,
  type OperationRuntimeAuthoritativeClaim,
  type OperationRuntimeCapabilities,
  type OperationRuntimeContextInput
} from "../../src/runtime/operation-context.js";

const capabilities: OperationRuntimeCapabilities = {
  stableProviderId: true,
  stableBrowserId: true,
  stableTabId: true,
  authoritativeTabClaim: true,
  concurrentTabs: true
};

const claim: OperationRuntimeAuthoritativeClaim = {
  status: "available",
  token: "fence-token-a",
  epoch: 7
};
const BACKEND_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_OPERATION_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_DIGEST = `hmac-sha256:${"a".repeat(64)}`;
const CHILD_TARGET_DIGEST = `hmac-sha256:${"b".repeat(64)}`;

function makePage(label: string): { label: string } {
  return { label };
}

function makeInput(
  page = makePage("one"),
  overrides: Record<string, unknown> = {}
): OperationRuntimeContextInput<{ label: string }> {
  return {
    providerId: "provider-a",
    browserId: "browser-a",
    tabId: "tab-a",
    page,
    authoritativeClaim: claim,
    owner: {
      backendSessionId: BACKEND_SESSION_ID,
      operationId: OPERATION_ID
    },
    capabilities,
    targetBindingDigest: TARGET_DIGEST,
    ...overrides
  } as OperationRuntimeContextInput<{ label: string }>;
}

function expectContextError(action: () => unknown, code: OperationRuntimeContextError["code"]): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(OperationRuntimeContextError);
  expect((error as OperationRuntimeContextError).code).toBe(code);
}

describe("OperationRuntimeContext", () => {
  it("binds a page, stable identities, owner, claim, target, and exact tab resource", () => {
    const page = makePage("one");
    const context = createOperationRuntimeContext(makeInput(page));

    expect(context.page).toBe(page);
    expect(context.providerId).toBe("provider-a");
    expect(context.browserId).toBe("browser-a");
    expect(context.tabId).toBe("tab-a");
    expect(context.owner).toEqual({
      backendSessionId: BACKEND_SESSION_ID,
      operationId: OPERATION_ID
    });
    expect(context.authoritativeClaim).toEqual(claim);
    expect(context.targetBindingDigest).toBe(TARGET_DIGEST);
    expect(context.coordinationScope).toBe("tab");
    expect(context.coordinatorResource()).toMatchObject({
      scope: "tab",
      resourceKind: "tab",
      exactTabOwnership: true,
      downgraded: false,
      resourceKey: "tab:provider-a:browser-a:tab-a"
    });
  });

  it("keeps concurrent contexts isolated when a legacy environment would share page state", () => {
    const pageOne = makePage("one");
    const pageTwo = makePage("two");
    const first = createOperationRuntimeContext(makeInput(pageOne));
    const second = createOperationRuntimeContext(makeInput(pageTwo, { tabId: "tab-b" }));

    expect(first.page).toBe(pageOne);
    expect(second.page).toBe(pageTwo);
    expect(first.capture().page).toBe(pageOne);
    expect(second.capture().page).toBe(pageTwo);
    expect(first.coordinatorResource().resourceKey).not.toBe(second.coordinatorResource().resourceKey);
    expect(() => first.assertPageAffinity(pageTwo, { tabId: "tab-b", authoritativeClaim: claim }))
      .toThrowError("not the page bound");
  });

  it("rejects page substitution, tab drift, and authoritative claim drift", () => {
    const page = makePage("one");
    const context = createOperationRuntimeContext(makeInput(page));

    expect(context.assertPageAffinity(page, { tabId: "tab-a", authoritativeClaim: claim })).toEqual({
      pageMatches: true,
      tabMatches: true,
      claimMatches: true,
      exactTabOwnership: true
    });
    expectContextError(
      () => context.assertPageAffinity(makePage("replacement"), { tabId: "tab-a", authoritativeClaim: claim }),
      "page_affinity_mismatch"
    );
    expectContextError(
      () => context.assertPageAffinity(page, { tabId: "tab-b", authoritativeClaim: claim }),
      "tab_affinity_mismatch"
    );
    expectContextError(
      () => context.assertPageAffinity(page, {
        tabId: "tab-a",
        authoritativeClaim: { status: "available", token: "fence-token-b", epoch: 7 }
      }),
      "claim_drift"
    );
    expectContextError(
      () => context.assertPageAffinity(page, { tabId: "tab-a" }),
      "claim_drift"
    );
  });

  it("requires explicit observed tab evidence for exact ownership", () => {
    const page = makePage("one");
    const context = createOperationRuntimeContext(makeInput(page));
    expectContextError(() => context.assertPageAffinity(page), "tab_affinity_mismatch");
    expectContextError(
      () => context.assertPageAffinity(page, { authoritativeClaim: claim }),
      "tab_affinity_mismatch"
    );
  });

  it("uses independent tab resources for different tabs and the same resource for the same tab", () => {
    const firstPage = makePage("one");
    const secondPage = makePage("two");
    const first = createOperationRuntimeContext(makeInput(firstPage, { tabId: "tab-a" }));
    const second = createOperationRuntimeContext(makeInput(secondPage, { tabId: "tab-b" }));
    const sameTab = createOperationRuntimeContext(makeInput(secondPage, { tabId: "tab-a" }));

    expect(first.coordinatorResource().resourceKind).toBe("tab");
    expect(first.coordinatorResource().resourceKey).not.toBe(second.coordinatorResource().resourceKey);
    expect(first.coordinatorResource().resourceKey).toBe(sameTab.coordinatorResource().resourceKey);
  });

  it("downgrades missing, unknown, and unsafe identities to provider-wide coordination", () => {
    const missingTab = createOperationRuntimeContext(makeInput(makePage("missing"), { tabId: undefined }));
    const unknownTab = createOperationRuntimeContext(makeInput(makePage("unknown"), { tabId: "unknown" }));
    const unsafeCapabilities = createOperationRuntimeContext(makeInput(makePage("unsafe"), {
      tabId: "tab-b",
      capabilities: { ...capabilities, concurrentTabs: false }
    }));

    for (const context of [missingTab, unknownTab, unsafeCapabilities]) {
      expect(context.coordinationScope).toBe("provider");
      expect(context.coordinatorResource()).toMatchObject({
        resourceKind: "browser",
        scope: "provider",
        downgraded: true
      });
    }
    expect(missingTab.coordinatorResource().exactTabOwnership).toBe(false);
    expect(unknownTab.coordinatorResource().exactTabOwnership).toBe(false);
    expect(missingTab.coordinatorResource().downgradeReasons).toContain("tab_identity_unavailable");
    expect(unknownTab.coordinatorResource().downgradeReasons).toContain("tab_identity_unavailable");
    expect(unsafeCapabilities.coordinatorResource().downgradeReasons).toContain("concurrent_tabs_not_advertised");
    expect(unsafeCapabilities.coordinatorResource().exactTabOwnership).toBe(true);
    expect(missingTab.coordinatorResource().resourceKey).toBe(unknownTab.coordinatorResource().resourceKey);
  });

  it("does not advertise exact ownership when a provider omits the claim or capability fields", () => {
    const noClaim = createOperationRuntimeContext(makeInput(makePage("no-claim"), {
      authoritativeClaim: undefined
    }));
    const noCapabilities = createOperationRuntimeContext(makeInput(makePage("no-capabilities"), {
      capabilities: undefined
    }));

    expect(noClaim.coordinatorResource().exactTabOwnership).toBe(false);
    expect(noCapabilities.coordinatorResource().exactTabOwnership).toBe(false);
    expect(noClaim.coordinatorResource().downgradeReasons).toContain("authoritative_claim_unavailable");
    expect(noCapabilities.coordinatorResource().downgradeReasons).toContain("concurrent_tabs_not_advertised");
  });

  it("rejects exact ownership requests instead of silently downgrading", () => {
    expectContextError(
      () => createOperationRuntimeContext(makeInput(makePage("missing"), {
        tabId: undefined,
        requireExactTabOwnership: true
      })),
      "exact_ownership_unavailable"
    );
    expectContextError(
      () => createOperationRuntimeContext(makeInput(makePage("unsafe"), {
        authoritativeClaim: undefined,
        requireExactTabOwnership: true
      })),
      "exact_ownership_unavailable"
    );
    const serialButOwned = createOperationRuntimeContext(makeInput(makePage("serial"), {
      capabilities: { ...capabilities, concurrentTabs: false },
      requireExactTabOwnership: true
    }));
    expect(serialButOwned.coordinationScope).toBe("provider");
    expect(serialButOwned.coordinatorResource().exactTabOwnership).toBe(true);
  });

  it("creates immutable children that cannot change page or browser ownership", () => {
    const page = makePage("one");
    const parent = createOperationRuntimeContext(makeInput(page));
    const child = parent.child({ operationId: CHILD_OPERATION_ID, targetBindingDigest: CHILD_TARGET_DIGEST });

    expect(child.page).toBe(page);
    expect(child.owner).toEqual({ backendSessionId: BACKEND_SESSION_ID, operationId: CHILD_OPERATION_ID });
    expect(child.providerId).toBe(parent.providerId);
    expect(child.tabId).toBe(parent.tabId);
    expect(child.targetBindingDigest).not.toBe(parent.targetBindingDigest);
    expect(child.coordinatorResource().resourceKey).toBe(parent.coordinatorResource().resourceKey);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.owner)).toBe(true);
    expect(() => {
      (child as { page: unknown }).page = makePage("replacement");
    }).toThrow();
    expect(() => parent.child({ operationId: "operation-child", extra: true } as never)).toThrow();
  });

  it("returns immutable capture views with a bound affinity verifier", () => {
    const page = makePage("one");
    const context = OperationRuntimeContext.bind(makeInput(page));
    const capture = context.capture();

    expect(Object.isFrozen(capture)).toBe(true);
    expect(Object.isFrozen(capture.owner)).toBe(true);
    expect(Object.isFrozen(capture.capabilities)).toBe(true);
    expect(Object.isFrozen(capture.resource)).toBe(true);
    expect(capture.page).toBe(page);
    expect(capture.assertPageAffinity(page, { tabId: "tab-a", authoritativeClaim: claim }).exactTabOwnership).toBe(true);
    expect(() => {
      (capture as { targetBindingDigest: string }).targetBindingDigest = "hmac-sha256:other";
    }).toThrow();
  });

  it("rejects extra/private fields and malformed nested values", () => {
    expect(() => createOperationRuntimeContext(makeInput(makePage("extra"), { _page: "secret" }))).toThrow();
    expect(() => createOperationRuntimeContext(makeInput(makePage("extra"), { extra: true }))).toThrow();
    expect(() => createOperationRuntimeContext(makeInput(makePage("owner"), {
      owner: { backendSessionId: BACKEND_SESSION_ID, operationId: OPERATION_ID, private: "no" }
    }))).toThrow();
    expect(() => createOperationRuntimeContext(makeInput(makePage("cap"), {
      capabilities: { ...capabilities, unsafe: true }
    }))).toThrow();
    expect(() => createOperationRuntimeContext(makeInput(makePage("claim"), {
      authoritativeClaim: { ...claim, private: "no" }
    }))).toThrow();
    expect(() => createOperationRuntimeContext(makeInput(makePage("number"), { tabId: 42 }))).toThrow();
    expect(() => createOperationRuntimeContext(makePage("not-a-record") as never)).toThrow();
  });

  it("keeps diagnostics and affinity errors redacted", () => {
    const page = makePage("private-page-label");
    const context = createOperationRuntimeContext(makeInput(page, {
      providerId: "provider-sensitive",
      browserId: "browser-sensitive",
      tabId: "tab-sensitive",
      authoritativeClaim: {
        status: "available",
        token: "claim-secret-token",
        epoch: 22
      },
      targetBindingDigest: `hmac-sha256:${"c".repeat(64)}`,
      owner: {
        backendSessionId: BACKEND_SESSION_ID,
        operationId: OPERATION_ID
      }
    }));
    const diagnosticJson = JSON.stringify(context.diagnostics());
    expect(diagnosticJson).not.toContain("sensitive");
    expect(diagnosticJson).not.toContain("claim-secret-token");
    expect(diagnosticJson).not.toContain("hmac-sha256");

    let error: OperationRuntimeContextError | undefined;
    try {
      context.assertPageAffinity(makePage("attacker-page"), { tabId: "tab-attacker", authoritativeClaim: {
        status: "available",
        token: "attacker-token",
        epoch: 999
      } });
    } catch (caught) {
      error = caught as OperationRuntimeContextError;
    }
    expect(error).toBeDefined();
    expect(error?.message).not.toContain("sensitive");
    expect(JSON.stringify(error?.diagnostics)).not.toContain("sensitive");
    expect(JSON.stringify(error?.diagnostics)).not.toContain("claim-secret-token");
    expect(JSON.stringify(error?.diagnostics)).not.toContain("hmac-sha256");
  });
});
