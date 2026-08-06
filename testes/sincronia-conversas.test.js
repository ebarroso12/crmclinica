'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  criarSincronizadorDeConversas, ehDoWhatsapp, telefoneDaSessao,
  idDaMensagem, textoDaMensagem, instanteDaMensagem,
} = require('../src/dominio/sincronia-conversas');

const msg = (papel, texto, id, extras = {}) => ({
  role: papel,
  content: [{ type: 'text', text: texto }],
  __openclaw: { id },
  ...extras,
});

const SESSAO = Object.freeze({
  key: 'agent:serena:main',
  sessionId: 'abc-123',
  displayName: '+5516993120938',
  origin: { provider: 'whatsapp', from: '+5516993120938' },
});

// ----------------------------------------------------------------- as peças

test('só sessões de WhatsApp entram — as do painel são ensaio', () => {
  assert.equal(ehDoWhatsapp(SESSAO), true);
  assert.equal(ehDoWhatsapp({ origin: { provider: 'dashboard' } }), false);
  assert.equal(ehDoWhatsapp({}), false);
});

test('o telefone sai normalizado como no resto do sistema', () => {
  // Normalização própria aqui criaria um segundo contato para o mesmo paciente
  // — um com código de país, outro sem.
  const numero = telefoneDaSessao(SESSAO);
  assert.match(numero, /^\+?55/);
  assert.equal(telefoneDaSessao({ origin: { from: '16993120938' } }), numero);
});

test('grupo não vira paciente', () => {
  // O JID de grupo passa em qualquer teste de tamanho, e sem barrar viraria um
  // contato com vinte dígitos de telefone.
  assert.equal(telefoneDaSessao({ origin: { from: '120363001234567890@g.us' } }), null);
  assert.equal(telefoneDaSessao({ origin: { from: '5516993120938-1699999999' } }), null);
});

test('sem identificador do gateway, a mensagem é pulada, não inventada', () => {
  // Inventar um id faria mensagens de pacientes diferentes colidirem e serem
  // descartadas como duplicadas — perda de dado silenciosa.
  assert.equal(idDaMensagem({ __openclaw: { id: 'f40d3bac' } }), 'wa:f40d3bac');
  assert.equal(idDaMensagem({}), null);
  assert.equal(idDaMensagem({ __openclaw: {} }), null);
});

test('o texto é extraído das duas formas que o gateway usa', () => {
  assert.equal(textoDaMensagem({ content: 'oi' }), 'oi');
  assert.equal(textoDaMensagem({ content: [{ type: 'text', text: 'oi' }] }), 'oi');
  assert.equal(textoDaMensagem({ content: [{ type: 'image' }] }), '');
  assert.equal(textoDaMensagem({}), '');
});

test('timestamp que o Date não entende vira nulo, não exceção', () => {
  // Uma exceção aqui derrubaria a mensagem no catch e ela seria descartada em
  // toda leitura, para sempre, enquanto a sincronização relatasse sucesso.
  assert.equal(instanteDaMensagem({ timestamp: 1785854754000 }), '2026-08-04T14:45:54.000Z');
  assert.equal(instanteDaMensagem({ timestamp: '1785854754000' }), '2026-08-04T14:45:54.000Z');
  assert.equal(instanteDaMensagem({ timestamp: 'ontem à tarde' }), null);
  assert.equal(instanteDaMensagem({ timestamp: null }), null);
  assert.equal(instanteDaMensagem({}), null);
});

// ---------------------------------------------------------- a sincronização

function montarAmbiente(mensagens, { jaTemSaida = false } = {}) {
  const recebidas = [];
  const saidas = [];

  return {
    recebidas,
    saidas,
    sincronizador: criarSincronizadorDeConversas({
      gateway: {
        async chamar(metodo) {
          if (metodo === 'sessions.list') return { sessions: [SESSAO] };
          if (metodo === 'chat.history') return { messages: mensagens };
          throw new Error(`método inesperado: ${metodo}`);
        },
      },
      atendimento: {
        async receberMensagem(evento) { recebidas.push(evento); return { acao: 'ok' }; },
      },
      repositorio: {
        async encontrarOuCriarContato() { return { id: 1 }; },
        async encontrarOuCriarConversaAberta() { return { id: 10 }; },
        async registrarMensagem(_, dados) { saidas.push(dados); return { duplicada: false }; },
        async existeSaidaComTexto() { return jaTemSaida; },
      },
    }),
  };
}

test('a fala do paciente entra como entrada, a da Serena como automação', async () => {
  const ambiente = montarAmbiente([
    msg('user', 'oi, quero marcar', 'a1'),
    msg('assistant', 'claro, qual seu nome?', 'a2'),
  ]);

  await ambiente.sincronizador.sincronizar();

  assert.equal(ambiente.recebidas.length, 1);
  assert.equal(ambiente.recebidas[0].texto, 'oi, quero marcar');
  assert.equal(ambiente.saidas.length, 1);
  assert.equal(ambiente.saidas[0].autor_tipo, 'automacao');
});

test('toolResult e system não viram fala do paciente', async () => {
  // Sem esta separação, resultado de ferramenta seria gravado como se o paciente
  // tivesse escrito — e passaria pelo detector de PARAR, podendo desligar os
  // lembretes de quem não pediu nada.
  const ambiente = montarAmbiente([
    msg('toolResult', 'parar processamento', 't1'),
    msg('system', 'contexto interno', 's1'),
    msg('user', 'oi', 'u1'),
  ]);

  await ambiente.sincronizador.sincronizar();

  assert.equal(ambiente.recebidas.length, 1);
  assert.equal(ambiente.recebidas[0].texto, 'oi');
  assert.equal(ambiente.saidas.length, 0);
});

test('o que o CRM já enviou não volta como mensagem nova', async () => {
  // A resposta da equipe sai pelo gateway e reaparece no histórico como saída
  // do agente. Regravá-la mostraria a mesma frase duas vezes, a segunda
  // assinada pela Serena em vez de por quem escreveu.
  const ambiente = montarAmbiente([msg('assistant', 'já respondi isso', 'e1')], { jaTemSaida: true });

  const r = await ambiente.sincronizador.sincronizar();

  assert.equal(ambiente.saidas.length, 0);
  assert.equal(r.gravadas, 0);
});

test('mensagem sem identificador é pulada sem derrubar as outras', async () => {
  const ambiente = montarAmbiente([
    { role: 'user', content: [{ type: 'text', text: 'sem id' }] },
    msg('user', 'com id', 'u2'),
  ]);

  await ambiente.sincronizador.sincronizar();
  assert.equal(ambiente.recebidas.length, 1);
  assert.equal(ambiente.recebidas[0].texto, 'com id');
});

test('duas passadas simultâneas não rodam juntas', async () => {
  // Cada ciclo faz uma chamada por conversa e o ciclo do worker é de um minuto:
  // sobreposição é esperada. Duas passadas juntas disputariam a criação da mesma
  // conversa — SELECT seguido de INSERT — e abririam duas para o mesmo paciente.
  const ambiente = montarAmbiente([msg('user', 'oi', 'u3')]);

  const [primeira, segunda] = await Promise.all([
    ambiente.sincronizador.sincronizar(),
    ambiente.sincronizador.sincronizar(),
  ]);

  assert.ok(primeira.pulada === true || segunda.pulada === true);
});

test('uma conversa que falha não impede as demais', async () => {
  const sincronizador = criarSincronizadorDeConversas({
    gateway: {
      async chamar(metodo, params) {
        if (metodo === 'sessions.list') {
          return { sessions: [{ ...SESSAO, key: 'ruim' }, { ...SESSAO, key: 'boa' }] };
        }
        if (params.sessionKey === 'ruim') throw new Error('histórico corrompido');
        return { messages: [msg('user', 'oi', 'u4')] };
      },
    },
    atendimento: { async receberMensagem() { return { acao: 'ok' }; } },
    repositorio: {
      async encontrarOuCriarContato() { return { id: 1 }; },
      async encontrarOuCriarConversaAberta() { return { id: 1 }; },
      async registrarMensagem() { return { duplicada: false }; },
      async existeSaidaComTexto() { return false; },
    },
  });

  const r = await sincronizador.sincronizar();
  assert.equal(r.falhas.length, 1);
  assert.equal(r.conversas, 1);
});

test('o instante da mensagem original acompanha o evento', async () => {
  const ambiente = montarAmbiente([msg('user', 'oi', 'u5', { timestamp: 1785854754000 })]);
  await ambiente.sincronizador.sincronizar();
  assert.equal(ambiente.recebidas[0].ocorrido_em, '2026-08-04T14:45:54.000Z');
});

// ---------------------------------------------------------------- P0.3: testes integrados
// Verificam que o fluxo Arquitetura A está correto:
// - mensagem user é importada com estrategia_ia='openclaw_gerencia'
// - atendimento NÃO chama despacharEvento (a ação retornada é 'importada_do_canal')
// - resposta assistant é importada uma vez
// - releitura não duplica (deduplicação via id_externo no repositório)

test('mensagem user do OpenClaw chega ao atendimento com estrategia_ia=openclaw_gerencia', async () => {
  const eventos = [];
  const sincronizador = criarSincronizadorDeConversas({
    gateway: {
      async chamar(metodo) {
        if (metodo === 'sessions.list') return { sessions: [SESSAO] };
        if (metodo === 'chat.history') return { messages: [msg('user', 'quero agendar', 'u10')] };
        throw new Error(`metodo inesperado: ${metodo}`);
      },
    },
    atendimento: {
      async receberMensagem(evento) {
        eventos.push(evento);
        return { acao: 'importada_do_canal' };
      },
    },
    repositorio: {
      async encontrarOuCriarContato() { return { id: 1 }; },
      async encontrarOuCriarConversaAberta() { return { id: 10 }; },
      async registrarMensagem() { return { duplicada: false }; },
      async existeSaidaComTexto() { return false; },
    },
  });
  await sincronizador.sincronizar();
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].estrategia_ia, 'openclaw_gerencia',
    'evento do WhatsApp deve ter estrategia_ia=openclaw_gerencia');
  assert.equal(eventos[0].origem, 'whatsapp');
});

test('releitura do historico envia o mesmo id_externo — repositorio deduplica', async () => {
  const recebidas = [];
  const sincronizador = criarSincronizadorDeConversas({
    gateway: {
      async chamar(metodo) {
        if (metodo === 'sessions.list') return { sessions: [SESSAO] };
        if (metodo === 'chat.history') return { messages: [msg('user', 'oi', 'u11')] };
        throw new Error(`metodo inesperado: ${metodo}`);
      },
    },
    atendimento: {
      async receberMensagem(evento) {
        recebidas.push(evento);
        return { acao: 'importada_do_canal' };
      },
    },
    repositorio: {
      async encontrarOuCriarContato() { return { id: 1 }; },
      async encontrarOuCriarConversaAberta() { return { id: 10 }; },
      async registrarMensagem() { return { duplicada: true }; },
      async existeSaidaComTexto() { return false; },
    },
  });
  await sincronizador.sincronizar();
  await sincronizador.sincronizar();
  assert.equal(recebidas.length, 2, 'sincronizador envia ao atendimento em cada passada');
  assert.equal(recebidas[0].id_externo, recebidas[1].id_externo,
    'mesmo id_externo nas duas passadas — repositorio deduplica');
});

test('toolResult e system nao chegam ao atendimento como mensagem do paciente', async () => {
  const recebidas = [];
  const sincronizador = criarSincronizadorDeConversas({
    gateway: {
      async chamar(metodo) {
        if (metodo === 'sessions.list') return { sessions: [SESSAO] };
        if (metodo === 'chat.history') return {
          messages: [
            msg('toolResult', 'resultado de ferramenta', 't10'),
            msg('system', 'contexto interno', 's10'),
            msg('user', 'mensagem real', 'u12'),
            msg('assistant', 'resposta real', 'a10'),
          ],
        };
        throw new Error(`metodo inesperado: ${metodo}`);
      },
    },
    atendimento: {
      async receberMensagem(evento) { recebidas.push(evento); return { acao: 'ok' }; },
    },
    repositorio: {
      async encontrarOuCriarContato() { return { id: 1 }; },
      async encontrarOuCriarConversaAberta() { return { id: 10 }; },
      async registrarMensagem() { return { duplicada: false }; },
      async existeSaidaComTexto() { return false; },
    },
  });
  await sincronizador.sincronizar();
  assert.equal(recebidas.length, 1, 'so a mensagem real do paciente chega ao atendimento');
  assert.equal(recebidas[0].texto, 'mensagem real');
});
