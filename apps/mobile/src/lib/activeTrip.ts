import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PlanResponse, TraceSample, TripStop } from '@wayboo/core';

/**
 * Navegação em curso gravada no aparelho. Se o sistema fechar o app sem rede, a rota já calculada e o rastro
 * ainda não enviado voltam ao reabrir, sem depender do servidor.
 */
export interface ActiveTrip {
  savedAt: number;
  /** Servidor da viagem: `tripId` e o rastro só valem nele. */
  apiUrl: string;
  plan: PlanResponse;
  routeIndex: number;
  stops: TripStop[];
  tripId: string | null;
  buffer: TraceSample[];
}

const KEY = 'wayboo-active-trip';
const VERSION = 1;
/** Uma viagem parada há mais tempo que isso já acabou; retomar mostraria uma rota velha. */
export const ACTIVE_TRIP_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Serializa gravações e remoção: uma gravação lenta não ressuscita a viagem depois de encerrada. */
let queue: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
  queue = queue.then(op).catch(() => {});
  return queue;
}

/** Falhas de disco são ignoradas: a navegação segue, só não sobrevive a um fechamento do app. */
export function saveActiveTrip(trip: ActiveTrip): Promise<void> {
  const raw = JSON.stringify({ v: VERSION, ...trip });
  return enqueue(() => AsyncStorage.setItem(KEY, raw));
}

export function clearActiveTrip(): Promise<void> {
  return enqueue(() => AsyncStorage.removeItem(KEY));
}

function isTrip(x: unknown): x is ActiveTrip & { v: number } {
  if (!x || typeof x !== 'object') return false;
  const t = x as Partial<ActiveTrip> & { v?: unknown };
  return (
    t.v === VERSION &&
    typeof t.savedAt === 'number' &&
    typeof t.apiUrl === 'string' &&
    typeof t.routeIndex === 'number' &&
    Array.isArray(t.plan?.routes) &&
    t.plan.routes[t.routeIndex] !== undefined &&
    Array.isArray(t.stops) &&
    Array.isArray(t.buffer) &&
    (t.tripId === null || typeof t.tripId === 'string')
  );
}

/** Viagem gravada que ainda dá para retomar em `apiUrl`, ou null. Gravação inválida ou velha é apagada. */
export async function loadActiveTrip(apiUrl: string, now = Date.now()): Promise<ActiveTrip | null> {
  await queue;
  let parsed: unknown;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw === null) return null;
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!isTrip(parsed) || now - parsed.savedAt > ACTIVE_TRIP_MAX_AGE_MS) {
    await clearActiveTrip();
    return null;
  }
  const { v: _v, ...trip } = parsed;
  // Trocou de servidor: a rota ainda serve para chegar, mas a viagem é de outro servidor.
  return trip.apiUrl === apiUrl ? trip : { ...trip, tripId: null, buffer: [] };
}
