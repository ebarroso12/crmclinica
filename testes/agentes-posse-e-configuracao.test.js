'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarServicoDeOutbox } = require('../src/dominio/automacao-outbox-servico');
const { configuracaoDeTeste } = require('./auxiliar');

// Duas garantias pequenas da reauditoria dos agentes, com peças falsas:
//   - a outbox entrega ao atendimento um `renovarPosse` ligado ao lease do
//     trabalho e NÃO conclui um trabalho cujo fluxo parou por posse perdida;
//   - a lista de instâncias da clínica inclui sozinha a instância de envio.
// NÃO prova concorrência real entre processos (isso só contra PostgreSQL).

function trabalhoDeTeste() {
  return {
    id: 5, conversa_id: 50, mensagem_entrada_id: 1, status: 'processando',
    tentativas: 0, max_tentativas: 5, criado_em: new Date().toISOString(),
  };
}

test('posse perdida no meio do processamento: a outbox não conclui, não reagenda e não escala', async () => {
  const concluidos = [];
  const renovacoes = [];
  const auditorias = [];
  const escalonamentos = [];
  const trabalho = trabalhoDeTeste();

  const repositorio = {
    async registrarAuditoria(entrada) { auditorias.push(entrada); },
    async liberarTrabalhosDeOutboxPresos() { return []; },
    async reivindicarTrabalhosDeOutbox() { return [trabalho]; },
    async renovarReivindicacaoDeOutbox(id, dados) { renovacoes.push({ id, ...dados }); return { ...trabalho }; },
    async concluirTrabalhoDeOutbox(id, dados) { concluidos.push({ id, dados }); return {}; },
  };
  let opcoesRecebidas = null;
  const atendimento = {
    async responderSePossivel(conversaId, opcoes) {
      opcoesRecebidas = opcoes;
      await opcoes.renovarPosse();
      return { acao: 'posse_perdida', conversa_id: conversaId, possePerdida: true };
    },
    async escalonar(conversaId, motivo) { escalonamentos.push(motivo); },
  };

  const servico = criarServicoDeOutbox({ repositorio, atendimento });
  const resultado = await servico.processarLote({ limite: 1, worker: 'worker-a' });

  assert.equal(opcoesRecebidas.mensagemEntradaId, 1);
  assert.equal(typeof opcoesRecebidas.renovarPosse, 'function');
  assert.deepEqual(renovacoes.map((item) => [item.id, item.worker]), [[5, 'worker-a'], [5, 'worker-a']],
    'renova na entrada (como antes) e de novo quando o fluxo confere a posse');
  assert.equal(concluidos.length, 0, 'quem perdeu a posse não pisa no trabalho do outro worker');
  assert.equal(escalonamentos.length, 0);
  assert.equal(resultado.resultados[0].status, 'lease_perdido');
  assert.ok(auditorias.some((item) => item.acao === 'outbox_lease_perdido'));
});

test('sem posse perdida, o desfecho segue exatamente o caminho de sempre', async () => {
  const concluidos = [];
  const trabalho = trabalhoDeTeste();
  const repositorio = {
    async registrarAuditoria() {},
    async liberarTrabalhosDeOutboxPresos() { return []; },
    async reivindicarTrabalhosDeOutbox() { return [trabalho]; },
    async renovarReivindicacaoDeOutbox() { return { ...trabalho }; },
    async concluirTrabalhoDeOutbox(id, dados) { concluidos.push({ id, dados }); return {}; },
  };
  const atendimento = {
    async responderSePossivel(conversaId) { return { acao: 'respondida_pela_automacao', conversa_id: conversaId }; },
    async escalonar() {},
  };

  const resultado = await criarServicoDeOutbox({ repositorio, atendimento }).processarLote({ limite: 1, worker: 'w' });

  assert.equal(resultado.concluidos, 1);
  assert.deepEqual(concluidos, [{ id: 5, dados: { status: 'concluido' } }]);
});

test('instâncias da clínica: vazia desliga a proteção; preenchida inclui sozinha a instância de envio', () => {
  const instancias = (ambiente) => configuracaoDeTeste(ambiente).evolution.instanciasDaClinica;

  assert.deepEqual(instancias({}), []);
  assert.deepEqual(instancias({ EVOLUTION_INSTANCE: 'Clinica' }), [], 'sem a lista, nada muda');
  assert.deepEqual(instancias({ EVOLUTION_INSTANCIAS_CLINICA: 'clinica-2', EVOLUTION_INSTANCE: 'Clinica' }), ['clinica-2', 'Clinica']);
  assert.deepEqual(instancias({ EVOLUTION_INSTANCIAS_CLINICA: 'clinica, outra ', EVOLUTION_INSTANCE: 'CLINICA' }), ['clinica', 'outra'],
    'não repete a de envio quando ela já está na lista (sem diferenciar maiúsculas)');
});
