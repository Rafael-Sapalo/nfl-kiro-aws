import './style.css';
import {
  PRIMARY_T,
  THRESHOLDS,
  type PlayerRow,
  type Pos,
  type PositionBaseline,
  type Spotlight,
  type Summary,
  type ThresholdKey,
} from '../shared/types.ts';
import { renderCurves } from './curves.ts';
import { renderBoard } from './leaderboard.ts';
import { initSpotlight } from './replay.ts';

const COLORS = ['#e4572e', '#2e86ab', '#7b2cbf'];
const DEFAULT_PLAYERS = ['Deebo Samuel', 'Mark Andrews', 'Diontae Johnson'];
const TOP_N = 12;

type PosFilter = Pos | 'ALL';
interface State {
  T: ThresholdKey;
  pos: PosFilter;
  selected: number[];
  search: string;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pct = (v: number) => `${Math.round(v * 100)}%`;

async function load<T>(name: string): Promise<T> {
  const res = await fetch(`data/${name}`);
  if (!res.ok) throw new Error(`Could not load data/${name} (${res.status}). Run "npm run pipeline" first.`);
  return (await res.json()) as T;
}

function segmented<V extends string>(container: HTMLElement, options: { value: V; label: string }[], current: V, onPick: (v: V) => void) {
  container.replaceChildren(
    ...options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', String(o.value === current));
      b.addEventListener('click', () => onPick(o.value));
      return b;
    }),
  );
}

function kpi(value: string, label: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'kpi';
  const v = document.createElement('div');
  v.className = 'kpi-value';
  v.textContent = value;
  const l = document.createElement('div');
  l.className = 'kpi-label';
  l.textContent = label;
  d.append(v, l);
  return d;
}

async function main() {
  const [players, baselines, summary, spotlight] = await Promise.all([
    load<PlayerRow[]>('players.json'),
    load<PositionBaseline[]>('baselines.json'),
    load<Summary>('summary.json'),
    load<Spotlight>('spotlight.json'),
  ]);
  const byId = new Map(players.map((p) => [p.nflId, p]));
  const defaults = DEFAULT_PLAYERS.map((n) => players.find((p) => p.name === n)?.nflId).filter((id): id is number => id !== undefined);
  const state: State = { T: PRIMARY_T, pos: 'ALL', selected: defaults.length ? defaults : players.slice(0, 2).map((p) => p.nflId), search: '' };

  const colorOf = (id: number) => {
    const i = state.selected.indexOf(id);
    return i === -1 ? null : COLORS[i];
  };
  const toggle = (id: number) => {
    const i = state.selected.indexOf(id);
    if (i !== -1) state.selected.splice(i, 1);
    else {
      if (state.selected.length >= COLORS.length) state.selected.shift();
      state.selected.push(id);
    }
    render();
  };

  const render = () => {
    const T = state.T;
    const v = summary.validation[T];
    const wr = baselines.find((b) => b.pos === 'WR')!.byT[T];
    const sens = summary.sensitivity;
    $('kpis').replaceChildren(
      kpi(`${pct(v.targetInWindow.rate)} vs ${pct(v.targetNotInWindow.rate)}`, `completion when the target was inside a ${T} yd window at release vs not (${(v.targetInWindow.n + v.targetNotInWindow.n).toLocaleString('en-US')} targets)`),
      kpi(pct(wr.openAtSnapShare), `of WR routes already have ≥ ${T} yd of cushion at the snap. We only credit NEW windows`),
      kpi(`${wr.medianTimeToWindow?.toFixed(1) ?? 'n/a'} s`, 'median time for a WR to create a new window'),
      kpi(`ρ ${sens[0].spearman} / ${sens[1].spearman}`, 'rank stability of the metric, 2↔2.5 yd and 2.5↔3 yd'),
      kpi(summary.routes.toLocaleString('en-US'), `routes analysed across ${summary.plays.toLocaleString('en-US')} dropbacks`),
    );

    segmented($('threshold'), THRESHOLDS.map((t) => ({ value: String(t) as ThresholdKey, label: `${t} yd` })), T, (t) => {
      state.T = t;
      render();
    });
    segmented<PosFilter>(
      $('position'),
      [
        { value: 'ALL', label: 'All' },
        { value: 'WR', label: 'WR' },
        { value: 'TE', label: 'TE' },
        { value: 'RB', label: 'RB' },
      ],
      state.pos,
      (p) => {
        state.pos = p;
        render();
      },
    );

    const pool = players
      .filter((p) => state.pos === 'ALL' || p.pos === state.pos)
      .sort((a, b) => b.byT[T].overExpected - a.byT[T].overExpected);
    const rankOf = new Map(pool.map((p, i) => [p.nflId, i + 1]));
    const q = state.search.trim().toLowerCase();
    const shown = q ? pool.filter((p) => p.name.toLowerCase().includes(q) || p.team.toLowerCase() === q).slice(0, 20) : pool.slice(0, TOP_N);
    renderBoard($('board'), shown, rankOf, T, colorOf, toggle);
    $('board-note').textContent =
      `${pool.length} qualified players (≥ ${summary.minRoutes} routes). ${q ? `${shown.length} match "${state.search}".` : `Showing the top ${TOP_N}. Search to find anyone.`}` +
      (state.pos === 'RB' ? ' RBs start in the backfield with big cushions, so few of their windows are new; compare their dashed curves.' : '');

    const selected = state.selected
      .map((id) => byId.get(id))
      .filter((p): p is PlayerRow => !!p)
      .map((row) => ({ row, color: colorOf(row.nflId)! }));
    renderCurves($('curves'), $('curve-legend'), selected, baselines, T);
  };

  $<HTMLInputElement>('search').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value;
    render();
  });

  render();
  initSpotlight(spotlight, {
    intro: $('spot-intro'),
    list: $('plays'),
    table: $('spot-table'),
    field: $('field'),
    play: $<HTMLButtonElement>('play'),
    scrub: $<HTMLInputElement>('scrub'),
    clock: $('clock'),
    dist: $('dist-chart'),
    desc: $('play-desc'),
  });
}

main().catch((err: unknown) => {
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.textContent = err instanceof Error ? err.message : String(err);
  document.querySelector('main')?.prepend(msg);
});
