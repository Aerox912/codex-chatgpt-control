import type { LocatorLike, PageLike } from "../types.js";
import { localeLabels } from "../dom/locale-labels.js";
import {
  createProductionAttachmentPrimitive,
  type ProductionAttachmentActivation,
  type ProductionAttachmentPrimitive,
  type ProductionAttachmentPrimitiveOptions,
  type ProductionAttachmentPreparationResult,
  type ProductionAttachmentSurfaceRead
} from "./production-attachments.js";
import type { BrowserObservationDigest } from "./browser-observation.js";
import type { OperationFileIdentity, OperationFileManifestEntryV1 } from "./file-identity.js";
import type {
  SubmissionAttachmentObservation,
  SubmissionAttachmentRequest,
  SubmissionHandoffRequest,
  SubmissionHandoffResult
} from "./submission.js";
import type { OperationTargetBindingV1 } from "./types.js";

/**
 * Options for the ChatGPT-specific attachment provider.
 *
 * This adapter deliberately composes the provider-neutral attachment
 * primitive.  It only supplies bounded, semantic ChatGPT DOM callbacks; the
 * primitive retains ownership of the one-shot chooser state machine and of
 * all request-local file paths.
 */
export type ChatGPTAttachmentProviderOptions = Readonly<{
  evidenceDigest: BrowserObservationDigest;
  files: readonly OperationFileIdentity[];
  identityDigest: (ordinal: number, manifest: OperationFileManifestEntryV1) => string;
  revalidateFile: (identity: OperationFileIdentity) => Promise<void>;
  timeoutMs?: number;
  maxCandidates?: number;
  /** Optional BCP-47 tag used only to select locale-aware DOM labels. */
  locale?: string;
  /** Request-local cancellation.  It is never serialized or returned. */
  signal?: AbortSignal;
}>;

/** The resulting capability is the same narrow surface as the core primitive. */
export type ChatGPTAttachmentProvider = ProductionAttachmentPrimitive;

export const CHATGPT_ATTACHMENT_PROVIDER_SCHEMA_VERSION =
  "chatgpt.browser_control.production_chatgpt_attachments.v1" as const;

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/u;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/u;
const SELECTOR_PATTERN = /^[A-Za-z0-9_#.:>\[\]="'()*^$|~+=\\ -]{1,4096}$/u;
const LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/u;
const MAX_PROBE_ITEMS = 256;
const MAX_PROBE_TEXT = 512;
const MAX_TIMEOUT_MS = 30_000;
const CAPABILITY_KEY = "chatgpt.attachments.active-composer";

type CausalHandoff = Readonly<{
  operationId: string;
  requestDigest: string;
  actionId: string;
  targetBindingDigest: string;
  manifest: Readonly<{
    count: number;
    identities: readonly { identityDigest: string; ordinal: number }[];
  }>;
  manifestFacts: readonly OperationFileManifestEntryV1[];
  target: Readonly<OperationTargetBindingV1>;
}>;

type CausalHandoffRequest = Readonly<{
  operationId: string;
  requestDigest: string;
  surface: SubmissionHandoffRequest["surface"];
  actionId: string;
  targetBindingDigest: string;
  manifest: Readonly<{
    count: number;
    orderPolicy: "exact";
    identities: readonly { identityDigest: string; ordinal: number }[];
  }>;
}>;

type RawAttachmentFact = Readonly<{
  ordinal: number;
  namePresent: boolean;
  sizePresent: boolean;
  nameMatch?: boolean;
  bytesMatch?: boolean;
  matchOrdinal?: number;
  ambiguous?: boolean;
  orderKey?: number;
}>;

type RawComposerProbe = Readonly<{
  status: "ready" | "ambiguous" | "unavailable";
  composerCount: number;
  fileInputCount: number;
  inputFilesReadable: boolean;
  attachmentRegionCount: number;
  facts: readonly RawAttachmentFact[];
  secondaryFacts: readonly RawAttachmentFact[];
  factSource: "input" | "metadata" | "none" | "mixed";
  orderDeterministic: boolean;
  directActivationSelector?: string;
  menuOpenerSelector?: string;
  menuUploadSelector?: string;
  activationCandidateCount: number;
}>;

type ComposerProbe = Readonly<{
  status: RawComposerProbe["status"];
  composerCount: number;
  fileInputCount: number;
  inputFilesReadable: boolean;
  attachmentRegionCount: number;
  facts: readonly RawAttachmentFact[];
  secondaryFacts: readonly RawAttachmentFact[];
  factSource: RawComposerProbe["factSource"];
  orderDeterministic: boolean;
  directActivationSelector?: string;
  menuOpenerSelector?: string;
  menuUploadSelector?: string;
  activationCandidateCount: number;
}>;

type ExpectedBrowserFact = Readonly<{
  ordinal: number;
  displayName: string;
  bytes: number;
}>;

/**
 * Build a request-scoped ChatGPT attachment capability.
 *
 * Important recovery property: a non-empty exact observation is impossible
 * until this exact returned capability has completed its own chooser handoff.
 * A fresh provider instance observing an existing/same-name attachment stays
 * ambiguous, including after a process restart.
 */
export function createChatGPTAttachmentProvider(
  options: ChatGPTAttachmentProviderOptions
): ChatGPTAttachmentProvider {
  const normalized = normalizeOptions(options);
  let causalHandoff: CausalHandoff | undefined;
  let menuOpened = false;

  const expectedFactsForRequest = (
    request: SubmissionAttachmentRequest | SubmissionHandoffRequest
  ): readonly ExpectedBrowserFact[] | undefined => {
    const facts: ExpectedBrowserFact[] = [];
    for (const entry of request.manifest.identities) {
      if (entry.ordinal < 0 || entry.ordinal >= normalized.manifestFacts.length
        || normalized.identityDigests[entry.ordinal] !== entry.identityDigest) return undefined;
      const manifest = normalized.manifestFacts[entry.ordinal];
      if (manifest === undefined) return undefined;
      facts.push(Object.freeze({
        ordinal: entry.ordinal,
        displayName: manifest.displayName,
        bytes: manifest.bytes
      }));
    }
    return Object.freeze(facts);
  };

  const recordCausalHandoff = (
    request: CausalHandoffRequest,
    target: OperationTargetBindingV1
  ): void => {
    causalHandoff = Object.freeze({
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      actionId: request.actionId,
      targetBindingDigest: request.targetBindingDigest,
      manifest: Object.freeze({
        count: request.manifest.count,
        identities: Object.freeze(request.manifest.identities.map(entry => Object.freeze({
          identityDigest: entry.identityDigest,
          ordinal: entry.ordinal
        })))
      }),
      manifestFacts: normalized.manifestFacts,
      target: Object.freeze({ ...target })
    });
  };

  const probe = async (
    page: Readonly<PageLike>,
    expected?: readonly ExpectedBrowserFact[],
    requestSignal?: AbortSignal,
    requestDeadlineAt?: number
  ): Promise<ComposerProbe | undefined> => {
    if (isAnyAbortRequested(normalized.signal, requestSignal, requestDeadlineAt)) return undefined;
    const timeoutMs = boundedProbeTimeout(normalized.timeoutMs, requestDeadlineAt);
    if (timeoutMs <= 0) return undefined;
    const result = await readComposerProbe(
      page,
      timeoutMs,
      normalized.labelCandidates,
      requestSignal ?? normalized.signal,
      expected
    );
    return isAnyAbortRequested(normalized.signal, requestSignal, requestDeadlineAt) ? undefined : result;
  };

  const observeSurface = async (
    request: SubmissionAttachmentRequest,
    page: Readonly<PageLike>,
    target: OperationTargetBindingV1
  ): Promise<ProductionAttachmentSurfaceRead> => {
    if (normalized.signal?.aborted) return { status: "unavailable", source: "live_surface" };
    const current = await probe(page, expectedFactsForRequest(request));
    if (current === undefined || current.status !== "ready" || !isSafeTarget(target)) {
      return { status: "unavailable", source: "live_surface" };
    }
    const baseMaterial = surfaceEvidenceMaterial(request, target, current);
    if (current.facts.length === 0 && current.attachmentRegionCount === 0
      && current.inputFilesReadable && current.fileInputCount === 1) {
      const evidence = safeEvidence(normalized.evidenceDigest, "chatgpt-attachment-surface", {
        ...baseMaterial,
        status: "absent",
        count: 0
      });
      return evidence === undefined
        ? { status: "unavailable", source: "live_surface" }
        : {
            status: "absent",
            source: "live_surface",
            count: 0,
            identityDigests: [],
            providerEvidenceDigest: evidence
          };
    }

    const causal = causalHandoff;
    if (causal === undefined || !sameCausalRequest(causal, request, target)) {
      return evidenceStatus(normalized.evidenceDigest, baseMaterial, "ambiguous", current.facts.length);
    }

    const match = compareCausalSurface(current, causal, request);
    const evidence = safeEvidence(normalized.evidenceDigest, "chatgpt-attachment-surface", {
      ...baseMaterial,
      status: match.status,
      count: current.facts.length,
      factsMatch: match.factsMatch,
      multiplicityMatch: match.multiplicityMatch,
      orderDeterministic: current.orderDeterministic,
      duplicateNames: match.duplicateNames
    });
    if (match.status !== "exact") {
      return evidence === undefined
        ? { status: match.status, source: "live_surface" }
        : { status: match.status, source: "live_surface", providerEvidenceDigest: evidence };
    }
    return evidence === undefined
      ? { status: "unavailable", source: "live_surface" }
      : {
          status: "exact",
          source: "live_surface",
          count: request.manifest.count,
          identityDigests: request.manifest.identities.map(entry => entry.identityDigest),
          providerEvidenceDigest: evidence
        };
  };

  const prepareActivation = async (
    request: SubmissionHandoffRequest,
    page: Readonly<PageLike>,
    target: OperationTargetBindingV1,
    preparationOptions: Readonly<{ timeoutMs: number }>
  ): Promise<ProductionAttachmentPreparationResult> => {
    // The provider-level lifetime signal predates the one-shot request and
    // retains its historical pre-mutation blocker. A caller/coordinator signal
    // arrives after the durable intent and therefore must quarantine instead.
    if (normalized.signal?.aborted) return { status: "not_satisfied", blockerCode: "operation_timeout" };
    if (request.signal?.aborted || request.deadlineAt !== undefined && Date.now() >= request.deadlineAt) {
      return { status: "uncertain", quarantine: "caller" };
    }
    if (preparationOptions.timeoutMs <= 0) return { status: "not_satisfied", blockerCode: "operation_timeout" };
    const current = await probe(page, expectedFactsForRequest(request), request.signal, request.deadlineAt);
    if (current === undefined || current.status !== "ready" || !isSafeTarget(target)) {
      return { status: "not_satisfied", blockerCode: "selector_drift" };
    }
    // The only safe precondition for a first handoff is an unambiguously empty
    // active composer. Existing same-name chips are not treated as success.
    if (current.facts.length !== 0 || current.attachmentRegionCount !== 0
      || !current.inputFilesReadable || current.fileInputCount !== 1) {
      return { status: "not_satisfied", blockerCode: "ambiguous_file_handoff" };
    }
    const material = {
      operationId: request.operationId,
      requestDigest: request.requestDigest,
      actionId: request.actionId,
      targetBindingDigest: request.targetBindingDigest,
      status: "prepared",
      empty: true,
      activationCandidateCount: current.activationCandidateCount,
      menu: current.menuOpenerSelector !== undefined
    };
    const evidence = safeEvidence(normalized.evidenceDigest, "chatgpt-attachment-precondition", material);
    if (evidence === undefined) return { status: "uncertain", quarantine: "provider" };

    // Some ChatGPT rollouts expose only a localized plus-menu opener. The
    // semantic probe has already proved it is in the active composer; click it
    // once here so the final resolver can identify the menu's file row. The
    // core primitive still owns the chooser waiter and all file mutation.
    if (current.directActivationSelector === undefined && current.menuOpenerSelector !== undefined) {
      const opener = locatorFor(page, current.menuOpenerSelector);
      if (opener === undefined) return { status: "not_satisfied", blockerCode: "selector_drift" };
      const click = safeMethod(opener, "click");
      if (click === undefined) return { status: "not_satisfied", blockerCode: "selector_drift" };
      try {
        const result = click.call(opener, {
          timeout: preparationOptions.timeoutMs,
          timeoutMs: preparationOptions.timeoutMs
        });
        await awaitMutating(result);
        menuOpened = true;
      } catch {
        // A click may have opened the menu before the bridge rejected. The
        // final resolver may still prove a unique row; never retry the opener.
        menuOpened = true;
        return { status: "uncertain", quarantine: "provider" };
      }
      if (isAnyAbortRequested(normalized.signal, request.signal, request.deadlineAt)) {
        return { status: "uncertain", quarantine: "caller" };
      }
      const afterMenu = await probe(page, expectedFactsForRequest(request), request.signal, request.deadlineAt);
      if (afterMenu === undefined || afterMenu.menuUploadSelector === undefined
        || afterMenu.activationCandidateCount !== 1) {
        return { status: "uncertain", quarantine: "provider" };
      }
    }
    return { status: "prepared", providerEvidenceDigest: evidence };
  };

  const resolveActivation = async (
    request: SubmissionHandoffRequest,
    page: Readonly<PageLike>,
    target: OperationTargetBindingV1
  ): Promise<ProductionAttachmentActivation | undefined> => {
    if (isAnyAbortRequested(normalized.signal, request.signal, request.deadlineAt) || !isSafeTarget(target)) return undefined;
    const current = await probe(page, expectedFactsForRequest(request), request.signal, request.deadlineAt);
    if (current === undefined || current.status !== "ready") return undefined;
    const selector = menuOpened
      ? current.menuUploadSelector
      : current.directActivationSelector;
    if (selector === undefined || current.activationCandidateCount !== 1) return undefined;
    const locator = locatorFor(page, selector);
    if (locator === undefined) return undefined;
    return { locator, candidateCount: 1, capabilityKey: CAPABILITY_KEY };
  };

  const primitiveOptions: ProductionAttachmentPrimitiveOptions = {
    evidenceDigest: normalized.evidenceDigest,
    files: normalized.files,
    identityDigest: normalized.identityDigest,
    revalidateFile: normalized.revalidateFile,
    observeSurface,
    resolveActivation,
    prepareActivation
  };
  const primitive = createProductionAttachmentPrimitive({
    ...primitiveOptions,
    ...(normalized.timeoutWasProvided ? { timeoutMs: normalized.timeoutMs } : {}),
    ...(normalized.maxCandidatesWasProvided ? { maxCandidates: normalized.maxCandidates } : {})
  });

  const handoffFiles = async (
    request: SubmissionHandoffRequest,
    page: Readonly<PageLike>,
    target: OperationTargetBindingV1
  ): Promise<SubmissionHandoffResult> => {
    // Capture the request envelope before any provider callback can re-enter
    // the caller and mutate its manifest while the native chooser operation is
    // in flight. The core still performs its own validation; this snapshot is
    // only the immutable causal record installed after a satisfied handoff.
    const causalRequest = snapshotHandoffRequest(request);
    const causalTarget = snapshotTargetBinding(target);
    const result = await primitive.handoffFiles(request, page, target);
    if (result.status === "satisfied" && causalRequest !== undefined && causalTarget !== undefined) {
      recordCausalHandoff(causalRequest, causalTarget);
    }
    return result;
  };

  const handoffFilesForAdapter = async (
    request: SubmissionHandoffRequest,
    files: readonly OperationFileIdentity[],
    page: Readonly<PageLike>,
    target: OperationTargetBindingV1
  ): Promise<SubmissionHandoffResult> => {
    const causalRequest = snapshotHandoffRequest(request);
    const causalTarget = snapshotTargetBinding(target);
    const result = await primitive.handoffFilesForAdapter(request, files, page, target);
    if (result.status === "satisfied" && causalRequest !== undefined && causalTarget !== undefined) {
      recordCausalHandoff(causalRequest, causalTarget);
    }
    return result;
  };

  return Object.freeze({
    observeAttachments: primitive.observeAttachments,
    handoffFiles,
    handoffFilesForAdapter
  });
}

export const createProductionChatGPTAttachments = createChatGPTAttachmentProvider;
export const createChatGPTProductionAttachmentPrimitive = createChatGPTAttachmentProvider;

function normalizeOptions(value: ChatGPTAttachmentProviderOptions): Readonly<{
  evidenceDigest: BrowserObservationDigest;
  files: readonly OperationFileIdentity[];
  identityDigest: ChatGPTAttachmentProviderOptions["identityDigest"];
  identityDigests: readonly string[];
  revalidateFile: ChatGPTAttachmentProviderOptions["revalidateFile"];
  timeoutMs: number;
  maxCandidates: number;
  timeoutWasProvided: boolean;
  maxCandidatesWasProvided: boolean;
  manifestFacts: readonly OperationFileManifestEntryV1[];
  locale?: string;
  signal?: AbortSignal;
  labelCandidates: readonly string[];
}> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid ChatGPT attachment provider options");
  assertOwnDataKeys(value, ["evidenceDigest", "files", "identityDigest", "revalidateFile", "timeoutMs", "maxCandidates", "locale", "signal"]);
  const evidenceDigest = readOwn<BrowserObservationDigest>(value, "evidenceDigest");
  const files = readOwn<readonly OperationFileIdentity[]>(value, "files");
  const identityDigest = readOwn<ChatGPTAttachmentProviderOptions["identityDigest"]>(value, "identityDigest");
  const revalidateFile = readOwn<ChatGPTAttachmentProviderOptions["revalidateFile"]>(value, "revalidateFile");
  const timeoutValue = readOwn<number>(value, "timeoutMs");
  const maxCandidatesValue = readOwn<number>(value, "maxCandidates");
  const locale = readOwn<string>(value, "locale");
  const signal = readOwn<AbortSignal>(value, "signal");
  if (typeof evidenceDigest !== "function" || !Array.isArray(files)
    || typeof identityDigest !== "function" || typeof revalidateFile !== "function") {
    throw new Error("invalid ChatGPT attachment provider options");
  }
  const timeoutMs = timeoutValue ?? 5_000;
  const maxCandidates = maxCandidatesValue ?? 128;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 512) {
    throw new Error("invalid ChatGPT attachment provider options");
  }
  if (locale !== undefined && (typeof locale !== "string" || !LOCALE_PATTERN.test(locale))) {
    throw new Error("invalid ChatGPT attachment provider options");
  }
  if (signal !== undefined && !isAbortSignal(signal)) throw new Error("invalid ChatGPT attachment provider options");
  const labels = Object.freeze([...new Set([
    ...localeLabels.addFilesOpenerCandidates,
    ...localeLabels.addPhotosFilesMenuItem,
    ...localeLabels.projectSourcesUploadFiles
  ].filter(label => typeof label === "string" && label.length > 0 && label.length <= MAX_PROBE_TEXT))]);
  const snapshot = snapshotFileIdentities(files);
  const identityDigestSet = new Set<string>();
  const identityDigests = Object.freeze(snapshot.map((file, ordinal) => {
    let digest: string;
    try {
      digest = identityDigest(ordinal, file.manifest);
    } catch {
      throw new Error("invalid ChatGPT attachment provider options");
    }
    if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
      throw new Error("invalid ChatGPT attachment provider options");
    }
    if (identityDigestSet.has(digest)) throw new Error("invalid ChatGPT attachment provider options");
    identityDigestSet.add(digest);
    return digest;
  }));
  const stableIdentityDigest = (ordinal: number, _manifest: OperationFileManifestEntryV1): string => {
    const digest = identityDigests[ordinal];
    if (digest === undefined) throw new Error("invalid ChatGPT attachment provider options");
    return digest;
  };
  return Object.freeze({
    evidenceDigest,
    files: snapshot,
    identityDigest: stableIdentityDigest,
    identityDigests,
    revalidateFile,
    timeoutMs,
    maxCandidates,
    timeoutWasProvided: timeoutValue !== undefined,
    maxCandidatesWasProvided: maxCandidatesValue !== undefined,
    manifestFacts: Object.freeze(snapshot.map(file => Object.freeze({ ...file.manifest }))),
    ...(locale === undefined ? {} : { locale }),
    ...(signal === undefined ? {} : { signal }),
    labelCandidates: labels
  });
}

async function readComposerProbe(
  page: Readonly<PageLike>,
  timeoutMs: number,
  labelCandidates: readonly string[],
  signal: AbortSignal | undefined,
  expected: readonly ExpectedBrowserFact[] | undefined
): Promise<ComposerProbe | undefined> {
  if (signal?.aborted) return undefined;
  const evaluate = safeMethod(page, "evaluate");
  if (evaluate === undefined) return undefined;
  let raw: unknown;
  try {
    raw = evaluate.call(page, inspectChatGPTComposer, {
      labels: [...labelCandidates],
      ...(expected === undefined ? {} : {
        expected: expected.map(fact => ({
          ordinal: fact.ordinal,
          displayName: fact.displayName,
          bytes: fact.bytes
        }))
      })
    }, { timeout: timeoutMs });
    raw = await boundedNative(raw, timeoutMs);
  } catch {
    return undefined;
  }
  return normalizeProbe(raw);
}

/**
 * This function is serialized into the page. It uses HTML/ARIA structure as
 * the primary semantic contract and only uses the verified locale registry as
 * a text fallback for localized menu rows. It returns no raw labels, URLs,
 * prompts, account data, or file paths.
 */
function inspectChatGPTComposer(argument: unknown): RawComposerProbe {
  // Keep this evaluator self-contained. Browser bridges serialize only this
  // function; module-scope helpers would be undefined in the page realm.
  const record = argument !== null && typeof argument === "object" && !Array.isArray(argument)
    ? argument as Record<string, unknown>
    : {};
  const labels = Array.isArray(record.labels)
    ? record.labels.filter((label): label is string => typeof label === "string" && label.length <= 512)
    : [];
  const expected: Array<{ ordinal: number; displayName: string; bytes: number }> = [];
  if (Array.isArray(record.expected)) {
    if (record.expected.length > MAX_PROBE_ITEMS) throw new Error("probe limit exceeded");
    for (const item of record.expected) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.ordinal !== "number" || !Number.isSafeInteger(entry.ordinal)
        || typeof entry.displayName !== "string" || entry.displayName.length === 0 || entry.displayName.length > 512
        || typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) continue;
      expected.push({ ordinal: entry.ordinal, displayName: entry.displayName.normalize("NFC"), bytes: entry.bytes });
    }
    expected.sort((left, right) => left.ordinal - right.ordinal);
  }
  const boundedQuery = <T extends Element>(
    root: Node,
    selector: string,
    maxMatched = MAX_PROBE_ITEMS,
    maxVisited = 4096
  ): T[] => {
    const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument;
    if (ownerDocument === null || typeof ownerDocument.createTreeWalker !== "function") {
      throw new Error("DOM traversal unavailable");
    }
    // Count text/comment nodes as well as elements; only elements can match.
    const walker = ownerDocument.createTreeWalker(root, 0xffffffff);
    const matches: T[] = [];
    let visited = 0;
    let current = walker.nextNode();
    while (current !== null) {
      visited += 1;
      if (visited > maxVisited) throw new Error("probe limit exceeded");
      const element = current.nodeType === 1 ? current as Element : undefined;
      if (element !== undefined && element.matches(selector)) {
        matches.push(element as T);
        if (matches.length > maxMatched) throw new Error("probe limit exceeded");
      }
      current = walker.nextNode();
    }
    return matches;
  };
  const boundedText = (node: Element): string => {
    const chunks: string[] = [];
    const ancestors: Node[] = [];
    let visited = 0;
    let total = 0;
    let current: Node | null = node;
    while (current !== null) {
      visited += 1;
      if (visited > 4096) throw new Error("probe limit exceeded");
      if (current.nodeType === 3) {
        const value = current.nodeValue ?? "";
        total += value.length;
        if (total > MAX_PROBE_TEXT) throw new Error("probe text limit exceeded");
        if (value.length > 0) chunks.push(value);
      }
      const child: Node | null = current.firstChild;
      if (child !== null) {
        if (ancestors.length >= 4096) throw new Error("probe limit exceeded");
        ancestors.push(current);
        current = child;
        continue;
      }
      while (current !== null && current !== node && current.nextSibling === null) current = ancestors.pop() ?? null;
      if (current === node) break;
      if (current !== null) current = current.nextSibling;
    }
    return chunks.join("").replace(/\s+/gu, " ").trim().normalize("NFC");
  };
  const boundedAttribute = (element: Element, name: string): string => {
    const value = element.getAttribute(name) ?? "";
    if (value.length > MAX_PROBE_TEXT) throw new Error("probe text limit exceeded");
    return value;
  };
  const unique = (values: readonly Element[]): Element[] => [...new Set(values)];
  const visible = (element: Element): boolean => {
    const html = element as HTMLElement;
    if (html.hidden || html.closest("[hidden], [inert], [aria-hidden='true']") !== null) return false;
    const style = window.getComputedStyle(html);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = html.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  };
  const semanticControl = (element: Element): boolean => {
    const structural = [
      boundedAttribute(element, "data-testid"),
      boundedAttribute(element, "data-test-id"),
      boundedAttribute(element, "data-action"),
      boundedAttribute(element, "id"),
      boundedAttribute(element, "class")
    ].join(" ").toLocaleLowerCase();
    if (/attach|upload|file|document|photo|image/u.test(structural)) return true;
    const accessible = [
      boundedAttribute(element, "aria-label"),
      boundedAttribute(element, "title"),
      boundedText(element)
    ].join(" ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
    return labels.some(label => accessible.includes(label.toLocaleLowerCase()));
  };
  const cssPath = (element: Element): string => {
    const segments: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current !== null && depth < 24; depth += 1) {
      const id = current.getAttribute("id");
      if (id !== null && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(id)) {
        segments.unshift(`#${id}`);
        break;
      }
      const parent: Element | null = current.parentElement;
      if (parent === null) {
        segments.unshift(current.tagName.toLocaleLowerCase());
        break;
      }
      let ordinal = 0;
      let sibling: Element | null = parent.firstElementChild;
      while (sibling !== null) {
        if (sibling.tagName === current.tagName) {
          ordinal += 1;
          if (sibling === current) break;
        }
        sibling = sibling.nextElementSibling;
      }
      if (ordinal === 0 || ordinal > MAX_PROBE_ITEMS) throw new Error("probe limit exceeded");
      segments.unshift(`${current.tagName.toLocaleLowerCase()}:nth-of-type(${ordinal})`);
      current = parent;
    }
    return segments.join(" > ");
  };
  const textOf = (element: Element): string => [
    boundedAttribute(element, "data-file-name"),
    boundedAttribute(element, "data-filename"),
    boundedAttribute(element, "aria-label"),
    boundedAttribute(element, "title"),
    boundedText(element)
  ].join(" ").replace(/\s+/gu, " ").trim().normalize("NFC").slice(0, 512);
  const parseBytes = (element: Element, text: string): number | undefined => {
    const dataSize = element.getAttribute("data-file-size") ?? element.getAttribute("data-size");
    if (dataSize !== null && /^\d+$/u.test(dataSize)) {
      const value = Number(dataSize);
      if (Number.isSafeInteger(value)) return value;
    }
    const match = /(?:^|[\s(])([0-9]+(?:\.[0-9]+)?)\s*(bytes?|B|KiB|KB|MiB|MB|GiB|GB)(?:$|[\s),])/iu.exec(text);
    if (match === null) return undefined;
    const amount = Number(match[1]);
    const unit = match[2]?.toLocaleLowerCase();
    const multiplier = unit === "b" || unit === "byte" || unit === "bytes" ? 1
      : unit === "kib" ? 1024
      : unit === "kb" ? 1000
      : unit === "mib" ? 1024 * 1024
      : unit === "mb" ? 1000 * 1000
      : unit === "gib" ? 1024 * 1024 * 1024
      : unit === "gb" ? 1000 * 1000 * 1000
      : undefined;
    if (multiplier === undefined) return undefined;
    const value = amount * multiplier;
    return Number.isSafeInteger(value) ? value : undefined;
  };
  const makeFact = (ordinal: number, name: string | undefined, bytes: number | undefined, orderKey: number): RawAttachmentFact => {
    const namePresent = name !== undefined && name.length > 0;
    const sizePresent = bytes !== undefined;
    if (expected.length === 0) return { ordinal, namePresent, sizePresent, orderKey };
    const nameMatches = namePresent
      ? expected.filter(item => name!.includes(item.displayName))
      : [];
    const nameMatch = nameMatches.length === 1;
    const matched = nameMatch ? nameMatches[0] : undefined;
    const bytesMatch = matched === undefined || !sizePresent ? undefined : bytes === matched.bytes;
    const ambiguous = nameMatches.length > 1;
    const matchOrdinal = matched === undefined || bytesMatch === false ? -1 : matched.ordinal;
    return {
      ordinal,
      namePresent,
      sizePresent,
      nameMatch,
      ...(bytesMatch === undefined ? {} : { bytesMatch }),
      matchOrdinal,
      ...(ambiguous ? { ambiguous: true } : {}),
      orderKey
    };
  };
  const inputFacts = (input: HTMLInputElement): Readonly<{ readable: boolean; facts: readonly RawAttachmentFact[] }> => {
    const files = input.files;
    if (files === null) return { readable: false, facts: [] };
    if (files.length > MAX_PROBE_ITEMS) throw new Error("probe limit exceeded");
    const facts: RawAttachmentFact[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files.item(index);
      if (file === null) return { readable: false, facts: [] };
      const name = typeof file.name === "string" && file.name.length > 0 ? file.name.normalize("NFC") : undefined;
      const bytes = Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined;
      facts.push(makeFact(index, name, bytes, index));
    }
    return { readable: true, facts };
  };
  const metadataFacts = (root: Element): Readonly<{
    facts: readonly RawAttachmentFact[];
    regionCount: number;
    orderDeterministic: boolean;
  }> => {
    const selector = [
      "[data-file-name]", "[data-filename]", "[data-file-size]", "[data-size]",
      "[data-testid*='attachment' i]", "[data-testid*='file' i]",
      "[aria-label*='attachment' i]", "[aria-label*='upload' i]", "[aria-label*='file' i]",
      "[class*='attachment' i]", "[class*='upload' i]", "[class*='file' i]",
      "[role='listitem']", "[role='progressbar']"
    ].join(", ");
    const raw = unique(boundedQuery<HTMLElement>(root, selector)
      .filter(visible)
      .filter(element => element.tagName !== "INPUT" && element.tagName !== "TEXTAREA"
        && element.tagName !== "BUTTON" && element.tagName !== "LABEL"
        && element.getAttribute("role") !== "button"
        && element.getAttribute("aria-haspopup") === null));
    const rawSet = new Set(raw);
    const nestedContainers = new Set<Element>();
    for (const other of raw) {
      let ancestor = other.parentElement;
      let depth = 0;
      while (ancestor !== null && depth < 4096) {
        if (rawSet.has(ancestor)
          && ancestor.getAttribute("data-file-name") === null
          && ancestor.getAttribute("data-filename") === null) {
          nestedContainers.add(ancestor);
        }
        ancestor = ancestor.parentElement;
        depth += 1;
      }
      if (ancestor !== null) throw new Error("probe limit exceeded");
    }
    const nodes = raw.filter(candidate => !nestedContainers.has(candidate));
    const facts: RawAttachmentFact[] = [];
    for (let index = 0; index < nodes.length && index < 256; index += 1) {
      const node = nodes[index]!;
      const text = textOf(node);
      const name = text.length > 0 ? text : undefined;
      facts.push(makeFact(index, name, parseBytes(node, text), index));
    }
    return { facts, regionCount: nodes.length, orderDeterministic: nodes.length > 0 };
  };
  const textboxes = boundedQuery<HTMLElement>(document,
    "textarea, [contenteditable='true'], [role='textbox']").filter(visible);
  const roots = [...new Set(
    textboxes.map(textbox =>
      textbox.closest<HTMLElement>("form")
        ?? textbox.closest<HTMLElement>("[data-testid*='composer' i]")
        ?? textbox.closest<HTMLElement>("[aria-label*='composer' i]")
        ?? textbox.closest<HTMLElement>("[class*='composer' i]")
    ).filter((root): root is HTMLElement => root !== null && visible(root))
  )];
  if (roots.length !== 1) {
    return {
      status: roots.length === 0 ? "unavailable" : "ambiguous",
      composerCount: roots.length,
      fileInputCount: 0,
      inputFilesReadable: false,
      attachmentRegionCount: 0,
      facts: [],
      secondaryFacts: [],
      factSource: "none",
      orderDeterministic: false,
      activationCandidateCount: 0
    };
  }
  const root = roots[0]!;
  const allInputs = boundedQuery<HTMLInputElement>(root, "input[type='file']")
    .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const preferred = allInputs.filter(input => input.id === "upload-files");
  const nonImage = allInputs.filter(input => input.getAttribute("accept") !== "image/*");
  const inputs = preferred.length === 1 ? preferred : allInputs.length === 1 ? allInputs : nonImage.length === 1 ? nonImage : [];
  if (inputs.length !== 1) {
    return {
      status: "ambiguous",
      composerCount: 1,
      fileInputCount: allInputs.length,
      inputFilesReadable: false,
      attachmentRegionCount: 0,
      facts: [],
      secondaryFacts: [],
      factSource: "none",
      orderDeterministic: false,
      activationCandidateCount: 0
    };
  }
  const input = inputs[0]!;
  const inputResult = inputFacts(input);
  const metadataResult = metadataFacts(root);
  const inputPrimary = inputResult.readable && inputResult.facts.length > 0;
  const facts = inputPrimary ? inputResult.facts : metadataResult.facts;
  const secondaryFacts = inputPrimary ? metadataResult.facts : [];
  const factSource: RawComposerProbe["factSource"] = inputResult.readable
    ? inputPrimary
      ? metadataResult.facts.length > 0 ? "mixed" : "input"
      : metadataResult.facts.length > 0 ? "metadata" : "none"
    : metadataResult.facts.length > 0 ? "metadata" : "none";
  const attachmentRegionCount = Math.max(metadataResult.regionCount, inputResult.facts.length);
  const controls = boundedQuery<HTMLElement>(root,
    "label, button, [role='button'], [role='menuitem']").filter(visible);
  const directCandidates = unique(controls.filter(control => {
    if (control.getAttribute("aria-haspopup") === "menu" && !control.contains(input)) return false;
    if (control === input || control.contains(input)) return true;
    if (input.id.length > 0 && (control.getAttribute("for") === input.id || control.getAttribute("aria-controls") === input.id)) return true;
    const inputRef = control.getAttribute("data-input-id") ?? control.getAttribute("data-file-input");
    return input.id.length > 0 && inputRef === input.id || semanticControl(control);
  }));
  const menuRootItems = boundedQuery<HTMLElement>(document, "[role='menu'] [role='menuitem']").filter(visible);
  const menuItems = (menuRootItems.length > 0 ? menuRootItems : boundedQuery<HTMLElement>(document,
    "[role='menu'] div[tabindex='0']").filter(visible)).filter(item => {
    if (input.id.length > 0 && item.getAttribute("aria-controls") === input.id) return true;
    return semanticControl(item);
  });
  const menuOpeners = unique(boundedQuery<HTMLElement>(root, "button, [role='button']")
    .filter(visible)
    .filter(control => control.getAttribute("aria-haspopup") === "menu"
      && (semanticControl(control) || control.getAttribute("data-testid") !== null)));
  const directActivationSelector = directCandidates.length === 1 ? cssPath(directCandidates[0]!) : undefined;
  const menuUploadSelector = menuItems.length === 1 ? cssPath(menuItems[0]!) : undefined;
  const menuOpenerSelector = menuOpeners.length === 1 ? cssPath(menuOpeners[0]!) : undefined;
  const candidateCount = directCandidates.length > 0
    ? directCandidates.length
    : menuItems.length > 0 ? menuItems.length
    : menuOpenerSelector !== undefined ? 1
    : 0;
  return {
    status: candidateCount === 1 ? "ready" : "ambiguous",
    composerCount: 1,
    fileInputCount: allInputs.length,
    inputFilesReadable: inputResult.readable,
    attachmentRegionCount,
    facts,
    secondaryFacts,
    factSource,
    orderDeterministic: inputResult.readable || metadataResult.orderDeterministic,
    ...(directActivationSelector === undefined ? {} : { directActivationSelector }),
    ...(menuOpenerSelector === undefined ? {} : { menuOpenerSelector }),
    ...(menuUploadSelector === undefined ? {} : { menuUploadSelector }),
    activationCandidateCount: candidateCount
  };
}

function normalizeProbe(raw: unknown): ComposerProbe | undefined {
  if (!isDataRecord(raw)) return undefined;
  if (!hasExactKeys(raw, [
    "status",
    "composerCount",
    "fileInputCount",
    "inputFilesReadable",
    "attachmentRegionCount",
    "facts",
    "secondaryFacts",
    "factSource",
    "orderDeterministic",
    "directActivationSelector",
    "menuOpenerSelector",
    "menuUploadSelector",
    "activationCandidateCount"
  ])) return undefined;
  const status = readOwn<RawComposerProbe["status"]>(raw, "status");
  const composerCount = readOwn<number>(raw, "composerCount");
  const fileInputCount = readOwn<number>(raw, "fileInputCount");
  const inputFilesReadable = readOwn<boolean>(raw, "inputFilesReadable");
  const attachmentRegionCount = readOwn<number>(raw, "attachmentRegionCount");
  const facts = readOwn<readonly RawAttachmentFact[]>(raw, "facts");
  const secondaryFacts = readOwn<readonly RawAttachmentFact[]>(raw, "secondaryFacts");
  const factSource = readOwn<RawComposerProbe["factSource"]>(raw, "factSource");
  const orderDeterministic = readOwn<boolean>(raw, "orderDeterministic");
  const directActivationSelector = readOwn<string>(raw, "directActivationSelector");
  const menuOpenerSelector = readOwn<string>(raw, "menuOpenerSelector");
  const menuUploadSelector = readOwn<string>(raw, "menuUploadSelector");
  const activationCandidateCount = readOwn<number>(raw, "activationCandidateCount");
  if ((status !== "ready" && status !== "ambiguous" && status !== "unavailable")
    || !isBoundedCount(composerCount) || !isBoundedCount(fileInputCount)
    || typeof inputFilesReadable !== "boolean" || !isBoundedCount(attachmentRegionCount)
    || !Array.isArray(facts) || facts.length > MAX_PROBE_ITEMS || !hasSafeArrayDescriptors(facts)
    || !Array.isArray(secondaryFacts) || secondaryFacts.length > MAX_PROBE_ITEMS || !hasSafeArrayDescriptors(secondaryFacts)
    || (factSource !== "input" && factSource !== "metadata" && factSource !== "none" && factSource !== "mixed")
    || typeof orderDeterministic !== "boolean" || !isBoundedCount(activationCandidateCount)) return undefined;
  const normalizeFacts = (rawFacts: readonly RawAttachmentFact[]): readonly RawAttachmentFact[] | undefined => {
    const normalizedFacts: RawAttachmentFact[] = [];
    for (let index = 0; index < rawFacts.length; index += 1) {
      const fact = rawFacts[index];
      if (!isDataRecord(fact) || !hasExactKeys(fact, [
        "ordinal",
        "namePresent",
        "sizePresent",
        "nameMatch",
        "bytesMatch",
        "matchOrdinal",
        "ambiguous",
        "orderKey"
      ])) return undefined;
      const ordinal = readOwn<number>(fact, "ordinal");
      const namePresent = readOwn<boolean>(fact, "namePresent");
      const sizePresent = readOwn<boolean>(fact, "sizePresent");
      const nameMatch = readOwn<boolean>(fact, "nameMatch");
      const bytesMatch = readOwn<boolean>(fact, "bytesMatch");
      const matchOrdinal = readOwn<number>(fact, "matchOrdinal");
      const ambiguous = readOwn<boolean>(fact, "ambiguous");
      const orderKey = readOwn<number>(fact, "orderKey");
      if (ordinal !== index || typeof namePresent !== "boolean" || typeof sizePresent !== "boolean"
        || (nameMatch !== undefined && typeof nameMatch !== "boolean")
        || (bytesMatch !== undefined && typeof bytesMatch !== "boolean")
        || (matchOrdinal !== undefined && (!Number.isSafeInteger(matchOrdinal)
          || matchOrdinal < -1 || matchOrdinal > MAX_PROBE_ITEMS))
        || (ambiguous !== undefined && typeof ambiguous !== "boolean")
        || (orderKey !== undefined && !isBoundedCount(orderKey))) return undefined;
      normalizedFacts.push(Object.freeze({
        ordinal,
        namePresent,
        sizePresent,
        ...(nameMatch === undefined ? {} : { nameMatch }),
        ...(bytesMatch === undefined ? {} : { bytesMatch }),
        ...(matchOrdinal === undefined ? {} : { matchOrdinal }),
        ...(ambiguous === undefined ? {} : { ambiguous }),
        ...(orderKey === undefined ? {} : { orderKey })
      }));
    }
    return Object.freeze(normalizedFacts);
  };
  const normalizedFacts = normalizeFacts(facts);
  const normalizedSecondaryFacts = normalizeFacts(secondaryFacts);
  if (normalizedFacts === undefined || normalizedSecondaryFacts === undefined) return undefined;
  for (const selector of [directActivationSelector, menuOpenerSelector, menuUploadSelector]) {
    if (selector !== undefined && (!SELECTOR_PATTERN.test(selector) || selector.length > 4096)) return undefined;
  }
  return Object.freeze({
    status,
    composerCount,
    fileInputCount,
    inputFilesReadable,
    attachmentRegionCount,
    facts: normalizedFacts,
    secondaryFacts: normalizedSecondaryFacts,
    factSource,
    orderDeterministic,
    ...(directActivationSelector === undefined ? {} : { directActivationSelector }),
    ...(menuOpenerSelector === undefined ? {} : { menuOpenerSelector }),
    ...(menuUploadSelector === undefined ? {} : { menuUploadSelector }),
    activationCandidateCount
  });
}

function compareCausalSurface(
  current: ComposerProbe,
  causal: CausalHandoff,
  request: SubmissionAttachmentRequest
): Readonly<{
  status: "exact" | "mismatch" | "ambiguous" | "unavailable";
  factsMatch: boolean;
  multiplicityMatch: boolean;
  duplicateNames: boolean;
}> {
  // A DOM filename/size is never a content-SHA proof. Exact identity is
  // justified only by this capability's own settled chooser handoff, the
  // frozen manifest selected for that handoff, and every exposed UI fact
  // matching that causal manifest in bounded ordinal order.
  const expectedCount = request.manifest.count;
  const multiplicityMatch = current.facts.length === expectedCount
    && current.attachmentRegionCount === expectedCount;
  const expectedFiles = causalManifestFiles(causal, request);
  if (expectedFiles === undefined || expectedFiles.length !== expectedCount) {
    return {
      status: "mismatch",
      factsMatch: false,
      multiplicityMatch,
      duplicateNames: duplicateNames(current.facts) || duplicateNames(current.secondaryFacts)
    };
  }
  const primary = compareFactList(current.facts, expectedCount);
  const secondary = current.secondaryFacts.length === 0
    ? { factsMatch: true, ambiguous: false, duplicateNames: false }
    : compareFactList(current.secondaryFacts, expectedCount);
  const duplicates = primary.duplicateNames || secondary.duplicateNames;
  if (!multiplicityMatch) {
    return { status: "mismatch", factsMatch: false, multiplicityMatch, duplicateNames: duplicates };
  }
  if (!current.orderDeterministic || primary.ambiguous || secondary.ambiguous) {
    return {
      status: "ambiguous",
      factsMatch: false,
      multiplicityMatch,
      duplicateNames: duplicates
    };
  }
  const factsMatch = primary.factsMatch && secondary.factsMatch;
  return {
    status: factsMatch ? "exact" : "mismatch",
    factsMatch,
    multiplicityMatch,
    duplicateNames: duplicates
  };
}

function compareFactList(
  facts: readonly RawAttachmentFact[],
  expectedCount: number
): Readonly<{ factsMatch: boolean; ambiguous: boolean; duplicateNames: boolean }> {
  if (facts.length !== expectedCount) {
    return { factsMatch: false, ambiguous: false, duplicateNames: duplicateNames(facts) };
  }
  const matchedOrdinals: number[] = [];
  let factsMatch = true;
  let ambiguous = false;
  for (let index = 0; index < facts.length; index += 1) {
    const fact = facts[index]!;
    if (fact.ambiguous === true) ambiguous = true;
    if (!fact.namePresent || fact.nameMatch !== true || fact.matchOrdinal !== index) factsMatch = false;
    if (fact.sizePresent && fact.bytesMatch !== true) factsMatch = false;
    if (fact.orderKey !== undefined && fact.orderKey !== index) factsMatch = false;
    if (fact.matchOrdinal !== undefined && fact.matchOrdinal >= 0) matchedOrdinals.push(fact.matchOrdinal);
  }
  const duplicate = duplicateNames(facts)
    || matchedOrdinals.length !== new Set(matchedOrdinals).size;
  if (duplicate) ambiguous = true;
  return { factsMatch, ambiguous, duplicateNames: duplicate };
}

function causalManifestFiles(
  causal: CausalHandoff,
  request: SubmissionAttachmentRequest
): readonly OperationFileManifestEntryV1[] | undefined {
  if (causal.manifest.count !== request.manifest.count
    || causal.manifest.identities.length !== request.manifest.identities.length) return undefined;
  const files = causal.manifest.identities.map(entry => {
    const requestEntry = request.manifest.identities[entry.ordinal];
    return requestEntry?.identityDigest === entry.identityDigest
      ? causal.manifestFacts[entry.ordinal]
      : undefined;
  });
  if (files.some(entry => entry === undefined)) return undefined;
  return files as readonly OperationFileManifestEntryV1[];
}

function evidenceStatus(
  evidenceDigest: BrowserObservationDigest,
  baseMaterial: Record<string, unknown>,
  status: "ambiguous" | "mismatch" | "unavailable",
  count: number
): ProductionAttachmentSurfaceRead {
  const evidence = safeEvidence(evidenceDigest, "chatgpt-attachment-surface", {
    ...baseMaterial,
    status,
    count
  });
  return evidence === undefined
    ? { status, source: "live_surface" }
    : { status, source: "live_surface", providerEvidenceDigest: evidence };
}

function surfaceEvidenceMaterial(
  request: SubmissionAttachmentRequest,
  target: OperationTargetBindingV1,
  current: ComposerProbe
): Record<string, unknown> {
  return {
    schemaVersion: CHATGPT_ATTACHMENT_PROVIDER_SCHEMA_VERSION,
    operationId: request.operationId,
    requestDigest: request.requestDigest,
    targetBindingDigest: request.targetBindingDigest,
    providerId: target.providerId,
    browserId: target.browserId,
    tabId: target.tabId,
    composerCount: current.composerCount,
    fileInputCount: current.fileInputCount,
    factSource: current.factSource,
    orderDeterministic: current.orderDeterministic
  };
}

function sameCausalRequest(
  causal: CausalHandoff,
  request: SubmissionAttachmentRequest,
  target: OperationTargetBindingV1
): boolean {
  return causal.operationId === request.operationId
    && causal.requestDigest === request.requestDigest
    && causal.targetBindingDigest === request.targetBindingDigest
    && causal.manifest.count === request.manifest.count
    && causal.manifest.identities.every((entry, index) => {
      const current = request.manifest.identities[index];
      return current?.ordinal === entry.ordinal && current.identityDigest === entry.identityDigest;
    })
    && causal.target.providerId === target.providerId
    && causal.target.browserId === target.browserId
    && causal.target.tabId === target.tabId;
}

function duplicateNames(facts: readonly RawAttachmentFact[]): boolean {
  const matched = facts.flatMap(fact => fact.matchOrdinal === undefined || fact.matchOrdinal < 0
    ? []
    : [fact.matchOrdinal]);
  return facts.some(fact => fact.ambiguous === true)
    || matched.length !== new Set(matched).size;
}

function locatorFor(page: Readonly<PageLike>, selector: string): LocatorLike | undefined {
  const locator = safeMethod(page, "locator");
  if (locator === undefined) return undefined;
  try {
    const value = locator.call(page, selector);
    return isSafeProviderObject(value) ? value as LocatorLike : undefined;
  } catch {
    return undefined;
  }
}

function safeEvidence(
  evidenceDigest: BrowserObservationDigest,
  domain: string,
  material: unknown
): string | undefined {
  try {
    const value = evidenceDigest(domain, material);
    return typeof value === "string" && DIGEST_PATTERN.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function boundedNative(value: unknown, timeoutMs: number): Promise<unknown> {
  if (!(value instanceof Promise)) {
    if (value !== null && typeof value === "object") throw new Error("provider callback promise is not native");
    return value;
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider callback timed out")), timeoutMs);
    value.then(result => {
      clearTimeout(timer);
      resolve(result);
    }, error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function awaitMutating(value: unknown): Promise<unknown> {
  if (value instanceof Promise) return await value;
  if (value !== null && typeof value === "object") throw new Error("provider mutation promise is not native");
  return value;
}

function safeMethod(value: object, key: string): ((this: object, ...args: unknown[]) => unknown) | undefined {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 12; depth += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
    } catch {
      return undefined;
    }
    if (descriptor !== undefined) {
      return !descriptor.get && !descriptor.set && "value" in descriptor && typeof descriptor.value === "function"
        ? descriptor.value as (this: object, ...args: unknown[]) => unknown
        : undefined;
    }
    try {
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isSafeProviderObject(value: unknown): value is object {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readOwn<T>(value: object, key: PropertyKey): T | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined
      ? descriptor.value as T
      : undefined;
  } catch {
    return undefined;
  }
}

function assertOwnDataKeys(value: object, keys: readonly string[]): void {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new Error("invalid ChatGPT attachment provider options");
  }
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) throw new Error("invalid ChatGPT attachment provider options");
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new Error("invalid ChatGPT attachment provider options");
    }
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  try {
    const allowed = new Set(keys);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || !allowed.has(key)) return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isSafeTarget(value: unknown): value is OperationTargetBindingV1 {
  if (!isDataRecord(value)) return false;
  const providerId = readOwn<string>(value, "providerId");
  const browserId = readOwn<string>(value, "browserId");
  const tabId = readOwn<string>(value, "tabId");
  const scope = readOwn<string>(value, "coordinationScope");
  return typeof providerId === "string" && ID_PATTERN.test(providerId)
    && typeof browserId === "string" && ID_PATTERN.test(browserId)
    && typeof tabId === "string" && ID_PATTERN.test(tabId)
    && (scope === "process" || scope === "provider");
}

function snapshotHandoffRequest(value: unknown): CausalHandoffRequest | undefined {
  if (!isDataRecord(value)) return undefined;
  const operationId = readOwn<string>(value, "operationId");
  const requestDigest = readOwn<string>(value, "requestDigest");
  const surface = readOwn<SubmissionHandoffRequest["surface"]>(value, "surface");
  const actionId = readOwn<string>(value, "actionId");
  const targetBindingDigest = readOwn<string>(value, "targetBindingDigest");
  const rawManifest = readOwn<unknown>(value, "manifest");
  const manifest = snapshotHandoffManifest(rawManifest);
  if (typeof operationId !== "string" || !ID_PATTERN.test(operationId)
    || typeof requestDigest !== "string" || !DIGEST_PATTERN.test(requestDigest)
    || (surface !== "chat" && surface !== "work")
    || typeof actionId !== "string" || !ID_PATTERN.test(actionId)
    || typeof targetBindingDigest !== "string" || !DIGEST_PATTERN.test(targetBindingDigest)
    || manifest === undefined) return undefined;
  return Object.freeze({ operationId, requestDigest, surface, actionId, targetBindingDigest, manifest });
}

function snapshotHandoffManifest(value: unknown): CausalHandoffRequest["manifest"] | undefined {
  if (!isDataRecord(value) || !hasExactKeys(value, ["count", "orderPolicy", "identities"])) return undefined;
  const count = readOwn<number>(value, "count");
  const orderPolicy = readOwn<string>(value, "orderPolicy");
  const identities = readOwn<unknown>(value, "identities");
  if (!isBoundedCount(count) || orderPolicy !== "exact" || !Array.isArray(identities)
    || identities.length !== count || !hasSafeArrayDescriptors(identities)) return undefined;
  const result: Array<{ identityDigest: string; ordinal: number }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < identities.length; index += 1) {
    const entry = identities[index];
    if (!isDataRecord(entry) || !hasExactKeys(entry, ["identityDigest", "ordinal"])) return undefined;
    const identityDigest = readOwn<string>(entry, "identityDigest");
    const ordinal = readOwn<number>(entry, "ordinal");
    if (typeof identityDigest !== "string" || !DIGEST_PATTERN.test(identityDigest)
      || ordinal !== index || seen.has(identityDigest)) return undefined;
    seen.add(identityDigest);
    result.push(Object.freeze({ identityDigest, ordinal }));
  }
  return Object.freeze({ count, orderPolicy: "exact", identities: Object.freeze(result) });
}

function snapshotTargetBinding(value: unknown): OperationTargetBindingV1 | undefined {
  if (!isSafeTarget(value)) return undefined;
  try {
    return Object.freeze({ ...(value as OperationTargetBindingV1) });
  } catch {
    return undefined;
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof AbortSignal === "undefined" || !(value instanceof AbortSignal)) return false;
  try {
    return typeof value.aborted === "boolean" && typeof value.addEventListener === "function";
  } catch {
    return false;
  }
}

function isAnyAbortRequested(
  providerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined,
  requestDeadlineAt: number | undefined
): boolean {
  return providerSignal?.aborted === true
    || requestSignal?.aborted === true
    || requestDeadlineAt !== undefined && Date.now() >= requestDeadlineAt;
}

function boundedProbeTimeout(timeoutMs: number, requestDeadlineAt: number | undefined): number {
  if (requestDeadlineAt === undefined) return timeoutMs;
  return Math.max(0, Math.min(timeoutMs, requestDeadlineAt - Date.now()));
}

/**
 * Snapshot the complete request-local file identity graph before any provider
 * callback is installed.  A shallow array copy is not sufficient: callers
 * can otherwise mutate `sourcePath`, manifest facts, or inode proof after the
 * factory returns and make the later handoff/evidence refer to different
 * inputs than the journaled request.
 */
function snapshotFileIdentities(value: readonly OperationFileIdentity[]): readonly OperationFileIdentity[] {
  if (!Array.isArray(value) || value.length > MAX_PROBE_ITEMS || !hasSafeArrayDescriptors(value)) {
    throw new Error("invalid ChatGPT attachment provider options");
  }
  const result: OperationFileIdentity[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index];
    if (!isDataRecord(source) || !hasExactKeys(source, ["sourcePath", "manifest", "proof"])) {
      throw new Error("invalid ChatGPT attachment provider options");
    }
    const sourcePath = readOwn<string>(source, "sourcePath");
    const manifest = readOwn<unknown>(source, "manifest");
    const proof = readOwn<unknown>(source, "proof");
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.length > 4096
      || /[\u0000-\u001f\u007f]/u.test(sourcePath)) {
      throw new Error("invalid ChatGPT attachment provider options");
    }
    const manifestSnapshot = snapshotManifest(manifest);
    const proofSnapshot = snapshotProof(proof);
    if (manifestSnapshot === undefined || proofSnapshot === undefined
      || proofSnapshot.size !== String(manifestSnapshot.bytes)) {
      throw new Error("invalid ChatGPT attachment provider options");
    }
    result.push(Object.freeze({
      sourcePath,
      manifest: manifestSnapshot,
      proof: proofSnapshot
    }));
  }
  return Object.freeze(result);
}

function snapshotManifest(value: unknown): OperationFileIdentity["manifest"] | undefined {
  if (!isDataRecord(value) || !hasExactKeys(value, ["displayName", "bytes", "contentSha256"])) return undefined;
  const displayName = readOwn<string>(value, "displayName");
  const bytes = readOwn<number>(value, "bytes");
  const contentSha256 = readOwn<string>(value, "contentSha256");
  if (displayName === undefined || !safeDisplayName(displayName)
    || bytes === undefined || !isBoundedBytes(bytes)
    || contentSha256 === undefined || !/^[0-9a-f]{64}$/u.test(contentSha256)) return undefined;
  return Object.freeze({ displayName, bytes, contentSha256 });
}

function snapshotProof(value: unknown): OperationFileIdentity["proof"] | undefined {
  if (!isDataRecord(value) || !hasExactKeys(value, ["device", "inode", "size", "modifiedNs", "changedNs"])) return undefined;
  const device = readOwn<string>(value, "device");
  const inode = readOwn<string>(value, "inode");
  const size = readOwn<string>(value, "size");
  const modifiedNs = readOwn<string>(value, "modifiedNs");
  const changedNs = readOwn<string>(value, "changedNs");
  if (![device, inode, size, modifiedNs, changedNs].every(item => typeof item === "string"
    && item.length > 0 && item.length <= 256 && /^\d+$/u.test(item))) {
    return undefined;
  }
  return Object.freeze({ device, inode, size, modifiedNs, changedNs } as OperationFileIdentity["proof"]);
}

function hasSafeArrayDescriptors(value: readonly unknown[]): boolean {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || (key !== "length" && !/^\d+$/u.test(key))) return false;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
      if (key !== "length" && Number(key) >= value.length) return false;
    }
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    return length === value.length && Number.isSafeInteger(length) && length >= 0;
  } catch {
    return false;
  }
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PROBE_ITEMS;
}

function isBoundedBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function safeDisplayName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_PROBE_TEXT && !/[\\/\u0000-\u001f\u007f]/u.test(value);
}
