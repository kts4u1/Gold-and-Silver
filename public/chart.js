// 단일 시리즈 선 그래프 (SVG). 크로스헤어 툴팁, 키보드 이동, 표 보기를 함께 그립니다.
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => span / s <= count + 0.5);
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/**
 * @param {HTMLElement} container
 * @param {{points: {date: string, value: number}[], formatValue: (n:number)=>string,
 *          formatTick: (n:number)=>string, formatDate: (d:string)=>string, label: string}} opts
 */
export function renderLineChart(container, { points, formatValue, formatTick, formatDate, label }) {
  container.replaceChildren();
  if (!points || points.length < 2) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = '추이 데이터를 불러오지 못했습니다.';
    container.append(p);
    return;
  }

  const width = Math.max(280, container.clientWidth || 600);
  const plotH = 190;
  const m = { top: 14, right: 72, bottom: 26, left: 52 };
  const height = m.top + plotH + m.bottom;
  const innerW = width - m.left - m.right;

  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.12 || hi * 0.01;
  const ticks = niceTicks(lo - pad, hi + pad);
  const yMin = ticks[0];
  const yMax = ticks.at(-1);
  const x = (i) => m.left + (i / (points.length - 1)) * innerW;
  const y = (v) => m.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const first = points[0];
  const last = points.at(-1);
  const root = svg('svg', {
    viewBox: `0 0 ${width} ${height}`,
    height,
    role: 'img',
    tabindex: 0,
    'aria-label': `${label}: ${formatDate(first.date)} ${formatValue(first.value)}에서 ${formatDate(last.date)} ${formatValue(last.value)}. 최고 ${formatValue(hi)}, 최저 ${formatValue(lo)}. 좌우 화살표로 날짜별 값을 볼 수 있습니다.`,
  });

  // 가로 눈금선(가는 실선)과 y축 라벨
  for (const t of ticks) {
    root.append(svg('line', { x1: m.left, x2: m.left + innerW, y1: y(t), y2: y(t), stroke: 'var(--grid)', 'stroke-width': 1 }));
    const tx = svg('text', { x: m.left - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' });
    tx.textContent = formatTick(t);
    root.append(tx);
  }
  root.append(svg('line', { x1: m.left, x2: m.left + innerW, y1: m.top + plotH, y2: m.top + plotH, stroke: 'var(--baseline)', 'stroke-width': 1 }));

  // x축 날짜 라벨 4개
  const xTickIdx = [...new Set([0, 1, 2, 3].map((k) => Math.round((k / 3) * (points.length - 1))))];
  for (const i of xTickIdx) {
    const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
    const tx = svg('text', { x: x(i), y: m.top + plotH + 18, 'text-anchor': anchor, class: 'tick' });
    tx.textContent = formatDate(points[i].date);
    root.append(tx);
  }

  // 면(옅은 채움) + 선
  const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
  const areaPath = `${linePath}L${x(points.length - 1).toFixed(1)},${m.top + plotH}L${m.left},${m.top + plotH}Z`;
  root.append(svg('path', { d: areaPath, fill: 'var(--series-1)', 'fill-opacity': 0.1, stroke: 'none' }));
  root.append(
    svg('path', { d: linePath, fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
  );

  // 마지막 값 표시
  const lx = x(points.length - 1);
  const ly = y(last.value);
  root.append(svg('circle', { cx: lx, cy: ly, r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  const endLabel = svg('text', { x: lx + 8, y: ly + 4, class: 'end-label' });
  endLabel.textContent = formatTick(last.value);
  root.append(endLabel);

  // 크로스헤어
  const cross = svg('line', { y1: m.top, y2: m.top + plotH, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' });
  const focusDot = svg('circle', { r: 4, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' });
  const hit = svg('rect', { x: m.left, y: m.top, width: innerW, height: plotH, fill: 'transparent' });
  root.append(cross, focusDot, hit);

  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  const tipValue = document.createElement('strong');
  const tipDate = document.createElement('span');
  const key = document.createElement('i');
  key.className = 'key';
  tipDate.prepend(key);
  const tipDateText = document.createTextNode('');
  tipDate.append(tipDateText);
  tip.append(tipValue, tipDate);

  let active = -1;
  function show(i) {
    active = Math.max(0, Math.min(points.length - 1, i));
    const p = points[active];
    const px = x(active);
    const py = y(p.value);
    cross.setAttribute('x1', px);
    cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    focusDot.setAttribute('cx', px);
    focusDot.setAttribute('cy', py);
    focusDot.setAttribute('visibility', 'visible');
    tipValue.textContent = formatValue(p.value);
    tipDateText.textContent = formatDate(p.date, true);
    tip.hidden = false;
    const scale = root.getBoundingClientRect().width / width || 1;
    const left = Math.min(Math.max(px * scale, 70), root.getBoundingClientRect().width - 70);
    tip.style.left = `${left}px`;
    tip.style.top = `${py * scale - 10}px`;
  }
  function hide() {
    active = -1;
    cross.setAttribute('visibility', 'hidden');
    focusDot.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  }
  function indexAt(clientX) {
    const rect = root.getBoundingClientRect();
    const sx = ((clientX - rect.left) / rect.width) * width;
    return Math.round(((sx - m.left) / innerW) * (points.length - 1));
  }
  root.addEventListener('pointermove', (e) => show(indexAt(e.clientX)));
  root.addEventListener('pointerdown', (e) => show(indexAt(e.clientX)));
  root.addEventListener('pointerleave', hide);
  root.addEventListener('focus', () => show(points.length - 1));
  root.addEventListener('blur', hide);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      show((active < 0 ? points.length - 1 : active) + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      show(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      show(points.length - 1);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  // 표 보기 (툴팁 없이도 모든 값을 읽을 수 있게)
  const details = document.createElement('details');
  details.className = 'table-view';
  const summary = document.createElement('summary');
  summary.textContent = '표로 보기';
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = table.createTHead().insertRow();
  for (const [text, cls] of [
    ['날짜', ''],
    [label, 'num'],
  ]) {
    const th = document.createElement('th');
    th.textContent = text;
    if (cls) th.className = cls;
    thead.append(th);
  }
  const tbody = table.createTBody();
  for (const p of [...points].reverse()) {
    const row = tbody.insertRow();
    row.insertCell().textContent = formatDate(p.date, true);
    const c = row.insertCell();
    c.className = 'num';
    c.textContent = formatValue(p.value);
  }
  wrap.append(table);
  details.append(summary, wrap);

  container.append(root, tip, details);
}
