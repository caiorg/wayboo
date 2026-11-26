import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACKGROUND_LOCATION_TASK, startBackgroundLocation, stopBackgroundLocation } from '../src/lib/backgroundLocation';
import { publishLocations } from '../src/lib/location';

const native = vi.hoisted(() => ({ started: false }));

vi.mock('expo-task-manager', () => ({ defineTask: vi.fn() }));
vi.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  ActivityType: { AutomotiveNavigation: 2 },
  startLocationUpdatesAsync: vi.fn(async () => {
    native.started = true;
  }),
  stopLocationUpdatesAsync: vi.fn(async () => {
    native.started = false;
  }),
  hasStartedLocationUpdatesAsync: vi.fn(async () => native.started),
}));
vi.mock('../src/lib/location', () => ({ publishLocations: vi.fn() }));

const start = vi.mocked(Location.startLocationUpdatesAsync);
const stop = vi.mocked(Location.stopLocationUpdatesAsync);
// Capturado antes do primeiro clearAllMocks: a task é definida ao importar o módulo.
const defineTaskCall = vi.mocked(TaskManager.defineTask).mock.calls[0];

beforeEach(() => {
  vi.clearAllMocks();
  native.started = false;
});

describe('task de localização em segundo plano', () => {
  it('é definida ao carregar o módulo, fora de componentes', () => {
    expect(defineTaskCall?.[0]).toBe(BACKGROUND_LOCATION_TASK);
  });

  it('publica as leituras que o sistema entrega com a tela bloqueada', async () => {
    const executor = defineTaskCall![1];
    const locations = [{ timestamp: 1, coords: { latitude: 1, longitude: 2 } }];
    await executor({ data: { locations }, error: null, executionInfo: { eventId: '1', taskName: BACKGROUND_LOCATION_TASK } });
    expect(publishLocations).toHaveBeenCalledWith(locations);
  });

  it('ignora execução com erro ou sem dados', async () => {
    const executor = defineTaskCall![1];
    const executionInfo = { eventId: '1', taskName: BACKGROUND_LOCATION_TASK };
    await executor({ data: null, error: { code: 1, message: 'negado' }, executionInfo });
    await executor({ data: {}, error: null, executionInfo });
    expect(publishLocations).not.toHaveBeenCalled();
  });
});

describe('startBackgroundLocation', () => {
  it('inicia com serviço em primeiro plano e notificação com o destino', async () => {
    expect(await startBackgroundLocation('Av. Paulista, 1000')).toBe(true);
    expect(start).toHaveBeenCalledWith(
      BACKGROUND_LOCATION_TASK,
      expect.objectContaining({
        accuracy: Location.Accuracy.BestForNavigation,
        activityType: Location.ActivityType.AutomotiveNavigation,
        pausesUpdatesAutomatically: false,
        foregroundService: {
          notificationTitle: 'Navegando para Av. Paulista, 1000',
          notificationBody: 'Toque para voltar ao mapa.',
          killServiceOnDestroy: true,
        },
      }),
    );
  });

  it('sem nome de destino, usa um título genérico', async () => {
    await startBackgroundLocation(null);
    expect(start.mock.calls[0]?.[1]?.foregroundService?.notificationTitle).toBe('Wayboo está navegando');
    await stopBackgroundLocation();
    await startBackgroundLocation('   ');
    expect(start.mock.calls[1]?.[1]?.foregroundService?.notificationTitle).toBe('Wayboo está navegando');
  });

  it('devolve false quando o sistema recusa (Expo Go, permissão negada, app fora da tela)', async () => {
    start.mockRejectedValueOnce(new Error('ForegroundServiceStartNotAllowedException'));
    expect(await startBackgroundLocation('Casa')).toBe(false);
  });

  it('reinicia quando já havia atualizações de uma navegação anterior, para trocar o destino da notificação', async () => {
    await startBackgroundLocation('Casa');
    await startBackgroundLocation('Trabalho');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]?.[1]?.foregroundService?.notificationTitle).toBe('Navegando para Trabalho');
  });
});

describe('stopBackgroundLocation', () => {
  it('não chama o sistema quando não há atualizações', async () => {
    await stopBackgroundLocation();
    expect(stop).not.toHaveBeenCalled();
  });

  it('parar logo depois de iniciar espera o início e para de fato', async () => {
    let resolve!: () => void;
    start.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          resolve = () => {
            native.started = true;
            r();
          };
        }),
    );
    const starting = startBackgroundLocation('Casa');
    const stopping = stopBackgroundLocation();
    await vi.waitFor(() => expect(start).toHaveBeenCalled());
    expect(stop).not.toHaveBeenCalled();
    resolve();
    await Promise.all([starting, stopping]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(native.started).toBe(false);
  });

  it('para atualizações que sobraram de uma sessão encerrada no meio da navegação', async () => {
    native.started = true;
    await stopBackgroundLocation();
    expect(stop).toHaveBeenCalledWith(BACKGROUND_LOCATION_TASK);
  });

  it('falha ao parar não gera promise rejeitada', async () => {
    native.started = true;
    stop.mockRejectedValueOnce(new Error('TaskNotFound'));
    await expect(stopBackgroundLocation()).resolves.toBeUndefined();
  });
});
