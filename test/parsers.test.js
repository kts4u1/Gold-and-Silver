import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hanaOffers, HANA_PRODUCTS, parseHanaTable, parseSizeLabel } from '../src/sources/hana.js';
import { parseKgxMain } from '../src/sources/kgx.js';
import { komscoOffers, parseKomscoGoldPrice, parseKomscoProducts, parseProductWeight } from '../src/sources/komsco.js';
import { krxOffers, parseHistory, parseIndex } from '../src/sources/naver.js';
import { toNumber } from '../src/http.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const text = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const json = (name) => JSON.parse(text(name));

describe('공통', () => {
  it('toNumber는 쉼표와 단위를 무시합니다', () => {
    assert.equal(toNumber('1,234.56'), 1234.56);
    assert.equal(toNumber(' 206,192.35(부가세포함)'.replace(/\(.*\)/, '')), 206192.35);
    assert.equal(toNumber('-2,630'), -2630);
    assert.equal(toNumber(''), null);
    assert.equal(toNumber(undefined), null);
  });
});

describe('하나은행', () => {
  it('중량 표기를 g으로 바꿉니다', () => {
    assert.equal(parseSizeLabel('3.75g'), 3.75);
    assert.equal(parseSizeLabel('37.5g'), 37.5);
    assert.equal(parseSizeLabel('1kg'), 1000);
    assert.equal(parseSizeLabel('1Kg'), 1000);
    assert.equal(parseSizeLabel('Large bar'), null);
  });

  it('한국금거래소 골드바 표의 최신 회차를 읽습니다', () => {
    const t = parseHanaTable(text('hana-04.html'));
    assert.equal(t.round, 85);
    assert.equal(t.time, '10:58:00');
    assert.equal(t.basePrice, 176437.68);
    assert.equal(t.usdKrw, 1328.9);
    assert.deepEqual(
      t.buy.map((b) => [b.sizeG, b.price]),
      [
        [10, 1870230],
        [37.5, 7013390],
        [100, 18508310],
        [500, 92453340],
        [1000, 184906680],
      ],
    );
    assert.equal(t.sell.find((s) => s.sizeG === 10).price, 1676150);
    // 살 때 가격 = 기준가격 × 중량 × 가산율(10g 106%), 십원 미만 절사
    assert.equal(Math.floor((t.basePrice * 10 * 1.06) / 10) * 10, 1870230);
  });

  it('LS MnM 표의 Large bar(중량 미정)는 건너뜁니다', () => {
    const t = parseHanaTable(text('hana-01.html'));
    assert.deepEqual(
      t.buy.map((b) => b.sizeG),
      [10, 100, 1000],
    );
  });

  it('살 때·팔 때가 한 칸씩인 선물하기 표와 실버바 표를 읽습니다', () => {
    const gift = parseHanaTable(text('hana-06.html'));
    assert.deepEqual(gift.buy, [{ label: '3.75g', sizeG: 3.75, price: 774120 }]);
    assert.deepEqual(gift.sell, [{ label: '3.75g', sizeG: 3.75, price: 608700 }]);

    const silver = parseHanaTable(text('hana-02.html'));
    assert.equal(silver.basePrice, 2434.84);
    assert.deepEqual(
      silver.buy.map((b) => [b.sizeG, b.price]),
      [
        [500, 1424380],
        [1000, 2848760],
      ],
    );
  });

  it('오류 응답은 메시지와 함께 예외를 던집니다', () => {
    const err = '[{"errorCode":"WEBK00038","errorMessage":"시스템 장애중 입니다. \\\\n잠시후 다시 이용해 주시기 바랍니다."}]';
    assert.throws(() => parseHanaTable(err), /시스템 장애중/);
  });

  it('고시가 없는 날(주말·공휴일)은 null을 돌려줍니다', () => {
    assert.equal(parseHanaTable(text('hana-nodata.json')), null);
  });

  it('상품(offer)으로 바꾸면 부가세 별도 가격과 되팔 때 가격이 들어갑니다', () => {
    const product = HANA_PRODUCTS.find((p) => p.tab === '05');
    const offers = hanaOffers(product, parseHanaTable(text('hana-05.html')), '2026-10-20');
    const don = offers.find((o) => o.sizeG === 3.75);
    assert.equal(don.channelId, 'hana-samsung');
    assert.equal(don.unitPrice, 706630);
    assert.equal(don.vatIncluded, false);
    assert.equal(don.sellPrice, 628550);
    assert.equal(don.quotedAt, '2026-10-20T10:58:01+09:00');
  });
});

describe('한국조폐공사', () => {
  it('상품명에서 중량을 읽습니다', () => {
    assert.equal(parseProductWeight('오롯 골드바 1,000g'), 1000);
    assert.equal(parseProductWeight('오롯 골드바 37.5g'), 37.5);
    assert.equal(parseProductWeight('실버바 1kg'), 1000);
    assert.equal(parseProductWeight('기념메달'), null);
  });

  it('상품 목록에서 이름·가격을 읽습니다', () => {
    const gold = parseKomscoProducts(text('komsco-gold.html'));
    assert.equal(gold.length, 5);
    assert.deepEqual(gold.find((p) => p.sizeG === 100), { name: '오롯 골드바 100g', sizeG: 100, price: 20424710, soldOut: false });
  });

  it('같은 중량·같은 가격이면 기본 상품 하나만 남깁니다', () => {
    const offers = komscoOffers(parseKomscoProducts(text('komsco-silver.html')), 'silver', null);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].productName, '실버바 1,000g');
    assert.equal(offers[0].unitPrice, 3267350);
    assert.equal(offers[0].vatIncluded, true);
  });

  it('품절 상품은 제외합니다', () => {
    const offers = komscoOffers(
      [
        { name: 'A 10g', sizeG: 10, price: 100, soldOut: true },
        { name: 'B 10g', sizeG: 10, price: 200, soldOut: false },
      ],
      'gold',
      null,
    );
    assert.deepEqual(
      offers.map((o) => o.unitPrice),
      [200],
    );
  });

  it('금시세정보 표를 읽습니다', () => {
    assert.deepEqual(parseKomscoGoldPrice(text('komsco-goldprice.html')), {
      intlUsdPerOz: 4132.62,
      usdKrw: 1331.07,
      perGramUnder100: 206192.35,
      perGram100Plus: 204247.14,
      at: '2026-10-20T10:59:00+09:00',
    });
  });
});

describe('한국금거래소', () => {
  it('도매·매입·국제 시세를 읽습니다', () => {
    const k = parseKgxMain(json('kgx-main.json'));
    assert.equal(k.at, '2026-10-20T10:58:35+09:00');
    assert.equal(k.wholesale.gold.perDon, 711700);
    assert.equal(k.wholesale.silver.perGram, 3405);
    assert.equal(k.spot.gold.perGram, 176705.98);
    assert.equal(k.usdKrw, 1330.3);
    assert.deepEqual(
      k.purchase.map((p) => [p.name, p.perDon]),
      [
        ['순금 (24K)', 659000],
        ['18K', 484300],
        ['14K', 375600],
        ['백금', 247000],
        ['은', 8480],
      ],
    );
  });

  it('형식이 다르면 예외를 던집니다', () => {
    assert.throws(() => parseKgxMain({}), /형식/);
  });
});

describe('네이버 증권', () => {
  it('KRX 금·국제 은·환율 시세를 읽습니다', () => {
    const krx = parseIndex(json('naver-krx-gold.json'));
    assert.equal(krx.value, 176330);
    assert.equal(krx.unit, '원/g');
    assert.equal(krx.changePct, -1.47);
    assert.equal(parseIndex(json('naver-silver.json')).value, 56.91);
    assert.equal(parseIndex(json('naver-usdkrw.json')).value, 1328.9);
  });

  it('일별 추이를 오래된 날짜부터 정렬합니다', () => {
    const h = parseHistory(json('naver-history.json'));
    assert.equal(h.length, 10);
    assert.deepEqual(h[0], { date: '2026-10-06', value: 179000 });
    assert.deepEqual(h.at(-1), { date: '2026-10-20', value: 176330 });
  });

  it('KRX 시세로 100g·1kg 인출 상품을 만듭니다', () => {
    const offers = krxOffers({ value: 176330, at: 'x' });
    assert.deepEqual(
      offers.map((o) => [o.sizeG, o.kind, o.pricePerGram]),
      [
        [100, 'krx', 176330],
        [1000, 'krx', 176330],
      ],
    );
    assert.deepEqual(krxOffers(null), []);
  });
});
