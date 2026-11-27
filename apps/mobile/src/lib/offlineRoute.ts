import type { Route } from '@wayboo/core';
import { create } from 'zustand';
import { corridorDownloads, type Bounds } from './offlineArea';
import { deleteOfflineAreas, downloadArea, listOfflineAreas } from './offlineMaps';

interface OfflineRouteState {
  /** Rota e estilos das partes abaixo. */
  key: string | null;
  routeId: string | null;
  styles: string[];
  /** Downloads do corredor da rota, na ordem do percurso. */
  parts: Bounds[];
  /** Partes já salvas, numeradas a partir de 1. */
  done: number[];
  /**
   * Partes que pararam no limite de 50 MB, com área ou estilo faltando. Não contam como salvas, mas o próximo toque
   * passa para a parte seguinte: baixar de novo não traria mais nada dentro do limite.
   */
  limited: number[];
  /** False até ler do aparelho quais partes já estão salvas. */
  ready: boolean;
  /**
   * Download em andamento no app inteiro, de qualquer rota. Um por vez: dois ao mesmo tempo dobrariam as
   * requisições paralelas que os termos do OpenFreeMap limitam a 4.
   */
  active: { routeId: string; part: number; percentage: number } | null;
  /** Exclusão em andamento: apagaria o pacote que um download novo tentasse retomar. */
  deleting: boolean;
  message: string | null;
}

export const useOfflineRoute = create<OfflineRouteState>(() => ({
  key: null,
  routeId: null,
  styles: [],
  parts: [],
  done: [],
  limited: [],
  ready: false,
  active: null,
  deleting: false,
  message: null,
}));

const keyOf = (routeId: string, styles: string[]) => `${routeId} ${styles.join(' ')}`;

/**
 * Sobe a cada mudança de `done` ou `limited` (preparo, fim de download ou exclusão). Uma releitura que começou antes é de
 * um estado velho: em vez de gravar, lê de novo.
 */
let revision = 0;

/** Calcula as partes da rota e marca as já salvas em todos os estilos. */
export async function prepareOfflineRoute(route: Pick<Route, 'id' | 'geometry'>, styles: string[]): Promise<void> {
  const key = keyOf(route.id, styles);
  if (useOfflineRoute.getState().key === key) return;
  revision++;
  useOfflineRoute.setState({ key, routeId: route.id, styles, parts: corridorDownloads(route.geometry), done: [], limited: [], ready: false, message: null });
  await refreshSavedParts();
}

/** Relê do aparelho quais partes da rota atual estão salvas (depois de apagar em Ajustes, por exemplo). */
export async function refreshSavedParts(): Promise<void> {
  const { key, routeId, styles, parts } = useOfflineRoute.getState();
  if (!key || !routeId) return;
  const rev = revision;
  const areas = await listOfflineAreas().catch(() => []);
  const state = useOfflineRoute.getState();
  if (state.key !== key) return;
  if (rev !== revision) return refreshSavedParts();
  const ours = areas.filter((a) => a.meta.routeId === routeId);
  const done = parts
    .map((_, i) => i + 1)
    .filter((part) => styles.every((style) => ours.some((a) => a.complete && a.meta.part === part && a.meta.style === style)));
  // Parada no limite fica parada enquanto o pacote dela existir; apagado em Ajustes, volta a ser oferecida.
  const limited = state.limited.filter((part) => !done.includes(part) && ours.some((a) => a.meta.part === part));
  useOfflineRoute.setState({ done, limited, ready: true });
}

/** Baixa a próxima parte pendente. Cada parte é um download que o usuário inicia, como os termos exigem. */
export async function downloadNextPart(styles: string[]): Promise<void> {
  const { key, routeId, parts, done, limited, ready, active, deleting } = useOfflineRoute.getState();
  const index = parts.findIndex((_, i) => !done.includes(i + 1) && !limited.includes(i + 1));
  const bounds = parts[index];
  if (active || deleting || !ready || !routeId || key !== keyOf(routeId, styles) || !bounds) return;
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
  const add = (list: number[]) => [...new Set([...list, part])].sort((a, b) => a - b);
  const state = useOfflineRoute.getState();
  const nowDone = result.status === 'complete' ? add(state.done) : state.done;
  const nowLimited = result.status === 'partial' ? add(state.limited) : state.limited;
  const message =
    result.status === 'partial'
      ? `Parte ${part} de ${total} parou no limite de 50 MB. Sem rede, parte da área pode faltar.`
      : nowDone.length + nowLimited.length < total
        ? `Parte ${part} de ${total} salva. Toque para baixar a próxima.`
        : nowLimited.length
          ? 'Mapa da rota salvo, com partes incompletas.'
          : 'Mapa da rota salvo para usar sem rede.';
  revision++;
  useOfflineRoute.setState({ done: nowDone, limited: nowLimited, message });
}

export type DeleteResult = { status: 'deleted'; count: number } | { status: 'busy' } | { status: 'error' };

/** Apaga os mapas salvos. Não começa com um download ativo, e nenhum download começa enquanto apaga. */
export async function deleteOfflineMaps(): Promise<DeleteResult> {
  const { active, deleting } = useOfflineRoute.getState();
  if (active || deleting) return { status: 'busy' };
  useOfflineRoute.setState({ deleting: true });
  try {
    return { status: 'deleted', count: await deleteOfflineAreas() };
  } catch {
    return { status: 'error' };
  } finally {
    // O que estava no aparelho mudou, mesmo numa falha no meio: releituras que começaram antes leem de novo.
    revision++;
    // Também depois de uma falha no meio: o botão da rota volta a oferecer o que foi apagado. Segue em `deleting`
    // até a releitura acabar, senão um download que começasse no meio teria a parte nova sobrescrita por ela.
    await refreshSavedParts();
    useOfflineRoute.setState({ deleting: false });
  }
}
