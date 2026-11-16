# Harmony 0.4.9 — oito EXEs, voz e transmissão nativa

**720p30 passou. 1080p60 e 1440p60 reprovaram por FPS. A meta de sustentar os dois perfis de 60 FPS com oito participantes continua aberta.** Nos três ensaios a voz passou nos oito clientes, os sete receptores mantiveram a resolução integral e não houve congelamento medido. Esses resultados não permitem declarar 60 FPS atingidos.

A candidata foi implementada, revisada e publicada diretamente na main pessoal, sem PR ou contratação. O [instalador público manual](https://github.com/BersaneV/Harmony/releases/download/v0.4.9/Harmony_0.4.9_x64-setup.exe) tem 4.139.623 bytes, SHA-256 cf42a6924ccd1c390e33bbf440b6d77381f15f57fd06c09d5c1a29035b23f7ca. O EXE instalado tem 15.448.576 bytes, SHA-256 6a1517c44ed45c996ac8d32c08767ea7306e897a4cb73d703d9286b68c86c2cc.

## Resultado sustentado

Cada perfil usou oito VMs Windows 2022 novas e oito cópias dos mesmos bytes públicos: um emissor de tela, sete receptores e oito microfones gerados. Houve 30 s de acomodação e pelo menos 180 s medidos em cada uma das fases voz e voz+tela. As rodadas foram sequenciais, com sala vazia e intervalo de pelo menos 60 s antes da próxima preparação.

| Perfil solicitado | Resolução nos sete receptores | FPS exibidos, mínimo–máximo | Fonte, FPS bruto / distinto | Congelamentos | Voz | Resultado |
|---|---|---:|---:|---:|---|---|
| 720p30 | 1280×720 | 29,9975–30,0040 | 30,0018 / 28,3298 | 0 | 8/8 PASS | PASS |
| 1080p60 | 1920×1080 | 49,6417–49,7802 | 49,7449 / 46,3352 | 0 | 8/8 PASS | FAIL |
| 1440p60 | 2560×1440 | 47,9155–47,9398 | 47,9445 / 44,8197 | 0 | 8/8 PASS | FAIL |

Os gates foram preservados: perfis de 60 FPS exigem pelo menos 54 FPS brutos e distintos na fonte, 54 FPS exibidos, resolução integral, zero freeze e duração mínima. A regressão de 720p30 mantém 24 FPS mínimos e os demais critérios. Escolher 60 FPS é uma solicitação; os números medidos acima são menores nos dois perfis. Não houve mudança de tolerância, redução de resolução ou desativação da proteção por CPU para aprovar um resultado.

A medição independente da fonte durou 181,8227 s em 720p,182,1292 s em 1080p e181,7727 s em 1440p. O observador clona a track nativa e copia um pixel por quadro; essa observação pode acrescentar overhead e não substitui a fonte. Cada run preserva 1.136 amostras únicas, oito atestações e oito relatórios obtidos dos logs integrais de cada job. As 1.136 incluem acomodação; o cálculo de qualidade usa as 61 amostras steady por cliente/fase. Total das três rodadas: 3.408 amostras e 24 logs/atestações/relatórios.

## Ping e áudio

| Perfil | RTT da voz sem tela, p50 / p95 / máximo | RTT da voz durante tela, p50 / p95 / máximo | RTT SDK com SFU: emissor p50 | Intervalo dos p50 dos sete receptores com SFU |
|---|---:|---:|---:|---:|
| 720p30 | 33 / 65 / 70 ms | 34 / 65 / 69 ms | 195 ms | 128–193 ms |
| 1080p60 | 28 / 66 / 68 ms | 31 / 67 / 71 ms | 148 ms | 127–183 ms |
| 1440p60 | 33 / 68 / 71 ms | 34 / 68 / 87 ms | 123 ms | 127–181 ms |

A voz usa P2P e a tela usa o SFU opcional existente na hospedagem externa. As rotas têm RTTs diferentes. Esses RTTs ICE/SDK não são latência acústica ou ponta a ponta da imagem. Houve 28 pares reversos confirmados e 56 relações direcionadas de áudio em cada fase, com energia decodificada e contadores de perda/concealment preservados nos JSONs. O áudio é gerado; não houve avaliação auditiva humana nem MOS.

Os limites de bitrate foram 4, 8 e 16 Mb/s. Os payloads médios de vídeo medidos foram respectivamente 0,4454/0,9974/1,3508 Mb/s; o conteúdo sintético simples não consome necessariamente o teto escolhido.

## Mudança e limite observado

A 0.4.9 reúne cópia e publicação dos metadados do quadro numa única callback da interface. Foram removidos uma passagem intermediária pelo worker, a segunda chamada à fila da interface, o mutex dos metadados copiados e o prazo independente de publicação. O relógio nominal de captura continua limitando a cadência. Um Vec e um SharedBuffer em uso, ACK exato, conclusão do envio, origem/stop, revisão do perfil, descarte stale e watchdog de cinco segundos desde a reserva permanecem protegidos. Locks de pixels e TLS terminam antes de Channel.send. FPS e timestamps continuam representando trabalho real.

A indicação de conteúdo detail da 0.4.8 e o controle local de desempenho continuam presentes. A captura nativa desses ensaios usa FPS explícito e áudio do sistema desligado; os oito microfones da chamada permanecem independentes. As outras políticas de captura e os controles de resolução/FPS/bitrate foram preservados.

Em 1440p, a prévia antes de publicar já entregou 51,0964 FPS brutos e48,3966 distintos em 10 s. No intervalo longo, o clone nativo e o media-source do SDK avançaram ambos 8.715 quadros; o encoder codificou e enviou 8.712. O tempo de encode reportado por quadro foi 12,5319 ms. Houve um outbound estável, VP8/libvpx/L1T1/detail/screenshare, limite de 60 FPS/16 Mb/s e maintain-resolution nas 61 amostras. QualityLimitationReason foi none em 61/61, com duração de CPU Δ0 e zero mudanças de resolução. Isso não demonstra que a adaptação por CPU reduziu a cadência nessa rodada.

Os 568 marcadores adjacentes iguais já aparecem na trilha nativa observada, antes da codificação. A CPU da VM inteira ficou em 39,79%/76,24%/77,60% nos perfis 720/1080/1440, com quatro processadores lógicos em cada publicador. Essa CPU inclui Windows, fixture, app, observação e encoding; não é utilização exclusiva do encoder. O tempo médio de encode abaixo de um período de 60 FPS não prova capacidade sustentada conjunta.

Os [resultados048](EXE-WAN-0.4.8.md) continuam preservados. Suas VMs, rotas e períodos diferem; a comparação não isola o efeito da callback única. Ainda falta separar compositor/WGC/readback/cópia/ponte/escalonamento sob carga. Não há evidência para atribuir causa exclusiva à GPU, trocar codec ou relaxar as guardas. Um preflight separado de ferramentas nativas de escalonamento está sendo preparado com rótulo sintético/diagnóstico; ele ainda não é prova de causa ou capacidade.

## Pacote e validação

Produto: commit baa7acb90275d76d6e2df93d56d5ebbdad39b7c7. QA das três rodadas: a8ed323b36e3407f2325aff6d0c851115edd068a. O [CI completo 43928232637](https://github.com/BersaneV/Harmony/actions/runs/43928232637) passou na tentativa 2. A tentativa 1 falhou no startup de Chromium de uma fixture Linux, antes do Windows; a causa permaneceu não determinada, sem alteração do código/gates para repetir. O resultado anterior e os logs foram preservados.

Validação independente: 37 testes locais,36 testes Windows da ponte e do núcleo, nove mutantes compilados detectados, Clippy/fmt e 151 testes QA passaram. A [verificaçãoWindows isolada](https://github.com/BersaneV/Harmony/actions/runs/43930903948) também passou. As 17 verificações do updater, incluindo assinatura, passaram no Windows e localmente, além de nove checks de instalação/remoção. Os cinco assets, a fonte e seus digests permaneceram iguais entre draft e publicação. O download anônimo HTTP 200 confirmou os mesmos bytes. A [prova do pacote](evidence/package-0.4.9-20261116.json) distingue assinatura Tauri/minisign de Windows Authenticode.

O [canal público manual](https://github.com/BersaneV/Harmony/releases/tag/v0.4.9) não foi promovido ao feed automático, que continua0.4.2. Backend/Web e bundle Linux continuam 0.4.3 na hospedagem externa existente. Nenhum recurso pago, cartão ou configuração global do Codex foi usado para esta mudança.

## Evidências

| Ensaio | Run | Dados completos projetados | Figura |
|---|---|---|---|
| 720p30 | [43942260760](https://github.com/BersaneV/Harmony/actions/runs/43942260760) | [JSON](evidence/exe-wan-0.4.9-720p30-20261116.json) | [PNG](evidence/exe-wan-0.4.9-720p30-20261116.png) |
| 1080p60 | [43939874839](https://github.com/BersaneV/Harmony/actions/runs/43939874839) | [JSON](evidence/exe-wan-0.4.9-1080p60-20261116.json) | [PNG](evidence/exe-wan-0.4.9-1080p60-20261116.png) |
| 1440p60 | [43937755450](https://github.com/BersaneV/Harmony/actions/runs/43937755450) | [JSON](evidence/exe-wan-0.4.9-1440p60-20261116.json) | [PNG](evidence/exe-wan-0.4.9-1440p60-20261116.png) |

Cada run confirmou oito hashes de VM e oito saídas HTTPS/UDP distintas, o mesmo EXE e a rota SFU consistente. São máquinas em nuvem, sem medição de oito provedores residenciais ou 5G, hardware GPU físico, jogos ou captura de áudio do sistema. As três salas ficaram vazias após os testes. A coleção, as projeções e os títulos dos gráficos mantêm os FAILs e a distinção entre fonte e receptores; o renderer não foi alterado.
