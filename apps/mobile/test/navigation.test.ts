import type { PlanResponse } from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Speech from 'expo-speech';
import { saveActiveTrip } from '../src/lib/activeTrip';
import { pickVoice, resumeNavigation, startNavigation, stopNavigation, toggleMute, useNavSession, type VoiceInfo } from '../src/lib/navigation';
import { useLocationStore } from '../src/lib/location';
import { startBackgroundLocation, stopBackgroundLocation } from '../src/lib/backgroundLocation';
import { api, ApiError } from '../src/lib/api';
import { useSettings } from '../src/lib/store';

const mocks = vi.hoisted(() => ({
  announcement: null as string | null,
  announcementQueued: false,
  bgSupported: true,
  offRoute: false,
  visit: false,
  async: new Map<string, string>(),
  readGate: null as Promise<void> | null,
  navigators: [] as { route: unknown; updates: number }[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      if (mocks.readGate) await mocks.readGate;
      return mocks.async.get(k) ?? null;
    },
    setItem: async (k: string, v: string) => void mocks.async.set(k, v),
    removeItem: async (k: string) => void mocks.async.delete(k),
  },
}));

// Imita o expo-keep-awake da web: desativar uma tag inativa lança erro.
const active = new Set<string>();
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: vi.fn(async (tag: string) => {
    active.add(tag);
  }),
  deactivateKeepAwake: vi.fn(async (tag: string) => {
    if (!active.delete(tag)) throw new Error(`The wake lock with tag ${tag} has not activated yet`);
  }),
}));
vi.mock('expo-speech', () => ({
  stop: vi.fn(),
  speak: vi.fn(),
  getAvailableVoicesAsync: vi.fn(async () => []),
  VoiceQuality: { Default: 'Default', Enhanced: 'Enhanced' },
}));
vi.mock('@wayboo/core', () => ({
  INSTRUCTION_LANGUAGE: 'pt-BR',
  createNavigator: (route: unknown) => {
    const nav = { route, updates: 0 };
    mocks.navigators.push(nav);
    return {
      update: () => {
        nav.updates++;
        return { arrived: false, offRoute: mocks.offRoute, announcement: mocks.announcement, announcementQueued: mocks.announcementQueued };
      },
    };
  },
  simulateDrive: function* () {},
  markVisitedStops: (stops: unknown[]) => (mocks.visit ? [...stops] : stops),
  rerouteRequest: () => ({}),
}));
vi.mock('../src/lib/api', () => ({
  ApiError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: {
    startTrip: vi.fn(async () => ({ tripId: 't1' })),
    finishTrip: vi.fn(async () => ({})),
    samples: vi.fn(async () => {}),
    plan: vi.fn(),
    reroute: vi.fn(async () => {}),
  },
}));
vi.mock('../src/lib/location', async () => {
  const { create } = await import('zustand');
  return { useLocationStore: create(() => ({ fix: null })) };
});
vi.mock('../src/lib/store', async () => {
  const { create } = await import('zustand');
  return {
    normalizeApiUrl: (u: string) => u,
    useSettings: create(() => ({ voice: false, avoidTolls: false, avoidHighways: false, backgroundNav: true, apiUrl: 'https://api.wayboo.app' })),
  };
});
vi.mock('../src/lib/backgroundLocation', () => ({
  get BACKGROUND_LOCATION_SUPPORTED() {
    return mocks.bgSupported;
  },
  startBackgroundLocation: vi.fn(async () => true),
  stopBackgroundLocation: vi.fn(async () => {}),
}));

const plan = {
  planId: 'p1',
  destinationName: 'Av. Paulista, 1000',
  waypoints: [],
  routes: [{ route: { id: 'r0' }, eta: { segmentDurationsS: [] }, alerts: [] }],
} as unknown as PlanResponse;

const TRIP_KEY = 'wayboo-active-trip';
const stored = () => {
  const raw = mocks.async.get(TRIP_KEY);
  return raw ? (JSON.parse(raw) as { tripId: string | null; routeIndex: number }) : null;
};

const activate = vi.mocked(activateKeepAwakeAsync);
const deactivate = vi.mocked(deactivateKeepAwake);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  active.clear();
  mocks.announcement = null;
  mocks.announcementQueued = false;
  mocks.bgSupported = true;
  mocks.offRoute = false;
  mocks.visit = false;
  mocks.navigators = [];
  mocks.readGate = null;
  mocks.async.clear();
  useSettings.setState({ voice: false, backgroundNav: true });
  useNavSession.setState({ muted: false, status: 'idle', error: null });
  useLocationStore.setState({ fix: null });
});

afterEach(async () => {
  await stopNavigation();
  await settle();
});

describe('wake lock da navegação', () => {
  it('não desativa a tag quando ela nunca foi ativada', async () => {
    await startNavigation(plan, 0, true);
    await settle();
    expect(deactivate).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(1);
  });

  it('libera o wake lock ao parar', async () => {
    await startNavigation(plan, 0, false);
    await stopNavigation();
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('parar antes de a ativação terminar não deixa a tela presa acesa', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    activate.mockImplementationOnce(async (tag?: string) => {
      await pending;
      active.add(tag!);
    });
    await startNavigation(plan, 0, true);
    await stopNavigation();
    await settle();
    expect(activate).toHaveBeenCalledTimes(1);
    resolve();
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(active.size).toBe(0);
  });

  it('segue navegando quando o navegador recusa o wake lock', async () => {
    activate.mockRejectedValueOnce(new Error('NotAllowedError'));
    await startNavigation(plan, 0, true);
    await settle();
    expect(useNavSession.getState().status).toBe('navigating');
    await stopNavigation();
    await settle();
    expect(deactivate).not.toHaveBeenCalled();
  });

  it('tenta liberar de novo quando a desativação falha', async () => {
    await startNavigation(plan, 0, true);
    await settle();
    deactivate.mockRejectedValueOnce(new Error('no activity'));
    await stopNavigation();
    await settle();
    expect(active.size).toBe(1);
    // O cleanup do próximo início tenta liberar de novo antes de ativar.
    await startNavigation(plan, 0, true);
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(2);
    expect(activate).toHaveBeenCalledTimes(2);
    await stopNavigation();
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(3);
    expect(active.size).toBe(0);
  });

  it('só ativa de novo depois que a desativação anterior termina', async () => {
    await startNavigation(plan, 0, true);
    await settle();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => {
      resolve = r;
    });
    deactivate.mockImplementationOnce(async (tag?: string) => {
      await pending;
      active.delete(tag!);
    });
    await stopNavigation();
    await startNavigation(plan, 0, true);
    await settle();
    expect(deactivate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledTimes(1);
    resolve();
    await settle();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(active.size).toBe(1);
  });

  it('parar e iniciar várias vezes não gera promise rejeitada', async () => {
    for (let i = 0; i < 5; i++) {
      await startNavigation(plan, 0, i % 2 === 0);
      await stopNavigation();
    }
    await settle();
    expect(activate).toHaveBeenCalledTimes(5);
    expect(deactivate).toHaveBeenCalledTimes(5);
    expect(active.size).toBe(0);
  });
});

const voice = (name: string, language: string, extra: Partial<VoiceInfo> = {}): VoiceInfo => ({
  identifier: name,
  name,
  language,
  quality: Speech.VoiceQuality.Default,
  ...extra,
});

// Ordem real do Chrome no macOS com o sistema em en-US.
const macVoices = [
  voice('Samantha', 'en-US', { isDefault: true }),
  voice('Eddy (Portuguese (Brazil))', 'pt-BR'),
  voice('Grandpa (Portuguese (Brazil))', 'pt-BR'),
  voice('Joana', 'pt-PT'),
  voice('Luciana', 'pt-BR'),
];

describe('pickVoice', () => {
  it('escolhe a voz natural do idioma, não a padrão do sistema nem as de efeito', () => {
    expect(pickVoice(macVoices, 'pt-BR')?.name).toBe('Luciana');
  });

  it('serve para qualquer idioma', () => {
    expect(pickVoice(macVoices, 'en-US')?.name).toBe('Samantha');
    expect(pickVoice(macVoices, 'pt-PT')?.name).toBe('Joana');
  });

  it('cai para outra região do mesmo idioma', () => {
    expect(pickVoice([voice('Samantha', 'en-US'), voice('Joana', 'pt-PT')], 'pt-BR')?.name).toBe('Joana');
    expect(pickVoice(macVoices, 'pt-AO')?.name).toBe('Joana');
  });

  it('prefere uma voz de efeito do idioma a nenhuma', () => {
    expect(pickVoice([voice('Eddy (Portuguese (Brazil))', 'pt-BR')], 'pt-BR')?.name).toBe('Eddy (Portuguese (Brazil))');
  });

  it('reconhece as vozes de efeito do iOS pelo identificador', () => {
    const ios = [
      voice('Eddy', 'pt-BR', { identifier: 'com.apple.eloquence.pt-BR.Eddy' }),
      voice('Luciana', 'pt-BR', { identifier: 'com.apple.voice.compact.pt-BR.Luciana' }),
    ];
    expect(pickVoice(ios, 'pt-BR')?.name).toBe('Luciana');
  });

  it('prefere Enhanced, depois a padrão, depois a local', () => {
    expect(pickVoice([voice('A', 'pt-BR'), voice('B', 'pt-BR', { quality: Speech.VoiceQuality.Enhanced })], 'pt-BR')?.name).toBe('B');
    expect(pickVoice([voice('A', 'pt-BR'), voice('B', 'pt-BR', { isDefault: true })], 'pt-BR')?.name).toBe('B');
    expect(pickVoice([voice('Google', 'pt-BR', { localService: false }), voice('Local', 'pt-BR', { localService: true })], 'pt-BR')?.name).toBe('Local');
  });

  it('aceita pt_BR e maiúsculas trocadas (Android)', () => {
    expect(pickVoice([voice('pt-br-x-afs-local', 'pt_br')], 'pt-BR')?.name).toBe('pt-br-x-afs-local');
  });

  it('sem voz no idioma devolve null', () => {
    expect(pickVoice(macVoices, 'ja-JP')).toBeNull();
    expect(pickVoice([], 'pt-BR')).toBeNull();
  });
});

describe('voz da navegação', () => {
  const fix = { t: 1, lat: -23.5, lon: -46.6 };

  it('fala com a voz escolhida para o idioma das instruções', async () => {
    vi.mocked(Speech.getAvailableVoicesAsync).mockResolvedValueOnce(macVoices as Speech.Voice[]);
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    await settle();
    expect(Speech.speak).toHaveBeenCalledWith('Vire à direita', { language: 'pt-BR', voice: 'Luciana', rate: 1.02 });
  });

  it('instrução corta a fala em curso, aviso de velocidade entra na fila', async () => {
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    await settle();
    expect(Speech.speak).toHaveBeenLastCalledWith('Vire à direita', expect.anything());
    const stops = vi.mocked(Speech.stop).mock.calls.length;
    expect(stops).toBeGreaterThan(0);
    mocks.announcement = 'Atenção: limite de 40 km/h';
    mocks.announcementQueued = true;
    useLocationStore.setState({ fix: { ...fix, t: 2 } });
    await settle();
    expect(Speech.speak).toHaveBeenLastCalledWith('Atenção: limite de 40 km/h', expect.anything());
    expect(Speech.stop).toHaveBeenCalledTimes(stops);
  });

  it('sem voz no idioma, fala só com o idioma', async () => {
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    await settle();
    expect(Speech.speak).toHaveBeenCalledWith('Vire à direita', { language: 'pt-BR', voice: undefined, rate: 1.02 });
  });

  it('descarta a fala que ainda esperava a voz quando a navegação para', async () => {
    let resolve!: (v: Speech.Voice[]) => void;
    vi.mocked(Speech.getAvailableVoicesAsync).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    await stopNavigation();
    resolve(macVoices as Speech.Voice[]);
    await settle();
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('descarta a fala pendente quando a voz é desligada em Ajustes', async () => {
    let resolve!: (v: Speech.Voice[]) => void;
    vi.mocked(Speech.getAvailableVoicesAsync).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    useSettings.setState({ voice: false });
    resolve(macVoices as Speech.Voice[]);
    await settle();
    expect(Speech.speak).not.toHaveBeenCalled();
  });

  it('ligar e desligar o mudo descarta a fala pendente, mas não as próximas', async () => {
    let resolve!: (v: Speech.Voice[]) => void;
    vi.mocked(Speech.getAvailableVoicesAsync).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    useSettings.setState({ voice: true });
    useLocationStore.setState({ fix });
    mocks.announcement = 'Vire à direita';
    await startNavigation(plan, 0, false);
    toggleMute();
    toggleMute();
    resolve(macVoices as Speech.Voice[]);
    await settle();
    expect(Speech.speak).not.toHaveBeenCalled();
    mocks.announcement = 'Vire à esquerda';
    useLocationStore.setState({ fix: { ...fix, t: 2 } });
    await settle();
    expect(Speech.speak).toHaveBeenCalledWith('Vire à esquerda', { language: 'pt-BR', voice: 'Luciana', rate: 1.02 });
  });
});

describe('navegação com a tela bloqueada', () => {
  const startBg = vi.mocked(startBackgroundLocation);
  const stopBg = vi.mocked(stopBackgroundLocation);

  it('na navegação real, inicia a localização em segundo plano com o destino', async () => {
    await startNavigation(plan, 0, false);
    expect(startBg).toHaveBeenCalledWith('Av. Paulista, 1000');
  });

  it('na simulação, não usa localização em segundo plano', async () => {
    await startNavigation(plan, 0, true);
    expect(startBg).not.toHaveBeenCalled();
  });

  it('com a chave desligada em Ajustes, não inicia', async () => {
    useSettings.setState({ backgroundNav: false });
    await startNavigation(plan, 0, false);
    expect(startBg).not.toHaveBeenCalled();
  });

  it('para a localização em segundo plano ao encerrar', async () => {
    await startNavigation(plan, 0, false);
    stopBg.mockClear();
    await stopNavigation();
    expect(stopBg).toHaveBeenCalledTimes(1);
  });

  it('quando o sistema recusa, segue navegando e avisa que a tela precisa ficar ligada', async () => {
    startBg.mockResolvedValueOnce(false);
    await startNavigation(plan, 0, false);
    await settle();
    const s = useNavSession.getState();
    expect(s.status).toBe('navigating');
    expect(s.error).toBe('Com a tela bloqueada, a navegação pausa neste aparelho.');
  });

  it('a recusa que chega depois de encerrar não vira aviso na próxima sessão', async () => {
    let resolve!: (ok: boolean) => void;
    startBg.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await startNavigation(plan, 0, false);
    await stopNavigation();
    await startNavigation(plan, 0, true);
    resolve(false);
    await settle();
    expect(useNavSession.getState().error).toBeNull();
  });
});

describe('envio do rastro', () => {
  const samples = vi.mocked(api.samples);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('envia pelos fixes, sem depender do timer que o Android pausa com o app em segundo plano', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await startNavigation(plan, 0, false);
    useLocationStore.setState({ fix: { t: 1, lat: 0, lon: 0 } });
    await settle();
    samples.mockClear();
    now += 16_000;
    useLocationStore.setState({ fix: { t: 2, lat: 0, lon: 0 } });
    await settle();
    expect(samples).toHaveBeenCalledTimes(1);
  });

  it('divide em lotes de até 2000 amostras, o limite da API', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await startNavigation(plan, 0, false);
    useLocationStore.setState({ fix: { t: 0, lat: 0, lon: 0 } });
    await settle();
    samples.mockClear();
    samples.mockRejectedValue(new Error('offline'));
    for (let t = 1; t <= 4500; t++) {
      if (t % 1000 === 0) now += 16_000;
      useLocationStore.setState({ fix: { t, lat: 0, lon: 0 } });
    }
    await settle();
    expect(samples.mock.calls.every(([, batch]) => batch.length <= 2000)).toBe(true);
    samples.mockReset();
    samples.mockResolvedValue({ stored: 0 });
    await stopNavigation();
    const sent = samples.mock.calls.flatMap(([, batch]) => batch.map((b) => b.t));
    expect(samples.mock.calls.every(([, batch]) => batch.length <= 2000)).toBe(true);
    expect(sent).toEqual(Array.from({ length: 4501 }, (_, i) => i));
  });
});

describe('envio do rastro entre viagens', () => {
  const samples = vi.mocked(api.samples);
  const finishTrip = vi.mocked(api.finishTrip);
  const at = (t: number) => ({ t, lat: 0, lon: 0 });
  const sentTo = (tripId: string) => samples.mock.calls.filter(([id]) => id === tripId).flatMap(([, b]) => b.map((x) => x.t));
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(api.startTrip).mockResolvedValueOnce({ tripId: 'A' }).mockResolvedValueOnce({ tripId: 'B' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Viagem A com um envio pendente, depois a viagem B começa. */
  async function startAThenB(pendingA: Promise<{ stored: number }>) {
    samples.mockReturnValueOnce(pendingA);
    await startNavigation(plan, 0, false);
    useLocationStore.setState({ fix: at(1) });
    now += 16_000;
    useLocationStore.setState({ fix: at(2) });
    await settle();
    expect(sentTo('A')).toEqual([1, 2]);
    await startNavigation(plan, 0, false);
    await settle();
  }

  it('encerra a viagem B com o rastro dela, mesmo com um envio da viagem A pendente', async () => {
    let releaseA!: () => void;
    await startAThenB(new Promise((r) => (releaseA = () => r({ stored: 2 }))));
    useLocationStore.setState({ fix: at(3) });
    const stopping = stopNavigation();
    await settle();
    releaseA();
    await stopping;
    // B começa com o último fix conhecido (2). Com o rastro de A misturado, seria [1, 2, 2, 3].
    expect(sentTo('B')).toEqual([2, 3]);
    const sendB = samples.mock.invocationCallOrder[samples.mock.calls.findIndex(([id]) => id === 'B')]!;
    expect(sendB).toBeLessThan(finishTrip.mock.invocationCallOrder[0]!);
    expect(finishTrip).toHaveBeenCalledWith('B');
  });

  it('um envio da viagem A que falha depois de B começar não põe o rastro de A em B', async () => {
    let failA!: () => void;
    await startAThenB(new Promise((_, reject) => (failA = () => reject(new Error('offline')))));
    failA();
    await settle();
    useLocationStore.setState({ fix: at(3) });
    await stopNavigation();
    // B começa com o último fix conhecido (2). Com o rastro de A misturado, seria [1, 2, 2, 3].
    expect(sentTo('B')).toEqual([2, 3]);
  });
});

describe('resposta atrasada de startTrip', () => {
  const startTrip = vi.mocked(api.startTrip);

  it('a resposta de uma viagem já encerrada não muda a navegação seguinte', async () => {
    let releaseA!: () => void;
    startTrip
      .mockReturnValueOnce(new Promise((r) => (releaseA = () => r({ tripId: 'A' }))))
      .mockResolvedValueOnce({ tripId: 'B' });
    const startingA = startNavigation(plan, 0, false);
    await settle();
    await stopNavigation();
    await startNavigation(plan, 0, false);
    releaseA();
    await startingA;
    expect(useNavSession.getState().tripId).toBe('B');
    await stopNavigation();
    // A órfã A é encerrada assim que a resposta chega: sem amostras, o servidor a descarta.
    expect(vi.mocked(api.finishTrip).mock.calls.map((c) => c[0])).toEqual(['A', 'B']);
  });

  it('a falha de uma viagem já encerrada não mostra erro', async () => {
    let failA!: () => void;
    startTrip.mockReturnValueOnce(new Promise((_, reject) => (failA = () => reject(new Error('offline')))));
    const startingA = startNavigation(plan, 0, false);
    await settle();
    await stopNavigation();
    failA();
    await startingA;
    expect(useNavSession.getState().error).toBeNull();
    expect(useNavSession.getState().tripId).toBeNull();
  });
});

describe('navegação com a tela bloqueada sem suporte (web)', () => {
  it('não tenta iniciar nem mostra aviso', async () => {
    mocks.bgSupported = false;
    await startNavigation(plan, 0, false);
    await settle();
    expect(startBackgroundLocation).not.toHaveBeenCalled();
    expect(useNavSession.getState().error).toBeNull();
  });
});

describe('navegação sem rede', () => {
  const fix = { t: 1, lat: -23.5, lon: -46.6 };
  const sample = { t: 1, lat: -23.5, lon: -46.6, speed: null, heading: null, accuracy: 5 };

  it('grava a viagem ativa com o id do servidor', async () => {
    await startNavigation(plan, 0, false);
    await settle();
    expect(stored()).toMatchObject({ tripId: 't1', routeIndex: 0 });
  });

  it('não grava a simulação', async () => {
    await startNavigation(plan, 0, true);
    await settle();
    expect(stored()).toBeNull();
  });

  it('encerrar apaga a viagem gravada', async () => {
    await startNavigation(plan, 0, false);
    await stopNavigation();
    await settle();
    expect(stored()).toBeNull();
  });

  it('retoma a viagem depois de reabrir o app e envia o rastro guardado', async () => {
    await saveActiveTrip({
      savedAt: Date.now(),
      apiUrl: 'https://api.wayboo.app',
      plan,
      routeIndex: 0,
      stops: [],
      tripId: 't9',
      buffer: [sample],
    });
    expect(await resumeNavigation()).toBe(true);
    const s = useNavSession.getState();
    expect(s).toMatchObject({ status: 'navigating', tripId: 't9', simulated: false });
    expect(s.route).toEqual(plan.routes[0]!.route);
    expect(api.startTrip).not.toHaveBeenCalled();
    await stopNavigation();
    expect(api.samples).toHaveBeenCalledWith('t9', [sample]);
    expect(api.finishTrip).toHaveBeenCalledWith('t9');
  });

  it('sem viagem gravada não retoma', async () => {
    expect(await resumeNavigation()).toBe(false);
    expect(useNavSession.getState().status).toBe('idle');
  });

  it('não retoma por cima de uma navegação em curso', async () => {
    await startNavigation(plan, 0, true);
    await saveActiveTrip({ savedAt: Date.now(), apiUrl: 'https://api.wayboo.app', plan, routeIndex: 0, stops: [], tripId: 't9', buffer: [] });
    expect(await resumeNavigation()).toBe(false);
    expect(useNavSession.getState().simulated).toBe(true);
  });

  it('sem rede ao recalcular, segue a rota anterior e avisa', async () => {
    vi.mocked(api.plan).mockRejectedValueOnce(new ApiError(0, 'Sem conexão com o servidor (x). Confira a URL em Ajustes.'));
    mocks.offRoute = true;
    useLocationStore.setState({ fix });
    await startNavigation(plan, 0, false);
    await settle();
    const s = useNavSession.getState();
    expect(s.route).toBe(plan.routes[0]!.route);
    expect(s.rerouting).toBe(false);
    expect(s.error).toBe('Sem conexão: seguindo a rota anterior.');
  });

  it('recálculo com sucesso limpa o aviso e grava a rota nova', async () => {
    const next = { ...plan, planId: 'p2', recommendedIndex: 0, routes: [{ route: { id: 'r2' }, eta: { segmentDurationsS: [] } }] };
    let resolve!: (r: PlanResponse) => void;
    vi.mocked(api.plan).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    mocks.offRoute = true;
    useLocationStore.setState({ fix });
    await startNavigation(plan, 0, false);
    useNavSession.setState({ error: 'Sem conexão: seguindo a rota anterior.' });
    resolve(next as unknown as PlanResponse);
    await settle();
    await settle();
    const s = useNavSession.getState();
    expect(s.route).toEqual({ id: 'r2' });
    expect(s.error).toBeNull();
    expect(JSON.parse(mocks.async.get(TRIP_KEY)!).plan.planId).toBe('p2');
  });

  it('o lote em envio fica na gravação até o servidor confirmar', async () => {
    vi.useFakeTimers();
    try {
      let confirm!: () => void;
      vi.mocked(api.samples).mockReturnValueOnce(new Promise((r) => (confirm = () => r({ stored: 1 }))));
      useLocationStore.setState({ fix: { t: 1, lat: -23.5, lon: -46.6 } });
      await startNavigation(plan, 0, false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(api.samples).toHaveBeenCalledTimes(1);
      // Uma parada visitada grava a viagem enquanto o envio espera resposta.
      mocks.visit = true;
      useLocationStore.setState({ fix: { t: 2, lat: -23.5, lon: -46.6 } });
      await vi.advanceTimersByTimeAsync(0);
      const pending = JSON.parse(mocks.async.get(TRIP_KEY)!) as { buffer: { t: number }[] };
      expect(pending.buffer.map((x) => x.t)).toEqual([1, 2]);
      confirm();
      mocks.visit = false;
      await vi.advanceTimersByTimeAsync(15_000);
      const after = JSON.parse(mocks.async.get(TRIP_KEY)!) as { buffer: { t: number }[] };
      expect(after.buffer.map((x) => x.t)).not.toContain(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recálculo que o servidor não registra mantém o navegador da rota anterior', async () => {
    const next = { ...plan, planId: 'p2', recommendedIndex: 0, routes: [{ route: { id: 'r2' }, eta: { segmentDurationsS: [] }, alerts: [] }] };
    vi.mocked(api.plan).mockResolvedValueOnce(next as unknown as PlanResponse);
    vi.mocked(api.reroute).mockRejectedValueOnce(new ApiError(0, 'Sem conexão'));
    mocks.offRoute = true;
    useLocationStore.setState({ fix: { t: 1, lat: -23.5, lon: -46.6 } });
    await startNavigation(plan, 0, false);
    await settle();
    expect(useNavSession.getState().route).toEqual({ id: 'r0' });
    mocks.offRoute = false;
    useLocationStore.setState({ fix: { t: 2, lat: -23.5, lon: -46.6 } });
    const old = mocks.navigators.find((n) => (n.route as { id: string }).id === 'r0')!;
    const fresh = mocks.navigators.find((n) => (n.route as { id: string }).id === 'r2');
    expect(old.updates).toBe(2);
    expect(fresh?.updates ?? 0).toBe(0);
  });

  it('um envio do rastro espera o anterior e nenhum lote sai da gravação antes da confirmação', async () => {
    vi.useFakeTimers();
    try {
      const confirms: (() => void)[] = [];
      vi.mocked(api.samples).mockImplementation(() => new Promise((r) => confirms.push(() => r({ stored: 1 }))));
      useLocationStore.setState({ fix: { t: 1, lat: -23.5, lon: -46.6 } });
      await startNavigation(plan, 0, false);
      await vi.advanceTimersByTimeAsync(15_000);
      useLocationStore.setState({ fix: { t: 2, lat: -23.5, lon: -46.6 } });
      // O primeiro envio ainda espera: o segundo tique não começa outro.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(api.samples).toHaveBeenCalledTimes(1);
      mocks.visit = true;
      useLocationStore.setState({ fix: { t: 3, lat: -23.5, lon: -46.6 } });
      await vi.advanceTimersByTimeAsync(0);
      const saved = JSON.parse(mocks.async.get(TRIP_KEY)!) as { buffer: { t: number }[] };
      expect(saved.buffer.map((x) => x.t)).toEqual([1, 2, 3]);
      confirms[0]!();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.samples).toHaveBeenCalledTimes(2);
      expect(vi.mocked(api.samples).mock.calls[1]![1].map((x) => x.t)).toEqual([2, 3]);
      confirms[1]!();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.mocked(api.samples).mockReset();
      vi.mocked(api.samples).mockImplementation(async () => ({ stored: 0 }));
      vi.useRealTimers();
    }
  });

  it('recálculo de uma navegação encerrada não mexe na navegação nova', async () => {
    let answer!: (r: PlanResponse) => void;
    vi.mocked(api.plan).mockReturnValueOnce(new Promise((r) => (answer = r)));
    mocks.offRoute = true;
    useLocationStore.setState({ fix: { t: 1, lat: -23.5, lon: -46.6 } });
    await startNavigation(plan, 0, false);
    expect(api.plan).toHaveBeenCalledTimes(1);
    await stopNavigation();
    mocks.offRoute = false;
    const other = { ...plan, planId: 'p3', routes: [{ route: { id: 'r3' }, eta: { segmentDurationsS: [] }, alerts: [] }] } as unknown as PlanResponse;
    await startNavigation(other, 0, false);
    answer({ ...plan, planId: 'p2', recommendedIndex: 0, routes: [{ route: { id: 'r2' }, eta: { segmentDurationsS: [] }, alerts: [] }] } as unknown as PlanResponse);
    await settle();
    expect(useNavSession.getState()).toMatchObject({ route: { id: 'r3' }, rerouting: false, error: null });
    expect(api.reroute).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.async.get(TRIP_KEY)!).plan.planId).toBe('p3');
  });

  it('grava o lote antes de enviar, sem depender de outra gravação no meio', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    try {
      vi.mocked(api.samples).mockReturnValueOnce(new Promise((r) => (release = () => r({ stored: 1 }))));
      useLocationStore.setState({ fix: { t: 1, lat: -23.5, lon: -46.6 } });
      await startNavigation(plan, 0, false);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(api.samples).toHaveBeenCalledTimes(1);
      const saved = JSON.parse(mocks.async.get(TRIP_KEY)!) as { buffer: { t: number }[] };
      expect(saved.buffer.map((x) => x.t)).toEqual([1]);
    } finally {
      release?.();
      vi.useRealTimers();
    }
  });

  it('viagem criada por uma navegação já encerrada não entra na navegação nova', async () => {
    let first!: (r: { tripId: string }) => void;
    vi.mocked(api.startTrip).mockReturnValueOnce(new Promise((r) => (first = r)));
    vi.mocked(api.startTrip).mockResolvedValueOnce({ tripId: 't2' });
    const starting = startNavigation(plan, 0, false);
    await stopNavigation();
    await startNavigation(plan, 0, false);
    first({ tripId: 't-old' });
    await starting;
    await settle();
    expect(useNavSession.getState().tripId).toBe('t2');
    expect(JSON.parse(mocks.async.get(TRIP_KEY)!).tripId).toBe('t2');
    // A viagem órfã é encerrada: sem amostras, o servidor a descarta.
    expect(api.finishTrip).toHaveBeenCalledWith('t-old');
  });

  it('falha de startTrip de uma navegação encerrada não aparece na nova', async () => {
    let fail!: (e: Error) => void;
    vi.mocked(api.startTrip).mockReturnValueOnce(new Promise((_, r) => (fail = r)));
    const starting = startNavigation(plan, 0, false);
    await stopNavigation();
    await startNavigation(plan, 0, false);
    fail(new Error('Viagem não registrada'));
    await starting;
    expect(useNavSession.getState()).toMatchObject({ tripId: 't1', error: null });
  });

  it('retomada que termina de ler depois de outra navegação começar e acabar é descartada', async () => {
    await saveActiveTrip({ savedAt: Date.now(), apiUrl: 'https://api.wayboo.app', plan, routeIndex: 0, stops: [], tripId: 't9', buffer: [] });
    let open!: () => void;
    mocks.readGate = new Promise((r) => (open = r));
    const resuming = resumeNavigation();
    await startNavigation(plan, 0, true);
    await stopNavigation();
    expect(useNavSession.getState().status).toBe('idle');
    open();
    expect(await resuming).toBe(false);
    expect(useNavSession.getState()).toMatchObject({ status: 'idle', tripId: null });
  });
});
