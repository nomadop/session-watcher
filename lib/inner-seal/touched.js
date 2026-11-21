// lib/inner-seal/touched.js — the held files and skills a seal's replaced events touched.

/**
 * The entries of a held view that an effect belonging to one of `seqs` touched: a read or a write of a file, one that leaves its text unchanged included, and a load of a skill, a repeated load included.
 * Only an entry the view holds is answered, whatever else the effects name, and an entry touched by several effects is answered once, in the order the view holds it.
 * @param {{ paths: Map<string, number[]>, skills: Map<string, string>,
 *   effects: { seq: number, kind: 'path'|'skill', key: string }[] }} held
 * @param {Iterable<number>} seqs the seqs of the events the seal replaces
 * @returns {{ paths: Map<string, number[]>, skills: Map<string, string> }}
 */
export function touchedOf({ paths, skills, effects }, seqs) {
  const replaced = new Set(seqs);
  const touched = { path: new Set(), skill: new Set() };
  for (const { seq, kind, key } of effects) if (replaced.has(seq)) touched[kind].add(key);
  return {
    paths: new Map([...paths].filter(([key]) => touched.path.has(key))),
    skills: new Map([...skills].filter(([name]) => touched.skill.has(name))),
  };
}
