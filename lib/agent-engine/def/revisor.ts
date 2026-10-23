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
 * O modelo FALHA ABERTO: sem resposta legível, a mensagem segue e o evento fica
 * registrado. A camada de código continua valendo, e as travas da cadeia
 * `before-send` (afirmação clínica, promessa, vocabulário) também.
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../edge/llm/credentials';
import { extrairObjetoJsonDoTexto } from '../texto/extrair-json-do-texto';
import type { ModoDef } from './roteador';
import type { EtapaDef, IntencaoDef, RoteiroDef } from './tipos';

export interface VetoDef {
  regra: string;
  motivo: string;
}

export interface VereditoDef {
  aprovada: boolean;
  regras: string[];
  motivo: string;
  /** Quem decidiu: o código, o modelo, ou ninguém (o modelo falhou e soltou). */
  origem: 'codigo' | 'modelo' | 'falhou_aberto';
}

/** Etapas em que o valor completo ainda não pode aparecer (sem o lead perguntar). */
const ANTES_DO_PRECO: readonly EtapaDef[] = ['contato', 'descoberta', 'encantamento', 'isolamento'];

/** Modos em que a mensagem não precisa terminar em pergunta. */
const SEM_PERGUNTA: readonly ModoDef[] = ['urgencia', 'dispensa', 'passagem'];

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function checagensDeCodigo(args: {
  body: string;
  etapa: EtapaDef;
  modo: ModoDef;
  intencoes: readonly IntencaoDef[];
  enviosNoTurno: number;
  linksPermitidos: readonly string[];
}): VetoDef[] {
  const { body } = args;
  const vetos: VetoDef[] = [];
  const texto = semAcento(body);

  // 1. No máximo 2 parágrafos por mensagem e 2 mensagens por vez.
  const paragrafos = body.split(/\n\s*\n/).filter((p) => p.trim() !== '');
  if (paragrafos.length > 2) {
    vetos.push({ regra: '1', motivo: 'Use no máximo 2 parágrafos curtos por mensagem.' });
  }
  if (args.enviosNoTurno >= 2) {
    vetos.push({
      regra: '1',
      motivo: 'Você já mandou 2 mensagens neste turno. Não mande mais nada: espere a família responder.',
    });
  }

  // 2. Termina em pergunta (menos urgência, dispensa, passagem e pagamento recebido).
  const recebeuPagamento = /parabens pela decisao|recebi[, !]/.test(texto);
  if (!SEM_PERGUNTA.includes(args.modo) && !recebeuPagamento && !body.trim().endsWith('?')) {
    vetos.push({ regra: '2', motivo: 'Termine a mensagem com uma pergunta (uma só).' });
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
    vetos.push({ regra: '4', motivo: `Não mande este link: ${foraDaLista.join(', ')}. Só o Instagram oficial é permitido.` });
  }

  // 5. Valor completo antes do isolamento, sem o lead ter perguntado.
  if (
    ANTES_DO_PRECO.includes(args.etapa) &&
    !args.intencoes.includes('pergunta_preco') &&
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
    origem: 'modelo',
  };
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
    if (veredito !== null) return veredito;
    deps.log.warn('def: revisor sem JSON legível — a mensagem segue (falha aberta)');
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    deps.log.warn('def: revisor falhou — a mensagem segue (falha aberta)', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
  }
  return { aprovada: true, regras: [], motivo: '', origem: 'falhou_aberto' };
}
