// 한국금거래소 소비자 고시가 (순금·18K·14K·백금·은, 3.75g 기준)
// 한국금거래소 소매 사이트(koreagoldx.co.kr)는 해외 IP를 막아서, 같은 고시가를 그대로 보여 주는
// 대한표준금거래소(ksgold.co.kr) 홈페이지의 공개 시세 API를 씁니다 (응답의 source가 "koreagoldx").
import { fetchJson, toNumber } from '../http.js';
import { shopQuoteOffer } from './shops.js';

const API = 'http://www.ksgold.co.kr/api/price.php';
const PAGE = 'http://www.ksgold.co.kr/price.php';

const KEYS = { gold_24k: 'gold24k', gold_18k: 'gold18k', gold_14k: 'gold14k', platinum: 'platinum', silver: 'silver' };

export function parseKsgold(json) {
  if (!json?.success || !Array.isArray(json.data)) throw new Error('한국금거래소 고시가 응답 형식이 다릅니다');
  const prices = {};
  let at = null;
  let source = null;
  for (const row of json.data) {
    const key = KEYS[row.metal];
    if (!key) continue;
    // buy_price는 매장이 사는 값(내가 팔 때), sell_price는 매장이 파는 값(내가 살 때)
    prices[key] = { buy: toNumber(row.sell_price), sell: toNumber(row.buy_price) };
    at ??= toIso(row.datetime);
    source ??= row.source;
  }
  // 18K·14K 살 때는 "제품 시세 적용"이라 실제 판매가가 아닙니다
  for (const k of ['gold18k', 'gold14k']) if (prices[k]) prices[k].buy = null;
  if (!prices.gold24k?.buy) throw new Error('한국금거래소 순금 고시가가 없습니다');

  return {
    id: 'kgx-retail',
    name: '한국금거래소',
    region: '서울 종로 본점 · 전국 가맹점',
    url: PAGE,
    source: 'ksgold',
    origin: source,
    prices,
    buyVatIncluded: true,
    at,
    date: at ? at.slice(0, 10) : null,
    notes: ['전국 금은방이 가장 많이 따르는 한국금거래소 고시가입니다 (대한표준금거래소 홈페이지에서 받아옴)'],
  };
}

export async function fetchKsgold() {
  const shop = parseKsgold(await fetchJson(API));
  return { market: {}, shops: [shop], offers: [shopQuoteOffer(shop)].filter(Boolean) };
}

function toIso(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s ?? ''));
  return m ? `${m[1]}T${m[2]}+09:00` : null;
}
