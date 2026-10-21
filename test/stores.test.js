// 새로 더한 사업자 시세와 매장 목록 (저장해 둔 실제 페이지 샘플 사용)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCollector, seedFromPrevious } from '../src/collect.js';
import {
  DEALERS,
  fetchDealer,
  fetchDealerStores,
  finishBranches,
  parseJungangBranches,
  parseKggoldBranches,
  parseKggoldQuote,
  parseKoreagoldBranches,
  parseKoreagoldQuote,
  parseSamsungBranchDetail,
  parseSamsungBranchList,
  parseGwangjuQuote,
  parseSamsungQuote,
  quoteToShop,
} from '../src/sources/dealers.js';
import { flatTokens } from '../src/sources/util.js';
import { fetchKgsBusanStores, parseKgsBusanBranches } from '../src/sources/kgs.js';
import { parseKgxStores, parseKsgoldStores } from '../src/sources/ksgold.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dealers');
const html = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const def = (id) => DEALERS.find((d) => d.id === id);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
/** 주소별로 정해 둔 응답만 돌려주는 가짜 fetch (호출한 주소는 calls에 기록) */
function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = routes(String(url));
    return body == null ? new Response('x', { status: 404 }) : new Response(body);
  };
  return calls;
}

describe('새 사업자 오늘 시세', () => {
  it('한국금시장거래소: 다섯 칸에서 살 때·팔 때를 읽고 변동폭은 뺍니다', () => {
    const q = parseKoreagoldQuote(html('koreagold-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 777_000, sell: 667_500 });
    assert.deepEqual(q.prices.gold18k, { buy: null, sell: 490_700 }); // "제품시세적용"
    assert.deepEqual(q.prices.silver, { buy: 10_310, sell: 8_580 });
    assert.equal(q.buyVatIncluded, true);
    assert.equal(q.vatStated, true);
    const shop = quoteToShop(def('koreagold'), q, []);
    assert.match(shop.notes.join(), /날짜가 표시되지 않아/);
  });

  it('삼성금거래소 위젯: 열이 금속, 줄이 살 때·팔 때인 표', () => {
    const q = parseSamsungQuote(html('samsunggold-sise.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 775_000, sell: 665_000 });
    assert.deepEqual(q.prices.platinum, { buy: 304_000, sell: 248_000 });
    assert.equal(q.prices.gold14k.buy, null);
    assert.equal(q.date, '2026-10-20');
    assert.equal(q.buyVatIncluded, true);
  });

  it('국제금거래소: 살 때가 VAT별도이고, 은수저 줄이 은 시세를 덮지 않습니다', () => {
    const q = parseKggoldQuote(html('kggold-home.html'));
    assert.deepEqual(q.prices.gold24k, { buy: 710_000, sell: 675_000 });
    assert.deepEqual(q.prices.silver, { buy: 10_000, sell: 8_150 });
    assert.equal(q.buyVatIncluded, false);
    assert.equal(q.date, '2026-10-20');
  });
});

describe('새 매장 목록', () => {
  it('한국금거래소 가맹점 127곳: 빈 지역 칸은 위 줄을 따르고 전화는 첫 번호', () => {
    const list = parseKgxStores(html('kgx-stores.html'));
    assert.equal(list.length, 127);
    assert.deepEqual(list[1], {
      name: '한국금거래소 강남본점',
      address: '서울 강남구 논현로 878 중산빌딩1층',
      phone: '02-6203-9990',
      hours: null,
      opening: false,
      region: '서울',
    });
    assert.ok(list.every((b) => b.region));
  });

  it('대한표준금거래소 20곳: 스크립트 속 좌표까지 읽습니다', () => {
    const list = parseKsgoldStores(html('ksgold-stores.html'));
    assert.equal(list.length, 20);
    assert.deepEqual(list[0], {
      name: '대한표준금거래소 부산 용호 본점',
      address: '부산 남구 분포로 113 1층',
      phone: '070-7575-4415',
      hours: null,
      opening: false,
      region: '부산',
      lat: 35.128054,
      lng: 129.107943,
    });
  });

  it('한국금시장거래소 43곳 (압구정점은 따로 모으므로 뺌)', () => {
    const raw = parseKoreagoldBranches(html('koreagold-branches.html'));
    assert.equal(raw.length, 43);
    assert.equal(raw.find((b) => b.name === '광주점').region, '경기'); // 경기 광주시
    const list = finishBranches(def('koreagold'), raw);
    assert.ok(!list.some((b) => /압구정/.test(b.name)));
    assert.equal(list.length, 42);
  });

  it('삼성금거래소: 목록 쪽(제목·글 번호)과 대리점 글(주소·전화)', () => {
    const page = parseSamsungBranchList(html('samsunggold-branches-p1.html'));
    assert.equal(page.length, 15);
    assert.deepEqual(page[0], { wrId: 53, title: '47호점 (제주) 삼성금거래소 서귀포점', area: '제주', name: '서귀포점' });
    assert.deepEqual(parseSamsungBranchDetail(html('samsunggold-branch-wr20.html')), {
      area: '전라',
      name: '광주점',
      address: '광주광역시 동구 서석로 17 1층',
      phone: '062-226-6300',
    });
  });

  it('삼성금거래소: 목록을 다 읽고 대리점 글마다 주소를 가져옵니다', async () => {
    const pages = [1, 2, 3].map((p) => html(`samsunggold-branches-p${p}.html`));
    const calls = fakeFetch((url) => {
      const page = /&page=(\d+)$/.exec(url)?.[1];
      if (page) return pages[page - 1] ?? pages[2]; // 마지막 쪽 뒤로는 같은 쪽이 반복됨
      if (/wr_id=20$/.test(url)) return html('samsunggold-branch-wr20.html');
      return null; // 나머지 글은 실패 → 목록의 지역만 씀
    });
    const result = await fetchDealerStores(def('samsunggold'));
    assert.equal(result.branches.length, 44);
    assert.ok(!calls.some((u) => u.endsWith('&page=5'))); // 새 글이 없으면 멈춤
    const gwangju = result.branches.find((b) => b.name === '광주점');
    assert.equal(gwangju.address, '광주광역시 동구 서석로 17 1층');
    assert.equal(gwangju.quoteId, 'samsunggold');
    assert.equal(result.branches.find((b) => b.name === '서귀포점').region, '제주');
    assert.match(result.warnings.join(), /43곳은 상세 주소를 받지 못해/);
  });

  it('중앙금거래소: 주소가 다른 지점과 같고 이름의 지역과 어긋나면(천안점=평택 주소) 뺍니다', () => {
    const raw = parseJungangBranches(html('jungang-branches.html'));
    assert.ok(raw.some((b) => b.name === '천안점'));
    const list = finishBranches(def('jungang'), raw);
    assert.ok(!list.some((b) => b.name === '천안점'));
    assert.ok(list.some((b) => b.name === '평택안성점'));
    assert.equal(list.filter((b) => b.name === '종로본점').length, 2); // 이름은 같아도 주소가 다른 두 곳은 둘 다 남김
  });

  it('국제금거래소 3곳, 한국표준금거래소 부산 5곳 (주소·전화·영업시간)', () => {
    assert.deepEqual(parseKggoldBranches(html('kggold-branches.html')).map((b) => b.region), ['부산', '울산', '경북']);
    const busan = parseKgsBusanBranches(html('kgs-busan-branches.html'));
    assert.deepEqual(busan.map((b) => b.name), ['동래점', '남포점', '하단점', '해운대점', '수영점']);
    assert.equal(busan[0].phone, '051-553-8080');
    assert.match(busan[0].hours, /오전 10시반/);
  });

  it('부산 매장 안내를 못 읽으면 구 단위 기본 목록을 씁니다', async () => {
    fakeFetch(() => null);
    const result = await fetchKgsBusanStores();
    assert.equal(result.branches.length, 5);
    assert.equal(result.branches[0].quoteId, 'kgs-busan');
    assert.match(result.warnings.join(), /구 단위/);
  });
});

describe('지점 목록은 드물게 받습니다', () => {
  const NOW = Date.parse('2026-10-20T06:00:00Z');
  const src = { id: 'x-stores', ttlMs: 24 * 3600_000, minIntervalMs: 12 * 3600_000 };
  const previous = {
    sources: [{ id: 'x-stores', ok: true, fetchedAt: new Date(NOW - 3 * 3600_000).toISOString(), warnings: [] }],
    branches: [{ id: 'x-1', source: 'x-stores', name: 'A' }],
    shops: [],
    offers: [],
  };

  it('직전 배포 값이 아직 유효하면 다시 받지 않습니다 (새로고침이어도)', async () => {
    let calls = 0;
    const collect = createCollector([{ ...src, fetch: async () => (calls++, { market: {}, offers: [], branches: [] }) }], () => NOW, { previous });
    const data = await collect({ force: true });
    assert.equal(calls, 0);
    assert.deepEqual(data.branches.map((b) => b.name), ['A']);
  });

  it('하루가 지났거나 자주 갱신하는 출처면 직전 값을 쓰지 않습니다', () => {
    assert.equal(seedFromPrevious(src, previous, NOW + 22 * 3600_000), null);
    assert.equal(seedFromPrevious({ ...src, ttlMs: 15 * 60_000 }, previous, NOW), null);
    assert.ok(seedFromPrevious(src, previous, NOW));
  });
});

describe('지방 개인 금은방 시세 (사이트마다 다른 화면)', () => {
  const shopsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shops');
  const page = (f) => fs.readFileSync(path.join(shopsDir, `${f}.html`), 'utf8');
  const collect = async (id, file) => {
    fakeFetch(() => page(file));
    return fetchDealer(def(id));
  };
  const cases = [
    // [사업자, 샘플, 살 때, 팔 때, 살 때 부가세 포함?, 날짜]
    ['busangoldx', 'busan-beomil-goldx', 700_000, 675_000, false, '2026-10-20'], // 팔때 칸이 먼저, 날짜는 표 밖
    ['daesunggold', 'daesung-daegu', 760_000, 675_000, true, '2026-10-20'],
    ['kgoldsongdo', 'kgold-songdo', 720_000, 672_000, false, '2026-10-20'],
    ['sstgold', 'sstgold-suwon', 772_000, 668_000, true, '2026-10-20'], // 값 줄에만 있는 변동폭 칸을 빼고 셈
    ['bucheongold', 'bucheongold', 769_500, 668_500, true, '2026-10-20'], // "₩769,500"
    ['goldworld', 'goldworld-jinju', 700_000, 670_000, false, '2026-10-20'],
    ['usgold', 'usgold-ulsan', 710_000, 667_000, false, '2026-10-20'], // 열이 금속인 표, 부가세는 설정값
    ['gwangjugold', 'gwangju-gamjeong', 695_000, 677_000, false, null], // 날짜는 아래에서 따로 확인
    ['jejugold', 'jejugold', 700_000, 675_000, false, null], // 날짜 없음
  ];
  for (const [id, file, buy, sell, vat, date] of cases) {
    it(`${def(id).name}: 살 때 ${buy.toLocaleString('ko-KR')} / 팔 때 ${sell.toLocaleString('ko-KR')}`, async () => {
      const { shops, offers } = await collect(id, file);
      assert.deepEqual(shops[0].prices.gold24k, { buy, sell });
      assert.equal(shops[0].buyVatIncluded, vat);
      if (date) assert.equal(shops[0].date, date);
      assert.equal(offers.length, 1); // 순금 1돈 살 때 → 3.75g 구매처
    });
  }

  it('광주감정금거래소: 연도 없는 "[10/20]"은 올해, 오늘보다 뒤면 작년으로 봅니다', () => {
    const tokens = flatTokens(page('gwangju-gamjeong'));
    assert.equal(parseGwangjuQuote(tokens, { now: Date.parse('2026-10-21T00:00:00Z') }).date, '2026-10-20');
    assert.equal(parseGwangjuQuote(tokens, { now: Date.parse('2027-01-05T00:00:00Z') }).date, '2026-10-20');
    const q = parseGwangjuQuote(tokens, { now: Date.parse('2026-10-21T00:00:00Z') });
    assert.deepEqual(q.prices.gold18k, { buy: 570_000, sell: 509_000 });
  });

  it('팔 때 시세만 올린 날(창원 비비주얼리·구미 더드림)은 팔 때만 보여 주고 구매 순위에는 넣지 않습니다', async () => {
    for (const [id, file, sell] of [['bbgold', 'bbgold-changwon', 668_000], ['thedreamgold', 'thedream-gumi', 675_000]]) {
      const { shops, offers } = await collect(id, file);
      assert.deepEqual(shops[0].prices.gold24k, { buy: null, sell });
      assert.equal(shops[0].date, '2026-10-20');
      assert.equal(offers.length, 0);
      assert.match(shops[0].notes.join(), /팔 때\(매입\) 시세만/);
    }
  });

  it('국제금거래소 울산점 매장에는 울산점 자체 시세를 붙입니다', () => {
    const list = finishBranches(def('kggold'), parseKggoldBranches(html('kggold-branches.html')));
    assert.deepEqual(list.map((b) => b.quoteId), ['kggold', 'usgold', 'kggold']);
  });
});
