// 서버 없이 열 수 있는 정적 사이트(GitHub Pages용)를 만듭니다.
// 시세를 한 번 모아서 data/prices.json으로 저장하고, 화면 파일을 함께 복사합니다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { carryOver } from './carryover.js';

const STATIC_META = '<meta name="data-mode" content="static" />';

/**
 * @param {{ rootDir: string, outDir: string, collect: () => Promise<any>, previous?: object|null, now?: number }} opts
 *   previous: 직전에 배포한 data/prices.json. 이번에 실패한 출처는 이 값을 이어 씁니다.
 * @returns {Promise<{ offers: number, shops: number, branches: number, sources: {id: string, ok: boolean, stale: boolean}[] }>}
 */
export async function buildStatic({ rootDir, outDir, collect, previous = null, now = Date.now() }) {
  const data = carryOver(await collect({ force: true }), previous, { now });

  // 비교할 가격이 하나도 없으면 빈 사이트로 덮어쓰지 않도록 실패 처리합니다
  if (!data.offers?.length) {
    const reasons = (data.sources ?? []).filter((s) => !s.ok).map((s) => `${s.id}: ${s.error}`);
    throw new Error(`수집된 가격이 없어 배포하지 않습니다. ${reasons.join(' | ')}`);
  }

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, 'data'), { recursive: true });
  await fs.cp(path.join(rootDir, 'public'), outDir, { recursive: true });
  await fs.cp(path.join(rootDir, 'shared'), path.join(outDir, 'shared'), { recursive: true });

  const indexPath = path.join(outDir, 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  if (!html.includes('<head>')) throw new Error('index.html에서 <head>를 찾지 못했습니다');
  await fs.writeFile(indexPath, html.replace('<head>', `<head>\n    ${STATIC_META}`));

  await fs.writeFile(path.join(outDir, 'data', 'prices.json'), JSON.stringify(data));
  await fs.writeFile(path.join(outDir, '.nojekyll'), ''); // GitHub Pages가 파일을 가공하지 않도록

  return {
    offers: data.offers.length,
    shops: data.shops?.length ?? 0,
    branches: data.branches?.length ?? 0,
    sources: data.sources.map((s) => ({ id: s.id, ok: s.ok, stale: Boolean(s.stale) })),
  };
}
