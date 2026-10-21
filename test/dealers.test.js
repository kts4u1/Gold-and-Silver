import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dropImplausible } from '../src/collect.js';
import {
  DEALERS,
  fetchDealer,
  fetchDealerStores,
  parsePairQuote,
  parseBarsFromTokens,
  parseGbk,
  parseGoldkoreaBranches,
  parseGoodgoldBranches,
  parseJongroBranches,
  parseKaggoldBranches,
  parseKgoldBuyback,
  parseSamegoldBranches,
  parseSlotQuote,
  parseTableQuote,
  quoteToShop,
  validateQuote,
} from '../src/sources/dealers.js';
import { shopQuoteOffer } from '../src/sources/shops.js';
import { decodeBody } from '../src/http.js';
import { flatTokens, toRegion } from '../src/sources/util.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/dealers');
const html = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const tokens = (name) => flatTokens(html(name));
const def = (id) => DEALERS.find((d) => d.id === id);

const SLOT = {
  goodgold: { layout: 'header-first', startAfter: /^오늘의 시세$/, buy: /^내가 살 때$/, sell: /^내가 팔 때$/, labelsEnd: /^Silver$/i, slots: 5 },
  kgoldsilver: { layout: 'marker-first', startAfter: /^DOMESTIC GOLD PRICES$/, buy: /^살\s?때$/, sell: /^팔\s?때$/, slots: 5 },
  samegold: { layout: 'marker-first', startAfter: /^오늘의 국내시세 라인업$/, buy: /^내가 살 때$/, sell: /^내가 팔 때$/, slots: 6 },
};

describe('시세: 표 형식', () => {
  it('한국감정금거래소: 순금·18K·14K·백금·은 살 때/팔 때', () => {
    const q = parseTableQuote(html('goldkorea-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 777000, sell: 668000 });
    assert.deepEqual(q.prices.gold18k, { buy: null, sell: 491300 }); // 살 때 0원 = 없음
    assert.deepEqual(q.prices.silver, { buy: 10310, sell: 8580 });
    assert.equal(q.date, '2026-10-20');
    assert.equal(q.vatStated, false);
  });

  it('한국공인금거래소: "제품시세적용"은 살 때 없음으로 읽습니다', () => {
    const q = parseTableQuote(html('kaggold-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 777000, sell: 668000 });
    assert.deepEqual(q.prices.gold18k, { buy: null, sell: 490200 });
  });

  it('종로금거래소: 팔 때가 먼저 나오는 표와 "VAT별도"를 읽습니다', () => {
    const q = parseTableQuote(html('jongrogx-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 708000, sell: 667000 });
    assert.deepEqual(q.prices.silver, { buy: 9370, sell: 7500 });
    assert.equal(q.buyVatIncluded, false);
    assert.equal(q.vatStated, true);
  });
});

describe('시세: 칸 순서 형식', () => {
  it('국제표준금거래소: 머리글 뒤에 값이 이어지는 형식', () => {
    const q = parseSlotQuote(tokens('goodgold-home.html'), SLOT.goodgold);
    assert.deepEqual(q.prices.gold24k, { buy: 773000, sell: 668000 });
    assert.deepEqual(q.prices.gold14k, { buy: null, sell: 381200 });
    assert.deepEqual(q.prices.platinum, { buy: 307000, sell: 249000 });
    assert.deepEqual(q.prices.silver, { buy: 10110, sell: 8580 });
    assert.equal(q.date, '2026-10-20');
  });

  it('K-금은거래소: 변동폭(▼ 6,000)을 가격으로 착각하지 않습니다', () => {
    const q = parseSlotQuote(tokens('kgoldsilver-home.html'), SLOT.kgoldsilver);
    assert.deepEqual(q.prices.gold24k, { buy: 787000, sell: 680000 });
    assert.deepEqual(q.prices.gold18k, { buy: null, sell: 502000 });
    assert.deepEqual(q.prices.platinum, { buy: 316000, sell: 263000 });
  });

  it('삼이금거래소: 6칸(구리 포함)에서 변동폭 "14,000 (1.8%)"을 건너뜁니다', () => {
    const q = parseSlotQuote(tokens('samegold-home.html'), SLOT.samegold);
    assert.deepEqual(q.prices.gold24k, { buy: 774000, sell: 668000 });
    assert.deepEqual(q.prices.silver, { buy: 10190, sell: 8480 });
    assert.equal(q.buyVatIncluded, true);
    assert.equal(q.vatStated, true); // "VAT 포함"
  });

  it('시세 영역이 없으면 예외를 던집니다', () => {
    assert.throws(() => parseSlotQuote(['아무 글'], SLOT.goodgold), /시세 영역/);
  });

  it('K-금은거래소 품목별 매입시세(금·은)를 읽습니다', () => {
    const b = parseKgoldBuyback(tokens('kgoldsilver-home.html'));
    assert.equal(b.gold.length, 5);
    assert.deepEqual(b.gold[0], { label: '골드바, 덩어리(검인)', price: 680000 });
    assert.equal(b.silver.find((i) => /그래뉼/.test(i.label)).price, 10300);
  });

  it('GBK금거래소: 금고 보관형은 살 때만 참고용으로 보여 줍니다', () => {
    const q = parseGbk(tokens('gbk-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 693900, sell: null });
    const shop = quoteToShop(def('gbk'), q, []);
    assert.equal(shop.buyIsReference, true);
    assert.equal(shopQuoteOffer(shop), null); // 순위에는 넣지 않음
  });
});

describe('시세 검증', () => {
  it('팔 때가 살 때보다 높으면 칸을 잘못 읽은 것으로 보고 거부합니다', () => {
    assert.throws(() => validateQuote({ gold24k: { buy: 700000, sell: 780000 } }), /칸을 잘못 읽은/);
    assert.throws(() => validateQuote({ gold24k: { buy: 50, sell: 40 } }), /이상합니다/);
    assert.throws(() => validateQuote({ gold24k: { buy: 780000, sell: null } }), /모두 읽지 못/);
  });

  it('은 칸만 이상하면 은만 버리고 금 시세는 살립니다', () => {
    const prices = { gold24k: { buy: 780000, sell: 670000 }, silver: { buy: 8000, sell: 9000 } };
    validateQuote(prices);
    assert.deepEqual(prices.silver, { buy: null, sell: null });
  });

  it('부가세 표기가 없는 곳은 포함으로 보고 안내 문구를 붙입니다', () => {
    const q = parseTableQuote(html('goldkorea-home.html'));
    const shop = quoteToShop(def('goldkorea'), q, []);
    assert.match(shop.notes.join(' '), /부가세 포함 여부가 적혀 있지 않아/);
    assert.equal(shopQuoteOffer(shop).unitPrice, 777000);
  });
});

describe('골드바·실버바 판매가', () => {
  it('중량이 하나인 상품만 읽고, 여러 중량이 섞인 이름은 건너뜁니다', () => {
    const bars = parseBarsFromTokens([
      '국제표준금거래소 ISG 골드바 3.75g', '804,000원',
      '[기독교 골드바] 1g , 3.75g', '237,000원', // 중량이 둘: 건너뜀
      '실버바 1000g', '3,037,000원',
      '골드바 0.1g', '47,000원', // 1g 미만: 건너뜀
    ]);
    assert.deepEqual(
      bars.map((b) => [b.metal, b.sizeG, b.price]),
      [
        ['gold', 3.75, 804000],
        ['silver', 1000, 3037000],
      ],
    );
  });

  it('정가와 할인가가 같이 있으면 싼 값을 씁니다', () => {
    const [bar] = parseBarsFromTokens(['골드바 10g', '2,200,000원', '2,074,000원']);
    assert.equal(bar.price, 2074000);
  });

  it('홈페이지에서 실제로 읽어 옵니다', () => {
    const goodgold = parseBarsFromTokens(tokens('goodgold-home.html'));
    assert.ok(goodgold.some((b) => b.metal === 'gold' && b.sizeG === 3.75 && b.price === 804000));
    const goldkorea = parseBarsFromTokens(tokens('goldkorea-home.html'));
    assert.ok(goldkorea.some((b) => b.sizeG === 3.75 && b.price === 813000));
  });
});

describe('지점 목록', () => {
  it('국제표준금거래소 56곳: 주소·전화·영업시간과 오픈 예정 표시', () => {
    const list = parseGoodgoldBranches(tokens('goodgold-branches.html'));
    assert.equal(list.length, 56);
    const opening = list.find((b) => b.name === '목포점');
    assert.equal(opening.opening, true);
    assert.equal(opening.region, '전남');
    const dalseo = list.find((b) => b.name === '대구 달서점');
    assert.equal(dalseo.phone, '053-522-9171');
    assert.equal(dalseo.region, '대구');
    assert.match(dalseo.hours, /10:00/);
  });

  it('한국감정금거래소 37곳: 도시 이름만 있는 주소도 지역을 찾습니다', () => {
    const list = parseGoldkoreaBranches(tokens('goldkorea-branches.html'));
    assert.equal(list.length, 37);
    assert.equal(list.find((b) => b.name === '창원 북면점').region, '경남');
    assert.equal(list.find((b) => b.name === '청주점').phone, '043-900-6006');
    assert.equal(list.find((b) => /구영리/.test(b.name)).opening, true);
    assert.ok(list.every((b) => !/오픈/.test(b.name))); // 이름에서 "(오픈예정)" 제거
  });

  it('한국공인금거래소: 표에서 지점을 읽고 전체 건수를 알려 줍니다', () => {
    const { branches, total } = parseKaggoldBranches(html('kaggold-branches-p1.html'));
    assert.equal(branches.length, 15);
    assert.equal(total, 71);
    assert.deepEqual(branches[0], {
      name: '서울본사',
      address: '서울 종로구 돈화문로5가길 11(돈의동 132), 201호',
      phone: '02-766-3750',
      hours: null,
      opening: false,
      region: '서울',
    });
  });

  it('한국공인금거래소: "[사용안함]"으로 표시된 지점은 뺍니다', () => {
    const row = (name, addr) => `<tr><td>1</td><td>서울</td><td>${name}</td><td>${addr}</td><td>02-477-9894</td></tr>`;
    const { branches } = parseKaggoldBranches(
      `<table>${row('천호점', '[사용안함]서울특별시 강동구 천호대로 997')}${row('강동천호지점', '서울특별시 강동구 천호대로 1024')}</table>`,
    );
    assert.deepEqual(branches.map((b) => b.name), ['강동천호지점']);
  });

  it('삼이금거래소 8곳', () => {
    const list = parseSamegoldBranches(tokens('samegold-branches.html'));
    assert.equal(list.length, 8);
    assert.equal(list[0].name, '삼이금거래소 본점');
    assert.equal(list[0].region, '서울');
  });

  it('종로금거래소: 지사 이름만 읽고 스팸·숫자가 섞인 글은 버립니다', () => {
    const list = parseJongroBranches(tokens('jongrogx-branches.html'));
    assert.equal(list.length, 29);
    assert.equal(list.find((b) => b.name === '창원점').region, '경남');
    assert.ok(list.every((b) => /^[가-힣/ ]+$/.test(b.name)));
    const spam = ['서울', '종로금거래소 지사안내', '서울', '강남 룸 010-1234-5678 예약', '종로본점', '지점인지'];
    assert.deepEqual(parseJongroBranches(spam).map((b) => b.name), ['종로본점']);
  });

  it('지역 판별', () => {
    assert.equal(toRegion('전북특별자치도 완주군'), '전북');
    assert.equal(toRegion('충청북도 청주시'), '충북');
    assert.equal(toRegion('창원시 의창구'), '경남');
    assert.equal(toRegion('알 수 없는 곳'), null);
    assert.equal(toRegion('알 수 없는 곳', '부산'), '부산');
  });
});

describe('사업자 수집 (네트워크 없이)', () => {
  const realFetch = globalThis.fetch;
  const withFetch = async (routes, fn) => {
    globalThis.fetch = async (url) => {
      const body = routes[String(url)]; // 주소가 정확히 같은 것만 응답
      return body === undefined ? new Response('x', { status: 404 }) : new Response(body);
    };
    try {
      return await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('시세와 홈페이지 판매가를 모읍니다 (지점 목록은 따로)', async () => {
    const result = await withFetch({ 'https://www.goodgold.co.kr/': html('goodgold-home.html') }, () => fetchDealer(def('goodgold')));
    assert.equal(result.shops[0].prices.gold24k.buy, 773000);
    assert.deepEqual(result.branches, []);
    assert.ok(result.offers.some((o) => o.channelName === '국제표준금거래소 · 홈페이지 판매가' && o.sizeG === 3.75));
    assert.ok(result.offers.some((o) => o.channelName === '국제표준금거래소' && o.sizeG === 3.75)); // 고시가
  });

  it('지점 목록: 업체·출처·가격 연결 정보를 채웁니다', async () => {
    const result = await withFetch({ 'https://www.goodgold.co.kr/81': html('goodgold-branches.html') }, () => fetchDealerStores(def('goodgold')));
    assert.equal(result.branches.length, 56);
    const b = result.branches[0];
    assert.equal(b.chain, 'goodgold');
    assert.equal(b.source, 'goodgold-stores');
    assert.equal(b.quoteId, 'goodgold'); // 본사 고시가를 붙임
    assert.match(b.id, /^goodgold-\d+$/);
  });

  it('지점 목록 페이지가 실패해도 홈페이지에 적힌 본점은 남깁니다', async () => {
    const result = await withFetch({}, () => fetchDealerStores(def('jongrogx')));
    assert.deepEqual(result.branches.map((b) => b.name), ['종로 본점']);
    assert.match(result.warnings.join(' '), /지점 목록/);
  });

  it('아무것도 못 읽으면 예외를 던집니다', async () => {
    await assert.rejects(withFetch({}, () => fetchDealer(def('kaggold'))), /HTTP 404/);
    await assert.rejects(withFetch({}, () => fetchDealerStores(def('kaggold'))), /HTTP 404/);
  });

  it('한국공인금거래소 지점은 여러 페이지를 이어서 읽습니다', async () => {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(html('kaggold-branches-p1.html'));
    };
    try {
      const result = await fetchDealerStores(def('kaggold'));
      assert.ok(calls.some((u) => u.endsWith('&page=5')));
      assert.ok(!calls.some((u) => u.endsWith('&page=6')));
      assert.equal(result.branches.length, 15); // 같은 샘플을 5번 읽어도 중복은 합쳐짐
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('이상한 값 걸러내기', () => {
  const spot = { gold: { perGram: 176_000 }, silver: { perGram: 2_440 } }; // 1돈 약 660,000원
  const shop = (id, buy, sell, extra = {}) => ({ id, name: id, source: id, buyVatIncluded: true, prices: { gold24k: { buy, sell } }, ...extra });

  it('국제 시세와 동떨어진 시세는 매장과 그 구매처를 함께 제외합니다', () => {
    const shops = [shop('ok', 775000, 668000), shop('bad', 77500, 66800), shop('bad2', 775000, 900000)];
    const offers = [
      { id: 'o1', channelId: 'ok', kind: 'fixed', metal: 'gold', sizeG: 3.75, unitPrice: 775000, vatIncluded: true, channelName: 'ok', source: 'ok' },
      { id: 'o2', channelId: 'bad', kind: 'fixed', metal: 'gold', sizeG: 3.75, unitPrice: 77500, vatIncluded: true, channelName: 'bad', source: 'bad' },
    ];
    const r = dropImplausible({ shops, offers }, spot);
    assert.deepEqual(r.shops.map((s) => s.id), ['ok']);
    assert.deepEqual(r.offers.map((o) => o.id), ['o1']);
    assert.equal(r.dropped.length, 2);
    assert.match(r.dropped[0].reason, /너무 달라 제외/);
  });

  it('골드바·실버바 가격도 g당 가격이 비정상이면 제외합니다', () => {
    const offers = [
      { id: 'a', channelId: 'a', kind: 'fixed', metal: 'gold', sizeG: 100, unitPrice: 20_400_000, vatIncluded: true, channelName: 'a', source: 'a' },
      { id: 'b', channelId: 'b', kind: 'fixed', metal: 'gold', sizeG: 100, unitPrice: 2_040_000, vatIncluded: true, channelName: 'b', source: 'b' }, // 0이 하나 빠짐
      { id: 'c', channelId: 'c', kind: 'fixed', metal: 'silver', sizeG: 1000, unitPrice: 3_100_000, vatIncluded: true, channelName: 'c', source: 'c' },
      { id: 'k', channelId: 'k', kind: 'krx', metal: 'gold', sizeG: 100, pricePerGram: 176000, channelName: 'k', source: 'k' },
    ];
    const r = dropImplausible({ shops: [], offers }, spot);
    assert.deepEqual(r.offers.map((o) => o.id), ['a', 'c', 'k']);
  });

  it('금 시세 참고값(buyIsReference)의 살 때 가격은 검사하지 않습니다', () => {
    const r = dropImplausible({ shops: [shop('gbk', 693900, null, { buyIsReference: true, buyVatIncluded: false })], offers: [] }, spot);
    assert.equal(r.shops.length, 1);
  });

  it('국제 시세를 모르면 그대로 둡니다', () => {
    const r = dropImplausible({ shops: [shop('x', 1, 2)], offers: [] }, { gold: null });
    assert.equal(r.shops.length, 1);
  });
});

describe('시세: 안성금거래소·중앙금거래소', () => {
  it('안성금거래소: 개인 가맹점이 18K·14K 살 때 가격까지 공개합니다', () => {
    const q = parseTableQuote(html('anseong-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 778000, sell: 667000 });
    assert.deepEqual(q.prices.gold18k, { buy: 571830, sell: 490300 });
    assert.deepEqual(q.prices.silver, { buy: 10310, sell: 8580 });
  });

  it('"순금 돌반지(세공비 별도)" 줄이 값이 달라도 순금 시세를 덮어쓰지 않습니다', () => {
    const table = `<table><tr><th>품목</th><th>살 때(판매가)</th><th>팔 때(매입가)</th></tr>
      <tr><td>순금 24K</td><td>778,000원</td><td>667,000원</td></tr>
      <tr><td>순금 돌반지 ( 세공비 별도 )</td><td>999,000원</td><td>888,000원</td></tr></table>`;
    assert.deepEqual(parseTableQuote(table).prices.gold24k, { buy: 778000, sell: 667000 });
  });

  it('중앙금거래소: 겹겹인 표에서 "가격 + 변동폭" 칸의 첫 숫자만 읽습니다', () => {
    const q = parsePairQuote(html('jungang-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 775000, sell: 670000 });
    assert.deepEqual(q.prices.gold18k, { buy: null, sell: 492100 });
    assert.deepEqual(q.prices.platinum, { buy: 304000, sell: 247000 });
    assert.deepEqual(q.prices.silver, { buy: 10190, sell: 8480 });
  });

  it('중앙금거래소: 아래 은 표의 "(vat별도)"를 금 시세의 부가세 표기로 착각하지 않습니다', () => {
    const q = parsePairQuote(html('jungang-home.html'));
    assert.equal(q.vatStated, false);
    assert.equal(q.buyVatIncluded, true);
  });

  it('EUC-KR로 된 사이트도 글자가 깨지지 않게 읽습니다', () => {
    const euckr = Uint8Array.from([0xb1, 0xdd]); // "금"
    assert.equal(decodeBody(euckr, 'text/html; charset=euc-kr'), '금');
    const metaOnly = Uint8Array.from([...Buffer.from('<meta charset="euc-kr">'), 0xb1, 0xdd]);
    assert.ok(decodeBody(metaOnly, 'text/html').endsWith('금'));
    assert.equal(decodeBody(Buffer.from('금', 'utf8'), 'text/html'), '금'); // 표기가 없으면 UTF-8
    assert.equal(decodeBody(Buffer.from('금', 'utf8'), 'text/html; charset=nonsense-9'), '금'); // 모르는 이름도 안전
  });
});

describe('오래된 시세 걸러내기', () => {
  const spot = { gold: { perGram: 176_000 } };
  const now = Date.parse('2026-10-20T03:00:00Z'); // 한국 시간 10/20 낮
  const shop = (id, date) => ({ id, name: id, source: id, date, buyVatIncluded: true, prices: { gold24k: { buy: 775000, sell: 668000 } } });

  it('7일보다 오래된 시세는 제외하고 그 곳의 구매처 가격도 함께 뺍니다', () => {
    const offers = [
      { id: 'a', channelId: 'old', source: 'old', kind: 'fixed', metal: 'gold', sizeG: 3.75, unitPrice: 775000, vatIncluded: true, channelName: 'old' },
      { id: 'b', channelId: 'old-shop', source: 'old', kind: 'fixed', metal: 'gold', sizeG: 100, unitPrice: 20_400_000, vatIncluded: true, channelName: 'old' },
      { id: 'c', channelId: 'new', source: 'new', kind: 'fixed', metal: 'gold', sizeG: 3.75, unitPrice: 775000, vatIncluded: true, channelName: 'new' },
    ];
    const r = dropImplausible({ shops: [shop('old', '2026-09-04'), shop('new', '2026-10-19')], offers }, spot, { now });
    assert.deepEqual(r.shops.map((s) => s.id), ['new']);
    assert.deepEqual(r.offers.map((o) => o.id), ['c']);
    assert.match(r.dropped[0].reason, /2026-09-04로 46일 전이라 제외/);
  });

  it('주말·연휴 정도(며칠 전)는 그대로 둡니다', () => {
    const r = dropImplausible({ shops: [shop('a', '2026-10-16')], offers: [] }, spot, { now });
    assert.equal(r.shops.length, 1);
  });
});
