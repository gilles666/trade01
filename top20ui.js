// ui.js — gestion interface (ES module)
import { loadDataset } from 'top20data.js';

// DOM
const tbody = document.getElementById('tbody');
const lastUpdate = document.getElementById('lastUpdate');
const nextIn = document.getElementById('nextIn');
const refreshBtn = document.getElementById('refreshBtn');
const bar = document.getElementById('bar');
const statusEl = document.getElementById('status');
const countersEl = document.getElementById('counters');
const windowSel = document.getElementById('windowSel');
const minVolSel = document.getElementById('minVolSel');

// Formatters
const fmtUSD = (v) =>
  isFinite(+v)
    ? new Intl.NumberFormat('fr-FR', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: +v >= 1 ? 2 : 6,
        minimumFractionDigits: +v >= 1 ? 2 : 4,
      }).format(+v)
    : '—';
const fmtCompact = (v) =>
  isFinite(+v)
    ? new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 2 }).format(+v)
    : '—';
const fmtPct = (v) => (isFinite(+v) ? (+v).toFixed(2) + ' %' : '—');
const toLocal = (t) => new Date(t).toLocaleString('fr-FR', { hour12: false });

// Progress & counters
function setProgress(pct, txt) {
  bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  statusEl.textContent = txt || '';
}
function setCounters({ products = 0, statsOK = 0, passed = 0, shown = 0, volMin = 0, hours = 24 } = {}) {
  countersEl.innerHTML = [
    ['Fenêtre %', hours + 'h'],
    ['Vol 24h min (USD)', new Intl.NumberFormat('fr-FR').format(volMin)],
    ['Produits USD/USDT', products],
    ['Stats ok', statsOK],
    ['Filtre OK (prix>1$, vol≥seuil, %>1%)', passed],
    ['Affichés', shown],
  ]
    .map(([k, v]) => `<span class="counter">${k}: <strong>${v}</strong></span>`)
    .join('');
}

// Compte à rebours
let timer = null,
  countdown = 0;
function startCountdown(sec = 300) {
  countdown = sec;
  updateCountdown();
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    countdown--;
    updateCountdown();
    if (countdown <= 0) {
      clearInterval(timer);
      load();
    }
  }, 1000);
}
function updateCountdown() {
  const m = Math.floor(countdown / 60);
  const s = String(countdown % 60).padStart(2, '0');
  nextIn.textContent = `Prochaine maj dans: ${m}:${s}`;
}

// Rendu du tableau
function render(rows, hours, minVol) {
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:18px;color:#9aa0b4">
      Aucune donnée (prix &gt; 1 $, vol24h ≥ ${new Intl.NumberFormat('fr-FR').format(minVol)} $, hausse &gt; 1% sur ${hours}h).
    </td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r, i) => {
      const p = r.product;
      const asset = `${p.base_currency}-${p.quote_currency}`;
      const mc = isFinite(r.marketCapUsd) ? fmtCompact(r.marketCapUsd) : '—';
      const vol = isFinite(r.volUsd) ? fmtCompact(r.volUsd) : '—';
      const pos = r.pct >= 0;
      return `
      <tr>
        <td>${i + 1}</td>
        <td>
          <div style="display:flex;gap:10px;align-items:center">
            <div style="width:8px;height:8px;border-radius:50%;background:var(--accent);opacity:.7"></div>
            <div>
              <div>${p.base_currency} <span class="sym">(${asset})</span></div>
              <div class="sym hide-sm" style="font-size:12px">
                <a href="https://exchange.coinbase.com/trade/${encodeURIComponent(asset)}" target="_blank" style="color:var(--accent)">Ouvrir sur Coinbase</a>
              </div>
            </div>
          </div>
        </td>
        <td class="hide-sm num">${fmtUSD(r.last)}</td>
        <td class="hide-sm num">${mc}</td>
        <td class="hide-sm num">${vol}</td>
        <td class="num ${pos ? 'pos' : 'neg'}">${fmtPct(r.pct)}</td>
        <td class="num"><strong>${r.conf ?? 0} %</strong></td>
      </tr>`;
    })
    .join('');
}

// Chargement principal
async function load() {
  const hours = +windowSel.value;
  const minVol = +minVolSel.value;

  refreshBtn.disabled = true;
  windowSel.disabled = true;
  minVolSel.disabled = true;

  try {
    const { rows, ts } = await loadDataset({
      windowHours: hours,
      minVolUsd: minVol,
      minPct: 1,
      onStage: (pct, txt) => setProgress(pct, txt),
      onCounters: (c) =>
        setCounters({ ...c, hours, volMin: minVol, shown: c.shown ?? 0 }),
    });

    setProgress(98, `Rendu (${rows.length})…`);
    render(rows, hours, minVol);

    lastUpdate.textContent = `Dernière maj: ${toLocal(ts)}`;
    setCounters({ hours, volMin: minVol, shown: rows.length });

    setProgress(100, 'Terminé ✅');
    startCountdown(300);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:18px;color:#ffb4b4">Erreur: ${err.message}. Nouvelle tentative dans 60s…</td></tr>`;
    setProgress(0, `Erreur: ${err.message}`);
    setCounters({});
    startCountdown(60);
  } finally {
    refreshBtn.disabled = false;
    windowSel.disabled = false;
    minVolSel.disabled = false;
  }
}

// Interactions
refreshBtn.addEventListener('click', load);
windowSel.addEventListener('change', load);
minVolSel.addEventListener('change', load);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && countdown < 5) load();
});

// Premier chargement
load();
