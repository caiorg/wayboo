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

function pick(cur: RoadAlert, a: RoadAlert): RoadAlert {
  const [win, lose] = totalVotes(cur) > totalVotes(a) ? [cur, a] : [a, cur];
  return win.myVote === undefined && lose.myVote !== undefined ? { ...win, mine: lose.mine, myVote: lose.myVote } : win;
}

/**
 * Junta as cópias de cada alerta vindas de várias fontes (plano, alertas ao redor).
 * Os contadores só sobem, então fica a cópia com mais votos e, no empate, a da fonte mais recente.
 * Uma cópia sem `myVote` (alertas do plano em servidor antigo, por exemplo) herda o da outra.
 * `patches` (respostas de voto) só corrigem alertas presentes nas fontes: um alerta que o servidor
 * deixou de mandar não volta ao mapa por causa de uma resposta antiga.
 * Tira os expirados e os de `gone`, que o servidor disse não existirem mais.
 */
export function mergeAlerts(sources: RoadAlert[][], gone: ReadonlySet<string>, now = Date.now(), patches: RoadAlert[] = []): RoadAlert[] {
  const byId = new Map<string, RoadAlert>();
  for (const list of sources) {
    for (const a of list) {
      const cur = byId.get(a.id);
      byId.set(a.id, cur ? pick(cur, a) : a);
    }
  }
  for (const a of patches) {
    const cur = byId.get(a.id);
    if (cur) byId.set(a.id, pick(cur, a));
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

/** Caixa que cobre os alertas, com folga de `pad` graus, para buscá-los de novo em `GET /alerts`. */
export function alertsBox(alerts: RoadAlert[], pad = 0.001): { minLat: number; minLon: number; maxLat: number; maxLon: number } | null {
  if (!alerts.length) return null;
  const lats = alerts.map((a) => a.lat);
  const lons = alerts.map((a) => a.lon);
  return { minLat: Math.min(...lats) - pad, minLon: Math.min(...lons) - pad, maxLat: Math.max(...lats) + pad, maxLon: Math.max(...lons) + pad };
}

/**
 * Grava cópias novas sobre `cur` com a mesma regra de `mergeAlerts`: fica a de mais votos. Uma recarga
 * que começou antes de um voto chega com menos votos e não apaga a resposta do voto.
 */
export function upsertAlerts(cur: RoadAlert[], incoming: RoadAlert[]): RoadAlert[] {
  const byId = new Map(cur.map((a) => [a.id, a]));
  for (const a of incoming) {
    const prev = byId.get(a.id);
    byId.set(a.id, prev ? pick(prev, a) : a);
  }
  return [...byId.values()];
}
