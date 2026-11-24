import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { Button, Card, Chip, T } from '@/components/ui';
import { aiKeyInBrowser, clearAi, hasAiKey, saveAi } from '@/lib/aiKey';
import { api, ApiError, LocalSaveError, RegistrationLimitError, type DeviceInfo } from '@/lib/api';
import { exportMyData, type ExportResult } from '@/lib/exportData';
import { AI_PROVIDERS, normalizeApiUrl, useSettings, type AiProviderId, type ThemePref } from '@/lib/store';
import { useTheme } from '@/lib/theme';

const day = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** `model`: sugestão inicial; vazio quando não há um padrão certo e o usuário escolhe. `of` e `to`: o nome com artigo. */
const AI_INFO: Record<AiProviderId, { label: string; of: string; to: string; model: string; modelHint: string; keyHint: string }> = {
  anthropic: { label: 'Anthropic', of: 'da Anthropic', to: 'à Anthropic', model: 'claude-opus-5-5', modelHint: 'claude-opus-5-5', keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', of: 'da OpenAI', to: 'à OpenAI', model: '', modelHint: 'ex.: gpt-4o-mini', keyHint: 'sk-…' },
  openrouter: { label: 'OpenRouter', of: 'do OpenRouter', to: 'ao OpenRouter', model: '', modelHint: 'ex.: openai/gpt-4o-mini', keyHint: 'sk-or-v1-…' },
};

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
  // null enquanto carrega ou sem conexão.
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  // Mesmo padrão de dois toques de "Apagar meus dados": o id armado e o que está em andamento.
  const [deviceConfirm, setDeviceConfirm] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);
  const [deviceMsg, setDeviceMsg] = useState<string | null>(null);
  // Só a consulta mais recente vale, e só para o servidor e a identidade em que começou:
  // a resposta de um servidor anterior ou do usuário antigo não substitui a lista atual.
  const devicesGen = useRef(0);
  // IA: `aiProvider` null é a IA do servidor. A chave digitada só vive neste estado até salvar; a salva nunca volta à tela.
  const [aiProvider, setAiProvider] = useState<AiProviderId | null>(s.ai?.provider ?? null);
  const [aiModel, setAiModel] = useState(s.ai?.model ?? '');
  const [aiKeyDraft, setAiKeyDraft] = useState('');
  const [aiKeySaved, setAiKeySaved] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<string | null>(null);
  // Provedores que o servidor aceita com chave própria; null antes do teste de conexão.
  const [serverByok, setServerByok] = useState<string[] | null>(null);
  // A chave salva só vale para o provedor em que foi salva.
  const keyKept = aiKeySaved && aiProvider !== null && s.ai?.provider === aiProvider;

  const pickAiProvider = (p: AiProviderId | null) => {
    setAiProvider(p);
    setAiModel(p && p === s.ai?.provider ? s.ai.model : p ? AI_INFO[p].model : '');
    setAiKeyDraft('');
    setAiMsg(null);
  };

  const saveAiChoice = async () => {
    setAiBusy(true);
    try {
      if (!aiProvider) {
        await clearAi();
        setAiKeySaved(false);
        setAiMsg('O copiloto usa a IA do servidor. A chave saiu deste aparelho.');
      } else {
        const typed = aiKeyDraft.trim();
        if (!typed && !keyKept) throw new Error(`Cole a chave ${AI_INFO[aiProvider].of}.`);
        await saveAi({ provider: aiProvider, model: aiModel }, typed || null);
        setAiKeyDraft('');
        setAiKeySaved(true);
        setAiMsg(`Chave salva neste aparelho. O copiloto usa ${AI_INFO[aiProvider].label} (${aiModel.trim()}).`);
      }
    } catch (e) {
      setAiMsg(e instanceof Error ? e.message : 'Não foi possível salvar.');
    }
    setAiBusy(false);
  };

  const removeAiKey = async () => {
    setAiBusy(true);
    try {
      await clearAi();
      setAiKeySaved(false);
      setAiProvider(null);
      setAiModel('');
      setAiMsg('Chave removida deste aparelho. O copiloto usa a IA do servidor.');
    } catch {
      setAiMsg('Não foi possível apagar a chave deste aparelho. Tente de novo.');
    }
    setAiBusy(false);
  };
  const identity = () => `${normalizeApiUrl(useSettings.getState().apiUrl)} ${useSettings.getState().userId}`;

  const loadDevices = async () => {
    const gen = ++devicesGen.current;
    const started = identity();
    const current = () => gen === devicesGen.current && started === identity();
    try {
      const { devices: list } = await api.devices();
      // Este aparelho primeiro; o servidor ordena por data de registro.
      if (current()) setDevices(list.sort((x, y) => Number(y.current) - Number(x.current)));
    } catch {
      if (!current()) return;
      setDevices(null);
      setDeviceMsg('Não foi possível ler os aparelhos no servidor.');
    }
  };

  const revoke = async (d: DeviceInfo) => {
    if (deviceConfirm !== d.id) {
      setDeviceConfirm(d.id);
      setDeviceMsg(d.current ? 'Toque de novo para sair. Este aparelho vira um usuário novo, sem o histórico.' : 'Toque de novo para desconectar o aparelho.');
      return;
    }
    setDeviceConfirm(null);
    setDeviceBusy(d.id);
    try {
      if (d.current) {
        await api.logout();
        setDeviceMsg('Você saiu. Este aparelho recebeu um identificador novo.');
        void loadPrivacy();
      } else {
        await api.revokeDevice(d.id);
        setDeviceMsg('Aparelho desconectado. O token dele deixou de valer.');
      }
    } catch (e) {
      setDeviceMsg(e instanceof ApiError && e.status !== 0 ? e.message : 'Não foi possível desconectar. Confira a conexão com o servidor.');
    }
    setDeviceBusy(null);
    void loadDevices();
  };

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
      void loadDevices();
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
      setDeviceConfirm(null);
      setDeviceMsg(null);
      devicesGen.current++;
      setDevices(null);
    }
    s.set({ apiUrl: nextUrl });
    setStatus('Testando…');
    try {
      const h = await api.health();
      setServerByok(h.byok ?? []);
      const ai = h.ai ? `IA: ${h.ai.provider} (${h.ai.model}).` : 'IA desativada: o copiloto usa regras.';
      setStatus(`Conectado. ${ai} ${h.map ? 'Mapa do próprio servidor.' : 'Mapa público (OpenFreeMap).'}`);
      void loadPrivacy();
      void loadDevices();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Falha');
    }
  };

  useEffect(() => {
    hasAiKey()
      .then(setAiKeySaved)
      .catch(() => setAiKeySaved(false));
    void test();
    // Testa a conexão uma vez ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A identidade mudou (dados apagados, saída ou token revogado em outro aparelho): a lista era do usuário antigo.
  const shownIdentity = useRef(s.userId);
  useEffect(() => {
    if (shownIdentity.current === s.userId) return;
    shownIdentity.current = s.userId;
    devicesGen.current++;
    setDevices(null);
    setDeviceConfirm(null);
    void loadDevices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.userId]);

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

      <Card style={{ gap: 10 }}>
        <T variant="title">IA do copiloto</T>
        <View style={styles.chips}>
          <Chip label="Do servidor" selected={aiProvider === null} onPress={() => pickAiProvider(null)} />
          {AI_PROVIDERS.map((p) => (
            <Chip key={p} label={AI_INFO[p].label} selected={aiProvider === p} onPress={() => pickAiProvider(p)} />
          ))}
        </View>
        {aiProvider ? (
          <>
            <TextInput
              value={aiModel}
              onChangeText={setAiModel}
              placeholder={AI_INFO[aiProvider].modelHint}
              placeholderTextColor={t.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surfaceAlt }]}
              accessibilityLabel="Modelo de IA"
            />
            <TextInput
              value={aiKeyDraft}
              onChangeText={setAiKeyDraft}
              placeholder={keyKept ? 'Chave salva. Cole outra para trocar.' : `Chave (${AI_INFO[aiProvider].keyHint})`}
              placeholderTextColor={t.textMuted}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surfaceAlt }]}
              accessibilityLabel="Chave de IA"
            />
            <T variant="caption">
              A chave fica só neste aparelho. O app a manda ao servidor acima, por HTTPS, apenas nas chamadas de IA. O servidor a repassa{' '}
              {AI_INFO[aiProvider].to} e não a guarda nem registra em log.
            </T>
            {aiKeyInBrowser() ? (
              <T variant="caption" color={t.warning}>
                No navegador não há cofre de chaves: a chave fica no armazenamento local deste site, e quem usar este navegador consegue lê-la.
              </T>
            ) : null}
            {serverByok && !serverByok.includes(aiProvider) ? (
              <T variant="caption" color={t.danger}>
                Este servidor não aceita chave própria {AI_INFO[aiProvider].of}. Atualize a API ou use a IA do servidor.
              </T>
            ) : null}
          </>
        ) : (
          <T variant="caption">O copiloto usa a IA configurada no servidor. Sem IA no servidor, ele segue por regras.</T>
        )}
        <Button label="Salvar IA" kind="secondary" icon="key-variant" loading={aiBusy} onPress={() => void saveAiChoice()} />
        {aiKeySaved && s.ai ? (
          <Button label="Remover chave deste aparelho" kind="danger" icon="key-remove" disabled={aiBusy} onPress={() => void removeAiKey()} />
        ) : null}
        {aiMsg ? <T variant="caption">{aiMsg}</T> : null}
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
        <T variant="title">Aparelhos conectados</T>
        {devices?.map((d) => (
          <View key={d.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <T>{d.current ? 'Este aparelho' : 'Outro aparelho'}</T>
              <T variant="caption">
                Conectado em {day(d.createdAt)}
                {d.lastSeenAt ? ` · último uso em ${day(d.lastSeenAt)}` : ''}
              </T>
            </View>
            <Button
              label={deviceConfirm === d.id ? 'Confirmar' : d.current ? 'Sair' : 'Desconectar'}
              kind={deviceConfirm === d.id ? 'danger' : 'secondary'}
              icon={d.current ? 'logout' : 'link-off'}
              loading={deviceBusy === d.id}
              disabled={devices.length === 1}
              onPress={() => void revoke(d)}
            />
          </View>
        ))}
        {devices?.length === 1 ? (
          <T variant="caption">Este é o único aparelho conectado. Para sair dele, use "Apagar meus dados do servidor".</T>
        ) : null}
        {deviceMsg ? <T variant="caption">{deviceMsg}</T> : null}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
});
