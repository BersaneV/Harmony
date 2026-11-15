# Harmony 0.4.2 — resolução manual e teste de oito EXEs

Estado desta candidata: **validação final Windows/WAN NOT_RUN**. Este registro será completado com o pacote e a execução medidos; build e diagnóstico controlado não aprovam capacidade.

## Alteração e reprodução

O perfil de movimento usava `maintain-framerate` mesmo com resolução manual. Essa preferência permite ao WebRTC reduzir a resolução durante a adaptação. A 0.4.2 usa `maintain-resolution` quando o usuário escolhe uma resolução, preservando `contentHint=motion`, teto de FPS, bitrate e escala independente de cada espectador. Movimento com resolução automática conserva a política anterior. O helper é compartilhado pelos transportes P2P e LiveKit. [Semântica das preferências](https://w3c.github.io/mst-content-hint/#degradation-preference-when-encoding).

Dois testes de regressão falharam antes da mudança e passaram depois. A suíte cliente tem 116 testes aprovados, incluindo autorização, fontes e negociação. A alteração não desliga proteção de CPU, não injeta SDP e não promete manter simultaneamente FPS, resolução e detalhe quando faltam recursos.

O [resultado anterior 0.4.1](EXE-WAN-VALIDATION.md) permanece FAIL: P5 terminou em 180p e teve seis congelamentos, somando 3,478 s. A [repetição instrumentada sem mudar o produto](https://github.com/BersaneV/Harmony/actions/runs/43681608708), fonte `46997d00116d4c769fa30a7ff5e6873a2b271a19`, passou: todos os espectadores em 720p/29,027–29,042 FPS, zero congelamentos na fase sustentada, RTT p95 66 ms. Esse PASS demonstra intermitência, não eficácia da correção. O gatilho exato da ocorrência histórica não foi isolado, pois sua coleta não continha o motivo de limitação do encoder.

## Comparação controlada, separada da aprovação de capacidade

A [execução 43683509958](https://github.com/BersaneV/Harmony/actions/runs/43683509958), fonte `0c5f55cdf3ca97f8533b6ce8f115f5a6b4045e61`, usou oito EXEs 0.4.1 em VMs distintas para comparar as duas preferências na **mesma conexão P5**, fonte nativa, codec OpenH264 e conteúdo de movimento. Cada etapa começou após cinco observações consecutivas de saída em 1280×720 e pelo menos 24 FPS. Somente essa conexão recebeu um teto artificial de 50 kb/s por aproximadamente 30 s, restaurado para 4 Mb/s; o teto de 30 FPS e o conteúdo foram mantidos. É uma intervenção diagnóstica explícita nas APIs nativas, não comportamento injetado na prova final do produto.

| Medida na etapa observada | Política anterior | Prioridade de resolução |
|---|---:|---:|
| Resoluções recebidas | 720p, 540p, 360p, 270p | Somente 720p |
| Congelamentos durante toda a etapa, incluindo o cap artificial | 3 / 1,171 s | 3 / 0,827 s |
| Após 30 s de recuperação, resolução | Somente 720p | Somente 720p |
| Após 30 s de recuperação, FPS exibidos médios | 29,226 | 29,246 |
| Novos congelamentos na janela de recuperação | 0 | 0 |

O encoder anterior indicou `bandwidth` quando seu orçamento foi limitado e reduziu a geometria; a disponibilidade estimada do link ficou em aproximadamente 5,52 Mb/s. Portanto o cap é orçamento artificial do encoder, não uma medição de banda da internet. A comparação demonstra a mudança de adaptação espacial; os congelamentos sob 50 kb/s mostram a limitação física que continua existindo. Ela não substitui o ensaio normal de 720p/30 FPS.

[Dados sanitizados da comparação](evidence/encoder-policy-20261115.json). A execução global ficou **FAIL**: todas as amostras das duas etapas e as barreiras finais foram coletadas, mas o emissor tentou restaurar a preferência depois que os outros clientes começavam a sair e recebeu erro ao avaliar um sender encerrado. Os sete receptores terminaram `DIAGNOSTIC`. A mutação final desnecessária foi removida do harness; o bitrate já tinha sido restaurado e o processo descartável é encerrado. Não reclassificar esse run como PASS.

A [primeira tentativa controlada](https://github.com/BersaneV/Harmony/actions/runs/43682467805) também permanece FAIL: a sessão HTTP do controle expirou após as coletas e os estados iniciais não eram equivalentes. Corrigiram-se a renovação rotativa e a espera pelo mesmo estado inicial. Dois testes cobrem concorrência da renovação e falha fechada; nenhum timeout, validade de token ou autorização do produto foi relaxado.

## Critérios da validação final

A prova normal deve instalar exatamente o pacote assinado com hashes de instalador e executável fixados, em oito VMs e oito egressos públicos distintos. São necessários 28 pares nativos confirmados nas duas pontas, 56 recepções direcionais de microfone por fase, 30 s de acomodação e pelo menos 180 s adicionais de voz e de voz com uma tela.

O emissor solicita 720p, 30 FPS, teto de 4 Mb/s por espectador, perfil movimento e áudio da tela desligado. O harness apenas observa a mídia e verifica a preferência nativa da 0.4.2; não modifica parâmetros no modo normal. Todos os sete espectadores devem manter 1280×720 nas amostras sustentadas, média exibida de pelo menos 24 FPS e **zero congelamentos contabilizados**. Esse último requisito é adicional ao ensaio anterior; um teste de regressão impede aprovação por média de FPS apesar de pausas ou ausência dos contadores.

Os critérios de voz permanecem: sete fluxos por cliente, áudio não reconstruído equivalente a pelo menos 80% do tempo, reconstrução de no máximo 2% e RMS decodificado mínimo de 0,03. RTT é a leitura temporal do último valor ICE, não latência completa de fala ou captura até exibição.

## Escopo e custo

As VMs são runners Windows standard de um repositório pessoal público, sem runners maiores, artifacts, caches ou relay pago. [Política de uso gratuito do GitHub](https://docs.github.com/en/actions/concepts/billing-and-usage). A hospedagem Altare existente, os dados reais e o config.toml do Codex não são alterados. O backend 0.4.1 é compatível com o cliente 0.4.2; não há mudança de protocolo ou migração.

São fontes de teste: fala gerada pelo SAPI e captura getDisplayMedia real de janela WinForms própria, usando GPU por software. IPs e identidades de VM aparecem somente como HMAC. Os oito egressos cloud não representam oito operadoras residenciais/5G. PCs físicos, eco/acústica, jogos, áudio do sistema, múltiplas telas, 1440p+, 60 FPS e uso prolongado continuam fora dessa comprovação. O gráfico e os valores efetivos devem identificar resolução, FPS e congelamentos separadamente.
