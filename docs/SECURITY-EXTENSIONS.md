# Revisão das extensões: atualização, mídia e aparência

Revisão independente realizada em 12/11/2026 sobre os novos componentes do Harmony. Os resultados abaixo distinguem execução real, teste com substitutos controlados e inspeção de código. Não equivalem à homologação do aplicativo instalado no Windows nem à validação de um servidor público.

## Atualização assinada

O fluxo nativo fixa o canal de atualização e a URL do repositório pessoal, exige HTTPS inclusive nos redirecionamentos, rejeita versões iguais/anteriores e recebe apenas comandos sem URLs ou bytes fornecidos pelo renderer. Os bytes permanecem no estado nativo e só podem chegar à instalação depois da verificação. Operações concorrentes usam exclusão mútua e o cancelamento não mantém um pacote parcialmente baixado como instalável.

O plugin Tauri 2.13.3 é usado com `requireSignedVersion=true` e `allowDowngrades=false`. A versão anunciada pelo feed deve coincidir com a versão no comentário autenticado da assinatura. Isso impede reapresentar um pacote antigo assinado sob um número de versão novo. A verificação é executada pelo código original do plugin e por `minisign-verify 0.3.0`, sem uma segunda implementação de criptografia. A [documentação oficial do atualizador](https://v2.tauri.app/plugin/updater/) descreve a assinatura obrigatória e a chave pública embutida; o [código da versão usada](https://github.com/tauri-apps/plugins-workspace/tree/6bbd44d4ef254d835a12c6d7bdf2a8a61778031a/plugins/updater) é a referência para a vinculação de versão.

**Falha encontrada e corrigida:** cancelar externamente no callback de progresso não limitava o buffer do plugin. No teste inicial, um corpo pronto de 2 MiB foi consumido inteiro apesar do limite de 64 KiB, com e sem Content-Length. A checagem final bloqueava a instalação, mas não resolvia o consumo de memória.

A extensão local `download_with_limit` passou a rejeitar Content-Length excessivo antes de ler o corpo e a conferir cada chunk antes de acrescentá-lo ao buffer. Ela também cede a execução entre chunks para permitir cancelamento. O diff altera somente dois arquivos do pacote original; as rotinas de assinatura e versão permanecem intactas. Origem, licença e diff estão em [HARMONY-PATCH.md](../vendor/tauri-plugin-updater/HARMONY-PATCH.md). O coordenador revisou independentemente esse diff e integrou a API limitada ao aplicativo; o autor do patch não foi seu único revisor.

O harness [tools/updater-check](../tools/updater-check/README.md) executou **16 critérios com PASS** usando MockRuntime oficial, servidor HTTP de loopback, chaves descartáveis e payload inofensivo:

| Grupo | Evidência executada |
| --- | --- |
| Criptografia | Assinatura correta aceita; bytes alterados/truncados, chave errada, base64 inválido, bit alterado e comentário adulterado rejeitados |
| Versão | Relabel de 0.2.0 para 0.3.0 e assinatura sem versão rejeitados; downgrade e mesma versão não oferecidos |
| Recursos | Corpo acima do teto rejeitado com/sem Content-Length; tamanho exatamente no limite aceito; excesso de um byte rejeitado; cancelamento interrompe stream disponível |

Na execução após a correção, o limite de 65.536 bytes reteve zero bytes quando o tamanho excessivo era anunciado e 65.405 bytes quando não era; cancelamento interrompeu outro corpo de 2 MiB após 8.036 bytes. Esses valores por chunk variam conforme o transporte; os critérios são não exceder o limite de bytes acumulados e não consumir o corpo inteiro após cancelar. O teto não representa o RSS exato do processo, que inclui TLS, runtime e alocações internas.

Evidências locais preservadas: `.local/qa-updater/before-hard-cap.json` registra os dois FAIL originais; `after-hard-cap.json` registra a matriz corrigida. Nenhum instalador foi executado pelo harness. Verificar uma assinatura de atualização não produz uma assinatura Authenticode, não elimina possíveis avisos do SmartScreen e não comprova instalação/rollback no Windows.

## Processamento de mídia

A inspeção de `crates/media-worker` e das rotas de derivados confirmou chaves de objeto geradas pelo servidor, tentativas identificadas por UUID, bloqueio da publicação por tentativa vigente, reservas de cota e registro das chaves antes de PUT. O download do original exige tamanho consistente e limita bytes, os comandos não usam shell nem URL fornecida pelo cliente e limpam o ambiente. A publicação e a coleta de objetos compartilham os bloqueios de banco relevantes. Os derivados só são consultados com acesso ao canal; antes de anexar a uma mensagem, somente o dono acessa; mensagens removidas impedem nova emissão de URL.

O subprocesso tem whitelist de demuxers/protocolo, limites de tempo, bytes de saída, pixels e recursos. A necessidade de restringir explicitamente protocolos está documentada pelo [FFmpeg](https://ffmpeg.org/ffmpeg-protocols.html); uma whitelist de `file` sozinha não substitui o isolamento do sistema operacional. O worker falha quando não pode aplicar o sandbox. O mecanismo Linux depende de Landlock ABI 3 e seccomp; a [documentação do kernel](https://www.kernel.org/doc/html/v6.10/userspace-api/landlock.html) descreve a dependência de ABI.

[scripts/test_worker_sandbox.py](../scripts/test_worker_sandbox.py) chama o entrypoint real `--check-sandbox` com programas C inofensivos compilados para o teste, configuração fictícia e nenhum acesso a PostgreSQL/S3. A execução final no macOS, após o hardening do subprocesso, passou nos **seis critérios**: leitura/escrita somente no diretório permitido e remoção de credenciais do ambiente; limite de stdout; limite de stderr; interrupção por tempo; interrupção por memória; nenhuma conexão recebida pelo listener TCP externo ao sandbox. O canário de memória alocou/tocou 200 MiB diante do teto de 128 MiB e foi interrompido por `parser_memory_limit` antes do timeout. O teste registra SHA do binário e plataforma em `.local/qa-worker-sandbox/result.json`. Isso não comprova o mecanismo Landlock/seccomp do Linux, que é distinto.

Os E2Es de fila/FFmpeg/PG/S3 são executados pelo implementador e documentados separadamente. A revisão estática e o teste com substitutos não comprovam decodificação de todos os formatos, isolamento Linux em runtime, capacidade sob carga ou execução segura de todo arquivo malformado possível. URLs S3 já emitidas continuam utilizáveis até expirar (60 s); revogar uma permissão impede novas URLs, mas não recolhe bytes já entregues ao cliente.

## Personalização e arquivos locais

O importador reconstrói o tema com campos permitidos e rejeita propriedades desconhecidas, valores inválidos e JSON acima de 16 KiB. Não aceita CSS, scripts ou URLs. Os blobs são separados por origem normalizada, usuário e identificador; a leitura inclui tipo de asset. A cota de 40 MiB/16 arquivos é calculada na mesma transação de escrita do IndexedDB, evitando ultrapassá-la com importações simultâneas. A [documentação de transações IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction) fundamenta essa fronteira atômica.

Imagens ficam restritas a PNG/JPEG/WebP estático, com limites antes do decoder e comparação das dimensões decodificadas. WebP confere o canvas e o bitstream, rejeitando animação e discrepância entre cabeçalhos. Fontes têm tamanho/formato limitado e usam `FontFace` com ArrayBuffer; nunca CSS remoto ou uma URL importada. A [API FontFace](https://developer.mozilla.org/en-US/docs/Web/API/FontFace) oferece essa entrada binária. Object URLs são criadas internamente e revogadas na troca do tema.

Os quatro testes independentes em [tools/theme-review.test.ts](../tools/theme-review.test.ts) passaram: seis importações simultâneas de 8 MiB aceitam somente cinco; logout durante decode pendente impede aplicação tardia; troca de conta impede o asset antigo de aparecer na nova; desativar o fundo revoga o blob e limpa o CSS. Esses testes importam o código de produção, mas usam IndexedDB e decoder controlados. Não substituem a validação do decoder, fonte e persistência no aplicativo real.

Os arquivos locais não são enviados ao servidor nem incluídos no JSON de tema; limpar dados ou sofrer evicção do armazenamento pode removê-los. A aplicação oferece fallback e aviso, sem tratar a cota local como backup. Esse limite acompanha o comportamento de [quota e evicção do navegador](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

## Execução reproduzível e limites

```sh
cargo build --locked --manifest-path tools/updater-check/Cargo.toml
python3 tools/updater-check/test_updater.py --output .local/qa-updater/result.json
node node_modules/vitest/vitest.mjs run tools/theme-review.test.ts
python3 scripts/test_worker_sandbox.py --output .local/qa-worker-sandbox/result.json
```

Repetir os testes afetados se os arquivos ou a versão do plugin mudarem. A publicação e a verificação do instalador real, a execução de sandbox Linux/containers e a homologação do instalador Windows têm evidências próprias; não recebem PASS por esta matriz local.

O script [test_windows_install.ps1](../scripts/test_windows_install.ps1) foi preparado para o runner Windows descartável do repositório: instala o artefato recém-compilado em diretório temporário exclusivo, confere `ProductVersion` do setup e do executável, a presença do desinstalador, ausência de processo do aplicativo e remoção do executável/registro de desinstalação. Usa `/S /D=...` e `/S _?=...` conforme a [documentação NSIS](https://nsis.sourceforge.io/Docs/Chapter3.html). `_?=` permite aguardar a remoção real, mas o próprio desinstalador pode permanecer até a limpeza do diretório de teste; essa limpeza só ocorre depois das asserções. O template oficial Tauri só abre o aplicativo silenciosamente com `/R`, que o script não envia. Sua execução depende do job Windows e permanece sem PASS até esse resultado; não comprova substituição por updater, UI, voz, captura ou dispositivos.
