import { randomUUID } from 'node:crypto';
import {
  BINS_PER_DAY,
  binLabel,
  cumulativeDistances,
  DAY_TYPE_LABEL,
  distanceToPolyline,
  formatDurationPtBR,
  geohashCenter,
  haversine,
  localTime,
  matchPlace,
  PLACE_KIND_LABEL,
  predictTrips,
  tradeoffs,
  type AssistantResponse,
  type Insights,
  type LatLon,
  type PlanResponse,
  type StopSuggestion,
  type Suggestion,
} from '@wayboo/core';
import { parseIntent } from '../ai/planner';
import { config } from '../config';
import { db, deletionTicket, getPlaces, getPrefs, getRoutineRoutes, getRoutines, saveRoutineRoutes, statsByPrefix } from '../db';
import { currentWeather, geocode, STOP_QUERY, type BBox } from '../providers/geo-services';
import { regionAt, regionalCalendar } from '../holidays';
import { valhalla } from '../providers/routing';
import { evaluatePlan, knownPlace, plan } from './planning';

type Row = Record<string, string | number | null>;
type Log = (msg: string) => void;

const hm = (epoch: number, timeZone: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(epoch));

/** "08:30" no fuso do usuário → epoch ms do próximo horário com esse valor. */
function nextLocal(hhmm: string, timeZone: string, now = Date.now()): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const target = Number(m[1]) * 60 + Number(m[2]);
  if (target >= 1440) return null;
  let diff = target - localTime(now, timeZone).minuteOfDay;
  if (diff < -30) diff += 1440;
  return now + diff * 60_000;
}

export async function assistant(userId: string, text: string, origin: LatLon, timeZone: string, log: Log): Promise<AssistantResponse> {
  const { intent, provider } = await parseIntent(text, log);
  const fail = (message: string): AssistantResponse => ({ intent, provider, plan: null, stops: [], message });

  let destination: LatLon | null = null;
  let destinationName: string | null = null;
  if (intent.destinationPlace) {
    const place = getPlaces(userId).find((p) => p.kind === intent.destinationPlace);
    if (!place) {
      return fail(
        `Ainda não sei onde fica ${intent.destinationPlace === 'home' ? 'sua casa' : 'seu trabalho'}. Faça algumas viagens ou marque o lugar em Aprendizado.`,
      );
    }
    destination = { lat: place.lat, lon: place.lon };
    destinationName = place.name ?? PLACE_KIND_LABEL[place.kind];
  } else if (intent.destinationQuery) {
    const [hit] = await geocode(intent.destinationQuery, origin, undefined, 1);
    if (!hit) return fail(`Não encontrei "${intent.destinationQuery}".`);
    destination = { lat: hit.lat, lon: hit.lon };
    destinationName = hit.name;
  } else {
    return fail('Para onde você quer ir?');
  }

  const options = { avoidTolls: intent.avoidTolls, avoidHighways: intent.avoidHighways, avoidFerries: intent.avoidFerries };
  const stops: StopSuggestion[] = [];
  if (intent.stops.length) {
    // Rota provisória para procurar a parada perto do caminho, não só perto da origem.
    const [draft] = await valhalla.route([origin, destination], options, 0);
    if (draft) {
      const cum = cumulativeDistances(draft.geometry);
      const lats = draft.geometry.map((c) => c[1]);
      const lons = draft.geometry.map((c) => c[0]);
      const pad = 0.006;
      const bbox: BBox = [Math.min(...lons) - pad, Math.min(...lats) - pad, Math.max(...lons) + pad, Math.max(...lats) + pad];
      for (const stop of intent.stops.slice(0, 2)) {
        const q = STOP_QUERY[stop.category];
        const queries = stop.query ? [stop.query] : q.qs;
        const batches = await Promise.all(
          queries.map((term) => geocode(term, origin, stop.query ? undefined : q.tag, 10, bbox).catch(() => [])),
        );
        // A melhor parada fica colada no caminho e não logo na saída nem na chegada.
        const best = batches
          .flat()
          .map((h) => ({ h, p: distanceToPolyline(draft.geometry, cum, [h.lon, h.lat]) }))
          .filter((x) => x.p.offsetM < 600 && x.p.alongM > draft.distanceM * 0.1 && x.p.alongM < draft.distanceM * 0.9)
          .sort((a, b) => a.p.offsetM - b.p.offsetM)[0];
        if (best && !stops.some((s) => s.name === best.h.name)) {
          stops.push({ category: q.label, name: best.h.name, lat: best.h.lat, lon: best.h.lon });
        }
      }
    }
  }

  const departAt = intent.departAt ? (nextLocal(intent.departAt, timeZone) ?? undefined) : undefined;
  const result = await plan(
    userId,
    {
      origin,
      destination,
      destinationName: destinationName ?? undefined,
      waypoints: stops.map((s) => ({ lat: s.lat, lon: s.lon })),
      departAt,
      timeZone,
      options,
      reroute: false,
    },
    intent.priority,
  );

  const rec = result.routes[result.recommendedIndex]!;
  const parts = [`${destinationName}: ${formatDurationPtBR(rec.eta.durationS)}`];
  if (intent.avoidTolls) parts.push('sem pedágio');
  if (stops.length) parts.push(`parando em ${stops.map((s) => s.name).join(' e ')}`);
  if (intent.stops.length > stops.length) parts.push('não achei todas as paradas perto do caminho');
  let message = `${parts.join(', ')}.`;
  if (intent.arriveBy) {
    const target = nextLocal(intent.arriveBy, timeZone);
    if (target) {
      const leaveBy = target - rec.eta.p90S * 1000;
      message +=
        leaveBy < Date.now()
          ? ` Saindo agora a chegada provável é ${hm(Date.now() + rec.eta.durationS * 1000, timeZone)}, depois de ${intent.arriveBy}.`
          : ` Para chegar às ${intent.arriveBy} com folga, saia até ${hm(leaveBy, timeZone)}.`;
    }
  }
  return { intent, provider, plan: result, stops, message };
}

// ---------- sugestões proativas (rotina) ----------

const metersBetween = (a: LatLon, b: LatLon) => haversine([a.lon, a.lat], [b.lon, b.lat]);

/** Chamada ao roteador em andamento por rotina (usuário, origem, destino). Sai do mapa ao terminar, com ou sem erro. */
const routing = new Map<string, Promise<PlanResponse>>();

/**
 * Plano da rotina origem → destino. Reaproveita as rotas guardadas e só reavalia o ETA;
 * o roteador só é chamado se elas passaram da idade máxima ou se a origem ou o destino
 * se afastaram do raio dos pontos usados quando foram guardadas.
 * Pedidos simultâneos da mesma rotina esperam a chamada em andamento e usam a rota que ela guardou;
 * se ela falhar, recebem o mesmo erro em vez de chamar o roteador de novo.
 * `ticket` vem de `deletionTicket()` no início do pedido: as esperas aqui (chamada em andamento, clima)
 * não podem deixar gravar o plano de um usuário apagado nesse meio tempo.
 */
async function routinePlan(
  userId: string,
  originId: string,
  destId: string,
  req: Parameters<typeof plan>[1],
  ticket: number,
): Promise<PlanResponse> {
  const key = JSON.stringify([userId, originId, destId]);
  for (let running = routing.get(key); running; running = routing.get(key)) await running;
  const { routeMaxAgeMs, routeRadiusM } = config.suggestions;
  const now = Date.now();
  const saved = getRoutineRoutes(userId, originId, destId);
  if (
    saved &&
    now - saved.fetchedAt <= routeMaxAgeMs &&
    metersBetween(saved.from, req.origin) <= routeRadiusM &&
    metersBetween(saved.to, req.destination) <= routeRadiusM
  ) {
    // Ids novos: cada plano tem as próprias rotas, como no caminho que chama o roteador.
    const routes = saved.routes.map((r) => ({ ...r, id: randomUUID() }));
    const [weather, region] = await Promise.all([currentWeather(req.origin.lat, req.origin.lon), regionAt(req.origin, req.timeZone)]);
    return evaluatePlan(userId, req, routes, weather, null, ticket, region);
  }
  const running = plan(userId, req, null, ticket)
    .then((result) => {
      saveRoutineRoutes(userId, originId, destId, { from: req.origin, to: req.destination, fetchedAt: now, routes: result.routes.map((r) => r.route) });
      return result;
    })
    .finally(() => routing.delete(key));
  routing.set(key, running);
  return running;
}

export async function suggestions(userId: string, here: LatLon, timeZone: string): Promise<Suggestion[]> {
  const ticket = deletionTicket();
  const places = getPlaces(userId);
  const origin = matchPlace(places, here.lat, here.lon, 300);
  if (!origin) return [];
  const now = Date.now();
  const lt = localTime(now, timeZone, regionalCalendar(timeZone, await regionAt(here, timeZone)));
  const preds = predictTrips(getRoutines(userId), origin.id, lt, now)
    .filter((p) => p.probability >= 0.25)
    .slice(0, 2);
  const out: Suggestion[] = [];
  for (const p of preds) {
    const dest = places.find((x) => x.id === p.destId);
    if (!dest) continue;
    const result = await routinePlan(userId, origin.id, dest.id, {
      origin: here,
      destination: { lat: dest.lat, lon: dest.lon },
      destinationName: dest.name ?? PLACE_KIND_LABEL[dest.kind],
      waypoints: [],
      timeZone,
      options: { avoidTolls: false, avoidHighways: false, avoidFerries: false },
      reroute: false,
    }, ticket);
    const rec = result.routes[result.recommendedIndex]!;
    const usual = db
      .prepare("SELECT AVG(actual_s) AS avg FROM (SELECT actual_s FROM trips WHERE user_id = ? AND origin_place = ? AND dest_place = ? AND status = 'done' ORDER BY started_at DESC LIMIT 20)")
      .get(userId, origin.id, dest.id) as Row;
    const usualDurationS = usual.avg === null ? rec.eta.durationS : Number(usual.avg);
    const best = result.departures.reduce((a, b) => (b.durationS < a.durationS ? b : a), result.departures[0]!);
    const saves = result.departures[0] ? (result.departures[0].durationS - best.durationS) / 60 : 0;
    const label = knownPlace(dest)!.label;
    const delta = Math.round((rec.eta.durationS - usualDurationS) / 60);
    let message = `${label} em ${formatDurationPtBR(rec.eta.durationS)}`;
    if (delta >= 3) message += `, ${delta} min a mais que o normal`;
    else if (delta <= -3) message += `, ${-delta} min a menos que o normal`;
    if (saves >= 3) message += `. Saindo às ${hm(best.departAt, timeZone)} economiza ${Math.round(saves)} min`;
    out.push({
      place: knownPlace(dest)!,
      plan: result,
      probability: p.probability,
      typicalDeparture: binLabel(Math.floor(p.typicalDepartureMin / 30) % BINS_PER_DAY).slice(0, 5),
      durationS: rec.eta.durationS,
      usualDurationS,
      bestDeparture: saves >= 3 ? best : null,
      message: `${message}.`,
    });
  }
  return out;
}

// ---------- painel de aprendizado ----------

const CTX_LABEL: Record<string, string> = {
  rain: 'Chuva',
  heavy_rain: 'Chuva forte',
  low_visibility: 'Baixa visibilidade',
  alerts: 'Alertas na rota',
};

export function insights(userId: string): Insights {
  const totals = db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(distance_m), 0) AS m FROM trips WHERE user_id = ? AND status = 'done'")
    .get(userId) as Row;
  const places = getPlaces(userId);
  const label = (id: string) => {
    const p = places.find((x) => x.id === id);
    return p ? (p.name ?? PLACE_KIND_LABEL[p.kind]) : 'Lugar';
  };
  const routines = getRoutines(userId)
    .filter((r) => r.trips >= 2)
    .sort((a, b) => b.trips - a.trips)
    .slice(0, 8)
    .map((r) => {
      const peak = r.hist.reduce((best, v, i) => (v > (r.hist[best] ?? 0) ? i : best), 0);
      return { origin: label(r.originId), destination: label(r.destId), dayType: DAY_TYPE_LABEL[r.dayType], typicalDeparture: binLabel(peak), trips: r.trips };
    });
  const accuracy = (
    db
      .prepare(
        'SELECT id, started_at, error_base, error_learned FROM trips WHERE user_id = ? AND error_learned IS NOT NULL ORDER BY started_at DESC LIMIT 60',
      )
      .all(userId) as Row[]
  )
    .reverse()
    .map((r) => ({
      tripId: String(r.id),
      at: Number(r.started_at),
      errorBasePct: Number(r.error_base) * 100,
      errorLearnedPct: Number(r.error_learned) * 100,
    }));

  const slowSpots = statsByPrefix(userId, 'sb|', 2)
    .filter((s) => s.stat.mean > Math.log(1.5))
    .sort((a, b) => b.stat.mean - a.stat.mean)
    .slice(0, 12)
    .map(({ key, stat }) => {
      const [, seg, dayType, bin] = key.split('|');
      const cell = seg!.split('>')[1]!;
      const [lon, lat] = geohashCenter(cell);
      return {
        lat,
        lon,
        factor: Math.exp(stat.mean),
        observations: Math.round(stat.w),
        when: `${DAY_TYPE_LABEL[dayType as keyof typeof DAY_TYPE_LABEL]}, ${binLabel(Number(bin))}`,
      };
    });

  const contextFactors = statsByPrefix(userId, 'c|', 0.5).map(({ key, stat }) => ({
    label: CTX_LABEL[key.slice(2)] ?? key,
    impactPct: (Math.exp(stat.mean) - 1) * 100,
    observations: Math.round(stat.w),
  }));
  const learned = db.prepare("SELECT COUNT(*) AS n FROM stats WHERE user_id = ? AND key LIKE 's|%'").get(userId) as Row;

  return {
    trips: Number(totals.n),
    kmDriven: Number(totals.m) / 1000,
    places: places
      .filter((p) => p.visits > 0)
      .sort((a, b) => b.visits - a.visits)
      .map((p) => knownPlace(p)!),
    routines,
    accuracy,
    tradeoffs: getPrefs(userId).updates > 0 ? tradeoffs(getPrefs(userId).weights) : [],
    slowSpots,
    contextFactors,
    learnedSegments: Number(learned.n),
  };
}
