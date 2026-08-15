'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');

// Orquestrador simulado: nenhuma rede, nenhuma credencial real.
function orquestradorFalso(resposta = { resposta: 'Olá! Posso ajudar?' }) {
  const despachos = [];
  return {
    disponivel: true,
    despachos,
    despacharEvento: async (carga) => {
      despachos.push(carga);
      if (resposta instanceof Error) throw resposta;
      return resposta;
    },
  };
}

function montar(resposta) {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso(resposta);
  return { repositorio, orquestrador, atendimento: criarAtendimento({ repositorio, orquestrador }) };
}

function canalFalso({ falhar = false } = {}) {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      envios.push(carga);
      if (falhar) throw new Error('WhatsApp indisponível');
      return { identificador: 'wa-saida-1' };
    },
  };
}

const EVENTO = Object.freeze({
  canal: 'whatsapp',
  // O ciclo completo — despacho, resposta, escalonação — é o fluxo em que o
  // CRM aciona a IA. WhatsApp sem estratégia é recusado fechado (teste próprio
  // em estrategia-ia.test.js); aqui o interesse é a mecânica do ciclo.
  estrategia_ia: 'crm_despacha',
  id_externo: 'wa:1',
  remetente: '5516999999999',
  nome: 'Marina Souza',
  texto: 'Quero saber sobre a primeira consulta',
});

test('mensagem recebida vira contato, conversa e linha no histórico', async () => {
  const { repositorio, atendimento } = montar();

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'respondida_pela_automacao');

  const conversas = await repositorio.listarConversas({});
  assert.equal(conversas.length, 1);
  assert.equal(conversas[0].contato.telefone, '5516999999999');
  assert.equal(conversas[0].contato.nome, 'Marina Souza');
});

test('a resposta do orquestrador é gravada no mesmo histórico da equipe', async () => {
  const { repositorio, orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});
  const mensagens = await repositorio.listarMensagens(conversa.id);

  assert.equal(orquestrador.despachos.length, 1);
  assert.equal(mensagens.length, 2, 'a mensagem do paciente e a resposta ficam juntas');
  assert.equal(mensagens[1].conteudo, 'Olá! Posso ajudar?');
  assert.equal(mensagens[1].autor_tipo, 'automacao');
  assert.equal(mensagens[1].direcao, 'saida');
});

test('Arquitetura B entrega a resposta automática pelo WhatsApp uma única vez', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const canal = canalFalso();
  const atendimento = criarAtendimento({ repositorio, orquestrador, canal });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal(resultado.entregue, true);
  assert.equal(canal.envios.length, 1);
  assert.equal(canal.envios[0].telefone, '5516999999999');
  assert.match(canal.envios[0].chave, /^serena:/);

  await atendimento.receberMensagem(EVENTO);
  assert.equal(canal.envios.length, 1, 'releitura não reenvia a resposta');
});

test('falha de entrega automática escala sem afirmar resposta entregue', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: orquestradorFalso(),
    canal: canalFalso({ falhar: true }),
  });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'escalonada_por_falha_entrega');
  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.obterConversa(conversa.id)).assumida_por_humano, true);
  // Nome canônico da trilha — o mesmo que a view de métricas da Serena lê.
  assert.ok(repositorio._auditoria.some((r) => r.acao === 'resposta_nao_entregue'
    && r.detalhe?.autor === 'automacao'));
});

test('o orquestrador recebe só o contexto mínimo', async () => {
  const { orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const [carga] = orquestrador.despachos;

  assert.equal(carga.contexto.contato.telefone, '5516999999999');
  assert.deepEqual(Object.keys(carga.contexto.contato).sort(), ['identificador', 'nome', 'telefone']);
  assert.ok(!JSON.stringify(carga).includes('email'));
});

test('reentrega da mesma mensagem não gera segunda resposta', async () => {
  const { repositorio, orquestrador, atendimento } = montar();

  await atendimento.receberMensagem(EVENTO);
  const repetida = await atendimento.receberMensagem(EVENTO);

  assert.equal(repetida.acao, 'mensagem_duplicada');
  assert.equal(orquestrador.despachos.length, 1, 'o paciente não pode receber resposta dobrada');

  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 2);
});

test('assumir a conversa pausa a automação', async () => {
  const { repositorio, orquestrador, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, null);
  const assumida = await repositorio.obterConversa(conversa.id);
  assert.equal(assumida.assumida_por_humano, true);

  // Nova mensagem do paciente na conversa assumida não aciona a IA.
  const despachosAntes = orquestrador.despachos.length;
  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:2', texto: 'Continuo aqui' });

  assert.equal(orquestrador.despachos.length, despachosAntes, 'a IA precisa calar');
});

test('assumir deixa registro visível na conversa e na auditoria', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, null);

  const mensagens = await repositorio.listarMensagens(conversa.id);
  const sistema = mensagens.filter((mensagem) => mensagem.tipo === 'sistema');
  assert.equal(sistema.length, 1);
  assert.match(sistema[0].conteudo, /pausada/);

  assert.ok(repositorio._auditoria.some((registro) => registro.acao === 'assumida_por_humano'));
});

test('responder como equipe assume a conversa sem precisar de outro clique', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.responderComoEquipe(conversa.id, 'Bom dia, Marina!', { autorNome: 'Recepção' });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true, 'responder é dizer "eu cuido deste"');

  const mensagens = await repositorio.listarMensagens(conversa.id);
  const daEquipe = mensagens.find((mensagem) => mensagem.autor_tipo === 'equipe');
  assert.equal(daEquipe.conteudo, 'Bom dia, Marina!');
});

test('nota interna não assume a conversa nem cala a IA', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.responderComoEquipe(conversa.id, 'paciente já ligou antes', { privada: true });

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, false);
});

test('liberar devolve a conversa à automação', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, null);
  await atendimento.liberar(conversa.id);

  const liberada = await repositorio.obterConversa(conversa.id);
  assert.equal(liberada.assumida_por_humano, false);
  assert.equal(liberada.atribuido_a, null);
  assert.equal(liberada.ia_pausada_ate, null);
});

// -------------------------------------------- Bug B, item 5: duplicidade de
// eventos operacionais. Achado real desta sessão: `assumir`/`liberar` não
// checavam se a conversa JÁ estava no estado alvo antes de gravar aviso de
// sistema + auditoria de novo — um duplo clique no botão "Assumir" (ou um
// retry de rede sem confirmação) duplicava os dois. Estes testes chamam
// `assumir`/`liberar` duas vezes seguidas para a MESMA conversa, exatamente
// como o duplo clique faria.

test('assumir duas vezes pela mesma pessoa não duplica aviso de sistema nem auditoria', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, 42);
  await atendimento.assumir(conversa.id, 42); // duplo clique / retry sem confirmação

  const mensagens = await repositorio.listarMensagens(conversa.id);
  const avisos = mensagens.filter((mensagem) => mensagem.tipo === 'sistema');
  assert.equal(avisos.length, 1, 'só pode existir UM aviso de "conversa assumida"');

  const auditoria = repositorio._auditoria.filter((registro) => registro.acao === 'assumida_por_humano');
  assert.equal(auditoria.length, 1, 'a segunda chamada não é uma transição de verdade — não audita de novo');

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true);
  assert.equal(depois.atribuido_a, 42);
});

test('assumir por uma pessoa DIFERENTE depois de já assumida é uma transição de verdade e audita', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, 42);
  await atendimento.assumir(conversa.id, 99); // outra pessoa assume — transferência real

  const auditoria = repositorio._auditoria.filter((registro) => registro.acao === 'assumida_por_humano');
  assert.equal(auditoria.length, 2, 'transferência entre pessoas diferentes é uma transição real, não duplicata');

  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.atribuido_a, 99, 'a última pessoa a assumir é quem está com a conversa');
});

test('liberar duas vezes seguidas não duplica auditoria', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.assumir(conversa.id, null);
  await atendimento.liberar(conversa.id);
  await atendimento.liberar(conversa.id); // duplo clique / retry sem confirmação

  const auditoria = repositorio._auditoria.filter((registro) => registro.acao === 'liberada_para_automacao');
  assert.equal(auditoria.length, 1, 'a segunda chamada não é uma transição de verdade — não audita de novo');
});

test('falha do orquestrador escalona para a equipe em vez de travar', async () => {
  const falha = Object.assign(new Error('fora do ar'), { codigo: 'openclaw_resposta_invalida' });
  const { repositorio, atendimento } = montar(falha);

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'escalonada_por_falha');

  const [conversa] = await repositorio.listarConversas({});
  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true, 'a conversa não pode ficar órfã');
});

test('sem orquestrador configurado, a conversa é escalonada para a equipe — Comando 7, achado A-2', async () => {
  // Antes deste achado: `sem_orquestrador` era tratado como resultado "resolvido"
  // pela outbox (ver decidirDesfecho em automacao-outbox.js) e a função
  // devolvia sem chamar `escalonar` nenhuma vez — a conversa ficava "aberta",
  // sem `assumida_por_humano`, sem aviso de sistema, sem ninguém sabendo que o
  // paciente não teve resposta. Falta de configuração não é transitória: não
  // adianta reagendar e tentar de novo (o valor de `disponivel` vem de config
  // estática, não muda sozinho entre tentativas) — o mesmo raciocínio que já
  // vale para `motor_ia_nao_configurado` (mais abaixo em `atendimento.js`) e
  // para `falha_no_orquestrador`. Escalação imediata, não retentativa.
  const repositorio = criarRepositorioEmMemoria();
  const atendimento = criarAtendimento({
    repositorio,
    orquestrador: { disponivel: false, despacharEvento: async () => { throw new Error('não deveria'); } },
  });

  const resultado = await atendimento.receberMensagem(EVENTO);
  assert.equal(resultado.acao, 'escalonada_para_equipe');
  assert.equal(resultado.motivo, 'openclaw_nao_configurado');

  // A mensagem não se perde: está gravada e esperando.
  const [conversa] = await repositorio.listarConversas({});
  assert.equal((await repositorio.listarMensagens(conversa.id)).length, 2, 'a mensagem do paciente + o aviso de escalonamento');

  // A conversa vai para a equipe de verdade — não fica "aberta" sem dono.
  const depois = await repositorio.obterConversa(conversa.id);
  assert.equal(depois.assumida_por_humano, true, 'a conversa não pode ficar órfã, sem ninguém saber que não foi respondida');
});

test('definir temperatura preserva as etiquetas da equipe e reflete no lead', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await repositorio.definirEtiquetasDaConversa(conversa.id, ['pagou_sinal', 'avaliacao']);
  const resultado = await atendimento.definirTemperatura(conversa.id, 'frio');

  assert.ok(resultado.etiquetas.includes('pagou_sinal'));
  assert.ok(resultado.etiquetas.includes('avaliacao'));
  assert.ok(resultado.etiquetas.includes('lead_frio'));

  const [lead] = await repositorio.listarLeads();
  assert.equal(lead.temperatura, 'frio', 'o lead não pode discordar da etiqueta');
});

test('a temperatura marcada pela equipe não é sobrescrita pela automação', async () => {
  const { repositorio, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await atendimento.definirTemperatura(conversa.id, 'frio');
  const sugestao = await atendimento.sincronizarTemperatura(conversa.id);

  assert.equal(sugestao.origem, 'etiqueta_da_equipe');
  assert.deepEqual(await repositorio.listarEtiquetasDaConversa(conversa.id), ['lead_frio']);
});

test('conversa resolvida não recebe resposta automática', async () => {
  const { repositorio, orquestrador, atendimento } = montar();
  await atendimento.receberMensagem(EVENTO);
  const [conversa] = await repositorio.listarConversas({});

  await repositorio.atualizarConversa(conversa.id, { status: 'resolvida' });
  const despachosAntes = orquestrador.despachos.length;

  const resultado = await atendimento.responderSePossivel(conversa.id);
  assert.equal(resultado.acao, 'aguardando_equipe');
  assert.equal(resultado.motivo, 'conversa_resolvida');
  assert.equal(orquestrador.despachos.length, despachosAntes);
});

// ---------------------------------------------------------------- opt-out pelo canal
//
// "PARAR" precisa valer na hora em que a mensagem chega. Esperar alguém da
// equipe ler e clicar em algo deixaria a pessoa que acabou de pedir para não
// receber nada recebendo o próximo lembrete — que é exatamente o que ela pediu
// para evitar.

/** Fila simulada: registra os opt-outs sem depender do serviço inteiro. */
function filaDeLembretesFalsa() {
  const registros = [];
  return {
    registros,
    definirOptOut: async (contatoId, opcoes) => {
      registros.push({ contatoId, ...opcoes });
      return { contato: { id: contatoId }, cancelados: [] };
    },
  };
}

test('"PARAR" pelo canal desliga os lembretes do contato na hora', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const lembretes = filaDeLembretesFalsa();
  const atendimento = criarAtendimento({ repositorio, orquestrador, lembretes });

  await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:parar', texto: 'PARAR' });

  assert.equal(lembretes.registros.length, 1);
  assert.equal(lembretes.registros[0].optout, true);
  assert.equal(lembretes.registros[0].origem, 'contato');
});

test('mensagem comum não desliga lembrete de ninguém', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const lembretes = filaDeLembretesFalsa();
  const atendimento = criarAtendimento({ repositorio, orquestrador, lembretes });

  // A frase contém "parar" e não é um pedido de descadastro.
  await atendimento.receberMensagem({
    ...EVENTO, id_externo: 'wa:duvida', texto: 'posso parar de tomar o remédio antes da consulta?',
  });

  assert.equal(lembretes.registros.length, 0);
});

test('falha ao registrar o opt-out não derruba o atendimento', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = orquestradorFalso();
  const lembretes = { definirOptOut: async () => { throw new Error('banco fora do ar'); } };
  const atendimento = criarAtendimento({ repositorio, orquestrador, lembretes });

  const resultado = await atendimento.receberMensagem({ ...EVENTO, id_externo: 'wa:parar2', texto: 'parar' });

  // A mensagem entrou no inbox e a conversa seguiu: a fila é acessório.
  assert.equal(resultado.acao, 'respondida_pela_automacao');
  assert.equal((await repositorio.listarConversas({})).length, 1);
});
