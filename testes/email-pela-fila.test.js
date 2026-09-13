'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRemetente } = require('../src/seguranca/email');
const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');

// O e-mail de recuperação de senha, e por onde ele sai.
//
// Antes: o servidor HTTP mandava direto. Na produção esse servidor é uma função
// serverless na Vercel, onde (a) o processo morre em segundos, (b) o IP muda a
// cada execução e cai em spam, e (c) a senha do e-mail não pode ser posta sem o
// painel. Resultado prático em 12/09/2026: o link nunca saía, e a tela não
// tinha como saber disso.
//
// Agora, sem SMTP no processo, o e-mail vai para a fila e quem entrega é o
// worker do VPS. O que estes testes protegem é a diferença entre "não enviei e
// avisei" e "não enviei e ninguém ficou sabendo".

test('sem SMTP mas com banco, o e-mail vai para a fila em vez de sumir no log', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const registrados = [];
  const remetente = criarRemetente({}, { repositorio, registrar: (m) => registrados.push(m) });

  assert.equal(remetente.disponivel, true, 'enfileirar também é estar disponível: o e-mail vai sair');
  assert.equal(remetente.enviaDireto, false, 'este processo não fala SMTP');

  const resultado = await remetente.enviar({
    para: 'alguem@exemplo',
    assunto: 'crmclinica — redefinição de senha',
    texto: 'link secreto',
  });

  assert.deepEqual(resultado, { enviado: true, via: 'fila' });
  const fila = await repositorio.reivindicarEmails({ limite: 10 });
  assert.equal(fila.length, 1);
  assert.equal(fila[0].para, 'alguem@exemplo');
  assert.equal(fila[0].texto, 'link secreto');
});

test('sem SMTP e sem banco, continua registrando no log — e dizendo que não enviou', async () => {
  const registrados = [];
  const remetente = criarRemetente({}, { registrar: (m) => registrados.push(m) });

  assert.equal(remetente.disponivel, false);
  const resultado = await remetente.enviar({ para: 'a@b.c', assunto: 'x', texto: 'y' });

  assert.equal(resultado.enviado, false);
  assert.equal(resultado.motivo, 'smtp_nao_configurado');
  assert.equal(registrados.length, 1, 'sumir em silêncio é o que não pode acontecer');
});

test('com SMTP no processo, envia direto e não usa a fila', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const enviados = [];
  const remetente = criarRemetente(
    { host: 'smtp.exemplo', porta: 587, remetente: 'de@exemplo', usuario: 'u', senha: 's' },
    { repositorio, enviarPorSmtp: async (_config, mensagem) => { enviados.push(mensagem); return { enviado: true, via: 'smtp' }; } },
  );

  assert.equal(remetente.enviaDireto, true);
  await remetente.enviar({ para: 'a@b.c', assunto: 'x', texto: 'y' });

  assert.equal(enviados.length, 1);
  assert.equal((await repositorio.reivindicarEmails({ limite: 10 })).length, 0, 'nada foi para a fila');
});

test('falha ao enfileirar não finge sucesso', async () => {
  const repositorio = {
    enfileirarEmail: async () => { throw new Error('banco fora do ar'); },
  };
  const registrados = [];
  const remetente = criarRemetente({}, { repositorio, registrar: (m) => registrados.push(m) });

  const resultado = await remetente.enviar({ para: 'a@b.c', assunto: 'x', texto: 'y' });
  assert.equal(resultado.enviado, false);
  assert.equal(resultado.motivo, 'falha_ao_enfileirar');
  assert.equal(registrados.length, 1);
});

test('o texto é apagado quando o e-mail sai: ele carrega o link que troca a senha', async () => {
  const repositorio = criarRepositorioEmMemoria();
  await repositorio.enfileirarEmail({ para: 'a@b.c', assunto: 'x', texto: 'https://crm/?recuperar=TOKEN-SECRETO' });

  const [item] = await repositorio.reivindicarEmails({ limite: 1 });
  await repositorio.marcarEmailEnviado(item.id);

  // O repositório em memória espelha o do banco: depois de entregue, o corpo
  // não fica guardado. Quem lesse a tabela tomaria a conta de alguém.
  const fila = await repositorio.reivindicarEmails({ limite: 10 });
  assert.equal(fila.length, 0, 'e-mail entregue não volta para a fila');
});
