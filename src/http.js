const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class HttpError extends Error {}

/**
 * 타임아웃이 있는 fetch. 2xx가 아니면 예외를 던집니다.
 * 연결이 끊기는 등 네트워크 오류는 한 번 더 시도합니다 (HTTP 오류 응답은 재시도하지 않음).
 * @returns {Promise<string>}
 */
export async function fetchText(url, { method = 'GET', form, headers = {}, timeoutMs = 12000, retries = 1 } = {}) {
  const init = {
    method,
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'ko-KR,ko;q=0.9', ...headers },
  };
  if (form) {
    init.method = 'POST';
    init.body = new URLSearchParams(form).toString();
    init.headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new HttpError(`HTTP ${res.status} (${new URL(url).host})`);
      return await res.text();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt >= retries) {
        const host = new URL(url).host;
        const reason = err?.name === 'TimeoutError' ? '응답 시간 초과' : '연결 실패';
        throw new Error(`${reason} (${host})`, { cause: err });
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 형식이 아닌 응답 (${new URL(url).host})`);
  }
}

/** "1,234.56" → 1234.56, 숫자가 아니면 null */
export function toNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(value).match(/\d/) ? n : null;
}

/** 한국 시간 기준 날짜 (YYYY-MM-DD) */
export function kstDate(date = new Date(), offsetDays = 0) {
  const t = new Date(date.getTime() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return t.toISOString().slice(0, 10);
}
