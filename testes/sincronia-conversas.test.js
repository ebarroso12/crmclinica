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

function montarAmbiente(mensagens, { jaTemSaida = false, estrategiaIa = 'openclaw_gerencia' } = {}) {
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
      estrategiaIa,
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

test('Arquitetura B carimba a entrada como crm_despacha', async () => {
  const ambiente = montarAmbiente([msg('user', 'oi', 'b1')], { estrategiaIa: 'crm_despacha' });
  await ambiente.sincronizador.sincronizar();
  assert.equal(ambiente.recebidas.length, 1);
  assert.equal(ambiente.recebidas[0].estrategia_ia, 'crm_despacha');
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
