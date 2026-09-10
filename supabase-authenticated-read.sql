-- Leitura do sistema patrimonial por usuários autenticados.
-- Execute manualmente no Supabase SQL Editor. Este arquivo não é executado
-- pelo frontend e não contém operações de escrita, alteração ou remoção de dados.

begin;

grant usage on schema gestao_patrimonial to authenticated;
grant select on table gestao_patrimonial.patrimonios to authenticated;

-- O histórico é opcional no banco atual; só recebe a permissão se existir.
do $$
begin
    if to_regclass('gestao_patrimonial.patrimonios_historico') is not null then
        grant select on table gestao_patrimonial.patrimonios_historico to authenticated;
    end if;
end
$$;

commit;
