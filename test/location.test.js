import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISTRICTS } from '../shared/districts.js';
import {
  centerOf,
  distanceKm,
  districtsOf,
  guessDistrict,
  guessRegion,
  locateBranch,
  nearbyBest,
  nearestDistrict,
  parseAddress,
  rankNearby,
  REGIONS,
  toRegion,
} from '../shared/location.js';

describe('시·군·구 중심 좌표표', () => {
  it('17개 시·도가 모두 있고 좌표가 우리나라 안에 있습니다', () => {
    for (const r of REGIONS) assert.ok(districtsOf(r).length > 0, r);
    assert.equal(districtsOf('서울').length, 25);
    for (const [region, name, lat, lng] of DISTRICTS) {
      assert.ok(lat > 33 && lat < 38.7 && lng > 124.5 && lng < 131, `${region} ${name} ${lat},${lng}`);
    }
  });

  it('일반구가 있는 시는 시 하나로 합쳐져 있습니다 (수원시장안구 → 수원시)', () => {
    assert.ok(districtsOf('경기').includes('수원시'));
    assert.ok(!districtsOf('경기').some((d) => /시.+구$/.test(d)));
    assert.ok(districtsOf('대구').includes('군위군')); // 2023년 대구 편입
    assert.ok(districtsOf('인천').includes('미추홀구'));
  });

  it('알려진 곳의 중심이 실제 위치 근처입니다', () => {
    const near = (a, b, km) => assert.ok(distanceKm(a, b) < km, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    near(centerOf('서울', '강남구'), { lat: 37.5172, lng: 127.0473 }, 5); // 강남구청
    near(centerOf('부산', '해운대구'), { lat: 35.1631, lng: 129.1636 }, 8); // 해운대구청
    near(centerOf('경남', '창원시'), { lat: 35.2279, lng: 128.6811 }, 15); // 창원시청
    near(centerOf('제주', '제주시'), { lat: 33.4996, lng: 126.5312 }, 20); // 제주시청
  });
});

describe('주소 → 시·도, 시·군·구', () => {
  const cases = [
    ['서울특별시 강남구 도산대로 435', '서울', '강남구'],
    ['서울시 종로구 돈화문로6나길 45', '서울', '종로구'],
    ['경기도 수원시 팔달구 정조로 1', '경기', '수원시'],
    ['경기 광주시 오포읍', '경기', '광주시'],
    ['광주광역시 북구 서하로 1', '광주', '북구'],
    ['부산광역시 기장군 일광읍 삼성리 820', '부산', '기장군'],
    ['창원시 의창구 북면 1', '경남', '창원시'],
    ['세종특별시 새롬로26 A116호', '세종', '세종시'],
    ['전북특별자치도 완주군 이서면 기지로 56', '전북', '완주군'],
    ['강원특별자치도 고성군 거진읍', '강원', '고성군'],
    ['경남 고성군 고성읍', '경남', '고성군'],
    ['(12345) 대구 달서구 용산로 141', '대구', '달서구'],
    ['인천 남구 주안동', '인천', '남구'],
    ['부산광역시 진구 가야대로 786', '부산', '부산진구'],
    // 2026년 통합 광역 표기: 뒤의 시·군·구로 원래 시·도를 고릅니다
    ['전남광주통합특별시 목포시 비파로 96, 1층', '전남', '목포시'],
    ['전남광주통합특별시 광산구 1', '광주', '광산구'],
  ];
  for (const [address, region, district] of cases) {
    it(address, () => assert.deepEqual(parseAddress(address), { region, district }));
  }

  it('시·도를 모르면 null, 대신 넘겨준 시·도를 씁니다', () => {
    assert.deepEqual(parseAddress('알 수 없는 곳'), { region: null, district: null });
    assert.equal(toRegion('알 수 없는 곳', '부산'), '부산');
  });

  it('주소가 없는 지점은 이름으로 짐작합니다', () => {
    assert.equal(guessRegion('부평지사'), '인천');
    assert.equal(guessRegion('울산지사'), '울산');
    assert.equal(guessRegion('부산본점'), '부산'); // "산본"(군포)으로 오인하지 않음
    assert.equal(guessRegion('광주 수완점'), '광주');
    assert.equal(guessRegion('천안점'), '충남');
    assert.equal(guessDistrict('분당점'), '성남시');
    assert.equal(guessDistrict('동대구지사', '대구'), '동구');
    assert.equal(guessDistrict('고성점'), null); // 강원·경남에 모두 있어 정할 수 없음
    assert.equal(guessDistrict('울산 달동점', '울산'), '남구');
    assert.deepEqual(locateBranch({ name: '하단점', area: '부산 사하구 하단동', region: '부산' }), {
      name: '하단점',
      area: '부산 사하구 하단동',
      region: '부산',
      district: '사하구',
    });
  });
});

describe('현재 위치 → 가장 가까운 시·군·구', () => {
  it('해운대 해수욕장 → 부산 해운대구, 서울시청 → 서울 중구', () => {
    assert.equal(nearestDistrict(35.1587, 129.1604).district, '해운대구');
    const city = nearestDistrict(37.5665, 126.978);
    assert.equal(`${city.region} ${city.district}`, '서울 중구');
  });
});

describe('내 주변 매장 가격순', () => {
  const shops = [
    { id: 'a', prices: { gold24k: { buy: 790_000, sell: 680_000 } }, buyVatIncluded: true },
    { id: 'b', prices: { gold24k: { buy: 710_000, sell: 685_000 } }, buyVatIncluded: false }, // 부가세 별도 → 781,000
    { id: 'c', prices: { gold24k: { buy: 780_000, sell: 670_000 } }, buyVatIncluded: true, buyIsReference: true },
  ];
  const b = (id, chain, region, district) => ({ id, chain, quoteId: chain, name: id, region, district });
  const branches = [
    b('해운대A', 'a', '부산', '해운대구'),
    b('수영B', 'b', '부산', '수영구'),
    b('사하A', 'a', '부산', '사하구'),
    b('기장C', 'c', '부산', '기장군'),
    b('강남A', 'a', '서울', '강남구'),
    b('김해B', 'b', '경남', '김해시'),
    b('미상', 'zzz', '부산', null),
  ];

  it('같은 시·도 매장을 살 때(부가세 포함) 싼 순서로, 참고값·가격 없는 곳은 뒤로', () => {
    const rows = rankNearby({ branches, shops, user: { region: '부산' }, area: 'region' });
    assert.deepEqual(
      rows.map((r) => r.branch.id),
      ['수영B', '해운대A', '사하A', '기장C', '미상'],
    );
    assert.equal(rows[0].buy, 781_000);
    assert.equal(rows[3].buy, null); // 참고용 살 때 가격은 순위에 쓰지 않음
    assert.equal(rows[3].sell, 670_000);
  });

  it('반경을 주면 시·도 경계를 넘어 가까운 곳도 들어옵니다 (부산 강서 → 김해)', () => {
    const rows = rankNearby({ branches, shops, user: { region: '부산', district: '강서구' }, area: 'km', radiusKm: 20 });
    const ids = rows.map((r) => r.branch.id);
    assert.ok(ids.includes('김해B'));
    assert.ok(!ids.includes('해운대A')); // 약 25km 이상
    assert.ok(!ids.includes('강남A'));
    assert.ok(rows.every((r) => r.distanceKm <= 20));
  });

  it('같은 시·군·구만, 가까운 순 정렬', () => {
    const same = rankNearby({ branches, shops, user: { region: '부산', district: '해운대구' }, area: 'district' });
    assert.deepEqual(same.map((r) => r.branch.id), ['해운대A']);
    assert.equal(same[0].distanceKm, 0);

    const byDist = rankNearby({ branches, shops, user: { region: '부산', district: '해운대구' }, area: 'all', sort: 'distance' });
    assert.equal(byDist[0].branch.id, '해운대A');
    assert.equal(byDist[1].branch.id, '수영B');
    assert.equal(byDist.at(-1).distanceKm, null); // 위치 모르는 매장은 맨 뒤
  });

  it('근처에서 살 때 가장 싼 곳·팔 때 가장 비싸게 사 주는 곳', () => {
    const rows = rankNearby({ branches, shops, user: { region: '부산' }, area: 'region' });
    const best = nearbyBest(rows);
    assert.equal(best.buy.branch.id, '수영B');
    assert.equal(best.sell.branch.id, '수영B');
  });

  it('오픈 예정 매장은 가격이 싸도 맨 뒤로 보내고 추천하지 않습니다', () => {
    const list = [{ ...b('새매장', 'b', '부산', '수영구'), opening: true }, b('해운대A', 'a', '부산', '해운대구')];
    const rows = rankNearby({ branches: list, shops, user: { region: '부산' }, area: 'region' });
    assert.deepEqual(rows.map((r) => r.branch.id), ['해운대A', '새매장']);
    assert.equal(nearbyBest(rows).buy.branch.id, '해운대A');
  });

  it('은은 은 시세로 비교합니다', () => {
    const silverShops = [{ id: 'a', prices: { silver: { buy: 9_000, sell: 7_000 } }, buyVatIncluded: true }];
    const rows = rankNearby({ branches: [branches[0]], shops: silverShops, user: { region: '부산' }, area: 'region', metal: 'silver' });
    assert.equal(rows[0].buy, 9_000);
  });
});
