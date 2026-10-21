// 사용법: node scripts/build-static.js [출력 폴더]   (기본: dist)
// 환경 변수 PREVIOUS_DATA_URL에 직전 배포본의 data/prices.json 주소를 주면, 이번에 실패한 출처는 그 값을 이어 씁니다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPrevious } from '../src/carryover.js';
import { createCollector } from '../src/collect.js';
import { buildStatic } from '../src/static-build.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] ?? path.join(rootDir, 'dist'));

try {
  const previous = await fetchPrevious(process.env.PREVIOUS_DATA_URL);
  if (process.env.PREVIOUS_DATA_URL) console.log(previous ? '직전 배포 데이터를 받았습니다 (실패한 출처는 이어 씀)' : '직전 배포 데이터 없음');
  // 지점 목록처럼 천천히 갱신하는 출처는 직전 배포 값이 아직 유효하면 다시 받지 않습니다
  const result = await buildStatic({ rootDir, outDir, collect: createCollector(undefined, undefined, { previous }), previous });
  console.log(`정적 사이트 생성 완료: ${outDir}`);
  console.log(`구매처 가격 ${result.offers}건, 매장 시세 ${result.shops}곳, 매장 위치 ${result.branches}곳`);
  for (const s of result.sources) console.log(`  ${s.ok ? 'OK  ' : s.stale ? 'OLD ' : 'FAIL'} ${s.id}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
