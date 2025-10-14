// ==== CONFIG ====
// CoinGecko base URL
const API_BASE = "https://api.coingecko.com/api/v3";

// ==== UTILITAIRES ====
function unixTimestamp(dateStr) {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

// Tri du tableau (simple)
function sortTable(table, key, asc = true) {
  const tbody = table.tBodies[0];
  const rows = Array.from(tbody.rows);
  rows.sort((a, b) => {
    const vA = a.dataset[key];
    const vB = b.dataset[key];
    if (vA < vB) return asc ? -1 : 1;
    if (vA > vB) return asc ? 1 : -1;
    return 0;
  });
  rows.forEach(r => tbody.appendChild(r));
}

// ==== API CALLS ====
async function fetchCoinsList() {
  const resp = await fetch(`${API_BASE}/coins/list`);
  return resp.json(); // [{id, symbol, name}, ...]
}

// Récupère prix + volume toutes les minutes (ou plus gros pas si la période > 90 jours)
async function fetchHistorical(id, from, to) {
  const url = `${API_BASE}/coins/${id}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Erreur ${resp.status} pour ${id}`);
  return resp.json(); // {prices: [[ts,price],...], total_volumes: [[ts,vol],...]}
}

// ==== LOGIQUE DE CALCUL ====
async function computeForAll(startTS, endTS) {
  const coins = await fetchCoinsList(); // ~7 000 actifs
  const results = [];

  // Limiter le nombre d’actifs affichés (ex: top 100 par market‑cap) pour rester dans les quotas
  const topCoins = await fetch(`${API_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1`).then(r=>r.json());

  for (const coin of topCoins) {
    try {
      const data = await fetchHistorical(coin.id, startTS, endTS);
      if (!data.prices.length) continue;

      // Prix au début = premier point, prix à la fin = dernier point
      const priceStart = data.prices[0][1];
      const priceEnd   = data.prices[data.prices.length-1][1];
      const pctChange  = ((priceEnd - priceStart) / priceStart) * 100;

      // Total volume = somme des volumes de chaque point (ou volume final)
      const totalVolume = data.total_volumes.reduce((s, v) => s + v[1], 0);

      results.push({
        name: coin.name,
        priceStart,
        priceEnd,
        pctChange,
        totalVolume
      });
    } catch (e) {
      console.warn(`Skip ${coin.id}: ${e.message}`);
    }
  }
  return results;
}

// ==== RENDER ====
function renderTable(data) {
  const tbody = document.querySelector("#resultTable tbody");
  tbody.innerHTML = ""; // reset

  data.forEach(row => {
    const tr = document.createElement("tr");
    tr.dataset.name = row.name;
    tr.dataset.priceStart = row.priceStart;
    tr.dataset.priceEnd = row.priceEnd;
    tr.dataset.pctChange = row.pctChange;
    tr.dataset.totalVolume = row.totalVolume;

    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.priceStart.toFixed(4)}</td>
      <td>${row.priceEnd.toFixed(4)}</td>
      <td>${row.pctChange.toFixed(2)} %</td>
      <td>${row.totalVolume.toLocaleString(undefined,{maximumFractionDigits:0})}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ==== EVENT LISTENERS ====
document.getElementById("run").addEventListener("click", async () => {
  const start = document.getElementById("start").value;
  const end   = document.getElementById("end").value;
  if (!start || !end) return alert("Veuillez saisir les deux dates/heure.");

  const startTS = unixTimestamp(start);
  const endTS   = unixTimestamp(end);
  if (endTS <= startTS) return alert("La date de fin doit être postérieure à la date de début.");

  // Afficher un loader simple
  document.getElementById("run").textContent = "Chargement…";
  try {
    const data = await computeForAll(startTS, endTS);
    renderTable(data);
  } catch (e) {
    console.error(e);
    alert("Erreur lors du chargement des données.");
  } finally {
    document.getElementById("run").textContent = "Rechercher";
  }
});

// ==== TRI DES COLONNES ====
document.querySelectorAll("#resultTable th").forEach(th => {
  let asc = true;
  th.addEventListener("click", () => {
    const key = th.dataset.key;
    sortTable(document.getElementById("resultTable"), key, asc);
    asc = !asc; // alterner direction
  });
});
