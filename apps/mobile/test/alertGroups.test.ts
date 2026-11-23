import type { AlertType, RoadAlert } from '@wayboo/core';
import { describe, expect, it } from 'vitest';
import { ALERT_SEVERITY, groupAlerts, SAME_SPOT_M } from '../src/lib/alertGroups';

let seq = 0;
function alert(type: AlertType, lat: number, lon: number, createdAt = '2026-11-23T10:00:00.000Z'): RoadAlert {
  return { id: `a${++seq}`, type, lat, lon, note: null, createdAt, expiresAt: '2026-11-23T12:00:00.000Z', upvotes: 0, downvotes: 0 };
}

// ~1 m de latitude
const M = 1 / 111_195;

describe('groupAlerts', () => {
  it('junta alertas no mesmo ponto num grupo só', () => {
    const types: AlertType[] = ['accident', 'traffic', 'hazard', 'pothole', 'police', 'speed_camera', 'road_closed', 'flood'];
    const groups = groupAlerts(types.map((t) => alert(t, -23.55, -46.63)));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.alerts).toHaveLength(8);
  });

  it('separa alertas mais distantes que o raio', () => {
    const a = alert('police', -23.55, -46.63);
    const b = alert('flood', -23.55 + (SAME_SPOT_M + 10) * M, -46.63);
    expect(groupAlerts([a, b])).toHaveLength(2);
  });

  it('junta alertas dentro do raio', () => {
    const a = alert('police', -23.55, -46.63);
    const b = alert('flood', -23.55 + (SAME_SPOT_M - 10) * M, -46.63);
    expect(groupAlerts([a, b])).toHaveLength(1);
  });

  it('põe o tipo mais grave no topo e o grupo na posição dele', () => {
    const police = alert('police', -23.55, -46.63);
    const closed = alert('road_closed', -23.55 + 5 * M, -46.63);
    const [g] = groupAlerts([police, closed]);
    expect(g!.top.id).toBe(closed.id);
    expect(g!.alerts.map((a) => a.type)).toEqual(['road_closed', 'police']);
    expect([g!.lat, g!.lon]).toEqual([closed.lat, closed.lon]);
  });

  it('desempata pelo alerta mais recente', () => {
    const old = alert('flood', -23.55, -46.63, '2026-11-23T09:00:00.000Z');
    const recent = alert('flood', -23.55, -46.63, '2026-11-23T10:30:00.000Z');
    expect(groupAlerts([old, recent])[0]!.top.id).toBe(recent.id);
  });

  it('não depende da ordem de entrada', () => {
    const list = [alert('police', -23.55, -46.63), alert('accident', -23.55, -46.63), alert('pothole', -23.56, -46.63)];
    const ids = (gs: ReturnType<typeof groupAlerts>) => gs.map((g) => g.alerts.map((a) => a.id));
    expect(ids(groupAlerts([...list].reverse()))).toEqual(ids(groupAlerts(list)));
  });

  it('lista todos os tipos na ordem de gravidade', () => {
    expect([...ALERT_SEVERITY].sort()).toEqual(['accident', 'flood', 'hazard', 'police', 'pothole', 'road_closed', 'speed_camera', 'traffic']);
  });

  it('devolve vazio sem alertas', () => {
    expect(groupAlerts([])).toEqual([]);
  });
});
