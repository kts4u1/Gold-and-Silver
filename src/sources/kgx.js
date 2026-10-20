// 한국금거래소 사업자용 시세 (exgold.co.kr): 국제 실시간 시세, 국내 도매시세, 매입시세
// 일반 소비자용 사이트(koreagoldx.co.kr)는 해외 IP를 막고 있어 사업자용 공개 API를 씁니다.
import { fetchJson, toNumber } from '../http.js';

const API = 'https://www.exgold.co.kr/api/main';
export const KGX_PAGE = 'https://www.exgold.co.kr/';

const PURCHASE_NAMES = {
  PURE_GOLD: '순금 (24K)',
  '18K_GOLD': '18K',
  '14K_GOLD': '14K',
  PLATINUM: '백금',
  SILVER: '은',
};

export function parseKgxMain(json) {
  if (!json || !Array.isArray(json.wholesaleList)) throw new Error('한국금거래소 시세 응답 형식이 다릅니다');

  const wholesale = {};
  for (const w of json.wholesaleList) {
    const metal = { Au: 'gold', Ag: 'silver' }[w.type];
    if (!metal) continue;
    wholesale[metal] = {
      perDon: toNumber(w.price),
      perGram: toNumber(w.priceGram),
      spotPerGram: toNumber(w.globalPrice),
      change: toNumber(w.diff),
      at: toIso(w.date),
    };
  }

  const purchase = (json.purchaseList ?? []).map((p) => ({
    type: p.type,
    name: PURCHASE_NAMES[p.type] ?? p.typeName,
    perDon: toNumber(p.price),
    change: toNumber(p.diff),
    changePct: toNumber(p.diffPer),
    at: toIso(p.date),
  }));

  const spot = {};
  for (const m of json.marketPriceList ?? []) {
    const metal = { au: 'gold', ag: 'silver' }[m.type];
    if (!metal) continue;
    spot[metal] = { bid: toNumber(m.bid), ask: toNumber(m.ask), perGram: toNumber(m.priceGram), changePct: toNumber(m.askDiffPer) };
  }

  return { at: toIso(json.date), wholesale, purchase, spot, usdKrw: toNumber(json.exchangeRate?.ask) };
}

export async function fetchKgx() {
  const json = await fetchJson(API, { method: 'POST', headers: { 'x-requested-with': 'XMLHttpRequest' } });
  return { market: { kgx: parseKgxMain(json) }, offers: [] };
}

/** "2026-10-20 10:51:55" (한국 시간) → ISO 문자열 */
function toIso(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s));
  return m ? `${m[1]}T${m[2]}+09:00` : null;
}
