# Diagnóstico contentHint — EXE público 0.4.7

DIAGNOSTIC; capacity_approval=false. Dois runs independentes, cada um com uma VM Windows, uma captura WGC, um microfone gerado e nenhum receptor. Mesma fonte e vínculo de envio nas três fases de cada run: motion → detail → motion. VP8, um encoding, 60 FPS solicitados, 8 Mb/s em 1080p e 16 Mb/s em 1440p; maintain-resolution e proteção de CPU preservados.

Cada run tem 96 amostras únicas de fases, iguais entre log ao vivo e JSON final: 11 de estabilização e 21 de medição por fase. As seis estabilizações cobrem pelo menos 30 segundos observados e as seis medições pelo menos 60. As três amostras iniciais de produção de cada run ficam fora dessas 96. Fonte bruta, marcador distinto, media-source SDK e encoder são contadores diferentes.

| Perfil | Fase / hint | Fonte bruta FPS | Distintos FPS | SDK FPS | Encoder FPS | ms/encode | CPU VM | reason=cpu |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1080p60 | A_motion | 55.1291 | 51.8559 | 55.1457 | 55.1457 | 9.1913 | 49.56% | 0/21 |
| 1080p60 | B_detail | 55.2988 | 52.2922 | 55.2988 | 55.3154 | 6.5508 | 42.91% | 0/21 |
| 1080p60 | A2_motion | 55.1497 | 51.6935 | 55.1497 | 55.1664 | 9.5343 | 52.12% | 0/21 |
| 1440p60 | A_motion | 46.6582 | 43.8189 | 39.5183 | 39.4519 | 18.6578 | 79.29% | 8/21 |
| 1440p60 | B_detail | 49.5645 | 46.1274 | 49.5812 | 49.5812 | 12.1340 | 72.91% | 0/21 |
| 1440p60 | A2_motion | 48.5161 | 44.7790 | 29.9966 | 30.0132 | 20.9945 | 74.77% | 21/21 |

Arredondamento apenas nesta tabela; aggregate.json preserva os números originais. ms/encode é a diferença de totalEncodeTime dividida pela diferença de framesEncoded. CPU VM abrange fixture, aplicativo, observação e codificação; não é atribuição ao encoder.

Em B_detail, content_type=screenshare foi reportado nas 21/21 amostras de medição dos dois perfis. Nos controles motion, o campo ficou ausente; ausência não recebe valor inferido. Todas as amostras preservaram geometria completa e os limites de envio. O hint motion foi restaurado duas vezes; a restauração final precedeu os cliques de parar a tela e sair da chamada, conforme os resultados e a ordem do runner revisado.

Há duas fronteiras de reset por run: ao entrar em B e em A2, caem acumuladores do encoder, media-source e durações de limitação, apesar das identidades estáveis. Os contadores nativos brutos/distintos seguem contínuos. Também há um timestamp RTP repetido em cada passagem de estabilização para medição. Não se interpola nenhuma dessas adjacências; os resumos originais usam somente deltas internos de cada janela de medição, sem fronteira de reset observada nelas.

Os controles motion de 1440p diferem bastante (39.4519 e 30.0132 FPS do encoder). A ordem não foi contrabalançada; os dados não estabelecem efeito universal. Nessa execução, reason=cpu ocorreu em 8/21 amostras de A, 0/21 de B e 21/21 de A2. Em 1080p, reason=none ocorreu nas 21 amostras de cada fase.

Este ensaio não executa o gate de 180 segundos nem uma chamada com oito participantes. Não mede FPS recebido, freezes ou MOS; não comprova 60 FPS nem o requisito de 54 quadros distintos por segundo. Não demonstra GPU, número de threads ou denoising efetivamente ativado. Não é evidência de desempenho da 0.4.8.

Rascunho privado para revisão independente. Publicação futura depende de CI assinado completo, draft verificado e revisão da projeção. Os originais privados são identificados no manifest.json por nome, tamanho e SHA-256. A projeção omite identidades de fontes, usuários, sessões e rede.
