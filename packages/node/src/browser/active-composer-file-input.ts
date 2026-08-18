/**
 * Fixed CDP expression for one trusted user gesture on ChatGPT's unique
 * #upload-files input, with the unique visible prompt composer as a fallback.
 * Local paths never enter this expression; the sanctioned file-chooser
 * capability performs the handoff.
 *
 * Keep this shared by the ordinary files command and the transactional
 * attachment provider so their target-selection safety contract cannot drift.
 */
export const ACTIVE_COMPOSER_FILE_INPUT_CLICK_EXPRESSION = `(() => {
  const visible = element => {
    if (element.hidden || element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0"
      && (rect.width > 0 || rect.height > 0);
  };
  const all = [...document.querySelectorAll("input[type='file']")]
    .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const preferred = all.filter(input => input.id === "upload-files");
  let candidates = preferred;
  if (preferred.length !== 1) {
    const prompts = [...document.querySelectorAll("#prompt-textarea, [data-testid='prompt-textarea']")].filter(visible);
    const composers = [...new Set(prompts.map(prompt =>
      prompt.closest("form")
        ?? prompt.closest("[data-testid*='composer' i]")
        ?? prompt.closest("[aria-label*='composer' i]")
        ?? prompt.closest("[class*='composer' i]")
    ).filter(Boolean))];
    if (composers.length !== 1) return { ok: false, reason: "active composer was not unique" };
    const scoped = all.filter(input => composers[0].contains(input));
    const scopedPreferred = scoped.filter(input => input.id === "upload-files");
    const nonImage = scoped.filter(input => input.getAttribute("accept") !== "image/*");
    candidates = scopedPreferred.length ? scopedPreferred : nonImage.length ? nonImage : scoped;
  }
  if (candidates.length !== 1) return { ok: false, reason: "active composer file input was not unique" };
  candidates[0].click();
  return { ok: true };
})()`;
