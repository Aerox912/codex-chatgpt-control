/**
 * Fixed CDP expression for one trusted user gesture on ChatGPT's unique
 * composer-owned file input. Local paths never enter this expression; the
 * sanctioned file-chooser capability performs the handoff.
 *
 * Keep this shared by the ordinary files command and the transactional
 * attachment provider so their target-selection safety contract cannot drift.
 */
export const ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION = `(() => {
  const visible = element => {
    if (element.hidden || element.closest?.("[hidden], [inert], [aria-hidden='true']")) return false;
    if (typeof element.getBoundingClientRect !== "function") return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && (rect.width > 0 || rect.height > 0);
  };
  const all = [...document.querySelectorAll("input[type='file']")]
    .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const prompts = [...document.querySelectorAll(
    "#prompt-textarea, [data-testid='prompt-textarea'], [contenteditable='true'][role='textbox']"
  )].filter(visible);
  if (prompts.length > 1) return { ok: false, reason: "active composer was not unique" };
  let candidates = [];
  if (prompts.length === 1) {
    const prompt = prompts[0];
    const composer = prompt.closest("[data-chatgpt-composer]")
      ?? prompt.closest("form")
      ?? prompt.closest("[data-composer-body]")
      ?? prompt.closest("[data-testid*='composer' i]")
      ?? prompt.closest("[aria-label*='composer' i]")
      ?? prompt.closest("[class*='composer' i]");
    if (!composer) return { ok: false, reason: "active composer was not unique" };
    const scoped = all.filter(input => composer.contains(input));
    const scopedPreferred = scoped.filter(input => input.id === "upload-files");
    const general = scoped.filter(input => input.multiple
      && (input.getAttribute("accept") === null || input.getAttribute("accept").trim() === ""));
    const nonMedia = scoped.filter(input => !/(?:^|,)\\s*(?:image|video)\\//i.test(input.getAttribute("accept") ?? ""));
    candidates = scopedPreferred.length ? scopedPreferred
      : general.length ? general
        : nonMedia.length ? nonMedia : scoped;
  } else {
    // The historical, unique #upload-files input remains supported when no
    // visible editor is present; an editor, when present, always owns scope.
    candidates = all.filter(input => input.id === "upload-files");
  }
  if (candidates.length !== 1) return { ok: false, reason: "active composer file input was not unique" };
  candidates[0].click();
  return { ok: true };
})()`;

/**
 * Serialized locator evaluator shared by chooser and menu ownership checks.
 * Keep this function self-contained because browser bridges serialize it.
 */
export function isOwnedActiveChatGPTUploadTarget(element: Element): boolean {
  const visible = (node: HTMLElement): boolean => {
    if (node.hidden || node.closest("[hidden], [inert], [aria-hidden='true']") !== null) return false;
    const style = window.getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && (rect.width > 0 || rect.height > 0);
  };
  const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='file']"))
    .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const prompts = Array.from(document.querySelectorAll<HTMLElement>(
    "#prompt-textarea, [data-testid='prompt-textarea'], [contenteditable='true'][role='textbox']"
  )).filter(visible);
  if (prompts.length > 1) return false;

  const composerFrom = (anchor: HTMLElement): HTMLElement | null => anchor.closest<HTMLElement>("[data-chatgpt-composer]")
    ?? anchor.closest<HTMLElement>("form")
    ?? anchor.closest<HTMLElement>("[data-composer-body]")
    ?? anchor.closest<HTMLElement>("[data-testid*='composer' i]")
    ?? anchor.closest<HTMLElement>("[aria-label*='composer' i]")
    ?? anchor.closest<HTMLElement>("[class*='composer' i]");
  let composer: HTMLElement | null = null;
  if (prompts.length === 1) {
    composer = composerFrom(prompts[0]!);
  } else {
    const preferred = allInputs.filter(input => input.id === "upload-files");
    if (preferred.length !== 1) return false;
    composer = composerFrom(preferred[0]!);
    if (composer === null && element === preferred[0]) return true;
  }
  if (composer === null) return false;

  if (element.tagName === "INPUT" && element.getAttribute("type") === "file") {
    const scoped = allInputs.filter(input => composer!.contains(input));
    const scopedPreferred = scoped.filter(input => input.id === "upload-files");
    const general = scoped.filter(input => input.multiple
      && (input.getAttribute("accept") ?? "").trim().length === 0);
    const nonMedia = scoped.filter(input => !/(?:^|,)\s*(?:image|video)\//i.test(input.getAttribute("accept") ?? ""));
    const resolved = scopedPreferred.length > 0 ? scopedPreferred
      : general.length > 0 ? general
        : nonMedia.length > 0 ? nonMedia : scoped;
    return resolved.length === 1 && resolved[0] === element;
  }

  if (composer.contains(element)) return true;

  const currentTriggers = Array.from(composer.querySelectorAll<HTMLElement>(
    "[data-composer-navigation-target='add-context'][aria-expanded='true']"
  )).filter(visible);
  const visibleOverlays = Array.from(document.querySelectorAll<HTMLElement>(
    "[data-composer-overlay-floating-ui='true']"
  )).filter(visible);
  if (currentTriggers.length === 1 && visibleOverlays.length === 1
    && element.tagName === "BUTTON"
    && element.getAttribute("data-list-navigation-item") === "true"
    && element.getAttribute("aria-current") === "true"
    && visibleOverlays[0]!.contains(element)) return true;

  const controlledOwners = Array.from(composer.querySelectorAll<HTMLElement>("button[aria-controls], [role='button'][aria-controls]"))
    .filter(visible)
    .filter(trigger => trigger.getAttribute("aria-expanded") === "true")
    .filter(trigger => (trigger.getAttribute("aria-controls") ?? "").split(/\s+/u).some(id => {
      const target = document.getElementById(id);
      return id.length > 0 && target !== null && target.contains(element);
    }));
  return controlledOwners.length === 1;
}
