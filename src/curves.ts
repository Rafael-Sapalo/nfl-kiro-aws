import * as d3 from 'd3';
import { CURVE_BINS, type PlayerRow, type PositionBaseline, type ThresholdKey } from '../shared/types.ts';

const W = 640;
const H = 380;
const M = { t: 18, r: 18, b: 46, l: 54 };
const GREYS: Record<string, string> = { WR: '#5f6873', TE: '#9aa3ad', RB: '#c3c9d0' };
const TIMES = d3.range(CURVE_BINS).map((i) => i / 10);

interface Series {
  label: string;
  color: string;
  opened: number[];
  now: number[];
  baseline?: boolean;
}

/** Open Curves: cumulative "has created a window" (solid) and "currently open" (dashed) vs time since snap. */
export function renderCurves(
  container: HTMLElement,
  legend: HTMLElement,
  selected: { row: PlayerRow; color: string }[],
  baselines: PositionBaseline[],
  T: ThresholdKey,
): void {
  container.replaceChildren();
  legend.replaceChildren();

  const series: Series[] = [];
  const positions = [...new Set(selected.map((s) => s.row.pos))];
  for (const pos of positions.length ? positions : (['WR'] as const)) {
    const b = baselines.find((x) => x.pos === pos);
    if (b) series.push({ label: `${pos} average`, color: GREYS[pos], opened: b.byT[T].curveOpened, now: b.byT[T].curveOpenNow, baseline: true });
  }
  for (const s of selected) {
    series.push({ label: s.row.name, color: s.color, opened: s.row.byT[T].curveOpened, now: s.row.byT[T].curveOpenNow });
  }

  const x = d3.scaleLinear().domain([0, 4]).range([M.l, W - M.r]);
  const y = d3.scaleLinear().domain([0, 1]).range([H - M.b, M.t]);
  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('role', 'img')
    .attr('aria-label', `Open curves at ${T} yards for ${series.map((s) => s.label).join(', ')}`);

  svg
    .append('g')
    .attr('class', 'gridlines')
    .attr('transform', `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickSize(-(W - M.l - M.r)).tickFormat(() => ''));
  svg
    .append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(0,${H - M.b})`)
    .call(d3.axisBottom(x).ticks(8).tickFormat((d) => `${d} s`));
  svg
    .append('g')
    .attr('class', 'axis')
    .attr('transform', `translate(${M.l},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(d3.format('.0%')));
  svg.append('text').attr('class', 'axis-title').attr('x', (M.l + W - M.r) / 2).attr('y', H - 8).attr('text-anchor', 'middle').text('Time since snap');
  svg
    .append('text')
    .attr('class', 'axis-title')
    .attr('transform', `translate(14,${(M.t + H - M.b) / 2}) rotate(-90)`)
    .attr('text-anchor', 'middle')
    .text('Share of routes');

  // 2.5 s "early" deadline.
  svg.append('line').attr('class', 'deadline').attr('x1', x(2.5)).attr('x2', x(2.5)).attr('y1', M.t).attr('y2', H - M.b);
  svg.append('text').attr('class', 'deadline-label').attr('x', x(2.5) + 4).attr('y', M.t + 12).text('2.5 s: early deadline');

  const line = d3
    .line<number>()
    .defined((d) => d >= 0)
    .x((_, i) => x(TIMES[i]))
    .y((d) => y(d));

  for (const s of series) {
    svg
      .append('path')
      .attr('d', line(s.now))
      .attr('fill', 'none')
      .attr('stroke', s.color)
      .attr('stroke-width', s.baseline ? 1.5 : 2)
      .attr('stroke-dasharray', '5 4')
      .attr('opacity', s.baseline ? 0.8 : 0.9);
    svg
      .append('path')
      .attr('d', line(s.opened))
      .attr('fill', 'none')
      .attr('stroke', s.color)
      .attr('stroke-width', s.baseline ? 2 : 3);
  }

  // Legend with live values (updated on hover).
  const valueSpans: HTMLSpanElement[] = [];
  for (const s of series) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = s.color;
    const name = document.createElement('span');
    name.textContent = s.label;
    const v = document.createElement('span');
    v.className = 'legend-value';
    valueSpans.push(v);
    item.append(sw, name, v);
    legend.append(item);
  }
  const fmt = (d: number | undefined) => (d === undefined || d < 0 ? 'n/a' : `${Math.round(d * 100)}%`);
  const setValues = (i: number) => {
    series.forEach((s, k) => {
      valueSpans[k].textContent = `created ${fmt(s.opened[i])} · open now ${fmt(s.now[i])} @ ${TIMES[i].toFixed(1)} s`;
    });
  };
  setValues(25);

  const rule = svg.append('line').attr('class', 'hover-rule').attr('y1', M.t).attr('y2', H - M.b).attr('opacity', 0);
  svg
    .append('rect')
    .attr('x', M.l)
    .attr('y', M.t)
    .attr('width', W - M.l - M.r)
    .attr('height', H - M.t - M.b)
    .attr('fill', 'transparent')
    .on('mousemove', (ev: MouseEvent) => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(CURVE_BINS - 1, Math.round(x.invert(mx) * 10)));
      rule.attr('x1', x(TIMES[i])).attr('x2', x(TIMES[i])).attr('opacity', 1);
      setValues(i);
    })
    .on('mouseleave', () => {
      rule.attr('opacity', 0);
      setValues(25);
    });
}
