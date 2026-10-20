import {
  availableSizes,
  DEFAULT_SETTINGS,
  explainRecommendation,
  formatWeight,
  GRAMS_PER_DON,
  rankByPerGram,
  rankOffers,
} from '/shared/compare.js';
import { renderLineChart } from '/chart.js';

const REFRESH_MS = 60 * 1000;
const PERGRAM_PREVIEW = 8;
const $ = (sel) => document.querySelector(sel);

// ---------- 저장 (이 기기에만, 실패해도 동작) ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`gs:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`gs:${key}`, JSON.stringify(value));
    } catch {
      /* 저장소를 못 써도 화면은 계속 동작 */
    }
  },
};

function loadManual() {
  const list = store.get('manual', []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (m) =>
      m &&
      typeof m.name === 'string' &&
      (m.metal === 'gold' || m.metal === 'silver') &&
      Number(m.sizeG) > 0 &&
      Number(m.unitPrice) > 0,
  );
}

const state = {
  data: null,
  loading: false,
  metal: store.get('metal', 'gold') === 'silver' ? 'silver' : 'gold',
  size: { gold: 100, silver: 1000, ...store.get('size', {}) },
  qty: 1,
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  manual: loadManual(),
  showAllPerGram: false,
};

// ---------- 표기 ----------
const nf = new Intl.NumberFormat('ko-KR');
const won = (n) => `${nf.format(Math.round(n))}원`;
const num = (n, digits = 0) =>
  Number(n).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signedPct = (r, digits = 1) => `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(digits)}%`;
const kstTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
function when(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : kstTime.format(d);
}
function shortDate(ymd, long = false) {
  const [y, m, d] = ymd.split('-').map(Number);
  return long ? `${y}년 ${m}월 ${d}일` : `${m}/${d}`;
}

/** 요소 만들기. 문자열 자식은 항상 텍스트로 넣습니다 (외부 데이터 안전). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function delta(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct > 0) return h('span', { class: 'delta-up' }, `▲ ${pct.toFixed(2)}%`);
  if (pct < 0) return h('span', { class: 'delta-down' }, `▼ ${Math.abs(pct).toFixed(2)}%`);
  return h('span', null, '– 0.00%');
}

function link(url, text) {
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : null;
}

// ---------- 데이터 ----------
function manualOffers() {
  return state.manual.map((m) => ({
    id: m.id,
    channelId: m.id,
    channelName: m.name,
    vendor: '직접 입력',
    metal: m.metal,
    sizeG: Number(m.sizeG),
    kind: 'fixed',
    summary: '직접 입력한 견적',
    unitPrice: Number(m.unitPrice),
    vatIncluded: Boolean(m.vatIncluded),
    sellPrice: null,
    quotedAt: m.addedAt,
    source: 'manual',
    url: null,
    notes: ['직접 입력한 견적이라 자동으로 갱신되지 않습니다'],
  }));
}

function allOffers() {
  return [...(state.data?.offers ?? []), ...manualOffers()];
}

function spotFor(metal) {
  return state.data?.market?.spot?.[metal]?.perGram ?? null;
}

function sourceStatus(id) {
  return state.data?.sources?.find((s) => s.id === id) ?? null;
}

async function load(force = false) {
  if (state.loading) return;
  state.loading = true;
  $('#main').classList.toggle('is-loading', Boolean(state.data));
  $('#refresh').disabled = true;
  try {
    const res = await fetch(`/api/prices${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`서버 오류 (${res.status})`);
    state.data = await res.json();
    render();
  } catch (err) {
    $('#updated').textContent = state.data ? `갱신 실패 · ${when(state.data.generatedAt)} 기준` : '불러오기 실패';
    if (!state.data) $('#explain').textContent = `시세를 불러오지 못했습니다: ${err.message}. 잠시 후 새로고침해 주세요.`;
  } finally {
    state.loading = false;
    $('#main').classList.remove('is-loading');
    $('#refresh').disabled = false;
  }
}

// ---------- 렌더링 ----------
function render() {
  if (!state.data) return;
  $('#updated').textContent = `${when(state.data.generatedAt)} 기준`;
  for (const btn of document.querySelectorAll('.metal-switch button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.metal === state.metal));
  }
  renderTiles();
  renderChart();
  renderSellRef();
  renderFinder();
  renderPerGram();
  renderManualList();
  renderSources();
}

function tile(label, value, unit, ...meta) {
  return h(
    'div',
    { class: 'card tile' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value, unit ? h('small', null, unit) : null),
    h('div', { class: 'meta' }, ...meta),
  );
}

function renderTiles() {
  const m = state.data.market;
  const metal = state.metal;
  const spot = m.spot?.[metal];
  const kgxSpot = m.kgx?.spot?.[metal];
  const intl = metal === 'gold' ? m.intlGold : m.intlSilver;
  const usd = kgxSpot?.ask ?? intl?.value;
  const usdPct = kgxSpot?.changePct ?? intl?.changePct;
  const tiles = [];

  tiles.push(
    tile(
      metal === 'gold' ? '국제 금 시세' : '국제 은 시세',
      usd ? `$${num(usd, 2)}` : '-',
      '/oz',
      delta(usdPct),
      spot ? ` · ${won(spot.perGram)}/g 환산` : '',
    ),
  );

  const fx = m.usdKrw;
  tiles.push(
    tile('원/달러 환율', fx?.value ? num(fx.value, 1) : m.spot?.usdKrw ? num(m.spot.usdKrw, 1) : '-', '원', delta(fx?.changePct), fx ? ' · 하나은행 고시' : ''),
  );

  if (metal === 'gold') {
    const krx = m.krxGold;
    const status = krx?.marketStatus === 'OPEN' ? '장중' : '장 마감';
    tiles.push(
      tile(
        'KRX 금시장 (1g)',
        krx ? num(krx.value) : '-',
        '원',
        delta(krx?.changePct),
        krx ? ` · 1돈 ${won(krx.value * GRAMS_PER_DON)} · ${status}` : '',
      ),
    );
  } else {
    tiles.push(
      tile('국제가 환산 (1kg)', spot ? num(spot.perGram * 1000) : '-', '원', '부가세 별도 · ', spot?.basis ?? ''),
    );
  }

  const buyBack = m.kgx?.purchase?.find((p) => p.type === (metal === 'gold' ? 'PURE_GOLD' : 'SILVER'));
  tiles.push(
    tile(
      metal === 'gold' ? '팔 때 기준 (순금 1돈)' : '팔 때 기준 (은 3.75g)',
      buyBack ? num(buyBack.perDon) : '-',
      '원',
      delta(buyBack?.changePct),
      ' · 한국금거래소 매입시세',
    ),
  );

  $('#tiles').replaceChildren(...tiles);

  // 지금 가장 싼 방법도 국제 시세보다 얼마나 비싼지 알려 줍니다.
  const notice = $('#market-notice');
  const best = rankByPerGram(allOffers().filter((o) => o.source !== 'manual'), {
    metal,
    settings: state.settings,
    spotPerGram: spot?.perGram,
  })[0];
  if (best && best.premiumPct != null) {
    const what = `${best.offer.channelName} ${formatWeight(best.offer.sizeG)}`;
    const extra =
      metal === 'silver'
        ? ' 은은 금보다 판매 마진과 유통 비용 비중이 커서 국제 시세와의 차이가 큽니다.'
        : ' 이 중 10%는 실물을 살 때 피할 수 없는 부가세입니다.';
    notice.replaceChildren(
      'g당 가장 싸게 사는 방법(',
      h('strong', null, what),
      `)도 국제 시세보다 ${signedPct(best.premiumPct)} 비쌉니다.${extra}`,
    );
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

function renderChart() {
  const hist = state.data.market.history ?? {};
  const isGold = state.metal === 'gold';
  const points = (isGold ? hist.krxGold : hist.intlSilver) ?? [];
  const label = isGold ? 'KRX 금 (원/g)' : '국제 은 ($/oz)';
  $('#chart-title').textContent = isGold ? 'KRX 금 시세 추이' : '국제 은 시세 추이';
  $('#chart-sub').textContent = isGold
    ? `1g당 원화 가격, 최근 ${points.length}거래일 종가`
    : `1온스당 달러 가격, 최근 ${points.length}거래일 종가 (국내 은 현물 시장은 없음)`;
  renderLineChart($('#chart'), {
    points,
    label,
    formatValue: (v) => (isGold ? `${num(v)}원` : `$${num(v, 2)}`),
    formatTick: (v) => (isGold ? num(v) : `$${num(v, v % 1 ? 1 : 0)}`),
    formatDate: shortDate,
  });
}

function renderSellRef() {
  const kgx = state.data.market.kgx;
  const box = $('#sell-ref');
  if (!kgx) {
    box.replaceChildren(h('p', { class: 'muted small' }, '한국금거래소 시세를 불러오지 못했습니다.'));
    return;
  }
  const isGold = state.metal === 'gold';
  const wholesale = kgx.wholesale?.[state.metal];
  const rows = [];
  if (wholesale) rows.push([`국내 도매시세 (${isGold ? '금' : '은'})`, wholesale.perDon, null, wholesale.change]);
  for (const p of kgx.purchase ?? []) {
    const isSilver = p.type === 'SILVER';
    if (isGold === isSilver || p.type === 'PLATINUM') continue;
    rows.push([`매입시세 · ${p.name}`, p.perDon, p.changePct, p.change]);
  }
  const tbody = h(
    'tbody',
    null,
    rows.map(([name, price, pct, change]) =>
      h(
        'tr',
        null,
        h('td', null, name),
        h('td', { class: 'num' }, won(price)),
        h('td', { class: 'num' }, pct != null ? delta(pct) : change != null ? `${change > 0 ? '+' : ''}${num(change)}원` : '-'),
      ),
    ),
  );
  box.replaceChildren(
    h('h3', null, '한국금거래소 시세 (3.75g 기준)'),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, '구분'), h('th', { class: 'num' }, '가격'), h('th', { class: 'num' }, '변동'))),
      tbody,
    ),
    h(
      'p',
      { class: 'muted small' },
      `도매시세는 사업자 간 거래가, 매입시세는 한국금거래소가 사업자에게서 사들이는 가격입니다. 개인이 금은방에 팔 때는 이보다 조금 낮을 수 있어요. ${when(kgx.at)} 기준 · `,
      link('https://www.exgold.co.kr/', '출처'),
    ),
  );
}

function renderFinder() {
  const offers = allOffers();
  const sizes = availableSizes(offers, state.metal);
  let size = state.size[state.metal];
  if (!sizes.some((s) => Math.abs(s - size) < 0.001)) {
    const preferred = state.metal === 'gold' ? 100 : 1000;
    size = sizes.includes(preferred) ? preferred : sizes[0];
  }

  $('#sizes').replaceChildren(
    ...sizes.map((s) =>
      h(
        'label',
        { class: 'chip' },
        h('input', {
          type: 'radio',
          name: 'size',
          value: s,
          checked: Math.abs(s - size) < 0.001,
          onchange: () => {
            state.size[state.metal] = s;
            store.set('size', state.size);
            renderFinder();
          },
        }),
        h('span', null, formatWeight(s)),
      ),
    ),
  );
  $('#qty').value = state.qty;

  const ranking = $('#ranking');
  if (size == null) {
    $('#explain').textContent = '';
    ranking.replaceChildren(h('li', { class: 'card empty' }, '비교할 상품이 없습니다. 데이터 출처 상태를 확인해 주세요.'));
    return;
  }

  const ranked = rankOffers(offers, {
    metal: state.metal,
    sizeG: size,
    qty: state.qty,
    settings: state.settings,
    spotPerGram: spotFor(state.metal),
  });
  $('#explain').textContent = explainRecommendation(ranked);
  ranking.replaceChildren(...ranked.map((q, i) => offerCard(q, i)));
}

function offerCard(q, i) {
  const o = q.offer;
  const isBest = i === 0;
  const status = sourceStatus(o.source);
  const badges = [];
  if (isBest) badges.push(h('span', { class: 'badge' }, '추천'));
  if (o.source === 'manual') badges.push(h('span', { class: 'badge soft' }, '직접 입력'));
  if (status?.stale) badges.push(h('span', { class: 'badge soft' }, '지연된 가격'));

  const breakdown = h(
    'table',
    { class: 'breakdown' },
    h(
      'tbody',
      null,
      q.lines.map((l) => h('tr', null, h('td', null, l.label), h('td', { class: 'num' }, won(l.amount)))),
      h('tr', { class: 'sum' }, h('td', null, `합계 (${formatWeight(o.sizeG)} × ${q.qty}개)`), h('td', { class: 'num' }, won(q.total))),
    ),
  );

  const resale =
    q.resale != null
      ? h(
          'p',
          null,
          `같은 곳에 바로 되팔면 ${won(q.resale)} (`,
          h('span', { class: 'delta-down' }, signedPct(-q.resaleLossPct)),
          ')',
        )
      : null;

  return h(
    'li',
    { class: `card offer${isBest ? ' is-best' : ''}` },
    h(
      'div',
      { class: 'offer-head' },
      h('span', { class: 'rank', 'aria-label': `${i + 1}위` }, String(i + 1)),
      h('div', { class: 'offer-name' }, h('strong', null, o.channelName), h('span', { class: 'maker' }, o.summary ?? '')),
      ...badges,
    ),
    h(
      'div',
      { class: 'offer-price' },
      h('span', { class: 'total' }, won(q.total)),
      h('span', { class: 'diff' }, isBest ? '최저가' : `+${won(q.diffFromBest)} (${signedPct(q.diffFromBestPct)})`),
    ),
    h(
      'div',
      { class: 'offer-meta' },
      `g당 ${won(q.perGram)}`,
      q.premiumPct != null ? ` · 국제 시세 대비 ${signedPct(q.premiumPct)} (부가세 포함)` : '',
    ),
    h(
      'details',
      null,
      h('summary', null, '계산 내역 · 유의사항'),
      breakdown,
      h('ul', { class: 'notes' }, (o.notes ?? []).map((n) => h('li', null, n))),
      resale,
      h(
        'p',
        { class: 'muted small' },
        `가격 기준 ${when(o.quotedAt)}`,
        o.url ? ' · ' : '',
        link(o.url, '판매처에서 확인 ↗'),
      ),
    ),
  );
}

function renderPerGram() {
  const rows = rankByPerGram(allOffers(), {
    metal: state.metal,
    settings: state.settings,
    spotPerGram: spotFor(state.metal),
  });
  const tbody = $('#pergram-table tbody');
  const more = $('#pergram-more');
  if (!rows.length) {
    tbody.replaceChildren(h('tr', null, h('td', { colspan: 5, class: 'empty' }, '데이터가 없습니다.')));
    more.hidden = true;
    return;
  }
  const hiddenCount = state.showAllPerGram ? 0 : Math.max(0, rows.length - PERGRAM_PREVIEW);
  more.hidden = rows.length <= PERGRAM_PREVIEW;
  more.textContent = hiddenCount ? `나머지 ${hiddenCount}개 더 보기` : '접기';
  tbody.replaceChildren(
    ...rows.slice(0, rows.length - hiddenCount).map((q, i) =>
      h(
        'tr',
        { class: i === 0 ? 'is-best' : null },
        h('td', null, q.offer.channelName),
        h('td', null, formatWeight(q.offer.sizeG)),
        h('td', { class: 'num' }, won(q.total)),
        h('td', { class: 'num' }, won(q.perGram)),
        h('td', { class: 'num' }, q.premiumPct != null ? signedPct(q.premiumPct) : '-'),
      ),
    ),
  );
}

function renderManualList() {
  const list = $('#manual-list');
  list.replaceChildren(
    ...state.manual.map((m) =>
      h(
        'li',
        null,
        h(
          'span',
          null,
          `${m.name} · ${m.metal === 'gold' ? '금' : '은'} ${formatWeight(Number(m.sizeG))} · ${won(m.unitPrice)} (${m.vatIncluded ? '부가세 포함' : '부가세 별도'})`,
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': `${m.name} 견적 삭제`,
            onclick: () => {
              state.manual = state.manual.filter((x) => x.id !== m.id);
              store.set('manual', state.manual);
              render();
            },
          },
          '삭제',
        ),
      ),
    ),
  );
}

function renderSources() {
  $('#sources').replaceChildren(
    ...state.data.sources.map((s) => {
      const [cls, text] = s.ok ? ['ok', '✓ 정상'] : s.stale ? ['stale', '! 지연'] : ['fail', '✕ 실패'];
      const detail = [];
      if (s.fetchedAt) detail.push(`${when(s.fetchedAt)} 수집`);
      if (s.error) detail.push(s.error);
      for (const w of s.warnings ?? []) detail.push(w);
      return h(
        'li',
        null,
        h('span', { class: `status ${cls}` }, text),
        h('div', null, link(s.url, s.name), h('div', { class: 'muted small' }, detail.join(' · '))),
      );
    }),
  );
  $('#not-covered').textContent =
    '자동으로 모으지 못하는 곳: 한국금거래소 소매 매장(koreagoldx.co.kr), KB국민·신한·우리·NH농협 은행 골드바, 동네 금은방. 이곳 가격은 "내가 받은 견적 비교하기"에 넣으면 함께 비교됩니다.';
}

// ---------- 이벤트 ----------
for (const btn of document.querySelectorAll('.metal-switch button')) {
  btn.addEventListener('click', () => {
    state.metal = btn.dataset.metal;
    store.set('metal', state.metal);
    render();
  });
}

function setQty(n) {
  state.qty = Math.min(99, Math.max(1, Math.round(Number(n) || 1)));
  renderFinder();
}
$('#qty').addEventListener('change', (e) => setQty(e.target.value));
for (const btn of document.querySelectorAll('.qty [data-step]')) {
  btn.addEventListener('click', () => setQty(state.qty + Number(btn.dataset.step)));
}

$('#refresh').addEventListener('click', () => load(true));

$('#pergram-more').addEventListener('click', () => {
  state.showAllPerGram = !state.showAllPerGram;
  renderPerGram();
});

$('#manual-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const entry = {
    id: `manual-${Date.now()}`,
    name: String(f.get('name')).trim().slice(0, 40),
    metal: f.get('metal') === 'silver' ? 'silver' : 'gold',
    sizeG: Number(f.get('sizeG')),
    unitPrice: Math.round(Number(f.get('unitPrice'))),
    vatIncluded: f.get('vatIncluded') === 'on',
    addedAt: new Date().toISOString(),
  };
  if (!entry.name || !(entry.sizeG > 0) || !(entry.unitPrice > 0)) return;
  state.manual.push(entry);
  store.set('manual', state.manual);
  // 입력한 견적이 바로 보이도록 해당 금속·중량으로 이동
  state.metal = entry.metal;
  state.size[entry.metal] = entry.sizeG;
  store.set('metal', state.metal);
  e.target.reset();
  render();
  $('#finder-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const settingsForm = $('#settings-form');
function fillSettings() {
  settingsForm.krxTradeFeeRate.value = Number((state.settings.krxTradeFeeRate * 100).toFixed(4));
  settingsForm.krxBrokerWithdrawFee.value = state.settings.krxBrokerWithdrawFee;
  settingsForm.krxKsdWithdrawFeePerBar.value = state.settings.krxKsdWithdrawFeePerBar;
}
settingsForm.addEventListener('input', () => {
  const read = (name, scale = 1) => {
    const v = Number(settingsForm[name].value);
    return Number.isFinite(v) && v >= 0 ? v * scale : DEFAULT_SETTINGS[name];
  };
  state.settings = {
    ...state.settings,
    krxTradeFeeRate: read('krxTradeFeeRate', 0.01),
    krxBrokerWithdrawFee: read('krxBrokerWithdrawFee'),
    krxKsdWithdrawFeePerBar: read('krxKsdWithdrawFeePerBar'),
  };
  store.set('settings', state.settings);
  render();
});
$('#settings-reset').addEventListener('click', () => {
  state.settings = { ...DEFAULT_SETTINGS };
  store.set('settings', {});
  fillSettings();
  render();
});
fillSettings();

// 화면 폭이 바뀌면 차트를 다시 그립니다.
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (state.data && Math.abs(w - lastWidth) > 4) {
    lastWidth = w;
    renderChart();
  }
}).observe($('#chart'));

load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, REFRESH_MS);
