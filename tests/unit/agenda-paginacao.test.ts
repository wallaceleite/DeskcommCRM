import { expect, it, vi } from "vitest";
import { protecaoAgendaPg, protecaoAgendaSupabase } from "@/lib/agenda/protecao-followup";
import { assertAgendaEffectSupabase } from "@/lib/agenda/efeito";
import { logger } from "@/lib/logger";
const now = new Date("2026-09-06T12:00:00Z");
it("páginas truncadas abaixo do limit são lidas até vazio; protetor após 1000 coincide com PG e barra efeito", async () => {
  const rows = Array.from({ length: 1101 }, (_, n) => ({
    id: String(n).padStart(5, "0"),
    contact_id: "contact",
    revision: 1,
    status: "confirmed",
    starts_at: n === 1100 ? "2099-01-01T12:00:00Z" : "2020-01-01T12:00:00Z",
    ends_at: n === 1100 ? "2099-01-01T13:00:00Z" : "2020-01-01T13:00:00Z",
  }));
  const cursors: string[] = [];
  const db = {
    from: (table: string) => {
      let cursor = "";
      const q = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        gt: (_key: string, value: string) => {
          cursor = value;
          return q;
        },
        single: async () => ({ data: { settings: {} }, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          cursors.push(cursor);
          return Promise.resolve({
            data:
              table === "calendar_appointments"
                ? rows.filter((r) => r.id > cursor).slice(0, 127)
                : [],
            error: null,
          }).then(resolve);
        },
      };
      return q;
    },
  };
  const a = (await protecaoAgendaSupabase(db as never, "org", ["contact"], now)).get("contact");
  const pg = {
    query: async (sql: string) => ({
      rows: sql.includes("calendar_appointments") ? rows : [{ settings: {} }],
    }),
  };
  expect(a).toEqual(await protecaoAgendaPg(pg as never, "org", "contact", now));
  expect(a).toMatchObject({ adiar: true, appointment_id: "01100" });
  expect(cursors.at(-1)).toBe("01100");
  await expect(
    assertAgendaEffectSupabase(db as never, { organizationId: "org", contactId: "contact" }),
  ).rejects.toMatchObject({ protection: { adiar: true, appointment_id: "01100" } });
});
it("falha de página posterior não transforma leitura parcial em ausência", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  let second = false;
  const q = {
    select: () => q,
    eq: () => q,
    in: () => q,
    order: () => q,
    limit: () => q,
    gt: () => {
      second = true;
      return q;
    },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve(
        second
          ? { data: null, error: { message: "page unavailable" } }
          : { data: [{ id: "1", contact_id: "c" }], error: null },
      ).then(resolve),
  };
  expect(
    (await protecaoAgendaSupabase({ from: () => q } as never, "org", ["c"], now)).get("c"),
  ).toMatchObject({ adiar: true, motivo: "leitura_indisponivel" });
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});
it("fork: centenas de contatos vão em lotes de no máximo 100 no .in(), e o protetor de qualquer lote é achado", async () => {
  // 500 uuids num único `.in()` estouravam o header Content-Location do
  // PostgREST: a leitura falhava inteira e o radar de risco quebrava.
  const contatos = Array.from({ length: 250 }, (_, n) => `contato-${String(n).padStart(3, "0")}`);
  const tamanhos: number[] = [];
  const db = {
    from: (table: string) => {
      let lote: string[] = [];
      let cursor = "";
      const q = {
        select: () => q,
        eq: () => q,
        in: (coluna: string, valores: string[]) => {
          if (coluna === "contact_id") {
            lote = valores;
            tamanhos.push(valores.length);
          }
          return q;
        },
        order: () => q,
        limit: () => q,
        gt: (_k: string, v: string) => {
          cursor = v;
          return q;
        },
        single: async () => ({ data: { settings: {} }, error: null }),
        then: (resolve: (value: unknown) => unknown) => {
          const linhas =
            table === "calendar_appointments" && lote.includes("contato-240") && cursor === ""
              ? [
                  {
                    id: "a1",
                    contact_id: "contato-240",
                    revision: 1,
                    status: "confirmed",
                    starts_at: "2099-01-01T12:00:00Z",
                    ends_at: "2099-01-01T13:00:00Z",
                  },
                ]
              : [];
          return Promise.resolve({ data: linhas, error: null }).then(resolve);
        },
      };
      return q;
    },
  };
  const mapa = await protecaoAgendaSupabase(db as never, "org", contatos, now);
  expect(Math.max(...tamanhos)).toBeLessThanOrEqual(100);
  expect(new Set(tamanhos.filter((t) => t > 0))).toEqual(new Set([100, 50]));
  expect(mapa.get("contato-240")).toMatchObject({ adiar: true, appointment_id: "a1" });
  expect(mapa.get("contato-001")?.motivo).not.toBe("leitura_indisponivel");
});
