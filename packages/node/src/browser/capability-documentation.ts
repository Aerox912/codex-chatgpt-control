const CDP_DOCUMENTATION_PATH = "capabilities/tab/cdp";

const authorizedAgents = new WeakSet<object>();

/**
 * Browser requires its CDP capability documentation to be read before the
 * first command. Keep that host handshake explicit and fail closed so callers
 * can use their ordinary visible-control fallback when documentation access is
 * unavailable.
 */
export async function authorizeBrowserCdp(agent: unknown): Promise<boolean> {
  if (!isObjectLike(agent)) return false;
  if (authorizedAgents.has(agent)) return true;

  let documentation: unknown;
  let get: unknown;
  try {
    documentation = Reflect.get(agent, "documentation", agent);
    if (!isObjectLike(documentation)) return false;
    get = Reflect.get(documentation, "get", documentation);
  } catch {
    return false;
  }
  if (typeof get !== "function") return false;

  try {
    await Promise.resolve(Reflect.apply(get, documentation, [CDP_DOCUMENTATION_PATH]));
    authorizedAgents.add(agent);
    return true;
  } catch {
    return false;
  }
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
