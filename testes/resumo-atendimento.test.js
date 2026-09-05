'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarResumoDeAtendimento } = require('../src/dominio/resumo-atendimento');

// Repositório falso: o interesse aqui é a ORDEM entre marcar e entregar, não o
// banco. `marcadas` é a prova de que a conversa saiu (ou não) da varredura.
function repositorioFalso({ conversas = [{ id: 7, contato_id: 3 }] } = {}) {
  const marcadas = [];
  const auditorias = [];
  let restantes = conversas.slice();

  return {
    marcadas,
    auditorias,
    async listarConversasSemResumo() {
      return restantes;
    },
    async obterContato() {
      return { id: 3, nome: 'Joana', telefone: '+5516999990000' };
    },
    async listarMensagens() {
      return [{ autor_tipo: 'contato', conteudo: 'tenho 40 anos e dor no joelho ha um mes' }];
    },
    async obterAgendamentoDoContato() { return null; },
    async obterLeadPorContato() { return null; },
    async marcarResumoEnviado(id) {
      marcadas.push(id);
      restantes = restantes.filter((conversa) => conversa.id !== id);
    },
    async registrarAuditoria(registro) {
      auditorias.push(registro);
    },
  };
}

function canalFalso({ falharEm = [] } = {}) {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      if (falharEm.includes(carga.telefone)) throw new Error('o gateway não confirmou o envio');
      envios.push(carga);
      return { identificador: 'wa-1' };
    },
  };
}

const EQUIPE = ['+5516992943215', '+5516993624116'];

test('entrega confirmada marca a conversa como resumida', async () => {
  const repositorio = repositorioFalso();
  const canal = canalFalso();
  const resumo = criarResumoDeAtendimento({ repositorio, canal, destinatarios: EQUIPE });

  const resultado = await resumo.enviarPendentes();

  assert.equal(resultado.enviados, 1);
  assert.equal(resultado.nao_entregues, 0);
  assert.deepEqual(repositorio.marcadas, [7]);
  assert.equal(canal.envios.length, 2);
  assert.equal(repositorio.auditorias.length, 0);
});

test('quando NINGUÉM recebe, a conversa não é marcada e o ciclo seguinte tenta de novo', async () => {
  // O defeito real: `marcarResumoEnviado` rodava antes do envio, então uma
  // falha de canal apagava o resumo para sempre — a conversa saía da varredura
  // sem ninguém ter recebido nada.
  const repositorio = repositorioFalso();
  const canal = canalFalso({ falharEm: EQUIPE });
  const resumo = criarResumoDeAtendimento({ repositorio, canal, destinatarios: EQUIPE });

  const primeiro = await resumo.enviarPendentes();

  assert.equal(primeiro.enviados, 0);
  assert.equal(primeiro.nao_entregues, 1);
  assert.deepEqual(repositorio.marcadas, [], 'não pode marcar o que não foi entregue');

  // O canal volta; o mesmo resumo precisa sair no ciclo seguinte.
  const canalDeVolta = canalFalso();
  const resumoDeVolta = criarResumoDeAtendimento({ repositorio, canal: canalDeVolta, destinatarios: EQUIPE });
  const segundo = await resumoDeVolta.enviarPendentes();

  assert.equal(segundo.enviados, 1);
  assert.deepEqual(repositorio.marcadas, [7]);
});

test('falha total de entrega vira auditoria — o log do worker não é lido por ninguém', async () => {
  const repositorio = repositorioFalso();
  const canal = canalFalso({ falharEm: EQUIPE });
  const resumo = criarResumoDeAtendimento({ repositorio, canal, destinatarios: EQUIPE });

  await resumo.enviarPendentes();

  assert.equal(repositorio.auditorias.length, 1);
  const registro = repositorio.auditorias[0];
  assert.equal(registro.acao, 'resumo_nao_entregue');
  assert.equal(registro.entidade, 'conversa');
  assert.equal(registro.entidadeId, 7);
  assert.equal(registro.detalhe.confirmados, 0);
  assert.equal(registro.detalhe.falhados, 2);
  const serializado = JSON.stringify(registro.detalhe);
  for (const numero of EQUIPE) {
    assert.ok(!serializado.includes(numero), 'telefone de pessoa não entra no detalhe de auditoria');
  }
});

test('entrega parcial marca a conversa e registra quem ficou de fora', async () => {
  // Reenviar tudo mandaria o resumo duas vezes para quem já leu, e resumo
  // repetido é o começo de a equipe parar de ler os resumos.
  const repositorio = repositorioFalso();
  const canal = canalFalso({ falharEm: [EQUIPE[1]] });
  const resumo = criarResumoDeAtendimento({ repositorio, canal, destinatarios: EQUIPE });

  const resultado = await resumo.enviarPendentes();

  assert.equal(resultado.enviados, 1);
  assert.deepEqual(repositorio.marcadas, [7]);
  assert.equal(repositorio.auditorias[0].acao, 'resumo_parcialmente_entregue');
  assert.equal(repositorio.auditorias[0].detalhe.confirmados, 1);
});

test('sem destinatários não há resumo — e a varredura nem consulta o banco', async () => {
  const repositorio = repositorioFalso();
  const resumo = criarResumoDeAtendimento({ repositorio, canal: canalFalso(), destinatarios: [] });

  assert.equal(resumo.ativo, false);
  const resultado = await resumo.enviarPendentes();
  assert.equal(resultado.enviados, 0);
  assert.deepEqual(repositorio.marcadas, []);
});

test('o worker de lembretes nunca monta o canal sem as vias de entrega', () => {
  // Regressão real: `criarCanalDeConversas(configuracao.openclaw.canalClinica)`
  // sem o segundo argumento deixa o worker preso ao gateway WebSocket da
  // clínica — o mesmo que esteve parado no VPS enquanto a Evolution entregava
  // mensagem a paciente o dia inteiro. `http.js` e `worker-outbox.js` sempre
  // injetaram as vias; só este worker não.
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'bin', 'worker-lembretes.js'), 'utf8');
  const chamadas = fonte.match(/criarCanalDeConversas\([^)]*\)/g) ?? [];

  assert.ok(chamadas.length > 0, 'o worker precisa montar o canal em algum lugar');
  for (const chamada of chamadas) {
    assert.match(chamada, /,\s*viasDeEntrega\s*\)$/, `montagem sem vias de entrega: ${chamada}`);
  }
});
