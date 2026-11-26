import { OfflineManager, type OfflinePack, type OfflinePackStatus } from '@maplibre/maplibre-react-native';
import { countedBytes, judgeProgress, OFFLINE_MAX_ZOOM, OFFLINE_MIN_ZOOM, type Bounds } from './offlineArea';

/** Gravado em cada pacote: identifica os do Wayboo e a parte da rota a que pertencem. */
// `type`, não `interface`: precisa caber no `Record<string, unknown>` do metadata do pacote.
export type OfflineMeta = {
  app: 'wayboo';
  routeId: string;
  part: number;
  total: number;
};

export interface OfflineArea {
  id: string;
  meta: OfflineMeta & { style: string };
  bytes: number;
  complete: boolean;
}

export interface DownloadProgress {
  percentage: number;
  bytes: number;
}

export type DownloadResult = { status: 'complete' | 'partial'; bytes: number } | { status: 'error'; message: string };

/** Na web o MapLibre GL não tem pacotes offline: ver `offlineMaps.web.ts`. */
export const offlineSupported = true;

/** Rede de segurança: um evento perdido não deixa o download pendurado. */
const POLL_MS = 2000;

function isOurs(metadata: Record<string, unknown>): metadata is OfflineMeta & { style: string } {
  return metadata.app === 'wayboo' && typeof metadata.routeId === 'string' && typeof metadata.part === 'number' && typeof metadata.style === 'string';
}

/** O Android devolve `null` para um pacote que não existe mais. */
async function statusOf(pack: OfflinePack): Promise<OfflinePackStatus | null> {
  return (await pack.status().catch(() => null)) ?? null;
}

type Followed = { verdict: 'complete' | 'limit'; bytes: number } | { error: string };

/**
 * Para o pacote. Se a pausa falhar, apaga: um pacote solto continuaria baixando além do limite e em paralelo
 * com o próximo download.
 */
async function halt(pack: OfflinePack): Promise<void> {
  try {
    await pack.pause();
  } catch {
    await OfflineManager.deletePack(pack.id).catch(() => {});
  }
}

/** Espera o pacote terminar, bater num limite dos termos, falhar ou ser parado por fora. Pausa nos três últimos. */
function follow(pack: OfflinePack, reusesTiles: boolean, onProgress: (status: OfflinePackStatus) => void): Promise<Followed> {
  return new Promise((resolve) => {
    let settled = false;
    let sawActive = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const finish = async (result: Followed, stop: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      OfflineManager.removeListener(pack.id);
      if (stop) await halt(pack);
      resolve(result);
    };
    const check = (status: OfflinePackStatus | null) => {
      if (settled) return;
      if (!status) {
        void finish({ error: 'O mapa salvo foi apagado durante o download.' }, false);
        return;
      }
      onProgress(status);
      if (status.state === 'active') sawActive = true;
      // Ativo e depois inativo: alguém pausou ou apagou o pacote fora deste download.
      if (status.state === 'inactive' && sawActive) {
        void finish({ error: 'Download interrompido.' }, false);
        return;
      }
      const verdict = judgeProgress(status, { reusesTiles });
      if (verdict !== 'downloading') void finish({ verdict, bytes: countedBytes(status, reusesTiles) }, verdict === 'limit');
    };
    OfflineManager.addListener(
      pack.id,
      (_pack, status) => check(status),
      (_pack, error) => void finish({ error: error.message }, true),
    ).then(
      () => {
        // Depois do listener: o pacote pode ter terminado antes (recursos já salvos por outro pacote).
        void statusOf(pack).then(check);
        timer = setInterval(() => void statusOf(pack).then(check), POLL_MS);
      },
      (e: unknown) => void finish({ error: e instanceof Error ? e.message : String(e) }, true),
    );
  });
}

type Opened = { pack: OfflinePack } | { done: Followed };

async function openPack(style: string, bounds: Bounds, meta: OfflineMeta, reusesTiles: boolean): Promise<Opened> {
  const existing = (await OfflineManager.getPacks()).find(
    (p) => isOurs(p.metadata) && p.metadata.routeId === meta.routeId && p.metadata.part === meta.part && p.metadata.style === style,
  );
  if (existing) {
    const status = await statusOf(existing);
    if (status) {
      // Completo ou já no limite: retomar só baixaria mais além dos 50 MB.
      const verdict = judgeProgress(status, { reusesTiles });
      if (verdict !== 'downloading') return { done: { verdict, bytes: countedBytes(status, reusesTiles) } };
      // Tentativa anterior parou no meio (erro ou app fechado): retoma em vez de criar outro pacote igual.
      await existing.resume();
      return { pack: existing };
    }
  }
  const pack = await OfflineManager.createPack(
    { mapStyle: style, bounds, minZoom: OFFLINE_MIN_ZOOM, maxZoom: OFFLINE_MAX_ZOOM, metadata: { ...meta, style } },
    () => {},
    () => {},
  );
  return { pack };
}

/**
 * Baixa `bounds` para cada estilo, um depois do outro, como um único download iniciado pelo usuário. Os tiles são os
 * mesmos nos dois estilos e o MapLibre reaproveita o que já está no banco, então o segundo estilo só traz estilo,
 * sprites e fontes. Sem ele, o mapa sumiria ao trocar para o tema escuro sem rede.
 */
export async function downloadArea(
  { styles, bounds, meta }: { styles: string[]; bounds: Bounds; meta: OfflineMeta },
  onProgress: (p: DownloadProgress) => void,
): Promise<DownloadResult> {
  let bytes = 0;
  for (const [i, style] of styles.entries()) {
    const reusesTiles = i > 0;
    try {
      const opened = await openPack(style, bounds, meta, reusesTiles);
      const result =
        'done' in opened
          ? opened.done
          : await follow(opened.pack, reusesTiles, (s) =>
              onProgress({ percentage: ((i + s.percentage / 100) / styles.length) * 100, bytes: bytes + countedBytes(s, reusesTiles) }),
            );
      if ('error' in result) return { status: 'error', message: result.error };
      bytes += result.bytes;
      if (result.verdict === 'limit') return { status: 'partial', bytes };
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { status: 'complete', bytes };
}

export async function listOfflineAreas(): Promise<OfflineArea[]> {
  const areas: Promise<OfflineArea | null>[] = [];
  for (const p of await OfflineManager.getPacks()) {
    const meta = p.metadata;
    if (!isOurs(meta)) continue;
    areas.push(statusOf(p).then((s) => (s ? { id: p.id, meta, bytes: s.completedResourceSize, complete: s.state === 'complete' } : null)));
  }
  return (await Promise.all(areas)).filter((a): a is OfflineArea => a !== null);
}

/** Apaga os pacotes do Wayboo. Devolve quantos apagou. */
export async function deleteOfflineAreas(): Promise<number> {
  const ours = (await OfflineManager.getPacks()).filter((p) => isOurs(p.metadata));
  for (const p of ours) await OfflineManager.deletePack(p.id);
  return ours.length;
}
