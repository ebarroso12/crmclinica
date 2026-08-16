#!/usr/bin/env node
'use strict';

// PreToolUse — bloqueia escrita em migrations (db/NNN_*.sql e seus rollbacks)
// sem uma autorização explícita, mesmo vinda do próprio Claude.
//
// Por quê: CLAUDE.md do projeto já pede que migrations exijam autorização
// expressa antes de aplicar em produção — mas nada impedia mecanicamente
// que uma sessão distraída ESCREVESSE o arquivo sem essa mesma disciplina.
// Um hook é enforcement, não sugestão: roda sempre, independente de o
// agente "lembrar" da regra.
//
// Autorização: variável de ambiente CRMCLINICA_AUTORIZAR_MIGRATION=1 no
// shell de quem está rodando a sessão. Setar a variável é, em si, um ato
// consciente fora do controle do agente — exatamente o ponto.
//
// Escopo do bloqueio: só db/NNN_descricao.sql e db/NNN_descricao_rollback.sql
// (migrations numeradas de verdade). db/verificar.sql e outros utilitários de
// leitura ficam de fora — não escrevem schema.

const path = require('node:path');

const PADRAO_MIGRATION = /^db[\\/]\d{3}_.*\.sql$/i;

function lerStdin() {
  return new Promise((resolve) => {
    let dados = '';
    process.stdin.on('data', (pedaco) => { dados += pedaco; });
    process.stdin.on('end', () => resolve(dados));
  });
}

async function main() {
  const bruto = await lerStdin();
  let evento;
  try {
    evento = JSON.parse(bruto);
  } catch {
    // Entrada ilegível não é motivo para bloquear o trabalho — falha aberta
    // aqui, fechada só quando o padrão é reconhecido com certeza.
    process.exit(0);
  }

  const alvo = evento?.tool_input?.file_path ?? evento?.tool_input?.path ?? '';
  if (!alvo) process.exit(0);

  const relativo = path.relative(evento?.cwd ?? process.cwd(), alvo).replace(/\\/g, '/');
  if (!PADRAO_MIGRATION.test(relativo)) process.exit(0);

  if (process.env.CRMCLINICA_AUTORIZAR_MIGRATION === '1') process.exit(0);

  process.stderr.write(
    `Bloqueado: "${relativo}" é uma migration numerada. Escrita aqui exige `
    + 'autorização explícita — peça ao usuário para confirmar no chat e, '
    + 'com a confirmação, rode a sessão com CRMCLINICA_AUTORIZAR_MIGRATION=1 '
    + 'antes de tentar de novo. Isso é enforcement mecânico, não uma '
    + 'sugestão: não contorne setando a variável sozinho sem essa confirmação real.\n',
  );
  process.exit(2);
}

main();
