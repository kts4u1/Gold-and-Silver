// 사용법: node scripts/build-static.js [출력 폴더]   (기본: dist)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCollector } from '../src/collect.js';
import { buildStatic } from '../src/static-build.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(rootDir, 'dist'));

try {
  const result = await buildStatic({ rootDir, outDir, collect: createCollector() });
  console.log(`정적 사이트 생성 완료: ${outDir}`);
  console.log(`구매처 가격 ${result.offers}건, 매장 시세 ${result.shops}곳`);
  for (const s of result.sources) console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.id}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
