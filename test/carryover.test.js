import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carryOver } from '../src/carryover.js';

const NOW = Date.parse('2026-10-20T06:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

const previous = {
  generatedAt: hoursAgo(1),
  market: { usdKrw: { value: 1400 }, krxGold: { value: 200_000 } },
  shops: [
    { id: 'gk', source: 'goldkorea' },
    { id: 'gg', source: 'goodgold' },
  ],
  offers: [
    { id: 'gk-gold-3.75', source: 'goldkorea' },
    { id: 'gg-gold-3.75', source: 'goodgold' },
  ],
  branches: [
    { id: 'goldkorea-1', source: 'goldkorea', name: '서면점', address: '부산 부산진구' },
    { id: 'goldkorea-2', source: 'goldkorea', name: '창원점', address: '창원시' },
    { id: 'jongrogx-1', source: 'jongrogx', chain: 'jongrogx', name: '수원지사', address: null },
    { id: 'old-1', chain: 'jongrogx', name: '닫은 지점', address: null }, // 출처 표시가 없던 옛 데이터는 이어 쓰지 않음
  ],
  sources: [
    { id: 'goldkorea', ok: true, fetchedAt: hoursAgo(1), warnings: [] },
    { id: 'goodgold', ok: true, fetchedAt: hoursAgo(1), warnings: [] },
    { id: 'jongrogx', ok: true, fetchedAt: hoursAgo(1), warnings: [] },
  ],
};

const current = (over = {}) => ({
  generatedAt: new Date(NOW).toISOString(),
  market: { usdKrw: { value: 1410 } },
  shops: [{ id: 'gg', source: 'goodgold', fresh: true }],
  offers: [{ id: 'gg-gold-3.75', source: 'goodgold', fresh: true }],
  branches: [{ id: 'jongrogx-1', source: 'jongrogx', name: '종로 본점', address: '서울 종로구' }],
  sources: [
    { id: 'goldkorea', ok: false, stale: false, error: '연결 실패 (goldkorea.kr)', warnings: [], fetchedAt: null },
    { id: 'goodgold', ok: true, stale: false, error: null, warnings: [], fetchedAt: new Date(NOW).toISOString() },
    { id: 'jongrogx', ok: true, stale: false, error: null, warnings: ['지점: HTTP 500 (www.jongrogx.com)'], fetchedAt: new Date(NOW).toISOString() },
  ],
  ...over,
});

describe('직전 배포 데이터 이어 쓰기', () => {
  it('이번에 실패한 출처의 시세·상품·매장을 지연 표시와 함께 이어 씁니다', () => {
    const out = carryOver(current(), previous, { now: NOW });
    assert.ok(out.shops.some((s) => s.id === 'gk'));
    assert.ok(out.offers.some((o) => o.id === 'gk-gold-3.75'));
    assert.equal(out.branches.filter((b) => b.source === 'goldkorea').length, 2);
    const st = out.sources.find((s) => s.id === 'goldkorea');
    assert.equal(st.stale, true);
    assert.equal(st.fetchedAt, previous.sources[0].fetchedAt);
    assert.match(st.warnings.join(), /직전/);
  });

  it('이번에 받은 출처는 새 값만 쓰고 직전 값을 섞지 않습니다', () => {
    const out = carryOver(current(), previous, { now: NOW });
    assert.deepEqual(out.shops.filter((s) => s.source === 'goodgold'), [{ id: 'gg', source: 'goodgold', fresh: true }]);
    assert.equal(out.offers.filter((o) => o.source === 'goodgold').length, 1);
  });

  it('지점 목록만 실패했으면 빠진 지점을 직전 목록에서 채웁니다 (아이디 겹침 피함)', () => {
    const out = carryOver(current(), previous, { now: NOW });
    const jongro = out.branches.filter((b) => (b.source ?? b.chain) === 'jongrogx');
    assert.deepEqual(jongro.map((b) => b.name).sort(), ['수원지사', '종로 본점']);
    assert.ok(!out.branches.some((b) => b.name === '닫은 지점'));
    assert.equal(new Set(out.branches.map((b) => b.id)).size, out.branches.length);
  });

  it('출처 id가 바뀌어도(시세 출처 → 매장 목록 출처) 이미 있는 매장을 다시 더하지 않습니다', () => {
    const prev = {
      ...previous,
      // 예전 배포: 지점이 시세 출처(goodgold) 아래에 있었음
      branches: [{ id: 'goodgold-1', source: 'goodgold', chain: 'goodgold', chainName: '국제표준금거래소', name: '남천점', address: '부산 수영구' }],
    };
    const cur = current({
      branches: [{ id: 'goodgold-1', source: 'goodgold-stores', chain: 'goodgold', chainName: '국제표준금거래소', name: '남천점', address: '부산 수영구' }],
      sources: [...current().sources, { id: 'goodgold-stores', ok: true, stale: false, warnings: [], fetchedAt: new Date(NOW).toISOString() }],
    });
    const out = carryOver(cur, prev, { now: NOW });
    assert.equal(out.branches.filter((b) => b.name === '남천점').length, 1);
    assert.ok(!out.sources.find((s) => s.id === 'goodgold').warnings.some((w) => /지점 목록/.test(w)));
  });

  it('48시간보다 오래된 값은 이어 쓰지 않습니다', () => {
    const old = {
      ...previous,
      generatedAt: hoursAgo(60),
      sources: previous.sources.map((s) => ({ ...s, fetchedAt: hoursAgo(60) })),
    };
    const out = carryOver(current(), old, { now: NOW });
    assert.ok(!out.shops.some((s) => s.id === 'gk'));
    assert.equal(out.sources.find((s) => s.id === 'goldkorea').stale, false);
    assert.equal(out.market.krxGold, undefined);
    // 지점 목록은 14일까지는 이어 씀
    assert.equal(out.branches.filter((b) => b.source === 'goldkorea').length, 2);
  });

  it('빠진 시장 시세만 직전 값으로 채우고, 새로 받은 값은 그대로 둡니다', () => {
    const out = carryOver(current(), previous, { now: NOW });
    assert.equal(out.market.usdKrw.value, 1410);
    assert.equal(out.market.krxGold.value, 200_000);
  });

  it('직전 데이터가 없으면 그대로 돌려줍니다', () => {
    const cur = current();
    assert.equal(carryOver(cur, null, { now: NOW }), cur);
  });
});
