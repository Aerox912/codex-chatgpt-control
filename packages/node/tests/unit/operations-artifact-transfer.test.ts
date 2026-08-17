import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  transferOperationArtifact,
  type ArtifactTransferDurableState,
  type ArtifactTransferOptions,
  type ArtifactTransferReceiptV1
} from "../../src/operations/artifact-transfer.js";
import { deriveOperationOutputKey } from "../../src/operations/artifact-output.js";

type FakeJournal = {
  state: ArtifactTransferDurableState | undefined;
  reads: number;
  intents: number;
  receipts: number;
  persisted: unknown[];
  readActionState: (lookup: unknown) => Promise<ArtifactTransferDurableState | undefined>;
  persistIntent: (intent: ArtifactTransferDurableState["intent"]) => Promise<void>;
  persistReceipt: (receipt: ArtifactTransferReceiptV1) => Promise<void>;
};

function digest(value: unknown): string {
  return `hmac-sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function id(): string {
  const hex = Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, "0");
  return `123e4567-e89b-12d3-a456-${hex}`;
}

async function root(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `artifact-transfer-${label}-`));
  roots.add(path);
  return path;
}

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all([...roots].map(path => rm(path, { recursive: true, force: true })));
  roots.clear();
});

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value, "utf8");
}

function makeJournal(initial?: ArtifactTransferDurableState): FakeJournal {
  const journal: FakeJournal = {
    state: initial,
    reads: 0,
    intents: 0,
    receipts: 0,
    persisted: [],
    readActionState: async () => {
      journal.reads += 1;
      return journal.state;
    },
    persistIntent: async intent => {
      journal.intents += 1;
      journal.persisted.push(intent);
      journal.state = intent === undefined ? {} : { intent };
    },
    persistReceipt: async receipt => {
      journal.receipts += 1;
      journal.persisted.push(receipt);
      journal.state = { ...(journal.state ?? {}), receipt };
    }
  };
  return journal;
}

function journalPort(journal: FakeJournal): ArtifactTransferOptions["journal"] {
  return {
    readActionState: journal.readActionState,
    persistIntent: journal.persistIntent,
    persistReceipt: journal.persistReceipt
  };
}

function makeOptions(
  outputDirectory: string,
  journal: FakeJournal,
  overrides: Partial<ArtifactTransferOptions> = {}
): ArtifactTransferOptions {
  return {
    operationId: id(),
    requestDigest: digest(["request", Math.random()]),
    targetBindingDigest: digest(["target", Math.random()]),
    assistantTurnId: "assistant-turn-opaque-1",
    sourceIdentityDigest: digest(["source", Math.random()]),
    kind: "file",
    ordinal: 0,
    transferActionId: id(),
    outputDirectory,
    evidenceDigest: (domain, material) => digest([domain, material]),
    openSource: async () => chunks("payload"),
    journal: journalPort(journal),
    ...overrides
  };
}

function withSharedIdentity(left: ArtifactTransferOptions, right: Partial<ArtifactTransferOptions>): ArtifactTransferOptions {
  return { ...left, ...right };
}

describe("operation-owned artifact transfer", () => {
  it("persists local-output intent before opening the source or writing bytes", async () => {
    const destination = await root("ordering");
    const journal = makeJournal();
    const events: string[] = [];
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        events.push("source-open");
        return chunks("first", "second");
      }
    });
    const instrumented = {
      ...options,
      journal: {
        readActionState: journal.readActionState,
        persistIntent: async (intent: NonNullable<ArtifactTransferDurableState["intent"]>) => {
          events.push("intent");
          await journal.persistIntent(intent);
        },
        persistReceipt: async (receipt: ArtifactTransferReceiptV1) => {
          events.push("receipt");
          await journal.persistReceipt(receipt);
        }
      }
    } as ArtifactTransferOptions;
    const result = await transferOperationArtifact(instrumented);
    expect(result.outcome).toBe("satisfied");
    expect(result.receipt?.status).toBe("transferred");
    expect(events).toEqual(["intent", "source-open", "receipt"]);
    expect(journal.persisted.map(value => JSON.stringify(value)).join(" ")).not.toContain(destination);
    expect(result.receipt).toMatchObject({
      operationId: options.operationId,
      requestDigest: options.requestDigest,
      targetBindingDigest: options.targetBindingDigest,
      assistantTurnId: options.assistantTurnId,
      sourceIdentityDigest: options.sourceIdentityDigest,
      transferActionId: options.transferActionId,
      status: "transferred"
    });
  });

  it("closes an opened source when destination preflight consumes zero chunks", async () => {
    const parent = await root("preflight-source-close");
    const invalidDestination = join(parent, "not-a-directory");
    await writeFile(invalidDestination, "occupied", "utf8");
    const journal = makeJournal();
    let nextCalls = 0;
    let returnCalls = 0;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          nextCalls += 1;
          return { done: false, value: Buffer.from("must-not-be-read", "utf8") };
        },
        return: async () => {
          returnCalls += 1;
          return { done: true, value: undefined };
        }
      })
    };

    const result = await transferOperationArtifact(makeOptions(invalidDestination, journal, {
      openSource: async () => source
    }));

    expect(nextCalls).toBe(0);
    expect(returnCalls).toBe(1);
    expect(result).toMatchObject({ outcome: "uncertain", receipt: { status: "partial" } });
  });

  it("bounds a never-settling source cleanup after zero-read preflight", async () => {
    vi.useFakeTimers();
    try {
      const parent = await root("preflight-source-close-timeout");
      const invalidDestination = join(parent, "not-a-directory");
      await writeFile(invalidDestination, "occupied", "utf8");
      const journal = makeJournal();
      let markReturnStarted!: () => void;
      const returnStarted = new Promise<void>(resolve => { markReturnStarted = resolve; });
      let returnCalls = 0;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: false, value: Buffer.from("must-not-be-read", "utf8") }),
          return: async () => {
            returnCalls += 1;
            markReturnStarted();
            return await new Promise<IteratorResult<Uint8Array>>(() => undefined);
          }
        })
      };
      const pending = transferOperationArtifact(makeOptions(invalidDestination, journal, {
        deadlineAt: 5,
        now: () => 0,
        openSource: async () => source
      }));
      await returnStarted;
      expect(returnCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result).toMatchObject({
        outcome: "uncertain",
        intentPersistence: "durable",
        receipt: { status: "partial", blockerCode: "artifact_transfer_partial" }
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds source acquisition after intent and closes a late capability", async () => {
    vi.useFakeTimers();
    try {
      const destination = await root("source-open-timeout");
      const journal = makeJournal();
      let markOpenStarted!: () => void;
      const openStarted = new Promise<void>(resolve => { markOpenStarted = resolve; });
      let resolveOpen!: (source: AsyncIterable<Uint8Array>) => void;
      const openResult = new Promise<AsyncIterable<Uint8Array>>(resolve => { resolveOpen = resolve; });
      let returnCalls = 0;
      const lateSource: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
          return: async () => {
            returnCalls += 1;
            return { done: true, value: undefined };
          }
        })
      };
      const pending = transferOperationArtifact(makeOptions(destination, journal, {
        deadlineAt: 5,
        now: () => 0,
        openSource: async () => {
          markOpenStarted();
          return await openResult;
        }
      }));
      await openStarted;
      await vi.advanceTimersByTimeAsync(5);
      const result = await pending;
      expect(result).toMatchObject({
        outcome: "uncertain",
        intentPersistence: "durable",
        receipt: { status: "partial", blockerCode: "artifact_transfer_partial" }
      });
      resolveOpen(lateSource);
      await vi.advanceTimersByTimeAsync(0);
      expect(returnCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays a completed receipt without opening the browser/source", async () => {
    const destination = await root("replay");
    const journal = makeJournal();
    let sourceOpens = 0;
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        sourceOpens += 1;
        return chunks("replayable");
      }
    });
    const first = await transferOperationArtifact(options);
    const second = await transferOperationArtifact({
      ...options,
      openSource: async () => {
        sourceOpens += 100;
        throw new Error("source must not be opened on replay");
      }
    });
    expect(first.outcome).toBe("satisfied");
    expect(second).toMatchObject({ replayed: true, outcome: "satisfied", receiptPersistence: "durable", intentPersistence: "durable" });
    expect(second.receipt).toEqual(first.receipt);
    expect(sourceOpens).toBe(1);
  });

  it("rejects the same action when its destination or artifact identity changes", async () => {
    const firstDestination = await root("conflict-a");
    const secondDestination = await root("conflict-b");
    const journal = makeJournal();
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const first = makeOptions(firstDestination, journal, {
      openSource: async () => {
        await gate;
        return chunks("one");
      }
    });
    const p1 = transferOperationArtifact(first);
    await Promise.resolve();
    const differentDestination = withSharedIdentity(first, { outputDirectory: secondDestination });
    const destinationConflict = await transferOperationArtifact(differentDestination);
    const differentArtifact = withSharedIdentity(first, { sourceIdentityDigest: digest("other-artifact") });
    const artifactConflict = await transferOperationArtifact(differentArtifact);
    expect(destinationConflict).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_request_mismatch" });
    expect(artifactConflict).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_request_mismatch" });
    release();
    await p1;
  });

  it("never retries source delivery after a crash leaves intent without a receipt", async () => {
    const destination = await root("crash-after-intent");
    const journal = makeJournal();
    const crashController = new AbortController();
    let opens = 0;
    let receiptAttempts = 0;
    const options = makeOptions(destination, journal, {
      signal: crashController.signal,
      openSource: async () => {
        opens += 1;
        return chunks("must-not-open");
      },
      journal: {
        readActionState: journal.readActionState,
        persistIntent: async intent => {
          await journal.persistIntent(intent);
          crashController.abort();
        },
        persistReceipt: async () => {
          receiptAttempts += 1;
          throw new Error("simulated crash before receipt persistence");
        }
      }
    });

    const crashed = await transferOperationArtifact(options);
    expect(crashed).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "durable",
      receiptPersistence: "indeterminate",
      receipt: { status: "partial", blockerCode: "operation_cancelled" }
    });
    expect(journal.state).toMatchObject({ intent: { actionKind: "local_output_commit" } });
    expect(journal.state).not.toHaveProperty("receipt");
    expect(receiptAttempts).toBe(1);
    expect(opens).toBe(0);

    const { signal: _crashSignal, ...recoveryOptions } = options;
    const recovered = await transferOperationArtifact({
      ...recoveryOptions,
      openSource: async () => {
        opens += 1;
        return chunks("must-not-retry");
      },
      journal: journalPort(journal)
    });
    expect(recovered).toMatchObject({
      outcome: "uncertain",
      replayed: false,
      intentPersistence: "durable",
      receiptPersistence: "durable",
      receipt: { status: "partial", blockerCode: "artifact_transfer_partial" }
    });
    expect(opens).toBe(0);
    expect(journal.receipts).toBe(1);

    const replay = await transferOperationArtifact({
      ...recoveryOptions,
      openSource: async () => {
        opens += 1;
        return chunks("must-not-retry");
      },
      journal: journalPort(journal)
    });
    expect(replay).toMatchObject({ outcome: "uncertain", replayed: true, receipt: recovered.receipt });
    expect(opens).toBe(0);
    expect(journal.receipts).toBe(1);
  });

  it("never retries source delivery after source acquisition becomes ambiguous", async () => {
    const destination = await root("intent-only");
    const journal = makeJournal();
    let opens = 0;
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        opens += 1;
        throw new Error("provider delivery is ambiguous");
      }
    });
    const result = await transferOperationArtifact(options);
    expect(result).toMatchObject({ outcome: "uncertain", receipt: { status: "partial", blockerCode: "artifact_transfer_partial" } });
    expect(result.receipt).not.toHaveProperty("bytes");
    expect(result.receipt).not.toHaveProperty("sha256");
    expect(opens).toBe(1);
    const retry = await transferOperationArtifact({
      ...options,
      openSource: async () => {
        opens += 1;
        return chunks("must-not-retry");
      }
    });
    expect(retry).toMatchObject({ outcome: "uncertain", replayed: true, receipt: { status: "partial" } });
    expect(opens).toBe(1);
  });

  it("records an observed prefix when a source streams and then fails", async () => {
    const destination = await root("stream-failure");
    const journal = makeJournal();
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      openSource: async () => (async function* (): AsyncGenerator<Uint8Array> {
        yield Buffer.from("prefix");
        throw new Error("late provider failure with private text");
      })()
    }));
    expect(result).toMatchObject({ outcome: "uncertain", receipt: { status: "partial", blockerCode: "artifact_transfer_partial", bytes: 6 } });
    expect((await readdir(destination)).filter(name => name.includes("partial-")).length).toBe(0);
    expect(JSON.stringify(result)).not.toContain(destination);
  });

  it("reconciles a verified operation-owned temp without opening source again", async () => {
    const destination = await root("temp-reconcile");
    const journal = makeJournal();
    let sourceOpens = 0;
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        sourceOpens += 1;
        return chunks("verified-temp");
      }
    });
    const first = await transferOperationArtifact(options);
    const outputKey = first.receipt!.outputKey!;
    await unlink(join(destination, outputKey));
    const payload = Buffer.from("verified-temp");
    await writeFile(join(destination, `.${outputKey}.partial-${"0".repeat(32)}.tmp`), payload, { mode: 0o600 });
    const recovered = await transferOperationArtifact({
      ...options,
      openSource: async () => {
        sourceOpens += 100;
        throw new Error("verified temp must not use provider source");
      }
    });
    expect(recovered).toMatchObject({ outcome: "satisfied", replayed: true, receipt: { status: "transferred", bytes: payload.byteLength } });
    expect(sourceOpens).toBe(1);
    expect(await readFile(join(destination, outputKey))).toEqual(payload);
  });

  it("converges concurrent identical callers to one source open and one receipt", async () => {
    const destination = await root("concurrent");
    const journal = makeJournal();
    let sourceOpens = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        sourceOpens += 1;
        await gate;
        return chunks("same-call");
      }
    });
    const left = transferOperationArtifact(options);
    await Promise.resolve();
    const right = transferOperationArtifact(options);
    release();
    const [leftResult, rightResult] = await Promise.all([left, right]);
    expect(sourceOpens).toBe(1);
    expect(journal.intents).toBe(1);
    expect(journal.receipts).toBe(1);
    expect(leftResult.receipt).toEqual(rightResult.receipt);
  });

  it("reports destination collisions without overwriting the existing file", async () => {
    const destination = await root("collision");
    const journal = makeJournal();
    const options = makeOptions(destination, journal, { openSource: async () => chunks("new-bytes") });
    const evidence = options.evidenceDigest("artifact-destination", {
      schemaVersion: "chatgpt.browser_control.artifact_transfer.v1",
      operationId: options.operationId,
      requestDigest: options.requestDigest,
      targetBindingDigest: options.targetBindingDigest,
      assistantTurnId: options.assistantTurnId,
      sourceIdentityDigest: options.sourceIdentityDigest,
      kind: options.kind,
      ordinal: options.ordinal,
      transferActionId: options.transferActionId,
      canonicalDestination: destination
    });
    const artifact = JSON.stringify({ assistantTurnId: options.assistantTurnId, sourceIdentityDigest: options.sourceIdentityDigest, kind: options.kind, ordinal: options.ordinal, transferActionId: options.transferActionId, destinationIdentityDigest: evidence, maxBytes: 128 * 1024 * 1024 });
    const outputKey = deriveOperationOutputKey({ operationId: options.operationId, artifactIdentity: artifact });
    await writeFile(join(destination, outputKey), "old-bytes");
    const result = await transferOperationArtifact(options);
    expect(result).toMatchObject({ outcome: "not_satisfied", receipt: { status: "blocked", blockerCode: "output_collision" } });
    expect(await readFile(join(destination, outputKey), "utf8")).toBe("old-bytes");
  });

  it("distinguishes cancellation before intent from cancellation after intent", async () => {
    const beforeRoot = await root("cancel-before");
    const beforeJournal = makeJournal();
    const beforeController = new AbortController();
    beforeController.abort();
    const before = await transferOperationArtifact(makeOptions(beforeRoot, beforeJournal, { signal: beforeController.signal }));
    expect(before).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_cancelled", intentPersistence: "not_attempted", receiptPersistence: "not_attempted" });
    expect(beforeJournal.intents).toBe(0);

    const afterRoot = await root("cancel-after");
    const afterJournal = makeJournal();
    const afterController = new AbortController();
    const after = await transferOperationArtifact(makeOptions(afterRoot, afterJournal, {
      signal: afterController.signal,
      openSource: async () => {
        throw new Error("source must not open after cancellation");
      },
      journal: {
        readActionState: afterJournal.readActionState,
        persistIntent: async (intent: NonNullable<ArtifactTransferDurableState["intent"]>) => {
          afterController.abort();
          await afterJournal.persistIntent(intent);
        },
        persistReceipt: afterJournal.persistReceipt
      }
    }));
    expect(after).toMatchObject({ outcome: "uncertain", intentPersistence: "durable", receiptPersistence: "durable", receipt: { status: "partial", blockerCode: "operation_cancelled" } });
  });

  it("fails closed on accessors, proxies, and non-native AbortSignals", async () => {
    const destination = await root("hostile");
    const journal = makeJournal();
    const base = makeOptions(destination, journal);
    const accessor = Object.defineProperty({ ...base }, "openSource", { get: () => base.openSource });
    await expect(transferOperationArtifact(accessor as ArtifactTransferOptions)).rejects.toMatchObject({ code: "invalid_options" });
    const proxy = new Proxy(base, { getOwnPropertyDescriptor: () => { throw new Error("trap"); } });
    await expect(transferOperationArtifact(proxy)).rejects.toMatchObject({ code: "invalid_options" });
    const fakeSignal = { aborted: false, addEventListener: () => undefined, removeEventListener: () => undefined };
    await expect(transferOperationArtifact({ ...base, signal: fakeSignal as unknown as AbortSignal })).rejects.toMatchObject({ code: "invalid_options" });
    const sourceProxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("source trap"); } });
    const sourceResult = await transferOperationArtifact({ ...base, openSource: async () => sourceProxy as AsyncIterable<Uint8Array> });
    expect(sourceResult).toMatchObject({ outcome: "uncertain", receipt: { status: "partial" } });
  });

  it("keeps errors and durable JSON free of raw source/path material", async () => {
    const destination = await root("privacy");
    const secret = "private-source-label-should-not-escape";
    const journal = makeJournal();
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      openSource: async () => { throw new Error(`${secret}:${destination}`); }
    }));
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(destination);
    expect(JSON.stringify(journal.persisted)).not.toContain(secret);
    expect(JSON.stringify(journal.persisted)).not.toContain(destination);
  });

  it("treats a receipt without its causal intent as corrupt and never replays it", async () => {
    const destination = await root("receipt-without-intent");
    const sourceJournal = makeJournal();
    const sourceOptions = makeOptions(destination, sourceJournal, { openSource: async () => chunks("causal") });
    const completed = await transferOperationArtifact(sourceOptions);
    const receipt = completed.receipt;
    expect(receipt).toBeDefined();
    if (receipt === undefined) throw new Error("expected durable receipt");

    const corruptJournal = makeJournal({ receipt });
    let sourceOpens = 0;
    const result = await transferOperationArtifact({
      ...sourceOptions,
      journal: journalPort(corruptJournal),
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-open");
      }
    });
    expect(result).toMatchObject({
      outcome: "not_satisfied",
      blockerCode: "operation_state_corrupt",
      intentPersistence: "not_attempted",
      receiptPersistence: "not_attempted"
    });
    expect(sourceOpens).toBe(0);
  });

  it("converges an intent write that commits before throwing", async () => {
    const destination = await root("intent-commit-then-throw");
    const journal = makeJournal();
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      journal: {
        readActionState: journal.readActionState,
        persistIntent: async intent => {
          await journal.persistIntent(intent);
          throw new Error("journal acknowledged too late");
        },
        persistReceipt: journal.persistReceipt
      }
    }));
    expect(result).toMatchObject({
      outcome: "satisfied",
      intentPersistence: "durable",
      receiptPersistence: "durable"
    });
    expect(result.receipt).toEqual(journal.state?.receipt);
    expect(journal.intents).toBe(1);
  });

  it("returns uncertain with indeterminate intent persistence when convergence fails", async () => {
    const destination = await root("intent-indeterminate");
    const journal = makeJournal();
    let sourceOpens = 0;
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      journal: {
        readActionState: journal.readActionState,
        persistIntent: async () => {
          throw new Error("journal unavailable");
        },
        persistReceipt: journal.persistReceipt
      },
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-open");
      }
    }));
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "indeterminate",
      receiptPersistence: "not_attempted",
      blockerCode: "operation_state_corrupt"
    });
    expect(sourceOpens).toBe(0);
  });

  it("converges a receipt write that commits before throwing and returns its exact receipt", async () => {
    const destination = await root("receipt-commit-then-throw");
    const journal = makeJournal();
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      journal: {
        readActionState: journal.readActionState,
        persistIntent: journal.persistIntent,
        persistReceipt: async receipt => {
          await journal.persistReceipt(receipt);
          throw new Error("receipt acknowledgement lost");
        }
      }
    }));
    expect(result).toMatchObject({
      outcome: "satisfied",
      intentPersistence: "durable",
      receiptPersistence: "durable"
    });
    expect(result.receipt).toEqual(journal.state?.receipt);
  });

  it("marks receipt persistence indeterminate when a receipt write cannot be converged", async () => {
    const destination = await root("receipt-indeterminate");
    const journal = makeJournal();
    let receiptAttempts = 0;
    let sourceOpens = 0;
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        sourceOpens += 1;
        return chunks("receipt-persistence");
      },
      journal: {
        readActionState: journal.readActionState,
        persistIntent: journal.persistIntent,
        persistReceipt: async () => {
          receiptAttempts += 1;
          throw new Error("receipt journal unavailable");
        }
      }
    });
    const result = await transferOperationArtifact(options);
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "durable",
      receiptPersistence: "indeterminate",
      blockerCode: "operation_state_corrupt",
      receipt: { status: "transferred" }
    });
    expect(receiptAttempts).toBe(1);
    const retry = await transferOperationArtifact({
      ...options,
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-retry");
      }
    });
    expect(retry).toMatchObject({
      outcome: "uncertain",
      replayed: false,
      intentPersistence: "durable",
      receiptPersistence: "indeterminate",
      receipt: { status: "partial", blockerCode: "artifact_transfer_partial" }
    });
    expect(receiptAttempts).toBe(2);
    expect(sourceOpens).toBe(1);
  });

  it("contains a later malformed clock value without claiming persistence", async () => {
    const destination = await root("clock-malformed");
    const journal = makeJournal();
    let calls = 0;
    let sourceOpens = 0;
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      now: () => {
        calls += 1;
        return calls === 1 ? 0 : Number.NaN;
      },
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-open");
      }
    }));
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "not_attempted",
      receiptPersistence: "not_attempted",
      blockerCode: "operation_state_corrupt"
    });
    expect(sourceOpens).toBe(0);
  });

  it("contains a clock failure after intent without opening the source", async () => {
    const destination = await root("clock-after-intent");
    const journal = makeJournal();
    let calls = 0;
    let sourceOpens = 0;
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      deadlineAt: 1,
      now: () => {
        calls += 1;
        return calls <= 4 ? 0 : Number.NaN;
      },
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-open");
      }
    }));
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "durable",
      receiptPersistence: "not_attempted",
      blockerCode: "operation_state_corrupt"
    });
    expect(sourceOpens).toBe(0);
  });

  it("rejects a backwards clock after intent without inventing an observed receipt time", async () => {
    const destination = await root("clock-backwards-after-intent");
    const journal = makeJournal();
    const samples = [1000, 1000, 1000, 2000, 1500];
    let calls = 0;
    let sourceOpens = 0;
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      now: () => samples[Math.min(calls++, samples.length - 1)]!,
      openSource: async () => {
        sourceOpens += 1;
        return chunks("must-not-open");
      }
    }));
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "durable",
      receiptPersistence: "not_attempted",
      blockerCode: "operation_state_corrupt"
    });
    expect(result.receipt).toBeUndefined();
    expect(journal.state?.intent).toBeDefined();
    expect(journal.state?.receipt).toBeUndefined();
    expect(sourceOpens).toBe(0);
  });

  it("forwards the transfer deadline and guarded clock to the local commit", async () => {
    const destination = await root("deadline-forwarding");
    const journal = makeJournal();
    let calls = 0;
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      deadlineAt: 1005,
      now: () => {
        calls += 1;
        return calls <= 5 ? 1000 : 1005;
      },
      openSource: async () => chunks("deadline-crossed")
    }));
    expect(result).toMatchObject({
      outcome: "uncertain",
      intentPersistence: "durable",
      receiptPersistence: "durable",
      receipt: { status: "partial" }
    });
    // A preflight deadline crossing has no observed stream prefix.  Its
    // placeholder zero/empty digest must not become durable transfer data.
    expect(result.receipt).not.toHaveProperty("bytes");
    expect(result.receipt).not.toHaveProperty("sha256");
    expect(await readdir(destination)).toEqual([]);
  });

  it("passes immutable snapshots to source and journal callbacks and returns immutable receipts", async () => {
    const destination = await root("immutable-callback-records");
    const baseJournal = makeJournal();
    let seenLookup: unknown;
    let seenIntent: unknown;
    let seenReceipt: unknown;
    let seenSourceRequest: unknown;
    const options = makeOptions(destination, baseJournal, {
      openSource: async request => {
        seenSourceRequest = request;
        expect(Object.isFrozen(request)).toBe(true);
        return chunks("immutable");
      },
      journal: {
        readActionState: async lookup => {
          seenLookup = lookup;
          expect(Object.isFrozen(lookup)).toBe(true);
          return baseJournal.readActionState(lookup);
        },
        persistIntent: async intent => {
          seenIntent = intent;
          expect(Object.isFrozen(intent)).toBe(true);
          await baseJournal.persistIntent(intent);
        },
        persistReceipt: async receipt => {
          seenReceipt = receipt;
          expect(Object.isFrozen(receipt)).toBe(true);
          await baseJournal.persistReceipt(receipt);
        }
      }
    });
    const result = await transferOperationArtifact(options);
    expect(result.outcome).toBe("satisfied");
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(Object.isFrozen(result.receipt)).toBe(true);
    expect(Object.isFrozen(seenLookup)).toBe(true);
    expect(Object.isFrozen(seenIntent)).toBe(true);
    expect(Object.isFrozen(seenReceipt)).toBe(true);
    expect(Object.isFrozen(seenSourceRequest)).toBe(true);
    expect(Reflect.set(seenSourceRequest as object, "assistantTurnId", "tampered")).toBe(false);
    expect((result.receipt as ArtifactTransferReceiptV1).status).toBe("transferred");
  });

  it("closes a failing source iterator before returning and does not expose its chunk alias", async () => {
    const destination = await root("iterator-cleanup");
    const journal = makeJournal();
    const events: string[] = [];
    let calls = 0;
    const chunk = Buffer.from("stable-prefix");
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            calls += 1;
            if (calls === 1) {
              setTimeout(() => chunk.fill(0x78), 0);
              return { done: false, value: chunk };
            }
            throw new Error("late source failure");
          },
          return: async () => {
            events.push("return");
            await new Promise<void>(resolve => setTimeout(resolve, 5));
            events.push("closed");
            return { done: true, value: undefined };
          }
        };
      }
    };
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      openSource: async () => source
    }));
    expect(result).toMatchObject({ outcome: "uncertain", receipt: { status: "partial", bytes: chunk.byteLength } });
    expect(events).toEqual(["return", "closed"]);
    expect(JSON.stringify(result)).not.toContain("late source failure");
  });

  it("copies an accepted chunk before the provider can mutate its buffer", async () => {
    const destination = await root("chunk-copy");
    const journal = makeJournal();
    const chunk = Buffer.from("copy-before-await");
    let yielded = false;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            if (yielded) return { done: true, value: undefined };
            yielded = true;
            setTimeout(() => chunk.fill(0x78), 0);
            return { done: false, value: chunk };
          }
        };
      }
    };
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      openSource: async () => source
    }));
    expect(result.outcome).toBe("satisfied");
    const outputKey = result.receipt?.outputKey;
    expect(outputKey).toBeDefined();
    if (outputKey === undefined) throw new Error("expected output key");
    expect(await readFile(join(destination, outputKey))).toEqual(Buffer.from("copy-before-await"));
  });

  it("rejects an oversized transfer chunk before copying it", async () => {
    const destination = await root("oversized-chunk");
    const journal = makeJournal();
    const oversized = new Uint8Array((8 * 1024 * 1024) + 1);
    const result = await transferOperationArtifact(makeOptions(destination, journal, {
      limits: { maxBytes: 512 * 1024 * 1024 },
      openSource: async () => (async function*(): AsyncGenerator<Uint8Array> {
        yield oversized;
      })()
    }));
    expect(result).toMatchObject({ outcome: "uncertain", receipt: { status: "partial", bytes: 0 } });
    expect(await readdir(destination)).not.toContain(result.receipt?.outputKey);
  });

  it("keeps an acts-then-throws source boundary non-repeatable", async () => {
    const destination = await root("source-acts-then-throws");
    const journal = makeJournal();
    let opens = 0;
    const options = makeOptions(destination, journal, {
      openSource: async () => {
        opens += 1;
        throw new Error("provider handed off but acknowledged too late");
      }
    });
    const first = await transferOperationArtifact(options);
    const second = await transferOperationArtifact({ ...options, openSource: async () => { opens += 1; return chunks("retry"); } });
    expect(first).toMatchObject({ outcome: "uncertain", receipt: { status: "partial" } });
    expect(first.receipt).not.toHaveProperty("bytes");
    expect(first.receipt).not.toHaveProperty("sha256");
    expect(second).toMatchObject({ outcome: "uncertain", replayed: true, receipt: { status: "partial" } });
    expect(opens).toBe(1);
  });

  it("fails closed on a malformed durable record with accessor-backed data", async () => {
    const destination = await root("malformed-durable-record");
    const base = makeOptions(destination, makeJournal());
    const corruptJournal: ArtifactTransferOptions["journal"] = {
      readActionState: async () => ({
        intent: Object.defineProperty({}, "schemaVersion", { get: () => "private" })
      }),
      persistIntent: async () => undefined,
      persistReceipt: async () => undefined
    };
    const result = await transferOperationArtifact({ ...base, journal: corruptJournal });
    expect(result).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_state_corrupt" });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("rejects a durable receipt observed before its causal intent", async () => {
    const destination = await root("receipt-before-intent");
    const sourceJournal = makeJournal();
    const sourceOptions = makeOptions(destination, sourceJournal, { openSource: async () => chunks("causal-order") });
    const completed = await transferOperationArtifact(sourceOptions);
    expect(completed.receipt).toBeDefined();
    expect(sourceJournal.state?.intent).toBeDefined();
    if (completed.receipt === undefined || sourceJournal.state?.intent === undefined) throw new Error("expected durable transfer state");
    const corruptJournal = makeJournal({
      intent: { ...sourceJournal.state.intent, intentAt: "2100-01-01T00:00:00.000Z" },
      receipt: completed.receipt
    });
    const result = await transferOperationArtifact({
      ...sourceOptions,
      journal: journalPort(corruptJournal),
      openSource: async () => chunks("must-not-open")
    });
    expect(result).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_state_corrupt" });
  });

  it("rejects unknown keys in options, limits, and journal records", async () => {
    const destination = await root("unknown-keys");
    const journal = makeJournal();
    const base = makeOptions(destination, journal);
    await expect(transferOperationArtifact({ ...base, extra: true } as ArtifactTransferOptions & { extra: boolean }))
      .rejects.toMatchObject({ code: "invalid_options" });
    await expect(transferOperationArtifact({ ...base, limits: { maxBytes: 1024, extra: true } } as ArtifactTransferOptions))
      .rejects.toMatchObject({ code: "invalid_options" });
    await expect(transferOperationArtifact({
      ...base,
      journal: { ...journalPort(journal), extra: true }
    } as ArtifactTransferOptions))
      .rejects.toMatchObject({ code: "invalid_options" });
  });

  it("includes maxBytes in in-flight semantic identity", async () => {
    const destination = await root("max-bytes-identity");
    const journal = makeJournal();
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    let sourceOpens = 0;
    const first = makeOptions(destination, journal, {
      limits: { maxBytes: 1024 },
      openSource: async () => {
        sourceOpens += 1;
        await gate;
        return chunks("same-action");
      }
    });
    const left = transferOperationArtifact(first);
    await Promise.resolve();
    const right = transferOperationArtifact({ ...first, limits: { maxBytes: 2048 } });
    const conflict = await right;
    expect(conflict).toMatchObject({ outcome: "not_satisfied", blockerCode: "operation_request_mismatch" });
    release();
    await left;
    expect(sourceOpens).toBe(1);
  });
});
