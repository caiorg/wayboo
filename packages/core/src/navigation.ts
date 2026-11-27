import type { PlanRequest, PlanResponse } from './api';
import { cumulativeDistances, haversine, projectOnPolyline, type Coord, type Projection } from './geo';
import { spokenInstruction } from './instructions';
import { isOverSpeedLimit, speedLimitSpanAt } from './speed';
import type { LatLon, Maneuver, Route, RouteOptions } from './types';

export interface NavFix {
  t: number;
  lat: number;
  lon: number;
  /** m/s */
  speed?: number | null;
  heading?: number | null;
  accuracy?: number | null;
}

export interface NavState {
  alongM: number;
  remainingM: number;
  remainingS: number;
  arrivalAt: number;
  snapped: Coord;
  offsetM: number;
  nextManeuver: Maneuver | null;
  nextManeuverIndex: number;
  distanceToManeuverM: number;
  /** Manobra seguinte à próxima (para "depois, ..."). */
  thenManeuver: Maneuver | null;
  offRoute: boolean;
  arrived: boolean;
  currentStreet: string | null;
  /** Texto a falar agora, se houver */
  announcement: string | null;
  /** O anúncio é o aviso de velocidade: entra na fila da voz em vez de cortar a fala em curso. */
  announcementQueued: boolean;
  progress: number;
  /** Razão entre ritmo real e previsto até aqui (1 = no previsto). */
  paceRatio: number;
  /** Limite do trecho atual em km/h, ou null se o OSM não tem o dado ou o carro saiu da rota. */
  speedLimitKmh: number | null;
  /** Velocidade do GPS em km/h, ou null se o aparelho não informou. */
  speedKmh: number | null;
  /** Acima do limite em duas leituras seguidas. */
  overSpeedLimit: boolean;
}

export interface NavigatorOptions {
  /** Duração prevista por trecho (ETA aprendido). Sem isso usa o tempo base. */
  segmentDurationsS?: number[];
  startedAt?: number;
}

/** Pausa mínima entre um anúncio e o aviso de velocidade, para não cortar a instrução falada. */
const SPEECH_GAP_MS = 6000;

export function createNavigator(route: Route, opts: NavigatorOptions = {}) {
  const coords = route.geometry;
  const cum = cumulativeDistances(coords);
  const total = cum[cum.length - 1] ?? 0;
  const segDur = opts.segmentDurationsS ?? route.segments.map((s) => s.baseDurationS);
  // Tempo previsto restante a partir do início de cada trecho (sufixo acumulado).
  const suffix = new Array<number>(segDur.length + 1).fill(0);
  for (let i = segDur.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + segDur[i]!;
  const maneuverStartM = route.maneuvers.map((m) => cum[m.beginIdx] ?? 0);

  let lastIdx = 0;
  let lastAlong = 0;
  let badFixes = 0;
  let startedAt = opts.startedAt ?? null;
  const spoken = new Set<string>();
  let overFixes = 0;
  let lastAnnouncedAt = -Infinity;

  const predictedRemaining = (along: number): number => {
    const i = route.segments.findIndex((s) => along < s.endM);
    if (i < 0) return 0;
    const s = route.segments[i]!;
    const len = s.endM - s.startM;
    const frac = len > 0 ? (s.endM - along) / len : 0;
    return suffix[i + 1]! + segDur[i]! * Math.max(0, Math.min(1, frac));
  };

  function update(fix: NavFix): NavState {
    startedAt ??= fix.t;
    const p: Coord = [fix.lon, fix.lat];
    let proj = projectOnPolyline(coords, cum, p, lastIdx - 3, lastIdx + 80);
    if (proj.offsetM > 60) proj = projectOnPolyline(coords, cum, p);

    const tolerance = Math.max(35, (fix.accuracy ?? 10) * 1.5);
    badFixes = proj.offsetM > tolerance ? badFixes + 1 : 0;
    const offRoute = badFixes >= 3 || (proj.offsetM > 150 && (fix.accuracy ?? 10) < 30);

    // Evita que ruído de GPS faça o progresso voltar.
    const along = proj.offsetM <= tolerance ? Math.max(lastAlong - 15, proj.alongM) : lastAlong;
    if (proj.offsetM <= tolerance) {
      lastIdx = proj.index;
      lastAlong = along;
    }

    const remainingM = Math.max(0, total - along);
    const arrived = remainingM < 30 || (remainingM < 60 && (fix.speed ?? 5) < 2);

    // Ritmo real vs previsto: ajusta o restante de forma amortecida.
    const elapsedS = (fix.t - startedAt) / 1000;
    const predictedElapsed = suffix[0]! - predictedRemaining(along);
    const paceRatio =
      along > 800 && predictedElapsed > 60 ? Math.max(0.7, Math.min(1.8, elapsedS / predictedElapsed)) : 1;
    const remainingS = predictedRemaining(along) * (1 + (paceRatio - 1) * 0.5);

    const nextIdx = maneuverStartM.findIndex((m, i) => i > 0 && m > along + 3);
    const next = nextIdx >= 0 ? route.maneuvers[nextIdx]! : null;
    const distToManeuver = nextIdx >= 0 ? maneuverStartM[nextIdx]! - along : remainingM;
    const then = nextIdx >= 0 ? (route.maneuvers[nextIdx + 1] ?? null) : null;
    const current = route.maneuvers[nextIdx > 0 ? nextIdx - 1 : route.maneuvers.length - 1];

    let announcement: string | null = null;
    if (arrived) {
      if (!spoken.has('arrive')) {
        spoken.add('arrive');
        announcement = 'Você chegou ao destino';
      }
    } else if (!spoken.has('start')) {
      spoken.add('start');
      announcement = route.maneuvers[0] ? spokenInstruction(route.maneuvers[0], null) : null;
    } else if (next && !offRoute) {
      const v = Math.max(5, fix.speed ?? 10);
      const far = Math.max(300, v * 28);
      const near = Math.max(50, v * 6);
      if (distToManeuver <= near && !spoken.has(`${nextIdx}:near`)) {
        spoken.add(`${nextIdx}:near`).add(`${nextIdx}:far`);
        const thenText =
          then && maneuverStartM[nextIdx + 1]! - maneuverStartM[nextIdx]! < 120
            ? `, depois ${then.instruction.charAt(0).toLowerCase()}${then.instruction.slice(1)}`
            : '';
        announcement = `${next.instruction}${thenText}`;
      } else if (distToManeuver <= far && distToManeuver > near * 1.5 && !spoken.has(`${nextIdx}:far`)) {
        spoken.add(`${nextIdx}:far`);
        announcement = spokenInstruction(next, distToManeuver);
      }
    }

    // Com o fix longe da rota não dá para saber em que via o carro está.
    const speedSpan = offRoute || proj.offsetM > tolerance ? null : speedLimitSpanAt(route.speedLimits, lastIdx);
    const speedLimitKmh = speedSpan?.kmh ?? null;
    overFixes = isOverSpeedLimit(fix.speed, speedLimitKmh) ? overFixes + 1 : 0;
    const overSpeedLimit = overFixes >= 2;
    let announcementQueued = false;
    if (announcement !== null) lastAnnouncedAt = fix.t;
    // Um aviso por trecho de limite. A pausa evita empilhar falas, e a fila garante que a instrução não seja cortada.
    else if (
      overSpeedLimit &&
      speedSpan &&
      !arrived &&
      fix.t - lastAnnouncedAt >= SPEECH_GAP_MS &&
      !spoken.has(`speed:${speedSpan.beginIdx}`)
    ) {
      spoken.add(`speed:${speedSpan.beginIdx}`);
      announcement = `Atenção: limite de ${speedSpan.kmh} km/h`;
      announcementQueued = true;
      lastAnnouncedAt = fix.t;
    }

    return {
      alongM: along,
      remainingM,
      remainingS,
      arrivalAt: fix.t + remainingS * 1000,
      snapped: proj.point,
      offsetM: proj.offsetM,
      nextManeuver: next,
      nextManeuverIndex: nextIdx,
      distanceToManeuverM: Math.max(0, distToManeuver),
      thenManeuver: then,
      offRoute,
      arrived,
      currentStreet: current?.streetNames[0] ?? null,
      announcement,
      announcementQueued,
      progress: total > 0 ? along / total : 1,
      paceRatio,
      speedLimitKmh,
      speedKmh: fix.speed == null ? null : Math.round(fix.speed * 3.6),
      overSpeedLimit,
    };
  }

  /** Projeta um ponto na rota a partir de `fromM` (ex.: uma parada), sem mexer no estado da navegação. */
  const project = (p: LatLon, fromM = 0): Projection => {
    const pt: Coord = [p.lon, p.lat];
    if (fromM <= 0) return projectOnPolyline(coords, cum, pt);
    const i = cum.findIndex((d) => d > fromM) - 1;
    if (i < 0) return { index: coords.length - 1, point: coords[coords.length - 1]!, offsetM: Infinity, alongM: total };
    // Trecho que contém `fromM`: vale só a parte depois dele (a distância no trecho é convexa).
    let first = projectOnPolyline(coords, cum, pt, i, i + 1);
    if (first.alongM < fromM) {
      const [a, b] = [coords[i]!, coords[i + 1]!];
      const f = (fromM - cum[i]!) / (cum[i + 1]! - cum[i]!);
      const point: Coord = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      first = { index: i, point, offsetM: haversine(pt, point), alongM: fromM };
    }
    const rest = projectOnPolyline(coords, cum, pt, i + 1);
    return rest.offsetM < first.offsetM ? rest : first;
  };

  /**
   * Último ponto da rota, a partir de `fromM`, a até `distM` de `p`, ou null se não houver. Com
   * retorno ou volta pela mesma via, é a saída da última passagem perto de `p`.
   */
  const lastWithin = (p: LatLon, distM: number, fromM = 0): number | null => {
    const pt: Coord = [p.lon, p.lat];
    for (let j = coords.length - 2; j >= 0 && cum[j + 1]! >= fromM; j--) {
      const len = cum[j + 1]! - cum[j]!;
      const da = haversine(coords[j]!, pt);
      if (len === 0) {
        if (da <= distM && cum[j]! >= fromM) return cum[j]!;
        continue;
      }
      // Pé da perpendicular na reta do trecho (sem limitar ao trecho) e distância até ela.
      const db = haversine(coords[j + 1]!, pt);
      const u = (da ** 2 - db ** 2 + len ** 2) / (2 * len);
      const h2 = distM ** 2 - (da ** 2 - u ** 2);
      if (h2 < 0) continue;
      const h = Math.sqrt(h2);
      // O círculo de raio `distM` corta a reta em [u - h, u + h]; vale a parte dentro do trecho.
      if (u - h > len || u + h < 0) continue;
      const leave = cum[j]! + Math.min(len, u + h);
      if (leave >= fromM) return leave;
    }
    return null;
  };

  return { update, project, lastWithin, totalM: total };
}

export type Navigator = ReturnType<typeof createNavigator>;

/** Parada intermediária da viagem (ex.: posto pedido ao copiloto). */
export interface TripStop extends LatLon {
  visited: boolean;
}

/** Pedido de replanejamento a partir da posição atual, mantendo destino e paradas pendentes. */
export function rerouteRequest(
  plan: Pick<PlanResponse, 'destination' | 'destinationName'>,
  fix: Pick<NavFix, 'lat' | 'lon'>,
  stops: TripStop[],
  options: RouteOptions,
): Omit<PlanRequest, 'timeZone'> {
  return {
    origin: { lat: fix.lat, lon: fix.lon },
    destination: plan.destination,
    destinationName: plan.destinationName ?? undefined,
    waypoints: stops.filter((s) => !s.visited).map(({ lat, lon }) => ({ lat, lon })),
    options,
    reroute: true,
  };
}

export const STOP_VISITED_RADIUS_M = 50;
/** Distância máxima entre a parada e a rota para o avanço contar como passagem por ela. */
export const STOP_ON_ROUTE_M = 150;

export interface RouteProgress extends Pick<Navigator, 'project' | 'lastWithin'> {
  /** Avanço na rota em navegação (`NavState.alongM`), medido no mesmo `Navigator`. */
  alongM: number;
}

/**
 * Marca como visitadas as paradas a menos de `radiusM` da posição. Com `progress`, também conta
 * como visitada a parada que a rota já deixou para trás (avanço além dela), o que cobre a última
 * parada pulada. Se a rota volta à parada, conta a última passagem. A rota passa pelas paradas na
 * ordem do array, então as anteriores à última visitada também contam como visitadas (puladas).
 * Devolve o mesmo array se nada mudou.
 */
export function markVisitedStops(
  stops: TripStop[],
  fix: Pick<NavFix, 'lat' | 'lon'>,
  progress?: RouteProgress,
  radiusM = STOP_VISITED_RADIUS_M,
): TripStop[] {
  let last = -1;
  // Cada parada pendente é procurada na rota depois da anterior, na ordem do array.
  let fromM = 0;
  stops.forEach((s, i) => {
    if (s.visited) {
      last = i;
      return;
    }
    if (haversine([s.lon, s.lat], [fix.lon, fix.lat]) <= radiusM) last = i;
    if (!progress) return;
    const p = progress.project(s, fromM);
    if (p.offsetM > STOP_ON_ROUTE_M) return;
    fromM = p.alongM;
    // Conta a saída da última passagem perto da parada: com retorno, a rota ainda volta a ela.
    const leaveM = progress.lastWithin(s, p.offsetM + radiusM, p.alongM);
    if (leaveM !== null && progress.alongM > leaveM) last = i;
  });
  if (stops.every((s, i) => s.visited || i > last)) return stops;
  return stops.map((s, i) => (s.visited || i > last ? s : { ...s, visited: true }));
}
