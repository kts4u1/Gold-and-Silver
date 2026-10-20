// 금골디 (goldie.co.kr): 제휴 금은방에 금을 파는 플랫폼. 홈페이지 "실시간 시세 현황"의 1돈 가격.
// 팔 때(매입) 시세 참고용입니다. 살 때 값은 기준 시각이 없고 국제 시세+부가세보다 낮게 나오는 경우가 있어
// 구매처 순위에는 넣지 않습니다.
import { fetchText } from '../http.js';

const URL = 'https://www.goldie.co.kr/';

function extract(raw, key) {
  // Next.js 페이지 데이터 안에 "buyRes":{"code":200,…,"data":{…}} 형태로 들어 있습니다 (따옴표가 \" 로 이스케이프됨)
  const text = raw.replace(/\\"/g, '"');
  const m = new RegExp(`"${key}":(\\{"code":\\d+,"message":"[^"]*","data":\\{[^{}]*\\}\\})`).exec(text);
  return m ? JSON.parse(m[1]).data : null;
}

export function parseGoldie(html) {
  const buy = extract(html, 'buyRes');
  const sell = extract(html, 'sellRes');
  if (!sell?.goldTaelPrice) throw new Error('금골디 시세를 찾지 못했습니다');
  return {
    id: 'goldie',
    name: '금골디 (제휴 금은방)',
    region: '전국 제휴 금은방 · 택배 매입',
    url: URL,
    source: 'goldie',
    prices: {
      gold24k: { buy: buy?.goldTaelPrice ?? null, sell: sell.goldTaelPrice },
      gold18k: { buy: null, sell: sell.gold18KTaelPrice ?? null },
      gold14k: { buy: null, sell: sell.gold14KTaelPrice ?? null },
      platinum: { buy: buy?.whiteGoldTaelPrice ?? null, sell: sell.whiteGoldTaelPrice ?? null },
      silver: { buy: buy?.silverTaelPrice ?? null, sell: sell.silverTaelPrice ?? null },
    },
    buyVatIncluded: true,
    buyIsReference: true,
    at: null,
    date: null,
    notes: ['금 매입 플랫폼의 기준 시세입니다. 실제 매입가는 감정 후 정해집니다'],
  };
}

export async function fetchGoldie() {
  return { market: {}, shops: [parseGoldie(await fetchText(URL))], offers: [] };
}
