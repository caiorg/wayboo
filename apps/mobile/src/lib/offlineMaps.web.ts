import type { DownloadProgress, DownloadResult, OfflineArea, OfflineMeta } from './offlineMaps';
import type { Bounds } from './offlineArea';

export type { DownloadProgress, DownloadResult, OfflineArea, OfflineMeta };

/** O MapLibre GL da web não tem pacotes offline, e importar o módulo nativo lançaria erro. */
export const offlineSupported = false;

export async function downloadArea(_opts: { styles: string[]; bounds: Bounds; meta: OfflineMeta }, _onProgress: (p: DownloadProgress) => void): Promise<DownloadResult> {
  return { status: 'error', message: 'Mapas offline só existem no app para Android e iOS.' };
}

export async function listOfflineAreas(): Promise<OfflineArea[]> {
  return [];
}

export async function deleteOfflineAreas(): Promise<number> {
  return 0;
}
