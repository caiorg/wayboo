import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { publishLocations } from './location';

export const BACKGROUND_LOCATION_TASK = 'wayboo-background-location';
export const BACKGROUND_LOCATION_SUPPORTED = true;

/**
 * Definida ao carregar o módulo, como o expo-task-manager exige: o sistema pode entregar leituras sem nenhum componente
 * montado. O `_layout` importa este módulo na abertura do app.
 */
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations) return;
  publishLocations(data.locations);
});

function notificationTitle(destinationName: string | null): string {
  const name = destinationName?.trim();
  return name ? `Navegando para ${name}` : 'Wayboo está navegando';
}

/** Serializa iniciar e parar: parar antes de o início terminar não deixa o GPS ligado. */
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op);
  queue = next.catch(() => {});
  return next;
}

async function stopIfStarted() {
  if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}

/**
 * Mantém o GPS ligado com a tela bloqueada durante uma navegação, usando só a permissão "ao usar o app": serviço em
 * primeiro plano com notificação no Android e `UIBackgroundModes` `location` no iOS. Precisa ser chamada com o app
 * aberto. Devolve false quando o sistema recusa (Expo Go, permissão negada, app fora da tela).
 */
export function startBackgroundLocation(destinationName: string | null): Promise<boolean> {
  return enqueue(async () => {
    try {
      // Uma navegação anterior pode ter deixado as atualizações ligadas, com outro destino na notificação.
      await stopIfStarted();
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        activityType: Location.ActivityType.AutomotiveNavigation,
        timeInterval: 1000,
        distanceInterval: 2,
        // Com a permissão "ao usar o app", uma pausa automática do iOS só volta quando o app abre de novo.
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: notificationTitle(destinationName),
          notificationBody: 'Toque para voltar ao mapa.',
          killServiceOnDestroy: true,
        },
      });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Para as atualizações em segundo plano. Também roda na abertura do app: o expo-task-manager restaura as atualizações
 * de uma sessão encerrada no meio da navegação, e o GPS não deve seguir ligado sem navegação.
 */
export function stopBackgroundLocation(): Promise<void> {
  return enqueue(stopIfStarted).catch(() => {});
}
