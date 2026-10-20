import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createCollector } from './src/collect.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const FORCE_REFRESH_MIN_INTERVAL_MS = 15 * 1000;

const collect = createCollector();
let lastForcedAt = 0;

const app = express();
app.disable('x-powered-by');

app.get('/api/prices', async (req, res) => {
  // ?refresh=1 은 캐시를 무시하고 다시 가져오되, 출처 사이트에 부담을 주지 않도록 15초에 한 번만 허용
  let force = false;
  if (req.query.refresh === '1' && Date.now() - lastForcedAt > FORCE_REFRESH_MIN_INTERVAL_MS) {
    force = true;
    lastForcedAt = Date.now();
  }
  try {
    const data = await collect({ force });
    res.set('cache-control', 'no-store').json(data);
  } catch (err) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

app.use('/shared', express.static(path.join(root, 'shared')));
app.use(express.static(path.join(root, 'public')));

app.listen(PORT, () => {
  console.log(`금·은 실물 최저가 비교: http://localhost:${PORT}`);
});
