/**
 * Accept genuine one-byte typed-array views across JavaScript realms.
 *
 * `instanceof Uint8Array` is realm-sensitive. `ArrayBuffer.isView` checks the
 * internal view slot across realms; the one-byte width and length relation
 * then exclude DataView and wider typed arrays without trusting a type tag.
 */
export function isByteArrayView(value: unknown): value is Uint8Array {
  if (!ArrayBuffer.isView(value)) return false;
  try {
    const view = value as ArrayBufferView & {
      BYTES_PER_ELEMENT?: unknown;
      length?: unknown;
    };
    return view.BYTES_PER_ELEMENT === 1
      && Number.isSafeInteger(view.length)
      && view.length === view.byteLength;
  } catch {
    return false;
  }
}

/**
 * Accept descriptor-safe plain records across JavaScript realms.
 *
 * Comparing a prototype directly with this realm's `Object.prototype`
 * rejects ordinary objects returned by a VM or browser bridge. A foreign
 * intrinsic Object prototype is still a direct child of `null`; custom class
 * instances have at least one additional layer. Only own data descriptors
 * are accepted, so getters are never invoked by the boundary.
 */
export function isPlainDataRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== null
      && prototype !== Object.prototype
      && Object.getPrototypeOf(prototype) !== null
    ) {
      return false;
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    }
    return true;
  } catch {
    return false;
  }
}
