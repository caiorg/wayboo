import { randomUUID } from 'node:crypto';
import {
  analyzeTrace,
  haversine,
  inferKinds,
  learnFromTrip,
  LIVE_WINDOW_MS,
  liveObservations,
  localTime,
  matchPlace,
  recordArrival,
  recordDeparture,
  recordRoutine,
  statKey,
  updatePreferences,
  type FinishTripResponse,
  type Place,
  type TraceSample,
  type TripContext,
} from '@wayboo/core';
import {
  CROWD,
  db,
  getPlaces,
  getPlan,
  getPrefs,
  getRoutines,
  getSamples,
  getShareCrowd,
  insertSamples,
  loadStats,
  newPlace,
  saveLiveObservations,
  saveRoutine,
  savePrefs,
  saveStats,
  transaction,
  upsertPlace,
} from '../db';
import { regionalCalendar } from '../holidays';
import { HttpError } from '../providers/http';

type Row = Record<string, string | number | null>;

function ownTrip(userId: string, tripId: string): Row {
  const t = db.prepare('SELECT * FROM trips WHERE id = ? AND user_id = ?').get(tripId, userId) as Row | undefined;
  if (!t) throw new HttpError(404, 'Viagem não encontrada');
  return t;
}

export function startTrip(userId: string, planId: string, routeIndex: number, timeZone: string): { tripId: string } {
  const plan = getPlan(userId, planId);
  if (!plan) throw new HttpError(404, 'Plano não encontrado ou expirado');
  const chosen = plan.routes[routeIndex];
  if (!chosen) throw new HttpError(400, 'Rota inválida');

  const tripId = randomUUID();
  const now = Date.now();
  transaction(() => {
    db.prepare(
      `INSERT INTO trips (id, user_id, plan_id, route_index, time_zone, started_at, predicted_s, base_s, distance_m, origin_place, dest_place, ctx, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      tripId,
      userId,
      planId,
      routeIndex,
      timeZone,
      now,
      chosen.eta.durationS,
      chosen.eta.baseDurationS,
      chosen.route.distanceM,
      plan.originPlace?.id ?? null,
      plan.destinationPlace?.id ?? null,
      JSON.stringify({ ...plan.context, weather: undefined }),
    );
    db.prepare('INSERT INTO trip_legs (trip_id, seq, started_at, plan_id, route_index) VALUES (?, 0, ?, ?, ?)').run(tripId, now, planId, routeIndex);

    // A escolha entre alternativas é o sinal de preferência mais direto.
    if (plan.routes.length > 1) {
      const prefs = getPrefs(userId);
      const weights = updatePreferences(prefs.weights, plan.routes.map((r) => r.features), routeIndex);
      savePrefs(userId, weights, prefs.updates + 1);
    }
  });
  return { tripId };
}

export function addSamples(userId: string, tripId: string, samples: TraceSample[]): { stored: number } {
  const trip = ownTrip(userId, tripId);
  if (trip.status !== 'active') throw new HttpError(409, 'Viagem já encerrada');
  transaction(() => insertSamples(tripId, samples));
  if (getShareCrowd(userId)) {
    // O ao vivo é melhor esforço: uma falha aqui não pode recusar as amostras, que o app reenviaria.
    try {
      recordLiveTraffic(userId, tripId, Math.max(...samples.map((s) => s.t)));
    } catch (e) {
      console.error('Falha ao medir o trânsito ao vivo', e);
    }
  }
  return { stored: samples.length };
}

/** Folga antes da janela ao vivo, para o primeiro trecho da janela ter a amostra de entrada. */
const LIVE_LOOKBACK_MS = LIVE_WINDOW_MS + 5 * 60_000;

/**
 * Mede os trechos que o usuário (com opt-in) terminou nos últimos 15 min na etapa atual da viagem
 * e grava no trânsito ao vivo. Roda a cada envio de amostras, que o app faz a cada 15 s.
 * `lastT` é a amostra mais recente do lote, no relógio do aparelho. Vem do lote, e não do banco, para uma
 * amostra com horário absurdo afetar só o próprio envio.
 */
function recordLiveTraffic(userId: string, tripId: string, lastT: number, now = Date.now()): void {
  const leg = db.prepare('SELECT * FROM trip_legs WHERE trip_id = ? ORDER BY seq DESC LIMIT 1').get(tripId) as Row | undefined;
  if (!leg) return;
  const route = getPlan(userId, String(leg.plan_id))?.routes[Number(leg.route_index)]?.route;
  if (!route) return;
  // Como em `finishTrip`, a etapa começa em `started_at` do servidor, comparado ao `t` das amostras.
  const samples = getSamples(tripId, Math.max(Number(leg.started_at) - 5000, lastT - LIVE_LOOKBACK_MS)).filter((s) => s.t <= lastT);
  const trace = analyzeTrace(route, samples);
  saveLiveObservations(userId, liveObservations(route, trace.observations, lastT, now), now);
}

export function rerouteTrip(userId: string, tripId: string, planId: string, routeIndex: number): { seq: number } {
  const trip = ownTrip(userId, tripId);
  if (trip.status !== 'active') throw new HttpError(409, 'Viagem já encerrada');
  const plan = getPlan(userId, planId);
  if (!plan?.routes[routeIndex]) throw new HttpError(404, 'Plano não encontrado');
  const r = db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM trip_legs WHERE trip_id = ?').get(tripId) as Row;
  const seq = Number(r.next);
  db.prepare('INSERT INTO trip_legs (trip_id, seq, started_at, plan_id, route_index) VALUES (?, ?, ?, ?, ?)').run(tripId, seq, Date.now(), planId, routeIndex);
  return { seq };
}

function placeFor(places: Place[], lat: number, lon: number): Place {
  const found = matchPlace(places, lat, lon);
  if (found) return found;
  const p = newPlace(lat, lon);
  places.push(p);
  return p;
}

export function finishTrip(userId: string, tripId: string): FinishTripResponse {
  const trip = ownTrip(userId, tripId);
  if (trip.status !== 'active') throw new HttpError(409, 'Viagem já encerrada');
  const timeZone = String(trip.time_zone);
  const ctx = JSON.parse(String(trip.ctx)) as TripContext;
  const samples = getSamples(tripId);
  const legs = db.prepare('SELECT * FROM trip_legs WHERE trip_id = ? ORDER BY seq').all(tripId) as Row[];

  const empty: FinishTripResponse = {
    actualS: 0,
    predictedS: Number(trip.predicted_s),
    baseS: Number(trip.base_s),
    errorLearnedPct: 0,
    errorBasePct: 0,
    learnedSegments: 0,
    anomalies: 0,
    arrived: false,
    message: 'Viagem curta demais para aprender algo.',
  };
  if (samples.length < 5) {
    db.prepare("UPDATE trips SET status = 'discarded', finished_at = ? WHERE id = ?").run(Date.now(), tripId);
    return empty;
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const actualS = (last.t - first.t) / 1000;
  let learnedSegments = 0;
  let anomalies = 0;
  let arrived = false;
  let places = getPlaces(userId);
  // Sem opt-in, a viagem só alimenta o aprendizado do próprio usuário. O agregado continua sendo lido.
  const shareCrowd = getShareCrowd(userId);
  const knownOrigin = matchPlace(places, first.lat, first.lon);
  const originPlace = placeFor(places, first.lat, first.lon);
  // Feriados da região gravada no plano, a mesma que o ETA usou. Plano antigo ou apagado: calendário do fuso.
  const firstPlan = legs[0] ? getPlan(userId, String(legs[0].plan_id)) : null;
  const tripCalendar = regionalCalendar(timeZone, firstPlan?.holidayRegion);

  transaction(() => {
    legs.forEach((leg, i) => {
      const plan = getPlan(userId, String(leg.plan_id));
      const route = plan?.routes[Number(leg.route_index)]?.route;
      if (!plan || !route) return;
      const from = Number(leg.started_at);
      const to = i + 1 < legs.length ? Number(legs[i + 1]!.started_at) : Infinity;
      const legSamples = samples.filter((s) => s.t >= from - 5000 && s.t < to);
      const trace = analyzeTrace(route, legSamples);
      if (i === legs.length - 1) arrived = trace.reachedEnd;
      if (!trace.observations.length) return;

      const keys = route.segments.map((s) => s.key);
      const user = loadStats(userId, keys);
      const crowd = loadStats(CROWD, keys);
      const singleLeg = legs.length === 1;
      const destPlace = matchPlace(places, plan.destination.lat, plan.destination.lon);
      const res = learnFromTrip({
        route,
        observations: trace.observations,
        departAt: trace.firstT ?? from,
        timeZone,
        calendar: regionalCalendar(timeZone, plan.holidayRegion),
        user,
        crowd,
        ctx,
        odKey: singleLeg && knownOrigin && destPlace ? statKey.od(knownOrigin.id, destPlace.id) : null,
        // Resíduo de ponta a ponta só faz sentido se a viagem seguiu uma única rota até o fim.
        actualTotalS: singleLeg && trace.reachedEnd && trace.coverage > 0.8 ? actualS : null,
      });
      saveStats(userId, res.user);
      if (shareCrowd) saveStats(CROWD, res.crowd);
      learnedSegments += res.learnedSegments;
      anomalies += res.anomalies.length;
      const ins = db.prepare('INSERT INTO anomalies (user_id, seg, at, expected_s, observed_s) VALUES (?, ?, ?, ?, ?)');
      for (const a of res.anomalies) ins.run(userId, a.segmentKey, Date.now(), a.expectedS, a.observedS);
    });

    // Lugares e rotina: só para viagens reais (≥ 3 min e ≥ 500 m em linha reta).
    const straight = haversine([first.lon, first.lat], [last.lon, last.lat]);
    if (actualS >= 180 && straight >= 500) {
      const departLt = localTime(first.t, timeZone, tripCalendar);
      const arriveLt = localTime(last.t, timeZone, tripCalendar);
      const destPlace = placeFor(places, last.lat, last.lon);
      places = places.map((p) =>
        p.id === destPlace.id ? recordArrival(p, last.lat, last.lon, arriveLt) : p.id === originPlace.id ? recordDeparture(p, departLt) : p,
      );
      places = inferKinds(places);
      for (const p of places) upsertPlace(userId, p);
      const routines = getRoutines(userId);
      const existing = routines.find((r) => r.originId === originPlace.id && r.destId === destPlace.id && r.dayType === departLt.dayType);
      saveRoutine(
        userId,
        recordRoutine(existing, { originId: originPlace.id, destId: destPlace.id, dayType: departLt.dayType }, departLt, first.t),
      );
      db.prepare('UPDATE trips SET origin_place = ?, dest_place = ? WHERE id = ?').run(originPlace.id, destPlace.id, tripId);
    }

    const predictedS = Number(trip.predicted_s);
    const baseS = Number(trip.base_s);
    const errL = arrived && legs.length === 1 ? Math.abs(predictedS - actualS) / actualS : null;
    const errB = arrived && legs.length === 1 ? Math.abs(baseS - actualS) / actualS : null;
    db.prepare("UPDATE trips SET status = 'done', finished_at = ?, actual_s = ?, error_learned = ?, error_base = ? WHERE id = ?").run(
      Date.now(),
      actualS,
      errL,
      errB,
      tripId,
    );
  });

  const predictedS = Number(trip.predicted_s);
  const baseS = Number(trip.base_s);
  const errorLearnedPct = (Math.abs(predictedS - actualS) / actualS) * 100;
  const errorBasePct = (Math.abs(baseS - actualS) / actualS) * 100;
  const message =
    arrived && legs.length === 1
      ? `Previsão errou ${errorLearnedPct.toFixed(0)}% (o roteador sozinho erraria ${errorBasePct.toFixed(0)}%). ${learnedSegments} trechos atualizados.`
      : `${learnedSegments} trechos atualizados com o que você percorreu.`;
  return { actualS, predictedS, baseS, errorLearnedPct, errorBasePct, learnedSegments, anomalies, arrived, message };
}
