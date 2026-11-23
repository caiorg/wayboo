import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { Button, Card, Chip, T } from '@/components/ui';
import { api, LocalSaveError, RegistrationLimitError } from '@/lib/api';
import { exportMyData, type ExportResult } from '@/lib/exportData';
import { normalizeApiUrl, useSettings, type ThemePref } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const s = useSettings();
  const [url, setUrl] = useState(s.apiUrl);
  // Id que o servidor atual usa; antes do primeiro registro, o UUID local que ele vai adotar.
  const userId = s.credentials[normalizeApiUrl(s.apiUrl)]?.userId ?? s.userId;
  const [status, setStatus] = useState<string | null>(null);
  // null enquanto carrega ou sem conexão: o opt-in vive no servidor, não no aparelho.
  const [shareCrowd, setShareCrowd] = useState<boolean | null>(null);
  const [privacyError, setPrivacyError] = useState<string | null>(null);
  // Dois toques: o primeiro arma, o segundo apaga. Alert com botões não funciona na web.
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'deleting'>('idle');
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  const exportData = async () => {
    const server = normalizeApiUrl(useSettings.getState().apiUrl);
    setExporting(true);
    const result = await exportMyData();
    setExporting(false);
    // Trocou de servidor no meio: a mensagem não vale para o atual.
    if (normalizeApiUrl(useSettings.getState().apiUrl) === server) setExportResult(result);
  };

  const loadPrivacy = async () => {
    try {
      setShareCrowd((await api.privacy()).shareCrowd);
      setPrivacyError(null);
    } catch (e) {
      setShareCrowd(null);
      setPrivacyError(e instanceof RegistrationLimitError ? e.message : 'Não foi possível ler a opção no servidor.');
    }
  };

  const changeShareCrowd = async (v: boolean) => {
    const prev = shareCrowd;
    setShareCrowd(v);
    try {
      setShareCrowd((await api.setPrivacy({ shareCrowd: v })).shareCrowd);
      setPrivacyError(null);
    } catch (e) {
      setShareCrowd(prev);
      setPrivacyError(e instanceof RegistrationLimitError ? e.message : 'Não foi possível salvar. Confira a conexão com o servidor.');
    }
  };

  const deleteMyData = async () => {
    if (deleteState === 'idle') {
      setDeleteState('confirm');
      setDeleteMsg('Toque de novo para apagar. Não dá para desfazer.');
      return;
    }
    setDeleteState('deleting');
    try {
      await api.deleteMyData();
      setDeleteMsg('Dados apagados no servidor. Este aparelho recebeu um identificador novo.');
      void loadPrivacy();
    } catch (e) {
      setDeleteMsg(e instanceof LocalSaveError ? e.message : 'Não foi possível apagar. Confira a conexão com o servidor.');
    }
    setDeleteState('idle');
  };

  const test = async () => {
    const nextUrl = normalizeApiUrl(url);
    // A confirmação vale para o servidor em que foi armada.
    if (nextUrl !== normalizeApiUrl(s.apiUrl)) {
      setDeleteState('idle');
      setDeleteMsg(null);
      setExportResult(null);
    }
    s.set({ apiUrl: nextUrl });
    setStatus('Testando…');
    try {
      const h = await api.health();
      const ai = h.ai ? `IA: ${h.ai.provider} (${h.ai.model}).` : 'IA desativada: o copiloto usa regras.';
      setStatus(`Conectado. ${ai} ${h.map ? 'Mapa do próprio servidor.' : 'Mapa público (OpenFreeMap).'}`);
      void loadPrivacy();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Falha');
    }
  };

  useEffect(() => {
    void test();
    // Testa a conexão uma vez ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const row = (label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <T>{label}</T>
        {hint ? <T variant="caption">{hint}</T> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.primary, false: t.border }} />
    </View>
  );

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: 10 }}>
        <T variant="title">Servidor</T>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surfaceAlt }]}
          accessibilityLabel="URL da API"
        />
        <Button label="Salvar e testar" kind="secondary" icon="lan-connect" onPress={() => void test()} />
        {status ? <T variant="caption">{status}</T> : null}
      </Card>

      <Card style={{ gap: 14 }}>
        <T variant="title">Navegação</T>
        {row('Instruções por voz', s.voice, (v) => s.set({ voice: v }))}
        {row('Evitar pedágios', s.avoidTolls, (v) => s.set({ avoidTolls: v }), 'O app também aprende isso das suas escolhas.')}
        {row('Evitar rodovias', s.avoidHighways, (v) => s.set({ avoidHighways: v }))}
      </Card>

      <Card style={{ gap: 10 }}>
        <T variant="title">Privacidade</T>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <T>Contribuir com o trânsito coletivo</T>
            <T variant="caption">Desligado por padrão. Desligado, suas viagens só ensinam o seu app, e você continua usando os tempos que outras pessoas compartilham.</T>
          </View>
          <Switch
            value={shareCrowd ?? false}
            disabled={shareCrowd === null}
            onValueChange={(v) => void changeShareCrowd(v)}
            trackColor={{ true: t.primary, false: t.border }}
            accessibilityLabel="Contribuir com o trânsito coletivo"
          />
        </View>
        <T variant="caption">
          Ligado, o servidor soma ao total coletivo só quanto cada trecho de rua demorou em relação ao previsto, com o tipo de dia e a faixa
          de 30 minutos. Não vão rastro GPS, lugares, horário exato nem o identificador deste aparelho. Ao desligar, as próximas viagens
          deixam de contribuir. O que já foi somado não guarda quem enviou e continua no total.
        </T>
        {privacyError ? <T variant="caption" color={t.danger}>{privacyError}</T> : null}
        <T variant="caption">
          O rastro GPS de cada viagem sai do servidor depois do prazo de retenção (24 horas no padrão); ficam só os tempos aprendidos por trecho, seus lugares e o resumo das viagens.
        </T>
        <Button label="Exportar meus dados" kind="secondary" icon="download" loading={exporting} onPress={() => void exportData()} />
        {exportResult ? <T variant="caption" color={exportResult.ok ? undefined : t.danger}>{exportResult.message}</T> : null}
        <Button
          label={deleteState === 'confirm' ? 'Confirmar: apagar meus dados' : 'Apagar meus dados do servidor'}
          kind="danger"
          icon="delete-outline"
          loading={deleteState === 'deleting'}
          onPress={() => void deleteMyData()}
        />
        {deleteMsg ? <T variant="caption">{deleteMsg}</T> : null}
      </Card>

      <Card style={{ gap: 10 }}>
        <T variant="title">Tema</T>
        <View style={styles.chips}>
          {(['system', 'light', 'dark'] as ThemePref[]).map((p) => (
            <Chip key={p} label={{ system: 'Sistema', light: 'Claro', dark: 'Escuro' }[p]} selected={s.theme === p} onPress={() => s.set({ theme: p })} />
          ))}
        </View>
      </Card>

      <Card style={{ gap: 8 }}>
        <T variant="title">Identificador deste aparelho</T>
        <T variant="caption" style={{ fontFamily: 'monospace' }} color={t.text}>
          {userId}
        </T>
        <T variant="caption">
          Seu histórico de aprendizado fica associado a este id no servidor. Para ver o aprendizado sem dirigir, gere viagens de demonstração:
        </T>
        <T variant="caption" style={{ fontFamily: 'monospace' }} color={t.learn}>
          bun run seed --user {userId}
        </T>
      </Card>

      <T variant="caption" style={{ textAlign: 'center' }}>
        Mapas © OpenStreetMap e OpenFreeMap · Rotas Valhalla · Busca Photon · Clima Open-Meteo
      </T>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chips: { flexDirection: 'row', gap: 8 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
});
