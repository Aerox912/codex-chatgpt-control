import { describe, expect, it } from "vitest";
import { applyConfiguration, configurationInspectionFromSurface, configurationMatchesSelection, inspectConfiguration } from "../../src/commands/configuration.js";
import { chatModelMenuOptions, findChatModelMenuOption, selectedChatModelMenuOption } from "../../src/dom/chat-configuration-menu.js";
import type { MenuItem } from "../../src/dom/menus.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

const desired = { model: "Latest", intelligence: "Pro" };

describe("Project Chat model and Power configuration", () => {
  for (const view of ["closed", "root", "model"] as const) {
    it(`reads independent selected values starting from the ${view} view`, async () => {
      const page = picker({ view });
      const result = await inspectConfiguration({ page }, { experience: "chat", includeOptions: true, timeoutMs: 0 });
      expect(result.data).toMatchObject({
        selectorProfile: "project_chat_v1", active: { model: "Latest", effort: "Pro" }, verified: true,
        options: { model: [
          { label: "Latest", selected: true },
          { label: "GPT-5.6 Sol", selected: false },
          { label: "GPT-5.5", selected: false }
        ] }
      });
      expect(page.mutations).toEqual([]);
      expect(result.data?.evidence).toEqual(expect.arrayContaining([
        { source: "control", label: "Selected model radio: Latest" },
        { source: "control", label: "Selected Power slider: Pro" }
      ]));
      expect(page.view()).toBe("closed");
    });

    it(`applies Latest + Pro without a setting change from the ${view} view`, async () => {
      const page = picker({ view });
      const result = await applyConfiguration({ page }, { experience: "chat", desired, strict: true, timeoutMs: 0 });
      expect(result.ok).toBe(true);
      expect(result.data?.verified).toBe(true);
      expect(result.data?.selected).toEqual([
        { axis: "intelligence", requested: "Pro", selected: "Pro" },
        { axis: "model", requested: "Latest", selected: "Latest" }
      ]);
      expect(page.mutations).toEqual([]);
    });
  }

  it("reads a different selected model despite the same composite numeral", async () => {
    const page = picker({ selected: ["GPT-5.6 Sol"] });
    const result = await inspectConfiguration({ page }, { experience: "chat", timeoutMs: 0 });
    expect(result.data?.active).toEqual({ model: "GPT-5.6 Sol", effort: "Pro" });
    expect(configurationMatchesSelection(result.data!, desired)).toBe(false);
  });

  it("reads both axes when the browser exposes Escape only on menu locators", async () => {
    const page = picker({ view: "model", locatorKeyboardOnly: true });
    const result = await applyConfiguration({ page }, { experience: "chat", desired, strict: true, timeoutMs: 0 });
    expect(result.ok).toBe(true);
    expect(result.data?.after.active).toEqual({ model: "Latest", effort: "Pro" });
    expect(page.view()).toBe("closed");
    expect(page.mutations).toEqual([]);
  });

  it("changes the requested model and verifies both axes afterwards", async () => {
    const page = picker({ selected: ["GPT-5.6 Sol"] });
    const result = await applyConfiguration({ page }, { experience: "chat", desired, strict: true, timeoutMs: 0 });
    expect(result.ok).toBe(true);
    expect(result.data?.after.active).toEqual({ model: "Latest", effort: "Pro" });
    expect(page.mutations).toEqual(["model:Latest"]);
  });

  it("rejects a model change that also changes Power", async () => {
    const page = picker({ selected: ["GPT-5.6 Sol"], changePowerWithModel: true });
    const result = await applyConfiguration({ page }, { experience: "chat", desired, strict: true, timeoutMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.blocker?.code).toBe("configuration_postcondition_unverified");
    expect(result.data?.after.active).toEqual({ model: "Latest", effort: "Medium" });
  });

  for (const selected of [[], ["Latest", "GPT-5.6 Sol"]]) {
    it(`does not verify ${selected.length === 0 ? "unreadable" : "ambiguous"} selected model evidence`, async () => {
      const page = picker({ selected });
      const result = await inspectConfiguration({ page }, { experience: "chat", timeoutMs: 0 });
      expect(result.data?.verified).toBe(false);
      expect(result.data?.active.model).toBeUndefined();
      expect(configurationMatchesSelection(result.data!, desired)).toBe(false);
      expect(configurationMatchesSelection(result.data!, { model: "Pro" })).toBe(false);
    });
  }

  it("does not verify a missing model view", async () => {
    const page = picker({ modelLabels: [] });
    const result = await applyConfiguration({ page }, { experience: "chat", desired, strict: true, timeoutMs: 0 });
    expect(result.ok).toBe(false);
    expect(result.data?.before.verified).toBe(false);
    expect(result.data?.verified).toBe(false);
    expect(page.mutations).toEqual([]);
  });

  it("does not replace unreadable Power with the composite trigger", async () => {
    const page = picker({ unreadablePower: true });
    const result = await inspectConfiguration({ page }, { experience: "chat", timeoutMs: 0 });
    expect(result.data?.active).toEqual({ model: "Latest" });
    expect(result.data?.verified).toBe(false);
    expect(configurationMatchesSelection(result.data!, desired)).toBe(false);
  });

  it("does not interpret an unopened composite trigger as either axis", () => {
    const result = configurationInspectionFromSurface("chat", "project_chat_v1", [],
      { openerLabel: "6 Pro", axisRows: [], advancedVisible: false }, []);
    expect(result.active).toEqual({});
    expect(result.verified).toBe(false);
  });

  it("recognizes Latest only as an actual model radio and rejects duplicate candidates", () => {
    const item: MenuItem = { label: "Latest", normalized: "latest", role: "menuitemradio", checked: true };
    expect(chatModelMenuOptions([item])).toEqual([item]);
    expect(findChatModelMenuOption([item], "6")).toBeUndefined();
    expect(chatModelMenuOptions([{ ...item, role: "menuitem" }])).toEqual([]);
    expect(findChatModelMenuOption([item, item], "Latest")).toBeUndefined();
    expect(selectedChatModelMenuOption([item, item])).toBeUndefined();
  });
});

type PickerOptions = {
  view?: "closed" | "root" | "model";
  selected?: string[];
  modelLabels?: string[];
  unreadablePower?: boolean;
  changePowerWithModel?: boolean;
  locatorKeyboardOnly?: boolean;
};

// A stateful browser boundary: production inspection, application, menu
// classification and Power classification run unchanged against these views.
function picker(options: PickerOptions = {}): PageLike & { mutations: string[]; view: () => string } {
  let view = options.view ?? "closed";
  let selected = options.selected ?? ["Latest"];
  let effort = "Pro";
  const models = options.modelLabels ?? ["Latest", "GPT-5.6 Sol", "GPT-5.5"];
  const powers = ["Instant", "Medium", "High", "Extra High", "Pro"];
  const mutations: string[] = [];
  const label = () => view === "closed" ? `6 ${effort}` : "Thinking effort";
  const missing: LocatorLike = { count: async () => 0 };
  const control = (exists: () => boolean, click: () => void): LocatorLike => ({
    count: async () => exists() ? 1 : 0,
    click: async () => { click(); },
    evaluate: async <T>() => true as T
  });
  const opener = control(() => true, () => { view = view === "closed" ? "root" : "closed"; });
  const selectModel = control(() => view === "root", () => { view = "model"; });
  const escape = async (key: string) => {
    if (key === "Escape") view = view === "model" ? "root" : "closed";
  };
  return {
    mutations,
    view: () => view,
    url: () => "https://chatgpt.com/g/g-p-sanitized-project/project",
    title: async () => "ChatGPT",
    getByRole: (role, args = {}) => {
      if (role === "menu") return { count: async () => view === "closed" ? 0 : 1, press: escape };
      if (role === "button" && args.name === label()) return opener;
      if (role === "menuitem" && args.name === "Select model") return selectModel;
      if (role === "menuitemradio" && typeof args.name === "string" && models.includes(args.name)) {
        const name = args.name;
        return control(() => view === "model", () => {
          selected = [name];
          mutations.push(`model:${name}`);
          if (options.changePowerWithModel) effort = "Medium";
        });
      }
      return missing;
    },
    ...(options.locatorKeyboardOnly ? {} : { keyboard: { press: escape } }),
    evaluate: async <T, A = unknown>(fn: (arg: A) => T | Promise<T>): Promise<T> => {
      const source = String(fn);
      if (source.includes("composerRoots") && source.includes("mainControls")) {
        return { composerLabels: ["New chat in Example"], mainControls: [label()], mainText: "", selectedSurfaceLabels: ["Chat"] } as T;
      }
      if (source.includes("normalizedAxes") && source.includes("axisRows")) {
        return { openerLabel: label(), axisRows: [], advancedVisible: false } as T;
      }
      if (source.includes("normalizedModeLabels")) return [label()] as T;
      if (source.includes("allRoleNodes") && source.includes("scopedRoleNodes")) {
        const items = view === "closed" ? [] : view === "root" ? [
          { label: `6 ${effort}`, ariaLabel: "Select model", role: "menuitem" },
          { label: "Power", ariaLabel: "Power", role: "menuitem" }
        ] : models.map(label => ({ label, role: "menuitemradio", checked: selected.includes(label) }));
        return { items, labels: [], split: false } as T;
      }
      if (source.includes("sliderElements") && source.includes("maxTextChars")) {
        return { sliders: view !== "root" || options.unreadablePower ? [] : [{
          index: 0, visible: true, minimum: "0", maximum: "4", current: String(powers.indexOf(effort)),
          valueText: effort, owner: { role: "menuitem", label: "Power", visible: true },
          menu: { role: "menu", visible: true }, surface: { experience: "chat" }
        }] } as T;
      }
      throw new Error(`Unexpected browser observation: ${source.slice(0, 100)}`);
    },
    waitForTimeout: async () => {}
  };
}
