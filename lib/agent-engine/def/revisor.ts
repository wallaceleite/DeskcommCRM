/**
 * [fork wallaceleite] O REVISOR DE COMPLIANCE DO MÉTODO DEF (documento 05).
 *
 * Duas camadas, na ordem do pacote:
 *  1. CÓDIGO — rápido e sem custo: parágrafos, mensagens por turno, pergunta no
 *     fim, "senhor/senhora", links fora da lista, preço antes da hora, duração da
 *     consulta e desconto fora da regra. Reprovou aqui, nem chama o modelo.
 *  2. MODELO — as regras de conteúdo (diagnóstico, promessa, comparação, fato
 *     fora da base…). As expressões do "nunca diga" entram como suspeita para o
 *     modelo confirmar: sozinhas elas pegariam frase legítima ("depende de cada
 *     caso, sem antecipar o diagnóstico").
 *
 * O modelo FALHA ABERTO quando não há suspeita: sem resposta legível, a
 * mensagem segue. Com expressão do "nunca diga" no texto, FALHA FECHADO (P1.2).
 * A camada de código continua valendo, e as travas da cadeia `before-send`
 * (afirmação clínica, promessa, vocabulário) também.
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../edge/llm/credentials';
import { extrairObjetoJsonDoTexto } from '../texto/extrair-json-do-texto';
import type { ModoDef } from './roteador';
import type { EtapaDef, FichaDef, IntencaoDef, RoteiroDef } from './tipos';

export interface VetoDef {
  regra: string;
  motivo: string;
}

export interface VereditoDef {
  aprovada: boolean;
  regras: string[];
  motivo: string;
  /** O trecho que o modelo diz violar (vazio quando não citou). */
  trecho?: string;
  /**
   * Quem decidiu: o código, o modelo, ou ninguém — o modelo falhou e soltou
   * (`falhou_aberto`), ou falhou com expressão suspeita no texto e segurou
   * (`falhou_fechado`, contexto de saúde: na dúvida, reescreve).
   */
  origem: 'codigo' | 'modelo' | 'falhou_aberto' | 'falhou_fechado';
}

/** Etapas em que o valor completo ainda não pode aparecer (sem o lead perguntar). */
const ANTES_DO_PRECO: readonly EtapaDef[] = ['contato', 'descoberta', 'encantamento', 'isolamento'];

/** Modos em que o turno não precisa terminar em pergunta. */
export const SEM_PERGUNTA: readonly ModoDef[] = ['urgencia', 'dispensa', 'passagem'];

/** Mensagens que a família recebe por vez (documento 05, regra 1). */
export const MENSAGENS_POR_TURNO = 2;

/** Abaixo disto a mensagem é curta demais para medir repetição ("Combinado?"). */
const TAMANHO_MINIMO_PARA_REPETICAO = 40;

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** A família perguntou o preço? Regex simples, para quando o extrator falhou (P1.5). */
export function perguntouPreco(texto: string): boolean {
  return /\b(quanto|valor|preco|custa|custo|investimento)\b/.test(semAcento(texto));
}

/**
 * A família perguntou de valor OU de condição (desconto, Pix, parcela, cartão,
 * pagamento, taxa)? Responder a condição com o valor não é "preço antes da
 * hora" — a regra 5 é sobre o valor que a equipe solta sem ser perguntada.
 */
export function perguntouValorOuCondicao(texto: string): boolean {
  return (
    perguntouPreco(texto) ||
    /\b(desconto|pix|parcel\w*|cartao|pagamento|pagar|taxa|a vista|vezes)\b/.test(semAcento(texto))
  );
}

/** Termina em pergunta? (o emoji depois do "?", como o 😬 da cadência, não conta) */
export function terminaEmPergunta(body: string): boolean {
  return body.replace(/[\s\p{Extended_Pictographic}\uFE0F]+$/u, '').endsWith('?');
}

/** Quantas perguntas a mensagem faz (cada "?" fecha uma). */
export function contarPerguntas(body: string): number {
  return (body.match(/\?+/g) ?? []).length;
}

/** A mensagem é um aviso de pagamento recebido (não precisa de pergunta)? */
export function eAvisoDePagamento(body: string): boolean {
  return /parabens pela decisao|recebi[, !]/.test(semAcento(body));
}

/**
 * O LIMITE DO TURNO — não é veto de conteúdo (P0.4 e P0.5). Já saíram 2
 * mensagens, ou a pergunta do turno já foi feita: a próxima tentativa recebe
 * "aguarde a família", sem contar para o limite de reprovações e sem a
 * mensagem de espera. Contar como veto passava a conversa para a equipe sem
 * motivo nenhum.
 */
export function limiteDoTurno(args: { enviosNoTurno: number; perguntasNoTurno: number }): string | null {
  if (args.enviosNoTurno >= MENSAGENS_POR_TURNO) {
    return 'Você já mandou 2 mensagens neste turno. Não mande mais nada: aguarde a família responder.';
  }
  if (args.perguntasNoTurno > 0) {
    return 'A pergunta deste turno já foi feita. Não mande mais nada: aguarde a família responder.';
  }
  return null;
}

/** Semelhança de Dice sobre bigramas de caracteres (0 a 1), sem acento nem pontuação. */
export function semelhanca(a: string, b: string): number {
  const limpar = (t: string) => semAcento(t).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const x = limpar(a);
  const y = limpar(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bigramas = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const bg = x.slice(i, i + 2);
    bigramas.set(bg, (bigramas.get(bg) ?? 0) + 1);
  }
  let comuns = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const bg = y.slice(i, i + 2);
    const n = bigramas.get(bg) ?? 0;
    if (n > 0) {
      comuns += 1;
      bigramas.set(bg, n - 1);
    }
  }
  return (2 * comuns) / (x.length - 1 + y.length - 1);
}

function campoPreenchido(ficha: FichaDef, campo: string): boolean {
  const v = (ficha as Record<string, unknown>)[campo];
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim() !== '' && v !== 'nao_informado' && v !== 'nao_mapeado';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function testar(expressao: string, texto: string, flags: string): boolean {
  try {
    return new RegExp(expressao, flags).test(texto);
  } catch {
    // Expressão inválida no roteiro não pode derrubar o envio.
    return false;
  }
}

export function checagensDeCodigo(args: {
  body: string;
  etapa: EtapaDef;
  modo: ModoDef;
  intencoes: readonly IntencaoDef[];
  linksPermitidos: readonly string[];
  /** A última mensagem da família pergunta de valor ou condição (libera a regra 5). */
  familiaPerguntouValor?: boolean;
  /** Marcas de texto de IA do roteiro (`revisor.regex_tom`). */
  regexTom?: readonly { regex: string; motivo: string }[];
  /** Perguntas sobre campo já preenchido (`revisor.perguntas_da_ficha`). */
  perguntasDaFicha?: readonly { campo: string; regex: string }[];
  ficha?: FichaDef;
  /** O que a equipe já mandou nesta conversa (repetição). */
  anterioresDaEquipe?: readonly string[];
  similaridadeMaxima?: number;
  /** Teto de caracteres por mensagem (`revisor.max_caracteres`); ausente = sem teto. */
  maxCaracteres?: number;
}): VetoDef[] {
  const { body } = args;
  const vetos: VetoDef[] = [];
  const texto = semAcento(body);

  // T. Tamanho: público que se perde em mensagem longa. Urgência nunca é barrada.
  if (args.maxCaracteres !== undefined && args.modo !== 'urgencia' && body.trim().length > args.maxCaracteres) {
    vetos.push({
      regra: 'tamanho',
      motivo: `Mensagem longa demais (${body.trim().length} caracteres; o limite é ${args.maxCaracteres}). Corte explicação e diga só o essencial.`,
    });
  }

  // 1. No máximo 2 parágrafos por mensagem (o limite de mensagens é `limiteDoTurno`).
  const paragrafos = body.split(/\n\s*\n/).filter((p) => p.trim() !== '');
  if (paragrafos.length > 2) {
    vetos.push({ regra: '1', motivo: 'Use no máximo 2 parágrafos curtos por mensagem.' });
  }

  // 2. Uma pergunta por vez, e no fim. A ÚLTIMA mensagem do turno termina em
  //    pergunta — isso se cobra no fim do turno (`turno.ts`), não aqui: a 1ª de
  //    duas mensagens pode ser só o bloco do valor.
  const perguntas = contarPerguntas(body);
  if (perguntas > 1) {
    vetos.push({ regra: '2', motivo: 'Faça uma pergunta só por vez.' });
  } else if (perguntas === 1 && !terminaEmPergunta(body)) {
    vetos.push({ regra: '2', motivo: 'A pergunta fica no fim da mensagem: nada depois dela.' });
  }

  // 3. Sem "senhor" ou "senhora".
  if (/\bsenhora?\b/.test(texto)) {
    vetos.push({ regra: '3', motivo: 'Não use "senhor" nem "senhora".' });
  }

  // 4. Só os links da lista.
  const links = body.match(/(https?:\/\/[^\s)]+|www\.[^\s)]+)/gi) ?? [];
  const normalizar = (url: string) => semAcento(url).replace(/^https?:\/\//, '').replace(/^www\./, '');
  const foraDaLista = links.filter((l) => !args.linksPermitidos.some((p) => normalizar(l).startsWith(normalizar(p))));
  if (foraDaLista.length > 0) {
    vetos.push({ regra: '4', motivo: `Não mande este link: ${foraDaLista.join(', ')}. Só os links permitidos.` });
  }

  // 5. Valor completo antes do isolamento, sem o lead ter perguntado.
  if (
    ANTES_DO_PRECO.includes(args.etapa) &&
    !args.intencoes.includes('pergunta_preco') &&
    args.familiaPerguntouValor !== true &&
    /\b1\.?200\b|\b3\s?x\b|tres vezes sem juros/.test(texto)
  ) {
    vetos.push({
      regra: '5',
      motivo: 'O valor e as condições só aparecem no fechamento, depois do isolamento — a não ser que a família pergunte o preço.',
    });
  }

  // 6. A duração da consulta é informação interna.
  if (/(dura|duracao|leva|tempo de)[^.?!]{0,40}\b(1|uma)\s*h(ora)?\b|\b60\s*min/.test(texto)) {
    vetos.push({ regra: '6', motivo: 'Não informe a duração da consulta.' });
  }

  // 7. Desconto só o de irmãos (negar desconto é permitido).
  const negaDesconto = /n(a|ã)o (temos|tem|existe|ha|oferecemos)[^.?!]{0,25}desconto/.test(texto);
  if (/desconto/.test(texto) && !/irmao/.test(texto) && !negaDesconto) {
    vetos.push({ regra: '7', motivo: 'O único desconto que existe é o de 10% para irmãos.' });
  }

  // T. Marcas de texto de IA (markdown, travessão, aberturas prontas, emoji…),
  //    no texto ORIGINAL: acento e caixa contam aqui.
  for (const tom of args.regexTom ?? []) {
    if (testar(tom.regex, body, 'iu')) vetos.push({ regra: 'tom', motivo: tom.motivo });
  }

  // M. Memória: perguntar de novo o que a ficha já tem.
  if (perguntas > 0 && args.ficha !== undefined) {
    for (const p of args.perguntasDaFicha ?? []) {
      if (campoPreenchido(args.ficha, p.campo) && testar(p.regex, texto, 'i')) {
        vetos.push({ regra: 'memoria', motivo: `A família já respondeu isto (${p.campo}): não pergunte de novo.` });
      }
    }
  }

  // R. Repetição: a mesma frase já saiu para esta família.
  if (body.trim().length >= TAMANHO_MINIMO_PARA_REPETICAO) {
    const limite = args.similaridadeMaxima ?? 0.8;
    const repetida = (args.anterioresDaEquipe ?? []).some((anterior) => semelhanca(body, anterior) > limite);
    if (repetida) {
      vetos.push({ regra: 'repeticao', motivo: 'Esta mensagem repete uma que a família já recebeu. Diga com outras palavras.' });
    }
  }

  return vetos;
}

/** As expressões do "nunca diga" que aparecem no texto — suspeita para o modelo confirmar. */
export function suspeitasDoNuncaDiga(body: string, expressoes: readonly string[]): string[] {
  const texto = semAcento(body);
  const achadas: string[] = [];
  for (const expressao of expressoes) {
    try {
      if (new RegExp(expressao, 'i').test(texto)) achadas.push(expressao);
    } catch {
      // Expressão inválida no roteiro não pode derrubar o envio.
    }
  }
  return achadas;
}

function montarPedidoDoRevisor(roteiro: RoteiroDef, etapa: EtapaDef, body: string, suspeitas: string[]): string {
  const regras = roteiro.revisor.regras_modelo.map((r, i) => `${i + 1}. ${r}`).join('\n');
  return [
    'Você revisa uma mensagem de WhatsApp que a equipe vai mandar para uma família. Aprove só se ela cumprir todas as regras.',
    '',
    'Reprove se a mensagem:',
    regras,
    '',
    `BASE (os únicos fatos que a mensagem pode afirmar):\n${roteiro.revisor.base}`,
    '',
    `ETAPA: ${etapa}`,
    suspeitas.length > 0 ? `\nATENÇÃO, expressões suspeitas encontradas (confirme se violam alguma regra): ${suspeitas.join(' | ')}` : '',
    '',
    `MENSAGEM:\n${body}`,
    '',
    'Só reprove copiando em "trecho" as palavras EXATAS da mensagem que violam a regra. Sem trecho exato que viole claramente, aprove. Dizer com outras palavras um fato da BASE não viola a regra 9.',
    'Responda só com JSON: {"aprovada": true|false, "regras_violadas": [números], "trecho": "...", "como_corrigir": "..."}',
  ].join('\n');
}

export function lerVereditoDoRevisor(texto: string): VereditoDef | null {
  const obj = extrairObjetoJsonDoTexto(texto);
  if (obj === null || typeof obj.aprovada !== 'boolean') return null;
  const regras = Array.isArray(obj.regras_violadas) ? obj.regras_violadas.map((r) => String(r)).slice(0, 12) : [];
  const trecho = typeof obj.trecho === 'string' ? obj.trecho.slice(0, 200) : '';
  const comoCorrigir = typeof obj.como_corrigir === 'string' ? obj.como_corrigir.slice(0, 400) : '';
  return {
    aprovada: obj.aprovada,
    regras,
    motivo: [trecho ? `Trecho: "${trecho}".` : '', comoCorrigir].filter(Boolean).join(' '),
    trecho,
    origem: 'modelo',
  };
}

/**
 * O modelo reprovou citando um trecho que NÃO está na mensagem: é invenção do
 * revisor, e a reprovação não vale (medido na bateria: o modelo barato vetava
 * frase do próprio roteiro citando regra e trecho que não existiam).
 */
export function trechoExisteNaMensagem(trecho: string, body: string): boolean {
  const limpar = (t: string) => semAcento(t).replace(/["'“”‘’«»]/g, '').replace(/\s+/g, ' ').trim();
  const corpo = limpar(body);
  const pedacos = limpar(trecho)
    .split(/\.\.\.|…/)
    .map((p) => p.trim().replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/g, ''))
    .filter((p) => p.length >= 6);
  return pedacos.length > 0 && pedacos.every((p) => corpo.includes(p));
}

export async function revisarComModelo(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string | null; jobId?: string; agentId: string | null },
  args: {
    roteiro: RoteiroDef;
    etapa: EtapaDef;
    body: string;
    model?: string;
    llmOverride?: LlmResolveOverride;
  },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<VereditoDef> {
  const suspeitas = suspeitasDoNuncaDiga(args.body, args.roteiro.revisor.regex_nunca_diga);
  try {
    const call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
        agentId: ids.agentId,
        purpose: 'def_revisor',
        reasoning: 'none',
        maxOutputTokens: 400,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
        messages: [{ role: 'user', content: montarPedidoDoRevisor(args.roteiro, args.etapa, args.body, suspeitas) }],
      },
      { registry: deps.registry, log: deps.log },
    );
    const veredito = lerVereditoDoRevisor(call.result.text);
    if (veredito !== null && !veredito.aprovada && veredito.trecho && !trechoExisteNaMensagem(veredito.trecho, args.body)) {
      deps.log.warn('def: revisor citou trecho que não está na mensagem — reprovação descartada', { regras: veredito.regras });
      return { aprovada: true, regras: [], motivo: '', origem: 'modelo' };
    }
    if (veredito !== null) return veredito;
    deps.log.warn('def: revisor sem JSON legível');
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    deps.log.warn('def: revisor falhou', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
  return vereditoSemModelo(suspeitas);
}

/**
 * O modelo não respondeu. Sem suspeita do "nunca diga", a mensagem segue (falha
 * aberta). COM suspeita, segura (P1.2): em clínica, a dúvida vira reescrita.
 */
export function vereditoSemModelo(suspeitas: readonly string[]): VereditoDef {
  if (suspeitas.length === 0) return { aprovada: true, regras: [], motivo: '', origem: 'falhou_aberto' };
  return {
    aprovada: false,
    regras: ['8'],
    motivo: `Não foi possível confirmar a mensagem. Reescreva sem estas expressões: ${suspeitas.join(' | ')}.`,
    origem: 'falhou_fechado',
  };
}
