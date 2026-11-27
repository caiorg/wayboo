import { OfflineManager } from '@maplibre/maplibre-react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STOP_AT_BYTES, type Bounds } from '../src/lib/offlineArea';
import { deleteOfflineAreas, downloadArea, listOfflineAreas, type OfflineMeta } from '../src/lib/offlineMaps';

type Status = {
  state: 'inactive' | 'active' | 'complete';
  percentage: number;
  completedResourceSize: number;
  completedTileCount: number;
  completedTileSize: number;
};
type Progress = (pack: FakePack, status: Status) => void;
type Fail = (pack: FakePack, error: { id: string; message: string }) => void;

interface FakePack {
  id: string;
  metadata: Record<string, unknown>;
  bounds: Bounds;
  current: Status | null;
  status: () => Promise<Status | null>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

const h = vi.hoisted(() => ({
  packs: [] as FakePack[],
  listeners: new Map<string, { progress: Progress; fail: Fail }>(),
  nextId: 0,
}));

const makePack = (metadata: Record<string, unknown>, bounds: Bounds, state: Status['state'] = 'inactive'): FakePack => {
  const pack: FakePack = {
    id: `p${++h.nextId}`,
    metadata,
    bounds,
    current: { state, percentage: state === 'complete' ? 100 : 0, completedResourceSize: 0, completedTileCount: 0, completedTileSize: 0 },
    status: async () => pack.current,
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
  };
  return pack;
};

vi.mock('@maplibre/maplibre-react-native', () => ({
  OfflineManager: {
    createPack: vi.fn(async (opts: { metadata: Record<string, unknown>; bounds: Bounds }, progress: Progress, fail: Fail) => {
      const pack = makePack(opts.metadata, opts.bounds, 'active');
      h.packs.push(pack);
      h.listeners.set(pack.id, { progress, fail });
      return pack;
    }),
    addListener: vi.fn(async (id: string, progress: Progress, fail: Fail) => void h.listeners.set(id, { progress, fail })),
    removeListener: vi.fn((id: string) => void h.listeners.delete(id)),
    getPacks: vi.fn(async () => [...h.packs]),
    deletePack: vi.fn(async (id: string) => {
      h.packs = h.packs.filter((p) => p.id !== id);
    }),
  },
}));

const bounds: Bounds = [-46.7, -23.6, -46.6, -23.5];
const meta = (patch: Partial<OfflineMeta> = {}): OfflineMeta => ({ app: 'wayboo', routeId: 'r1', part: 1, total: 2, ...patch });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Manda um evento de progresso para o pacote mais novo. */
async function emit(patch: Partial<Status>) {
  await settle();
  const pack = h.packs.at(-1)!;
  pack.current = { ...pack.current!, ...patch };
  h.listeners.get(pack.id)?.progress(pack, pack.current);
}

/** Fontes de tiles de cada style JSON servido pelo `fetch` falso. Os dois estilos usam a mesma, como no OpenFreeMap. */
const styleSources: Record<string, string> = { 'https://s/light': 'https://s/planet', 'https://s/dark': 'https://s/planet' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({ ok: true, json: async () => ({ version: 8, sources: { omt: { type: 'vector', url: styleSources[url] } } }) })),
  );
  styleSources['https://s/dark'] = 'https://s/planet';
  h.packs = [];
  h.listeners.clear();
  h.nextId = 0;
});

describe('downloadArea', () => {
  it('baixa um pacote por estilo, em sequência, com o zoom do corredor', async () => {
    const onProgress = vi.fn();
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, onProgress);
    await emit({ percentage: 50, completedResourceSize: 1000 });
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith({ percentage: 25, bytes: 1000 });
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 2000 });
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 300 });
    await expect(done).resolves.toEqual({ status: 'complete', bytes: 2300 });
    const calls = vi.mocked(OfflineManager.createPack).mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.mapStyle)).toEqual(['https://s/light', 'https://s/dark']);
    expect(calls[0]).toMatchObject({ bounds, minZoom: 10, maxZoom: 14, metadata: { ...meta(), style: 'https://s/light' } });
    expect(h.listeners.size).toBe(0);
  });

  it('para no limite de tamanho, pausa e não baixa o próximo estilo', async () => {
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ completedResourceSize: STOP_AT_BYTES + 1 });
    await expect(done).resolves.toEqual({ status: 'partial', bytes: STOP_AT_BYTES + 1 });
    expect(h.packs[0]!.pause).toHaveBeenCalled();
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it('erro de download pausa e devolve a mensagem', async () => {
    const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
    await settle();
    const pack = h.packs[0]!;
    h.listeners.get(pack.id)!.fail(pack, { id: pack.id, message: 'timeout' });
    await expect(done).resolves.toEqual({ status: 'error', message: 'timeout' });
    expect(pack.pause).toHaveBeenCalled();
  });

  it('pacote que já terminou antes do primeiro evento conta como completo', async () => {
    vi.mocked(OfflineManager.createPack).mockImplementationOnce(async (opts) => {
      const pack = makePack(opts.metadata as Record<string, unknown>, bounds, 'complete');
      h.packs.push(pack);
      return pack as never;
    });
    await expect(downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {})).resolves.toMatchObject({ status: 'complete' });
  });

  it('retoma o pacote já criado para a mesma parte e estilo em vez de criar outro', async () => {
    const old = makePack({ ...meta(), style: 'https://s/light' }, bounds);
    h.packs.push(old);
    const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
    await settle();
    expect(OfflineManager.createPack).not.toHaveBeenCalled();
    expect(old.resume).toHaveBeenCalled();
    h.listeners.get(old.id)!.progress(old, { ...old.current!, state: 'complete', percentage: 100 });
    await expect(done).resolves.toMatchObject({ status: 'complete' });
  });

  it('pacote já completo ou no limite não volta a baixar', async () => {
    const complete = makePack({ ...meta(), style: 'https://s/light' }, bounds, 'complete');
    const partial = makePack({ ...meta(), style: 'https://s/dark' }, bounds, 'inactive');
    partial.current = { ...partial.current!, completedResourceSize: 40_000, completedTileSize: 0, completedTileCount: 3000 };
    h.packs.push(complete, partial);
    await expect(downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {})).resolves.toMatchObject({
      status: 'partial',
    });
    expect(complete.resume).not.toHaveBeenCalled();
    expect(partial.resume).not.toHaveBeenCalled();
    expect(OfflineManager.createPack).not.toHaveBeenCalled();
  });

  it('no segundo estilo, os tiles reaproveitados não contam para os 50 MB', async () => {
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 5_000_000, completedTileSize: 4_000_000 });
    await emit({ completedResourceSize: STOP_AT_BYTES + 1, completedTileSize: STOP_AT_BYTES - 1_000_000 });
    await emit({ state: 'complete', percentage: 100, completedResourceSize: STOP_AT_BYTES + 2, completedTileSize: STOP_AT_BYTES - 1_000_000 });
    await expect(done).resolves.toMatchObject({ status: 'complete' });
  });

  it('segundo estilo com outra fonte de tiles conta os tiles inteiros', async () => {
    styleSources['https://s/dark'] = 'https://outro/planet';
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 5_000_000, completedTileSize: 4_000_000 });
    await emit({ completedResourceSize: STOP_AT_BYTES - 4_000_000, completedTileSize: STOP_AT_BYTES - 5_000_000 });
    await expect(done).resolves.toEqual({ status: 'partial', bytes: STOP_AT_BYTES + 1_000_000 });
    expect(h.packs[1]!.pause).toHaveBeenCalled();
  });

  it('sem o style JSON, o segundo estilo conta os tiles inteiros', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 5_000_000, completedTileSize: 4_000_000 });
    await emit({ completedResourceSize: STOP_AT_BYTES - 4_000_000, completedTileSize: STOP_AT_BYTES - 5_000_000 });
    await expect(done).resolves.toEqual({ status: 'partial', bytes: STOP_AT_BYTES + 1_000_000 });
  });

  it('os dois estilos dividem os mesmos 50 MB', async () => {
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ state: 'complete', percentage: 100, completedResourceSize: 40_000_000, completedTileSize: 39_000_000 });
    // 7 MB de estilo, sprites e fontes no segundo: 40 + 7 passa do ponto de parada.
    await emit({ completedResourceSize: 46_000_000, completedTileSize: 39_000_000 });
    await expect(done).resolves.toEqual({ status: 'partial', bytes: 47_000_000 });
    expect(h.packs[1]!.pause).toHaveBeenCalled();
  });

  it('pacote pausado ou apagado por fora encerra o download com erro', async () => {
    const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
    await emit({ state: 'active', percentage: 10 });
    await emit({ state: 'inactive' });
    await expect(done).resolves.toEqual({ status: 'error', message: 'Download interrompido.' });
    expect(h.listeners.size).toBe(0);
  });

  it('evento perdido: a consulta periódica do status termina o download', async () => {
    vi.useFakeTimers();
    try {
      const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
      await vi.advanceTimersByTimeAsync(0);
      h.packs[0]!.current = { ...h.packs[0]!.current!, state: 'complete', percentage: 100 };
      await vi.advanceTimersByTimeAsync(2000);
      await expect(done).resolves.toMatchObject({ status: 'complete' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('se a pausa falhar no limite, apaga o pacote para ele não seguir baixando', async () => {
    const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
    await settle();
    h.packs[0]!.pause.mockRejectedValueOnce(new Error('falhou'));
    await emit({ completedResourceSize: STOP_AT_BYTES });
    // Sem pacote não há parte salva: o resultado é erro, e a parte segue pendente.
    await expect(done).resolves.toMatchObject({ status: 'error' });
    expect(OfflineManager.deletePack).toHaveBeenCalledWith('p1');
  });

  it('primeiro estilo completo já no limite: o segundo nem começa', async () => {
    const done = downloadArea({ styles: ['https://s/light', 'https://s/dark'], bounds, meta: meta() }, () => {});
    await emit({ state: 'complete', percentage: 100, completedResourceSize: STOP_AT_BYTES + 10, completedTileSize: STOP_AT_BYTES });
    await expect(done).resolves.toEqual({ status: 'partial', bytes: STOP_AT_BYTES + 10 });
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(1);
  });

  it('se não der para pausar nem apagar, avisa e recusa outro download', async () => {
    const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
    await settle();
    h.packs[0]!.pause.mockRejectedValueOnce(new Error('falhou'));
    vi.mocked(OfflineManager.deletePack).mockRejectedValueOnce(new Error('falhou'));
    await emit({ completedResourceSize: STOP_AT_BYTES });
    await expect(done).resolves.toEqual({ status: 'error', message: 'Não foi possível parar o download desta parte.' });
    const stuck = h.packs[0]!;
    await expect(downloadArea({ styles: ['https://s/light'], bounds, meta: meta({ part: 2 }) }, () => {})).resolves.toEqual({
      status: 'error',
      message: 'O download anterior ainda não parou. Tente de novo daqui a pouco.',
    });
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(1);
    // Consulta que falha não confirma que o pacote parou: o bloqueio continua.
    const realStatus = stuck.status;
    stuck.status = () => Promise.reject(new Error('módulo nativo indisponível'));
    await expect(downloadArea({ styles: ['https://s/light'], bounds, meta: meta({ part: 2 }) }, () => {})).resolves.toMatchObject({
      status: 'error',
    });
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(1);
    stuck.status = realStatus;
    // Quando o pacote preso para (terminou ou foi pausado), o próximo download segue.
    stuck.current = { ...stuck.current!, state: 'complete' };
    const next = downloadArea({ styles: ['https://s/light'], bounds, meta: meta({ part: 2 }) }, () => {});
    await settle();
    expect(OfflineManager.createPack).toHaveBeenCalledTimes(2);
    await emit({ state: 'complete', percentage: 100 });
    await expect(next).resolves.toMatchObject({ status: 'complete' });
  });

  it('evento antes de o listener ficar pronto não deixa consulta periódica rodando', async () => {
    vi.useFakeTimers();
    try {
      // O MapLibre entrega o evento final antes de a promessa de addListener resolver.
      vi.mocked(OfflineManager.addListener).mockImplementationOnce(async (id, progress) => {
        const pack = h.packs.find((p) => p.id === id)!;
        pack.current = { ...pack.current!, state: 'complete', percentage: 100 };
        progress(pack as never, pack.current as never);
      });
      const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
      await vi.advanceTimersByTimeAsync(0);
      await expect(done).resolves.toMatchObject({ status: 'complete' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pacote que nunca fica ativo encerra com erro em vez de esperar para sempre', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(OfflineManager.createPack).mockImplementationOnce(async (opts) => {
        const pack = makePack(opts.metadata as Record<string, unknown>, bounds, 'inactive');
        h.packs.push(pack);
        return pack as never;
      });
      const done = downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {});
      await vi.advanceTimersByTimeAsync(9_000);
      let settled = false;
      void done.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(done).resolves.toEqual({ status: 'error', message: 'O download não começou.' });
      expect(h.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falha ao criar o pacote vira erro, sem exceção', async () => {
    vi.mocked(OfflineManager.createPack).mockRejectedValueOnce(new Error('sem espaço'));
    await expect(downloadArea({ styles: ['https://s/light'], bounds, meta: meta() }, () => {})).resolves.toEqual({
      status: 'error',
      message: 'sem espaço',
    });
  });
});

describe('áreas salvas', () => {
  it('lista só os pacotes do Wayboo, com tamanho e estado', async () => {
    const ours = makePack({ ...meta({ part: 2 }), style: 'https://s/light' }, bounds, 'complete');
    ours.current!.completedResourceSize = 5000;
    h.packs.push(ours, makePack({ other: true }, bounds, 'complete'));
    expect(await listOfflineAreas()).toEqual([{ id: ours.id, meta: { ...meta({ part: 2 }), style: 'https://s/light' }, bytes: 5000, complete: true }]);
  });

  it('ignora pacote que sumiu do banco (status nulo no Android)', async () => {
    const gone = makePack({ ...meta(), style: 'x' }, bounds);
    gone.current = null;
    h.packs.push(gone);
    expect(await listOfflineAreas()).toEqual([]);
  });

  it('apaga só os pacotes do Wayboo', async () => {
    h.packs.push(makePack({ ...meta(), style: 'x' }, bounds), makePack({ other: true }, bounds));
    expect(await deleteOfflineAreas()).toBe(1);
    expect(h.packs).toHaveLength(1);
    expect(h.packs[0]!.metadata).toEqual({ other: true });
  });
});
