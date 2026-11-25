import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  os: 'ios' as 'ios' | 'web',
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  saved: [] as string[],
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return h.os;
    },
  },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => crypto.randomUUID(),
  getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.async.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.async.set(k, v),
    removeItem: async (k: string) => void h.async.delete(k),
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => h.secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void h.secure.set(k, v),
  deleteItemAsync: async (k: string) => void h.secure.delete(k),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));
vi.mock('../src/lib/saveJson', () => ({ saveJson: async (_name: string, text: string) => void h.saved.push(text) }));

const KEY = 'sk-proj-app-QZXW9-0123456789abcdefABCDEF';
const CHOICE = { provider: 'openai', model: 'gpt-4o-mini' } as const;

type Sent = { url: string; headers: Record<string, string> };

/** Servidor falso: registra o aparelho e responde às rotas; `status` força a resposta das rotas de IA. */
function fakeServer(opts: { aiStatus?: number; aiError?: string } = {}) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    sent.push({ url, headers });
    const path = new URL(url).pathname;
    const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (path === '/auth/device') return body({ userId: crypto.randomUUID() });
    const ai = path === '/assistant' || path === '/insights/narrative' || path.endsWith('/brief');
    if (ai && opts.aiStatus) return body({ error: opts.aiError ?? 'erro' }, opts.aiStatus);
    if (path === '/me/export') return body({ userId: 'u', exportedAt: 'x', tables: { trips: [] } });
    return body({});
  });
  return { fetch, sent, keySent: () => sent.filter((s) => JSON.stringify(s).includes(KEY)) };
}

const consoleOut: string[] = [];

beforeEach(() => {
  h.os = 'ios';
  h.async.clear();
  h.secure.clear();
  h.saved = [];
  vi.resetModules();
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleOut.push(a.map(String).join(' ')));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load() {
  const store = await import('../src/lib/store');
  const aiKey = await import('../src/lib/aiKey');
  const { api, ApiError, AiKeyError } = await import('../src/lib/api');
  const { exportMyData } = await import('../src/lib/exportData');
  await store.settingsHydration;
  return { ...store, ...aiKey, api, ApiError, AiKeyError, exportMyData };
}

const aiCalls = async (api: Awaited<ReturnType<typeof load>>['api']) => {
  await api.brief(crypto.randomUUID());
  await api.assistant('me leva pra casa', { lat: -23.5, lon: -46.6 });
  await api.narrative();
};

describe('chave de IA do usuário no app', () => {
  it('salva a chave no secure store, fora dos ajustes', async () => {
    const m = await load();
    await m.saveAi(CHOICE, KEY);
    await m.settingsSaved();

    expect(h.secure.get(m.AI_KEY_STORE)).toBe(KEY);
    expect(JSON.stringify([...h.async])).not.toContain(KEY);
    expect(m.useSettings.getState().ai).toEqual(CHOICE);
    expect(await m.hasAiKey()).toBe(true);
  });

  it('na web, a chave fica no armazenamento do navegador, numa entrada separada dos ajustes', async () => {
    h.os = 'web';
    const m = await load();
    await m.saveAi(CHOICE, KEY);
    await m.settingsSaved();

    expect(m.aiKeyInBrowser()).toBe(true);
    expect(h.async.get(m.AI_KEY_STORE)).toBe(KEY);
    expect(h.async.get('wayboo-settings')).not.toContain(KEY);
  });

  it('manda a chave só nas chamadas de IA', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const m = await load();
    m.useSettings.getState().set({ apiUrl: 'https://wayboo.example' });
    await m.saveAi(CHOICE, KEY);

    await aiCalls(m.api);
    await m.api.privacy();
    await m.api.insights();
    await m.exportMyData();

    const withKey = server.keySent().map((s) => new URL(s.url).pathname);
    expect(withKey).toHaveLength(3);
    expect(withKey).toEqual(expect.arrayContaining(['/assistant', '/insights/narrative']));
    for (const s of server.keySent()) {
      expect(s.headers).toMatchObject({ 'x-ai-provider': 'openai', 'x-ai-model': 'gpt-4o-mini', 'x-ai-key': KEY });
    }
  });

  it('sem chave própria não manda cabeçalhos de IA: o servidor usa o provedor padrão', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const m = await load();

    await aiCalls(m.api);

    expect(server.sent.length).toBeGreaterThan(0);
    for (const s of server.sent) expect(Object.keys(s.headers).filter((k) => k.startsWith('x-ai-'))).toEqual([]);
  });

  it('recusa mandar a chave por HTTP fora do localhost, com erro claro', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const m = await load();
    m.useSettings.getState().set({ apiUrl: 'http://192.168.0.10:8787' });
    await m.saveAi(CHOICE, KEY);

    const err = await m.api.narrative().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(m.AiKeyError);
    expect((err as Error).message).toMatch(/HTTPS/);
    expect(server.keySent()).toEqual([]);

    // Em localhost (proxy ou emulador), HTTP vale.
    m.useSettings.getState().set({ apiUrl: 'http://localhost:8787' });
    await m.api.narrative();
    expect(server.keySent()).toHaveLength(1);
  });

  it('chave recusada pelo provedor chega como erro claro', async () => {
    const message = 'A chave de IA foi recusada pela OpenAI. Confira a chave em Ajustes.';
    vi.stubGlobal('fetch', fakeServer({ aiStatus: 422, aiError: message }).fetch);
    const m = await load();
    await m.saveAi(CHOICE, KEY);

    const err = await m.api.brief(crypto.randomUUID()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(m.AiKeyError);
    expect(err).toMatchObject({ status: 422, message });
  });

  it('chave escolhida mas ausente do aparelho: erro claro em vez de usar o servidor calado', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const m = await load();
    await m.saveAi(CHOICE, KEY);
    h.secure.clear();

    const err = await m.api.narrative().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(m.AiKeyError);
    expect((err as Error).message).toMatch(/Ajustes/);
    expect(server.sent.filter((s) => s.url.endsWith('/insights/narrative'))).toEqual([]);
  });

  it('remover apaga a chave do aparelho e volta para a IA do servidor', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const m = await load();
    await m.saveAi(CHOICE, KEY);

    await m.clearAi();
    await m.settingsSaved();

    expect(h.secure.has(m.AI_KEY_STORE)).toBe(false);
    expect(m.useSettings.getState().ai).toBeNull();
    expect(await m.hasAiKey()).toBe(false);
    await m.api.narrative();
    expect(server.keySent()).toEqual([]);
  });

  it('recusa chave em formato inválido sem gravar nada', async () => {
    const m = await load();
    await expect(m.saveAi(CHOICE, 'curta')).rejects.toThrow(/chave/i);
    await expect(m.saveAi(CHOICE, `${KEY} ${KEY}`)).rejects.toThrow(/chave/i);
    await expect(m.saveAi({ provider: 'openai', model: ' ' }, KEY)).rejects.toThrow(/modelo/i);
    expect(h.secure.size).toBe(0);
    expect(m.useSettings.getState().ai).toBeNull();
  });

  it('a chave não aparece no console nem no arquivo exportado', async () => {
    vi.stubGlobal('fetch', fakeServer({ aiStatus: 422, aiError: 'recusada' }).fetch);
    const m = await load();
    await m.saveAi(CHOICE, KEY);
    await aiCalls(m.api).catch(() => {});
    vi.stubGlobal('fetch', fakeServer().fetch);
    await m.exportMyData();

    expect(h.saved).toHaveLength(1);
    expect(h.saved.join('')).not.toContain(KEY);
    expect(consoleOut.join('\n')).not.toContain(KEY);
  });
});
