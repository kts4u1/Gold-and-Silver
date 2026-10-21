import {
  availableSizes,
  DEFAULT_SETTINGS,
  explainRecommendation,
  formatWeight,
  GRAMS_PER_DON,
  rankByPerGram,
  rankOffers,
} from './shared/compare.js';
import { districtsOf, nearbyBest, nearestDistrict, rankNearby, REGIONS } from './shared/location.js';
import { renderLineChart } from './chart.js';

const REFRESH_MS = 60 * 1000;
const PERGRAM_PREVIEW = 8;
const NEARBY_PAGE = 20;
const IS_STATIC = document.querySelector('meta[name="data-mode"]')?.content === 'static';
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

const AREAS = {
  district: '같은 시·군·구',
  km10: '10km 안',
  km20: '20km 안',
  km50: '50km 안',
  region: '시·도 전체',
  all: '전국',
};

/** 저장된 위치 설정을 읽습니다. 예전 "지역" 필터 값도 이어받습니다. */
function loadLocation() {
  const saved = store.get('location', {}) ?? {};
  const old = store.get('branchFilter', {}) ?? {};
  const region = REGIONS.includes(saved.region) ? saved.region : REGIONS.includes(old.region) ? old.region : '';
  const district = region && districtsOf(region).includes(saved.district) ? saved.district : '';
  return {
    region,
    district,
    area: saved.area in AREAS ? saved.area : 'km20',
    sort: ['price', 'sell', 'distance'].includes(saved.sort) ? saved.sort : 'price',
  };
}

const state = {
  data: null,
  location: loadLocation(),
  branchFilter: { chain: '', q: '', ...store.get('branchFilter', {}) },
  nearbyLimit: NEARBY_PAGE,
  nearbyOnly: store.get('nearbyOnly', false) === true,
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
    // GitHub Pages 같은 정적 배포본은 서버 대신 미리 저장된 data/prices.json을 읽습니다
    const url = IS_STATIC ? 'data/prices.json' : `api/prices${force ? '?refresh=1' : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
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
  renderLocationControls();
  renderNearby();
  renderShops();
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

  // 금은방에 팔 때 기준: 한국금거래소 소비자 고시가, 없으면 사업자 매입시세
  const key = metal === 'gold' ? 'gold24k' : 'silver';
  const kgxRetail = (state.data.shops ?? []).find((s) => s.id === 'kgx-retail');
  const buyBack = m.kgx?.purchase?.find((p) => p.type === (metal === 'gold' ? 'PURE_GOLD' : 'SILVER'));
  const sellPrice = kgxRetail?.prices?.[key]?.sell ?? buyBack?.perDon;
  tiles.push(
    tile(
      metal === 'gold' ? '팔 때 기준 (순금 1돈)' : '팔 때 기준 (은 3.75g)',
      sellPrice ? num(sellPrice) : '-',
      '원',
      kgxRetail?.prices?.[key]?.sell ? '한국금거래소 고시가' : [delta(buyBack?.changePct), ' · 한국금거래소 매입시세'],
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

/** 매장 시세 기준 시각 표시. 날짜만 있으면 날짜, 오래됐으면 며칠 전인지 */
function shopWhen(shop) {
  if (shop.at) return when(shop.at);
  if (!shop.date) return '시각 미표기';
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const days = Math.round((Date.parse(today) - Date.parse(shop.date)) / 86400000);
  const label = shortDate(shop.date);
  return days >= 1 ? `${label} (${days}일 전)` : `${label} (오늘)`;
}

/** 살 때 가격을 부가세 포함으로 맞춥니다 (비교용) */
function buyWithVat(shop, price) {
  return shop.buyVatIncluded ? price : Math.round(price * (1 + state.settings.vatRate));
}

/** K-금은거래소처럼 품목별 매입시세를 공개하는 곳은 한 줄로 보여 줍니다. */
function buybackNote(shop) {
  const items = shop.buyback?.[state.metal];
  if (!items?.length) return null;
  const short = items.slice(0, 3).map((i) => `${i.label.replace(/\(.*?\)/g, '').trim()} ${num(i.price)}`);
  return h('div', { class: 'cell-note' }, `품목별 매입: ${short.join(' · ')}`);
}

function renderShops() {
  const shops = state.data.shops ?? [];
  const isGold = state.metal === 'gold';
  const key = isGold ? 'gold24k' : 'silver';
  const unit = isGold ? '순금 1돈' : '은 3.75g';
  const withPrice = shops.filter((s) => s.prices?.[key]?.buy || s.prices?.[key]?.sell);
  // 살 때 싼 순서 (참고값·살 때 없는 곳은 뒤로, 그 안에서는 팔 때 높은 순)
  const sortKey = (s) => {
    const p = s.prices[key];
    return p.buy && !s.buyIsReference ? [0, buyWithVat(s, p.buy)] : [1, -(p.sell ?? 0)];
  };
  const rows = [...withPrice].sort((a, b) => {
    const [ga, va] = sortKey(a);
    const [gb, vb] = sortKey(b);
    return ga - gb || va - vb;
  });

  $('#shops-sub').textContent = `금거래소·금은방 ${withPrice.length}곳이 매일 고시하는 ${unit} 가격입니다 (서울 종로·강남, 부산 등). 살 때 가격이 싼 순서로 보여 줍니다.`;

  // 살 때 최저(참고값 제외, 부가세 포함으로 맞춤) · 팔 때 최고
  const buyable = rows.filter((s) => s.prices[key].buy && !s.buyIsReference);
  const cheapest = buyable.reduce(
    (a, s) => (!a || buyWithVat(s, s.prices[key].buy) < buyWithVat(a, a.prices[key].buy) ? s : a),
    null,
  );
  const sellable = rows.filter((s) => s.prices[key].sell);
  const bestSell = sellable.reduce((a, s) => (!a || s.prices[key].sell > a.prices[key].sell ? s : a), null);

  const best = $('#shops-best');
  if (cheapest || bestSell) {
    best.replaceChildren(
      ...(cheapest
        ? [`${unit} 살 때 가장 싼 곳 `, h('strong', null, `${cheapest.name} ${won(buyWithVat(cheapest, cheapest.prices[key].buy))}`)]
        : []),
      cheapest && bestSell ? ' · ' : '',
      ...(bestSell ? ['팔 때 가장 비싸게 사 주는 곳 ', h('strong', null, `${bestSell.name} ${won(bestSell.prices[key].sell)}`)] : []),
    );
    best.hidden = false;
  } else {
    best.hidden = true;
  }

  const head = [
    h('th', null, '매장'),
    h('th', { class: 'num' }, `살 때 (${unit})`),
    h('th', { class: 'num' }, `팔 때 (${unit})`),
    isGold ? h('th', { class: 'num' }, '팔 때 18K / 14K') : null,
    h('th', null, '기준'),
  ];
  $('#shops-table thead').replaceChildren(h('tr', null, head));

  const tbody = $('#shops-table tbody');
  if (!rows.length) {
    tbody.replaceChildren(h('tr', null, h('td', { colspan: head.filter(Boolean).length, class: 'empty' }, '매장 시세를 불러오지 못했습니다.')));
    $('#shops-foot').textContent = '';
    return;
  }

  tbody.replaceChildren(
    ...rows.map((s) => {
      const p = s.prices[key];
      const buyCell = p.buy
        ? [
            won(p.buy),
            s === cheapest ? h('span', { class: 'badge inline' }, '최저') : null,
            !s.buyVatIncluded ? h('div', { class: 'cell-note' }, `VAT별도 표기 · 포함 ${won(buyWithVat(s, p.buy))}`) : null,
            s.buyIsReference ? h('div', { class: 'cell-note' }, '참고용 (구매 순위 제외)') : null,
          ]
        : '-';
      const sellCell = p.sell ? [won(p.sell), s === bestSell ? h('span', { class: 'badge inline' }, '최고') : null] : '-';
      const k18 = s.prices.gold18k?.sell;
      const k14 = s.prices.gold14k?.sell;
      return h(
        'tr',
        null,
        h(
          'td',
          null,
          link(s.url, s.name),
          h('div', { class: 'cell-note' }, s.region),
          nearNote(s),
          buybackNote(s),
        ),
        h('td', { class: 'num', 'data-label': `살 때 (${unit})` }, buyCell),
        h('td', { class: 'num', 'data-label': `팔 때 (${unit})` }, sellCell),
        isGold
          ? h('td', { class: 'num', 'data-label': '팔 때 18K / 14K' }, k18 || k14 ? `${k18 ? num(k18) : '-'} / ${k14 ? num(k14) : '-'}` : '-')
          : null,
        h('td', { class: 'cell-when', 'data-label': '기준' }, shopWhen(s)),
      );
    }),
  );

  $('#shops-foot').textContent = isGold
    ? '살 때는 부가세 포함 가격입니다. 18K·14K는 살 때 가격이 제품마다 달라 팔 때만 보여 줍니다. 실제 매입가는 순도 감정 후 정해지고, 골드바는 제작비가 붙을 수 있어요.'
    : '은은 3.75g 기준 고시가입니다. 실버바는 아래 "최저가 찾기"에서 무게별로 비교하세요.';
}

// ---------- 내 위치와 내 주변 매장 ----------

/** 고른 범위를 실제로 쓸 수 있는 값으로 맞춥니다 (시·군·구를 안 골랐으면 km 범위는 못 씀). */
function effectiveArea() {
  const { region, district, area } = state.location;
  if (!region) return 'all';
  if (!district) return area === 'all' ? 'all' : 'region';
  return area;
}

function areaQuery() {
  const area = effectiveArea();
  return area.startsWith('km') ? { area: 'km', radiusKm: Number(area.slice(2)) } : { area };
}

function locationLabel() {
  const { region, district } = state.location;
  return region ? `${region}${district ? ` ${district}` : ''}` : '';
}

function scopeLabel() {
  const area = effectiveArea();
  if (area === 'all') return '전국';
  if (area === 'region') return `${state.location.region} 전체`;
  if (area === 'district') return locationLabel();
  return `${locationLabel()} 근처 ${AREAS[area]}`;
}

/** 위치 기준으로 가격·거리를 붙인 매장 목록 (업체·검색 필터 적용 전) */
function nearbyRows(extra = {}) {
  const { region, district, sort } = state.location;
  return rankNearby({
    branches: state.data?.branches ?? [],
    shops: state.data?.shops ?? [],
    user: { region, district },
    metal: state.metal,
    sort,
    vatRate: state.settings.vatRate,
    ...areaQuery(),
    ...extra,
  });
}

function branchMatches(b, f) {
  if (f.chain && b.chain !== f.chain) return false;
  if (f.q) {
    const hay = `${b.chainName} ${b.name} ${b.address ?? ''} ${b.area ?? ''} ${b.region ?? ''} ${b.district ?? ''}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

function fillSelect(sel, options, current) {
  sel.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
  sel.value = options.some(([v]) => v === current) ? current : options[0]?.[0] ?? '';
}

function renderLocationControls() {
  const all = state.data?.branches ?? [];
  const loc = state.location;
  const count = (pred) => all.filter(pred).length;

  fillSelect(
    $('#loc-region'),
    [['', '시·도 선택'], ...REGIONS.map((r) => [r, `${r} (매장 ${count((b) => b.region === r)}곳)`])],
    loc.region,
  );
  const districts = loc.region ? districtsOf(loc.region) : [];
  fillSelect(
    $('#loc-district'),
    [
      ['', loc.region ? '전체 (시·군·구 선택)' : '시·도를 먼저 고르세요'],
      ...districts.map((d) => {
        const n = count((b) => b.region === loc.region && b.district === d);
        return [d, n ? `${d} (매장 ${n})` : d];
      }),
    ],
    loc.district,
  );
  $('#loc-district').disabled = !loc.region;

  const areas = !loc.region ? ['all'] : !loc.district ? ['region', 'all'] : Object.keys(AREAS);
  fillSelect(
    $('#loc-area'),
    areas.map((a) => [a, a === 'region' && loc.region ? `${loc.region} 전체` : AREAS[a]]),
    effectiveArea(),
  );
  $('#loc-sort').value = loc.sort;

  const chains = [...new Map(all.map((b) => [b.chain, b.chainName])).entries()];
  fillSelect($('#branch-chain'), [['', '모든 업체'], ...chains.map(([id, name]) => [id, `${name} (${count((b) => b.chain === id)})`])], state.branchFilter.chain);
  if ($('#branch-q').value !== state.branchFilter.q) $('#branch-q').value = state.branchFilter.q;

  $('#loc-chip').textContent = loc.region ? `내 위치: ${locationLabel()}` : '내 위치 설정';
}

/** 매장 이름 (업체 이름이 빠져 있으면 붙임) */
function branchTitle(b) {
  return b.name.startsWith(b.chainName.slice(0, 3)) ? b.name : `${b.chainName} ${b.name}`;
}

function distanceText(r) {
  if (r.sameDistrict) return `같은 ${r.branch.district.slice(-1)}`;
  if (r.distanceKm == null) return null;
  return r.distanceKm < 1.5 ? '약 1km' : `약 ${Math.round(r.distanceKm)}km`;
}

const unitLabel = () => (state.metal === 'gold' ? '순금 1돈' : '은 3.75g');

function summaryStat(label, main, ...sub) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'stat-main' }, main), h('div', { class: 'muted small' }, ...sub));
}

function renderNearbySummary(rows) {
  const box = $('#nearby-summary');
  const unit = unitLabel();
  const stats = [];
  const { buy, sell } = nearbyBest(rows);
  const where = (r) => [branchTitle(r.branch), distanceText(r)].filter(Boolean).join(' · ');

  if (buy) stats.push(summaryStat(`${unit} 살 때 가장 싼 곳`, h('strong', null, won(buy.buy)), where(buy)));
  if (sell) stats.push(summaryStat(`${unit} 팔 때 가장 비싸게 사 주는 곳`, h('strong', null, won(sell.sell)), where(sell)));

  // 전국 매장 최저가와 비교 (집 근처가 전국 최저보다 얼마나 비싼지)
  if (state.location.region && buy) {
    const nation = nearbyBest(nearbyRows({ area: 'all' })).buy;
    if (nation) {
      const gap = buy.buy - nation.buy;
      stats.push(
        summaryStat(
          '전국 매장 최저 (살 때)',
          h('strong', null, won(nation.buy)),
          `${branchTitle(nation.branch)}${nation.branch.region ? ` · ${nation.branch.region}` : ''}`,
          h('br'),
          gap > 0 ? `내 주변 최저보다 ${won(gap)} 쌈` : '내 주변 최저와 같은 값',
        ),
      );
    }
  }

  // 매장에 가지 않고 택배로 받는 골드바 최저가
  if (state.metal === 'gold') {
    const online = rankOffers(
      allOffers().filter((o) => o.reach === 'online'),
      { metal: 'gold', sizeG: 3.75, qty: 1, settings: state.settings },
    )[0];
    if (online) stats.push(summaryStat('택배로 받기 (3.75g 골드바 최저)', h('strong', null, won(online.total)), online.offer.channelName));
  }

  const parts = [];
  if (!state.location.region) {
    parts.push(h('p', { class: 'notice' }, '위에서 시·도(와 시·군·구)를 고르거나 "현재 위치로 찾기"를 누르면 집 근처 매장만 골라 보여 드립니다. 지금은 전국 매장을 보여 줍니다.'));
  } else if (!buy && !sell) {
    parts.push(h('p', { class: 'notice' }, `${scopeLabel()}에는 오늘 가격을 공개한 매장이 없습니다. 범위를 넓혀 보세요.`));
  }
  if (stats.length) parts.push(h('div', { class: 'stats' }, ...stats));
  box.replaceChildren(...parts);
}

function nearbyCard(r, { cheapest, bestSell, chainSize }) {
  const b = r.branch;
  const mapQuery = b.address ?? `${b.chainName} ${b.name}`;
  const priced = r.buy || r.sell;
  const basis = r.shop
    ? [
        (chainSize.get(b.quoteId) ?? 0) > 1 ? '본사 고시가' : '매장 고시가',
        shopWhen(r.shop),
        r.buy && !r.shop.buyVatIncluded ? '살 때는 VAT별도 표기라 10%를 더한 값' : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;
  const place = [distanceText(r), [b.region, b.district].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: `card branch${r === cheapest ? ' is-best' : ''}` },
    h(
      'div',
      { class: 'branch-head' },
      h('strong', null, branchTitle(b)),
      r === cheapest ? h('span', { class: 'badge' }, '가장 쌈') : null,
      r === bestSell ? h('span', { class: 'badge sell' }, '가장 비싸게 사 줌') : null,
      b.opening ? h('span', { class: 'badge soft' }, '오픈 예정') : null,
    ),
    priced
      ? h(
          'div',
          { class: 'branch-price' },
          h('span', null, h('span', { class: 'muted' }, '살 때 '), r.buy ? h('strong', null, won(r.buy)) : '-'),
          h('span', null, h('span', { class: 'muted' }, '팔 때 '), r.sell ? h('strong', null, won(r.sell)) : '-'),
        )
      : h('div', { class: 'branch-price muted' }, '오늘 가격 미공개 · 전화로 문의'),
    basis ? h('div', { class: 'branch-meta small' }, basis) : null,
    h(
      'div',
      { class: 'branch-meta' },
      place ? `${place} · ` : '',
      b.address ?? (b.area ? `${b.area} (상세 주소는 업체에 문의)` : '주소는 업체에 문의 (홈페이지에 지점 이름만 공개)'),
    ),
    b.hours ? h('div', { class: 'branch-meta' }, `영업시간 ${b.hours}`) : null,
    h(
      'div',
      { class: 'branch-links' },
      b.phone ? h('a', { href: `tel:${b.phone.replace(/[^0-9]/g, '')}` }, `전화 ${b.phone}`) : null,
      h('a', { href: `https://map.naver.com/p/search/${encodeURIComponent(mapQuery)}`, target: '_blank', rel: 'noopener noreferrer' }, '지도 보기 ↗'),
      link(b.url, '홈페이지 ↗'),
    ),
  );
}

function renderNearby() {
  const all = state.data.branches ?? [];
  $('#nearby-section').hidden = !all.length;
  if (!all.length) return;

  const rows = nearbyRows().filter((r) => branchMatches(r.branch, state.branchFilter));
  renderNearbySummary(rows);

  const chainSize = new Map();
  for (const b of all) chainSize.set(b.quoteId, (chainSize.get(b.quoteId) ?? 0) + 1);
  const { buy: cheapest, sell: bestSell } = nearbyBest(rows);

  // 범위 안에 매장이 없으면 가장 가까운 매장을 대신 보여 줍니다
  let list = rows;
  let fallback = false;
  if (!rows.length && state.location.district) {
    list = nearbyRows({ area: 'all', sort: 'distance' })
      .filter((r) => r.distanceKm != null && branchMatches(r.branch, state.branchFilter))
      .slice(0, 5);
    fallback = list.length > 0;
  }

  const priced = rows.filter((r) => r.buy || r.sell).length;
  const sortText = { price: '살 때 싼 순', sell: '팔 때 비싼 순', distance: '가까운 순' }[state.location.sort];
  const shown = Math.min(list.length, state.nearbyLimit);
  $('#nearby-count').textContent = fallback
    ? `${scopeLabel()}에는 매장이 없어 가장 가까운 매장 ${list.length}곳을 보여 드립니다.`
    : rows.length
      ? `${scopeLabel()} 매장 ${rows.length}곳 (오늘 가격 공개 ${priced}곳) · ${sortText} · ${shown}곳 표시 중`
      : '조건에 맞는 매장이 없습니다. 범위를 넓히거나 검색어를 지워 보세요.';

  $('#nearby-list').replaceChildren(...list.slice(0, state.nearbyLimit).map((r) => nearbyCard(r, { cheapest, bestSell, chainSize })));

  const rest = list.length - state.nearbyLimit;
  const more = $('#nearby-more');
  more.hidden = rest <= 0;
  more.textContent = `${Math.min(NEARBY_PAGE, rest)}곳 더 보기`;
  const allBtn = $('#nearby-all');
  allBtn.hidden = rest <= NEARBY_PAGE;
  allBtn.textContent = `전체 ${list.length}곳 모두 보기`;
}

/** 매장 시세 표: 그 업체 매장 중 내 위치에서 가까운 곳 */
function nearNote(shop) {
  if (!state.location.region) return null;
  const branches = (state.data.branches ?? []).filter((b) => b.quoteId === shop.id);
  if (!branches.length) return null;
  const inArea = rankNearby({ branches, shops: [], user: state.location, ...areaQuery() });
  if (inArea.length) return h('div', { class: 'cell-note near' }, `내 주변 매장 ${inArea.length}곳`);
  const nearest = rankNearby({ branches, shops: [], user: state.location, area: 'all', sort: 'distance' })[0];
  return nearest?.distanceKm != null ? h('div', { class: 'cell-note' }, `가장 가까운 매장 약 ${Math.round(nearest.distanceKm)}km`) : null;
}

/**
 * 구매처를 어디서 이용할 수 있는지: 택배·전국 영업점은 어디서나, 매장 방문형은 내 주변에 매장이 있을 때만.
 * @returns {{ label: string, nearby: boolean }}
 */
function reachInfo(o) {
  if (o.source === 'manual') return { label: '직접 입력', nearby: true };
  if (o.reach === 'online') return { label: '택배 배송', nearby: true };
  if (o.reach === 'nationwide') return { label: o.kind === 'krx' ? '증권사 계좌 · 전국' : '은행 영업점 · 전국', nearby: true };
  // 이 구매처 가격을 쓰는 매장: 같은 업체(chain)이거나 같은 시세(quoteId)를 붙인 매장
  const branches = (state.data?.branches ?? []).filter((b) => b.chain === o.source || b.quoteId === o.channelId);
  if (!branches.length) return { label: '매장 방문', nearby: !state.location.region };
  if (!state.location.region) return { label: `매장 ${branches.length}곳`, nearby: true };
  const inArea = rankNearby({ branches, shops: [], user: state.location, ...areaQuery() });
  if (inArea.length) return { label: `내 주변 매장 ${inArea.length}곳`, nearby: true };
  const nearest = rankNearby({ branches, shops: [], user: state.location, area: 'all', sort: 'distance' })[0];
  return {
    label:
      nearest?.distanceKm != null
        ? `주변 매장 없음 · 가장 가까운 곳 약 ${Math.round(nearest.distanceKm)}km`
        : `주변 매장 없음 (${branches[0].region ?? '다른 지역'})`,
    nearby: false,
  };
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

  $('#nearby-only-wrap').hidden = !state.location.region;
  $('#nearby-only').checked = state.nearbyOnly;
  const filtered = state.location.region && state.nearbyOnly ? offers.filter((o) => reachInfo(o).nearby) : offers;
  const ranked = rankOffers(filtered, {
    metal: state.metal,
    sizeG: size,
    qty: state.qty,
    settings: state.settings,
    spotPerGram: spotFor(state.metal),
  });
  const total = rankOffers(offers, { metal: state.metal, sizeG: size }).length;
  // 몇 곳 중 몇 곳인지 분명히: 잘라 낸 순위가 아니라 이 중량을 파는 곳 전부입니다
  $('#ranking-count').textContent =
    ranked.length === total
      ? `${formatWeight(size)} 상품을 파는 ${total}곳 전부를 총비용이 싼 순서로 보여 줍니다 (1위가 추천).`
      : `${formatWeight(size)} 상품을 파는 ${total}곳 중 내 주변에서 살 수 있는 ${ranked.length}곳을 싼 순서로 보여 줍니다.`;
  $('#explain').textContent = explainRecommendation(ranked);
  ranking.replaceChildren(
    ...(ranked.length ? ranked.map((q, i) => offerCard(q, i)) : [h('li', { class: 'card empty' }, '내 주변에서 살 수 있는 곳이 없습니다. 체크를 풀면 전체를 볼 수 있어요.')]),
  );
}

function offerCard(q, i) {
  const o = q.offer;
  const isBest = i === 0;
  const status = sourceStatus(o.source);
  const badges = [];
  if (isBest) badges.push(h('span', { class: 'badge' }, '추천'));
  if (o.source === 'manual') badges.push(h('span', { class: 'badge soft' }, '직접 입력'));
  if (status?.stale) badges.push(h('span', { class: 'badge soft' }, '지연된 가격'));
  const reach = reachInfo(o);

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
    h('div', { class: `offer-reach${reach.nearby ? '' : ' far'}` }, reach.label),
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
        `가격 기준 ${o.quotedAt ? when(o.quotedAt) : o.quotedDate ? shortDate(o.quotedDate, true) : '시각 미표기'}`,
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

function sourceItem(s) {
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
}

function renderSources() {
  // 시세 출처를 먼저, 매장 목록 출처(하루 한 번 갱신)는 접어서 따로 보여 줍니다
  const isStoreList = (s) => /-stores$/.test(s.id);
  const prices = state.data.sources.filter((s) => !isStoreList(s));
  const stores = state.data.sources.filter(isStoreList);
  const storeCount = (state.data.branches ?? []).length;
  const bad = stores.filter((s) => !s.ok).length;
  $('#sources').replaceChildren(
    ...prices.map(sourceItem),
    stores.length
      ? h(
          'li',
          { class: 'sources-group' },
          h(
            'details',
            null,
            h('summary', null, `매장 목록 출처 ${stores.length}곳 · 매장 ${storeCount}곳 (하루 한 번 갱신)${bad ? ` · 확인 필요 ${bad}곳` : ''}`),
            h('ul', { class: 'sources' }, ...stores.map(sourceItem)),
          ),
        )
      : null,
  );
  $('#not-covered').textContent =
    '자동으로 모으지 못하는 곳: KB국민·신한·우리·NH농협 은행 골드바, 한국표준금거래소 본사 시세·지점 목록과 해외 접속을 막는 일부 지방 매장(국내에서 실행하면 수집될 수 있음), 순금나라·한국금거래소 소매 사이트(접속 차단), 홈페이지가 없는 동네 금은방. 이런 곳의 가격은 "내가 받은 견적 비교하기"에 넣으면 함께 비교됩니다.';
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

// 내 위치·매장 필터
function setLocation(patch) {
  state.location = { ...state.location, ...patch };
  if (!state.location.region) state.location.district = '';
  state.nearbyLimit = NEARBY_PAGE;
  store.set('location', state.location);
  if (state.data) render();
}
function setBranchFilter(patch) {
  state.branchFilter = { ...state.branchFilter, ...patch };
  state.nearbyLimit = NEARBY_PAGE;
  store.set('branchFilter', state.branchFilter);
  renderNearby();
}
$('#loc-region').addEventListener('change', (e) => setLocation({ region: e.target.value, district: '' }));
$('#loc-district').addEventListener('change', (e) => {
  // 시·군·구를 처음 고르면 범위를 "20km 안"으로 맞춰 이웃 시·군 매장도 함께 보이게 합니다
  const area = e.target.value && !state.location.district && ['region', 'all'].includes(state.location.area) ? 'km20' : state.location.area;
  setLocation({ district: e.target.value, area });
});
$('#loc-area').addEventListener('change', (e) => setLocation({ area: e.target.value }));
$('#loc-sort').addEventListener('change', (e) => setLocation({ sort: e.target.value }));
$('#branch-chain').addEventListener('change', (e) => setBranchFilter({ chain: e.target.value }));
$('#branch-q').addEventListener('input', (e) => setBranchFilter({ q: e.target.value.trim() }));
$('#nearby-more').addEventListener('click', () => {
  state.nearbyLimit += NEARBY_PAGE;
  renderNearby();
});
$('#nearby-all').addEventListener('click', () => {
  state.nearbyLimit = Infinity;
  renderNearby();
});
$('#nearby-only').addEventListener('change', (e) => {
  state.nearbyOnly = e.target.checked;
  store.set('nearbyOnly', state.nearbyOnly);
  renderFinder();
});

// 현재 위치: 좌표는 가장 가까운 시·군·구를 고르는 데만 쓰고 저장하거나 보내지 않습니다
$('#loc-gps').addEventListener('click', () => {
  const status = $('#loc-status');
  if (!('geolocation' in navigator)) {
    status.textContent = '이 브라우저는 위치 기능을 지원하지 않습니다. 시·도와 시·군·구를 직접 골라 주세요.';
    return;
  }
  status.textContent = '현재 위치를 확인하는 중…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const d = nearestDistrict(pos.coords.latitude, pos.coords.longitude);
      if (!d || d.km > 60) {
        status.textContent = '국내 위치를 찾지 못했습니다. 시·도와 시·군·구를 직접 골라 주세요.';
        return;
      }
      const area = ['region', 'all'].includes(state.location.area) ? 'km20' : state.location.area;
      setLocation({ region: d.region, district: d.district, area });
      status.textContent = `현재 위치에서 가장 가까운 ${d.region} ${d.district}(으)로 설정했습니다. 좌표는 저장하거나 보내지 않습니다.`;
    },
    (err) => {
      status.textContent =
        err.code === 1
          ? '위치 권한이 거부되었습니다. 시·도와 시·군·구를 직접 골라 주세요.'
          : '현재 위치를 가져오지 못했습니다. 시·도와 시·군·구를 직접 골라 주세요.';
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 10 * 60 * 1000 },
  );
});

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

if (IS_STATIC) $('#static-note').hidden = false;
load();
setInterval(() => {
  if (document.visibilityState === 'visible') load();
}, REFRESH_MS);
