import * as d3 from 'd3';
import type { Association, ReplayEntity, Spotlight } from '../shared/types.ts';

const RESULT: Record<string, string> = { C: 'complete', I: 'incomplete', S: 'sack', IN: 'interception', R: 'scramble' };
const COL = { a: '#f4a261', b: '#2a9d8f', d: '#d62728', off: '#ffb612', def: '#f1f3f4', ball: '#8b4513' };

const short = (name: string) => {
  const parts = name.split(' ');
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
};
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? 'n/a' : v.toFixed(d));

interface Els {
  intro: HTMLElement;
  list: HTMLElement;
  table: HTMLElement;
  field: HTMLElement;
  play: HTMLButtonElement;
  scrub: HTMLInputElement;
  clock: HTMLElement;
  dist: HTMLElement;
  desc: HTMLElement;
}

export function initSpotlight(sp: Spotlight, els: Els): void {
  const T = Number(sp.threshold);
  els.intro.textContent =
    `Paris hosts its first NFL regular-season game this Sunday (25 Oct 2026): Steelers vs Saints at the Stade de France. ` +
    `Across ${sp.teamRoutes.toLocaleString('en-US')} Steelers routes (2021, weeks 1–8) we found ${sp.associations} associated openings. ` +
    `In each, a coverage defender moved off receiver B toward teammate A, and B's window (≥ ${sp.threshold} yd) opened within the next second. ` +
    `Pick a play to watch it. These are sequences worth inspecting, not proof that A caused the opening.`;

  renderTable(els.table, sp);

  let current: Association | null = null;
  let frame = 1;
  let timer: number | undefined;
  let drawField: (f: number) => void = () => {};
  let drawDist: (f: number) => void = () => {};

  const stop = () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    els.play.textContent = '▶ Play';
  };
  const show = (f: number) => {
    if (!current) return;
    frame = Math.max(1, Math.min(current.lastFrame, f));
    els.scrub.value = String(frame);
    drawField(frame);
    drawDist(frame);
    const t = (frame - current.snapFrame) / 10;
    const phase =
      frame < current.snapFrame
        ? 'pre-snap'
        : frame >= current.endFrame
          ? 'passing phase over'
          : frame >= current.f1
            ? "B's window is open"
            : frame >= current.f0
              ? 'defender shifting'
              : 'routes developing';
    els.clock.textContent = `${t >= 0 ? '+' : ''}${t.toFixed(1)} s · ${phase}`;
  };
  const play = () => {
    if (!current) return;
    if (timer !== undefined) return stop();
    if (frame >= current.lastFrame) show(1);
    els.play.textContent = '❚❚ Pause';
    timer = window.setInterval(() => {
      if (!current || frame >= current.lastFrame) return stop();
      show(frame + 1);
    }, 100);
  };

  const buttons: HTMLButtonElement[] = [];
  const select = (i: number, autoplay: boolean) => {
    stop();
    current = sp.plays[i];
    buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    drawField = buildField(els.field, current, T);
    drawDist = buildDistChart(els.dist, current, T);
    els.scrub.max = String(current.lastFrame);
    const a = current;
    const i0 = a.f0 - 1;
    const i1 = a.f1 - 1;
    els.desc.replaceChildren();
    const lead = document.createElement('strong');
    lead.textContent = `${a.d.name} (${a.d.pos}) was ${fmt(a.distDB[i0])} yd from ${a.b.name}. `;
    const rest = document.createTextNode(
      `In the next ${((a.f1 - a.f0) / 10).toFixed(1)} s he moved ${fmt(a.towardA)} yd in ${a.a.name}'s direction and ended ${fmt(a.distDB[i1])} yd from B. ` +
        `${a.b.name} opened at +${a.tOpen.toFixed(1)} s. Result: ${RESULT[a.passResult] ?? a.passResult}. `,
    );
    const pbp = document.createElement('span');
    pbp.className = 'muted';
    pbp.textContent = `Play-by-play: ${a.description}`;
    els.desc.append(lead, rest, pbp);
    if (autoplay) {
      show(Math.max(1, a.snapFrame - 2));
      play();
    } else {
      // Static view opens on the key moment: B's window has just opened.
      show(Math.min(a.lastFrame, a.f1 + 2));
    }
  };

  els.list.replaceChildren();
  sp.plays.forEach((a, i) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'play-item';
    const title = document.createElement('span');
    title.className = 'play-title';
    title.textContent = `${short(a.a.name)} draws ${short(a.d.name)} → ${short(a.b.name)} opens at ${a.tOpen.toFixed(1)} s`;
    const meta = document.createElement('span');
    meta.className = 'play-meta';
    meta.textContent = `Wk ${a.week} vs ${a.opponent} · Q${a.quarter} ${a.down}&${a.yardsToGo} · ${a.coverage || a.coverageType} · ${RESULT[a.passResult] ?? a.passResult}`;
    btn.append(title, meta);
    btn.addEventListener('click', () => select(i, true));
    buttons.push(btn);
    li.append(btn);
    els.list.append(li);
  });

  els.play.addEventListener('click', play);
  els.scrub.addEventListener('input', () => {
    stop();
    show(Number(els.scrub.value));
  });
  if (sp.plays.length) select(0, false);
}

function renderTable(container: HTMLElement, sp: Spotlight): void {
  const table = document.createElement('table');
  table.className = 'board compact';
  const head = ['Player', 'Routes', 'EWR vs exp.', 'Drew for a teammate', 'Opened after a teammate drew'];
  const thead = table.createTHead().insertRow();
  head.forEach((h, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = h;
    if (i > 0) th.className = 'num';
    thead.append(th);
  });
  const body = table.createTBody();
  for (const p of sp.players) {
    const tr = body.insertRow();
    const cells = [
      `${p.name} · ${p.pos}`,
      String(p.routes),
      `${p.overExpected >= 0 ? '+' : '−'}${Math.abs(p.overExpected * 100).toFixed(1)} pp`,
      String(p.drewForTeammate),
      String(p.openedAfterTeammateDrew),
    ];
    cells.forEach((c, i) => {
      const td = tr.insertCell();
      td.textContent = c;
      if (i > 0) td.className = 'num';
    });
  }
  container.replaceChildren(table);
}

function at(e: ReplayEntity, i: number): [number, number] | null {
  const x = e.x[i];
  const y = e.y[i];
  return x === null || y === null || x === undefined || y === undefined ? null : [x, y];
}

/** Top-down field (in yards) with every player, trails for A / B / D and the separation ring around B. */
function buildField(container: HTMLElement, a: Association, T: number): (f: number) => void {
  container.replaceChildren();
  // Crop the view to where the players actually are (with padding), keeping at least 26 yd of width.
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const e of a.entities) {
    for (const v of e.x) if (v !== null) ((xmin = Math.min(xmin, v)), (xmax = Math.max(xmax, v)));
    for (const v of e.y) if (v !== null) ((ymin = Math.min(ymin, v)), (ymax = Math.max(ymax, v)));
  }
  xmin = Math.max(0, Math.floor(xmin - 4));
  xmax = Math.min(120, Math.ceil(xmax + 4));
  ymin = Math.max(0, ymin - 4);
  ymax = Math.min(53.3, ymax + 4);
  if (ymax - ymin < 26) {
    const mid = (ymin + ymax) / 2;
    ymin = Math.max(0, mid - 13);
    ymax = Math.min(53.3, ymin + 26);
  }
  const width = xmax - xmin;
  const height = 53.3;

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `${xmin} ${ymin} ${width} ${ymax - ymin}`)
    .attr('role', 'img')
    .attr('aria-label', `Replay: ${a.d.name} moves from ${a.b.name} toward ${a.a.name}; ${a.b.name} opens at ${a.tOpen} seconds`);
  svg.append('rect').attr('class', 'turf').attr('x', xmin).attr('y', 0).attr('width', width).attr('height', height);
  for (let yl = 10; yl <= 110; yl += 5) {
    if (yl < xmin || yl > xmax) continue;
    svg.append('line').attr('class', yl % 10 === 0 ? 'yard major' : 'yard').attr('x1', yl).attr('x2', yl).attr('y1', 0).attr('y2', height);
    if (yl % 10 === 0) {
      const n = yl - 10 <= 50 ? yl - 10 : 110 - yl;
      if (n > 0) svg.append('text').attr('class', 'yard-num').attr('x', yl).attr('y', ymin + 3).attr('text-anchor', 'middle').text(String(n));
    }
  }
  const ball = a.entities.find((e) => e.side === 'ball');
  const los = ball ? at(ball, a.snapFrame - 1) : null;
  if (los) {
    svg.append('line').attr('class', 'los').attr('x1', los[0]).attr('x2', los[0]).attr('y1', 0).attr('y2', height);
    const fd = los[0] + a.yardsToGo;
    if (fd <= xmax) svg.append('line').attr('class', 'first-down').attr('x1', fd).attr('x2', fd).attr('y1', 0).attr('y2', height);
  }

  const find = (id: number) => a.entities.find((e) => e.nflId === id)!;
  const A = find(a.a.nflId);
  const B = find(a.b.nflId);
  const D = find(a.d.nflId);

  const trails = [
    { e: A, color: COL.a },
    { e: B, color: COL.b },
    { e: D, color: COL.d },
  ].map((t) => ({ ...t, path: svg.append('path').attr('class', 'trail').attr('stroke', t.color) }));
  const linkDA = svg.append('line').attr('class', 'link').attr('stroke', COL.a);
  const linkDB = svg.append('line').attr('class', 'link').attr('stroke', COL.d);
  const ring = svg.append('circle').attr('class', 'ring').attr('r', T);

  const dots = a.entities.map((e) => {
    const special = e === A ? COL.a : e === B ? COL.b : e === D ? COL.d : null;
    const r = e.side === 'ball' ? 0.45 : special ? 1.05 : 0.8;
    const fill = special ?? (e.side === 'off' ? COL.off : e.side === 'def' ? COL.def : COL.ball);
    const c = svg
      .append('circle')
      .attr('r', r)
      .attr('fill', fill)
      .attr('class', e.side === 'ball' ? 'dot ball' : 'dot');
    c.append('title').text(`${e.name}${e.jersey !== null ? ` #${e.jersey}` : ''} · ${e.role}`);
    return { e, c };
  });
  // Fixed offsets (yards) so the three labels don't collide when the players are close together.
  const labels = [
    { e: A, text: `A · ${short(a.a.name)}`, color: COL.a, dx: -1.4, dy: -1.6, anchor: 'end' },
    { e: B, text: `B · ${short(a.b.name)}`, color: COL.b, dx: -1.4, dy: 2.4, anchor: 'end' },
    { e: D, text: `D · ${short(a.d.name)}`, color: COL.d, dx: 1.5, dy: 0.6, anchor: 'start' },
  ].map((l) => ({
    ...l,
    t: svg.append('text').attr('class', 'label').attr('fill', l.color).attr('text-anchor', l.anchor).text(l.text),
  }));

  const line = d3.line<[number, number]>();
  return (f: number) => {
    const i = f - 1;
    for (const { e, c } of dots) {
      const p = at(e, i);
      c.attr('display', p ? null : 'none');
      if (p) c.attr('cx', p[0]).attr('cy', p[1]);
    }
    const from = Math.max(0, a.snapFrame - 1);
    for (const t of trails) {
      const pts: [number, number][] = [];
      for (let k = from; k <= i; k++) {
        const p = at(t.e, k);
        if (p) pts.push(p);
      }
      t.path.attr('d', pts.length > 1 ? line(pts) : null);
    }
    for (const l of labels) {
      const p = at(l.e, i);
      if (p) l.t.attr('x', p[0] + l.dx).attr('y', p[1] + l.dy);
    }
    const pa = at(A, i);
    const pb = at(B, i);
    const pd = at(D, i);
    const showLinks = f >= a.snapFrame && !!pd;
    linkDA.attr('display', showLinks && pa ? null : 'none');
    linkDB.attr('display', showLinks && pb ? null : 'none');
    if (pd && pa) linkDA.attr('x1', pd[0]).attr('y1', pd[1]).attr('x2', pa[0]).attr('y2', pa[1]);
    if (pd && pb) linkDB.attr('x1', pd[0]).attr('y1', pd[1]).attr('x2', pb[0]).attr('y2', pb[1]);
    if (pb) {
      const sep = a.sepB[i];
      ring
        .attr('cx', pb[0])
        .attr('cy', pb[1])
        .attr('class', sep !== null && sep >= T ? 'ring open' : 'ring covered');
    }
  };
}

/** Synced distances: B's separation, defender to B, defender to A, with the shift window shaded. */
function buildDistChart(container: HTMLElement, a: Association, T: number): (f: number) => void {
  container.replaceChildren();
  const W = 640;
  const H = 210;
  const M = { t: 26, r: 16, b: 34, l: 46 };
  const tOf = (f: number) => (f - a.snapFrame) / 10;
  const n = a.lastFrame;
  const x = d3.scaleLinear().domain([tOf(1), tOf(n)]).range([M.l, W - M.r]);
  const maxY = Math.min(16, Math.max(T + 1, ...[...a.sepB, ...a.distDA, ...a.distDB].filter((v): v is number => v !== null)));
  const y = d3.scaleLinear().domain([0, maxY]).nice().range([H - M.b, M.t]);
  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('role', 'img')
    .attr('aria-label', 'Distances over time for the selected play');

  svg
    .append('rect')
    .attr('class', 'shift')
    .attr('x', x(tOf(a.f0)))
    .attr('width', x(tOf(a.f1)) - x(tOf(a.f0)))
    .attr('y', M.t)
    .attr('height', H - M.t - M.b);
  svg.append('text').attr('class', 'shift-label').attr('x', x(tOf(a.f0)) + 3).attr('y', M.t + 11).text('defender shift');
  svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${H - M.b})`).call(d3.axisBottom(x).ticks(8).tickFormat((d) => `${d} s`));
  svg.append('g').attr('class', 'axis').attr('transform', `translate(${M.l},0)`).call(d3.axisLeft(y).ticks(4).tickFormat((d) => `${d} yd`));
  svg.append('line').attr('class', 'threshold').attr('x1', M.l).attr('x2', W - M.r).attr('y1', y(T)).attr('y2', y(T));
  svg.append('line').attr('class', 'marker').attr('x1', x(0)).attr('x2', x(0)).attr('y1', M.t).attr('y2', H - M.b);
  svg.append('line').attr('class', 'marker').attr('x1', x(tOf(a.endFrame))).attr('x2', x(tOf(a.endFrame))).attr('y1', M.t).attr('y2', H - M.b);
  svg.append('text').attr('class', 'marker-label').attr('x', x(0) + 3).attr('y', H - M.b - 4).text('snap');
  svg
    .append('text')
    .attr('class', 'marker-label')
    .attr('x', x(tOf(a.endFrame)) - 3)
    .attr('y', H - M.b - 4)
    .attr('text-anchor', 'end')
    .text('ball out / sack');

  const frames = d3.range(1, n + 1);
  const line = (vals: (number | null)[]) =>
    d3
      .line<number>()
      .defined((f) => vals[f - 1] !== null)
      .x((f) => x(tOf(f)))
      .y((f) => y(vals[f - 1] ?? 0))(frames);
  const series = [
    { vals: a.sepB, color: COL.b, label: `B separation (${short(a.b.name)})`, w: 3 },
    { vals: a.distDB, color: COL.d, label: 'Defender D ↔ B', w: 2 },
    { vals: a.distDA, color: COL.a, label: 'Defender D ↔ A', w: 2 },
  ];
  series.forEach((s, k) => {
    svg.append('path').attr('d', line(s.vals)).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', s.w);
    const lx = M.l + k * 190;
    svg.append('rect').attr('x', lx).attr('y', 6).attr('width', 12).attr('height', 4).attr('fill', s.color);
    svg.append('text').attr('class', 'mini-legend').attr('x', lx + 16).attr('y', 12).text(s.label);
  });
  svg.append('text').attr('class', 'marker-label').attr('x', W - M.r).attr('y', y(T) - 4).attr('text-anchor', 'end').text(`${T} yd window`);

  const cursor = svg.append('line').attr('class', 'cursor').attr('y1', M.t).attr('y2', H - M.b);
  return (f: number) => {
    cursor.attr('x1', x(tOf(f))).attr('x2', x(tOf(f)));
  };
}
