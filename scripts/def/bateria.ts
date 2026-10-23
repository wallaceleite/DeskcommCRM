/**
 * [fork wallaceleite] A BATERIA DE ACEITE DO MÉTODO DEF (item 6 do PRD).
 *
 * Os 22 cenários da aba "Testes" da planilha 04, rodados pelo Testar do agente
 * (`POST /api/v1/ai/agents/{id}/versions/{vid}/test`) com `history`: cada
 * mensagem do cenário é um turno, e a resposta do agente entra no histórico do
 * turno seguinte. O que conferir por cenário está em `bateria-esperado.json`.
 *
 *   # só monta os cenários (para rodar em outro lugar, ex.: no navegador)
 *   pnpm tsx scripts/def/bateria.ts --gerar > cenarios.json
 *
 *   # roda contra uma instalação (a sessão é sua; nunca vai para o repositório)
 *   DESKCOMM_URL=https://crm.exemplo.com DESKCOMM_COOKIE='sb-...=...' \
 *     pnpm tsx scripts/def/bateria.ts --agente <uuid> --versao <uuid>
 *
 * Imprime, por cenário: etapa esperada × obtida, passagem esperada × obtida, as
 * regras do revisor acionadas e o texto que saiu. Sai com código 1 se algum
 * cenário reprovar.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { lerXlsx } from "./xlsx-minimo";

export interface CenarioDef {
  n: string;
  titulo: string;
  mensagens: string[];
  esperado: {
    roda?: boolean;
    porque?: string;
    etapa?: string[];
    modo?: string;
    passagem?: string | null;
    exigido?: string[];
    proibido?: string[];
  };
  comportamento: string;
}

export interface ResultadoDoTurno {
  final_text?: string;
  def?: {
    etapa: string;
    modo: string;
    passagem: string | null;
    vetos: { regras: string[]; origem: string }[];
  } | null;
}

function argumento(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function montarCenarios(fontes: string): CenarioDef[] {
  const esperado = JSON.parse(readFileSync(join(__dirname, "bateria-esperado.json"), "utf8")).cenarios as Record<
    string,
    CenarioDef["esperado"]
  >;
  const aba = lerXlsx(join(fontes, "agente-def", "04 - Configuração do agente.xlsx")).get("Testes") ?? [];
  const inicio = aba.findIndex((l) => l[0] === "#");
  return aba
    .slice(inicio + 1)
    .filter((l) => /^\d+$/.test(l[0] ?? ""))
    .map((l) => ({
      n: l[0]!,
      titulo: l[1] ?? "",
      mensagens: (l[2] ?? "")
        .split(/\s+\/\s+|\n/)
        .map((m) => m.trim())
        .filter((m) => m !== "" && !/^\(.*\)$/.test(m)),
      esperado: esperado[l[0]!] ?? {},
      comportamento: l[3] ?? "",
    }));
}

const semAcento = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Confere o último turno do cenário. Devolve as falhas (vazio = aprovado). */
export function conferir(c: CenarioDef, ultimo: ResultadoDoTurno): string[] {
  const falhas: string[] = [];
  const texto = semAcento(ultimo.final_text ?? "");
  const def = ultimo.def ?? null;
  if (def === null) return ["o turno não trouxe o resumo do Método DEF (roteiro inativo?)"];
  const e = c.esperado;
  if (e.etapa && !e.etapa.includes(def.etapa)) falhas.push(`etapa ${def.etapa}, esperada ${e.etapa.join(" ou ")}`);
  if (e.modo && def.modo !== e.modo) falhas.push(`modo ${def.modo}, esperado ${e.modo}`);
  if (e.passagem !== undefined && (def.passagem ?? null) !== e.passagem) {
    falhas.push(`passagem ${def.passagem ?? "nenhuma"}, esperada ${e.passagem ?? "nenhuma"}`);
  }
  for (const x of e.exigido ?? []) if (!new RegExp(x).test(texto)) falhas.push(`faltou /${x}/`);
  for (const x of e.proibido ?? []) if (new RegExp(x).test(texto)) falhas.push(`saiu /${x}/`);
  if (texto === "") falhas.push("nenhuma mensagem saiu");
  return falhas;
}

async function rodar(): Promise<void> {
  const url = process.env.DESKCOMM_URL;
  const cookie = process.env.DESKCOMM_COOKIE;
  const agente = argumento("--agente");
  const versao = argumento("--versao");
  if (!url || !cookie || !agente || !versao) {
    throw new Error("faltam DESKCOMM_URL, DESKCOMM_COOKIE, --agente ou --versao (ou use --gerar)");
  }
  const cenarios = montarCenarios(argumento("--fontes") ?? join(homedir(), "analise-atendimento-raphael"));
  let reprovados = 0;
  for (const c of cenarios) {
    if (c.esperado.roda === false) {
      process.stdout.write(`\n#${c.n} ${c.titulo}\n  NÃO RODA NO TESTAR: ${c.esperado.porque}\n`);
      continue;
    }
    const historico: { direction: "inbound" | "outbound"; body: string }[] = [];
    let ultimo: ResultadoDoTurno = {};
    for (const fala of c.mensagens) {
      const r = await fetch(`${url}/api/v1/ai/agents/${agente}/versions/${versao}/test`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ sample_message: fala, sample_contact: { name: "Juliana", phone: "+5511999990000" }, history: historico }),
      });
      ultimo = ((await r.json()) as { data?: ResultadoDoTurno }).data ?? {};
      historico.push({ direction: "inbound", body: fala });
      if (ultimo.final_text) historico.push({ direction: "outbound", body: ultimo.final_text });
    }
    const falhas = conferir(c, ultimo);
    if (falhas.length > 0) reprovados += 1;
    const def = ultimo.def;
    process.stdout.write(
      [
        `\n#${c.n} ${c.titulo} — ${falhas.length === 0 ? "APROVADO" : "REPROVADO"}`,
        `  etapa: ${c.esperado.etapa?.join("|") ?? "-"} × ${def?.etapa ?? "?"}   modo: ${c.esperado.modo ?? "-"} × ${def?.modo ?? "?"}`,
        `  passagem: ${c.esperado.passagem === undefined ? "-" : (c.esperado.passagem ?? "nenhuma")} × ${def?.passagem ?? "nenhuma"}`,
        `  revisor: ${(def?.vetos ?? []).map((v) => `${v.regras.join(",")}(${v.origem})`).join(" ") || "sem veto"}`,
        `  texto: ${(ultimo.final_text ?? "").replace(/\n+/g, " ⏎ ")}`,
        ...falhas.map((f) => `  ✗ ${f}`),
      ].join("\n") + "\n",
    );
  }
  process.stdout.write(`\n${cenarios.length} cenários, ${reprovados} reprovados\n`);
  if (reprovados > 0) process.exitCode = 1;
}

if (process.argv.includes("--gerar")) {
  process.stdout.write(
    JSON.stringify(montarCenarios(argumento("--fontes") ?? join(homedir(), "analise-atendimento-raphael")), null, 2) + "\n",
  );
} else if (require.main === module) {
  void rodar();
}
