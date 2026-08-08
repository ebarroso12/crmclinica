'use strict';

const { criarServidor } = require('../src/servidor/http');
const { carregarConfiguracao } = require('../src/config');
const { gerarHash } = require('../src/seguranca/senha');

// Ambiente de teste: nenhuma variável real, nenhum segredo de produção, nenhuma chamada de rede.
const AMBIENTE_BASE = Object.freeze({
  NODE_ENV: 'test',
  PORT: '0',
  CRMCLINICA_DATABASE_URL: '',
  CRMCLINICA_JWT_SECRET: 'segredo-sintetico-de-teste-com-mais-de-32-caracteres',
  OPENCLAW_BASE_URL: '',
  OPENCLAW_TOKEN: '',
  OPENCLAW_WEBHOOK_SECRET: '',
  SERENA_BASE_URL: '',
  KIMI_API_KEY: '',
  // A suíte inteira autentica com usuários admin/master sem TOTP cadastrado;
  // com o 2FA obrigatório ligado (P1-04), todos os testes existentes tomariam
  // 403. Os testes do próprio P1-04 ligam isto com 'sim' explicitamente.
  CRMCLINICA_2FA_OBRIGATORIO: 'nao',
});

// Senha sintética usada só nos testes.
const SENHA_DE_TESTE = 'senha-de-teste-123';

function configuracaoDeTeste(sobrescritas = {}) {
  return carregarConfiguracao({ ...AMBIENTE_BASE, ...sobrescritas });
}

/**
 * Sobe o servidor numa porta livre e devolve utilitários de requisição.
 *
 * Quando `dependencias.repositorio` existe, cria um usuário e autentica, de modo que
 * `pedir` já vá com o portador. `pedirSemAuth` existe para testar a recusa.
 * O chamador é responsável por `await ambiente.encerrar()`.
 */
async function subirServidor(dependencias = {}) {
  const configuracao = dependencias.configuracao || configuracaoDeTeste();
  const servidor = criarServidor({ ...dependencias, configuracao });

  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  const pedirSemAuth = (caminho, opcoes) => fetch(`${base}${caminho}`, opcoes);

  let sessao = null;
  if (dependencias.repositorio && dependencias.autenticar !== false) {
    sessao = await autenticar({
      base,
      repositorio: dependencias.repositorio,
      papel: dependencias.papel || 'admin',
      // Por padrão o usuário do teste é o master: as rotas de gestão de contas
      // exigem isso, e a maioria das suítes precisa de acesso total.
      master: dependencias.master ?? (dependencias.papel ?? 'admin') === 'admin',
    });
  }

  const comPortador = (opcoes = {}) => {
    if (!sessao) return opcoes;
    return { ...opcoes, headers: { ...(opcoes.headers || {}), authorization: `Bearer ${sessao.access_token}` } };
  };

  return {
    base,
    configuracao,
    sessao,
    pedirSemAuth,
    pedir: (caminho, opcoes) => pedirSemAuth(caminho, comPortador(opcoes)),
    /** Autentica outro usuário, para testar papéis diferentes na mesma instância. */
    entrarComo: (papel, opcoes = {}) => autenticar({
      base, repositorio: dependencias.repositorio, papel, ...opcoes,
    }),
    encerrar: () => new Promise((resolve, reject) => {
      servidor.close((erro) => (erro ? reject(erro) : resolve()));
    }),
  };
}

/**
 * Cria um usuário do papel pedido, já liberado, e devolve a sessão aberta.
 * Conta nova nasce pendente no produto; no teste ela precisa poder entrar.
 */
async function autenticar({ base, repositorio, papel = 'admin', master = false }) {
  const email = `${papel}-${Math.random().toString(36).slice(2, 8)}@teste.local`;

  await repositorio.criarUsuario({
    nome: `Usuário ${papel}`,
    email,
    senhaHash: await gerarHash(SENHA_DE_TESTE),
    papel,
    situacao: 'ativo',
    master,
  });

  const resposta = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: SENHA_DE_TESTE }),
  });

  if (!resposta.ok) throw new Error(`falha ao autenticar no teste: HTTP ${resposta.status}`);
  return { ...(await resposta.json()), email, senha: SENHA_DE_TESTE };
}

module.exports = { AMBIENTE_BASE, SENHA_DE_TESTE, configuracaoDeTeste, subirServidor, autenticar };
