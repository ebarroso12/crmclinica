'use strict';

// Smoke test do fluxo completo, com orquestrador simulado (não há credencial do
// gateway real). Exercita: canal → contrato → banco → OpenClaw → histórico local,
// já com autenticação e RBAC ligados.

const { criarServidor } = require('../src/servidor/http');
const { carregarConfiguracao } = require('../src/config');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarAtendimento } = require('../src/dominio/atendimento');
const { gerarHash } = require('../src/seguranca/senha');
const crypto = require('node:crypto');

const SEGREDO_WEBHOOK = 'segredo-de-smoke-com-mais-de-32-caracteres';
const PORTA = 4250;

const repositorio = criarRepositorioEmMemoria();
const despachos = [];
const orquestrador = {
  disponivel: true,
  despacharEvento: async (carga) => { despachos.push(carga); return { resposta: 'Olá! Sou a Serena. Como posso ajudar?' }; },
  verificarSaude: async () => ({ estado: 'operacional' }),
};
const atendimento = criarAtendimento({ repositorio, orquestrador });

const configuracao = carregarConfiguracao({
  NODE_ENV: 'test',
  CRMCLINICA_JWT_SECRET: 'segredo-de-smoke-jwt-com-mais-de-32-caracteres',
  OPENCLAW_WEBHOOK_SECRET: SEGREDO_WEBHOOK,
});

const servidor = criarServidor({ configuracao, repositorio, atendimento, orquestrador });

const base = `http://127.0.0.1:${PORTA}`;
const passos = [];
function verificar(descricao, condicao, detalhe = '') {
  passos.push({ descricao, ok: Boolean(condicao), detalhe });
  console.log(`  ${condicao ? 'OK  ' : 'FALHA'} ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function main() {
  await new Promise((r) => servidor.listen(PORTA, '127.0.0.1', r));

  // --- 1. WhatsApp → crmclinica, com assinatura HMAC ---
  const evento = JSON.stringify({
    canal: 'whatsapp', id_externo: 'wa:smoke-fluxo-1',
    remetente: '5516993120938', nome: 'Paciente Teste',
    texto: 'Quero saber sobre a primeira consulta',
  });
  const assinatura = 'sha256=' + crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(evento).digest('hex');

  const recepcao = await fetch(`${base}/api/eventos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': assinatura },
    body: evento,
  });
  const recibo = await recepcao.json();
  verificar('canal entrega o evento assinado (202)', recepcao.status === 202, `status ${recepcao.status}`);
  verificar('sem assinatura válida seria recusado',
    (await fetch(`${base}/api/eventos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: evento })).status === 401);

  // --- 2. gravou no banco ---
  const conversaId = recibo.conversa_id;
  verificar('evento virou conversa no banco', typeof conversaId === 'number', `conversa ${conversaId}`);

  // --- 3. foi ao OpenClaw com contexto mínimo ---
  verificar('orquestrador foi acionado', despachos.length === 1);
  const contexto = despachos[0]?.contexto ?? {};
  verificar('contexto mínimo: só nome, telefone e identificador',
    JSON.stringify(Object.keys(contexto.contato || {}).sort()) === '["identificador","nome","telefone"]');

  // --- 4. resposta gravada no histórico local ---
  const mensagens = await repositorio.listarMensagens(conversaId);
  verificar('mensagem do paciente e resposta no mesmo histórico', mensagens.length === 2, `${mensagens.length} mensagens`);
  verificar('a resposta é da automação', mensagens[1]?.autor_tipo === 'automacao');

  // --- 5. reentrega não duplica ---
  await fetch(`${base}/api/eventos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': assinatura },
    body: evento,
  });
  verificar('reentrega não gera segunda resposta', despachos.length === 1 && (await repositorio.listarMensagens(conversaId)).length === 2);

  // --- 6. inbox exige autenticação ---
  verificar('inbox sem token responde 401', (await fetch(`${base}/api/conversas`)).status === 401);

  // --- 7. login e leitura autenticada ---
  await repositorio.criarUsuario({ nome: 'Recepção', email: 'recepcao@smoke.local', senhaHash: await gerarHash('senha-de-smoke-123'), papel: 'atendente', situacao: 'ativo' });
  const login = await (await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'recepcao@smoke.local', senha: 'senha-de-smoke-123' }),
  })).json();
  verificar('login devolve access e refresh', Boolean(login.access_token && login.refresh_token));

  const auth = { authorization: `Bearer ${login.access_token}` };
  const lista = await (await fetch(`${base}/api/conversas`, { headers: auth })).json();
  verificar('inbox autenticado lista a conversa', lista.total === 1);
  verificar('a prévia mostra a última mensagem', lista.conversas[0].previa === 'Olá! Sou a Serena. Como posso ajudar?');

  // --- 8. equipe assume: IA pausa ---
  await fetch(`${base}/api/conversas/${conversaId}/assumir`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
  const assumida = await repositorio.obterConversa(conversaId);
  verificar('assumir pausa a IA', assumida.assumida_por_humano === true);

  const despachosAntes = despachos.length;
  const evento2 = JSON.stringify({ canal: 'whatsapp', id_externo: 'wa:smoke-fluxo-2', remetente: '5516993120938', texto: 'Continuo aqui' });
  await fetch(`${base}/api/eventos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-openclaw-assinatura': 'sha256=' + crypto.createHmac('sha256', SEGREDO_WEBHOOK).update(evento2).digest('hex') },
    body: evento2,
  });
  verificar('com humano na conversa, a IA cala', despachos.length === despachosAntes);
  verificar('mas a mensagem do paciente é gravada', (await repositorio.listarMensagens(conversaId)).some((m) => m.conteudo === 'Continuo aqui'));

  // --- 9. RBAC ---
  verificar('atendente não prioriza (403)',
    (await fetch(`${base}/api/conversas/${conversaId}/prioridade`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prioridade: 'alta' }) })).status === 403);

  // --- 10. kanban aponta a conversa ---
  const leads = await (await fetch(`${base}/api/leads`, { headers: auth })).json();
  const lead = leads.colunas.flatMap((c) => c.leads)[0];
  verificar('lead do kanban aponta a conversa', lead?.conversa_id === conversaId);

  // --- 11. nenhum segredo vaza ---
  const resumo = await (await fetch(`${base}/api/resumo`, { headers: auth })).text();
  verificar('resumo não vaza segredo', !resumo.includes(SEGREDO_WEBHOOK) && !resumo.includes('scrypt'));

  servidor.close();
  const falhas = passos.filter((p) => !p.ok);
  console.log(`\n${passos.length - falhas.length}/${passos.length} verificações passaram`);
  process.exit(falhas.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('erro no smoke:', e.message); process.exit(1); });
