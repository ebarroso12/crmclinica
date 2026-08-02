'use strict';

const { gerarHash } = require('./senha');

// Criação do administrador master — a conta que libera todas as outras.
//
// A senha inicial vem do ambiente e serve só para a primeira entrada: a conta
// nasce com `precisa_trocar_senha`, porque senha que passou por configuração,
// mensagem ou terminal deve ser considerada conhecida por terceiros.
//
// Rodar duas vezes é seguro: se a conta já existe, nada é sobrescrito.

async function semearMaster(repositorio, { email, senhaInicial, nome }) {
  if (!email) return { criado: false, motivo: 'email_do_master_nao_configurado' };

  const existente = await repositorio.obterUsuarioPorEmail(email);
  if (existente) {
    // A conta já existe: promover a master se ainda não for, mas **nunca** mexer
    // na senha — quem já trocou não pode ser devolvido à senha do arquivo.
    if (!existente.master) {
      await repositorio.atualizarUsuario(existente.id, {
        master: true, papel: 'admin', situacao: 'ativo', ativo: true,
      });
      return { criado: false, promovido: true, id: existente.id };
    }
    return { criado: false, promovido: false, id: existente.id };
  }

  if (!senhaInicial) return { criado: false, motivo: 'senha_do_master_nao_configurada' };

  const criado = await repositorio.criarUsuario({
    nome: nome || 'Administrador master',
    email,
    senhaHash: await gerarHash(senhaInicial),
    papel: 'admin',
    situacao: 'ativo',
    master: true,
    precisaTrocarSenha: true,
  });

  await repositorio.registrarAuditoria({
    entidade: 'usuario',
    entidadeId: criado.id,
    acao: 'admin_master_criado',
  });

  return { criado: true, id: criado.id };
}

module.exports = { semearMaster };
