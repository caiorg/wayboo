import { describe, expect, it } from 'vitest';
import { checkReportAccuracy, metersToPixelsAtZoom22, REPORT_MAX_ACCURACY_M } from '../src/lib/gpsAccuracy';

describe('checkReportAccuracy', () => {
  it('libera o reporte com precisão dentro do limite', () => {
    expect(REPORT_MAX_ACCURACY_M).toBe(50);
    expect(checkReportAccuracy(12)).toEqual({ ok: true, accuracyM: 12 });
    expect(checkReportAccuracy(50)).toEqual({ ok: true, accuracyM: 50 });
  });

  it('bloqueia o reporte com precisão pior que o limite e explica o motivo', () => {
    const r = checkReportAccuracy(120.4);
    expect(r).toMatchObject({ ok: false, accuracyM: 120.4 });
    expect(r.ok ? '' : r.message).toBe('GPS impreciso (±120 m). Espere o sinal melhorar ou ative a localização precisa para reportar.');
  });

  it('libera quando o aparelho não informa a precisão', () => {
    expect(checkReportAccuracy(null)).toEqual({ ok: true, accuracyM: null });
    expect(checkReportAccuracy(undefined)).toEqual({ ok: true, accuracyM: null });
  });
});

describe('metersToPixelsAtZoom22', () => {
  it('converte metros em pixels no zoom 22 (tiles de 512 px)', () => {
    // No equador, 1 px no zoom 22 vale 40075016.686 / (512 * 2^22) ≈ 0.01866 m.
    expect(metersToPixelsAtZoom22(50, 0)).toBeCloseTo(2679.2, 0);
  });

  it('aumenta com a latitude, porque o metro ocupa mais pixels longe do equador', () => {
    expect(metersToPixelsAtZoom22(50, 60)).toBeCloseTo(2 * metersToPixelsAtZoom22(50, 0), 3);
  });
});
