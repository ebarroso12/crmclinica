#!/usr/bin/env node
'use strict';

// PreToolUse (matcher: Bash) — nega comandos destrutivos de git e operações
// de deploy/infra de produção antes de executar, mesmo que o agente "ache"
// que tem autorização. CLAUDE.md do projeto já lista essas ações como
// exigindo confirmação expressa; isto é o mecanismo que garante que a
// confirmação aconteceu de verdade (fora deste processo), não só que o
// agente lembrou de pedir.
//
// Cada padrão tem o motivo anotado — ajuda a próxima pessoa a decidir se
// um padrão novo precisa entrar aqui, e não vira uma lista mágica.
//
// Isto NÃO substitui o julgamento do agente para casos fora da lista — é
// uma rede de segurança para os piores casos, não a política inteira.

const PADROES_PERIGOSOS = [
  { re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/i, motivo: 'push forçado reescreve histórico remoto' },
  { re: /\bgit\s+push\b[^\n]*\bmain\b/i, motivo: 'push direto na main — este projeto vai por PR' },
  { re: /\bgit\s+reset\s+--hard\b/i, motivo: 'descarta trabalho local sem chance de recuperar' },
  { re: /\bgit\s+clean\b[^\n]*-[a-z]*f/i, motivo: 'apaga arquivo não rastreado permanentemente' },
  { re: /\bgit\s+branch\s+-D\b/i, motivo: 'apaga branch sem checar merge' },
  { re: /\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b/i, motivo: 'remoção recursiva forçada' },
  { re: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, motivo: 'DDL destrutivo' },
  { re: /\bTRUNCATE\b/i, motivo: 'apaga todas as linhas da tabela' },
  { re: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i, motivo: 'DELETE sem WHERE visível — apaga a tabela inteira' },
  { re: /vercel\s+(--prod|deploy\s+.*--prod)/i, motivo: 'deploy direto de produção fora do fluxo de PR' },
  { re: /\bsupabase\s+db\s+(push|reset)\b/i, motivo: 'migration/reset de banco fora do fluxo manual do SQL Editor' },
];

function lerStdin() {
  return new Promise((resolve) => {
    let dados = '';
    process.stdin.on('data', (pedaco) => { dados += pedaco; });
    process.stdin.on('end', () => resolve(dados));
  });
}

// Achado ao testar este próprio hook: um `git commit -m "$(cat <<'EOF'
// ...texto que MENCIONA 'rm -rf' como exemplo...\nEOF\n)"` se autobloqueava —
// o padrão batia dentro do CONTEÚDO da mensagem de commit (dado), não num
// comando real. Heredoc é o jeito padrão deste próprio projeto de passar
// mensagem de commit/PR longa; sem remover o corpo antes de testar, toda
// descrição que cita um comando perigoso como exemplo dispara falso
// positivo.
//
// Deliberadamente NÃO removemos conteúdo entre aspas simples/duplas em
// geral: `psql -c "DROP TABLE ..."` é o padrão mais comum de SQL
// destrutivo real neste projeto, e ele vem exatamente entre aspas — reduzir
// falso positivo de texto livre não pode custar deixar passar isso. Entre
// "bloqueia sem querer um `echo` de teste" e "deixa passar um DROP TABLE
// disfarçado de string", a primeira fricção é sempre o preço aceito aqui.
function removerHeredocs(comando) {
  return comando.replace(/<<[-~]?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\b/g, ' ');
}

// Achado ao testar: `rm -rf scripts/tmp` (limpar o próprio scratch que
// CLAUDE.md deste projeto recomenda usar livremente) batia no padrão geral
// de remoção recursiva forçada — mesmo quando era só um passo dentro de um
// comando maior (`cd ... && rm -rf scripts/tmp && git status`), que é como
// comandos normalmente chegam aqui na prática (encadeados, não isolados).
// Em vez de exigir que o comando INTEIRO seja só isso (inútil na prática:
// quase nunca é), neutraliza especificamente essa ocorrência antes de
// testar o resto — só libera `scripts/tmp` como alvo; `rm -rf` de qualquer
// outro caminho no mesmo comando continua caindo no padrão geral abaixo.
function neutralizarLimpezaDeScratch(comando) {
  return comando.replace(
    /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+["']?\.?\/?scripts[\\/]tmp\/?["']?/gi,
    ' true ',
  );
}

function sanitizar(comando) {
  return neutralizarLimpezaDeScratch(removerHeredocs(comando));
}

async function main() {
  const bruto = await lerStdin();
  let evento;
  try {
    evento = JSON.parse(bruto);
  } catch {
    process.exit(0);
  }

  const comando = evento?.tool_input?.command ?? '';
  if (!comando) process.exit(0);

  const comandoSanitizado = sanitizar(comando);

  for (const { re, motivo } of PADROES_PERIGOSOS) {
    if (re.test(comandoSanitizado)) {
      process.stderr.write(
        `Bloqueado: comando bate com padrão destrutivo (${motivo}).\n`
        + `Comando: ${comando}\n\n`
        + 'Isto exige autorização explícita do usuário no chat, para esta ação '
        + 'específica — não genérica ("continue"/"pode"). Explique ao usuário '
        + 'o que este comando faria e peça confirmação explícita antes de '
        + 'tentar de novo. Se isto bloqueou um caso legítimo por engano '
        + '(falso positivo), explique isso também — o padrão pode precisar de '
        + 'ajuste, mas o ajuste é decisão de quem mantém o hook, não algo para '
        + 'contornar na hora.\n',
      );
      process.exit(2);
    }
  }

  process.exit(0);
}

main();
