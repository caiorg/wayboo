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
