import { CURVE_BINS, EARLY_FRAMES, PERSIST_FRAMES, THRESHOLDS } from '../shared/types.ts';
import type { Align, PlayInfo, PlayRoles } from './load.ts';
import type { PlayTrack, Track } from './tracking.ts';

const SNAP_EVENTS = new Set(['ball_snap', 'autoevent_ballsnap']);
/** Anything that ends the passing phase: throw, sack, scramble, fumble, handoff... */
const END_EVENTS = new Set([
  'pass_forward',
  'autoevent_passforward',
  'pass_shovel',
  'qb_sack',
  'qb_strip_sack',
  'run',
  'fumble',
  'handoff',
  'lateral',
  'autoevent_passinterrupted',
]);
const THROW_EVENTS = new Set(['pass_forward', 'autoevent_passforward', 'pass_shovel']);

/** Look-back for the teammate association (1.0 s before the window opens). */
const LOOKBACK_FRAMES = 10;
/** The defender must be B's nearest coverage defender and within this distance at the start of the look-back. */
const MAX_DIST_ON_B = 7;
/** The defender must move at least this far toward A, and away from B. */
const MIN_SHIFT = 1;
/** The defender must end up within this distance of A (distance limit, not just "nearest to someone"). */
const MAX_DIST_TO_A = 12;

export interface RouteThreshold {
  covered: boolean;
  /** Frames after the snap at which a new window opened (covered -> open, held 0.3 s), or null. */
  onset: number | null;
  /** Last frame offset at which an onset could still be confirmed (censoring time). */
  censor: number;
  early: boolean;
  /** Per 0.1 s bin from the snap: 1 if inside a window, 0 if not (only active bins). */
  openNow: Uint8Array;
}

export interface RouteResult {
  nflId: number;
  align: Align;
  sepSnap: number;
  byT: RouteThreshold[];
}

export interface AssociationCandidate {
  aId: number;
  bId: number;
  dId: number;
  f0: number;
  f1: number;
  tOpen: number;
  towardA: number;
  awayFromB: number;
}

export interface PlayResult {
  snap: number;
  end: number;
  isThrow: boolean;
  routes: RouteResult[];
  targetId: number | null;
  /** Per threshold: was the targeted receiver inside a window at release? (null when not a targeted throw) */
  targetInWindow: (boolean | null)[];
  anyEarly: boolean[];
  associations: AssociationCandidate[];
}

const val = (arr: number[], f: number): number => arr[f] ?? Number.NaN;

export function dist(a: Track, b: Track, f: number): number {
  return Math.hypot(val(a.x, f) - val(b.x, f), val(a.y, f) - val(b.y, f));
}

/** Distance from a track to the nearest coverage defender at frame f. */
export function nearestCoverage(t: Track, coverage: Track[], f: number): { d: number; id: number | null } {
  let best = Number.POSITIVE_INFINITY;
  let id: number | null = null;
  for (const c of coverage) {
    const d = dist(t, c, f);
    if (d < best) {
      best = d;
      id = c.nflId;
    }
  }
  return { d: Number.isFinite(best) ? best : Number.NaN, id };
}

export function findSnap(pt: PlayTrack): number | null {
  let snap: number | null = null;
  for (const [f, ev] of pt.events) if (SNAP_EVENTS.has(ev) && (snap === null || f < snap)) snap = f;
  return snap;
}

function findEnd(pt: PlayTrack, snap: number): { end: number; isThrow: boolean } {
  let end: number | null = null;
  let isThrow = false;
  for (const [f, ev] of pt.events) {
    if (f > snap && END_EVENTS.has(ev) && (end === null || f < end)) {
      end = f;
      isThrow = THROW_EVENTS.has(ev);
    }
  }
  // Fallback: tracking always stops 5 frames after the end of the passing phase.
  if (end === null) end = Math.max(snap + PERSIST_FRAMES, pt.nFrames - 5);
  return { end, isThrow };
}

/**
 * Window detection for one separation series (index 0 = snap).
 * - onset: first k where sep[k-1] < T and sep[k..k+2] >= T  (a *new* window, held 0.3 s)
 * - openNow: k is inside any run of >= 3 consecutive frames with sep >= T
 */
function windows(sep: Float64Array, T: number) {
  const n = sep.length;
  const open = new Uint8Array(n);
  let runStart = -1;
  for (let k = 0; k <= n; k++) {
    const ok = k < n && sep[k] >= T;
    if (ok && runStart === -1) runStart = k;
    if (!ok && runStart !== -1) {
      if (k - runStart >= PERSIST_FRAMES) for (let j = runStart; j < k; j++) open[j] = 1;
      runStart = -1;
    }
  }
  let onset: number | null = null;
  for (let k = 1; k + PERSIST_FRAMES - 1 < n; k++) {
    if (sep[k - 1] < T && open[k] === 1) {
      onset = k;
      break;
    }
  }
  return { open, onset };
}

export function analyzePlay(
  pt: PlayTrack,
  info: PlayInfo,
  roles: PlayRoles,
  targetId: number | null,
): PlayResult | null {
  const snap = findSnap(pt);
  if (snap === null) return null;
  const { end, isThrow } = findEnd(pt, snap);
  const span = end - snap; // frames in the passing phase after the snap
  if (span < PERSIST_FRAMES) return null;

  const coverage = roles.coverage.map((id) => pt.tracks.get(id)).filter((t): t is Track => !!t);
  if (coverage.length === 0) return null;

  const runners = roles.routes
    .map((r) => ({ r, t: pt.tracks.get(r.nflId) }))
    .filter((x): x is { r: (typeof roles.routes)[number]; t: Track } => !!x.t);

  const routes: RouteResult[] = [];
  const onsetAtPrimary = new Map<number, number>();
  const anyEarly = THRESHOLDS.map(() => false);
  const targetInWindow: (boolean | null)[] = THRESHOLDS.map(() => null);

  for (const { r, t } of runners) {
    const sep = new Float64Array(span + 1);
    for (let k = 0; k <= span; k++) sep[k] = nearestCoverage(t, coverage, snap + k).d;
    if (!Number.isFinite(sep[0])) continue;

    const byT: RouteThreshold[] = THRESHOLDS.map((T, ti) => {
      const { open, onset } = windows(sep, T);
      const covered = sep[0] < T;
      // A window only counts if it is NEW (covered -> open). Pre-existing cushion at the snap never counts.
      const early = onset !== null && onset <= EARLY_FRAMES;
      if (early) anyEarly[ti] = true;
      if (ti === 1 && onset !== null) onsetAtPrimary.set(r.nflId, onset);
      if (targetId === r.nflId && isThrow && ['C', 'I', 'IN'].includes(info.passResult)) {
        targetInWindow[ti] = open[span] === 1;
      }
      const bins = Math.min(span, CURVE_BINS - 1) + 1;
      return {
        covered,
        onset,
        censor: span - (PERSIST_FRAMES - 1),
        early,
        openNow: open.slice(0, bins),
      };
    });
    routes.push({ nflId: r.nflId, align: r.align, sepSnap: sep[0], byT });
  }

  // Teammate association at the headline threshold (2.5 yd):
  // a coverage defender who was on B moves toward A and away from B, then B's window opens.
  const associations: AssociationCandidate[] = [];
  for (const [bId, onset] of onsetAtPrimary) {
    const B = pt.tracks.get(bId);
    if (!B) continue;
    const f1 = snap + onset;
    const f0 = Math.max(snap, f1 - LOOKBACK_FRAMES);
    const near = nearestCoverage(B, coverage, f0);
    if (near.id === null || !(near.d <= MAX_DIST_ON_B)) continue;
    const D = pt.tracks.get(near.id);
    if (!D) continue;
    const awayFromB = dist(D, B, f1) - dist(D, B, f0);
    if (!(awayFromB >= MIN_SHIFT)) continue;
    const dx = val(D.x, f1) - val(D.x, f0);
    const dy = val(D.y, f1) - val(D.y, f0);

    let best: AssociationCandidate | null = null;
    for (const { r, t: A } of runners) {
      if (r.nflId === bId) continue;
      const ux = val(A.x, f0) - val(D.x, f0);
      const uy = val(A.y, f0) - val(D.y, f0);
      const len = Math.hypot(ux, uy);
      if (!(len > 0)) continue;
      const towardA = (dx * ux + dy * uy) / len;
      const dA1 = dist(D, A, f1);
      if (towardA >= MIN_SHIFT && dA1 <= MAX_DIST_TO_A) {
        if (!best || towardA > best.towardA) {
          best = { aId: r.nflId, bId, dId: near.id, f0, f1, tOpen: onset / 10, towardA, awayFromB };
        }
      }
    }
    if (best) associations.push(best);
  }

  return { snap, end, isThrow, routes, targetId, targetInWindow, anyEarly, associations };
}
