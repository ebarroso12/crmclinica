'use strict';

const fs = require('node:fs');

const extra = require('C:/Users/Cliente/AppData/Local/Temp/funcoes-extra.json');
const base = require('C:/Users/Cliente/AppData/Local/Temp/extracao-008-009.json');

function porNome(nome) {
  const f1 = base.funcoes.find((x) => x.proname === nome);
  if (f1) return f1.definicao.trim();
  const f2 = extra.find((x) => x.proname === nome);
  if (f2) return f2.definicao.trim();
  throw new Error('nao encontrada: ' + nome);
}

const ORDEM = [
  'current_app_role', 'current_usuario_id', 'is_backend', 'is_gestor_or_admin',
  'is_atendente', 'is_admin', 'can_access_conversa', 'can_access_agendamento',
  'is_admin_master', 'is_colaborador',
];

let saida = '';
for (const nome of ORDEM) {
  let def = porNome(nome);
  if (!def.endsWith(';')) def += ';';
  saida += def + '\n\n';
}

fs.writeFileSync('scripts/tmp/_funcoes_034_final.sql', saida);
console.log('OK, ' + ORDEM.length + ' funcoes escritas');
