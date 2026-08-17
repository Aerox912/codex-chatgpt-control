import type { PageLike } from "../types.js";
import { formatMessageHtml, normalizeResponseFormat } from "../dom/message-format.js";
import {
  TURN_OWNERSHIP_SCHEMA_VERSION,
  type OwnershipBaseline,
  type OwnershipIdentityEvidence,
  type OwnershipSnapshot,
  type OwnershipTargetEvidence,
  type OwnershipTurn
} from "./turn-ownership.js";
import {
  COLLECTOR_TERMINAL_SCHEMA_VERSION,
  type CollectorArtifact,
  type CollectorTerminalObservation,
  type CollectorTextDigest
} from "./collector.js";
import type { OperationResponseFormatV1 } from "./types.js";

/**
 * A read-only browser observation has deliberately fewer powers than the
 * legacy page helpers.  The page is passed by value to this boundary and is
 * never obtained from (or written back to) RuntimeEnv.
 */
export type BrowserObservationDigest = (domain: string, material: unknown) => string;

export type BrowserObservationTarget = Readonly<{
  providerId: string;
  browserId: string;
  tabId: string;
  coordinationScope: "process" | "provider";
  authoritativeTabClaim?: string;
  /**
   * A new target is allowed to have no provider conversation identity before
   * Send.  The read-only page probe still has to prove a blank/new-task
   * surface; this flag never permits a missing identity for a fixed target.
   */
  targetLifecycle?: "fixed" | "new_pending" | "new_established";
  expectedConversationId?: string;
  expectedThreadId?: string;
}>;

export type BrowserObservationOptions = Readonly<{
  operationId: string;
  target: BrowserObservationTarget;
  evidenceDigest: BrowserObservationDigest;
  /** Metadata is the default; raw content requires an exact assistant ID. */
  responseContent?: "include" | "metadata";
  /** Immutable transactional response format; only semantic Markdown/text are supported. */
  responseFormat?: OperationResponseFormatV1;
  /** Exact terminal assistant turn to normalize for collector metadata. */
  terminalAssistantTurnId?: string;
  rawAssistantTurnId?: string;
  /** A complete baseline enables exact post-Send delta evidence. */
  baseline?: OwnershipBaseline;
  maxTurns?: number;
  maxTextChars?: number;
  maxArtifactsPerTurn?: number;
}>;

export type BrowserObservationResult = Readonly<{
  snapshot: OwnershipSnapshot;
  terminal?: CollectorTerminalObservation;
  /** Present only for a verified blank/new-task pre-Send observation. */
  newTargetAnchor?: Readonly<{
    anchorDigest: string;
    blankTaskEvidenceDigest: string;
  }>;
}>;

export type BrowserObservationErrorCode =
  | "page_evaluation_unavailable"
  | "page_evaluation_failed"
  | "provider_shape_drift"
  | "missing_identity"
  | "duplicate_identity"
  | "unstable_identity"
  | "incomplete_dom"
  | "navigation_ambiguous"
  | "branch_ambiguous"
  | "bounded_limit_exceeded"
  | "evidence_digest_failed"
  | "raw_content_unavailable";

const ERROR_MESSAGES: Record<BrowserObservationErrorCode, string> = {
  page_evaluation_unavailable: "Browser observation requires a read-only page evaluation boundary.",
  page_evaluation_failed: "Browser observation could not complete its bounded DOM transaction.",
  provider_shape_drift: "Browser observation found an unsupported provider DOM shape.",
  missing_identity: "Browser observation is missing a required stable identity.",
  duplicate_identity: "Browser observation found duplicate stable identities.",
  unstable_identity: "Browser observation found an identity that changed within one DOM snapshot.",
  incomplete_dom: "Browser observation found an incomplete or out-of-order conversation DOM.",
  navigation_ambiguous: "Browser observation could not prove one canonical conversation navigation target.",
  branch_ambiguous: "Browser observation could not prove one stable assistant branch.",
  bounded_limit_exceeded: "Browser observation exceeded a bounded DOM or content limit.",
  evidence_digest_failed: "Browser observation could not create privacy-preserving evidence.",
  raw_content_unavailable: "The requested exact terminal assistant content is unavailable."
};

export class BrowserObservationError extends Error {
  readonly code: BrowserObservationErrorCode;

  constructor(code: BrowserObservationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BrowserObservationError";
    this.code = code;
  }
}

const DIGEST_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;
const MAX_TURNS = 256;
const MAX_ARTIFACTS_PER_TURN = 32;
const MAX_TEXT_CHARS = 1_000_000;
const MAX_TOTAL_TEXT_CHARS = 8_000_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 4096;
const MAX_ATTRIBUTE_LENGTH = 4096;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const OPAQUE_URL_PREFIX = "https://opaque.invalid/thread/";

type RawArtifact = Readonly<{
  kind: "file" | "image" | "other";
  identity: string;
  contentDigest?: string;
  bytes?: number;
  mimeType?: string;
}>;

type RawTurn = Readonly<{
  role: "user" | "assistant";
  stableId: string;
  parentStableId?: string;
  branchStableId?: string;
  ordinal: number;
  text: string;
  /** Bounded, transient innerHTML for the one exact requested assistant turn. */
  contentHtml?: string;
  structure: Readonly<{
    tag: string;
    childCount: number;
    artifactCount: number;
  }>;
  state?: "generating" | "terminal";
  finishReason?: string;
  artifacts: readonly RawArtifact[];
}>;

type RawPageObservation = Readonly<{
  canonicalUrl: string;
  conversationId?: string;
  threadId?: string;
  turns: readonly RawTurn[];
  completeness: "complete" | "truncated" | "incomplete" | "out_of_order";
  terminalState: "idle" | "generating" | "terminal" | "unknown";
}>;

type RawEvaluateArguments = Readonly<{
  maxTurns: number;
  maxTextChars: number;
  maxArtifactsPerTurn: number;
  captureAssistantTurnId?: string;
  allowBlankTask?: boolean;
}>;

type FrozenTarget = OwnershipTargetEvidence;

/**
 * Perform one bounded read-only page transaction and normalize its result.
 * `page.evaluate` is the only browser call made by this adapter.
 */
export async function observeBrowserPage(
  page: Readonly<PageLike>,
  options: BrowserObservationOptions
): Promise<BrowserObservationResult> {
  validateOptions(options);
  if (typeof page.evaluate !== "function") {
    throw new BrowserObservationError("page_evaluation_unavailable");
  }

  const responseContent = options.responseContent ?? "metadata";
  if (responseContent === "include" && options.rawAssistantTurnId === undefined) {
    throw new BrowserObservationError("raw_content_unavailable");
  }
  if (options.rawAssistantTurnId !== undefined
    && options.terminalAssistantTurnId !== undefined
    && options.rawAssistantTurnId !== options.terminalAssistantTurnId) {
    throw new BrowserObservationError("raw_content_unavailable");
  }

  const evaluateArgs: RawEvaluateArguments = {
    maxTurns: boundedPositive(options.maxTurns, MAX_TURNS),
    maxTextChars: boundedPositive(options.maxTextChars, MAX_TEXT_CHARS),
    maxArtifactsPerTurn: boundedPositive(options.maxArtifactsPerTurn, MAX_ARTIFACTS_PER_TURN),
    ...((options.terminalAssistantTurnId ?? options.rawAssistantTurnId) === undefined
      ? {}
      : { captureAssistantTurnId: options.terminalAssistantTurnId ?? options.rawAssistantTurnId }),
    ...(options.target.targetLifecycle === "new_pending" ? { allowBlankTask: true } : {})
  };
  let raw: unknown;
  try {
    raw = await page.evaluate(readPageObservation, evaluateArgs);
  } catch {
    throw new BrowserObservationError("page_evaluation_failed");
  }

  const parsed = parseRawObservation(raw, evaluateArgs);
  const target = buildTarget(parsed, options);
  const normalized = normalizeTurns(parsed.turns, options);
  const postSendDelta = options.baseline === undefined
    ? undefined
    : makePostSendDelta(options.baseline, normalized.userTurns, options.evidenceDigest);
  const snapshotDigest = digest(options.evidenceDigest, "browser-observation-snapshot", {
    operationId: options.operationId,
    target: targetMaterial(target),
    userTurns: normalized.userTurns.map(turnMaterial),
    assistantTurns: normalized.assistantTurns.map(turnMaterial),
    completeness: parsed.completeness,
    terminalState: parsed.terminalState,
    // A pending target cannot persist a conversation URL yet, but the keyed
    // navigation evidence still makes the blank-task anchor sensitive to a
    // pre-Send navigation change without exposing the raw URL.
    ...(options.target.targetLifecycle === "new_pending"
      ? { blankTaskNavigationDigest: digest(options.evidenceDigest, "browser-observation-blank-task-navigation", parsed.canonicalUrl) }
      : {}),
    ...(postSendDelta === undefined ? {} : { postSendDelta })
  });
  const snapshot: OwnershipSnapshot = Object.freeze({
    schemaVersion: TURN_OWNERSHIP_SCHEMA_VERSION,
    snapshotDigest,
    target,
    userTurns: Object.freeze(normalized.userTurns),
    assistantTurns: Object.freeze(normalized.assistantTurns),
    completeness: parsed.completeness,
    terminalState: parsed.terminalState,
    ...(postSendDelta === undefined ? {} : { postSendDelta })
  });

  const terminalTurn = resolveTerminalTurn(parsed.turns, normalized.assistantTurns, options);
  const terminal = terminalTurn === undefined
    ? undefined
    : terminalObservation(terminalTurn.raw, terminalTurn.normalized, normalized.userTurns, options, target);
  const newTargetAnchor = options.target.targetLifecycle === "new_pending"
    && target.conversation.status === "unavailable"
    && target.canonicalThreadUrl.status === "unavailable"
    && normalized.userTurns.length === 0
    && normalized.assistantTurns.length === 0
    ? (() => {
        const blankTaskEvidenceDigest = snapshot.snapshotDigest;
        const anchorDigest = digest(options.evidenceDigest, "browser-observation-new-target-anchor", {
          operationId: options.operationId,
          target: targetMaterial(target),
          blankTaskEvidenceDigest
        });
        return Object.freeze({ anchorDigest, blankTaskEvidenceDigest });
      })()
    : undefined;
  return Object.freeze({
    snapshot,
    ...(terminal === undefined ? {} : { terminal }),
    ...(newTargetAnchor === undefined ? {} : { newTargetAnchor })
  });
}

/**
 * This function is intentionally self-contained because it is serialized into
 * the browser evaluation boundary. It returns bounded, transient raw material;
 * the outer adapter converts ownership material to HMAC evidence and never
 * stores prompt/response text in the normalized snapshot. Exact response text
 * is exposed only in the request-scoped terminal result when explicitly asked.
 */
export function readPageObservation(args: RawEvaluateArguments): RawPageObservation {
  // IMPORTANT: page.evaluate serializes this function. Every runtime value it
  // uses must therefore be declared inside this body; imported/module helpers
  // are not part of the browser realm. Keep the outer twins below for SDK-side
  // validation only.
  const MAX_TURNS = 256;
  const MAX_ARTIFACTS_PER_TURN = 32;
  const MAX_TEXT_CHARS = 1_000_000;
  const MAX_TOTAL_TEXT_CHARS = 8_000_000;
  const MAX_NODES = 4096;
  const MAX_ATTRIBUTE_LENGTH = 4096;
  const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
  const ID_PATTERN = /^[A-Za-z0-9._:-]{1,512}$/;

  const boundedPositive = (value: unknown, fallback: number): number =>
    Number.isSafeInteger(value) && (value as number) > 0
      ? Math.min(value as number, fallback)
      : fallback;
  const isBoundedId = (value: unknown): value is string =>
    typeof value === "string" && ID_PATTERN.test(value);
  const isBoundedText = (value: unknown, max: number): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\u0000");
  const isContentDigest = (value: unknown): value is string =>
    typeof value === "string" && /^(?:hmac-sha256:|sha256:)[0-9a-f]{64}$/.test(value);
  const canonicalizeUrl = (value: string): string => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new Error("non-canonical navigation");
    }
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/u, "") || "/";
    return url.toString();
  };
  const conversationIdFromUrl = (urlValue: string): string | undefined => {
    const url = new URL(urlValue);
    const parts = url.pathname.split("/").filter(Boolean);
    const index = parts.findIndex(part => part === "c" || part === "conversation");
    const candidate = index >= 0 ? parts[index + 1] : undefined;
    return candidate !== undefined && ID_PATTERN.test(candidate) ? candidate : undefined;
  };
  const uniqueNodeAttribute = (root: HTMLElement, roleNode: HTMLElement, names: readonly string[]): string | undefined => {
    const values = new Set<string>();
    for (const node of [root, roleNode]) {
      for (const name of names) {
        const value = node.getAttribute(name);
        if (value !== null && value.length > 0) {
          if (value.length > MAX_ATTRIBUTE_LENGTH || !ID_PATTERN.test(value)) throw new Error("attribute drift");
          values.add(value);
        }
      }
    }
    if (values.size > 1) throw new Error("unstable identity");
    return [...values][0];
  };
  const boundedText = (value: string, max: number): string => {
    if (value.length > max || value.includes("\u0000")) throw new Error("text limit exceeded");
    return value;
  };
  const boundedMarkup = (value: unknown, max: number): string => {
    if (typeof value !== "string" || value.length > max || value.includes("\u0000")) throw new Error("markup limit exceeded");
    return value;
  };
  const readTurnState = (root: HTMLElement, roleNode: HTMLElement): "generating" | "terminal" | undefined => {
    const values = [root, roleNode].flatMap(node => [
      node.getAttribute("data-generation-state"),
      node.getAttribute("data-state"),
      node.getAttribute("data-status"),
      node.getAttribute("data-turn-state"),
      node.getAttribute("data-generating") === "true" ? "generating" : node.getAttribute("data-generating") === "false" ? "terminal" : null,
      node.getAttribute("aria-busy") === "true" ? "generating" : node.getAttribute("aria-busy") === "false" ? "terminal" : null
    ]).filter((value): value is string => value !== null && value !== undefined).map(value => value.trim().toLowerCase());
    const generating = values.some(value => ["generating", "streaming", "in_progress", "in-progress", "true"].includes(value));
    const terminal = values.some(value => ["terminal", "complete", "completed", "done", "false"].includes(value));
    if (generating && terminal) throw new Error("unstable generation state");
    return generating ? "generating" : terminal ? "terminal" : undefined;
  };
  const readFinishReason = (root: HTMLElement, roleNode: HTMLElement): string | undefined => {
    for (const node of [root, roleNode]) {
      for (const name of ["data-finish-reason", "data-stop-reason", "data-completion-reason"]) {
        const value = node.getAttribute(name);
        if (value !== null && value.length > 0) return value.trim().slice(0, 128);
      }
    }
    return undefined;
  };
  const validateRawTurnOrdering = (turns: readonly RawTurn[]): void => {
    const counters = { user: 0, assistant: 0 };
    for (const turn of turns) {
      if (turn.ordinal !== counters[turn.role]) throw new Error("out-of-order turn");
      counters[turn.role] += 1;
    }
    const users = new Set(turns.filter(turn => turn.role === "user").map(turn => turn.stableId));
    for (const turn of turns) {
      if (turn.role === "assistant" && (turn.parentStableId === undefined || !users.has(turn.parentStableId))) {
        throw new Error("branch ambiguity");
      }
    }
  };
  const maxTurns = boundedPositive(args?.maxTurns, MAX_TURNS);
  const maxTextChars = boundedPositive(args?.maxTextChars, MAX_TEXT_CHARS);
  const maxArtifactsPerTurn = boundedPositive(args?.maxArtifactsPerTurn, MAX_ARTIFACTS_PER_TURN);
  const captureAssistantTurnId = args?.captureAssistantTurnId;
  if (captureAssistantTurnId !== undefined && !isBoundedId(captureAssistantTurnId)) throw new Error("capture identity unavailable");
  const allowBlankTask = args?.allowBlankTask === true;
  const documentRoot = (globalThis as unknown as { document?: Document }).document;
  if (documentRoot === undefined) throw new Error("document unavailable");
  const locationRoot = (globalThis as unknown as { location?: Location }).location;
  const currentUrl = locationRoot?.href;
  if (typeof currentUrl !== "string" || currentUrl.length === 0 || currentUrl.length > MAX_ATTRIBUTE_LENGTH) {
    throw new Error("navigation unavailable");
  }
  const canonicalUrl = canonicalizeUrl(currentUrl);
  const fromUrl = conversationIdFromUrl(canonicalUrl);
  const conversationValues = new Set<string>();
  const threadValues = new Set<string>();
  const roots: Array<{
    root: HTMLElement;
    roleMarkers: HTMLElement[];
    firstRoleNode?: HTMLElement;
    directChildCount: number;
    artifacts: RawArtifact[];
    artifactIds: Set<string>;
    messageChunks: string[];
    messageChars: number;
  }> = [];
  const activeArtifacts: Array<{
    raw: RawArtifact;
    textChars: number;
  }> = [];
  const activeElements: Array<{
    element: HTMLElement;
    turn?: (typeof roots)[number];
    messageOwner?: (typeof roots)[number];
    messageIgnored: boolean;
    artifact?: (typeof activeArtifacts)[number];
    hiddenAncestor: boolean;
  }> = [];
  let roleNodeCount = 0;
  let blankTaskMarker = false;
  let visibleComposerCount = 0;
  let completenessMarker: string | undefined;
  let visitedNodes = 0;
  const consumeNode = (): void => {
    visitedNodes += 1;
    if (visitedNodes > MAX_NODES) throw new Error("node limit exceeded");
  };
  const addIdentityValues = (element: HTMLElement, names: readonly string[], values: Set<string>): void => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value !== null && value.length > 0) {
        if (value.length > maxTextChars || !ID_PATTERN.test(value)) throw new Error("attribute drift");
        values.add(value);
        if (values.size > 1) throw new Error("ambiguous identity");
      }
    }
  };
  const isTurnRoot = (element: HTMLElement): boolean => {
    const testId = element.getAttribute("data-testid");
    return (testId !== null && testId.startsWith("conversation-turn"))
      || element.hasAttribute("data-conversation-turn-id")
      || element.hasAttribute("data-turn-id")
      || element.hasAttribute("data-message-id");
  };
  const isIgnoredMessageElement = (element: HTMLElement): boolean => {
    const tag = element.tagName.toLowerCase();
    return tag === "button"
      || tag === "script"
      || tag === "style"
      || tag === "svg"
      || element.getAttribute("role") === "button"
      || element.getAttribute("aria-hidden") === "true";
  };
  const isArtifact = (element: HTMLElement): boolean => {
    const testId = (element.getAttribute("data-testid") ?? "").toLowerCase();
    const tag = element.tagName.toLowerCase();
    return element.hasAttribute("data-artifact-id")
      || element.hasAttribute("data-file-id")
      || element.hasAttribute("data-attachment-id")
      || element.hasAttribute("data-image-id")
      || testId.includes("artifact")
      || testId.includes("file")
      || testId.includes("image")
      || (tag === "a" && element.hasAttribute("download"));
  };
  const isBlankTaskMarker = (element: HTMLElement): boolean => {
    const hasMarker = element.hasAttribute("data-new-task")
      || element.hasAttribute("data-new-conversation")
      || ((element.getAttribute("data-testid") ?? "").toLowerCase().includes("new-chat"))
      || ((element.getAttribute("data-testid") ?? "").toLowerCase().includes("new-conversation"));
    if (!hasMarker) return false;
    const explicit = element.getAttribute("data-new-task") ?? element.getAttribute("data-new-conversation");
    if (explicit === null || explicit === "" || explicit.toLowerCase() === "true") return true;
    const testId = (element.getAttribute("data-testid") ?? "").toLowerCase();
    return testId.includes("new-chat") || testId.includes("new-conversation");
  };
  const isComposer = (element: HTMLElement): boolean => {
    const tag = element.tagName.toLowerCase();
    return tag === "textarea"
      || element.getAttribute("contenteditable") === "true"
      || element.getAttribute("role") === "textbox";
  };
  const readArtifact = (element: HTMLElement, turn: (typeof roots)[number]): (typeof activeArtifacts)[number] => {
    const identityValues = new Set<string>();
    for (const name of ["data-artifact-id", "data-file-id", "data-attachment-id", "data-image-id"] as const) {
      const value = element.getAttribute(name);
      if (value !== null && value.length > 0) {
        if (!isBoundedId(value)) throw new Error("artifact identity unavailable");
        identityValues.add(value);
      }
    }
    if (identityValues.size > 1) throw new Error("artifact identity unavailable");
    const identity = [...identityValues][0] ?? (element.getAttribute("data-testid") ?? "");
    if (!isBoundedId(identity) || turn.artifactIds.has(identity)) throw new Error("artifact identity unavailable");
    turn.artifactIds.add(identity);
    if (turn.artifacts.length >= maxArtifactsPerTurn) throw new Error("artifact limit exceeded");
    const testId = (element.getAttribute("data-testid") ?? "").toLowerCase();
    const tag = element.tagName.toLowerCase();
    const kind: RawArtifact["kind"] = tag === "img" || testId.includes("image") || element.hasAttribute("data-image-id")
      ? "image"
      : testId.includes("file") || element.hasAttribute("data-file-id") || element.hasAttribute("data-attachment-id") || tag === "a"
        ? "file"
        : "other";
    const contentDigest = element.getAttribute("data-content-sha256") ?? element.getAttribute("data-sha256") ?? undefined;
    if (contentDigest !== undefined && !isContentDigest(contentDigest)) throw new Error("artifact digest drift");
    const bytesRaw = element.getAttribute("data-bytes") ?? element.getAttribute("data-size") ?? undefined;
    const bytes = bytesRaw === undefined ? undefined : Number(bytesRaw);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARTIFACT_BYTES)) throw new Error("artifact bytes limit");
    const mimeType = element.getAttribute("data-mime-type") ?? element.getAttribute("type") ?? undefined;
    if (mimeType !== undefined && !isBoundedText(mimeType, 128)) throw new Error("artifact MIME drift");
    const raw: RawArtifact = {
      kind,
      identity,
      ...(contentDigest === undefined ? {} : { contentDigest }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(mimeType === undefined ? {} : { mimeType })
    };
    turn.artifacts.push(raw);
    const state = { raw, textChars: 0 };
    activeArtifacts.push(state);
    return state;
  };
  const ownerDocument = typeof documentRoot.createTreeWalker === "function" ? documentRoot : undefined;
  if (ownerDocument === undefined) throw new Error("DOM traversal unavailable");
  // SHOW_ALL is deliberate. This is one aggregate transaction budget: every
  // element, text node, and comment returned by this walker consumes exactly
  // one slot, including nodes later used for text and artifact attribution.
  const walker = ownerDocument.createTreeWalker(documentRoot, 0xffffffff);
  let current = walker.nextNode();
  while (current !== null) {
    consumeNode();
    while (activeElements.length > 0
      && activeElements[activeElements.length - 1]?.element !== current.parentNode) {
      const closed = activeElements.pop();
      if (closed?.artifact !== undefined) {
        const popped = activeArtifacts.pop();
        if (popped !== closed.artifact) throw new Error("artifact traversal drift");
      }
    }
    if (current.nodeType === 1) {
      const element = current as HTMLElement;
      const parent = activeElements[activeElements.length - 1];
      const inheritedTurn = parent?.turn;
      const rootCandidate = isTurnRoot(element);
      // A nested provider root would otherwise make one role/artifact subtree
      // belong to two owners. Reject it before descending so the exact visit
      // budget cannot be multiplied by overlapping ownership interpretations.
      if (rootCandidate && inheritedTurn !== undefined) throw new Error("nested turn root");
      let turn = rootCandidate
        ? {
            root: element,
            roleMarkers: [] as HTMLElement[],
            directChildCount: 0,
            artifacts: [] as RawArtifact[],
            artifactIds: new Set<string>(),
            messageChunks: [] as string[],
            messageChars: 0
          }
        : inheritedTurn;
      if (rootCandidate) {
        if (turn === undefined) throw new Error("turn traversal drift");
        roots.push(turn);
      }
      if (parent !== undefined && parent.turn?.root === parent.element) parent.turn.directChildCount += 1;
      const role = element.getAttribute("data-message-author-role");
      if (role !== null) {
        roleNodeCount += 1;
        if (role !== "user" && role !== "assistant") throw new Error("role drift");
        if (turn === undefined) {
          turn = {
            root: element,
            roleMarkers: [],
            directChildCount: 0,
            artifacts: [],
            artifactIds: new Set<string>(),
            messageChunks: [],
            messageChars: 0
          };
          roots.push(turn);
        }
        turn.roleMarkers.push(element);
        if (turn.firstRoleNode === undefined) turn.firstRoleNode = element;
      }
      addIdentityValues(element, ["data-conversation-id", "data-chat-id"], conversationValues);
      addIdentityValues(element, ["data-thread-id", "data-conversation-thread-id"], threadValues);
      if (completenessMarker === undefined
        && (element.hasAttribute("data-observation-completeness")
          || element.hasAttribute("data-conversation-completeness")
          || element.hasAttribute("data-turns-truncated"))) {
        completenessMarker = (element.getAttribute("data-observation-completeness")
          ?? element.getAttribute("data-conversation-completeness")
          ?? element.getAttribute("data-turns-truncated")
          ?? "").toLowerCase();
      }
      if (isBlankTaskMarker(element)) blankTaskMarker = true;
      const inheritedHidden = parent?.hiddenAncestor ?? false;
      const ownHidden = element.hidden === true
        || element.hasAttribute("hidden")
        || element.hasAttribute("inert")
        || element.getAttribute("aria-hidden") === "true";
      const hiddenAncestor = inheritedHidden || ownHidden;
      if (!hiddenAncestor && isComposer(element)) {
        const style = globalThis.getComputedStyle?.(element);
        if (style === undefined || (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0")) {
          visibleComposerCount += 1;
        }
      }
      const selectedRoleNode = turn?.firstRoleNode === element;
      const messageOwner = selectedRoleNode ? turn : parent?.messageOwner;
      const messageIgnored = selectedRoleNode
        ? false
        : (parent?.messageIgnored ?? false) || isIgnoredMessageElement(element);
      let artifact: (typeof activeArtifacts)[number] | undefined;
      if (turn !== undefined && turn.root !== element && isArtifact(element)) artifact = readArtifact(element, turn);
      activeElements.push({
        element,
        ...(turn === undefined ? {} : { turn }),
        ...(messageOwner === undefined ? {} : { messageOwner }),
        messageIgnored,
        ...(artifact === undefined ? {} : { artifact }),
        hiddenAncestor
      });
    } else if (current.nodeType === 3) {
      const value = current.nodeValue ?? "";
      for (const artifact of activeArtifacts) {
        artifact.textChars += value.length;
        if (artifact.textChars > maxTextChars) throw new Error("artifact text limit");
      }
      const owner = activeElements[activeElements.length - 1];
      if (owner?.messageOwner !== undefined && !owner.messageIgnored) {
        owner.messageOwner.messageChars += value.length;
        if (owner.messageOwner.messageChars > maxTextChars) throw new Error("text limit exceeded");
        if (value.length > 0) owner.messageOwner.messageChunks.push(value);
      }
    }
    current = walker.nextNode();
  }
  while (activeElements.length > 0) {
    const closed = activeElements.pop();
    if (closed?.artifact !== undefined) activeArtifacts.pop();
  }
  const conversationId = [...conversationValues][0];
  const threadId = [...threadValues][0];
  const resolvedConversationId = conversationId ?? fromUrl;
  const resolvedThreadId = threadId ?? resolvedConversationId;
  if ((resolvedConversationId === undefined || resolvedThreadId === undefined)
    && (!allowBlankTask || roleNodeCount !== 0 || (!blankTaskMarker && visibleComposerCount !== 1))) {
    throw new Error("conversation identity unavailable");
  }
  const outputRoots = roots.filter(root => root.roleMarkers.length > 0);
  if (outputRoots.length > maxTurns) throw new Error("turn limit exceeded");
  let totalTextChars = 0;
  const turns: RawTurn[] = [];
  for (const root of outputRoots) {
    const roleMarkers = root.roleMarkers;
    const distinctRoles = new Set(roleMarkers.map(node => node.getAttribute("data-message-author-role")));
    if (distinctRoles.size !== 1) throw new Error("role ambiguity");
    const role = [...distinctRoles][0];
    if (role !== "user" && role !== "assistant") throw new Error("role drift");
    const roleNode = roleMarkers[0];
    if (roleNode === undefined) throw new Error("role missing");
    const stableId = uniqueNodeAttribute(root.root, roleNode, ["data-message-id", "data-turn-id", "data-conversation-turn-id"]);
    if (stableId === undefined) throw new Error("turn identity unavailable");
    const parentStableId = uniqueNodeAttribute(root.root, roleNode, ["data-parent-message-id", "data-parent-turn-id", "data-parent-id"]);
    const branchStableId = uniqueNodeAttribute(root.root, roleNode, ["data-branch-id", "data-conversation-branch-id", "data-message-branch-id"]);
    const text = boundedText(root.messageChunks.join("").replace(/\s+/g, " ").trim().normalize("NFC"), maxTextChars);
    totalTextChars += text.length;
    if (totalTextChars > MAX_TOTAL_TEXT_CHARS) throw new Error("text limit exceeded");
    const artifacts = root.artifacts;
    const state = readTurnState(root.root, roleNode);
    const finishReason = readFinishReason(root.root, roleNode);
    // Only read innerHTML for the exact assistant ID requested by the outer
    // transaction.  This keeps transient markup bounded and prevents a
    // page-wide/latest-message fallback from entering the response path.
    const contentHtml = role === "assistant" && captureAssistantTurnId === stableId
      ? boundedMarkup(roleNode.innerHTML, maxTextChars)
      : undefined;
    turns.push({
      role,
      stableId,
      ...(parentStableId === undefined ? {} : { parentStableId }),
      ...(branchStableId === undefined ? {} : { branchStableId }),
      ordinal: role === "user" ? turns.filter(turn => turn.role === "user").length : turns.filter(turn => turn.role === "assistant").length,
      text,
      ...(contentHtml === undefined ? {} : { contentHtml }),
      structure: {
        tag: root.root.tagName.toLowerCase().slice(0, 64),
        childCount: Math.min(root.directChildCount, MAX_NODES),
        artifactCount: artifacts.length
      },
      ...(state === undefined ? {} : { state }),
      ...(finishReason === undefined ? {} : { finishReason }),
      artifacts
    });
  }
  validateRawTurnOrdering(turns);
  const assistantTurns = turns.filter(turn => turn.role === "assistant");
  if (assistantTurns.some(turn => turn.state === undefined)) throw new Error("assistant state unavailable");
  const generating = assistantTurns.some(turn => turn.state === "generating");
  const terminal = assistantTurns.length > 0 && assistantTurns.every(turn => turn.state === "terminal");
  const terminalState: RawPageObservation["terminalState"] = generating
    ? "generating"
    : terminal
      ? "terminal"
      : assistantTurns.length === 0
        ? "idle"
        : "unknown";
  const completeness: RawPageObservation["completeness"] = completenessMarker === "truncated" || completenessMarker === "true"
    ? "truncated"
    : completenessMarker === "incomplete"
      ? "incomplete"
      : completenessMarker === "out_of_order"
        ? "out_of_order"
        : "complete";
  if (completeness !== "complete") throw new Error("incomplete conversation DOM");
  return {
    canonicalUrl,
    ...(resolvedConversationId === undefined ? {} : { conversationId: resolvedConversationId }),
    ...(resolvedThreadId === undefined ? {} : { threadId: resolvedThreadId }),
    turns,
    completeness,
    terminalState
  };

}

function validateOptions(options: BrowserObservationOptions): void {
  if (!isRecord(options) || !isBoundedId(options.operationId)) throw new BrowserObservationError("provider_shape_drift");
  if (typeof options.evidenceDigest !== "function") throw new BrowserObservationError("evidence_digest_failed");
  if (options.responseContent !== undefined && options.responseContent !== "include" && options.responseContent !== "metadata") {
    throw new BrowserObservationError("provider_shape_drift");
  }
  if (options.responseFormat !== undefined && options.responseFormat !== "markdown" && options.responseFormat !== "text") {
    throw new BrowserObservationError("provider_shape_drift");
  }
  const target = options.target;
  if (!isRecord(target)
    || !isBoundedId(target.providerId)
    || !isBoundedId(target.browserId)
    || !isBoundedId(target.tabId)
    || (target.coordinationScope !== "process" && target.coordinationScope !== "provider")
    || (target.targetLifecycle !== undefined
      && target.targetLifecycle !== "fixed"
      && target.targetLifecycle !== "new_pending"
      && target.targetLifecycle !== "new_established")
    || (target.coordinationScope === "provider" && target.authoritativeTabClaim === undefined)
    || (target.authoritativeTabClaim !== undefined && !isBoundedId(target.authoritativeTabClaim))) {
    throw new BrowserObservationError("missing_identity");
  }
  for (const value of [target.expectedConversationId, target.expectedThreadId, options.terminalAssistantTurnId, options.rawAssistantTurnId]) {
    if (value !== undefined && !isBoundedId(value)) throw new BrowserObservationError("provider_shape_drift");
  }
  for (const value of [options.maxTurns, options.maxTextChars, options.maxArtifactsPerTurn]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new BrowserObservationError("bounded_limit_exceeded");
  }
  if (options.baseline !== undefined && options.baseline.completeness !== "complete") {
    throw new BrowserObservationError("incomplete_dom");
  }
}

function parseRawObservation(value: unknown, args: RawEvaluateArguments): RawPageObservation {
  if (!isRecord(value)) throw new BrowserObservationError("provider_shape_drift");
  assertExactKeys(value, ["canonicalUrl", "conversationId", "threadId", "turns", "completeness", "terminalState"]);
  if (typeof value.canonicalUrl !== "string") {
    throw new BrowserObservationError("navigation_ambiguous");
  }
  if (!isBoundedUrl(value.canonicalUrl)
    || (value.conversationId !== undefined && !isBoundedId(value.conversationId))
    || (value.threadId !== undefined && !isBoundedId(value.threadId))) {
    throw new BrowserObservationError("navigation_ambiguous");
  }
  if ((value.conversationId === undefined || value.threadId === undefined)
    && (!args.allowBlankTask || value.conversationId !== undefined || value.threadId !== undefined)) {
    throw new BrowserObservationError("navigation_ambiguous");
  }
  if (!Array.isArray(value.turns) || value.turns.length > args.maxTurns) throw new BrowserObservationError("bounded_limit_exceeded");
  if (value.completeness !== "complete" && value.completeness !== "truncated" && value.completeness !== "incomplete" && value.completeness !== "out_of_order") {
    throw new BrowserObservationError("provider_shape_drift");
  }
  if (value.terminalState !== "idle" && value.terminalState !== "generating" && value.terminalState !== "terminal" && value.terminalState !== "unknown") {
    throw new BrowserObservationError("provider_shape_drift");
  }
  const turns: RawTurn[] = [];
  const seenIds = new Set<string>();
  let totalTextChars = 0;
  for (const candidate of value.turns) {
    if (!isRecord(candidate)) throw new BrowserObservationError("provider_shape_drift");
    assertExactKeys(candidate, ["role", "stableId", "parentStableId", "branchStableId", "ordinal", "text", "contentHtml", "structure", "state", "finishReason", "artifacts"]);
    if (candidate.role !== "user" && candidate.role !== "assistant") throw new BrowserObservationError("provider_shape_drift");
    if (!isBoundedId(candidate.stableId)) throw new BrowserObservationError("missing_identity");
    if (seenIds.has(candidate.stableId)) throw new BrowserObservationError("duplicate_identity");
    seenIds.add(candidate.stableId);
    if (!Number.isSafeInteger(candidate.ordinal) || candidate.ordinal < 0 || candidate.ordinal >= args.maxTurns) throw new BrowserObservationError("provider_shape_drift");
    if (typeof candidate.text !== "string" || candidate.text.length > args.maxTextChars) throw new BrowserObservationError("bounded_limit_exceeded");
    totalTextChars += candidate.text.length;
    if (totalTextChars > MAX_TOTAL_TEXT_CHARS) throw new BrowserObservationError("bounded_limit_exceeded");
    if (candidate.contentHtml !== undefined) {
      // A serialized page probe is only allowed to return markup for the
      // exact requested assistant.  Reject unsolicited/page-wide markup
      // rather than silently treating it as a valid capture.
      if (candidate.role !== "assistant" || args.captureAssistantTurnId === undefined || candidate.stableId !== args.captureAssistantTurnId) {
        throw new BrowserObservationError("provider_shape_drift");
      }
      if (typeof candidate.contentHtml !== "string" || candidate.contentHtml.length > args.maxTextChars || candidate.contentHtml.includes("\u0000")) {
        throw new BrowserObservationError("bounded_limit_exceeded");
      }
    }
    if (candidate.parentStableId !== undefined && !isBoundedId(candidate.parentStableId)) throw new BrowserObservationError("unstable_identity");
    if (candidate.branchStableId !== undefined && !isBoundedId(candidate.branchStableId)) throw new BrowserObservationError("unstable_identity");
    if (candidate.state !== undefined && candidate.state !== "generating" && candidate.state !== "terminal") throw new BrowserObservationError("provider_shape_drift");
    if (candidate.role === "assistant" && (candidate.parentStableId === undefined || candidate.branchStableId === undefined)) throw new BrowserObservationError("branch_ambiguous");
    if (candidate.role === "assistant" && candidate.state === undefined) throw new BrowserObservationError("provider_shape_drift");
    if (candidate.finishReason !== undefined && (!isBoundedText(candidate.finishReason, 128) || /[\u0000-\u001f\u007f]/u.test(candidate.finishReason))) throw new BrowserObservationError("provider_shape_drift");
    if (!isRecord(candidate.structure)
      || typeof candidate.structure.tag !== "string"
      || !Number.isSafeInteger(candidate.structure.childCount)
      || !Number.isSafeInteger(candidate.structure.artifactCount)
      || candidate.structure.childCount < 0
      || candidate.structure.childCount > MAX_NODES
      || candidate.structure.artifactCount < 0) {
      throw new BrowserObservationError("provider_shape_drift");
    }
    assertExactKeys(candidate.structure, ["tag", "childCount", "artifactCount"]);
    if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length > args.maxArtifactsPerTurn) throw new BrowserObservationError("bounded_limit_exceeded");
    const artifactIds = new Set<string>();
    const artifacts: RawArtifact[] = [];
    for (const rawArtifact of candidate.artifacts) {
      if (!isRecord(rawArtifact)
        || (rawArtifact.kind !== "file" && rawArtifact.kind !== "image" && rawArtifact.kind !== "other")
        || !isBoundedId(rawArtifact.identity)) throw new BrowserObservationError("provider_shape_drift");
      assertExactKeys(rawArtifact, ["kind", "identity", "contentDigest", "bytes", "mimeType"]);
      if (artifactIds.has(rawArtifact.identity)) throw new BrowserObservationError("duplicate_identity");
      artifactIds.add(rawArtifact.identity);
      if (rawArtifact.contentDigest !== undefined && !isContentDigest(rawArtifact.contentDigest)) throw new BrowserObservationError("provider_shape_drift");
      if (rawArtifact.bytes !== undefined && (!Number.isSafeInteger(rawArtifact.bytes) || rawArtifact.bytes < 0 || rawArtifact.bytes > MAX_ARTIFACT_BYTES)) throw new BrowserObservationError("bounded_limit_exceeded");
      if (rawArtifact.mimeType !== undefined && !isBoundedText(rawArtifact.mimeType, 128)) throw new BrowserObservationError("provider_shape_drift");
      artifacts.push(Object.freeze({
        kind: rawArtifact.kind,
        identity: rawArtifact.identity,
        ...(rawArtifact.contentDigest === undefined ? {} : { contentDigest: rawArtifact.contentDigest }),
        ...(rawArtifact.bytes === undefined ? {} : { bytes: rawArtifact.bytes }),
        ...(rawArtifact.mimeType === undefined ? {} : { mimeType: rawArtifact.mimeType })
      }));
    }
    turns.push(Object.freeze({
      role: candidate.role,
      stableId: candidate.stableId,
      ...(candidate.parentStableId === undefined ? {} : { parentStableId: candidate.parentStableId }),
      ...(candidate.branchStableId === undefined ? {} : { branchStableId: candidate.branchStableId }),
      ordinal: candidate.ordinal,
      text: candidate.text,
      ...(candidate.contentHtml === undefined ? {} : { contentHtml: candidate.contentHtml }),
      structure: Object.freeze({
        tag: candidate.structure.tag,
        childCount: candidate.structure.childCount,
        artifactCount: candidate.structure.artifactCount
      }),
      ...(candidate.state === undefined ? {} : { state: candidate.state }),
      ...(candidate.finishReason === undefined ? {} : { finishReason: candidate.finishReason }),
      artifacts: Object.freeze(artifacts)
    }));
  }
  validateRawTurnOrdering(turns);
  const assistant = turns.filter(turn => turn.role === "assistant");
  if (assistant.some(turn => turn.state === undefined)) throw new BrowserObservationError("provider_shape_drift");
  const hasGeneratingAssistant = assistant.some(turn => turn.state === "generating");
  const hasOnlyTerminalAssistants = assistant.length > 0 && assistant.every(turn => turn.state === "terminal");
  const expectedTerminalState = hasGeneratingAssistant
    ? "generating"
    : hasOnlyTerminalAssistants
      ? "terminal"
      : assistant.length === 0
        ? "idle"
        : "unknown";
  if (value.terminalState !== expectedTerminalState) throw new BrowserObservationError("unstable_identity");
  if (value.completeness !== "complete") throw new BrowserObservationError("incomplete_dom");
  return Object.freeze({
    canonicalUrl: value.canonicalUrl,
    conversationId: value.conversationId,
    threadId: value.threadId,
    turns: Object.freeze(turns),
    completeness: value.completeness,
    terminalState: value.terminalState
  });
}

function normalizeTurns(turns: readonly RawTurn[], options: BrowserObservationOptions): { userTurns: OwnershipTurn[]; assistantTurns: OwnershipTurn[] } {
  const users: OwnershipTurn[] = [];
  const assistants: OwnershipTurn[] = [];
  const assistantParents = new Map<string, Set<string>>();
  for (const raw of turns) {
    const artifactEvidenceDigests = raw.artifacts.map((artifact, ordinal) => digest(options.evidenceDigest, "browser-observation-artifact", {
      operationId: options.operationId,
      turnId: raw.stableId,
      ordinal,
      kind: artifact.kind,
      identity: artifact.identity,
      ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
      ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
      ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType })
    }));
    const evidenceDigest = digest(options.evidenceDigest, "browser-observation-turn", {
      operationId: options.operationId,
      role: raw.role,
      stableId: raw.stableId,
      ...(raw.parentStableId === undefined ? {} : { parentStableId: raw.parentStableId }),
      ...(raw.branchStableId === undefined ? {} : { branchStableId: raw.branchStableId }),
      ordinal: raw.ordinal,
      text: raw.text,
      artifacts: artifactEvidenceDigests
    });
    const structureDigest = digest(options.evidenceDigest, "browser-observation-structure", {
      operationId: options.operationId,
      role: raw.role,
      stableId: raw.stableId,
      ordinal: raw.ordinal,
      structure: raw.structure,
      artifacts: artifactEvidenceDigests
    });
    const turn: OwnershipTurn = Object.freeze({
      stableId: raw.stableId,
      evidenceDigest,
      structureDigest,
      ordinal: raw.ordinal,
      ...(raw.parentStableId === undefined ? {} : { parentStableId: raw.parentStableId }),
      ...(raw.branchStableId === undefined ? {} : { branchStableId: raw.branchStableId }),
      ...(raw.state === undefined ? {} : { state: raw.state }),
      artifactEvidenceDigests: Object.freeze(artifactEvidenceDigests)
    });
    if (raw.role === "user") users.push(turn);
    else {
      assistants.push(turn);
      const parent = raw.parentStableId!;
      const branches = assistantParents.get(parent) ?? new Set<string>();
      if (branches.has(raw.branchStableId!)) throw new BrowserObservationError("branch_ambiguous");
      branches.add(raw.branchStableId!);
      assistantParents.set(parent, branches);
    }
  }
  return { userTurns: users, assistantTurns: assistants };
}

function resolveTerminalTurn(
  rawTurns: readonly RawTurn[],
  assistantTurns: readonly OwnershipTurn[],
  options: BrowserObservationOptions
): { raw: RawTurn; normalized: OwnershipTurn } | undefined {
  const requestedId = options.terminalAssistantTurnId ?? options.rawAssistantTurnId;
  if (requestedId === undefined) return undefined;
  const raw = rawTurns.find(turn => turn.role === "assistant" && turn.stableId === requestedId);
  const normalized = assistantTurns.find(turn => turn.stableId === requestedId);
  if (raw === undefined || normalized === undefined || raw.state !== "terminal") throw new BrowserObservationError("raw_content_unavailable");
  if (raw.finishReason === undefined) throw new BrowserObservationError("provider_shape_drift");
  return { raw, normalized };
}

function terminalObservation(
  raw: RawTurn,
  normalized: OwnershipTurn,
  userTurns: readonly OwnershipTurn[],
  options: BrowserObservationOptions,
  _target: FrozenTarget
): CollectorTerminalObservation {
  if (raw.parentStableId === undefined || raw.branchStableId === undefined || raw.state !== "terminal" || raw.finishReason === undefined) {
    throw new BrowserObservationError("provider_shape_drift");
  }
  const user = userTurns.find(turn => turn.stableId === raw.parentStableId);
  if (user === undefined) throw new BrowserObservationError("branch_ambiguous");
  if (raw.contentHtml === undefined) throw new BrowserObservationError("raw_content_unavailable");
  const requestedFormat = options.responseFormat ?? "markdown";
  const normalizedFormat = normalizeResponseFormat(requestedFormat);
  if (normalizedFormat !== "markdown" && normalizedFormat !== "normalized_text") {
    throw new BrowserObservationError("provider_shape_drift");
  }
  const maxResponseChars = boundedPositive(options.maxTextChars, MAX_TEXT_CHARS);
  let formatted: ReturnType<typeof formatMessageHtml>;
  try {
    formatted = formatMessageHtml(raw.contentHtml, requestedFormat, maxResponseChars);
  } catch {
    throw new BrowserObservationError("provider_shape_drift");
  }
  if (formatted.captureLimit?.clipped === true) throw new BrowserObservationError("bounded_limit_exceeded");
  if (formatted.text.length === 0 && raw.text.length > 0) throw new BrowserObservationError("provider_shape_drift");
  if (formatted.text.length > maxResponseChars || utf8Bytes(formatted.text) > MAX_RESPONSE_BYTES) {
    throw new BrowserObservationError("bounded_limit_exceeded");
  }
  const textDigest = digest(options.evidenceDigest, "browser-observation-response", {
    operationId: options.operationId,
    assistantTurnId: raw.stableId,
    responseFormat: requestedFormat,
    text: formatted.text
  });
  const text: CollectorTextDigest = Object.freeze({
    digest: textDigest,
    bytes: utf8Bytes(formatted.text),
    chars: formatted.text.length
  });
  const artifacts: CollectorArtifact[] = raw.artifacts.map((artifact, ordinal) => {
    const sourceIdentityDigest = normalized.artifactEvidenceDigests?.[ordinal];
    if (sourceIdentityDigest === undefined) throw new BrowserObservationError("provider_shape_drift");
    return Object.freeze({
      kind: artifact.kind,
      ordinal,
      sourceIdentityDigest,
      ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
      ...(artifact.bytes === undefined ? {} : { bytes: artifact.bytes }),
      ...(artifact.mimeType === undefined ? {} : { mimeType: artifact.mimeType })
    });
  });
  return Object.freeze({
    schemaVersion: COLLECTOR_TERMINAL_SCHEMA_VERSION,
    userTurnId: raw.parentStableId,
    assistantTurnId: raw.stableId,
    userTurnEvidenceDigest: user.evidenceDigest,
    assistantTurnEvidenceDigest: normalized.evidenceDigest,
    userOrdinal: user.ordinal,
    assistantOrdinal: raw.ordinal,
    branchStableId: raw.branchStableId,
    text,
    responseFormat: requestedFormat,
    ...(options.responseContent === "include" && options.rawAssistantTurnId === raw.stableId ? { rawText: formatted.text } : {}),
    artifacts: Object.freeze(artifacts),
    finishReason: raw.finishReason
  });
}

function makePostSendDelta(
  baseline: OwnershipBaseline,
  users: readonly OwnershipTurn[],
  evidenceDigest: BrowserObservationDigest
): OwnershipSnapshot["postSendDelta"] {
  const baselineIds = new Set<string>();
  let baselineCursor = 0;
  for (const turn of baseline.userTurns) {
    if (turn.stableId === undefined || baselineIds.has(turn.stableId)) throw new BrowserObservationError("unstable_identity");
    baselineIds.add(turn.stableId);
    const fresh = users[baselineCursor];
    if (fresh?.stableId !== turn.stableId || fresh.evidenceDigest !== turn.evidenceDigest) throw new BrowserObservationError("incomplete_dom");
    baselineCursor += 1;
  }
  const added = users.slice(baselineCursor);
  const addedUserEvidenceDigests = added.map(turn => turn.evidenceDigest);
  const deltaDigest = digest(evidenceDigest, "browser-observation-post-send-delta", {
    baselineSnapshotDigest: baseline.snapshotDigest,
    addedUserEvidenceDigests
  });
  return Object.freeze({
    baselineSnapshotDigest: baseline.snapshotDigest,
    addedUserEvidenceDigests: Object.freeze(addedUserEvidenceDigests),
    deltaDigest
  });
}

function buildTarget(raw: RawPageObservation, options: BrowserObservationOptions): FrozenTarget {
  if (options.target.expectedConversationId !== undefined && options.target.expectedConversationId !== raw.conversationId) throw new BrowserObservationError("navigation_ambiguous");
  if (options.target.expectedThreadId !== undefined && options.target.expectedThreadId !== raw.threadId) throw new BrowserObservationError("navigation_ambiguous");
  const hasConversationIdentity = raw.conversationId !== undefined && raw.threadId !== undefined;
  const canonicalDigest = hasConversationIdentity
    ? digest(options.evidenceDigest, "browser-observation-url", raw.canonicalUrl)
    : undefined;
  const target: FrozenTarget = {
    provider: availableIdentity(options.target.providerId),
    browser: availableIdentity(options.target.browserId),
    tab: availableIdentity(options.target.tabId),
    thread: raw.threadId === undefined ? unavailableIdentity("not_observed") : availableIdentity(raw.threadId),
    conversation: raw.conversationId === undefined ? unavailableIdentity("not_observed") : availableIdentity(raw.conversationId),
    canonicalThreadUrl: canonicalDigest === undefined
      ? unavailableIdentity("not_observed")
      : availableUrlIdentity(`${OPAQUE_URL_PREFIX}${canonicalDigest.slice("hmac-sha256:".length)}`),
    authoritativeTabClaim: options.target.authoritativeTabClaim === undefined
      ? unavailableIdentity("not_exposed")
      : availableIdentity(options.target.authoritativeTabClaim),
    coordinationScope: options.target.coordinationScope
  };
  return Object.freeze(target);
}

function targetMaterial(target: OwnershipTargetEvidence): unknown {
  return {
    provider: target.provider,
    browser: target.browser,
    tab: target.tab,
    thread: target.thread,
    conversation: target.conversation,
    canonicalThreadUrl: target.canonicalThreadUrl,
    authoritativeTabClaim: target.authoritativeTabClaim,
    coordinationScope: target.coordinationScope
  };
}

function turnMaterial(turn: OwnershipTurn): unknown {
  return {
    stableId: turn.stableId,
    evidenceDigest: turn.evidenceDigest,
    structureDigest: turn.structureDigest,
    ordinal: turn.ordinal,
    ...(turn.parentStableId === undefined ? {} : { parentStableId: turn.parentStableId }),
    ...(turn.branchStableId === undefined ? {} : { branchStableId: turn.branchStableId }),
    ...(turn.state === undefined ? {} : { state: turn.state }),
    artifactEvidenceDigests: turn.artifactEvidenceDigests ?? []
  };
}

function digest(fn: BrowserObservationDigest, domain: string, material: unknown): string {
  let result: unknown;
  try {
    result = fn(domain, material);
  } catch {
    throw new BrowserObservationError("evidence_digest_failed");
  }
  if (typeof result !== "string" || !DIGEST_PATTERN.test(result)) throw new BrowserObservationError("evidence_digest_failed");
  return result;
}

function availableIdentity(value: string): OwnershipIdentityEvidence {
  return Object.freeze({ status: "available", value });
}

function availableUrlIdentity(value: string): OwnershipIdentityEvidence {
  return Object.freeze({ status: "available", value });
}

function unavailableIdentity(reason: "not_exposed" | "not_observed" | "redacted"): OwnershipIdentityEvidence {
  return Object.freeze({ status: "unavailable", reason });
}

function validateRawTurnOrdering(turns: readonly RawTurn[]): void {
  const counters = { user: 0, assistant: 0 };
  for (const turn of turns) {
    if (turn.ordinal !== counters[turn.role]) throw new BrowserObservationError("incomplete_dom");
    counters[turn.role] += 1;
  }
  const users = new Set(turns.filter(turn => turn.role === "user").map(turn => turn.stableId));
  for (const turn of turns) {
    if (turn.role === "assistant" && (turn.parentStableId === undefined || !users.has(turn.parentStableId))) throw new BrowserObservationError("branch_ambiguous");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new BrowserObservationError("provider_shape_drift");
  }
}

function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000]/u.test(value);
}

function isBoundedUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_ATTRIBUTE_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function isContentDigest(value: unknown): value is string {
  return typeof value === "string" && /^(?:hmac-sha256:|sha256:)[0-9a-f]{64}$/.test(value);
}

function boundedPositive(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, fallback) : fallback;
}

function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error("non-canonical navigation");
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/u, "") || "/";
  return url.toString();
}

function conversationIdFromUrl(urlValue: string): string | undefined {
  const url = new URL(urlValue);
  const parts = url.pathname.split("/").filter(Boolean);
  const index = parts.findIndex(part => part === "c" || part === "conversation");
  const candidate = index >= 0 ? parts[index + 1] : undefined;
  return candidate !== undefined && ID_PATTERN.test(candidate) ? candidate : undefined;
}

function boundedQueryElements<T extends Element>(
  root: Node,
  selector: string,
  maxMatched = MAX_NODES,
  maxVisited = MAX_NODES
): T[] {
  const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument;
  if (ownerDocument === null || typeof ownerDocument.createTreeWalker !== "function") {
    throw new Error("DOM traversal unavailable");
  }
  // Count every browser node, not only selector-capable elements.
  const walker = ownerDocument.createTreeWalker(root, 0xffffffff);
  const matches: T[] = [];
  let visited = 0;
  let current = walker.nextNode();
  while (current !== null) {
    visited += 1;
    if (visited > maxVisited) throw new Error("node limit exceeded");
    const element = current.nodeType === 1 ? current as Element : undefined;
    if (element !== undefined && element.matches(selector)) {
      matches.push(element as T);
      if (matches.length > maxMatched) throw new Error("node limit exceeded");
    }
    current = walker.nextNode();
  }
  return matches;
}

function uniqueAttributeValue(root: Document, names: readonly string[], max: number): string | undefined {
  const values = new Set<string>();
  const selector = names.map(name => `[${name}]`).join(",");
  const nodes = boundedQueryElements<HTMLElement>(root, selector);
  for (const node of nodes) {
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value !== null && value.length > 0) {
        if (value.length > max || !ID_PATTERN.test(value)) throw new Error("attribute drift");
        values.add(value);
      }
    }
  }
  if (values.size > 1) throw new Error("ambiguous identity");
  return [...values][0];
}

function uniqueNodeAttribute(root: HTMLElement, roleNode: HTMLElement, names: readonly string[]): string | undefined {
  const values = new Set<string>();
  for (const node of [root, roleNode]) {
    for (const name of names) {
      const value = node.getAttribute(name);
      if (value !== null && value.length > 0) {
        if (value.length > MAX_ATTRIBUTE_LENGTH || !ID_PATTERN.test(value)) throw new Error("attribute drift");
        values.add(value);
      }
    }
  }
  if (values.size > 1) throw new Error("unstable identity");
  return [...values][0];
}

function messageText(node: HTMLElement): string {
  const ignored = (element: Element): boolean => element.matches("button,[role='button'],[aria-hidden='true'],script,style,svg");
  const chunks: string[] = [];
  const ancestors: Node[] = [];
  let visited = 0;
  let total = 0;
  let current: Node | null = node.firstChild;
  while (current !== null) {
    visited += 1;
    if (visited > MAX_NODES) throw new Error("node limit exceeded");
    const element = current.nodeType === 1 ? current as Element : undefined;
    const skip = element !== undefined && ignored(element);
    if (!skip && current.nodeType === 3) {
      const value = current.nodeValue ?? "";
      total += value.length;
      if (total > MAX_TEXT_CHARS) throw new Error("text limit exceeded");
      if (value.length > 0) chunks.push(value);
    }
    const child: Node | null = skip ? null : current.firstChild;
    if (child !== null) {
      if (ancestors.length >= MAX_NODES) throw new Error("node limit exceeded");
      ancestors.push(current);
      current = child;
      continue;
    }
    while (current !== null && current.nextSibling === null) current = ancestors.pop() ?? null;
    if (current !== null) current = current.nextSibling;
  }
  return chunks.join("").replace(/\s+/g, " ").trim().normalize("NFC");
}

function boundedTextLength(node: Element, max: number): number {
  const ancestors: Node[] = [];
  let total = 0;
  let visited = 0;
  let current: Node | null = node;
  while (current !== null) {
    visited += 1;
    if (visited > MAX_NODES) throw new Error("node limit exceeded");
    if (current.nodeType === 3) {
      total += (current.nodeValue ?? "").length;
      if (total > max) throw new Error("artifact text limit");
    }
    const child: Node | null = current.firstChild;
    if (child !== null) {
      if (ancestors.length >= MAX_NODES) throw new Error("node limit exceeded");
      ancestors.push(current);
      current = child;
      continue;
    }
    while (current !== null && current !== node && current.nextSibling === null) current = ancestors.pop() ?? null;
    if (current === node) break;
    if (current !== null) current = current.nextSibling;
  }
  return total;
}

function boundedText(value: string, max: number): string {
  if (value.length > max || value.includes("\u0000")) throw new Error("text limit exceeded");
  return value;
}

function readArtifacts(root: HTMLElement, maxArtifacts: number, maxTextChars: number): RawArtifact[] {
  const selector = "[data-artifact-id],[data-file-id],[data-attachment-id],[data-image-id],[data-testid*='artifact' i],[data-testid*='file' i],[data-testid*='image' i],a[download]";
  const nodes = boundedQueryElements<HTMLElement>(root, selector, maxArtifacts);
  const seen = new Set<string>();
  const artifacts: RawArtifact[] = [];
  for (const node of nodes) {
    const identity = uniqueNodeAttribute(node, node, ["data-artifact-id", "data-file-id", "data-attachment-id", "data-image-id"])
      ?? (node.getAttribute("data-testid") ?? "");
    if (!isBoundedId(identity) || seen.has(identity)) throw new Error("artifact identity unavailable");
    seen.add(identity);
    const testId = (node.getAttribute("data-testid") ?? "").toLowerCase();
    const kind = node.tagName.toLowerCase() === "img" || testId.includes("image") || node.hasAttribute("data-image-id") ? "image" : testId.includes("file") || node.hasAttribute("data-file-id") || node.hasAttribute("data-attachment-id") || node.tagName.toLowerCase() === "a" ? "file" : "other";
    const contentDigest = node.getAttribute("data-content-sha256") ?? node.getAttribute("data-sha256") ?? undefined;
    if (contentDigest !== undefined && !isContentDigest(contentDigest)) throw new Error("artifact digest drift");
    const bytesRaw = node.getAttribute("data-bytes") ?? node.getAttribute("data-size") ?? undefined;
    const bytes = bytesRaw === undefined ? undefined : Number(bytesRaw);
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ARTIFACT_BYTES)) throw new Error("artifact bytes limit");
    const mimeType = node.getAttribute("data-mime-type") ?? node.getAttribute("type") ?? undefined;
    if (mimeType !== undefined && !isBoundedText(mimeType, 128)) throw new Error("artifact MIME drift");
    boundedTextLength(node, maxTextChars);
    artifacts.push({ kind, identity, ...(contentDigest === undefined ? {} : { contentDigest }), ...(bytes === undefined ? {} : { bytes }), ...(mimeType === undefined ? {} : { mimeType }) });
  }
  return artifacts;
}

function readTurnState(root: HTMLElement, roleNode: HTMLElement): "generating" | "terminal" | undefined {
  const values = [root, roleNode].flatMap(node => [
    node.getAttribute("data-generation-state"),
    node.getAttribute("data-state"),
    node.getAttribute("data-status"),
    node.getAttribute("data-turn-state"),
    node.getAttribute("data-generating") === "true" ? "generating" : node.getAttribute("data-generating") === "false" ? "terminal" : null,
    node.getAttribute("aria-busy") === "true" ? "generating" : node.getAttribute("aria-busy") === "false" ? "terminal" : null
  ]).filter((value): value is string => value !== null && value !== undefined).map(value => value.trim().toLowerCase());
  const generating = values.filter(value => ["generating", "streaming", "in_progress", "in-progress", "true"].includes(value));
  const terminal = values.filter(value => ["terminal", "complete", "completed", "done", "false"].includes(value));
  if (generating.length > 0 && terminal.length > 0) throw new Error("unstable generation state");
  if (generating.length > 0) return "generating";
  if (terminal.length > 0) return "terminal";
  return undefined;
}

function readFinishReason(root: HTMLElement, roleNode: HTMLElement): string | undefined {
  for (const node of [root, roleNode]) {
    for (const name of ["data-finish-reason", "data-stop-reason", "data-completion-reason"]) {
      const value = node.getAttribute(name);
      if (value !== null && value.length > 0) return value.trim().slice(0, 128);
    }
  }
  return undefined;
}

function readCompleteness(root: Document): RawPageObservation["completeness"] {
  const markers = boundedQueryElements<HTMLElement>(root, "[data-observation-completeness],[data-conversation-completeness],[data-turns-truncated]");
  for (const marker of markers) {
    const value = (marker.getAttribute("data-observation-completeness") ?? marker.getAttribute("data-conversation-completeness") ?? marker.getAttribute("data-turns-truncated") ?? "").toLowerCase();
    if (value === "truncated" || value === "true") return "truncated";
    if (value === "incomplete") return "incomplete";
    if (value === "out_of_order") return "out_of_order";
  }
  return "complete";
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
