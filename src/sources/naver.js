// 네이버 증권 시세 API: KRX 금 현물, 국제 금·은, 원/달러 환율, 일별 추이
import { fetchJson, toNumber } from '../http.js';

const API = 'https://api.stock.naver.com/marketindex';
const HISTORY = 'https://m.stock.naver.com/front-api/marketIndex/prices';

export const NAVER_CODES = {
  krxGold: 'M04020000', // KRX 금 99.99_1kg (원/g)
  intlGold: 'GCcv1', // 국제 금 (USD/oz)
  intlSilver: 'SIcv1', // 국제 은 (USD/oz)
};

export function parseIndex(json) {
  const d = json?.exchangeInfo ?? json;
  const value = toNumber(d?.closePrice);
  if (value == null) throw new Error('네이버 시세 응답에 가격이 없습니다');
  return {
    name: d.name ?? null,
    value,
    change: toNumber(d.fluctuations),
    changePct: toNumber(d.fluctuationsRatio),
    unit: d.unit ?? null,
    at: d.localTradedAt ?? null,
    marketStatus: d.marketStatus ?? null,
  };
}

export function parseHistory(json) {
  const rows = Array.isArray(json?.result) ? json.result : [];
  return rows
    .map((r) => ({ date: String(r.localTradedAt).slice(0, 10), value: toNumber(r.closePrice) }))
    .filter((r) => r.value != null)
    .reverse(); // 오래된 날짜 → 최근 날짜
}

/** KRX 금시장에서 사서 100g/1kg 골드바로 인출하는 경로 */
export function krxOffers(krxGold) {
  if (!krxGold?.value) return [];
  return [100, 1000].map((sizeG) => ({
    id: `krx-gold-${sizeG}`,
    channelId: 'krx',
    channelName: 'KRX 금시장 → 실물 인출',
    vendor: '증권사 금현물 계좌',
    maker: 'KRX 인증 골드바',
    metal: 'gold',
    sizeG,
    kind: 'krx',
    summary: '증권사 계좌로 사서 실물로 인출',
    pricePerGram: krxGold.value,
    quotedAt: krxGold.at,
    source: 'naver',
    url: 'https://m.stock.naver.com/marketindex/metals/M04020000',
    notes: [
      '증권사 금현물 계좌가 필요합니다 (키움·미래에셋·한국투자·삼성 등)',
      `${sizeG === 100 ? '100g 종목(미니금)' : '1kg 종목'}으로 사야 ${sizeG === 100 ? '100g' : '1kg'} 골드바로 인출됩니다`,
      '인출 신청 후 영업일 며칠 뒤 지정 장소에서 수령 (증권사별 상이)',
      '거래시간 평일 09:00~15:30 · 수수료는 증권사마다 달라요',
    ],
  }));
}

export async function fetchNaver() {
  const [krxGold, intlGold, intlSilver, usdKrw, hGold, hIntlGold, hSilver] = await Promise.all([
    fetchJson(`${API}/metals/${NAVER_CODES.krxGold}`).then(parseIndex),
    fetchJson(`${API}/metals/${NAVER_CODES.intlGold}`).then(parseIndex),
    fetchJson(`${API}/metals/${NAVER_CODES.intlSilver}`).then(parseIndex),
    fetchJson(`${API}/exchange/FX_USDKRW`).then(parseIndex),
    history(NAVER_CODES.krxGold),
    history(NAVER_CODES.intlGold),
    history(NAVER_CODES.intlSilver),
  ]);
  return {
    market: {
      krxGold,
      intlGold,
      intlSilver,
      usdKrw: { ...usdKrw, provider: '하나은행 고시' },
      history: { krxGold: hGold, intlGold: hIntlGold, intlSilver: hSilver },
    },
    offers: krxOffers(krxGold),
  };
}

async function history(code) {
  try {
    const json = await fetchJson(`${HISTORY}?category=metals&reutersCode=${code}&page=1&pageSize=60`);
    return parseHistory(json);
  } catch {
    return []; // 추이 차트는 없어도 최저가 비교는 가능
  }
}
