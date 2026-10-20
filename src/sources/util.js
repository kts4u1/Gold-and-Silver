// 여러 판매처 수집기가 함께 쓰는 도우미
import { load } from 'cheerio';
import { toNumber } from '../http.js';

/** "오롯 골드바 1,000g" → 1000, "실버바 1kg" → 1000, "골드바 11.25g [3돈]" → 11.25 */
export function parseProductWeight(name) {
  const m = /([\d,.]+)\s*(kg|g)(?![a-z])/i.exec(String(name));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2].toLowerCase() === 'kg' ? n * 1000 : n;
}

/** 상품명으로 금·은을 구분합니다. 알 수 없으면 null */
export function detectMetal(name) {
  if (/실버|은\s?(바|그래뉼)|silver/i.test(name)) return 'silver';
  if (/골드|순금|금\s?바|gold/i.test(name)) return 'gold';
  return null;
}

/**
 * 같은 중량 상품이 여러 개면 가장 싼 것 하나만 남깁니다.
 * 값이 같으면 이름이 짧은(기본형) 상품을 고릅니다.
 */
export function cheapestBySize(products) {
  const bySize = new Map();
  for (const p of products) {
    if (p.soldOut) continue;
    const key = `${p.metal ?? ''}:${p.sizeG}`;
    const prev = bySize.get(key);
    const better = !prev || p.price < prev.price || (p.price === prev.price && p.name.length < prev.name.length);
    if (better) bySize.set(key, p);
  }
  return [...bySize.values()];
}

/** "2026년 10월 19일" 또는 "2026-10-20" → "2026-10-19" */
export function parseKoreanDate(text) {
  const m = /(\d{4})\s*[년.\-/]\s*(\d{1,2})\s*[월.\-/]\s*(\d{1,2})/.exec(String(text));
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/** 카페24 상품 목록에서 상품명·가격을 읽습니다. */
export function parseCafe24List(html, baseUrl) {
  const $ = load(html);
  const products = [];
  $('li[id^="anchorBoxId_"]').each((_, el) => {
    const li = $(el);
    const nameSpans = li.find('.name span').filter((_, s) => !$(s).hasClass('title') && $(s).children().length === 0);
    const name = nameSpans.last().text().replace(/\s+/g, ' ').trim();
    // 목록에 정가(취소선)와 판매가가 함께 있으면 판매가(.pri)를, 없으면 첫 "N원"을 씁니다
    const priceText = li.find('.price_all .pri').first().text() || li.find('.price_all').first().text();
    const price = toNumber(li.attr('data-price')) ?? toNumber(/\d[\d,]*(?=\s*원)/.exec(priceText)?.[0]);
    const href = li.find('.name a').attr('href');
    const sizeG = parseProductWeight(name);
    const metal = detectMetal(name);
    const soldOut = li.find('.soldout, .icon_soldout').length > 0 || /품절/.test(li.find('.icon').text());
    if (name && price && sizeG && metal && sizeG >= 1) {
      products.push({ name, sizeG, metal, price, soldOut, url: href ? new URL(href, baseUrl).href : undefined });
    }
  });
  return products;
}

/**
 * 화면에 보이는 글자를 조각(토큰) 목록으로 나눕니다. 태그가 바뀔 때마다 한 조각입니다.
 * 표가 아닌 div로 시세를 그리는 사이트도 "살 때 → 값들 → 팔 때 → 값들" 순서로 읽을 수 있게 합니다.
 */
export function flatTokens(html) {
  const $ = load(html);
  $('script,style,noscript,svg,head').remove();
  const out = [];
  const walk = (node) => {
    for (const c of node.children ?? []) {
      if (c.type === 'text') {
        const t = c.data.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      } else if (c.type === 'tag') walk(c);
    }
  };
  walk($.root()[0]);
  return out;
}

export const PHONE_RE = /(?:0\d{1,2}|1\d{3})-\d{3,4}(?:-\d{4})?/;

const REGION_PREFIXES = [
  ['서울', '서울'], ['경기', '경기'], ['인천', '인천'], ['부산', '부산'], ['대구', '대구'], ['대전', '대전'],
  ['광주', '광주'], ['울산', '울산'], ['세종', '세종'], ['강원', '강원'], ['제주', '제주'],
  ['충북', '충북'], ['충청북', '충북'], ['충남', '충남'], ['충청남', '충남'],
  ['전북', '전북'], ['전라북', '전북'], ['전남', '전남'], ['전라남', '전남'],
  ['경북', '경북'], ['경상북', '경북'], ['경남', '경남'], ['경상남', '경남'],
];
export const REGIONS = ['서울', '경기', '인천', '부산', '대구', '대전', '광주', '울산', '세종', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];

// 시·도 없이 도시 이름으로만 시작하는 주소("창원시 의창구 …")용
const CITY_REGION = {
  창원: '경남', 마산: '경남', 김해: '경남', 양산: '경남', 진주: '경남', 거제: '경남', 밀양: '경남', 통영: '경남', 사천: '경남',
  구미: '경북', 경산: '경북', 포항: '경북', 안동: '경북', 경주: '경북', 영주: '경북',
  청주: '충북', 충주: '충북', 제천: '충북', 천안: '충남', 아산: '충남', 서산: '충남', 당진: '충남',
  전주: '전북', 익산: '전북', 군산: '전북', 완주: '전북', 순천: '전남', 여수: '전남', 목포: '전남', 광양: '전남',
  수원: '경기', 성남: '경기', 고양: '경기', 용인: '경기', 부천: '경기', 안산: '경기', 안양: '경기', 평택: '경기', 시흥: '경기',
  화성: '경기', 의정부: '경기', 김포: '경기', 하남: '경기', 구리: '경기', 춘천: '강원', 원주: '강원', 강릉: '강원',
};

/** 주소(또는 지역 표기)의 맨 앞 글자로 17개 시·도 중 하나를 고릅니다. 모르면 fallback */
export function toRegion(address, fallback = null) {
  const a = String(address ?? '').trim();
  for (const [prefix, region] of REGION_PREFIXES) if (a.startsWith(prefix)) return region;
  const city = Object.keys(CITY_REGION).find((c) => a.startsWith(c));
  if (city) return CITY_REGION[city];
  if (fallback) {
    const f = toRegion(fallback, null);
    if (f) return f;
  }
  return null;
}
