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
