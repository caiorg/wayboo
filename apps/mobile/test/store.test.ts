import * as SecureStore from 'expo-secure-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios',
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  secureFails: false,
  secureReadFails: false,
  removeFails: false,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.async.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.async.set(k, v),
    removeItem: async (k: string) => {
      if (h.removeFails) throw new Error('disco cheio');
      h.async.delete(k);
    },
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (k: string) => {
    if (h.secureReadFails) throw new Error('keychain bloqueado');
    return h.secure.get(k) ?? null;
  }),
  setItemAsync: vi.fn(async (k: string, v: string) => {
    if (h.secureFails) throw new Error('keychain indisponível');
    h.secure.set(k, v);
  }),
  deleteItemAsync: vi.fn(async (k: string) => void h.secure.delete(k)),
}));

const URL_A = 'http://192.168.0.10:8787';

/** Importa o store do zero, como numa abertura do app, e espera a hidratação. */
async function openApp() {
  vi.resetModules();
  const store = await import('../src/lib/store');
  await store.settingsHydration;
  return store;
}

const savedJson = () => h.async.get('wayboo-settings') ?? '';

/** Estado salvo por uma versão anterior do app: token em texto puro no AsyncStorage. */
function seedPlainToken() {
  h.async.set(
    'wayboo-settings',
    JSON.stringify({ state: { userId: 'local-1', credentials: { [URL_A]: { token: 'TOKEN-A', userId: 'user-a' } }, apiUrl: URL_A }, version: 0 }),
  );
}

beforeEach(() => {
  h.os = 'ios';
  h.async.clear();
  h.secure.clear();
  h.secureFails = false;
  h.secureReadFails = false;
  h.removeFails = false;
  vi.clearAllMocks();
});

describe('token do aparelho', () => {
  it('no nativo, grava o token no secure store e não no AsyncStorage', async () => {
    const { useSettings } = await openApp();
    useSettings.getState().setCredential(URL_A, { token: 'TOKEN-A', userId: 'user-a' });

    await vi.waitFor(() => expect([...h.secure.values()]).toContain('TOKEN-A'));
    await vi.waitFor(() => expect(savedJson()).toContain('user-a'));
    expect(savedJson()).not.toContain('TOKEN-A');
  });

  it('migra o token do AsyncStorage para o secure store sem perder a sessão', async () => {
    seedPlainToken();
    const { useSettings } = await openApp();

    expect(useSettings.getState().credentials[URL_A]).toEqual({ token: 'TOKEN-A', userId: 'user-a' });
    await vi.waitFor(() => expect([...h.secure.values()]).toContain('TOKEN-A'));
    await vi.waitFor(() => expect(savedJson()).not.toContain('TOKEN-A'));
    expect(savedJson()).toContain('user-a');

    // Próxima abertura: o token vem do secure store.
    const reopened = await openApp();
    expect(reopened.useSettings.getState().credentials[URL_A]).toEqual({ token: 'TOKEN-A', userId: 'user-a' });
  });

  it('mantém o token no AsyncStorage enquanto o secure store falhar', async () => {
    seedPlainToken();
    h.secureFails = true;
    const { useSettings } = await openApp();

    expect(useSettings.getState().credentials[URL_A]).toEqual({ token: 'TOKEN-A', userId: 'user-a' });
    useSettings.getState().set({ voice: false });
    await vi.waitFor(() => expect(savedJson()).toContain('"voice":false'));
    expect(savedJson()).toContain('TOKEN-A');

    // Secure store volta a funcionar: a próxima abertura conclui a migração.
    h.secureFails = false;
    const reopened = await openApp();
    expect(reopened.useSettings.getState().credentials[URL_A]).toEqual({ token: 'TOKEN-A', userId: 'user-a' });
    await vi.waitFor(() => expect(savedJson()).not.toContain('TOKEN-A'));
  });

  it('com falha na leitura do secure store, não grava por cima dos ajustes salvos', async () => {
    seedPlainToken();
    await openApp();
    await vi.waitFor(() => expect(savedJson()).not.toContain('TOKEN-A'));
    const before = savedJson();

    h.secureReadFails = true;
    const { useSettings, settingsHydration } = await openApp();
    expect(await settingsHydration).not.toBeNull();
    useSettings.getState().set({ voice: false });
    useSettings.getState().setCredential('http://outro:8787', { token: 'TOKEN-B' });
    await new Promise((r) => setTimeout(r, 50));

    expect(savedJson()).toBe(before);
    expect([...h.secure.values()]).toEqual(['TOKEN-A']);
  });

  it('não grava antes de a hidratação terminar', async () => {
    seedPlainToken();
    vi.resetModules();
    const { useSettings, settingsHydration } = await import('../src/lib/store');
    // Antes da leitura: o estado ainda é o padrão.
    useSettings.getState().set({ voice: false });
    await settingsHydration;

    expect(useSettings.getState().credentials[URL_A]).toEqual({ token: 'TOKEN-A', userId: 'user-a' });
    await vi.waitFor(() => expect(savedJson()).not.toContain('TOKEN-A'));
    expect(savedJson()).toContain('user-a');
    expect(savedJson()).toContain('local-1');
  });

  it('na web, o token continua no AsyncStorage', async () => {
    h.os = 'web';
    const { useSettings } = await openApp();
    useSettings.getState().setCredential(URL_A, { token: 'TOKEN-A', userId: 'user-a' });

    await vi.waitFor(() => expect(savedJson()).toContain('TOKEN-A'));
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
  });
});

describe('chave antiga trajeto-settings', () => {
  const saved = JSON.stringify({ state: { userId: 'local-1', credentials: {}, apiUrl: URL_A, voice: false }, version: 0 });

  it('sem a chave nova, move o valor da antiga para ela', async () => {
    h.async.set('trajeto-settings', saved);
    const { useSettings } = await openApp();

    expect(useSettings.getState().userId).toBe('local-1');
    expect([...h.async.keys()]).toEqual(['wayboo-settings']);
    expect(savedJson()).toBe(saved);
  });

  it('com as duas chaves, apaga a antiga e mantém a nova', async () => {
    const legacy = JSON.stringify({ state: { userId: 'antigo', voice: true }, version: 0 });
    h.async.set('wayboo-settings', saved);
    h.async.set('trajeto-settings', legacy);
    const { useSettings } = await openApp();

    expect(useSettings.getState().userId).toBe('local-1');
    expect([...h.async.keys()]).toEqual(['wayboo-settings']);
    expect(savedJson()).toBe(saved);
  });

  it('se apagar a antiga falhar, abre com a nova e tenta de novo na próxima abertura', async () => {
    h.async.set('wayboo-settings', saved);
    h.async.set('trajeto-settings', JSON.stringify({ state: { userId: 'antigo' }, version: 0 }));
    h.removeFails = true;
    const { useSettings, settingsHydration } = await openApp();

    expect(await settingsHydration).toBeNull();
    expect(useSettings.getState().userId).toBe('local-1');
    expect([...h.async.keys()].sort()).toEqual(['trajeto-settings', 'wayboo-settings']);

    h.removeFails = false;
    await openApp();
    expect([...h.async.keys()]).toEqual(['wayboo-settings']);
    expect(savedJson()).toBe(saved);
  });
});

describe('navegação com a tela bloqueada', () => {
  it('vem ligada, também para quem já tinha ajustes salvos antes da chave existir', async () => {
    seedPlainToken();
    const { useSettings } = await openApp();
    expect(useSettings.getState().backgroundNav).toBe(true);
  });
});
