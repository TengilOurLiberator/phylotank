/**
 * Behaviour templates matching the body templates (03 §3.11 item 3): BrainTraits settings for
 * reflex gains, drives and personality. A template is body independent; it sets genes only.
 * v0.1 templates use the direct encoding (spike 8, docs/spikes/brain-8.md).
 */
import { BRAIN_TRAITS, BT, encodeQ, type Genome, type TemplateId } from '../core/index.js';

type Settings = Record<string, number>;

const TEMPLATES: Readonly<Record<TemplateId, Settings>> = {
  // grazer: calm, strong klinotaxis and graze reflexes
  meadowlamp: { ENCODING: 0, REFLEX_GRAZE: 1.5, APPETITE: 0.6, ACTIVITY: 0.45, BOLDNESS: -0.2, LIGHT_SHOW: 0.4, F_LOW: 0.5, F_HIGH: 2.5 },
  // ambush hunter: still, startle reused as a strike, bites on taste, patient moods
  hushmaw: { ENCODING: 0, REFLEX_STARTLE: 1.6, REFLEX_BITE_ON_TASTE: 1.8, ACTIVITY: 0.15, PATIENCE: 0.9, AGGRESSION: 0.6, BOLDNESS: 0.6, LIGHT_SHOW: 0.15 },
  // drifting filter feeder: low activity, little fear
  sievebell: { ENCODING: 0, ACTIVITY: 0.25, REFLEX_GRAZE: 1.2, REFLEX_STARTLE: 0.5, F_LOW: 0.3, F_HIGH: 1.2, LIGHT_SHOW: 0.5 },
  // parasite: latches and holds, follows smell
  tetherling: { ENCODING: 0, REFLEX_BITE_ON_TASTE: 1.5, REFLEX_GRAZE: 1.4, AGGRESSION: 0.4, ACTIVITY: 0.5, BOLDNESS: 0.3 },
  // scavenger: follows blood smell, bold
  ashpicker: { ENCODING: 0, REFLEX_GRAZE: 1.3, REFLEX_HUNGER_SEEKS: 1.4, BOLDNESS: 0.4, AGGRESSION: 0.2, ACTIVITY: 0.55 },
  // large hunter: aggressive, fast flight response, larger head ganglion
  deepcrown: { ENCODING: 0, HEAD_HIDDEN: 16, AGGRESSION: 0.7, BOLDNESS: 0.8, ACTIVITY: 0.6, REFLEX_BITE_ON_TASTE: 1.5, LIGHT_SHOW: 0.25 },
  // microbe: no hidden neurons, no oscillators beyond the gait, swims constantly
  motefly: { ENCODING: 0, HEAD_HIDDEN: 0, HIDDEN_PER_SEGMENT: 0, OSC_PER_FIN: -0.5, ACTIVITY: 0.7, REFLEX_GRAZE: 1.5 },
  blank: {},
};

export function behaviourTemplate(id: TemplateId): Readonly<Settings> { return TEMPLATES[id]; }

/** Write a behaviour template's BrainTraits into a genome (in place). */
export function applyBehaviourTemplate(g: Genome, id: TemplateId): Genome {
  for (const [name, v] of Object.entries(TEMPLATES[id])) {
    const idx = BT[name];
    if (idx === undefined) throw new Error(`template ${id}: unknown brain trait ${name}`);
    g.brainTraits[idx] = encodeQ(v, BRAIN_TRAITS[idx]!);
  }
  return g;
}
