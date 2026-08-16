import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChatGPT } from "../../src/client.js";
import {
  buildProjectSourceAddPlan,
  diffProjectSourceNames,
  extractProjectSourcesFromHtml,
  listProjectSources,
  normalizeProjectSourcesUrl,
  safeProjectSourceCandidatesFromHtml
} from "../../src/commands/project-sources.js";
import type { FileChooserLike, LocatorLike, PageLike } from "../../src/types.js";

const PROJECT_URL = "https://chatgpt.com/g/g-p-69f7590a9a188191a7356459c924eaf9-diy-wifi/project";

describe("Project Sources URL normalization", () => {
  it("normalizes project and nested project-chat URLs to the Sources tab target", () => {
    expect(normalizeProjectSourcesUrl(`${PROJECT_URL}?model=gpt-5#foo`)).toEqual({
      projectId: "g-p-69f7590a9a188191a7356459c924eaf9",
      projectSlug: "diy-wifi",
      url: PROJECT_URL
    });

    expect(normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-69f7590a9a188191a7356459c924eaf9-diy-wifi/c/abc-123")).toEqual({
      projectId: "g-p-69f7590a9a188191a7356459c924eaf9",
      projectSlug: "diy-wifi",
      url: PROJECT_URL
    });

    expect(normalizeProjectSourcesUrl("https://chatgpt.com/g/g-p-example/project").url).toBe("https://chatgpt.com/g/g-p-example/project");
  });

  it("rejects non-Project and non-ChatGPT URLs", () => {
    expect(() => normalizeProjectSourcesUrl("https://chatgpt.com/c/abc-123")).toThrow(/Project URL/);
    expect(() => normalizeProjectSourcesUrl("https://example.com/g/g-p-example/project")).toThrow(/chatgpt.com/);
    expect(() => normalizeProjectSourcesUrl("http://chatgpt.com/g/g-p-example/project")).toThrow(/https/);
  });
});

describe("Project Sources add planning", () => {
  it("batches explicit local files while preserving display path, name, and byte metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-plan-"));
    const first = join(dir, "brief.md");
    const second = join(dir, "data.csv");
    const third = join(dir, "notes.txt");
    await writeFile(first, "hello");
    await writeFile(second, "a,b\n1,2");
    await writeFile(third, "note");

    const result = await buildProjectSourceAddPlan({}, {
      projectUrl: PROJECT_URL,
      files: [first, second, third],
      batchSize: 2
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      projectUrl: PROJECT_URL,
      totalBytes: 16,
      files: [
        { path: first, displayPath: first, name: "brief.md", bytes: 5 },
        { path: second, displayPath: second, name: "data.csv", bytes: 7 },
        { path: third, displayPath: third, name: "notes.txt", bytes: 4 }
      ],
      batches: [
        { index: 0, files: [{ name: "brief.md" }, { name: "data.csv" }] },
        { index: 1, files: [{ name: "notes.txt" }] }
      ]
    });
  });

  it("diffs duplicate source names by count", () => {
    const added = diffProjectSourceNames(
      [
        { name: "brief.md", status: "ready" },
        { name: "brief.md", status: "ready" },
        { name: "existing.pdf", status: "ready" }
      ],
      [
        { name: "brief.md", status: "ready" },
        { name: "brief.md", status: "ready" },
        { name: "brief.md", status: "processing" },
        { name: "existing.pdf", status: "ready" },
        { name: "notes.txt", status: "ready" }
      ]
    );

    expect(added.map(source => source.name)).toEqual(["brief.md", "notes.txt"]);
  });
});

describe("Project Sources browser commands", () => {
  it("plans add without touching browser mutation or upload primitives", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-dry-run-"));
    const file = join(dir, "brief.md");
    await writeFile(file, "hello");
    const page = mutationFailingPage();
    const chatgpt = createChatGPT({ page });

    const result = await chatgpt.projects.sources.planAdd({
      projectUrl: PROJECT_URL,
      files: [file]
    });

    expect(result.ok).toBe(true);
    expect(page.mutationCalls).toEqual([]);
  });

  it("requires explicit confirmation before mutating Project Sources", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-confirm-"));
    const file = join(dir, "brief.md");
    await writeFile(file, "hello");
    const chatgpt = createChatGPT({ page: mutationFailingPage() });

    const result = await chatgpt.projects.sources.add({
      projectUrl: PROJECT_URL,
      files: [file]
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("needs_confirmation");
    expect(result.blocker).toMatchObject({
      kind: "confirmation",
      code: "project_sources_add_confirmation_required"
    });
    expect(JSON.stringify(result)).not.toContain("hello");
  });

  it("uploads through the Add sources menu Upload option after confirmation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-upload-"));
    const file = join(dir, "smoke.txt");
    await writeFile(file, "hello");
    const page = projectSourcesUploadPage("smoke.txt");
    const chatgpt = createChatGPT({ page });

    const result = await chatgpt.projects.sources.add({
      projectUrl: PROJECT_URL,
      files: [file],
      confirmMutation: true,
      batchSize: 1
    });

    expect(result.ok).toBe(true);
    expect(page.clicks).toEqual(["Sources", "Add sources", "Upload"]);
    expect(page.uploadedPaths).toEqual([file]);
    expect(page.chooserWaiters).toBe(1);
    expect(page.setFilesCalls).toBe(1);
    expect(result.data?.dryRun).toBe(false);
    if (result.data === undefined || result.data.dryRun !== false) {
      throw new Error("Expected confirmed Project Sources add data.");
    }
    expect(result.data.before).toEqual([]);
    expect(result.data.after).toEqual([{ name: "smoke.txt", status: "processing" }]);
    expect(result.data.added).toEqual([{ name: "smoke.txt", status: "processing" }]);
  });

  it("uploads through a file chooser that opens later than the former 300 ms probe window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-delayed-chooser-"));
    const file = join(dir, "smoke.txt");
    await writeFile(file, "hello");
    const page = projectSourcesUploadPage("smoke.txt", { chooserDelayMs: 900 });
    const chatgpt = createChatGPT({ page });

    const result = await chatgpt.projects.sources.add({
      projectUrl: PROJECT_URL,
      files: [file],
      confirmMutation: true,
      batchSize: 1
    });

    expect(result.ok).toBe(true);
    expect(page.clicks).toEqual(["Sources", "Add sources"]);
    expect(page.uploadedPaths).toEqual([file]);
    expect(page.chooserWaiters).toBe(1);
    expect(page.setFilesCalls).toBe(1);
    expect(page.elapsedMsAtChooserOpen).toBeGreaterThan(300);
  });

  it("treats chooser rejection as terminal without retrying through the upload menu", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatgpt-project-source-rejected-chooser-"));
    const file = join(dir, "smoke.txt");
    await writeFile(file, "hello");
    const page = projectSourcesUploadPage("smoke.txt", { chooserRejectAfterMs: 100 });
    const chatgpt = createChatGPT({ page });

    const result = await chatgpt.projects.sources.add({
      projectUrl: PROJECT_URL,
      files: [file],
      confirmMutation: true,
      batchSize: 1
    });

    expect(result.ok).toBe(false);
    expect(result.blocker?.message).toContain("simulated chooser rejection");
    expect(page.clicks).toEqual(["Sources", "Add sources"]);
    expect(page.chooserWaiters).toBe(1);
    expect(page.setFilesCalls).toBe(0);
    expect(page.uploadedPaths).toEqual([]);
  });

  it("extracts source names and statuses from a fixture list without source content", () => {
    const html = `
      <main>
        <button role="tab" aria-selected="true">Sources</button>
        <section aria-label="Sources">
          <div data-testid="project-source">
            <span>brief.md</span>
            <span>Ready</span>
            <p>private body text should not be captured</p>
          </div>
          <div data-testid="project-source">
            <span>dataset.csv</span>
            <span>Processing</span>
          </div>
        </section>
      </main>
    `;

    expect(extractProjectSourcesFromHtml(html)).toEqual([
      { name: "brief.md", status: "ready" },
      { name: "dataset.csv", status: "processing" }
    ]);
  });

  it("returns selector-drift candidates without leaking source body text", async () => {
    const result = await listProjectSources({
      page: htmlPage(`
        <main>
          <button role="tab">Chats</button>
          <button role="tab">Sources</button>
          <button>Add source</button>
          <p>secret source body should never be a selector candidate</p>
        </main>
      `)
    }, { projectUrl: PROJECT_URL });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("unsupported");
    expect(result.blocker).toMatchObject({
      kind: "selector_drift",
      code: "project_sources_list_unavailable",
      candidates: expect.arrayContaining([
        { label: "Sources", role: "tab" },
        { label: "Add source", role: "button" }
      ])
    });
    expect(JSON.stringify(result.blocker)).not.toContain("secret source body");
  });

  it("lists Project Sources through the client namespace", async () => {
    const chatgpt = createChatGPT({
      page: htmlPage(`
        <main>
          <button role="tab" aria-selected="true">Sources</button>
          <div data-testid="project-source"><span>brief.md</span><span>Ready</span></div>
        </main>
      `)
    });

    const result = await chatgpt.projects.sources.list({ projectUrl: PROJECT_URL });

    expect(result.ok).toBe(true);
    expect(result.data?.sources).toEqual([{ name: "brief.md", status: "ready" }]);
  });

  it("does not list empty-state sort, filter, or add controls as sources", async () => {
    const result = await listProjectSources({
      page: htmlPage(`
        <main>
          <button role="tab" aria-selected="true">Sources</button>
          <button aria-label="Sort sources: Newest"><span>Newest</span></button>
          <button aria-label="Filter sources: All"><span>All</span></button>
          <section aria-label="Sources">
            <p>Give ChatGPT more context</p>
            <button>Add sources</button>
          </section>
        </main>
      `)
    }, { projectUrl: PROJECT_URL });

    expect(result.ok).toBe(true);
    expect(result.data?.sources).toEqual([]);
  });

  it("extracts live Sources section filename rows without content", () => {
    const sources = extractProjectSourcesFromHtml(`
      <section aria-label="Sources">
        <button>Add sources</button>
        <button class="w-full cursor-pointer text-start">
          chatgpt-project-sources-stage4-smoke.txt Document · Jun 10, 2026
        </button>
        <div aria-label="chatgpt-project-sources-stage4-smoke.txt">
          chatgpt-project-sources-stage4-smoke.txt
        </div>
        <button aria-label="Source actions"></button>
      </section>
    `);

    expect(sources).toEqual([
      { name: "chatgpt-project-sources-stage4-smoke.txt", status: "unknown" }
    ]);
  });

  it("navigates nested project chat pages to the normalized project page before listing", async () => {
    let currentUrl = "https://chatgpt.com/g/g-p-69f7590a9a188191a7356459c924eaf9-diy-wifi/c/abc-123";
    const navigations: string[] = [];
    const chatgpt = createChatGPT({
      page: {
        ...htmlPage(`
          <main>
            <button role="tab" aria-selected="true">Sources</button>
            <div data-testid="project-source"><span>brief.md</span><span>Ready</span></div>
          </main>
        `),
        url: () => currentUrl,
        goto: async url => {
          navigations.push(String(url));
          currentUrl = String(url);
        }
      }
    });

    const result = await chatgpt.projects.sources.list({
      projectUrl: "https://chatgpt.com/g/g-p-69f7590a9a188191a7356459c924eaf9-diy-wifi/c/abc-123"
    });

    expect(result.ok).toBe(true);
    expect(navigations).toEqual([PROJECT_URL]);
  });

  it("extracts only safe selector candidates from fallback HTML", () => {
    const candidates = safeProjectSourceCandidatesFromHtml(`
      <main>
        <button role="tab">Sources</button>
        <button>Add source</button>
        <a href="/g/g-p-example/project">Project Home</a>
        <p>confidential source paragraph</p>
      </main>
    `);

    expect(candidates).toEqual([
      { label: "Sources", role: "tab" },
      { label: "Add source", role: "button" },
      { label: "Project Home", role: "link" }
    ]);
  });
});

function htmlPage(html: string): PageLike {
  return {
    url: () => PROJECT_URL,
    title: async () => "ChatGPT Project",
    content: async () => html,
    locator: () => ({ count: async () => 0 })
  };
}

function mutationFailingPage(): PageLike & { mutationCalls: string[] } {
  const mutationCalls: string[] = [];
  const locator: LocatorLike = {
    count: async () => 0,
    click: async () => {
      mutationCalls.push("click");
      throw new Error("dry-run should not click");
    },
    setInputFiles: async () => {
      mutationCalls.push("setInputFiles");
      throw new Error("dry-run should not upload");
    }
  };
  return {
    mutationCalls,
    url: () => PROJECT_URL,
    title: async () => "ChatGPT Project",
    locator: () => locator,
    goto: async () => {
      mutationCalls.push("goto");
      throw new Error("dry-run should not navigate");
    },
    waitForEvent: async () => {
      mutationCalls.push("waitForEvent");
      throw new Error("dry-run should not wait for file chooser");
    }
  };
}

type ProjectSourcesUploadPage = PageLike & {
  clicks: string[];
  uploadedPaths: string[];
  chooserWaiters: number;
  setFilesCalls: number;
  elapsedMsAtChooserOpen: number;
};

function projectSourcesUploadPage(
  uploadedName: string,
  options: { chooserDelayMs?: number; chooserRejectAfterMs?: number } = {}
): ProjectSourcesUploadPage {
  const clicks: string[] = [];
  const uploadedPaths: string[] = [];
  const chooserWaiters: Array<{
    resolve: (chooser: FileChooserLike) => void;
    reject: (error: Error) => void;
  }> = [];
  const directChooser = options.chooserDelayMs !== undefined || options.chooserRejectAfterMs !== undefined;
  let addSourcesClicked = false;
  let menuOpen = false;
  let elapsedMs = 0;
  const chooser: FileChooserLike = {
    setFiles: async paths => {
      page.setFilesCalls += 1;
      uploadedPaths.push(...paths);
    }
  };

  const locatorFor = (label: string, count: () => number, onClick?: () => void): LocatorLike => {
    const locator: LocatorLike = {
      count: async () => count(),
      isVisible: async () => count() > 0,
      click: async () => {
        clicks.push(label);
        onClick?.();
      }
    };
    locator.first = () => locator;
    return locator;
  };

  const openChooser = (): void => {
    page.elapsedMsAtChooserOpen = elapsedMs;
    for (const waiter of chooserWaiters.splice(0)) {
      waiter.resolve(chooser);
    }
  };

  const page: ProjectSourcesUploadPage = {
    clicks,
    uploadedPaths,
    chooserWaiters: 0,
    setFilesCalls: 0,
    elapsedMsAtChooserOpen: 0,
    url: () => PROJECT_URL,
    title: async () => "ChatGPT Project",
    content: async () => uploadedPaths.length === 0
      ? `<main><button role="tab" aria-selected="true">Sources</button></main>`
      : `<main><button role="tab" aria-selected="true">Sources</button><div data-testid="project-source"><span>${uploadedName}</span><span>Processing</span></div></main>`,
    locator: (selector: string) => locatorFor(selector, () => 0),
    getByRole: (role: string, options?: Record<string, unknown>) => {
      const pattern = options?.name instanceof RegExp ? options.name : undefined;
      if (role === "tab" && pattern?.test("Sources")) {
        return locatorFor("Sources", () => 1);
      }
      if (role === "button" && pattern?.test("Add sources")) {
        return locatorFor("Add sources", () => 1, () => {
          addSourcesClicked = true;
          menuOpen = !directChooser;
        });
      }
      if (role === "button" && pattern?.test("Upload")) {
        return locatorFor("Upload", () => menuOpen ? 1 : 0, openChooser);
      }
      return locatorFor(role, () => 0);
    },
    waitForEvent: async (event: string) => {
      if (event !== "filechooser") {
        throw new Error(`Unexpected event: ${event}`);
      }
      page.chooserWaiters += 1;
      return new Promise<FileChooserLike>((resolve, reject) => {
        chooserWaiters.push({ resolve, reject });
      });
    },
    waitForTimeout: async (ms: number) => {
      if (!directChooser || !addSourcesClicked) {
        return;
      }
      elapsedMs += ms;
      if (options.chooserRejectAfterMs !== undefined && elapsedMs >= options.chooserRejectAfterMs) {
        for (const waiter of chooserWaiters.splice(0)) {
          waiter.reject(new Error("simulated chooser rejection"));
        }
      } else if (options.chooserDelayMs !== undefined && elapsedMs >= options.chooserDelayMs && chooserWaiters.length > 0) {
        openChooser();
      }
    }
  };

  return page;
}
