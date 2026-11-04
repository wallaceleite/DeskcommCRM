import { describe, expect, it, vi } from "vitest";

import { juntarCampos, lerEmPaginas } from "./carga-do-quadro";

/** Um banco de mentira que corta cada resposta em `teto` linhas, como o PostgREST. */
function bancoCom(total: number, teto = 1000) {
  const linhas = Array.from({ length: total }, (_, i) => ({ id: `n${i}` }));
  return vi.fn((de: number, ate: number) =>
    Promise.resolve({ data: linhas.slice(de, Math.min(ate + 1, de + teto)), error: null }),
  );
}

describe("lerEmPaginas", () => {
  it("funil com mais de 1000 negócios chega inteiro, sem repetir nenhum", async () => {
    const pagina = bancoCom(2350);
    const { data, error } = await lerEmPaginas(pagina);
    expect(error).toBeNull();
    expect(data).toHaveLength(2350);
    expect(new Set(data!.map((l) => l.id)).size).toBe(2350);
    expect(pagina).toHaveBeenCalledTimes(3);
  });

  it("funil abaixo do teto custa uma ida só", async () => {
    const pagina = bancoCom(935);
    const { data } = await lerEmPaginas(pagina);
    expect(data).toHaveLength(935);
    expect(pagina).toHaveBeenCalledTimes(1);
  });

  it("exatamente 1000: confere a página seguinte e para nela, vazia", async () => {
    const pagina = bancoCom(1000);
    const { data } = await lerEmPaginas(pagina);
    expect(data).toHaveLength(1000);
    expect(pagina).toHaveBeenCalledTimes(2);
  });

  it("erro em qualquer página devolve o erro, nunca meio funil", async () => {
    let chamada = 0;
    const { data, error } = await lerEmPaginas<{ id: string }>(() => {
      chamada += 1;
      return Promise.resolve(
        chamada === 1
          ? { data: Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}` })), error: null }
          : { data: null, error: { message: "caiu" } },
      );
    });
    expect(data).toBeNull();
    expect(error?.message).toBe("caiu");
  });
});

describe("juntarCampos", () => {
  it("cada etapa paralela acrescenta o seu campo ao mesmo negócio", () => {
    const base = [{ id: "a" }, { id: "b" }];
    const comScore = [{ id: "a", score: 1 }, { id: "b" }];
    const comTarefas = [{ id: "a" }, { id: "b", tasks: 2 }];
    expect(juntarCampos<Record<string, unknown>>(base, [comScore, comTarefas])).toEqual([
      { id: "a", score: 1 },
      { id: "b", tasks: 2 },
    ]);
  });

  it("não muda a lista de entrada", () => {
    const base = [{ id: "a" }];
    juntarCampos<Record<string, unknown>>(base, [[{ id: "a", score: 1 }]]);
    expect(base).toEqual([{ id: "a" }]);
  });
});
