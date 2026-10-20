// 한국조폐공사 공식 쇼핑몰 (오롯 골드바, 실버바). 가격은 부가세 포함, 금시세는 하루 3회 갱신.
import { load } from 'cheerio';
import { fetchText, toNumber } from '../http.js';

const BASE = 'https://www.koreamint.com';
export const KOMSCO_URLS = {
  gold: `${BASE}/goods/category.do?cate=2040`,
  silver: `${BASE}/goods/category.do?cate=2224`,
  goldPrice: `${BASE}/etc/gold_price_info.do?cate=1877`,
};

/** "오롯 골드바 1,000g" → 1000, "실버바 1kg" → 1000 */
export function parseProductWeight(name) {
  const m = /([\d,.]+)\s*(kg|g)\b/i.exec(name);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'kg' ? n * 1000 : n;
}

/** 상품 목록 페이지에서 {name, sizeG, price} 목록을 읽습니다. */
export function parseKomscoProducts(html) {
  const $ = load(html);
  const products = [];
  $('.item').each((_, el) => {
    const name = $(el).find('.item-title').first().text().replace(/\s+/g, ' ').trim();
    const price = toNumber($(el).find('.item-price .price').first().text());
    const sizeG = parseProductWeight(name);
    const soldOut = /품절|sold\s*out/i.test($(el).text());
    if (name && price && sizeG) products.push({ name, sizeG, price, soldOut });
  });
  return products;
}

/** 금시세정보 페이지: 국제시세·환율·g당 판매가(부가세 포함) */
export function parseKomscoGoldPrice(html) {
  const $ = load(html);
  const byLabel = {};
  $('table')
    .first()
    .find('th')
    .each((_, th) => {
      const label = $(th).text().replace(/\s+/g, ' ').trim();
      byLabel[label] = $(th).next('td').text().trim();
    });
  const find = (re) => {
    const key = Object.keys(byLabel).find((k) => re.test(k));
    return key ? toNumber(byLabel[key].replace(/\(.*\)/, '')) : null;
  };
  const stamp = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})시\s*(\d{1,2})분/.exec($('body').text());
  const at = stamp
    ? `${stamp[1]}-${pad(stamp[2])}-${pad(stamp[3])}T${pad(stamp[4])}:${pad(stamp[5])}:00+09:00`
    : null;
  return {
    intlUsdPerOz: find(/국제금시세/),
    usdKrw: find(/매매기준환율/),
    perGramUnder100: find(/판매가\(100g 미만\)/),
    perGram100Plus: find(/판매가\(100g 이상\)/),
    at,
  };
}

/** 같은 중량에 디자인 상품이 여러 개면 가장 싼 것 하나만 남깁니다 (같은 값이면 기본 상품 우선). */
export function komscoOffers(products, metal, quotedAt) {
  const bySize = new Map();
  for (const p of products) {
    if (p.soldOut) continue;
    const prev = bySize.get(p.sizeG);
    const better = !prev || p.price < prev.price || (p.price === prev.price && p.name.length < prev.name.length);
    if (better) bySize.set(p.sizeG, p);
  }
  return [...bySize.values()].map((p) => ({
    id: `komsco-${metal}-${p.sizeG}`,
    channelId: metal === 'gold' ? 'komsco' : 'komsco-silver',
    channelName: '한국조폐공사 쇼핑몰',
    vendor: '한국조폐공사',
    maker: '한국조폐공사',
    productName: p.name,
    metal,
    sizeG: p.sizeG,
    kind: 'fixed',
    summary: `${p.name} · 온라인 주문, 택배 배송`,
    unitPrice: p.price,
    vatIncluded: true,
    sellPrice: null,
    quotedAt,
    source: 'komsco',
    url: KOMSCO_URLS[metal],
    notes: [
      `상품명: ${p.name}`,
      '온라인 주문 후 택배 배송 · 재고와 배송비는 쇼핑몰에서 확인',
      metal === 'gold' ? '판매가는 하루 3번 금시세에 맞춰 바뀝니다' : '은 시세에 따라 가격이 바뀝니다',
    ],
  }));
}

export async function fetchKomsco() {
  const [goldHtml, silverHtml, priceHtml] = await Promise.all([
    fetchText(KOMSCO_URLS.gold),
    fetchText(KOMSCO_URLS.silver),
    fetchText(KOMSCO_URLS.goldPrice).catch(() => null),
  ]);
  const goldPrice = priceHtml ? parseKomscoGoldPrice(priceHtml) : null;
  const fetchedAt = new Date().toISOString();
  const offers = [
    ...komscoOffers(parseKomscoProducts(goldHtml), 'gold', goldPrice?.at ?? fetchedAt),
    ...komscoOffers(parseKomscoProducts(silverHtml), 'silver', fetchedAt),
  ];
  if (!offers.length) throw new Error('조폐공사 쇼핑몰에서 판매 중인 골드바·실버바를 찾지 못했습니다');
  return { market: { komsco: goldPrice }, offers };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
