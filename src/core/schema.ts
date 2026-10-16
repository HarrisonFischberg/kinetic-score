// Versioned JSON schema ids. The app was previously called "Kinetic Score"; files and
// browser storage written under that name are still accepted and migrated.
export const APP_ID = 'musical-marbles';
const LEGACY_APP_IDS = ['kinetic-score'];

/** true when `v` is `<app>/<kind>@1` under the current or a former app id */
export function schemaIs(v: unknown, kind: string): boolean {
  return typeof v === 'string' && [APP_ID, ...LEGACY_APP_IDS].some((id) => v === `${id}/${kind}@1`);
}

/** localStorage keys this key was stored under before the rename (oldest last) */
export function legacyKeys(key: string): string[] {
  return LEGACY_APP_IDS.map((id) => key.replace(`${APP_ID}/`, `${id}/`));
}
