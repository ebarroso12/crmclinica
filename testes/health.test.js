const test = require('node:test');
const assert = require('node:assert/strict');
const { servidor } = require('../src');

test('a base responde com a identidade crmclinica', async () => {
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const porta = servidor.address().port;
  const resposta = await fetch(`http://127.0.0.1:${porta}/health`);
  assert.equal(resposta.status, 200);
  assert.deepEqual(await resposta.json(), { produto: 'crmclinica', status: 'ok' });
  await new Promise((resolve, reject) => servidor.close((erro) => erro ? reject(erro) : resolve()));
});
