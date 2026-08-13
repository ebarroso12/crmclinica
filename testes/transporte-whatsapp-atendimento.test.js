'use strict';

// Comando 4, frente 8 — confirma o que o plano do Comando 1 (seção 1.5)
// registrou como nuance: `SERENA_TRANSPORTE_WHATSAPP` hoje só deveria
// controlar a sincronia de conversas por leitura do worker de lembretes
// (Arquitetura A), nunca o caminho de ATENDIMENTO (mensagem → resposta →
// entrega). A investigação para este comando encontrou uma exceção real: o
// próprio `bin/worker-outbox.js`, criado no Comando 3, condicionava o
// orquestrador (quem gera a resposta) a essa variável — copiando por engano
// o padrão do worker de lembretes, onde ela decide outra coisa. Com o valor
// padrão do `.env.exemplo` (`openclaw_gerencia`), isso deixaria a outbox
// SEM orquestrador, e todo trabalho reivindicado cairia em
// `sem_orquestrador` — nenhum paciente seria respondido. Corrigido antes de
// alinhar o padrão da variável (ordem exigida pelo Comando 4).
//
// Não há gateway real disponível neste ambiente de teste, então a prova é
// estrutural: inspeciona o código-fonte para confirmar que a construção do
// orquestrador em cada caminho de atendimento não depende de
// `transporteWhatsapp`/`SERENA_TRANSPORTE_WHATSAPP`.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTTP_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'servidor', 'http.js'), 'utf8');
const WORKER_OUTBOX_JS = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-outbox.js'), 'utf8');
const WORKER_LEMBRETES_JS = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-lembretes.js'), 'utf8');
const ATENDIMENTO_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'dominio', 'atendimento.js'), 'utf8');
const CANAL_CONVERSAS_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'integracoes', 'canal-conversas.js'), 'utf8');
const EVOLUTION_ENVIO_JS = fs.readFileSync(path.join(__dirname, '..', 'src', 'integracoes', 'evolution-envio.js'), 'utf8');

test('src/servidor/http.js: o orquestrador do atendimento HTTP nunca dependeu de transporteWhatsapp', () => {
  assert.ok(!/transporteWhatsapp/.test(HTTP_JS),
    'a rota HTTP nunca deveria consultar essa variável para decidir se despacha a IA');
  assert.match(HTTP_JS, /const orquestrador = dependencias\.orquestrador \|\| criarClienteOpenClaw\(/,
    'construção incondicional do orquestrador');
});

test('bin/worker-outbox.js: o orquestrador da outbox é construído incondicionalmente (bug do Comando 3, corrigido aqui)', () => {
  assert.ok(!/transporteWhatsapp/.test(WORKER_OUTBOX_JS),
    'o worker que processa a outbox não pode mais condicionar o orquestrador a essa variável');
  assert.match(WORKER_OUTBOX_JS, /orquestrador: criarClienteOpenClaw\(configuracao\.openclaw\)/,
    'construção incondicional, igual à do servidor HTTP');
});

test('src/dominio/atendimento.js e src/integracoes/canal-conversas.js: o caminho de resposta e entrega não referencia a variável', () => {
  assert.ok(!/transporteWhatsapp/.test(ATENDIMENTO_JS));
  assert.ok(!/transporteWhatsapp/.test(CANAL_CONVERSAS_JS));
  assert.ok(!/transporteWhatsapp/.test(EVOLUTION_ENVIO_JS));
});

test('bin/worker-lembretes.js continua sendo o único lugar que legitimamente depende da variável — para a sincronia de LEITURA, não para responder', () => {
  assert.match(WORKER_LEMBRETES_JS, /transporteWhatsapp/,
    'este worker decide, com a variável, se a sincronia de conversas por leitura (Arquitetura A) roda — isso é esperado e não muda neste comando');
});
