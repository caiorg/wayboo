import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  LIVE_WINDOW_MS,
  PRIOR_WEIGHTS,
  segmentOfKey,
  type LiveObservation,
  type DecayedStat,
  type LatLon,
  type Place,
  type PlanResponse,
  type PreferenceWeights,
  type RoadAlert,
  type Route,
  type Routine,
  type StatsMap,
  type TraceSample,
} from '@wayboo/core';
import { config } from './config';

/** Usuário agregado (crowd): estatísticas de todos, sem identificar ninguém. */
export const CROWD = '*';

export const db = new DatabaseSync(config.dbPath);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS stats (
  user_id TEXT NOT NULL, key TEXT NOT NULL, seg TEXT,
  w REAL NOT NULL, mean REAL NOT NULL, m2 REAL NOT NULL, t INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX IF NOT EXISTS stats_seg ON stats(user_id, seg);
CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  name TEXT, kind TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0, home_score REAL NOT NULL DEFAULT 0, work_score REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS places_user ON places(user_id);
CREATE TABLE IF NOT EXISTS routines (
  user_id TEXT NOT NULL, origin_id TEXT NOT NULL, dest_id TEXT NOT NULL, day_type TEXT NOT NULL,
  hist TEXT NOT NULL, t INTEGER NOT NULL, trips INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, origin_id, dest_id, day_type)
);
CREATE TABLE IF NOT EXISTS prefs (user_id TEXT PRIMARY KEY, weights TEXT NOT NULL, updates INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS privacy (user_id TEXT PRIMARY KEY, share_crowd INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, route_index INTEGER NOT NULL,
  time_zone TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  predicted_s REAL NOT NULL, base_s REAL NOT NULL, actual_s REAL, distance_m REAL NOT NULL,
  origin_place TEXT, dest_place TEXT, ctx TEXT NOT NULL, status TEXT NOT NULL,
  error_base REAL, error_learned REAL, last_sample_at INTEGER
);
CREATE INDEX IF NOT EXISTS trips_user ON trips(user_id, started_at);
CREATE TABLE IF NOT EXISTS trip_legs (
  trip_id TEXT NOT NULL, seq INTEGER NOT NULL, started_at INTEGER NOT NULL, plan_id TEXT NOT NULL, route_index INTEGER NOT NULL,
  PRIMARY KEY (trip_id, seq)
);
CREATE TABLE IF NOT EXISTS samples (
  trip_id TEXT NOT NULL, t INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
  speed REAL, heading REAL, accuracy REAL
);
CREATE INDEX IF NOT EXISTS samples_trip ON samples(trip_id, t);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, note TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
  reporter TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS alerts_geo ON alerts(lat, lon);
CREATE TABLE IF NOT EXISTS alert_votes (alert_id TEXT NOT NULL, user_id TEXT NOT NULL, up INTEGER NOT NULL, PRIMARY KEY (alert_id, user_id));
CREATE TABLE IF NOT EXISTS anomalies (
  user_id TEXT NOT NULL, seg TEXT NOT NULL, at INTEGER NOT NULL, expected_s REAL NOT NULL, observed_s REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);
CREATE TABLE IF NOT EXISTS deleted_users (user_id TEXT PRIMARY KEY);
`);

/** Condição de INSERT ... SELECT que grava só se o usuário (último parâmetro) não foi apagado por `DELETE /me`. */
const NOT_DELETED = 'NOT EXISTS (SELECT 1 FROM deleted_users WHERE user_id = ?)';

// Bancos criados antes da retenção não têm a coluna; `CREATE TABLE IF NOT EXISTS` não a acrescenta.
if (!db.prepare("SELECT 1 FROM pragma_table_info('trips') WHERE name = 'last_sample_at'").get()) {
  db.exec('ALTER TABLE trips ADD COLUMN last_sample_at INTEGER');
}

/**
 * Acrescenta a `devices` o id público (o que `GET /devices` mostra, nunca o hash), o último uso e a revogação.
 * Idempotente. Bancos antigos e novos passam por aqui, então o `CREATE TABLE` acima fica com as colunas originais.
 */
export function migrateDevices(database: DatabaseSync): void {
  const has = (column: string) => database.prepare("SELECT 1 FROM pragma_table_info('devices') WHERE name = ?").get(column) !== undefined;
  for (const [column, type] of [['id', 'TEXT'], ['last_seen_at', 'INTEGER'], ['revoked_at', 'INTEGER']] as const) {
    if (!has(column)) database.exec(`ALTER TABLE devices ADD COLUMN ${column} ${type}`);
  }
  const fill = database.prepare('UPDATE devices SET id = ? WHERE token_hash = ?');
  for (const r of database.prepare('SELECT token_hash FROM devices WHERE id IS NULL').all() as Row[]) fill.run(randomUUID(), String(r.token_hash));
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS devices_id ON devices(id)');
}
migrateDevices(db);

type Row = Record<string, string | number | null>;

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- estatísticas ----------

const toStat = (r: Row): DecayedStat => ({ w: Number(r.w), mean: Number(r.mean), m2: Number(r.m2), t: Number(r.t) });

/** Carrega estatísticas dos trechos informados + todas as chaves globais (sem trecho) do usuário. */
export function loadStats(userId: string, segs: string[]): StatsMap {
  const map: StatsMap = new Map();
  const unique = [...new Set(segs)];
  const chunk = 400;
  for (let i = 0; i < unique.length; i += chunk) {
    const part = unique.slice(i, i + chunk);
    const rows = db
      .prepare(`SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND seg IN (${part.map(() => '?').join(',')})`)
      .all(userId, ...part) as Row[];
    for (const r of rows) map.set(String(r.key), toStat(r));
  }
  for (const r of db.prepare('SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND seg IS NULL').all(userId) as Row[]) {
    map.set(String(r.key), toStat(r));
  }
  return map;
}

export function saveStats(userId: string, stats: StatsMap): void {
  const stmt = db.prepare(
    `INSERT INTO stats (user_id, key, seg, w, mean, m2, t) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET w = excluded.w, mean = excluded.mean, m2 = excluded.m2, t = excluded.t`,
  );
  for (const [key, s] of stats) stmt.run(userId, key, segmentOfKey(key), s.w, s.mean, s.m2, s.t);
}

export function statsByPrefix(userId: string, prefix: string, minW: number): { key: string; stat: DecayedStat }[] {
  return (db.prepare('SELECT key, w, mean, m2, t FROM stats WHERE user_id = ? AND key LIKE ? AND w >= ?').all(userId, `${prefix}%`, minW) as Row[]).map(
    (r) => ({ key: String(r.key), stat: toStat(r) }),
  );
}

// ---------- lugares e rotinas ----------

const toPlace = (r: Row): Place => ({
  id: String(r.id),
  lat: Number(r.lat),
  lon: Number(r.lon),
  name: r.name === null ? null : String(r.name),
  kind: String(r.kind) as Place['kind'],
  pinned: Number(r.pinned) === 1,
  visits: Number(r.visits),
  homeScore: Number(r.home_score),
  workScore: Number(r.work_score),
});

export function getPlaces(userId: string): Place[] {
  return (db.prepare('SELECT * FROM places WHERE user_id = ?').all(userId) as Row[]).map(toPlace);
}

export function upsertPlace(userId: string, p: Place): void {
  db.prepare(
    `INSERT INTO places (id, user_id, lat, lon, name, kind, pinned, visits, home_score, work_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, name = excluded.name, kind = excluded.kind,
       pinned = excluded.pinned, visits = excluded.visits, home_score = excluded.home_score, work_score = excluded.work_score`,
  ).run(p.id, userId, p.lat, p.lon, p.name, p.kind, p.pinned ? 1 : 0, p.visits, p.homeScore, p.workScore);
}

export function newPlace(lat: number, lon: number): Place {
  return { id: randomUUID(), lat, lon, name: null, kind: 'other', pinned: false, visits: 0, homeScore: 0, workScore: 0 };
}

export function getRoutines(userId: string): (Routine & { trips: number })[] {
  return (db.prepare('SELECT * FROM routines WHERE user_id = ?').all(userId) as Row[]).map((r) => ({
    originId: String(r.origin_id),
    destId: String(r.dest_id),
    dayType: String(r.day_type) as Routine['dayType'],
    hist: JSON.parse(String(r.hist)) as number[],
    t: Number(r.t),
    trips: Number(r.trips),
  }));
}

export function saveRoutine(userId: string, r: Routine): void {
  db.prepare(
    `INSERT INTO routines (user_id, origin_id, dest_id, day_type, hist, t, trips) VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(user_id, origin_id, dest_id, day_type) DO UPDATE SET hist = excluded.hist, t = excluded.t, trips = trips + 1`,
  ).run(userId, r.originId, r.destId, r.dayType, JSON.stringify(r.hist.map((v) => Math.round(v * 1000) / 1000)), r.t);
}

// ---------- rota habitual das sugestões ----------

db.exec(`
CREATE TABLE IF NOT EXISTS routine_routes (
  user_id TEXT NOT NULL, origin_id TEXT NOT NULL, dest_id TEXT NOT NULL,
  from_lat REAL NOT NULL, from_lon REAL NOT NULL, to_lat REAL NOT NULL, to_lon REAL NOT NULL,
  fetched_at INTEGER NOT NULL, routes TEXT NOT NULL,
  PRIMARY KEY (user_id, origin_id, dest_id)
);
`);

/** Rotas que o roteador devolveu para uma rotina, com os pontos pedidos e quando. */
export interface RoutineRoutes {
  from: LatLon;
  to: LatLon;
  fetchedAt: number;
  routes: Route[];
}

/** Passada a idade máxima a rota não é mais reaproveitada; não há motivo para guardar a localização. */
const purgeExpiredRoutineRoutes = (now: number) =>
  Number(db.prepare('DELETE FROM routine_routes WHERE fetched_at < ?').run(now - config.suggestions.routeMaxAgeMs).changes);

export function getRoutineRoutes(userId: string, originId: string, destId: string): RoutineRoutes | null {
  // Também roda a cada leitura, então a limpeza não depende de o roteador responder e uma rota nova ser gravada.
  purgeExpiredRoutineRoutes(Date.now());
  const r = db.prepare('SELECT * FROM routine_routes WHERE user_id = ? AND origin_id = ? AND dest_id = ?').get(userId, originId, destId) as
    | Row
    | undefined;
  if (!r) return null;
  return {
    from: { lat: Number(r.from_lat), lon: Number(r.from_lon) },
    to: { lat: Number(r.to_lat), lon: Number(r.to_lon) },
    fetchedAt: Number(r.fetched_at),
    routes: JSON.parse(String(r.routes)) as Route[],
  };
}

/** Como `savePlan`, não grava para usuário em `deleted_users`: a rota chega depois de esperar o roteador. */
export function saveRoutineRoutes(userId: string, originId: string, destId: string, v: RoutineRoutes): void {
  db.prepare(
    `INSERT INTO routine_routes (user_id, origin_id, dest_id, from_lat, from_lon, to_lat, to_lon, fetched_at, routes)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${NOT_DELETED}
     ON CONFLICT(user_id, origin_id, dest_id) DO UPDATE SET from_lat = excluded.from_lat, from_lon = excluded.from_lon,
       to_lat = excluded.to_lat, to_lon = excluded.to_lon, fetched_at = excluded.fetched_at, routes = excluded.routes`,
  ).run(userId, originId, destId, v.from.lat, v.from.lon, v.to.lat, v.to.lon, v.fetchedAt, JSON.stringify(v.routes), userId);
}

// ---------- preferências ----------

export function getPrefs(userId: string): { weights: PreferenceWeights; updates: number } {
  const r = db.prepare('SELECT weights, updates FROM prefs WHERE user_id = ?').get(userId) as Row | undefined;
  if (!r) return { weights: { ...PRIOR_WEIGHTS }, updates: 0 };
  return { weights: { ...PRIOR_WEIGHTS, ...(JSON.parse(String(r.weights)) as PreferenceWeights) }, updates: Number(r.updates) };
}

export function savePrefs(userId: string, weights: PreferenceWeights, updates: number): void {
  db.prepare(
    `INSERT INTO prefs (user_id, weights, updates) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET weights = excluded.weights, updates = excluded.updates`,
  ).run(userId, JSON.stringify(weights), updates);
}

// ---------- aparelhos ----------

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** `last_seen_at` só é regravado depois desse intervalo, para não escrever no banco a cada pedido. */
const LAST_SEEN_STEP_MS = 3_600_000;

/**
 * Registra o token que o próprio aparelho gerou (256 bits); o banco guarda só o hash.
 * Idempotente: repetir o mesmo token devolve o mesmo usuário, então uma resposta perdida
 * não cria outra identidade. O aparelho grava o token antes de enviar.
 * `legacyUserId` é o UUID que o app enviava em `x-user-id`: o servidor adota esse id
 * (e os dados gravados nele) se nenhum aparelho o reivindicou antes e ele não foi apagado (`DELETE /me`).
 * Senão, cria um usuário novo. Aparelhos revogados continuam reivindicando o id.
 * Devolve `null` para um token revogado, que nunca volta a valer.
 */
export function registerDevice(token: string, legacyUserId?: string): { userId: string } | null {
  const hash = hashToken(token);
  return transaction(() => {
    const known = db.prepare('SELECT user_id, revoked_at FROM devices WHERE token_hash = ?').get(hash) as Row | undefined;
    if (known) return known.revoked_at === null ? { userId: String(known.user_id) } : null;
    const claimed =
      legacyUserId !== undefined &&
      db.prepare('SELECT 1 FROM devices WHERE user_id = ? UNION ALL SELECT 1 FROM deleted_users WHERE user_id = ?').get(legacyUserId, legacyUserId) !==
        undefined;
    const userId = legacyUserId !== undefined && !claimed ? legacyUserId : randomUUID();
    const now = Date.now();
    db.prepare('INSERT INTO devices (id, token_hash, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(randomUUID(), hash, userId, now, now);
    return { userId };
  });
}

/** Usuário e aparelho do token, se ele não foi revogado. Também marca o último uso (no máximo 1 vez por hora). */
export function deviceOfToken(token: string, now = Date.now()): { userId: string; deviceId: string } | null {
  const r = db.prepare('SELECT id, user_id, last_seen_at FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(hashToken(token)) as
    | Row
    | undefined;
  if (!r) return null;
  if (r.last_seen_at === null || Number(r.last_seen_at) < now - LAST_SEEN_STEP_MS) {
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, String(r.id));
  }
  return { userId: String(r.user_id), deviceId: String(r.id) };
}

export interface DeviceRecord {
  id: string;
  createdAt: string;
  /** `null` em aparelhos registrados antes de o servidor guardar o último uso. */
  lastSeenAt: string | null;
}

const iso = (ms: string | number | null | undefined) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());

/** Aparelhos ativos do usuário, do mais antigo ao mais novo. */
export function listDevices(userId: string): DeviceRecord[] {
  const rows = db.prepare('SELECT id, created_at, last_seen_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, id').all(userId) as Row[];
  return rows.map((r) => ({ id: String(r.id), createdAt: iso(r.created_at)!, lastSeenAt: iso(r.last_seen_at) }));
}

/**
 * Revoga um aparelho ativo do usuário. O último aparelho ativo não sai (`'last'`): sem login, ninguém
 * mais conseguiria exportar nem apagar os dados. Para sair dele, o caminho é `DELETE /me`.
 */
export function revokeDevice(userId: string, deviceId: string, now = Date.now()): 'revoked' | 'not_found' | 'last' {
  return transaction(() => {
    const active = db.prepare('SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL').all(userId) as Row[];
    if (!active.some((r) => r.id === deviceId)) return 'not_found';
    if (active.length === 1) return 'last';
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(now, deviceId);
    return 'revoked';
  });
}

// ---------- privacidade ----------

/** Opt-in para somar os tempos de trecho ao usuário agregado. Sem linha, vale "não". */
export function getShareCrowd(userId: string): boolean {
  const r = db.prepare('SELECT share_crowd FROM privacy WHERE user_id = ?').get(userId) as Row | undefined;
  return Number(r?.share_crowd ?? 0) === 1;
}

export function setShareCrowd(userId: string, share: boolean): void {
  transaction(() => {
    db.prepare(
      `INSERT INTO privacy (user_id, share_crowd, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET share_crowd = excluded.share_crowd, updated_at = excluded.updated_at`,
    ).run(userId, share ? 1 : 0, Date.now());
    // Revogar o opt-in tira também o que o usuário mediu nos últimos minutos, na mesma transação.
    if (!share) db.prepare('DELETE FROM live_obs WHERE user_id = ?').run(userId);
  });
}

// ---------- trânsito ao vivo ----------

/**
 * Última medida de cada usuário com opt-in em cada trecho, nos últimos 15 min: o log da razão e o instante
 * de saída do trecho, no relógio do servidor. O `user_id` só serve para contar usuários distintos e
 * guardar uma medida por pessoa; nunca sai da API. Linhas com mais de 15 min saem a cada gravação e leitura.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS live_obs (
  seg TEXT NOT NULL, user_id TEXT NOT NULL, t INTEGER NOT NULL, x REAL NOT NULL,
  PRIMARY KEY (seg, user_id)
);
CREATE INDEX IF NOT EXISTS live_obs_t ON live_obs(t);
`);

const purgeLive = (now: number) => Number(db.prepare('DELETE FROM live_obs WHERE t < ?').run(now - LIVE_WINDOW_MS).changes);

export function saveLiveObservations(userId: string, observations: { seg: string; t: number; x: number }[], now = Date.now()): void {
  purgeLive(now);
  const stmt = db.prepare(
    `INSERT INTO live_obs (seg, user_id, t, x) VALUES (?, ?, ?, ?)
     ON CONFLICT(seg, user_id) DO UPDATE SET t = excluded.t, x = excluded.x WHERE excluded.t >= live_obs.t`,
  );
  for (const o of observations) stmt.run(o.seg, userId, o.t, o.x);
}

/** Observações da janela nos trechos pedidos, para `aggregateLive`. */
export function loadLiveObservations(segs: string[], now = Date.now()): LiveObservation[] {
  purgeLive(now);
  const unique = [...new Set(segs)];
  const out: LiveObservation[] = [];
  for (let i = 0; i < unique.length; i += 400) {
    const part = unique.slice(i, i + 400);
    const rows = db
      .prepare(`SELECT seg, user_id, t, x FROM live_obs WHERE seg IN (${part.map(() => '?').join(',')})`)
      .all(...part) as Row[];
    for (const r of rows) out.push({ seg: String(r.seg), contributor: String(r.user_id), t: Number(r.t), x: Number(r.x) });
  }
  return out;
}

// ---------- planos ----------

/**
 * Grava o plano, salvo se o usuário está em `deleted_users`. O planejamento espera os provedores (IA, clima,
 * roteador); sem essa checagem, um pedido que começou antes do `DELETE /me` recriaria origem, destino e rota.
 * Um id apagado nunca volta a um aparelho (`registerDevice`), então só pedidos assim chegam aqui com ele.
 * A checagem fica no próprio INSERT, e vale com o servidor reiniciado ou com outro processo no mesmo banco.
 * Devolve se gravou.
 */
export function savePlan(userId: string, plan: PlanResponse): boolean {
  const inserted = db
    .prepare(`INSERT INTO plans (id, user_id, created_at, body) SELECT ?, ?, ?, ? WHERE ${NOT_DELETED}`)
    .run(plan.planId, userId, plan.createdAt, JSON.stringify(plan), userId).changes;
  if (!inserted) return false;
  // Planos só servem para iniciar viagens; os de mais de 2 dias sem viagem podem sair.
  db.prepare(
    'DELETE FROM plans WHERE created_at < ? AND id NOT IN (SELECT plan_id FROM trip_legs)',
  ).run(Date.now() - 2 * 86_400_000);
  return true;
}

export function getPlan(userId: string, planId: string): PlanResponse | null {
  const r = db.prepare('SELECT body FROM plans WHERE id = ? AND user_id = ?').get(planId, userId) as Row | undefined;
  return r ? (JSON.parse(String(r.body)) as PlanResponse) : null;
}

// ---------- amostras ----------

/** Grava as amostras e marca a atividade da viagem com o relógio do servidor (usado na retenção). */
export function insertSamples(tripId: string, samples: TraceSample[], now = Date.now()): void {
  const stmt = db.prepare('INSERT INTO samples (trip_id, t, lat, lon, speed, heading, accuracy) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const s of samples) stmt.run(tripId, s.t, s.lat, s.lon, s.speed ?? null, s.heading ?? null, s.accuracy ?? null);
  db.prepare('UPDATE trips SET last_sample_at = ? WHERE id = ?').run(now, tripId);
}

/** Instante da amostra mais recente da viagem (relógio do aparelho), ou `-Infinity` sem amostras. */
export function lastSampleT(tripId: string): number {
  const r = db.prepare('SELECT MAX(t) AS t FROM samples WHERE trip_id = ?').get(tripId) as Row | undefined;
  return r?.t == null ? -Infinity : Number(r.t);
}

/** Amostras da viagem a partir de `since` (relógio do aparelho), em ordem. */
export function getSamples(tripId: string, since = -Infinity): TraceSample[] {
  return (
    db.prepare('SELECT t, lat, lon, speed, heading, accuracy FROM samples WHERE trip_id = ? AND t >= ? ORDER BY t').all(tripId, since) as Row[]
  ).map((r) => ({
    t: Number(r.t),
    lat: Number(r.lat),
    lon: Number(r.lon),
    speed: r.speed === null ? null : Number(r.speed),
    heading: r.heading === null ? null : Number(r.heading),
    accuracy: r.accuracy === null ? null : Number(r.accuracy),
  }));
}

// ---------- retenção e dados do usuário (LGPD) ----------

/** Viagem ativa sem encerramento por mais que isso conta como abandonada. */
const ABANDONED_TRIP_MS = 86_400_000;

/**
 * Apaga o rastro GPS bruto e os planos (origem, destino e geometria) das viagens encerradas há mais
 * de `retentionMs`. Depois do encerramento, o aprendizado só usa as estatísticas por trecho, que ficam.
 * Viagem ativa só perde o rastro depois de abandonada, para o prazo curto não cortar uma viagem em curso.
 * Alertas expirados há mais de `retentionMs` saem com os votos: guardam coordenada, horário e autor.
 * Rotas guardadas das rotinas saem ao passar de `SUGGESTION_ROUTE_MAX_AGE_MIN`, mesmo sem consulta a `/suggestions`.
 */
export function purgeExpiredTraces(
  retentionMs: number,
  now = Date.now(),
): { samples: number; plans: number; alerts: number; routineRoutes: number; liveObservations: number } {
  const cutoff = now - retentionMs;
  const abandonedCutoff = now - Math.max(retentionMs, ABANDONED_TRIP_MS);
  // Ativa: abandono conta do último envio de amostras pelo relógio do servidor, não da idade da viagem
  // nem do `t` das amostras, que vem do aparelho e pode estar no futuro.
  const expired = `SELECT id FROM trips WHERE (status != 'active' AND finished_at < ?)
    OR (status = 'active' AND COALESCE(last_sample_at, started_at) < ?)`;
  return transaction(() => {
    const samples = db.prepare(`DELETE FROM samples WHERE trip_id IN (${expired})`).run(cutoff, abandonedCutoff);
    const plans = db
      .prepare(`DELETE FROM plans WHERE created_at < ? AND id NOT IN (SELECT plan_id FROM trip_legs WHERE trip_id NOT IN (${expired}))`)
      .run(cutoff, cutoff, abandonedCutoff);
    db.prepare('DELETE FROM alert_votes WHERE alert_id IN (SELECT id FROM alerts WHERE expires_at < ?)').run(cutoff);
    const alerts = db.prepare('DELETE FROM alerts WHERE expires_at < ?').run(cutoff);
    const routineRoutes = purgeExpiredRoutineRoutes(now);
    const liveObservations = purgeLive(now);
    return { samples: Number(samples.changes), plans: Number(plans.changes), alerts: Number(alerts.changes), routineRoutes, liveObservations };
  });
}


const OWN_TRIPS = 'trip_id IN (SELECT id FROM trips WHERE user_id = ?)';

/**
 * Tudo o que o servidor guarda ligado a um usuário; exportar e apagar usam a mesma lista.
 * Filhos antes de `trips`, porque o filtro deles depende das viagens. O hash do token do aparelho não é exportado.
 * O agregado (`CROWD`) não guarda quem contribuiu, então não entra aqui.
 */
const USER_TABLES: { table: string; where: string; columns?: string }[] = [
  { table: 'samples', where: OWN_TRIPS },
  { table: 'trip_legs', where: OWN_TRIPS },
  { table: 'trips', where: 'user_id = ?' },
  { table: 'plans', where: 'user_id = ?' },
  { table: 'stats', where: 'user_id = ?' },
  { table: 'anomalies', where: 'user_id = ?' },
  { table: 'places', where: 'user_id = ?' },
  { table: 'routines', where: 'user_id = ?' },
  { table: 'routine_routes', where: 'user_id = ?' },
  { table: 'prefs', where: 'user_id = ?' },
  { table: 'privacy', where: 'user_id = ?' },
  { table: 'live_obs', where: 'user_id = ?' },
  { table: 'alerts', where: 'reporter = ?' },
  { table: 'alert_votes', where: 'user_id = ?' },
  { table: 'devices', where: 'user_id = ?', columns: 'id, created_at, last_seen_at, revoked_at' },
];

export interface UserDataExport {
  userId: string;
  exportedAt: string;
  tables: Record<string, Row[]>;
}

export function exportUserData(userId: string): UserDataExport {
  const tables: Record<string, Row[]> = {};
  for (const t of USER_TABLES) tables[t.table] = db.prepare(`SELECT ${t.columns ?? '*'} FROM ${t.table} WHERE ${t.where}`).all(userId) as Row[];
  return { userId, exportedAt: new Date().toISOString(), tables };
}

/**
 * Apaga todos os dados do usuário, inclusive os aparelhos: o token deixa de valer.
 * Alertas que ele criou continuam para a comunidade, sem autor; os votos dele saem, e a contagem do alerta fica.
 * O id vai para `deleted_users` (só o id, sem data), e `registerDevice` não o adota de novo.
 */
export function deleteUserData(userId: string): Record<string, number> {
  return transaction(() => {
    const deleted: Record<string, number> = {};
    for (const t of USER_TABLES) {
      const sql = t.table === 'alerts' ? `UPDATE alerts SET reporter = '${CROWD}' WHERE ${t.where}` : `DELETE FROM ${t.table} WHERE ${t.where}`;
      deleted[t.table] = Number(db.prepare(sql).run(userId).changes);
    }
    db.prepare('INSERT OR IGNORE INTO deleted_users (user_id) VALUES (?)').run(userId);
    return deleted;
  });
}

// ---------- alertas ----------

export const toAlert = (r: Row): RoadAlert => ({
  id: String(r.id),
  type: String(r.type) as RoadAlert['type'],
  lat: Number(r.lat),
  lon: Number(r.lon),
  note: r.note === null ? null : String(r.note),
  createdAt: new Date(Number(r.created_at)).toISOString(),
  expiresAt: new Date(Number(r.expires_at)).toISOString(),
  upvotes: Number(r.up),
  downvotes: Number(r.down),
});

export function alertsInBox(minLat: number, minLon: number, maxLat: number, maxLon: number, now = Date.now()): RoadAlert[] {
  return (
    db
      .prepare('SELECT * FROM alerts WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? AND expires_at > ? LIMIT 500')
      .all(minLat, maxLat, minLon, maxLon, now) as Row[]
  ).map(toAlert);
}
