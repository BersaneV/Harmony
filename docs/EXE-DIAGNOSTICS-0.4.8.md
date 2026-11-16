# Diagnósticos da captura e entrega nativa 0.4.8

Os diagnósticos foram executados e preservam os resultados negativos. **Não aprovam 1080p60 ou 1440p60 por 180 segundos com oito participantes.** A capacidade continua com os resultados do [ensaio longo 0.4.8](EXE-WAN-0.4.8.md). Este documento distingue execução completa do diagnóstico e aprovação da qualidade.

A [projeção numérica](evidence/native-diagnostics-0.4.8-20261116.json) contém os contadores, tempos, hashes dos logs integrais e URLs dos runs. Não contém contas, credenciais, endereços de rede, títulos de janelas ou pixels. Os logs foram obtidos pela API de cada job, sem o rollup truncado do run.

## Núcleo WGC isolado

A fonte é uma janela gerada com resolução física integral. Cada run usa uma captura, um Vec e o mesmo perfil de 60 FPS, em controle–instrumentação–controle, com 5 s de acomodação e 10 s medidos por fase. A feature capture-diagnostics começa desligada em builds normais. Os controles usam o mesmo binário experimental com a coleta desligada. Não há SharedBuffer, JavaScript, encoder, receptores ou carga de oito chamadas neste ensaio.

| Resolução | Controle anterior bruto / distinto | Instrumentado bruto / distinto | Controle posterior bruto / distinto |
|---|---:|---:|---:|
| 1080p | 57,54 / 56,04 | 58,08 / 56,38 | 57,99 / 55,89 |
| 1440p | 57,49 / 54,89 | 56,86 / 54,46 | 56,70 / 54,20 |

Na fase instrumentada, o tempo interno por frame foi 3,796 ms em 1080p e 5,772 ms em 1440p. Map ocupou respectivamente 3,224 e 4,869 ms; a cópia de linhas, 0,441 e 0,712 ms. Map inclui sincronização e espera/scheduling; esses valores não são tempo exclusivo da GPU. Não houve fila crescente de frames, erros de captura ou resize. Os polls vazios incluem a espera necessária por um novo quadro; seu tempo não é integralmente recuperável.

SystemRelativeTime não demonstrou identidade única de conteúdo: houve timestamps repetidos com marcador alterado e timestamps avançados com o mesmo marcador. O marcador também tem limite e wrap; nenhum timestamp foi usado para inventar FPS distinto.

Runs: [1080p](https://github.com/BersaneV/Harmony/actions/runs/43907878936) e [1440p](https://github.com/BersaneV/Harmony/actions/runs/43907845168), fonte 4eec7e165092fba78dcf5df6bc0384daf7bbac93. As VMs informaram 4 processadores lógicos e Microsoft Hyper-V Video; o texto do modelo da CPU não representa a quantidade de núcleos físicos dedicada ao job.

## Espera por sinal de frame

A feature capture-frame-ready-experiment também começa desligada e não foi promovida ao produto. O teste compara poll–evento–evento–poll na mesma captura, com 5 s de acomodação e 10 s medidos por fase. As quatro fases de evento exerceram espera de kernel positiva, com argumento máximo de 1 ms, sem fallback ou erro, inclusive na acomodação. O tempo real de espera pode exceder o argumento por scheduling.

| Resolução | Poll A bruto / distinto | Evento B bruto / distinto | Evento B bruto / distinto | Poll A bruto / distinto |
|---|---:|---:|---:|---:|
| 1080p | 57,613 / 55,716 | 59,611 / 55,417 | 59,371 / 56,072 | 58,290 / 55,691 |
| 1440p | 56,653 / 54,555 | 58,995 / 53,695 | 59,100 / 54,400 | 56,799 / 53,899 |

Houve aumento de FPS bruto e mais marcadores iguais. As médias ponderadas de FPS distinto foram 55,703→55,745 em 1080p e 54,227→54,047 em 1440p. **Não há ganho distinto consistente que justifique ativar essa espera no produto.** O run 1440p reprovou a qualidade, embora o experimento tenha sido exercitado corretamente. Os testes específicos de posse do evento, fechamento, cancelamento e não consumo do sinal também foram executados no Windows. Utilização de CPU não foi medida neste experimento.

Runs: [1080p](https://github.com/BersaneV/Harmony/actions/runs/43920465047) e [1440p](https://github.com/BersaneV/Harmony/actions/runs/43920437970), fonte 562624d8cb7590b55b59e5ed83b5a987585f1506. São ensaios do núcleo, sem ponte WebView ou chamada de oito participantes.

## Entrega JavaScript sob carga de oito EXEs

Aqui o executável é o pacote público 0.4.8, com main SHA-256 96c9790236c38a18c759e2fac151b92257aaa6b487db9359d4ef79d8bd083f5b. Foram oito VMs Windows descartáveis, um emissor de tela, sete receptores e oito microfones gerados, com 56 relações direcionadas de voz, contadas como 56 entradas e 56 saídas no agregado dos clientes. Os recibos de carga foram conferidos antes e depois de cada fase. Houve 30 s de acomodação da carga e três janelas de cerca de 10 s: controle–instrumentação–controle. Esses intervalos curtos não substituem o gate de capacidade de 180 s.

| Perfil | Fonte distinta, controle anterior / instrumentação / controle posterior | Construção BGRX, média | writer.write até conclusão, média | ACK, médias das três fases |
|---|---:|---:|---:|---:|
| 1080p60 | 54,298 / 54,398 / 55,194 FPS | 0,677 ms | 0,080 ms | 2,52–2,73 ms |
| 1440p60 | 47,094 / 49,495 / 46,899 FPS | 0,982 ms | 0,103 ms | 3,31–3,57 ms |

Os hooks observaram 573 escritas em 1080p e 538 em 1440p, sem escritas pendentes ou erros ao terminar; os métodos originais foram restaurados. Nos trechos medidos, o encoder conservou resolução integral, VP8/detail e qualidade reportada como none. A CPU de toda a VM ficou em 56,4–58,0% em 1080p e 71,9–74,8% em 1440p, com 4 processadores lógicos. Essa CPU inclui Windows, fixture, app e observação; não é utilização exclusiva do encoder.

O tempo baixo de escrita não demonstra bloqueio dominante no writer. Os dados ainda não isolam fila da interface, cópia Shared ou Map sob essa carga, nem provam causa exclusiva da perda de FPS. 1440p reprovou a qualidade da fonte nas três fases. 1080p passou nas três fases curtas, sem modificar o FAIL do ensaio longo em outra VM.

A primeira tentativa [1440p](https://github.com/BersaneV/Harmony/actions/runs/43915332594) foi interrompida por ERR_ASSERTION em capture.snapshot depois do controle inicial; a instrumentação ficou NOT_RUN. Os logs completos não comprovam a causa HTTP dessa falha, que permanece não determinada. O controle inicial mediu 38,899 FPS brutos e 38,499 distintos e continua FAIL; apenas a instrumentação não foi executada. A primeira [1080p](https://github.com/BersaneV/Harmony/actions/runs/43915359327) falhou no prepare com 429, antes dos oito EXEs. Ambas permanecem registradas.

O harness foi corrigido para repetir somente respostas 429 explícitas, com corpo/nonce estáveis, leitura HTTP coalescida e inspeção local de mídia durante a espera. O prepare é executado uma única vez após 60 s de cooldown. Não foram aumentadas cotas nem alterados backend, autenticação, quóruns ou gates. A repetição completou os oito clientes nos dois perfis: 17 respostas 429 em 1080p e 2 em 1440p foram recuperadas; nenhum limite foi esgotado. Houve 579 amostras em 1080p e 557 em 1440p, preservadas integralmente.

Runs completos: [1080p](https://github.com/BersaneV/Harmony/actions/runs/43922244094) e [1440p](https://github.com/BersaneV/Harmony/actions/runs/43920913009), QA 1179f3f383b9e05240b5b78dae7f1f3cafc53326. A recuperação de cota permite medir a mídia; não transforma execução completa em aprovação de FPS.

## Próxima candidata e limites

A candidata 0.4.9 está em implementação para reunir cópia e publicação numa única callback da interface, removendo uma passagem worker→interface e o relógio independente de publicação. Uma captura nominal continua limitando a cadência; confirmação de envio e ACK continuam limitando a reutilização de memória. O efeito sobre a fluidez ainda exige o pacote Windows assinado e os ensaios longos.

Os dados acima não comparam versões na mesma VM, não comprovam desempenho de GPUs físicas, jogos, oito provedores residenciais ou percepção auditiva humana. Não houve contratação ou recurso pago. O feed automático continua 0.4.2 e o backend/Web externo continua 0.4.3. Os hashes e resultados originais dos ensaios longos 0.4.8 foram preservados.
