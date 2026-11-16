-- manifest: Funil e tarefas deixam de pagar o RLS por linha: crm_leads (e filhas) usa fn_lead_scope() (porte do #4323 do upstream) e crm_tasks resolve papel, escopo e agenda compartilhada UMA vez por consulta — o quadro de 935 negócios levava 6 s e as tarefas 13 s para uma atendente
--
-- Fork rangel. Medido em produção (16/11/2026), como a atendente (papel agent),
-- dentro de transação só de leitura:
--   select count(*) from crm_leads where pipeline_id = <funil> ... 6.237 ms (931 linhas)
--   select count(*) from crm_tasks ............................ 13.645 ms (1.076 linhas)
-- As demais tabelas da mesma carga respondiam em ~90 ms. O quadro do funil passava
-- dos 10 s e o navegador desistia — a tela da atendente nunca abria.
--
-- Causa: `fn_can_view_lead`/`fn_can_view_task` são `security definer` com
-- `set search_path`, não são embutidas e recebem colunas da linha, então rodam
-- POR LINHA, e cada chamada refaz `fn_user_role_in_org()` (até 2×) e
-- `fn_support_context()`. Em `crm_tasks`, a policy de escrita (FOR ALL, que
-- também vale para SELECT) somava `fn_role_at_least` 2× e
-- `fn_colegas_podem_mexer_na_agenda` por linha.
--
-- Conserto: o que é da SESSÃO sai do caminho por linha. A escada de
-- `fn_can_view_task` é a mesma de `fn_can_view_lead` (com responsável OU criador
-- no lugar do dono), então as duas usam `fn_lead_scope()`; papel mínimo e
-- agenda compartilhada viram conjuntos de organizações calculados uma vez.
-- `fn_can_view_lead`/`fn_can_view_task` seguem intactas (outros consumidores).
-- Na ESCRITA de tarefas, o ramo de plataforma é só o `_full` (doutrina da 0533:
-- suporte só-leitura não escreve) — a regra antiga o herdava, por dentro de
-- `fn_can_view_task`, na forma pura.
-- Visibilidade idêntica, conferida usuário por usuário e linha por linha contra
-- as funções antigas no banco de produção antes de aplicar.

create or replace function public.fn_lead_scope()
returns table (organization_id uuid, org_wide_read boolean, sees_unassigned boolean)
language sql stable security definer
set search_path = public
as $$
  select o.organization_id,
         public.fn_user_role_in_org(o.organization_id) in ('viewer','manager','admin')
           or coalesce((select z.settings->>'visibility_mode' from public.organizations z
                        where z.id = o.organization_id), 'own_and_unassigned') = 'all',
         coalesce((select z.settings->>'visibility_mode' from public.organizations z
                   where z.id = o.organization_id), 'own_and_unassigned') = 'own_and_unassigned'
  from public.fn_user_org_ids() as o(organization_id);
$$;

revoke all on function public.fn_lead_scope() from public, anon;
grant execute on function public.fn_lead_scope() to authenticated, service_role;

-- A policy de leitura do negócio: a linha comparada com o conjunto.
--
-- `create policy` e `drop policy` no MESMO bloco: se a criação falhasse depois do
-- drop, `crm_leads` ficaria sem policy de leitura no `update.sh` (que roda sem
-- ON_ERROR_STOP).
do $crm_leads_select$ begin
  drop policy if exists "crm_leads_select" on public.crm_leads;
  create policy "crm_leads_select" on public.crm_leads
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
           select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
         )
      or (
           owner_user_id = auth.uid()
           and organization_id in (select s.organization_id from public.fn_lead_scope() s)
         )
      or (
           owner_user_id is null
           and organization_id in (
                select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
              )
         )
    );
end $crm_leads_select$;

-- As filhas seguem o MESMO conjunto, cada uma dentro do `EXISTS` no lead-pai.
-- A estrutura é a de hoje (nada de escalar de `owner_user_id`: o `EXISTS` é o que
-- fecha o caso do lead oculto — lição G4-01), só a régua dentro dele muda.
do $crm_lead_activities_select$ begin
  drop policy if exists "crm_lead_activities_select" on public.crm_lead_activities;
  create policy "crm_lead_activities_select" on public.crm_lead_activities
    for select using (
      exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_activities.lead_id
          and (
            (select public.fn_is_platform_admin())
            or l.organization_id in (
                 select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
               )
            or (
                 l.owner_user_id = auth.uid()
                 and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
               )
            or (
                 l.owner_user_id is null
                 and l.organization_id in (
                      select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                    )
               )
          )
      )
    );
end $crm_lead_activities_select$;

do $crm_lead_links_select$ begin
  drop policy if exists "crm_lead_links_select" on public.crm_lead_links;
  create policy "crm_lead_links_select" on public.crm_lead_links
    for select using (
      exists (
        select 1 from public.crm_leads l
        where l.id = crm_lead_links.lead_id
          and (
            (select public.fn_is_platform_admin())
            or l.organization_id in (
                 select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
               )
            or (
                 l.owner_user_id = auth.uid()
                 and l.organization_id in (select s.organization_id from public.fn_lead_scope() s)
               )
            or (
                 l.owner_user_id is null
                 and l.organization_id in (
                      select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                    )
               )
          )
      )
    );
end $crm_lead_links_select$;

-- ── Módulo OPCIONAL de cadências (9249): as tabelas só existem depois de
-- `fn_cadencias_provisionar()`. Instalação sem o módulo não tem o que reescrever
-- (o `to_regclass` é null), e a que já provisionou entra aqui. Sem esta guarda o
-- `update.sh` desta migration quebraria toda instalação que não usa cadências.

do $crm_tasks_escopo$ begin
  drop policy if exists crm_tasks_select on public.crm_tasks;
  create policy crm_tasks_select on public.crm_tasks
    for select using (
      (select public.fn_is_platform_admin())
      or organization_id in (
           select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
         )
      or (
           (assigned_to = auth.uid() or created_by = auth.uid())
           and organization_id in (select s.organization_id from public.fn_lead_scope() s)
         )
      or (
           assigned_to is null
           and organization_id in (
                select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
              )
         )
      -- a chave da agenda compartilhada (#2902), resolvida em conjunto
      or organization_id in (
           select f.o from public.fn_user_org_ids() as f(o)
            where public.fn_colegas_podem_mexer_na_agenda(f.o)
         )
    );

  drop policy if exists crm_tasks_write on public.crm_tasks;
  create policy crm_tasks_write on public.crm_tasks
    using (
      (select public.fn_is_platform_admin_full())
      or (
        organization_id in (
          select f.o from public.fn_user_org_ids() as f(o)
           where public.fn_role_at_least(f.o, 'agent')
        )
        and (
          organization_id in (
            select f.o from public.fn_user_org_ids() as f(o)
             where public.fn_role_at_least(f.o, 'manager')
          )
          or organization_id in (
               select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
             )
          or (
               (assigned_to = auth.uid() or created_by = auth.uid())
               and organization_id in (select s.organization_id from public.fn_lead_scope() s)
             )
          or (
               assigned_to is null
               and organization_id in (
                    select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                  )
             )
          or organization_id in (
               select f.o from public.fn_user_org_ids() as f(o)
                where public.fn_colegas_podem_mexer_na_agenda(f.o)
             )
        )
      )
    )
    with check (
      (select public.fn_is_platform_admin_full())
      or (
        organization_id in (
          select f.o from public.fn_user_org_ids() as f(o)
           where public.fn_role_at_least(f.o, 'agent')
        )
        and (
          organization_id in (
            select f.o from public.fn_user_org_ids() as f(o)
             where public.fn_role_at_least(f.o, 'manager')
          )
          or organization_id in (
               select s.organization_id from public.fn_lead_scope() s where s.org_wide_read
             )
          or (
               (assigned_to = auth.uid() or created_by = auth.uid())
               and organization_id in (select s.organization_id from public.fn_lead_scope() s)
             )
          or (
               assigned_to is null
               and organization_id in (
                    select s.organization_id from public.fn_lead_scope() s where s.sees_unassigned
                  )
             )
          or organization_id in (
               select f.o from public.fn_user_org_ids() as f(o)
                where public.fn_colegas_podem_mexer_na_agenda(f.o)
             )
        )
      )
    );
end $crm_tasks_escopo$;
