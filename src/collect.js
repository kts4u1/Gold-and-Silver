// 모든 출처에서 시세와 구매처 가격을 모아 하나로 합칩니다.
// 출처마다 캐시를 두고, 실패하면 마지막으로 성공한 데이터를 "지연됨" 표시와 함께 돌려줍니다.
import { spotKrwPerGram } from '../shared/compare.js';
import { fetchHana } from './sources/hana.js';
import { fetchKgx, KGX_PAGE } from './sources/kgx.js';
import { fetchKomsco, KOMSCO_URLS } from './sources/komsco.js';
import { fetchNaver } from './sources/naver.js';

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
    const statuses = [];

    results.forEach((r, i) => {
      const src = sources[i];
      if (r.data) {
        Object.assign(market, r.data.market);
        offers.push(...r.data.offers);
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
    return { generatedAt: new Date(now()).toISOString(), market, offers, sources: statuses };
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
