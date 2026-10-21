// Data contract between the Node pipeline (pipeline/) and the web demo (src/).
// Every JSON file in public/data/ follows one of these shapes.

export type Pos = 'WR' | 'TE' | 'RB';

/** Separation thresholds (yards) used for the sensitivity check. 2.5 is the headline value. */
export const THRESHOLDS = [2, 2.5, 3] as const;
export type ThresholdKey = '2' | '2.5' | '3';
export const PRIMARY_T: ThresholdKey = '2.5';

/** A window must hold for this many consecutive frames (10 Hz => 0.3 s). */
export const PERSIST_FRAMES = 3;
/** "Early" deadline in frames after the snap (2.5 s). */
export const EARLY_FRAMES = 25;
/** Curves are sampled every 0.1 s from 0 to 4.0 s. */
export const CURVE_BINS = 41;

export interface ThresholdStats {
  /** Share of routes that already had >= T yards of cushion at the snap (pre-existing, never credited). */
  openAtSnapShare: number;
  /** Routes that created a NEW window (covered -> open, held 0.3 s) before min(2.5 s, end of passing phase). */
  earlyWindows: number;
  /** Early Window Rate = earlyWindows / routes. */
  ewr: number;
  /** League rate for routes with the same alignment, coverage type and starting cushion. */
  expected: number;
  /** ewr - expected (share, not percentage points). */
  overExpected: number;
  /** Median seconds from snap to a created window, among routes that created one. */
  medianTimeToWindow: number | null;
  /** Kaplan-Meier: share of routes that have created a window at least once by t (censored at end of passing phase). */
  curveOpened: number[];
  /** Share of still-active routes that are currently inside a window at t (created or pre-existing). */
  curveOpenNow: number[];
}

export interface PlayerRow {
  nflId: number;
  name: string;
  pos: Pos;
  team: string;
  routes: number;
  byT: Record<ThresholdKey, ThresholdStats>;
}

export interface PositionBaseline {
  pos: Pos;
  routes: number;
  byT: Record<ThresholdKey, Pick<ThresholdStats, 'ewr' | 'curveOpened' | 'curveOpenNow' | 'openAtSnapShare' | 'medianTimeToWindow'>>;
}

export interface Rate {
  n: number;
  rate: number;
}

export interface ThresholdValidation {
  /** Completion rate on throws to the parsed target, split by whether he was inside a window at release. */
  targetInWindow: Rate;
  targetNotInWindow: Rate;
  /** Sack / pressure rates on plays where at least one route runner created an early window, vs none. */
  earlyWindowPlaysSack: Rate;
  noEarlyWindowPlaysSack: Rate;
  earlyWindowPlaysPressure: Rate;
  noEarlyWindowPlaysPressure: Rate;
}

export interface Summary {
  games: number;
  plays: number;
  routes: number;
  qualifiedPlayers: number;
  minRoutes: number;
  targetsMatched: number;
  validation: Record<ThresholdKey, ThresholdValidation>;
  /** Spearman rank correlation of overExpected between thresholds (qualified players). */
  sensitivity: { pair: string; spearman: number }[];
  generatedAt: string;
}

export interface ReplayEntity {
  nflId: number | null;
  jersey: number | null;
  side: 'off' | 'def' | 'ball';
  role: string;
  name: string;
  /** Normalised coordinates (offense moves left -> right), one value per frame (index 0 = frameId 1). */
  x: (number | null)[];
  y: (number | null)[];
}

export interface PlayerRef {
  nflId: number;
  name: string;
  pos: string;
  jersey: number | null;
}

export interface Association {
  gameId: number;
  playId: number;
  team: string;
  opponent: string;
  week: number;
  description: string;
  quarter: number;
  down: number;
  yardsToGo: number;
  coverage: string;
  coverageType: string;
  passResult: string;
  /** Receiver whose route the defender moved toward. */
  a: PlayerRef;
  /** Receiver whose window opened afterwards. */
  b: PlayerRef;
  /** Coverage defender who shifted from B toward A. */
  d: PlayerRef;
  snapFrame: number;
  endFrame: number;
  lastFrame: number;
  /** Look-back start and window onset (frameIds). */
  f0: number;
  f1: number;
  tOpen: number;
  towardA: number;
  awayFromB: number;
  /** Per-frame series (index 0 = frameId 1). */
  sepB: (number | null)[];
  sepA: (number | null)[];
  distDA: (number | null)[];
  distDB: (number | null)[];
  entities: ReplayEntity[];
}

export interface SpotlightPlayer {
  nflId: number;
  name: string;
  pos: Pos;
  routes: number;
  /** Times this player's route drew a defender away from a teammate who then opened. */
  drewForTeammate: number;
  /** Times this player opened after a defender shifted toward a teammate. */
  openedAfterTeammateDrew: number;
  drewPer100: number;
  ewr: number;
  overExpected: number;
}

export interface Spotlight {
  team: string;
  teamName: string;
  threshold: ThresholdKey;
  teamRoutes: number;
  associations: number;
  players: SpotlightPlayer[];
  plays: Association[];
}
