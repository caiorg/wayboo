import { randomUUID } from 'node:crypto';
import {
  buildSegments,
  decodePolyline,
  INSTRUCTION_LANGUAGE,
  instructionPtBR,
  type Coord,
  type LatLon,
  type Maneuver,
  type Route,
  type RouteOptions,
} from '@wayboo/core';
import { config } from '../config';
import { fetchJson, HttpError } from './http';

/** Interface para trocar o roteador (Valhalla público, Valhalla próprio, GraphHopper...). */
export interface RoutingProvider {
  name: string;
  route(locations: LatLon[], options: RouteOptions, alternatives: number): Promise<Route[]>;
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
}

interface ValhallaTrip {
  legs: { shape: string; maneuvers: ValhallaManeuver[] }[];
  summary: { length: number; time: number; has_toll?: boolean; has_highway?: boolean; has_ferry?: boolean };
}

interface ValhallaResponse {
  trip: ValhallaTrip;
  alternates?: { trip: ValhallaTrip }[];
}

function toRoute(trip: ValhallaTrip): Route {
  const geometry: Coord[] = [];
  const maneuvers: Maneuver[] = [];
  trip.legs.forEach((leg, li) => {
    const shape = decodePolyline(leg.shape, 6);
    // Pernas consecutivas repetem o ponto de junção.
    const offset = geometry.length === 0 ? 0 : geometry.length - 1;
    geometry.push(...(offset === 0 ? shape : shape.slice(1)));
    for (const m of leg.maneuvers) {
      // A chegada numa parada intermediária tem comprimento zero; a partida da perna
      // seguinte vira "continue", para a navegação não encerrar na parada.
      if (li < trip.legs.length - 1 && [4, 5, 6].includes(m.type)) continue;
      const resumesAfterStop = li > 0 && [1, 2, 3].includes(m.type);
      const type = resumesAfterStop ? 8 : m.type;
      const streets = m.street_names ?? m.begin_street_names ?? [];
      const text = instructionPtBR(type, streets, m.roundabout_exit_count);
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
  };
}

export const valhalla: RoutingProvider = {
  name: 'valhalla',
  async route(locations, options, alternatives) {
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
    };
    try {
      const res = await fetchJson<ValhallaResponse>(`${config.valhallaUrl}/route`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        timeoutMs: 20000,
      });
      return [res.trip, ...(res.alternates ?? []).map((a) => a.trip)].map(toRoute);
    } catch (e) {
      if (e instanceof HttpError && e.status === 400) {
        throw new HttpError(422, 'Não foi possível traçar uma rota entre esses pontos.');
      }
      throw e;
    }
  },
};
