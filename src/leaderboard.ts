import type { PlayerRow, ThresholdKey } from '../shared/types.ts';

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const pp = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)} pp`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Ranked table with a diverging "vs expected" bar. Rows are toggle buttons for the curve comparison. */
export function renderBoard(
  container: HTMLElement,
  rows: PlayerRow[],
  rankOf: Map<number, number>,
  T: ThresholdKey,
  colorOf: (nflId: number) => string | null,
  onToggle: (nflId: number) => void,
): void {
  container.replaceChildren();
  if (rows.length === 0) {
    container.append(el('p', 'note', 'No qualified player matches this filter.'));
    return;
  }
  const maxAbs = Math.max(0.05, ...rows.map((r) => Math.abs(r.byT[T].overExpected)));

  const table = el('table', 'board');
  const head = el('tr');
  for (const [label, cls] of [
    ['#', 'num'],
    ['Player', ''],
    ['Routes', 'num'],
    ['EWR', 'num'],
    ['Exp.', 'num'],
    ['vs expected', 'bar-col'],
  ] as const) {
    const th = el('th', cls, label);
    th.scope = 'col';
    head.append(th);
  }
  table.append(el('thead'), el('tbody'));
  table.tHead!.append(head);

  for (const r of rows) {
    const s = r.byT[T];
    const color = colorOf(r.nflId);
    const tr = el('tr', color ? 'selected' : '');
    tr.tabIndex = 0;
    tr.setAttribute('role', 'button');
    tr.setAttribute('aria-pressed', String(!!color));
    tr.setAttribute('aria-label', `${r.name}, ${r.pos}, ${r.team}: ${pp(s.overExpected)} versus expected. Toggle comparison.`);
    if (color) tr.style.setProperty('--sel', color);

    tr.append(el('td', 'num rank', String(rankOf.get(r.nflId) ?? '')));
    const who = el('td', 'who');
    const chip = el('span', 'chip');
    if (color) chip.style.background = color;
    who.append(chip, el('span', 'name', r.name), el('span', 'meta', ` ${r.team} · ${r.pos}`));
    tr.append(who);
    tr.append(el('td', 'num', String(r.routes)));
    tr.append(el('td', 'num', pct(s.ewr)));
    tr.append(el('td', 'num muted', pct(s.expected)));

    const barCell = el('td', 'bar-col');
    const track = el('div', 'bar-track');
    const bar = el('div', s.overExpected >= 0 ? 'bar pos' : 'bar neg');
    const w = (Math.abs(s.overExpected) / maxAbs) * 50;
    bar.style.width = `${w}%`;
    bar.style.left = s.overExpected >= 0 ? '50%' : `${50 - w}%`;
    track.append(bar);
    barCell.append(track, el('span', 'bar-label', pp(s.overExpected)));
    tr.append(barCell);

    const toggle = () => onToggle(r.nflId);
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    table.tBodies[0].append(tr);
  }
  container.append(table);
}
