import { randomUUID } from 'node:crypto';
import {
  buildSegments,
  decodePolyline,
  encodePolyline,
  INSTRUCTION_LANGUAGE,
  instructionPtBR,
  parseValhallaLanes,
  appendSpeedLimits,
  cumulativeDistances,
  parseValhallaSpeedLimits,
  type Coord,
  type LatLon,
  type Maneuver,
  type Route,
  type RouteOptions,
  type SpeedLimitSpan,
} from '@wayboo/core';
import { config } from '../config';
import { fetchJson, HttpError } from './http';

/** Dados opcionais da rota que custam chamadas extras ao roteador. */
export interface RouteExtras {
  /** Limites de velocidade por trecho (padrão: sim). Quem só usa a geometria passa `false`. */
  speedLimits?: boolean;
}

/** Interface para trocar o roteador (Valhalla público, Valhalla próprio, GraphHopper...). */
export interface RoutingProvider {
  name: string;
  route(locations: LatLon[], options: RouteOptions, alternatives: number, extras?: RouteExtras): Promise<Route[]>;
}

interface ValhallaManeuver {
  type: number;
  street_names?: string[];
  begin_street_names?: string[];
  length: number;
  time: number;
  begin_shape_index: number;
  end_shape_index: number;
  roundabout_exit_count?: number;
  toll?: boolean;
  highway?: boolean;
  /** Só vem com `turn_lanes: true`, e só quando a via antes da manobra tem mais de uma faixa. */
  lanes?: unknown;
}

interface ValhallaTrip {
  legs: { shape: string; maneuvers: ValhallaManeuver[] }[];
  summary: { length: number; time: number; has_toll?: boolean; has_highway?: boolean; has_ferry?: boolean };
}

interface ValhallaResponse {
  trip: ValhallaTrip;
  alternates?: { trip: ValhallaTrip }[];
}

interface ValhallaTraceAttributes {
  shape?: string;
  edges?: unknown;
}

/**
 * Tamanho máximo de cada pedaço do shape mandado ao `/trace_attributes`. O padrão do Valhalla
 * (`service_limits.trace`) é 200 km e 16.000 pontos, e o selfhost usa o padrão.
 */
const TRACE_CHUNK_M = 150_000;
const TRACE_CHUNK_POINTS = 10_000;

/**
 * Teto de consultas ao `/trace_attributes` em voo, somando todos os pedidos. Acima dele o pedaço fica
 * sem limite em vez de esperar: o limite é opcional e não pode atrasar nem disputar o `/route`.
 */
export const MAX_TRACES_IN_FLIGHT = 8;
let tracesInFlight = 0;

/** Mesmos pontos, na mesma ordem, na precisão da polyline (1e-6). */
const samePoints = (a: Coord[], b: Coord[]) =>
  a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i]![0]) < 5e-7 && Math.abs(p[1] - b[i]![1]) < 5e-7);

/** Pedaços `[início, fim]` (inclusive) do shape; pedaços vizinhos dividem o ponto de junção. */
function traceChunks(shape: Coord[]): [number, number][] {
  const cum = cumulativeDistances(shape);
  const chunks: [number, number][] = [];
  let start = 0;
  for (let i = 1; i < shape.length; i++) {
    const tooLong = cum[i]! - cum[start]! > TRACE_CHUNK_M || i - start >= TRACE_CHUNK_POINTS;
    if (tooLong && i - 1 > start) {
      chunks.push([start, i - 1]);
      start = i - 1;
    }
  }
  if (shape.length > 1) chunks.push([start, shape.length - 1]);
  return chunks;
}

/**
 * Limites de velocidade de um pedaço de shape, pelo `/trace_attributes` com `edge_walk`. O JSON nativo
 * do `/route` não traz limite. Falha ou resposta que não bate com o shape devolve `undefined`: o
 * trecho fica sem limite em vez de mostrar um valor errado.
 */
async function traceSpeedLimits(shape: Coord[]): Promise<SpeedLimitSpan[] | undefined> {
  if (tracesInFlight >= MAX_TRACES_IN_FLIGHT) return undefined;
  tracesInFlight++;
  try {
    const res = await fetchJson<ValhallaTraceAttributes>(`${config.valhallaUrl}/trace_attributes`, {
      method: 'POST',
      body: JSON.stringify({
        encoded_polyline: encodePolyline(shape, 6),
        shape_match: 'edge_walk',
        costing: 'auto',
        units: 'kilometers',
        filters: { action: 'include', attributes: ['edge.speed_limit', 'edge.begin_shape_index', 'edge.end_shape_index', 'shape'] },
      }),
      headers: { 'content-type': 'application/json' },
      // Curto: roda depois do `/route` e o app desiste do `/plan` em 25 s.
      timeoutMs: 4000,
    });
    // Os índices das arestas só valem se o shape devolvido for o enviado, ponto a ponto.
    if (typeof res.shape !== 'string' || !samePoints(decodePolyline(res.shape, 6), shape)) return undefined;
    return parseValhallaSpeedLimits(res.edges, shape.length);
  } catch {
    return undefined;
  } finally {
    tracesInFlight--;
  }
}

/** Limites de uma perna, nos índices do shape dela. `undefined` se nenhum pedaço respondeu. */
async function legSpeedLimits(encoded: string): Promise<SpeedLimitSpan[] | undefined> {
  const shape = decodePolyline(encoded, 6);
  const chunks = traceChunks(shape);
  const results = await Promise.all(chunks.map(([a, b]) => traceSpeedLimits(shape.slice(a, b + 1))));
  if (results.every((r) => r === undefined)) return undefined;
  const spans: SpeedLimitSpan[] = [];
  results.forEach((r, i) => r && appendSpeedLimits(spans, r, chunks[i]![0]));
  return spans;
}

/** `speedLimits[i]` são os limites da perna i, nos índices do shape dela. */
function toRoute(trip: ValhallaTrip, speedLimits: (SpeedLimitSpan[] | undefined)[] = []): Route {
  const geometry: Coord[] = [];
  const maneuvers: Maneuver[] = [];
  let limits: SpeedLimitSpan[] | undefined;
  trip.legs.forEach((leg, li) => {
    const shape = decodePolyline(leg.shape, 6);
    // Pernas consecutivas repetem o ponto de junção.
    const offset = geometry.length === 0 ? 0 : geometry.length - 1;
    geometry.push(...(offset === 0 ? shape : shape.slice(1)));
    const legLimits = speedLimits[li];
    if (legLimits) appendSpeedLimits((limits ??= []), legLimits, offset);
    for (const m of leg.maneuvers) {
      // A chegada numa parada intermediária tem comprimento zero; a partida da perna
      // seguinte vira "continue", para a navegação não encerrar na parada.
      if (li < trip.legs.length - 1 && [4, 5, 6].includes(m.type)) continue;
      const resumesAfterStop = li > 0 && [1, 2, 3].includes(m.type);
      const type = resumesAfterStop ? 8 : m.type;
      const streets = m.street_names ?? m.begin_street_names ?? [];
      const text = instructionPtBR(type, streets, m.roundabout_exit_count);
      const lanes = parseValhallaLanes(m.lanes);
      maneuvers.push({
        type,
        instruction: resumesAfterStop ? `Parada concluída. ${text}` : text,
        streetNames: streets,
        distanceM: m.length * 1000,
        durationS: m.time,
        beginIdx: m.begin_shape_index + offset,
        endIdx: m.end_shape_index + offset,
        roundaboutExit: m.roundabout_exit_count,
        toll: Boolean(m.toll),
        highway: Boolean(m.highway),
        ...(lanes ? { lanes } : {}),
      });
    }
  });
  const distanceM = trip.summary.length * 1000;
  const highwayM = maneuvers.filter((m) => m.highway).reduce((a, m) => a + m.distanceM, 0);
  return {
    id: randomUUID(),
    geometry,
    distanceM,
    baseDurationS: trip.summary.time,
    maneuvers,
    hasToll: Boolean(trip.summary.has_toll) || maneuvers.some((m) => m.toll),
    hasHighway: Boolean(trip.summary.has_highway) || highwayM > 0,
    hasFerry: Boolean(trip.summary.has_ferry),
    highwayShare: distanceM > 0 ? Math.min(1, highwayM / distanceM) : 0,
    segments: buildSegments(geometry, maneuvers),
    provider: 'valhalla',
    ...(limits ? { speedLimits: limits } : {}),
  };
}

export const valhalla: RoutingProvider = {
  name: 'valhalla',
  async route(locations, options, alternatives, extras = {}) {
    const body = {
      locations: locations.map((l, i) => ({ lat: l.lat, lon: l.lon, type: i === 0 || i === locations.length - 1 ? 'break' : 'break_through' })),
      costing: 'auto',
      costing_options: {
        auto: {
          use_tolls: options.avoidTolls ? 0 : 0.5,
          use_highways: options.avoidHighways ? 0 : 1,
          use_ferry: options.avoidFerries ? 0 : 0.5,
        },
      },
      // O Valhalla só gera alternativas para rotas sem paradas intermediárias.
      alternates: locations.length === 2 ? alternatives : 0,
      language: INSTRUCTION_LANGUAGE,
      units: 'kilometers',
      directions_type: 'maneuvers',
      // Faixas por manobra (Valhalla 3.6.0 ou mais novo).
      turn_lanes: true,
    };
    try {
      const res = await fetchJson<ValhallaResponse>(`${config.valhallaUrl}/route`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        timeoutMs: 20000,
      });
      const trips = [res.trip, ...(res.alternates ?? []).map((a) => a.trip)];
      const limits =
        extras.speedLimits === false
          ? []
          : await Promise.all(trips.map((t) => Promise.all(t.legs.map((l) => legSpeedLimits(l.shape)))));
      return trips.map((t, i) => toRoute(t, limits[i]));
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) {
        throw new HttpError(422, 'Não foi possível traçar uma rota entre esses pontos.');
      }
      throw e;
    }
  },
};
