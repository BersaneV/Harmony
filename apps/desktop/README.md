# Cliente Harmony

Cliente React/TypeScript e executável Tauri 2 para a instância Harmony. Sem dados de demonstração ou conexão automática com serviços comerciais.

## Desenvolvimento

Na raiz do repositório, `npm ci`, `npm run dev` (porta 1420), `npm run test` e `npm run build`. O servidor é escolhido na tela de entrada. Use HTTPS fora de loopback. O backend deve autorizar a origem do cliente em sua configuração CORS.

`npm run desktop:dev` abre o Tauri. `npm run desktop:build` gera o instalador NSIS quando executado no Windows com os pré-requisitos oficiais do Tauri. O manifesto Rust do desktop tem workspace e lockfile próprios em `src-tauri/`.

## Funcionalidades implementadas

- Entrada, cadastro por convite, recuperação com código administrativo e troca da instância.
- Comunidades e canais de texto/voz, convites, lista de membros, cargo de moderador e remoção.
- Amigos, pedidos e conversas diretas/grupos.
- Mensagens Markdown sem HTML ativo ou carregamento automático de imagens externas; edição, exclusão, reações, busca, paginação, anexos e download autorizado. Imagens/GIFs, vídeos e áudios têm visualização/reprodução explícita por clique, com blobs limitados e revogados ao fechar. HTML/SVG não são exibidos inline.
- Retry de mensagem preserva nonce; recuperação incremental usa o cursor de alterações do servidor, inclusive edições/exclusões/reações anteriores, e preserva BIGINT como string/BigInt.
- Voz/câmera e telas com LiveKit; captura exige ação explícita; prévia antes de publicar; microfone inicia desligado; áudio de tela separado; dispositivos, volume, foco/grade/tela cheia e moderação.
- Resoluções 144p–2160p, FPS 15/24/30/60 e bitrate automático/manual dentro do teto do servidor. A UI separa pedido e estatísticas WebRTC efetivas.
- Um encoder VP8 por tela, sem simulcast e sem codec reserva: o limite definido corresponde ao orçamento agregado de vídeo dessa tela. Áudio/overhead e câmera são contabilizados separadamente. Perfis não são promessa de desempenho.
- Push-to-talk: F9 global no Tauri, Espaço com janela focada no navegador. Registro nativo expõe somente F9, não atalhos arbitrários.
- Temas claro/escuro, cor validada, fonte do sistema, tamanho, densidade e fundo. Preferências persistidas no servidor; nenhum CSS/JS de terceiros.
- Administração de contas, desativação, convite de cadastro, código de reset com reautenticação, auditoria e métricas disponíveis na API.
- Notificações mediante permissão, enquanto o aplicativo está aberto.

## Fronteiras de segurança

O token de acesso fica na memória. No Tauri, somente o refresh token é persistido no Windows Credential Manager/macOS Keychain, por origem da instância. No navegador, ele fica somente na memória: recarregar requer nova entrada. Nenhum token vai em URL ou localStorage. localStorage contém apenas a origem escolhida.

Troca de conta/origem e logout invalidam respostas assíncronas anteriores. Rotação concorrente usa uma única requisição de refresh. Navegação remota na WebView é bloqueada; links HTTP/HTTPS explícitos abrem no navegador padrão. Capabilities permitem somente comandos específicos de sessão, links, F9 e notificações. Sem shell/FS genérico ou IPC para páginas remotas.

Downloads e uploads usam URLs assinadas obtidas após autorização na API. Markdown não executa HTML, scripts ou imagens remotas. O download cria um blob local com nome seguro fornecido pela API; não executa o arquivo.

## Validação e limites reais

TypeScript, build Vite e testes de regressão cobrem orçamento de bitrate, catálogos, BigInt, mesclagem de mensagens, tema e corridas de sessão. `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` compila o adaptador nativo e verifica origens aceitas/rejeitadas. Isso não homologa captura, keyring ou hotkeys em Windows real.

- O instalador Windows ainda precisa da prova de execução/captura em hardware Windows, áudio do sistema, permissão negada, múltiplos monitores, suspensão e F9 durante jogo.
- Sem simulcast inicial, um receptor que escolhe teto menor que a única camada é informado e tem o vídeo pausado. Não há transcode no SFU nem promessa de nove camadas simultâneas.
- Não há updater ativo sem chave de assinatura e endpoint publicados. Instalação gerada não equivale a Authenticode assinado.
- Rascunhos e fila de envio do frontend ficam em memória; mensagens confirmadas e o histórico são persistidos no PostgreSQL. Não anunciar envio offline ou recuperação de rascunho após fechar o app.
- Fontes arbitrárias, wallpapers importados, editor Lexical avançado, threads/fóruns, stickers de catálogo, E2EE e recursos experimentais permanecem evoluções; anexos GIF/imagem/áudio/vídeo usam o caminho de arquivo real.
- A UI não substitui políticas de quota e autorização do servidor. Clientes modificados podem ignorar limites locais de bitrate; controle de rede permanece necessário na infraestrutura.
