// 위치 관련 순수 함수: 주소 → 시·도/시·군·구, 거리 계산, "내 주변 매장" 가격순 정렬.
// 브라우저와 서버(수집기·테스트)에서 함께 씁니다. 외부 의존성이 없어야 합니다.
//
// 매장 주소를 하나하나 좌표로 바꾸려면 지도 API 키가 필요해서,
// 시·군·구마다 중심 좌표 하나(shared/districts.js)를 두고 "시·군·구 중심끼리 거리"로 가깝고 먼 정도를 잽니다.
import { DISTRICTS } from './districts.js';

export const REGIONS = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
export const CAPITAL_AREA = ['서울', '경기', '인천'];

// 주소 맨 앞 시·도 표기 → 짧은 이름. 긴 이름이 먼저 와야 "충청북도"가 "충청"에서 끊기지 않습니다.
const REGION_PREFIXES = [
  ['서울', '서울'], ['경기', '경기'], ['인천', '인천'], ['부산', '부산'], ['대구', '대구'], ['대전', '대전'],
  ['광주', '광주'], ['울산', '울산'], ['세종', '세종'], ['강원', '강원'], ['제주', '제주'],
  ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'],
  ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
  ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'],
];
// "서울", "서울시", "서울특별시", "경기도", "강원특별자치도"처럼 시·도만 적힌 토막
const REGION_TOKEN_RE = /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|제주|충청북|충청남|충북|충남|전라북|전라남|전북|전남|경상북|경상남|경북|경남)(특별시|광역시|특별자치시|특별자치도|시|도)?$/;
const DISTRICT_RE = /^[가-힣]{1,6}(시|군|구)$/;
// 2026년부터 생긴 통합 광역 표기("전남광주통합특별시 목포시 …"): 뒤의 시·군·구를 보고 원래 시·도를 고릅니다
const MERGED_RE = /^(전남광주|광주전남|대구경북|경북대구|대전충남|충남대전)[가-힣]*$/;
const MERGED_REGIONS = { 전남광주: ['전남', '광주'], 광주전남: ['광주', '전남'], 대구경북: ['대구', '경북'], 경북대구: ['경북', '대구'], 대전충남: ['대전', '충남'], 충남대전: ['충남', '대전'] };

// 시·군·구 이름이 아닌 동네 이름으로 부르는 곳 (지점 이름에 자주 나옴)
const AREA_ALIASES = {
  분당: ['경기', '성남시'], 판교: ['경기', '성남시'], 일산: ['경기', '고양시'], 평촌: ['경기', '안양시'], 동탄: ['경기', '화성시'],
  광교: ['경기', '수원시'], 영통: ['경기', '수원시'], 산본: ['경기', '군포시'], 위례: ['경기', '하남시'], 미사: ['경기', '하남시'],
  압구정: ['서울', '강남구'], 청담: ['서울', '강남구'], 신사: ['서울', '강남구'], 잠실: ['서울', '송파구'], 명동: ['서울', '중구'],
  천호: ['서울', '강동구'], 신림: ['서울', '관악구'], 목동: ['서울', '양천구'], 여의도: ['서울', '영등포구'], 노원: ['서울', '노원구'],
  서면: ['부산', '부산진구'], 남포: ['부산', '중구'], 하단: ['부산', '사하구'], 센텀: ['부산', '해운대구'], 동대구: ['대구', '동구'],
  둔산: ['대전', '서구'], 상무: ['광주', '서구'], 충장: ['광주', '동구'], 나성동: ['세종', '세종시'], 대평: ['세종', '세종시'],
  마산: ['경남', '창원시'], 진해: ['경남', '창원시'], 송도: ['인천', '연수구'], 구월: ['인천', '남동구'], 청라: ['인천', '서구'],
  당산: ['서울', '영등포구'], 신촌: ['서울', '서대문구'], 홍대: ['서울', '마포구'], 건대: ['서울', '광진구'], 강남역: ['서울', '강남구'],
  달동: ['울산', '남구'], 삼산: ['울산', '남구'], 언양: ['울산', '울주군'], 수성: ['대구', '수성구'], 범어: ['대구', '수성구'],
};
// 주소에 줄여 쓰는 구 이름 ("부산광역시 진구 …" = 부산진구)
const SHORT_DISTRICTS = { '부산 진구': '부산진구' };

const key = (region, district) => `${region} ${district}`;
const stem = (name) => name.replace(/(시|군|구)$/, '');

// 시·군·구 표: "경기 수원시" → {region, district, lat, lng}
const BY_KEY = new Map();
const BY_NAME = new Map(); // "수원시" → [항목들] (중구·동구처럼 여러 시·도에 있는 이름)
for (const [region, district, lat, lng] of DISTRICTS) {
  const d = { region, district, lat, lng };
  BY_KEY.set(key(region, district), d);
  BY_NAME.set(district, [...(BY_NAME.get(district) ?? []), d]);
}

// 시·도 중심: 그 시·도 시·군·구 중심들의 평균
const REGION_CENTER = new Map();
for (const r of REGIONS) {
  const list = DISTRICTS.filter((d) => d[0] === r);
  if (list.length) {
    REGION_CENTER.set(r, {
      lat: list.reduce((s, d) => s + d[2], 0) / list.length,
      lng: list.reduce((s, d) => s + d[3], 0) / list.length,
    });
  }
}

/** 시·도 이름 목록 순서대로 그 시·도의 시·군·구 이름 (가나다순) */
export function districtsOf(region) {
  return DISTRICTS.filter((d) => d[0] === region)
    .map((d) => d[1])
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 주소(또는 "서울 강남" 같은 지역 표기)의 맨 앞으로 17개 시·도 중 하나를 고릅니다. 모르면 fallback의 시·도 */
export function toRegion(address, fallback = null) {
  const a = String(address ?? '').replace(/^\s*[([]?\s*(우\s*)?\d{5}\s*[)\]]?\s*/, '').trim();
  const words = a.split(/\s+/);
  if (MERGED_RE.test(words[0] ?? '')) {
    const pair = MERGED_REGIONS[words[0].slice(0, 4)];
    const next = (words[1] ?? '').replace(/[(),]/g, '');
    return pair.find((r) => BY_KEY.has(key(r, next))) ?? pair[0];
  }
  for (const [prefix, region] of REGION_PREFIXES) if (a.startsWith(prefix)) return region;
  // 시·도 없이 "창원시 의창구 …"처럼 시·군 이름으로 시작하는 주소: 이름이 하나뿐인 시·군이면 그 시·도
  const first = a.split(/\s+/)[0] ?? '';
  const city = DISTRICT_RE.test(first) ? first : `${first}시`;
  const hits = BY_NAME.get(city);
  if (hits?.length === 1) return hits[0].region;
  const alias = AREA_ALIASES[first.replace(/(시|구|동|점)$/, '')];
  if (alias) return alias[0];
  if (fallback) return toRegion(fallback, null);
  return null;
}

/**
 * 주소 → { region, district }. district는 시·군·구 이름(일반구가 있는 시는 "수원시"처럼 시까지)이고 모르면 null.
 *   "서울특별시 강남구 압구정로 …" → { region: '서울', district: '강남구' }
 *   "경기 수원시 팔달구 …"        → { region: '경기', district: '수원시' }
 *   "창원시 의창구 …"             → { region: '경남', district: '창원시' }
 *   "세종특별자치시 나성동 …"      → { region: '세종', district: '세종시' }
 */
export function parseAddress(address, fallbackRegion = null) {
  const text = String(address ?? '')
    .replace(/^\s*[([]?\s*(우\s*)?\d{5}\s*[)\]]?\s*/, '')
    .replace(/[(),]/g, ' ')
    .trim();
  const region = toRegion(text, fallbackRegion);
  if (!region) return { region: null, district: null };
  if (region === '세종') return { region, district: '세종시' };

  const words = text.split(/\s+/);
  let i = 0;
  if (REGION_TOKEN_RE.test(words[0] ?? '') || MERGED_RE.test(words[0] ?? '')) i = 1;
  // "서울 강남구", "경기도 수원시 팔달구": 시·도 다음 첫 시·군·구
  for (; i < Math.min(words.length, 4); i++) {
    const w = words[i];
    if (!DISTRICT_RE.test(w)) continue;
    if (BY_KEY.has(key(region, w))) return { region, district: w };
    if (SHORT_DISTRICTS[key(region, w)]) return { region, district: SHORT_DISTRICTS[key(region, w)] };
    if (w.endsWith('구') || w.endsWith('군') || w.endsWith('시')) {
      // "고양시 일산동구"처럼 표에 시만 있는 경우, 또는 "중구"처럼 그 시·도에 있는 구
      const asCity = `${stem(w)}시`;
      if (BY_KEY.has(key(region, asCity))) return { region, district: asCity };
    }
  }
  return { region, district: guessDistrict(text, region) };
}

/**
 * 주소가 없는 지점("부평지사", "분당점")은 이름 속 지역명으로 시·군·구를 짐작합니다.
 * 같은 시·도 안에서 이름이 겹치지 않을 때만 고릅니다.
 */
export function guessDistrict(name, region = null) {
  const text = String(name ?? '');
  for (const [alias, [r, d]] of Object.entries(AREA_ALIASES)) {
    if (text.includes(alias) && (!region || region === r)) return d;
  }
  const candidates = DISTRICTS.filter(([r, d]) => (!region || r === region) && stem(d).length >= 2 && text.includes(stem(d)));
  // "동대구"에 "대구"가 들어 있는 식의 오인을 줄이려고 가장 긴 이름을 고릅니다
  candidates.sort((a, b) => stem(b[1]).length - stem(a[1]).length);
  if (!candidates.length) return null;
  const best = candidates.filter((c) => stem(c[1]).length === stem(candidates[0][1]).length);
  return best.length === 1 ? best[0][1] : null;
}

/** 주소가 없는 지점의 시·도도 이름으로 짐작합니다 ("부평" → 인천). 하나로 정해질 때만. */
export function guessRegion(name) {
  const text = String(name ?? '');
  for (const [alias, [r]] of Object.entries(AREA_ALIASES)) if (text.includes(alias)) return r;
  const hits = DISTRICTS.filter(([, d]) => stem(d).length >= 2 && text.includes(stem(d)));
  const regions = [...new Set(hits.map((h) => h[0]))];
  if (regions.length === 1) return regions[0];
  // "울산지사", "대전점"처럼 광역시 이름이 들어 있는 경우
  return REGIONS.find((r) => text.includes(r)) ?? null;
}

/**
 * 매장 하나의 시·도와 시·군·구를 채웁니다. 주소가 있으면 주소로, 없으면 이름("부평지사")으로 짐작합니다.
 * 이미 적힌 region은 주소를 못 읽을 때만 씁니다.
 */
export function locateBranch(b) {
  if (b.address) {
    const p = parseAddress(b.address, b.region);
    if (p.region) return { ...b, region: p.region, district: p.district ?? b.district ?? null };
  }
  const hint = [b.area, b.name].filter(Boolean).join(' ');
  const region = b.region ?? toRegion(b.area ?? '') ?? guessRegion(hint);
  const district = b.district ?? (b.area ? parseAddress(b.area, region).district : null) ?? guessDistrict(hint, region);
  return { ...b, region: region ?? null, district: district ?? null };
}

/** 시·군·구(또는 시·도) 중심 좌표. 모르면 null */
export function centerOf(region, district) {
  if (region && district) {
    const d = BY_KEY.get(key(region, district));
    if (d) return { lat: d.lat, lng: d.lng, precise: true };
  }
  const c = region ? REGION_CENTER.get(region) : null;
  return c ? { ...c, precise: false } : null;
}

/** 두 좌표 사이 거리 (km, 지구를 공으로 보고 계산) */
export function distanceKm(a, b) {
  if (!a || !b) return null;
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 현재 위치(위도·경도)에서 가장 가까운 시·군·구 중심 */
export function nearestDistrict(lat, lng) {
  let best = null;
  for (const d of BY_KEY.values()) {
    const km = distanceKm({ lat, lng }, d);
    if (!best || km < best.km) best = { region: d.region, district: d.district, km };
  }
  return best;
}

/**
 * 매장(지점) 목록에 오늘 가격을 붙이고, 내 위치 기준으로 거르고 정렬합니다.
 *
 * @param {object} p
 * @param {Array} p.branches  매장 목록 ({chain, quoteId, region, district, ...})
 * @param {Array} p.shops     매장 시세 목록 (prices.gold24k.buy/sell 등, 3.75g 단위)
 * @param {{region?: string, district?: string}} p.user  내 위치
 * @param {'district'|'km'|'region'|'all'} p.area  같은 시·군·구 / 반경 radiusKm 안 / 같은 시·도 / 전국
 * @param {number} p.radiusKm  area가 'km'일 때 반경
 * @param {'gold'|'silver'} p.metal
 * @param {'price'|'sell'|'distance'} p.sort  살 때 싼 순 / 팔 때 비싼 순 / 가까운 순
 * @param {number} p.vatRate
 * @returns {Array<{branch, shop, distanceKm: number|null, buy: number|null, sell: number|null, sameDistrict: boolean}>}
 *   buy = 내가 살 때 (부가세 포함으로 맞춤), sell = 내가 팔 때
 */
export function rankNearby({ branches = [], shops = [], user = {}, area = 'region', radiusKm = 20, metal = 'gold', sort = 'price', vatRate = 0.1 }) {
  const keyName = metal === 'silver' ? 'silver' : 'gold24k';
  const shopById = new Map(shops.map((s) => [s.id, s]));
  const home = user.region ? centerOf(user.region, user.district) : null;
  const precise = Boolean(home?.precise);
  const isSame = (b) => precise && b.region === user.region && b.district === user.district;

  const rows = [];
  for (const b of branches) {
    const center = centerOf(b.region, b.district);
    const same = isSame(b);
    // 거리는 내 시·군·구와 매장 시·군·구를 둘 다 알 때만 (시·도만 알면 너무 부정확)
    const km = same ? 0 : precise && center?.precise ? distanceKm(home, center) : null;
    if (area === 'district' && precise && !same) continue;
    if (area === 'km' && precise && (km == null || km > radiusKm)) continue;
    if ((area === 'region' || (!precise && area !== 'all')) && user.region && b.region !== user.region) continue;

    const shop = shopById.get(b.quoteId ?? b.chain) ?? null;
    const p = shop?.prices?.[keyName];
    const buy = p?.buy && !shop.buyIsReference ? Math.round(shop.buyVatIncluded ? p.buy : p.buy * (1 + vatRate)) : null;
    rows.push({ branch: b, shop, distanceKm: km, buy, sell: p?.sell ?? null, sameDistrict: same });
  }

  const byDist = (a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
  // 오픈 예정 매장은 오늘 살 수 없으니 가격이 있어도 맨 뒤로
  const group = (r) => (r.branch.opening ? 3 : r.buy ? 0 : r.sell ? 1 : 2);
  rows.sort((a, b) => {
    if (sort === 'distance') return byDist(a, b) || group(a) - group(b) || (a.buy ?? 0) - (b.buy ?? 0);
    // 팔 때 비싼 순: 팔 때 가격 없는 곳은 뒤로
    if (sort === 'sell') return (a.sell && !a.branch.opening ? 0 : 1) - (b.sell && !b.branch.opening ? 0 : 1) || (b.sell ?? 0) - (a.sell ?? 0) || byDist(a, b);
    // 가격순: 살 때 가격 있는 곳 → 팔 때만 있는 곳 → 가격 미공개. 같은 값이면 가까운 곳 먼저
    return group(a) - group(b) || (a.buy ?? 0) - (b.buy ?? 0) || (b.sell ?? 0) - (a.sell ?? 0) || byDist(a, b);
  });
  return rows;
}

/** 거리 순으로 가장 가까운 매장 n곳 (근처에 매장이 없을 때 안내용) */
export function nearestBranches(rows, n = 5) {
  return rows
    .filter((r) => r.distanceKm != null)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, n);
}

/** 근처 매장 중 살 때 가장 싼 곳·팔 때 가장 비싸게 사 주는 곳 */
export function nearbyBest(rows) {
  let buy = null;
  let sell = null;
  for (const r of rows) {
    if (r.branch.opening) continue; // 아직 문을 열지 않은 매장은 추천하지 않음
    if (r.buy && (!buy || r.buy < buy.buy || (r.buy === buy.buy && (r.distanceKm ?? Infinity) < (buy.distanceKm ?? Infinity)))) buy = r;
    if (r.sell && (!sell || r.sell > sell.sell)) sell = r;
  }
  return { buy, sell };
}

