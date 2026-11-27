import { useEffect, useMemo, useRef, useState } from 'react';
import { listOfflineAreas, offlineSupported } from '@/lib/offlineMaps';
import { deleteOfflineMaps, useOfflineRoute } from '@/lib/offlineRoute';
import { useMapStyles } from '@/lib/theme';
import { Button, Card, T } from './ui';

/** Partes de rota salvas no aparelho, com a opção de apagar. Só no app nativo. */
export function OfflineMapsCard() {
  return offlineSupported ? <OfflineMapsCardBody /> : null;
}

function OfflineMapsCardBody() {
  // null enquanto carrega.
  const [parts, setParts] = useState<number | null>(null);
  // Pacotes no aparelho, completos ou não: um download que parou no meio também ocupa espaço.
  const [packs, setPacks] = useState(0);
  // Dois toques, como "Apagar meus dados": o primeiro arma, o segundo apaga.
  const [state, setState] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  // Apagar no meio de um download deixaria o pacote em andamento sem dono.
  const downloading = useOfflineRoute((s) => s.active !== null);
  const { light, dark } = useMapStyles();
  const styles = useMemo(() => [...new Set([light, dark])], [light, dark]);

  // Só a leitura mais recente vale: uma anterior que demorou não sobrescreve o resultado novo.
  const loadGen = useRef(0);
  const load = async () => {
    const gen = ++loadGen.current;
    try {
      const areas = await listOfflineAreas();
      if (gen !== loadGen.current) return;
      // Um pacote por estilo: a parte conta uma vez, e só com pacote completo em cada estilo do servidor atual.
      // Sem o escuro, o mapa some sem rede quando o tema troca.
      const key = (a: (typeof areas)[number]) => `${a.meta.routeId} ${a.meta.part}`;
      const saved = [...new Set(areas.map(key))].filter((k) =>
        styles.every((style) => areas.some((a) => key(a) === k && a.meta.style === style && a.complete)),
      );
      setParts(saved.length);
      setPacks(areas.length);
    } catch {
      if (gen !== loadGen.current) return;
      setParts(0);
      setPacks(0);
      setMsg('Não foi possível ler os mapas salvos.');
    }
  };

  // Relê ao abrir e quando um download termina: a parte nova entra na contagem.
  useEffect(() => {
    if (!downloading) void load();
  }, [downloading, styles]); // eslint-disable-line react-hooks/exhaustive-deps

  const remove = async () => {
    if (state !== 'confirm') {
      setState('confirm');
      setMsg('Toque de novo para apagar os mapas salvos. Sem rede, só as áreas vistas há pouco continuam aparecendo.');
      return;
    }
    setState('deleting');
    const result = await deleteOfflineMaps();
    setMsg(
      result.status === 'deleted'
        ? result.count
          ? 'Mapas offline apagados.'
          : 'Não havia mapas salvos.'
        : result.status === 'busy'
          ? 'Espere o download em andamento terminar para apagar.'
          : 'Não foi possível apagar os mapas salvos.',
    );
    setState('idle');
    void load();
  };

  return (
    <Card style={{ gap: 10 }}>
      <T variant="title">Mapas offline</T>
      <T variant="caption">
        {parts === null
          ? 'Lendo mapas salvos…'
          : parts === 0
            ? packs > 0
              ? 'Nenhuma parte de rota completa. Há downloads interrompidos ocupando espaço neste aparelho.'
              : 'Nenhum mapa salvo. Baixe o mapa de uma rota na tela de rotas, antes de sair.'
            : `${parts} ${parts === 1 ? 'parte de rota salva' : 'partes de rota salvas'} neste aparelho.`}
      </T>
      {packs > 0 || downloading ? (
        <Button
          label={state === 'confirm' ? 'Confirmar: apagar mapas' : 'Apagar mapas offline'}
          kind="danger"
          icon="delete-outline"
          loading={state === 'deleting'}
          disabled={downloading}
          onPress={() => void remove()}
        />
      ) : null}
      {downloading ? <T variant="caption">Espere o download em andamento terminar para apagar.</T> : null}
      {msg ? <T variant="caption">{msg}</T> : null}
    </Card>
  );
}
