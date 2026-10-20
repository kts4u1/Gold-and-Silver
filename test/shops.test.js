import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { quoteOffer, rankOffers } from '../shared/compare.js';
import { createCollector } from '../src/collect.js';
import { parseGoldie } from '../src/sources/goldie.js';
import { parseGoldmarket } from '../src/sources/goldmarket.js';
import { kgsHeadShop, parseKgsBusan, parseKgsChart } from '../src/sources/kgs.js';
import { parseKsgold } from '../src/sources/ksgold.js';
import { shopQuoteOffer } from '../src/sources/shops.js';
import { parseSsgold } from '../src/sources/ssgold.js';
import { cheapestBySize, detectMetal, parseCafe24List, parseKoreanDate, parseProductWeight } from '../src/sources/util.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const text = (name) => fs.readFileSync(path.join(dir, name), 'utf8');

describe('도우미', () => {
  it('상품명에서 중량·금속·날짜를 읽습니다', () => {
    assert.equal(parseProductWeight('황금개 골드바 11.25g [3돈]'), 11.25);
    assert.equal(parseProductWeight('주물 실버바 1000g'), 1000);
    assert.equal(parseProductWeight('사자 골드바 1,000g'), 1000);
    assert.equal(detectMetal('실버 그래뉼 1000g'), 'silver');
    assert.equal(detectMetal('주물 실버바 500g'), 'silver');
    assert.equal(detectMetal('프레스 골드바 3.75g'), 'gold');
    assert.equal(detectMetal('기념메달'), null);
    assert.equal(parseKoreanDate('오늘의 시세 2026년 10월 19일'), '2026-10-19');
    assert.equal(parseKoreanDate('2026-10-20 기준'), '2026-10-20');
  });
});

describe('한국금거래소 고시가 (대한표준금거래소 API)', () => {
  const shop = parseKsgold(JSON.parse(text('ksgold-price.json')));

  it('살 때·팔 때를 바르게 나눕니다 (API의 sell_price가 내가 살 때)', () => {
    assert.deepEqual(shop.prices.gold24k, { buy: 773000, sell: 668000 });
    assert.deepEqual(shop.prices.silver, { buy: 10190, sell: 8480 });
    assert.equal(shop.prices.gold18k.buy, null); // 제품 시세 적용이라 제외
    assert.equal(shop.prices.gold18k.sell, 491300);
    assert.equal(shop.at, '2026-10-20T09:49:30+09:00');
    assert.equal(shop.origin, 'koreagoldx');
  });

  it('순금 1돈 살 때 가격을 3.75g 구매처로 만들고, 같은 곳에 되파는 값을 붙입니다', () => {
    const offer = shopQuoteOffer(shop);
    assert.equal(offer.sizeG, 3.75);
    assert.equal(offer.unitPrice, 773000);
    assert.equal(offer.vatIncluded, true);
    const q = quoteOffer(offer);
    assert.equal(q.total, 773000);
    assert.equal(q.resale, 668000);
  });

  it('형식이 다르면 예외를 던집니다', () => {
    assert.throws(() => parseKsgold({ success: false }), /형식/);
  });
});

describe('한국금시장거래소 압구정점', () => {
  const { shop, products } = parseGoldmarket(text('goldmarket-home.html'));

  it('오늘의 시세와 날짜, 부가세 포함 여부를 읽습니다', () => {
    assert.deepEqual(shop.prices.gold24k, { buy: 788000, sell: 683000 });
    assert.equal(shop.buyVatIncluded, true);
    assert.equal(shop.date, '2026-10-19');
    assert.equal(shop.region, '서울 강남구 신사동');
  });

  it('사자 골드바 상품 가격을 읽습니다', () => {
    assert.equal(products.length, 7);
    assert.deepEqual(
      products.find((p) => p.sizeG === 100),
      { name: '사자 골드바 100g', sizeG: 100, metal: 'gold', price: 21227000 },
    );
    assert.equal(products.find((p) => p.sizeG === 1000).price, 212238000);
  });
});

describe('한국표준금거래소', () => {
  it('부산 지점: 숨겨진 입력값에서 시세를 읽고, 빈 칸은 비워 둡니다', () => {
    const shop = parseKgsBusan(text('kgs-busan-home.html'));
    assert.deepEqual(shop.prices.gold24k, { buy: 774000, sell: 668000 });
    assert.deepEqual(shop.prices.gold18k, { buy: null, sell: 491000 });
    assert.deepEqual(shop.prices.silver, { buy: 10090, sell: 7990 });
    assert.equal(shop.date, '2026-10-20');
  });

  it('부산 지점: "VAT별도" 표기를 따라 비교할 때 부가세를 더합니다', () => {
    const shop = parseKgsBusan(text('kgs-busan-home.html'));
    assert.equal(shop.buyVatIncluded, false);
    assert.equal(quoteOffer(shopQuoteOffer(shop)).total, 851400); // 774,000 + 부가세 77,400
  });

  it('부산 지점: 오늘 시세가 비어 있으면 예외를 던집니다', () => {
    const empty = text('kgs-busan-home.html').replace(/value="[\d,]+"/g, 'value=""');
    assert.throws(() => parseKgsBusan(empty), /아직 올라오지 않았습니다/);
  });

  it('본사 시세 API: 가장 최근 날짜 값을 고릅니다 (본사 시세 페이지 스크립트의 응답 형식)', () => {
    // 해외 IP에서는 403이라 실제 응답을 저장하지 못했습니다. 페이지 스크립트가 쓰는 형식대로 만든 예시입니다.
    const chart = parseKgsChart({
      buy: [
        { x: '2026-10-19', y: 790000 },
        { x: '2026-10-20', y: 775000 },
      ],
      sale: [
        { x: '2026-10-19', y: 680000, k18: 499800, k14: 387600 },
        { x: '2026-10-20', y: 669000, k18: 491700, k14: 381300 },
      ],
    });
    assert.deepEqual(chart, { date: '2026-10-20', buy: 775000, sell: 669000, k18: 491700, k14: 381300 });
    const shop = kgsHeadShop(chart);
    assert.equal(shopQuoteOffer(shop).unitPrice, 775000);
    assert.throws(() => parseKgsChart({}), /형식/);
  });

  it('쇼핑몰: 디자인 골드바 중 중량별로 가장 싼 상품을 고르고 실버 그래뉼도 은으로 분류합니다', () => {
    const products = cheapestBySize(parseCafe24List(text('kgs-shop-bars.html'), 'https://goldgold.co.kr/'));
    const bySize = Object.fromEntries(products.map((p) => [`${p.metal}:${p.sizeG}`, p.price]));
    assert.equal(bySize['gold:3.75'], 810000);
    assert.equal(bySize['gold:10'], 2083000);
    assert.equal(bySize['silver:1000'], 3018000);
    assert.ok(products.every((p) => p.sizeG >= 1)); // 0.02g 같은 기념품은 제외
  });
});

describe('삼성금거래소 공식몰', () => {
  it('정가·판매가가 겹쳐 있어도 판매가 하나만 읽습니다', () => {
    const products = parseSsgold(text('ssgold-home.html'));
    const find = (metal, sizeG) => products.find((p) => p.metal === metal && p.sizeG === sizeG);
    assert.equal(find('gold', 3.75).price, 810000);
    assert.equal(find('gold', 1000).price, 203727000);
    assert.equal(find('silver', 1000).price, 3080000);
    assert.equal(products.length, 13);
  });
});

describe('금골디', () => {
  it('페이지 데이터에서 1돈 시세를 읽고, 살 때 값은 참고용으로 둡니다', () => {
    const shop = parseGoldie(text('goldie-home.html'));
    assert.deepEqual(shop.prices.gold24k, { buy: 708803, sell: 667733 });
    assert.equal(shop.prices.gold14k.sell, 380607);
    assert.equal(shop.buyIsReference, true);
    assert.equal(shopQuoteOffer(shop), null);
  });
});

describe('매장 시세가 순위에 들어가는 방식', () => {
  it('3.75g 순위에서 매장 고시가와 은행 상품을 함께 비교합니다', () => {
    const kgx = shopQuoteOffer(parseKsgold(JSON.parse(text('ksgold-price.json'))));
    const bank = { id: 'b', channelName: '은행', metal: 'gold', sizeG: 3.75, kind: 'fixed', unitPrice: 706630, vatIncluded: false };
    const r = rankOffers([bank, kgx], { metal: 'gold', sizeG: 3.75 });
    assert.deepEqual(
      r.map((q) => q.offer.channelName),
      ['한국금거래소', '은행'],
    );
  });

  it('수집기는 출처별 매장 시세를 하나의 목록으로 합칩니다', async () => {
    const shop = (id) => ({ id, name: id, prices: {} });
    const collect = createCollector(
      [
        { id: 'a', name: 'A', url: 'x', ttlMs: 1000, fetch: async () => ({ market: {}, offers: [], shops: [shop('s1')] }) },
        { id: 'b', name: 'B', url: 'y', ttlMs: 1000, fetch: async () => ({ market: {}, offers: [], shops: [shop('s2')] }) },
        { id: 'c', name: 'C', url: 'z', ttlMs: 1000, fetch: async () => ({ market: {}, offers: [] }) },
      ],
      () => 0,
    );
    const data = await collect();
    assert.deepEqual(
      data.shops.map((s) => s.id),
      ['s1', 's2'],
    );
  });
});
