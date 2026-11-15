# Testar o EXE em redes diferentes com oito pessoas

Este roteiro complementar trata de PCs e participantes físicos e permanece **NOT_RUN** nesse recorte. O [teste automatizado atual de oito EXEs 0.4.2 em VMs Windows externas](EXE-WAN-0.4.2.md) passou: voz nos oito clientes, tela em 720p nos sete espectadores e zero congelamentos na fase sustentada. A primeira ocorrência 0.4.1 permanece FAIL e está preservada no histórico. As fontes desse ensaio são fala gerada e captura real de janela própria; não substituem redes residenciais/5G, microfones físicos ou avaliação dos usuários.

## Preparação

1. Cada pessoa usa um PC Windows, sua própria conta e o [instalador 0.4.2](https://github.com/BersaneV/Harmony/releases/download/v0.4.2/Harmony_0.4.2_x64-setup.exe). Servidor: **https://harmony.go.altare.global**, sem `/api`.
2. Confirmar a versão de cada aplicativo. Para conferir o instalador com PowerShell: `Get-FileHash .\Harmony_0.4.1_x64-setup.exe -Algorithm SHA256`. Hash esperado: `509e30e8781876caa64ec8b36fc37ddb76bf868924717fd44ca6c109b7ab42bf`.
3. Usar conexões de internet independentes. Atribuir códigos de rede R1–R8; máquinas atrás do mesmo roteador recebem o mesmo código. Registrar cabo, Wi-Fi ou internet móvel. Um PC conectado ao hotspot 4G/5G continua sendo um cliente Windows válido. O celular sozinho testa o cliente web móvel.
4. Usar fones e deixar câmeras desligadas nesta primeira rodada. Cada pessoa escolhe e ativa seu próprio microfone. Fechar transferências grandes e pausar outras transmissões durante a referência inicial; anotar VPN ou rede corporativa se estiverem em uso.
5. Entrar na comunidade **Teste Windows 8 — redes reais**, por convite fornecido privadamente, e no canal **voz-e-tela-8**. Convite de comunidade é usado uma vez por conta. A chamada abre pelo canal.
6. Identificar as pessoas como P1–P8 no relatório, sem senhas, tokens, IPs ou endereços pessoais. Conferir oito usuários distintos na mesma chamada; um observador que só consulta a lista de participantes não deve entrar na mídia.

Não alterar bitrate, qualidade, dispositivos ou conexão no meio de uma fase sem registrar horário e motivo. Falha é evidência; preservar o primeiro resultado antes de tentar recuperar.

## Rodada inicial

| Fase | Duração | Ação e observação |
|---|---|---|
| Conexão | Até os oito entrarem | Registrar quem não conectou e a mensagem exata. Não começar a medir uma chamada de oito com pessoas faltando. |
| Voz | 30 s de acomodação + 180 s | P1–P8 falam por 20 s cada; depois, duas pessoas falam ao mesmo tempo. Cada receptor confirma que ouviu os outros sete. Anotar voz clara, cortes, som robótico, eco e reconexões. |
| Uma tela | 30 s de acomodação + 180 s | P1 transmite janela de teste em **720p / 30 FPS / 4 Mb/s por espectador**, perfil movimento. Os outros sete assistem com qualidade automática e continuam conversando. |
| Outro emissor | 30 s de acomodação + 180 s | P1 para a tela; P2 repete o mesmo perfil. Incluir uma conexão móvel nesta rodada, se disponível, para diferenciar problemas do emissor e de cada caminho. |
| Recuperação | Sem tempo fixo | Uma pessoa sai e entra novamente pelo canal. Confirmar que os outros sete continuam conversando, registrar o tempo de retorno e ativar o microfone novamente por ação própria. |
| Perfis superiores | Opcional, após a referência | Experimentar 1080p ou 1440p, mantendo uma variável por vez e registrando novo perfil/horário. Dificuldade no perfil superior não apaga os resultados de 720p. |

Para a tela, usar conteúdo de teste com movimento e texto, por exemplo um vídeo local sem dados pessoais e uma janela com rolagem. Cada usuário escolhe o que compartilhar. Conferir o áudio da tela separadamente do microfone, quando a fonte selecionada disponibilizar áudio. Registrar quando o aplicativo informar que a fonte não oferece áudio.

Com sete espectadores, o teto de vídeo de 4 Mb/s por destinatário soma **28 Mb/s de upload**, acrescido de áudio e overhead. É teto configurado; o envio real depende do conteúdo, codec e rede. Registrar também o campo **Upload de vídeo medido**, incluindo a indicação “parcial”, quando existir. Reduzir o bitrate em uma rodada posterior ajuda a identificar saturação, preservando o resultado da primeira rodada.

## Coleta usando a versão 0.4.1

O cliente mostra o RTT ICE de cada par nas informações do participante. Quando há tela recebida, mostra também resolução, FPS e bitrate. O emissor vê perfil solicitado, captura e upload medido. Observar aos **30, 60, 90, 120, 150 e 180 segundos** de cada fase sustentada; registrar a acomodação separadamente. Usar o formulário CSV ou observações equivalentes. Capturas da janela do Harmony podem apoiar os números, se os participantes quiserem fornecê-las.

| Campo | Interpretação e limite |
|---|---|
| Ping em ms no participante | RTT ICE do caminho entre aquele par. Registrar receptor e remetente. Cada pessoa terá até sete medições diferentes. |
| Resolução recebida | Comparar com o perfil solicitado e com o teto escolhido por esse espectador. |
| FPS mostrados | A implementação usa estatísticas de frames decodificados no receptor; a fluidez efetivamente exibida também exige observação visual. |
| Bitrate recebido | Taxa recente de payload, variável com a cena. Um valor abaixo do teto não demonstra defeito sozinho. |
| Voz/fluidez | Observação manual de cortes, congelamentos, dessincronização e inteligibilidade; anotar horário e quem foi afetado. |
| Desconexão | Mensagem, fase, número de pessoas presentes e recuperação observada. |

O [RTT ICE definido pelo W3C](https://www.w3.org/TR/webrtc-stats/#dom-rtcicecandidatepairstats-currentroundtriptime) é uma medição de ida e volta baseada nas verificações STUN do caminho. O ping de um comando para o servidor sueco avalia outro caminho. O atraso completo de captura e reprodução requer medição própria; não estimá-lo dividindo o RTT por dois.

**Limite atual da coleta:** a 0.4.1 não exporta histórico, perda de pacotes ou jitter pela interface. A API de sinalização fornece participantes e estados de publicação; a mídia P2P não passa por ela. Não atribuir à API valores de qualidade que só os clientes observam. Esses campos ficam **NOT_MEASURED** até haver instrumentação apropriada. Dados ausentes ficam vazios; não preencher com zero. Sem série de amostras, registrar a faixa observada e relatos, sem inventar média, mediana ou p95.

## Resultado

Concluir separadamente conectividade, voz e vídeo. A condição funcional é oito contas conectadas e os 56 sentidos de voz confirmados pelos receptores, mais uma tela assistida pelos sete e recuperação sem derrubar os demais. Relatos de voz robótica ou cortes são falhas observadas mesmo quando os indicadores de rede parecem bons.

Na tela 720p/30, usar como referência inicial a meta já usada no ensaio automatizado: manter 1280×720 e procurar médias de ao menos 24 FPS. As amostras pontuais da interface e a observação manual são evidências parciais; não recebem automaticamente o mesmo PASS de uma série contínua de frames exibidos. Registrar valores efetivos e quem reprovou. Não há limite universal de ping aprovado por este roteiro: apresentar os caminhos medidos e avaliar a experiência real.

Guardar versão, perfil, quantidade de usuários, grupos de rede, duração, observações, amostras e falhas. Um resultado com menos de oito participantes fica identificado com sua quantidade real. Até receber essas evidências, a campanha de PCs físicos em redes dos usuários permanece **NOT_RUN**; o ensaio automatizado em VMs externas possui o resultado próprio vinculado acima. Nenhuma gravação de voz ou de tela é iniciada pelo servidor ou por este roteiro.
