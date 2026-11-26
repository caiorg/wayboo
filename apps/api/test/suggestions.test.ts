import { randomBytes } from 'node:crypto';
import { BINS_PER_DAY, localTime, type Coord, type Suggestion } from '@wayboo/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { db, getPlaces, getRoutineRoutes, newPlace, saveRoutine, saveRoutineRoutes, upsertPlace } from '../src/db';
import { currentWeather } from '../src/providers/geo-services';
import { encodePolyline } from './helpers';

// Espião em `getPlaces` para saber quando um pedido de `/suggestions` chegou a `routinePlan` (ver `concurrently`).
vi.mock('../src/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/db')>();
  return { ...actual, getPlaces: vi.fn(actual.getPlaces) };
});
// Espião em `currentWeather`: o clima fica em cache por lugar, então segurar o `fetch` não basta para prender a espera.
vi.mock('../src/providers/geo-services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/providers/geo-services')>();
  return { ...actual, currentWeather: vi.fn(actual.currentWeather) };
});

const TZ = 'America/Sao_Paulo';
/** Quarta-feira às 15h em `TZ`: os avanços de tempo dos testes não trocam o tipo de dia da rotina. */
const WEDNESDAY_3PM = new Date('2026-11-18T15:00:00-03:00');
const HOME: Coord = [-46.65, -23.56];
const WORK: Coord = [-46.62, -23.59];

const n = 40;
const shape = Array.from({ length: n + 1 }, (_, i): Coord => [HOME[0] + ((WORK[0] - HOME[0]) * i) / n, HOME[1] + ((WORK[1] - HOME[1]) * i) / n]);
const VALHALLA = {
  trip: {
    legs: [
      {
        shape: encodePolyline(shape),
        maneuvers: [
          { type: 1, street_names: ['Rua A'], length: 4.5, time: 400, begin_shape_index: 0, end_shape_index: n },
          { type: 4, length: 0, time: 0, begin_shape_index: n, end_shape_index: n },
        ],
      },
    ],
    summary: { length: 4.5, time: 400 },
  },
};

const routerCalls = vi.fn();
/** Status HTTP que o roteador devolve; 200 responde a rota. */
let routerStatus = 200;
/** Enquanto definida, o roteador só responde depois que ela resolve. */
let routerGate: Promise<void> | null = null;
/** Segura a resposta do roteador até chamar a função devolvida. */
function holdRouter() {
  let release!: () => void;
  routerGate = new Promise((resolve) => (release = resolve));
  return release;
}
/**
 * Abre as sugestões duas vezes ao mesmo tempo com o roteador seguro. Confere que, com os dois pedidos já
 * dentro do servidor, houve uma chamada ao roteador e nenhum terminou; então libera e devolve as respostas.
 */
async function concurrently<T>(open: () => Promise<T>) {
  const release = holdRouter();
  let finished = 0;
  const placesBefore = vi.mocked(getPlaces).mock.calls.length;
  const track = (p: Promise<T>) => p.finally(() => finished++);
  const both = Promise.all([track(open()), track(open())] as const);
  // `suggestions` lê os lugares e chega à checagem do mapa em `routinePlan` sem nenhum `await` no meio, e o
  // roteador é chamado no mesmo passo. Com duas leituras, os dois pedidos já passaram por ali.
  await vi.waitFor(() => expect(vi.mocked(getPlaces).mock.calls.length - placesBefore).toBe(2));
  expect(routerCalls).toHaveBeenCalledTimes(1);
  expect(finished).toBe(0);
  release();
  return both;
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(() => app.close());

const defaults = { ...config.suggestions };
beforeEach(() => {
  routerCalls.mockClear();
  routerStatus = 200;
  routerGate = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith(`${config.valhallaUrl}/route`)) {
        routerCalls(url);
        await routerGate;
        return routerStatus === 200 ? json(VALHALLA) : new Response('falhou', { status: routerStatus });
      }
      if (url.startsWith(config.openMeteoUrl)) return json({ current: { precipitation: 0, weather_code: 0, visibility: 10000 } });
      throw new Error(`fetch inesperado: ${url}`);
    }),
  );
});
afterEach(() => {
  // Descarta um `mockImplementationOnce` que sobrou de um teste que falhou antes de consumi-lo.
  vi.mocked(currentWeather).mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.assign(config.suggestions, defaults);
});

/** Usuário com casa, trabalho e o hábito de ir de casa ao trabalho em qualquer horário. */
async function commuter() {
  const token = randomBytes(32).toString('base64url');
  const { userId } = (await app.inject({ method: 'POST', url: '/auth/device', payload: { token } })).json<{ userId: string }>();
  const home = { ...newPlace(HOME[1], HOME[0]), kind: 'home' as const, visits: 10 };
  const work = { ...newPlace(WORK[1], WORK[0]), kind: 'work' as const, visits: 10 };
  upsertPlace(userId, home);
  upsertPlace(userId, work);
  const now = Date.now();
  saveRoutine(userId, { originId: home.id, destId: work.id, dayType: localTime(now, TZ).dayType, hist: Array(BINS_PER_DAY).fill(1), t: now });
  const request = (here: Coord = HOME) =>
    app.inject({
      method: 'GET',
      url: `/suggestions?lat=${here[1]}&lon=${here[0]}`,
      headers: { authorization: `Bearer ${token}`, 'x-time-zone': TZ },
    });
  const open = async (here: Coord = HOME) => {
    const res = await request(here);
    expect(res.statusCode).toBe(200);
    return res.json<{ suggestions: Suggestion[] }>().suggestions;
  };
  return Object.assign(open, { request, userId, token });
}

describe('cache das sugestões de rotina', () => {
  it('duas aberturas seguidas no mesmo lugar chamam o roteador uma vez só', async () => {
    const open = await commuter();
    const first = await open();
    const second = await open();

    expect(routerCalls).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.plan.planId).not.toBe(first[0]!.plan.planId);
    expect(second[0]!.plan.routes[0]!.route.geometry).toEqual(first[0]!.plan.routes[0]!.route.geometry);
    expect(second[0]!.plan.routes[0]!.route.id).not.toBe(first[0]!.plan.routes[0]!.route.id);
  });

  it('duas aberturas simultâneas chamam o roteador uma vez só', async () => {
    const open = await commuter();
    const [first, second] = await concurrently(() => open());

    expect(routerCalls).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.plan.planId).not.toBe(first[0]!.plan.planId);
  });

  it('falha do roteador chega às aberturas simultâneas e não fica guardada', async () => {
    const open = await commuter();
    routerStatus = 503;
    const failed = await concurrently(() => open.request());
    expect(failed.map((r) => r.statusCode >= 500)).toEqual([true, true]);
    expect(routerCalls).toHaveBeenCalledTimes(1);

    routerStatus = 200;
    expect(await open()).toHaveLength(1);
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('cada usuário tem a própria rota guardada', async () => {
    await (await commuter())();
    await (await commuter())();
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('chama o roteador de novo quando a rota guardada passa da idade máxima', async () => {
    config.suggestions.routeMaxAgeMs = 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now: WEDNESDAY_3PM });
    const open = await commuter();
    await open();
    vi.advanceTimersByTime(30_000);
    await open();
    expect(routerCalls).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    await open();
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('apaga as rotas guardadas que passaram da idade máxima', async () => {
    config.suggestions.routeMaxAgeMs = 60_000;
    vi.useFakeTimers({ toFake: ['Date'], now: WEDNESDAY_3PM });
    db.exec('DELETE FROM routine_routes');
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM routine_routes').get() as { n: number }).n;
    await (await commuter())();
    expect(count()).toBe(1);
    vi.advanceTimersByTime(61_000);
    await (await commuter())();
    expect(count()).toBe(1);
  });

  it('apaga as rotas vencidas na leitura, mesmo sem gravar outra', () => {
    config.suggestions.routeMaxAgeMs = 60_000;
    db.exec('DELETE FROM routine_routes');
    const from = { lat: HOME[1], lon: HOME[0] };
    const to = { lat: WORK[1], lon: WORK[0] };
    saveRoutineRoutes('u1', 'a', 'b', { from, to, fetchedAt: Date.now() - 61_000, routes: [] });
    saveRoutineRoutes('u2', 'a', 'b', { from, to, fetchedAt: Date.now(), routes: [] });
    expect(getRoutineRoutes('u3', 'a', 'b')).toBeNull();
    expect(db.prepare('SELECT user_id FROM routine_routes').all()).toEqual([{ user_id: 'u2' }]);
  });

  it('chama o roteador de novo quando o usuário está longe da origem da rota guardada', async () => {
    config.suggestions.routeRadiusM = 50;
    const open = await commuter();
    await open();
    // ~110 m ao norte: ainda é "casa" (raio de 300 m), mas fora do raio da rota guardada.
    const nearby: Coord = [HOME[0], HOME[1] + 0.001];
    await open(nearby);
    expect(routerCalls).toHaveBeenCalledTimes(2);
    await open(nearby);
    expect(routerCalls).toHaveBeenCalledTimes(2);
  });

  it('não grava o plano da rota guardada quando DELETE /me chega durante a espera do clima', async () => {
    const open = await commuter();
    await open();
    expect(routerCalls).toHaveBeenCalledTimes(1);

    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.mocked(currentWeather).mockImplementationOnce(async () => {
      entered();
      await gate;
      return null;
    });
    const pending = open.request();
    await waiting;
    const del = await app.inject({ method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${open.token}` } });
    expect(del.statusCode).toBe(200);
    release();

    const res = await pending;
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'Dados do usuário apagados durante o planejamento' });
    expect(routerCalls).toHaveBeenCalledTimes(1);
    const rows = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(open.userId) as { n: number }).n;
    expect(rows('plans')).toBe(0);
    expect(rows('routine_routes')).toBe(0);
  });
});
