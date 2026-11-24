import { haversine, type AlertType, type RoadAlert } from '@wayboo/core';

/** Do mais grave para o menos grave. Define o ícone de um grupo e quem fica por cima no mapa. */
export const ALERT_SEVERITY: readonly AlertType[] = ['road_closed', 'accident', 'flood', 'hazard', 'traffic', 'pothole', 'speed_camera', 'police'];

/** Alertas a até esta distância contam como o mesmo ponto e viram um marcador só. */
export const SAME_SPOT_M = 40;

export interface AlertGroup {
  lat: number;
  lon: number;
  /** Alerta mostrado no marcador: o mais grave e, no empate, o mais recente. */
  top: RoadAlert;
  /** Todos os alertas do grupo, `top` primeiro. */
  alerts: RoadAlert[];
}

export function severityRank(type: string): number {
  const i = ALERT_SEVERITY.indexOf(type as AlertType);
  return i === -1 ? ALERT_SEVERITY.length : i;
}

function compare(a: RoadAlert, b: RoadAlert): number {
  return severityRank(a.type) - severityRank(b.type) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Agrupa alertas no mesmo ponto. Cada grupo fica na posição do alerta mais importante,
 * e um alerta entra no primeiro grupo cuja posição esteja a até `radiusM` metros.
 */
export function groupAlerts(alerts: RoadAlert[], radiusM = SAME_SPOT_M): AlertGroup[] {
  const groups: AlertGroup[] = [];
  for (const a of [...alerts].sort(compare)) {
    const g = groups.find((x) => haversine([x.lon, x.lat], [a.lon, a.lat]) <= radiusM);
    if (g) g.alerts.push(a);
    else groups.push({ lat: a.lat, lon: a.lon, top: a, alerts: [a] });
  }
  return groups;
}

/** Ids do grupo que contém o alerta `id`, do jeito que o mapa agrupa. Vazio se o alerta não está na lista. */
export function groupIdsOf(alerts: RoadAlert[], id: string): string[] {
  const g = groupAlerts(alerts).find((x) => x.alerts.some((a) => a.id === id));
  return g ? g.alerts.map((a) => a.id) : [];
}

/** Os alertas de `ids` que ainda estão na lista, do mais grave para o menos grave. */
export function alertsByIds(alerts: RoadAlert[], ids: readonly string[]): RoadAlert[] {
  const wanted = new Set(ids);
  return alerts.filter((a) => wanted.has(a.id)).sort(compare);
}

const totalVotes = (a: RoadAlert) => a.upvotes + a.downvotes;

/**
 * Junta as cópias de cada alerta vindas de várias fontes (plano, alertas ao redor, respostas de voto).
 * Os contadores só sobem, então fica a cópia com mais votos e, no empate, a da fonte mais recente.
 * Uma cópia sem `myVote` (alertas do plano em servidor antigo, por exemplo) herda o da outra.
 * Tira os expirados e os de `gone`, que o servidor disse não existirem mais.
 */
export function mergeAlerts(sources: RoadAlert[][], gone: ReadonlySet<string>, now = Date.now()): RoadAlert[] {
  const byId = new Map<string, RoadAlert>();
  for (const list of sources) {
    for (const a of list) {
      const cur = byId.get(a.id);
      if (!cur) {
        byId.set(a.id, a);
        continue;
      }
      const [win, lose] = totalVotes(cur) > totalVotes(a) ? [cur, a] : [a, cur];
      byId.set(a.id, win.myVote === undefined && lose.myVote !== undefined ? { ...win, mine: lose.mine, myVote: lose.myVote } : win);
    }
  }
  return [...byId.values()].filter((a) => !gone.has(a.id) && Date.parse(a.expiresAt) > now);
}

/** O que a folha de detalhes mostra no lugar dos botões de voto. `open`: ainda pode votar. */
export function voteStatus(a: RoadAlert): 'mine' | 'up' | 'down' | 'open' {
  if (a.mine) return 'mine';
  return a.myVote ?? 'open';
}

/** "agora", "há 5 min", "há 2 h", "há 3 dias". */
export function timeAgoPtBR(iso: string, now = Date.now()): string {
  const min = Math.floor((now - Date.parse(iso)) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'há 1 dia' : `há ${d} dias`;
}
