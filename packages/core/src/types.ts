import { z } from 'zod';
import type { Coord } from './geo';
import type { Lane } from './lanes';

export const LatLonSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
export type LatLon = z.infer<typeof LatLonSchema>;

export const RouteOptionsSchema = z.object({
  avoidTolls: z.boolean().default(false),
  avoidHighways: z.boolean().default(false),
  avoidFerries: z.boolean().default(false),
});
export type RouteOptions = z.infer<typeof RouteOptionsSchema>;

export const STOP_CATEGORIES = ['fuel', 'food', 'coffee', 'pharmacy', 'parking', 'ev_charging', 'atm', 'supermarket'] as const;
export type StopCategory = (typeof STOP_CATEGORIES)[number];

export interface Maneuver {
  /** Tipo de manobra no enum do Valhalla. */
  type: number;
  instruction: string;
  streetNames: string[];
  distanceM: number;
  durationS: number;
  beginIdx: number;
  endIdx: number;
  roundaboutExit?: number;
  toll: boolean;
  highway: boolean;
  /** Faixas da via antes da manobra, da esquerda para a direita. Ausente quando o OSM não tem `turn:lanes`. */
  lanes?: Lane[];
}

/** Trecho da rota com limite de velocidade conhecido, nos índices de `Route.geometry` (fim exclusivo). */
export interface SpeedLimitSpan {
  beginIdx: number;
  endIdx: number;
  /** Limite em km/h, vindo da tag `maxspeed` do OSM. */
  kmh: number;
}

/** Trecho de ~300 m da rota. É a unidade em que o ETA aprende. */
export interface RouteSegment {
  /** Chave estável e direcional: geohash7(início) > geohash7(fim). */
  key: string;
  startM: number;
  endM: number;
  baseDurationS: number;
}

export interface Route {
  id: string;
  geometry: Coord[];
  distanceM: number;
  baseDurationS: number;
  maneuvers: Maneuver[];
  hasToll: boolean;
  hasHighway: boolean;
  hasFerry: boolean;
  /** Fração da distância em rodovias (0..1). */
  highwayShare: number;
  segments: RouteSegment[];
  provider: string;
  /** Trechos com limite conhecido, em ordem. Ausente se o roteador não respondeu os limites. */
  speedLimits?: SpeedLimitSpan[];
}

export type DayType = 'weekday' | 'saturday' | 'sunday';

export const ALERT_TYPES = [
  'accident',
  'traffic',
  'hazard',
  'pothole',
  'police',
  'speed_camera',
  'road_closed',
  'flood',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface RoadAlert {
  id: string;
  type: AlertType;
  lat: number;
  lon: number;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  upvotes: number;
  downvotes: number;
}

export const TraceSampleSchema = z.object({
  /** epoch ms */
  t: z.number().int().positive(),
  lat: z.number(),
  lon: z.number(),
  speed: z.number().nullable().optional(),
  heading: z.number().nullable().optional(),
  accuracy: z.number().nullable().optional(),
});
export type TraceSample = z.infer<typeof TraceSampleSchema>;

export interface EtaFactor {
  kind: 'segments' | 'time_of_day' | 'context' | 'routine' | 'alerts' | 'crowd';
  label: string;
  /** Delta em segundos em relação ao ETA base do roteador. */
  deltaS: number;
}

export interface EtaEstimate {
  durationS: number;
  p10S: number;
  p90S: number;
  baseDurationS: number;
  /** 0..1, cresce com a quantidade de observações próprias nos trechos da rota. */
  confidence: number;
  factors: EtaFactor[];
  /** Duração prevista por trecho, na mesma ordem de route.segments. */
  segmentDurationsS: number[];
}

export interface RouteFeatures {
  deltaMin: number;
  deltaKm: number;
  toll: number;
  highwayShare: number;
  turnsPerKm: number;
  familiarity: number;
  alerts: number;
  uncertaintyMin: number;
}

export interface TripContext {
  rain: boolean;
  heavyRain: boolean;
  lowVisibility: boolean;
  alertsOnRoute: number;
}
