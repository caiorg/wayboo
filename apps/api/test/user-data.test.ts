import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { db, exportUserData, purgeExpiredTraces, saveRoutineRoutes, type UserDataExport } from '../src/db';
import { client, makeRoute, TZ } from './helpers';

const ROUTE = makeRoute();
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Com `hold`, o roteador avisa que foi chamado e espera `release`: simula provedor lento. */
let hold: { entered: () => void; release: Promise<void> } | null = null;
vi.mock('../src/providers/routing', () => ({
  valhalla: {
    name: 'test',
    route: async () => {
      if (hold) {
        hold.entered();
        await hold.release;
      }
      return [structuredClone(ROUTE)];
    },
  },
}));
vi.mock('../src/providers/geo-services', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/geo-services')>()),
  currentWeather: async () => null,
  geocode: async () => [{ name: 'Destino', label: 'Destino', lat: ROUTE.geometry.at(-1)![1], lon: ROUTE.geometry.at(-1)![0], category: null }],
}));
/** Como `hold`, mas na interpretação do pedido do assistente (modelo de linguagem lento). */
let intentHold: { entered: () => void; release: Promise<void> } | null = null;
vi.mock('../src/ai/planner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/planner')>();
  return {
    ...actual,
    parseIntent: async (...args: Parameters<typeof actual.parseIntent>) => {
      if (intentHold) {
        intentHold.entered();
        await intentHold.release;
      }
      return actual.parseIntent(...args);
    },
  };
});

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const api = client(() => app, ROUTE);
const { register, call } = api;

const count = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
const samplesOf = (tripId: string) => count('SELECT COUNT(*) AS n FROM samples WHERE trip_id = ?', tripId);
const planExists = (planId: string) => count('SELECT COUNT(*) AS n FROM plans WHERE id = ?', planId) === 1;

describe('retenção dos rastros GPS', () => {
  it('apaga o rastro e o plano da viagem encerrada depois do prazo e mantém o aprendizado', async () => {
    const user = await register();
    const { tripId, planId } = await api.drive(user);
    const stats = count('SELECT COUNT(*) AS n FROM stats WHERE user_id = ?', user.userId);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(stats).toBeGreaterThan(0);

    purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS - HOUR_MS);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(planExists(planId)).toBe(true);

    const purged = purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS + HOUR_MS);
    expect(purged.samples).toBeGreaterThan(0);
    expect(samplesOf(tripId)).toBe(0);
    expect(planExists(planId)).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM trips WHERE id = ?', tripId)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM stats WHERE user_id = ?', user.userId)).toBe(stats);
  });

  it('viagem em andamento só perde o rastro quando é abandonada', async () => {
    const { tripId, planId } = await api.drive(await register(), false);

    purgeExpiredTraces(0, Date.now() + HOUR_MS);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(planExists(planId)).toBe(true);

    purgeExpiredTraces(0, Date.now() + DAY_MS + HOUR_MS);
    expect(samplesOf(tripId)).toBe(0);
  });

  it('abandono conta do último envio de amostras, não do início da viagem', async () => {
    const user = await register();
    const { tripId, planId } = await api.drive(user, false);
    // Viagem longa: começou há 30 horas, o envio anterior foi há 25, e agora chega outro lote.
    db.prepare('UPDATE trips SET started_at = ?, last_sample_at = ? WHERE id = ?').run(Date.now() - 30 * HOUR_MS, Date.now() - 25 * HOUR_MS, tripId);
    const late = { t: Date.now() - 25 * HOUR_MS, lat: -23.5, lon: -46.6 };
    expect((await call(user, 'POST', `/trips/${tripId}/samples`, { samples: [late] })).status).toBe(200);

    purgeExpiredTraces(DAY_MS);
    expect(samplesOf(tripId)).toBeGreaterThan(0);
    expect(planExists(planId)).toBe(true);
  });

  it('abandono usa o relógio do servidor, não o horário que o aparelho manda', async () => {
    const user = await register();
    const { tripId } = await api.drive(user, false);
    // Último envio há 30 horas, com um ponto marcado 23 horas no futuro (fica no passado em limpezas seguintes).
    const future = { t: Date.now() + 23 * HOUR_MS, lat: -23.5, lon: -46.6 };
    expect((await call(user, 'POST', `/trips/${tripId}/samples`, { samples: [future] })).status).toBe(200);
    db.prepare('UPDATE trips SET started_at = ?, last_sample_at = ? WHERE id = ?').run(Date.now() - 31 * HOUR_MS, Date.now() - 30 * HOUR_MS, tripId);

    purgeExpiredTraces(DAY_MS);
    expect(samplesOf(tripId)).toBe(0);
  });

  it('apaga alertas e votos expirados há mais que o prazo', async () => {
    const reporter = await register();
    const voter = await register();
    // Buraco dura 14 dias; acidente, 45 minutos.
    const { body: kept } = await call<{ id: string }>(reporter, 'POST', '/alerts', { type: 'pothole', lat: -22.9, lon: -43.2 });
    const { body: gone } = await call<{ id: string }>(reporter, 'POST', '/alerts', { type: 'accident', lat: -22.8, lon: -43.1 });
    await call(voter, 'POST', `/alerts/${gone.id}/vote`, { up: false });
    const alertExists = (id: string) => count('SELECT COUNT(*) AS n FROM alerts WHERE id = ?', id) === 1;

    purgeExpiredTraces(DAY_MS, Date.now() + 2 * HOUR_MS);
    expect(alertExists(gone.id)).toBe(true);

    const purged = purgeExpiredTraces(DAY_MS, Date.now() + DAY_MS + 2 * HOUR_MS);
    expect(purged.alerts).toBeGreaterThan(0);
    expect(alertExists(gone.id)).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM alert_votes WHERE alert_id = ?', gone.id)).toBe(0);
    expect(alertExists(kept.id)).toBe(true);
  });

  it('apaga as rotas guardadas vencidas sem consulta a /suggestions e mantém as recentes', () => {
    const now = Date.now();
    const maxAge = config.suggestions.routeMaxAgeMs;
    const p = { lat: -23.56, lon: -46.65 };
    const [old, recent] = [randomUUID(), randomUUID()];
    saveRoutineRoutes(old, 'a', 'b', { from: p, to: p, fetchedAt: now - maxAge - 1, routes: [] });
    saveRoutineRoutes(recent, 'a', 'b', { from: p, to: p, fetchedAt: now - maxAge + HOUR_MS, routes: [] });

    const purged = purgeExpiredTraces(DAY_MS, now);

    expect(purged.routineRoutes).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM routine_routes WHERE user_id = ?', old)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM routine_routes WHERE user_id = ?', recent)).toBe(1);
  });
});

describe('dados do usuário', () => {
  it('exportar e apagar cobrem toda tabela com user_id', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
    const withUser = tables
      .map((t) => t.name)
      .filter((name) => (db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(name, 'user_id') as unknown) !== undefined)
      // Só o id de quem apagou, para o registro não adotá-lo de novo; não é dado do usuário.
      .filter((name) => name !== 'deleted_users');
    expect(withUser.length).toBeGreaterThan(0);
    const covered = Object.keys(exportUserData('ninguem').tables);
    for (const name of withUser) expect(covered, name).toContain(name);
  });

  it('exige autenticação', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/export' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/me' })).statusCode).toBe(401);
  });

  it('exporta os dados do próprio usuário e nada de outro', async () => {
    const user = await register();
    const other = await register();
    await call(user, 'PUT', '/privacy', { shareCrowd: true });
    const { tripId, planId } = await api.drive(user);
    await api.drive(other);

    const res = await call<UserDataExport>(user, 'GET', '/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['cache-control']).toBe('no-store');
    const { tables } = res.body;
    expect(res.body.userId).toBe(user.userId);
    expect(tables.trips!.map((t) => t.id)).toEqual([tripId]);
    expect(tables.samples!.length).toBe(samplesOf(tripId));
    expect(tables.plans!.map((p) => p.id)).toEqual([planId]);
    expect(tables.stats!.length).toBeGreaterThan(0);
    expect(tables.places!.length).toBeGreaterThan(0);
    expect(tables.privacy).toEqual([expect.objectContaining({ share_crowd: 1 })]);
    expect(tables.devices).toEqual([{ id: expect.any(String), created_at: expect.any(Number), last_seen_at: expect.any(Number), revoked_at: null }]);
    expect(JSON.stringify(res.body)).not.toContain(other.userId);
  });

  it('plano em andamento durante a exclusão não é gravado, mesmo se o aparelho se registrar de novo', async () => {
    const user = await register();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      hold = { entered: resolve, release: new Promise((r) => (release = r)) };
    });
    const pending = call(user, 'POST', '/plan', api.planRequest);
    await entered;

    expect((await call(user, 'DELETE', '/me')).status).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/auth/device', payload: { token: user.token, legacyUserId: user.userId } });
    const { userId: newId } = again.json<{ userId: string }>();
    expect(newId).not.toBe(user.userId);
    hold = null;
    release();

    // 409, não 401: com 401 o app registraria o aparelho e repetiria o pedido, gravando o plano.
    expect((await pending).status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', user.userId)).toBe(0);
    // Pedido novo, depois da exclusão, grava normalmente no id novo.
    expect((await call(user, 'POST', '/plan', api.planRequest)).status).toBe(200);
    expect(count('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', user.userId)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', newId)).toBe(1);
  });

  it('assistente não grava o plano quando DELETE /me chega durante a interpretação do pedido', async () => {
    const user = await register();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      intentHold = { entered: resolve, release: new Promise((r) => (release = r)) };
    });
    const pending = call(user, 'POST', '/assistant', { text: 'ir para o Parque Ibirapuera', origin: api.planRequest.origin, timeZone: TZ });
    await entered;

    expect((await call(user, 'DELETE', '/me')).status).toBe(200);
    intentHold = null;
    release();

    expect((await pending).status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', user.userId)).toBe(0);
  });

  it('plano em curso não é gravado para id em deleted_users, mesmo sem a exclusão neste processo', async () => {
    // Simula a exclusão feita antes de reiniciar o servidor ou por outro processo: só a linha em `deleted_users`.
    const user = await register();
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      hold = { entered: resolve, release: new Promise((r) => (release = r)) };
    });
    const pending = call(user, 'POST', '/plan', api.planRequest);
    await entered;

    db.prepare('INSERT INTO deleted_users (user_id) VALUES (?)').run(user.userId);
    hold = null;
    release();

    expect((await pending).status).toBe(409);
    expect(count('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', user.userId)).toBe(0);
  });

  it('não grava routine_routes de id em deleted_users', () => {
    const id = randomUUID();
    const p = { lat: -23.5, lon: -46.6 };
    db.prepare('INSERT INTO deleted_users (user_id) VALUES (?)').run(id);
    saveRoutineRoutes(id, 'a', 'b', { from: p, to: p, fetchedAt: Date.now(), routes: [] });
    expect(count('SELECT COUNT(*) AS n FROM routine_routes WHERE user_id = ?', id)).toBe(0);
  });

  it('apagar remove tudo do usuário, invalida o token e não mexe nos dados de outro', async () => {
    const user = await register();
    const other = await register();
    await api.drive(user);
    await api.drive(other);
    const { body: mine } = await call<{ id: string }>(user, 'POST', '/alerts', { type: 'hazard', lat: -23.5, lon: -46.6 });
    const { body: theirs } = await call<{ id: string }>(other, 'POST', '/alerts', { type: 'pothole', lat: -23.4, lon: -46.5 });
    await call(user, 'POST', `/alerts/${theirs.id}/vote`, { up: true });
    const before = (await call<UserDataExport>(other, 'GET', '/me/export')).body.tables;

    const res = await call<{ deleted: Record<string, number> }>(user, 'DELETE', '/me');
    expect(res.status).toBe(200);
    expect(res.body.deleted.samples).toBeGreaterThan(0);

    const left = exportUserData(user.userId).tables;
    for (const [table, rows] of Object.entries(left)) expect(rows, table).toEqual([]);
    expect((await call(user, 'GET', '/privacy')).status).toBe(401);
    expect((await call<UserDataExport>(other, 'GET', '/me/export')).body.tables).toEqual(before);
    // O alerta continua útil para a comunidade, sem apontar para quem o criou.
    expect(db.prepare('SELECT reporter FROM alerts WHERE id = ?').get(mine.id)).toEqual({ reporter: '*' });
  });
});
