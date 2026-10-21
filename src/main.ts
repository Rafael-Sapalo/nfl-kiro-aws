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
  showNow: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const pp = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pp`;
const short = (name: string) => {
  const parts = name.split(' ');
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
};

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

function kpi(value: string, label: string, variant?: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'kpi';
  const v = document.createElement('div');
  v.className = variant ? `kpi-value ${variant}` : 'kpi-value';
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
  const state: State = {
    T: PRIMARY_T,
    pos: 'ALL',
    selected: defaults.length ? defaults : players.slice(0, 2).map((p) => p.nflId),
    search: '',
    showNow: false,
  };

  const colorOf = (id: number) => {
    const i = state.selected.indexOf(id);
    return i === -1 ? null : COLORS[i];
  };

  /** Plain-language headline numbers; they follow the selected threshold. */
  const renderKpis = (T: ThresholdKey) => {
    const v = summary.validation[T];
    const wr = baselines.find((b) => b.pos === 'WR')!.byT[T];
    const best = (pos: Pos) =>
      players.filter((p) => p.pos === pos).reduce((a, b) => (b.byT[T].overExpected > a.byT[T].overExpected ? b : a));
    const topWR = best('WR');
    const topTE = best('TE');
    const [s1, s2] = summary.sensitivity;
    $('kpis').replaceChildren(
      kpi(
        `${pct(v.targetInWindow.rate)} vs ${pct(v.targetNotInWindow.rate)}`,
        `completion rate when the target was inside a ${T} yd window at the throw vs not (${(v.targetInWindow.n + v.targetNotInWindow.n).toLocaleString('en-US')} targets)`,
      ),
      kpi(pct(wr.openAtSnapShare), `of WR routes already have ${T} yd of cushion at the snap, so only new windows count`),
      kpi(
        `${short(topWR.name)} · ${short(topTE.name)}`,
        `best WR and TE at creating new windows: ${pp(topWR.byT[T].overExpected)} and ${pp(topTE.byT[T].overExpected)} over expected`,
        'names',
      ),
      kpi(`${s1.spearman} / ${s2.spearman}`, 'rank correlation of the leaderboard between 2 ↔ 2.5 yd and 2.5 ↔ 3 yd: the order holds'),
      kpi(summary.routes.toLocaleString('en-US'), `routes from ${summary.plays.toLocaleString('en-US')} dropbacks in ${summary.games} games`),
    );
  };

  /** Removable chips for the players being compared, so they stay visible even when not in the top 12. */
  const renderCompare = (selected: { row: PlayerRow; color: string }[]) => {
    const label = document.createElement('span');
    label.className = 'compare-label';
    label.textContent = selected.length ? 'Comparing' : 'Click players in the leaderboard to compare (up to 3)';
    const chips = selected.map(({ row, color }) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'compare-chip';
      chip.style.setProperty('--c', color);
      chip.title = `Remove ${row.name}`;
      chip.setAttribute('aria-label', `Remove ${row.name} from the comparison`);
      const dot = document.createElement('span');
      dot.className = 'dot';
      const name = document.createElement('span');
      name.textContent = `${row.name} · ${row.pos}`;
      const x = document.createElement('span');
      x.className = 'x';
      x.setAttribute('aria-hidden', 'true');
      x.textContent = '×';
      chip.append(dot, name, x);
      chip.addEventListener('click', () => toggle(row.nflId, false));
      return chip;
    });
    $('compare').replaceChildren(label, ...chips);
  };

  const render = () => {
    const T = state.T;
    renderKpis(T);

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
    renderBoard($('board'), shown, rankOf, T, colorOf, (id) => toggle(id, true));
    $('board-note').textContent =
      `${pool.length} qualified players (≥ ${summary.minRoutes} routes). ${q ? `${shown.length} match "${state.search}".` : `Showing the top ${TOP_N}. Search to find anyone.`}` +
      (state.pos === 'RB' ? ' RBs start in the backfield with big cushions, so few of their windows are new. Turn on “currently open” to compare them.' : '');

    const selected = state.selected
      .map((id) => byId.get(id))
      .filter((p): p is PlayerRow => !!p)
      .map((row) => ({ row, color: colorOf(row.nflId)! }));
    renderCompare(selected);
    renderCurves($('curves'), $('curve-legend'), selected, baselines, T, state.showNow);
  };

  const toggle = (id: number, refocus: boolean) => {
    const i = state.selected.indexOf(id);
    if (i !== -1) state.selected.splice(i, 1);
    else {
      if (state.selected.length >= COLORS.length) state.selected.shift();
      state.selected.push(id);
    }
    render();
    // Keep keyboard focus on the row that was toggled (the table is re-rendered).
    if (refocus) $('board').querySelector<HTMLElement>(`tr[data-id="${id}"]`)?.focus();
  };

  $<HTMLInputElement>('search').addEventListener('input', (e) => {
    state.search = (e.target as HTMLInputElement).value;
    render();
  });
  const showNow = $<HTMLInputElement>('show-now');
  showNow.checked = state.showNow;
  showNow.addEventListener('change', () => {
    state.showNow = showNow.checked;
    render();
  });

  render();
  initSpotlight(spotlight, {
    intro: $('spot-intro'),
    list: $('plays'),
    table: $('spot-table'),
    field: $('field'),
    play: $<HTMLButtonElement>('play'),
    prev: $<HTMLButtonElement>('prev'),
    next: $<HTMLButtonElement>('next'),
    jump: $<HTMLButtonElement>('jump'),
    speed: $('speed'),
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
