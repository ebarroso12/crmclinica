'use strict';

const { ErroDeContrato } = require('../contratos/erros');
const { exigirPermissao } = require('../seguranca/rbac');
const { executarDiagnostico } = require('../dominio/diagnostico');
const {
  sondaDoBanco, sondaDaFila, sondaDoCanal, sondaDaEvolution, sondaDaSerena, sondaDoGoogle, sondaDoWorker, sondaDaOutbox,
  sondaDeEntregasFalhadas, sondaDoInstagram,
} = require('../dominio/diagnostico-sondas');
const { decidirAtendimento } = require('../dominio/sincronia-serena');
const { conferirConexao } = require('../dados/conferir-conexao');
const { gerarParecer, gerarPlanoDeReparo } = require('../dominio/diagnostico-ia');

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
  // Comando 7, achado A-3: migration 032, ainda não aplicada em produção.
  { tabela: 'mensagens', coluna: 'entrega_falhou' },
]);

const ACOES_APLICAVEIS = Object.freeze([
  'outbox:reenfileirar-mortos',
  'lembretes:reprocessar-falhados',
]);

function criarRotasDeDiagnostico({
  repositorio, serena, pool = null, vinculo = null, politica = null, googleAgenda = null,
  evolucaoConfig = null, evolucaoFetchImpl = undefined,
  instagramConfig = null, instagramFetchImpl = undefined,
  gateway = null,
}) {
  return {
    /** GET /api/diagnostico — a varredura completa. */
    async varrer(usuario) {
      exigirPermissao(usuario, 'usuarios:gerenciar');

      return executarDiagnostico({
        banco: sondaDoBanco(repositorio, OBJETOS_ESPERADOS, pool ? () => conferirConexao(pool) : null),
        fila: sondaDaFila(repositorio),
        canal: sondaDoCanal(vinculo),
        // Comando 4 / frente 9: o canal PRIMÁRIO de entrega, ao lado do
        // gateway do OpenClaw (reserva, sondado acima).
        evolucao: sondaDaEvolution(evolucaoConfig, {
          repositorio,
          ...(evolucaoFetchImpl ? { fetchImpl: evolucaoFetchImpl } : {}),
        }),
        serena: sondaDaSerena(serena, politica, decidirAtendimento),
        google: sondaDoGoogle(googleAgenda),
        worker: sondaDoWorker(repositorio),
        // Comando 7, achado A-1: worker separado (bin/worker-outbox.js), sem
        // observabilidade nenhuma até aqui.
        outbox: sondaDaOutbox(repositorio),
        // Incidente de 22/08: o sinal fim-a-fim que pega falha mesmo quando
        // cada peça isolada (fila, worker, canal, Evolution) reporta "ok".
        entregas: sondaDeEntregasFalhadas(repositorio),
        // Integração de Instagram, em construção 23/08 — mesmo padrão da
        // Evolution: credencial configurada e conta alcançável.
        instagram: sondaDoInstagram(instagramConfig, {
          ...(instagramFetchImpl ? { fetchImpl: instagramFetchImpl } : {}),
        }),
      });
    },

    /** POST /api/diagnostico/parecer — IA sobre o laudo inteiro. */
    async parecer(usuario, corpo) {
      exigirPermissao(usuario, 'usuarios:gerenciar');
      if (!gateway) throw new Error('gateway de IA não disponível');

      const laudo = await executarDiagnostico({
        banco: sondaDoBanco(repositorio, OBJETOS_ESPERADOS, pool ? () => conferirConexao(pool) : null),
        fila: sondaDaFila(repositorio),
        canal: sondaDoCanal(vinculo),
        evolucao: sondaDaEvolution(evolucaoConfig, {
          repositorio,
          ...(evolucaoFetchImpl ? { fetchImpl: evolucaoFetchImpl } : {}),
        }),
        serena: sondaDaSerena(serena, politica, decidirAtendimento),
        google: sondaDoGoogle(googleAgenda),
        worker: sondaDoWorker(repositorio),
        outbox: sondaDaOutbox(repositorio),
        entregas: sondaDeEntregasFalhadas(repositorio),
        instagram: sondaDoInstagram(instagramConfig, {
          ...(instagramFetchImpl ? { fetchImpl: instagramFetchImpl } : {}),
        }),
      });

      return gerarParecer({
        gateway,
        achados: laudo.achados,
        provedor: corpo?.provedor ?? null,
        modelo: corpo?.modelo ?? null,
      });
    },

    /** POST /api/diagnostico/reparo — plano de reparo por IA para um achado. */
    async reparo(usuario, corpo) {
      exigirPermissao(usuario, 'usuarios:gerenciar');
      if (!gateway) throw new Error('gateway de IA não disponível');

      const area = String(corpo?.area ?? '').trim();
      const titulo = String(corpo?.titulo ?? '').trim();
      if (!area) throw new ErroDeContrato('campo "area" é obrigatório', 'area');
      if (!titulo) throw new ErroDeContrato('campo "titulo" é obrigatório', 'titulo');

      const achado = {
        area,
        nivel: corpo?.nivel ?? 'falha',
        titulo,
        detalhe: corpo?.detalhe ?? null,
        reparo: corpo?.reparo ?? null,
        acao: corpo?.acao ?? null,
      };

      const resultado = await gerarPlanoDeReparo({
        gateway,
        achado,
        provedor: corpo?.provedor ?? null,
        modelo: corpo?.modelo ?? null,
      });

      return {
        ...resultado,
        acao_aplicavel: achado.acao ?? null,
      };
    },

    /** POST /api/diagnostico/acoes — reparo aplicável de allowlist fechada. */
    async acoes(usuario, corpo) {
      exigirPermissao(usuario, 'usuarios:gerenciar');

      const acao = String(corpo?.acao ?? '').trim();
      if (!ACOES_APLICAVEIS.includes(acao)) {
        throw new ErroDeContrato(`ação não reconhecida: ${acao}`, 'acao');
      }

      if (acao === 'outbox:reenfileirar-mortos') {
        const reenfileirados = await repositorio.reenfileirarTrabalhosMortosDaOutbox();
        return { acao, reenfileirados };
      }

      if (acao === 'lembretes:reprocessar-falhados') {
        const reprocessados = await repositorio.reprocessarLembretesFalhados();
        return { acao, reprocessados };
      }

      // Inatingível (allowlist cobre), mas mantém para segurança.
      throw new ErroDeContrato(`ação não implementada: ${acao}`, 'acao');
    },
  };
}

module.exports = { criarRotasDeDiagnostico, OBJETOS_ESPERADOS };
