import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function pluginPreferencesPath() {
  return join(homedir(), ".codex", "codex-chatgpt-control", "preferences.json");
}

export async function loadPluginPreferences({ path = pluginPreferencesPath() } = {}) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function applyPluginPreferences(options = {}, preferences = {}) {
  const workspacePath = globalThis.nodeRepl?.cwd;
  const inferred = options.workspaceProject !== undefined
    || typeof workspacePath !== "string"
    || workspacePath.trim().length === 0
    ? options
    : { ...options, workspaceProject: { path: workspacePath } };
  const workspaceProject = inferred.workspaceProject;
  if (
    workspaceProject === undefined
    || workspaceProject === false
    || workspaceProject === null
    || typeof workspaceProject !== "object"
    || workspaceProject.confirmCreation !== undefined
    || preferences.workspaceProjects?.autoCreate !== true
  ) {
    return inferred;
  }
  return {
    ...inferred,
    workspaceProject: { ...workspaceProject, confirmCreation: true }
  };
}

export async function importChatGPTControl({ cacheBust = true, preferencesPath } = {}) {
  const runtimeUrl = new URL("./node/codex-chatgpt-control.bundle.mjs", import.meta.url);
  const href = cacheBust
    ? `${runtimeUrl.href}?t=${Date.now()}`
    : runtimeUrl.href;
  const [runtime, preferences] = await Promise.all([
    import(href),
    loadPluginPreferences(preferencesPath === undefined ? {} : { path: preferencesPath })
  ]);
  return {
    ...runtime,
    createChatGPT(options = {}) {
      return runtime.createChatGPT(applyPluginPreferences(options, preferences));
    }
  };
}

export function backendBundleUrl() {
  return pathToFileURL(new URL("./node/codex-chatgpt-control-backend.mjs", import.meta.url).pathname).href;
}
