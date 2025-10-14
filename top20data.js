// data.js — logique de données (ES module)

// ⚙️ Config API (ton Worker CORS)
const EX = 'https://spring-mud-37a1.gilles-e74.workers.dev/coinbase';
const COINCAP = 'https://api.coincap.io/v2/assets?limit=2000';

// Utilitaires
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchJSON(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url}`);
  return res.json();
}

// Pool de requêtes avec concurrence bornée
async function mapPool(items, worker, concurrency = 8, onProgress) {
  const results = new Array(items.length);
  let i = 0, done = 0;
  const runners = new Array(concurrency).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch {
        results[idx] = null;
      }
      done++;
      onProgress && onProgress(done, items.length);
      await sleep(60);
    }
  });
  await Promise.all(runners);
  return results;
}

// Heuristique de confiance (0..100)
function confidencePct({ mom60, volX, trendGreen, proxHigh }) {
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const score =
    0.35 * clamp(mom60) +
    0.30 * clamp(volX) +
    0.20 * clamp(trendGreen) +
    0.15 * clamp(proxHigh);
  return Math.round(score * 100);
}

// Market caps via CoinCap (symbol -> marketCapUsd)
async function buildMarketCapMap(onStage) {
  try {
    onStage?.(4, 'Market caps (CoinCap)…');
    const data = await fetchJSON(COINCAP);
    const map = {};
    for (const a of data.data || []) {
      const sym = (a.symbol || '').toUpperCase();
      const mc = +a.marketCapUsd;
      if (sym && isFinite(mc)) map[sym] = Math.max(map[sym] || 0, mc);
    }
    return map;
  } catch {
    return {};
  }
}

// % variation sur N heures via bougies 5m
async function percentChangeFromCandles(productId, hours) {
  const now = Date.now();
  const end = new Date(now).toISOString();
  const start = new Date(now - (hours * 60 + 5) * 60 * 1000).toISOString();
  const candles = await fetchJSON(
    `${EX}/products/${encodeURIComponent(productId)}/candles?granularity=300&start=${start}&end=${end}`
  );
  const cs = (candles || []).sort((a, b) => a[0] - b[0]); // [t, low, high, open, close, volume]
  if (cs.length < 2) return NaN;
  const firstClose = +cs[0][4];
  const lastClose = +cs[cs.length - 1][4];
  if (!isFinite(firstClose) || firstClose <= 0 || !isFinite(lastClose)) return NaN;
  return ((lastClose - firstClose) / firstClose) * 100;
}

/**
 * Charge et calcule les résultats selon options :
 * @param {Object} opts
 * @param {number} opts.windowHours - 24|12|6|3|1
 * @param {number} opts.minVolUsd   - seuil volume 24h en USD (1000, 10000, 100000, 1000000)
 * @param {number} opts.minPct      - pourcentage minimal (> 1)
 * @param {function(pct:number, txt:string)} opts.onStage - callback progression
 * @param {function(countersObj)} opts.onCounters - callback compteurs
 * @returns {Promise<{rows:any[], ts:number}>}
 */
export async function loadDataset(opts) {
  const {
    windowHours = 24,
    minVolUsd = 1_000_000,
    minPct = 1,
    onStage,
    onCounters,
  } = opts || {};

  onStage?.(0, `Préparation (fenêtre ${windowHours}h, vol≥${minVolUsd})…`);
  onCounters?.({ volMin: minVolUsd, hours: windowHours });

  // Market caps (en parallèle)
  const mcMapPromise = buildMarketCapMap(onStage);

  // 1) Produits
  onStage?.(8, 'Produits Coinbase…');
  const products = await fetchJSON(`${EX}/products`);
  const spot = products.filter(
    (p) =>
      (p.status === 'online' || p.status === 'online_trading') &&
      (p.quote_currency === 'USD' || p.quote_currency === 'USDT') &&
      !p.trading_disabled &&
      !p.cancel_only &&
      !p.post_only
  );

  // 2) Stats 24h pour prix & volUSD
  let statsOK = 0;
  onStage?.(18, `Stats 24h (prix & vol)… 0/${spot.length}`);
  const statsList = await mapPool(
    spot,
    async (p) => {
      const s = await fetchJSON(`${EX}/products/${encodeURIComponent(p.id)}/stats`);
      const open = +s.open,
        last = +s.last,
        high = +s.high,
        low = +s.low,
        volBase = +s.volume;
      const pct24 =
        isFinite(open) && open > 0 && isFinite(last) ? ((last - open) / open) * 100 : NaN;
      const volUsd = isFinite(volBase) && isFinite(last) ? volBase * last : NaN;
      if (isFinite(last)) statsOK++;
      return { product: p, pct24, last, high, low, volBase, volUsd };
    },
    8,
    (done, total) => {
      const pct = 18 + Math.round((34 * done) / total);
      onStage?.(pct, `Stats 24h (prix & vol)… ${done}/${total}`);
    }
  );
  onCounters?.({ products: spot.length, statsOK });

  const baseStats = statsList.filter(Boolean);

  // 3) Filtre prix >1$ & vol24h ≥ seuil
  onStage?.(54, `Filtre prix>1$ & vol24h≥${minVolUsd}…`);
  let preFiltered = baseStats.filter(
    (x) => isFinite(x.last) && x.last > 1 && isFinite(x.volUsd) && x.volUsd >= minVolUsd
  );

  // 4) Calcul du % sur la fenêtre
  let withPct = [];
  if (windowHours === 24) {
    withPct = preFiltered.map((x) => ({ ...x, pct: x.pct24 }));
  } else {
    onStage?.(60, `Calcul % ${windowHours}h via bougies… 0/${preFiltered.length}`);
    const pctList = await mapPool(
      preFiltered,
      async (x) => {
        const pct = await percentChangeFromCandles(x.product.id, windowHours);
        return { ...x, pct };
      },
      8,
      (done, total) => {
        const pct = 60 + Math.round((20 * done) / total);
        onStage?.(pct, `Calcul % ${windowHours}h via bougies… ${done}/${total}`);
      }
    );
    withPct = pctList.filter(Boolean);
  }

  // 5) Filtre % > minPct
  const passed = withPct.filter((x) => isFinite(x.pct) && x.pct > minPct);
  onCounters?.({ products: spot.length, statsOK, passed: passed.length });

  // 6) Confiance (bougies 1h) + volX vs moyenne 30j (si dispo)
  onStage?.(80, `Confiance (bougies 1h)… 0/${passed.length}`);
  const volSummaryPromise = fetchJSON(`${EX}/products/volume-summary`).catch(() => null);

  const enriched = await mapPool(
    passed,
    async (item) => {
      const pid = item.product.id;
      let mom60 = 0,
        volX = 0,
        trendGreen = 0,
        proxHigh = 0;

      try {
        const now = Date.now();
        const end = new Date(now).toISOString();
        const start = new Date(now - 65 * 60 * 1000).toISOString();
        const candles = await fetchJSON(
          `${EX}/products/${encodeURIComponent(pid)}/candles?granularity=300&start=${start}&end=${end}`
        );
        const cs = (candles || []).sort((a, b) => a[0] - b[0]);
        if (cs.length >= 2) {
          const first = cs[0],
            lastC = cs[cs.length - 1];
          const p0 = +first[3],
            p1 = +lastC[4];
          mom60 = isFinite(p0) && p0 > 0 && isFinite(p1) ? Math.max(-1, Math.min(1, ((p1 - p0) / p0) * 5)) : 0;
          const greens = cs.filter((c) => +c[4] > +c[3]).length;
          trendGreen = greens / cs.length;
        }
      } catch {}

      try {
        const volSum = await volSummaryPromise;
        const vm = Array.isArray(volSum) ? volSum.find((r) => r.product_id === pid) : null;
        if (vm && +vm.volume_30day > 0) {
          const v24 = +vm.volume_24h || 0;
          const v30 = +vm.volume_30day || 0;
          const avgDaily = v30 / 30;
          volX = Math.min(1, (v24 / avgDaily) / 3);
        }
      } catch {}

      if (isFinite(item.high) && isFinite(item.low) && item.high > item.low && isFinite(item.last)) {
        const rng = item.high - item.low;
        proxHigh = Math.max(0, Math.min(1, (item.last - item.low) / rng));
      }

      const conf = confidencePct({ mom60, volX, trendGreen, proxHigh });
      return { ...item, conf };
    },
    8,
    (done, total) => {
      const pct = 80 + Math.round((14 * done) / total);
      onStage?.(pct, `Confiance (bougies 1h)… ${done}/${total}`);
    }
  );

  // 7) Market caps & rendu final (Top 30 trié par pct desc)
  onStage?.(94, 'Market caps…');
  const mcMap = await mcMapPromise;
  const rows = enriched
    .map((x) => ({
      ...x,
      marketCapUsd: mcMap[(x.product.base_currency || '').toUpperCase()] || NaN,
    }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 30);

  onStage?.(98, `Rendu (${rows.length})…`);
  return { rows, ts: Date.now() };
}
