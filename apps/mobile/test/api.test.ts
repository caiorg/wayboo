import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  async: new Map<string, string>(),
  secure: new Map<string, string>(),
  /** Enquanto definida, toda gravação no AsyncStorage espera esta promessa. */
  saveGate: null as Promise<void> | null,
  saveFails: false,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));
vi.mock('expo-crypto', () => ({
  randomUUID: () => crypto.randomUUID(),
  getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.async.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      if (h.saveGate) await h.saveGate;
      if (h.saveFails) throw new Error('disco cheio');
      h.async.set(k, v);
    },
    removeItem: async (k: string) => void h.async.delete(k),
  },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => h.secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void h.secure.set(k, v),
  deleteItemAsync: async (k: string) => void h.secure.delete(k),
}));

/** Imita `registerDevice`, `userOfToken` e `DELETE /me` da API. */
function fakeServer() {
  const devices = new Map<string, string>();
  const registered: string[] = [];
  /** Chamadas autenticadas, com o token usado. */
  const calls: { route: string; token: string }[] = [];
  /** Segura a próxima resposta da rota (o servidor já processou o pedido) até `release`. */
  const held = new Map<string, { reached: () => void; gate: Promise<void> }>();
  const hold = (route: string) => {
    let release!: () => void;
    let reached!: () => void;
    const arrived = new Promise<void>((r) => (reached = r));
    held.set(route, { reached, gate: new Promise<void>((r) => (release = r)) });
    return { arrived, release };
  };
  const json = async (route: string, status: number, body: unknown) => {
    const h = held.get(route);
    if (h) {
      held.delete(route);
      h.reached();
      await h.gate;
    }
    return new Response(JSON.stringify(body), { status });
  };
  /** Enquanto definido, `POST /auth/device` responde 429 com este `Retry-After`. */
  let limited: string | null = null;
  const limit = (retryAfter: string | null) => void (limited = retryAfter);
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const route = `${init.method} ${path}`;
    if (path === '/auth/device') {
      if (limited !== null) {
        return new Response(JSON.stringify({ error: 'Muitos registros deste endereço; tente mais tarde' }), {
          status: 429,
          headers: { 'retry-after': limited },
        });
      }
      const { token, legacyUserId } = JSON.parse(String(init.body)) as { token: string; legacyUserId?: string };
      const known = devices.get(token);
      if (known) return json(route, 200, { userId: known });
      const claimed = [...devices.values()].includes(legacyUserId ?? '');
      const userId = legacyUserId && !claimed ? legacyUserId : crypto.randomUUID();
      devices.set(token, userId);
      registered.push(userId);
      return json(route, 200, { userId });
    }
    const token = String((init.headers as Record<string, string>).authorization ?? '').replace('Bearer ', '');
    calls.push({ route, token });
    const userId = devices.get(token);
    if (!userId) return json(route, 401, { error: 'token inválido' });
    if (path === '/me' && init.method === 'DELETE') {
      for (const [t, u] of devices) if (u === userId) devices.delete(t);
      return json(route, 200, { deleted: { trips: 3 } });
    }
    return json(route, 200, { shareCrowd: false });
  });
  return { fetch, registered, calls, hold, limit };
}

beforeEach(() => {
  h.async.clear();
  h.secure.clear();
  h.saveGate = null;
  h.saveFails = false;
  vi.resetModules();
});

describe('apagar os dados', () => {
  it('gera token e id novos e o servidor registra um usuário novo', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api } = await import('../src/lib/api');
    const { normalizeApiUrl, useSettings } = await import('../src/lib/store');
    const url = normalizeApiUrl(useSettings.getState().apiUrl);
    // Id exibido em Ajustes (`settings.tsx`).
    const shownId = () => useSettings.getState().credentials[url]?.userId ?? useSettings.getState().userId;

    await api.privacy();
    const before = useSettings.getState().credentials[url]!;
    expect(before.userId).toBe(shownId());
    await vi.waitFor(() => expect([...h.secure.values()]).toContain(before.token));

    await api.deleteMyData();
    expect(shownId()).not.toBe(before.userId);
    expect(useSettings.getState().credentials[url]).toBeUndefined();

    await api.privacy();
    const after = useSettings.getState().credentials[url]!;
    expect(after.token).not.toBe(before.token);
    expect(after.userId).not.toBe(before.userId);
    expect(after.userId).toBe(shownId());
    expect(server.registered).toEqual([before.userId, after.userId]);
    // A credencial antiga sai do aparelho.
    await vi.waitFor(() => expect([...h.secure.values()]).not.toContain(before.token));
  });

  it('registro pendente durante o DELETE não restaura nem repassa a credencial antiga', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api } = await import('../src/lib/api');
    const { normalizeApiUrl, useSettings } = await import('../src/lib/store');
    const url = normalizeApiUrl(useSettings.getState().apiUrl);

    await api.privacy();
    const old = useSettings.getState().credentials[url]!;

    // O servidor apaga, mas a resposta do DELETE demora.
    const del = server.hold('DELETE /me');
    const deleting = api.deleteMyData();
    await del.arrived;
    // Uma escrita leva 401 e registra o token antigo de novo; a resposta do registro também demora.
    const reg = server.hold('POST /auth/device');
    const stale = api.report('police', { lat: -23.5, lon: -46.6 });
    await reg.arrived;

    del.release();
    await deleting;
    const newId = useSettings.getState().userId;
    expect(newId).not.toBe(old.userId);

    // Chamada depois do reset: não reaproveita o registro antigo.
    await api.privacy();
    const fresh = useSettings.getState().credentials[url]!;
    expect(fresh.token).not.toBe(old.token);
    expect(fresh.userId).toBe(newId);

    // O registro antigo responde depois do reset: a escrita falha em vez de ir com o token antigo.
    const sent = server.calls.length;
    reg.release();
    await expect(stale).rejects.toThrow();
    expect(server.calls.slice(sent)).toEqual([]);
    expect(useSettings.getState().credentials[url]).toEqual(fresh);
    expect(useSettings.getState().userId).toBe(newId);
  });

  it('só conclui depois de salvar a identidade nova no aparelho', async () => {
    vi.stubGlobal('fetch', fakeServer().fetch);
    const { api } = await import('../src/lib/api');
    const store = await import('../src/lib/store');
    await api.privacy();
    const oldId = store.useSettings.getState().userId;

    let release!: () => void;
    h.saveGate = new Promise<void>((r) => (release = r));
    let done = false;
    const deleting = api.deleteMyData().then(() => (done = true));
    await vi.waitFor(() => expect(store.useSettings.getState().userId).not.toBe(oldId));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);

    release();
    h.saveGate = null;
    await deleting;
    // Reabertura: a identidade salva é a nova.
    vi.resetModules();
    const reopened = await import('../src/lib/store');
    await reopened.settingsHydration;
    expect(reopened.useSettings.getState().userId).toBe(store.useSettings.getState().userId);
    expect(reopened.useSettings.getState().userId).not.toBe(oldId);
  });

  it('avisa quando apagou no servidor mas não salvou a identidade nova', async () => {
    vi.stubGlobal('fetch', fakeServer().fetch);
    const { api } = await import('../src/lib/api');
    await api.privacy();

    h.saveFails = true;
    await expect(api.deleteMyData()).rejects.toThrow(/apagados no servidor/);
  });

  it('escrita que leva 401 depois do reset não é reenviada com a identidade nova', async () => {
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api } = await import('../src/lib/api');
    await api.privacy();

    const del = server.hold('DELETE /me');
    const deleting = api.deleteMyData();
    await del.arrived;
    // O servidor já apagou: a escrita leva 401, mas a resposta só chega depois do reset.
    const write = server.hold('POST /alerts');
    const stale = api.report('police', { lat: -23.5, lon: -46.6 });
    await write.arrived;
    del.release();
    await deleting;

    const sent = server.calls.length;
    write.release();
    await expect(stale).rejects.toThrow();
    expect(server.calls.slice(sent).filter((c) => c.route === 'POST /alerts')).toEqual([]);
  });
});

describe('registro limitado (429)', () => {
  afterEach(() => vi.useRealTimers());

  const registrations = (server: ReturnType<typeof fakeServer>) =>
    server.fetch.mock.calls.filter(([url]) => new URL(url).pathname === '/auth/device').length;

  it('só tenta registrar de novo depois do Retry-After e avisa com mensagem clara', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api, RegistrationLimitError } = await import('../src/lib/api');

    server.limit('120');
    await expect(api.privacy()).rejects.toThrow('Muitos registros desta rede. Tente de novo em 2 min.');
    expect(registrations(server)).toBe(1);

    // O servidor já liberaria, mas o app respeita a espera e nem chama o registro.
    server.limit(null);
    vi.setSystemTime(Date.now() + 119_000);
    const early = api.privacy();
    await expect(early).rejects.toBeInstanceOf(RegistrationLimitError);
    await expect(early).rejects.toThrow('Tente de novo em 1 s.');
    expect(registrations(server)).toBe(1);

    vi.setSystemTime(Date.now() + 1_000);
    await expect(api.privacy()).resolves.toEqual({ shareCrowd: false });
    expect(registrations(server)).toBe(2);
  });

  it('aceita Retry-After como data HTTP', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api } = await import('../src/lib/api');

    server.limit(new Date(Date.now() + 45_000).toUTCString());
    await expect(api.privacy()).rejects.toThrow(/Tente de novo em 4[45] s\./);
    server.limit(null);
    vi.setSystemTime(Date.now() + 30_000);
    await expect(api.privacy()).rejects.toThrow(/Muitos registros/);
    expect(registrations(server)).toBe(1);
  });

  it('sem Retry-After válido, espera um minuto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const server = fakeServer();
    vi.stubGlobal('fetch', server.fetch);
    const { api } = await import('../src/lib/api');

    server.limit('abc');
    await expect(api.privacy()).rejects.toThrow('Tente de novo em 1 min.');
    server.limit(null);
    vi.setSystemTime(Date.now() + 60_000);
    await expect(api.privacy()).resolves.toEqual({ shareCrowd: false });
  });
});
