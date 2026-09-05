'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { criarAvisoDeEquipe, textoDeMarcacao } = require('../src/integracoes/aviso-equipe');

function canalFalso({ falharEm = [] } = {}) {
  const envios = [];
  return {
    envios,
    async enviar(carga) {
      if (falharEm.includes(carga.telefone)) throw new Error('canal indisponível');
      envios.push(carga);
      return { identificador: 'wa-1' };
    },
  };
}

const EQUIPE = ['+5516992943215', '+5516993624116'];

test('o aviso interno sai pelo canal do inbox, para toda a equipe', async () => {
  // Antes daqui o veículo era `execFile('openclaw', …)` — uma CLI que não
  // existe na função serverless da Vercel, que é onde esta rota roda. Toda
  // chamada falhava no callback e virava log; a rota respondia enviado: true.
  const canal = canalFalso();
  const aviso = criarAvisoDeEquipe({ canal, destinatarios: EQUIPE });

  assert.equal(aviso.disponivel, true);
  const resultado = await aviso.enviarResumo('RESUMO DE LEAD — Marina');

  assert.equal(resultado.enviados, 2);
  assert.deepEqual(canal.envios.map((e) => e.telefone), EQUIPE);
  assert.equal(canal.envios[0].texto, 'RESUMO DE LEAD — Marina');
});

test('quando o canal falha, o resultado diz que falhou — não "enviado"', async () => {
  const canal = canalFalso({ falharEm: EQUIPE });
  const aviso = criarAvisoDeEquipe({ canal, destinatarios: EQUIPE });

  const resultado = await aviso.enviarResumo('RESUMO DE LEAD — Marina');

  assert.equal(resultado.enviados, 0);
  assert.equal(resultado.falhas.length, 2);
});

test('sem canal, o aviso se declara indisponível em vez de fingir', async () => {
  const aviso = criarAvisoDeEquipe({ canal: null, destinatarios: EQUIPE });

  assert.equal(aviso.disponivel, false);
  const resultado = await aviso.enviarResumo('qualquer coisa');
  assert.equal(resultado.enviados, 0);
  assert.ok(resultado.motivo);
});

test('a lista de destinatários vem da configuração, não do código', async () => {
  const canal = canalFalso();
  const aviso = criarAvisoDeEquipe({ canal, destinatarios: ['+5516900000001'] });

  await aviso.enviarResumo('texto');

  assert.deepEqual(canal.envios.map((e) => e.telefone), ['+5516900000001']);
  assert.equal(aviso.quantidade, 1);
});

test('o aviso de marcação continua com o formato que a equipe conhece', () => {
  const texto = textoDeMarcacao({ nome: 'Marina', telefone: '5516999999999', quando: 'quinta, 14h' });

  assert.match(texto, /^Nova marcacao - Dr\. Edson/);
  assert.match(texto, /Paciente: Marina \| Tel: 5516999999999/);
  assert.match(texto, /Data: quinta, 14h/);
});
