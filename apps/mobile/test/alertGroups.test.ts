import type { AlertType, RoadAlert } from '@wayboo/core';
import { describe, expect, it } from 'vitest';
import { ALERT_SEVERITY, alertsByIds, groupAlerts, groupIdsOf, mergeAlerts, SAME_SPOT_M, timeAgoPtBR, voteStatus } from '../src/lib/alertGroups';

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

describe('groupIdsOf e alertsByIds', () => {
  it('tocar em qualquer alerta do marcador devolve o grupo inteiro', () => {
    const list = [alert('police', -23.55, -46.63), alert('accident', -23.55, -46.63), alert('flood', -23.55 + 5 * M, -46.63), alert('pothole', -23.6, -46.63)];
    const ids = groupIdsOf(list, list[0]!.id);
    expect(ids).toHaveLength(3);
    expect(alertsByIds(list, ids).map((a) => a.type)).toEqual(['accident', 'flood', 'police']);
  });

  it('id que não está no mapa devolve vazio', () => {
    expect(groupIdsOf([alert('police', -23.55, -46.63)], 'x')).toEqual([]);
  });

  it('alertsByIds ignora ids que saíram do mapa', () => {
    const a = alert('police', -23.55, -46.63);
    expect(alertsByIds([a], [a.id, 'sumiu'])).toEqual([a]);
  });
});

describe('mergeAlerts', () => {
  const NOW = Date.parse('2026-11-23T11:00:00.000Z');

  it('fica a cópia com mais votos, mesmo vinda de uma fonte anterior', () => {
    const a = alert('police', -23.55, -46.63);
    const voted = { ...a, upvotes: 1, myVote: 'up' as const };
    expect(mergeAlerts([[voted], [a]], new Set(), NOW)).toEqual([voted]);
    expect(mergeAlerts([[a], [voted]], new Set(), NOW)).toEqual([voted]);
  });

  it('no empate de votos, a fonte mais recente vence', () => {
    const a = alert('police', -23.55, -46.63);
    const newer = { ...a, note: 'depois' };
    expect(mergeAlerts([[a], [newer]], new Set(), NOW)).toEqual([newer]);
  });

  it('a cópia sem campos pessoais herda o voto da outra', () => {
    const a = alert('police', -23.55, -46.63);
    const personal = { ...a, mine: false, myVote: 'down' as const };
    expect(mergeAlerts([[personal], [a]], new Set(), NOW)).toEqual([personal]);
  });

  it('tira alertas expirados e os que sumiram do servidor', () => {
    const live = alert('police', -23.55, -46.63);
    const expired = { ...alert('flood', -23.55, -46.63), expiresAt: '2026-11-23T10:59:59.000Z' };
    const gone = alert('accident', -23.55, -46.63);
    expect(mergeAlerts([[live, expired, gone]], new Set([gone.id]), NOW)).toEqual([live]);
  });
});

describe('voteStatus', () => {
  it('distingue autor, voto dado e voto em aberto', () => {
    const a = alert('police', -23.55, -46.63);
    expect(voteStatus({ ...a, mine: true, myVote: null })).toBe('mine');
    expect(voteStatus({ ...a, mine: false, myVote: 'up' })).toBe('up');
    expect(voteStatus({ ...a, mine: false, myVote: 'down' })).toBe('down');
    expect(voteStatus({ ...a, mine: false, myVote: null })).toBe('open');
    // Servidor antigo, sem os campos pessoais: deixa votar e o servidor decide.
    expect(voteStatus(a)).toBe('open');
  });
});

describe('timeAgoPtBR', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const ago = (ms: number) => timeAgoPtBR(new Date(NOW - ms).toISOString(), NOW);

  it('escreve há quanto tempo o alerta foi criado', () => {
    expect(ago(20_000)).toBe('agora');
    expect(ago(60_000)).toBe('há 1 min');
    expect(ago(59 * 60_000)).toBe('há 59 min');
    expect(ago(60 * 60_000)).toBe('há 1 h');
    expect(ago(23 * 3_600_000 + 59 * 60_000)).toBe('há 23 h');
    expect(ago(24 * 3_600_000)).toBe('há 1 dia');
    expect(ago(14 * 24 * 3_600_000)).toBe('há 14 dias');
  });

  it('data no futuro (relógio adiantado) conta como agora', () => {
    expect(ago(-5 * 60_000)).toBe('agora');
  });
});
