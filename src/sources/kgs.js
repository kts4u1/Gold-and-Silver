// 한국표준금거래소 (KGS): 종로 본사 고시 시세, 공식 쇼핑몰 골드바 가격, 부산 지점 시세
import { load } from 'cheerio';
import { fetchJson, fetchText, toNumber } from '../http.js';
import { productOffers, shopQuoteOffer } from './shops.js';
import { cheapestBySize, parseCafe24List, parseKoreanDate } from './util.js';

const CHART_API = 'https://irena111.cafe24.com/api/custom/kgs_chart.php';
const CHART_PAGE = 'https://goldgold.co.kr/custom/html/kgs_chart_gold.html';
const SHOP_LIST = 'https://goldgold.co.kr/product/list.html?cate_no=57';
const SHOP_PAGES = 2;
export const BUSAN_URL = 'http://www.xn--v69atsro791a9mh55e7tb933a08xdjc.com/'; // 한국표준금거래소부산.com

// ---------- 본사 고시 시세 ----------

/**
 * 시세 차트 API 응답에서 가장 최근 날짜 값을 고릅니다.
 * 형식 (본사 시세 페이지 스크립트 기준): { buy: [{x: 날짜, y: 살 때}], sale: [{x, y: 팔 때, k18, k14}] }
 */
export function parseKgsChart(json) {
  const buy = Array.isArray(json?.buy) ? json.buy : [];
  const sale = Array.isArray(json?.sale) ? json.sale : [];
  if (!buy.length) throw new Error('한국표준금거래소 시세 응답 형식이 다릅니다');
  const time = (p) => new Date(p.x).getTime() || 0;
  const latestBuy = buy.reduce((a, b) => (time(b) > time(a) ? b : a));
  const sameDay = sale.find((s) => time(s) === time(latestBuy)) ?? sale.reduce((a, b) => (time(b) > time(a) ? b : a), sale[0]);
  return {
    date: new Date(time(latestBuy) + 9 * 3600 * 1000).toISOString().slice(0, 10),
    buy: toNumber(latestBuy.y),
    sell: toNumber(sameDay?.y),
    k18: toNumber(sameDay?.k18),
    k14: toNumber(sameDay?.k14),
  };
}

export function kgsHeadShop(chart) {
  return {
    id: 'kgs-head',
    name: '한국표준금거래소',
    region: '서울 종로 본사 · 전국 지점',
    url: CHART_PAGE,
    source: 'kgs',
    prices: {
      gold24k: { buy: chart.buy, sell: chart.sell },
      gold18k: { buy: null, sell: chart.k18 },
      gold14k: { buy: null, sell: chart.k14 },
    },
    buyVatIncluded: true,
    at: null,
    date: chart.date,
    notes: ['한국표준금거래소 본사 고시가 (전국 지점 공통)'],
  };
}

// ---------- 부산 지점 ----------

const BUSAN_ROWS = { '24K': 'gold24k', '18K': 'gold18k', '14K': 'gold14k', 백금: 'platinum', 은: 'silver' };

export function parseKgsBusan(html) {
  const $ = load(html);
  const table = $('.rw_table_one table').first();
  if (!table.length) throw new Error('부산 지점 시세 표를 찾지 못했습니다');
  const box = table.closest('.rl_one');
  const buyHead = table.find('thead th').eq(1).text();
  const prices = {};
  table.find('tbody tr').each((_, tr) => {
    const label = $(tr).find('td').first().text().replace(/\s+/g, '');
    const key = BUSAN_ROWS[label];
    if (!key) return;
    // cheerio의 .map()은 null을 빼 버리므로 배열로 바꿔서 자리를 지킵니다 (빈 칸 = null)
    const [buy, sell] = $(tr)
      .find('input')
      .toArray()
      .map((inp) => toNumber($(inp).attr('value')) || null);
    prices[key] = { buy: buy ?? null, sell: sell ?? null };
  });
  if (!prices.gold24k?.sell && !prices.gold24k?.buy) throw new Error('부산 지점 오늘 시세가 아직 올라오지 않았습니다');
  const vatExcluded = /VAT\s*별도/.test(buyHead);
  return {
    id: 'kgs-busan',
    name: '한국표준금거래소 부산',
    region: '부산 동래·남포·하단·해운대·수영점',
    url: BUSAN_URL,
    source: 'kgs-busan',
    prices,
    buyVatIncluded: !vatExcluded,
    at: null,
    date: parseKoreanDate(box.text()),
    notes: vatExcluded
      ? ['홈페이지에 살 때 가격이 "VAT별도"로 표기되어 있어 부가세 10%를 더해 비교합니다. 실제 포함 여부는 매장에 확인하세요']
      : [],
  };
}

// ---------- 수집 ----------

export async function fetchKgs() {
  const today = new Date();
  const from = new Date(today.getTime() - 10 * 86400 * 1000);
  const ymd = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const [chartRes, ...pageRes] = await Promise.allSettled([
    fetchJson(`${CHART_API}?startDate=${ymd(from)}&endDate=${ymd(today)}&mode=gold`, {
      headers: { referer: CHART_PAGE },
    }),
    ...Array.from({ length: SHOP_PAGES }, (_, i) => fetchText(`${SHOP_LIST}&page=${i + 1}`)),
  ]);

  const warnings = [];
  const shops = [];
  const offers = [];

  if (chartRes.status === 'fulfilled') {
    const shop = kgsHeadShop(parseKgsChart(chartRes.value));
    shops.push(shop);
    const offer = shopQuoteOffer(shop);
    if (offer) offers.push(offer);
  } else {
    const msg = chartRes.reason?.message ?? String(chartRes.reason);
    warnings.push(`본사 시세: ${/403/.test(msg) ? '해외 접속 차단(국내에서 실행하면 받아올 수 있음)' : msg}`);
  }

  const products = pageRes.filter((r) => r.status === 'fulfilled').flatMap((r) => parseCafe24List(r.value, SHOP_LIST));
  if (pageRes.every((r) => r.status === 'rejected')) warnings.push(`쇼핑몰: ${pageRes[0].reason?.message}`);
  offers.push(
    ...productOffers(cheapestBySize(products), {
      id: 'kgs-shop',
      channelName: '한국표준금거래소 쇼핑몰',
      vendor: '한국표준금거래소',
      summary: '온라인 주문, 택배 배송',
      url: SHOP_LIST,
      source: 'kgs',
      quotedAt: new Date().toISOString(),
      notes: ['디자인 골드바라 같은 중량이라도 상품마다 값이 다를 수 있습니다 (가장 싼 상품 기준)'],
    }),
  );

  if (!shops.length && !offers.length) throw new Error(warnings.join(' · ') || '한국표준금거래소 데이터를 받지 못했습니다');
  return { market: {}, shops, offers, warnings };
}

export async function fetchKgsBusan() {
  const shop = parseKgsBusan(await fetchText(BUSAN_URL));
  return { market: {}, shops: [shop], offers: [shopQuoteOffer(shop)].filter(Boolean) };
}
