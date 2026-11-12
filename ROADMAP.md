# Roadmap do Harmony

Este arquivo preserva as fases do projeto. A primeira implementação cobre o núcleo e parte das fases de mídia/operação. Consulte [VALIDATION.md](docs/VALIDATION.md) para provas executadas e pendências; a presença de um item aqui não significa que esteja entregue ou homologado.

## Fase 0 — provas de mídia e Windows

- Executável Tauri no Windows 11 x64, com versões de Tauri e WebView2 registradas.
- Captura de monitor/janela, permissão negada, cancelamento, mudança de dispositivo e suspensão.
- Microfone e áudio da tela separados; verificar eco e captura indevida da própria chamada.
- Resolução, FPS e bitrate antes/durante a transmissão; comparar configuração solicitada com estatísticas efetivas.
- Catálogo 144p–2160p; habilitar cada perfil somente com prova de captura/publicação real.
- Limite agregado de bitrate entre camadas; degradação sob congestionamento e múltiplos espectadores.
- LiveKit local e remoto: UDP e fallback TURN/TLS 443, DNS/SNI e redes diferentes.
- Compatibilidade de imagens e binários para servidor ARM64 e cliente Windows x64.

Registrar máquina, rede, versões, cenário, esperado, observado, métricas, logs sem segredos e situação PASS/FAIL/NOT_RUN. Não usar o teste no navegador de macOS como homologação do executável Windows.

## Fase 1 — núcleo persistente

Contas/convites, sessões/reset administrativo, comunidades/canais, cargos/ACL, mensagens/DMs/grupos, histórico e recuperação após reconexão. Provar idempotência, persistência e casos negativos de autorização.

## Fase 2 — mídia e interação

Voz/câmera/tela, moderação durante chamadas, múltiplas telas, push-to-talk, volume, anexos, reações, menções, busca e notificações. Manter os controles de resolução/FPS/bitrate definidos na arquitetura.

## Fase 3 — personalização e operação

Temas, painel administrativo, cotas, backup/restauração, instalador e atualizações assinadas. Medir consumo real e desempenho antes de anunciar capacidade.

## Condições para piloto público

- Host elegível e disponível, sem recurso pago criado automaticamente.
- DNS e certificados com renovação verificada.
- Limites de disco, upload, publicadores, assinaturas e tráfego aplicados inclusive a fluxos ativos.
- Backup fora do host e restauração ensaiada.
- Provas Windows, autorização, revogação e persistência concluídas.

Alta disponibilidade, FPS superiores ao catálogo inicial, E2EE e demais extensões dependem de etapas próprias. Ver detalhes e limites em [ARCHITECTURE.md](ARCHITECTURE.md).
