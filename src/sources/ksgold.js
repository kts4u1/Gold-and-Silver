// 한국금거래소 소비자 고시가 (순금·18K·14K·백금·은, 3.75g 기준)
// 한국금거래소 소매 사이트(koreagoldx.co.kr)는 해외 IP를 막아서, 같은 고시가를 그대로 보여 주는
// 대한표준금거래소(ksgold.co.kr) 홈페이지의 공개 시세 API를 씁니다 (응답의 source가 "koreagoldx").
import { load } from 'cheerio';
import { fetchJson, fetchText, toNumber } from '../http.js';
import { shopQuoteOffer } from './shops.js';
import { PHONE_RE, toRegion } from './util.js';

const API = 'http://www.ksgold.co.kr/api/price.php';
const PAGE = 'http://www.ksgold.co.kr/price.php';

const KEYS = { gold_24k: 'gold24k', gold_18k: 'gold18k', gold_14k: 'gold14k', platinum: 'platinum', silver: 'silver' };

export function parseKsgold(json) {
  if (!json?.success || !Array.isArray(json.data)) throw new Error('한국금거래소 고시가 응답 형식이 다릅니다');
  const prices = {};
  let at = null;
  let source = null;
  for (const row of json.data) {
    const key = KEYS[row.metal];
    if (!key) continue;
    // buy_price는 매장이 사는 값(내가 팔 때), sell_price는 매장이 파는 값(내가 살 때)
    prices[key] = { buy: toNumber(row.sell_price), sell: toNumber(row.buy_price) };
    at ??= toIso(row.datetime);
    source ??= row.source;
  }
  // 18K·14K 살 때는 "제품 시세 적용"이라 실제 판매가가 아닙니다
  for (const k of ['gold18k', 'gold14k']) if (prices[k]) prices[k].buy = null;
  if (!prices.gold24k?.buy) throw new Error('한국금거래소 순금 고시가가 없습니다');

  return {
    id: 'kgx-retail',
    name: '한국금거래소',
    region: '서울 종로 본점 · 전국 가맹점',
    url: PAGE,
    source: 'ksgold',
    origin: source,
    prices,
    buyVatIncluded: true,
    at,
    date: at ? at.slice(0, 10) : null,
    notes: ['전국 금은방이 가장 많이 따르는 한국금거래소 고시가입니다 (대한표준금거래소 홈페이지에서 받아옴)'],
  };
}

export async function fetchKsgold() {
  const shop = parseKsgold(await fetchJson(API));
  return { market: {}, shops: [shop], offers: [shopQuoteOffer(shop)].filter(Boolean) };
}

function toIso(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s ?? ''));
  return m ? `${m[1]}T${m[2]}+09:00` : null;
}

// ---------- 한국금거래소 가맹점 · 대한표준금거래소 매장 ----------
// 두 곳 모두 위 한국금거래소 고시가를 따르므로 매장마다 그 가격(kgx-retail)을 붙입니다.

export const KGX_STORES_URL = 'https://www.goldshell.co.kr/shopinfo/store/store.html';
export const KSGOLD_STORES_URL = 'http://www.ksgold.co.kr/stores.php';

/** 한국금거래소 가맹점 표: [지역(빈칸이면 위와 같음), 매장명, 주소, 전화(여러 개면 줄바꿈), 약도, GIA] */
export function parseKgxStores(html) {
  const $ = load(html);
  const table = $('table')
    .filter((_, t) => /매장명/.test($(t).find('th').text()) && /주소/.test($(t).find('th').text()))
    .first();
  if (!table.length) throw new Error('한국금거래소 가맹점 표를 찾지 못했습니다');
  const out = [];
  let area = null;
  for (const tr of table.find('tr').toArray()) {
    const cells = $(tr).children('td').toArray();
    if (cells.length < 4) continue;
    const t = (i) => $(cells[i]).text().replace(/\s+/g, ' ').trim();
    if (t(0)) area = t(0);
    const name = t(1);
    const address = t(2);
    if (!name || !address) continue;
    out.push({
      name: /^한국금거래소/.test(name) ? name : `한국금거래소 ${name}`,
      address,
      phone: PHONE_RE.exec(t(3))?.[0] ?? null,
      hours: null,
      opening: /예정/.test(name),
      region: toRegion(address, area === '본점' ? null : area),
    });
  }
  return out;
}

/** 대한표준금거래소 매장: 페이지 스크립트의 storesData 객체 (좌표 포함) */
export function parseKsgoldStores(html) {
  const block = /storesData\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(html)?.[1];
  if (!block) throw new Error('대한표준금거래소 매장 목록을 찾지 못했습니다');
  const field = (body, name) => new RegExp(`${name}:\\s*'([^']*)'`).exec(body)?.[1] ?? null;
  const num = (body, name) => Number(new RegExp(`${name}:\\s*(-?[\\d.]+)`).exec(body)?.[1]);
  const out = [];
  for (const m of block.matchAll(/\w+:\s*\{([\s\S]*?)\}/g)) {
    const body = m[1];
    const name = field(body, 'name');
    const address = field(body, 'address');
    if (!name || !address) continue;
    const lat = num(body, 'lat');
    const lng = num(body, 'lng');
    out.push({
      name: `대한표준금거래소 ${name}`,
      address: address.replace(/\s*대한표준금거래소\s*$/, ''),
      phone: PHONE_RE.exec(field(body, 'phone') ?? '')?.[0] ?? null,
      hours: null,
      opening: false,
      region: toRegion(address),
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}),
    });
  }
  return out;
}

const store = (chain, chainName, url) => (b, i) => ({
  id: `${chain}-${i + 1}`,
  chain,
  chainName,
  url,
  source: 'kgx-stores',
  quoteId: 'kgx-retail', // 한국금거래소 고시가
  ...b,
});

/** 두 매장 목록을 함께 받습니다 (하나가 실패해도 다른 하나는 살림). 지점 목록이라 드물게 받습니다. */
export async function fetchKgxStores() {
  const [kgx, ks] = await Promise.allSettled([fetchText(KGX_STORES_URL), fetchText(KSGOLD_STORES_URL)]);
  const warnings = [];
  const branches = [];
  const take = (res, parse, fn, label) => {
    if (res.status !== 'fulfilled') return warnings.push(`${label}: ${res.reason?.message ?? res.reason}`);
    try {
      branches.push(...parse(res.value).map(fn));
    } catch (err) {
      warnings.push(`${label}: ${err.message}`);
    }
  };
  take(kgx, parseKgxStores, store('kgx', '한국금거래소', 'https://www.goldshell.co.kr/'), '한국금거래소 가맹점');
  take(ks, parseKsgoldStores, store('ksgold', '대한표준금거래소', 'http://www.ksgold.co.kr/'), '대한표준금거래소 매장');
  if (!branches.length) throw new Error(warnings.join(' · '));
  return { market: {}, shops: [], offers: [], branches, warnings };
}
