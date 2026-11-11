/**
 * Por que o microfone não abriu, dito de um jeito que aponta o conserto.
 *
 * O `catch` do gravador entregava um `Error` cru a `showApiError`, que só
 * reconhece `ApiError` e cai no genérico: quem clicava no microfone lia
 * "Erro inesperado. Tente novamente." para permissão bloqueada, computador sem
 * microfone e microfone ocupado. São três problemas com três consertos, e
 * nenhum deles é "tentar de novo".
 *
 * O nome do erro (`NotAllowedError`, `NotFoundError`…) é o da especificação de
 * `getUserMedia`; os nomes antigos do Chrome (`PermissionDeniedError`,
 * `DevicesNotFoundError`, `TrackStartError`) seguem aceitos por compatibilidade.
 */
type Traduzir = (texto: string) => string;

export interface AvisoDoMicrofone {
  mensagem: string;
  /** O nome técnico do erro, para quem for diagnosticar. */
  codigo?: string;
}

/** Nome usado pelo gravador quando o navegador não oferece gravação nenhuma. */
export const SEM_SUPORTE_A_GRAVACAO = "SemSuporteAGravacao";

function nomeDoErro(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "name" in err) {
    const nome = (err as { name: unknown }).name;
    if (typeof nome === "string" && nome) return nome;
  }
  return undefined;
}

export function avisoDoMicrofone(err: unknown, t: Traduzir): AvisoDoMicrofone {
  const codigo = nomeDoErro(err);
  switch (codigo) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return {
        codigo,
        mensagem: t(
          "O navegador está bloqueando o microfone deste site. Clique no cadeado ao lado do endereço, permita o Microfone e recarregue a página. Se já estiver permitido, libere o microfone para o navegador nas configurações de privacidade do computador.",
        ),
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return {
        codigo,
        mensagem: t(
          "Nenhum microfone encontrado neste computador. Conecte um fone com microfone e tente de novo.",
        ),
      };
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return {
        codigo,
        mensagem: t(
          "O microfone está sendo usado por outro programa (Meet, Zoom, WhatsApp Desktop). Feche-o e tente de novo.",
        ),
      };
    case SEM_SUPORTE_A_GRAVACAO:
    case "NotSupportedError":
      return {
        codigo,
        mensagem: t("Este navegador não grava áudio nesta página. Use o Google Chrome atualizado."),
      };
    default:
      return {
        codigo,
        mensagem: t("Não consegui acessar o microfone. Verifique a permissão do navegador."),
      };
  }
}
