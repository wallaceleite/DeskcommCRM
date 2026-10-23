/**
 * [fork wallaceleite] GET /api/v1/def/titular?contact_id= — o que o Método DEF
 * guarda sobre um titular (LGPD, pedido de acesso): a ficha, as provas e os
 * eventos (sem texto do cliente).
 *
 * A exportação do núcleo (`lib/lgpd/export-collector.ts`) lista cada tabela à
 * mão e não tem ponto de extensão; até o fork entrar lá, quem atende o pedido
 * anexa esta resposta ao arquivo exportado. A exclusão não depende disto: a
 * anonimização do contato apaga a ficha e os eventos (`trg_def_esquecer_contato`).
 *
 * Só admin (o mesmo papel que gera a exportação). `organization_id` do papel.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const authz = await requireRole("admin", { resource: "def_titular" });
  if (!authz.ok) return authz.response;
  const contactId = z.string().uuid().safeParse(req.nextUrl.searchParams.get("contact_id"));
  if (!contactId.success) return fail("invalid_query", "contact_id inválido", 422);

  const pool = getRequestPool();
  const [ficha, eventos] = await Promise.all([
    pool.query(
      `select etapa, ficha, provas, atualizada_em from def_fichas where organization_id = $1 and contact_id = $2`,
      [authz.org.orgId, contactId.data],
    ),
    pool.query(
      `select tipo, etapa, dados, created_at from def_eventos
        where organization_id = $1 and contact_id = $2 order by created_at`,
      [authz.org.orgId, contactId.data],
    ),
  ]);
  return ok({ contact_id: contactId.data, ficha: ficha.rows[0] ?? null, eventos: eventos.rows });
}
