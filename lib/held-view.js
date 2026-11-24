// lib/held-view.js — the held-set projection: what a session's observations leave held, apart from any live watcher and its state.
// It answers each held file's line keys, each held skill's text, and for every effect the event it belongs to. A harness hands in its Projection factory and its own `completeToolResult`; this module reads only the canonical Observation (`sourceOrdinal`, `content`) and an effect's `impacts[].resourceKey`.
import { createMeasurementEngine } from './measurement/engine.js';
import { SKILL_RESOURCE_PREFIX } from './resource-policy.js';

// Line keys and texts are what a held view answers, and no resource selection changes them, so every resource is selected.
const SELECTED = () => ({ selectedByDefault: true, defaultDiscardReason: null });

/**
 * The held view over a harness's Projection.
 * `createProjection({ completeToolResult })` builds one Projection per pass, `completeToolResult` being the harness interpreter's own with a record of what it completes wrapped around it; `frameCtx` is handed to every `project`, `{ recall }` where the caller recalls a call's saved attribution, `{}` where it does not.
 * A pass projects the observations in order and ingests the effect and epoch records of each into an Engine of its own: the held lines are that Engine's `heldLines()` less the skills' keys, and a skill's text is the result behind its latest effect, an epoch boundary leaving only the skills loaded after it. A call the interpreter gave no effect loads no text.
 * An effect belongs to the event of the result that completes its call, a load message's included, since the interpreter makes none when the call is issued; the seq of the call's own message is not consulted. A result the pruner replaced belongs to its original's seq, not to its replacement's.
 *
 * @param {{ createProjection: (options: { completeToolResult: function }) => { project: function },
 *   completeToolResult: function, resolveModelPolicy: function, frameCtx: object }} options
 * @returns {(observations: Iterable<object>) => { paths: Map<string, number[]>, skills: Map<string, string>,
 *   effects: { seq: number, kind: 'path'|'skill', key: string }[] }} `effects` holds one entry for each resource each
 *   effect impacts, in the order of the observations, `key` a skill's name without its prefix.
 */
export function createHeldView({ createProjection, completeToolResult, resolveModelPolicy, frameCtx }) {
  return (observations) => {
    // The results the Projection completes while one observation is projected, beside the effects each answered:
    // a skill's text is the result behind its effect. The seq is that of the completing result's event.
    let completed = [];
    const projection = createProjection({
      completeToolResult: (pending, observation, context, options) => {
        const answer = completeToolResult(pending, observation, context, options);
        completed.push({ effects: answer.effects, text: observation.content, seq: observation.sourceOrdinal });
        return answer;
      },
    });
    const engine = createMeasurementEngine({ resolveModelPolicy, resolveResourcePolicy: SELECTED });
    let skills = new Map();
    const effects = [];
    for (const observation of observations) {
      completed = [];
      const { records } = projection.project(observation, frameCtx);
      engine.ingest(records.filter(record => record.type === 'effect' || record.type === 'epoch'));
      if (records.some(record => record.type === 'epoch')) skills = new Map();
      for (const { effects: answered, text, seq } of completed) {
        for (const { resourceKey } of answered.flatMap(effect => effect.impacts)) {
          const isSkill = resourceKey.startsWith(SKILL_RESOURCE_PREFIX);
          const key = isSkill ? resourceKey.slice(SKILL_RESOURCE_PREFIX.length) : resourceKey;
          if (isSkill) skills.set(key, text);
          effects.push({ seq, kind: isSkill ? 'skill' : 'path', key });
        }
      }
    }
    const paths = new Map([...engine.heldLines()].filter(([key]) => !key.startsWith(SKILL_RESOURCE_PREFIX)));
    return { paths, skills, effects };
  };
}
