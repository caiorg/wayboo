import { randomUUID } from 'node:crypto';
import {
  binLabel,
  choiceProbabilities,
  cumulativeDistances,
  DAY_TYPE_LABEL,
  departureOptions,
  distanceToPolyline,
  estimateSegment,
  localTime,
  matchPlace,
  PLACE_KIND_LABEL,
  pointAlong,
  predictEta,
  routeFeatures,
  statKey,
  utility,
  type AlertType,
  type Candidate,
  type HolidayCalendar,
  type HolidayRegion,
  type KnownPlace,
  type Place,
  type PlannedRoute,
  type PlanRequestSchema,
  type PlanResponse,
  type PreferenceWeights,
  type RoadAlert,
  type Route,
  type RouteFeatures,
  type SlowSpot,
  type StatsMap,
  type TripContext,
  type WeatherNow,
} from '@wayboo/core';
import type { z } from 'zod';
import { alertsInBox, CROWD, deletionTicket, getPlaces, getPrefs, loadStats, savePlan } from '../db';
import { currentWeather, weatherFlags } from '../providers/geo-services';
import { HttpError } from '../providers/http';
import { valhalla } from '../providers/routing';
import { regionAt, regionalCalendar } from '../holidays';

export type Priority = 'fastest' | 'reliable' | 'familiar' | 'shortest' | null;

/** Atraso médio estimado por tipo de alerta à frente (s). */
const ALERT_PENALTY_S: Record<AlertType, number> = {
  accident: 240,
  traffic: 300,
  road_closed: 900,
  flood: 600,
  hazard: 30,
  pothole: 10,
  police: 0,
  speed_camera: 0,
};

export function knownPlace(p: Place | null): KnownPlace | null {
  if (!p) return null;
  return { id: p.id, kind: p.kind, name: p.name, label: p.name ?? PLACE_KIND_LABEL[p.kind], lat: p.lat, lon: p.lon, visits: p.visits };
}

function alertsOnRoute(route: Route, alerts: RoadAlert[]): RoadAlert[] {
  const cum = cumulativeDistances(route.geometry);
  return alerts.filter((a) => distanceToPolyline(route.geometry, cum, [a.lon, a.lat]).offsetM < 35);
}

function slowSpots(
  route: Route,
  segDur: number[],
  departAt: number,
  timeZone: string,
  calendar: HolidayCalendar,
  user: StatsMap,
  crowd: StatsMap,
): SlowSpot[] {
  const lt = localTime(departAt, timeZone, calendar);
  const cum = cumulativeDistances(route.geometry);
  const spots: (SlowSpot & { endM: number })[] = [];
  let elapsed = 0;
  route.segments.forEach((s, i) => {
    const bin = Math.floor(((lt.minuteOfDay + elapsed / 60) % 1440) / 30);
    elapsed += segDur[i] ?? s.baseDurationS;
    if (s.baseDurationS < 4) return;
    const e = estimateSegment(s.key, lt.dayType, bin, user, crowd, departAt);
    const factor = Math.exp(e.mean);
    if (factor < 1.5 || e.userW + e.crowdW < 2) return;
    const last = spots[spots.length - 1];
    if (last && s.startM - last.endM < 300) {
      last.factor = Math.max(last.factor, factor);
      last.endM = s.endM;
      return;
    }
    const mid = pointAlong(route.geometry, cum, (s.startM + s.endM) / 2);
    spots.push({
      lat: mid[1],
      lon: mid[0],
      factor,
      observations: Math.round(e.userW + e.crowdW),
      when: `${DAY_TYPE_LABEL[lt.dayType]}, ${binLabel(bin)}`,
      endM: s.endM,
    });
  });
  return spots.map(({ endM: _, ...rest }) => rest);
}

function familiarity(route: Route, user: StatsMap): number {
  const total = route.segments.reduce((a, s) => a + s.baseDurationS, 0);
  if (total <= 0) return 0;
  const known = route.segments.filter((s) => (user.get(statKey.seg(s.key))?.w ?? 0) >= 0.8).reduce((a, s) => a + s.baseDurationS, 0);
  return known / total;
}

function adjustWeights(w: PreferenceWeights, priority: Priority): PreferenceWeights {
  switch (priority) {
    case 'reliable':
      return { ...w, uncertaintyMin: w.uncertaintyMin * 4 - 0.3 };
    case 'familiar':
      return { ...w, familiarity: Math.max(1.5, w.familiarity * 3) };
    case 'shortest':
      return { ...w, deltaKm: -0.8 };
    case 'fastest':
      return { ...w, deltaMin: Math.min(w.deltaMin, -1), toll: w.toll * 0.2, familiarity: w.familiarity * 0.2, turnsPerKm: 0, highwayShare: 0 };
    default:
      return w;
  }
}

const REASON: Partial<Record<keyof RouteFeatures, string>> = {
  toll: 'Evita pedágio, como você costuma preferir.',
  familiarity: 'É o caminho que você costuma fazer.',
  uncertaintyMin: 'É mais previsível, com menos variação de tempo.',
  alerts: 'Tem menos alertas da comunidade.',
  turnsPerKm: 'Tem menos conversões.',
  deltaKm: 'É mais curta.',
  highwayShare: 'Usa o tipo de via que você prefere.',
};

function explain(candidates: PlannedRoute[], rec: number, w: PreferenceWeights): string {
  const byLearned = candidates.reduce((b, c, i) => (c.eta.durationS < candidates[b]!.eta.durationS ? i : b), 0);
  const byBase = candidates.reduce((b, c, i) => (c.eta.baseDurationS < candidates[b]!.eta.baseDurationS ? i : b), 0);
  if (rec === byLearned) {
    if (byLearned !== byBase) return 'Pelo trânsito que você costuma pegar neste horário, esta fica mais rápida, embora o roteador indique outra.';
    return candidates.length > 1 ? 'É a mais rápida considerando o que foi aprendido sobre este horário.' : 'Única rota viável encontrada.';
  }
  const a = candidates[rec]!.features;
  const b = candidates[byLearned]!.features;
  let bestKey: keyof RouteFeatures | null = null;
  let bestGain = 0;
  for (const k of Object.keys(REASON) as (keyof RouteFeatures)[]) {
    const gain = w[k] * (a[k] - b[k]);
    if (gain > bestGain) {
      bestGain = gain;
      bestKey = k;
    }
  }
  return bestKey ? REASON[bestKey]! : 'Melhor equilíbrio entre tempo e suas preferências.';
}

function tagRoutes(routes: PlannedRoute[]): void {
  const argmin = (f: (r: PlannedRoute) => number) => routes.reduce((b, r, i) => (f(r) < f(routes[b]!) ? i : b), 0);
  if (routes.length > 1) {
    routes[argmin((r) => r.eta.durationS)]!.tags.push('Mais rápida');
    const reliable = argmin((r) => r.eta.p90S - r.eta.p10S);
    if (routes[reliable]!.eta.p90S - routes[reliable]!.eta.p10S < 0.8 * Math.max(...routes.map((r) => r.eta.p90S - r.eta.p10S))) {
      routes[reliable]!.tags.push('Mais previsível');
    }
    const shortest = argmin((r) => r.route.distanceM);
    if (routes[shortest]!.route.distanceM < 0.95 * Math.max(...routes.map((r) => r.route.distanceM))) routes[shortest]!.tags.push('Mais curta');
    if (routes.some((r) => r.route.hasToll)) for (const r of routes) if (!r.route.hasToll) r.tags.push('Sem pedágio');
  }
  for (const r of routes) {
    if (r.route.hasToll) r.tags.push('Pedágio');
    if (r.familiarity >= 0.7) r.tags.push('Seu caminho de sempre');
    if (r.alerts.length) r.tags.push(`${r.alerts.length} alerta${r.alerts.length > 1 ? 's' : ''}`);
  }
}

export interface PlanInternals {
  user: StatsMap;
  crowd: StatsMap;
  places: Place[];
}

/** `ticket` vem de `deletionTicket()` no início do pedido; o padrão serve quando `plan` é a primeira espera. */
export async function plan(
  userId: string,
  req: z.output<typeof PlanRequestSchema>,
  priority: Priority = null,
  ticket = deletionTicket(),
): Promise<PlanResponse> {
  const [routes, weather, region] = await Promise.all([
    valhalla.route([req.origin, ...req.waypoints, req.destination], req.options, req.reroute ? 1 : 2),
    currentWeather(req.origin.lat, req.origin.lon),
    regionAt(req.origin, req.timeZone),
  ]);
  return evaluatePlan(userId, req, routes, weather, priority, ticket, region);
}

/**
 * Avalia rotas já obtidas com o que foi aprendido (separado para testes e simulação sem rede).
 * `ticket` vem de `deletionTicket()` no início do pedido, antes de esperar os provedores.
 * `region` (de `regionAt`) acrescenta os feriados estaduais e municipais; null usa só o calendário do fuso.
 */
export function evaluatePlan(
  userId: string,
  req: z.output<typeof PlanRequestSchema>,
  routes: Route[],
  weather: WeatherNow | null,
  priority: Priority = null,
  ticket = deletionTicket(),
  region: HolidayRegion | null = null,
): PlanResponse {
  const departAt = req.departAt ?? Date.now();
  const calendar = regionalCalendar(req.timeZone, region);

  const segKeys = routes.flatMap((r) => r.segments.map((s) => s.key));
  const user = loadStats(userId, segKeys);
  const crowd = loadStats(CROWD, segKeys);
  const places = getPlaces(userId);
  const originPlace = matchPlace(places, req.origin.lat, req.origin.lon);
  const destinationPlace = matchPlace(places, req.destination.lat, req.destination.lon);
  const odKey = originPlace && destinationPlace ? statKey.od(originPlace.id, destinationPlace.id) : null;

  const lats = routes.flatMap((r) => r.geometry.map((c) => c[1]));
  const lons = routes.flatMap((r) => r.geometry.map((c) => c[0]));
  const alerts = alertsInBox(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
  const wf = weatherFlags(weather);
  const baseCtx: TripContext = { ...wf, alertsOnRoute: 0 };

  const draft = routes.map((route) => {
    const onRoute = alertsOnRoute(route, alerts);
    const ctx = { ...baseCtx, alertsOnRoute: onRoute.length };
    const alertPenaltyS = onRoute.reduce((a, x) => a + ALERT_PENALTY_S[x.type], 0);
    const eta = predictEta({ route, departAt, timeZone: req.timeZone, user, crowd, ctx, odKey, alertPenaltyS, calendar });
    return { route, eta, alerts: onRoute, familiarity: familiarity(route, user), ctx, alertPenaltyS };
  });

  const candidates: Candidate[] = draft.map((d) => ({ route: d.route, eta: d.eta, familiarity: d.familiarity, alerts: d.alerts.length }));
  const features = routeFeatures(candidates);
  const weights = adjustWeights(getPrefs(userId).weights, priority);
  const probs = choiceProbabilities(features, weights);

  const planned: PlannedRoute[] = draft.map((d, i) => ({
    route: d.route,
    eta: d.eta,
    features: features[i]!,
    utility: utility(features[i]!, weights),
    probability: probs[i]!,
    familiarity: d.familiarity,
    alerts: d.alerts,
    slowSpots: slowSpots(d.route, d.eta.segmentDurationsS, departAt, req.timeZone, calendar, user, crowd),
    tags: [],
  }));
  tagRoutes(planned);
  const recommendedIndex = planned.reduce((b, r, i) => (r.utility > planned[b]!.utility ? i : b), 0);
  const rec = draft[recommendedIndex]!;

  const departures = req.reroute
    ? []
    : departureOptions(
        { route: rec.route, timeZone: req.timeZone, user, crowd, ctx: rec.ctx, odKey, alertPenaltyS: rec.alertPenaltyS, calendar },
        departAt,
        [0, 10, 20, 30, 45, 60, 90],
      );

  const conf = rec.eta.confidence;
  const result: PlanResponse = {
    planId: randomUUID(),
    createdAt: Date.now(),
    departAt,
    origin: req.origin,
    destination: req.destination,
    destinationName: req.destinationName ?? null,
    waypoints: req.waypoints,
    originPlace: knownPlace(originPlace),
    destinationPlace: knownPlace(destinationPlace),
    routes: planned,
    recommendedIndex,
    reason: explain(planned, recommendedIndex, weights),
    context: { ...baseCtx, weather },
    departures,
    learningLevel: conf < 0.05 ? 'nenhum' : conf < 0.3 ? 'inicial' : conf < 0.7 ? 'bom' : 'alto',
    holidayRegion: region,
  };
  // Usuário apagado durante o planejamento. 409, não 401: com 401 o app registraria o aparelho e repetiria o pedido.
  if (!savePlan(userId, result, ticket)) throw new HttpError(409, 'Dados do usuário apagados durante o planejamento');
  return result;
}
