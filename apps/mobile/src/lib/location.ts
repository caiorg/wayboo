import type { NavFix } from '@wayboo/core';
import * as Location from 'expo-location';
import { create } from 'zustand';

type Permission = 'unknown' | 'granted' | 'denied';

interface LocationState {
  fix: NavFix | null;
  permission: Permission;
  error: string | null;
}

export const useLocationStore = create<LocationState>(() => ({ fix: null, permission: 'unknown', error: null }));

let subscription: Location.LocationSubscription | null = null;
/** Horário da última leitura real publicada. Não usa o fix do store, que a simulação adianta. */
let lastPublishedT = -Infinity;
/** Relógio do aparelho na última publicação. Se ele voltar mais que CLOCK_JUMP_MS, os horários do GPS recomeçam. */
let lastPublishedAt = -Infinity;
/** Horário da última leitura publicada antes de uma volta do relógio. */
let staleUpTo = -Infinity;
const CLOCK_JUMP_MS = 60_000;

function toFix(p: Location.LocationObject): NavFix {
  return {
    t: p.timestamp,
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    speed: p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed : null,
    heading: p.coords.heading !== null && p.coords.heading >= 0 ? p.coords.heading : null,
    accuracy: p.coords.accuracy,
  };
}

/**
 * Publica as leituras do GPS em ordem de horário, uma por vez, para a navegação processar cada ponto.
 * Com a navegação em segundo plano, o watcher e a task entregam os mesmos pontos, às vezes num lote atrasado: repetidas e
 * mais antigas são ignoradas. A volta do relógio se detecta pelo relógio do aparelho, não pela diferença entre leituras.
 * Depois dela, um ponto de antes da volta fica no futuro do relógio novo e já foi publicado: é ignorado.
 */
export function publishLocations(locations: readonly Location.LocationObject[]): void {
  const now = Date.now();
  if (now < lastPublishedAt - CLOCK_JUMP_MS) {
    staleUpTo = Math.max(staleUpTo, lastPublishedT);
    lastPublishedT = -Infinity;
  }
  for (const p of [...locations].sort((a, b) => a.timestamp - b.timestamp)) {
    if (p.timestamp <= lastPublishedT) continue;
    if (p.timestamp <= staleUpTo && p.timestamp > now + CLOCK_JUMP_MS) continue;
    lastPublishedT = p.timestamp;
    lastPublishedAt = now;
    useLocationStore.setState({ fix: toFix(p) });
  }
}

/** Só para testes. */
export function resetPublishedLocations(): void {
  lastPublishedT = -Infinity;
  lastPublishedAt = -Infinity;
  staleUpTo = -Infinity;
}

/** Pede permissão e mantém um único watcher de GPS para o app inteiro. */
export async function startLocation(): Promise<void> {
  if (subscription) return;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      useLocationStore.setState({ permission: 'denied', error: 'Permita o acesso à localização para navegar.' });
      return;
    }
    useLocationStore.setState({ permission: 'granted', error: null });
    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
      (p) => publishLocations([p]),
    );
  } catch (e) {
    useLocationStore.setState({ error: e instanceof Error ? e.message : 'Localização indisponível' });
  }
}
