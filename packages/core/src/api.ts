import { z } from 'zod';
import type { PlaceKind } from './learning/routine';
import type { Tradeoff } from './learning/preferences';
import type { HolidayRegion } from './learning/holidays';
import {
  ALERT_TYPES,
  LatLonSchema,
  RouteOptionsSchema,
  STOP_CATEGORIES,
  TraceSampleSchema,
  type EtaEstimate,
  type LatLon,
  type RoadAlert,
  type Route,
  type RouteFeatures,
  type TripContext,
} from './types';

/** Contrato HTTP entre app e API. Schemas zod validam no servidor; tipos servem ao cliente. */

export const PlanRequestSchema = z.object({
  origin: LatLonSchema,
  destination: LatLonSchema,
  destinationName: z.string().max(200).optional(),
  waypoints: z.array(LatLonSchema).max(3).default([]),
  departAt: z.number().int().optional(),
  timeZone: z.string().min(1).max(64),
  options: RouteOptionsSchema.default({ avoidTolls: false, avoidHighways: false, avoidFerries: false }),
  /** true para replanejamento durante a navegação (pula horários de saída). */
  reroute: z.boolean().default(false),
});
export type PlanRequest = z.input<typeof PlanRequestSchema>;

export interface SlowSpot {
  lat: number;
  lon: number;
  /** multiplicador típico sobre o tempo base (ex.: 1,8 = 80% mais lento) */
  factor: number;
  observations: number;
  when: string;
}

export interface PlannedRoute {
  route: Route;
  eta: EtaEstimate;
  features: RouteFeatures;
  utility: number;
  probability: number;
  familiarity: number;
  alerts: RoadAlert[];
  slowSpots: SlowSpot[];
  tags: string[];
}

export interface WeatherNow {
  precipitationMm: number;
  weatherCode: number;
  visibilityM: number | null;
  description: string;
}

export interface KnownPlace {
  id: string;
  kind: PlaceKind;
  name: string | null;
  label: string;
  lat: number;
  lon: number;
  visits: number;
}

export interface DepartureOption {
  departAt: number;
  durationS: number;
  p90S: number;
}

export interface PlanResponse {
  planId: string;
  createdAt: number;
  departAt: number;
  origin: LatLon;
  destination: LatLon;
  destinationName: string | null;
  /** Paradas intermediárias, na ordem pedida. */
  waypoints: LatLon[];
  originPlace: KnownPlace | null;
  destinationPlace: KnownPlace | null;
  routes: PlannedRoute[];
  recommendedIndex: number;
  /** Motivo determinístico (sem IA) da recomendação */
  reason: string;
  context: TripContext & { weather: WeatherNow | null };
  departures: DepartureOption[];
  learningLevel: 'nenhum' | 'inicial' | 'bom' | 'alto';
  /** Região cujos feriados estaduais e municipais entraram no ETA; null usa só o calendário do fuso. Planos antigos não têm. */
  holidayRegion?: HolidayRegion | null;
}

export const BriefSchema = z.object({
  recommendedIndex: z.number().int().min(0),
  headline: z.string(),
  explanation: z.string(),
  warnings: z.array(z.string()),
  departureAdvice: z.string().nullable(),
});
export type Brief = z.infer<typeof BriefSchema> & { provider: string; model: string | null };

export const IntentSchema = z.object({
  destinationQuery: z.string().nullable(),
  destinationPlace: z.enum(['home', 'work']).nullable(),
  avoidTolls: z.boolean(),
  avoidHighways: z.boolean(),
  avoidFerries: z.boolean(),
  stops: z.array(z.object({ category: z.enum(STOP_CATEGORIES), query: z.string().nullable() })),
  /** HH:MM local */
  arriveBy: z.string().nullable(),
  departAt: z.string().nullable(),
  priority: z.enum(['fastest', 'reliable', 'familiar', 'shortest']).nullable(),
});
export type Intent = z.infer<typeof IntentSchema>;

export const AssistantRequestSchema = z.object({
  text: z.string().min(1).max(500),
  origin: LatLonSchema,
  timeZone: z.string().min(1).max(64),
});

export interface StopSuggestion {
  category: string;
  name: string;
  lat: number;
  lon: number;
}

export interface AssistantResponse {
  intent: Intent;
  provider: string;
  plan: PlanResponse | null;
  stops: StopSuggestion[];
  message: string;
}

export const StartTripSchema = z.object({
  planId: z.string().uuid(),
  routeIndex: z.number().int().min(0),
  timeZone: z.string().min(1).max(64),
});

export const SamplesSchema = z.object({ samples: z.array(TraceSampleSchema).min(1).max(2000) });

export const RerouteSchema = z.object({ planId: z.string().uuid(), routeIndex: z.number().int().min(0) });

export interface FinishTripResponse {
  actualS: number;
  predictedS: number;
  baseS: number;
  errorLearnedPct: number;
  errorBasePct: number;
  learnedSegments: number;
  anomalies: number;
  arrived: boolean;
  message: string;
}

export const AlertCreateSchema = z.object({
  type: z.enum(ALERT_TYPES),
  lat: z.number(),
  lon: z.number(),
  note: z.string().max(140).nullable().optional(),
});

export const VoteSchema = z.object({ up: z.boolean() });

export interface AccuracyPoint {
  tripId: string;
  at: number;
  errorBasePct: number;
  errorLearnedPct: number;
}

export interface Insights {
  trips: number;
  kmDriven: number;
  places: KnownPlace[];
  routines: { origin: string; destination: string; dayType: string; typicalDeparture: string; trips: number }[];
  accuracy: AccuracyPoint[];
  tradeoffs: Tradeoff[];
  slowSpots: SlowSpot[];
  contextFactors: { label: string; impactPct: number; observations: number }[];
  learnedSegments: number;
}

export interface Suggestion {
  place: KnownPlace;
  plan: PlanResponse;
  probability: number;
  typicalDeparture: string;
  durationS: number;
  usualDurationS: number;
  bestDeparture: DepartureOption | null;
  message: string;
}

/** Opt-in do aprendizado coletivo. Desligado, nada da viagem vai para o usuário agregado. */
export const PrivacySchema = z.object({ shareCrowd: z.boolean() });
export type Privacy = z.infer<typeof PrivacySchema>;

export const PlacePatchSchema = z.object({
  kind: z.enum(['home', 'work', 'other']).optional(),
  name: z.string().max(80).nullable().optional(),
});
