/** 32-bit FNV-1a hash of a string (UTF-16 code units). */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

const hueCache = new Map<string, number>();

/** Stable hue (0–359) for a tag/process name: same name → same color, always (SPEC §7.1). */
export function hashHue(name: string): number {
  let hue = hueCache.get(name);
  if (hue === undefined) {
    hue = fnv1a(name) % 360;
    if (hueCache.size > 5000) hueCache.clear();
    hueCache.set(name, hue);
  }
  return hue;
}
