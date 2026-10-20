import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  availableSizes,
  DEFAULT_SETTINGS,
  explainRecommendation,
  formatWeight,
  quoteOffer,
  rankByPerGram,
  rankOffers,
  spotKrwPerGram,
} from '../shared/compare.js';
import { computeSpot, createCollector } from '../src/collect.js';

const bank = (over = {}) => ({
  id: 'bank-100',
  channelId: 'bank',
  channelName: '은행',
  metal: 'gold',
  sizeG: 100,
  kind: 'fixed',
  unitPrice: 18_500_000,
  vatIncluded: false,
  sellPrice: 16_700_000,
  ...over,
});
const krx = (over = {}) => ({
  id: 'krx-100',
  channelId: 'krx',
  channelName: 'KRX',
  metal: 'gold',
  sizeG: 100,
  kind: 'krx',
  pricePerGram: 176_000,
  ...over,
});

describe('기본 계산', () => {
  it('국제 시세를 원/g으로 환산합니다', () => {
    // 4,126.28 $/oz, 1,328.40원 → 하나은행 기준가격 176,229.50원/g
    assert.equal(Math.floor(spotKrwPerGram(4126.28, 1328.4) * 100) / 100, 176229.5);
    assert.equal(spotKrwPerGram(null, 1300), null);
  });

  it('중량을 읽기 쉽게 표시합니다', () => {
    assert.equal(formatWeight(3.75), '3.75g (1돈)');
    assert.equal(formatWeight(37.5), '37.5g (10돈)');
    assert.equal(formatWeight(10), '10g');
    assert.equal(formatWeight(100), '100g');
    assert.equal(formatWeight(1000), '1kg');
  });
});

describe('quoteOffer', () => {
  it('부가세 별도 가격에는 10%를 더합니다', () => {
    const q = quoteOffer(bank(), { qty: 2 });
    assert.equal(q.total, 18_500_000 * 2 * 1.1);
    assert.equal(q.grams, 200);
    assert.equal(q.perGram, (18_500_000 * 1.1) / 100);
    assert.equal(q.resale, 16_700_000 * 2);
  });

  it('부가세 포함 가격은 그대로 쓰고 배송비를 더합니다', () => {
    const q = quoteOffer(bank({ vatIncluded: true, unitPrice: 2_000_000, sizeG: 10, shippingFee: 3000 }));
    assert.equal(q.total, 2_003_000);
  });

  it('KRX 경로는 매수대금 + 수수료 + 인출 부가세 + 인출수수료입니다', () => {
    const q = quoteOffer(krx(), { qty: 2 });
    const principal = 176_000 * 200;
    const expected =
      principal +
      Math.round(principal * DEFAULT_SETTINGS.krxTradeFeeRate) +
      Math.round(principal * 0.1) +
      DEFAULT_SETTINGS.krxBrokerWithdrawFee +
      DEFAULT_SETTINGS.krxKsdWithdrawFeePerBar * 2;
    assert.equal(q.total, expected);
    assert.equal(q.lines.length, 5);
    assert.equal(q.resale, null);
  });

  it('수수료 설정을 바꿀 수 있습니다', () => {
    const cheap = quoteOffer(krx(), { settings: { krxTradeFeeRate: 0, krxBrokerWithdrawFee: 0, krxKsdWithdrawFeePerBar: 0 } });
    assert.equal(cheap.total, 176_000 * 100 * 1.1);
  });

  it('국제 시세 대비 프리미엄을 계산합니다', () => {
    const q = quoteOffer(bank({ unitPrice: 100 * 1000, sizeG: 100 }), { spotPerGram: 1000 });
    assert.ok(Math.abs(q.premiumPct - 0.1) < 1e-9); // 부가세 10%만큼
  });
});

describe('rankOffers', () => {
  const offers = [
    bank(),
    krx(),
    bank({ id: 'b2', channelId: 'b2', channelName: '조폐공사', vatIncluded: true, unitPrice: 20_424_710 }),
    bank({ id: 'small', sizeG: 10, unitPrice: 1_870_000 }),
    bank({ id: 'silver', metal: 'silver', sizeG: 1000, unitPrice: 2_848_760 }),
  ];

  it('같은 금속·중량만 비교해서 싼 순서로 정렬합니다', () => {
    const r = rankOffers(offers, { metal: 'gold', sizeG: 100, qty: 1 });
    assert.deepEqual(
      r.map((q) => q.offer.channelId),
      ['krx', 'bank', 'b2'],
    );
    assert.equal(r[0].diffFromBest, 0);
    assert.equal(r[1].diffFromBest, r[1].total - r[0].total);
  });

  it('추천 이유를 설명합니다', () => {
    const r = rankOffers(offers, { metal: 'gold', sizeG: 100 });
    const msg = explainRecommendation(r);
    assert.match(msg, /KRX/);
    assert.match(msg, /2위\(은행\)보다 [\d,]+원/);
    assert.equal(explainRecommendation([]), '');
  });

  it('직접 입력한 견적도 함께 비교합니다', () => {
    const manual = bank({ id: 'm', channelName: '종로 금은방', source: 'manual', vatIncluded: true, unitPrice: 19_000_000 });
    const r = rankOffers([...offers, manual], { metal: 'gold', sizeG: 100 });
    assert.equal(r[0].offer.id, 'm');
    assert.match(explainRecommendation(r), /직접 입력한 견적 "종로 금은방"/);
  });

  it('중량 목록과 g당 단가 순위를 만듭니다', () => {
    assert.deepEqual(availableSizes(offers, 'gold'), [10, 100]);
    assert.deepEqual(availableSizes(offers, 'silver'), [1000]);
    const perGram = rankByPerGram(offers, { metal: 'gold' });
    assert.equal(perGram[0].offer.id, 'krx-100');
    assert.equal(perGram.length, 4);
  });
});

describe('collect', () => {
  it('출처별 결과를 합치고, 실패한 출처는 마지막 성공 데이터를 지연됨으로 표시합니다', async () => {
    let t = 0;
    let fail = false;
    const sources = [
      { id: 'a', name: 'A', url: 'x', ttlMs: 1000, fetch: async () => ({ market: { a: 1 }, offers: [bank()] }) },
      {
        id: 'b',
        name: 'B',
        url: 'y',
        ttlMs: 1000,
        fetch: async () => {
          if (fail) throw new Error('다운');
          return { market: { b: 2 }, offers: [krx()] };
        },
      },
    ];
    const collect = createCollector(sources, () => t);

    const first = await collect();
    assert.equal(first.offers.length, 2);
    assert.deepEqual(
      first.sources.map((s) => s.ok),
      [true, true],
    );

    fail = true;
    t = 5000; // TTL 지남
    const second = await collect();
    const b = second.sources.find((s) => s.id === 'b');
    assert.equal(b.ok, false);
    assert.equal(b.stale, true);
    assert.equal(b.error, '다운');
    assert.equal(second.offers.length, 2); // 이전 데이터 유지
    assert.equal(second.market.b, 2);
  });

  it('TTL 안에서는 다시 가져오지 않습니다', async () => {
    let calls = 0;
    const collect = createCollector(
      [{ id: 'a', name: 'A', url: 'x', ttlMs: 60_000, fetch: async () => (calls++, { market: {}, offers: [] }) }],
      () => 0,
    );
    await collect();
    await collect();
    assert.equal(calls, 1);
    await collect({ force: true });
    assert.equal(calls, 2);
  });

  it('기준 시세는 실시간 현물 → 은행 기준가 → 국제 선물 순으로 고릅니다', () => {
    assert.equal(computeSpot({ kgx: { spot: { gold: { perGram: 1 } } }, hana: { gold: { perGram: 2 } } }).gold.perGram, 1);
    assert.equal(computeSpot({ hana: { gold: { perGram: 2 } } }).gold.perGram, 2);
    const s = computeSpot({ intlGold: { value: 4126.28 }, usdKrw: { value: 1328.4 } });
    assert.equal(Math.round(s.gold.perGram), 176230);
    assert.equal(s.silver, null);
  });
});
