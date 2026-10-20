#!/usr/bin/env node
// 시·군·구 중심 좌표표(shared/districts.js)를 만듭니다. 평소에는 실행할 필요가 없고, 행정구역이 바뀌면 다시 만듭니다.
//
// 원본: 통계청 2018 시·군·구 경계 (southkorea-maps 저장소에 공개된 GeoJSON)
//   node scripts/build-districts.js [GeoJSON 파일 경로]
// 경로를 주지 않으면 내려받습니다.
//
// 처리:
//  - "수원시장안구"처럼 일반구로 나뉜 시는 하나의 시로 합칩니다 (주소에서 시까지만 씁니다).
//  - 섬이 많은 곳은 가장 큰 땅덩이의 무게중심을 씁니다 (바다 한가운데 점이 찍히지 않도록).
//  - 2018년 이후 바뀐 이름·소속을 반영합니다 (인천 남구→미추홀구, 군위군 경북→대구, 2026 인천 개편).
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-geo.json';
const REGION_BY_CODE = {
  11: '서울', 21: '부산', 22: '대구', 23: '인천', 24: '광주', 25: '대전', 26: '울산', 29: '세종',
  31: '경기', 32: '강원', 33: '충북', 34: '충남', 35: '전북', 36: '전남', 37: '경북', 38: '경남', 39: '제주',
};

/** 고리(외곽선) 하나의 넓이와 무게중심 (경도·위도를 평면으로 보고 계산, 시·군·구 크기에서는 충분히 정확) */
function ringCentroid(ring) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j];
    const [x1, y1] = ring[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  a /= 2;
  if (!a) return null;
  return { area: Math.abs(a), lng: cx / (6 * a), lat: cy / (6 * a) };
}

function largestPart(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polys
    .map((p) => ringCentroid(p[0]))
    .filter(Boolean)
    .reduce((a, b) => (!a || b.area > a.area ? b : a), null);
}

export function buildDistricts(geojson) {
  const groups = new Map();
  for (const f of geojson.features) {
    const { name, code } = f.properties;
    let region = REGION_BY_CODE[String(code).slice(0, 2)];
    let district = name.replace(/^(.+?시)(.+구)$/, '$1'); // 수원시장안구 → 수원시
    if (region === '경북' && district === '군위군') region = '대구'; // 2023년 대구 편입
    const part = largestPart(f.geometry);
    if (!region || !part) continue;
    const k = `${region} ${district}`;
    groups.set(k, [...(groups.get(k) ?? []), { region, district, ...part }]);
  }

  const out = new Map();
  for (const parts of groups.values()) {
    const area = parts.reduce((s, p) => s + p.area, 0);
    const { region, district } = parts[0];
    out.set(`${region} ${district}`, {
      region,
      district,
      lat: parts.reduce((s, p) => s + p.lat * p.area, 0) / area,
      lng: parts.reduce((s, p) => s + p.lng * p.area, 0) / area,
    });
  }

  // 2018년 이후 바뀐 이름: 옛 이름도 남겨 두어 옛 주소도 알아봅니다
  const alias = (region, name, from, latlng) => {
    const base = from ? out.get(`${region} ${from}`) : null;
    if (base || latlng) out.set(`${region} ${name}`, { region, district: name, ...(latlng ?? { lat: base.lat, lng: base.lng }) });
  };
  alias('인천', '미추홀구', '남구');
  // 2026년 7월 인천 개편: 중구·동구 → 제물포구(내륙)·영종구(영종도), 서구 북부 → 검단구
  const incheonJung = out.get('인천 중구'); // 가장 큰 땅덩이 = 영종도
  alias('인천', '영종구', '중구');
  alias('인천', '제물포구', '동구');
  if (incheonJung) alias('인천', '중구', '동구'); // 옛 주소의 "중구"는 대부분 원도심(신포동 일대)이라 동구 쪽으로 봅니다
  alias('인천', '검단구', null, { lat: 37.5985, lng: 126.6629 }); // 검단신도시 일대

  return [...out.values()].sort((a, b) => a.region.localeCompare(b.region, 'ko') || a.district.localeCompare(b.district, 'ko'));
}

async function main() {
  const file = process.argv[2];
  const text = file ? await readFile(file, 'utf8') : await (await fetch(SOURCE_URL)).text();
  const list = buildDistricts(JSON.parse(text));
  const lines = list.map((d) => `  ['${d.region}', '${d.district}', ${d.lat.toFixed(4)}, ${d.lng.toFixed(4)}],`);
  const body = `// 시·군·구 중심 좌표 [시·도, 시·군·구, 위도, 경도]. scripts/build-districts.js로 만든 파일이라 직접 고치지 마세요.
// 원본: 통계청 2018 시·군·구 경계 (일반구는 시로 합침, 이후 행정구역 변경 반영)
export const DISTRICTS = [
${lines.join('\n')}
];
`;
  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'districts.js');
  await writeFile(outPath, body);
  console.log(`${list.length}개 시·군·구 → ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
