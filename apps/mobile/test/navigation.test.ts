import type { PlanResponse } from '@wayboo/core';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Speech from 'expo-speech';
import { pickVoice, startNavigation, stopNavigation, toggleMute, useNavSession, type VoiceInfo } from '../src/lib/navigation';
import { useLocationStore } from '../src/lib/location';
import { useSettings } from '../src/lib/store';

const mocks = vi.hoisted(() => ({ announcement: null as string | null }));

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
  createNavigator: () => ({ update: () => ({ arrived: false, offRoute: false, announcement: mocks.announcement }) }),
  simulateDrive: function* () {},
  markVisitedStops: (stops: unknown) => stops,
  rerouteRequest: () => ({}),
}));
vi.mock('../src/lib/api', () => ({
  api: {
    startTrip: vi.fn(async () => ({ tripId: 't1' })),
    finishTrip: vi.fn(async () => ({})),
    samples: vi.fn(async () => {}),
  },
}));
vi.mock('../src/lib/location', async () => {
  const { create } = await import('zustand');
  return { useLocationStore: create(() => ({ fix: null })) };
});
vi.mock('../src/lib/store', async () => {
  const { create } = await import('zustand');
  return { useSettings: create(() => ({ voice: false, avoidTolls: false, avoidHighways: false })) };
});

const plan = {
  planId: 'p1',
  waypoints: [],
  routes: [{ route: {}, eta: { segmentDurationsS: [] } }],
} as unknown as PlanResponse;

const activate = vi.mocked(activateKeepAwakeAsync);
const deactivate = vi.mocked(deactivateKeepAwake);
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  active.clear();
  mocks.announcement = null;
  useSettings.setState({ voice: false });
  useNavSession.setState({ muted: false });
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
