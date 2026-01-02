// Tap to Empire - MVP Idle Clicker (offline earnings + upgrades + prestige)
// No external libraries. Saves to localStorage.

const SAVE_KEY = "tte_save_v1";

const fmt = (n) => {
  if (!isFinite(n)) return "∞";
  const abs = Math.abs(n);
  if (abs < 1000) return n.toFixed(0);
  const units = ["K","M","B","T","Qa","Qi","Sx","Sp","Oc","No","Dc"];
  let u = -1;
  let val = abs;
  while (val >= 1000 && u < units.length - 1) { val /= 1000; u++; }
  const sign = n < 0 ? "-" : "";
  return `${sign}${val.toFixed(val >= 100 ? 0 : val >= 10 ? 1 : 2)}${units[u]}`;
};

const nowMs = () => Date.now();

const defaultState = () => ({
  coins: 0,
  perTapBase: 1,
  critChance: 0.05,      // 5%
  critMult: 5,           // crit = x5
  combo: 1.0,
  comboDecayMs: 900,     // if no tap for this long, combo decays
  lastTapMs: 0,

  producers: [
    // name, baseCost, cpsBase
    { id:"intern",   name:"Intern",   baseCost: 25,    cpsBase: 0.5,  qty:0 },
    { id:"worker",   name:"Worker",   baseCost: 120,   cpsBase: 2.5,  qty:0 },
    { id:"factory",  name:"Factory",  baseCost: 900,   cpsBase: 20,   qty:0 },
    { id:"plant",    name:"Mega Plant",baseCost: 6500, cpsBase: 120,  qty:0 },
    { id:"ai",       name:"AI Core",  baseCost: 45000, cpsBase: 900,  qty:0 },
  ],

  tapUpgrades: [
    // Each upgrade boosts per tap additively or multiplicatively
    { id:"tp1", name:"Stronger Fingers", desc:"+1 per tap", baseCost: 50,  level:0, type:"add", value:1 },
    { id:"tp2", name:"Tap Technique",    desc:"+5 per tap", baseCost: 300, level:0, type:"add", value:5 },
    { id:"tp3", name:"Power Gloves",     desc:"x1.20 tap power", baseCost: 1200, level:0, type:"mul", value:1.20 },
    { id:"tp4", name:"Overclock",        desc:"x1.35 tap power", baseCost: 9000, level:0, type:"mul", value:1.35 },
    { id:"tp5", name:"Crit Training",    desc:"+1% crit chance", baseCost: 4000, level:0, type:"crit", value:0.01 },
  ],

  prestigePoints: 0,
  boostUntilMs: 0,

  lastSavedMs: nowMs(),
});

let state = load() ?? defaultState();

// ---------- Pricing ----------
function upgradeCost(baseCost, level) {
  // Smooth exponential cost curve
  return Math.floor(baseCost * Math.pow(1.65, level));
}

function producerCost(p) {
  // Typical idle scaling
  return Math.floor(p.baseCost * Math.pow(1.15, p.qty));
}

// ---------- Derived Stats ----------
function prestigeMultiplier() {
  // Simple but satisfying: +10% per prestige point (tune later)
  return 1 + state.prestigePoints * 0.10;
}

function boostMultiplier() {
  return nowMs() < state.boostUntilMs ? 2 : 1;
}

function perTap() {
  let add = state.perTapBase;
  let mul = 1;

  for (const u of state.tapUpgrades) {
    if (u.type === "add") add += u.level * u.value;
    if (u.type === "mul") mul *= Math.pow(u.value, u.level);
  }

  return add * mul * prestigeMultiplier() * boostMultiplier() * state.combo;
}

function perSecond() {
  let cps = 0;
  for (const p of state.producers) {
    cps += p.qty * p.cpsBase;
  }
  // Producers also benefit from prestige and boost, but NOT combo
  return cps * prestigeMultiplier() * boostMultiplier();
}

// ---------- Offline earnings ----------
function applyOfflineEarnings() {
  const last = state.lastSavedMs ?? nowMs();
  const dtSec = Math.max(0, (nowMs() - last) / 1000);

  // Cap offline time so it doesn't explode (12 hours cap for MVP)
  const cappedSec = Math.min(dtSec, 12 * 3600);
  const earned = perSecond() * cappedSec;

  if (earned > 1) {
    state.coins += earned;
    const notice = document.getElementById("offlineNotice");
    notice.hidden = false;
    notice.textContent = `Offline earnings: +${fmt(earned)} coins (${Math.floor(cappedSec)}s)`;
  }
}

// ---------- Save/Load ----------
function save() {
  state.lastSavedMs = nowMs();
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);

    // Basic validation + merge to handle updates safely
    const base = defaultState();
    const merged = { ...base, ...s };

    // merge arrays by id
    merged.producers = base.producers.map(bp => {
      const found = (s.producers ?? []).find(x => x.id === bp.id);
      return { ...bp, ...(found ?? {}) };
    });
    merged.tapUpgrades = base.tapUpgrades.map(bu => {
      const found = (s.tapUpgrades ?? []).find(x => x.id === bu.id);
      return { ...bu, ...(found ?? {}) };
    });

    return merged;
  } catch {
    return null;
  }
}

function hardReset() {
  if (!confirm("Hard reset? This wipes your save.")) return;
  state = defaultState();
  save();
  renderAll();
}

// ---------- Tapping + combo ----------
function updateComboOnTap() {
  const t = nowMs();
  const since = t - (state.lastTapMs || 0);
  state.lastTapMs = t;

  // If you tap quickly, combo rises; if slow, combo drops
  if (since < 220) state.combo = Math.min(3.0, state.combo + 0.03);
  else if (since < 450) state.combo = Math.min(2.2, state.combo + 0.015);
  else state.combo = Math.max(1.0, state.combo - 0.05);
}

function decayCombo() {
  const t = nowMs();
  const since = t - (state.lastTapMs || 0);
  if (since > state.comboDecayMs) {
    state.combo = Math.max(1.0, state.combo - 0.02);
  }
}

function tap() {
  updateComboOnTap();

  const baseGain = perTap() / state.combo; // remove combo to apply properly below
  let gain = baseGain * state.combo;

  // crit
  const crit = Math.random() < state.critChance;
  if (crit) gain *= state.critMult;

  state.coins += gain;

  // quick UI ping
  const btn = document.getElementById("tapButton");
  btn.animate(
    [{ transform: "scale(1)" }, { transform: "scale(0.99)" }, { transform: "scale(1)" }],
    { duration: 120 }
  );

  renderTop();
}

// ---------- Purchases ----------
function buyTapUpgrade(id) {
  const u = state.tapUpgrades.find(x => x.id === id);
  if (!u) return;
  const cost = upgradeCost(u.baseCost, u.level);
  if (state.coins < cost) return;

  state.coins -= cost;
  u.level += 1;

  if (u.type === "crit") {
    // cap crit chance to 30% for sanity in MVP
    state.critChance = Math.min(0.30, state.critChance + u.value);
  }

  renderAll();
}

function buyProducer(id) {
  const p = state.producers.find(x => x.id === id);
  if (!p) return;
  const cost = producerCost(p);
  if (state.coins < cost) return;

  state.coins -= cost;
  p.qty += 1;
  renderAll();
}

function calcPrestigeGain() {
  // Simple prestige formula: based on lifetime power proxy = sqrt(total coins + value of stuff)
  // We'll approximate using current coins + producer value.
  let total = state.coins;
  for (const p of state.producers) {
    // rough valuation: qty * baseCost * 1.2
    total += p.qty * p.baseCost * 1.2;
  }
  // scale: 1 prestige around ~50k total
  const gain = Math.floor(Math.sqrt(total / 50000));
  return Math.max(0, gain);
}

function doPrestige() {
  const gain = calcPrestigeGain();
  if (gain <= 0) {
    alert("Not enough progress to prestige yet.");
    return;
  }
  if (!confirm(`Prestige now for +${gain} Prestige Points? This resets coins and upgrades.`)) return;

  const pp = state.prestigePoints + gain;
  state = defaultState();
  state.prestigePoints = pp;

  save();
  renderAll();
}

// ---------- Boost ----------
function activateBoost() {
  // 5 minutes x2 income
  state.boostUntilMs = Math.max(state.boostUntilMs, nowMs()) + 5 * 60 * 1000;
  renderAll();
}

// ---------- Rendering ----------
function renderTop() {
  document.getElementById("coins").textContent = fmt(state.coins);
  document.getElementById("perTap").textContent = fmt(perTap());
  document.getElementById("perSec").textContent = fmt(perSecond());
  document.getElementById("tapGain").textContent = fmt(perTap());
  document.getElementById("combo").textContent = `x${state.combo.toFixed(2)}`;
  document.getElementById("crit").textContent = `${Math.round(state.critChance * 100)}%`;
}

function renderUpgrades() {
  const root = document.getElementById("tapUpgrades");
  root.innerHTML = "";

  for (const u of state.tapUpgrades) {
    const cost = upgradeCost(u.baseCost, u.level);
    const can = state.coins >= cost;

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="itemName">${u.name} <span class="muted">(Lv ${u.level})</span></div>
        <div class="itemDesc">${u.desc}</div>
        <div class="itemMeta">Cost: <b>${fmt(cost)}</b></div>
      </div>
      <div class="btncol">
        <button class="${can ? "primary" : "ghost"}" ${can ? "" : "disabled"}>Buy</button>
      </div>
    `;
    el.querySelector("button").addEventListener("click", () => buyTapUpgrade(u.id));
    root.appendChild(el);
  }
}

function renderProducers() {
  const root = document.getElementById("producers");
  root.innerHTML = "";

  for (const p of state.producers) {
    const cost = producerCost(p);
    const can = state.coins >= cost;

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="itemName">${p.name} <span class="muted">(x${p.qty})</span></div>
        <div class="itemDesc">Produces <b>${fmt(p.cpsBase)}</b>/sec each</div>
        <div class="itemMeta">Cost: <b>${fmt(cost)}</b> • Total: <b>${fmt(p.qty * p.cpsBase)}</b>/sec</div>
      </div>
      <div class="btncol">
        <button class="${can ? "primary" : "ghost"}" ${can ? "" : "disabled"}>Hire</button>
      </div>
    `;
    el.querySelector("button").addEventListener("click", () => buyProducer(p.id));
    root.appendChild(el);
  }
}

function renderPrestige() {
  document.getElementById("prestigePoints").textContent = fmt(state.prestigePoints);
  document.getElementById("prestigeGain").textContent = fmt(calcPrestigeGain());
  document.getElementById("prestigeBoost").textContent = `x${prestigeMultiplier().toFixed(2)}`;
}

function renderAll() {
  renderTop();
  renderUpgrades();
  renderProducers();
  renderPrestige();
}

function setupTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tabpane").forEach(p => p.classList.remove("active"));

      btn.classList.add("active");
      const name = btn.dataset.tab;
      document.getElementById(`tab-${name}`).classList.add("active");
    });
  });
}

// ---------- Game loop ----------
function tick() {
  // passive income
  const gain = perSecond() / 20; // 20 ticks per sec
  state.coins += gain;

  decayCombo();
  renderTop();
}

function boot() {
  setupTabs();

  document.getElementById("tapButton").addEventListener("click", tap);
  document.getElementById("btnSave").addEventListener("click", () => { save(); alert("Saved."); });
  document.getElementById("btnReset").addEventListener("click", hardReset);
  document.getElementById("btnPrestige").addEventListener("click", doPrestige);
  document.getElementById("btnBoost").addEventListener("click", activateBoost);

  applyOfflineEarnings();
  renderAll();

  // autosave every 10s
  setInterval(save, 10000);
  // main tick 20 fps
  setInterval(tick, 50);

  // save on tab close
  window.addEventListener("beforeunload", save);
}

boot();
