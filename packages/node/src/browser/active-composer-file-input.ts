/**
 * Fixed CDP expression for one trusted user gesture on the unique file input
 * owned by the unique visible ChatGPT composer. Local paths never enter this
 * expression; the sanctioned file-chooser capability performs the handoff.
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
  const textboxes = [...document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']")].filter(visible);
  const composers = [...new Set(textboxes.map(textbox =>
    textbox.closest("form")
      ?? textbox.closest("[data-testid*='composer' i]")
      ?? textbox.closest("[aria-label*='composer' i]")
      ?? textbox.closest("[class*='composer' i]")
  ).filter(Boolean))];
  if (composers.length !== 1) return { ok: false, reason: "active composer was not unique" };
  const all = [...composers[0].querySelectorAll("input[type='file']")]
    .filter(input => !input.disabled && input.getAttribute("aria-disabled") !== "true");
  const preferred = all.filter(input => input.id === "upload-files");
  const nonImage = all.filter(input => input.getAttribute("accept") !== "image/*");
  const candidates = preferred.length ? preferred : nonImage.length ? nonImage : all;
  if (candidates.length !== 1) return { ok: false, reason: "active composer file input was not unique" };
  candidates[0].click();
  return { ok: true };
})()`;
