'use strict';

// Onboarding e ajuda contextual (P3-01).
//
// Ninguém lê manual de CRM. O que funciona é o sistema dizer, na primeira
// semana, "falta isto" — e parar de dizer quando deixou de faltar. Este
// módulo calcula a trilha do usuário a partir do estado real da conta dele:
// cada passo é um fato verificável, não uma propaganda de recurso.
//
// A ajuda contextual é um mapa tela -> dica curta, servido pela API para a
// interface mostrar no lugar certo. Dica boa é a que cabe numa linha e diz o
// que aquela tela faz com a vida da clínica.

const PASSOS = Object.freeze([
  {
    id: 'primeiro_acesso',
    titulo: 'Entrar pela primeira vez',
    descricao: 'Sua conta foi criada pela clínica. O primeiro passo já está feito.',
  },
  {
    id: 'trocar_senha',
    titulo: 'Trocar a senha provisória',
    descricao: 'A senha que veio pronta é provisória: troque por uma que só você sabe.',
  },
  {
    id: 'ativar_2fa',
    titulo: 'Ativar o segundo fator',
    descricao: 'O código do celular protege a agenda e as conversas se a senha vazar. '
      + 'Para admin e master, é obrigatório.',
  },
  {
    id: 'completar_cadastro',
    titulo: 'Completar o cadastro',
    descricao: 'Nome completo, nascimento e WhatsApp estruturado: é o que aparece '
      + 'na agenda e nos avisos da equipe.',
  },
  {
    id: 'conhecer_inbox',
    titulo: 'Conhecer a Inbox',
    descricao: 'Todas as conversas chegam aqui. Assuma uma conversa para responder '
      + 'em nome da clínica.',
  },
  {
    id: 'conhecer_agenda',
    titulo: 'Conhecer a Agenda',
    descricao: 'Marque, remarque e cancele consultas. O Google do médico é '
      + 'atualizado sozinho a cada mudança.',
  },
]);

// Dica de uma linha por tela. A chave é o nome da tela na interface.
const AJUDA_CONTEXTUAL = Object.freeze({
  inbox: 'Conversa aberta é paciente esperando. Assuma antes de responder — '
    + 'assim ninguém responde duas vezes.',
  agenda: 'Arrastar horário remarca. O Google do médico acompanha sozinho; '
    + 'se algo falhar, o painel de sincronia mostra.',
  contatos: 'Telefone e WhatsApp certos são o que fazem o lembrete chegar. '
    + 'Duplicatas aparecem em Operação > Qualidade.',
  usuarios: 'Suspender derruba as sessões na hora. Excluir é lógico: o '
    + 'histórico do que a pessoa fez continua dela.',
  sincronia: 'Verde significa agenda e Google contando a mesma história. '
    + 'Conflito pede uma decisão: vale o CRM ou vale o Google.',
  serena: 'A Serena atende enquanto estiver ligada. Pausar não apaga '
    + 'configuração — só silencia.',
  leads: 'O funil mostra quem ainda não virou consulta. Lead parado há dias '
    + 'é ligação que a clínica não fez.',
});

function criarOnboarding() {
  /**
   * A trilha do usuário, com o que já foi feito marcado a partir do estado
   * real da conta. Sem telemetria inventada: cada `feito` é um fato do banco.
   */
  function trilhaPara(usuario) {
    const feitos = {
      primeiro_acesso: Boolean(usuario?.ultimo_login_em),
      trocar_senha: usuario ? usuario.precisa_trocar_senha === false : false,
      ativar_2fa: Boolean(usuario?.totp_ativo),
      completar_cadastro: Boolean(usuario?.nome_completo && usuario?.nascimento && usuario?.whatsapp_numero),
      // Inbox e agenda não têm como saber se a pessoa visitou — ficam como
      // sugestão até ela mesma dispensar a trilha na interface.
      conhecer_inbox: false,
      conhecer_agenda: false,
    };

    return PASSOS.map((passo) => ({ ...passo, feito: feitos[passo.id] === true }));
  }

  /** Dica de contexto de uma tela; null quando a tela não tem dica. */
  function ajudaDaTela(tela) {
    return AJUDA_CONTEXTUAL[tela] ?? null;
  }

  return { trilhaPara, ajudaDaTela, PASSOS, AJUDA_CONTEXTUAL };
}

module.exports = { criarOnboarding };
