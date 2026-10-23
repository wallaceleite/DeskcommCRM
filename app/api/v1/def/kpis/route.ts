/**
 * [fork wallaceleite] GET /api/v1/def/kpis — os números do Método DEF de um
 * agente num período, para o painel de KPIs do consultório.
 *
 * Lê só o que o fork grava (`def_fichas`, `def_eventos`): quantos contatos estão
 * em cada etapa, em que etapa o preço apareceu, o que o revisor barrou, quais
 * passagens aconteceram, quais objeções e motivos de perda a ficha registrou.
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

  const [porEtapa, eventos, revisor, precoPorEtapa, passagens, objecoes, perdas] = await Promise.all([
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
      `select dados->>'intencao' as intencao, count(*)::int as total from def_eventos
        where organization_id = $1 and agent_id = $2 and created_at between $3 and $4 and tipo = 'passagem'
        group by dados->>'intencao'`,
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
  });
}
