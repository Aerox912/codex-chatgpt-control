import { resultError, resultOk } from "../errors.js";
import { readPageState } from "../browser/page-state.js";
import { localeLabels } from "../dom/locale-labels.js";
import { normalizeForLabelMatch, visibleLabelMatches } from "../dom/label-match.js";
import type {
  ChatGPTExperience,
  CommandResult,
  DetectExperienceArgs,
  DetectExperienceData,
  ExperienceConfidence,
  ExperienceEvidence,
  LocatorLike,
  OpenExperienceArgs,
  OpenExperienceData,
  PageLike,
  RuntimeEnv,
  SurfaceSelectorProfile
} from "../types.js";
import { contextFromPage } from "./context.js";
import { ensurePage } from "./session.js";

type SurfaceSnapshot = {
  url: string;
  composerLabels: string[];
  mainControls: string[];
  /** Controls outside overlays, scoped to the composer (or main fallback). */
  composerControls?: string[];
  /** Separate visible control roots; unrelated overlays cannot combine axes. */
  controlGroups?: string[][];
  rootBudgetExceeded?: true;
  mainText: string;
  selectedSurfaceLabels?: string[];
  /** Simplified Work popover owns the independent structural Fast checkbox. */
  workPopoverOpen?: boolean;
};

const CHATGPT_HOME = "https://chatgpt.com/";
const EXPERIENCE_CONTROL_DISCOVERY_TIMEOUT_MS = 15_000;
const EXPERIENCE_CURRENT_PAGE_GRACE_MS = 1_000;
const EXPERIENCE_POLL_MS = 250;
const EXPERIENCE_READINESS_TIMEOUT_MS = 1500;

export async function detectExperience(
  env: RuntimeEnv,
  args: DetectExperienceArgs = {}
): Promise<CommandResult<DetectExperienceData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) {
    return boot as CommandResult<DetectExperienceData>;
  }

  const page = env.page!;
  try {
    const readinessMs = Math.max(0, Math.min(args.timeoutMs ?? EXPERIENCE_READINESS_TIMEOUT_MS,
      EXPERIENCE_CONTROL_DISCOVERY_TIMEOUT_MS));
    const readinessDeadline = Date.now() + readinessMs;
    let data = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    // An empty post-navigation capture is loading evidence, not a final
    // classification. Never wait out a known blocker or a genuine score tie.
    for (let attempt = 1; data.experience === "unknown" && data.evidence.length === 0
      && Date.now() < readinessDeadline
      && attempt < pollAttempts(readinessMs, EXPERIENCE_POLL_MS); attempt += 1) {
      const blocker = await experiencePageBlocker(page, data);
      if (blocker !== undefined) return blocker;
      if (page.waitForTimeout === undefined || Date.now() >= readinessDeadline) break;
      await page.waitForTimeout(Math.min(EXPERIENCE_POLL_MS, readinessDeadline - Date.now()));
      data = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    }
    return resultOk(data, await contextFromPage(page, {
      experience: data.experience,
      selectorProfile: data.selectorProfile
    }), data.experience === "unknown"
      ? ["The current ChatGPT surface could not be classified as Chat or Work from scoped composer evidence."]
      : []);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

export async function openExperience(
  env: RuntimeEnv,
  args: OpenExperienceArgs
): Promise<CommandResult<OpenExperienceData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) {
    return boot as CommandResult<OpenExperienceData>;
  }

  const page = env.page!;
  try {
    const before = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    const initialBlocker = await experiencePageBlocker(page, before);
    if (initialBlocker !== undefined) return initialBlocker;
    if (before.experience === args.experience) {
      return resultOk({
        experience: args.experience,
        previousExperience: before.experience,
        changed: false,
        selectorProfile: before.selectorProfile
      }, await contextFromPage(page, {
        experience: before.experience,
        selectorProfile: before.selectorProfile
      }));
    }

    const labels = localeLabels.experienceOptions[args.experience];
    const timeoutMs = args.timeoutMs ?? 30000;
    const discoveryAttempts = pollAttempts(
      Math.min(timeoutMs, EXPERIENCE_CONTROL_DISCOVERY_TIMEOUT_MS),
      EXPERIENCE_POLL_MS
    );
    const currentPageAttempts = pollAttempts(
      Math.min(timeoutMs, EXPERIENCE_CURRENT_PAGE_GRACE_MS),
      EXPERIENCE_POLL_MS
    );
    let { observed, controlClicked } = await discoverExperienceControl(
      page,
      labels,
      args.experience,
      currentPageAttempts,
      before
    );
    if (observed.experience === args.experience) {
      return resultOk({
        experience: args.experience,
        previousExperience: before.experience,
        changed: true,
        selectorProfile: observed.selectorProfile
      }, await contextFromPage(page, {
        experience: observed.experience,
        selectorProfile: observed.selectorProfile
      }));
    }

    if (!controlClicked) {
      if (await navigateConversationToSurfaceHome(page, args.timeoutMs)) {
        observed = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
        const navigationBlocker = await experiencePageBlocker(page, observed);
        if (navigationBlocker !== undefined) return navigationBlocker;
        if (observed.experience === args.experience) {
          return resultOk({
            experience: args.experience,
            previousExperience: before.experience,
            changed: true,
            selectorProfile: observed.selectorProfile
          }, await contextFromPage(page, {
            experience: observed.experience,
            selectorProfile: observed.selectorProfile
          }));
        }
      }
      const finalDiscovery = await discoverExperienceControl(
        page,
        labels,
        args.experience,
        discoveryAttempts,
        observed
      );
      observed = finalDiscovery.observed;
      controlClicked = finalDiscovery.controlClicked;
      if (observed.experience === args.experience) {
        return resultOk({
          experience: args.experience,
          previousExperience: before.experience,
          changed: true,
          selectorProfile: observed.selectorProfile
        }, await contextFromPage(page, {
          experience: observed.experience,
          selectorProfile: observed.selectorProfile
        }));
      }
    }
    if (!controlClicked) {
      const discoveryBlocker = await experiencePageBlocker(page, observed);
      if (discoveryBlocker !== undefined) return discoveryBlocker;
      return experienceSelectorDrift(
        page,
        `No unique visible ChatGPT ${args.experience === "work" ? "Work" : "Chat"} surface control was found.`,
        observed
      );
    }

    let after = before;
    for (let attempt = 0; attempt < pollAttempts(timeoutMs, EXPERIENCE_POLL_MS); attempt += 1) {
      await page.waitForTimeout?.(EXPERIENCE_POLL_MS);
      after = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
      if (after.experience === args.experience) {
        return resultOk({
          experience: args.experience,
          previousExperience: before.experience,
          changed: true,
          selectorProfile: after.selectorProfile
        }, await contextFromPage(page, {
          experience: after.experience,
          selectorProfile: after.selectorProfile
        }));
      }
    }

    const postconditionBlocker = await experiencePageBlocker(page, after);
    if (postconditionBlocker !== undefined) return postconditionBlocker;
    return {
      ok: false,
      status: "blocked",
      warnings: [],
      blocker: {
        kind: "selector_drift",
        code: "experience_postcondition_unverified",
        fieldPath: "experience",
        message: `The ${args.experience} surface control was clicked, but the composer did not verify that ChatGPT switched to ${args.experience}.`,
        candidates: labels.map(label => ({ label })),
        resumable: true
      },
      context: await contextFromPage(page, {
        experience: after.experience,
        selectorProfile: after.selectorProfile
      })
    };
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

async function discoverExperienceControl(
  page: PageLike,
  labels: string[],
  experience: OpenExperienceArgs["experience"],
  attempts: number,
  initial: DetectExperienceData
): Promise<{ observed: DetectExperienceData; controlClicked: boolean }> {
  let observed = initial;
  let controlClicked = await clickUniqueExperienceControl(page, labels);
  for (let attempt = 1; !controlClicked && attempt < attempts; attempt += 1) {
    await page.waitForTimeout?.(EXPERIENCE_POLL_MS);
    observed = detectExperienceFromSnapshot(await readSurfaceSnapshot(page));
    if (observed.experience === experience) break;
    controlClicked = await clickUniqueExperienceControl(page, labels);
  }
  return { observed, controlClicked };
}

async function experiencePageBlocker(
  page: PageLike,
  observed: DetectExperienceData
): Promise<CommandResult<never> | undefined> {
  const state = await readPageState(page);
  if (state.blocker === undefined) return undefined;
  return {
    ok: false,
    status: "blocked",
    warnings: [],
    blocker: {
      kind: state.blocker.kind,
      code: `experience_blocked_${state.blocker.kind}`,
      fieldPath: "experience",
      message: state.blocker.message,
      ...(state.blocker.visibleText === undefined ? {} : { visibleText: state.blocker.visibleText }),
      resumable: true
    },
    context: await contextFromPage(page, {
      experience: observed.experience,
      selectorProfile: observed.selectorProfile
    })
  };
}

function pollAttempts(timeoutMs: number, pollMs: number): number {
  return Math.max(1, Math.ceil(Math.max(0, timeoutMs) / pollMs));
}

async function navigateConversationToSurfaceHome(
  page: PageLike,
  timeoutMs: number | undefined
): Promise<boolean> {
  if (page.goto === undefined || page.url === undefined) return false;
  const currentUrl = await Promise.resolve(page.url()).catch(() => "");
  if (!/^https:\/\/chatgpt\.com\/c\//i.test(currentUrl)) return false;
  await page.goto(CHATGPT_HOME, {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs ?? 30000
  });
  await page.waitForTimeout?.(500);
  return true;
}

export function detectExperienceFromSnapshot(snapshot: SurfaceSnapshot): DetectExperienceData {
  if (snapshot.rootBudgetExceeded === true) {
    return {
      experience: "unknown", selectorProfile: "unknown", confidence: "low",
      evidence: [{ source: "control", label: "Experience surface root budget exceeded" }]
    };
  }
  const evidence: ExperienceEvidence[] = [];
  const composerLabels = snapshot.composerLabels.map(normalizeForLabelMatch);
  const mainText = normalizeForLabelMatch(snapshot.mainText);
  const selectedSurfaceLabels = (snapshot.selectedSurfaceLabels ?? []).map(normalizeForLabelMatch);
  const url = snapshot.url.toLowerCase();

  const selectedWork = matchingLabels(selectedSurfaceLabels, localeLabels.experienceOptions.work);
  const selectedChat = matchingLabels(selectedSurfaceLabels, localeLabels.experienceOptions.chat);
  const workSurfaceSelected = selectedWork.length > 0 && selectedChat.length === 0;
  const chatSurfaceSelected = selectedChat.length > 0 && selectedWork.length === 0;
  if (workSurfaceSelected) {
    evidence.push({ source: "control", label: "Work surface selected" });
  } else if (chatSurfaceSelected) {
    evidence.push({ source: "control", label: "Chat surface selected" });
  }

  const workComposer = matchingLabels(composerLabels, localeLabels.workComposerTextbox);
  for (const label of workComposer) {
    evidence.push({ source: "composer", label });
  }

  const chatComposer = matchingLabels(composerLabels, localeLabels.composerTextbox);
  for (const label of chatComposer) {
    evidence.push({ source: "composer", label });
  }
  const projectChatComposer = /\/g\/g-p-[^/]+\/project(?:[/?#]|$)/i.test(url)
    ? composerLabels.filter(label => /^new chat in\s+\S/u.test(label))
    : [];
  for (const label of projectChatComposer) {
    evidence.push({ source: "composer", label });
  }

  // Model and effort also occur in the Chat composer popover. Only the
  // complete Work axis group, including speed in the same visible pane,
  // supplies Work evidence. Do not combine labels across unrelated overlays.
  const workAxes = (snapshot.controlGroups ?? [snapshot.mainControls]).some(group => {
    const groupLabels = group.map(normalizeForLabelMatch);
    return (["model", "effort", "speed"] as const).every(axis =>
      hasAnyLabel(groupLabels, localeLabels.configurationAxes[axis]));
  });
  if (workAxes) {
    evidence.push({ source: "control", label: "Work configuration axes (3/3)" });
  }
  const composerControls = (snapshot.composerControls ?? snapshot.mainControls).map(normalizeForLabelMatch);
  const workConfigurationOpener = composerControls.some(label =>
    /\b(?:gpt[\s-]?\d|\d+(?:\.\d+)+|sol|luna|terra)\b/i.test(label)
    && hasAnyLabel([label], [
      ...localeLabels.configurationOptions.light,
      ...localeLabels.configurationOptions.medium,
      ...localeLabels.configurationOptions.high,
      ...localeLabels.configurationOptions.extraHigh,
      ...localeLabels.configurationOptions.max,
      ...localeLabels.configurationOptions.ultra,
    ])
  );
  if (workConfigurationOpener) {
    evidence.push({ source: "control", label: "Work configuration opener" });
  }
  if (snapshot.workPopoverOpen === true) {
    evidence.push({ source: "control", label: "Work configuration popover" });
  }

  if (/\/work(?:\/|$|\?)/.test(url)) {
    evidence.push({ source: "url", label: snapshot.url });
  }
  if (containsAny(mainText, ["work on something else", "work on anything"])) {
    evidence.push({ source: "heading", label: "Work composer copy" });
  }

  const workScore = workComposer.length * 4
    + (workSurfaceSelected ? 10 : 0)
    + (workAxes ? 6 : 0)
    // The active Work task drops the Chat/Work radio and keeps the shared
    // "Chat with ChatGPT" textbox name. Its compound model + effort opener is
    // therefore strong enough to disambiguate that continuation surface.
    + (workConfigurationOpener ? 6 : 0)
    + (snapshot.workPopoverOpen === true ? 10 : 0)
    + (/\/work(?:\/|$|\?)/.test(url) ? 3 : 0)
    + (containsAny(mainText, ["work on something else", "work on anything"]) ? 2 : 0);
  const chatScore = chatComposer.length * 4
    + projectChatComposer.length * 6
    + (chatSurfaceSelected ? 10 : 0)
    + (!workAxes && chatComposer.length > 0 && hasExactLabel(snapshot.mainControls.map(normalizeForLabelMatch), localeLabels.configurationOptions.pro) ? 4 : 0);
  if (!workAxes && chatComposer.length > 0
    && hasExactLabel(snapshot.mainControls.map(normalizeForLabelMatch), localeLabels.configurationOptions.pro)) {
    evidence.push({ source: "control", label: "Compact Chat advanced configuration" });
  }

  let experience: ChatGPTExperience = "unknown";
  let confidence: ExperienceConfidence = "low";
  if (workScore > chatScore && workScore >= 4) {
    experience = "work";
    confidence = workSurfaceSelected || workScore >= 7 ? "high" : "medium";
  } else if (chatScore > workScore && chatScore >= 4) {
    experience = "chat";
    confidence = "high";
  }

  const selectorProfile = profileFromSnapshot(snapshot, experience);
  return { experience, selectorProfile, confidence, evidence };
}

export async function readSurfaceSnapshot(page: PageLike): Promise<SurfaceSnapshot> {
  const url = typeof page.url === "function"
    ? await Promise.resolve(page.url()).catch(() => "")
    : "";
  if (typeof page.evaluate !== "function") {
    return { url, composerLabels: [], mainControls: [], mainText: "", selectedSurfaceLabels: [] };
  }

  const snapshot = await page.evaluate((surfaceOptionLabels: { chat: string[]; work: string[]; composerTextboxes: string[] }) => {
    const visible = (element: Element): boolean => {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect?.();
      if (rect !== undefined && (rect.width <= 0 || rect.height <= 0)) return false;
      let current: Element | null = element;
      while (current !== null) {
        if (current.hasAttribute?.("inert") || current.getAttribute?.("aria-hidden") === "true") {
          return false;
        }
        const style = typeof window !== "undefined"
          ? window.getComputedStyle?.(current as HTMLElement)
          : undefined;
        if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") {
          return false;
        }
        current = current.parentElement ?? null;
      }
      return true;
    };
    const labelFor = (element: Element): string => {
      const html = element as HTMLElement;
      return element.getAttribute("aria-label")
        ?? element.getAttribute("placeholder")
        ?? html.innerText
        ?? element.textContent
        ?? "";
    };
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const normalizeComparable = (value: string): string => normalize(value).toLocaleLowerCase();
    const wantedComposerLabels = new Set(surfaceOptionLabels.composerTextboxes.map(normalizeComparable));
    const chatSurfaceLabels = new Set(surfaceOptionLabels.chat.map(normalizeComparable));
    const workSurfaceLabels = new Set(surfaceOptionLabels.work.map(normalizeComparable));
    const wantedSurfaceLabels = new Set([...chatSurfaceLabels, ...workSurfaceLabels]);
    const currentComposerRoots = Array.from(document.querySelectorAll(
      'main form[data-thread-find-composer="true"]'
    )).filter(visible);
    // Prefer the current structural form marker. Utility classes containing
    // "composer" occur on many descendants and are not independent roots.
    const composerRoots = currentComposerRoots.length > 0 ? currentComposerRoots : Array.from(document.querySelectorAll(
      "main form, main [data-testid*='composer' i], main [class*='composer' i]"
    )).filter(visible);
    const main = document.querySelector("main");
    const overlayRoots = Array.from(document.querySelectorAll(
      "[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-radix-menu-content]"
    )).filter(visible);
    const composerControlRoots = composerRoots.length > 0 ? composerRoots : main === null ? [] : [main];
    const effectiveControlRoots = Array.from(new Set<Element>([...composerControlRoots, ...overlayRoots]));
    // Reject oversized captures before expanding overlapping subtrees. A
    // truncated prefix could omit contradictory surface evidence.
    if (effectiveControlRoots.length > 32) {
      return {
        composerLabels: [], mainControls: [], composerControls: [], controlGroups: [],
        mainText: "", selectedSurfaceLabels: [], rootBudgetExceeded: true as const
      };
    }
    const mainTextboxes = main === null ? [] : Array.from(main.querySelectorAll(
      "textarea, [contenteditable='true'], [role='textbox'], input:not([type]), input[type='text']"
    )).filter(node => wantedComposerLabels.has(normalizeComparable(labelFor(node))));
    const composerNodes = Array.from(new Set([...composerRoots.flatMap(root => [
      root,
      ...Array.from(root.querySelectorAll("textarea, [contenteditable='true'], [role='textbox'], input"))
    ]), ...mainTextboxes]));
    const observedComposerLabels = Array.from(new Set(composerNodes
      .filter(visible)
      .map(labelFor)
      .map(normalize)
      .filter(Boolean)));
    const composerLabels = Array.from(new Set([
      ...observedComposerLabels.filter(label => wantedComposerLabels.has(normalizeComparable(label))),
      ...observedComposerLabels
    ]))
      .slice(0, 16);
    const overlayRootSet = new Set(overlayRoots);
    const owningOverlay = (node: Element): Element | undefined => {
      let current: Element | null = node;
      while (current !== null) {
        if (overlayRootSet.has(current)) return current;
        current = current.parentElement;
      }
      return undefined;
    };
    const controlsFor = (root: Element): string[] => Array.from(new Set(
      Array.from(root.querySelectorAll(
        "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option']"
      ))
        .filter(visible)
        // An ancestor composer/popover must not aggregate independent or
        // nested menus. Each overlay contributes only its own nearest scope.
        .filter(node => owningOverlay(node) === (overlayRootSet.has(root) ? root : undefined))
        .map(labelFor)
        .map(normalize)
        .filter(Boolean)
    )).slice(0, 120);
    const rootGroups = new Map(effectiveControlRoots.map(root => [root, controlsFor(root)]));
    const controlGroups = [...rootGroups.values()];
    const mainControls = Array.from(new Set(controlGroups.flat())).slice(0, 120);
    const composerControls = Array.from(new Set(composerControlRoots
      .flatMap(root => rootGroups.get(root) ?? []))).slice(0, 120);
    const surfaceTextNodes = main === null ? [] : Array.from(main.querySelectorAll(
      "h1, h2, h3, form, [data-testid*='composer' i], [class*='composer' i]"
    ))
      .filter(visible)
      .slice(0, 32);
    const mainText = normalize(surfaceTextNodes.map(labelFor).join(" ")).slice(0, 2000);
    const selectedRadioLabels = Array.from(document.querySelectorAll(
      "[role='radio'][aria-checked='true'], [role='radio'][data-state='checked'], input[type='radio']:checked"
    ))
      .filter(visible)
      .map(labelFor)
      .map(normalize)
      .filter(label => wantedSurfaceLabels.has(normalizeComparable(label)));
    // Current home panes use a two-button group. Require both known surface
    // labels, a unique group outside conversation/overlay content, and exactly
    // one pressed button; arbitrary pressed controls cannot supply evidence.
    const pressedGroups = Array.from(document.querySelectorAll("main [role='group']"))
      .filter(visible)
      .filter(group => {
        let ancestor: Element | null = group;
        for (let depth = 0; ancestor !== null && depth < 64; depth += 1) {
          if (ancestor.hasAttribute("data-message-author-role") || ancestor.tagName === "ARTICLE"
            || ["dialog", "menu", "listbox"].includes(ancestor.getAttribute("role") ?? "")) return false;
          ancestor = ancestor.parentElement;
        }
        return ancestor === null;
      })
      .map(group => Array.from(group.querySelectorAll("button[aria-pressed]"))
        .filter(button => button.parentElement === group && visible(button)
          && button.getAttribute("disabled") === null && button.getAttribute("aria-disabled") !== "true"))
      .filter(buttons => buttons.length === 2
        && new Set(buttons.map(button => normalizeComparable(labelFor(button)))).size === 2
        && buttons.every(button => wantedSurfaceLabels.has(normalizeComparable(labelFor(button)))
          && ["true", "false"].includes(button.getAttribute("aria-pressed") ?? ""))
        && buttons.filter(button => chatSurfaceLabels.has(normalizeComparable(labelFor(button)))).length === 1
        && buttons.filter(button => workSurfaceLabels.has(normalizeComparable(labelFor(button)))).length === 1
        && buttons.filter(button => button.getAttribute("aria-pressed") === "true").length === 1);
    const selectedButtonLabels = pressedGroups.length === 1
      ? pressedGroups[0]!.filter(button => button.getAttribute("aria-pressed") === "true").map(labelFor).map(normalize)
      : [];
    const selectedSurfaceLabels = Array.from(new Set([...selectedRadioLabels, ...selectedButtonLabels]))
      .slice(0, 4);
    const workPopoverOpen = Array.from(document.querySelectorAll(
      '[data-testid="composer-intelligence-picker-content"]'
    )).filter(visible).some(root => {
      const speed = Array.from(root.querySelectorAll(
        '[role="menuitemcheckbox"][data-fast-mode-enabled]'
      )).filter(visible);
      const sliders = Array.from(root.querySelectorAll('[role="slider"]'));
      return speed.length === 1 && sliders.length === 1;
    });
    return { composerLabels, mainControls, composerControls, controlGroups, mainText, selectedSurfaceLabels, workPopoverOpen };
  }, {
    chat: localeLabels.experienceOptions.chat,
    work: localeLabels.experienceOptions.work,
    composerTextboxes: [
      ...localeLabels.composerTextbox,
      ...localeLabels.workComposerTextbox,
    ]
  }).catch(() => ({ composerLabels: [], mainControls: [], mainText: "", selectedSurfaceLabels: [] }));

  return { url, ...snapshot };
}

function profileFromSnapshot(
  snapshot: SurfaceSnapshot,
  experience: ChatGPTExperience
): SurfaceSelectorProfile {
  const controls = snapshot.mainControls.map(normalizeForLabelMatch);
  const mainText = normalizeForLabelMatch(snapshot.mainText);

  if (experience === "work") {
    return hasAnyLabel(controls, localeLabels.configurationAxes.advanced)
      || containsAny(mainText, localeLabels.configurationAxes.advanced)
      ? "work_advanced_v1"
      : "work_basic_v1";
  }
  if (experience !== "chat") {
    return "unknown";
  }

  const projectComposer = snapshot.composerLabels
    .map(normalizeForLabelMatch)
    .some(label => /^new chat in\s+\S/u.test(label));
  if (/\/g\/g-p-[^/]+\/project(?:[/?#]|$)/i.test(snapshot.url) && projectComposer) {
    return "project_chat_v1";
  }

  const simplifiedOptions = [
    ...localeLabels.configurationOptions.instant,
    ...localeLabels.configurationOptions.medium,
    ...localeLabels.configurationOptions.high,
    ...localeLabels.configurationOptions.extraHigh,
    ...localeLabels.configurationOptions.pro,
  ];
  if (hasAnyLabel(controls, simplifiedOptions)) {
    return "chat_simplified_v1";
  }
  const legacyOptions = [
    ...localeLabels.modeOptions.latest,
    ...localeLabels.modeOptions.thinking,
    ...localeLabels.modeOptions.extended,
  ];
  return hasAnyLabel(controls, legacyOptions)
    ? "chat_legacy_v1"
    : "chat_simplified_v1";
}

async function clickUniqueExperienceControl(page: PageLike, labels: string[]): Promise<boolean> {
  for (const label of labels) {
    for (const role of ["radio", "button", "menuitem", "tab", "link"]) {
      if (await clickIfUnique(page.getByRole?.(role, { name: label, exact: true }))) {
        return true;
      }
    }
  }

  if (typeof page.evaluate !== "function") {
    return false;
  }
  return page.evaluate((wantedLabels: string[]) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const wanted = new Set(wantedLabels.map(normalize));
    const visible = (element: Element): boolean => {
      const html = element as HTMLElement;
      const rect = html.getBoundingClientRect?.();
      if (rect !== undefined && (rect.width <= 0 || rect.height <= 0)) return false;
      let current: Element | null = element;
      while (current !== null) {
        if (current.hasAttribute?.("inert") || current.getAttribute?.("aria-hidden") === "true") {
          return false;
        }
        const style = typeof window !== "undefined"
          ? window.getComputedStyle?.(current as HTMLElement)
          : undefined;
        if (style?.display === "none" || style?.visibility === "hidden" || style?.opacity === "0") {
          return false;
        }
        current = current.parentElement ?? null;
      }
      return true;
    };
    const labelFor = (node: Element): string => {
      const html = node as HTMLElement;
      const inputLabels = "labels" in node
        ? Array.from((node as HTMLInputElement).labels ?? []).map(label => label.innerText).join(" ")
        : "";
      return node.getAttribute("aria-label")
        || inputLabels
        || html.innerText
        || node.textContent
        || "";
    };
    const nodes = Array.from(document.querySelectorAll(
      "[role='radio'], input[type='radio'], header button, header [role='button'], header [role='tab'], main [role='menuitem'], main [role='option']"
    ));
    const matches = nodes.filter(node => visible(node) && wanted.has(normalize(labelFor(node))));
    if (matches.length !== 1) return false;
    (matches[0] as HTMLElement).click();
    return true;
  }, labels).catch(() => false);
}

async function clickIfUnique(locator: LocatorLike | undefined): Promise<boolean> {
  if (locator?.count === undefined || locator.click === undefined) {
    return false;
  }
  if (await locator.count().catch(() => 0) !== 1) {
    return false;
  }
  await locator.click();
  return true;
}

function matchingLabels(normalizedHaystack: string[], candidates: readonly string[]): string[] {
  const normalizedCandidates = candidates.map(normalizeForLabelMatch);
  return normalizedHaystack
    .filter(label => normalizedCandidates.some(candidate =>
      label === candidate || visibleLabelMatches(label, candidate)
    ))
    .slice(0, 4);
}

function hasAnyLabel(normalizedHaystack: string[], candidates: readonly string[]): boolean {
  const normalizedCandidates = candidates.map(normalizeForLabelMatch);
  return normalizedHaystack.some(label =>
    normalizedCandidates.some(candidate =>
      label === candidate || visibleLabelMatches(label, candidate)
    )
  );
}

function hasExactLabel(normalizedHaystack: string[], candidates: readonly string[]): boolean {
  const normalizedCandidates = new Set(candidates.map(normalizeForLabelMatch));
  return normalizedHaystack.some(label => normalizedCandidates.has(label));
}

function containsAny(normalizedText: string, candidates: readonly string[]): boolean {
  return candidates.map(normalizeForLabelMatch).some(candidate => normalizedText.includes(candidate));
}

async function experienceSelectorDrift<T>(
  page: PageLike,
  message: string,
  detected: DetectExperienceData
): Promise<CommandResult<T>> {
  return {
    ok: false,
    status: "unsupported",
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code: "experience_control_not_found",
      fieldPath: "experience",
      message,
      candidates: detected.evidence.map(item => ({ label: `${item.source}: ${item.label}` })),
      resumable: true
    },
    context: await contextFromPage(page, {
      experience: detected.experience,
      selectorProfile: detected.selectorProfile
    })
  };
}
