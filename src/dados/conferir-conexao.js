'use strict';

// Confere com QUEM a aplicação conectou.
//
// O RLS e todas as políticas do banco dependem de uma coisa que nenhum arquivo
// de migration consegue garantir: que a aplicação **não** conecte como dono das
// tabelas. Dono tem `BYPASSRLS` — o RLS nem chega a ser avaliado, e as políticas
// viram decoração cara.
//
// É uma troca de uma linha na connection string, feita fora do repositório, e
// por isso mesmo é fácil de esquecer numa migração de servidor ou num ambiente
// novo. Em produção, esquecer não pode ser silencioso.

/**
 * @returns {{ usuario: string, ignoraRls: boolean, tabelasProprias: number,
 *             superusuario: boolean, seguro: boolean }}
 */
async function conferirConexao(pool) {
  const { rows: [linha] } = await pool.query(`
    SELECT current_user AS usuario,
           COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS ignora_rls,
           COALESCE((SELECT rolsuper     FROM pg_roles WHERE rolname = current_user), false) AS superusuario,
           (SELECT count(*)::int FROM pg_tables
             WHERE schemaname = 'public' AND tableowner = current_user) AS tabelas_proprias
  `);

  const tabelasProprias = Number(linha.tabelas_proprias);
  return {
    usuario: linha.usuario,
    ignoraRls: linha.ignora_rls === true,
    superusuario: linha.superusuario === true,
    tabelasProprias,
    seguro: linha.ignora_rls !== true && linha.superusuario !== true && tabelasProprias === 0,
  };
}

/** Frase única, para log e para mensagem de erro. */
function descreverConexao(diagnostico) {
  if (diagnostico.seguro) {
    return `conectado como "${diagnostico.usuario}" — o RLS vale para esta conexão`;
  }

  const motivos = [
    diagnostico.superusuario ? 'é superusuário' : null,
    diagnostico.ignoraRls ? 'tem BYPASSRLS' : null,
    diagnostico.tabelasProprias > 0 ? `é dono de ${diagnostico.tabelasProprias} tabela(s)` : null,
  ].filter(Boolean).join(', ');

  return `conectado como "${diagnostico.usuario}", que ${motivos}: `
    + 'o RLS não é avaliado e as políticas do banco não têm efeito';
}

/**
 * Em produção, recusa subir com conexão privilegiada. Fora dela, apenas avisa —
 * quem desenvolve costuma ter só a URL do dono à mão, e travar o ambiente local
 * empurraria a pessoa a desligar a verificação em vez de arrumar a conexão.
 */
async function exigirConexaoSegura(pool, { producao }) {
  const diagnostico = await conferirConexao(pool);
  const frase = descreverConexao(diagnostico);

  if (diagnostico.seguro) {
    console.log(`[crmclinica] ${frase}`);
    return diagnostico;
  }

  if (!producao) {
    console.warn(`[crmclinica] AVISO: ${frase}.`);
    console.warn('[crmclinica] Aponte CRMCLINICA_DATABASE_URL para crmclinica_app antes de publicar.');
    return diagnostico;
  }

  const erro = new Error(`Conexão insegura em produção: ${frase}.`);
  erro.codigo = 'conexao_privilegiada';
  throw erro;
}

module.exports = { conferirConexao, descreverConexao, exigirConexaoSegura };
