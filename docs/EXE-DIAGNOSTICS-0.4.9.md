# Diagnósticos de captura e scheduler — Harmony 0.4.9

As quatro rodadas abaixo usaram o mesmo EXE público 0.4.9, com oito instâncias Windows, microfones gerados e o perfil de tela 2560 × 1440 a 60 FPS e 16 Mbit/s. O objetivo foi observar a fonte e os contadores do publicador durante controles e uma fase com WPR. **O resultado é diagnóstico inconclusivo; não há aprovação de capacidade.**

As janelas nominais de 10 segundos no R3 e de 2 segundos no R4 não substituem as [campanhas normais de qualidade de 180 segundos](EXE-WAN-0.4.9.md). O gate de fonte de 54 FPS permaneceu igual e falhou nas seis janelas observadas.

| Rodada                                                             | Workflow e coleta                           | Quorum confirmado                                  | Fases do publicador                               | Resultado do trace                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [R1](https://github.com/BersaneV/Harmony/actions/runs/43964251679) | FAIL; oito relatórios FAILED                | Voz: 8                                             | Nenhuma                                           | Bootstrap interrompido em `MESH_SCREEN_ACTIVE`; receptores terminaram em `READY_TIMEOUT`. |
| [R2](https://github.com/BersaneV/Harmony/actions/runs/43965746529) | FAIL; oito relatórios FAILED                | Voz e tela: 8                                      | Nenhuma                                           | `PS_NOT_VERIFIED` / `window_not_unique`; cleanup do companion falhou.                     |
| [R3](https://github.com/BersaneV/Harmony/actions/runs/43968985788) | SUCCESS na coleta; oito relatórios COMPLETE | Voz e tela: 8; início e fim de cada fase completos | 3 × 10 s nominais                                 | `NOT_VERIFIED` / `xml_size_bound`; nenhum tempo de scheduler validado.                    |
| [R4](https://github.com/BersaneV/Harmony/actions/runs/43972722303) | FAIL; oito relatórios FAILED                | Voz e tela: 8; início e fim de cada fase completos | 3 × 2 s nominais, observadas antes da falha final | `DEADLINE` e `COMPANION_CLEANUP` no fechamento; resposta final do trace ausente.          |

Em R3 e R4, os recibos agregados de início e fim de cada fase confirmam oito clientes, 56 envios e 56 recepções de voz, um publicador SFU e sete receptores de tela. Os envios e recepções representam as duas observações dos mesmos 56 fluxos direcionados. Esse quorum confirma a carga naquele diagnóstico e não mede a qualidade perceptiva da voz.

A fonte bruta conta quadros no processor do publicador. A contagem distinta usa mudanças no marcador da janela. O FPS informado pelo produtor Rust, os quadros da media-source do SDK e os quadros codificados são métricas separadas; o JSON conserva suas janelas e deltas.

| Rodada / fase        | Janela nominal | Janela observada da fonte | Fonte bruta (FPS) | Fonte distinta (FPS) | Gate 54 FPS |
| -------------------- | -------------: | ------------------------: | ----------------: | -------------------: | ----------- |
| R3 — controle antes  |           10 s |                 10,0212 s |            46,202 |               43,208 | FAIL        |
| R3 — instrumentada   |           10 s |                 10,0279 s |            45,772 |               42,681 | FAIL        |
| R3 — controle depois |           10 s |                 10,0289 s |            45,867 |               43,574 | FAIL        |
| R4 — controle antes  |            2 s |                  2,0343 s |            29,986 |               29,986 | FAIL        |
| R4 — instrumentada   |            2 s |                  2,0462 s |            30,300 |               30,300 | FAIL        |
| R4 — controle depois |            2 s |                  2,0372 s |            30,434 |               30,434 | FAIL        |

As janelas de referência do companion, medidas por QPC, também estão no JSON, separadas da janela observada pela fonte. As três janelas R3 duraram aproximadamente 10,09 / 10,07 / 10,06 segundos no companion; no R4, 2,11 / 2,09 / 2,08 segundos. O harness posiciona startup e flush do WPR fora dessa janela de referência e solicita a decodificação após o último controle; o resultado dessa etapa permanece NOT_VERIFIED nas duas rodadas.

| R3 / fase       | CPU — captura (ms) | CPU — UI (ms) | Encode médio (ms/quadro) |
| --------------- | -----------------: | ------------: | -----------------------: |
| controle antes  |            562,500 |       609,375 |                    13,26 |
| instrumentada   |            656,250 |       750,000 |                    13,11 |
| controle depois |            687,500 |       671,875 |                    12,73 |

O encode médio em milissegundos usa 1000 × ΔtotalEncodeTime / ΔframesEncoded do SDK. Os contadores CPU das duas APIs concordam nos endpoints observados e têm seus próprios intervalos de consulta; não se somam ao tempo de encode. São deltas de CPU por papel, com granularidade grosseira; não representam espera, uso total da VM ou atribuição exclusiva ao encoder. No R3, os metadados de FPS do produtor nativo variaram de 44,33 a 47,41. O WebRTC reportou `quality_limitation_reason=none` nas amostras das fases; isso não prova ausência de gargalo de CPU.

No R3, o guard de XML rejeita tamanho não positivo ou acima de 256 MiB. O código `xml_size_bound` foi reportado, mas o tamanho real é UNKNOWN, pois essa rodada não o exportou. O `tracerpt` terminou com código 0, o que não comprova que o XML tenha sido validado. Os campos zerados de eventos e espera são valores inicializados, não observações. O status do WPR reportou Dropped event 0; perdas de eventos e buffers permanecem UNKNOWN e não equivalem a perda zero.

No R4, os números das três janelas e os respectivos quorums foram registrados antes do fechamento falhar. Sem resposta final do companion, tamanho dos arquivos, decodificação, etapa nativa responsável e conclusão do cleanup não foram verificados. O trace é inutilizável para atribuir uma causa.

As rodadas são execuções distintas. A diferença de FPS entre R3 e R4 não isola o efeito de encurtar o probe. Esses registros não estabelecem causa exclusiva de scheduler, CPU, GPU ou rede física e não aprovam FPS remoto, freezes de recepção ou MOS.

A [evidência desidentificada](evidence/exe-diagnostics-0.4.9-20261116.json) contém os números exatos, IDs públicos dos runs e jobs, hash do EXE público e hashes agregados das logs/proveniências. Foram conferidas 32 logs e 32 relatórios. As fases de R3 e R4 contêm, respectivamente, 441 e 358 registros únicos de amostras, incluindo 15 e 6 do publicador. Modelos de CPU, identificadores de processo/thread, endereços, caminhos e identidades de contas não fazem parte desta projeção.
