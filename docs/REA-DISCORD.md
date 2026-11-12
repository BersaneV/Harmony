# Análise estática do Discord com REA

Data: 12/11/2026. Escopo: pacote oficial **Discord stable 0.0.421 para macOS universal**, obtido pela [página oficial de download](https://discord.com/download). Esta análise fornece referências técnicas para uma implementação original do Harmony. Não é uma análise completa do Discord, uma auditoria de segurança, nem uma homologação do cliente Windows.

O pacote foi montado somente para leitura. O aplicativo, seus scripts de inicialização e seu updater não foram executados. Nenhuma conta Discord, conversa, cookie, token ou diretório de dados de usuário foi acessado. Nenhum código, fonte, som, fonte tipográfica, imagem ou binário do Discord integra o código distribuído pelo Harmony.

## Identidade e integridade

| Item | Evidência observada |
|---|---|
| Origem | Endpoint de download oficial, redirecionando para `stable.dl2.discordapp.net/distro/app/stable/osx/universal/0.0.421/Discord.dmg` |
| Tamanho do DMG | 234.045.145 bytes |
| SHA-256 do DMG | `85ac799972df5cc34978359ba720fb61024bd727b64db6c22bd705a1c555015d` |
| Versão do aplicativo | `0.0.421`, conferida em `Info.plist` e `build_info.json` |
| SHA-256 de `app.asar` | `8b82e3a09af848544bedf2a23f63a875831d51c6fd5ad90948f07452c35fe0c7` |
| SHA-256 de `bundle.js` | `48ab4ea22a2da429e31ec17b4ef62a3a98942763d23f13ca68efaa3108699d47` |
| Verificação de assinatura | `codesign --verify --deep --strict`: válido no disco e atende ao Designated Requirement. Isso não é teste de execução nem prova de ausência de vulnerabilidades. |
| Ferramenta | REA 6.7.0, análise de artefato, JavaScript inerte e fuses Electron |

A licença declarada em `app.asar/package.json` é `UNLICENSED`; o pacote se descreve como bootstrapper privado. A [página de open source do Discord](https://discord.com/open-source) apresenta contribuições e bibliotecas utilizadas. Ela não concede, por si, uma licença aberta para todo o cliente. O Harmony mantém sua própria licença e utiliza dependências com licenças verificadas.

## O que foi observado

### 1. O instalador contém um bootstrapper, não toda a aplicação

O inventário do DMG encontrou 586 ocorrências e 235 nós de conteúdo, incluindo diretórios, symlinks e arquivos deduplicados. Esses números descrevem a representação do pacote; não são contagens de funcionalidades.

O ASAR contém dez arquivos: um bundle JavaScript principal, um preload do splash, metadados, texto e assets do splash. O manifesto externo de bootstrap enumera módulos como `discord_desktop_core`, `discord_voice`, notificações, correção ortográfica e utilitários. O bundle solicita o núcleo por um carregador e chama seu ponto de inicialização. O corpo desses módulos não está entre os dez arquivos do ASAR examinado.

**Conclusão limitada:** há uma separação estática entre inicialização/atualização e módulos da aplicação. Não foram adquiridos os módulos posteriores nem observada a inicialização real. O inventário não recupera o backend do Discord, o código de mídia completo ou a interface principal atual.

### 2. A janela de splash possui uma fronteira explícita com o preload

A leitura estática do módulo `53006` de `bundle.js` encontrou uma configuração para a janela de splash com `nodeIntegration: false`, `contextIsolation: true`, `sandbox: false` e um preload específico. O mesmo recorte registra tratamento de navegação e abertura de janelas. O preload contém chamadas IPC relacionadas a estado, prontidão e encerramento do splash.

Localização preservada pelo REA: `bundle.js`, linha 12, colunas 51675–69220, módulo `53006`. A configuração da janela começa perto da coluna 56423. As colunas do REA seguem a representação da ferramenta; nomes numéricos de módulos só identificam este build.

**Conclusão limitada:** esses são valores e chamadas encontrados no texto distribuído. Não comprovam os parâmetros efetivamente utilizados durante a execução, a segurança de cada handler ou as configurações da janela principal. Não se concluiu a existência de uma vulnerabilidade. O resumo automático do REA não reconheceu todas essas fronteiras Electron no bundle minificado; a leitura do recorte complementa o resultado, com origem e limite explícitos.

### 3. Fuses do framework são verificáveis nos bytes

O leitor de fuses identificou duas fatias Mach-O, x86_64 e arm64, com os mesmos valores relevantes:

| Fuse | Estado observado |
|---|---|
| `RunAsNode` | Desabilitado |
| `EnableNodeCliInspectArguments` | Desabilitado |
| `EnableEmbeddedAsarIntegrityValidation` | Desabilitado |
| `OnlyLoadAppFromAsar` | Desabilitado |

O framework selecionado possui SHA-256 `d8e47439b1c452e86633267aaf11d0417d902ce0d4ffc0096c1f9503f1940faa`. Esses estados não demonstram todos os controles do aplicativo. Por exemplo, desabilitar um mecanismo de integridade Electron não prova que não exista outro mecanismo; desabilitar argumentos Inspector não prova que não exista outra forma de depuração.

### 4. O manifesto de dependências não basta para identificar o binário final

O `package.json` do bootstrapper declara Electron `42.7.1` como dependência de desenvolvimento, enquanto o `Info.plist` do framework realmente embarcado informa `44.10.0`. A diferença é observável nos dois artefatos; não foi inferida a causa nem executado `process.versions`.

**Aplicação ao Harmony:** registrar versão e hash do instalador produzido, além de lockfiles e versões declaradas. Uma versão no manifesto não comprova qual runtime foi empacotado ou executado.

### 5. Mídia exige evidências além do bootstrapper

O nome `discord_voice` no manifesto é uma referência de módulo, não prova de codec, algoritmo de captura, resolução, latência ou bitrate. Não foi feita decompilação desse módulo, captura de tráfego ou sessão de transmissão.

Como contexto separado, a [publicação de engenharia sobre Go Live](https://discord.com/blog/how-it-all-goes-live-an-overview-of-discords-streaming-technology), de 2024, descreve captura, codificação, encaminhamento pelo backend e decodificação, com adaptação à rede e métricas de desempenho. É documentação histórica do fornecedor, não observação deste pacote.

A [documentação oficial sobre captura Windows](https://support.discord.com/hc/en-us/articles/9410427556375--Windows-Capturing-Application-Window-for-Screen-Share-and-Go-Live), atualizada em 2022, descreve caminhos distintos de captura, Windows Graphics Capture e limitações de jogos em tela cheia exclusiva. Isso reforça a necessidade de testar o caminho Windows do Harmony; não estabelece equivalência entre Tauri/WebView2 e o cliente nativo do Discord.

## Decisões e verificações para o Harmony

As seguintes recomendações são decisões de engenharia do Harmony, derivadas dos riscos observados e das fontes citadas; não são código recuperado do Discord:

1. **Fronteira de privilégio curta:** comandos Tauri específicos, payloads validados, nenhuma execução genérica de shell, nenhuma autorização IPC concedida a conteúdo remoto e mensagens renderizadas sem HTML ativo.
2. **Distribuição verificável:** lockfiles, inventário de dependências e identificação do executável final. Atualização automática somente com verificação criptográfica e procedimento de recuperação testado.
3. **Mídia desacoplada:** LiveKit/WebRTC transportam áudio e vídeo; a API Rust autoriza a participação. Captura nativa, se necessária, entra em um adaptador explícito e exige homologação própria.
4. **Qualidade solicitada e medida separadas:** a seleção de resolução/FPS/bitrate não constitui prova de capacidade. Exibir resultados efetivos e conservar a adaptação sob congestionamento.
5. **Áudio independente:** microfone e som compartilhado têm controles e tracks distintos. Verificar eco e inclusão indevida da própria chamada em Windows real.
6. **Prova ponta a ponta:** testar monitor/janela, cancelamento, permissão negada, mudança de dispositivo, suspensão, encerramento da captura e múltiplos espectadores. A análise do pacote macOS não resolve esses critérios.

## Evidências e cobertura

| Registro | Identificador REA |
|---|---|
| Inspeção do DMG | `ev_9477c357b990add4d5003254975c5ac683620a20a2bfddb86ca5e2e5ce923abc` |
| Inventário do DMG | `ev_acf7557bc0ccf6fc8817393d6181a0dbef16fa5c27781598d8e60a517ff63480` |
| Análise de `app.asar` | `ev_70becf9b347746fb0d82b36c6c5feda3a7459ca278b6fa6afea7d819563c44b2` |
| Resumo da análise JavaScript | `ev_87f827bca462d1745c98fe032e284b4d087957fbcf9045235aa11e0fab38d706` |
| Recorte do módulo de splash | `ev_cdedd7653c049867cd0a929b7d48363c384f43870a3dd12d210bdbe7f253230c` |
| Fuses Electron | `ev_5e2ad9b4004b189e663fc6b34580011c10a2d5e4f42ddf75aea788903586d494` |

Foram lidos 3.092.472 bytes de texto relevante do ASAR, com dois arquivos JavaScript processados e nenhuma falha de parsing. O REA recuperou 980 módulos, incluindo módulos do bundle. **A cobertura semântica é parcial:** 20.489 desconhecidos retidos, com limites de retenção atingidos e ocorrências adicionais omitidas. Contagem zero de uma categoria no resumo não foi interpretada como ausência de comportamento.

O bundle canônico de evidências foi exportado localmente antes de fechar a sessão: nove registros, 58.160.866 bytes. Os artefatos e as evidências integrais permanecem em `.local/rea-discord/`, ignorado pelo Git, pois contêm materiais do fornecedor e caminhos da máquina. O manifesto local de aquisição registra hashes, versões e limites. Este relatório público contém apenas metadados, conclusões originais e referências.

| Pergunta | Resultado |
|---|---|
| Qual pacote foi examinado? | Respondida por origem, versão e hashes. |
| Como o cliente se organiza? | Parcial: bootstrapper, preload, framework e referências a módulos. |
| Quais fronteiras de privilégio aparecem? | Parcial: splash e fuses; janela principal e execução não analisadas. |
| Como funciona a mídia real? | Não demonstrado pelo artefato disponível; contexto histórico oficial separado. |
| O que podemos reutilizar? | Recomendações de engenharia e bibliotecas com licença própria verificada; nenhum código/asset do cliente. |
| O Harmony está homologado para Windows por esta análise? | Não. Exige os testes reais do roadmap. |

O comando de extração DMG do REA retornou `unsupported_target`; a materialização dos arquivos necessários usou montagem nativa somente para leitura. A análise JavaScript operou sobre o ASAR copiado com hash registrado. A sessão REA foi fechada e o volume desmontado ao terminar. Nenhuma configuração do Codex ou engine foi alterada.
