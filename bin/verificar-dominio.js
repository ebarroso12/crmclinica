#!/usr/bin/env node
'use strict';

// Confere se o domínio próprio já está no ar.
//
//   npm run verificar-dominio
//   npm run verificar-dominio -- --esperar
//
// Existe porque propagação de DNS é uma espera cega: o painel do provedor diz
// "salvo", e não diz quando começa a valer. Este comando responde as três
// perguntas que importam, na ordem em que elas quebram:
//
//   1. o nome resolve?
//   2. resolve para a Vercel?
//   3. a aplicação responde por ele, com HTTPS válido?
//
// Uma delas falhando explica as outras — e evita trocar o registro DNS quando o
// que falta é só o certificado ser emitido.

const dns = require('node:dns').promises;

const DOMINIO = process.argv.find((a) => a.startsWith('--dominio='))?.slice(10)
  || 'crmclinica.edsonbarrosojr.com.br';
const ESPERAR = process.argv.includes('--esperar');

// IPs anycast que a Vercel usa para registros A. Não é lista exaustiva: serve
// para reconhecer o caso comum, e o teste de HTTP decide o resto.
const IPS_DA_VERCEL = new Set(['76.76.21.21', '216.150.1.1', '216.150.16.1']);

const verde = (t) => `\x1b[32m${t}\x1b[0m`;
const vermelho = (t) => `\x1b[31m${t}\x1b[0m`;
const amarelo = (t) => `\x1b[33m${t}\x1b[0m`;

/**
 * Consulta pública, por HTTPS, quando o resolver da máquina não coopera.
 *
 * Rede corporativa e VPN costumam bloquear DNS na porta 53, e o erro que sai
 * disso (`ECONNREFUSED`) parece "o domínio não existe" — mandando alguém mexer
 * num registro que já está certo. Perguntar a um resolver público separa as
 * duas coisas.
 */
async function resolverPorHttps(nome, tipo) {
  const resposta = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(nome)}&type=${tipo}`, {
    headers: { accept: 'application/dns-json' },
  });
  if (!resposta.ok) throw new Error(`resolver público respondeu ${resposta.status}`);

  const dados = await resposta.json();
  return (dados.Answer ?? [])
    .filter((registro) => registro.type === (tipo === 'A' ? 1 : 5))
    .map((registro) => registro.data.replace(/\.$/, ''));
}

async function resolver(nome, tipo) {
  try {
    return tipo === 'A' ? await dns.resolve4(nome) : await dns.resolveCname(nome);
  } catch (erro) {
    // Só cai para o resolver público quando o problema é de rede, não quando o
    // domínio realmente não tem o registro.
    if (!['ECONNREFUSED', 'ESERVFAIL', 'ETIMEOUT', 'EREFUSED'].includes(erro.code)) throw erro;
    return resolverPorHttps(nome, tipo);
  }
}

async function conferir() {
  const passos = [];

  // 1. resolve?
  let enderecos = [];
  let cname = null;
  try {
    enderecos = await resolver(DOMINIO, 'A');
    if (enderecos.length === 0) throw Object.assign(new Error('sem registro A'), { code: 'ENODATA' });
  } catch (erro) {
    try {
      cname = (await resolver(DOMINIO, 'CNAME'))[0];
      if (!cname) throw erro;
      enderecos = await resolver(cname, 'A');
    } catch {
      passos.push([false, 'o nome ainda não resolve', erro.code ?? erro.message]);
      return { pronto: false, passos };
    }
  }
  passos.push([true, 'o nome resolve', cname ? `CNAME → ${cname} → ${enderecos.join(', ')}` : enderecos.join(', ')]);

  // 2. aponta para a Vercel?
  const naVercel = Boolean(cname?.includes('vercel')) || enderecos.some((ip) => IPS_DA_VERCEL.has(ip));
  passos.push([naVercel, naVercel ? 'aponta para a Vercel' : 'aponta para outro lugar', enderecos.join(', ')]);

  // 3. a aplicação responde, com certificado válido?
  try {
    const resposta = await fetch(`https://${DOMINIO}/health`, { redirect: 'manual' });
    if (resposta.status === 200) {
      const saude = await resposta.json();
      passos.push([true, 'a aplicação responde por HTTPS',
        `versão ${saude.versao}, banco ${saude.banco?.usuario ?? '—'}`]);
      return { pronto: true, passos };
    }
    passos.push([false, `HTTPS respondeu ${resposta.status}`,
      resposta.status === 404 ? 'o domínio ainda não está ligado ao projeto' : '']);
  } catch (erro) {
    // Certificado ainda não emitido é o caso mais comum aqui, e é questão de
    // minutos depois de o DNS apontar certo.
    passos.push([false, 'HTTPS ainda não responde', erro.cause?.code ?? erro.message]);
  }

  return { pronto: false, passos };
}

function imprimir(passos) {
  for (const [ok, texto, detalhe] of passos) {
    console.log(`  ${ok ? verde('ok  ') : vermelho('nao ')} ${texto}${detalhe ? ` — ${detalhe}` : ''}`);
  }
}

async function main() {
  console.log(`\nDomínio: ${DOMINIO}\n`);

  let resultado = await conferir();
  imprimir(resultado.passos);

  if (!resultado.pronto && ESPERAR) {
    console.log(`\n${amarelo('esperando a propagação (checagem a cada 30s, por até 15 minutos)…')}\n`);
    for (let tentativa = 1; tentativa <= 30 && !resultado.pronto; tentativa += 1) {
      await new Promise((r) => setTimeout(r, 30_000));
      resultado = await conferir();
      const ultimo = resultado.passos.at(-1);
      console.log(`  ${tentativa * 30}s: ${ultimo[1]}`);
    }
    if (resultado.pronto) {
      console.log('');
      imprimir(resultado.passos);
    }
  }

  if (resultado.pronto) {
    console.log(`\n${verde(`No ar: https://${DOMINIO}`)}\n`);
    return;
  }

  console.log(`\n${amarelo('Falta o registro DNS. No painel do provedor:')}\n`);
  console.log('  Tipo:  A');
  console.log(`  Nome:  ${DOMINIO.split('.')[0]}`);
  console.log('  Valor: 76.76.21.21');
  console.log('  TTL:   3600 (ou o padrão)\n');
  console.log('  Alternativa equivalente, e mais durável se a Vercel trocar de IP:');
  console.log('  Tipo: CNAME · Nome: crmclinica · Valor: cname.vercel-dns.com\n');
  process.exitCode = 1;
}

main().catch((erro) => {
  console.error(vermelho(`\nfalha ao verificar: ${erro.message}\n`));
  process.exit(1);
});
