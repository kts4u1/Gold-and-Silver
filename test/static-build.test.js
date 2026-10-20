import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildStatic } from '../src/static-build.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
const PREFIX = 'gs-static-';
// 테스트용 임시 폴더를 만들고 그 안의 dist 경로를 돌려줍니다
const tmp = async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), PREFIX));
  tmpDirs.push(base);
  return path.join(base, 'dist');
};
afterEach(async () => {
  for (const base of tmpDirs.splice(0)) {
    // 안전장치: 우리가 만든 임시 폴더만 지웁니다
    if (!path.basename(base).startsWith(PREFIX)) throw new Error(`예상 밖 경로는 지우지 않습니다: ${base}`);
    await fs.rm(base, { recursive: true, force: true });
  }
});

const sample = {
  generatedAt: '2026-10-20T03:00:00.000Z',
  market: {},
  offers: [{ id: 'a' }, { id: 'b' }],
  shops: [{ id: 's' }],
  sources: [
    { id: 'x', ok: true },
    { id: 'y', ok: false, error: '실패' },
  ],
};

describe('정적 사이트 만들기', () => {
  it('화면 파일과 시세 데이터를 함께 만듭니다', async () => {
    const outDir = await tmp();
    let forced;
    const result = await buildStatic({
      rootDir,
      outDir,
      collect: async (opts) => ((forced = opts.force), sample),
    });
    assert.equal(forced, true); // 캐시 없이 새로 가져옴
    assert.deepEqual(result, { offers: 2, shops: 1, sources: [{ id: 'x', ok: true }, { id: 'y', ok: false }] });

    const data = JSON.parse(await fs.readFile(path.join(outDir, 'data/prices.json'), 'utf8'));
    assert.equal(data.generatedAt, sample.generatedAt);
    for (const f of ['index.html', 'app.js', 'chart.js', 'style.css', 'manifest.webmanifest', 'icon.svg', 'shared/compare.js', '.nojekyll']) {
      await fs.access(path.join(outDir, f));
    }
  });

  it('정적 모드 표시를 넣고, 하위 경로(/저장소이름/)에서도 열리도록 절대 경로를 쓰지 않습니다', async () => {
    const outDir = await tmp();
    await buildStatic({ rootDir, outDir, collect: async () => sample });
    const html = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    assert.match(html, /<meta name="data-mode" content="static" \/>/);
    assert.doesNotMatch(html, /(?:href|src)="\//);
    const app = await fs.readFile(path.join(outDir, 'app.js'), 'utf8');
    assert.doesNotMatch(app, /from '\//);
    const manifest = JSON.parse(await fs.readFile(path.join(outDir, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.icons[0].src, 'icon.svg');
  });

  it('가격이 하나도 없으면 사이트를 만들지 않고 이유를 알려 줍니다', async () => {
    const outDir = await tmp();
    await assert.rejects(
      buildStatic({ rootDir, outDir, collect: async () => ({ ...sample, offers: [] }) }),
      /수집된 가격이 없어.*y: 실패/,
    );
    await assert.rejects(fs.access(outDir)); // 빈 결과물을 남기지 않음
  });
});
