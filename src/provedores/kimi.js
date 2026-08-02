'use strict';

async function chamarKimi(mensagens, configuracao = {}) {
  const chave = configuracao.chave || process.env.KIMI_API_KEY;
  const base = configuracao.base || process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1';
  const modelo = configuracao.modelo || process.env.KIMI_MODEL || 'kimi-latest';
  if (!chave) throw new Error('KIMI_API_KEY não configurada');

  const resposta = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${chave}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: modelo, messages: mensagens, temperature: 0.2 }),
  });

  if (!resposta.ok) throw new Error(`Provedor Kimi respondeu HTTP ${resposta.status}`);
  const dados = await resposta.json();
  const texto = dados.choices?.[0]?.message?.content;
  if (!texto) throw new Error('Resposta do Kimi sem conteúdo');
  return texto;
}

module.exports = { chamarKimi };
