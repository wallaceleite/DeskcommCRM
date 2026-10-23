/**
 * [fork wallaceleite] Leitor mínimo de .xlsx, sem dependência: só o que o
 * gerador do roteiro DEF precisa — o texto das células de cada aba, linha a
 * linha. O .xlsx é um zip de XML; aqui se lê o diretório central do zip, se
 * descomprime (deflate) as entradas e se tiram os valores com expressão regular.
 *
 * Não lê fórmula, estilo nem data: as planilhas do pacote são texto.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

function entradasDoZip(buf: Buffer): Map<string, Buffer> {
  // Fim do diretório central: assinatura 0x06054b50, procurada de trás para frente.
  let fim = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw new Error("arquivo não é um zip (.xlsx)");
  const total = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const saida = new Map<string, Buffer>();
  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("diretório central do zip inválido");
    const metodo = buf.readUInt16LE(p + 10);
    const tamanho = buf.readUInt32LE(p + 20);
    const lenNome = buf.readUInt16LE(p + 28);
    const lenExtra = buf.readUInt16LE(p + 30);
    const lenComentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nome = buf.subarray(p + 46, p + 46 + lenNome).toString("utf8");
    const inicio = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const dados = buf.subarray(inicio, inicio + tamanho);
    saida.set(nome, metodo === 0 ? dados : inflateRawSync(dados));
    p += 46 + lenNome + lenExtra + lenComentario;
  }
  return saida;
}

function desescapar(t: string): string {
  return t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function textosDe(xml: string): string {
  return [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => desescapar(m[1]!)).join("");
}

function coluna(ref: string): number {
  const letras = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const c of letras) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/** Cada aba como lista de linhas; cada linha, o texto das células (vazio = ""). */
export function lerXlsx(caminho: string): Map<string, string[][]> {
  const zip = entradasDoZip(readFileSync(caminho));
  const compartilhadas = [...(zip.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => textosDe(m[1]!),
  );
  const workbook = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const atributo = (tag: string, nome: string) => new RegExp(`\\b${nome}="([^"]*)"`).exec(tag)?.[1] ?? "";
  const alvo = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [atributo(m[0], "Id"), atributo(m[0], "Target")]),
  );
  const abas = new Map<string, string[][]>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const nome = desescapar(atributo(m[0], "name"));
    const destino = (alvo.get(atributo(m[0], "r:id")) ?? "").replace(/^\/?(xl\/)?/, "");
    const xml = zip.get(`xl/${destino}`)?.toString("utf8") ?? "";
    const linhas: string[][] = [];
    for (const lin of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const celulas: string[] = [];
      for (const c of lin[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? "";
        const corpo = c[2] ?? "";
        const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "";
        const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
        const texto =
          tipo === "s"
            ? (compartilhadas[Number(v)] ?? "")
            : tipo === "inlineStr"
              ? textosDe(corpo)
              : v !== undefined
                ? desescapar(v)
                : "";
        celulas[coluna(ref)] = texto.trim();
      }
      linhas.push(Array.from(celulas, (x) => x ?? ""));
    }
    abas.set(nome, linhas);
  }
  return abas;
}
