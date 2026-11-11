import { describe, expect, it } from "vitest";

import { SEM_SUPORTE_A_GRAVACAO, avisoDoMicrofone } from "./aviso-do-microfone";

const t = (texto: string) => texto;
const erro = (name: string) => Object.assign(new Error("x"), { name });

describe("avisoDoMicrofone — o motivo real, nunca 'Erro inesperado'", () => {
  it.each(["NotAllowedError", "PermissionDeniedError", "SecurityError"])(
    "%s aponta o cadeado da barra de endereço",
    (nome) => {
      const aviso = avisoDoMicrofone(erro(nome), t);
      expect(aviso.mensagem).toMatch(/bloqueando o microfone/);
      expect(aviso.codigo).toBe(nome);
    },
  );

  it.each(["NotFoundError", "DevicesNotFoundError", "OverconstrainedError"])(
    "%s diz que não há microfone",
    (nome) => {
      expect(avisoDoMicrofone(erro(nome), t).mensagem).toMatch(/Nenhum microfone encontrado/);
    },
  );

  it.each(["NotReadableError", "TrackStartError", "AbortError"])(
    "%s diz que outro programa está usando",
    (nome) => {
      expect(avisoDoMicrofone(erro(nome), t).mensagem).toMatch(/outro programa/);
    },
  );

  it("navegador sem gravação pede o Chrome", () => {
    expect(avisoDoMicrofone(erro(SEM_SUPORTE_A_GRAVACAO), t).mensagem).toMatch(/Google Chrome/);
    expect(avisoDoMicrofone(erro("NotSupportedError"), t).mensagem).toMatch(/Google Chrome/);
  });

  it("DOMException real (o que o navegador lança) é reconhecida pelo nome", () => {
    const aviso = avisoDoMicrofone(new DOMException("Permission denied", "NotAllowedError"), t);
    expect(aviso.codigo).toBe("NotAllowedError");
    expect(aviso.mensagem).toMatch(/bloqueando o microfone/);
  });

  it("erro desconhecido ou sem nome cai na frase de permissão, sem inventar código", () => {
    expect(avisoDoMicrofone("string solta", t)).toEqual({
      codigo: undefined,
      mensagem: "Não consegui acessar o microfone. Verifique a permissão do navegador.",
    });
    expect(avisoDoMicrofone(erro("TypeError"), t).mensagem).toMatch(/Não consegui acessar/);
  });

  it("passa toda frase por t()", () => {
    const aviso = avisoDoMicrofone(erro("NotAllowedError"), (s) => `[${s}]`);
    expect(aviso.mensagem.startsWith("[")).toBe(true);
  });
});
