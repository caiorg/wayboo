import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bounds } from '../src/lib/offlineArea';
import { deleteOfflineAreas, downloadArea, listOfflineAreas, type DownloadResult } from '../src/lib/offlineMaps';
import { deleteOfflineMaps, downloadNextPart, prepareOfflineRoute, refreshSavedParts, useOfflineRoute } from '../src/lib/offlineRoute';

const h = vi.hoisted(() => ({ parts: [] as Bounds[] }));

vi.mock('../src/lib/offlineArea', () => ({ corridorDownloads: () => h.parts }));
vi.mock('../src/lib/offlineMaps', () => ({
  offlineSupported: true,
  downloadArea: vi.fn(),
  listOfflineAreas: vi.fn(async () => []),
  deleteOfflineAreas: vi.fn(async () => 0),
}));

const styles = ['https://s/light', 'https://s/dark'];
const route = { id: 'r1', geometry: [] };
const b1: Bounds = [0, 0, 1, 1];
const b2: Bounds = [1, 0, 2, 1];

beforeEach(() => {
  vi.clearAllMocks();
  h.parts = [b1, b2];
  useOfflineRoute.setState({ key: null, routeId: null, styles: [], parts: [], done: [], limited: [], ready: false, active: null, deleting: false, message: null });
});

describe('download do mapa da rota', () => {
  it('divide a rota em partes e marca as que já estão salvas por completo', async () => {
    vi.mocked(listOfflineAreas).mockResolvedValueOnce([
      { id: 'a', meta: { app: 'wayboo', routeId: 'r1', part: 2, total: 2, style: styles[0]! }, bytes: 1, complete: true },
      { id: 'b', meta: { app: 'wayboo', routeId: 'r1', part: 2, total: 2, style: styles[1]! }, bytes: 1, complete: true },
      { id: 'c', meta: { app: 'wayboo', routeId: 'r1', part: 1, total: 2, style: styles[0]! }, bytes: 1, complete: true },
      { id: 'd', meta: { app: 'wayboo', routeId: 'r1', part: 1, total: 2, style: styles[1]! }, bytes: 1, complete: false },
      { id: 'e', meta: { app: 'wayboo', routeId: 'outra', part: 1, total: 1, style: styles[0]! }, bytes: 1, complete: true },
    ]);
    await prepareOfflineRoute(route, styles);
    expect(useOfflineRoute.getState()).toMatchObject({ routeId: 'r1', parts: [b1, b2], done: [2], ready: true });
  });

  it('cada toque baixa uma parte só, na ordem', async () => {
    vi.mocked(downloadArea).mockResolvedValue({ status: 'complete', bytes: 10 });
    await prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(downloadArea).toHaveBeenCalledTimes(1);
    expect(vi.mocked(downloadArea).mock.calls[0]![0]).toEqual({ styles, bounds: b1, meta: { app: 'wayboo', routeId: 'r1', part: 1, total: 2 } });
    expect(useOfflineRoute.getState()).toMatchObject({ done: [1], active: null, message: 'Parte 1 de 2 salva. Toque para baixar a próxima.' });
    await downloadNextPart(styles);
    expect(vi.mocked(downloadArea).mock.calls[1]![0].bounds).toEqual(b2);
    expect(useOfflineRoute.getState()).toMatchObject({ done: [1, 2], message: 'Mapa da rota salvo para usar sem rede.' });
    await downloadNextPart(styles);
    expect(downloadArea).toHaveBeenCalledTimes(2);
  });

  it('não começa outra parte enquanto uma baixa', async () => {
    let resolve!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await prepareOfflineRoute(route, styles);
    const first = downloadNextPart(styles);
    await downloadNextPart(styles);
    expect(downloadArea).toHaveBeenCalledTimes(1);
    expect(useOfflineRoute.getState().active).toEqual({ routeId: 'r1', part: 1, percentage: 0 });
    resolve({ status: 'complete', bytes: 1 });
    await first;
  });

  it('mostra o progresso da parte em andamento', async () => {
    let resolve!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockImplementationOnce((_opts, onProgress) => {
      onProgress({ percentage: 42.4, bytes: 1 });
      return new Promise((r) => (resolve = r));
    });
    await prepareOfflineRoute(route, styles);
    const done = downloadNextPart(styles);
    expect(useOfflineRoute.getState().active).toEqual({ routeId: 'r1', part: 1, percentage: 42 });
    resolve({ status: 'complete', bytes: 1 });
    await done;
  });

  it('parte cortada pelo limite não conta como salva, mas o próximo toque segue para a parte seguinte', async () => {
    vi.mocked(downloadArea).mockResolvedValueOnce({ status: 'partial', bytes: 46_000_000 });
    vi.mocked(downloadArea).mockResolvedValueOnce({ status: 'complete', bytes: 1 });
    await prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(useOfflineRoute.getState()).toMatchObject({
      done: [],
      limited: [1],
      message: 'Parte 1 de 2 parou no limite de 50 MB. Sem rede, parte da área pode faltar.',
    });
    await downloadNextPart(styles);
    expect(vi.mocked(downloadArea).mock.calls[1]![0].bounds).toEqual(b2);
    expect(useOfflineRoute.getState()).toMatchObject({
      done: [2],
      limited: [1],
      message: 'Mapa da rota salvo, com partes incompletas.',
    });
    await downloadNextPart(styles);
    expect(downloadArea).toHaveBeenCalledTimes(2);
  });

  it('erro deixa a parte pendente para tentar de novo', async () => {
    vi.mocked(downloadArea).mockResolvedValueOnce({ status: 'error', message: 'timeout' });
    await prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(useOfflineRoute.getState()).toMatchObject({ done: [], active: null, message: 'Falha ao baixar o mapa: timeout' });
  });

  it('resultado de uma rota trocada no meio do download é descartado', async () => {
    let resolve!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await prepareOfflineRoute(route, styles);
    const first = downloadNextPart(styles);
    await prepareOfflineRoute({ id: 'r2', geometry: [] }, styles);
    // O download da rota anterior ainda ocupa a vez: a rota nova espera.
    await downloadNextPart(styles);
    expect(downloadArea).toHaveBeenCalledTimes(1);
    expect(useOfflineRoute.getState().active).toMatchObject({ routeId: 'r1' });
    resolve({ status: 'complete', bytes: 1 });
    await first;
    expect(useOfflineRoute.getState()).toMatchObject({ routeId: 'r2', done: [], active: null, message: null });
  });

  it('ignora o toque antes de saber quais partes já estão salvas', async () => {
    let resolve!: (a: Awaited<ReturnType<typeof listOfflineAreas>>) => void;
    vi.mocked(listOfflineAreas).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const preparing = prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(downloadArea).not.toHaveBeenCalled();
    resolve([]);
    await preparing;
    expect(useOfflineRoute.getState().ready).toBe(true);
  });

  it('trocar os estilos refaz a conta das partes salvas', async () => {
    await prepareOfflineRoute(route, styles);
    await prepareOfflineRoute(route, [styles[0]!]);
    expect(listOfflineAreas).toHaveBeenCalledTimes(2);
  });

  it('relê as partes salvas depois de apagar os mapas', async () => {
    vi.mocked(downloadArea).mockResolvedValueOnce({ status: 'complete', bytes: 1 });
    await prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(useOfflineRoute.getState().done).toEqual([1]);
    await refreshSavedParts();
    expect(useOfflineRoute.getState().done).toEqual([]);
  });

  it('não baixa enquanto apaga, e não apaga enquanto baixa', async () => {
    let finishDelete!: (n: number) => void;
    vi.mocked(deleteOfflineAreas).mockReturnValueOnce(new Promise((r) => (finishDelete = r)));
    await prepareOfflineRoute(route, styles);
    const deleting = deleteOfflineMaps();
    expect(useOfflineRoute.getState().deleting).toBe(true);
    await downloadNextPart(styles);
    expect(downloadArea).not.toHaveBeenCalled();
    finishDelete(2);
    await expect(deleting).resolves.toEqual({ status: 'deleted', count: 2 });
    expect(useOfflineRoute.getState().deleting).toBe(false);

    let finishDownload!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockReturnValueOnce(new Promise((r) => (finishDownload = r)));
    const downloading = downloadNextPart(styles);
    await expect(deleteOfflineMaps()).resolves.toEqual({ status: 'busy' });
    expect(deleteOfflineAreas).toHaveBeenCalledTimes(1);
    finishDownload({ status: 'complete', bytes: 1 });
    await downloading;
  });

  it('segue apagando até terminar de reler as partes salvas', async () => {
    await prepareOfflineRoute(route, styles);
    let reread!: (a: Awaited<ReturnType<typeof listOfflineAreas>>) => void;
    vi.mocked(listOfflineAreas).mockReturnValueOnce(new Promise((r) => (reread = r)));
    const deleting = deleteOfflineMaps();
    await new Promise((r) => setTimeout(r, 0));
    expect(useOfflineRoute.getState().deleting).toBe(true);
    await downloadNextPart(styles);
    expect(downloadArea).not.toHaveBeenCalled();
    reread([]);
    await deleting;
    expect(useOfflineRoute.getState().deleting).toBe(false);
  });

  it('falha ao apagar libera o estado e relê as partes salvas', async () => {
    vi.mocked(deleteOfflineAreas).mockRejectedValueOnce(new Error('disco'));
    await prepareOfflineRoute(route, styles);
    await expect(deleteOfflineMaps()).resolves.toEqual({ status: 'error' });
    expect(useOfflineRoute.getState().deleting).toBe(false);
    expect(listOfflineAreas).toHaveBeenCalledTimes(2);
  });

  const area = (part: number, style: string, complete: boolean) => ({
    id: `${part}${style}`,
    meta: { app: 'wayboo' as const, routeId: 'r1', part, total: 2, style },
    bytes: 1,
    complete,
  });

  it('releitura que começa antes de um download terminar não apaga a parte salva', async () => {
    await prepareOfflineRoute(route, styles);
    let finish!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockReturnValueOnce(new Promise((r) => (finish = r)));
    const downloading = downloadNextPart(styles);
    let stale!: (a: Awaited<ReturnType<typeof listOfflineAreas>>) => void;
    vi.mocked(listOfflineAreas)
      .mockReturnValueOnce(new Promise((r) => (stale = r)))
      .mockResolvedValueOnce([area(1, styles[0]!, true), area(1, styles[1]!, true)]);
    const refreshing = refreshSavedParts();
    finish({ status: 'complete', bytes: 1 });
    await downloading;
    expect(useOfflineRoute.getState().done).toEqual([1]);
    stale([]);
    await refreshing;
    expect(useOfflineRoute.getState()).toMatchObject({ done: [1], ready: true });
  });

  it('releitura atrasada não esquece a parte parada no limite', async () => {
    await prepareOfflineRoute(route, styles);
    let finish!: (r: DownloadResult) => void;
    vi.mocked(downloadArea).mockReturnValueOnce(new Promise((r) => (finish = r)));
    const downloading = downloadNextPart(styles);
    let stale!: (a: Awaited<ReturnType<typeof listOfflineAreas>>) => void;
    vi.mocked(listOfflineAreas)
      .mockReturnValueOnce(new Promise((r) => (stale = r)))
      .mockResolvedValueOnce([area(1, styles[0]!, false)]);
    const refreshing = refreshSavedParts();
    finish({ status: 'partial', bytes: 46_000_000 });
    await downloading;
    stale([]);
    await refreshing;
    expect(useOfflineRoute.getState()).toMatchObject({ done: [], limited: [1] });
    // Sem pacote no aparelho (apagado em Ajustes), a parte volta a ser oferecida.
    vi.mocked(listOfflineAreas).mockResolvedValueOnce([]);
    await refreshSavedParts();
    expect(useOfflineRoute.getState().limited).toEqual([]);
  });

  it('releitura que começou antes de apagar não traz de volta as partes apagadas', async () => {
    vi.mocked(listOfflineAreas).mockResolvedValueOnce([area(1, styles[0]!, true), area(1, styles[1]!, true)]);
    await prepareOfflineRoute(route, styles);
    expect(useOfflineRoute.getState().done).toEqual([1]);
    let stale!: (a: Awaited<ReturnType<typeof listOfflineAreas>>) => void;
    vi.mocked(listOfflineAreas)
      .mockReturnValueOnce(new Promise((r) => (stale = r)))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const refreshing = refreshSavedParts();
    await deleteOfflineMaps();
    expect(useOfflineRoute.getState().done).toEqual([]);
    stale([area(1, styles[0]!, true), area(1, styles[1]!, true)]);
    await refreshing;
    expect(useOfflineRoute.getState().done).toEqual([]);
  });
});
