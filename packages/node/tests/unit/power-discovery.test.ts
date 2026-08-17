import { describe, expect, it } from "vitest";
import {
  classifyPowerSliderObservation,
  discoverPowerSlider,
  MAX_POWER_DOM_NODES,
  resolvePowerTarget,
  type PowerDomObservation,
  type PowerSliderDomObservation
} from "../../src/commands/power-discovery.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

type SyntheticNode = SyntheticDocument | SyntheticElement | SyntheticText;

class SyntheticElement {
  readonly nodeType = 1;
  readonly nodeValue = null;
  parentNode: SyntheticNode | null = null;
  firstChild: SyntheticNode | null = null;
  lastChild: SyntheticNode | null = null;
  nextSibling: SyntheticNode | null = null;
  ownerDocument: SyntheticDocument;
  readonly tagName: string;
  hidden = false;
  private readonly attributes: Record<string, string>;

  constructor(ownerDocument: SyntheticDocument, tagName: string, attributes: Record<string, string> = {}) {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.attributes = attributes;
  }

  append(child: SyntheticNode): void {
    child.parentNode = this;
    if (this.lastChild === null) {
      this.firstChild = child;
      this.lastChild = child;
      return;
    }
    this.lastChild.nextSibling = child;
    this.lastChild = child;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 20 };
  }
}

class SyntheticText {
  readonly nodeType = 3;
  readonly nodeValue: string;
  parentNode: SyntheticNode | null = null;
  readonly firstChild = null;
  readonly lastChild = null;
  nextSibling: SyntheticNode | null = null;
  ownerDocument: SyntheticDocument;

  constructor(ownerDocument: SyntheticDocument, value: string) {
    this.ownerDocument = ownerDocument;
    this.nodeValue = value;
  }
}

class SyntheticDocument {
  readonly nodeType = 9;
  readonly nodeValue = null;
  readonly ownerDocument = null;
  parentNode: SyntheticNode | null = null;
  nextSibling: SyntheticNode | null = null;
  firstChild: SyntheticNode | null = null;
  lastChild: SyntheticNode | null = null;
  walkedNodes = 0;

  append(child: SyntheticNode): void {
    child.parentNode = this;
    if (this.lastChild === null) {
      this.firstChild = child;
      this.lastChild = child;
      return;
    }
    this.lastChild.nextSibling = child;
    this.lastChild = child;
  }

  createTreeWalker(root: SyntheticDocument | SyntheticElement): { nextNode: () => SyntheticNode | null } {
    let nextNode: SyntheticNode | null = root.firstChild;
    return {
      nextNode: () => {
        if (nextNode === null || nextNode === root) return null;
        const result = nextNode;
        this.walkedNodes += 1;
        let cursor: SyntheticNode | null = result;
        if (cursor.firstChild !== null) {
          nextNode = cursor.firstChild;
        } else {
          while (cursor !== null && cursor !== root && cursor.nextSibling === null) {
            cursor = cursor.parentNode;
          }
          if (cursor === null || cursor === root) nextNode = null;
          else nextNode = cursor.nextSibling ?? null;
        }
        return result;
      }
    };
  }
}

function syntheticPowerDom(optionCount = 5): SyntheticDocument {
  const document = new SyntheticDocument();
  const surface = new SyntheticElement(document, "main", { "data-surface": "chat" });
  const menu = new SyntheticElement(document, "div", { role: "menu", "aria-label": "Model settings" });
  const owner = new SyntheticElement(document, "div", { role: "menuitem", "aria-label": "Power" });
  const slider = new SyntheticElement(document, "div", {
    role: "slider",
    "aria-label": "Power",
    "aria-valuemin": "0",
    "aria-valuemax": String(optionCount - 1),
    "aria-valuenow": "2",
    "aria-valuetext": "High"
  });
  document.append(surface);
  surface.append(menu);
  menu.append(owner);
  owner.append(slider);
  for (let index = 0; index < optionCount; index += 1) {
    const option = new SyntheticElement(document, "div", {
      role: "option",
      "data-value": String(index)
    });
    owner.append(option);
    option.append(new SyntheticText(document, ["Instant", "Medium", "High", "Extra High", "Pro"][index] ?? `Level ${index}`));
  }
  return document;
}

function discoverSynthetic(document: SyntheticDocument, onEvaluate?: (source: string) => void): Promise<Awaited<ReturnType<typeof discoverPowerSlider>>> {
  const previousDocument = (globalThis as { document?: unknown }).document;
  const previousWindow = (globalThis as { window?: unknown }).window;
  const page: PageLike = {
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> => {
      onEvaluate?.(String(fn));
      Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: document });
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        writable: true,
        value: { getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }) }
      });
      try {
        return await fn(arg as A);
      } finally {
        if (previousDocument === undefined) delete (globalThis as { document?: unknown }).document;
        else Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: previousDocument });
        if (previousWindow === undefined) delete (globalThis as { window?: unknown }).window;
        else Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previousWindow });
      }
    }
  };
  return discoverPowerSlider(page, { powerLabels: ["Power"] });
}

function powerSlider(overrides: Partial<PowerSliderDomObservation> = {}): PowerSliderDomObservation {
  return {
    index: 0,
    visible: true,
    ariaLabel: "Power",
    minimum: "0",
    maximum: "4",
    current: "2",
    owner: { role: "menuitem", label: "Power", text: "Power", visible: true },
    menu: { role: "menu", label: "Model settings", text: "Model settings", visible: true },
    optionSource: "owner",
    options: [
      { label: "Instant", value: "0", visible: true },
      { label: "Medium", value: "1", visible: true },
      { label: "High", value: "2", visible: true },
      { label: "Extra High", value: "3", visible: true },
      { label: "Pro", value: "4", visible: true }
    ],
    ...overrides
  };
}

function observation(sliders: PowerSliderDomObservation[]): PowerDomObservation {
  return { sliders };
}

function classify(sliders: PowerDomObservation, options: Parameters<typeof classifyPowerSliderObservation>[1] = {}) {
  return classifyPowerSliderObservation(sliders, { powerLabels: ["Power"], ...options });
}

describe("dynamic Power slider discovery", () => {
  it("matches a reordered menu by the semantic owner and resolves the explicit value", () => {
    const slider = powerSlider({
      options: [
        { label: "Pro", value: "4", visible: true },
        { label: "High", value: "2", visible: true },
        { label: "Instant", value: "0", visible: true },
        { label: "Medium", value: "1", visible: true },
        { label: "Extra High", value: "3", visible: true }
      ]
    });
    const result = classify(observation([slider]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ minimum: 0, maximum: 4, current: 2, count: 5 });
    expect(resolvePowerTarget(result, ["Pro"])).toBe(4);
  });

  it("accepts a changed six-level range when the complete ordered semantic map is exposed", () => {
    const result = classify(observation([powerSlider({
      minimum: "2",
      maximum: "7",
      current: "4",
      options: [
        { label: "Licht", visible: true },
        { label: "Mittel", visible: true },
        { label: "Hoch", visible: true },
        { label: "Sehr hoch", visible: true },
        { label: "Pro", visible: true },
        { label: "Max", visible: true }
      ]
    })]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range).toEqual({ minimum: 2, maximum: 7, current: 4, count: 6 });
    expect(result.options.map(option => option.value)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(resolvePowerTarget(result, ["Max"])).toBe(7);
  });

  it("uses a localized Power axis relationship without inferring an English label", () => {
    const result = classify(observation([powerSlider({
      ariaLabel: "Potencia",
      owner: { role: "menuitem", label: "Potencia", text: "Potencia Alto", visible: true },
      options: [
        { label: "Bajo", value: "0", visible: true },
        { label: "Alto", value: "1", visible: true },
        { label: "Máximo", value: "2", visible: true },
        { label: "Pro", value: "3", visible: true },
        { label: "Ultra", value: "4", visible: true }
      ]
    })]), { powerLabels: ["Potencia"] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.matchedPowerLabels).toEqual(["Potencia"]);
    expect(resolvePowerTarget(result, ["Máximo"])).toBe(2);
    expect(resolvePowerTarget(result, ["Power"])).toBeUndefined();
  });

  it("fails closed when no locale pack is supplied instead of guessing English Power", () => {
    const result = classifyPowerSliderObservation(observation([powerSlider()]));
    expect(result).toMatchObject({ ok: false, reason: "no_semantic_power_slider" });
  });

  it("fails closed for two visible sliders with the same Power relationship", () => {
    const result = classify(observation([
      powerSlider({ index: 0 }),
      powerSlider({ index: 1, ariaLabel: "Power", owner: { role: "group", label: "Power", visible: true } })
    ]));

    expect(result).toMatchObject({
      ok: false,
      reason: "ambiguous_power_slider",
      evidence: { visibleSliderCount: 2, semanticSliderCount: 2 }
    });
  });

  it("ignores hidden stale controls when one unique visible Power slider remains", () => {
    const result = classify(observation([
      powerSlider({ index: 0, visible: false }),
      powerSlider({ index: 1, current: "3" })
    ]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sliderIndex).toBe(1);
    expect(result.evidence.range.current).toBe(3);
  });

  it.each([
    { name: "missing minimum", patch: { minimum: undefined } as Record<string, string | undefined> },
    { name: "non-integer maximum", patch: { maximum: "4.5" } as Record<string, string | undefined> },
    { name: "current outside range", patch: { current: "8" } as Record<string, string | undefined> },
    { name: "non-unit step", patch: { step: "2" } as Record<string, string | undefined> }
  ])("rejects $name ARIA range metadata", ({ patch }) => {
    const candidate = powerSlider();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete candidate[key as keyof PowerSliderDomObservation];
      } else {
        (candidate as unknown as Record<string, unknown>)[key] = value;
      }
    }
    const result = classify(observation([candidate]));
    expect(result).toMatchObject({ ok: false, reason: "invalid_aria_range" });
  });

  it("rejects an oversized range before any selection can be planned", () => {
    const result = classify(observation([powerSlider({
      minimum: "0",
      maximum: "32",
      current: "0"
    })]));
    expect(result).toMatchObject({ ok: false, reason: "unsupported_range" });
  });

  it("fails closed when slider or option observation caps were exceeded", () => {
    const tooManySliders = classify(observation(Array.from({ length: 33 }, (_, index) => powerSlider({ index }))));
    const truncatedOptions = classify(observation([powerSlider({ optionsTruncated: true })]));

    expect(tooManySliders).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
    expect(truncatedOptions).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
  });

  it("does not use an option list without provenance from the owned Power relationship", () => {
    const slider = powerSlider();
    delete slider.optionSource;
    const result = classify(observation([slider]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual([]);
    expect(resolvePowerTarget(result, ["Pro"])).toBeUndefined();
  });

  it("keeps the Chat and Work surface profile evidence distinct", () => {
    const work = classify(observation([powerSlider({
      surface: { experience: "work", selectorProfile: "work_advanced_v1" }
    })]), { expectedSurface: "work" });
    const chatExpectation = classify(observation([powerSlider({
      surface: { experience: "work", selectorProfile: "work_advanced_v1" }
    })]), { expectedSurface: "chat" });

    expect(work).toMatchObject({ ok: true, evidence: { surface: "work", selectorProfile: "work_advanced_v1" } });
    expect(chatExpectation).toMatchObject({ ok: false, reason: "surface_mismatch" });
  });

  it("does not treat a current value label as a mapping for an unprobed target", () => {
    const result = classify(observation([powerSlider({
      options: [],
      valueText: "High",
      current: "2"
    })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolvePowerTarget(result, ["High"])).toBe(2);
    expect(resolvePowerTarget(result, ["Pro"])).toBeUndefined();
  });

  it("rejects an explicit target outside the discovered range instead of clamping it", () => {
    const result = classify(observation([powerSlider({
      minimum: "2",
      maximum: "4",
      current: "3",
      options: [
        { label: "Low", value: "2", visible: true },
        { label: "High", value: "3", visible: true },
        { label: "Pro", value: "8", visible: true }
      ]
    })]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.options).toEqual([]);
    expect(resolvePowerTarget(result, ["Pro"])).toBeUndefined();
  });

  it("does not carry a discovered range or mapping between independent calls", () => {
    const first = classify(observation([powerSlider({ maximum: "4", current: "4" })]));
    const second = classify(observation([powerSlider({
      minimum: "10",
      maximum: "12",
      current: "10",
      options: [
        { label: "Low", visible: true },
        { label: "High", visible: true },
        { label: "Pro", visible: true }
      ]
    })]));

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.range).toEqual({ minimum: 0, maximum: 4, current: 4, count: 5 });
    expect(second.range).toEqual({ minimum: 10, maximum: 12, current: 10, count: 3 });
    expect(resolvePowerTarget(second, ["Pro"])).toBe(12);
    expect(resolvePowerTarget(second, ["Extra High"])).toBeUndefined();
  });

  it("performs one read-only DOM inspection and never asks the page to mutate", async () => {
    let evaluations = 0;
    let clicks = 0;
    let presses = 0;
    const locator: LocatorLike = {
      count: async () => 1,
      click: async () => { clicks += 1; },
      press: async () => { presses += 1; }
    };
    const page: PageLike = {
      locator: () => locator,
      evaluate: async <T>(): Promise<T> => {
        evaluations += 1;
        return { sliders: [powerSlider()] } as T;
      }
    };

    const result = await discoverPowerSlider(page, { powerLabels: ["Power"] });

    expect(result.ok).toBe(true);
    expect(evaluations).toBe(1);
    expect(clicks).toBe(0);
    expect(presses).toBe(0);
  });

  it("uses one bounded SHOW_ALL traversal without selector or page-wide text materialization", async () => {
    const document = syntheticPowerDom();
    let callbackSource = "";
    const result = await discoverSynthetic(document, source => { callbackSource = source; });

    expect(result.ok).toBe(true);
    expect(callbackSource).not.toMatch(/querySelectorAll|innerText|textContent|Array\.from/);
    expect(document.walkedNodes).toBeGreaterThan(0);
    expect(document.walkedNodes).toBeLessThanOrEqual(MAX_POWER_DOM_NODES);
  });

  it("fails closed at the global node cap before scanning the rest of a noisy page", async () => {
    const document = syntheticPowerDom();
    for (let index = 0; index < MAX_POWER_DOM_NODES; index += 1) {
      document.append(new SyntheticText(document, "noise"));
    }

    const result = await discoverSynthetic(document);

    expect(result).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
    // The sentinel node is inspected to prove overflow, but no following
    // sibling is traversed or retained.
    expect(document.walkedNodes).toBeLessThanOrEqual(MAX_POWER_DOM_NODES + 1);
  });

  it("fails closed when the semantic option map exceeds its bounded cap", async () => {
    const result = await discoverSynthetic(syntheticPowerDom(33));

    expect(result).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
  });

  it("fails closed when bounded text extraction reaches its character budget", async () => {
    const document = syntheticPowerDom();
    document.append(new SyntheticText(document, "x".repeat(32 * 1024 + 1)));

    const result = await discoverSynthetic(document);

    expect(result).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
  });

  it("collects no more than the maximum number of sliders", async () => {
    const document = new SyntheticDocument();
    const root = new SyntheticElement(document, "main");
    document.append(root);
    for (let index = 0; index < 33; index += 1) {
      root.append(new SyntheticElement(document, "div", { role: "slider" }));
    }

    const result = await discoverSynthetic(document);

    expect(result).toMatchObject({ ok: false, reason: "observation_limit_exceeded" });
    expect(document.walkedNodes).toBeLessThanOrEqual(34);
  });
});
