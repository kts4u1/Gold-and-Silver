// 구매처별 실물 금·은 총비용 계산과 최저가 순위 매기기.
// 브라우저와 서버(테스트)에서 함께 쓰는 순수 함수 모듈입니다. 외부 의존성이 없어야 합니다.

export const GRAMS_PER_TROY_OZ = 31.1034768;
export const GRAMS_PER_DON = 3.75;

/**
 * 기본 비용 설정. 화면의 "수수료 설정"에서 바꿀 수 있습니다.
 * KRX 수수료는 증권사마다 다르므로 보수적인 값으로 잡았습니다.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  vatRate: 0.1,
  // KRX 금시장 매매수수료(부가세 포함). 증권사별 약 0.165%~0.33% (온라인 기준)
  krxTradeFeeRate: 0.003,
  // 증권사 실물 인출 수수료, 인출 1건당 (부가세 포함, 한화투자증권 기준 11,000원)
  krxBrokerWithdrawFee: 11000,
  // 한국예탁결제원 인출 수수료, 골드바 1개당 (부가세 포함, 22,000원)
  krxKsdWithdrawFeePerBar: 22000,
});

/** 국제 시세($/oz)와 환율(원/$)로 1g당 원화 가격(부가세 제외)을 계산합니다. */
export function spotKrwPerGram(usdPerOz, usdKrw) {
  if (!Number.isFinite(usdPerOz) || !Number.isFinite(usdKrw)) return null;
  return (usdPerOz / GRAMS_PER_TROY_OZ) * usdKrw;
}

/** 3.75g(1돈), 37.5g(10돈), 1kg 처럼 사람이 읽기 쉬운 중량 표기 */
export function formatWeight(grams) {
  if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000}kg`;
  const g = `${Number(grams.toFixed(2))}g`;
  const don = grams / GRAMS_PER_DON;
  if (Number.isInteger(Math.round(don * 100) / 100) && don <= 100 && grams < 100) {
    return `${g} (${Math.round(don)}돈)`;
  }
  return g;
}

function sameSize(a, b) {
  return Math.abs(a - b) < 0.001;
}

/**
 * 한 구매처(offer)에서 `qty`개를 살 때 드는 총비용을 계산합니다.
 *
 * offer.kind
 *  - 'fixed': 상품 1개 가격이 정해진 경우 (은행·조폐공사·직접 입력 견적)
 *      unitPrice: 1개 가격, vatIncluded: 가격에 부가세 포함 여부, shippingFee: 주문당 배송비(선택)
 *  - 'krx': KRX 금시장에서 g 단위로 사서 골드바로 인출하는 경우
 *      pricePerGram: KRX 시세(원/g)
 */
export function quoteOffer(offer, { qty = 1, settings = {}, spotPerGram = null } = {}) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const grams = offer.sizeG * qty;
  const lines = [];

  if (offer.kind === 'krx') {
    const principal = Math.round(offer.pricePerGram * grams);
    const tradeFee = Math.round(principal * s.krxTradeFeeRate);
    const vat = Math.round(principal * s.vatRate);
    const brokerFee = s.krxBrokerWithdrawFee;
    const ksdFee = s.krxKsdWithdrawFeePerBar * qty;
    lines.push({ label: `금 매수대금 (${fmt(offer.pricePerGram)}원/g × ${fmtG(grams)})`, amount: principal });
    lines.push({ label: `매매수수료 ${pct(s.krxTradeFeeRate, 3)}`, amount: tradeFee });
    lines.push({ label: '실물 인출 부가세 10%', amount: vat });
    lines.push({ label: '증권사 인출수수료 (1건)', amount: brokerFee });
    lines.push({ label: `예탁결제원 인출수수료 (${qty}개)`, amount: ksdFee });
  } else {
    const base = Math.round(offer.unitPrice * qty);
    if (offer.vatIncluded) {
      lines.push({ label: `상품가 (부가세 포함, ${fmt(offer.unitPrice)}원 × ${qty}개)`, amount: base });
    } else {
      lines.push({ label: `상품가 (${fmt(offer.unitPrice)}원 × ${qty}개)`, amount: base });
      lines.push({ label: '부가세 10%', amount: Math.round(base * s.vatRate) });
    }
    if (offer.shippingFee) lines.push({ label: '배송비', amount: offer.shippingFee });
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  const perGram = total / grams;
  const premiumPct = spotPerGram ? perGram / spotPerGram - 1 : null;

  // 같은 곳에 바로 되팔 때 받는 금액. 판매처가 매입가를 공시하는 경우만 있습니다.
  // (KRX에서 인출한 실물은 다시 계좌에 넣을 수 없어 해당 없음)
  const resale = Number.isFinite(offer.sellPrice) ? Math.round(offer.sellPrice * qty) : null;

  return {
    offer,
    qty,
    grams,
    total,
    perGram,
    perDon: perGram * GRAMS_PER_DON,
    premiumPct,
    lines,
    resale,
    resaleLossPct: resale != null ? 1 - resale / total : null,
  };
}

/** 금속별로 살 수 있는 상품 중량 목록 (오름차순) */
export function availableSizes(offers, metal) {
  const sizes = [];
  for (const o of offers) {
    if (o.metal !== metal) continue;
    if (!sizes.some((s) => sameSize(s, o.sizeG))) sizes.push(o.sizeG);
  }
  return sizes.sort((a, b) => a - b);
}

/**
 * 같은 금속·같은 중량 상품을 qty개 살 때 총비용이 싼 순서로 정렬합니다.
 * 결과의 첫 번째가 추천 구매처입니다.
 */
export function rankOffers(offers, { metal, sizeG, qty = 1, settings = {}, spotPerGram = null }) {
  const quotes = offers
    .filter((o) => o.metal === metal && sameSize(o.sizeG, sizeG))
    .map((o) => quoteOffer(o, { qty, settings, spotPerGram }))
    .filter((q) => Number.isFinite(q.total) && q.total > 0)
    .sort((a, b) => a.total - b.total);

  const best = quotes[0];
  for (const q of quotes) {
    q.diffFromBest = best ? q.total - best.total : 0;
    q.diffFromBestPct = best ? q.total / best.total - 1 : 0;
  }
  return quotes;
}

/** 중량에 상관없이 1g당 실질 단가가 싼 순서 (상품 1개 기준) */
export function rankByPerGram(offers, { metal, settings = {}, spotPerGram = null }) {
  return offers
    .filter((o) => o.metal === metal)
    .map((o) => quoteOffer(o, { qty: 1, settings, spotPerGram }))
    .filter((q) => Number.isFinite(q.perGram) && q.perGram > 0)
    .sort((a, b) => a.perGram - b.perGram);
}

/**
 * 1위가 왜 싼지 한두 문장으로 설명합니다.
 */
export function explainRecommendation(ranked) {
  if (!ranked.length) return '';
  const [best, second] = ranked;
  const name = best.offer.channelName;
  const parts = [];
  if (best.offer.kind === 'krx') {
    parts.push(
      `${name}은(는) 판매 마진 없이 거래소 시세로 사고, 인출할 때 부가세 10%와 정액 수수료만 내기 때문에 큰 중량일수록 유리합니다.`,
    );
  } else if (best.offer.source === 'manual') {
    parts.push(`직접 입력한 견적 "${name}"이(가) 가장 저렴합니다.`);
  } else {
    parts.push(`${name}의 ${formatWeight(best.offer.sizeG)} 상품이 가장 저렴합니다.`);
  }
  if (second) {
    parts.push(
      `2위(${second.offer.channelName})보다 ${fmt(second.total - best.total)}원(${pct(second.total / best.total - 1, 1)}) 쌉니다.`,
    );
  }
  return parts.join(' ');
}

function fmt(n) {
  return Math.round(n).toLocaleString('ko-KR');
}
function fmtG(g) {
  return formatWeight(g).replace(/ \(.*\)$/, '');
}
function pct(r, digits) {
  return `${(r * 100).toFixed(digits)}%`;
}
