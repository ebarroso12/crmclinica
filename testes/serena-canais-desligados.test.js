'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decidirResposta, canalDesligado, CANAIS_SILENCIAVEIS } = require('../src/dominio/serena');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');

// Canal calado sem desligar a automação inteira (migration 048).
//
// Pedido de 12/09/2026: atender no Instagram com o WhatsApp da clínica calado.
// O que estes testes protegem, em ordem de gravidade:
//
//   1. o desligamento GERAL continua soberano — ligar um canal não fura a
//      parada de emergência;
//   2. um canal só é calado quando alguém o pôs na lista. Lista ausente,
//      vazia, nula ou com lixo NÃO pode calar ninguém: o fail-open aqui é o
//      seguro, porque o estado "não sei" só existe quando ninguém configurou;
//   3. calar um canal não fura as camadas por conversa (humano assumiu etc.).

// ---------------------------------------------------------------- decisão pura

test('canal na lista não responde, mesmo com tudo o mais liberado', () => {
  const decisao = decidirResposta(
    { status: 'aberta', canal: 'whatsapp' },
    { ativa: true, canais_desligados: ['whatsapp'] },
  );
  assert.deepEqual(decisao, { responder: false, motivo: 'canal_desligado', escopo: 'canal' });
});

test('o outro canal segue respondendo — é o pedido inteiro: Instagram no ar, WhatsApp calado', () => {
  const configuracao = { ativa: true, canais_desligados: ['whatsapp'] };
  assert.equal(decidirResposta({ status: 'aberta', canal: 'instagram' }, configuracao).responder, true);
  assert.equal(decidirResposta({ status: 'aberta', canal: 'whatsapp' }, configuracao).responder, false);
});

test('o desligamento geral continua soberano: canal ligado não fura a parada', () => {
  const decisao = decidirResposta(
    { status: 'aberta', canal: 'instagram' },
    { ativa: false, canais_desligados: [] },
  );
  assert.equal(decisao.motivo, 'serena_desligada', 'a parada de emergência vale para todos os canais');
});

test('canal calado vence o plantão esporádico: é desligamento, não horário', () => {
  const daquiUmaHora = new Date(Date.now() + 3600_000);
  const decisao = decidirResposta(
    { status: 'aberta', canal: 'whatsapp' },
    { ativa: true, canais_desligados: ['whatsapp'], ligada_ate: daquiUmaHora },
    new Date(),
  );
  assert.equal(decisao.motivo, 'canal_desligado', 'o plantão fura o horário, nunca o desligamento');
});

test('a pausa humana vem antes do canal: quem pausou está resolvendo algo agora', () => {
  const daquiUmaHora = new Date(Date.now() + 3600_000);
  const decisao = decidirResposta(
    { status: 'aberta', canal: 'instagram' },
    { ativa: true, canais_desligados: ['whatsapp'], pausada_ate: daquiUmaHora },
    new Date(),
  );
  assert.equal(decisao.motivo, 'serena_pausada');
});

test('calar um canal não libera conversa assumida por humano no canal que responde', () => {
  const decisao = decidirResposta(
    { status: 'aberta', canal: 'instagram', assumida_por_humano: true },
    { ativa: true, canais_desligados: ['whatsapp'] },
  );
  assert.equal(decisao.motivo, 'assumida_por_humano');
});

// ---------------------------------------------------------------- nada cala por acidente

test('sem lista, com lista vazia ou com lista inválida, nenhum canal é calado', () => {
  for (const canais of [undefined, null, [], 'whatsapp', {}, 0]) {
    assert.equal(
      canalDesligado('whatsapp', canais), false,
      `canais_desligados=${JSON.stringify(canais)} não pode calar ninguém`,
    );
  }
});

test('banco sem a 048 responde como antes da migration', () => {
  // `obterConfiguracaoDaSerena` devolve [] quando a coluna não existe; aqui a
  // configuração chega sem a chave, que é o mesmo caso visto de outro ângulo.
  const decisao = decidirResposta({ status: 'aberta', canal: 'whatsapp' }, { ativa: true });
  assert.equal(decisao.responder, true);
});

test('canal sem interruptor próprio (site, formulário, interno) ignora a lista', () => {
  for (const canal of ['site', 'formulario', 'interno']) {
    assert.equal(
      canalDesligado(canal, [canal]), false,
      `${canal} não é silenciável: uma lista estranha não pode calá-lo`,
    );
  }
  assert.deepEqual(CANAIS_SILENCIAVEIS, ['whatsapp', 'instagram']);
});

test('comparação de canal não depende de caixa nem de espaço em volta', () => {
  assert.equal(canalDesligado('WhatsApp', ['whatsapp']), true);
  assert.equal(canalDesligado('whatsapp', ['  WHATSAPP  ']), true);
  assert.equal(canalDesligado(null, ['whatsapp']), false);
});

// ---------------------------------------------------------------- serviço

function repositorioFalso({ configuracao = { ativa: true, canais_desligados: [] } } = {}) {
  const gravados = [];
  const auditorias = [];
  return {
    gravados,
    auditorias,
    async obterConfiguracaoDaSerena() { return { ...configuracao }; },
    async definirCanaisDesligadosDaSerena({ canais, usuarioId }) {
      gravados.push({ canais, usuarioId });
      return { ...configuracao, canais_desligados: canais };
    },
    async registrarAuditoria(evento) { auditorias.push(evento); },
  };
}

test('o serviço normaliza, tira repetido e grava a lista inteira', async () => {
  const repositorio = repositorioFalso();
  const serena = criarServicoDaSerena({ repositorio });

  const resultado = await serena.definirCanaisDesligados([' WhatsApp ', 'whatsapp'], { usuarioId: 7 });

  assert.deepEqual(repositorio.gravados, [{ canais: ['whatsapp'], usuarioId: 7 }]);
  assert.deepEqual(resultado.canais_desligados, ['whatsapp']);
});

test('o serviço recusa canal que não tem interruptor próprio', async () => {
  const serena = criarServicoDaSerena({ repositorio: repositorioFalso() });
  await assert.rejects(
    () => serena.definirCanaisDesligados(['site']),
    (erro) => erro.codigo === 'canal_nao_silenciavel',
  );
});

test('o serviço recusa qualquer coisa que não seja lista', async () => {
  const serena = criarServicoDaSerena({ repositorio: repositorioFalso() });
  for (const entrada of ['whatsapp', null, undefined, 3, {}]) {
    await assert.rejects(
      () => serena.definirCanaisDesligados(entrada),
      (erro) => erro.codigo === 'canais_invalidos',
      `entrada ${JSON.stringify(entrada)} deveria ser recusada`,
    );
  }
});

test('lista vazia devolve a voz a todos os canais', async () => {
  const repositorio = repositorioFalso({ configuracao: { ativa: true, canais_desligados: ['whatsapp'] } });
  const serena = criarServicoDaSerena({ repositorio });

  await serena.definirCanaisDesligados([]);
  assert.deepEqual(repositorio.gravados, [{ canais: [], usuarioId: null }]);
});

test('a mudança fica auditada com o antes e o depois', async () => {
  const repositorio = repositorioFalso({ configuracao: { ativa: true, canais_desligados: [] } });
  const serena = criarServicoDaSerena({ repositorio });

  await serena.definirCanaisDesligados(['whatsapp'], { usuarioId: 4 });

  const evento = repositorio.auditorias.find((a) => a.acao === 'serena_canais_desligados');
  assert.ok(evento, 'calar um canal é decisão operacional: tem de deixar rastro');
  assert.deepEqual(evento.detalhe, { de: [], para: ['whatsapp'] });
  assert.equal(evento.usuarioId, 4);
});

test('a decisão do serviço usa o canal da conversa, ponta a ponta', async () => {
  const repositorio = repositorioFalso({ configuracao: { ativa: true, canais_desligados: ['whatsapp'] } });
  const serena = criarServicoDaSerena({ repositorio });

  assert.equal((await serena.podeResponder({ status: 'aberta', canal: 'instagram' })).responder, true);
  const calado = await serena.podeResponder({ status: 'aberta', canal: 'whatsapp' });
  assert.equal(calado.responder, false);
  assert.equal(calado.motivo, 'canal_desligado');
});
