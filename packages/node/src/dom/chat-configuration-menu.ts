import { localeLabels } from "./locale-labels.js";
import { normalizeForLabelMatch, visibleLabelMatches } from "./label-match.js";
import type { MenuItem } from "./menus.js";

const CHAT_MODEL_LABEL_PATTERN = /\b(?:gpt[\s-]?\d|sol|terra|luna)\b/i;
const CHAT_MODEL_VERSION_PATTERN = /^\d+(?:\.\d+)?(?:\s+(?:sol|terra|luna))?$/i;

export const chatPowerValueLabels = [
  ...localeLabels.configurationOptions.instant,
  ...localeLabels.configurationOptions.medium,
  ...localeLabels.configurationOptions.high,
  ...localeLabels.configurationOptions.extraHigh,
  ...localeLabels.configurationOptions.pro,
];

export function chatModelMenuOptions(items: readonly MenuItem[]): MenuItem[] {
  return items.filter(item => item.role === "menuitemradio" && chatModelLabelLooksSelectable(item.label));
}

export function findChatModelMenuOption(
  items: readonly MenuItem[],
  requested: string
): MenuItem | undefined {
  const options = chatModelMenuOptions(items);
  const wanted = normalizeChatModelLabel(requested);
  const exact = options.filter(option => normalizeChatModelLabel(option.label) === wanted);
  return exact.length === 1 ? exact[0] : undefined;
}

export function selectedChatModelMenuOption(items: readonly MenuItem[]): MenuItem | undefined {
  const selected = chatModelMenuOptions(items).filter(option => option.checked === true);
  return selected.length === 1 ? selected[0] : undefined;
}

export function findChatModelViewOpener(items: readonly MenuItem[]): MenuItem | undefined {
  const matches = items.filter(item => {
    if (item.role === "menuitemradio" || item.disabled === true) return false;
    const labels = [item.label, item.ariaLabel].filter((value): value is string => value !== undefined);
    return labels.some(label => localeLabels.configurationAxes.model.some(axisLabel =>
      visibleLabelMatches(label, axisLabel)
    ));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

export function chatModelLabelLooksSelectable(label: string): boolean {
  const normalized = normalizeForLabelMatch(label);
  return CHAT_MODEL_LABEL_PATTERN.test(normalized)
    || CHAT_MODEL_VERSION_PATTERN.test(normalized.replace(/^gpt\s+/i, ""));
}

export function chatModelLabelsMatch(actual: string, requested: string): boolean {
  return normalizeChatModelLabel(actual) === normalizeChatModelLabel(requested);
}

function normalizeChatModelLabel(value: string): string {
  return normalizeForLabelMatch(value)
    .replace(/^gpt\s*/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
