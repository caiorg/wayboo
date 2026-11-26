import type { Route } from '@wayboo/core';
import { create } from 'zustand';
import { corridorDownloads, type Bounds } from './offlineArea';
import { downloadArea, listOfflineAreas } from './offlineMaps';

interface OfflineRouteState {
  /** Rota e estilos das partes abaixo. */
  key: string | null;
  routeId: string | null;
  styles: string[];
  /** Downloads do corredor da rota, na ordem do percurso. */
  parts: Bounds[];
  /** Partes já salvas, numeradas a partir de 1. */
  done: number[];
  /** False até ler do aparelho quais partes já estão salvas. */
  ready: boolean;
  /**
   * Download em andamento no app inteiro, de qualquer rota. Um por vez: dois ao mesmo tempo dobrariam as
   * requisições paralelas que os termos do OpenFreeMap limitam a 4.
   */
  active: { routeId: string; part: number; percentage: number } | null;
  message: string | null;
}

export const useOfflineRoute = create<OfflineRouteState>(() => ({
  key: null,
  routeId: null,
  styles: [],
  parts: [],
  done: [],
  ready: false,
  active: null,
  message: null,
}));

const keyOf = (routeId: string, styles: string[]) => `${routeId} ${styles.join(' ')}`;

/** Calcula as partes da rota e marca as já salvas em todos os estilos. */
export async function prepareOfflineRoute(route: Pick<Route, 'id' | 'geometry'>, styles: string[]): Promise<void> {
  const key = keyOf(route.id, styles);
  if (useOfflineRoute.getState().key === key) return;
  useOfflineRoute.setState({ key, routeId: route.id, styles, parts: corridorDownloads(route.geometry), done: [], ready: false, message: null });
  await refreshSavedParts();
}

/** Relê do aparelho quais partes da rota atual estão salvas (depois de apagar em Ajustes, por exemplo). */
export async function refreshSavedParts(): Promise<void> {
  const { key, routeId, styles, parts } = useOfflineRoute.getState();
  if (!key || !routeId) return;
  const areas = await listOfflineAreas().catch(() => []);
  const done = parts
    .map((_, i) => i + 1)
    .filter((part) => styles.every((style) => areas.some((a) => a.complete && a.meta.routeId === routeId && a.meta.part === part && a.meta.style === style)));
  if (useOfflineRoute.getState().key === key) useOfflineRoute.setState({ done, ready: true });
}

/** Baixa a próxima parte pendente. Cada parte é um download que o usuário inicia, como os termos exigem. */
export async function downloadNextPart(styles: string[]): Promise<void> {
  const { key, routeId, parts, done, ready, active } = useOfflineRoute.getState();
  const index = parts.findIndex((_, i) => !done.includes(i + 1));
  const bounds = parts[index];
  if (active || !ready || !routeId || key !== keyOf(routeId, styles) || !bounds) return;
  const part = index + 1;
  const total = parts.length;
  const current = () => useOfflineRoute.getState().key === key;
  useOfflineRoute.setState({ active: { routeId, part, percentage: 0 }, message: null });
  let result;
  try {
    result = await downloadArea({ styles, bounds, meta: { app: 'wayboo', routeId, part, total } }, (p) =>
      useOfflineRoute.setState({ active: { routeId, part, percentage: Math.round(p.percentage) } }),
    );
  } finally {
    useOfflineRoute.setState({ active: null });
  }
  if (!current()) return;
  if (result.status === 'error') {
    useOfflineRoute.setState({ message: `Falha ao baixar o mapa: ${result.message}` });
    return;
  }
  const nowDone = [...new Set([...useOfflineRoute.getState().done, part])].sort((a, b) => a - b);
  const message =
    result.status === 'partial'
      ? `Parte ${part} de ${total} parou no limite de 50 MB. Sem rede, parte da área pode faltar.`
      : nowDone.length === total
        ? 'Mapa da rota salvo para usar sem rede.'
        : `Parte ${part} de ${total} salva. Toque para baixar a próxima.`;
  useOfflineRoute.setState({ done: nowDone, message });
}
