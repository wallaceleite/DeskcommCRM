// @vitest-environment node
//
// Fork: O PORTÃO CONFERE O JWT SEM IR AO SERVIDOR DE AUTH.
//
// Cada pedido perguntava ao servidor de auth do Supabase (`getUser`) antes de
// chegar à rota — que pergunta de novo. A Caixa de entrada abre ~20 pedidos de
// uma vez, e a fila dessas conferências deixava até rota trivial em 1 s. O
// portão agora usa `getClaims` (assinatura conferida localmente); a rota segue
// com o `getUser` que decide acesso a dado. Voltar o portão para `getUser` deixa
// o primeiro caso vermelho; aceitar pedido sem JWT válido deixa o segundo.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn(async () => ({ data: { user: { id: "u-1" } }, error: null }));
const getClaims = vi.fn(async () => ({ data: { claims: { sub: "u-1" } }, error: null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser, getClaims } }),
}));

async function pedir(url: string) {
  const { proxy } = await import("@/proxy");
  const { NextRequest } = await import("next/server");
  return proxy(new NextRequest(url));
}

describe("portão do proxy", () => {
  beforeEach(() => {
    getUser.mockClear();
    getClaims.mockClear();
  });

  it("JWT válido passa sem perguntar ao servidor de auth", async () => {
    const res = await pedir("https://crm.exemplo/api/v1/conversations");
    expect(res.status).toBe(200);
    expect(getClaims).toHaveBeenCalledTimes(1);
    expect(getUser).not.toHaveBeenCalled();
    expect(res.headers.get("Server-Timing")).toMatch(/^portao;dur=\d+$/);
  });

  it("sem JWT válido, API recebe 401 e tela vai para o login", async () => {
    getClaims.mockResolvedValue({ data: null, error: { message: "sem sessão" } } as never);
    const api = await pedir("https://crm.exemplo/api/v1/conversations");
    expect(api.status).toBe(401);
    const tela = await pedir("https://crm.exemplo/app/inbox");
    expect(tela.status).toBe(307);
    expect(tela.headers.get("location")).toContain("/login");
  });
});
