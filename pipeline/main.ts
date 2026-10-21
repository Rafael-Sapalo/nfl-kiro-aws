/**
 * Open Windows pipeline: raw NGS tracking + PFF scouting -> small JSON files for the web demo.
 * Run: npm run pipeline   (expects the data repo cloned at ./nfl-big-data-bowl-regional-event-data)
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CURVE_BINS,
  PRIMARY_T,
  THRESHOLDS,
  type Association,
  type PlayerRow,
  type Pos,
  type PositionBaseline,
  type Rate,
  type ReplayEntity,
  type Spotlight,
  type SpotlightPlayer,
  type Summary,
  type ThresholdKey,
  type ThresholdStats,
  type ThresholdValidation,
} from '../shared/types.ts';
import { analyzePlay, dist, nearestCoverage, type AssociationCandidate, type PlayResult } from './analyze.ts';
import { loadDataset, playKey, type Dataset, type Game, type PlayInfo, type PlayRoles } from './load.ts';
import { readGameTracking, type PlayTrack, type Track } from './tracking.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DATA_DIR = process.env.NFL_DATA_DIR ?? join(ROOT, 'nfl-big-data-bowl-regional-event-data', 'data');
const OUT_DIR = join(ROOT, 'public', 'data');
const MIN_ROUTES = 100;
const SPOTLIGHT_TEAM = 'PIT';
const SPOTLIGHT_TEAM_NAME = 'Pittsburgh Steelers';
const SPOTLIGHT_MIN_ROUTES = 30;
const SPOTLIGHT_PLAYS = 12;
const T_KEYS = THRESHOLDS.map((t) => String(t) as ThresholdKey);
const PRIMARY_INDEX = T_KEYS.indexOf(PRIMARY_T);

// ---------- accumulators ----------
interface Acc {
  openAtSnap: number;
  early: number;
  onsets: number[];
  kmEvent: number[];
  kmCensor: number[];
  nowActive: Float64Array;
  nowOpen: Float64Array;
  buckets: string[];
}
interface Group {
  routes: number;
  teams: Map<string, number>;
  byT: Acc[];
}
const newAcc = (): Acc => ({
  openAtSnap: 0,
  early: 0,
  onsets: [],
  kmEvent: [],
  kmCensor: [],
  nowActive: new Float64Array(CURVE_BINS),
  nowOpen: new Float64Array(CURVE_BINS),
  buckets: [],
});
const newGroup = (): Group => ({ routes: 0, teams: new Map(), byT: THRESHOLDS.map(newAcc) });

const round = (v: number, d = 4): number => Math.round(v * 10 ** d) / 10 ** d;
const r2 = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const rate = (n: number, k: number): Rate => ({ n, rate: n > 0 ? round(k / n) : 0 });

/** Starting-cushion buckets (yards to nearest coverage defender at the snap). */
const CUSHION_EDGES = [1, 2, 3, 5, 8];
function bucketKey(align: string, cov: string, sepSnap: number): string {
  let cushion = CUSHION_EDGES.findIndex((e) => sepSnap < e);
  if (cushion === -1) cushion = CUSHION_EDGES.length;
  return `${align}|${cov}|${cushion}`;
}

/** Kaplan-Meier cumulative "has opened" curve; event/censor in frames after the snap. */
function kmCurve(event: number[], censor: number[]): number[] {
  const out = new Array<number>(CURVE_BINS).fill(0);
  let survival = 1;
  for (let k = 1; k < CURVE_BINS; k++) {
    let atRisk = 0;
    let events = 0;
    for (let i = 0; i < event.length; i++) {
      const time = event[i] >= 0 ? event[i] : censor[i];
      if (time >= k) atRisk++;
      if (event[i] === k) events++;
    }
    if (atRisk > 0) survival *= 1 - events / atRisk;
    out[k] = round(1 - survival);
  }
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return round(num / Math.sqrt(da * db), 3);
}

function addRoute(g: Group, res: PlayResult, ri: number, cov: string, team: string): void {
  const route = res.routes[ri];
  g.routes++;
  g.teams.set(team, (g.teams.get(team) ?? 0) + 1);
  route.byT.forEach((rt, ti) => {
    const acc = g.byT[ti];
    // "Open at the snap" = pre-existing cushion; tracked separately and never credited as a created window.
    if (!rt.covered) acc.openAtSnap++;
    if (rt.early) acc.early++;
    if (rt.onset !== null) acc.onsets.push(rt.onset);
    acc.kmEvent.push(rt.onset ?? -1);
    acc.kmCensor.push(rt.onset ?? rt.censor);
    for (let k = 0; k < rt.openNow.length; k++) {
      acc.nowActive[k]++;
      acc.nowOpen[k] += rt.openNow[k];
    }
    acc.buckets.push(bucketKey(route.align, cov, route.sepSnap));
  });
}

function findTarget(info: PlayInfo, roles: PlayRoles, ds: Dataset): number | null {
  if (!info.targetAbbr) return null;
  const hits = roles.routes.filter((r) => ds.players.get(r.nflId)?.abbr === info.targetAbbr);
  return hits.length === 1 ? hits[0].nflId : null;
}

// ---------- replay export for the spotlight ----------
function buildAssociation(
  pt: PlayTrack,
  info: PlayInfo,
  roles: PlayRoles,
  game: Game,
  res: PlayResult,
  c: AssociationCandidate,
  ds: Dataset,
): Association {
  const routeIds = new Set(roles.routes.map((r) => r.nflId));
  const covIds = new Set(roles.coverage);
  const rushIds = new Set(roles.rushers);
  const coverage = roles.coverage.map((id) => pt.tracks.get(id)).filter((t): t is Track => !!t);
  const frames = Array.from({ length: pt.nFrames }, (_, i) => i + 1);
  const series = (fn: (f: number) => number) => frames.map((f) => r2(fn(f)));
  const ref = (id: number, t: Track | undefined) => {
    const p = ds.players.get(id);
    return { nflId: id, name: p?.name ?? String(id), pos: p?.officialPos ?? '', jersey: t?.jersey ?? null };
  };
  const A = pt.tracks.get(c.aId)!;
  const B = pt.tracks.get(c.bId)!;
  const D = pt.tracks.get(c.dId)!;

  const entities: ReplayEntity[] = [];
  for (const t of pt.tracks.values()) {
    const id = t.nflId!;
    const side = t.team === info.offense ? 'off' : 'def';
    const p = ds.players.get(id);
    const role = routeIds.has(id)
      ? 'Route'
      : covIds.has(id)
        ? 'Coverage'
        : rushIds.has(id)
          ? 'Rush'
          : side === 'off'
            ? p?.officialPos === 'QB'
              ? 'Pass'
              : 'Block'
            : 'Def';
    entities.push({
      nflId: id,
      jersey: t.jersey,
      side,
      role,
      name: p?.name ?? '',
      x: frames.map((f) => r2(t.x[f] ?? Number.NaN)),
      y: frames.map((f) => r2(t.y[f] ?? Number.NaN)),
    });
  }
  if (pt.ball) {
    const ball = pt.ball;
    entities.push({
      nflId: null,
      jersey: null,
      side: 'ball',
      role: 'Ball',
      name: 'Ball',
      x: frames.map((f) => r2(ball.x[f] ?? Number.NaN)),
      y: frames.map((f) => r2(ball.y[f] ?? Number.NaN)),
    });
  }

  return {
    gameId: info.gameId,
    playId: info.playId,
    team: info.offense,
    opponent: info.defense,
    week: game.week,
    description: info.description,
    quarter: info.quarter,
    down: info.down,
    yardsToGo: info.yardsToGo,
    coverage: info.coverage,
    coverageType: info.coverageType,
    passResult: info.passResult,
    target: res.targetId === null ? 'none' : res.targetId === c.bId ? 'B' : res.targetId === c.aId ? 'A' : 'other',
    a: ref(c.aId, A),
    b: ref(c.bId, B),
    d: ref(c.dId, D),
    snapFrame: res.snap,
    endFrame: res.end,
    lastFrame: pt.nFrames,
    f0: c.f0,
    f1: c.f1,
    tOpen: c.tOpen,
    towardA: round(c.towardA, 2),
    awayFromB: round(c.awayFromB, 2),
    sepB: series((f) => nearestCoverage(B, coverage, f).d),
    sepA: series((f) => nearestCoverage(A, coverage, f).d),
    distDA: series((f) => dist(D, A, f)),
    distDB: series((f) => dist(D, B, f)),
    entities,
  };
}

// ---------- main ----------
function main(): void {
  const t0 = Date.now();
  const ds = loadDataset(DATA_DIR);
  console.log(`metadata: ${ds.games.size} games, ${ds.plays.size} plays, ${ds.players.size} players (${Date.now() - t0} ms)`);

  const playsByGame = new Map<number, PlayInfo[]>();
  for (const p of ds.plays.values()) {
    const list = playsByGame.get(p.gameId) ?? [];
    list.push(p);
    playsByGame.set(p.gameId, list);
  }

  const players = new Map<number, Group>();
  const positions = new Map<Pos, Group>();
  const bucketCounts = THRESHOLDS.map(() => new Map<string, { n: number; early: number }>());
  const val = THRESHOLDS.map(() => ({ tin: [0, 0], tout: [0, 0], early: [0, 0, 0], none: [0, 0, 0] }));
  let playsAnalyzed = 0;
  let routesAnalyzed = 0;
  let targetsMatched = 0;
  /** Snap-to-throw times (s) per offense, for the quick-release context in the spotlight. */
  const throwTimes = new Map<string, number[]>();

  const spotAssociations: { score: number; assoc: Association }[] = [];
  const drew = new Map<number, number>();
  const opened = new Map<number, number>();
  let spotRoutes = 0;

  const files = readdirSync(join(DATA_DIR, 'tracking')).filter((f) => /^tracking_\d+\.csv$/.test(f)).sort();
  files.forEach((file, i) => {
    const gameId = Number(file.match(/\d+/)![0]);
    const game = ds.games.get(gameId);
    if (!game) return;
    const tracking = readGameTracking(join(DATA_DIR, 'tracking', file));
    for (const info of playsByGame.get(gameId) ?? []) {
      const pt = tracking.get(info.playId);
      const roles = ds.roles.get(playKey(gameId, info.playId));
      if (!pt || !roles) continue;
      const targetId = findTarget(info, roles, ds);
      const res = analyzePlay(pt, info, roles, targetId);
      if (!res) continue;
      playsAnalyzed++;
      if (targetId !== null) targetsMatched++;
      if (res.isThrow) {
        const times = throwTimes.get(info.offense) ?? [];
        times.push((res.end - res.snap) / 10);
        throwTimes.set(info.offense, times);
      }

      res.routes.forEach((route, ri) => {
        const pos = ds.players.get(route.nflId)?.pos;
        if (!pos) return;
        routesAnalyzed++;
        if (!players.has(route.nflId)) players.set(route.nflId, newGroup());
        if (!positions.has(pos)) positions.set(pos, newGroup());
        addRoute(players.get(route.nflId)!, res, ri, info.coverageType, info.offense);
        addRoute(positions.get(pos)!, res, ri, info.coverageType, info.offense);
        route.byT.forEach((rt, ti) => {
          const key = bucketKey(route.align, info.coverageType, route.sepSnap);
          const b = bucketCounts[ti].get(key) ?? { n: 0, early: 0 };
          b.n++;
          if (rt.early) b.early++;
          bucketCounts[ti].set(key, b);
        });
      });

      THRESHOLDS.forEach((_, ti) => {
        const v = val[ti];
        const inWin = res.targetInWindow[ti];
        if (inWin !== null) {
          const bucket = inWin ? v.tin : v.tout;
          bucket[0]++;
          if (info.passResult === 'C') bucket[1]++;
        }
        const bucket = res.anyEarly[ti] ? v.early : v.none;
        bucket[0]++;
        if (info.passResult === 'S') bucket[1]++;
        if (roles.pressure) bucket[2]++;
      });

      if (info.offense === SPOTLIGHT_TEAM) {
        spotRoutes += res.routes.length;
        for (const c of res.associations) {
          drew.set(c.aId, (drew.get(c.aId) ?? 0) + 1);
          opened.set(c.bId, (opened.get(c.bId) ?? 0) + 1);
          spotAssociations.push({
            score: c.towardA + c.awayFromB,
            assoc: buildAssociation(pt, info, roles, game, res, c, ds),
          });
        }
      }
    }
    if ((i + 1) % 20 === 0 || i === files.length - 1) {
      console.log(`tracking: ${i + 1}/${files.length} games, ${playsAnalyzed} plays (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  });

  // ---------- league expected rates by alignment x coverage x cushion ----------
  const bucketRate = bucketCounts.map((m) => {
    const out = new Map<string, number>();
    for (const [k, b] of m) out.set(k, b.early / b.n);
    return out;
  });

  const stats = (g: Group, ti: number): ThresholdStats => {
    const acc = g.byT[ti];
    const ewr = g.routes ? acc.early / g.routes : 0;
    const expected = acc.buckets.length
      ? acc.buckets.reduce((s, k) => s + (bucketRate[ti].get(k) ?? 0), 0) / acc.buckets.length
      : 0;
    const med = median(acc.onsets);
    return {
      openAtSnapShare: round(acc.openAtSnap / Math.max(1, g.routes)),
      earlyWindows: acc.early,
      ewr: round(ewr),
      expected: round(expected),
      overExpected: round(ewr - expected),
      medianTimeToWindow: med === null ? null : round(med / 10, 2),
      curveOpened: kmCurve(acc.kmEvent, acc.kmCensor),
      // -1 = fewer than 10 routes still active at t (not enough data to plot).
      curveOpenNow: Array.from(acc.nowActive, (n, k) => (n >= 10 ? round(acc.nowOpen[k] / n) : -1)),
    };
  };
  const byT = (g: Group) => Object.fromEntries(T_KEYS.map((k, ti) => [k, stats(g, ti)])) as Record<ThresholdKey, ThresholdStats>;
  const mainTeam = (g: Group) => [...g.teams.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  const rows: PlayerRow[] = [];
  for (const [nflId, g] of players) {
    const p = ds.players.get(nflId)!;
    if (!p.pos || g.routes < MIN_ROUTES) continue;
    rows.push({ nflId, name: p.name, pos: p.pos, team: mainTeam(g), routes: g.routes, byT: byT(g) });
  }
  rows.sort((a, b) => b.byT[PRIMARY_T].overExpected - a.byT[PRIMARY_T].overExpected);

  const baselines: PositionBaseline[] = (['WR', 'TE', 'RB'] as Pos[]).map((pos) => {
    const g = positions.get(pos)!;
    const full = byT(g);
    return {
      pos,
      routes: g.routes,
      byT: Object.fromEntries(
        T_KEYS.map((k) => [
          k,
          {
            ewr: full[k].ewr,
            curveOpened: full[k].curveOpened,
            curveOpenNow: full[k].curveOpenNow,
            openAtSnapShare: full[k].openAtSnapShare,
            medianTimeToWindow: full[k].medianTimeToWindow,
          },
        ]),
      ) as PositionBaseline['byT'],
    };
  });

  const validation = Object.fromEntries(
    T_KEYS.map((k, ti) => {
      const v = val[ti];
      const out: ThresholdValidation = {
        targetInWindow: rate(v.tin[0], v.tin[1]),
        targetNotInWindow: rate(v.tout[0], v.tout[1]),
        earlyWindowPlaysSack: rate(v.early[0], v.early[1]),
        noEarlyWindowPlaysSack: rate(v.none[0], v.none[1]),
        earlyWindowPlaysPressure: rate(v.early[0], v.early[2]),
        noEarlyWindowPlaysPressure: rate(v.none[0], v.none[2]),
      };
      return [k, out];
    }),
  ) as Record<ThresholdKey, ThresholdValidation>;

  const oe = (k: ThresholdKey) => rows.map((r) => r.byT[k].overExpected);
  const sensitivity = [
    { pair: '2 vs 2.5 yd', spearman: spearman(oe('2'), oe('2.5')) },
    { pair: '2.5 vs 3 yd', spearman: spearman(oe('2.5'), oe('3')) },
    { pair: '2 vs 3 yd', spearman: spearman(oe('2'), oe('3')) },
  ];

  const summary: Summary = {
    games: files.length,
    plays: playsAnalyzed,
    routes: routesAnalyzed,
    qualifiedPlayers: rows.length,
    minRoutes: MIN_ROUTES,
    targetsMatched,
    validation,
    sensitivity,
    generatedAt: new Date().toISOString(),
  };

  // ---------- spotlight team ----------
  const teamTimeToThrow = [...throwTimes.entries()]
    .map(([team, times]) => ({ team, med: median(times) ?? 0 }))
    .sort((a, b) => a.med - b.med);
  const spotPlayers: SpotlightPlayer[] = [];
  for (const [nflId, g] of players) {
    const p = ds.players.get(nflId)!;
    if (!p.pos || mainTeam(g) !== SPOTLIGHT_TEAM || g.routes < SPOTLIGHT_MIN_ROUTES) continue;
    const s = stats(g, PRIMARY_INDEX);
    const d = drew.get(nflId) ?? 0;
    spotPlayers.push({
      nflId,
      name: p.name,
      pos: p.pos,
      routes: g.routes,
      drewForTeammate: d,
      openedAfterTeammateDrew: opened.get(nflId) ?? 0,
      drewPer100: round((100 * d) / g.routes, 2),
      ewr: s.ewr,
      overExpected: s.overExpected,
    });
  }
  spotPlayers.sort((a, b) => b.drewPer100 - a.drewPer100);
  const seen = new Set<string>();
  // Show the clearest stories first: completed passes to B, then any throw to B, then the strongest shifts.
  const priority = (a: Association) => (a.target === 'B' ? (a.passResult === 'C' ? 2 : 1) : 0);
  const topPlays = spotAssociations
    .sort((a, b) => priority(b.assoc) - priority(a.assoc) || b.score - a.score)
    .filter(({ assoc }) => {
      const k = `${assoc.gameId}-${assoc.playId}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, SPOTLIGHT_PLAYS)
    .map((x) => x.assoc);
  const spotlight: Spotlight = {
    team: SPOTLIGHT_TEAM,
    teamName: SPOTLIGHT_TEAM_NAME,
    threshold: PRIMARY_T,
    teamRoutes: spotRoutes,
    associations: spotAssociations.length,
    medianTimeToThrow: round(median(throwTimes.get(SPOTLIGHT_TEAM) ?? []) ?? 0, 2),
    leagueMedianTimeToThrow: round(median([...throwTimes.values()].flat()) ?? 0, 2),
    timeToThrowRank: teamTimeToThrow.findIndex((t) => t.team === SPOTLIGHT_TEAM) + 1,
    teamCount: teamTimeToThrow.length,
    players: spotPlayers,
    plays: topPlays,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, data: unknown) => writeFileSync(join(OUT_DIR, name), JSON.stringify(data));
  write('players.json', rows);
  write('baselines.json', baselines);
  write('summary.json', summary);
  write('spotlight.json', spotlight);

  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${rows.length} qualified players, ${spotAssociations.length} ${SPOTLIGHT_TEAM} associations`);
  console.log(JSON.stringify({ validation: validation[PRIMARY_T], sensitivity }, null, 1));
}

main();
