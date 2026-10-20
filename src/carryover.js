// 정적 사이트(GitHub Pages)를 다시 만들 때, 이번에 수집에 실패한 출처는 직전에 배포한 값을 이어서 씁니다.
// 출처 한두 곳이 잠깐 안 열린다고 매장·가격이 화면에서 사라지지 않게 하려는 것입니다.
// 이어 쓴 값은 "지연" 표시가 붙고, 너무 오래된 값(기본 48시간)은 쓰지 않습니다.
import { computeSpot } from './collect.js';

const HOUR = 3600 * 1000;

/**
 * @param {object} current   이번에 모은 데이터 (createCollector 결과)
 * @param {object|null} previous  직전에 배포한 data/prices.json
 * @param {{ now?: number, maxAgeMs?: number, branchMaxAgeMs?: number }} [opts]
 * @returns {object} 합친 데이터 (current는 바꾸지 않음)
 */
export function carryOver(current, previous, { now = Date.now(), maxAgeMs = 48 * HOUR, branchMaxAgeMs = 14 * 24 * HOUR } = {}) {
  if (!previous || !Array.isArray(previous.sources)) return current;
  const out = {
    ...current,
    market: { ...current.market },
    shops: [...(current.shops ?? [])],
    offers: [...(current.offers ?? [])],
    branches: [...(current.branches ?? [])],
    sources: (current.sources ?? []).map((s) => ({ ...s, warnings: [...(s.warnings ?? [])] })),
  };
  const fresh = (iso, limit) => Boolean(iso) && now - Date.parse(iso) <= limit;
  const ofSource = (list, id) => (list ?? []).filter((x) => (x.source ?? x.chain) === id);

  for (const st of out.sources) {
    const prev = previous.sources.find((p) => p.id === st.id);
    if (!prev) continue;

    // 1) 출처 전체가 실패: 직전 시세·상품·매장을 그대로 이어 씀
    if (!st.ok && !st.stale && (prev.ok || prev.stale) && fresh(prev.fetchedAt, maxAgeMs)) {
      const shops = ofSource(previous.shops, st.id);
      const offers = ofSource(previous.offers, st.id);
      const branches = ofSource(previous.branches, st.id);
      if (shops.length || offers.length || branches.length) {
        out.shops.push(...shops);
        out.offers.push(...offers);
        out.branches.push(...branches);
        st.stale = true;
        st.fetchedAt = prev.fetchedAt;
        st.branchesAt = prev.branchesAt ?? prev.fetchedAt;
        st.warnings.push('이번 수집에 실패해 직전에 받은 값을 보여 줍니다');
        continue;
      }
    }

    // 2) 시세는 받았지만 지점 목록만 실패: 지점 목록은 잘 바뀌지 않아 더 오래(기본 14일) 이어 씀
    const current = out.branches.filter((b) => (b.source ?? b.chain) === st.id);
    const branchFailed = st.warnings.some((w) => /^지점:/.test(w));
    if (!current.length || branchFailed) {
      const at = prev.branchesAt ?? prev.fetchedAt;
      const known = new Set(current.map((b) => `${b.name}|${b.address ?? ''}`));
      const ids = new Set(out.branches.map((b) => b.id));
      const missing = ofSource(previous.branches, st.id).filter((b) => !known.has(`${b.name}|${b.address ?? ''}`));
      if (missing.length && fresh(at, branchMaxAgeMs)) {
        out.branches.push(...missing.map((b) => (ids.has(b.id) ? { ...b, id: `${b.id}-prev` } : b)));
        st.branchesAt = at;
        st.warnings.push(`지점 목록은 이번에 받지 못해 직전 목록(${missing.length}곳)을 보여 줍니다`);
      }
    } else if (st.ok || st.stale) {
      st.branchesAt = st.fetchedAt;
    }
  }

  // 시장 시세(KRX·환율·국제 시세 등)도 이번에 빠진 항목만 직전 값으로 채움
  if (fresh(previous.generatedAt, maxAgeMs)) {
    let filled = false;
    for (const [k, v] of Object.entries(previous.market ?? {})) {
      if (k !== 'spot' && out.market[k] == null && v != null) {
        out.market[k] = v;
        filled = true;
      }
    }
    if (filled) out.market.spot = computeSpot(out.market);
  }
  return out;
}

/** 직전에 배포한 data/prices.json을 받아 옵니다. 없거나 실패하면 null (첫 배포 등). */
export async function fetchPrevious(url, { timeoutMs = 15000 } = {}) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return null;
    const json = await res.json();
    return json && Array.isArray(json.sources) ? json : null;
  } catch {
    return null;
  }
}
