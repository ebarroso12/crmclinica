'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  telefoneDoPerfil, mascararWhatsapp, motivoSemEntrega, destinatariosDoGrupo,
  instanciaDoAgente, telefonesInternosDoCadastro, montarPainelDeDestinatarios,
} = require('../src/dominio/destinatarios-resumo');

// Quem recebe o resumo (docs/RESUMOS.md): a equipe de cada lado, só com WhatsApp
// autorizado (P1-06) e "recebe resumos" ligado.

const pessoa = (id, extra = {}) => ({
  id, nome: `Pessoa ${id}`, papel: 'atendente', acesso_clinica: true, recebe_resumo: true, agentes: [],
  whatsapp_ddi: '55', whatsapp_ddd: '16', whatsapp_numero: `99100000${id}`, whatsapp_particular_autorizado: true,
  ...extra,
});

test('WhatsApp do cadastro só vale com autorização (P1-06) e número completo; DDI vazio é 55', () => {
  assert.equal(telefoneDoPerfil(pessoa(1)), '+5516991000001');
  assert.equal(telefoneDoPerfil(pessoa(1, { whatsapp_particular_autorizado: false })), null, 'número sem autorização não é usado');
  assert.equal(telefoneDoPerfil(pessoa(1, { whatsapp_ddi: null })), '+5516991000001');
  assert.equal(telefoneDoPerfil(pessoa(1, { whatsapp_numero: '1234' })), null);
  assert.equal(telefoneDoPerfil(pessoa(1, { whatsapp_ddd: null })), null);
  assert.equal(telefoneDoPerfil(null), null);
});

test('máscara: a pessoa reconhece o próprio número, ninguém disca', () => {
  assert.equal(mascararWhatsapp(pessoa(1, { whatsapp_numero: '992943215' })), '+55 16 9****-3215');
  assert.equal(mascararWhatsapp(pessoa(1, { whatsapp_numero: '32153215' })), '+55 16 ****-3215');
  assert.equal(mascararWhatsapp(pessoa(1, { whatsapp_numero: null })), null);
});

test('motivo de quem não recebe: pausado, sem WhatsApp, sem autorização', () => {
  assert.equal(motivoSemEntrega(pessoa(1)), null);
  assert.equal(motivoSemEntrega(pessoa(1, { recebe_resumo: false })), 'pausado');
  assert.equal(motivoSemEntrega(pessoa(1, { whatsapp_numero: null })), 'sem_whatsapp');
  assert.equal(motivoSemEntrega(pessoa(1, { whatsapp_particular_autorizado: false })), 'whatsapp_nao_autorizado');
});

test('clínica = admin e quem vê a clínica; agente = só a equipe dele (admin fora da equipe não recebe)', () => {
  const pessoas = [
    pessoa(1, { papel: 'admin', acesso_clinica: false }), // admin vê a clínica sempre
    pessoa(2, { papel: 'gestor' }),
    pessoa(3, { acesso_clinica: false, agentes: [7] }), // colaborador da loja
    pessoa(4, { papel: 'gestor', agentes: [7] }),
    pessoa(5, { papel: 'admin', recebe_resumo: false, agentes: [7] }),
    pessoa(6, { acesso_clinica: false }), // não vê nada
  ];
  const ids = (lista) => lista.map((item) => item.usuario_id);
  assert.deepEqual(ids(destinatariosDoGrupo(pessoas, null)), [1, 2, 4]);
  assert.deepEqual(ids(destinatariosDoGrupo(pessoas, 7)), [3, 4]);
  assert.deepEqual(destinatariosDoGrupo(pessoas, 8), []);
  assert.equal(destinatariosDoGrupo(pessoas, 7)[0].telefone, '+5516991000003');
});

test('o resumo do agente sai só por canal de WhatsApp ativo do próprio agente', () => {
  assert.equal(instanciaDoAgente({ canais: [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }] }), 'alpins');
  assert.equal(instanciaDoAgente({ canais: [{ canal: 'whatsapp', instancia: 'alpins', ativo: false }] }), null);
  assert.equal(instanciaDoAgente({ canais: [{ canal: 'instagram', instancia: 'alpins', ativo: true }] }), null);
  assert.equal(instanciaDoAgente(null), null);
});

test('números internos: todo WhatsApp autorizado — inclusive de quem pausou —, nunca o não autorizado', () => {
  assert.deepEqual(
    telefonesInternosDoCadastro([pessoa(1), pessoa(2, { recebe_resumo: false }), pessoa(3, { whatsapp_particular_autorizado: false })]),
    ['+5516991000001', '+5516991000002'],
  );
});

test('painel: destinatários por grupo sempre mascarados, agente sem canal e quem não recebe com o porquê', () => {
  const painel = montarPainelDeDestinatarios({
    pessoas: [
      pessoa(1, { papel: 'admin' }),
      pessoa(2, { acesso_clinica: false, agentes: [7] }),
      pessoa(3, { whatsapp_particular_autorizado: false }),
      pessoa(4, { acesso_clinica: false }), // fora de tudo: não aparece em "sem entrega"
    ],
    agentes: [
      { id: 7, nome: 'Alpins', canais: [{ canal: 'whatsapp', instancia: 'alpins', ativo: true }] },
      { id: 8, nome: 'Bravo', canais: [] },
    ],
  });

  assert.deepEqual(painel.grupos.map((grupo) => [grupo.nome, grupo.sem_canal, grupo.destinatarios.map((d) => d.usuario_id)]), [
    ['Clínica', false, [1]],
    ['Alpins', false, [2]],
    ['Bravo', true, []],
  ]);
  assert.equal(painel.grupos[0].destinatarios[0].whatsapp, '+55 16 9****-0001');
  assert.deepEqual(painel.sem_entrega.map((item) => [item.usuario_id, item.motivo]), [[3, 'whatsapp_nao_autorizado']]);
  assert.ok(!/991000001|991000002|991000003/.test(JSON.stringify(painel)), 'número inteiro nunca sai no painel');
});
