import type { BrowserLike, CommandResult } from "../../types.js";

export type LiveSmokeStatus = "pass" | "fail" | "skip";

export type LiveSmokeCleanupResult = {
  attempted: boolean;
  ok: boolean;
  closedTabCount?: number;
  reason?: string;
  error?: {
    name: string;
    message: string;
  };
};

export type LiveSmokeScenarioResult = {
  name: string;
  status: LiveSmokeStatus;
  required: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  command?: CommandResult<unknown>;
  details?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
  };
  cleanup?: LiveSmokeCleanupResult;
};

export type LiveSmokeBrowser = BrowserLike & {
  tabs?: BrowserLike["tabs"] & {
    finalize?: (options: { keep?: unknown[] }) => Promise<void>;
  };
};

export type LiveSmokeContext = {
  agent: unknown;
  browser?: LiveSmokeBrowser;
  /** Optional tool-scoped browser that owns tab finalization but is not used for behavior. */
  cleanupBrowser?: LiveSmokeBrowser;
  env?: Record<string, string | undefined>;
  reportDir: string;
  knownThreadQuery?: string;
  knownThreadUrl?: string;
  knownConversationId?: string;
};

export type LiveSmokeScenario = {
  name: string;
  required: boolean;
  enabled: (context: LiveSmokeContext) => boolean;
  run: (context: LiveSmokeContext) => Promise<LiveSmokeScenarioResult>;
};

export type LiveSmokeRunResult = {
  reportPath: string;
  results: LiveSmokeScenarioResult[];
  requiredFailures: LiveSmokeScenarioResult[];
};
