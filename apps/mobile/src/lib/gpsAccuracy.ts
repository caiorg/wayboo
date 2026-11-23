/** Raio de incerteza máximo, em metros, para aceitar um reporte de alerta. */
export const REPORT_MAX_ACCURACY_M = 50;

export type ReportAccuracy = { ok: true; accuracyM: number | null } | { ok: false; accuracyM: number; message: string };

/** Sem precisão informada (alguns aparelhos e a simulação), o reporte segue liberado. */
export function checkReportAccuracy(accuracy: number | null | undefined): ReportAccuracy {
  if (accuracy == null) return { ok: true, accuracyM: null };
  if (accuracy <= REPORT_MAX_ACCURACY_M) return { ok: true, accuracyM: accuracy };
  return {
    ok: false,
    accuracyM: accuracy,
    message: `GPS impreciso (±${Math.round(accuracy)} m). Espere o sinal melhorar ou ative a localização precisa para reportar.`,
  };
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * Metros em pixels no zoom 22, para o MapLibre (tiles de 512 px) interpolar
 * exponencialmente até o zoom atual: o pixel dobra de tamanho a cada nível.
 */
export function metersToPixelsAtZoom22(meters: number, lat: number): number {
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** 22);
  return meters / metersPerPixel;
}
