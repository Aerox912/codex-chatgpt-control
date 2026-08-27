# Bridge Bootstrap

Use this reference when `globalThis.agent` is missing, when browser state is unclear, or when a user says an existing ChatGPT tab is already open.

Use this bootstrap only in the primary Codex task. If this reference is loaded
in a Workflow child or other Codex subagent, stop before browser initialization
and return the visible-surface operation to the parent. A child may prepare a
prompt or analyze browser output supplied by the parent, but it must not
bootstrap or operate either browser surface.

This is internal connection setup. In ordinary user-facing progress, say that Codex is connecting to the selected browser; do not narrate Node host state, globals, imports, or instruction loading unless the user explicitly asks for diagnostics.

In a Codex desktop run, use the installed Browser skill to locate its `browser-client.mjs`, initialize the runtime once, and prefer the in-app browser. Fall back to the Chrome extension only when the in-app browser is unavailable:

```js
const { setupBrowserRuntime } = await import("/absolute/path/to/browser-client.mjs");
globalThis.agent = await setupBrowserRuntime();
try {
  globalThis.browser = await agent.browsers.get("iab");
} catch {
  globalThis.browser = await agent.browsers.get("extension");
}
```

When the user explicitly selects the in-app browser or Chrome, do not fall back to another browser. Bind the requested browser through the Browser skill and pass it as `browser` to `createChatGPT(...)`. With no explicit browser choice, passing only `agent` lets the SDK use the same in-app-first policy.

After bootstrap:

```js
JSON.stringify({
  hasAgent: !!globalThis.agent,
  hasBrowser: !!globalThis.browser
}, null, 2);
```

Only report `browser_bridge_unavailable` after bootstrap fails or the bridge remains unavailable.

Do not use `browser.tabs.list()` or `browser.tabs.selected()` alone to decide a user-open ChatGPT tab is unavailable. Those APIs can be sparse for released user tabs. Prefer SDK `existingTab` options or lower-level `browser.user.openTabs()` and `browser.user.claimTab()` when exact user-open tab reuse matters.
