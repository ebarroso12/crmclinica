'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { subirServidor, configuracaoDeTeste } = require('./auxiliar');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { validarAgente } = require('../src/dominio/agentes/regras');

// Auditoria independente de ACESSO sobre 42939cf (docs/AGENTES.md, "Quem vê o quê").
// Regra que resolve a família: o colaborador (não vê a clínica) recebe dado de
// contato por LISTA BRANCA; nenhuma escrita dele toca tabela da clínica; e
// conversa de agente nunca carrega nem altera lead da clínica, para ninguém.
//
// Perfis: admin; gestorClinica (vê a clínica, fora da equipe); gestorAlpins (vê
// a clínica e está na equipe); loja (atendente, NÃO vê a clínica, equipe do
// Alpins); gestorLoja (GESTOR, NÃO vê a clínica, equipe do Alpins) — o perfil
// que a auditoria usou para ler e apagar dado clínico.

const SIGILOS = Object.freeze([
  'sigilo@clinica.test', 'OBS-CLINICA-SIGILOSA', 'ATRIBUTO-SIGILOSO', 'NOME-COMPLETO-SIGILOSO', '1980-01-02',
  'CPF-CIFRADO-SIGILOSO', '981110000', 'RESPONSAVEL-SIGILOSO', 'PARENTESCO-SIGILOSO', 'CONSENTIMENTO-SIGILOSO',
  'IDENT-SIGILOSO', 'MOTIVO-OPTOUT-SIGILOSO', 'INTERESSE-SIGILOSO',
]);

const CAMPOS_DE_LEAD = Object.freeze([
  'lead_id', 'temperatura', 'estagio', 'score', 'interesse', 'primeira_consulta',
  'pagamento', 'urgencia', 'disponibilidade', 'perdido_motivo',
]);

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const orquestrador = {
    disponivel: false,
    despacharEvento: async () => ({ resposta: null }),
    verificarSaude: async () => ({ estado: 'nao_configurado' }),
  };
  const atendimento = criarAtendimento({ repositorio, orquestrador });
  const app = await subirServidor({ repositorio, atendimento, orquestrador, configuracao: configuracaoDeTeste() });

  const alpins = await repositorio.criarAgente(validarAgente({ slug: 'alpins-auditoria', nome: 'Agente Alpins' }), { usuarioId: null });

  // A mesma pessoa é paciente da clínica (ficha inteira preenchida, lead
  // qualificado, opt-out com motivo) e cliente do Alpins.
  const paciente = await repositorio.encontrarOuCriarContato({ telefone: '5516900006001', nome: 'Paciente Auditoria' });
  await repositorio.atualizarContato(paciente.id, {
    email: 'sigilo@clinica.test', observacoes: 'OBS-CLINICA-SIGILOSA', atributos: { plano: 'ATRIBUTO-SIGILOSO' },
    nomeCompleto: 'NOME-COMPLETO-SIGILOSO', nascimento: '1980-01-02', cpfCifrado: 'CPF-CIFRADO-SIGILOSO',
    whatsappDdi: '55', whatsappDdd: '16', whatsappNumero: '981110000',
    responsavelNome: 'RESPONSAVEL-SIGILOSO', responsavelParentesco: 'PARENTESCO-SIGILOSO',
    consentimentoResponsavelEm: '2026-01-01T00:00:00.000Z', consentimentoCanal: 'CONSENTIMENTO-SIGILOSO',
    identificador: 'IDENT-SIGILOSO',
  });
  await repositorio.definirOptOutDeLembretes(paciente.id, { optout: true, motivo: 'MOTIVO-OPTOUT-SIGILOSO' });
  const conversaClinica = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp');
  await repositorio.registrarMensagem(conversaClinica.id, { direcao: 'entrada', conteudo: 'texto da clínica', autor_tipo: 'contato' });
  const lead = await repositorio.salvarLead(paciente.id, { conversaId: conversaClinica.id, temperatura: 'frio' });
  await repositorio.atualizarLead(lead.id, { interesse: 'INTERESSE-SIGILOSO', pagamento: 'convenio' });
  const conversaPacienteLoja = await repositorio.encontrarOuCriarConversaAberta(paciente.id, 'whatsapp', { agenteId: alpins.id });
  await repositorio.registrarMensagem(conversaPacienteLoja.id, { direcao: 'entrada', conteudo: 'texto do paciente na loja', autor_tipo: 'contato' });

  const sessoes = {
    admin: await app.entrarComo('admin', { master: true }),
    gestorClinica: await app.entrarComo('gestor'),
    gestorAlpins: await app.entrarComo('gestor'),
    loja: await app.entrarComo('atendente'),
    gestorLoja: await app.entrarComo('gestor'),
  };
  const ids = Object.fromEntries(Object.entries(sessoes).map(([nome, sessao]) => [nome, sessao.usuario.id]));
  for (const membro of ['gestorAlpins', 'loja', 'gestorLoja']) await repositorio.adicionarMembroDaEquipe(alpins.id, ids[membro]);
  await repositorio.atualizarUsuario(ids.loja, { acessoClinica: false });
  await repositorio.atualizarUsuario(ids.gestorLoja, { acessoClinica: false });

  async function pedir(quem, rota, { metodo = 'GET', corpo } = {}) {
    const resposta = await app.pedirSemAuth(rota, {
      method: metodo,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessoes[quem].access_token}` },
      body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    });
    const texto = await resposta.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: resposta.status, json, texto };
  }

  return { app, repositorio, pedir, ids, alpins, paciente, lead, conversaClinica, conversaPacienteLoja };
}

// ------------------------------------------------------------------ A1

test('A1: conversa de agente não traz lead nem próxima ação da clínica — para ninguém; a da clínica segue igual', async (t) => {
  const c = await montar();
  t.after(() => c.app.encerrar());

  for (const quem of ['admin', 'gestorAlpins', 'loja', 'gestorLoja']) {
    const aberta = await c.pedir(quem, `/api/conversas/${c.conversaPacienteLoja.id}`);
    assert.equal(aberta.status, 200, quem);
    for (const campo of CAMPOS_DE_LEAD) assert.equal(aberta.json.conversa[campo], null, `${quem}: conversa aberta com ${campo}`);
    assert.equal(aberta.json.conversa.proxima_acao, null, `${quem}: próxima ação`);

    const lista = (await c.pedir(quem, `/api/conversas?fila=todos&agente=${c.alpins.id}`)).json.conversas;
    const item = lista.find((conversa) => conversa.id === c.conversaPacienteLoja.id);
    assert.ok(item, `${quem} vê a conversa do Alpins na lista`);
    for (const campo of CAMPOS_DE_LEAD) assert.equal(item[campo], null, `${quem}: lista com ${campo}`);
    assert.equal(item.proxima_acao, null);
    assert.ok(!aberta.texto.includes('INTERESSE-SIGILOSO') && !JSON.stringify(lista).includes('INTERESSE-SIGILOSO'));
  }

  const daClinica = (await c.pedir('gestorClinica', `/api/conversas/${c.conversaClinica.id}`)).json.conversa;
  assert.equal(daClinica.lead_id, c.lead.id, 'a conversa da clínica continua com o lead');
  assert.equal(daClinica.pagamento, 'convenio');
  assert.equal(daClinica.interesse, 'INTERESSE-SIGILOSO');
});
