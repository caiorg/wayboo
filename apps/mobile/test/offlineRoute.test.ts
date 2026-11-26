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
  useOfflineRoute.setState({ key: null, routeId: null, styles: [], parts: [], done: [], ready: false, active: null, deleting: false, message: null });
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

  it('parte cortada pelo limite conta como salva e avisa', async () => {
    vi.mocked(downloadArea).mockResolvedValueOnce({ status: 'partial', bytes: 46_000_000 });
    h.parts = [b1];
    await prepareOfflineRoute(route, styles);
    await downloadNextPart(styles);
    expect(useOfflineRoute.getState()).toMatchObject({
      done: [1],
      message: 'Parte 1 de 1 parou no limite de 50 MB. Sem rede, parte da área pode faltar.',
    });
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

  it('falha ao apagar libera o estado e relê as partes salvas', async () => {
    vi.mocked(deleteOfflineAreas).mockRejectedValueOnce(new Error('disco'));
    await prepareOfflineRoute(route, styles);
    await expect(deleteOfflineMaps()).resolves.toEqual({ status: 'error' });
    expect(useOfflineRoute.getState().deleting).toBe(false);
    expect(listOfflineAreas).toHaveBeenCalledTimes(2);
  });
});
