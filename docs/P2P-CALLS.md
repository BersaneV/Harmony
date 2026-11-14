# Chamadas reais P2P — 0.4.1

O transporte padrão usa WebRTC diretamente entre participantes. Entrar em um canal de voz abre a chamada; conversas diretas e grupos têm o botão de chamada existente. Não há código para copiar nem prazo de 120 segundos. Microfone e câmera começam desligados e só são capturados por ação do usuário. Compartilhar tela exige escolher uma fonte, conferir a prévia e iniciar a transmissão.

A [prévia 0.4.1 para Windows x64](https://github.com/BersaneV/Harmony/releases/tag/v0.4.1) está publicada, com instalador e canal de atualização verificados. Passou no ensaio de oito participantes com voz e uma transmissão em 720p/30 FPS descrito abaixo. O CI completo também repetiu o perfil de 720p/15 FPS. Consulte [VALIDATION.md](VALIDATION.md) para os commits, hashes e limites.

## Transporte e configuração

`HARMONY_MEDIA_TRANSPORT=p2p` é o padrão. A API autentica e coordena a sala por WebSocket; a mídia não passa por ela. O serviço Compose `harmony` basta para desenvolvimento local. Em acesso público, `caddy` fornece HTTPS/WSS no perfil `public`; somente o nome `app` precisa de DNS. O worker isolado, SQLite, arquivos privados, personalização e atualizações assinadas permanecem.

`HARMONY_CALL_STUN_URLS` usa `stun:stun.l.google.com:19302` por padrão, seguindo o exemplo de conectividade WebRTC. O operador pode trocar por STUN próprio ou deixar explicitamente vazio para candidatos locais. Aceita no máximo quatro endereços STUN sem credenciais. STUN descobre rotas; não é hospedagem nem relay de áudio/vídeo. O serviço externo recebe consultas de rede dos clientes, não contas, mensagens ou mídia. Não há TURN contratado, upgrade automático ou recurso faturável criado.

O limite `HARMONY_MAX_ROOM_PARTICIPANTS` é 2–12 em P2P (padrão 12), até 256 participantes ativos na instância, com uma chamada por usuário. São limites de admissão, não capacidade homologada. Cada participante mantém uma conexão com cada outro participante; o upload de uma tela cresce com o número de espectadores. A configuração de bitrate é por destinatário, acrescida de áudio e overhead de rede.

O modo `HARMONY_MEDIA_TRANSPORT=livekit` preserva o caminho SFU anterior. Em instalação nova, use `scripts/configure.py --media-transport livekit`, os nomes DNS do modo e `docker compose --profile public --profile sfu up -d --build`. O modo é escolhido por instância, sem fallback automático. Servidor P2P recusa tokens de mídia LiveKit; atualize os clientes 0.3 junto do servidor. Cliente 0.4 reconhece explicitamente servidores 0.1–0.3 antigos e usa o transporte legado, sem contornar 403 ou erros de servidores atuais.

## Alvo de uso: 5 a 8 pessoas

Victor definiu grupos de 5 a 8 pessoas como alvo. Isso não transforma o limite configurável de 12 em capacidade homologada. O teste entre redes diferentes ficou para depois por decisão do usuário.

Em uma sala com uma tela transmitida, o emissor atende quatro espectadores com cinco pessoas, ou sete com oito. O bitrate selecionado é por espectador:

| Pessoas na sala | Espectadores | Tela a 2 Mb/s por espectador | Tela a 4 Mb/s por espectador |
|---|---:|---:|---:|
| 5 | 4 | 8 Mb/s | 16 Mb/s |
| 8 | 7 | 14 Mb/s | 28 Mb/s |

Esses valores são orçamentos de configuração para o vídeo. Acrescente voz, áudio da tela e tráfego de rede; a adaptação do encoder pode reduzir a taxa e a resolução. Câmeras ou outras telas simultâneas acrescentam processamento e tráfego. O valor escolhido não garante aquela qualidade efetiva.

Na 0.4.0, o ensaio local com cinco Chromes recebeu 20 fluxos direcionais de voz e uma tela nos quatro espectadores. Com teto de 720p/30 FPS e 2 Mb/s por espectador, o vídeo recebido foi **540p a cerca de 29 FPS**; a resolução solicitada não foi mantida. A soma das taxas de saída das faixas do emissor teve mediana de 8,67 Mb/s nessa janela de aproximadamente 20 s.

Ainda na 0.4.0, oito conexões de sinalização entregaram 504/504 mensagens sem desconexão em duas provas. Os ensaios completos com oito navegadores no mesmo Mac não passaram; uma repetição com cinco também não passou. Na repetição instrumentada, o servidor registrou o prazo de 500 ms excedido ao confirmar autorização, e o operador observou carga alta do host. Os motivos genéricos das tentativas anteriores não comprovam individualmente a mesma causa. O diagnóstico preservou os controles de segurança e não isolou CPU de outras esperas de escalonamento ou I/O. A conclusão de capacidade pendente daquele registro é histórica; o novo resultado da 0.4.1 tem o escopo delimitado a seguir.

O [registro da 0.4.0](evidence/p2p-0.4.0-capacity.json) preserva esses resultados e falhas. Na 0.4.1, o ensaio [43577516271](https://github.com/BersaneV/Harmony/actions/runs/43577516271), fonte `c2375c3c597c57715424aded01c07f0f79a542f0`, passou com oito processos Chrome no mesmo runner Ubuntu: 28 pares de conexão, 56 fluxos direcionais de microfone, uma fonte de vídeo no slot de tela e sete fluxos de áudio da tela. Usou API/WS/SQLite e a engine de produção, sem preferência de codec injetada pelo teste, STUN externo, TURN ou LiveKit. A engine escolheu H264 Constrained Baseline `42e01f` nas sete saídas do emissor de tela. [Evidência sanitizada da 0.4.1](evidence/calls-0.4.1-ci.json).

| Fase previamente definida | Observação |
|---|---|
| Acomodação fixa de 30 s; duração observada de 30,0045 s | 36 de 630 amostras de fluxo de áudio ficaram fora do orçamento da fase sustentada; máximo de 5,9876% de amostras reconstruídas. Três espectadores começaram em 360p; o último atingiu 720p na amostra de 17,0236 s. A fase inicial foi registrada, sem aprovação de qualidade. |
| Medição adicional de 180 s; duração observada de 180,7825 s | Todos os sete espectadores mantiveram 1280×720 nas amostras e médias de 26,7565–29,6949 FPS exibidos, descontando quadros descartados, com perfil solicitado de 30 FPS e 4 Mb/s por espectador. Nenhum intervalo de áudio reprovou; a maior fração de amostras reconstruídas foi 0,7186%. |

Não houve intervalo inteiro de amostragem nominal de três segundos sem avanço do vídeo exibido. Essa observação não demonstra ausência de pausas menores. Mute e mudanças de permissão chegaram em 52–464 ms; reset de senha, em 1.159 ms, dentro do limite de dois segundos do ensaio.

As fontes da prova de oito participantes são dispositivos virtuais WAV/Y4M: o vídeo é uma câmera falsa enviada no slot de tela. Não foi capturado monitor, jogo, microfone ou áudio do sistema pessoal. O microfone do emissor e seu áudio de tela usam o mesmo arquivo de tom de 330 Hz; o roteamento de fontes distintas e o getDisplayMedia real de uma aba própria são exercitados pela suíte separada de três navegadores. A prova não homologa oito máquinas Windows físicas, redes distintas, múltiplas telas/câmeras simultâneas, 1440p ou 60 FPS sustentados. Esses cenários, medição de upload real e aceite entre usuários permanecem pendentes.

## Fontes, controles e estatísticas

Cada conexão usa quatro transceivers estáveis: microfone, câmera, tela e áudio da tela. A negociação trata ofertas concorrentes, publicação posterior à entrada, troca de fontes e saída de participantes. Falha de um par não deve interromper os demais; perda de sinalização ou autorização encerra a chamada local. Reconectar não abre dispositivos automaticamente.

Na 0.4.1, a engine evita repetir replaceTrack e setParameters quando a faixa e os parâmetros nativos já correspondem ao estado solicitado. A leitura do estado real continua permitindo reaplicar limites que uma renegociação tenha reiniciado.

A escolha do codec da tela é por emissor e destinatário, antes da primeira faixa. H264 Constrained Baseline `42e01f`, com `packetization-mode=1`, só é escolhido entre codecs negociados e com captura/limites compatíveis com até 1280×720, 30 FPS e 14 Mb/s. Altura automática, geometria desconhecida, largura fora do envelope e perfis superiores seguem VP8 quando a API permite selecioná-lo. FPS e bitrate automáticos podem usar H264 quando seus tetos efetivos de 30 FPS e até 8 Mb/s cabem nesse envelope. Se a API estiver ausente, ignorar ou rejeitar a escolha inicial, o navegador conserva sua seleção nativa; o codec efetivo depende das estatísticas.

Uma ampliação além do envelope exige confirmar a troca para VP8 antes de alterar a captura, preservando os limites anteriores nessa etapa. Se essa confirmação falhar, a qualidade anterior permanece. Depois que o sender usa VP8, a engine não tenta voltar a H264 durante sua vida. Não há edição de SDP nem da lista negociada de codecs. Participantes que entram durante uma troca de qualidade aguardam sua conclusão; a barreira de operação/geração/faixa também trata erro, revogação e reconexão sem reabrir dispositivos.

- Tela: resolução automática ou 144p/240p/360p/480p/720p/1080p/1440p/2160p; FPS automático ou 15/24/30/60; bitrate automático ou 0,5–32 Mb/s, respeitando o teto da instância; perfis texto/movimento.
- A captura e o encoder recebem limites, mas rede, codec, fonte e equipamento determinam o resultado. “Automático” usa adaptação do WebRTC com teto inicial de 8 Mb/s e 30 FPS, limitado pela instância.
- Cada espectador pode pedir teto de resolução da tela. O emissor ajusta a escala de sua conexão, sem reduzir a qualidade dos outros espectadores. A interface distingue a resolução recebida da solicitada; não anuncia adaptação se o navegador não a aplicar.
- Volumes separados para voz e áudio da tela, dispositivos de entrada/saída quando suportados, silenciar áudio, câmera e push-to-talk (Espaço com foco na Web, F9 global no Tauri).
- A prévia não publica. Cancelar libera a captura. Desmarcar áudio antes de publicar descarta a faixa de áudio; captura sem áudio informa essa condição. Parar a tela também libera seu áudio.
- Estatísticas efetivas incluem resolução, FPS, bitrate e RTT ICE quando disponíveis. Ausência de medição não é zero. RTT ICE não mede atraso de captura até reprodução. O upload agregado é indicado como parcial quando faltam amostras.

Compartilhamento de áudio depende da fonte e do suporte do navegador/WebView2/Windows. Captura de janela, tela inteira e áudio do sistema não são equivalentes à captura de uma aba. Reprodução bloqueada pelo navegador oferece ação para ativar áudio. Não existe gravação automática.

## Autorização e limites de segurança

`GET /api/channels/{id}/call` exige sessão, VIEW e CONNECT atuais e canal de voz, DM ou grupo. `GET /api/calls` abre o WebSocket, cujo primeiro frame autentica token e canal. Tokens nunca são colocados na URL. O servidor atribui o peer_id e impede duplicidade de usuário/lotação de forma atômica.

A sinalização só encaminha entre participantes atuais do mesmo canal. Identidade de origem vem do servidor. SDP/ICE são efêmeros, sem persistência ou logs. Payloads, filas, negociação, bytes e frequência são limitados; consumidor lento é removido. Destino que já saiu é descartado sem desconectar o remetente.

Sessão, expiração, versão de autenticação, conta desativada, ACL, mute e ban são revalidados. O watchdog roda a cada 500 ms, com prazo de 500 ms para consultar acesso e 250 ms para escrita. Testes registram os tempos observados; isso não é promessa absoluta sob qualquer carga. Rotação legítima de refresh não derruba um socket já admitido, mas ele continua preso à sessão e ao vencimento do token até reautenticação estrita. Logout, reset e replay que revoga sessão encerram a chamada.

Desde a 0.4.1, cada verificação reúne sessão, canal, ACL, mute e ban em uma única consulta SQLite e no mesmo snapshot, substituindo quatro consultas sequenciais. As duas pontas de cada sinal continuam verificadas, sem cache e com o mesmo prazo de 500 ms. A correção reduz aquisições e esperas acumuladas; não relaxa autorização nem atribui exclusivamente ao SQL todas as falhas históricas de carga.

O cliente oficial para capturas ao perder PUBLISH/mute, descarta mídia não autorizada dos outros e fecha tudo ao perder CONNECT/VIEW/sinalização. A moderação do servidor persiste mute e remoção; remover aplica o ban temporário existente. Desmutar não liga o microfone automaticamente.

**Limite do P2P:** depois que dois clientes trocam chaves e endereços, o servidor de sinalização não consegue cortar fisicamente pacotes entre clientes modificados que cooperem para ignorá-lo. LiveKit permanece como modo opcional para controle central da mídia. DTLS-SRTP protege o transporte WebRTC, mas a aplicação não oferece identidade E2EE verificável pelo usuário nem promete que o administrador não possa acessar conteúdo persistido. Os participantes podem conhecer os endereços de rede uns dos outros.

Redes com NAT/firewall restritivo podem impedir a conexão direta. O cliente tenta recuperar e depois mostra falha; não compra relay. Trocar de rede ou configurar conscientemente a instância em modo LiveKit são alternativas. O túnel HTTPS temporário transporta apenas aplicação/sinalização e depende do computador de desenvolvimento; não é hospedagem definitiva.

## Verificação reproduzível

Protocolo HTTP/WS, SQLite e arquivos reais, instância descartável sem LiveKit e com diagnóstico desabilitado:

```sh
cargo build --workspace --locked
node scripts/test_calls.mjs
```

Mídia real com três processos Chromium separados, contra API local P2P e Vite de desenvolvimento. Cada teste usa perfis próprios e contas descartáveis; não abre o perfil pessoal nem captura microfone/câmera físicos. As fontes de áudio e câmera são geradas. Uma aba criada pelo teste é capturada pelo getDisplayMedia real, mediante gesto de teste e seleção restrita ao título da própria fixture. O resultado explicita as exclusões:

```sh
HARMONY_TEST_URL=http://127.0.0.1:8081 \
HARMONY_WEB_URL=http://127.0.0.1:1420 \
HARMONY_ENV_FILE=/caminho/privado/teste.env \
python3 scripts/with-env.py node scripts/call-browser-test.mjs
```

Defina `HARMONY_CHROME` para o executável Chromium local; o padrão é Chrome no macOS. A API deve corresponder às credenciais de bootstrap desse ambiente descartável. Relatórios locais: `.local/qa-call-protocol/result.json` e `.local/qa-real-calls/browser-result.json`. Testes unitários da engine cobrem interrupção de operações pendentes, moderação, reconexão, glare, tracks e limites; são complementares à prova RTC.

O [workflow manual de capacidade](https://github.com/BersaneV/Harmony/actions/workflows/call-capacity.yml) configura uma instância descartável no runner Ubuntu padrão. Para reproduzir o perfil aprovado, use `fps=30`, `source=native-fake`, `settling_seconds=30` e `codec=default`; o workflow fixa oito processos, altura 720p e 180 s de medição. `codec=default` deixa a escolha para a engine de produção. A variante `h264` injeta preferência apenas no adaptador de teste e é um experimento separado. O teste registra a fase inicial completa, exige fontes decodificando e dimensões corretas ao fim dos 30 s, não reinicia a mídia nem prolonga a espera para obter aprovação. Os critérios e o histórico de falhas estão em [VALIDATION.md](VALIDATION.md).

As medições no mesmo computador não representam ping 5G, NAT entre redes, desempenho de jogos ou Windows físico. A execução de mídia, revisão e publicação desta versão ficam registradas em [VALIDATION.md](VALIDATION.md). O [diagnóstico antigo](P2P-DIAGNOSTICS.md) permanece separado e não substitui esses testes.

Fontes técnicas: [negociação WebRTC](https://w3c.github.io/webrtc-pc/#perfect-negotiation-example), [captura de tela e autorização](https://w3c.github.io/mediacapture-screen-share/#dom-mediadevices-getdisplaymedia), [conectividade e STUN](https://webrtc.org/getting-started/peer-connections).
