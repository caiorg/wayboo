import { randomBytes, randomUUID } from 'node:crypto';
import { buildSegments, cumulativeDistances, simulateDrive, type Coord, type Maneuver, type PlanResponse, type Route } from '@wayboo/core';
import type { buildApp } from '../src/app';

export const TZ = 'America/Sao_Paulo';

/** Polyline com precisão 6, o formato que o Valhalla devolve em `shape`. */
export { encodePolyline } from '@wayboo/core';

/** Rota sintética de ~4,5 km com uma curva, a 12 m/s no roteador. */
export function makeRoute(): Route {
  const from: Coord = [-46.65, -23.56];
  const to: Coord = [-46.62, -23.59];
  const n = 80;
  const mid: Coord = [(from[0] + to[0]) / 2 + 0.004, (from[1] + to[1]) / 2];
  const geometry: Coord[] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const [a, b, g] = f < 0.5 ? [from, mid, f * 2] : [mid, to, (f - 0.5) * 2];
    geometry.push([a[0] + (b[0] - a[0]) * g, a[1] + (b[1] - a[1]) * g]);
  }
  const cum = cumulativeDistances(geometry);
  const m = (type: number, b: number, e: number): Maneuver => ({
    type,
    instruction: 'Siga',
    streetNames: [],
    distanceM: cum[e]! - cum[b]!,
    durationS: (cum[e]! - cum[b]!) / 12,
    beginIdx: b,
    endIdx: e,
    toll: false,
    highway: false,
  });
  const maneuvers = [m(1, 0, n / 2), m(15, n / 2, n), m(4, n, n)];
  return {
    id: randomUUID(),
    geometry,
    distanceM: cum[n]!,
    baseDurationS: cum[n]! / 12,
    maneuvers,
    hasToll: false,
    hasHighway: false,
    hasFerry: false,
    highwayShare: 0,
    segments: buildSegments(geometry, maneuvers),
    provider: 'test',
  };
}

type App = Awaited<ReturnType<typeof buildApp>>;
export type User = { userId: string; token: string };
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Chamadas autenticadas à API. `app` é lido na hora da chamada porque o teste o cria no `beforeAll`. */
export function client(app: () => App, route: Route) {
  const [lon0, lat0] = route.geometry[0]!;
  const [lon1, lat1] = route.geometry[route.geometry.length - 1]!;

  async function register(): Promise<User> {
    const token = randomBytes(32).toString('base64url');
    const res = await app().inject({ method: 'POST', url: '/auth/device', payload: { token } });
    return { ...res.json<{ userId: string }>(), token };
  }

  async function call<T>(user: User, method: Method, url: string, payload?: object) {
    const res = await app().inject({ method, url, headers: { authorization: `Bearer ${user.token}` }, payload });
    return { status: res.statusCode, body: res.json<T>(), headers: res.headers };
  }

  const planRequest = { origin: { lat: lat0, lon: lon0 }, destination: { lat: lat1, lon: lon1 }, timeZone: TZ };
  const plan = async (user: User) => (await call<PlanResponse>(user, 'POST', '/plan', planRequest)).body;

  /** Planeja e inicia a viagem, envia o rastro com trânsito 1,8× o previsto e, se `finish`, encerra pela API. */
  async function drive(user: User, finish = true) {
    const p = await plan(user);
    const { body: trip } = await call<{ tripId: string }>(user, 'POST', '/trips', { planId: p.planId, routeIndex: 0, timeZone: TZ });
    const r = p.routes[0]!.route;
    const samples = [...simulateDrive(r, r.segments.map((s) => s.baseDurationS * 1.8), Date.now() + 1000, 2)];
    await call(user, 'POST', `/trips/${trip.tripId}/samples`, { samples });
    const finished = finish ? (await call<{ learnedSegments: number }>(user, 'POST', `/trips/${trip.tripId}/finish`)).body : null;
    return { planId: p.planId, tripId: trip.tripId, finished };
  }

  return { register, call, planRequest, plan, drive };
}
