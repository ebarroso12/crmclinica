'use strict';

const crypto = require('node:crypto');

// Limite de tentativas de autenticação, em janela deslizante.
//
// Duas chaves independentes, porque protegem de coisas diferentes:
//
//   por conta  — impede que **uma** senha seja adivinhada. Limite baixo.
//   por IP     — impede que **muitas** contas sejam varridas da mesma origem.
//                Limite mais alto, porque uma clínica inteira sai por um IP só,
//                e um limite apertado trancaria a recepção junto com o atacante.
//
// Janela deslizante, não janela fixa: com janela fixa, quem estoura o limite às
// 10h14 recupera tudo às 10h15 e tenta o dobro na virada.
//
// O estado vive no repositório — no PostgreSQL, quando há banco. Com duas
// instâncias atrás de um balanceador, um contador em memória de processo
// permitiria o dobro das tentativas e a proteção seria só aparente.

const LIMITES = Object.freeze({
  login: {
    conta: { maximo: 5, janelaMs: 15 * 60 * 1000 },
    ip: { maximo: 30, janelaMs: 15 * 60 * 1000 },
  },
  recuperacao: {
    // Pedir link de recuperação é barato para quem pede e caro para quem recebe:
    // sem limite, vira ferramenta de flood no e-mail de outra pessoa.
    conta: { maximo: 3, janelaMs: 60 * 60 * 1000 },
    ip: { maximo: 10, janelaMs: 60 * 60 * 1000 },
  },
  redefinicao: {
    conta: { maximo: 10, janelaMs: 60 * 60 * 1000 },
    ip: { maximo: 20, janelaMs: 60 * 60 * 1000 },
  },
});

/**
 * Normaliza e resume o e-mail.
 *
 * O hash agrupa tentativas da mesma conta sem guardar uma lista de quem tem
 * cadastro. E o agrupamento acontece **exista a conta ou não** — do contrário,
 * um limite que só valesse para e-mail existente seria um oráculo de existência.
 */
function chaveDaConta(email) {
  const normalizado = String(email ?? '').trim().toLowerCase();
  if (!normalizado) return null;
  return crypto.createHash('sha256').update(`conta:${normalizado}`).digest('hex');
}

/** Erro de excesso, com o tempo de espera que a resposta HTTP precisa. */
class ErroDeLimite extends Error {
  constructor(segundosDeEspera, escopo) {
    super('tentativas demais; tente novamente mais tarde');
    this.name = 'ErroDeLimite';
    this.status = 429;
    this.retryAfter = Math.max(1, segundosDeEspera);
    this.escopo = escopo;
  }
}

function criarLimitador({ repositorio, limites = LIMITES, agora = () => new Date() } = {}) {
  /**
   * Verifica as duas chaves e lança 429 se alguma estourou.
   * Roda **antes** de conferir a senha: assim o atacante não descobre nada e
   * não consome o scrypt, que é caro de propósito.
   */
  async function exigirDentroDoLimite({ ip = null, email = null, acao = 'login' }) {
    const regra = limites[acao];
    if (!regra) return;

    const hashConta = chaveDaConta(email);
    const instante = agora();

    // A conta vem primeiro: é o limite mais apertado e o que protege a pessoa.
    for (const [escopo, chave] of [['conta', { hashConta }], ['ip', { ip }]]) {
      const { maximo, janelaMs } = regra[escopo];
      if (escopo === 'conta' && !hashConta) continue;
      if (escopo === 'ip' && !ip) continue;

      const desde = new Date(instante.getTime() - janelaMs).toISOString();
      const { total, maisAntigaEm } = await repositorio.contarFalhas({ ...chave, acao, desde });

      if (total >= maximo) {
        // A espera é até a tentativa mais antiga sair da janela — o momento em
        // que uma nova tentativa volta a caber.
        const saiEm = maisAntigaEm ? new Date(maisAntigaEm).getTime() + janelaMs : instante.getTime() + janelaMs;
        throw new ErroDeLimite(Math.ceil((saiEm - instante.getTime()) / 1000), escopo);
      }
    }
  }

  /** Registra o desfecho da tentativa. Nunca recebe nem guarda a senha. */
  async function registrar({ ip = null, email = null, acao = 'login', sucesso = false }) {
    const hashConta = chaveDaConta(email);
    await repositorio.registrarTentativa({ ip, hashConta, acao, sucesso });

    // Acertou: o contador da conta zera. Deixar as falhas anteriores contando
    // puniria quem só errou a senha e depois lembrou dela.
    if (sucesso) await repositorio.limparFalhasDaConta(hashConta, acao);
  }

  /** Remove o que já saiu de qualquer janela. */
  async function limpar(retencaoMs = 24 * 60 * 60 * 1000) {
    const anteriorA = new Date(agora().getTime() - retencaoMs).toISOString();
    return repositorio.limparTentativasVencidas(anteriorA);
  }

  return { exigirDentroDoLimite, registrar, limpar, chaveDaConta };
}

module.exports = { criarLimitador, chaveDaConta, ErroDeLimite, LIMITES };
