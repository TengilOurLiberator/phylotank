/**
 * Species renaming (07 §6.4, William's Q9: "William's renames win").
 *
 * A rename is validated here (genus 3 to 24 letters and capitalised, epithet 3 to 24 letters and
 * lowercase, letters plus hyphen only; uniqueness is a warning, never a block), kept in a
 * per-world NameBook, and sent to the host as a `setting` command (key `species.<id>.name`,
 * value a small JSON string) until the contract has a `rename` command
 * (docs/contract-requests/ui.md item 8). The NameBook is applied over every species name the
 * view receives, so a user name wins over any generated one, whether or not the host has
 * confirmed it yet. Daughter species inherit a user-named genus: a species whose generated
 * genus equals its renamed ancestor's generated genus is shown with the user genus.
 */
import { sanitiseText } from '../core/index.js';
import { store } from './dom.js';

export interface UserName { genus: string; epithet: string; common?: string; wholeGenus?: boolean; at: number }
export interface NamedSpecies { id: number; name: string; parent: number; common?: string }
export type RenameIssue = 'genusLength' | 'genusCase' | 'genusLetters' | 'epithetLength' | 'epithetCase' | 'epithetLetters' | 'duplicate' | 'commonLength';
export interface RenameCheck { genus: string; epithet: string; common: string; errors: RenameIssue[]; warnings: RenameIssue[] }

const LETTERS = /^[\p{L}-]+$/u;

export function splitName(name: string): { genus: string; epithet: string } {
  const [genus = '', ...rest] = name.trim().split(/\s+/);
  return { genus, epithet: rest.join(' ') };
}

/**
 * Normalise and check a proposed name. Case is fixed for the user (Genus, epithet) rather than
 * refused; length and letters are refused; a clash with another living or recorded species only warns.
 */
export function checkRename(input: { genus: string; epithet: string; common?: string }, others: readonly { id: number; name: string }[], self = -1): RenameCheck {
  const clean = (s: string) => sanitiseText(s, 48).trim().replace(/\s+/g, '');
  let genus = clean(input.genus), epithet = clean(input.epithet);
  const common = sanitiseText(input.common ?? '', 64).trim();
  genus = genus ? genus[0]!.toLocaleUpperCase('en') + genus.slice(1).toLocaleLowerCase('en') : genus;
  epithet = epithet.toLocaleLowerCase('en');
  const errors: RenameIssue[] = [], warnings: RenameIssue[] = [];
  const len = (s: string) => Array.from(s).length;
  if (len(genus) < 3 || len(genus) > 24) errors.push('genusLength');
  if (genus && !LETTERS.test(genus)) errors.push('genusLetters');
  if (genus && genus[0] !== genus[0]!.toLocaleUpperCase('en')) errors.push('genusCase');
  if (len(epithet) < 3 || len(epithet) > 24) errors.push('epithetLength');
  if (epithet && !LETTERS.test(epithet)) errors.push('epithetLetters');
  if (epithet !== epithet.toLocaleLowerCase('en')) errors.push('epithetCase');
  if (len(common) > 48) errors.push('commonLength');
  const full = `${genus} ${epithet}`.toLocaleLowerCase('en');
  if (others.some((o) => o.id !== self && o.name.toLocaleLowerCase('en') === full)) warnings.push('duplicate');
  return { genus, epithet, common, errors, warnings };
}

/** The value sent with `{t:'setting', key: renameKey(id)}` (at most 256 characters, CONTRACT 13 host limit). */
export function renameKey(species: number): string { return `species.${species}.name`; }
export function renameValue(n: { genus: string; epithet: string; common?: string; wholeGenus?: boolean }): string {
  return JSON.stringify({ g: n.genus, e: n.epithet, ...(n.common ? { c: n.common } : {}), ...(n.wholeGenus ? { all: true } : {}) }).slice(0, 256);
}
export function parseRenameValue(v: unknown): { genus: string; epithet: string; common?: string; wholeGenus: boolean } | null {
  if (typeof v !== 'string' || v.length > 256) return null;
  try {
    const o = JSON.parse(v) as { g?: unknown; e?: unknown; c?: unknown; all?: unknown };
    if (typeof o.g !== 'string' || typeof o.e !== 'string') return null;
    const r = checkRename({ genus: o.g, epithet: o.e, ...(typeof o.c === 'string' ? { common: o.c } : {}) }, []);
    if (r.errors.length) return null;
    return { genus: r.genus, epithet: r.epithet, ...(r.common ? { common: r.common } : {}), wholeGenus: o.all === true };
  } catch { return null; }
}

/** Per-world user names. Persisted in this viewer's localStorage as a mirror of the host's record. */
export class NameBook {
  private names = new Map<number, UserName>();
  private key = '';
  constructor(worldId = '') { this.load(worldId); }

  load(worldId: string): void {
    this.key = `pt.names.${worldId || 'default'}`;
    this.names.clear();
    try {
      const raw = store.get(this.key);
      if (raw) for (const [id, n] of Object.entries(JSON.parse(raw) as Record<string, UserName>)) {
        if (typeof n?.genus === 'string' && typeof n.epithet === 'string') this.names.set(Number(id), n);
      }
    } catch { /* a damaged mirror is ignored */ }
  }
  private save(): void { store.set(this.key, JSON.stringify(Object.fromEntries(this.names))); }

  get size(): number { return this.names.size; }
  get(id: number): UserName | undefined { return this.names.get(id); }
  entries(): [number, UserName][] { return [...this.names.entries()]; }

  /**
   * Record a rename. With `wholeGenus`, every species currently shown in the old genus takes the
   * new genus (each keeps its own epithet). Returns the ids whose displayed name changed.
   */
  rename(id: number, n: { genus: string; epithet: string; common?: string; wholeGenus?: boolean }, all: readonly NamedSpecies[], at = 0): number[] {
    const shown = new Map(all.map((s) => [s.id, splitName(this.display(s, all))]));
    const oldGenus = shown.get(id)?.genus;
    this.names.set(id, { genus: n.genus, epithet: n.epithet, ...(n.common ? { common: n.common } : {}), ...(n.wholeGenus ? { wholeGenus: true } : {}), at });
    const changed = [id];
    if (n.wholeGenus && oldGenus) {
      for (const s of all) {
        if (s.id === id) continue;
        const cur = shown.get(s.id)!;
        if (cur.genus !== oldGenus) continue;
        const prev = this.names.get(s.id);
        this.names.set(s.id, { genus: n.genus, epithet: prev?.epithet ?? cur.epithet, ...(prev?.common ? { common: prev.common } : {}), at });
        changed.push(s.id);
      }
    }
    this.save();
    return changed;
  }
  forget(id: number): void { this.names.delete(id); this.save(); }

  /** The name to show: the user's name wins; otherwise inherit a renamed ancestor's genus. */
  display(s: NamedSpecies, all: readonly NamedSpecies[]): string {
    const own = this.names.get(s.id);
    if (own) return `${own.genus} ${own.epithet}`;
    const gen = splitName(s.name);
    const byId = new Map(all.map((x) => [x.id, x]));
    let p = byId.get(s.parent), guard = 0;
    while (p && guard++ < 64) {
      const pn = this.names.get(p.id);
      if (pn && splitName(p.name).genus === gen.genus) return `${pn.genus} ${gen.epithet}`;
      if (splitName(p.name).genus !== gen.genus) break;
      p = byId.get(p.parent);
    }
    return s.name;
  }
  common(s: NamedSpecies): string | undefined { return this.names.get(s.id)?.common ?? s.common; }
  namedBy(id: number): 'user' | 'generator' { return this.names.has(id) ? 'user' : 'generator'; }
}
