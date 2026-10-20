// 금거래소·금은방 사업자 홈페이지에서 (1) 오늘의 시세 (2) 골드바·실버바 판매가 (3) 지점 목록을 읽습니다.
// 사업자마다 화면 구조가 달라 읽는 방식은 세 가지입니다.
//  - 표(table): 한국감정금거래소, 한국공인금거래소, 종로금거래소
//  - 칸 순서(slots): 국제표준금거래소, K-금은거래소, 삼이금거래소 (div로 그려서 글자 순서로 읽음)
//  - 직접: GBK금거래소
import { load } from 'cheerio';
import { fetchText, toNumber } from '../http.js';
import { productOffers, shopQuoteOffer } from './shops.js';
import { guessRegion, parseAddress } from '../../shared/location.js';
import { cheapestBySize, detectMetal, flatTokens, parseKoreanDate, parseProductWeight, PHONE_RE, REGIONS, toRegion } from './util.js';

const METAL_KEYS = ['gold24k', 'gold18k', 'gold14k', 'platinum', 'silver'];
const PRICE_RE = /(\d{1,3}(?:,\d{3})+|\d+)\s*원/;

// ---------- 시세: 공통 ----------

/** 시세가 말이 되는지 확인합니다. 화면 구조가 바뀌어 엉뚱한 칸을 읽으면 여기서 걸러집니다. */
export function validateQuote(prices, { buyOnly = false } = {}) {
  const g = prices.gold24k;
  if (buyOnly) {
    if (!g?.buy || g.buy < 100_000 || g.buy > 5_000_000) throw new Error('순금 가격을 읽지 못했거나 값이 이상합니다');
    return;
  }
  if (!g?.buy || !g?.sell) throw new Error('순금 살 때·팔 때 시세를 모두 읽지 못했습니다');
  for (const v of [g.buy, g.sell]) {
    if (v < 100_000 || v > 5_000_000) throw new Error(`순금 시세 값이 이상합니다 (${v.toLocaleString('ko-KR')}원)`);
  }
  if (g.sell >= g.buy) throw new Error('순금 팔 때 가격이 살 때보다 높아 칸을 잘못 읽은 것 같습니다');
  const s = prices.silver;
  if (s?.buy && s?.sell && (s.sell >= s.buy || s.buy > 200_000 || s.sell < 500)) {
    prices.silver = { buy: null, sell: null }; // 은 칸만 이상하면 은만 버립니다
  }
}

const vatFlag = (text) => (/(VAT|부가세)\s*별도/i.test(text) ? false : /(VAT|부가세)\s*포함/i.test(text) ? true : null);

// ---------- 시세: 표 형식 ----------

function rowKey(label) {
  const l = label.replace(/\s+/g, '');
  if (/돌반지|반지|팔찌|세공|제품$/.test(l)) return null; // "순금 돌반지(세공비 별도)" 같은 줄은 순금 시세가 아님
  if (/18K/i.test(l)) return 'gold18k';
  if (/14K/i.test(l)) return 'gold14k';
  if (/백금|Platinum/i.test(l)) return 'platinum';
  if (/^은|Silver/i.test(l)) return 'silver';
  if (/순금|24K|Gold24k/i.test(l)) return 'gold24k';
  return null;
}

/** 머리글에 "살 때"·"팔 때" 칸이 있는 표를 찾아 읽습니다 (칸 순서는 머리글을 보고 정함). */
export function parseTableQuote(html) {
  const $ = load(html);
  for (const table of $('table').toArray()) {
    const rows = $(table).find('tr').toArray();
    const head = $(rows[0]).children('th,td').toArray();
    const headText = head.map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    const buyIdx = headText.findIndex((t) => /살\s?때/.test(t));
    const sellIdx = headText.findIndex((t) => /팔\s?때/.test(t));
    if (buyIdx < 0 || sellIdx < 0) continue;

    const prices = {};
    for (const tr of rows.slice(1)) {
      const cells = $(tr).children('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      const key = rowKey(cells[0] ?? '');
      if (!key) continue;
      const pick = (i) => {
        const m = PRICE_RE.exec(cells[i] ?? '');
        const n = m ? toNumber(m[1]) : null;
        return n > 0 ? n : null;
      };
      prices[key] = { buy: pick(buyIdx), sell: pick(sellIdx) };
    }
    if (!prices.gold24k) continue;
    const text = $(table).parent().text();
    return {
      prices,
      buyVatIncluded: vatFlag(headText[buyIdx]) ?? true,
      vatStated: vatFlag(headText[buyIdx]) !== null,
      date: parseKoreanDate($(table).closest('div,section').text()) ?? parseKoreanDate(text),
    };
  }
  throw new Error('시세 표를 찾지 못했습니다');
}

/**
 * 한 줄이 [종류, "살 때 가격 + 변동폭", "팔 때 가격 + 변동폭"]인 표 (중앙금거래소).
 */
export function parsePairQuote(html) {
  const $ = load(html);
  // 표가 겹겹인 사이트라 "칸이 3개 이상이고 첫 칸이 짧은 종류 이름"인 줄만 직접 골라 읽습니다
  const byTable = new Map();
  for (const tr of $('tr').toArray()) {
    const cells = $(tr).children('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    if (cells.length < 3 || cells[0].length > 30) continue;
    const key = rowKey(cells[0]);
    if (!key) continue;
    // 칸 하나에 "775,000 14,000"(가격 + 변동폭)이 같이 들어 있어 첫 숫자만 가격으로 씁니다
    const num = (v) => {
      const m = /\d{1,3}(?:,\d{3})+|\d+/.exec(v ?? '');
      const n = m ? Number(m[0].replace(/,/g, '')) : null;
      return n > 0 ? n : null; // "제품시세적용"은 숫자가 없어 null
    };
    const table = $(tr).closest('table')[0];
    const group = byTable.get(table) ?? {};
    group[key] = { buy: num(cells[1]), sell: num(cells[2]) };
    byTable.set(table, group);
  }
  for (const [table, prices] of byTable) {
    if (!prices.gold24k) continue;
    // 부가세 표기는 이 표 자신의 머리글만 봅니다 (바로 아래 은 표의 "(vat별도)"를 잘못 가져오지 않도록)
    const vat = vatFlag($(table).text().replace(/\s+/g, ' '));
    return { prices, buyVatIncluded: vat ?? true, vatStated: vat !== null, date: null };
  }
  throw new Error('시세 표를 찾지 못했습니다');
}

// ---------- 시세: 칸 순서 형식 ----------

const NA_RE = /^제품\s*시세\s*적용$/;
const SLOT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)\s*원?$/;

function slotOf(token) {
  if (NA_RE.test(token)) return 'NA';
  const m = SLOT_RE.exec(token);
  return m ? Number(m[1].replace(/,/g, '')) : undefined;
}

function takeSlots(tokens, from, count, stopAt = Infinity) {
  const out = [];
  for (let i = from; i < tokens.length && i < stopAt && out.length < count; i++) {
    const s = slotOf(tokens[i]);
    if (s !== undefined) out.push(s);
  }
  return out;
}

const price = (s) => (typeof s === 'number' && s > 0 ? s : null);

/**
 * 시세를 div로 그리는 사이트: "살 때" 값 5칸(순금·18K·14K·백금·은)과 "팔 때" 값 5칸을 글자 순서로 읽습니다.
 * spec.layout = 'marker-first' : "살 때" 글자 바로 뒤에 값이 따라옴 (K-금은, 삼이)
 *             = 'header-first' : 머리글(살 때·팔 때·종류)이 먼저 나오고 값이 한꺼번에 이어짐 (국제표준)
 * 값이 아니라 "변동폭(▼ 6,000, 14,000 (1.8%))" 같은 조각은 숫자 하나만 있는 모양이 아니라서 건너뜁니다.
 */
export function parseSlotQuote(tokens, spec) {
  const find = (re, from = 0) => {
    for (let i = from; i < tokens.length; i++) if (re.test(tokens[i])) return i;
    return -1;
  };
  const start = spec.startAfter ? find(spec.startAfter) : 0;
  if (start < 0) throw new Error('시세 영역을 찾지 못했습니다');
  const iBuy = find(spec.buy, start);
  const iSell = iBuy < 0 ? -1 : find(spec.sell, iBuy + 1);
  if (iBuy < 0 || iSell < 0) throw new Error('살 때·팔 때 머리글을 찾지 못했습니다');

  const n = spec.slots ?? 5;
  let buy;
  let sell;
  if (spec.layout === 'header-first') {
    const iLabel = find(spec.labelsEnd, iSell + 1);
    if (iLabel < 0) throw new Error('종류 머리글을 찾지 못했습니다');
    const all = takeSlots(tokens, iLabel + 1, n * 2);
    buy = all.slice(0, n);
    sell = all.slice(n);
  } else {
    buy = takeSlots(tokens, iBuy + 1, n, iSell);
    sell = takeSlots(tokens, iSell + 1, n);
  }
  if (buy.length < n || sell.length < n) throw new Error('시세 칸 수가 맞지 않아 형식이 바뀐 것 같습니다');

  const prices = {};
  METAL_KEYS.forEach((key, i) => {
    prices[key] = { buy: price(buy[i]), sell: price(sell[i]) };
  });
  const near = tokens.slice(iBuy, iBuy + 4).join(' ');
  // 날짜는 머리글 바로 앞이나 뒤에 있습니다
  const dateToken = tokens.slice(Math.max(0, start - 6), start + 12).find((t) => parseKoreanDate(t));
  return {
    prices,
    buyVatIncluded: vatFlag(near) ?? true,
    vatStated: vatFlag(near) !== null,
    date: dateToken ? parseKoreanDate(dateToken) : null,
    iEnd: iSell,
  };
}

// ---------- 시세: K-금은거래소 품목별 매입시세 ----------

/** "순금제품별 매입시세: 골드바·덩어리 680,000원 …" 와 은제품 매입가를 읽습니다. */
export function parseKgoldBuyback(tokens) {
  const section = (startRe, endRe) => {
    const s = tokens.findIndex((t) => startRe.test(t));
    if (s < 0) return [];
    let e = tokens.findIndex((t, i) => i > s && endRe.test(t));
    if (e < 0) e = tokens.length;
    const items = [];
    for (let i = s + 1; i < e - 1; i++) {
      const m = PRICE_RE.exec(tokens[i + 1]);
      if (m && !PRICE_RE.test(tokens[i]) && !/매입시세|^SILVER$|^은제품$/i.test(tokens[i])) {
        items.push({ label: tokens[i], price: toNumber(m[1]) });
        i++;
      }
    }
    return items;
  };
  return {
    gold: section(/^순금제품별$/, /^SILVER$/i),
    silver: section(/^SILVER$/i, /^고객센터$/),
  };
}

// ---------- 시세: GBK금거래소 ----------

/** GBK는 "금고에 맡겨 두는" 방식이라 일반 금은방 시세와 달라 참고용 한 줄로만 보여 줍니다. */
export function parseGbk(tokens) {
  const iBar = tokens.findIndex((t) => /^GBK\s*골드바\s*-\s*3\.75g$/.test(t));
  const bar = iBar >= 0 ? PRICE_RE.exec(tokens[iBar + 1] ?? '') : null;
  const iUpd = tokens.findIndex((t) => /업데이트 시간/.test(t));
  const iRef = tokens.findIndex((t, i) => i > iUpd && t === '순금');
  const ref = iRef >= 0 ? PRICE_RE.exec(tokens[iRef + 1] ?? '') : null;
  if (!bar) throw new Error('GBK 골드바 가격을 찾지 못했습니다');
  return {
    prices: { gold24k: { buy: toNumber(bar[1]), sell: null } }, // 기준시세(국제가 환산)는 파는 값이 아니라 넣지 않음
    referencePerDon: ref ? toNumber(ref[1]) : null,
    buyVatIncluded: false,
    vatStated: true,
    date: parseKoreanDate(tokens[iUpd] ?? ''),
  };
}

// ---------- 골드바·실버바 판매가 (홈페이지에 나와 있는 상품) ----------

/**
 * 상품명에 중량이 하나만 있는 골드바·실버바와 바로 뒤의 가격을 읽습니다.
 * "1g , 3.75g"처럼 중량이 여러 개인 상품이나 여러 상품 이름이 섞인 곳은 건너뜁니다.
 */
export function parseBarsFromTokens(tokens) {
  const bars = [];
  const isName = (t) => /(골드바|실버바)/.test(t) && t.length <= 60 && !PRICE_RE.test(t);
  for (let i = 0; i < tokens.length; i++) {
    const name = tokens[i];
    if (!isName(name)) continue;
    const weights = name.match(/\d+(?:\.\d+)?\s*(?:kg|g)(?![a-z])/gi) ?? [];
    if (weights.length !== 1) continue;
    const sizeG = parseProductWeight(weights[0]);
    const metal = detectMetal(name);
    if (!sizeG || sizeG < 1 || !metal) continue;
    const found = [];
    for (let j = i + 1; j < Math.min(tokens.length, i + 4) && found.length < 2; j++) {
      if (isName(tokens[j])) break;
      const m = PRICE_RE.exec(tokens[j]) ?? (SLOT_RE.test(tokens[j]) && tokens[j].includes(',') ? [null, tokens[j]] : null);
      if (m) found.push(toNumber(m[1]));
    }
    const p = found.length ? Math.min(...found) : null; // 정가와 할인가가 같이 있으면 할인가
    if (p && p >= 1000) bars.push({ name: name.replace(/\s+/g, ' ').trim(), sizeG, metal, price: p });
  }
  return bars;
}

// ---------- 지점 목록 ----------

const isOpening = (s) => /오픈\s*예정|예정/.test(s);
const cleanName = (s) => s.replace(/\(.*?(오픈\s*예정|예정).*?\)/g, '').replace(/\s+/g, ' ').trim();

export function parseGoodgoldBranches(tokens) {
  const idx = tokens.map((t, i) => (t === '상세보기' ? i : -1)).filter((i) => i > 0);
  const out = [];
  idx.forEach((i, k) => {
    const end = k + 1 < idx.length ? idx[k + 1] - 1 : tokens.length;
    const seg = tokens.slice(i + 1, end);
    const a = seg.findIndex((t, j) => t === '주' && seg[j + 1] === '소');
    if (a < 0) return;
    const address = seg[a + 2];
    const p = seg.findIndex((t, j) => t === '전' && seg[j + 1] === '화');
    const phone = p >= 0 ? PHONE_RE.exec(seg[p + 4] ?? '')?.[0] ?? null : null;
    const h = seg.findIndex((t, j) => t === '영' && seg[j + 1] === '업');
    const hours = h >= 0 ? seg[h + 4] ?? null : null;
    const raw = tokens[i - 1];
    out.push({ name: cleanName(raw), address, phone, hours, opening: isOpening(raw), region: toRegion(address) });
  });
  return out;
}

export function parseKaggoldBranches(html) {
  const $ = load(html);
  const out = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).children('td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
    if (cells.length < 5 || !PHONE_RE.test(cells[4])) return;
    if (/사용\s*안\s*함/.test(`${cells[2]} ${cells[3]}`)) return; // 업체가 "[사용안함]"으로 표시한 (문 닫은) 지점
    out.push({
      name: cleanName(cells[2]),
      address: cells[3],
      phone: PHONE_RE.exec(cells[4])[0],
      hours: null,
      opening: isOpening(cells[2]),
      region: toRegion(cells[3], cells[1]),
    });
  });
  const total = Number(/Total\s*(\d+)\s*건/.exec($.root().text())?.[1] ?? 0);
  return { branches: out, total };
}

export function parseGoldkoreaBranches(tokens) {
  const idx = tokens.map((t, i) => (t === '한국감정금거래소' && tokens[i + 2] === '주소' ? i : -1)).filter((i) => i >= 0);
  return idx.map((i, k) => {
    const end = k + 1 < idx.length ? idx[k + 1] : tokens.length;
    const seg = tokens.slice(i, end);
    const after = (label) => {
      const j = seg.indexOf(label);
      return j >= 0 ? seg[j + 1] : null;
    };
    const address = seg[3];
    const regionTok = seg.find((t) => REGIONS.includes(t));
    return {
      name: cleanName(seg[1]),
      address,
      phone: PHONE_RE.exec(after('전화번호') ?? '')?.[0] ?? null,
      hours: after('영업시간'),
      opening: isOpening(seg[1]),
      region: toRegion(address, regionTok),
    };
  });
}

export function parseSamegoldBranches(tokens) {
  const start = tokens.findIndex((t) => t === '검색결과');
  const out = [];
  if (start < 0) return out;
  for (let i = start + 1; i < tokens.length - 1; i++) {
    if (!/^삼이금거래소/.test(tokens[i])) continue;
    out.push({ name: tokens[i].replace(/\s+/g, ' '), address: tokens[i + 1], phone: null, hours: null, opening: false, region: toRegion(tokens[i + 1]) });
    i++;
  }
  return out;
}

const JONGRO_CITY_REGION = {
  울산: '울산', 진주: '경남', 양산: '경남', 포항: '경북', 창원: '경남', 동대구: '대구', 천안: '충남', 세종: '세종',
  나성동: '세종', 대평: '세종', 서산: '충남', 대전: '대전', 익산: '전북', 전주: '전북', 부평: '인천', 수원: '경기',
  성남: '경기', 분당: '경기', 고양: '경기', 일산: '경기', 시흥: '경기', 안산: '경기', 안양: '경기', 평촌: '경기',
  의정부: '경기', 양주: '경기', 화성: '경기', 용인: '경기',
};

/** 종로금거래소는 지사 이름만 공개합니다 (주소·전화 없음). 게시판은 스팸이 많아 쓰지 않고 사이드바 목록만 읽습니다. */
export function parseJongroBranches(tokens) {
  const s = tokens.findIndex((t) => /종로금거래소\s*지사안내/.test(t));
  const e = tokens.findIndex((t, i) => i > s && /지점인지/.test(t));
  if (s < 0) return [];
  const headings = ['서울', '경기', '인천', '경상', '충청', '전라', '강원', '제주'];
  let heading = null;
  const out = [];
  for (const t of tokens.slice(s + 1, e < 0 ? undefined : e)) {
    if (headings.includes(t)) {
      heading = t;
      continue;
    }
    if (!/^[가-힣/ ]{2,14}$/.test(t) || !heading) continue; // 숫자·기호가 섞인 글은 버림
    const city = Object.keys(JONGRO_CITY_REGION).find((c) => t.includes(c));
    const region = heading === '서울' || heading === '경기' || heading === '인천' || heading === '강원' || heading === '제주'
      ? heading
      : city
        ? JONGRO_CITY_REGION[city]
        : null;
    out.push({ name: t, address: null, phone: null, hours: null, opening: false, region });
  }
  return out;
}

// ---------- 시세: 사업자별 전용 형식 ----------

const firstPrice = (text) => {
  const m = /\d{1,3}(?:,\d{3})+|\d+/.exec(String(text ?? '').replace(/\s+/g, ' '));
  const n = m ? Number(m[0].replace(/,/g, '')) : null;
  return n > 0 ? n : null; // "제품시세적용", "-"는 null
};

/**
 * 한국금시장거래소(koreagold.kr): div 다섯 칸(순금·18K·14K·백금·은)마다 [이름, 살 때, 팔 때].
 * 값 옆의 변동폭(<p>)은 떼고 읽습니다. 화면에 날짜가 없어 date는 null입니다.
 */
export function parseKoreagoldQuote(html) {
  const $ = load(html);
  const box = $('.mkprice').first();
  if (!box.length) throw new Error('시세 영역을 찾지 못했습니다');
  const prices = {};
  METAL_KEYS.forEach((key, i) => {
    const cells = box.find(`.mkprice_contentscol_${i + 1}`).first().children().toArray();
    const read = (el) => (el ? firstPrice($(el).clone().children('p').remove().end().text()) : null);
    prices[key] = { buy: read(cells[1]), sell: read(cells[2]) };
  });
  const vat = vatFlag(box.text().replace(/\s+/g, ''));
  return { prices, buyVatIncluded: vat ?? true, vatStated: vat !== null, date: null };
}

/** 삼성금거래소 시세 위젯: 열이 금속(순금·18K·14K·백금·은), 줄이 "내가 살 때"·"내가 팔 때"인 표 */
export function parseSamsungQuote(html) {
  const $ = load(html);
  const table = $('table.sise-table').first();
  if (!table.length) throw new Error('시세 표를 찾지 못했습니다');
  const keys = table
    .find('thead th')
    .toArray()
    .map((th) => rowKey($(th).text()));
  const row = (cls) =>
    $(table)
      .find(`tr.${cls}`)
      .first()
      .children('th,td')
      .toArray();
  const buyRow = row('row-buy');
  const sellRow = row('row-sell');
  if (!buyRow.length || !sellRow.length) throw new Error('살 때·팔 때 줄을 찾지 못했습니다');
  const prices = {};
  keys.forEach((key, i) => {
    if (key && !prices[key]) prices[key] = { buy: firstPrice($(buyRow[i]).text()), sell: firstPrice($(sellRow[i]).text()) };
  });
  const vat = vatFlag($(buyRow[0]).text());
  return { prices, buyVatIncluded: vat ?? true, vatStated: vat !== null, date: parseKoreanDate($('.banner-date').first().text()) };
}

/** 국제금거래소(부산): 줄마다 [종류, 살 때(VAT별도), 팔 때], 칸 안에 변동폭이 같이 있어 첫 숫자만 씁니다. */
export function parseKggoldQuote(html) {
  const $ = load(html);
  const prices = {};
  let vatText = '';
  for (const td of $('td.gold_widgets_title2').toArray()) {
    const key = rowKey($(td).text());
    if (!key || prices[key]) continue; // "은수저" 같은 아래 줄이 "은" 값을 덮지 않도록 처음 것만
    const cells = $(td).closest('tr').children('td').toArray();
    prices[key] = { buy: firstPrice($(cells[1]).text()), sell: firstPrice($(cells[2]).text()) };
    vatText ||= $(td).closest('table').text();
  }
  if (!prices.gold24k) throw new Error('시세 표를 찾지 못했습니다');
  const vat = vatFlag(vatText.replace(/\s+/g, ''));
  return {
    prices,
    buyVatIncluded: vat ?? true,
    vatStated: vat !== null,
    date: parseKoreanDate($('td.gold_title2').first().text()),
  };
}

// ---------- 지점 목록: 사업자별 ----------

const text = ($, el) => $(el).text().replace(/\s+/g, ' ').trim();

/** 한국금시장거래소: dl 하나가 매장 하나 (.mapa1 이름, .mapa2 주소, .mapa3 전화) */
export function parseKoreagoldBranches(html) {
  const $ = load(html);
  return $('#warp_bar2_inner > dl')
    .toArray()
    .map((dl) => {
      const name = text($, $(dl).find('.mapa1').first());
      const address = text($, $(dl).find('.mapa2').first());
      const phone = PHONE_RE.exec(text($, $(dl).find('.mapa3').first()))?.[0] ?? null;
      const notice = text($, $(dl).find('.slide2').first());
      return { name: cleanName(name), address: address || null, phone, hours: null, opening: isOpening(`${name} ${/오픈\s*예정/.test(notice) ? '오픈 예정' : ''}`), region: toRegion(address, text($, $(dl).find('.barItap_1').first())) };
    })
    .filter((b) => b.name);
}

/** 삼성금거래소 대리점 목록 한 쪽: "46호점 (경기) 삼성금거래소 하남미사점" + 글 번호 */
export function parseSamsungBranchList(html) {
  const $ = load(html);
  return $('td.list-subject a')
    .toArray()
    .map((a) => {
      const title = text($, a);
      const wrId = Number(/wr_id=(\d+)/.exec($(a).attr('href') ?? '')?.[1]);
      const m = /\(([^)]+)\)\s*(.+)$/.exec(title);
      return { wrId, title, area: m?.[1] ?? null, name: (m?.[2] ?? title).replace(/^삼성금거래소\s*/, '').trim() };
    })
    .filter((x) => x.wrId);
}

/** 삼성금거래소 대리점 글: 본문 줄이 [지역, 이름, 주소, 전화, (오시는 길)] */
export function parseSamsungBranchDetail(html) {
  const $ = load(html);
  const body = $('div.view-content').first();
  if (!body.length) return null;
  const lines = (body.html() ?? '')
    .split(/<br\s*\/?>/i)
    .map((l) => load(l).text().replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const address = lines.find((l) => toRegion(l) && /\d/.test(l) && !PHONE_RE.test(l.slice(0, 14))) ?? null;
  const phone = lines.map((l) => PHONE_RE.exec(l)?.[0]).find(Boolean) ?? null;
  return { area: lines[0] ?? null, name: lines[1] ?? null, address, phone };
}

/** 중앙금거래소 지점 표: [지역, 지점명, 주소, 전화번호, 약도] */
export function parseJungangBranches(html) {
  const $ = load(html);
  return $('table.board_list tr')
    .toArray()
    .map((tr) => $(tr).children('td').toArray().map((c) => text($, c)))
    .filter((c) => c.length >= 4 && c[1] && c[2])
    .map(([area, name, address, phone]) => ({
      name: cleanName(name),
      address,
      phone: PHONE_RE.exec(phone)?.[0] ?? null,
      hours: null,
      opening: isOpening(name),
      region: toRegion(address, area),
    }));
}

/** 국제금거래소: 칸 이름(.board_name 등)으로 된 목록, 첫 줄은 머리글 */
export function parseKggoldBranches(html) {
  const $ = load(html);
  const col = (cls) => $(`.board_table_layout .${cls}`).toArray().map((e) => text($, e));
  const names = col('board_name');
  const addrs = col('board_addr');
  const tels = col('board_tel');
  const out = [];
  names.forEach((name, i) => {
    if (i === 0 && /매장명/.test(name)) return;
    const address = addrs[i] ?? null;
    if (!name || !address) return;
    out.push({ name, address, phone: PHONE_RE.exec(tels[i] ?? '')?.[0] ?? null, hours: null, opening: false, region: toRegion(address) });
  });
  return out;
}

// ---------- 사업자 목록과 수집 ----------

const SLOT_SPECS = {
  goodgold: { layout: 'header-first', startAfter: /^오늘의 시세$/, buy: /^내가 살 때$/, sell: /^내가 팔 때$/, labelsEnd: /^Silver$/i, slots: 5 },
  kgoldsilver: { layout: 'marker-first', startAfter: /^DOMESTIC GOLD PRICES$/, buy: /^살\s?때$/, sell: /^팔\s?때$/, slots: 5 },
  samegold: { layout: 'marker-first', startAfter: /^오늘의 국내시세 라인업$/, buy: /^내가 살 때$/, sell: /^내가 팔 때$/, slots: 6 },
};

/**
 * 사업자 한 곳의 설정.
 *  quote: 'table' | 'goodgold' | 'kgoldsilver' | 'samegold' | 'gbk' | 'jungang' | 'koreagold' | 'samsung' | 'kggold'
 *  quoteUrl: 시세가 홈페이지(url)가 아닌 다른 주소에 있을 때
 *  bars: 홈페이지의 골드바·실버바 가격도 읽을지
 *  branches: { url, kind, parse } 지점 목록 ('tokens' = 글자 조각으로, 'html' = HTML로 읽음, 'kaggold'·'samsung' = 여러 쪽)
 *  stores: 홈페이지 아래쪽에 적힌 매장 주소 (지점 목록이 없거나 본점이 빠진 경우)
 *  skipBranch: 지점 목록에서 뺄 이름 (다른 출처가 따로 시세를 모으는 매장)
 */
export const DEALERS = [
  {
    id: 'goodgold',
    name: '국제표준금거래소',
    region: '전국 56개 지점 (서울·경기·대전·부산 등)',
    url: 'https://www.goodgold.co.kr/',
    quote: 'goodgold',
    bars: true,
    branches: { url: 'https://www.goodgold.co.kr/81', kind: 'tokens', parse: parseGoodgoldBranches },
  },
  {
    id: 'goldkorea',
    name: '한국감정금거래소',
    region: '부산·경남·울산·충북 등 37개 지점',
    url: 'https://goldkorea.kr/',
    quote: 'table',
    bars: true,
    branches: { url: 'https://goldkorea.kr/bbs/board.php?bo_table=m0101', kind: 'tokens', parse: parseGoldkoreaBranches },
  },
  {
    id: 'kaggold',
    name: '한국공인금거래소',
    region: '전국 68개 지점 (부산·경남·경기·인천 등)',
    url: 'http://www.kaggold.com/',
    quote: 'table',
    bars: true,
    branches: { url: 'http://www.kaggold.com/bbs/board.php?bo_table=sub81', kind: 'kaggold' },
  },
  {
    id: 'jongrogx',
    name: '종로금거래소',
    region: '서울 종로 본점 · 전국 지사',
    url: 'http://www.jongrogx.com/',
    quote: 'table',
    branches: { url: 'http://www.jongrogx.com/bbs/board.php?bo_table=store2', kind: 'tokens', parse: parseJongroBranches },
    stores: [{ name: '종로 본점', address: '서울 종로구 돈화문로6나길 45 보석백화점 5층 502호', phone: '02-765-9909' }],
  },
  {
    id: 'anseong',
    name: '안성금거래소 (한국금거래소 안성공도점)',
    region: '경기 안성시 공도읍 · 031-647-8648',
    url: 'https://anseonggold.co.kr/gold-price',
    quote: 'table',
    stores: [{ name: '안성금거래소 (안성공도점)', address: '경기 안성시 공도읍 진건중길 4', phone: '031-647-8648' }],
  },
  {
    id: 'jungang',
    name: '중앙금거래소',
    region: '서울 종로 · 전국 지점',
    url: 'http://www.goldsilvershop.co.kr/',
    quote: 'jungang',
    branches: { url: 'http://www.goldsilvershop.co.kr/bbs/board.php?bo_table=jisa&mode=ifr', kind: 'html', parse: parseJungangBranches },
  },
  {
    id: 'kgoldsilver',
    name: 'K-금은거래소',
    region: '서울 종로구 봉익동',
    url: 'https://www.k-goldsilver.com/',
    quote: 'kgoldsilver',
    stores: [{ name: 'K-금은거래소 (종로 봉익동)', address: '서울 종로구 봉익동 153 골드유빌딩 306호', phone: null }],
  },
  {
    id: 'samegold',
    name: '삼이금거래소',
    region: '서울 강남(청담)·종로 등 8개 판매점',
    url: 'https://samegoldexchange.com/',
    quote: 'samegold',
    branches: { url: 'https://samegoldexchange.com/bbs/franchise.php', kind: 'tokens', parse: parseSamegoldBranches },
  },
  {
    id: 'gbk',
    name: 'GBK금거래소 (금고 보관형)',
    region: '앱·온라인 (서울 종로)',
    url: 'https://gbkmall.com/',
    quote: 'gbk',
  },
  {
    id: 'koreagold',
    name: '한국금시장거래소',
    region: '서울 목동 본점 · 전국 40여 개 지점',
    url: 'https://koreagold.kr/',
    quote: 'koreagold',
    branches: { url: 'https://koreagold.kr/board/map/list.html?board_no=1002', kind: 'html', parse: parseKoreagoldBranches },
    skipBranch: /압구정/, // 압구정점은 자체 시세를 따로 모읍니다 (goldmarket)
  },
  {
    id: 'samsunggold',
    name: '삼성금거래소',
    region: '전국 40여 개 대리점',
    url: 'https://samsunggold.co.kr/bbs/board.php?bo_table=branch',
    quoteUrl: 'https://samsunggold.co.kr/sise_widget2.php',
    quote: 'samsung',
    branches: { url: 'https://samsunggold.co.kr/bbs/board.php?bo_table=branch', kind: 'samsung' },
  },
  {
    id: 'kggold',
    name: '국제금거래소',
    region: '부산·울산·포항 3개 매장',
    url: 'https://www.kggold.co.kr/',
    quote: 'kggold',
    branches: { url: 'https://www.kggold.co.kr/index.html?m_code=109000000', kind: 'html', parse: parseKggoldBranches },
  },
];

function buildQuote(def, tokens, html) {
  switch (def.quote) {
    case 'table':
      return parseTableQuote(html);
    case 'gbk':
      return parseGbk(tokens);
    case 'jungang': {
      const q = parsePairQuote(html);
      const d = tokens.find((t) => /^\d{4}\.\d{1,2}\.\d{1,2}$/.test(t));
      return { ...q, date: d ? parseKoreanDate(d) : null };
    }
    case 'koreagold':
      return parseKoreagoldQuote(html);
    case 'samsung':
      return parseSamsungQuote(html);
    case 'kggold':
      return parseKggoldQuote(html);
    default:
      return parseSlotQuote(tokens, SLOT_SPECS[def.quote]);
  }
}

/** 표에 날짜가 없으면 "기준: 2026-10-20 12:31" 같은 안내 글에서 찾습니다. */
function withDate(q, tokens) {
  if (q.date) return q;
  const i = tokens.findIndex((t) => /^기준\s*:?$/.test(t));
  const d = i >= 0 ? parseKoreanDate(tokens[i + 1] ?? '') : null;
  return d ? { ...q, date: d } : q;
}

export function quoteToShop(def, q, tokens) {
  validateQuote(q.prices, { buyOnly: def.quote === 'gbk' });
  const notes = [];
  if (!q.vatStated) notes.push('홈페이지에 부가세 포함 여부가 적혀 있지 않아 포함 가격으로 보고 비교합니다');
  if (!q.date && def.quote === 'koreagold') notes.push('홈페이지에 시세 날짜가 표시되지 않아 받아 온 시각을 기준으로 봅니다');
  if (def.quote === 'samsung') notes.push('팔 때는 대리점 매입 시세입니다');
  if (def.quote === 'gbk') notes.push('금고 보관형: 사 두고 보관하다 바로 팔면 부가세·인출수수료가 없고, 실물로 받을 때만 붙습니다 (수수료 금액 미공개)');
  const shop = {
    id: def.id,
    name: def.name,
    region: def.region,
    url: def.url,
    source: def.id,
    prices: q.prices,
    buyVatIncluded: q.buyVatIncluded,
    buyIsReference: def.quote === 'gbk',
    at: null,
    date: q.date,
    notes,
  };
  if (def.quote === 'kgoldsilver') {
    const b = parseKgoldBuyback(tokens);
    if (b.gold.length || b.silver.length) shop.buyback = b;
  }
  return shop;
}

/**
 * 지점 목록에 공통 항목을 채웁니다.
 * quoteId: 이 매장에 붙일 가격(매장 시세 id). 지점별 시세를 따로 공개하지 않아 본사 고시가를 씁니다.
 * 다른 지점과 주소가 같은데 이름이 가리키는 시·도가 주소와 다르면(예: "천안점"인데 경기 평택 주소) 잘못 옮겨 적은 것으로 보고 뺍니다.
 */
export function finishBranches(def, list, { source = `${def.id}-stores` } = {}) {
  const seen = new Set();
  const byAddress = new Map(); // 주소 → 그 주소를 쓰는 서로 다른 지점 이름들
  for (const b of list) if (b.address) byAddress.set(b.address, new Set([...(byAddress.get(b.address) ?? []), b.name]));
  const out = [];
  for (const b of list) {
    const key = `${b.name}|${b.address ?? ''}`;
    if (!b.name || seen.has(key)) continue;
    if (def.skipBranch?.test(b.name)) continue;
    if (b.address && byAddress.get(b.address).size > 1 && nameConflictsWithAddress(b)) continue;
    seen.add(key);
    out.push({ id: `${def.id}-${out.length + 1}`, chain: def.id, chainName: def.name, url: def.url, source, quoteId: def.id, ...b });
  }
  return out;
}

/** 이름이 가리키는 시·도와 주소의 시·도가 다른지 ("천안점"인데 경기 평택 주소) */
function nameConflictsWithAddress(b) {
  const named = guessRegion(b.name);
  const { region } = parseAddress(b.address);
  return Boolean(named && region && named !== region);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** 삼성금거래소: 목록 몇 쪽 + 대리점마다 글 하나 (주소는 글 안에만 있음). 사이트에 부담이 가지 않게 천천히 받습니다. */
async function fetchSamsungBranches(spec) {
  const list = [];
  for (let p = 1; p <= 6; p++) {
    const page = parseSamsungBranchList(await fetchText(`${spec.url}&page=${p}`));
    const fresh = page.filter((x) => !list.some((y) => y.wrId === x.wrId));
    if (!fresh.length) break;
    list.push(...fresh);
    await pause(300);
  }
  const out = [];
  let failed = 0;
  for (const item of list) {
    try {
      const d = parseSamsungBranchDetail(await fetchText(`${spec.url}&wr_id=${item.wrId}`));
      const name = d?.name || item.name;
      out.push({ name, address: d?.address ?? null, area: d?.address ? null : item.area, phone: d?.phone ?? null, hours: null, opening: isOpening(item.title), region: toRegion(d?.address ?? '', item.area) });
    } catch {
      failed++;
      out.push({ name: item.name, address: null, area: item.area, phone: null, hours: null, opening: isOpening(item.title), region: toRegion(item.area ?? '') });
    }
    await pause(250);
  }
  return { list: out, warnings: failed ? [`대리점 ${failed}곳은 상세 주소를 받지 못해 지역만 표시합니다`] : [] };
}

async function fetchBranchList(def) {
  const spec = def.branches;
  if (spec.kind === 'kaggold') {
    const first = parseKaggoldBranches(await fetchText(spec.url));
    let all = first.branches;
    const pages = Math.min(Math.ceil(first.total / Math.max(first.branches.length, 1)), 8);
    for (let p = 2; p <= pages; p++) {
      all = all.concat(parseKaggoldBranches(await fetchText(`${spec.url}&page=${p}`)).branches);
    }
    return { list: all, warnings: [] };
  }
  if (spec.kind === 'samsung') return fetchSamsungBranches(spec);
  const html = await fetchText(spec.url);
  return { list: spec.parse(spec.kind === 'html' ? html : flatTokens(html)), warnings: [] };
}

/**
 * 사업자 한 곳의 오늘 시세와 홈페이지 판매가를 받습니다 (자주 갱신).
 * 지점 목록은 잘 바뀌지 않아 fetchDealerStores로 따로, 드물게 받습니다.
 */
export async function fetchDealer(def) {
  const warnings = [];
  const shops = [];
  const offers = [];
  const html = await fetchText(def.quoteUrl ?? def.url);
  const tokens = flatTokens(html);
  try {
    const shop = quoteToShop(def, withDate(buildQuote(def, tokens, html), tokens), tokens);
    shops.push(shop);
    const offer = shopQuoteOffer(shop);
    if (offer) offers.push(offer);
  } catch (err) {
    warnings.push(`시세: ${err.message}`);
  }
  if (def.bars) {
    try {
      const bars = cheapestBySize(parseBarsFromTokens(tokens));
      offers.push(
        ...productOffers(bars, {
          id: `${def.id}-shop`,
          channelName: `${def.name} · 홈페이지 판매가`,
          vendor: def.name,
          summary: '홈페이지 판매가',
          url: def.url,
          source: def.id,
          quotedDate: shops[0]?.date ?? null,
          notes: ['홈페이지에 나온 판매가입니다. 재고와 배송·방문 수령 방법은 매장에 확인하세요'],
        }),
      );
    } catch (err) {
      warnings.push(`상품: ${err.message}`);
    }
  }
  if (!shops.length && !offers.length) throw new Error(warnings.join(' · ') || `${def.name} 시세를 읽지 못했습니다`);
  return { market: {}, shops, offers, branches: [], warnings };
}

/** 사업자 한 곳의 매장 목록 (지점 목록 페이지 + 홈페이지에 적힌 본점 주소) */
export async function fetchDealerStores(def) {
  const warnings = [];
  let list = [];
  if (def.branches) {
    try {
      const res = await fetchBranchList(def);
      list = res.list;
      warnings.push(...res.warnings);
    } catch (err) {
      if (!def.stores?.length) throw err;
      warnings.push(`지점 목록: ${err.message}`);
    }
  }
  const stores = (def.stores ?? []).map((s) => ({ hours: null, opening: false, region: null, ...s }));
  const branches = finishBranches(def, [...list, ...stores]);
  if (!branches.length) throw new Error(warnings.join(' · ') || '지점 목록이 비어 있습니다');
  return { market: {}, shops: [], offers: [], branches, warnings };
}
