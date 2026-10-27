import { beforeEach, expect, it, vi } from "vitest";

const consultas: string[] = [];
let fichaNoBanco: Record<string, unknown> | null = null;
const audit = vi.fn();

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({ ok: true, user: { id: "u1" }, org: { orgId: "org1" } }),
}));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => audit(...a) }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({
  getRequestPool: () => ({
    connect: async () => ({
      query: async (sql: string) => {
        consultas.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("from def_fichas")) return { rows: fichaNoBanco ? [fichaNoBanco] : [] };
        if (sql.includes("update def_horarios")) return { rowCount: 0, rows: [] };
        return { rows: [], rowCount: 1 };
      },
      release: () => {},
    }),
  }),
}));

import { POST } from "./route";

const pedido = (corpo: unknown) =>
  new Request("http://x/api/v1/def/titular/recomecar", { method: "POST", body: JSON.stringify(corpo) }) as never;
const CONTATO = "94380988-a926-4075-97e6-6fdc4839c1a5";

beforeEach(() => {
  consultas.length = 0;
  audit.mockClear();
});

it("guarda a ficha antiga num evento ANTES de zerar, e audita", async () => {
  fichaNoBanco = { etapa: "fechamento", ficha: { idade_anos: 6 }, provas: {}, agent_id: "a1" };
  const r = await POST(pedido({ contact_id: CONTATO }));
  const corpo = (await r.json()) as { data: { etapa_anterior: string; tinha_ficha: boolean } };
  expect(corpo.data).toMatchObject({ etapa_anterior: "fechamento", tinha_ficha: true });
  const evento = consultas.findIndex((s) => s.includes("insert into def_eventos") && s.includes("'recomeco'"));
  const zerou = consultas.findIndex((s) => s.includes("update def_fichas set etapa = 'contato'"));
  expect(evento).toBeGreaterThan(-1);
  expect(zerou).toBeGreaterThan(evento);
  expect(consultas.at(-1)).toBe("commit");
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "def.ficha_recomecada" }));
});

it("sem ficha e sem vaga segura: nada muda e não audita", async () => {
  fichaNoBanco = null;
  const r = await POST(pedido({ contact_id: CONTATO }));
  expect(r.status).toBe(200);
  expect(consultas.some((s) => s.includes("update def_fichas"))).toBe(false);
  expect(audit).not.toHaveBeenCalled();
});

it("contact_id inválido: 422 sem tocar no banco", async () => {
  const r = await POST(pedido({ contact_id: "x" }));
  expect(r.status).toBe(422);
  expect(consultas).toHaveLength(0);
});
