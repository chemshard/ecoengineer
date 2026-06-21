const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const TICK_MS = Number(process.env.TICK_MS || 90);
const SNAPSHOT_MS = Number(process.env.SNAPSHOT_MS || 140);
const SAVE_WORLD = process.env.SAVE_WORLD === "1";
const WORLD_SAVE_PATH = process.env.WORLD_SAVE_PATH || path.join(__dirname, "world_snapshot.json");

const WORLD_W = 1100;
const WORLD_H = 560;
const INITIAL_PLANTS = 1500;
const PLANT_K = 2300;
const PLANT_R = 0.05;
const MAX_PLANTS_SENT = 1300;
const MAX_ANIMALS = 2200;
const MAX_PLANTS = 2600;
const MAX_SPECIES = 80;

const RESET_EVERY_DAYS = Number(process.env.RESET_EVERY_DAYS || 1000000);
const PLANT_SNAPSHOT_EVERY = Number(process.env.PLANT_SNAPSHOT_EVERY || 8);

let day = 0;
let plants = [];
let obstacles = [];
let animals = [];
let species = [];
let lastCounts = new Map();
let byDiet = { herbivore: [], omnivore: [], carnivore: [] };
let animalsById = new Map();
let lastSnapshotAt = 0;
let snapshotSeq = 0;

function rand(min, max) { return Math.random() * (max - min) + min; }
function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
function makeId() { return crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2); }
function dist2(a, b) { const dx = a.x - b.x; const dy = a.y - b.y; return dx * dx + dy * dy; }

function stableRank(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function makePlant(x = rand(18, WORLD_W - 18), y = rand(18, WORLD_H - 18)) {
  const id = makeId();
  return { id, x, y, energy: rand(0.35, 0.95), rank: stableRank(id) };
}

function makeAnimal(s, x = rand(30, WORLD_W - 30), y = rand(30, WORLD_H - 30)) {
  const id = makeId();
  const energy = s.diet === "carnivore" ? rand(2.2, 3.4) : rand(0.75, 1.25);
  return {
    id,
    sid: s.id,
    x,
    y,
    vx: rand(-0.5, 0.5),
    vy: rand(-0.5, 0.5),
    energy,
    age: 0,
    cooldown: rand(30, 120),
    rank: stableRank(id),
    targetId: null
  };
}

function getSpecies(sid) { return species.find(s => s.id === sid); }

function countsBySpecies() {
  const m = new Map();
  for (const a of animals) m.set(a.sid, (m.get(a.sid) || 0) + 1);
  return m;
}

function generateObstacles() {
  obstacles = [];
  const count = Math.round(rand(6, 10));
  for (let i = 0; i < count; i++) {
    obstacles.push({ x: rand(60, WORLD_W - 60), y: rand(60, WORLD_H - 60), r: rand(20, 40) });
  }
}

function coverAt(x, y) {
  let best = null;
  let bestSlack = -Infinity;
  for (const o of obstacles) {
    const haloR = o.r + 14;
    const dx = x - o.x, dy = y - o.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const slack = haloR - d;
    if (slack > 0 && slack > bestSlack) { bestSlack = slack; best = o; }
  }
  return best;
}

function rebuildDietGroups() {
  byDiet = { herbivore: [], omnivore: [], carnivore: [] };
  animalsById = new Map();
  for (const a of animals) {
    animalsById.set(a.id, a);
    const s = getSpecies(a.sid);
    if (s && byDiet[s.diet]) byDiet[s.diet].push(a);
  }
}

function sampleNearest(a, pool, maxSamples, r2, applyCover = false) {
  if (!pool.length) return { nearest: null, inRange: 0, sampledFraction: 1, bestD: Infinity };
  let best = null;
  let bestD = Infinity;
  let inRange = 0;
  const tries = Math.min(maxSamples, pool.length);

  for (let i = 0; i < tries; i++) {
    const p = pool.length <= maxSamples ? pool[i] : pool[Math.floor(Math.random() * pool.length)];
    if (!p || p.id === a.id) continue;
    if (applyCover && coverAt(p.x, p.y) && Math.random() < 0.38) continue;
    const d = dist2(a, p);
    if (d < bestD) { bestD = d; best = p; }
    if (r2 !== undefined && d <= r2) inRange++;
  }

  return { nearest: best, inRange, sampledFraction: pool.length <= maxSamples ? 1 : tries / pool.length, bestD };
}

function isPredatorOf(predSpecies, preySpecies) {
  if (predSpecies.diet === "carnivore") return preySpecies.diet !== "carnivore";
  if (predSpecies.diet === "omnivore") return preySpecies.diet === "herbivore" && preySpecies.size <= predSpecies.size + 2;
  return false;
}

function scanPrey(a, s, maxSamples = 260) {
  let pool = [];
  if (s.diet === "carnivore") pool = byDiet.herbivore.concat(byDiet.omnivore);
  else if (s.diet === "omnivore") {
    pool = byDiet.herbivore.filter(os => {
      const os2 = getSpecies(os.sid);
      return os2 && os2.size <= s.size + 2;
    });
  }

  if (!pool.length) return { nearest: null, density: 0 };
  const detectRadius = s.diet === "carnivore" ? (140 + s.speed * 10) : (75 + s.speed * 6);
  const { nearest, inRange, sampledFraction } = sampleNearest(a, pool, maxSamples, detectRadius * detectRadius, true);
  const density = sampledFraction < 1 ? inRange / sampledFraction : inRange;
  return { nearest, density };
}

function scanThreat(a, s, maxSamples = 90) {
  let pool = byDiet.carnivore;
  if (s.diet === "herbivore") pool = pool.concat(byDiet.omnivore);
  if (!pool.length) return null;
  const fleeRadius = 95 + s.size * 4;
  const { nearest, bestD } = sampleNearest(a, pool, maxSamples, fleeRadius * fleeRadius);
  return bestD <= fleeRadius * fleeRadius ? nearest : null;
}

function findNearestPlant(a, maxSamples = 220) {
  if (!plants.length) return null;
  let best = null;
  let bestD = Infinity;
  const tries = Math.min(maxSamples, plants.length);
  for (let i = 0; i < tries; i++) {
    const p = plants.length <= maxSamples ? plants[i] : plants[Math.floor(Math.random() * plants.length)];
    const d = dist2(a, p);
    if (d < bestD) { best = p; bestD = d; }
  }
  return best;
}

function moveToward(a, target, strength) {
  if (!target) return false;
  const dx = target.x - a.x;
  const dy = target.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  a.vx += (dx / d) * strength;
  a.vy += (dy / d) * strength;
  return true;
}

function animalMaintenance(s) {
  const massTerm = Math.pow(s.size, 0.75);
  const basal = { herbivore: 0.0017, omnivore: 0.0027, carnivore: 0.0031 }[s.diet] || 0.0025;
  const activity = (s.speed * 0.00025 + s.attack * 0.0003) * Math.sqrt(s.size);
  return basal * massTerm + activity;
}

function animalMaxSpeed(s) {
  if (s.diet === "herbivore") return 1.55 + s.speed * 0.275;
  if (s.diet === "omnivore") return 1.40 + s.speed * 0.26;
  return 1.95 + s.speed * 0.365;
}

function chaseStrength(s) {
  if (s.diet === "herbivore") return 0.32 + s.speed * 0.035;
  if (s.diet === "omnivore") return 0.34 + s.speed * 0.040;
  return 0.475 + s.speed * 0.062;
}

function fleeStrength(s) { return 0.66 + s.speed * 0.066; }

function nearestObstacle(a, maxRange = 320) {
  let best = null;
  let bestD = maxRange * maxRange;
  for (const o of obstacles) {
    const dx = a.x - o.x, dy = a.y - o.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function fleeFrom(a, s, threat) {
  moveToward(a, threat, -fleeStrength(s));
  const cover = nearestObstacle(a, 260);
  if (cover) moveToward(a, cover, fleeStrength(s) * 0.30);
}

function graze(a, s, deadPlants) {
  const radius = 11 + s.size * 2.2;
  let bites = 0;
  const tries = Math.min(160, plants.length);
  for (let i = 0; i < tries && bites < 3; i++) {
    const p = plants[Math.floor(Math.random() * plants.length)];
    if (!p || deadPlants.has(p.id)) continue;
    if (dist2(a, p) <= radius * radius) {
      bites++;
      const biteGain = s.diet === "herbivore" ? 0.18 + s.size * 0.016 : 0.11 + s.size * 0.010;
      a.energy += biteGain;
      p.energy -= 0.16 + s.size * 0.018;
      if (p.energy <= 0.08 || Math.random() < 0.18) deadPlants.add(p.id);
    }
  }
  return bites > 0;
}

function hunt(a, s, deadAnimals) {
  const { nearest, density } = scanPrey(a, s, s.diet === "carnivore" ? 280 : 150);
  const giveUpDistance = (180 + s.speed * 14) * 1.6;
  let target = a.targetId ? animalsById.get(a.targetId) : null;
  if (target && (deadAnimals.has(target.id) || !getSpecies(target.sid))) target = null;
  if (target && dist2(a, target) > giveUpDistance * giveUpDistance) target = null;

  if (!target) {
    target = nearest;
    a.targetId = target ? target.id : null;
  } else if (nearest && nearest.id !== target.id && dist2(a, nearest) < dist2(a, target) * 0.4) {
    target = nearest;
    a.targetId = target.id;
  }

  if (!target) return false;
  moveToward(a, target, chaseStrength(s));

  const ps = getSpecies(target.sid);
  if (!ps) return true;

  const dx = target.x - a.x;
  const dy = target.y - a.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const attackRange = 6 + s.size * 1.65;

  if (d < attackRange) {
    const attackRate = s.diet === "carnivore" ? (0.018 + s.attack * 0.0036) : (0.012 + s.attack * 0.0024);
    const handlingTime = s.diet === "carnivore" ? Math.max(1.0, 2.0 - s.size * 0.05) : Math.max(1.2, 2.3 - s.size * 0.05);
    const d2 = density * density;
    const functionalResponse = (attackRate * d2) / (1 + attackRate * handlingTime * d2);
    const attackPower = s.attack * 1.3 + s.speed * 0.4 + s.size * 0.3 + rand(-1.2, 1.8);
    const defensePower = ps.speed * 0.32 + ps.size * 0.55 + rand(-1.2, 1.8);
    const skillFactor = clamp(0.55 + (attackPower - defensePower) * 0.045, 0.35, 1.6);
    const captureChance = clamp(functionalResponse * skillFactor, 0, 0.85);
    const finalChance = coverAt(target.x, target.y) ? captureChance * 0.62 : captureChance;

    if (Math.random() < finalChance) {
      deadAnimals.add(target.id);
      a.targetId = null;
      const preyEnergyContent = 1.6 + ps.size * 0.9;
      const trophicTransfer = s.diet === "carnivore" ? 0.55 : 0.25;
      a.energy += preyEnergyContent * trophicTransfer;
    } else {
      a.energy -= 0.022;
      a.vx -= dx / Math.max(1, d) * 0.5;
      a.vy -= dy / Math.max(1, d) * 0.5;
    }
  }

  return true;
}

function reproduceAnimal(a, s, newborns) {
  if (a.cooldown > 0) return;
  let threshold, chance, parentCost, childEnergy, cooldown;

  if (s.diet === "herbivore") {
    threshold = 0.74 + s.size * 0.034;
    chance = 0.0046 + s.fertility * 0.00115 + Math.min(0.013, Math.max(0, a.energy - 0.92) * 0.0055);
    parentCost = 0.60;
    childEnergy = 0.34;
    cooldown = 55 + rand(0, 115);
  } else if (s.diet === "omnivore") {
    threshold = 1.02 + s.size * 0.050;
    chance = 0.00125 + s.fertility * 0.00038 + Math.min(0.003, Math.max(0, a.energy - 1.15) * 0.0015);
    parentCost = 0.58;
    childEnergy = 0.33;
    cooldown = 220 + rand(0, 260);
  } else {
    threshold = 1.05 + s.size * 0.055;
    chance = 0.00075 + s.fertility * 0.00032 + Math.min(0.0032, Math.max(0, a.energy - 1.15) * 0.0013);
    parentCost = 0.42;
    childEnergy = 0.32;
    cooldown = 230 + rand(0, 210);
    const territoryCap = 40;
    chance *= clamp(1 - byDiet.carnivore.length / territoryCap, 0.10, 1);
  }

  if (a.energy < threshold) return;
  if (Math.random() < chance) {
    const child = makeAnimal(
      s,
      clamp(a.x + rand(-18, 18), 18, WORLD_W - 18),
      clamp(a.y + rand(-18, 18), 18, WORLD_H - 18)
    );
    child.energy = a.energy * childEnergy;
    child.cooldown = cooldown * 0.65;
    a.energy *= parentCost;
    a.cooldown = cooldown;
    newborns.push(child);
  }
}

function regrowPlants() {
  const N = plants.length;
  const growth = PLANT_R * N * (1 - N / PLANT_K);
  let toAdd = Math.round(growth);
  if (N < PLANT_K * 0.03) toAdd += 6;

  if (toAdd > 0) {
    toAdd = Math.min(toAdd, MAX_PLANTS - plants.length);
    for (let i = 0; i < toAdd; i++) {
      if (plants.length && Math.random() < 0.55) {
        const parent = plants[Math.floor(Math.random() * plants.length)];
        const radius = rand(14, 90);
        const angle = rand(0, Math.PI * 2);
        plants.push(makePlant(
          clamp(parent.x + Math.cos(angle) * radius, 15, WORLD_W - 15),
          clamp(parent.y + Math.sin(angle) * radius, 15, WORLD_H - 15)
        ));
      } else {
        plants.push(makePlant());
      }
    }
  } else if (toAdd < 0) {
    plants.splice(0, Math.min(plants.length, -toAdd));
  }

  for (const p of plants) p.energy = Math.min(1.0, p.energy + (0.05 * p.energy * (1 - p.energy) + 0.0016));
}

function stepWorld() {
  lastCounts = countsBySpecies();
  regrowPlants();

  const deadPlants = new Set();
  const deadAnimals = new Set();
  const newborns = [];

  for (let i = animals.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [animals[i], animals[j]] = [animals[j], animals[i]];
  }

  rebuildDietGroups();

  for (const a of animals) {
    if (deadAnimals.has(a.id)) continue;
    const s = getSpecies(a.sid);
    if (!s) { deadAnimals.add(a.id); continue; }

    a.age++;
    a.cooldown--;
    let fed = false;
    let hasTarget = false;

    if (s.diet === "herbivore") {
      const threat = scanThreat(a, s, 90);
      if (threat) {
        fleeFrom(a, s, threat);
        hasTarget = true;
        fed = graze(a, s, deadPlants);
      } else {
        fed = graze(a, s, deadPlants);
        const plant = findNearestPlant(a, 260);
        hasTarget = !!plant;
        moveToward(a, plant, chaseStrength(s));
      }
    } else if (s.diet === "omnivore") {
      const threat = scanThreat(a, s, 90);
      if (threat) {
        fleeFrom(a, s, threat);
        hasTarget = true;
        fed = graze(a, s, deadPlants);
      } else if (a.energy < 1.00 || Math.random() < 0.62) {
        fed = graze(a, s, deadPlants);
        const plant = findNearestPlant(a, 190);
        hasTarget = !!plant;
        moveToward(a, plant, chaseStrength(s) * 0.78);
      } else {
        hasTarget = hunt(a, s, deadAnimals);
      }
    } else if (s.diet === "carnivore") {
      hasTarget = hunt(a, s, deadAnimals);
    }

    if (!hasTarget) {
      a.vx += rand(-0.10, 0.10);
      a.vy += rand(-0.10, 0.10);
    }

    const maxV = animalMaxSpeed(s);
    a.vx = clamp(a.vx * 0.88, -maxV, maxV);
    a.vy = clamp(a.vy * 0.88, -maxV, maxV);
    a.x = clamp(a.x + a.vx, 14, WORLD_W - 14);
    a.y = clamp(a.y + a.vy, 14, WORLD_H - 14);

    let cost = animalMaintenance(s);
    if (fed && s.diet === "herbivore") cost *= 0.52;
    if (fed && s.diet === "omnivore") cost *= 0.72;
    if (hasTarget && s.diet === "carnivore") cost *= 0.72;
    if (hasTarget && s.diet === "omnivore") cost *= 0.82;
    a.energy -= cost;
    if (s.diet === "carnivore" && !hasTarget) a.energy -= 0.008;

    const energyCap = s.diet === "herbivore" ? 1.75 : (s.diet === "omnivore" ? 2.10 : 4.20);
    a.energy = Math.min(a.energy, energyCap);

    reproduceAnimal(a, s, newborns);

    const oldAgeRisk = a.age > 2500 ? 0.002 : 0;
    const randomDeath = Math.random() < 0.00018 + oldAgeRisk;
    const deathFloor = s.diet === "carnivore" ? 0 : (s.diet === "omnivore" ? -0.05 : 0);
    if (a.energy <= deathFloor || randomDeath) deadAnimals.add(a.id);
  }

  plants = plants.filter(p => !deadPlants.has(p.id));
  animals = animals.filter(a => !deadAnimals.has(a.id)).concat(newborns).slice(0, MAX_ANIMALS);

  const counts = countsBySpecies();
  species = species.filter(s => counts.has(s.id));

  day++;
}

function sanitizeSpecies(input) {
  const dietAllowed = new Set(["producer", "herbivore", "omnivore", "carnivore"]);
  const rawName = typeof input.name === "string" ? input.name.trim() : "";
  const name = rawName.replace(/\s+/g, " ").slice(0, 24) || "Unnamed";
  const diet = dietAllowed.has(input.diet) ? input.diet : "herbivore";
  const color = /^#[0-9A-Fa-f]{6}$/.test(input.color) ? input.color : "#e8d2a6";
  const count = Math.round(clamp(Number(input.count ?? input.spawn_count ?? 20), 1, 120));
  const size = Math.round(clamp(Number(input.size), 1, 10));
  const speed = Math.round(clamp(Number(input.speed), 1, 10));
  const attack = diet === "producer" ? 0 : Math.round(clamp(Number(input.attack), 0, 10));
  const fertility = Math.round(clamp(Number(input.fertility), 1, 10));
  return { name, diet, color, count, size, speed, attack, fertility };
}

function releaseSpecies(input) {
  const clean = sanitizeSpecies(input);

  if (clean.diet === "producer") {
    const add = Math.min(clean.count, MAX_PLANTS - plants.length);
    for (let i = 0; i < add; i++) plants.push(makePlant(rand(18, WORLD_W - 18), rand(18, WORLD_H - 18)));
    return { ok: true, message: `Released ${add} producers.` };
  }

  if (species.length >= MAX_SPECIES) {
    return { ok: false, message: "Too many species already. Wait for some to go extinct, nature is brutal like that." };
  }

  const s = {
    id: makeId(),
    name: clean.name,
    diet: clean.diet,
    color: clean.color,
    size: clean.size,
    speed: clean.speed,
    attack: clean.attack,
    fertility: clean.fertility
  };

  species.push(s);

  let centre = { x: rand(90, WORLD_W - 90), y: rand(90, WORLD_H - 90) };
  if (s.diet === "carnivore" || s.diet === "omnivore") {
    const potentialPrey = animals.filter(other => {
      const os = getSpecies(other.sid);
      return os && isPredatorOf(s, os);
    });
    if (potentialPrey.length) {
      const anchor = potentialPrey[Math.floor(Math.random() * potentialPrey.length)];
      centre = { x: anchor.x, y: anchor.y };
    }
  }

  const add = Math.min(clean.count, MAX_ANIMALS - animals.length);
  for (let i = 0; i < add; i++) {
    animals.push(makeAnimal(
      s,
      clamp(centre.x + rand(-70, 70), 22, WORLD_W - 22),
      clamp(centre.y + rand(-70, 70), 22, WORLD_H - 22)
    ));
  }

  return { ok: true, message: `Released ${add} ${s.name}.` };
}

function resetWorld() {
  day = 0;
  plants = [];
  animals = [];
  species = [];
  lastCounts = new Map();
  generateObstacles();
  for (let i = 0; i < INITIAL_PLANTS; i++) plants.push(makePlant());
}

function loadWorldIfPresent() {
  if (!SAVE_WORLD || !fs.existsSync(WORLD_SAVE_PATH)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(WORLD_SAVE_PATH, "utf8"));
    day = Number(data.day) || 0;
    plants = Array.isArray(data.plants) ? data.plants.slice(0, MAX_PLANTS) : [];
    obstacles = Array.isArray(data.obstacles) ? data.obstacles : [];
    animals = Array.isArray(data.animals) ? data.animals.slice(0, MAX_ANIMALS) : [];
    species = Array.isArray(data.species) ? data.species.slice(0, MAX_SPECIES) : [];
    if (!plants.length || !obstacles.length) throw new Error("snapshot missing core world arrays");
    console.log(`Loaded world snapshot from ${WORLD_SAVE_PATH}`);
    return true;
  } catch (err) {
    console.warn("Could not load world snapshot, starting fresh:", err.message);
    return false;
  }
}

function saveWorld() {
  if (!SAVE_WORLD) return;
  try {
    fs.mkdirSync(path.dirname(WORLD_SAVE_PATH), { recursive: true });
    const tmp = `${WORLD_SAVE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ day, plants, obstacles, animals, species }));
    fs.renameSync(tmp, WORLD_SAVE_PATH);
  } catch (err) {
    console.warn("Could not save world snapshot:", err.message);
  }
}

function compactSnapshot(includePlants = true) {
  const counts = countsBySpecies();
  const plantList = includePlants
    ? (plants.length > MAX_PLANTS_SENT
        ? [...plants].sort((a, b) => a.rank - b.rank).slice(0, MAX_PLANTS_SENT)
        : plants)
    : undefined;

  return {
    type: "snapshot",
    day,
    world: { w: WORLD_W, h: WORLD_H },
    obstacles,
    species,
    plantsTotal: plants.length,
    animalsTotal: animals.length,
    speciesTotal: species.length,
    plants: plantList?.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), e: Number(p.energy.toFixed(2)) })),
    animals: animals.map(a => ({
      id: a.id,
      sid: a.sid,
      x: Number(a.x.toFixed(1)),
      y: Number(a.y.toFixed(1)),
      e: Number(a.energy.toFixed(2))
    })),
    counts: Object.fromEntries(counts)
  };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, "public")));
app.get("/healthz", (req, res) => res.status(200).send("ok"));
app.get("/state", (req, res) => res.json(compactSnapshot(true)));

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  ws.id = makeId();
  ws.lastReleaseAt = 0;
  send(ws, { type: "welcome", id: ws.id, message: "Connected to shared ecosystem server." });
  send(ws, compactSnapshot(true));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: "error", message: "Bad JSON." }); }

    if (msg.type === "release_species") {
      const now = Date.now();
      if (now - ws.lastReleaseAt < 700) {
        return send(ws, { type: "error", message: "Slow down. One release per 0.7 seconds." });
      }
      ws.lastReleaseAt = now;
      const result = releaseSpecies(msg.species || {});
      send(ws, { type: result.ok ? "notice" : "error", message: result.message });
      broadcast(compactSnapshot(true));
      return;
    }

    if (msg.type === "ping") send(ws, { type: "pong", at: Date.now() });
  });
});

if (!loadWorldIfPresent()) resetWorld();

setInterval(() => {
  stepWorld();

  if (day >= RESET_EVERY_DAYS) {
    resetWorld();
    snapshotSeq = 0;

    // If SAVE_WORLD=1, immediately save the clean reset state
    // so Render/server restarts don't reload the old cursed world.
    saveWorld();

    broadcast({
      type: "notice",
      message: `World reset after ${RESET_EVERY_DAYS} days. Clean slate.`
    });

    broadcast(compactSnapshot(true));
    return;
  }

  const now = Date.now();
  if (now - lastSnapshotAt >= SNAPSHOT_MS) {
    lastSnapshotAt = now;
    snapshotSeq++;
    broadcast(compactSnapshot(snapshotSeq % PLANT_SNAPSHOT_EVERY === 0));
  }
}, TICK_MS);

if (SAVE_WORLD) setInterval(saveWorld, 30_000);
process.on("SIGINT", () => { saveWorld(); process.exit(0); });
process.on("SIGTERM", () => { saveWorld(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Ecosystem multiplayer server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint is the same origin. SAVE_WORLD=${SAVE_WORLD}`);
});
