import type { PageLike } from "../types.js";
import { copyResponseButtons } from "./selectors.js";
import { localeLabels } from "./locale-labels.js";

export type GenerationStateReadOptions = {
  timeoutMs?: number;
};

export type AssistantGenerationState = {
  /** True only when the page DOM was inspected successfully. */
  observed: boolean;
  active: boolean;
  stopped: boolean;
  signals: string[];
};

/**
 * Neutral fallback used when generation state cannot be inspected.
 *
 * This means "no active/stopped signal observed"; it is not evidence that a
 * response is complete.
 */
export const EMPTY_GENERATION_STATE: AssistantGenerationState = {
  observed: false,
  active: false,
  stopped: false,
  signals: []
};

export async function readAssistantGenerationState(
  page: PageLike,
  options: GenerationStateReadOptions = {}
): Promise<AssistantGenerationState> {
  const expiresAtMs = options.timeoutMs === undefined
    ? undefined
    : Date.now() + Math.max(1, options.timeoutMs);
  if (typeof page.evaluate === "function") {
    const evaluateOptions = remainingGenerationStateOptions(expiresAtMs);
    if (expiresAtMs !== undefined && evaluateOptions === undefined) return EMPTY_GENERATION_STATE;
    try {
      return await page.evaluate((args: { stop: string[]; stopped: string[]; send: string[] }) => {
      const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const isVisible = (element: HTMLElement) => {
        if (element.hidden || element.closest("[hidden], [inert], [aria-hidden='true']") !== null) {
          return false;
        }
        const style = window.getComputedStyle(element);
        if (style.display === "none"
          || style.visibility === "hidden"
          || style.opacity === "0"
          || style.pointerEvents === "none") {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return (rect.width > 0 || rect.height > 0)
          && style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0";
      };
      const values = (element: HTMLElement) => [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.innerText,
        element.textContent
      ].map(normalize).filter(Boolean);
      const matchingLabels = (element: HTMLElement, phrases: string[]) => {
        const elementValues = values(element);
        return phrases.filter(phrase => elementValues.includes(normalize(phrase)));
      };
      const textboxes = Array.from(document.querySelectorAll<HTMLElement>(
        "textarea, [contenteditable='true'], [role='textbox']"
      )).filter(isVisible);
      const activeComposers = [...new Set(textboxes
        .map(textbox => textbox.closest<HTMLElement>("form")
          ?? textbox.closest<HTMLElement>("[data-testid*='composer' i]")
          ?? textbox.closest<HTMLElement>("[aria-label*='composer' i]")
          ?? textbox.closest<HTMLElement>("[class*='composer' i]"))
        .filter((value): value is HTMLElement => value !== null))];
      const isScopedStopControl = (button: HTMLButtonElement) =>
        activeComposers.length === 1 && activeComposers[0]!.contains(button);
      const visibleStopButtons = Array.from(document.querySelectorAll("button"))
        .filter((button): button is HTMLButtonElement => isVisible(button as HTMLElement)
          && button.disabled !== true
          && button.getAttribute("aria-disabled") !== "true"
          && isScopedStopControl(button)
          && matchingLabels(button, args.send).length === 0
          && matchingLabels(button, args.stop).length > 0);
      const activeSignals = [...new Set(visibleStopButtons.flatMap(button => matchingLabels(button, args.stop)))];

      const turns = Array.from(document.querySelectorAll("[data-testid^='conversation-turn']"));
      const latestAssistant = Array.from(document.querySelectorAll("[data-message-author-role='assistant']")).at(-1);
      const latestTurn = latestAssistant?.closest("[data-testid^='conversation-turn']") ?? turns.at(-1);
      const stoppedSignals = latestTurn === undefined
        ? []
        : [...new Set(Array.from(latestTurn.querySelectorAll<HTMLElement>(
            "button, [role='status'], [aria-label], [title], p, span, div"
          ))
            .filter(element => isVisible(element))
            .flatMap(element => matchingLabels(element, args.stopped)))];
      return {
        observed: true,
        active: activeSignals.length > 0,
        stopped: stoppedSignals.length > 0,
        signals: [...new Set([...activeSignals, ...stoppedSignals])].slice(0, 5)
      };
    }, {
      stop: [...localeLabels.stopControl],
      stopped: [...localeLabels.stoppedAssistant],
      send: [...localeLabels.sendButton]
      }, evaluateOptions);
    } catch {
      // Fall through to the serialized-DOM fallback when available. A failed
      // evaluate with no fallback remains explicitly unobserved.
    }
  }

  if (typeof page.content === "function") {
    const contentOptions = remainingGenerationStateOptions(expiresAtMs);
    if (expiresAtMs !== undefined && contentOptions === undefined) return EMPTY_GENERATION_STATE;
    try {
      return generationStateFromHtml(await page.content(contentOptions));
    } catch {
      return EMPTY_GENERATION_STATE;
    }
  }

  return EMPTY_GENERATION_STATE;
}

function remainingGenerationStateOptions(
  expiresAtMs: number | undefined
): { timeoutMs: number } | undefined {
  if (expiresAtMs === undefined) return undefined;
  const timeoutMs = expiresAtMs - Date.now();
  return timeoutMs > 0 ? { timeoutMs } : undefined;
}

export async function latestAssistantTurnHasResponseActions(page: PageLike): Promise<boolean> {
  if (typeof page.evaluate === "function") {
    const scoped = await page.evaluate((phrases: string[]) => {
      const turns = Array.from(document.querySelectorAll("[data-testid^='conversation-turn']"));
      if (turns.length === 0) return undefined;
      const latestTurn = turns.reverse().find(turn =>
        turn.querySelector("[data-message-author-role='assistant']") !== null
      ) as HTMLElement | undefined;
      if (latestTurn === undefined) return false;
      const actionText = Array.from(latestTurn.querySelectorAll("button"))
        .map(button => [
          button.innerText,
          button.textContent,
          button.getAttribute("aria-label"),
          button.getAttribute("title")
        ].filter(Boolean).join(" "))
        .join(" ")
        .toLowerCase();
      return phrases.some(phrase => actionText.includes(phrase.toLowerCase()));
    }, [...localeLabels.responseActions]).catch(() => undefined);
    if (scoped !== undefined) {
      return scoped;
    }
  }

  try {
    const copyButtons = copyResponseButtons(page);
    const count = await copyButtons.count?.();
    if (count !== undefined) {
      return count > 0;
    }
    return await copyButtons.isVisible?.() === true;
  } catch {
    if (typeof page.content === "function") {
      const html = await page.content().catch(() => "");
      return localeLabels.responseActions.some(phrase => html.toLowerCase().includes(phrase.toLowerCase()));
    }
    return true;
  }
}

function generationStateFromHtml(html: string): AssistantGenerationState {
  const normalize = (value: string) => value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const isHiddenTag = (tag: string) => /\b(?:hidden|inert)\b/i.test(tag)
    || /\baria-hidden\s*=\s*["']?true/i.test(tag)
    || /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(tag);
  const candidateValues = (tag: string, text: string) => {
    const values = [text];
    for (const attribute of ["aria-label", "title"]) {
      const match = new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
      if (match?.[1] !== undefined) values.push(match[1]);
    }
    return values.map(normalize).filter(Boolean);
  };
  const exactMatches = (values: string[], phrases: readonly string[]) =>
    phrases.filter(phrase => values.includes(normalize(phrase)));

  const activeSignals = serializedStopButtonCandidates(html)
    .filter(candidate => candidate.scoped && !candidate.hidden && !candidate.disabled)
    .flatMap(candidate => {
      const values = candidateValues(candidate.attributes, candidate.text);
      return exactMatches(values, localeLabels.sendButton).length > 0
        ? []
        : exactMatches(values, localeLabels.stopControl);
    });

  const latestTurnStart = Math.max(
    html.toLowerCase().lastIndexOf("data-message-author-role=\"assistant\""),
    html.toLowerCase().lastIndexOf("data-message-author-role='assistant'")
  );
  const latestAssistantHtml = latestTurnStart >= 0 ? html.slice(latestTurnStart) : "";
  const stoppedSignals = [...latestAssistantHtml.matchAll(
    /<(?:button|p|span|div)\b([^>]*)>([\s\S]*?)<\/(?:button|p|span|div)>/gi
  )]
    .filter(match => !isHiddenTag(match[1] ?? ""))
    .flatMap(match => exactMatches(candidateValues(match[1] ?? "", match[2] ?? ""), localeLabels.stoppedAssistant));
  return {
    observed: true,
    active: activeSignals.length > 0,
    stopped: stoppedSignals.length > 0,
    signals: [...new Set([...activeSignals, ...stoppedSignals])].slice(0, 5)
  };
}

type SerializedElement = {
  tag: string;
  attributes: string;
  parent: SerializedElement | undefined;
  text: string;
};

type SerializedStopButtonCandidate = {
  attributes: string;
  text: string;
  scoped: boolean;
  hidden: boolean;
  disabled: boolean;
};

function serializedStopButtonCandidates(html: string): SerializedStopButtonCandidate[] {
  const stack: SerializedElement[] = [];
  const buttons: SerializedElement[] = [];
  const activeComposers = new Set<SerializedElement>();
  const voidElements = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
  ]);
  const hidden = (attributes: string) => /\b(?:hidden|inert)\b/i.test(attributes)
    || /\baria-hidden\s*=\s*["']?true/i.test(attributes)
    || /\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(attributes);
  const hiddenInChain = (node: SerializedElement | undefined): boolean => {
    for (let current = node; current !== undefined; current = current.parent) {
      if (hidden(current.attributes)) return true;
    }
    return false;
  };
  const isComposerMetadata = (node: SerializedElement) =>
    /\b(?:data-testid|aria-label|class)\s*=\s*["'][^"']*composer/i.test(node.attributes);
  const isTextbox = (node: SerializedElement) => node.tag === "textarea"
    || /\bcontenteditable\s*=\s*["']?true/i.test(node.attributes)
    || /\brole\s*=\s*["']textbox["']/i.test(node.attributes);

  for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z0-9-]+\b[^>]*>|[^<]+/gi)) {
    const token = match[0];
    const closing = /^<\/([a-z0-9-]+)/i.exec(token);
    if (closing?.[1] !== undefined) {
      const tag = closing[1].toLowerCase();
      const index = stack.map(node => node.tag).lastIndexOf(tag);
      if (index >= 0) stack.splice(index);
      continue;
    }
    const opening = /^<([a-z0-9-]+)\b([^>]*)>/i.exec(token);
    if (opening?.[1] !== undefined) {
      const node: SerializedElement = {
        tag: opening[1].toLowerCase(),
        attributes: opening[2] ?? "",
        parent: stack.at(-1),
        text: ""
      };
      if (node.tag === "button") buttons.push(node);
      if (isTextbox(node) && !hiddenInChain(node)) {
        const ancestors = [...stack].reverse();
        const composer = ancestors.find(ancestor => ancestor.tag === "form")
          ?? ancestors.find(isComposerMetadata);
        if (composer !== undefined && !hiddenInChain(composer)) activeComposers.add(composer);
      }
      if (!voidElements.has(node.tag) && !/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      if (stack[index]!.tag === "button") {
        stack[index]!.text += ` ${token}`;
        break;
      }
    }
  }

  const activeComposer = activeComposers.size === 1 ? [...activeComposers][0] : undefined;
  return buttons.map(button => {
    let scoped = false;
    for (let current = button.parent; current !== undefined; current = current.parent) {
      if (current === activeComposer) {
        scoped = true;
        break;
      }
    }
    return {
      attributes: button.attributes,
      text: button.text,
      scoped,
      hidden: hiddenInChain(button),
      disabled: /\bdisabled(?:\s|=|$)/i.test(button.attributes)
        || /\baria-disabled\s*=\s*["']?true/i.test(button.attributes)
    };
  });
}
