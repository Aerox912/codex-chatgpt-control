import { enumerateVisibleMenuItems, pressMenuEscape, type MenuItem } from "../dom/menus.js";
import {
  chatModelMenuOptions,
  chatPowerValueLabels,
  findChatModelViewOpener,
  selectedChatModelMenuOption
} from "../dom/chat-configuration-menu.js";
import { localeLabels } from "../dom/locale-labels.js";
import { normalizeForLabelMatch, visibleLabelMatches } from "../dom/label-match.js";
import { resultError, resultOk } from "../errors.js";
import { tabIdFromPage } from "../browser/attach.js";
import type {
  AppliedConfigurationSelection,
  ApplyConfigurationArgs,
  ApplyConfigurationData,
  ChatGPTExperience,
  CommandResult,
  ConfigurationAxis,
  ConfigurationInspectionData,
  ConfigurationOption,
  ConfigurationSelection,
  InspectConfigurationArgs,
  LocatorLike,
  PageLike,
  RuntimeEnv,
  SurfaceSelectorProfile
} from "../types.js";
import { contextFromPage } from "./context.js";
import { detectExperience, openExperience } from "./experience.js";
import { setMode } from "./modes.js";
import { discoverPowerSlider, type PowerDiscoveryResult } from "./power-discovery.js";
import { ensurePage } from "./session.js";

const WORK_AXES: ConfigurationAxis[] = ["model", "effort", "speed"];
const CONFIGURATION_CONTROL_DISCOVERY_TIMEOUT_MS = 5_000;
const CONFIGURATION_CONTROL_POLL_MS = 250;
const CONFIGURATION_SELECTION_MAX_ATTEMPTS = 6;
const CONFIGURATION_SELECTION_RETRY_MS = 400;
const CONFIGURATION_AXIS_ORDER: ConfigurationAxis[] = [
  "model",
  "intelligence",
  "effort",
  "speed",
  "modelVersion",
];
const CHAT_CONFIGURATION_AXIS_ORDER: ConfigurationAxis[] = [
  "intelligence",
  "effort",
  "model",
  "modelVersion",
  "speed",
];

type SuccessfulPowerDiscovery = Extract<PowerDiscoveryResult, { ok: true }>;

type ChatConfigurationObservation = {
  power?: SuccessfulPowerDiscovery;
  modelItems?: MenuItem[];
};

export type ConfigurationPanelSnapshot = {
  openerLabel?: string;
  axisRows: Array<{ axis: ConfigurationAxis; label: string; value?: string }>;
  advancedVisible: boolean;
};

export async function inspectConfiguration(
  env: RuntimeEnv,
  args: InspectConfigurationArgs = {}
): Promise<CommandResult<ConfigurationInspectionData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) {
    return boot as CommandResult<ConfigurationInspectionData>;
  }

  const page = env.page!;
  try {
    const detected = await detectExperience(
      env,
      args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }
    );
    if (!detected.ok || detected.data === undefined) {
      return forwardFailure(detected);
    }
    const initialPanel = await readConfigurationPanel(page);
    const discoveryExperience = detected.data.experience === "unknown"
      ? args.experience ?? "unknown"
      : detected.data.experience;
    const rootOpened = await waitForConfigurationRoot(
      page,
      discoveryExperience,
      args.timeoutMs
    );
    if (rootOpened) {
      await page.waitForTimeout?.(150);
    }

    let panel = await readConfigurationPanel(page);
    if (initialPanel.openerLabel !== undefined
      && (panel.openerLabel === undefined || isProConfigurationOpener(initialPanel.openerLabel))) {
      panel.openerLabel = initialPanel.openerLabel;
    }
    let rootItems = rootOpened ? await enumerateVisibleMenuItems(page) : [];
    const inferredExperience = detected.data.experience === "unknown"
      ? inferExperienceFromConfigurationPanel(panel, rootItems)
      : detected.data.experience;
    const experience = inferredExperience === "unknown"
      ? discoveryExperience
      : inferredExperience;

    if (args.experience !== undefined && experience !== args.experience) {
      if (rootOpened) await closeConfigurationMenus(page);
      return {
        ok: false,
        status: "unsupported",
        warnings: [],
        blocker: {
          kind: "selector_drift",
          code: "experience_mismatch",
          fieldPath: "experience",
          message: `Configuration inspection expected ${args.experience}, but the visible composer is ${experience}. Call experience.open first or omit the expected experience.`,
          resumable: true
        },
        context: await contextFromPage(page, {
          experience,
          selectorProfile: detected.data.selectorProfile
        })
      };
    }

    let chatObservation: ChatConfigurationObservation | undefined;
    const chatAdvancedRequired = experience === "chat"
      && rootOpened
      && (compactChatRootLooksRecognized(panel, rootItems) || chatModelMenuOptions(rootItems).length > 0);
    let chatAdvancedOpened = !chatAdvancedRequired;
    if (chatAdvancedRequired) {
      // The model carousel hides Power. Reopen the root before reading either
      // axis so an already-open model view uses the same independent evidence.
      const modelViewOpen = chatModelMenuOptions(rootItems).length > 0
        && findChatModelViewOpener(rootItems) === undefined;
      if (modelViewOpen) {
        await closeConfigurationMenus(page);
        await waitForConfigurationRoot(page, "chat", args.timeoutMs);
        await page.waitForTimeout?.(150);
        rootItems = await enumerateVisibleMenuItems(page);
      }
      const currentPicker = modelViewOpen || findChatModelViewOpener(rootItems) !== undefined;
      const power = await discoverPowerSlider(page, {
        powerLabels: localeLabels.configurationAxes.power,
        valueLabels: chatPowerValueLabels
      });
      const currentModelItems = chatModelMenuOptions(rootItems).length > 0
        ? rootItems
        : findChatModelViewOpener(rootItems) === undefined
          ? undefined
          : await ensureChatModelPanel(page, rootItems);
      if (currentPicker) {
        chatObservation = {
          ...(power.ok ? { power } : {}),
          modelItems: currentModelItems ?? []
        };
        chatAdvancedOpened = power.ok && selectedChatModelMenuOption(currentModelItems ?? []) !== undefined;
        rootItems = currentModelItems ?? [];
      } else {
        chatAdvancedOpened = await ensureChatAdvancedPanel(page, rootItems);
      }
    }
    if (chatAdvancedRequired && chatAdvancedOpened) {
      await page.waitForTimeout?.(150);
      panel = await readConfigurationPanel(page);
      if (initialPanel.openerLabel !== undefined
        && (panel.openerLabel === undefined || isProConfigurationOpener(initialPanel.openerLabel))) {
        panel.openerLabel = initialPanel.openerLabel;
      }
      if (chatObservation === undefined) rootItems = await enumerateVisibleMenuItems(page);
    }

    const workAdvancedOpened = experience !== "work"
      || (rootOpened && await ensureWorkAdvancedPanel(page));
    if (experience === "work" && workAdvancedOpened) {
      await page.waitForTimeout?.(150);
      panel = await readConfigurationPanel(page);
      if (initialPanel.openerLabel !== undefined
        && (panel.openerLabel === undefined || isProConfigurationOpener(initialPanel.openerLabel))) {
        panel.openerLabel = initialPanel.openerLabel;
      }
      rootItems = rootOpened ? await enumerateVisibleMenuItems(page) : [];
    }

    const data = configurationInspectionFromSurface(
      experience,
      detected.data.selectorProfile,
      detected.data.evidence,
      panel,
      rootItems,
      chatObservation
    );

    if (args.includeOptions !== false && experience === "work" && panel.axisRows.length > 0) {
      for (const axis of WORK_AXES) {
        if (!data.availableAxes.includes(axis)) continue;
        const options = await inspectWorkAxisOptions(env, axis);
        if (options.length > 0) {
          data.options[axis] = options;
        }
      }
    }

    const warnings: string[] = [];
    if (!rootOpened) {
      warnings.push("No scoped configuration opener was available; inspection is limited to controls already visible in the composer.");
    }
    if (experience === "work" && rootOpened && !workAdvancedOpened) {
      warnings.push("The Work configuration menu opened, but its Advanced model, effort, and speed controls could not be made visible.");
    }
    if (chatAdvancedRequired && !chatAdvancedOpened) {
      warnings.push("The compact Chat configuration menu opened, but its Power and Select model controls could not both be verified.");
    }
    if (!data.verified) {
      warnings.push("The visible configuration could not be verified from a recognized Chat or Work selector profile.");
    }

    if (rootOpened) await closeConfigurationMenus(page);
    return resultOk(data, await contextFromPage(page, {
      experience: data.experience,
      selectorProfile: data.selectorProfile
    }), warnings);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

async function waitForConfigurationRoot(
  page: PageLike,
  experience: ChatGPTExperience,
  timeoutMs: number | undefined
): Promise<boolean> {
  const discoveryMs = Math.min(
    timeoutMs ?? CONFIGURATION_CONTROL_DISCOVERY_TIMEOUT_MS,
    CONFIGURATION_CONTROL_DISCOVERY_TIMEOUT_MS
  );
  const attempts = Math.max(1, Math.ceil(Math.max(0, discoveryMs) / CONFIGURATION_CONTROL_POLL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await openConfigurationRoot(page, experience)) return true;
    if (attempt + 1 < attempts) {
      await page.waitForTimeout?.(CONFIGURATION_CONTROL_POLL_MS);
    }
  }
  return false;
}

export async function applyConfiguration(
  env: RuntimeEnv,
  args: ApplyConfigurationArgs
): Promise<CommandResult<ApplyConfigurationData>> {
  const boot = await ensurePage(env);
  if (!boot.ok) {
    return boot as CommandResult<ApplyConfigurationData>;
  }

  const page = env.page!;
  const strict = args.strict ?? true;
  try {
    const desired = normalizeDesiredSelection(args.desired);
    if (selectionEntries(desired).length === 0) {
      return {
        ok: false,
        status: "unsupported",
        warnings: [],
        blocker: {
          kind: "selector_drift",
          code: "configuration_empty",
          fieldPath: "desired",
          message: "configuration.apply requires at least one desired model, intelligence, effort, speed, or modelVersion value.",
          resumable: false
        },
        context: await contextFromPage(page)
      };
    }

    if (args.experience !== undefined) {
      const opened = await openExperience(env, {
        experience: args.experience,
        ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
      });
      if (!opened.ok) {
        return forwardFailure(opened);
      }
    }

    const beforeResult = await inspectConfiguration(env, {
      ...(args.experience === undefined ? {} : { experience: args.experience }),
      includeOptions: true,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
    });
    if (!beforeResult.ok || beforeResult.data === undefined) {
      return forwardFailure(beforeResult);
    }
    const before = beforeResult.data;
    if (before.experience === "unknown") {
      return configurationFailure(page, before, desired, [], "The visible surface is not recognizable as Chat or Work.", "experience_unknown");
    }

    const selected: AppliedConfigurationSelection[] = [];
    const applyOrder = before.experience === "chat"
      ? CHAT_CONFIGURATION_AXIS_ORDER
      : CONFIGURATION_AXIS_ORDER;
    for (const [axis, requested] of selectionEntries(desired, applyOrder)) {
      const active = activeConfigurationValue(before, axis);
      if (active !== undefined && configurationValueMatches(active, requested)) {
        selected.push({ axis, requested, selected: active });
        continue;
      }

      const selection = before.experience === "work"
        ? await selectWorkAxis(env, axis, requested, args.timeoutMs)
        : await selectChatAxis(env, axis, requested, args.timeoutMs);
      if (selection === undefined) {
        return configurationFailure(
          page,
          before,
          desired,
          selected,
          `Configuration option "${requested}" for ${axis} was not found or was ambiguous on the ${before.experience} surface.`,
          "configuration_option_not_found",
          before.options[axis]?.map(option => option.label)
        );
      }
      selected.push({ axis, requested, selected: selection });
    }

    const afterResult = await inspectConfiguration(env, {
      ...(args.experience === undefined ? {} : { experience: args.experience }),
      includeOptions: false,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs })
    });
    if (!afterResult.ok || afterResult.data === undefined) {
      return forwardFailure(afterResult);
    }
    const after = afterResult.data;
    const verified = configurationMatchesSelection(after, desired);
    const data: ApplyConfigurationData = { requested: desired, selected, before, after, verified };
    if (!verified && strict) {
      return {
        ok: false,
        status: "blocked",
        data,
        warnings: [],
        blocker: {
          kind: "selector_drift",
          code: "configuration_postcondition_unverified",
          fieldPath: "desired",
          message: `ChatGPT accepted configuration clicks, but the visible ${after.experience} controls do not verify every requested value.`,
          candidates: Object.entries(after.active).map(([axis, label]) => ({ label: `${axis}: ${label}` })),
          resumable: true
        },
        context: await contextFromPage(page, {
          experience: after.experience,
          selectorProfile: after.selectorProfile
        })
      };
    }

    const warnings = verified
      ? []
      : ["Configuration clicks completed, but strict verification was disabled and the visible postcondition remains unverified."];
    return resultOk(data, await contextFromPage(page, {
      experience: after.experience,
      selectorProfile: after.selectorProfile
    }), warnings);
  } catch (error) {
    return resultError(error instanceof Error ? error : new Error(String(error)), await contextFromPage(page));
  }
}

export function configurationInspectionFromSurface(
  experience: ChatGPTExperience,
  detectedProfile: SurfaceSelectorProfile,
  evidence: ConfigurationInspectionData["evidence"],
  panel: ConfigurationPanelSnapshot,
  menuItems: MenuItem[],
  chatObservation?: ChatConfigurationObservation
): ConfigurationInspectionData {
  const active: Partial<Record<ConfigurationAxis, string>> = {};
  const options: Partial<Record<ConfigurationAxis, ConfigurationOption[]>> = {};
  const availableAxes: ConfigurationAxis[] = [];
  const configurationEvidence = [...evidence];
  let selectorProfile = detectedProfile;

  if (experience === "work") {
    for (const row of panel.axisRows) {
      if (!availableAxes.includes(row.axis)) availableAxes.push(row.axis);
      if (row.value !== undefined && row.value.length > 0) active[row.axis] = row.value;
    }
    selectorProfile = panel.advancedVisible ? "work_advanced_v1" : "work_basic_v1";
  } else if (experience === "chat") {
    const compact = compactChatMenuLooksRecognized(panel);
    const currentCompact = currentCompactChatMenuLooksRecognized(menuItems);
    const simplified = chatObservation !== undefined || currentCompact || compact || chatMenuLooksSimplified(menuItems);
    selectorProfile = detectedProfile === "project_chat_v1"
      ? detectedProfile
      : simplified ? "chat_simplified_v1" : detectedProfile;
    if (chatObservation !== undefined) {
      const modelOptions = chatModelMenuOptions(chatObservation.modelItems ?? []);
      availableAxes.push("model", "effort");
      if (modelOptions.length > 0) {
        options.model = modelOptions.map(menuItemToOption);
        const selectedModel = selectedChatModelMenuOption(modelOptions);
        if (selectedModel !== undefined) {
          active.model = selectedModel.label;
          configurationEvidence.push({ source: "control", label: `Selected model radio: ${selectedModel.label}` });
        }
      }
      if (chatObservation.power !== undefined) {
        const powerLabel = selectedPowerLabel(chatObservation.power);
        if (powerLabel !== undefined) {
          active.effort = powerLabel;
          configurationEvidence.push({ source: "control", label: `Selected Power slider: ${powerLabel}` });
        }
        options.effort = chatObservation.power.options.map(option => ({
          id: normalizeConfigurationId(option.label),
          label: option.label,
          selected: option.value === chatObservation.power!.range.current
        }));
      }
    } else if (currentCompact) {
      const modelOptions = chatModelMenuOptions(menuItems);
      availableAxes.push("model", "effort");
      options.model = modelOptions.map(menuItemToOption);
      const selectedModel = selectedChatModelMenuOption(modelOptions);
      if (selectedModel !== undefined) active.model = selectedModel.label;
      // Power belongs to the other carousel view and needs its own evidence.
    } else if (compact) {
      if (isStandaloneChatModeLabel(panel.openerLabel)) {
        availableAxes.push("intelligence");
        active.intelligence = panel.openerLabel;
      }
      for (const row of panel.axisRows) {
        if (!availableAxes.includes(row.axis)) availableAxes.push(row.axis);
        if (row.value !== undefined && row.value.length > 0) active[row.axis] = row.value;
      }
    } else {
      const axis: ConfigurationAxis = simplified ? "intelligence" : "effort";
      if (menuItems.length > 0 || panel.openerLabel !== undefined) {
        availableAxes.push(axis);
      }
      if (isStandaloneChatModeLabel(panel.openerLabel)) {
        active[axis] = panel.openerLabel;
      }
      const chatOptions = menuItems
        .filter(item => !isConfigurationAxisRow(item.label))
        .map(menuItemToOption);
      if (chatOptions.length > 0) {
        options[axis] = chatOptions;
      }
      const modelRows = menuItems.filter(item => /^gpt[\s-]/i.test(item.label) || item.hasPopup === true);
      if (modelRows.length > 0) {
        availableAxes.push("modelVersion");
        options.modelVersion = modelRows.map(menuItemToOption);
      }
    }
  }

  return {
    experience,
    selectorProfile,
    availableAxes,
    active,
    options,
    verified: experience !== "unknown" && availableAxes.length > 0
      && availableAxes.every(axis => active[axis] !== undefined),
    evidence: configurationEvidence
  };
}

async function inspectWorkAxisOptions(env: RuntimeEnv, axis: ConfigurationAxis): Promise<ConfigurationOption[]> {
  const page = env.page!;
  const options = (await openWorkAxisOptions(env, axis))
    .map(menuItemToOption);
  await closeConfigurationSubmenu(page);
  return dedupeOptions(options);
}

async function selectWorkAxis(
  env: RuntimeEnv,
  axis: ConfigurationAxis,
  requested: string,
  timeoutMs: number | undefined
): Promise<string | undefined> {
  const page = env.page!;
  if (!WORK_AXES.includes(axis)) {
    return undefined;
  }
  const retryWindowMs = Math.min(
    timeoutMs ?? CONFIGURATION_CONTROL_DISCOVERY_TIMEOUT_MS,
    CONFIGURATION_CONTROL_DISCOVERY_TIMEOUT_MS
  );
  const attempts = Math.max(2, Math.min(
    CONFIGURATION_SELECTION_MAX_ATTEMPTS,
    Math.ceil(Math.max(0, retryWindowMs) / CONFIGURATION_SELECTION_RETRY_MS) + 1
  ));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidates = await openWorkAxisOptions(env, axis);
    const match = findConfigurationOption(candidates, requested);
    if (match !== undefined && await clickVisibleMenuItem(page, match)) {
      await page.waitForTimeout?.(150);
      return match.label;
    }
    if (attempt + 1 < attempts) {
      // The submenu can disappear between enumeration and the visible click
      // when ChatGPT's pointer-grace timer fires, and Work may briefly retain
      // the previous submenu immediately after a selection. Reopen from a
      // fresh DOM instance for a small bounded window instead of treating the
      // transient state as permanent selector drift.
      await closeConfigurationMenus(page);
      await page.waitForTimeout?.(CONFIGURATION_SELECTION_RETRY_MS);
    }
  }
  return undefined;
}

async function openWorkAxisOptions(
  env: RuntimeEnv,
  axis: ConfigurationAxis,
  allowRootRetry = true
): Promise<MenuItem[]> {
  const page = env.page!;
  if (!await ensureWorkAdvancedPanel(page)) return [];

  const row = await findWorkAxisRow(page, axis);
  if (row === undefined) return [];

  const visibleOptions = async (): Promise<MenuItem[]> =>
    filterWorkAxisOptions(await enumerateVisibleMenuItems(page), axis);
  const alreadyOpen = await visibleOptions();
  if (alreadyOpen.length > 0) return alreadyOpen;

  const point = await locatorCenter(row);
  if (point !== undefined && await movePointerWithCdp(env, point)) {
    await page.waitForTimeout?.(180);
    const hoveredOptions = await visibleOptions();
    if (hoveredOptions.length > 0) return hoveredOptions;

    // Radix may apply the previous submenu's pointer-grace close after the new
    // axis briefly opens. Once that timer has elapsed, a tiny in-row nudge
    // creates a fresh hover transition without ever leaving the root menu.
    await movePointerWithCdp(env, { x: point.x - 2, y: point.y });
    await movePointerWithCdp(env, point);
    await page.waitForTimeout?.(180);
    const retriedOptions = await visibleOptions();
    if (retriedOptions.length > 0) return retriedOptions;
  }

  if (point !== undefined && page.mouse?.move !== undefined) {
    try {
      await page.mouse.move(point.x, point.y);
    } catch {
      // Fall through to the Computer Use and click fallbacks.
    }
    await page.waitForTimeout?.(180);
    const mouseOptions = await visibleOptions();
    if (mouseOptions.length > 0) return mouseOptions;
  }

  if (point !== undefined && typeof page.cua?.move === "function") {
    try {
      await page.cua.move(point);
    } catch {
      // Fall through to the click fallback.
    }
    await page.waitForTimeout?.(180);
    const movedOptions = await visibleOptions();
    if (movedOptions.length > 0) return movedOptions;
  }

  if (row.click !== undefined) {
    await row.click().catch(() => undefined);
    await page.waitForTimeout?.(180);
  }
  const clickedOptions = await visibleOptions();
  if (clickedOptions.length > 0 || !allowRootRetry) return clickedOptions;

  // A submenu pointer-grace dismissal can also close the root menu. Reopen the
  // complete Advanced panel once and resolve a fresh row locator; stale row
  // handles and same-coordinate pointer moves cannot recover a detached menu.
  await closeConfigurationMenus(page);
  await page.waitForTimeout?.(200);
  return openWorkAxisOptions(env, axis, false);
}

async function locatorCenter(locator: LocatorLike): Promise<{ x: number; y: number } | undefined> {
  if (locator.evaluate === undefined) return undefined;
  return locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  }).catch(() => undefined);
}

async function movePointerWithCdp(
  env: RuntimeEnv,
  point: { x: number; y: number }
): Promise<boolean> {
  const page = env.page;
  const tabId = page === undefined ? undefined : tabIdFromPage(page);
  if (tabId === undefined || env.browser?.tabs?.get === undefined) return false;
  try {
    const tab = await env.browser.tabs.get(tabId);
    const capability = await tab.capabilities?.get?.("cdp") as {
      send?: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    } | undefined;
    if (capability?.send === undefined) return false;
    // Move directly between axis rows. Moving outside the Radix root menu first
    // schedules its dismissal; the submenu can briefly appear and then vanish
    // before the bounded option inspection runs.
    await capability.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(point.x),
      y: Math.round(point.y),
      button: "none",
      buttons: 0,
      pointerType: "mouse"
    });
    return true;
  } catch {
    return false;
  }
}

function filterWorkAxisOptions(items: MenuItem[], axis: ConfigurationAxis): MenuItem[] {
  return items.filter(item => {
    if (isConfigurationAxisRow(item.label)) return false;
    // Keep every choice axis-specific. This excludes parent actions such as
    // "Reset to default" and prevents a still-open model submenu from being
    // mistaken for effort or speed choices if Escape is unavailable.
    return workAxisOptionLabelMatches(axis, item.label);
  });
}

function workAxisOptionLabelMatches(axis: ConfigurationAxis, label: string): boolean {
  if (axis === "model") {
    return /\b(?:gpt[\s-]?\d|sol|luna|terra)\b/i.test(label);
  }
  const candidates = axis === "effort"
    ? [
        ...localeLabels.configurationOptions.light,
        ...localeLabels.configurationOptions.medium,
        ...localeLabels.configurationOptions.high,
        ...localeLabels.configurationOptions.extraHigh,
        ...localeLabels.configurationOptions.max,
        ...localeLabels.configurationOptions.ultra,
      ]
    : axis === "speed"
      ? [
          ...localeLabels.configurationOptions.standard,
          ...localeLabels.configurationOptions.fast,
        ]
      : [];
  return candidates.some(candidate => visibleLabelMatches(label, candidate));
}

async function selectChatAxis(
  env: RuntimeEnv,
  axis: ConfigurationAxis,
  requested: string,
  timeoutMs: number | undefined
): Promise<string | undefined> {
  const legacyArgs = axis === "modelVersion"
    ? { modelVersion: requested }
    : axis === "intelligence"
      ? { intelligence: requested }
      : axis === "effort"
        ? { effort: requested }
        : axis === "model"
          ? { model: requested }
          : undefined;
  if (legacyArgs === undefined) {
    return undefined;
  }
  const result = await setMode(env, {
    ...legacyArgs,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  return result.ok ? result.data?.selected.at(-1) : undefined;
}

async function openConfigurationRoot(page: PageLike, experience: ChatGPTExperience): Promise<boolean> {
  const existing = await readConfigurationPanel(page);
  if (existing.axisRows.length > 0) {
    return true;
  }
  const existingItems = await enumerateVisibleMenuItems(page).catch(() => []);
  if (experience === "chat" && chatModelMenuOptions(existingItems).length > 0) return true;
  if (compactChatRootLooksRecognized(existing, existingItems)) {
    return true;
  }
  if (configurationMenuLooksRecognized(existingItems, experience, existing.openerLabel)) {
    return true;
  }
  if (existing.openerLabel !== undefined
    && await clickIfUnique(page.getByRole?.("button", { name: existing.openerLabel, exact: true }))) {
    return true;
  }

  if (typeof page.evaluate === "function") {
    const clicked = await page.evaluate((surface: ChatGPTExperience) => {
      const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
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
      const formRoots = Array.from(document.querySelectorAll("main form"));
      const testIdRoots = Array.from(document.querySelectorAll("main [data-testid*='composer' i]"));
      const classRoots = Array.from(document.querySelectorAll("main [class*='composer' i]"));
      const composerRoots = formRoots.length > 0
        ? formRoots
        : testIdRoots.length > 0
          ? testIdRoots
          : classRoots;
      const main = document.querySelector("main");
      const roots = Array.from(new Set<Element>(composerRoots.length > 0
        ? composerRoots
        : (main === null ? [] : [main])));
      const controls = Array.from(new Set(roots.flatMap(root =>
        Array.from(root.querySelectorAll("button, [role='button']"))
      )))
        .filter(visible);
      const matches = controls.filter(control => {
        const html = control as HTMLElement;
        const label = normalize(control.getAttribute("aria-label") ?? html.innerText ?? control.textContent ?? "");
        const testId = control.getAttribute("data-testid") ?? "";
        if (/send|voice|microphone|attach|upload|add files|plus/i.test(`${label} ${testId}`)) return false;
        if (/model-switcher|model-selector|mode-selector/i.test(testId)) return true;
        return surface === "work"
          ? /\b(?:gpt|sol|luna|terra|light|medium|high|max|ultra|standard|fast)\b/i.test(label)
          : /\b(?:instant|medium|high|extra high|pro|thinking|extended|gpt)\b/i.test(label);
      });
      if (matches.length !== 1) return false;
      (matches[0] as HTMLElement).click();
      return true;
    }, experience).catch(() => false);
    if (clicked) return true;
  }

  const labels = experience === "work"
    ? [
        ...localeLabels.configurationOptions.light,
        ...localeLabels.configurationOptions.medium,
        ...localeLabels.configurationOptions.high,
        ...localeLabels.configurationOptions.standard,
      ]
    : [
        ...localeLabels.configurationOptions.instant,
        ...localeLabels.configurationOptions.medium,
        ...localeLabels.configurationOptions.high,
        ...localeLabels.configurationOptions.extraHigh,
        ...localeLabels.configurationOptions.pro,
        ...localeLabels.modeOptions.thinking,
      ];
  for (const label of labels) {
    if (await clickIfUnique(page.getByRole?.("button", { name: label, exact: true }))) {
      return true;
    }
  }
  return false;
}

function configurationMenuLooksRecognized(
  items: MenuItem[],
  experience: ChatGPTExperience,
  openerLabel: string | undefined
): boolean {
  if (items.some(item => /(?:model|mode|effort|speed)-(?:switcher|selector)|model-switcher/i.test(item.testId ?? ""))) {
    return true;
  }
  const visibleAxisCount = (["model", "intelligence", "effort", "speed"] as ConfigurationAxis[])
    .filter(axis => items.some(item => (localeLabels.configurationAxes[axis as keyof typeof localeLabels.configurationAxes] ?? [])
      .some(label => visibleLabelMatches(item.label, label))))
    .length;
  if (visibleAxisCount >= 2) {
    return true;
  }
  if (experience === "work" && items.some(item =>
    localeLabels.configurationAxes.advanced.some(label => visibleLabelMatches(item.label, label)))) {
    return true;
  }
  if (openerLabel === undefined || items.length === 0) {
    return false;
  }

  const semanticLabels = experience === "work"
    ? [
        ...localeLabels.configurationOptions.light,
        ...localeLabels.configurationOptions.medium,
        ...localeLabels.configurationOptions.high,
        ...localeLabels.configurationOptions.max,
        ...localeLabels.configurationOptions.ultra,
        ...localeLabels.configurationOptions.standard,
        ...localeLabels.configurationOptions.fast,
      ]
    : [
        ...localeLabels.configurationOptions.instant,
        ...localeLabels.configurationOptions.medium,
        ...localeLabels.configurationOptions.high,
        ...localeLabels.configurationOptions.extraHigh,
        ...localeLabels.configurationOptions.pro,
        ...localeLabels.modeOptions.thinking,
        ...localeLabels.modeOptions.extended,
      ];
  const matched = new Set(
    items
      .filter(item => semanticLabels.some(label => visibleLabelMatches(item.label, label)))
      .map(item => normalizeConfigurationId(item.label))
  );
  return matched.size >= 2;
}

async function ensureWorkAdvancedPanel(page: PageLike): Promise<boolean> {
  const panel = await readConfigurationPanel(page);
  if (panel.axisRows.length > 0) return true;
  if (!await openConfigurationRoot(page, "work")) return false;
  const reopenedPanel = await readConfigurationPanel(page);
  if (reopenedPanel.axisRows.length > 0) return true;

  const items = await enumerateVisibleMenuItems(page);
  const advanced = items.filter(item =>
    localeLabels.configurationAxes.advanced.some(label => visibleLabelMatches(item.label, label)));
  if (advanced.length !== 1 || !await clickVisibleMenuItem(page, advanced[0]!)) {
    return false;
  }
  await page.waitForTimeout?.(200);
  return (await readConfigurationPanel(page)).axisRows.length > 0;
}

async function ensureChatModelPanel(page: PageLike, items: MenuItem[]): Promise<MenuItem[] | undefined> {
  if (chatModelMenuOptions(items).length > 0) return items;
  const opener = findChatModelViewOpener(items);
  if (opener === undefined || !await clickVisibleMenuItem(page, opener)) return undefined;
  await page.waitForTimeout?.(200);
  const modelItems = await enumerateVisibleMenuItems(page);
  return chatModelMenuOptions(modelItems).length > 0 ? modelItems : undefined;
}

async function ensureChatAdvancedPanel(page: PageLike, items: MenuItem[]): Promise<boolean> {
  const advanced = items.filter(item => menuItemMatchesConfigurationAxis(item, "advanced"));
  if (advanced.length !== 1 || !await clickVisibleMenuItem(page, advanced[0]!)) {
    return false;
  }
  await page.waitForTimeout?.(200);
  return compactChatMenuLooksRecognized(await readConfigurationPanel(page));
}

async function readConfigurationPanel(page: PageLike): Promise<ConfigurationPanelSnapshot> {
  if (typeof page.evaluate !== "function") {
    return { axisRows: [], advancedVisible: false };
  }
  return page.evaluate((axisLabels: Record<string, string[]>) => {
    const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
    const normalizedAxes = Object.fromEntries(
      Object.entries(axisLabels).map(([axis, labels]) => [
        axis,
        labels.map(label => normalize(label).toLocaleLowerCase())
      ])
    );
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
    const overlays = Array.from(document.querySelectorAll(
      "[role='menu'], [role='listbox'], [data-radix-popper-content-wrapper], [data-radix-menu-content]"
    )).filter(visible);
    const roots = overlays.length > 0 ? overlays : Array.from(document.querySelectorAll("main")).filter(visible);
    const rows = roots.flatMap(root => Array.from(root.querySelectorAll(
      "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option']"
    ))).filter(visible);
    const axisRows: Array<{ axis: ConfigurationAxis; label: string; value?: string }> = [];
    for (const row of rows) {
      const html = row as HTMLElement;
      const label = normalize(row.getAttribute("aria-label") ?? html.innerText ?? row.textContent ?? "");
      const normalized = label.toLocaleLowerCase();
      for (const axis of ["model", "intelligence", "effort", "speed"] as ConfigurationAxis[]) {
        const candidates = normalizedAxes[axis] ?? [];
        const prefix = candidates.find(candidate => normalized === candidate || normalized.startsWith(`${candidate} `));
        if (prefix === undefined) continue;
        const value = normalize(label.slice(prefix.length));
        const item: { axis: ConfigurationAxis; label: string; value?: string } = { axis, label };
        if (value.length > 0) item.value = value;
        axisRows.push(item);
        break;
      }
    }

    const formRoots = Array.from(document.querySelectorAll("main form"));
    const testIdRoots = Array.from(document.querySelectorAll("main [data-testid*='composer' i]"));
    const classRoots = Array.from(document.querySelectorAll("main [class*='composer' i]"));
    const composerRoots = formRoots.length > 0
      ? formRoots
      : testIdRoots.length > 0
        ? testIdRoots
        : classRoots;
    const main = document.querySelector("main");
    const openerRoots = Array.from(new Set<Element>(composerRoots.length > 0
      ? composerRoots
      : (main === null ? [] : [main])));
    const openerCandidatesFrom = (candidateRoots: Element[]) => Array.from(new Set(candidateRoots.flatMap(root =>
      Array.from(root.querySelectorAll("button, [role='button']"))
    )))
      .filter(visible)
      .map(control => {
        const html = control as HTMLElement;
        return {
          label: normalize(control.getAttribute("aria-label") ?? html.innerText ?? control.textContent ?? ""),
          testId: control.getAttribute("data-testid") ?? ""
        };
      })
      .filter(item => !/send|voice|microphone|attach|upload|add files|plus|feedback|copy|share|edit|more actions/i.test(`${item.label} ${item.testId}`))
      .filter(item => /model-switcher|model-selector|mode-selector/i.test(item.testId)
        || /\b(?:gpt|sol|luna|terra|instant|medium|high|extra high|pro|thinking|extended|light|standard|fast)\b/i.test(item.label));
    const scopedOpenerCandidates = openerCandidatesFrom(openerRoots);
    const openerCandidates = scopedOpenerCandidates;
    const result: ConfigurationPanelSnapshot = {
      axisRows,
      advancedVisible: axisRows.length > 0
    };
    if (openerCandidates.length === 1 && openerCandidates[0]?.label.length) {
      result.openerLabel = openerCandidates[0].label;
    }
    return result;
  }, localeLabels.configurationAxes).catch(() => ({ axisRows: [], advancedVisible: false }));
}

function compactChatMenuLooksRecognized(panel: ConfigurationPanelSnapshot): boolean {
  const openerLabel = panel.openerLabel;
  if (!isProConfigurationOpener(openerLabel)) {
    return false;
  }
  const axes = new Set(panel.axisRows.map(row => row.axis));
  return axes.has("model") && axes.has("effort");
}

function compactChatRootLooksRecognized(
  panel: ConfigurationPanelSnapshot,
  items: MenuItem[]
): boolean {
  if (panel.axisRows.length > 0
    || !items.some(item => /\bpower\b/i.test(`${item.label} ${item.ariaLabel ?? ""}`))) {
    return false;
  }
  // Select model is a strong identifier for the current two-view Chat picker,
  // regardless of which Power value is active. The legacy Advanced root needs
  // the compact Pro opener to remain distinguishable from Work.
  return findChatModelViewOpener(items) !== undefined
    || (isProConfigurationOpener(panel.openerLabel)
      && items.some(item => menuItemMatchesConfigurationAxis(item, "advanced")));
}

function currentCompactChatMenuLooksRecognized(items: MenuItem[]): boolean {
  return items.some(item => /\bpower\b/i.test(`${item.label} ${item.ariaLabel ?? ""}`))
    && chatModelMenuOptions(items).length > 0
    && selectedChatModelMenuOption(items) !== undefined;
}

function isProConfigurationOpener(label: string | undefined): boolean {
  return label !== undefined
    && localeLabels.configurationOptions.pro.some(candidate => visibleLabelMatches(label, candidate));
}

function isStandaloneChatModeLabel(label: string | undefined): label is string {
  return label !== undefined && Object.values(localeLabels.modeOptions).flat()
    .some(candidate => normalizeForLabelMatch(candidate) === normalizeForLabelMatch(label));
}

function menuItemMatchesConfigurationAxis(
  item: MenuItem,
  axis: "advanced"
): boolean {
  return localeLabels.configurationAxes[axis].some(label =>
    visibleLabelMatches(item.label, label)
    || (item.ariaLabel !== undefined && visibleLabelMatches(item.ariaLabel, label)));
}

function inferExperienceFromConfigurationPanel(
  panel: ConfigurationPanelSnapshot,
  items: MenuItem[]
): ChatGPTExperience {
  if (compactChatMenuLooksRecognized(panel)) {
    return "chat";
  }
  if (compactChatRootLooksRecognized(panel, items)) {
    return "chat";
  }
  if (isProConfigurationOpener(panel.openerLabel)
    && chatModelMenuOptions(items).length >= 2
    && selectedChatModelMenuOption(items) !== undefined) {
    return "chat";
  }
  if (chatMenuLooksSimplified(items)) {
    return "chat";
  }
  const axes = new Set(panel.axisRows.map(row => row.axis));
  if (axes.has("speed") || items.some(item =>
    localeLabels.configurationAxes.advanced.some(label => visibleLabelMatches(item.label, label)))) {
    return "work";
  }
  return "unknown";
}

async function findWorkAxisRow(page: PageLike, axis: ConfigurationAxis): Promise<LocatorLike | undefined> {
  const labels = axis === "modelVersion" ? [] : localeLabels.configurationAxes[axis as keyof typeof localeLabels.configurationAxes] ?? [];
  for (const label of labels) {
    const pattern = new RegExp(`^${escapeRegExp(label)}(?:\\s|$)`, "i");
    for (const role of ["button", "menuitem"]) {
      const locator = page.getByRole?.(role, { name: pattern });
      if (locator?.count !== undefined && await locator.count().catch(() => 0) === 1) {
        return locator;
      }
    }
  }
  return undefined;
}

async function clickVisibleMenuItem(page: PageLike, item: MenuItem): Promise<boolean> {
  if (item.testId !== undefined && await clickIfUnique(page.locator?.(`[data-testid="${escapeAttributeValue(item.testId)}"]`))) {
    return true;
  }
  const roles = [...new Set([
    item.role,
    "menuitemradio",
    "menuitem",
    "option"
  ].filter((role): role is string => role !== undefined))];
  // Current Chat can expose visible text such as "Advanced" while assigning
  // the actionable menu item a different accessible name (for example,
  // "Show compact options"). Prefer that enumerated accessible name so the
  // bridge clicks the menu item itself rather than a nested text span.
  if (item.ariaLabel !== undefined) {
    for (const role of roles) {
      if (await clickIfUnique(page.getByRole?.(role, { name: item.ariaLabel, exact: true }))) {
        return true;
      }
    }
  }
  for (const role of roles) {
    if (await clickIfUnique(page.getByRole?.(role, { name: item.label, exact: true }))) {
      return true;
    }
  }
  const exactText = new RegExp(`^\\s*${escapeRegExp(item.label)}\\s*$`, "i");
  return clickIfUnique(page.locator?.(
    "button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='option']"
  )?.filter?.({ hasText: exactText }));
}

function findConfigurationOption(items: MenuItem[], requested: string): MenuItem | undefined {
  const normalizedRequested = normalizeConfigurationId(requested);
  const exact = items.filter(item => normalizeConfigurationId(item.label) === normalizedRequested);
  if (exact.length === 1) return exact[0];

  const semanticLabels = configurationSemanticLabels(requested);
  for (const wanted of semanticLabels) {
    const matches = items.filter(item =>
      normalizeForLabelMatch(item.label) === normalizeForLabelMatch(wanted)
      || visibleLabelMatches(item.label, wanted)
    );
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

function configurationSemanticLabels(requested: string): string[] {
  const normalized = normalizeConfigurationId(requested);
  for (const labels of Object.values(localeLabels.configurationOptions)) {
    if (labels.some(label => normalizeConfigurationId(label) === normalized)) {
      return labels;
    }
  }
  for (const labels of Object.values(localeLabels.modeOptions)) {
    if (labels.some(label => normalizeConfigurationId(label) === normalized)) {
      return labels;
    }
  }
  return [requested];
}

export function configurationMatchesSelection(
  inspection: ConfigurationInspectionData,
  desired: ConfigurationSelection
): boolean {
  return selectionEntries(desired).every(([axis, requested]) => {
    const active = activeConfigurationValue(inspection, axis);
    return active !== undefined && configurationValueMatches(active, requested);
  });
}

function activeConfigurationValue(
  inspection: ConfigurationInspectionData,
  axis: ConfigurationAxis
): string | undefined {
  const direct = inspection.active[axis];
  if (direct !== undefined || inspection.experience !== "chat") {
    return direct;
  }

  // Only legacy reasoning pickers may alias model to intelligence or effort.
  if (axis === "model" && inspection.availableAxes.includes("model")) return undefined;
  if (axis === "model" || axis === "intelligence") {
    return inspection.active.intelligence ?? inspection.active.effort;
  }
  if (axis === "effort") {
    return inspection.active.effort ?? inspection.active.intelligence;
  }
  return undefined;
}

function configurationValueMatches(actual: string, requested: string): boolean {
  const normalizedActual = normalizeConfigurationId(actual);
  const normalizedRequested = normalizeConfigurationId(requested);
  if (normalizedActual === normalizedRequested) return true;
  return configurationSemanticLabels(requested)
    .some(label => normalizeConfigurationId(label) === normalizedActual);
}

function selectionEntries(
  selection: ConfigurationSelection,
  order: readonly ConfigurationAxis[] = CONFIGURATION_AXIS_ORDER
): Array<[ConfigurationAxis, string]> {
  const entries: Array<[ConfigurationAxis, string]> = [];
  for (const axis of order) {
    const value = selection[axis];
    if (typeof value === "string" && value.trim().length > 0) {
      entries.push([axis, value.trim()]);
    }
  }
  return entries;
}

function normalizeDesiredSelection(selection: ConfigurationSelection): ConfigurationSelection {
  const normalized: ConfigurationSelection = {};
  for (const axis of ["model", "intelligence", "effort", "speed"] as const) {
    const value = selection[axis]?.trim();
    if (value !== undefined && value.length > 0) normalized[axis] = value;
  }
  const modelVersion = (selection.modelVersion ?? selection.version)?.trim();
  if (modelVersion !== undefined && modelVersion.length > 0) {
    normalized.modelVersion = modelVersion;
  }
  return normalized;
}

function menuItemToOption(item: MenuItem): ConfigurationOption {
  const option: ConfigurationOption = {
    id: normalizeConfigurationId(item.label),
    label: item.label,
    selected: item.checked === true
  };
  if (item.hasPopup !== undefined) option.hasSubmenu = item.hasPopup;
  return option;
}

function selectedPowerLabel(discovery: SuccessfulPowerDiscovery): string | undefined {
  const selected = discovery.options.filter(option => option.value === discovery.range.current);
  if (selected.length === 1) return selected[0]!.label;
  if (discovery.valueText === undefined) return undefined;
  const aliases = Object.values(localeLabels.configurationOptions)
    .flat()
    .filter(label => visibleLabelMatches(discovery.valueText!, label));
  return aliases.length === 1 ? aliases[0] : discovery.valueText;
}

function dedupeOptions(options: ConfigurationOption[]): ConfigurationOption[] {
  const seen = new Set<string>();
  return options.filter(option => {
    const key = `${option.id}\u0000${option.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chatMenuLooksSimplified(items: MenuItem[]): boolean {
  const normalized = items.map(item => normalizeConfigurationId(item.label));
  const simplified = ["instant", "medium", "high", "extra high", "pro"];
  return simplified.filter(label => normalized.includes(label)).length >= 3;
}

function isConfigurationAxisRow(label: string): boolean {
  const normalized = normalizeForLabelMatch(label);
  return Object.values(localeLabels.configurationAxes)
    .flat()
    .some(axis => {
      const prefix = normalizeForLabelMatch(axis);
      return normalized === prefix || normalized.startsWith(`${prefix} `);
    });
}

function normalizeConfigurationId(value: string): string {
  return normalizeForLabelMatch(value)
    .replace(/^gpt[\s-]*/i, "gpt ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function closeConfigurationMenus(page: PageLike): Promise<void> {
  if (!await pressMenuEscape(page)) return;
  await page.waitForTimeout?.(50);
  if (await pressMenuEscape(page)) {
    // The carousel root uses a short pointer-grace dismissal. Reopening before
    // it settles can detach the fresh model view during the next selection.
    await page.waitForTimeout?.(200);
  }
}

async function closeConfigurationSubmenu(page: PageLike): Promise<void> {
  if (!await pressMenuEscape(page)) return;
  // Radix retains a short pointer-grace timer after a submenu closes. If the
  // next axis is hovered too quickly, that stale timer can dismiss the newly
  // opened submenu. Let the prior close settle before moving to another row.
  await page.waitForTimeout?.(200);
}

async function clickIfUnique(locator: LocatorLike | undefined): Promise<boolean> {
  if (locator?.count === undefined || locator.click === undefined) return false;
  const count = await locator.count().catch(() => 0);
  if (count === 1) {
    await locator.click();
    return true;
  }
  if (count <= 1 || locator.nth === undefined) return false;

  const visible: LocatorLike[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (candidate.isVisible !== undefined && await candidate.isVisible().catch(() => false)) {
      visible.push(candidate);
    }
  }
  if (visible.length !== 1 || visible[0]?.click === undefined) return false;
  await visible[0].click();
  return true;
}

async function configurationFailure(
  page: PageLike,
  before: ConfigurationInspectionData,
  desired: ConfigurationSelection,
  selected: AppliedConfigurationSelection[],
  message: string,
  code: string,
  candidates: string[] = []
): Promise<CommandResult<ApplyConfigurationData>> {
  const data: ApplyConfigurationData = {
    requested: desired,
    selected,
    before,
    after: before,
    verified: false
  };
  return {
    ok: false,
    status: "unsupported",
    data,
    warnings: [],
    blocker: {
      kind: "selector_drift",
      code,
      fieldPath: "desired",
      message,
      candidates: candidates.map(label => ({ label })),
      resumable: true
    },
    context: await contextFromPage(page, {
      experience: before.experience,
      selectorProfile: before.selectorProfile
    })
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function forwardFailure<T>(result: CommandResult<unknown>): CommandResult<T> {
  const forwarded: CommandResult<T> = {
    ok: false,
    status: result.status,
    warnings: result.warnings,
    context: result.context
  };
  if (result.output_text !== undefined) forwarded.output_text = result.output_text;
  if (result.reportPath !== undefined) forwarded.reportPath = result.reportPath;
  if (result.error !== undefined) forwarded.error = result.error;
  if (result.blocker !== undefined) forwarded.blocker = result.blocker;
  if (result.steps !== undefined) forwarded.steps = result.steps;
  return forwarded;
}
