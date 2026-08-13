'use strict';

// A barreira final antes do envio.
//
// `serena.podeResponder` é consultado no início de `responderSePossivel`,
// mas entre aquela leitura e o envio real passam a extração de qualificação,
// a chamada de IA (rede, pode levar dezenas de segundos) e a gravação da
// resposta. Estes testes provam que um Desligar, Pausar, Assumir ou PARAR
// SERENA que acontece NESSE INTERVALO ainda impede o envio — e que a
// verificação de controle é fail-closed, sem estado contraditório em clique
// duplo, e auditada sem conteúdo clínico.
//
// O truque para simular "a IA está gerando e o controle muda no meio" sem
// temporizador nenhum: o orquestrador falso muda o controle dentro do seu
// próprio `despacharEvento`, antes de devolver a resposta — é o mesmo efeito
// de uma chamada de rede lenta, determinístico e instantâneo no teste.

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { criarServicoDaSerena } = require('../src/dominio/serena-servico');

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:barreira:1',
  remetente: '5516999999999',
  nome: 'Marina Souza',
  texto: 'Quero saber sobre a primeira consulta',
});

function canalFalso() {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      envios.push(carga);
      return { identificador: 'wa-saida-1' };
    },
  };
}

/** Orquestrador cuja resposta só chega depois que `duranteAGeracao` terminar. */
function orquestradorComGeracaoLenta(texto, duranteAGeracao) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    async despacharEvento(carga) {
      despachos.push(carga);
      await duranteAGeracao();
      return { resposta: texto };
    },
  };
}

/** Igual ao repositório em memória, mas com um gancho antes de `listarMensagens`
 * devolver — é o ponto de "espera" natural do caminho de retentativa
 * (`respostaAnterior`), sem precisar mexer no relógio. */
function repositorioComGanchoAntesDaRetentativa(base, gancho) {
  return {
    ...base,
    async listarMensagens(...args) {
      const resultado = await base.listarMensagens(...args);
      await gancho();
      return resultado;
    },
  };
}

async function prepararConversa({ repositorio, orquestrador = { disponivel: true, despacharEvento: async () => ({ resposta: 'oi' }) } }) {
  const atendimentoDeSetup = criarAtendimento({ repositorio, orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } } });
  await atendimentoDeSetup.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
  const [mensagemDeEntrada] = await repositorio.listarMensagens(conversa.id);
  return { conversa, mensagemEntradaId: mensagemDeEntrada.id };
}

test('1. Serena desligada durante a geração: a resposta não pode ser entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const { conversa, mensagemEntradaId } = await prepararConversa({ repositorio });

  const orquestrador = orquestradorComGeracaoLenta('Resposta gerada com a Serena ainda ligada', async () => {
    // "Enquanto a IA gera" — a equipe clica em Desligar.
    await serena.definirAtiva(false, { motivo: 'incidente em teste', usuarioId: null });
  });
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, serena });

  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId });

  assert.equal(canal.envios.length, 0, 'entregarAoPaciente não pode ter chamado o canal (nem Evolution, nem OpenClaw)');
  assert.equal(resultado.acao, 'resposta_abortada_por_controle');
  assert.equal(resultado.motivo, 'serena_desligada');
  assert.ok(
    repositorio._auditoria.some((r) => r.acao === 'envio_abortado_por_controle' && r.detalhe?.motivo === 'serena_desligada'),
    'precisa existir auditoria explícita do aborto',
  );
});

test('2. Conversa assumida durante a geração: a resposta não pode ser entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const { conversa, mensagemEntradaId } = await prepararConversa({ repositorio });

  let atendimento;
  const orquestrador = orquestradorComGeracaoLenta('Resposta gerada antes de a conversa ser assumida', async () => {
    // "Enquanto a IA gera" — a secretária clica em Assumir.
    await atendimento.assumir(conversa.id, null);
  });
  atendimento = criarAtendimento({ repositorio, orquestrador, canal, serena });

  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId });

  assert.equal(canal.envios.length, 0);
  assert.equal(resultado.acao, 'resposta_abortada_por_controle');
  assert.equal(resultado.motivo, 'assumida_por_humano');
});

test('3. Pausa aplicada durante a geração: a resposta não pode ser entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const { conversa, mensagemEntradaId } = await prepararConversa({ repositorio });

  const orquestrador = orquestradorComGeracaoLenta('Resposta gerada antes da pausa', async () => {
    // "Enquanto a IA gera" — alguém pausa por 15 minutos.
    await serena.pausar(15, { usuarioId: null });
  });
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, serena });

  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId });

  assert.equal(canal.envios.length, 0);
  assert.equal(resultado.acao, 'resposta_abortada_por_controle');
  assert.equal(resultado.motivo, 'serena_pausada');
});

test('4. O controle muda durante uma retentativa: a retentativa é cancelada', async () => {
  // Cenário: a resposta já foi gerada e gravada numa chamada anterior (queda
  // entre gravar e entregar — o comentário do próprio código em
  // `responderSePossivel` descreve exatamente isso). A retentativa reaproveita
  // o texto gravado e vai direto para `entregarAoPaciente`, sem chamar a IA de
  // novo — e é bem aí, na espera por `listarMensagens`, que o controle muda.
  const base = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio: base });
  const canal = canalFalso();

  const atendimentoDeSetup = criarAtendimento({ repositorio: base, serena, canal, orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } } });
  await atendimentoDeSetup.receberMensagem(EVENTO);
  const [conversa] = await base.listarConversas({});
  const [mensagemDeEntrada] = await base.listarMensagens(conversa.id);

  // Simula a resposta já gravada, mas nunca entregue (a queda aconteceu entre
  // as duas coisas) — mesma chave que `responderSePossivel` calcularia.
  await base.registrarMensagem(conversa.id, {
    direcao: 'saida',
    conteudo: 'Resposta gravada antes da queda, nunca entregue',
    autor_tipo: 'automacao',
    autor_nome: 'Serena',
    id_externo: `serena:resposta:${conversa.id}:${mensagemDeEntrada.id}`,
  });

  const repositorioComGancho = repositorioComGanchoAntesDaRetentativa(base, async () => {
    // A retentativa já passou pela checagem do início de `responderSePossivel`
    // (Serena ainda ligada); o controle muda só agora, entre achar as
    // mensagens e chamar `entregarAoPaciente`.
    await serena.despausar({ usuarioId: null }); // no-op proposital: prova que despausar não interfere
    await serena.definirAtiva(false, { motivo: 'mudou no meio da retentativa', usuarioId: null });
  });
  const atendimento = criarAtendimento({
    repositorio: repositorioComGancho, serena, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => { throw new Error('a retentativa não pode chamar a IA de novo'); } },
  });

  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId: mensagemDeEntrada.id });

  assert.equal(canal.envios.length, 0, 'a retentativa não pode ter entregue nada');
  assert.equal(resultado.acao, 'resposta_abortada_por_controle');
  assert.equal(resultado.motivo, 'serena_desligada');
});

test('5. Clique duplo em desligar não cria estado contraditório', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });

  // Dois cliques em "Desligar Serena" quase simultâneos (o duplo clique que a
  // interface deveria impedir, mas o backend não pode depender disso).
  const [primeiro, segundo] = await Promise.allSettled([
    serena.definirAtiva(false, { motivo: 'duplo clique 1', usuarioId: null }),
    serena.definirAtiva(false, { motivo: 'duplo clique 2', usuarioId: null }),
  ]);

  assert.equal(primeiro.status, 'fulfilled');
  assert.equal(segundo.status, 'fulfilled');

  const configuracaoFinal = await serena.obterConfiguracao();
  assert.equal(configuracaoFinal.ativa, false, 'o estado final tem que ser desligada, sem ambiguidade');

  // Uma mensagem nova, depois do duplo clique, tem que ser silenciada — não
  // pode haver um meio-termo onde a automação "meio que" responde.
  const canal = canalFalso();
  const atendimento = criarAtendimento({
    repositorio, serena, canal,
    orquestrador: { disponivel: true, despacharEvento: async () => { throw new Error('não deveria despachar com a Serena desligada'); } },
  });
  const resultado = await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:barreira:duplo-clique' });

  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'serena_desligada');
  assert.equal(canal.envios.length, 0);
});

test('6. Falha ao reler o estado é fail-closed: não envia', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const { conversa, mensagemEntradaId } = await prepararConversa({ repositorio });

  // Simula o banco caindo bem no instante da releitura final: `obterConversa`
  // (chamado de novo por `podeEntregarAgora`, não a leitura do início) falha.
  let chamadas = 0;
  const repositorioInstavel = {
    ...repositorio,
    async obterConversa(id) {
      chamadas += 1;
      if (chamadas > 1) throw new Error('banco fora do ar bem na hora de entregar');
      return repositorio.obterConversa(id);
    },
  };

  const orquestrador = orquestradorComGeracaoLenta('Resposta gerada, mas o banco cai antes do envio', async () => {});
  const atendimento = criarAtendimento({ repositorio: repositorioInstavel, orquestrador, canal, serena });

  const resultado = await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId });

  assert.equal(canal.envios.length, 0, 'não saber se pode responder não pode virar "responde assim mesmo"');
  assert.equal(resultado.acao, 'resposta_abortada_por_controle');
  assert.equal(resultado.motivo, 'falha_ao_reler_controle');
});

test('7. O aborto por controle é auditado com motivo explícito, sem conteúdo clínico', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const serena = criarServicoDaSerena({ repositorio });
  const canal = canalFalso();
  const { conversa, mensagemEntradaId } = await prepararConversa({ repositorio });

  const TEXTO_GERADO = 'Sua dosagem de sertralina deve continuar 50mg, conforme combinado';
  const orquestrador = orquestradorComGeracaoLenta(TEXTO_GERADO, async () => {
    await serena.definirAtiva(false, { motivo: 'teste de auditoria', usuarioId: null });
  });
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal, serena });

  await atendimento.responderSePossivel(conversa.id, { mensagemEntradaId });

  const registro = repositorio._auditoria.find((r) => r.acao === 'envio_abortado_por_controle');
  assert.ok(registro, 'precisa existir o registro de auditoria');
  assert.equal(registro.entidade, 'conversa');
  assert.equal(registro.entidadeId, conversa.id);
  assert.equal(registro.detalhe.motivo, 'serena_desligada');
  assert.ok(Number.isInteger(registro.detalhe.mensagem_id), 'precisa trazer um identificador técnico');

  // O texto gerado pela IA (que pode conter informação clínica) não pode
  // aparecer em canto nenhum do registro de auditoria deste aborto.
  const serializado = JSON.stringify(registro);
  assert.ok(!serializado.includes(TEXTO_GERADO), 'a auditoria não pode carregar o conteúdo da resposta');
  assert.ok(!serializado.includes('sertralina'), 'nada clínico pode vazar para a auditoria');
});
