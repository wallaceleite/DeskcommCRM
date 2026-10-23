/**
 * [fork wallaceleite] O ROTULADOR DO MÉTODO DEF (P1.6).
 *
 * Depois que a mensagem SAIU, um modelo barato a rotula com o que o painel de
 * KPIs precisa e que o `send_message` não carrega: tipo, formato e foco da
 * pergunta, comando × voz passiva e qual frase da Matriz ela usou. Os rótulos
 * vão para o evento `mensagem` em `def_eventos`; o schema do `send_message`
 * não muda.
 *
 * A frase usada confirma campos da ficha (`marca` no roteiro): o recuo
 * estratégico, a paráfrase e o preço passam a ser marcados pelo que a equipe
 * de fato DISSE, não só pela leitura do extrator.
 *
 * Assíncrono e best-effort: roda depois do envio, nunca atrasa nem derruba o
 * turno. Usa o ponto `def_extrator` (mesmo modelo barato, mesma conta de custo).
 */
import type pg from 'pg';
import type { Logger } from '../obs/logger';
import type { ProviderRegistry } from '../edge/llm/providers';
import { runModelCall, type LlmEdgeConfig } from '../edge/llm/run-model-call';
import type { LlmResolveOverride } from '../edge/llm/credentials';
import { extrairObjetoJsonDoTexto } from '../texto/extrair-json-do-texto';
import { completarFichaDef, rotularEventoDef } from './persistencia';
import type { EtapaDef, FraseDef, RoteiroDef } from './tipos';

export const TIPOS_DE_PERGUNTA = [
  'situacao',
  'motivacao',
  'impeditivo',
  'aprofundamento',
  'verificacao',
  'isolamento',
  'fechamento',
  'nenhuma',
] as const;

export interface RotulosDef {
  tipo_pergunta: (typeof TIPOS_DE_PERGUNTA)[number];
  formato_pergunta: 'fechada' | 'aberta' | 'nenhuma';
  foco_pergunta: 'pessoa' | 'solucao' | 'nenhum';
  modo_frase: 'comando' | 'voz_passiva' | 'nenhum';
  usou_frase_matriz: string | null;
}

/** Todas as frases do roteiro, com o id estável da Matriz. */
export function frasesDoRoteiro(roteiro: RoteiroDef): FraseDef[] {
  const blocos = [...Object.values(roteiro.etapas), ...Object.values(roteiro.modos)].filter(
    (b): b is NonNullable<typeof b> => b !== undefined,
  );
  // A mesma frase pode estar em duas etapas (fechamento e reserva): uma vez só.
  const porId = new Map(blocos.flatMap((b) => b.frases).map((f) => [f.id, f]));
  return [...porId.values()];
}

function um<T extends string>(valor: unknown, permitidos: readonly T[], padrao: T): T {
  return typeof valor === 'string' && (permitidos as readonly string[]).includes(valor) ? (valor as T) : padrao;
}

/** Lê a saída do modelo. Nunca lança; frase fora do roteiro vira `null`. */
export function lerRotulos(texto: string, idsValidos: ReadonlySet<string>): RotulosDef | null {
  const obj = extrairObjetoJsonDoTexto(texto);
  if (obj === null) return null;
  const frase = typeof obj.usou_frase_matriz === 'string' ? obj.usou_frase_matriz.trim() : '';
  return {
    tipo_pergunta: um(obj.tipo_pergunta, TIPOS_DE_PERGUNTA, 'nenhuma'),
    formato_pergunta: um(obj.formato_pergunta, ['fechada', 'aberta', 'nenhuma'] as const, 'nenhuma'),
    foco_pergunta: um(obj.foco_pergunta, ['pessoa', 'solucao', 'nenhum'] as const, 'nenhum'),
    modo_frase: um(obj.modo_frase, ['comando', 'voz_passiva', 'nenhum'] as const, 'nenhum'),
    usou_frase_matriz: idsValidos.has(frase) ? frase : null,
  };
}

/** Os campos da ficha que a frase usada confirma. */
export function camposConfirmadosPelaFrase(
  frase: FraseDef | undefined,
  etapa: EtapaDef,
): Record<string, unknown> | null {
  switch (frase?.marca) {
    case 'recuo_estrategico_feito':
      return { recuo_estrategico_feito: true };
    case 'parafraseou':
      return { parafraseou: true };
    case 'preco':
      return { preco_informado_em: etapa };
    default:
      return null;
  }
}

function montarPedido(frases: readonly FraseDef[], etapa: EtapaDef, body: string): string {
  return [
    'Rotule uma mensagem que a equipe de uma clínica mandou para uma família pelo WhatsApp.',
    '',
    'tipo_pergunta: situacao (fato fácil: para quem, idade, cidade) | motivacao (por que procurou) | impeditivo (prazo, formato, convênio, quem decide, termômetro) | aprofundamento (impacto na escola e em casa) | verificacao ("o que mais fez sentido?") | isolamento ("o que falta?") | fechamento (valor, horário, pagamento) | nenhuma',
    'formato_pergunta: fechada | aberta | nenhuma',
    'foco_pergunta: pessoa (a família, a criança) | solucao (a consulta, o atendimento) | nenhum',
    'modo_frase: comando ("vamos garantir", "me passa") | voz_passiva ("podemos garantir?", "seria possível") | nenhum',
    'usou_frase_matriz: o id da frase de referência cujo SENTIDO a mensagem usa, ou "" se nenhuma.',
    '',
    `ETAPA: ${etapa}`,
    'FRASES DE REFERÊNCIA:',
    frases.map((f) => `[${f.id}] ${f.texto}`).join('\n'),
    '',
    `MENSAGEM:\n${body}`,
    '',
    'Responda só com JSON: {"tipo_pergunta": "...", "formato_pergunta": "...", "foco_pergunta": "...", "modo_frase": "...", "usou_frase_matriz": "..."}',
  ].join('\n');
}

export async function rotularMensagemDef(
  db: pg.Pool,
  cfg: LlmEdgeConfig,
  ids: { tenantId: string; leadId: string | null; agentId: string | null },
  args: {
    roteiro: RoteiroDef;
    etapa: EtapaDef;
    body: string;
    messageId: string;
    contactId: string;
    model?: string;
    llmOverride?: LlmResolveOverride;
  },
  deps: { registry?: ProviderRegistry; log: Logger },
): Promise<void> {
  try {
    const frases = frasesDoRoteiro(args.roteiro);
    const call = await runModelCall(
      db,
      cfg,
      {
        tenantId: ids.tenantId,
        leadId: ids.leadId,
        agentId: ids.agentId,
        purpose: 'def_extrator',
        reasoning: 'none',
        maxOutputTokens: 200,
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.llmOverride !== undefined ? { llmOverride: args.llmOverride } : {}),
        messages: [{ role: 'user', content: montarPedido(frases, args.etapa, args.body) }],
      },
      { registry: deps.registry, log: deps.log },
    );
    const rotulos = lerRotulos(call.result.text, new Set(frases.map((f) => f.id)));
    if (rotulos === null) return;
    await rotularEventoDef(db, deps.log, { organizationId: ids.tenantId, messageId: args.messageId, rotulos: { ...rotulos } });
    const frase = frases.find((f) => f.id === rotulos.usou_frase_matriz);
    const campos = camposConfirmadosPelaFrase(frase, args.etapa);
    if (campos !== null) {
      await completarFichaDef(db, deps.log, {
        organizationId: ids.tenantId,
        contactId: args.contactId,
        campos,
        // O preço guarda a PRIMEIRA etapa em que apareceu (KPI F1/F3).
        soSeVazio: frase?.marca === 'preco',
      });
    }
  } catch (err) {
    // Inclusive orçamento: a mensagem já saiu, e rótulo nenhum vale um turno.
    deps.log.warn('def: rotulador falhou', { error: (err instanceof Error ? err.message : String(err)).slice(0, 160) });
  }
}
