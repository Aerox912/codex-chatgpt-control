export type PluginPreferences = {
  workspaceProjects?: {
    autoCreate?: boolean;
  };
};

export type WorkspaceProjectClientOptions = {
  workspaceProject?: false | {
    confirmCreation?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function pluginPreferencesPath(): string;

export function loadPluginPreferences(options?: { path?: string }): Promise<PluginPreferences>;

export function applyPluginPreferences<T extends WorkspaceProjectClientOptions>(
  options?: T,
  preferences?: PluginPreferences
): T;

export function importChatGPTControl(options?: {
  cacheBust?: boolean;
  preferencesPath?: string;
}): Promise<Record<string, unknown> & { createChatGPT(options?: WorkspaceProjectClientOptions): unknown }>;

export function backendBundleUrl(): string;
