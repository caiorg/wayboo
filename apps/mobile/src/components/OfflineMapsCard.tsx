import { useEffect, useState } from 'react';
import { deleteOfflineAreas, listOfflineAreas, offlineSupported } from '@/lib/offlineMaps';
import { refreshSavedParts, useOfflineRoute } from '@/lib/offlineRoute';
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

  const load = async () => {
    try {
      const areas = await listOfflineAreas();
      // Um pacote por estilo: a parte conta uma vez, e só se todos os estilos dela terminaram.
      const key = (a: (typeof areas)[number]) => `${a.meta.routeId} ${a.meta.part}`;
      const incomplete = new Set(areas.filter((a) => !a.complete).map(key));
      setParts(new Set(areas.map(key).filter((k) => !incomplete.has(k))).size);
      setPacks(areas.length);
    } catch {
      setParts(0);
      setPacks(0);
      setMsg('Não foi possível ler os mapas salvos.');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async () => {
    if (state !== 'confirm') {
      setState('confirm');
      setMsg('Toque de novo para apagar os mapas salvos. Sem rede, só as áreas vistas há pouco continuam aparecendo.');
      return;
    }
    setState('deleting');
    try {
      const n = await deleteOfflineAreas();
      setMsg(n ? 'Mapas offline apagados.' : 'Não havia mapas salvos.');
      // O botão da rota volta a oferecer o download.
      void refreshSavedParts();
    } catch {
      setMsg('Não foi possível apagar os mapas salvos.');
    }
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
