import type { BlockerKind, CommandContext, CommandResult } from "./types.js";

type BlockerDetails = Partial<Omit<NonNullable<CommandResult["blocker"]>, "kind" | "message" | "visibleText">>;

export const BROWSER_BRIDGE_UNAVAILABLE_MESSAGE =
  "Codex cannot access the ChatGPT browser bridge from this backend process. In an ordinary shell this is expected; for a live Codex Chrome run, assign the Chrome plugin runtime returned by setupBrowserRuntime() to globalThis.agent before using it.";

export const BROWSER_BRIDGE_REMEDIATION: NonNullable<NonNullable<CommandResult["blocker"]>["remediation"]> = [
  {
    label: "Ordinary shell",
    instruction: "Treat browser_bridge_unavailable from a plain shell as an expected protocol/blocker-path result, not proof that Chrome, ChatGPT, or the Codex extension is broken.",
    userActionRequired: false
  },
  {
    label: "Codex Chrome bootstrap",
    instruction: "For a live run, initialize the Chrome plugin runtime in node_repl with globalThis.agent = await setupBrowserRuntime(), then set globalThis.browser = await agent.browsers.get(\"extension\") before calling createChatGPT({ agent: globalThis.agent }).",
    userActionRequired: false
  },
  {
    label: "Python live bridge",
    instruction: "For Python browser-bridge smokes, keep the bridge-hosted Node backend JS execution alive and run scripts/http_stdio_relay.mjs with CHATGPT_BROWSER_BACKEND_HTTP_URL; a plain Python-spawned Node subprocess cannot inherit globalThis.agent.",
    userActionRequired: false
  },
  {
    label: "Extension availability",
    instruction: "If this command was already running inside a bootstrapped bridge host, verify the Codex Chrome extension is installed and enabled, then restart Chrome or Codex before retrying.",
    userActionRequired: true
  }
];

export class ChatGPTControlError extends Error {
  constructor(
    message: string,
    public readonly kind: BlockerKind,
    public readonly recoverable: boolean,
    public readonly visibleText?: string,
    public readonly blockerDetails: BlockerDetails = {}
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BrowserBridgeUnavailableError extends ChatGPTControlError {
  constructor(message = BROWSER_BRIDGE_UNAVAILABLE_MESSAGE) {
    super(message, "browser_bridge_unavailable", true, undefined, {
      code: "codex_chrome_bridge_unavailable",
      remediation: BROWSER_BRIDGE_REMEDIATION
    });
  }
}

export class LoginRequiredError extends ChatGPTControlError {
  constructor(visibleText?: string) {
    super("ChatGPT login is required before this command can continue.", "login_required", true, visibleText);
  }
}

export class SelectorDriftError extends ChatGPTControlError {
  constructor(message: string, visibleText?: string) {
    super(message, "selector_drift", true, visibleText);
  }
}

export class ConfirmationRequiredError extends ChatGPTControlError {
  constructor(message: string, visibleText?: string) {
    super(message, "confirmation", true, visibleText);
  }
}

export class TimeoutPartialError extends ChatGPTControlError {
  constructor(message: string, visibleText?: string) {
    super(message, "unknown", true, visibleText);
  }
}

export function contextNow(partial: Partial<CommandContext> = {}): CommandContext {
  return {
    timestamp: new Date().toISOString(),
    ...partial
  };
}

export function resultOk<T>(
  data: T,
  context: Partial<CommandContext> = {},
  warnings: string[] = []
): CommandResult<T> {
  return {
    ok: true,
    status: "ok",
    data,
    warnings,
    context: contextNow(context)
  };
}

export function resultBlocked(
  kind: BlockerKind,
  message: string,
  visibleText?: string,
  context: Partial<CommandContext> = {}
): CommandResult<never> {
  const blocker = visibleText === undefined ? { kind, message } : { kind, message, visibleText };

  return {
    ok: false,
    status: "blocked",
    warnings: [],
    blocker,
    context: contextNow(context)
  };
}

export function resultError(
  error: Error,
  context: Partial<CommandContext> = {},
  recoverable = error instanceof ChatGPTControlError ? error.recoverable : false
): CommandResult<never> {
  const blocker = error instanceof ChatGPTControlError
    ? error.visibleText === undefined
      ? {
          kind: error.kind,
          message: error.message,
          ...error.blockerDetails
        }
      : {
          kind: error.kind,
          message: error.message,
          visibleText: error.visibleText,
          ...error.blockerDetails
        }
    : undefined;

  const result: CommandResult<never> = {
    ok: false,
    status: blocker ? "blocked" : "error",
    warnings: [],
    error: {
      name: error.name,
      message: error.message,
      recoverable
    },
    context: contextNow(context)
  };

  if (blocker !== undefined) {
    result.blocker = blocker;
  }

  return result;
}

export function toCommandResult(error: unknown, context: Partial<CommandContext> = {}): CommandResult<never> {
  if (error instanceof Error) {
    return resultError(error, context);
  }

  return resultError(new Error(String(error)), context);
}
