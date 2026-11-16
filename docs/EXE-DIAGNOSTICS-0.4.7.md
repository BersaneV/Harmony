# Diagnósticos de captura: pacing do núcleo e contentHint no EXE 0.4.7

**Ambos os ensaios são DIAGNOSTIC, com `capacity_approval=false`.** Não aprovam desempenho da versão 0.4.8, chamadas com oito participantes ou o gate de 180 segundos.

Os ensaios observam camadas diferentes e foram executados em runs e VMs separados. O primeiro mede o núcleo nativo sem IPC ou codificação. O segundo mede o EXE público 0.4.7 com um publicador e microfone gerado, sem receptores. Seus FPS não devem ser subtraídos para atribuir o custo de uma camada.

| Ensaio           | Escopo medido                                                            | Fases por perfil                                                                           | O que fica fora                                                          |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Pacing do núcleo | Executável `pacing_probe.exe`, captura real, buffer de pixels e cadência | A1–B1–B2–A2; 5 s de acomodação e 10 s medidos por fase                                     | Harmony EXE, IPC/SharedBuffer, JavaScript, encoder, receptores e chamada |
| contentHint      | EXE 0.4.7, mesma fonte WGC e envio SDK VP8 durante cada run              | A1 motion → B detail → A2 motion; pelo menos 30 s de estabilização e 60 s medidos por fase | Recepção, capacidade com oito pessoas e gate de 180 s                    |

## Pacing: agenda de captura no núcleo

Uma VM Windows 2022 por perfil executou A–B–B–A mantendo o mesmo objeto de captura, janela autorizada, buffer de pixels, perfil de 60 FPS e FramePacer. A usa início real da captura mais o período T; B usa prazo nominal. O piso de espera positiva da cadência foi de 500 µs nos dois braços. T corresponde a aproximadamente 16,667 ms.

A tabela apresenta a média aritmética dos FPS das duas fases de cada política. Os contadores de intervalos e polls são somas dessas duas fases; não são médias nem métricas de rede.

| Perfil  | Agenda              | Brutos/s, média | Distintos/s, média | Intervalos < T | Polls vazios | Resultado das duas fases curtas |
| ------- | ------------------- | --------------: | -----------------: | -------------: | -----------: | ------------------------------- |
| 1080p60 | A — início real + T |         55,2355 |            54,3865 |              0 |          594 | 2 PASS / 0 FAIL                 |
| 1080p60 | B — prazo nominal   |         58,4208 |            56,6718 |            732 |         3830 | 2 PASS / 0 FAIL                 |
| 1440p60 | A — início real + T |         52,6473 |            49,1975 |              0 |          914 | 0 PASS / 2 FAIL                 |
| 1440p60 | B — prazo nominal   |         55,6809 |            51,5823 |            654 |         2415 | 0 PASS / 2 FAIL                 |

Intervalos < T são intervalos entre os inícios de capturas que retornaram quadro. Polls vazios são chamadas de captura sem quadro disponível. O nominal apresentou mínimos de 3,0711 ms em 1080p e 6,5959 ms em 1440p; os controles A não tiveram intervalos abaixo de T. Isso descreve a cadência local, não jitter ou regularidade de quadros recebidos.

As quatro fases de 1080p passaram somente o gate curto do núcleo: geometria completa, conteúdo colorido e pelo menos 54 quadros brutos e distintos por segundo. As quatro de 1440p falharam porque o marcador distinto ficou abaixo de 54 FPS. Esses resultados de 10 s não aprovam 60 FPS sustentados no aplicativo. O nominal teve mais polls vazios; em 1440p, as medianas de tempo de captura foram maiores. Quantis, caudas, dimensões e todos os FAIL permanecem no agregado.

Evidências: [agregado do pacing](evidence/diagnostics-0.4.7/pacing/aggregate.json), [manifesto e hashes](evidence/diagnostics-0.4.7/pacing/manifest.json) e [figura das oito fases](evidence/diagnostics-0.4.7/pacing/native-pacing-20261116.png).

## contentHint: fonte, SDK e encoder no EXE

Cada perfil usou uma VM, o mesmo EXE público 0.4.7 e a mesma captura WGC durante A1–B–A2. A única alteração experimental foi `track.contentHint`: motion → detail → motion, com restauração obrigatória antes do teardown. Foram preservados VP8, um encoding ativo, resolução completa, 60 FPS solicitados, teto de 8 Mb/s em 1080p ou 16 Mb/s em 1440p, maintain-resolution e a proteção de CPU do WebRTC.

Cada run contém 96 amostras únicas de fases: 11 de estabilização e 21 de medição por fase. As linhas ao vivo do log correspondem às amostras do JSON final; o resultado final do log também coincide com o JSON. As três amostras iniciais de produção de cada run ficam fora dessas 96. As seis estabilizações cobrem pelo menos 30 s observados e as seis medições pelo menos 60 s.

| Perfil  | Fase / hint | Fonte bruta FPS | Marcador distinto FPS | Media-source SDK FPS | Encoder FPS |
| ------- | ----------- | --------------: | --------------------: | -------------------: | ----------: |
| 1080p60 | A1 — motion |         55,1291 |               51,8559 |              55,1457 |     55,1457 |
| 1080p60 | B — detail  |         55,2988 |               52,2922 |              55,2988 |     55,3154 |
| 1080p60 | A2 — motion |         55,1497 |               51,6935 |              55,1497 |     55,1664 |
| 1440p60 | A1 — motion |         46,6582 |               43,8189 |              39,5183 |     39,4519 |
| 1440p60 | B — detail  |         49,5645 |               46,1274 |              49,5812 |     49,5812 |
| 1440p60 | A2 — motion |         48,5161 |               44,7790 |              29,9966 |     30,0132 |

Fonte bruta conta quadros entregues ao observador da track nativa, após o generator; no ensaio de pacing, a contagem ocorre no núcleo, antes do IPC. Marcador distinto conta avanços do marcador da fixture, não FPS recebido nem qualidade visual. Media-source usa o contador do SDK/WebRTC; encoder usa `framesEncoded`. Cada taxa divide seu próprio delta pelo intervalo observado da janela correspondente.

| Perfil  | Fase / hint | Tempo reportado por quadro (ms) | CPU da VM | Amostras com reason=cpu |
| ------- | ----------- | ------------------------------: | --------: | ----------------------: |
| 1080p60 | A1 — motion |                          9,1913 |    49,56% |                    0/21 |
| 1080p60 | B — detail  |                          6,5508 |    42,91% |                    0/21 |
| 1080p60 | A2 — motion |                          9,5343 |    52,12% |                    0/21 |
| 1440p60 | A1 — motion |                         18,6578 |    79,29% |                    8/21 |
| 1440p60 | B — detail  |                         12,1340 |    72,91% |                    0/21 |
| 1440p60 | A2 — motion |                         20,9945 |    74,77% |                   21/21 |

Tempo por quadro é ΔtotalEncodeTime × 1000 / ΔframesEncoded, conforme os contadores reportados. CPU da VM abrange fixture, aplicativo, observação e codificação nos quatro processadores lógicos; não é CPU isolada do encoder. A última coluna conta amostras com `qualityLimitationReason=cpu`, não quadros perdidos nem segundos. As durações acumuladas de limitação permanecem no JSON. Em 1080p, reason=none ocorreu nas 21 amostras de cada fase.

Em B_detail, `content_type=screenshare` foi reportado nas 21/21 amostras de medição dos dois perfis. Nos controles motion, esse campo ficou ausente; a ausência não recebe um valor inferido. Os quadros codificados mantiveram 1920×1080 ou 2560×1440 nas amostras. O marcador distinto ficou abaixo de 54 FPS nas seis fases do EXE.

### Resets e limites da comparação

Identidade estável não significa acumuladores contínuos. Em cada run, as transições A1→B e B→A2, nas posições 32→33 e 64→65 do inventário de 96 amostras, reiniciaram acumuladores do encoder, da media-source e das durações de limitação. Os contadores nativos brutos e distintos seguiram contínuos. Os valores antes/depois estão no agregado.

Também há um timestamp RTP repetido em cada passagem de estabilização para medição: posições 11→12, 43→44 e 75→76 por run, apesar do avanço do relógio da página. Nenhuma dessas adjacências é interpolada ou usada para unir deltas. Os resumos originais usam somente as janelas internas após a estabilização, sem fronteira de reset observada dentro das seis medições.

Os controles motion de 1440p diferem bastante: 39,4519 FPS do encoder em A1 e 30,0132 em A2. A ordem motion→detail→motion não foi contrabalançada; os dados não estabelecem efeito universal. Os resultados não demonstram GPU mais rápida, número de threads ou denoising efetivamente ativado. A indicação de CPU preserva o que o WebRTC reportou nessa execução, sem atribuir causa a uma rotina específica.

O hint motion foi restaurado ao terminar o experimento e novamente antes dos cliques de parar a tela e sair da chamada. Os flags de restauração, os quatro últimos comandos `Runtime.evaluate` concluídos e a ordem do runner revisado corroboram essa sequência. A projeção pública omite identidades de fontes, usuários, sessões e rede, mantendo hashes e posições para conferência.

Evidências: [agregado e inventário das 192 amostras](evidence/diagnostics-0.4.7/hints/aggregate.json), [manifesto de proveniência](evidence/diagnostics-0.4.7/hints/manifest.json) e [figura de FPS e tempo por quadro](evidence/diagnostics-0.4.7/figures/content-hint-0.4.7-20261116.png).

## Proveniência e testes da 0.4.8

| Ensaio             | Perfil  | Run público                                                                     |
| ------------------ | ------- | ------------------------------------------------------------------------------- |
| Pacing do núcleo   | 1080p60 | [Run 43881735754](https://github.com/BersaneV/Harmony/actions/runs/43881735754) |
| Pacing do núcleo   | 1440p60 | [Run 43881746754](https://github.com/BersaneV/Harmony/actions/runs/43881746754) |
| contentHint no EXE | 1080p60 | [Run 43886682915](https://github.com/BersaneV/Harmony/actions/runs/43886682915) |
| contentHint no EXE | 1440p60 | [Run 43884983772](https://github.com/BersaneV/Harmony/actions/runs/43884983772) |

Os manifestos identificam os originais e projeções por SHA-256. Os dois runs de hints partiram de commits QA diferentes, mas usaram o mesmo código do diagnóstico e o mesmo hash do EXE 0.4.7. Os números estão arredondados apenas nas tabelas; os agregados preservam os valores originais e as fronteiras entre fases.

Estes diagnósticos não medem FPS remoto, freezes de recepção ou MOS e não executam a chamada de oito participantes por 180 s. Nenhum PASS curto do núcleo é convertido em aprovação do aplicativo.

A versão 0.4.8 tem pacote público com CI, instalação/remoção, assinatura do updater e download público verificados na [prova do pacote](evidence/package-0.4.8-public-proof.json). Esses controles de empacotamento não medem desempenho. A campanha Windows com oito EXEs da 0.4.8 está em execução; os gates de resolução, FPS, estabilidade e voz permanecem os já existentes, sem relaxamento por estes diagnósticos.

Os agregados, drafts e PNGs de origem são preservados byte a byte para conferência dos hashes. O manifesto público de hints atualiza somente metadados de publicação e revisão, sem alterar inputs, outputs ou valores; registra o SHA-256 do manifesto de preparação original. Os avisos históricos dos drafts permanecem intactos.
