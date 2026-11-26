import type { PlanResponse } from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Speech from 'expo-speech';
import { saveActiveTrip } from '../src/lib/activeTrip';
import { api, ApiError } from '../src/lib/api';
import { pickVoice, resumeNavigation, startNavigation, stopNavigation, toggleMute, useNavSession, type VoiceInfo } from '../src/lib/navigation';
import { useLocationStore } from '../src/lib/location';
import { useSettings } from '../src/lib/store';

const mocks = vi.hoisted(() => ({
  announcement: null as string | null,
  offRoute: false,
  visit: false,
  async: new Map<string, string>(),
  navigators: [] as { route: unknown; updates: number }[],
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => mocks.async.get(k) ?? null,
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
        return { arrived: false, offRoute: mocks.offRoute, announcement: mocks.announcement };
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
    useSettings: create(() => ({ voice: false, avoidTolls: false, avoidHighways: false, apiUrl: 'https://api.wayboo.app' })),
  };
});

const plan = {
  planId: 'p1',
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
  mocks.offRoute = false;
  mocks.visit = false;
  mocks.navigators = [];
  mocks.async.clear();
  useSettings.setState({ voice: false });
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
});
