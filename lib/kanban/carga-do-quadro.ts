/**
 * Fork: as duas peças da carga do quadro que não falam com o banco — testáveis
 * sem a rota (`app/api/v1/pipelines/[id]/board/route.ts`).
 */

/**
 * O PostgREST corta a resposta em `max_rows` (1000 no Supabase e no kit) SEM
 * erro: um funil com 1001 negócios perdia cards em silêncio, de qualquer coluna.
 */
export const PAGINA_DO_QUADRO = 1000;

type Pagina<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Lê tudo, uma página depois da outra, até vir uma página incompleta. Quem chama
 * ordena com desempate único (`id`): sem ele, duas páginas podiam repetir ou
 * pular o mesmo card.
 */
export async function lerEmPaginas<T>(
  pagina: (de: number, ate: number) => Pagina<T>,
  tamanho: number = PAGINA_DO_QUADRO,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  const todos: T[] = [];
  for (let de = 0; ; ) {
    const { data, error } = await pagina(de, de + tamanho - 1);
    if (error) return { data: null, error };
    const linhas = data ?? [];
    todos.push(...linhas);
    if (linhas.length < tamanho) return { data: todos, error: null };
    de += linhas.length;
  }
}

/**
 * Junta o que cada etapa INDEPENDENTE acrescentou ao mesmo negócio.
 *
 * As etapas rodam ao mesmo tempo sobre a MESMA lista, e cada uma só acrescenta o
 * próprio campo. Todas devolvem a lista na mesma ordem e tamanho, então o índice
 * casa o negócio entre elas.
 */
export function juntarCampos<T extends object>(base: T[], versoes: T[][]): T[] {
  return base.map((item, i) => Object.assign({}, item, ...versoes.map((v) => v[i])));
}
