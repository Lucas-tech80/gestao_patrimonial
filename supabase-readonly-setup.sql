-- Gestão Patrimonial MHS
-- Acesso da interface: somente leitura para a role anon.
--
-- Pré-requisito confirmado: o schema "gestao_patrimonial" está exposto na
-- API do projeto Supabase. Este arquivo não insere, altera ou remove dados.
--
-- IMPORTANTE
-- - Execute no SQL Editor do projeto Supabase.
-- - O dashboard/editor do Supabase continua funcionando com a role postgres.
-- - RLS não é alterado aqui para não afetar fluxos administrativos existentes.
-- - Se o bloco transacional falhar, ele desfaz todas as próprias alterações.

-- Auditoria antes da alteração: registre este resultado se precisar revisar
-- permissões concedidas por PUBLIC ou por outra role.
select
    has_schema_privilege('anon', 'gestao_patrimonial', 'USAGE') as anon_schema_usage_antes,
    has_schema_privilege('anon', 'gestao_patrimonial', 'CREATE') as anon_schema_create_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'SELECT') as anon_select_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'INSERT') as anon_insert_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'UPDATE') as anon_update_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'DELETE') as anon_delete_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRUNCATE') as anon_truncate_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'REFERENCES') as anon_references_antes,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRIGGER') as anon_trigger_antes;

begin;

-- Necessário para a API do Supabase acessar o schema personalizado.
grant usage on schema gestao_patrimonial to anon;
revoke create on schema gestao_patrimonial from anon;

-- Remove privilégios diretos de anon e devolve exclusivamente a leitura.
revoke all privileges on table gestao_patrimonial.patrimonios from anon;
grant select on table gestao_patrimonial.patrimonios to anon;

-- Não confirma a transação caso ainda exista escrita efetiva por PUBLIC ou
-- por uma role herdada. Nesse caso, não faça mudanças adicionais: envie o
-- erro retornado para uma auditoria específica.
do $$
begin
    if not has_schema_privilege('anon', 'gestao_patrimonial', 'USAGE')
       or has_schema_privilege('anon', 'gestao_patrimonial', 'CREATE')
       or not has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'SELECT')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'INSERT')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'UPDATE')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'DELETE')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRUNCATE')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'REFERENCES')
       or has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRIGGER')
    then
        raise exception
            'Permissões efetivas de anon não ficaram somente-leitura. A transação foi cancelada sem alterações.';
    end if;
end
$$;

commit;

-- Resultado esperado: usage e select = true; todos os privilégios de escrita = false.
select                              
    has_schema_privilege('anon', 'gestao_patrimonial', 'USAGE') as anon_schema_usage,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'SELECT') as anon_select,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'INSERT') as anon_insert,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'UPDATE') as anon_update,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'DELETE') as anon_delete,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRUNCATE') as anon_truncate,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'REFERENCES') as anon_references,
    has_table_privilege('anon', 'gestao_patrimonial.patrimonios', 'TRIGGER') as anon_trigger;
