// 모든 출처에서 시세와 구매처 가격을 모아 하나로 합칩니다.
// 출처마다 캐시를 두고, 실패하면 마지막으로 성공한 데이터를 "지연됨" 표시와 함께 돌려줍니다.
import { GRAMS_PER_DON, spotKrwPerGram } from '../shared/compare.js';
import { DEALERS, fetchDealer } from './sources/dealers.js';
import { fetchGoldie } from './sources/goldie.js';
import { fetchGoldmarket } from './sources/goldmarket.js';
import { fetchHana } from './sources/hana.js';
import { BUSAN_URL, fetchKgs, fetchKgsBusan } from './sources/kgs.js';
import { fetchKgx, KGX_PAGE } from './sources/kgx.js';
import { fetchKomsco, KOMSCO_URLS } from './sources/komsco.js';
import { fetchKsgold } from './sources/ksgold.js';
import { fetchNaver } from './sources/naver.js';
import { fetchSsgold } from './sources/ssgold.js';

const MINUTE = 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 1000;

export const SOURCES = [
  {
    id: 'naver',
    name: '네이버 증권 (KRX 금시장·국제 시세·환율)',
    url: 'https://m.stock.naver.com/marketindex/metals/M04020000',
    ttlMs: 1 * MINUTE,
    fetch: fetchNaver,
  },
  {
    id: 'hana',
    name: '하나은행 골드바·실버바 고시가',
    url: 'https://www.kebhana.com/cont/mall/mall14/mall1402/index.jsp',
    ttlMs: 1 * MINUTE,
    fetch: fetchHana,
  },
  {
    id: 'komsco',
    name: '한국조폐공사 쇼핑몰',
    url: KOMSCO_URLS.goldPrice,
    ttlMs: 5 * MINUTE,
    fetch: fetchKomsco,
  },
  {
    id: 'kgx',
    name: '한국금거래소 시세 (도매·매입)',
    url: KGX_PAGE,
    ttlMs: 1 * MINUTE,
    fetch: fetchKgx,
  },
  // ---- 금은방·금거래소 매장 시세와 쇼핑몰 가격 ----
  {
    id: 'ksgold',
    name: '한국금거래소 고시가 (대한표준금거래소 제공)',
    url: 'http://www.ksgold.co.kr/price.php',
    ttlMs: 10 * MINUTE,
    fetch: fetchKsgold,
  },
  {
    id: 'kgs',
    name: '한국표준금거래소 (본사 시세·쇼핑몰)',
    url: 'https://goldgold.co.kr/custom/html/kgs_chart_gold.html',
    ttlMs: 15 * MINUTE,
    fetch: fetchKgs,
  },
  {
    id: 'goldmarket',
    name: '한국금시장거래소 압구정점 (서울 강남)',
    url: 'https://www.goldmarket.co.kr/',
    ttlMs: 10 * MINUTE,
    fetch: fetchGoldmarket,
  },
  {
    id: 'kgs-busan',
    name: '한국표준금거래소 부산 지점',
    url: BUSAN_URL,
    ttlMs: 10 * MINUTE,
    fetch: fetchKgsBusan,
  },
  {
    id: 'ssgold',
    name: '삼성금거래소 공식몰',
    url: 'https://www.ssgold.co.kr/',
    ttlMs: 15 * MINUTE,
    fetch: fetchSsgold,
  },
  {
    id: 'goldie',
    name: '금골디 (제휴 금은방 매입 시세)',
    url: 'https://www.goldie.co.kr/',
    ttlMs: 10 * MINUTE,
    fetch: fetchGoldie,
  },
  // ---- 금거래소·금은방 사업자 홈페이지 (시세 + 골드바 판매가 + 지점 목록) ----
  ...DEALERS.map((def) => ({
    id: def.id,
    name: `${def.name}${def.quote === 'gbk' ? '' : ' (시세·판매가·지점)'}`,
    url: def.url,
    ttlMs: 15 * MINUTE,
    fetch: () => fetchDealer(def),
  })),
];

export function createCollector(sources = SOURCES, now = () => Date.now()) {
  const state = new Map();

  function load(src, force) {
    const st = state.get(src.id) ?? {};
    if (st.inflight) return st.inflight;
    const age = now() - (st.fetchedAt ?? 0);
    if (!force && st.data && age < src.ttlMs) return Promise.resolve(st);
    if (!force && st.failedAt && now() - st.failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(st);

    const inflight = Promise.resolve()
      .then(() => src.fetch())
      .then(
        (data) => ({ data, fetchedAt: now(), error: null }),
        (err) => ({ data: st.data, fetchedAt: st.fetchedAt, error: err?.message ?? String(err), failedAt: now() }),
      )
      .then((next) => {
        state.set(src.id, next);
        return next;
      });
    state.set(src.id, { ...st, inflight });
    return inflight;
  }

  return async function collect({ force = false } = {}) {
    const results = await Promise.all(sources.map((s) => load(s, force)));
    const market = {};
    const offers = [];
    const shops = [];
    const branches = [];
    const statuses = [];

    results.forEach((r, i) => {
      const src = sources[i];
      if (r.data) {
        Object.assign(market, r.data.market);
        offers.push(...r.data.offers);
        shops.push(...(r.data.shops ?? []));
        branches.push(...(r.data.branches ?? []));
      }
      statuses.push({
        id: src.id,
        name: src.name,
        url: src.url,
        ok: Boolean(r.data) && !r.error,
        stale: Boolean(r.data) && Boolean(r.error),
        error: r.error ?? null,
        warnings: r.data?.warnings ?? [],
        fetchedAt: r.fetchedAt ? new Date(r.fetchedAt).toISOString() : null,
      });
    });

    market.spot = computeSpot(market);
    const clean = dropImplausible({ shops, offers }, market.spot, { now: now() });
    for (const d of clean.dropped) {
      const st = statuses.find((x) => x.id === d.source);
      if (st) st.warnings = [...st.warnings, d.reason];
    }
    return {
      generatedAt: new Date(now()).toISOString(),
      market,
      offers: clean.offers,
      shops: clean.shops,
      branches,
      sources: statuses,
    };
  };
}

/**
 * 국제 시세를 원/g으로 환산한 기준가(부가세 제외).
 * 실시간 현물 시세(한국금거래소) → 하나은행 기준가격 → 네이버 국제 선물 시세 순으로 씁니다.
 */
export function computeSpot(m) {
  const usdKrw = m.usdKrw?.value ?? m.kgx?.usdKrw ?? m.hana?.gold?.usdKrw ?? null;
  const pick = (metal, naverIndex) => {
    if (m.kgx?.spot?.[metal]?.perGram) {
      return { perGram: m.kgx.spot[metal].perGram, basis: '한국금거래소 국제 현물 시세 환산', at: m.kgx.at };
    }
    if (m.hana?.[metal]?.perGram) {
      return { perGram: m.hana[metal].perGram, basis: '하나은행 기준가격', at: m.hana[metal].at };
    }
    if (naverIndex?.value && usdKrw) {
      return { perGram: spotKrwPerGram(naverIndex.value, usdKrw), basis: '국제 선물 시세 × 환율', at: naverIndex.at };
    }
    return null;
  };
  return { usdKrw, gold: pick('gold', m.intlGold), silver: pick('silver', m.intlSilver) };
}

/**
 * 국제 시세와 너무 동떨어진 가격은 화면 구조가 바뀌어 엉뚱한 칸을 읽은 것일 가능성이 커서 걸러냅니다.
 * 순위에 잘못된 "최저가"가 올라가는 것보다 빠지는 편이 안전합니다.
 */
export function dropImplausible({ shops, offers }, spot, { vatRate = 0.1, now = Date.now(), maxAgeDays = 7 } = {}) {
  const dropped = [];
  const goldDon = spot?.gold?.perGram ? spot.gold.perGram * GRAMS_PER_DON : null;
  const badShopIds = new Set();
  const staleSources = new Set();
  const today = new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const keptShops = shops.filter((shop) => {
    // 홈페이지 시세가 며칠째 그대로(갱신 안 됨)이면 지금 가격이 아니므로 제외
    if (shop.date) {
      const age = Math.round((Date.parse(today) - Date.parse(shop.date)) / 86400000);
      if (age > maxAgeDays) {
        badShopIds.add(shop.id);
        staleSources.add(shop.source);
        dropped.push({ source: shop.source, reason: `${shop.name}: 시세 날짜가 ${shop.date}로 ${age}일 전이라 제외했습니다` });
        return false;
      }
    }
    const g = shop.prices?.gold24k;
    if (!goldDon || !g) return true;
    const buy = g.buy && !shop.buyIsReference ? g.buy * (shop.buyVatIncluded ? 1 : 1 + vatRate) : null;
    const reasons = [];
    if (g.sell && (g.sell < goldDon * 0.85 || g.sell > goldDon * 1.1)) reasons.push(`팔 때 ${g.sell.toLocaleString('ko-KR')}원`);
    if (buy && (buy < goldDon * 0.95 || buy > goldDon * 1.6)) reasons.push(`살 때 ${Math.round(buy).toLocaleString('ko-KR')}원`);
    if (!reasons.length) return true;
    badShopIds.add(shop.id);
    dropped.push({ source: shop.source, reason: `${shop.name}: ${reasons.join('·')}이(가) 국제 시세(1돈 약 ${Math.round(goldDon).toLocaleString('ko-KR')}원)와 너무 달라 제외했습니다` });
    return false;
  });

  const keptOffers = offers.filter((o) => {
    if (badShopIds.has(o.channelId) || staleSources.has(o.source)) return false;
    if (o.kind !== 'fixed') return true;
    const per = spot?.[o.metal]?.perGram;
    if (!per) return true;
    const perGram = (o.vatIncluded ? o.unitPrice : o.unitPrice * (1 + vatRate)) / o.sizeG;
    const [lo, hi] = o.metal === 'gold' ? [0.95, 2.2] : [0.95, 3.5];
    if (perGram >= per * lo && perGram <= per * hi) return true;
    dropped.push({ source: o.source, reason: `${o.channelName} ${o.sizeG}g: g당 ${Math.round(perGram).toLocaleString('ko-KR')}원이 국제 시세와 너무 달라 제외했습니다` });
    return false;
  });

  return { shops: keptShops, offers: keptOffers, dropped };
}
