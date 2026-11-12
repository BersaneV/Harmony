# Mídia RTC local — prova de 12/11/2026

**PASS em macOS arm64 com dois peers do SDK oficial Python**, conectados ao Harmony pelo gateway Caddy de admissão. Esta prova usa áudio e vídeo gerados em memória; não captura dispositivos, não reproduz som e não homologa o aplicativo Windows.

Execução final: `2026-11-12T17:03:46Z`. SDKs: `livekit==1.2.1` e `livekit-api==1.2.2`. Script: [test_media_rtc.py](../scripts/test_media_rtc.py), SHA256 `477e4f59281b3253bdf03fae25babf4e92c08cb816a76cacef537f414566397f`. A prova usou API Harmony, PostgreSQL, Caddy e LiveKit locais reais, sem substituir a decisão de autorização por mock.

| Cenário | Observado |
|---|---|
| Conexão dos dois peers pelo Caddy | SDKs conectados e dois participantes confirmados pela API LiveKit. |
| Áudio sintético mono a 48kHz | Receptor decodificou 71 frames, com pico absoluto de amplitude 7436. |
| Vídeo sintético VP8 | Receptor decodificou dez frames em 160×96 e dez cores distintas. |
| Reset administrativo do transmissor ativo | SDK desconectado e saída observada pelo receptor em 0,334s nesta execução. |
| Estado após o reset | LiveKit listou somente o receptor; ele permaneceu conectado e não recebeu novos frames depois da drenagem dos buffers. |
| Reutilização do token | Gateway rejeitou o token antes dos seus 60s de expiração; a tentativa de reconexão do SDK oficial também foi rejeitada. |

Foram verificados 17 critérios, incluindo pré-condições locais. O vídeo foi solicitado a 15 FPS e até 200kbps; esses valores são configurações do ensaio, não medições de throughput nem prova de um teto imposto ao tráfego. O tempo de desconexão é uma observação local, não um SLA.

O primeiro preparo usava vídeo 160×90, recebido em 160×88 pelo encoder. A igualdade de dimensões reprovou e a execução parou antes do reset. A entrada sintética foi alterada para 160×96, alinhada a blocos do codec; a comparação continuou exigindo igualdade exata. Os resultados anteriores foram preservados localmente. Não houve alteração de código do produto para fazer esta prova passar.

## Reproduzir em ambiente descartável

O teste cria contas, comunidade e canal de teste no banco local e reseta uma dessas contas. Ele exige os serviços locais ativos, gateway de mídia configurado e credenciais de bootstrap/LiveKit no `.env`; não imprime essas credenciais.

```sh
python3 -m venv .local/qa-media/venv
.local/qa-media/venv/bin/python -m pip install livekit==1.2.1 livekit-api==1.2.2
python3 scripts/with-env.py .local/qa-media/venv/bin/python scripts/test_media_rtc.py
```

O relatório sem tokens fica em `.local/qa-media/result.json`, com data, versões e hash do script. O teste é uma integração executada explicitamente; `unittest discover` não executa o ensaio RTC. As dependências Python permanecem no ambiente local e não são dependências do aplicativo distribuído.

Captura/áudio do Windows, resoluções altas, FPS elevados, bitrate efetivo, múltiplos espectadores, reconexão após troca de rede, NAT e TURN público ainda exigem provas próprias. A ocorrência anterior com WebSocket bruto sem negociação RTC permanece distinta; esta execução demonstrou revogação de um participante com mídia ativa.

Referências usadas: [publicação de áudio/vídeo](https://docs.livekit.io/transport/media/publish/), [SDK Python oficial](https://github.com/livekit/python-sdks), [API de salas](https://docs.livekit.io/reference/python/livekit/api/room_service.html).

## ACL alterada durante mídia ativa

O teste independente de ACL encontrou uma falha real: após negar PUBLISH a um membro comum, a permissão de publicação no LiveKit permaneceu ativa por mais de15s. A reconciliação lia `canPublish`, enquanto a resposta Twirp retornava `can_publish`; o valor ausente era interpretado como false e a revogação não era enviada. O backend corrigiu a leitura canônica e acrescentou um teste de contrato. O mesmo ensaio passou depois da correção, sem alterar seus critérios.

A regressão foi promovida para [test_media_acl_rtc.py](../scripts/test_media_acl_rtc.py), ajustando apenas localização da raiz, documentação e nome de uma métrica. A execução pública foi repetida em `2026-11-12T17:21:47Z`, SHA256 `c05829e8dd9994822b17c56b399a60f7934cecc9229538a12e022a6e931b4d00`, e passou em25 critérios:

- Dois peers reais conectados; áudio não silencioso e vídeo variável decodificados.
- PUBLISH negado alterou a permissão do participante, interrompeu os frames e preservou ambas as conexões.
- PUBLISH restaurado permitiu publicar novas tracks e voltar a receber áudio/vídeo.
- CONNECT negado desconectou o transmissor em3,969s nesta execução; o receptor permaneceu conectado e foi o único participante listado.
- A entrega de mídia parou e o token ainda dentro da validade foi recusado tanto pelo gateway quanto pelo SDK na reconexão.

```sh
python3 scripts/with-env.py .local/qa-media/venv/bin/python scripts/test_media_acl_rtc.py
```

A preparação usou o receptor como proprietário da comunidade e o transmissor como membro comum, evitando o bypass administrativo previsto. As evidências de antes/depois permanecem em `.local/qa-media/acl-before-twirp-fix.json`, `acl-after-twirp-fix.json` e `acl-result.json`. Este ensaio tem os mesmos limites de plataforma/rede da prova de reset; o intervalo observado não é uma garantia de latência.
