'use strict';

// Qualidade cadastral (P2-10).
//
// Base suja não grita: ela deixa lembrete sem telefone para ir, paciente sem
// nome na tela, menor sem responsável registrado. Este módulo transforma as
// medidas do repositório num painel com nota — um número que o gestor vê
// piorar antes de o problema chegar ao paciente.
//
// A nota é uma média ponderada simples dos indicadores, de 0 a 100. Não é
// métrica científica; é semáforo. Os pesos dizem o que mais machuca a
// operação: telefone falhando cala os lembretes, então pesa mais.

const { exigirPermissao } = require('../seguranca/rbac');

const PESOS = Object.freeze({
  sem_telefone: 30,
  sem_nome: 20,
  sem_nome_completo: 10,
  sem_nascimento: 15,
  menores_sem_responsavel: 25,
});

function criarQualidadeCadastral({ repositorioClinica }) {
  async function relatorio(ator) {
    exigirPermissao(ator, 'contatos:ler');

    const medidas = await repositorioClinica.medirQualidadeCadastral();
    const { ativos } = medidas;

    // Sem base ativa não há o que medir — e dividir por zero daria nota NaN,
    // o semáforo mais confuso que existe.
    if (ativos === 0) {
      return { nota: null, medidas, pesos: PESOS, resumo: 'base vazia' };
    }

    let penalidade = 0;
    const detalhe = {};
    for (const [indicador, peso] of Object.entries(PESOS)) {
      const proporcao = (medidas[indicador] ?? 0) / ativos;
      const perdido = Math.round(proporcao * peso);
      detalhe[indicador] = { quantidade: medidas[indicador] ?? 0, peso, pontos_perdidos: perdido };
      penalidade += perdido;
    }

    const nota = Math.max(0, 100 - penalidade);
    return {
      nota,
      medidas,
      pesos: PESOS,
      detalhe,
      resumo: nota >= 90 ? 'base saudável' : nota >= 70 ? 'atenção' : 'base precisa de faxina',
    };
  }

  return { relatorio };
}

module.exports = { criarQualidadeCadastral, PESOS };
