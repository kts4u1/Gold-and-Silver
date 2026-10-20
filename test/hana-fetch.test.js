import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchHana } from '../src/sources/hana.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it('주말처럼 오늘 고시가 없으면 가장 최근 영업일 가격을 씁니다', async () => {
  const requested = [];
  globalThis.fetch = async (url, init) => {
    const form = new URLSearchParams(init.body);
    const tab = /_(\d\d)\.do$/.exec(url)[1];
    requested.push([tab, form.get('trscStrDt')]);
    // 2026-10-18(일)은 고시 없음, 10-16(금)은 있음 → 토요일(10-17)도 없음
    const date = form.get('trscStrDt');
    const file = date === '20261016' ? `hana-${tab}.html` : 'hana-nodata.json';
    return new Response(fs.readFileSync(path.join(dir, file), 'utf8'));
  };

  const sunday = new Date('2026-10-18T03:00:00Z'); // 한국 시간 일요일 낮 12시
  const result = await fetchHana(sunday);

  assert.deepEqual(
    requested.filter(([tab]) => tab === '04').map(([, d]) => d),
    ['20261018', '20261017', '20261016'],
  );
  assert.equal(result.warnings.length, 0);
  const kgx10 = result.offers.find((o) => o.id === 'hana-kgx-10');
  assert.equal(kgx10.unitPrice, 1870230);
  assert.equal(kgx10.quotedAt, '2026-10-16T10:58:00+09:00');
  assert.ok(result.offers.some((o) => o.metal === 'silver'));
  assert.equal(result.market.hana.gold.perGram, 176437.68);
});

it('모든 탭이 실패하면 예외를 던집니다', async () => {
  globalThis.fetch = async () => new Response('err', { status: 500 });
  await assert.rejects(fetchHana(new Date('2026-10-20T03:00:00Z')), /HTTP 500/);
});
