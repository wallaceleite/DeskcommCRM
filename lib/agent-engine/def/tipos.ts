/**
 * [fork wallaceleite] O MÉTODO DEF (Descoberta, Encantamento, Fechamento) como
 * camada do turno do agente.
 *
 * O roteiro é DADO, não código: etapas, frases, passagens e regras do revisor
 * moram em `def_roteiros.conteudo` (por agente). O código só sabe a ordem das
 * etapas, os critérios de saída (sobre a ficha) e como aplicar o revisor.
 * Outro consultório usa o mesmo motor trocando o JSON.
 */
import { z } from 'zod';

export const ETAPAS_DEF = [
  'contato',
  'descoberta',
  'encantamento',
  'isolamento',
  'fechamento',
  'reserva',
  'pos_reserva',
] as const;
export type EtapaDef = (typeof ETAPAS_DEF)[number];

export function eEtapaDef(v: unknown): v is EtapaDef {
  return typeof v === 'string' && (ETAPAS_DEF as readonly string[]).includes(v);
}

/** O que a última mensagem do lead pede. O roteador decide a passagem por elas. */
export const INTENCOES_DEF = [
  'pergunta_preco',
  'pergunta_clinica',
  'urgencia',
  'quer_humano',
  'adulto',
  'dermatologia',
  'curso_iess',
  'paciente_antigo',
  'quer_cartao',
  'enviou_comprovante',
  'pediu_depois',
  'desistiu',
  'golpe',
  'irritado',
  'pergunta_fora_da_base',
  'quer_data_antes',
  'formato_laudo',
] as const;
export type IntencaoDef = (typeof INTENCOES_DEF)[number];

const fraseSchema = z.object({
  id: z.string().min(1),
  texto: z.string().min(1),
  quando: z.string().optional(),
});
export type FraseDef = z.infer<typeof fraseSchema>;

const blocoSchema = z.object({
  titulo: z.string().min(1),
  instrucoes: z.string().min(1),
  frases: z.array(fraseSchema).default([]),
});
export type BlocoDef = z.infer<typeof blocoSchema>;

const passagemSchema = z.object({
  intencao: z.enum(INTENCOES_DEF),
  /** passar = chama a equipe; responder = segue a venda com a mensagem; dispensar = encerra. */
  acao: z.enum(['passar', 'responder', 'dispensar', 'urgencia']),
  mensagem: z.string().min(1),
  fora_do_horario: z.string().optional(),
});
export type PassagemDef = z.infer<typeof passagemSchema>;

export const roteiroDefSchema = z.object({
  versao: z.literal(1),
  /** Modelo barato do extrator e do revisor (do MESMO provedor do agente). */
  modelo_extrator: z.string().min(1).optional(),
  modelo_revisor: z.string().min(1).optional(),
  equipe: z.object({
    dias: z.array(z.number().int().min(0).max(6)).min(1),
    inicio: z.string().regex(/^\d{2}:\d{2}$/),
    fim: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  etapas: z.object({
    contato: blocoSchema,
    descoberta: blocoSchema,
    encantamento: blocoSchema,
    isolamento: blocoSchema,
    fechamento: blocoSchema,
    reserva: blocoSchema,
    pos_reserva: blocoSchema,
  }),
  modos: z.object({
    objecao: blocoSchema,
    dispensa: blocoSchema,
    decidido: blocoSchema.optional(),
    retomada: blocoSchema.optional(),
  }),
  passagens: z.array(passagemSchema).default([]),
  extrator: z.object({ instrucoes: z.string().min(1) }),
  revisor: z.object({
    ativo: z.boolean().default(true),
    /** Os fatos que a mensagem pode afirmar (regra 9 do revisor). */
    base: z.string().min(1),
    regras_modelo: z.array(z.string().min(1)).min(1),
    regex_nunca_diga: z.array(z.string().min(1)).default([]),
    links_permitidos: z.array(z.string().min(1)).default([]),
    /** O que o lead recebe quando o revisor reprova duas vezes. `{nome}` vira o nome. */
    mensagem_espera: z.string().min(1),
  }),
});
export type RoteiroDef = z.infer<typeof roteiroDefSchema>;

// ── A FICHA ─────────────────────────────────────────────────────────────────
//
// Saída de modelo é dado NÃO confiável: cada campo é solto (`.catch`) para que
// um valor fora do vocabulário vire "não sabido" em vez de derrubar a ficha
// inteira. Campo ausente mantém o valor anterior (ver `mesclarFicha`).

function solto<T extends z.ZodTypeAny>(s: T) {
  return s.optional().catch(undefined);
}

export const fichaDefSchema = z
  .object({
    perfil: solto(z.enum(['engano', 'decidido', 'empoderado', 'curioso', 'indefinido'])),
    para_quem: solto(z.enum(['filho', 'filha', 'outro', 'nao_informado'])),
    idade_anos: solto(z.number().min(0).max(120).nullable()),
    nome_crianca: solto(z.string().max(80).nullable()),
    nome_responsavel: solto(z.string().max(80).nullable()),
    cidade: solto(z.string().max(80).nullable()),
    uf: solto(z.string().max(30).nullable()),
    formato_preferido: solto(z.enum(['presencial', 'online', 'indiferente', 'nao_informado'])),
    tem_diagnostico: solto(z.enum(['sim', 'nao', 'investigando', 'nao_informado'])),
    acompanhamento_atual: solto(z.array(z.string().max(40)).max(10)),
    motivo: solto(
      z.enum([
        'suspeita',
        'escola_pediu',
        'encaminhamento',
        'laudo',
        'segunda_opiniao',
        'revisao_medicacao',
        'sem_acesso',
        'beneficio',
        'outro',
      ]).nullable(),
    ),
    motivo_texto: solto(z.string().max(240).nullable()),
    prazo: solto(z.object({ data: z.string().max(40).nullable(), finalidade: z.string().max(60).nullable() }).nullable()),
    dor_aprofundada: solto(z.boolean()),
    convenio_citado: solto(z.boolean()),
    decisor: solto(z.enum(['proprio', 'conjuge', 'outro', 'nao_mapeado'])),
    termometro: solto(z.enum(['imediato', 'futuro', 'nao_perguntado'])),
    data_retorno_pedida: solto(z.string().max(40).nullable()),
    pressa: solto(z.boolean()),
    recuo_estrategico_feito: solto(z.boolean()),
    parafraseou: solto(z.boolean()),
    acordo_sinceridade: solto(z.enum(['aceito', 'recusado', 'nao_feito'])),
    red_flags: solto(
      z.array(z.object({ descricao: z.string().max(160), resolvida: z.boolean().catch(false) })).max(20),
    ),
    diferenciais_lembrados: solto(
      z.object({ quantidade: z.number().int().min(0).max(3), quais: z.array(z.string().max(40)).max(3) }).nullable(),
    ),
    isolamento: solto(z.enum(['so_financeiro', 'outra_variavel', 'nao_feito'])),
    preco_informado_em: solto(z.string().max(30).nullable()),
    reacao_preco: solto(z.enum(['sim', 'sim_sem_firmeza', 'nao']).nullable()),
    preferencia_turno: solto(z.string().max(60).nullable()),
    horario_escolhido: solto(z.string().max(80).nullable()),
    ficha_nf_completa: solto(z.boolean()),
    pagamento: solto(z.enum(['pix', 'cartao', 'depois', 'nao']).nullable()),
    objecoes: solto(
      z
        .array(
          z.object({
            tipo: z.string().max(40),
            momento: z.string().max(30).nullable().catch(null),
            mao: z.enum(['dupla', 'unica']).catch('dupla'),
            evitavel_em: z.string().max(30).nullable().catch(null),
            saida_usada: z.string().max(60).nullable().catch(null),
            contornada: z.boolean().catch(false),
          }),
        )
        .max(30),
    ),
    motivo_perda: solto(z.string().max(30).nullable()),
    /** A pergunta de verificação já foi repetida uma vez (encantamento). */
    verificacao_repetida: solto(z.boolean()),
  });
export type FichaDef = z.infer<typeof fichaDefSchema>;

/** O que o extrator devolve, além da ficha. */
export interface ExtracaoDef {
  ficha: FichaDef;
  intencoes: IntencaoDef[];
  objecao_atual: string | null;
  provas: Record<string, string>;
}
