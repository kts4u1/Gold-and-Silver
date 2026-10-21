// 한국금시장거래소 압구정점 (서울 강남구 신사동): 홈페이지 "오늘의 시세"와 골드바 판매가
import { load } from 'cheerio';
import { fetchText, toNumber } from '../http.js';
import { productOffers, shopQuoteOffer } from './shops.js';
import { cheapestBySize, detectMetal, parseKoreanDate, parseProductWeight } from './util.js';

const URL = 'https://www.goldmarket.co.kr/';

export function parseGoldmarket(html) {
  const s = html.replace(/<!-- -->/g, '');
  const $ = load(s);

  // "오늘의 시세" 제목 옆 날짜와 바로 뒤 표
  const title = $('h3')
    .filter((_, el) => $(el).text().includes('오늘의 시세'))
    .first();
  if (!title.length) throw new Error('압구정점 오늘의 시세 표를 찾지 못했습니다');
  const date = parseKoreanDate(title.parent().text());
  const table = title.parent().nextAll('table').first();
  const headers = table
    .find('thead th')
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get();
  const row = table
    .find('tbody tr')
    .filter((_, el) => $(el).text().includes('순금'))
    .first();
  const [buy, sell] = row
    .find('td h3')
    .toArray()
    .map((el) => toNumber($(el).text()));
  if (!buy || !sell) throw new Error('압구정점 순금 시세를 읽지 못했습니다');

  const shop = {
    id: 'goldmarket-apgujeong',
    name: '한국금시장거래소 압구정점',
    region: '서울 강남구 신사동',
    url: URL,
    source: 'goldmarket',
    prices: { gold24k: { buy, sell } },
    buyVatIncluded: /VAT\s*포함/.test(headers[1] ?? ''),
    at: null,
    date,
    notes: ['자사 골드바 기준 시세입니다'],
  };

  // 골드바 상품 카드: <p>사자 골드바 100g</p><p>순도 …</p><p>21,227,000원</p>
  const products = [];
  for (const m of s.matchAll(/<p>([^<]*(?:골드바|실버바)[^<]*)<\/p>\s*<p>[^<]*<\/p>\s*<p>([\d,]+)원<\/p>/g)) {
    const name = m[1].replace(/\s+/g, ' ').trim();
    const sizeG = parseProductWeight(name);
    const metal = detectMetal(name);
    const price = toNumber(m[2]);
    if (sizeG && metal && price) products.push({ name, sizeG, metal, price });
  }

  return { shop, products: cheapestBySize(products) };
}

export async function fetchGoldmarket() {
  const { shop, products } = parseGoldmarket(await fetchText(URL));
  const offers = [
    shopQuoteOffer(shop),
    ...productOffers(products, {
      id: 'goldmarket-apgujeong',
      channelName: '한국금시장거래소 압구정점',
      vendor: '한국금시장거래소',
      summary: '압구정 매장 · 자체 골드바',
      url: URL,
      source: 'goldmarket',
      quotedDate: shop.date,
      notes: ['서울 강남구 압구정로28길 14 매장 · 재고는 매장에 확인하세요'],
    }),
  ].filter(Boolean);
  const branches = [
    {
      id: 'goldmarket-1',
      chain: 'goldmarket',
      chainName: '한국금시장거래소',
      source: 'goldmarket',
      quoteId: shop.id,
      url: URL,
      name: '압구정점',
      address: '서울 강남구 압구정로28길 14',
      phone: null,
      hours: null,
      opening: false,
      region: '서울',
    },
  ];
  return { market: {}, shops: [shop], offers, branches };
}
