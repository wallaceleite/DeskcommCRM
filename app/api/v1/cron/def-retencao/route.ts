/**
 * [fork wallaceleite] GET /api/v1/cron/def-retencao — retenção das fichas do
 * Método DEF (dado de saúde, LGPD art. 11).
 *
 * Ficha sem atividade há 12 meses perde o conteúdo (`fn_def_reter_fichas`, em
 * `supabase/fork/rangel.sql`); a etapa fica, sem dado pessoal, para o histórico
 * do funil. Uma vez por dia, no `scheduler`. Audita só quando apagou algo.
 *
 * Auth: `Authorization: Bearer <INTERNAL_CRON_SECRET>`, como as irmãs.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";

export const dynamic = "force-dynamic";

/** Meses sem atividade até a ficha perder o conteúdo (pacote do consultório). */
const MESES_DE_RETENCAO = 12;

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  let esvaziadas: number;
  try {
    const r = await getRequestPool().query<{ n: number }>("select public.fn_def_reter_fichas($1) as n", [MESES_DE_RETENCAO]);
    esvaziadas = r.rows[0]?.n ?? 0;
  } catch (err) {
    // Fork sem o schema aplicado: nada a reter, e a rodada não pode falhar alto.
    const detalhe = err instanceof Error ? err.message : String(err);
    if (/fn_def_reter_fichas/.test(detalhe)) return ok({ esvaziadas: 0, schema_do_fork: false });
    throw err;
  }
  if (esvaziadas > 0) {
    void audit({
      action: "retention.sweep_run",
      organizationId: null,
      bypassedRls: true,
      metadata: { origem: "def-retencao", fichas_esvaziadas: esvaziadas, meses: MESES_DE_RETENCAO },
      requestId,
    });
  }
  return ok({ esvaziadas });
}
