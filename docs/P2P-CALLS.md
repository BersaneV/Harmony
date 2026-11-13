# Chamadas reais P2P — 0.4.0

O transporte padrão usa WebRTC diretamente entre participantes. Entrar em um canal de voz abre a chamada; conversas diretas e grupos têm o botão de chamada existente. Não há código para copiar nem prazo de 120 segundos. Microfone e câmera começam desligados e só são capturados por ação do usuário. Compartilhar tela exige escolher uma fonte, conferir a prévia e iniciar a transmissão.

## Transporte e configuração

`HARMONY_MEDIA_TRANSPORT=p2p` é o padrão. A API autentica e coordena a sala por WebSocket; a mídia não passa por ela. O serviço Compose `harmony` basta para desenvolvimento local. Em acesso público, `caddy` fornece HTTPS/WSS no perfil `public`; somente o nome `app` precisa de DNS. O worker isolado, SQLite, arquivos privados, personalização e atualizações assinadas permanecem.

`HARMONY_CALL_STUN_URLS` usa `stun:stun.l.google.com:19302` por padrão, seguindo o exemplo de conectividade WebRTC. O operador pode trocar por STUN próprio ou deixar explicitamente vazio para candidatos locais. Aceita no máximo quatro endereços STUN sem credenciais. STUN descobre rotas; não é hospedagem nem relay de áudio/vídeo. O serviço externo recebe consultas de rede dos clientes, não contas, mensagens ou mídia. Não há TURN contratado, upgrade automático ou recurso faturável criado.

O limite `HARMONY_MAX_ROOM_PARTICIPANTS` é 2–12 em P2P (padrão 12), até 256 participantes ativos na instância, com uma chamada por usuário. São limites de admissão, não capacidade homologada. Cada participante mantém uma conexão com cada outro participante; o upload de uma tela cresce com o número de espectadores. A configuração de bitrate é por destinatário, acrescida de áudio e overhead de rede.

O modo `HARMONY_MEDIA_TRANSPORT=livekit` preserva o caminho SFU anterior. Em instalação nova, use `scripts/configure.py --media-transport livekit`, os nomes DNS do modo e `docker compose --profile public --profile sfu up -d --build`. O modo é escolhido por instância, sem fallback automático. Servidor P2P recusa tokens de mídia LiveKit; atualize os clientes 0.3 junto do servidor. Cliente 0.4 reconhece explicitamente servidores 0.1–0.3 antigos e usa o transporte legado, sem contornar 403 ou erros de servidores atuais.

## Fontes, controles e estatísticas

Cada conexão usa quatro transceivers estáveis: microfone, câmera, tela e áudio da tela. A negociação trata ofertas concorrentes, publicação posterior à entrada, troca de fontes e saída de participantes. Falha de um par não deve interromper os demais; perda de sinalização ou autorização encerra a chamada local. Reconectar não abre dispositivos automaticamente.

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

As medições no mesmo computador não representam ping 5G, NAT entre redes, desempenho de jogos ou Windows físico. A execução de mídia, revisão e publicação desta versão ficam registradas em [VALIDATION.md](VALIDATION.md). O [diagnóstico antigo](P2P-DIAGNOSTICS.md) permanece separado e não substitui esses testes.

Fontes técnicas: [negociação WebRTC](https://w3c.github.io/webrtc-pc/#perfect-negotiation-example), [captura de tela e autorização](https://w3c.github.io/mediacapture-screen-share/#dom-mediadevices-getdisplaymedia), [conectividade e STUN](https://webrtc.org/getting-started/peer-connections).
