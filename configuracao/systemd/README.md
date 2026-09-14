# Units systemd do VPS — versionadas a partir de 14/09/2026

Até aqui, as 6 units do crmclinica no VPS (`root@193.203.182.112`,
`/opt/crmclinica-ponte`) só existiam em `/etc/systemd/system/`, escritas à
mão, sem git — o mesmo problema que `configuracao/openclaw/workspace-serena/`
já resolveu para o prompt da Serena. Uma edição feita direto no servidor não
tem `git diff`, não tem `git blame`, e some na próxima reinstalação do zero.

Este diretório começa a fechar essa lacuna, mas **só para as duas units
tocadas pelo achado de 13/09/2026** (`crmclinica-ponte` e a referência de
`crmclinica-heartbeat`). As outras quatro (`crmclinica-email`,
`crmclinica-google-outbox`, `crmclinica-lembretes`, `crmclinica-outbox`)
continuam só no servidor — versioná-las é trabalho futuro, fora do escopo
desta correção.

## O achado

A ponte de ingresso (`crmclinica-ponte.service`) ficou **enabled + inactive +
zero linhas de log** por 12 horas em 13/09/2026 — 2880 falhas de plugin,
paciente esperando desde a véspera. A unit antiga:

```ini
[Unit]
After=network.target openclaw-clinica.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/crmclinica-ponte
ExecStart=/root/.nvm/versions/node/v24.18.0/bin/node src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`Restart=on-failure` só age se o processo **começou e caiu**. "Enabled +
inactive + zero log" é o processo nunca tendo chegado a rodar — não há
crash para reiniciar. A causa exata de por que ele nunca começou não foi
recuperada (o VPS não reiniciou desde 28/06/2026, então não foi corrida de
boot; o `journalctl` não guarda logs de antes de 01/09 — a hipótese mais
provável, não confirmada, é `systemctl enable` sem o `start` correspondente
numa sessão anterior).

Sem poder confirmar a causa exata, o conserto responsável não é uma aposta
específica — é trazer esta unit para o MESMO padrão que
`crmclinica-heartbeat.service` já usa hoje, comprovadamente, rodando sem
problema (é claramente mais nova/mais bem cuidada que a da ponte):

| Item | Antes (ponte) | Depois (igual ao heartbeat) | Por quê |
|---|---|---|---|
| `After=`/`Wants=` | `network.target` | `network-online.target` + `Wants=` | `network.target` é alcançado antes da rede ter IP de verdade — corrida de boot clássica |
| `StartLimitIntervalSec`/`Burst` | ausente | `300`/`5` | limita reinício em loop sem travar para sempre |
| `Restart=` | `on-failure` | `always` | cobre também saída limpa inesperada, não só crash |
| `RestartSec` | `3` | `10` | evita loop apertado demais contra um problema que não se resolve sozinho em 3s |
| Sandboxing (`ProtectSystem`, `PrivateTmp`, etc.) | nenhum | igual ao heartbeat | reduz superfície de um processo que já roda como root |

Confirmado, antes de aplicar, que o único arquivo que este processo escreve
localmente (`.openclaw-identidade.json`/`.openclaw-identidade-clinica.json`,
ver `src/config.js`) fica dentro de `/opt/crmclinica-ponte` — coberto por
`ReadWritePaths`; e que nada em `src/` usa `os.tmpdir()` — `PrivateTmp` não
quebra nada.

## O que isto NÃO resolve sozinho

Endurecer a unit reduz a chance de o mesmo tipo de falha se repetir, mas não
prova a causa raiz do episódio de 13/09. O complemento real está no
PR #83 (`fix/heartbeat-nao-checa-a-ponte`): o batimento de saúde
(`crmclinica-heartbeat.service`) gravava "tudo bem" incondicional sem checar
a ponte — por isso a queda ficou 12h invisível mesmo no painel. As duas
correções juntas (unit mais resiliente + detecção que de fato funciona) é
que fecham o achado.

## Como aplicar uma mudança nesta unit no VPS

```sh
scp configuracao/systemd/crmclinica-ponte.service root@193.203.182.112:/etc/systemd/system/crmclinica-ponte.service
ssh root@193.203.182.112 'systemctl daemon-reload && systemctl restart crmclinica-ponte && systemctl status crmclinica-ponte --no-pager'
```

Sempre confira `systemctl status` (PID estável, sem loop de restart) e
`ss -lntp | grep <porta>` depois — igual foi feito na aplicação de
13-14/09/2026.
