import { describe, expect, it } from "vitest";
import {
  captureOne,
  generationStopLabels,
  snapshotLooksActive,
  stopGenerationIfVisible
} from "../../src/scripts/capture-intelligence-locales.js";
import type { LocatorLike, PageLike } from "../../src/types.js";

describe("generation-state locale capture safety", () => {
  it("does not retain or click an unchanged unrelated Cancel control", async () => {
    const snapshot = {
      controls: [{ label: "Cancel", text: "Cancel" }],
      shortLatestAssistantTexts: []
    };
    let clicks = 0;
    const candidate: LocatorLike = {
      count: async () => 1,
      last: () => candidate,
      isVisible: async () => true,
      evaluate: async <T>() => true as T,
      click: async () => { clicks += 1; }
    };
    const page: PageLike = {
      getByRole: () => candidate
    };

    const labels = generationStopLabels(snapshot, snapshot);
    const stopped = await stopGenerationIfVisible(page, labels);

    expect(snapshotLooksActive(snapshot)).toBe(false);
    expect(labels).toEqual([]);
    expect(stopped).toBe(false);
    expect(clicks).toBe(0);
  });

  it("retains an unchanged composer-scoped control only with a stable Stop test id", () => {
    const snapshot = {
      controls: [{ label: "Localized control", testId: "composer-stop-button" }],
      shortLatestAssistantTexts: []
    };

    expect(generationStopLabels(snapshot, snapshot)).toEqual(["Localized control"]);
  });

  it("propagates a locale-capture Stop click failure", async () => {
    const candidate: LocatorLike = {
      count: async () => 1,
      isVisible: async () => true,
      evaluate: async <T>() => true as T,
      click: async () => { throw new Error("bridge click failed"); }
    };

    await expect(stopGenerationIfVisible({ getByRole: () => candidate }, ["Stop localized"]))
      .rejects.toThrow("bridge click failed");
  });

  it("returns success only after the locale-capture Stop control disappears", async () => {
    let visible = true;
    const candidate: LocatorLike = {
      count: async () => visible ? 1 : 0,
      isVisible: async () => visible,
      evaluate: async <T>() => true as T,
      click: async () => { visible = false; }
    };

    await expect(stopGenerationIfVisible({ getByRole: () => candidate }, ["Stop localized"]))
      .resolves.toBe(true);
  });

  it("fails closed when post-click Stop inspection is unavailable", async () => {
    let countCalls = 0;
    const candidate: LocatorLike = {
      count: async () => {
        countCalls += 1;
        if (countCalls > 1) throw new Error("bridge inspection failed");
        return 1;
      },
      isVisible: async () => true,
      evaluate: async <T>() => true as T,
      click: async () => undefined
    };

    await expect(stopGenerationIfVisible({ getByRole: () => candidate }, ["Stop localized"]))
      .rejects.toThrow("bridge inspection failed");
  });

  it("records a blocked locale capture when generation cleanup is unverified", async () => {
    const empty: LocatorLike = {
      count: async () => 0,
      click: async () => undefined,
      nth: () => empty,
      last: () => empty
    };
    const page: PageLike = {
      locator: () => empty,
      keyboard: { press: async () => undefined },
      evaluate: async <T>(_fn: (arg: never) => T | Promise<T>): Promise<T> => {
        if (String(_fn).includes("document.querySelector(\"[role='dialog']\")")) {
          return false as T;
        }
        return { htmlLang: "nl", url: "https://chatgpt.com/" } as T;
      }
    };
    const record = await captureOne(page, {
      language: "Dutch",
      nativeName: "Nederlands",
      bcp47: "nl",
      speakers: "",
      status: ""
    }, {
      locale: "nl",
      nativeName: "Nederlands",
      out: "/tmp/not-written.jsonl",
      printQueue: false,
      autoSwitch: false,
      all: false,
      limit: undefined,
      locales: undefined,
      openVersionSubmenu: true,
      captureGenerationState: true,
      captureSurfaces: false,
      generationPrompt: "probe",
      generationCaptureTimeoutMs: 10,
      restore: false,
      settleMs: 0,
      switchTimeoutMs: 10,
      coveragePath: "/tmp/not-read.md",
      ifMissing: "block",
      tabId: undefined
    }, [], {
      captureIntelligencePicker: async () => ({
        htmlLang: "nl",
        url: "https://chatgpt.com/",
        intelligenceLabels: ["Licht"],
        selectedIntelligenceLabel: "Licht",
        versionFamilyLabels: [],
        modelVersionLabels: ["GPT-5.6"],
        configuration: {
          openerLabel: "GPT-5.6",
          power: { axisLabel: "Power", valueLabel: "Licht", minimum: 0, maximum: 2, value: 0, position: 1, count: 3 },
          advanced: { label: "Advanced", expanded: false },
          rows: [
            { axis: "model", label: "Model GPT-5.6", axisLabel: "Model", options: [{ label: "GPT-5.6", checked: true }] },
            { axis: "effort", label: "Effort Licht", axisLabel: "Effort", options: [{ label: "Licht", checked: true }] }
          ]
        }
      }),
      captureGenerationStateLabels: async () => {
        throw new Error("Generation probe cleanup could not be verified: bridge inspection failed");
      }
    });

    expect(record).toMatchObject({
      status: "blocked",
      blocker: {
        code: "capture_failed",
        message: "Generation probe cleanup could not be verified: bridge inspection failed"
      }
    });
    expect(record).not.toHaveProperty("generationStopLabels");
  });
});
