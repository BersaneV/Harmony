# Experimento de cópia assíncrona da captura Windows

O [ensaio de 16/11/2026](https://github.com/BersaneV/Harmony/actions/runs/43979126187) comparou o readback bloqueante atual (A), duas texturas com `Map(READ, DO_NOT_WAIT)` (B) e novamente o controle (A). A feature `capture-readback-experiment` segue desligada por padrão. **Não houve ganho consistente de FPS que justificasse adotá-la no aplicativo.**

A comparação usou uma única VM Windows 2022, o mesmo executável CLI experimental, a mesma janela gerada em 2560 × 1440, uma captura, um perfil, um Vec e um FramePacer. Cada fase teve 5 segundos de acomodação e pelo menos 10 segundos medidos. O núcleo real foi compilado e seus testes e Clippy, com e sem a feature, passaram no Windows. Não há encoder, SharedBuffer, JavaScript, voz ou oito clientes neste ensaio; a compilação e a saída verde do workflow não aprovam capacidade do Harmony.

| Fase | Captura (FPS) | Marcador distinto (FPS) | Idade média desde a submissão | Idade máxima | Entregues acima de 16,667 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| A — bloqueante | 57,397 | 55,197 | 7,165 ms | 23,450 ms | 1 |
| B — duas texturas | 55,782 | 54,782 | 7,819 ms | 11,330 ms | 0 |
| A — bloqueante | 57,577 | 54,578 | 6,872 ms | 16,724 ms | 1 |

As três fases preservaram 2560 × 1440, o gate amostral de cores e os gates diagnósticos de 54 FPS brutos e distintos. Na fase B, 2.604 tentativas de Map resultaram em 2.029 respostas busy, 558 quadros entregues e 17 readbacks descartados. As duas texturas foram usadas e houve dois readbacks pendentes simultaneamente; um estava pendente ao término da janela. A idade exportada conserva o início original da submissão, incluindo espera, Map, cópia de linhas e Unmap. `freshness_status=PASS` corresponde somente à fase B; os dois controles têm uma entrega acima de um período.

O retorno rápido de Map em B confirma que a operação não bloqueante foi exercitada. Isso não prova ganho de throughput: o FPS bruto ficou abaixo dos dois controles e o FPS distinto ficou entre eles. O tempo de Map mistura sincronização e scheduling e não mede tempo exclusivo de GPU. Os contadores globais da janela gerada indicaram 59,978 apresentações/s em cerca de 40 segundos, mas não estão alinhados às fases e não certificam 60 paints/s em cada uma.

A fonte testada foi `8da81cc703ec19748fc8a4fdd43e79372deec5b9`; o job público foi `133690711198`. A log integral preservada tem 78.113 bytes, SHA-256 `78b1703d535e69776361ac040dcae088907d93d3b9bf70ee72133ba3f79b822b`. A [projeção numérica](evidence/native-readback-1440-20261116.json) conserva os valores exatos e os limites da comparação, sem identificadores de processo/thread, caminhos, endereços ou identidades de contas.

A versão assinada 0.4.9 e suas [campanhas completas com oito EXEs e voz](EXE-WAN-0.4.9.md) permanecem separadas: 720p30 passou; 1080p60 e 1440p60 falharam. Nenhum resultado deste experimento altera esses resultados, promove o canal de atualizações ou comprova execução em GPU física.
