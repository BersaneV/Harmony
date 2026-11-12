# Diagnóstico P2P gratuito

O Harmony oferece um experimento opcional para avaliar conexão direta entre dois participantes. As chamadas, permissões e moderação continuam no LiveKit. O experimento não é um segundo modo de chamada: transmite pings e um vídeo sintético gerado por canvas, sem pedir acesso ao microfone, câmera ou compartilhamento de tela.

## Ativação

`HARMONY_P2P_DIAGNOSTICS=true` habilita o diagnóstico. A configuração gerada para o perfil simples habilita o botão, mas o servidor sem a variável permanece desabilitado. `HARMONY_P2P_STUN_URLS` aceita até quatro endereços `stun:`/`stuns:`, separados por vírgula, sem credenciais. O padrão é vazio, adequado ao teste local. Para testar entre redes distintas, o operador pode informar o STUN da própria instância, por exemplo `stun:turn.seudominio:3478` quando o TURN/UDP embutido do LiveKit estiver habilitado e acessível.

STUN ajuda a descobrir o endereço acessível; não transporta o vídeo. O diagnóstico não aceita configurações ou credenciais TURN e não contrata relay. Quando NAT/firewall impede conexão direta, o teste pode falhar e informa essa limitação. Serviço gratuito de STUN não equivale a hospedagem gratuita ou banda de relay gratuita. Referências oficiais: [conectividade LiveKit](https://docs.livekit.io/transport/self-hosting/ports-firewall/) e [tipos de candidatos ICE](https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidateStats/candidateType).

## Como testar

1. Duas pessoas entram no mesmo canal de voz com contas diferentes e permissões de conexão e publicação. Não podem estar silenciadas ou temporariamente removidas por moderação.
2. A primeira pessoa abre **Testar P2P**, seleciona resolução/FPS/bitrate e toca em **Iniciar teste no canal**.
3. A outra pessoa vê automaticamente um cartão com o nome de quem iniciou e toca em **Participar**. O clique abre o painel e conecta; não é preciso copiar ou colar identificadores. O aviso sobre conexão direta e visibilidade dos endereços de rede aparece antes da ação.
4. Acompanhar RTT P2P, RTT até o servidor, caminho ICE, FPS/bitrate efetivos, jitter e pacotes perdidos disponíveis. Apenas quem cria transmite o vídeo sintético. Para testar o outro sentido, encerrar e inverter quem cria.
5. Encerrar e baixar o JSON. O relatório contém estatísticas, sem tokens, SDP, candidatos completos, IPs ou identificadores de usuário/canal. Para comparação WAN, registrar separadamente que os participantes estavam efetivamente em redes distintas.

O teste expira em até 120 segundos. Fechar o painel, trocar de conta, perder a sinalização ou perder uma permissão fecha os recursos do cliente oficial. Estatística não fornecida pelo navegador aparece como indisponível, e não como zero. Resolução e FPS selecionados são solicitações; os valores efetivos vêm de `RTCPeerConnection.getStats()`.

A navegação por canal e participação com um clique segue a referência pública do [Discord Go Live](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share) e das salas do [Crystal](https://crystal.lat/). A implementação é própria e mantém este recurso como diagnóstico temporário.

## Controles de sinalização

- `GET /api/channels/{id}/p2p-probes`: metadados e convites disponíveis do mesmo canal, somente para participante autorizado. Retorna apenas testes não expirados, sem convidado e com criador conectado e ainda autorizado.
- `POST /api/channels/{id}/p2p-probes`: cria um identificador interno aleatório temporário; no máximo um teste ativo por pessoa e 64 testes residentes. O identificador não aparece na interface.
- `GET /api/p2p/ws`: WebSocket com autenticação no primeiro frame, sem token na URL. O frame `auth` contém `token`, `probe_id` e `channel_id`.
- O evento `p2p.changed` contém somente o canal, sem identificador do teste, token ou SDP; invalida somente a consulta de convites. Reconexão e consulta periódica recuperam alterações perdidas. Falha de autorização oculta convites anteriores e impede iniciar outro teste na interface.
- Somente duas identidades distintas podem participar. A reserva da vaga é atômica, incluindo entradas simultâneas. A entrada revalida também a sessão e as permissões do criador. Oferta e resposta têm papéis fixos e não aceitam destinatário arbitrário. SDP com áudio é recusado. Sinalização, candidatos, tamanho de mensagens e ping são limitados.
- Sessão, CONNECT/PUBLISH, mute e ban são verificados na entrada, em sinalização e a cada dois segundos. Fechamento de qualquer lado encerra o teste inteiro. Estado, SDP e ICE não são persistidos nem registrados em log.

Uma vez estabelecida conexão direta, um servidor não controla o tráfego de clientes modificados da mesma maneira que um SFU. Por isso o experimento permanece restrito ao diagnóstico e não substitui o caminho de chamadas/moderação. O cliente oficial não captura mídia privada, para e libera todas as tracks/conexões quando o teste termina.

## Verificação automatizada

`scripts/test_p2p_discovery.mjs` verifica a descoberta pela API/WS real: isolamento, convite somente após conexão do criador, disputa pela vaga, revogação de sessão/permissão, moderação, fechamento e expiração real de 120 segundos. Usa somente loopback e cria dados descartáveis; configure `HARMONY_TEST_URL` e execute por `scripts/with-env.py` como o teste abaixo.

`scripts/p2p-browser-test.mjs` executa dois processos Chromium separados, com perfis descartáveis, contra a API real e o módulo de diagnóstico servido pelo Vite. Usa o Chrome já instalado; não acessa perfis pessoais. Aceita somente servidores em loopback para evitar criar contas de teste no destino errado.

```sh
# Terminal 1: API com configuração privada de teste e P2P habilitado.
HARMONY_ENV_FILE=.local/p2p-runtime/.env python3 scripts/with-env.py target/debug/harmony-server

# Terminal 2: Vite de desenvolvimento (não vite preview).
npm run dev -w @harmony/desktop -- --port 1421 --strictPort

# Terminal 3: teste. Ajustar a porta da API à configuração privada.
HARMONY_TEST_URL=http://127.0.0.1:18088 \
HARMONY_WEB_URL=http://127.0.0.1:1421 \
HARMONY_ENV_FILE=.local/p2p-runtime/.env \
python3 scripts/with-env.py node scripts/p2p-browser-test.mjs
```

O script exige credenciais administrativas apenas para criar contas/comunidade de teste na API local. Não as imprime. `HARMONY_CHROME` pode indicar outro executável Chromium; o padrão é o Google Chrome instalado no macOS. O resultado fica em `.local/p2p/browser-evidence.json` (ou `HARMONY_P2P_REPORT`). Testa WebRTC real, vídeo sintético, RTT, isolamento entre canais, identidade duplicada, ausência de autenticação, revogação de publicação, reset de senha, TTL real e rejeição de áudio.

**Limite de interpretação:** dois navegadores no mesmo computador comprovam funcionamento local e controles, não melhoria do RTT de aproximadamente 137 ms observado anteriormente até Ashburn. O relatório marca `scope: same-machine` e mantém WAN, Windows/WebView2, captura real e TURN como não verificados. RTT de ping não mede atraso de captura até reprodução; [getStats](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats) fornece métricas com escopos próprios.
