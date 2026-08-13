# Plano de migração: crmclinica da Vercel para o VPS próprio

Status: **planejamento — nada aqui foi executado.**

## Por que

O deploy atual em Vercel (serverless) trouxe o incidente de 12/08/2026: o
endpoint `/api/canais/whatsapp/eventos` está correto, mas depuração e logs
exigem passar pela dashboard/API da Vercel em vez do `journalctl` do próprio
servidor, e funções serverless têm timeout — arriscado para uma rota que fala
com IA e pode levar mais que alguns segundos. O VPS (`srv905994.hstgr.cloud`)
já roda outros processos do mesmo `package.json` (`crmclinica-ponte`,
`crmclinica-lembretes`, `crmclinica-heartbeat`, `crmclinica-google-outbox`) —
mover o servidor HTTP principal para lá unifica tudo num só lugar observável.

## O que já existe no VPS (não precisa recriar)

- Node v24 via nvm (`/root/.nvm/versions/node/v24.18.0/bin/node`)
- Banco Postgres de produção já acessível de lá (`CRMCLINICA_DATABASE_URL`)
- `crmclinica-ponte.service`: já roda `node src/index.js` a partir de
  `/opt/crmclinica-ponte`, hoje escutando só em `127.0.0.1:4177`
- Traefik (via EasyPanel) já expõe outros serviços do mesmo host publicamente
  com TLS automático (Let's Encrypt) — visto em
  `/etc/easypanel/traefik/config/main.yaml`, que já tem roteamento para o
  domínio público da Evolution API, por exemplo.

Ou seja: **o processo Node já existe e já roda em produção** — falta só
exposição pública. Duas rotas possíveis, na ordem de menor risco:

### Opção A — Traefik/EasyPanel (recomendado)

Reaproveita a infraestrutura que já está de pé para outros serviços do mesmo
host (a mesma que já expõe a Evolution API hoje). Não precisa instalar nada
novo (nginx, certbot, PM2) — é configuração dentro do EasyPanel.

1. No EasyPanel, criar um app apontando para `/opt/crmclinica-ponte` (ou um
   novo diretório de deploy), porta interna `4177` (ou trocar `HOST`/`PORT`
   no `.env` do serviço para `0.0.0.0`/outra porta livre, coordenado com o
   restart do `crmclinica-ponte.service`).
2. Configurar domínio no EasyPanel: `crmclinica.edsonbarrosojr.com.br`
   apontando para esse app — TLS automático via Let's Encrypt, igual ao que já
   existe para `evo.*`.
3. Ajustar systemd (`/etc/systemd/system/crmclinica-ponte.service`) se a porta
   ou o bind mudar.

### Opção B — nginx + certbot manual + PM2

Mais trabalho manual, só se a Opção A não servir (ex.: se quisermos o serviço
fora do EasyPanel por algum motivo):

1. `apt install nginx certbot python3-certbot-nginx`
2. Site nginx com `proxy_pass http://127.0.0.1:4177;` para
   `crmclinica.edsonbarrosojr.com.br`
3. `certbot --nginx -d crmclinica.edsonbarrosojr.com.br`
4. Trocar `Restart=always` do systemd por PM2 só se quisermos os recursos de
   PM2 (zero-downtime reload, monitor); o `crmclinica-ponte.service` atual já
   reinicia sozinho (`Restart=on-failure`), então PM2 não é estritamente
   necessário.

## DNS — o passo que corta o cabo

`crmclinica.edsonbarrosojr.com.br` hoje resolve para a Vercel. A migração só
vira real quando o DNS apontar para o IP do VPS (`193.203.182.112`, visto no
`known_hosts` desta máquina) em vez do CNAME da Vercel.

**Isso é o ponto de não-retorno de cada tentativa** — TTL do DNS decide quanto
tempo leva para reverter se algo der errado. Antes de mudar:
- confirmar TTL atual do registro (baixar TTL um dia antes ajuda a reverter rápido se precisar)
- ter a Opção A ou B já funcionando e testada via IP direto ou `/etc/hosts`
  local, com o certificado TLS já válido para o domínio, antes de apontar o
  DNS de verdade
- ter um plano de rollback escrito (reverter o registro DNS) pronto antes de
  mudar, não descoberto depois

## O que muda de código

Pouca coisa, se nada. `src/index.js` já é o entrypoint HTTP tanto do
`crmclinica-ponte.service` quanto (presumivelmente) do adaptador serverless da
Vercel (`api/index.js`) — a lógica de rotas é a mesma. O que muda é infra, não
aplicação:
- variável `PORT`/`HOST` do `.env` de produção no VPS
- remover a exposição pública da Vercel depois que o corte for confirmado
  (ou manter como staging/fallback, decisão de negócio, não técnica)

## Ordem recomendada (quando for autorizado a executar)

1. Confirmar que a correção do webhook (Fase 1, `EVOLUTION_WEBHOOK_TOKEN`)
   está estável em produção — não migrar servidor no meio de um incidente
   ainda não fechado.
2. Opção A (EasyPanel) num subdomínio de teste primeiro
   (ex.: `crmclinica-teste.edsonbarrosojr.com.br`), validar toda a aplicação
   funcionando por trás do Traefik antes de tocar no domínio de produção.
3. Cortar DNS do domínio de produção só depois do passo 2 validado, com
   rollback escrito.
4. Observar por 24–48h antes de desligar/remover o deploy Vercel.

## O que NÃO fazer

- Não apontar o DNS de produção antes de validar a Opção A/B num subdomínio à
  parte.
- Não remover o deploy Vercel até o VPS estar estável por alguns dias.
- Não migrar durante um incidente em aberto (isso complica diagnosticar qual
  das duas mudanças causou o quê).
