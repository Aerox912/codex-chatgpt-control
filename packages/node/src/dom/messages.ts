import type {
  BrowserOperationOptions,
  PageLike,
  ResponseAction,
  ResponseBlock,
  ResponseBranchState,
  ResponseCaptureLimit,
  ResponseCaptureFidelity,
  ResponseCaptureSource,
  ResponseCitation,
  ResponseCodeBlock,
  ResponseFormat,
  ResponseTable
} from "../types.js";
import { extractRoleMessageHtml, formatMessageHtml, normalizeResponseFormat } from "./message-format.js";
import { localeLabels } from "./locale-labels.js";
import { normalizeWhitespace } from "./visible-text.js";

export type MessageRole = "user" | "assistant";

export type ExtractedMessage = {
  role: MessageRole;
  text: string;
  format: Exclude<ResponseFormat, "text">;
  source?: ResponseCaptureSource;
  fidelity?: ResponseCaptureFidelity;
  captureLimit?: ResponseCaptureLimit;
  warnings?: string[];
  markdown?: string;
  visibleText?: string;
  normalizedText?: string;
  html?: string;
  blocks?: ResponseBlock[];
  citations?: ResponseCitation[];
  codeBlocks?: ResponseCodeBlock[];
  tables?: ResponseTable[];
  branch?: ResponseBranchState;
  actions?: ResponseAction[];
  thoughtDurationText?: string;
  sourcesAvailable?: boolean;
};

export type ReadMessagesArgs = {
  role?: MessageRole;
  scope?: "visible" | "loaded";
  format?: ResponseFormat;
  maxChars?: number;
};

export type LatestMessageTextSnapshot = {
  latestText?: string;
  turnCount: number;
};

export function extractMessagesFromHtml(html: string, args: ReadMessagesArgs = {}): ExtractedMessage[] {
  return extractRoleMessageHtml(html)
    .filter(message => args.role === undefined || message.role === args.role)
    .map(message => normalizeExtractedMessage(message, args));
}

export async function readMessages(page: PageLike, args: ReadMessagesArgs = {}): Promise<ExtractedMessage[]> {
  if (typeof page.evaluate === "function") {
    const messages = await page.evaluate(() => {
      const legacy = Array.from(document.querySelectorAll("[data-message-author-role]"));
      const nodes = legacy.length > 0 ? legacy : Array.from(document.querySelectorAll(
        "main [data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]"
      ));
      return nodes
        .map(node => {
          const role = node.getAttribute("data-message-author-role")
            ?? node.getAttribute("data-chatgpt-search-unit-key")?.split(":").at(-1);
          if (role !== "user" && role !== "assistant") {
            return undefined;
          }
          const content = role === "user" ? node.querySelector?.('[data-user-message-bubble="true"]')
            : node.querySelector?.('[data-markdown-text-style="assistant-message"]');
          return {
            role,
            html: content?.innerHTML || node.innerHTML.replace(/<h4\b[^>]*data-conversation-role=["']assistant["'][^>]*>[\s\S]*?<\/h4>/i, ""),
            metadataHtml: (node.closest("[data-testid^='conversation-turn']") as HTMLElement | null)?.outerHTML ?? node.outerHTML
          };
        })
        .filter(Boolean) as Array<{ role: "user" | "assistant"; html: string; metadataHtml?: string }>;
    });

    return messages
      .filter(message => args.role === undefined || message.role === args.role)
      .map(message => normalizeExtractedMessage(message, args));
  }

  if (typeof page.content === "function") {
    const html = await page.content();
    return extractMessagesFromHtml(html, args);
  }

  return [];
}

export async function readLatestMessage(
  page: PageLike,
  role: MessageRole = "assistant",
  format: ResponseFormat = "markdown",
  maxChars?: number
): Promise<ExtractedMessage | undefined> {
  if (typeof page.evaluate === "function") {
    const message = await page.evaluate((wantedRole: MessageRole) => {
      const legacy = Array.from(document.querySelectorAll(`[data-message-author-role="${wantedRole}"]`));
      const nodes = legacy.length > 0 ? legacy : Array.from(document.querySelectorAll(
        `main [data-chatgpt-search-unit-key$=":${wantedRole}"][data-chatgpt-search-message-ids]`
      ));
      const node = nodes.at(-1);
      if (node === undefined) return undefined;
      const content = wantedRole === "user" ? node.querySelector?.('[data-user-message-bubble="true"]')
        : node.querySelector?.('[data-markdown-text-style="assistant-message"]');
      return {
        role: wantedRole,
        html: content?.innerHTML || node.innerHTML.replace(/<h4\b[^>]*data-conversation-role=["']assistant["'][^>]*>[\s\S]*?<\/h4>/i, ""),
        metadataHtml: (node.closest("[data-testid^='conversation-turn']") as HTMLElement | null)?.outerHTML ?? node.outerHTML
      };
    }, role).catch(() => undefined);

    if (message !== undefined) {
      const args: ReadMessagesArgs = { role, format };
      if (maxChars !== undefined) args.maxChars = maxChars;
      return normalizeExtractedMessage(message, args);
    }
    return undefined;
  }

  const args: ReadMessagesArgs = { role, format };
  if (maxChars !== undefined) args.maxChars = maxChars;
  const messages = await readMessages(page, args);
  return messages.at(-1);
}

export async function readLatestMessageText(
  page: PageLike,
  role: MessageRole = "assistant"
): Promise<string | undefined> {
  if (typeof page.evaluate === "function") {
    return page.evaluate((wantedRole: MessageRole) => {
      const legacy = Array.from(document.querySelectorAll(`[data-message-author-role="${wantedRole}"]`));
      const nodes = legacy.length > 0 ? legacy : Array.from(document.querySelectorAll(
        `main [data-chatgpt-search-unit-key$=":${wantedRole}"][data-chatgpt-search-message-ids]`
      ));
      const node = nodes.at(-1) as HTMLElement | undefined;
      if (node?.getAttribute("data-chatgpt-search-unit-key") === null) return node?.innerText ?? node?.textContent ?? undefined;
      if (node === undefined) return undefined;
      const content = wantedRole === "user" ? node.querySelector?.('[data-user-message-bubble="true"]')
        : node.querySelector?.('[data-markdown-text-style="assistant-message"]');
      return (content as HTMLElement | null)?.innerText || content?.textContent
        || (node.innerText ?? node.textContent ?? "").replace(node.querySelector?.('[data-conversation-role="assistant"]')?.textContent ?? "", "").trim();
    }, role).catch(() => undefined);
  }

  return readLatestMessage(page, role, "normalized_text")
    .then(message => message?.text)
    .catch(() => undefined);
}

export async function readLatestMessageTextSnapshot(
  page: PageLike,
  role: MessageRole
): Promise<LatestMessageTextSnapshot> {
  if (typeof page.evaluate === "function") {
    return page.evaluate((wantedRole: MessageRole) => {
      const legacy = Array.from(document.querySelectorAll("[data-message-author-role]"));
      const allNodes = legacy.length > 0 ? legacy : Array.from(document.querySelectorAll(
        "main [data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]"
      )).filter(node => /:(?:user|assistant)$/.test(node.getAttribute("data-chatgpt-search-unit-key") ?? ""));
      const roleNodes = allNodes.filter(node => (node.getAttribute("data-message-author-role")
        ?? node.getAttribute("data-chatgpt-search-unit-key")?.split(":").at(-1)) === wantedRole);
      const latest = roleNodes.at(-1) as HTMLElement | undefined;
      const content = wantedRole === "user" ? latest?.querySelector?.('[data-user-message-bubble="true"]')
        : latest?.querySelector?.('[data-markdown-text-style="assistant-message"]');
      const latestText = (content as HTMLElement | null)?.innerText || content?.textContent
        || (latest === undefined ? undefined : (latest.innerText ?? latest.textContent ?? "")
          .replace(latest.querySelector?.('[data-conversation-role="assistant"]')?.textContent ?? "", "").trim());
      const snapshot: { latestText?: string; turnCount: number } = { turnCount: allNodes.length };
      if (latestText !== undefined) snapshot.latestText = latestText;
      return snapshot;
    }, role);
  }

  const messages = await readMessages(page, { role, format: "normalized_text" });
  const allMessages = await readMessages(page, { format: "normalized_text" });
  const snapshot: LatestMessageTextSnapshot = { turnCount: allMessages.length };
  const latestText = messages.at(-1)?.text;
  if (latestText !== undefined) snapshot.latestText = latestText;
  return snapshot;
}

export function isTransientAssistantText(text: string): boolean {
  const normalized = normalizeWhitespace(text)
    .replace(/[.。…]+$/g, "")
    .trim()
    .toLowerCase();

  return localeLabels.transientAssistant.some(phrase => normalized === phrase.toLowerCase())
    || /^analyzing (?:the )?images?$/.test(normalized)
    || /^processing (?:the )?images?$/.test(normalized)
    || /^reading (?:the )?images?$/.test(normalized);
}

export function countMessages(messages: ExtractedMessage[], role?: MessageRole): number {
  return role === undefined ? messages.length : messages.filter(message => message.role === role).length;
}

export async function countPageMessages(
  page: PageLike,
  role?: MessageRole,
  options?: BrowserOperationOptions
): Promise<number> {
  if (typeof page.evaluate === "function") {
    return page.evaluate((wantedRole: MessageRole | undefined) => {
      const selector = wantedRole === undefined
        ? "[data-message-author-role]"
        : `[data-message-author-role="${wantedRole}"]`;
      const legacyCount = document.querySelectorAll(selector).length;
      if (legacyCount > 0) return legacyCount;
      const currentSelector = wantedRole === undefined
        ? 'main [data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids], main [data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]'
        : `main [data-chatgpt-search-unit-key$=":${wantedRole}"][data-chatgpt-search-message-ids]`;
      return document.querySelectorAll(currentSelector).length;
    }, role, options);
  }

  return countMessages(await readMessages(page), role);
}

function normalizeExtractedMessage(
  message: { role: MessageRole; html: string; metadataHtml?: string },
  args: ReadMessagesArgs = {}
): ExtractedMessage {
  const metadataHtml = message.role === "assistant" ? message.metadataHtml : undefined;
  const content = formatMessageHtml(message.html, normalizeResponseFormat(args.format), args.maxChars, metadataHtml);
  return { role: message.role, ...content };
}
