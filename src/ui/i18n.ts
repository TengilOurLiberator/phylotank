/**
 * Localisation (07 §6.3): English and Swedish. Messages use a small ICU subset: `{name}` slots
 * and `{n, plural, one {...} other {...}}` with `#` for the formatted number. Whole sentences
 * are templates, never concatenated fragments. The language follows navigator.language and can
 * be switched at run time without a reload.
 */
import { Emitter } from './dom.js';

const EN = {
  'app.name': 'Phylotank',
  'app.worldName': 'Founding Waters',
  'app.mockBanner': 'Standalone mock sim: no host connected. Everything here is simulated by the UI mock.',
  'app.hostDown': 'Host not running. Retrying; world-changing controls are disabled.',
  'app.language': 'Language',
  'time.day': 'Day {d}',
  'time.pause': 'Pause',
  'time.resume': 'Resume',
  'time.ff': 'Fast-forward',
  'time.max': 'max',
  'time.achieved': '{req} requested, {got} achieved',
  'time.overnight': 'Run at max until…',
  'time.overnightTitle': 'Run unattended at maximum speed',
  'time.overnightUntil': 'Until (local time)',
  'time.overnightNote': 'The world runs at max until this time even with the god window closed, then returns to 1x. The wallpaper and TV will show the fast world.',
  'time.overnightStart': 'Start overnight run',
  'time.overnightActive': 'Max until {time} (unattended)',
  'time.overnightCancel': 'Stop',
  'time.lease': 'Lease renews every 10 s; returns to 1x 30 s after this window closes.',
  'season.spring': 'spring', 'season.summer': 'summer', 'season.autumn': 'autumn', 'season.winter': 'winter',
  'rail.map': 'Map', 'rail.powers': 'Powers', 'rail.designer': 'Designer', 'rail.library': 'Library',
  'rail.stats': 'Stats', 'rail.bookmarks': 'Bookmarks', 'rail.settings': 'Settings',
  'common.close': 'Close', 'common.cancel': 'Cancel', 'common.confirm': 'Confirm', 'common.yes': 'Yes',
  'common.showTable': 'Show as table', 'common.showChart': 'Show as chart', 'common.none': 'none',
  'common.estimate': 'estimate', 'common.live': 'live',
  'map.title': 'Map', 'map.zones': 'zones', 'map.currents': 'currents', 'map.light': 'light', 'map.temp': 'temp',
  'map.nutrients': 'nutrients', 'map.pop': 'population', 'map.events': 'god events',
  'map.under': 'Zone under cursor: {zone}, {temp} °C, light {light}',
  'zone.photic': 'sunlit zone', 'zone.twilight': 'twilight zone', 'zone.midnight': 'midnight zone', 'zone.vent': 'vent',
  'powers.title': 'Powers',
  'powers.pick': 'Pick a power, then target it in the tank.',
  'powers.targeting': 'targeting: {how}',
  'powers.intensity': 'Intensity',
  'powers.duration': 'Duration',
  'powers.inRange': '{n, plural, one {In range: # creature} other {In range: # creatures}} of {s, plural, one {# species} other {# species}}',
  'powers.major': 'Major power: an automatic snapshot is taken first.',
  'powers.hold': 'Hold to confirm',
  'powers.holdKey': 'or press and hold Enter',
  'powers.cast': 'Cast',
  'powers.confirmDialog': 'Confirm without holding',
  'powers.countdown': '{power} in {s} s',
  'powers.countdownPaused': '{power}: countdown starts on resume',
  'powers.done': '{power} cast.',
  'powers.doneSnap': '{power} cast. Snapshot "{snap}" saved. Undo by rewind.',
  'powers.rejected': 'Not cast: {reason}',
  'powers.stale': 'World was rewound; power not cast.',
  'powers.clickTarget': 'Click in the tank to target. Esc cancels.',
  'powers.pickSpecies': 'Choose the species to target:',
  'powers.globalReady': 'Affects the whole tank.',
  'target.global': 'whole tank', 'target.point': 'point', 'target.circle': 'circle', 'target.depthBand': 'depth band',
  'target.stroke': 'stroke', 'target.species': 'species', 'target.creature': 'creature',
  'power.bloom': 'Algae bloom', 'power.marineSnow': 'Marine snow', 'power.vent': 'Hydrothermal vent',
  'power.coldSnap': 'Cold snap', 'power.heatwave': 'Heatwave', 'power.plague': 'Plague', 'power.meteor': 'Meteor impact',
  'power.currentShift': 'Current shift', 'power.longNight': 'Long night', 'power.mutagen': 'Mutagen burst',
  'power.toxinLeak': 'Toxin leak', 'power.cull': 'Cull', 'power.bless': 'Bless (feed)', 'power.nutrientFlood': 'Nutrient flood',
  'power.iceAge': 'Ice age', 'power.predatorFlood': 'Predator flood', 'power.storm': 'Storm', 'power.whaleFall': 'Whale fall',
  'power.riftBarrier': 'Rift barrier', 'power.deadZone': 'Dead zone', 'power.earthquake': 'Earthquake', 'power.seasons': 'Seasons',
  'power.release': 'Release from library',
  'effect.bloom': 'nutrients x{v}', 'effect.vent': '+{v} °C locally', 'effect.coldSnap': '{v} °C',
  'effect.heatwave': '+{v} °C', 'effect.plague': 'virulence {v}', 'effect.meteor': 'kill radius {v} m',
  'effect.currentShift': 'flow {v} m/s', 'effect.longNight': 'light {v}%', 'effect.mutagen': 'mutation x{v}',
  'effect.cull': '{v}% removed', 'effect.bless': '+{v}% energy', 'effect.nutrientFlood': 'nutrients x{v}',
  'inspector.title': 'Inspector', 'inspector.none': 'Click a creature in the tank to inspect it.',
  'inspector.overview': 'Overview', 'inspector.genome': 'Genome', 'inspector.body': 'Body', 'inspector.brain': 'Brain', 'inspector.kin': 'Kin',
  'inspector.energy': 'Energy', 'inspector.health': 'Health', 'inspector.age': 'Age', 'inspector.generation': 'Generation',
  'inspector.stage': 'Stage', 'inspector.adult': 'adult', 'inspector.juvenile': 'juvenile', 'inspector.length': 'Length',
  'inspector.action': 'Doing', 'inspector.offspring': 'Offspring',
  'inspector.follow': 'Follow', 'inspector.unfollow': 'Stop following', 'inspector.save': 'Save genome to library',
  'inspector.fork': 'Fork in designer', 'inspector.bookmark': 'Bookmark', 'inspector.bless': 'Bless',
  'inspector.onlyDiff': 'Show only differences', 'inspector.gene': 'Gene', 'inspector.value': 'Value', 'inspector.founder': 'Default',
  'inspector.brainLegend': 'Bright = active; dashed = negative weight; thickness = |w|.',
  'inspector.ancestors': 'Ancestors', 'inspector.children': 'Children', 'inspector.collapsed': '… {n} generations …',
  'inspector.founderOf': 'founder', 'inspector.dead': 'dead', 'inspector.alive': 'alive',
  'inspector.saved': 'Saved to the library.',
  'stats.title': 'Stats', 'stats.population': 'Population', 'stats.phylogeny': 'Family tree of species',
  'stats.genes': 'Genes', 'stats.diversity': 'Diversity index', 'stats.foodWeb': 'Food web',
  'stats.log': 'log scale', 'stats.richness': 'Species richness', 'stats.shannon': 'Shannon H′',
  'stats.effective': 'Effective species exp(H′)', 'stats.simpson': 'Simpson 1 − Σp²', 'stats.time': 'Time',
  'stats.species': 'Species', 'stats.count': 'Count', 'stats.trait': 'Trait', 'stats.noData': 'Waiting for data…',
  'timeline.title': 'Timeline', 'timeline.god': 'god', 'timeline.life': 'life', 'timeline.death': 'death',
  'timeline.disease': 'disease', 'timeline.records': 'records', 'timeline.now': 'now',
  'timeline.rewindNearest': 'Rewind to nearest snapshot before this',
  'bookmarks.title': 'Bookmarks and rewind', 'bookmarks.now': 'Bookmark now (Ctrl+B)', 'bookmarks.rewind': 'Rewind to here',
  'bookmarks.confirm': 'All views will jump back to {when}. The present is saved as "Before rewind".',
  'bookmarks.empty': 'No snapshots yet.', 'bookmarks.life': '{n} life', 'bookmarks.species': '{n} sp',
  'bookmarks.kind.manual': 'manual', 'bookmarks.kind.auto': 'auto', 'bookmarks.kind.beforePower': 'before power',
  'bookmarks.kind.beforeRewind': 'before rewind', 'bookmarks.rewound': 'Rewound to {when}.',
  'bookmarks.label': 'Bookmark {n}',
  'designer.title': 'Designer', 'designer.genes': 'Genes', 'designer.parts': 'Parts', 'designer.undo': 'Undo', 'designer.redo': 'Redo',
  'designer.save': 'Save', 'designer.share': 'Share', 'designer.template': 'Template', 'designer.instinct': 'starting instinct, may evolve',
  'designer.growth': 'Growth', 'designer.play': 'Play', 'designer.stop': 'Stop', 'designer.age': 'age {a}',
  'designer.testTank': 'Test tank', 'designer.reroll': 'Reroll seed', 'designer.toyTank': 'toy model until the sim test tank lands',
  'designer.top': 'top {v} BL/s', 'designer.cruise': 'cruise {v} BL/s', 'designer.cot': 'CoT {v}',
  'designer.energy': 'Energy budget (estimate)', 'designer.income': 'Income', 'designer.costs': 'Costs',
  'designer.poor': 'poor', 'designer.typical': 'typical', 'designer.rich': 'rich',
  'designer.breakEven': 'break-even food density: {v} (relative)', 'designer.starves': 'Starves in {v}',
  'designer.adultIn': 'Adult in {v}', 'designer.breeds': 'Breeds every {v}', 'designer.offspring': 'Lifetime offspring (typical): ~{v}',
  'designer.tradeoffs': 'Top trade-offs', 'designer.tradeoff': '{locus} +10%: net {net}%',
  'designer.issues': 'Issues', 'designer.noIssues': 'No issues found.', 'designer.release': 'Release',
  'designer.releaseAnyway': 'Release anyway', 'designer.releaseLeviathan': 'Release as leviathan',
  'designer.eyesChip': 'Eyes: {n} (edit in Parts)', 'designer.finsChip': 'Fins: {n} (edit in Parts)',
  'designer.palette': 'Add part', 'designer.selected': 'Selected rule', 'designer.copies': '{n, plural, one {# copy} other {# copies}}',
  'designer.breakOut': 'Break out this copy', 'designer.deleteRule': 'Delete rule', 'designer.duplicate': 'Duplicate rule',
  'designer.selectPart': 'Click a part to select the rule that grew it. Then add parts to it from the palette.',
  'designer.symmetry': 'Symmetry', 'designer.sym.none': 'none', 'designer.sym.mirror': 'mirror', 'designer.sym.radial': 'radial',
  'designer.dirty': 'unsaved', 'designer.fingerprint': 'fp {fp}', 'designer.group.Advanced': 'Advanced',
  'designer.name': 'Name', 'designer.genus': 'Genus', 'designer.epithet': 'Epithet', 'designer.notes': 'Notes',
  'designer.leviathanFlag': 'leviathan', 'designer.ceilingClamp': 'clamped to {v} unless released as a leviathan',
  'release.title': 'Release {name}', 'release.count': 'How many', 'release.where': 'Where', 'release.zone': 'zone it prefers: {zone}',
  'release.centre': 'centre of the tank', 'release.scatter': 'scatter over the tank', 'release.protect': 'Founder protection',
  'release.button': 'Release', 'release.anyway': 'Release anyway', 'release.done': 'Released {n} × {name}.',
  'release.leviathanTitle': 'Release {name} as a leviathan',
  'release.leviathanNote': 'Sets the leviathan flag: this lineage may grow past the world size ceiling. The world adds its own food (8 × the adult mass per individual) and takes an automatic snapshot first.',
  'release.leviathanHold': 'Hold to release as leviathan',
  'library.title': 'Species library', 'library.search': 'Search name or tag…', 'library.import': 'Import',
  'library.importHint': 'Drop .ptkg files or paste a PTK1 string anywhere in this window to import.',
  'library.edit': 'Edit', 'library.share': 'Share', 'library.download': 'Save .ptkg file', 'library.delete': 'Remove',
  'library.template': 'template', 'library.designed': 'designed', 'library.captured': 'captured', 'library.imported': 'imported',
  'library.empty': 'Nothing here yet.', 'library.paste': 'Paste a PTK1 string', 'library.importOk': 'Imported {name}; opened in the designer preview.',
  'library.importFail': 'Import failed: {reason}', 'library.added': 'Added {name} to the library.',
  'library.exists': 'Already in the library.',
  'share.title': 'Share {name}', 'share.copy': 'Copy string', 'share.copied': 'Copied.', 'share.chars': '{n} characters',
  'share.qr': 'QR code', 'share.qrTooBig': 'Too long for a QR code; share the file instead.',
  'settings.title': 'Settings', 'settings.language': 'Language', 'settings.reducedMotion': 'Reduced motion',
  'settings.captions': 'Captions in screensaver and TV',
  'issue.V01': 'Starves even in rich water.', 'issue.V02': 'Needs richer water than this zone usually has.',
  'issue.V03': 'Its mouth cannot eat what it wants to eat.', 'issue.V04': 'Cannot swim; it will drift with currents.',
  'issue.V05': 'Mating only, but you are releasing a single individual.',
  'issue.V06': 'Cannot store enough energy for even one offspring.', 'issue.V07': 'Its brain cannot react to anything yet.',
  'issue.V09': 'No zone in this world is warm or cold enough.',
  'issue.V11': 'Error catastrophe likely: offspring will often be broken.',
  'issue.V12': 'Pulse will be softened on screen (safety cap).',
  'issue.V13': 'Adult size above the world ceiling: it will be clamped unless released as a leviathan.',
  'issue.V14': 'No mouth: it cannot eat at all.',
  'sev.info': 'info', 'sev.warning': 'warning', 'sev.inviable': 'inviable',
  'part.0': 'Segment', 'part.1': 'Fin', 'part.2': 'Limb', 'part.3': 'Mouth', 'part.4': 'Eye', 'part.5': 'Smell organ',
  'part.6': 'Spike', 'part.7': 'Light organ', 'part.8': 'Cilia', 'part.9': 'Jet', 'part.10': 'Bladder', 'part.11': 'Gland',
  'caption.hunt': '{species} · a hunt in the {zone}', 'caption.speciation': '{species} has branched off from {parent}',
  'caption.extinction': '{species} has died out', 'caption.giant': '{species} · the largest alive',
  'caption.god': '{power} in the {zone}', 'caption.release': 'New arrivals: {species}',
  'caption.school': '{species} · a school gathers in the {zone}', 'caption.massDeath': 'A mass death in the {zone}',
  'caption.frenzy': 'A feeding frenzy in the {zone}', 'caption.outbreak': 'An outbreak spreads in the {zone}',
  'caption.record': '{species} · a new record', 'caption.bloomFront': 'A bloom spreads through the {zone}',
  'caption.migration': '{species} · migrating', 'caption.newRole': '{species} · a new way of life',
  'caption.speed': 'Time is running {x}x faster', 'caption.rewound': 'Rewound to {when}',
  'event.birth': 'birth', 'event.death': 'death', 'event.newSpecies': '{species} has branched off from {parent}',
  'event.extinct': '{species} has died out', 'event.god': '{power} cast', 'event.release': '{species} released ({n})',
  'event.giant': 'Giant {species}', 'event.hunt': 'Hunt by {species}', 'event.bookmark': 'Bookmark: {label}',
  'event.outbreak': 'Outbreak', 'event.massDeath': 'Mass death ({n})', 'event.record': 'Record: {kind}',
  'event.rewind': 'Rewound to {when}', 'event.other': '{k}',
  'count.creatures': '{n, plural, one {# creature} other {# creatures}}',
  'unit.days': '{v} d', 'unit.hours': '{v} h', 'unit.min': '{v} min', 'unit.s': '{v} s',
} as const;

export type MsgKey = keyof typeof EN;

const SV: Record<MsgKey, string> = {
  'app.name': 'Phylotank',
  'app.worldName': 'Grundvattnen',
  'app.mockBanner': 'Fristående låtsassimulering: ingen värd ansluten. Allt här simuleras av gränssnittets attrapp.',
  'app.hostDown': 'Värden körs inte. Försöker igen; kontroller som ändrar världen är avstängda.',
  'app.language': 'Språk',
  'time.day': 'Dag {d}',
  'time.pause': 'Pausa',
  'time.resume': 'Fortsätt',
  'time.ff': 'Spola framåt',
  'time.max': 'max',
  'time.achieved': '{req} begärt, {got} uppnått',
  'time.overnight': 'Kör på max till…',
  'time.overnightTitle': 'Kör obevakat på högsta fart',
  'time.overnightUntil': 'Till (lokal tid)',
  'time.overnightNote': 'Världen kör på max till den här tiden även om gudsfönstret stängs, och går sedan tillbaka till 1x. Bakgrunden och tv:n visar den snabba världen.',
  'time.overnightStart': 'Starta nattkörning',
  'time.overnightActive': 'Max till {time} (obevakat)',
  'time.overnightCancel': 'Stoppa',
  'time.lease': 'Lånet förnyas var 10:e s; går tillbaka till 1x 30 s efter att fönstret stängts.',
  'season.spring': 'vår', 'season.summer': 'sommar', 'season.autumn': 'höst', 'season.winter': 'vinter',
  'rail.map': 'Karta', 'rail.powers': 'Krafter', 'rail.designer': 'Designer', 'rail.library': 'Bibliotek',
  'rail.stats': 'Statistik', 'rail.bookmarks': 'Bokmärken', 'rail.settings': 'Inställningar',
  'common.close': 'Stäng', 'common.cancel': 'Avbryt', 'common.confirm': 'Bekräfta', 'common.yes': 'Ja',
  'common.showTable': 'Visa som tabell', 'common.showChart': 'Visa som diagram', 'common.none': 'inga',
  'common.estimate': 'uppskattning', 'common.live': 'live',
  'map.title': 'Karta', 'map.zones': 'zoner', 'map.currents': 'strömmar', 'map.light': 'ljus', 'map.temp': 'temp',
  'map.nutrients': 'näring', 'map.pop': 'population', 'map.events': 'gudahändelser',
  'map.under': 'Zon under markören: {zone}, {temp} °C, ljus {light}',
  'zone.photic': 'solbelysta zonen', 'zone.twilight': 'skymningszonen', 'zone.midnight': 'midnattszonen', 'zone.vent': 'källa',
  'powers.title': 'Krafter',
  'powers.pick': 'Välj en kraft och sikta sedan i akvariet.',
  'powers.targeting': 'mål: {how}',
  'powers.intensity': 'Styrka',
  'powers.duration': 'Varaktighet',
  'powers.inRange': '{n, plural, one {Inom räckhåll: # varelse} other {Inom räckhåll: # varelser}} av {s, plural, one {# art} other {# arter}}',
  'powers.major': 'Stor kraft: en ögonblicksbild sparas automatiskt först.',
  'powers.hold': 'Håll för att bekräfta',
  'powers.holdKey': 'eller håll ned Enter',
  'powers.cast': 'Utlös',
  'powers.confirmDialog': 'Bekräfta utan att hålla',
  'powers.countdown': '{power} om {s} s',
  'powers.countdownPaused': '{power}: nedräkningen börjar när tiden går igen',
  'powers.done': '{power} utlöst.',
  'powers.doneSnap': '{power} utlöst. Ögonblicksbilden "{snap}" sparad. Ångra genom att spola tillbaka.',
  'powers.rejected': 'Inte utlöst: {reason}',
  'powers.stale': 'Världen spolades tillbaka; kraften utlöstes inte.',
  'powers.clickTarget': 'Klicka i akvariet för att sikta. Esc avbryter.',
  'powers.pickSpecies': 'Välj art att rikta in sig på:',
  'powers.globalReady': 'Påverkar hela akvariet.',
  'target.global': 'hela akvariet', 'target.point': 'punkt', 'target.circle': 'cirkel', 'target.depthBand': 'djupband',
  'target.stroke': 'drag', 'target.species': 'art', 'target.creature': 'varelse',
  'power.bloom': 'Algblomning', 'power.marineSnow': 'Marin snö', 'power.vent': 'Hydrotermisk källa',
  'power.coldSnap': 'Köldknäpp', 'power.heatwave': 'Värmebölja', 'power.plague': 'Farsot', 'power.meteor': 'Meteornedslag',
  'power.currentShift': 'Strömskifte', 'power.longNight': 'Lång natt', 'power.mutagen': 'Mutagenstöt',
  'power.toxinLeak': 'Giftläcka', 'power.cull': 'Gallring', 'power.bless': 'Välsigna (mata)', 'power.nutrientFlood': 'Näringsflod',
  'power.iceAge': 'Istid', 'power.predatorFlood': 'Rovdjursflod', 'power.storm': 'Storm', 'power.whaleFall': 'Valfall',
  'power.riftBarrier': 'Sprickbarriär', 'power.deadZone': 'Död zon', 'power.earthquake': 'Jordbävning', 'power.seasons': 'Årstider',
  'power.release': 'Släpp ut från biblioteket',
  'effect.bloom': 'näring x{v}', 'effect.vent': '+{v} °C lokalt', 'effect.coldSnap': '{v} °C',
  'effect.heatwave': '+{v} °C', 'effect.plague': 'virulens {v}', 'effect.meteor': 'dödsradie {v} m',
  'effect.currentShift': 'flöde {v} m/s', 'effect.longNight': 'ljus {v} %', 'effect.mutagen': 'mutation x{v}',
  'effect.cull': '{v} % bort', 'effect.bless': '+{v} % energi', 'effect.nutrientFlood': 'näring x{v}',
  'inspector.title': 'Granskare', 'inspector.none': 'Klicka på en varelse i akvariet för att granska den.',
  'inspector.overview': 'Översikt', 'inspector.genome': 'Arvsmassa', 'inspector.body': 'Kropp', 'inspector.brain': 'Hjärna', 'inspector.kin': 'Släkt',
  'inspector.energy': 'Energi', 'inspector.health': 'Hälsa', 'inspector.age': 'Ålder', 'inspector.generation': 'Generation',
  'inspector.stage': 'Stadium', 'inspector.adult': 'vuxen', 'inspector.juvenile': 'ung', 'inspector.length': 'Längd',
  'inspector.action': 'Gör', 'inspector.offspring': 'Avkomma',
  'inspector.follow': 'Följ', 'inspector.unfollow': 'Sluta följa', 'inspector.save': 'Spara arvsmassan i biblioteket',
  'inspector.fork': 'Kopiera till designern', 'inspector.bookmark': 'Bokmärk', 'inspector.bless': 'Välsigna',
  'inspector.onlyDiff': 'Visa bara skillnader', 'inspector.gene': 'Gen', 'inspector.value': 'Värde', 'inspector.founder': 'Standard',
  'inspector.brainLegend': 'Ljus = aktiv; streckad = negativ vikt; tjocklek = |w|.',
  'inspector.ancestors': 'Förfäder', 'inspector.children': 'Barn', 'inspector.collapsed': '… {n} generationer …',
  'inspector.founderOf': 'grundare', 'inspector.dead': 'död', 'inspector.alive': 'lever',
  'inspector.saved': 'Sparad i biblioteket.',
  'stats.title': 'Statistik', 'stats.population': 'Population', 'stats.phylogeny': 'Arternas släktträd',
  'stats.genes': 'Gener', 'stats.diversity': 'Mångfaldsindex', 'stats.foodWeb': 'Näringsväv',
  'stats.log': 'logaritmisk skala', 'stats.richness': 'Artrikedom', 'stats.shannon': 'Shannon H′',
  'stats.effective': 'Effektivt artantal exp(H′)', 'stats.simpson': 'Simpson 1 − Σp²', 'stats.time': 'Tid',
  'stats.species': 'Art', 'stats.count': 'Antal', 'stats.trait': 'Egenskap', 'stats.noData': 'Väntar på data…',
  'timeline.title': 'Tidslinje', 'timeline.god': 'gud', 'timeline.life': 'liv', 'timeline.death': 'död',
  'timeline.disease': 'sjukdom', 'timeline.records': 'rekord', 'timeline.now': 'nu',
  'timeline.rewindNearest': 'Spola tillbaka till närmaste ögonblicksbild före detta',
  'bookmarks.title': 'Bokmärken och tillbakaspolning', 'bookmarks.now': 'Bokmärk nu (Ctrl+B)', 'bookmarks.rewind': 'Spola tillbaka hit',
  'bookmarks.confirm': 'Alla vyer hoppar tillbaka till {when}. Nuet sparas som "Före tillbakaspolning".',
  'bookmarks.empty': 'Inga ögonblicksbilder än.', 'bookmarks.life': '{n} liv', 'bookmarks.species': '{n} arter',
  'bookmarks.kind.manual': 'manuell', 'bookmarks.kind.auto': 'auto', 'bookmarks.kind.beforePower': 'före kraft',
  'bookmarks.kind.beforeRewind': 'före tillbakaspolning', 'bookmarks.rewound': 'Tillbakaspolad till {when}.',
  'bookmarks.label': 'Bokmärke {n}',
  'designer.title': 'Designer', 'designer.genes': 'Gener', 'designer.parts': 'Delar', 'designer.undo': 'Ångra', 'designer.redo': 'Gör om',
  'designer.save': 'Spara', 'designer.share': 'Dela', 'designer.template': 'Mall', 'designer.instinct': 'startinstinkt, kan utvecklas',
  'designer.growth': 'Tillväxt', 'designer.play': 'Spela', 'designer.stop': 'Stoppa', 'designer.age': 'ålder {a}',
  'designer.testTank': 'Testakvarium', 'designer.reroll': 'Nytt frö', 'designer.toyTank': 'leksaksmodell tills simulatorns testakvarium finns',
  'designer.top': 'topp {v} KL/s', 'designer.cruise': 'marsch {v} KL/s', 'designer.cot': 'CoT {v}',
  'designer.energy': 'Energibudget (uppskattning)', 'designer.income': 'Intäkt', 'designer.costs': 'Kostnader',
  'designer.poor': 'fattigt', 'designer.typical': 'typiskt', 'designer.rich': 'rikt',
  'designer.breakEven': 'jämviktstäthet för föda: {v} (relativ)', 'designer.starves': 'Svälter efter {v}',
  'designer.adultIn': 'Vuxen efter {v}', 'designer.breeds': 'Förökar sig var {v}', 'designer.offspring': 'Avkomma under livet (typiskt): ~{v}',
  'designer.tradeoffs': 'Största avvägningar', 'designer.tradeoff': '{locus} +10 %: netto {net} %',
  'designer.issues': 'Varningar', 'designer.noIssues': 'Inga varningar.', 'designer.release': 'Släpp ut',
  'designer.releaseAnyway': 'Släpp ut ändå', 'designer.releaseLeviathan': 'Släpp ut som leviatan',
  'designer.eyesChip': 'Ögon: {n} (ändra under Delar)', 'designer.finsChip': 'Fenor: {n} (ändra under Delar)',
  'designer.palette': 'Lägg till del', 'designer.selected': 'Vald regel', 'designer.copies': '{n, plural, one {# kopia} other {# kopior}}',
  'designer.breakOut': 'Bryt ut den här kopian', 'designer.deleteRule': 'Ta bort regeln', 'designer.duplicate': 'Duplicera regeln',
  'designer.selectPart': 'Klicka på en del för att välja regeln som skapade den. Lägg sedan till delar på den från paletten.',
  'designer.symmetry': 'Symmetri', 'designer.sym.none': 'ingen', 'designer.sym.mirror': 'spegel', 'designer.sym.radial': 'radiell',
  'designer.dirty': 'osparad', 'designer.fingerprint': 'fp {fp}', 'designer.group.Advanced': 'Avancerat',
  'designer.name': 'Namn', 'designer.genus': 'Släkte', 'designer.epithet': 'Artepitet', 'designer.notes': 'Anteckningar',
  'designer.leviathanFlag': 'leviatan', 'designer.ceilingClamp': 'begränsas till {v} om den inte släpps ut som leviatan',
  'release.title': 'Släpp ut {name}', 'release.count': 'Hur många', 'release.where': 'Var', 'release.zone': 'zonen den föredrar: {zone}',
  'release.centre': 'mitten av akvariet', 'release.scatter': 'sprid över akvariet', 'release.protect': 'Skydd för grundare',
  'release.button': 'Släpp ut', 'release.anyway': 'Släpp ut ändå', 'release.done': 'Släppte ut {n} × {name}.',
  'release.leviathanTitle': 'Släpp ut {name} som leviatan',
  'release.leviathanNote': 'Sätter leviatanflaggan: släktlinjen får växa förbi världens storleksgräns. Världen tillför egen föda (8 × den vuxna massan per individ) och sparar först en ögonblicksbild automatiskt.',
  'release.leviathanHold': 'Håll för att släppa ut som leviatan',
  'library.title': 'Artbibliotek', 'library.search': 'Sök namn eller etikett…', 'library.import': 'Importera',
  'library.importHint': 'Släpp .ptkg-filer eller klistra in en PTK1-sträng var som helst i fönstret för att importera.',
  'library.edit': 'Redigera', 'library.share': 'Dela', 'library.download': 'Spara .ptkg-fil', 'library.delete': 'Ta bort',
  'library.template': 'mall', 'library.designed': 'designad', 'library.captured': 'fångad', 'library.imported': 'importerad',
  'library.empty': 'Inget här än.', 'library.paste': 'Klistra in en PTK1-sträng', 'library.importOk': 'Importerade {name}; öppnad i designerns förhandsvisning.',
  'library.importFail': 'Importen misslyckades: {reason}', 'library.added': 'La till {name} i biblioteket.',
  'library.exists': 'Finns redan i biblioteket.',
  'share.title': 'Dela {name}', 'share.copy': 'Kopiera strängen', 'share.copied': 'Kopierad.', 'share.chars': '{n} tecken',
  'share.qr': 'QR-kod', 'share.qrTooBig': 'För lång för en QR-kod; dela filen i stället.',
  'settings.title': 'Inställningar', 'settings.language': 'Språk', 'settings.reducedMotion': 'Minskad rörelse',
  'settings.captions': 'Bildtexter i skärmsläckaren och på tv',
  'issue.V01': 'Svälter även i rikt vatten.', 'issue.V02': 'Behöver rikare vatten än den här zonen brukar ha.',
  'issue.V03': 'Munnen kan inte äta det den vill äta.', 'issue.V04': 'Kan inte simma; den driver med strömmarna.',
  'issue.V05': 'Förökar sig bara genom parning, men du släpper ut en enda individ.',
  'issue.V06': 'Kan inte lagra tillräckligt med energi för ens en avkomma.', 'issue.V07': 'Hjärnan kan inte reagera på något än.',
  'issue.V09': 'Ingen zon i den här världen är varm eller kall nog.',
  'issue.V11': 'Felkatastrof trolig: avkomman blir ofta trasig.',
  'issue.V12': 'Pulsen dämpas på skärmen (säkerhetsgräns).',
  'issue.V13': 'Vuxenstorleken är över världens gräns: den begränsas om den inte släpps ut som leviatan.',
  'issue.V14': 'Ingen mun: den kan inte äta alls.',
  'sev.info': 'info', 'sev.warning': 'varning', 'sev.inviable': 'ej livsduglig',
  'part.0': 'Segment', 'part.1': 'Fena', 'part.2': 'Lem', 'part.3': 'Mun', 'part.4': 'Öga', 'part.5': 'Luktorgan',
  'part.6': 'Tagg', 'part.7': 'Ljusorgan', 'part.8': 'Flimmerhår', 'part.9': 'Jetorgan', 'part.10': 'Simblåsa', 'part.11': 'Körtel',
  'caption.hunt': '{species} · en jakt i {zone}', 'caption.speciation': '{species} har grenat ut sig från {parent}',
  'caption.extinction': '{species} har dött ut', 'caption.giant': '{species} · den största som lever',
  'caption.god': '{power} i {zone}', 'caption.release': 'Nyanlända: {species}',
  'caption.school': '{species} · ett stim samlas i {zone}', 'caption.massDeath': 'Massdöd i {zone}',
  'caption.frenzy': 'Ätarfrenesi i {zone}', 'caption.outbreak': 'Ett utbrott sprider sig i {zone}',
  'caption.record': '{species} · ett nytt rekord', 'caption.bloomFront': 'En blomning sprider sig genom {zone}',
  'caption.migration': '{species} · vandrar', 'caption.newRole': '{species} · ett nytt levnadssätt',
  'caption.speed': 'Tiden går {x} gånger fortare', 'caption.rewound': 'Tillbakaspolad till {when}',
  'event.birth': 'födsel', 'event.death': 'död', 'event.newSpecies': '{species} har grenat ut sig från {parent}',
  'event.extinct': '{species} har dött ut', 'event.god': '{power} utlöst', 'event.release': '{species} utsläppt ({n})',
  'event.giant': 'Jätte: {species}', 'event.hunt': 'Jakt av {species}', 'event.bookmark': 'Bokmärke: {label}',
  'event.outbreak': 'Utbrott', 'event.massDeath': 'Massdöd ({n})', 'event.record': 'Rekord: {kind}',
  'event.rewind': 'Tillbakaspolad till {when}', 'event.other': '{k}',
  'count.creatures': '{n, plural, one {# varelse} other {# varelser}}',
  'unit.days': '{v} d', 'unit.hours': '{v} h', 'unit.min': '{v} min', 'unit.s': '{v} s',
};

export const LOCALES = { en: EN as Record<MsgKey, string>, sv: SV } as const;
export type Locale = keyof typeof LOCALES;
const BCP47: Record<Locale, string> = { en: 'en-GB', sv: 'sv-SE' };

let current: Locale = 'en';
export const localeChanged = new Emitter<Locale>();

export function detectLocale(nav?: { language?: string }): Locale {
  const l = (nav?.language ?? '').toLowerCase();
  return l.startsWith('sv') ? 'sv' : 'en';
}
export function setLocale(l: Locale): void { if (l !== current) { current = l; localeChanged.emit(l); } }
export function getLocale(): Locale { return current; }
export function bcp47(): string { return BCP47[current]; }

export function fmtNum(v: number, maxDigits = 2, locale: Locale = current): string {
  return new Intl.NumberFormat(BCP47[locale], { maximumFractionDigits: maxDigits }).format(v);
}

type Vars = Record<string, string | number>;

/** Format one message: `{x}` slots and one level of `{n, plural, one {..} other {..}}`. */
export function format(msg: string, vars: Vars = {}, locale: Locale = current): string {
  let out = '';
  let i = 0;
  while (i < msg.length) {
    const c = msg[i]!;
    if (c !== '{') { out += c; i++; continue; }
    const end = matchBrace(msg, i);
    const body = msg.slice(i + 1, end);
    i = end + 1;
    const m = /^\s*(\w+)\s*,\s*plural\s*,(.*)$/s.exec(body);
    if (m) {
      const name = m[1]!;
      const n = Number(vars[name] ?? 0);
      const forms = parseForms(m[2]!);
      const cat = new Intl.PluralRules(BCP47[locale]).select(n);
      const form = forms[`=${n}`] ?? forms[cat] ?? forms.other ?? '';
      out += format(form, vars, locale).replace(/#/g, fmtNum(n, 2, locale));
    } else {
      const v = vars[body.trim()];
      out += v === undefined ? `{${body}}` : typeof v === 'number' ? fmtNum(v, 2, locale) : v;
    }
  }
  return out;
}
function matchBrace(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return j;
  }
  throw new Error(`unbalanced message: ${s}`);
}
function parseForms(s: string): Record<string, string> {
  const forms: Record<string, string> = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const kStart = i;
    while (i < s.length && s[i] !== '{' && !/\s/.test(s[i]!)) i++;
    const key = s.slice(kStart, i);
    while (i < s.length && s[i] !== '{') i++;
    const end = matchBrace(s, i);
    forms[key] = s.slice(i + 1, end);
    i = end + 1;
  }
  return forms;
}

export function t(key: MsgKey, vars?: Vars): string { return format(LOCALES[current][key] ?? EN[key], vars); }
/** Translate a key built at run time (power ids, part kinds); falls back to the key itself. */
export function tk(key: string, vars?: Vars): string {
  const m = (LOCALES[current] as Record<string, string>)[key] ?? (EN as Record<string, string>)[key];
  return m === undefined ? key : format(m, vars);
}

/** Durations in sim seconds, as d / h / min / s. */
export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '∞';
  if (s >= 86400) return t('unit.days', { v: Math.round((s / 86400) * 10) / 10 });
  if (s >= 3600) return t('unit.hours', { v: Math.round((s / 3600) * 10) / 10 });
  if (s >= 60) return t('unit.min', { v: Math.round(s / 60) });
  return t('unit.s', { v: Math.round(s) });
}
export function fmtLength(m: number): string {
  if (m >= 1) return `${fmtNum(m, 2)} m`;
  if (m >= 0.01) return `${fmtNum(m * 100, 1)} cm`;
  return `${fmtNum(m * 1000, 1)} mm`;
}
