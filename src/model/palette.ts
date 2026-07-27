/**
 * Hue assignment for collaborators.
 *
 * Two goals in tension: a person should keep the same color across sessions (so you
 * learn "teal is Priya"), and two people active at the same time should never share a
 * color (so you can tell them apart when it matters). Stability wins by default —
 * hue comes from a hash of the login — and probing resolves the clashes.
 */

export const HUE_COUNT = 8;

/**
 * The mainline's slot, kept outside the rotation on purpose.
 *
 * "Main has moved under you" is a different kind of statement from "Priya is editing
 * this", and giving it a collaborator hue would invite reading it as one more person.
 * A reserved slot means the mainline always looks like the mainline, whoever is on the
 * team this week.
 */
export const MAINLINE_HUE = -1;

/** FNV-1a. Chosen for being stable, tiny, and dependency-free — not for cryptography. */
export function hashLogin(login: string): number {
  let hash = 0x811c9dc5;
  const normalized = login.toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Theme color id for a hue slot. */
export function hueColorId(slot: number): string {
  if (slot === MAINLINE_HUE) return 'gitray.mainlineForeground';
  return `gitray.collaborator${(slot % HUE_COUNT) + 1}`;
}

/**
 * Give every active author a distinct hue.
 *
 * Order of assignment is derived from the logins themselves, not from the order they
 * arrive in, so the same set of people always produces the same mapping regardless of
 * how the pull requests happened to be sorted. Once all eight hues are taken, extras
 * fall back to their preferred slot and share.
 */
export function assignHues(logins: readonly string[]): Map<string, number> {
  const unique = [...new Set(logins)];
  unique.sort((a, b) => {
    const diff = hashLogin(a) - hashLogin(b);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const assignment = new Map<string, number>();
  const taken = new Set<number>();

  for (const login of unique) {
    const preferred = hashLogin(login) % HUE_COUNT;
    let slot = preferred;
    for (let probe = 0; probe < HUE_COUNT && taken.has(slot); probe++) {
      slot = (preferred + probe + 1) % HUE_COUNT;
    }
    if (taken.has(slot)) slot = preferred;
    taken.add(slot);
    assignment.set(login, slot);
  }

  return assignment;
}
