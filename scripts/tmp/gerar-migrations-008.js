'use strict';

// Gera o SQL das migrations de reconstrução MECANICAMENTE a partir das duas
// extrações somente-leitura já feitas (extracao-008-009.json,
// policies-completo.json) — nunca por transcrição manual. É exatamente o
// que "não invente" pede: o SQL sai do catálogo, não da memória.

const fs = require('node:fs');

const funcoes = require('C:/Users/Cliente/AppData/Local/Temp/extracao-008-009.json');
const policiasCompleto = require('C:/Users/Cliente/AppData/Local/Temp/policies-completo.json');

function porNome(nome) {
  const f = funcoes.funcoes.find((x) => x.proname === nome);
  if (!f) throw new Error('funcao nao encontrada na extracao: ' + nome);
  return f;
}

// ---------------------------------------------------------------- 034: funções

const ORDEM_FUNCOES = [
  'current_app_role', 'current_usuario_id',
  'is_backend', 'is_gestor_or_admin', 'is_atendente',
  'is_admin_master', 'is_colaborador',
];

let sqlFuncoes = '';
for (const nome of ORDEM_FUNCOES) {
  const f = porNome(nome);
  sqlFuncoes += f.definicao.trim();
  if (!sqlFuncoes.trimEnd().endsWith(';')) sqlFuncoes += ';';
  sqlFuncoes += '\n\n';
}

fs.writeFileSync('scripts/tmp/_gerado_funcoes.sql', sqlFuncoes);

// ---------------------------------------------------------------- policies crm008_*

const crm008 = policiasCompleto.policies.filter((p) => p.policyname.startsWith('crm008'));
const restrict = policiasCompleto.policies.filter((p) => p.policyname.startsWith('restrict_'));

function sqlPolicy(p) {
  const tipo = p.permissive === 'PERMISSIVE' ? '' : ' AS RESTRICTIVE';
  const roles = p.roles.replace(/[{}]/g, '').split(',').join(', ');
  let linha = `CREATE POLICY ${p.policyname} ON public.${p.tablename}${tipo}\n  FOR ${p.cmd}\n  TO ${roles}`;
  if (p.qual) linha += `\n  USING (${p.qual})`;
  if (p.with_check) linha += `\n  WITH CHECK (${p.with_check})`;
  linha += ';';
  return linha;
}

let sqlCrm008 = '';
const tabelasCrm008 = [...new Set(crm008.map((p) => p.tablename))].sort();
for (const tabela of tabelasCrm008) {
  sqlCrm008 += `-- ---- ${tabela}\n`;
  for (const p of crm008.filter((x) => x.tablename === tabela)) {
    sqlCrm008 += `DROP POLICY IF EXISTS ${p.policyname} ON public.${tabela};\n`;
    sqlCrm008 += sqlPolicy(p) + '\n';
  }
  sqlCrm008 += '\n';
}
fs.writeFileSync('scripts/tmp/_gerado_crm008.sql', sqlCrm008);
fs.writeFileSync('scripts/tmp/_gerado_crm008_tabelas.txt', tabelasCrm008.join('\n'));

let sqlRestrict = '';
const tabelasRestrict = [...new Set(restrict.map((p) => p.tablename))].sort();
for (const tabela of tabelasRestrict) {
  sqlRestrict += `-- ---- ${tabela}\n`;
  for (const p of restrict.filter((x) => x.tablename === tabela)) {
    sqlRestrict += `DROP POLICY IF EXISTS ${p.policyname} ON public.${tabela};\n`;
    sqlRestrict += sqlPolicy(p) + '\n';
  }
  sqlRestrict += '\n';
}
fs.writeFileSync('scripts/tmp/_gerado_restrict.sql', sqlRestrict);
fs.writeFileSync('scripts/tmp/_gerado_restrict_tabelas.txt', tabelasRestrict.join('\n'));

console.log('crm008: ' + crm008.length + ' policies em ' + tabelasCrm008.length + ' tabelas');
console.log('restrict_: ' + restrict.length + ' policies em ' + tabelasRestrict.length + ' tabelas');
console.log('rls_por_tabela:', JSON.stringify(policiasCompleto.rls_por_tabela, null, 2));
