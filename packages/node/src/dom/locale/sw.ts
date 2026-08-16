import type { LocaleContribution } from "./types.js";

/**
 * Swahili (sw-TZ). Captured 2026-06-09 against a live chatgpt.com session
 * (html lang=sw-TZ, Google Translate confirmed off).
 *
 * Some non-Intelligence surfaces may still fall back to English + `selector_drift`.
 *
 * Intelligence picker labels updated 2026-06-10, stop-control labels updated 2026-06-15, Chat/Work surface labels updated 2026-07-17, and Power/Advanced selector labels updated 2026-08-08 from visible ChatGPT sessions.
 */
export const sw = {
  configurationAxes: {
    power: ["Umahiri"],
    model: ["Modeli", "Mfumo"],
    effort: ["Juhudi", "Kiwango cha uchambuzi"],
    speed: ["Kasi"],
    advanced: ["Za kina"],
  },
  configurationOptions: {
    instant: ["Papo hapo"],
    light: ["Nyepesi"],
    medium: ["Wastani"],
    high: ["Juu"],
    extraHigh: ["Juu Zaidi"],
    max: ["Juu kabisa"],
    standard: ["Kawaida"],
    fast: ["Haraka"],
  },
  composerTextbox: ["Uliza chochote"],
  sendButton: ["Tuma makumbusho"],
  searchChatsButton: ["Tafuta mazungumzo"],
  searchChatsPlaceholder: ["Inatafuta chati..."],
  newChat: ["Chati mpya"],
  addFilesButton: ["Ongeza faili na mengine zaidi"],
  addFilesOpenerCandidates: ["Ongeza faili na mengine zaidi"],
  addPhotosFilesMenuItem: ["Pakia picha na mafaili"],
  copyResponse: ["Nakili jibu"],
  modeLabels: ["Papo hapo", "Wastani", "Juu", "Juu Zaidi"],
  modeOptions: {
    instant: ["Papo hapo"],
    medium: ["Wastani"],
    high: ["Juu"],
    extraHigh: ["Juu Zaidi"],
  },
  modeOpenerExtra: ["Sanidi..."],
  tools: {
    web_search: ["Utafutaji wa wavuti"],
    deep_research: ["Utafiti wa kina"],
    create_image: ["Unda picha"],
  },
  signedInMarkers: ["Chati mpya", "Tafuta mazungumzo", "Hivi karibuni", "Historia ya chati", "Miradi", "Uliza chochote"],
  responseActions: ["Nakili jibu"],
  stopControl: ["Sitisha kujibu"],
} satisfies LocaleContribution;
