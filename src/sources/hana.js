// 하나은행 골드바·실버바 고시가격 (회차별, 수시 갱신)
// 페이지: https://www.kebhana.com/cont/mall/mall14/mall1402/index.jsp (일자별 기준가격)
import { load } from 'cheerio';
import { fetchText, kstDate, toNumber } from '../http.js';

const BASE = 'https://www.kebhana.com/cms/goldbar';
const GOLD_PAGE = 'https://www.kebhana.com/cont/mall/mall14/mall1402/index.jsp';
const SILVER_PAGE = 'https://www.kebhana.com/cont/mall/mall14/mall1405/index.jsp';
const NO_DATA_CODE = 'BCOM10311';

const COMMON_NOTES = [
  '하나은행 영업점에서 신청 → 영업일 4~5일 뒤 방문 수령',
  '거래시간 평일 09:00~16:00 · 같은 은행에 되팔기 가능',
];

/** 하나은행 상품 탭 (엔드포인트 번호 → 상품) */
export const HANA_PRODUCTS = [
  { tab: '04', channelId: 'hana-kgx', label: '한국금거래소 골드바', maker: '한국금거래소', metal: 'gold' },
  { tab: '01', channelId: 'hana-lsmnm', label: 'LS MnM 골드바', maker: 'LS MnM', metal: 'gold' },
  { tab: '03', channelId: 'hana-komsco', label: '조폐공사 골드바', maker: '한국조폐공사 인증', metal: 'gold' },
  { tab: '05', channelId: 'hana-samsung', label: '삼성금거래소 골드바', maker: '삼성금거래소', metal: 'gold' },
  {
    tab: '06',
    channelId: 'hana-gift',
    label: '골드바 선물하기',
    maker: '한국금거래소',
    metal: 'gold',
    extraNotes: ['선물용 상품이라 일반 골드바보다 비쌉니다'],
  },
  {
    tab: '02',
    channelId: 'hana-kgx-silver',
    label: '한국금거래소 실버바',
    maker: '한국금거래소',
    metal: 'silver',
    form: { gdbDvcd: '02' },
  },
];

/** "37.5g" → 37.5, "1kg" → 1000, "Large bar" → null */
export function parseSizeLabel(label) {
  const m = /([\d.]+)\s*(kg|g)\b/i.exec(String(label).replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'kg' ? n * 1000 : n;
}

/**
 * 하나은행 기준가격 표에서 가장 최근 회차 한 줄을 읽습니다.
 * @returns {null | {round, time, basePrice, intlUsdPerOz, usdKrw, buy: Array, sell: Array}}
 */
export function parseHanaTable(html) {
  const trimmed = html.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let err = null;
    try {
      const parsed = JSON.parse(trimmed);
      err = Array.isArray(parsed) ? parsed[0] : parsed;
    } catch {
      /* 메시지를 못 읽어도 기본 문구 사용 */
    }
    // 주말·공휴일처럼 그날 고시가 없으면 "해당 데이터가 존재하지 않습니다" 오류가 옵니다
    if (err?.errorCode === NO_DATA_CODE) return null;
    throw new Error(err?.errorMessage?.replace(/\\n/g, ' ') || '하나은행 응답 오류');
  }

  const $ = load(html);
  const table = $('table').first();
  if (!table.length) throw new Error('하나은행 가격표를 찾지 못했습니다');

  const headRows = table.find('thead tr');
  const buyCount = Number(headRows.eq(0).find('th[colspan]').first().attr('colspan'));
  const sizeLabels = headRows
    .eq(1)
    .find('th')
    .map((_, el) => $(el).text().trim())
    .get();
  if (!buyCount || sizeLabels.length < buyCount) throw new Error('하나은행 가격표 형식이 바뀌었습니다');

  const row = table.find('tbody tr').first();
  const cells = row
    .children('th,td')
    .map((_, el) => $(el).text().trim())
    .get();
  if (cells.length < 5 + sizeLabels.length) return null; // 해당 날짜 고시 없음

  const values = cells.slice(5).map(toNumber);
  const toEntries = (labels, offset) =>
    labels
      .map((label, i) => ({ label, sizeG: parseSizeLabel(label), price: values[offset + i] }))
      .filter((e) => e.sizeG && e.price);

  return {
    round: toNumber(cells[0]),
    time: cells[1],
    basePrice: toNumber(cells[2]),
    intlUsdPerOz: toNumber(cells[3]),
    usdKrw: toNumber(cells[4]),
    buy: toEntries(sizeLabels.slice(0, buyCount), 0),
    sell: toEntries(sizeLabels.slice(buyCount), buyCount),
  };
}

/** 파싱 결과를 비교용 상품(offer) 목록으로 바꿉니다. 은행 고시가는 부가세 별도입니다. */
export function hanaOffers(product, table, date) {
  if (!table) return [];
  const quotedAt = `${date}T${table.time}+09:00`;
  return table.buy.map((b) => {
    const sell = table.sell.find((s) => Math.abs(s.sizeG - b.sizeG) < 0.001);
    return {
      id: `${product.channelId}-${b.sizeG}`,
      channelId: product.channelId,
      channelName: `하나은행 · ${product.label}`,
      vendor: '하나은행',
      maker: product.maker,
      metal: product.metal,
      sizeG: b.sizeG,
      kind: 'fixed',
      summary: '은행 영업점 신청 · 방문 수령',
      unitPrice: b.price,
      vatIncluded: false,
      sellPrice: sell ? sell.price : null,
      quotedAt,
      source: 'hana',
      url: product.metal === 'silver' ? SILVER_PAGE : GOLD_PAGE,
      notes: [...(product.extraNotes ?? []), ...COMMON_NOTES],
    };
  });
}

async function fetchTab(product, date) {
  const html = await fetchText(`${BASE}/wpgdb430_01i_${product.tab}.do`, {
    form: {
      trscStrDt: date.replace(/-/g, ''),
      requestPageNo: '1',
      listSize: '1',
      ...(product.form ?? {}),
    },
    headers: { referer: `${BASE}/wpgdb430_01i.do`, 'x-requested-with': 'XMLHttpRequest' },
  });
  return parseHanaTable(html);
}

/** 오늘 고시가 없으면(이른 아침·휴일) 최근 영업일까지 거슬러 올라갑니다. */
async function fetchLatest(product, now) {
  for (let back = 0; back < 7; back++) {
    const date = kstDate(now, -back);
    const table = await fetchTab(product, date);
    if (table) return { table, date };
  }
  return null;
}

export async function fetchHana(now = new Date()) {
  const results = await Promise.allSettled(HANA_PRODUCTS.map((p) => fetchLatest(p, now)));
  const offers = [];
  const warnings = [];
  let goldBase = null;
  let silverBase = null;

  results.forEach((r, i) => {
    const product = HANA_PRODUCTS[i];
    if (r.status === 'rejected') {
      warnings.push(`${product.label}: ${r.reason?.message ?? r.reason}`);
      return;
    }
    if (!r.value) return;
    const { table, date } = r.value;
    offers.push(...hanaOffers(product, table, date));
    const base = { perGram: table.basePrice, intlUsdPerOz: table.intlUsdPerOz, usdKrw: table.usdKrw, at: `${date}T${table.time}+09:00` };
    if (product.metal === 'gold' && !goldBase) goldBase = base;
    if (product.metal === 'silver' && !silverBase) silverBase = base;
  });

  if (!offers.length) throw new Error(warnings[0] ?? '하나은행 고시가를 가져오지 못했습니다');
  return { market: { hana: { gold: goldBase, silver: silverBase } }, offers, warnings };
}
