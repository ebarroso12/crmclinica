'use strict';

const { exigirPermissao } = require('../seguranca/rbac');
const { executarDiagnostico } = require('../dominio/diagnostico');
const {
  sondaDoBanco, sondaDaFila, sondaDoCanal, sondaDaSerena, sondaDoGoogle, sondaDoWorker,
} = require('../dominio/diagnostico-sondas');
const { decidirAtendimento } = require('../dominio/sincronia-serena');
const { conferirConexao } = require('../dados/conferir-conexao');

// Centro operacional: a rota que responde "o sistema está inteiro?".
//
// Sete peças falham de formas silenciosas — banco, RLS, esquema, fila, canal,
// automação e worker —, e nenhuma grita quando cai. Esta rota pergunta a todas
// de uma vez e devolve fato verificado, não impressão.
//
// Só admin: a varredura expõe o estado interno da infraestrutura, e quem atende
// paciente não precisa saber o nome do usuário do banco para fazer o trabalho.

// Objetos que o código publicado espera encontrar. A lista olha o objeto, não o
// ledger de migrations: `supabase_migrations` só registra o que passou pelo CLI,
// e boa parte daqui foi aplicada por outros caminhos. A pergunta que importa é
// se a coluna existe — foi a ausência de uma delas que quebrou o painel da
// Serena em produção, depois de o código subir antes da migration.
const OBJETOS_ESPERADOS = Object.freeze([
  { tabela: 'lembretes' },
  { tabela: 'serena_configuracao' },
  { tabela: 'serena_prompts' },
  { tabela: 'serena_regras' },
  { tabela: 'serena_configuracao', coluna: 'agenda' },
  { tabela: 'serena_configuracao', coluna: 'pausada_ate' },
  { tabela: 'serena_configuracao', coluna: 'ligada_ate' },
  { tabela: 'contatos', coluna: 'lembretes_optout' },
  { tabela: 'contatos', coluna: 'excluido_em' },
]);

function criarRotasDeDiagnostico({ repositorio, serena, pool = null, vinculo = null, politica = null, googleAgenda = null }) {
  return {
    /** GET /api/diagnostico — a varredura completa. */
    async varrer(usuario) {
      exigirPermissao(usuario, 'usuarios:gerenciar');

      return executarDiagnostico({
        banco: sondaDoBanco(repositorio, OBJETOS_ESPERADOS, pool ? () => conferirConexao(pool) : null),
        fila: sondaDaFila(repositorio),
        canal: sondaDoCanal(vinculo),
        serena: sondaDaSerena(serena, politica, decidirAtendimento),
        google: sondaDoGoogle(googleAgenda),
        worker: sondaDoWorker(repositorio),
      });
    },
  };
}

module.exports = { criarRotasDeDiagnostico, OBJETOS_ESPERADOS };
