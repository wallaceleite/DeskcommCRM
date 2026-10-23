/**
 * [fork wallaceleite] O EXTRATOR DO MÉTODO DEF.
 *
 * Um modelo barato lê a ficha atual, as últimas mensagens e a mensagem nova e
 * devolve a ficha atualizada (documento 03 do pacote), as intenções da última
 * mensagem e a prova de cada valor. Roda ANTES da resposta, junto com os
 * classificadores do turno.
 *
 * Falha não derruba o atendimento: sem ficha nova, o turno segue com a ficha
 * guardada. A exceção é o orçamento — `LlmBudgetExceededError` sobe para a
 * escolta do turno passar a conversa a uma pessoa (mesma regra do
 * `stage-classifier.ts`).
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { LlmBudgetExceededError, runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../edge/llm/credentials';
import type { LeadContextMessage } from '../edge/crm/get-lead-context';
import { extrairObjetoJsonDoTexto } from '../texto/extrair-json-do-texto';
import {
  fichaDefSchema,
  INTENCOES_DEF,
  type ExtracaoDef,
  type FichaDef,
  type IntencaoDef,
  type RoteiroDef,
} from './tipos';

/** Quantas mensagens o extrator lê — o mesmo número do pacote. */
export const MENSAGENS_DO_EXTRATOR = 20;

const FORMATO_DA_SAIDA = `Responda SOMENTE com um objeto JSON, sem texto em volta, neste formato:
{
  "ficha": { ...os campos da ficha, só os que você sabe... },
  "intencoes": [ ...o que a ÚLTIMA mensagem da família pede, da lista abaixo... ],
  "objecao_atual": "tipo da objeção feita na última mensagem, ou null",
  "provas": { "campo": "número da mensagem que comprova", ... }
}

Campos da ficha e valores permitidos:
- perfil: engano | decidido | empoderado | curioso | indefinido
- para_quem: filho | filha | outro | nao_informado
- idade_anos: número ou null
- nome_crianca, nome_responsavel, cidade, uf: texto ou null
- formato_preferido: presencial | online | indiferente | nao_informado
- tem_diagnostico: sim | nao | investigando | nao_informado
- acompanhamento_atual: lista (psicologo, fono, aba, to, psicopedagogo, outro)
- motivo: suspeita | escola_pediu | encaminhamento | laudo | segunda_opiniao | revisao_medicacao | sem_acesso | beneficio | outro | null
- motivo_texto: frase curta nas palavras da família
- prazo: {"data": texto ou null, "finalidade": escola | inss | terapia | empresa | outro} ou null
- dor_aprofundada, convenio_citado, pressa: true | false
- decisor: proprio | conjuge | outro | nao_mapeado
- termometro: imediato | futuro | nao_perguntado
- data_retorno_pedida: texto ou null
- recuo_estrategico_feito: true quando a equipe JÁ disse que a avaliação começa antes e pediu licença para perguntar
- parafraseou: true quando a equipe JÁ resumiu o caso e pediu confirmação
- acordo_sinceridade: aceito | recusado | nao_feito
- red_flags: [{"descricao": texto curto, "resolvida": true|false}]
- diferenciais_lembrados: {"quantidade": 0 a 3, "quais": [laudo_na_consulta | mesmo_medico_online | avaliacao_antes]} ou null — só depois que a família respondeu "o que mais fez sentido"
- verificacao_repetida: true quando a pergunta "o que mais fez sentido" já foi feita duas vezes
- isolamento: so_financeiro | outra_variavel | nao_feito
- preco_informado_em: etapa em que a EQUIPE informou o valor (contato | descoberta | encantamento | isolamento | fechamento) ou null
- reacao_preco: sim | sim_sem_firmeza | nao | null
- preferencia_turno: texto (ex.: "manhã, segunda ou quarta") ou null
- horario_escolhido: "AAAA-MM-DD HH:MM" do horário que a família ESCOLHEU entre os oferecidos pela equipe, ou null
- ficha_nf_completa: true quando a família já mandou os dados da nota fiscal
- pagamento: pix | cartao | depois | nao | null
- objecoes: [{"tipo", "momento", "mao": dupla|unica, "evitavel_em", "saida_usada", "contornada": true|false}]
- motivo_perda: valor | distancia | convenio | data | decisor | confianca | sem_resposta | outro | null

Intenções permitidas: ${INTENCOES_DEF.join(', ')}.`;

function linhaDaMensagem(m: LeadContextMessage, i: number): string {
  const quem = m.direction === 'inbound' ? 'FAMÍLIA' : 'EQUIPE';
  const corpo = m.body.replace(/\s+/g, ' ').trim().slice(0, 1200);
  return `[${i + 1}] ${quem} (${m.sent_at}): ${corpo}`;
}

export function montarMensagemDoExtrator(
  ficha: FichaDef,
  mensagens: readonly LeadContextMessage[],
): string {
  const recorte = mensagens.slice(-MENSAGENS_DO_EXTRATOR);
  const ultima = [...recorte].reverse().find((m) => m.direction === 'inbound');
  return [
    'FICHA ATUAL:',
    JSON.stringify(ficha),
    '',
    `CONVERSA (últimas ${recorte.length} mensagens, numeradas):`,
    recorte.map(linhaDaMensagem).join('\n') || '(vazia)',
    '',
    'MENSAGEM NOVA:',
    ultima ? ultima.body.replace(/\s+/g, ' ').trim().slice(0, 1200) : '(nenhuma)',
  ].join('\n');
}

/** Lê a saída do modelo. Nunca lança: o que não parsear vira `null`. */
export function lerSaidaDoExtrator(texto: string): ExtracaoDef | null {
  const obj = extrairObjetoJsonDoTexto(texto);
  if (obj === null) return null;
  const bruto = typeof obj.ficha === 'object' && obj.ficha !== null ? obj.ficha : obj;
  const ficha = fichaDefSchema.safeParse(bruto);
  if (!ficha.success) return null;
  const intencoes = Array.isArray(obj.intencoes)
    ? obj.intencoes.filter((i): i is IntencaoDef => (INTENCOES_DEF as readonly string[]).includes(i as string))
    : [];
  const objecao =
    typeof obj.objecao_atual === 'string' && obj.objecao_atual.trim() !== '' && obj.objecao_atual !== 'null'
      ? obj.objecao_atual.trim().slice(0, 40)
      : null;
  const provas: Record<string, string> = {};
  if (typeof obj.provas === 'object' && obj.provas !== null) {
    for (const [campo, prova] of Object.entries(obj.provas as Record<string, unknown>)) {
      if (typeof prova === 'string' || typeof prova === 'number') provas[campo.slice(0, 40)] = String(prova).slice(0, 40);
    }
  }
  return { ficha: ficha.data, intencoes: [...new Set(intencoes)], objecao_atual: objecao, provas };
}

function chave(texto: string | null | undefined): string {
  return (texto ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

type Objecao = NonNullable<FichaDef['objecoes']>[number];
type RedFlag = NonNullable<FichaDef['red_flags']>[number];

/** Objeções: uma por tipo + momento; a contornada não volta a não contornada. */
function unirObjecoes(anteriores: readonly Objecao[], novas: readonly Objecao[]): Objecao[] {
  const porChave = new Map<string, Objecao>();
  for (const o of [...anteriores, ...novas]) {
    const k = `${chave(o.tipo)}|${chave(o.momento)}`;
    const ja = porChave.get(k);
    porChave.set(k, ja ? { ...ja, ...o, contornada: ja.contornada || o.contornada } : o);
  }
  return [...porChave.values()];
}

/** Sinais de risco: um por descrição; o resolvido não reabre. */
function unirRedFlags(anteriores: readonly RedFlag[], novas: readonly RedFlag[]): RedFlag[] {
  const porChave = new Map<string, RedFlag>();
  for (const r of [...anteriores, ...novas]) {
    const k = chave(r.descricao);
    const ja = porChave.get(k);
    porChave.set(k, ja ? { ...ja, ...r, resolvida: ja.resolvida || r.resolvida } : r);
  }
  return [...porChave.values()];
}

/**
 * A ficha nova por cima da anterior. Campo que a extração não trouxe (ou trouxe
 * vazio) mantém o valor anterior — a conversa recortada em 20 mensagens não
 * pode apagar o que a família disse antes. As LISTAS somam (P1.1): o extrator só
 * vê as objeções recentes, e trocar a lista inteira apagava as antigas e
 * reabria sinal de risco já resolvido.
 */
export function mesclarFicha(anterior: FichaDef, nova: FichaDef): FichaDef {
  const saida: Record<string, unknown> = { ...anterior };
  for (const [campo, valor] of Object.entries(nova)) {
    if (valor === undefined || valor === null) continue;
    if (Array.isArray(valor) && valor.length === 0) continue;
    saida[campo] = valor;
  }
  if (anterior.objecoes && nova.objecoes) saida.objecoes = unirObjecoes(anterior.objecoes, nova.objecoes);
  if (anterior.red_flags && nova.red_flags) saida.red_flags = unirRedFlags(anterior.red_flags, nova.red_flags);
  if (anterior.acompanhamento_atual && nova.acompanhamento_atual) {
    saida.acompanhamento_atual = [...new Set([...anterior.acompanhamento_atual, ...nova.acompanhamento_atual])];
  }
  return saida as FichaDef;
}

export async function extrairFichaDef(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string | null; jobId?: string; agentId: string | null },
  args: {
    roteiro: RoteiroDef;
    ficha: FichaDef;
    mensagens: readonly LeadContextMessage[];
    model?: string;
    llmOverride?: LlmResolveOverride;
  },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<ExtracaoDef | null> {
  let texto: string;
  try {
    const call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        ...(ids.jobId !== undefined ? { jobId: ids.jobId } : {}),
        agentId: ids.agentId,
        purpose: 'def_extrator',
        reasoning: 'none',
        maxOutputTokens: 1600,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
        system: `${args.roteiro.extrator.instrucoes}\n\n${FORMATO_DA_SAIDA}`,
        messages: [{ role: 'user', content: montarMensagemDoExtrator(args.ficha, args.mensagens) }],
      },
      { registry: deps.registry, log: deps.log },
    );
    texto = call.result.text;
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) throw err;
    deps.log.warn('def: extrator falhou — turno segue com a ficha guardada', {
      error: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    });
    return null;
  }
  const saida = lerSaidaDoExtrator(texto);
  if (saida === null) deps.log.warn('def: saída do extrator sem JSON legível — turno segue com a ficha guardada');
  return saida;
}
