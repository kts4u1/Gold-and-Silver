// 삼성금거래소 공식몰 (ssgold.co.kr): 골드바 1g~1kg, 실버바 100g~1kg 판매가 (부가세 포함, 매일 시세 반영)
import { fetchText } from '../http.js';
import { productOffers } from './shops.js';
import { cheapestBySize, parseCafe24List } from './util.js';

const URL = 'https://www.ssgold.co.kr/';

export function parseSsgold(html) {
  return cheapestBySize(parseCafe24List(html, URL));
}

export async function fetchSsgold() {
  const products = parseSsgold(await fetchText(URL));
  if (!products.length) throw new Error('삼성금거래소 공식몰에서 골드바·실버바 가격을 찾지 못했습니다');
  return {
    market: {},
    shops: [],
    offers: productOffers(products, {
      id: 'ssgold',
      channelName: '삼성금거래소 공식몰',
      vendor: '삼성금거래소',
      summary: '온라인 주문, 택배 배송',
      reach: 'online',
      url: URL,
      source: 'ssgold',
      quotedAt: new Date().toISOString(),
      notes: ['국제 시세에 맞춰 매일 바뀌는 가격입니다 · 평일 오전 10시 이전 입금분까지 당일 처리'],
    }),
  };
}
