'use strict';

const dados = require('C:/Users/Cliente/AppData/Local/Temp/extracao-008-009.json');

for (let i = 0; i < dados.funcoes.length; i += 1) {
  const f = dados.funcoes[i];
  console.log('=== ' + f.proname + ' (owner=' + f.owner + ', security_definer=' + f.security_definer + ', volatile=' + f.provolatile + ') ===');
  console.log(f.definicao);
  console.log('');
}

console.log('=== GRANTS ===');
console.log(JSON.stringify(dados.grants_execute, null, 2));

console.log('=== POLICIES POR PREFIXO crm008% ===');
console.log('total:', dados.policies_crm008_por_prefixo.length);

console.log('=== POLICIES QUE USAM ALGUMA DAS FUNCOES (qualquer nome) ===');
console.log('total:', dados.policies_que_usam_as_funcoes.length);
for (let i = 0; i < dados.policies_que_usam_as_funcoes.length; i += 1) {
  const p = dados.policies_que_usam_as_funcoes[i];
  console.log('--- ' + p.tablename + '.' + p.policyname + ' (' + p.cmd + ', roles=' + p.roles + ') ---');
  console.log('qual: ' + p.qual);
  console.log('with_check: ' + p.with_check);
}
