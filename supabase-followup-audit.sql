-- Gestão Patrimonial MHS
-- Auditoria complementar: somente leitura, sem exibir registros individuais.
-- Execute no SQL Editor do mesmo projeto Supabase após confirmar a interface.

-- 1) Compatibilidade de mídia com a interface.
-- A interface usa somente links HTTP(S); paths de Storage ou outros formatos
-- permanecem protegidos e não são presumidos como links públicos.
with midia as (
    select 'foto'::text as campo, foto as valor
    from gestao_patrimonial.patrimonios

    union all

    select 'documento'::text, documento
    from gestao_patrimonial.patrimonios
)
select
    campo,
    count(*) filter (where nullif(btrim(coalesce(valor, '')), '') is null) as vazio,
    count(*) filter (where btrim(coalesce(valor, '')) ~* '^https?://') as url_http,
    count(*) filter (
        where nullif(btrim(coalesce(valor, '')), '') is not null
          and btrim(coalesce(valor, '')) !~* '^https?://'
    ) as nao_http
from midia
group by campo
order by campo;

-- 2) Privilégios efetivos de anon nos demais objetos expostos do schema.
-- Não altera permissões; serve para identificar riscos fora da tabela usada
-- pela interface antes de qualquer expansão de funcionalidade.
select
    c.relname as objeto,
    c.relkind as tipo,
    c.relrowsecurity as rls_ativo,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
    has_table_privilege('anon', c.oid, 'INSERT') as anon_insert,
    has_table_privilege('anon', c.oid, 'UPDATE') as anon_update,
    has_table_privilege('anon', c.oid, 'DELETE') as anon_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'gestao_patrimonial'
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
order by c.relkind, c.relname;
