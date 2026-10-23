/**
 * [fork wallaceleite] GET /api/v1/def/kpis — os números do Método DEF de um
 * agente num período, para o painel de KPIs do consultório.
 *
 * Fluxo do período, não a foto: a conversão entre etapas conta os eventos
 * `etapa` (de → para) do período; a foto (`contatos_por_etapa`) segue junto.
 * Também: preço por etapa (F1/F3), turnos que terminam em pergunta (N4), vetos
 * por regra (N1/N2), passagens por intenção e por horário, rótulos das
 * mensagens (tipo, formato e foco da pergunta, comando × voz passiva) e o tempo
 * da 1ª resposta (da tabela `messages`, só leitura).
 * Nenhum texto de cliente sai daqui — só contagens e rótulos.
 *
 * Pool do servidor com `organization_id` do papel validado (tabelas do fork não
 * estão nos tipos gerados do Supabase).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

const consultaSchema = z.object({
  agent_id: z.string().uuid(),
  desde: z.string().datetime({ offset: true }).optional(),
  ate: z.string().datetime({ offset: true }).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("manager", { resource: "def_kpis" });
  if (!authz.ok) return authz.response;
  const sp = req.nextUrl.searchParams;
  const parsed = consultaSchema.safeParse({
    agent_id: sp.get("agent_id"),
    desde: sp.get("desde") ?? undefined,
    ate: sp.get("ate") ?? undefined,
  });
  if (!parsed.success) return fail("invalid_query", "consulta inválida", 422, { details: parsed.error.issues });

  const org = authz.org.orgId;
  const { agent_id } = parsed.data;
  const desde = parsed.data.desde ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
  const ate = parsed.data.ate ?? new Date().toISOString();
  const pool = getRequestPool();
  const p = [org, agent_id, desde, ate];

  const [
    porEtapa,
    eventos,
    revisor,
    precoPorEtapa,
    passagens,
    objecoes,
    perdas,
    conversao,
    turnos,
    rotulos,
    primeiraResposta,
  ] = await Promise.all([
    pool.query(
      `select etapa, count(*)::int as contatos from def_fichas
        where organization_id = $1 and agent_id = $2 and atualizada_em between $3 and $4
        group by etapa`,
      p,
    ),
    pool.query(
      `select tipo, count(*)::int as total from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4
        group by tipo`,
      p,
    ),
    pool.query(
      `select regra, dados->>'origem' as origem, count(*)::int as total
         from def_eventos, jsonb_array_elements_text(coalesce(dados->'regras', '[]'::jsonb)) as regra
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'revisor'
        group by regra, dados->>'origem'`,
      p,
    ),
    pool.query(
      `select etapa, count(*) filter (where (dados->>'tem_preco')::boolean)::int as com_preco,
              count(*)::int as mensagens,
              count(*) filter (where (dados->>'termina_em_pergunta')::boolean)::int as terminam_em_pergunta
         from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'mensagem'
        group by etapa`,
      p,
    ),
    pool.query(
      `select dados->>'intencao' as intencao, (dados->>'dentro_do_horario')::boolean as dentro_do_horario,
              count(*)::int as total
         from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'passagem'
        group by 1, 2`,
      p,
    ),
    pool.query(
      `select o->>'tipo' as tipo, count(*)::int as total,
              count(*) filter (where (o->>'contornada')::boolean)::int as contornadas
         from def_fichas, jsonb_array_elements(coalesce(ficha->'objecoes', '[]'::jsonb)) as o
        where organization_id = $1 and agent_id = $2 and atualizada_em between $3 and $4
        group by o->>'tipo'`,
      p,
    ),
    pool.query(
      `select ficha->>'motivo_perda' as motivo, count(*)::int as total from def_fichas
        where organization_id = $1 and agent_id = $2 and atualizada_em between $3 and $4
          and ficha->>'motivo_perda' is not null
        group by ficha->>'motivo_perda'`,
      p,
    ),
    pool.query(
      `select dados->>'de' as de, dados->>'para' as para, count(*)::int as total from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'etapa'
        group by 1, 2`,
      p,
    ),
    pool.query(
      `select count(*)::int as turnos_com_fala,
              count(*) filter (where (dados->>'termina_em_pergunta')::boolean)::int as terminam_em_pergunta,
              count(*) filter (where (dados->>'perguntas')::int > 1)::int as mais_de_uma_pergunta
         from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'turno'
          and (dados->>'mensagens')::int > 0
          and not coalesce((dados->>'passou')::boolean, false)
          and coalesce(dados->>'modo', 'normal') not in ('urgencia', 'dispensa', 'passagem')`,
      p,
    ),
    pool.query(
      `select etapa, dados->>'tipo_pergunta' as tipo_pergunta, dados->>'formato_pergunta' as formato_pergunta,
              dados->>'foco_pergunta' as foco_pergunta, dados->>'modo_frase' as modo_frase,
              count(*)::int as total,
              count(*) filter (where dados->>'usou_frase_matriz' is not null)::int as usou_frase_matriz
         from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'mensagem'
          and dados ? 'tipo_pergunta'
        group by 1, 2, 3, 4, 5`,
      p,
    ),
    pool.query(
      `with contatos as (
         select distinct contact_id from def_eventos
          where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and contact_id is not null
       ), primeira as (
         select m.contact_id, min(m.sent_at) as chegou
           from messages m join contatos c on c.contact_id = m.contact_id
          where m.organization_id = $1 and m.direction = 'inbound'
          group by m.contact_id
       ), espera as (
         select extract(epoch from (
                  select min(o.sent_at) from messages o
                   where o.organization_id = $1 and o.contact_id = p.contact_id
                     and o.direction = 'outbound' and o.sent_at >= p.chegou
                ) - p.chegou) as segundos
           from primeira p
       )
       select count(*)::int as contatos,
              percentile_cont(0.5) within group (order by segundos) as mediana_segundos,
              avg(segundos) as media_segundos,
              count(*) filter (where segundos <= 300)::int as ate_5_minutos
         from espera where segundos is not null`,
      p,
    ),
  ]);

  return ok({
    periodo: { desde, ate },
    contatos_por_etapa: porEtapa.rows,
    eventos: eventos.rows,
    revisor_por_regra: revisor.rows,
    mensagens_por_etapa: precoPorEtapa.rows,
    passagens: passagens.rows,
    objecoes: objecoes.rows,
    motivos_de_perda: perdas.rows,
    conversao_entre_etapas: conversao.rows,
    turnos: turnos.rows[0] ?? null,
    rotulos_das_mensagens: rotulos.rows,
    primeira_resposta: primeiraResposta.rows[0] ?? null,
  });
}
