/**
 * [fork wallaceleite] MONTA O ROTEIRO DEF DA CONSULTA DO DR. RAPHAEL (P0.1).
 *
 *   pnpm tsx scripts/def/montar-roteiro-rangel.ts [--fontes <pasta>] [--saida <arquivo>]
 *
 * Fonte única: o pacote "Agente de IA · Método DEF" (documentos 02, 03 e 05 e a
 * planilha 04, em `<fontes>/agente-def/`) e a Matriz DEF (`<fontes>/Matriz DEF -
 * Consulta Dr Raphael Rangel.xlsx`), mais os ajustes do motor em
 * `scripts/def/rangel-ajustes.json`. Sai um `conteudo` válido em
 * `roteiroDefSchema`, pronto para `PUT /api/v1/def/roteiros`.
 *
 * O roteiro é dado do consultório: a saída padrão
 * (`supabase/fork/roteiros/rangel-consulta.json`) fica FORA do git — o fork é
 * público. O que se versiona é este gerador e os ajustes.
 *
 * As frases ganham id estável pela posição na aba da Matriz (DESC-01, ENC-03…):
 * mudar a ordem das linhas muda os ids, e os KPIs de "frase usada" passam a
 * contar a frase nova.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { roteiroDefSchema, type FraseDef } from "../../lib/agent-engine/def/tipos";
import { lerXlsx } from "./xlsx-minimo";

function argumento(nome: string, padrao: string): string {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : padrao;
}

const FONTES = resolve(argumento("--fontes", join(homedir(), "analise-atendimento-raphael")));
const SAIDA = resolve(argumento("--saida", join(__dirname, "../../supabase/fork/roteiros/rangel-consulta.json")));
const PACOTE = join(FONTES, "agente-def");
const AJUSTES = JSON.parse(readFileSync(join(__dirname, "rangel-ajustes.json"), "utf8"));

const ler = (arquivo: string) => readFileSync(join(PACOTE, arquivo), "utf8");
const limpar = (t: string) => t.replace(/\*\*/g, "").replace(/\n{3,}/g, "\n\n").trim();
const pendente = (t: string) => /PENDENTE|PREENCHER/.test(t);

// ── documento 02: as etapas e os modos ──────────────────────────────────────

const doc02 = ler("02 - Prompts por etapa.md");
const secoes = new Map<string, string>();
for (const parte of doc02.split(/\n## /).slice(1)) {
  const [titulo, ...resto] = parte.split("\n");
  secoes.set(titulo!.trim(), resto.join("\n").replace(/\n---\s*$/, "").trim());
}

function secao(prefixo: string): { titulo: string; texto: string } {
  for (const [titulo, texto] of secoes) {
    if (titulo.startsWith(prefixo)) {
      const semMatriz = texto.replace(/\n\*\*Matriz:\*\*.*$/m, "");
      return { titulo: titulo.replace(/^\d+\.\s*/, "").replace(/\s*\(.*\)$/, ""), texto: limpar(semMatriz) };
    }
  }
  throw new Error(`documento 02 sem a seção "${prefixo}"`);
}

const acrescimo = (chave: string) => (AJUSTES.acrescimos?.[chave] ? `\n\n${AJUSTES.acrescimos[chave]}` : "");

// ── Matriz: as frases, com id estável ───────────────────────────────────────

const matriz = lerXlsx(join(FONTES, "Matriz DEF - Consulta Dr Raphael Rangel.xlsx"));

interface LinhaDaMatriz {
  secao: string;
  colunas: string[];
}

/** As linhas de frase de uma aba (depois do cabeçalho "Frase"/"Perfil"/"Passo"), com a seção em que estão. */
function linhasDaAba(aba: string, cabecalho: string): LinhaDaMatriz[] {
  const linhas = matriz.get(aba);
  if (!linhas) throw new Error(`Matriz sem a aba "${aba}"`);
  const inicio = linhas.findIndex((l) => l[0] === cabecalho);
  if (inicio < 0) throw new Error(`aba "${aba}" sem o cabeçalho "${cabecalho}"`);
  const saida: LinhaDaMatriz[] = [];
  let atual = "";
  for (const l of linhas.slice(inicio + 1)) {
    const preenchidas = l.filter((c) => c !== "");
    if (preenchidas.length === 0) continue;
    if (preenchidas.length === 1 && l[0] !== "") {
      atual = l[0]!;
      continue;
    }
    saida.push({ secao: atual, colunas: l });
  }
  return saida;
}

function marcaDa(texto: string, quando: string): FraseDef["marca"] {
  if (/recuo (estrat|alternativo)/i.test(quando)) return "recuo_estrategico_feito";
  if (/par[áa]frase/i.test(quando)) return "parafraseou";
  if (/R\$\s?1\.200/.test(texto)) return "preco";
  return undefined;
}

/** `uso` é só a coluna "quando usar" da linha — o nome da seção não marca nada. */
function frase(prefixo: string, n: number, texto: string, quando: string, uso: string): FraseDef {
  const marca = marcaDa(texto, uso);
  return {
    id: `${prefixo}-${String(n).padStart(2, "0")}`,
    texto: texto.replace(/\s*\n\s*/g, " ").trim(),
    ...(quando ? { quando } : {}),
    ...(marca ? { marca } : {}),
  };
}

/** Numera TODAS as linhas da aba (id estável) e devolve as que não estão pendentes. */
function frasesDaAba(
  aba: string,
  cabecalho: string,
  prefixo: string,
  colTexto: number,
  colQuando: (l: LinhaDaMatriz) => string,
  colUso = -1,
) {
  return linhasDaAba(aba, cabecalho).map((l, i) => ({
    secao: l.secao,
    colunas: l.colunas,
    frase: frase(prefixo, i + 1, l.colunas[colTexto] ?? "", colQuando(l), colUso >= 0 ? (l.colunas[colUso] ?? "") : ""),
  }));
}

const quandoCom = (...cols: number[]) => (l: LinhaDaMatriz) =>
  [l.secao, ...cols.map((c) => l.colunas[c] ?? "")].filter((x) => x !== "").join(" · ");

const descoberta = frasesDaAba("Descoberta", "Frase", "DESC", 0, quandoCom(3), 3);
const encantamento = frasesDaAba("Encantamento", "Frase", "ENC", 0, quandoCom(3));
const fechamento = frasesDaAba("Fechamento", "Frase", "FECH", 0, quandoCom(2));
const objecoes = frasesDaAba("Objeções", "Frase", "OBJ", 0, (l) => l.colunas[1] ?? l.secao);
const perfis = frasesDaAba("Perfis", "Perfil", "PERF", 3, (l) => l.colunas[0] ?? "");
const cadencia = frasesDaAba("Cadência", "Passo", "CAD", 2, (l) => [l.colunas[0], l.colunas[1]].filter(Boolean).join(" · "));

/**
 * `substituir_frases` troca o texto de uma frase da Matriz pelo id (a voz da
 * equipe); o id, o "quando" e a marca ficam, para os KPIs seguirem contando a
 * mesma frase.
 */
const todasAsFrases = [...descoberta, ...encantamento, ...fechamento, ...objecoes, ...perfis, ...cadencia];
// O valor é o texto inteiro, ou pares [de, para] quando a frase traz dado do
// consultório (razão social, chave) que não deve ser copiado para este repositório.
for (const [id, troca] of Object.entries((AJUSTES.substituir_frases ?? {}) as Record<string, string | [string, string][]>)) {
  if (id.startsWith("_")) continue;
  const alvo = todasAsFrases.find((x) => x.frase.id === id);
  if (!alvo) throw new Error(`substituir_frases: a Matriz não tem a frase ${id}`);
  if (typeof troca === "string") {
    alvo.frase.texto = troca;
    continue;
  }
  for (const [de, para] of troca) {
    if (!alvo.frase.texto.includes(de)) throw new Error(`substituir_frases.${id}: a frase não tem "${de}"`);
    alvo.frase.texto = alvo.frase.texto.replace(de, para);
  }
}

const validas = (xs: { frase: FraseDef }[]) => xs.map((x) => x.frase).filter((f) => f.texto !== "" && !pendente(f.texto));
const naSecao = (xs: typeof descoberta, teste: (s: string) => boolean) => xs.filter((x) => teste(x.secao));

const abertura = (s: string) => /^Abertura e recuo/i.test(s);
const isolamento = (s: string) => /^Isolamento de vari/i.test(s);
const reacaoSim = (s: string) => /^Rea[çc][ãa]o 'sim'$/i.test(s);
const depoisDoPagamento = (s: string) => /^Depois do pagamento/i.test(s);
const precoAntes = objecoes.filter((x) => /Pediu pre[çc]o antes/i.test(x.colunas[1] ?? ""));

// ── planilha 04: as passagens ───────────────────────────────────────────────

const config = lerXlsx(join(PACOTE, "04 - Configuração do agente.xlsx"));
const abaPassagem = config.get("Passagem para humano") ?? [];
const inicioPassagem = abaPassagem.findIndex((l) => /^Gatilho/.test(l[0] ?? ""));
const GATILHO_PARA_INTENCAO: Record<string, string> = { lista_desistencia: "quer_data_antes" };
let mensagemEspera = "Já te respondo, {nome}, só um instante.";
const passagens: Record<string, unknown>[] = [];
for (const l of abaPassagem.slice(inicioPassagem + 1)) {
  const gatilho = l[0] ?? "";
  if (gatilho === "") continue;
  const mensagem = (l[3] ?? "").trim();
  if (gatilho === "revisor_reprovou_2x") {
    mensagemEspera = mensagem.replace("[nome]", "{nome}");
    continue;
  }
  const fora = (l[4] ?? "").trim();
  passagens.push({
    intencao: GATILHO_PARA_INTENCAO[gatilho] ?? gatilho,
    acao: gatilho === "urgencia" ? "urgencia" : gatilho === "pergunta_clinica" ? "responder" : "passar",
    mensagem,
    ...(fora && !/^(igual|mesma mensagem)/i.test(fora) ? { fora_do_horario: fora } : {}),
  });
}
const adulto = perfis.find((x) => /^Engano \(~/.test(x.colunas[0] ?? ""));
const golpe = objecoes.find((x) => /golpe/i.test(x.colunas[1] ?? ""));
if (adulto) passagens.push({ intencao: "adulto", acao: "dispensar", mensagem: adulto.frase.texto });
if (golpe) passagens.push({ intencao: "golpe", acao: "responder", mensagem: golpe.frase.texto });
if (precoAntes[0]) passagens.push({ intencao: "pergunta_preco", acao: "responder", mensagem: precoAntes[0].frase.texto });
passagens.push(...AJUSTES.passagens_extras);

/** `substituir_passagens` troca a mensagem (e o aviso de fora do horário) de uma passagem da planilha 04, pela intenção. */
for (const [intencao, troca] of Object.entries((AJUSTES.substituir_passagens ?? {}) as Record<string, Record<string, string>>)) {
  if (intencao.startsWith("_")) continue;
  const alvo = passagens.find((p) => p.intencao === intencao);
  if (!alvo) throw new Error(`substituir_passagens: a planilha 04 não tem a passagem ${intencao}`);
  Object.assign(alvo, troca);
}

// ── documento 03: o extrator ────────────────────────────────────────────────

const doc03 = ler("03 - Ficha DEF e extrator.md");
const blocoExtrator = /## Prompt do extrator[\s\S]*?```text\n([\s\S]*?)```/.exec(doc03)?.[1] ?? "";
const regrasExtrator = blocoExtrator.split(/\nDevolva somente|\nFICHA ATUAL:/)[0]!.trim();
const redFlags = linhasDaAba("Red Flags", "Sinal").map((l) => l.colunas[0]).filter(Boolean);
const extrator = [
  regrasExtrator,
  ...AJUSTES.extrator_extras.map((x: string) => `- ${x}`),
  `- red_flags: anote estes sinais quando aparecerem (${redFlags.join("; ")}) e marque resolvida quando a equipe tratou.`,
].join("\n");

// ── documento 05 e Base do Produto: o revisor ───────────────────────────────

const doc05 = ler("05 - Revisor de compliance.md");
const promptRevisor = /```text\n([\s\S]*?)```/.exec(doc05)?.[1] ?? "";
const regrasModelo = [...promptRevisor.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) => m[1]!.trim());
const linhaRegex = /Regex de primeiro filtro[^:]*:\s*(.+)$/m.exec(doc05)?.[1] ?? "";
const regexNuncaDiga = [...linhaRegex.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

const base = matriz.get("Base do Produto") ?? [];
const inicioBase = base.findIndex((l) => l[0] === "Item");
const fatos: string[] = [];
let secaoBase = "";
for (const l of base.slice(inicioBase + 1)) {
  if ((l[1] ?? "") === "" && (l[0] ?? "") !== "") {
    secaoBase = l[0]!;
    continue;
  }
  // "Nunca diga" e "Passar para…" são regras, não fatos que a mensagem pode afirmar.
  if (/^(Nunca diga|Passar para)/i.test(secaoBase)) continue;
  if (!l[1] || pendente(l[1])) continue;
  fatos.push(`${l[0]}: ${l[1]}`);
}

// ── o roteiro ───────────────────────────────────────────────────────────────

interface EtapaSubstituida {
  instrucoes: string;
  /** Frases novas (id próprio, fora da numeração da Matriz). */
  frases: FraseDef[];
  /** Frases da Matriz que continuam valendo nesta etapa, pelo id. */
  manter?: string[];
}

/**
 * `substituir_etapas` troca o texto do documento 02 de uma etapa (o fluxo
 * enxuto do Dr.); o resto do pacote segue igual. As frases da Matriz só entram
 * quando listadas em `manter`, para os KPIs de "frase usada" não contarem uma
 * frase que a etapa nova não usa.
 */
const bloco = (prefixoSecao: string, chave: string, frases: FraseDef[]) => {
  const s = secao(prefixoSecao);
  const troca = (AJUSTES.substituir_etapas as Record<string, EtapaSubstituida> | undefined)?.[chave];
  if (troca) {
    const daMatriz = (troca.manter ?? []).map((id) => {
      const f = [...descoberta, ...encantamento, ...fechamento, ...objecoes].find((x) => x.frase.id === id)?.frase;
      if (!f) throw new Error(`substituir_etapas.${chave}: a Matriz não tem a frase ${id}`);
      return f;
    });
    return { titulo: s.titulo, instrucoes: troca.instrucoes, frases: [...troca.frases, ...daMatriz] };
  }
  // `trocar_nas_instrucoes`: corrige uma frase do documento 02 sem reescrever a etapa inteira.
  let texto = s.texto;
  for (const [de, para] of ((AJUSTES.trocar_nas_instrucoes ?? {}) as Record<string, [string, string][]>)[chave] ?? []) {
    if (!texto.includes(de)) throw new Error(`trocar_nas_instrucoes.${chave}: o documento 02 não tem "${de}"`);
    texto = texto.replace(de, para);
  }
  return { titulo: s.titulo, instrucoes: `${texto}${acrescimo(chave)}`, frases };
};

const roteiro = roteiroDefSchema.parse({
  versao: 1,
  ...(AJUSTES.fluxo ? { fluxo: AJUSTES.fluxo } : {}),
  modelo_extrator: AJUSTES.modelo_extrator,
  modelo_revisor: AJUSTES.modelo_revisor,
  equipe: AJUSTES.equipe,
  agenda: AJUSTES.agenda,
  etapas: {
    contato: bloco("1. Contato", "contato", [...validas(naSecao(descoberta, abertura)), ...validas(precoAntes)]),
    descoberta: bloco("2. Descoberta", "descoberta", validas(naSecao(descoberta, (s) => !abertura(s)))),
    encantamento: bloco("3. Encantamento", "encantamento", validas(naSecao(encantamento, (s) => !isolamento(s)))),
    isolamento: bloco("4. Isolamento", "isolamento", validas(naSecao(encantamento, isolamento))),
    fechamento: bloco("5. Fechamento", "fechamento", validas(naSecao(fechamento, (s) => !depoisDoPagamento(s)))),
    reserva: bloco("6. Reserva", "reserva", validas(naSecao(fechamento, reacaoSim))),
    pos_reserva: bloco("7. Pós-reserva", "pos_reserva", validas(naSecao(fechamento, depoisDoPagamento))),
  },
  modos: {
    objecao: bloco("Modo Objeção", "objecao", validas(objecoes)),
    dispensa: bloco("Dispensa", "dispensa", validas(perfis.filter((x) => /^(Engano|Curioso)/.test(x.colunas[0] ?? "")))),
    decidido: bloco("Atalho: lead decidido", "decidido", validas(perfis.filter((x) => /^Decidido/.test(x.colunas[0] ?? "")))),
    retomada: bloco("Atalho: DEF adaptado", "retomada", []),
    cadencia: bloco("Cadência e reativação", "cadencia", validas(cadencia.filter((x) => !/^1ª mensagem/.test(x.colunas[0] ?? "")))),
  },
  passagens,
  extrator: { instrucoes: extrator },
  revisor: {
    ativo: true,
    base: [...fatos, AJUSTES.revisor.base_extra].join("\n"),
    regras_modelo: [...regrasModelo, ...AJUSTES.revisor.regras_extras],
    regex_nunca_diga: [...regexNuncaDiga, ...AJUSTES.revisor.regex_extras],
    links_permitidos: AJUSTES.revisor.links_permitidos,
    mensagem_espera: mensagemEspera,
    regex_tom: AJUSTES.revisor.regex_tom,
    perguntas_da_ficha: AJUSTES.revisor.perguntas_da_ficha,
    similaridade_maxima: AJUSTES.revisor.similaridade_maxima,
    ...(AJUSTES.revisor.max_caracteres ? { max_caracteres: AJUSTES.revisor.max_caracteres } : {}),
  },
});

mkdirSync(dirname(SAIDA), { recursive: true });
writeFileSync(SAIDA, `${JSON.stringify(roteiro, null, 2)}\n`);
const frases = [...Object.values(roteiro.etapas), ...Object.values(roteiro.modos)].reduce((n, b) => n + (b?.frases.length ?? 0), 0);
process.stdout.write(
  `roteiro: ${SAIDA}\n  ${frases} frases, ${roteiro.passagens.length} passagens, ${roteiro.revisor.regras_modelo.length} regras do revisor, ${roteiro.revisor.regex_nunca_diga.length} expressões do nunca-diga, ${fatos.length} fatos na base\n`,
);
