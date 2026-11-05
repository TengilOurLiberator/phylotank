/**
 * Localised labels for the generated designer sliders (07 §6.3). The sliders come from the
 * schema tables (TRAITS, BRAIN_TRAITS, MODULE_RECORD), whose names are code identifiers, so the
 * labels live here, keyed by schema name, in English and Swedish. A name missing from a table
 * falls back to a tidied schema name, so a new schema trait still gets a slider (tests check
 * that every current schema name has both languages). The pseudo-locale wraps the English.
 */
import { BRAIN_TRAITS, DRIVES, TRAITS } from '../core/index.js';
import { getLocale, pseudo } from './i18n.js';

type Pair = readonly [en: string, sv: string];

/** Trait labels (TRAIT block, CONTRACT 6.3). */
export const TRAIT_LABELS: Readonly<Record<string, Pair>> = {
  ADULT_LENGTH: ['Adult length', 'Vuxenlängd'],
  BIRTH_FRACTION: ['Size at birth', 'Storlek vid födseln'],
  GROWTH_RATE: ['Growth rate', 'Tillväxttakt'],
  MATURITY_FRACTION: ['Size at maturity', 'Storlek vid könsmognad'],
  LIFESPAN_MULT: ['Lifespan', 'Livslängd'],
  SENESCENCE: ['Ageing shape', 'Åldrandets förlopp'],
  CLUTCH_SIZE: ['Clutch size', 'Kullstorlek'],
  REPRO_RESERVE: ['Energy kept before breeding', 'Energireserv före fortplantning'],
  SEX_PROB: ['Sexual reproduction', 'Könlig fortplantning'],
  MATE_PATIENCE: ['Patience for a mate', 'Tålamod med partner'],
  FAT_CAPACITY: ['Fat stores', 'Fettreserver'],
  BROOD_INTERVAL: ['Time between broods', 'Tid mellan kullar'],
  IMMUNE_INVEST: ['Immune defence', 'Immunförsvar'],
  O_CRIT: ['Oxygen need', 'Syrebehov'],
  SHELL: ['Shell', 'Skal'],
  SESSILE: ['Sessile (anchored)', 'Fastsittande'],
  MU_LOG: ['Mutation rate', 'Mutationstakt'],
  MU_STRUCT_RATIO: ['Body-plan mutations', 'Mutationer i kroppsplanen'],
  SIGMA: ['Mutation step size', 'Mutationssteg'],
  MUSCLE_STRENGTH: ['Muscle strength', 'Muskelstyrka'],
  DIET_PLANT: ['Plant enzymes', 'Växtenzymer'],
  DIET_DETRITUS: ['Detritus enzymes', 'Detritusenzymer'],
  TEMP_OPTIMUM: ['Preferred temperature', 'Föredragen temperatur'],
  TEMP_TOLERANCE: ['Temperature tolerance', 'Temperaturtålighet'],
  FAST_FIBRE: ['Fast muscle fibres', 'Snabba muskelfibrer'],
  TOXICITY: ['Toxicity', 'Giftighet'],
  AEROBIC_SCOPE: ['Aerobic scope', 'Aerob kapacitet'],
  JOINT_DAMPING: ['Joint damping', 'Leddämpning'],
  BODY_HUE: ['Body hue', 'Kroppens nyans'],
  BODY_SAT: ['Body saturation', 'Kroppens mättnad'],
  BODY_LUM: ['Body brightness', 'Kroppens ljushet'],
  TRANSLUCENCY: ['Translucency', 'Genomskinlighet'],
  GLOW_HUE: ['Glow hue', 'Glödens nyans'],
  GLOW_BASE: ['Resting glow', 'Viloglöd'],
  PULSE_FREQ: ['Pulse rate', 'Pulsfrekvens'],
  PULSE_SHAPE: ['Pulse shape', 'Pulsform'],
  PATTERN_KIND: ['Pattern', 'Mönster'],
  PATTERN_FREQ: ['Pattern scale', 'Mönsterskala'],
  PATTERN_CONTRAST: ['Pattern contrast', 'Mönsterkontrast'],
  TRAIL_LENGTH: ['Glow trail', 'Glödspår'],
  ODOUR_A: ['Scent A', 'Doft A'],
  ODOUR_B: ['Scent B', 'Doft B'],
  ODOUR_C: ['Scent C', 'Doft C'],
  ODOUR_D: ['Scent D', 'Doft D'],
  PREF_GLOW_HUE: ['Preferred mate glow', 'Önskad partnerglöd'],
  PREF_HUE_WIDTH: ['Glow preference width', 'Bredd på glödpreferens'],
  PREF_SIZE_RATIO: ['Preferred mate size', 'Önskad partnerstorlek'],
  PREF_PULSE: ['Preferred mate pulse', 'Önskad partnerpuls'],
  PREF_ODOUR_WEIGHT: ['Weight on scent', 'Vikt på doft'],
  CHOOSINESS: ['Choosiness', 'Kräsenhet'],
  CILIA_SPEED: ['Cilia beat', 'Flimmerhårens takt'],
  ALARM_EMIT: ['Alarm signal', 'Larmsignal'],
  G_SLENDERNESS: ['Scale: slenderness', 'Skala: slankhet'],
  G_FIN: ['Scale: fins', 'Skala: fenor'],
  G_EYE: ['Scale: eyes', 'Skala: ögon'],
  G_MOUTH: ['Scale: mouth', 'Skala: mun'],
  G_SPIKE: ['Scale: spikes', 'Skala: taggar'],
  G_ARMOUR: ['Scale: armour', 'Skala: pansar'],
  G_TAPER: ['Scale: taper', 'Skala: avsmalning'],
  G_STIFFNESS: ['Scale: stiffness', 'Skala: styvhet'],
  G_PHOTOPHORE: ['Scale: light organs', 'Skala: ljusorgan'],
  G_GUT: ['Scale: gut', 'Skala: tarm'],
  G_LIMB_LENGTH: ['Scale: limb length', 'Skala: lemlängd'],
};

/** BrainTraits labels (CONTRACT 6.7). RULEn_* and DRIVE_* are built by brainLabel below. */
export const BRAIN_LABELS: Readonly<Record<string, Pair>> = {
  ENCODING: ['Brain encoding', 'Hjärnans kodning'],
  HEAD_HIDDEN: ['Head neurons', 'Neuroner i huvudet'],
  HIDDEN_PER_SEGMENT: ['Neurons per segment', 'Neuroner per segment'],
  OSC_PER_SEGMENT: ['Rhythm per segment', 'Rytm per segment'],
  OSC_PER_FIN: ['Rhythm per fin', 'Rytm per fena'],
  F_LOW: ['Slowest rhythm', 'Långsammaste rytm'],
  F_HIGH: ['Fastest rhythm', 'Snabbaste rytm'],
  PLASTICITY_ON: ['Learning', 'Inlärning'],
  ETA_SCALE: ['Learning rate', 'Inlärningstakt'],
  TAU_FORGET: ['Forgetting time', 'Glömsketid'],
  SENSOR_NOISE: ['Sensor noise', 'Sinnesbrus'],
  TAU_SCALE: ['Neuron time scale', 'Neuronernas tidsskala'],
  GAIN_VISION: ['Vision gain', 'Synens förstärkning'],
  GAIN_LATERAL: ['Lateral line gain', 'Sidolinjens förstärkning'],
  GAIN_CHEMO: ['Smell gain', 'Luktens förstärkning'],
  REFLEX_SWIM: ['Swim reflex', 'Simreflex'],
  REFLEX_STARTLE: ['Startle reflex', 'Skrämselreflex'],
  REFLEX_GRAZE: ['Graze reflex', 'Betesreflex'],
  REFLEX_BITE_ON_TASTE: ['Bite on taste', 'Bit vid smak'],
  REFLEX_AVOID_WALL: ['Avoid walls', 'Undvik väggar'],
  REFLEX_REPRODUCE: ['Breeding urge', 'Fortplantningsdrift'],
  REFLEX_HUNGER_SEEKS: ['Hunger seeks food', 'Hunger söker föda'],
  REFLEX_FEAR_FLEES: ['Fear flees', 'Rädsla flyr'],
  REFLEX_INNATE_GAIT: ['Innate gait', 'Medfödd gång'],
  BOLDNESS: ['Boldness', 'Djärvhet'],
  ACTIVITY: ['Activity', 'Aktivitet'],
  EXPLORATION: ['Curiosity', 'Nyfikenhet'],
  SOCIALITY: ['Sociability', 'Sällskaplighet'],
  AGGRESSION: ['Aggression', 'Aggressivitet'],
  APPETITE: ['Appetite', 'Aptit'],
  PATIENCE: ['Patience', 'Tålamod'],
  CHRONOTYPE: ['Night or day', 'Natt eller dag'],
  PREF_DEPTH: ['Preferred depth', 'Föredraget djup'],
  RISK_AVERSION: ['Caution', 'Försiktighet'],
  LIGHT_SHOW: ['Light show', 'Ljusshow'],
  INDIVIDUALITY: ['Individuality', 'Individualitet'],
};

const DRIVE_NAMES: Readonly<Record<string, Pair>> = {
  HUNGER: ['Hunger', 'Hunger'], FEAR: ['Fear', 'Rädsla'], LIBIDO: ['Libido', 'Parningslust'],
  FATIGUE: ['Fatigue', 'Trötthet'], AGGRESSION: ['Aggression', 'Aggressivitet'], SOCIALITY: ['Sociability', 'Sällskaplighet'],
};
const DRIVE_PARTS: Readonly<Record<string, Pair>> = { BIAS: ['baseline', 'grundnivå'], TAU: ['decay time', 'avklingningstid'], GAIN: ['gain', 'förstärkning'] };
const RULE_PARTS: Readonly<Record<string, Pair>> = {
  A: ['A (Hebbian)', 'A (hebbsk)'], B: ['B (pre)', 'B (före)'], C: ['C (post)', 'C (efter)'], D: ['D (constant)', 'D (konstant)'], CH: ['channel', 'kanal'],
};

/** Gene group names (schema `group`, plus the designer's Advanced). */
export const GROUP_LABELS: Readonly<Record<string, Pair>> = {
  Size: ['Size', 'Storlek'], Life: ['Life', 'Liv'], Reproduction: ['Reproduction', 'Fortplantning'], Diet: ['Diet', 'Föda'],
  Body: ['Body', 'Kropp'], Shape: ['Shape', 'Form'], Senses: ['Senses', 'Sinnen'], Habitat: ['Habitat', 'Livsmiljö'],
  Health: ['Health', 'Hälsa'], Look: ['Look', 'Utseende'], Mating: ['Mating', 'Parning'], Behaviour: ['Behaviour', 'Beteende'],
  Mutation: ['Mutation', 'Mutation'], Brain: ['Brain', 'Hjärna'], Instinct: ['Instinct', 'Instinkt'],
  Personality: ['Personality', 'Personlighet'], Drives: ['Drives', 'Drifter'], Plasticity: ['Learning rules', 'Inlärningsregler'],
  Advanced: ['Advanced', 'Avancerat'], hidden: ['Advanced', 'Avancerat'],
};

/** Part-editor field labels (MODULE_RECORD and LINK_RECORD names). */
export const FIELD_LABELS: Readonly<Record<string, Pair>> = {
  length: ['length', 'längd'], width: ['width', 'bredd'], taper: ['taper', 'avsmalning'], stiffness: ['stiffness', 'styvhet'],
  muscleFraction: ['muscle', 'muskel'], glow: ['glow', 'glöd'], hueOffset: ['hue', 'nyans'], armourCoverage: ['armour', 'pansar'],
  span: ['span', 'spännvidd'], lipidFraction: ['fat', 'fett'], gutFraction: ['gut', 'tarm'], photoFraction: ['photosynthesis', 'fotosyntes'],
  repeat: ['repeat', 'upprepning'], attachPos: ['attach position', 'fästpunkt'], attachAngle: ['attach angle', 'fästvinkel'],
  childScale: ['child scale', 'barnskala'], repeatScale: ['repeat scale', 'upprepningsskala'],
};

function pick(p: Pair | undefined, fallback: string): string {
  const loc = getLocale();
  if (!p) return loc === 'xx' ? pseudo(fallback) : fallback;
  return loc === 'sv' ? p[1] : loc === 'xx' ? pseudo(p[0]) : p[0];
}

/** Tidied schema name: the fallback for a name with no label yet. */
export function tidyName(n: string): string { return n.toLowerCase().replace(/_/g, ' ').replace(/^g /, 'scale: ').replace(/^\w/, (c) => c.toUpperCase()); }

function brainPair(name: string): Pair | undefined {
  const direct = BRAIN_LABELS[name];
  if (direct) return direct;
  let m = /^DRIVE_([A-Z]+)_(BIAS|TAU|GAIN)$/.exec(name);
  if (m) {
    const d = DRIVE_NAMES[m[1]!], p = DRIVE_PARTS[m[2]!];
    if (d && p) return [`${d[0]}: ${p[0]}`, `${d[1]}: ${p[1]}`];
  }
  m = /^RULE(\d)_(A|B|C|D|CH)$/.exec(name);
  if (m) {
    const p = RULE_PARTS[m[2]!]!;
    return [`Rule ${Number(m[1]) + 1}: ${p[0]}`, `Regel ${Number(m[1]) + 1}: ${p[1]}`];
  }
  return undefined;
}

/** Label for a trait slider. `table` is 'T' (traits) or 'B' (brain traits). */
export function traitLabel(name: string, table: 'T' | 'B' = 'T'): string {
  return pick(table === 'T' ? TRAIT_LABELS[name] : brainPair(name), tidyName(name));
}
export function groupLabel(group: string): string { return pick(GROUP_LABELS[group], group); }
export function fieldLabel(field: string): string { return pick(FIELD_LABELS[field], field); }

/** Schema names with no label in either language (for tests and the integrator). */
export function missingLabels(): string[] {
  const out: string[] = [];
  for (const s of TRAITS) if (s && !TRAIT_LABELS[s.name]) out.push(`T.${s.name}`);
  for (const s of BRAIN_TRAITS) if (s && !brainPair(s.name)) out.push(`B.${s.name}`);
  for (const s of [...TRAITS, ...BRAIN_TRAITS]) if (s && !GROUP_LABELS[s.group]) out.push(`group.${s.group}`);
  return out;
}
void DRIVES;
