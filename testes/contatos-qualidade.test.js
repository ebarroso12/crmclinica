'use strict';

// P1-09 (deduplicação), P2-10 (qualidade cadastral) e P3-01 (onboarding).

const test = require('node:test');
const assert = require('node:assert/strict');

const { criarRepositorioEmMemoria } = require('../src/dados/repositorio-memoria');
const { criarRepositorioClinicaEmMemoria } = require('../src/dados/repositorio-clinica-memoria');
const { criarDeduplicacaoDeContatos } = require('../src/dominio/contatos-dedup');
const { criarQualidadeCadastral } = require('../src/dominio/qualidade-cadastral');
const { criarOnboarding } = require('../src/dominio/onboarding');
const sensiveis = require('../src/seguranca/dados-sensiveis');
const { subirServidor } = require('./auxiliar');

const SEGREDO = 'segredo-sintetico-de-teste-com-mais-de-32-caracteres';

async function montar() {
  const repositorio = criarRepositorioEmMemoria();
  const repositorioClinica = criarRepositorioClinicaEmMemoria({ repositorio });
  const dedup = criarDeduplicacaoDeContatos({ repositorio, repositorioClinica });
  const qualidade = criarQualidadeCadastral({ repositorioClinica });
  const admin = await repositorio.criarUsuario({
    nome: 'Admin', email: 'admin@teste.local', papel: 'admin', situacao: 'ativo',
  });
  return { repositorio, repositorioClinica, dedup, qualidade, admin };
}

async function contatoComCpf(repositorio, { telefone, nome, cpf }) {
  const contato = await repositorio.encontrarOuCriarContato({ telefone, nome });
  const digitos = sensiveis.normalizarDocumento(cpf);
  await repositorio.atualizarContato(contato.id, {
    cpfCifrado: sensiveis.cifrar(SEGREDO, digitos),
    cpfBuscaHash: sensiveis.hashDeBusca(SEGREDO, digitos),
  });
  return contato;
}

// ------------------------------------------------------------------ P1-09

test('candidatos vêm só de critérios fortes: mesmo CPF pelo hash', async () => {
  const { repositorio, dedup, admin } = await montar();

  // Mesmo CPF, telefones diferentes: a pessoa trocou de número, não de CPF.
  await contatoComCpf(repositorio, { telefone: '5516111111111', nome: 'Marina S.', cpf: '52998224725' });
  await contatoComCpf(repositorio, { telefone: '5516222222222', nome: 'Marina Silva', cpf: '52998224725' });
  // Nome parecido NÃO é evidência: outra Marina, outro CPF, nenhum par.
  await contatoComCpf(repositorio, { telefone: '5516333333333', nome: 'Marina Souza', cpf: '39053344705' });

  const pares = await dedup.buscarDuplicatas(admin, {});
  assert.equal(pares.length, 1);
  assert.equal(pares[0].criterio, 'cpf');
  assert.equal(pares[0].contato_a.cpf_cadastrado, true);
});

test('fundir move os vínculos, completa o vencedor e não apaga o perdedor', async () => {
  const { repositorio, dedup, admin } = await montar();

  const vencedor = await contatoComCpf(repositorio, { telefone: '5516111111111', nome: 'Marina S.', cpf: '52998224725' });
  const perdedor = await contatoComCpf(repositorio, { telefone: '5516222222222', nome: 'Marina Silva', cpf: '52998224725' });
  await repositorio.atualizarContato(perdedor.id, { nomeCompleto: 'Marina Silva Souza' });

  const conversa = await repositorio.encontrarOuCriarConversaAberta(perdedor.id, 'whatsapp');
  const lead = await repositorio.salvarLead(perdedor.id, { conversaId: conversa.id });

  const resultado = await dedup.fundir(admin, { vencedorId: vencedor.id, perdedorId: perdedor.id });

  assert.equal(resultado.movidos.conversas, 1);
  assert.equal(resultado.movidos.leads, 1);

  // O vencedor herdou o que só o perdedor tinha.
  assert.equal(resultado.vencedor.nome_completo, 'Marina Silva Souza');

  // O perdedor continua existindo — excluído, com o mapa para desfazer.
  const fundido = await repositorio.obterContato(perdedor.id);
  assert.ok(fundido.excluido_em);
  assert.match(fundido.excluido_motivo, new RegExp(`fundido no contato ${vencedor.id}`));

  // E tudo ficou na auditoria.
  const registro = repositorio._auditoria.find((l) => l.acao === 'contato.fundido');
  assert.ok(registro);
  assert.equal(registro.detalhe.perdedor_id, perdedor.id);

  // A conversa e o lead agora apontam para o vencedor.
  assert.equal(repositorio._interno.conversas.get(conversa.id).contato_id, vencedor.id);
  assert.equal(repositorio._interno.leads.get(lead.id).contato_id, vencedor.id);
});

test('fusão se recusa a juntar consigo mesmo ou com excluído', async () => {
  const { repositorio, dedup, admin } = await montar();
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516111111111', nome: 'Marina' });

  await assert.rejects(
    () => dedup.fundir(admin, { vencedorId: contato.id, perdedorId: contato.id }),
    (erro) => erro.codigo === 'fusao_consigo_mesmo',
  );

  await repositorio.excluirContato(contato.id, {});
  await assert.rejects(
    () => dedup.fundir(admin, { vencedorId: contato.id, perdedorId: 999 }),
    (erro) => erro.codigo === 'vencedor_invalido',
  );
});

test('atendente não funde contato: a decisão é de quem responde pela base', async () => {
  const { repositorio, dedup } = await montar();
  const atendente = await repositorio.criarUsuario({
    nome: 'Atendente', email: 'atendente@teste.local', papel: 'atendente', situacao: 'ativo',
  });

  await assert.rejects(
    () => dedup.fundir(atendente, { vencedorId: 1, perdedorId: 2 }),
    (erro) => erro.status === 403,
  );
});

// ------------------------------------------------------------------ P2-10

test('qualidade cadastral: nota cai com os problemas e sobe com a faxina', async () => {
  const { repositorio, qualidade, admin } = await montar();

  // Base vazia: sem nota, sem divisão por zero.
  const vazio = await qualidade.relatorio(admin);
  assert.equal(vazio.nota, null);

  // Um contato sem telefone nem nome completo.
  await repositorio.encontrarOuCriarContato({ telefone: null, nome: 'Sem Telefone' });
  const sujo = await qualidade.relatorio(admin);
  assert.ok(sujo.nota < 100);
  assert.equal(sujo.medidas.sem_telefone, 1);
  assert.equal(sujo.medidas.sem_nome_completo, 1);

  // Faxina: completa tudo e a nota volta a 100.
  const [contato] = [...repositorio._interno.contatos.values()];
  await repositorio.atualizarContato(contato.id, {
    telefone: '5516999998888', nomeCompleto: 'Nome Completo', nascimento: '1985-03-20',
  });
  const limpo = await qualidade.relatorio(admin);
  assert.equal(limpo.nota, 100);
  assert.equal(limpo.resumo, 'base saudável');
});

test('menor sem responsável aparece na medida', async () => {
  const { repositorio, qualidade, admin } = await montar();
  const contato = await repositorio.encontrarOuCriarContato({ telefone: '5516111111111', nome: 'Criança' });
  await repositorio.atualizarContato(contato.id, { nascimento: '2018-01-10' });

  const relatorio = await qualidade.relatorio(admin);
  assert.equal(relatorio.medidas.menores_sem_responsavel, 1);
  assert.ok(relatorio.nota < 100, 'menor sem responsável pesa na nota');
});

// ------------------------------------------------------------------ P3-01

test('trilha do onboarding reflete o estado real da conta', () => {
  const onboarding = criarOnboarding();

  const recemCriado = {
    ultimo_login_em: null, precisa_trocar_senha: true, totp_ativo: false,
    nome_completo: null, nascimento: null, whatsapp_numero: null,
  };
  const trilhaInicial = onboarding.trilhaPara(recemCriado);
  const porId = Object.fromEntries(trilhaInicial.map((p) => [p.id, p.feito]));
  assert.equal(porId.primeiro_acesso, false);
  assert.equal(porId.trocar_senha, false);
  assert.equal(porId.ativar_2fa, false);
  assert.equal(porId.completar_cadastro, false);

  const veterano = {
    ultimo_login_em: '2026-08-01T10:00:00Z', precisa_trocar_senha: false, totp_ativo: true,
    nome_completo: 'Nome', nascimento: '1990-01-01', whatsapp_numero: '999999999',
  };
  const trilhaFinal = onboarding.trilhaPara(veterano);
  const finalPorId = Object.fromEntries(trilhaFinal.map((p) => [p.id, p.feito]));
  assert.equal(finalPorId.ativar_2fa, true);
  assert.equal(finalPorId.completar_cadastro, true);
});

test('ajuda contextual responde por tela e cala nas desconhecidas', () => {
  const onboarding = criarOnboarding();
  assert.match(onboarding.ajudaDaTela('agenda'), /Google/);
  assert.equal(onboarding.ajudaDaTela('tela-inexistente'), null);
});

// ------------------------------------------------------------------ HTTP

test('HTTP: duplicatas, qualidade e trilha respondem pela API', async () => {
  const repositorio = criarRepositorioEmMemoria();
  const ambiente = await subirServidor({ repositorio });
  try {
    const qualidade = await (await ambiente.pedir('/api/contatos/qualidade')).json();
    assert.ok('medidas' in qualidade);

    const duplicatas = await (await ambiente.pedir('/api/contatos/duplicatas')).json();
    assert.ok(Array.isArray(duplicatas.pares));

    const trilha = await (await ambiente.pedir('/api/usuarios/onboarding/trilha')).json();
    assert.ok(Array.isArray(trilha.passos));
    assert.ok(trilha.passos.length >= 5);

    const ajuda = await (await ambiente.pedir('/api/usuarios/ajuda?tela=agenda')).json();
    assert.match(ajuda.dica, /Google/);
  } finally {
    await ambiente.encerrar();
  }
});
