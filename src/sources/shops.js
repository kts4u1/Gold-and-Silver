// 금은방·금거래소 매장 시세(순금 1돈 살 때/팔 때)를 다루는 공통 도우미

/**
 * 매장 시세 한 건의 형태
 * @typedef {{
 *   id: string, name: string, region: string, url: string, source: string,
 *   prices: Record<'gold24k'|'gold18k'|'gold14k'|'platinum'|'silver', {buy?: number|null, sell?: number|null}>,
 *   buyVatIncluded: boolean, at: string|null, date: string|null,
 *   buyIsReference?: boolean, notes: string[]
 * }} ShopQuote
 * prices.*.buy  = 내가 살 때 (매장이 파는 값), prices.*.sell = 내가 팔 때 (매장이 사는 값). 단위는 3.75g(1돈).
 */

/** 순금 1돈 "살 때" 고시가를 3.75g 골드바 구매처로 바꿉니다. 살 때 값이 참고용이면 만들지 않습니다. */
export function shopQuoteOffer(shop) {
  const gold = shop.prices?.gold24k;
  if (!gold?.buy || shop.buyIsReference) return null;
  return {
    id: `${shop.id}-gold-3.75`,
    channelId: shop.id,
    channelName: shop.name,
    vendor: shop.name,
    metal: 'gold',
    sizeG: 3.75,
    kind: 'fixed',
    reach: 'stores', // 이 업체 매장에 가서 사는 가격
    summary: `${shop.region} · 매장 고시가 (순금 1돈)`,
    unitPrice: gold.buy,
    vatIncluded: shop.buyVatIncluded,
    sellPrice: gold.sell ?? null,
    quotedAt: shop.at,
    quotedDate: shop.date,
    source: shop.source,
    url: shop.url,
    notes: [
      '매장이 매일 고시하는 순금 1돈(3.75g) 가격입니다. 골드바 제작비가 따로 붙을 수 있으니 매장에 확인하세요',
      ...shop.notes,
    ],
  };
}

/** 쇼핑몰 상품 목록을 비교용 구매처로 바꿉니다. (가격은 부가세 포함 소비자가)
 *  reach: 어디서 살 수 있는지 — 'online'(택배 배송) | 'stores'(그 업체 매장 방문) | 'nationwide'(전국 은행·증권사) */
export function productOffers(
  products,
  { id, channelName, vendor, summary, url, source, quotedAt = null, quotedDate = null, notes = [], reach = 'stores' },
) {
  return products.map((p) => ({
    id: `${id}-${p.metal}-${p.sizeG}`,
    channelId: id,
    channelName,
    vendor,
    productName: p.name,
    metal: p.metal,
    sizeG: p.sizeG,
    kind: 'fixed',
    reach, // 'online' = 택배 배송, 'stores' = 매장 방문
    summary: `${p.name} · ${summary}`,
    unitPrice: p.price,
    vatIncluded: true,
    sellPrice: null,
    quotedAt,
    quotedDate,
    source,
    url: p.url ?? url,
    notes: [`상품명: ${p.name}`, ...notes],
  }));
}
