/**
 * GestÃƒÂ£o Patrimonial MHS
 * Arquivo principal da aplicaÃ§Ã£o.
 * DependÃƒÂªncias no index.html: Supabase JS, Chart.js, Tailwind e Font Awesome.
 */

// ================= CONFIGURAÃƒâ€¡ÃƒÆ’O =================

// O cliente JS usa a URL base do projeto, sem /rest/v1/.
const SUPABASE_URL = 'https://imdwkxhbcohyyczhvsil.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_vLrOsiiwDNF-XbycmZZEKA_ChBiZj8Z';
const SUPABASE_SCHEMA = 'gestao_patrimonial';
const TABLE_PATRIMONIOS = 'patrimonios';
const READ_ONLY_MODE = true;
const TABLE_HISTORICO = 'patrimonios_historico';
const BUCKET_FOTOS = 'foto_patrimonial';
const BUCKET_NFS = 'patrimonios-nfs';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ADMIN_CONFIG_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/admin-config`;

const IMAGE_PLACEHOLDER = 'https://placehold.co/400x400/f8fafc/64748b?text=Sem+Foto';

// As fotos devem vir exclusivamente do Storage. Não há fallback para os
// antigos caminhos locais nem para arquivos copiados para assets/.
const getCardPhotoUrl = (ativo) => ativo.img_url || null;

let storagePhotoIndexPromise = null;

const normalizePhotoKey = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\.[A-Z0-9]+$/i, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// Os nomes enviados para o Storage podem ter hÃ­fens, acentos, espaÃ§os,
// parÃªnteses ou um sufixo adicional. A comparaÃ§Ã£o precisa considerar o nome
// real do arquivo, e nÃ£o apenas plaquetas numÃ©ricas.
const photoNameMatchesItem = (fileName, itemName) => {
    const fileKey = normalizePhotoKey(fileName);
    const itemKey = normalizePhotoKey(itemName);

    if (!fileKey || !itemKey) return false;
    if (fileKey === itemKey) return true;

    // Permite nomes como "AR-CONDICIONADO (OBRAS) - 1.jpg" sem transformar
    // qualquer foto parecida em uma associaÃ§Ã£o automÃ¡tica.
    return fileKey.startsWith(`${itemKey} `) || itemKey.startsWith(`${fileKey} `);
};

const getPhotoNameTokens = (value) => normalizePhotoKey(value)
    .split(' ')
    .filter((token) => token && !['COPIA', 'OBS'].includes(token) && !/^\d+$/.test(token));

// Retorna uma pontuaÃ§Ã£o somente quando todas as palavras relevantes do nome
// da foto aparecem na descriÃ§Ã£o do patrimÃ´nio. Assim "MESA GRANDE.jpg"
// encontra "Mesa Grande", mas nÃ£o Ã© confundida com qualquer item que apenas
// contenha a palavra "mesa".
const scorePhotoNameMatch = (fileName, itemName) => {
    const fileTokens = getPhotoNameTokens(fileName);
    const itemTokens = getPhotoNameTokens(itemName);
    if (!fileTokens.length || !itemTokens.length) return -1;

    const itemTokenSet = new Set(itemTokens);
    if (!fileTokens.every((token) => itemTokenSet.has(token))) return -1;

    // Nomes abreviados nÃ£o devem ganhar pontos por a descriÃ§Ã£o ser menor:
    // "EXTINTOR" pode corresponder a mais de um patrimÃ´nio. A pontuaÃ§Ã£o
    // extra fica reservada para uma correspondÃªncia de palavras exata.
    return fileTokens.length === itemTokens.length ? 10000 : 0;
};

const findBestNamedPhoto = (files, registro, registros) => {
    const scoredFiles = files
        .map((file) => ({ file, score: scorePhotoNameMatch(file.name, registro.item) }))
        .filter((entry) => entry.score >= 0);

    if (!scoredFiles.length) return null;

    const bestFileScore = Math.max(...scoredFiles.map((entry) => entry.score));
    const bestFiles = scoredFiles.filter((entry) => entry.score === bestFileScore);
    if (bestFiles.length !== 1) return null;

    const bestFile = bestFiles[0].file;
    const competingRecords = registros
        .map((candidate) => ({
            candidate,
            score: scorePhotoNameMatch(bestFile.name, candidate.item)
        }))
        .filter((entry) => entry.score >= 0);
    const bestRecordScore = Math.max(...competingRecords.map((entry) => entry.score));
    const bestRecords = competingRecords.filter((entry) => entry.score === bestRecordScore);

    return bestRecords.length === 1 && Number(bestRecords[0].candidate.id) === Number(registro.id)
        ? bestFile
        : null;
};

async function createStoragePhotoUrl(path) {
    if (!path) return null;

    const { data, error } = supabaseClient.storage
        .from(BUCKET_FOTOS)
        .getPublicUrl(path);

    return error ? null : data?.publicUrl || null;
}

const isStorageImage = (entry) => Boolean(
    entry?.metadata?.mimetype?.startsWith('image/')
    || /\.(jpe?g|png|webp|gif)$/i.test(entry?.name || '')
);

const isLegacyLocalPath = (value) => /^[A-Z]:[\\/]/i.test(value) || value.startsWith('\\\\');

async function loadStoragePhotoIndex(numeros) {
    if (storagePhotoIndexPromise) return storagePhotoIndexPromise;

    storagePhotoIndexPromise = (async () => {
        const bucket = supabaseClient.storage.from(BUCKET_FOTOS);
        const index = { root: [], byNumero: new Map() };
        const { data: root, error: rootError } = await bucket.list('', { limit: 10000 });
        if (rootError) throw rootError;

        // Em algumas respostas do Storage, objetos da raiz podem nÃ£o trazer
        // `id`, embora ainda tragam `name`. O nome Ã© o dado necessÃ¡rio para
        // associar fotos nomeadas aos itens.
        index.root = (root || []).filter((entry) => entry.name);
        // Não consulte uma pasta para cada patrimônio. O bucket já informa na
        // listagem da raiz quais pastas existem; consultar apenas essas pastas
        // evita centenas de requisições e travamento da tela inicial.
        const existingFolders = new Set(
            index.root
                .filter((entry) => !entry.id)
                .map((entry) => entry.name)
        );
        const foldersToLoad = [...new Set(numeros)].filter((numero) => existingFolders.has(numero));
        await Promise.all(foldersToLoad.map(async (numero) => {
            const { data, error } = await bucket.list(numero, { limit: 10000 });
            if (!error) index.byNumero.set(numero, (data || []).filter((entry) => entry.name));
        }));

        return index;
    })().catch((error) => {
        console.warn('NÃ£o foi possÃ­vel consultar as fotos do Storage:', error);
        return null;
    });

    return storagePhotoIndexPromise;
}

async function resolveStoragePhotos(registros) {
    const numeros = registros.flatMap((registro) => [
        String(registro.numero || '').trim(),
        normalizeNumero(registro.numero)
    ]).filter(Boolean);
    const index = await loadStoragePhotoIndex(numeros);
    if (!index) return registros;
    const resolved = await Promise.all(registros.map(async (registro) => {
        const foto = String(registro.foto || '').trim();
        if (/^https?:\/\//i.test(foto)) return registro;

        // Se o banco já tiver um path relativo do Storage, ele tem prioridade.
        if (foto && !isLegacyLocalPath(foto) && !/^(N\/A|N\\A)$/i.test(foto)) {
            const storedUrl = await createStoragePhotoUrl(foto.replace(/\\/g, '/'));
            if (storedUrl) return { ...registro, foto: storedUrl };
        }

        const numero = normalizeNumero(registro.numero);

        const folderNumero = index.byNumero.has(numero) ? numero : String(registro.numero || '').trim();
        const inNumeroFolder = (index.byNumero.get(folderNumero) || [])
            .filter(isStorageImage);
        const namedFiles = index.root.filter(isStorageImage);
        const numeroRootMatches = namedFiles.filter((entry) =>
            normalizePhotoKey(entry.name) === numero
        );
        const exactRootMatches = namedFiles.filter((entry) =>
            photoNameMatchesItem(entry.name, registro.item)
        );

        // Mesmo quando existe um único arquivo nominal, ele só é seguro se
        // também corresponder a um único patrimônio. Isso evita atribuir a
        // mesma foto a itens diferentes com nomes iguais ou semelhantes.
        const exactNamedFile = exactRootMatches.length === 1 ? exactRootMatches[0] : null;
        const exactNamedRecords = exactNamedFile
            ? registros.filter((candidate) => photoNameMatchesItem(exactNamedFile.name, candidate.item))
            : [];
        const uniqueExactNamedFile = exactNamedRecords.length === 1
            && Number(exactNamedRecords[0].id) === Number(registro.id)
            ? exactNamedFile
            : null;

        // Quando o nome do arquivo Ã© abreviado, procura o melhor vÃ­nculo
        // entre todos os patrimÃ´nios. SÃ³ associa se houver um Ãºnico resultado.
        const bestNamedFile = exactRootMatches.length === 0
            ? findBestNamedPhoto(namedFiles, registro, registros)
            : null;
        const namedCandidates = uniqueExactNamedFile
            ? [uniqueExactNamedFile]
            : (exactRootMatches.length === 0 && bestNamedFile ? [bestNamedFile] : []);

        // Only use an unambiguous Storage object: number folder first, then
        // an exact item-name match at the bucket root.
        const candidates = inNumeroFolder.length === 1
            ? inNumeroFolder
            : (inNumeroFolder.length === 0 && numeroRootMatches.length === 1
                ? numeroRootMatches
                : (inNumeroFolder.length === 0 && numeroRootMatches.length === 0 && namedCandidates.length === 1
                    ? namedCandidates
                    : []));
        if (candidates.length !== 1) {
            return registro;
        }

        const path = inNumeroFolder.length === 1 ? `${folderNumero}/${candidates[0].name}` : candidates[0].name;
        const publicUrl = await createStoragePhotoUrl(path);
        return publicUrl ? { ...registro, foto: publicUrl } : registro;
    }));

    return resolved;
}

// ================= ESTADO GLOBAL =================

let supabaseClient = null;
let currentUser = null;
let appVisible = false;
let todosAtivosData = [];
let ativosData = [];
let historicoData = [];
let currentView = 'dashboard';
let isLoadingAtivos = false;
let isLoadingHistorico = false;
let editingAtivoId = null;
let activeModalAtivoId = null;
let chartClassificacaoInstance = null;
let chartLocalInstance = null;
let chartLocalView = 'local';
let dashboardMetricsAnterior = null;
let ultimoResumoLocal = {};
let authSubscription = null;

// ================= HELPERS =================

const getEl = (id) => document.getElementById(id);

const formatMoney = (value) => {
    const numberValue = Number(value || 0);
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(numberValue);
};

const formatDate = (dateString) => {
    if (!dateString) return '-';

    const value = String(dateString).trim();

    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        const [year, month, day] = value.slice(0, 10).split('-');
        return `${day}/${month}/${year}`;
    }

    if (/^\d{2}\/\d{2}\/\d{4}/.test(value)) {
        return value.slice(0, 10);
    }

    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
        return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
    }

    return value;
};

const formatDateTime = (dateString) => {
    if (!dateString) return '-';

    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return String(dateString);

    return new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'short',
        timeStyle: 'short'
    }).format(date);
};

const normalizeNumero = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits ? digits.padStart(4, '0') : '';
};

const normalizeStatus = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const normalizeAtivo = (ativo) => ({
    id: ativo.id,
    numero: normalizeNumero(ativo.numero),
    item: ativo.item || '',
    classificacao: ativo.classificacao || 'Outros',
    data: ativo.data || null,
    nf: ativo.nf || 'S/NF',
    preco: Number(ativo.preco || 0),
    local: ativo.local || 'Sem local definido',
    pagamento: ativo.pagamento || 'Não informado',
    // O banco ainda contÃ©m caminhos locais antigos (C:\\Users\\...).
    // Eles nÃ£o sÃ£o URLs carregÃ¡veis pela interface e devem permanecer como placeholder.
    img_url: /^https?:\/\//i.test(String(ativo.foto || '').trim()) ? String(ativo.foto).trim() : null,
    // Caminhos locais antigos não são anexos acessíveis pela aplicação.
    pdf_url: isLegacyLocalPath(String(ativo.documento || '').trim())
        ? null
        : (ativo.documento || null),
    status: ativo.status ?? null,
    ativo: ['ativo', 'ativos'].includes(normalizeStatus(ativo.status))
});

const parseSupabaseError = (error) => {
    if (!error) return 'Erro desconhecido.';
    if (error.message) return error.message;
    if (error.details) return error.details;
    if (error.error) return typeof error.error === 'string' ? error.error : JSON.stringify(error.error);
    if (error.code || error.status || error.statusCode) {
        return [error.code, error.status || error.statusCode, error.hint].filter(Boolean).join(' — ');
    }
    if (typeof error === 'string') return error;
    return 'Não foi possível concluir a operação.';
};

const escapeHTML = (value) => {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

function handleImageError(image) {
    image.onerror = null;
    image.src = IMAGE_PLACEHOLDER;
}

const truncateText = (value, size = 120) => {
    const text = String(value || '');
    return text.length > size ? `${text.slice(0, size)}...` : text;
};

const setButtonLoading = (button, loading, loadingText = 'Carregando...') => {
    if (!button) return;

    if (loading) {
        button.dataset.originalHtml = button.innerHTML;
        button.disabled = true;
        button.classList.add('opacity-70', 'cursor-not-allowed');
        button.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> ${loadingText}`;
        return;
    }

    button.disabled = false;
    button.classList.remove('opacity-70', 'cursor-not-allowed');
    if (button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
        delete button.dataset.originalHtml;
    }
};

const updateLocalData = (ativoAtualizado) => {
    const normalized = normalizeAtivo(ativoAtualizado);
    if (typeof isCadeiraEmDefeito === 'function' && isCadeiraEmDefeito(normalized)) return;
    const index = todosAtivosData.findIndex((item) => Number(item.id) === Number(normalized.id));

    if (index >= 0) {
        todosAtivosData[index] = normalized;
    } else {
        todosAtivosData.push(normalized);
    }

    todosAtivosData.sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));
    ativosData = todosAtivosData.filter((ativo) => ativo.ativo);
};

const buildDiff = (antes, depois, keys) => {
    const diff = {};

    keys.forEach((key) => {
        const oldValue = antes?.[key] ?? '';
        const newValue = depois?.[key] ?? '';

        if (String(oldValue) !== String(newValue)) {
            diff[key] = { antes: oldValue, depois: newValue };
        }
    });

    return diff;
};

// ================= STATUS / TOAST =================

function setConnectionStatus(status, customMessage = '') {
    const statusEl = getEl('connectionStatus');
    const pingEl = getEl('connectionPing');
    const dotEl = getEl('connectionDot');

    if (!statusEl || !pingEl || !dotEl) return;

    const basePing = 'animate-ping absolute inline-flex h-full w-full rounded-full opacity-75';
    const baseDot = 'relative inline-flex rounded-full h-2.5 w-2.5';

    if (status === 'connected') {
        statusEl.textContent = customMessage || 'Conectado';
        statusEl.className = 'text-xs font-semibold text-emerald-600';
        pingEl.className = `${basePing} bg-emerald-400`;
        dotEl.className = `${baseDot} bg-emerald-500`;
        return;
    }

    if (status === 'error') {
        statusEl.textContent = customMessage || 'Erro de conexão';
        statusEl.className = 'text-xs font-semibold text-rose-600';
        pingEl.className = `${basePing} bg-rose-400`;
        dotEl.className = `${baseDot} bg-rose-500`;
        return;
    }

    statusEl.textContent = customMessage || 'Conectando...';
    statusEl.className = 'text-xs font-semibold text-blue-600';
    pingEl.className = `${basePing} bg-blue-400`;
    dotEl.className = `${baseDot} bg-blue-500`;
}

function showToast(msg, type = 'success') {
    const toast = getEl('toast');
    if (!toast) return;

    const iconBox = toast.querySelector('div');
    const icon = iconBox.querySelector('i');

    getEl('toast-msg').textContent = msg;

    if (type === 'error') {
        iconBox.className = 'bg-rose-500 rounded-full w-8 h-8 flex items-center justify-center mr-3 flex-shrink-0';
        icon.className = 'fa-solid fa-triangle-exclamation text-white';
    } else if (type === 'warning') {
        iconBox.className = 'bg-amber-500 rounded-full w-8 h-8 flex items-center justify-center mr-3 flex-shrink-0';
        icon.className = 'fa-solid fa-circle-exclamation text-white';
    } else {
        iconBox.className = 'bg-emerald-500 rounded-full w-8 h-8 flex items-center justify-center mr-3 flex-shrink-0';
        icon.className = 'fa-solid fa-check text-white';
    }

    toast.classList.remove('translate-y-20', 'opacity-0');

    window.clearTimeout(toast.dataset.timeoutId);
    const timeoutId = window.setTimeout(() => {
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 4200);

    toast.dataset.timeoutId = timeoutId;
}

// ================= SUPABASE / AUTH =================

async function adminGatewayFetch(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const isDataRequest = url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/storage/v1/');

    if (!isDataRequest || !supabaseClient) return fetch(request);

    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session?.access_token) {
        return new Response(JSON.stringify({ message: 'Sessão não disponível.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    const headers = new Headers(request.headers);
    headers.set('apikey', SUPABASE_PUBLISHABLE_KEY);
    headers.set('Authorization', `Bearer ${data.session.access_token}`);

    const proxyUrl = `${ADMIN_CONFIG_FUNCTION_URL}${url.pathname}${url.search}`;
    const body = request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();

    return fetch(proxyUrl, {
        method: request.method,
        headers,
        body,
    });
}

function initSupabaseClient() {
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
        throw new Error('Biblioteca do Supabase não carregou. Verifique sua conexão com a internet/CDN.');
    }

    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        db: { schema: SUPABASE_SCHEMA },
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
        },
        global: {
            headers: {
                'x-client-info': 'mhs-gestao-patrimonial-web'
            }
        }
    });
}

async function handleAuthState(session = null) {
    const loginScreen = getEl('loginScreen');
    const appScreen = getEl('appScreen');
    const appShell = getEl('appShell');
    const userEmailLabel = getEl('userEmailLabel');
    const adminConfigBtn = getEl('adminConfigBtn');
    const logoutBtn = getEl('logoutBtn');
    const mobileLogoutBtn = getEl('mobileLogoutBtn');

    if (!session?.user) {
        currentUser = null;
        appVisible = false;
        appScreen?.classList.add('hidden');
        loginScreen?.classList.remove('hidden');
        loginScreen?.classList.add('flex');
        adminConfigBtn?.classList.add('hidden');
        logoutBtn?.classList.add('hidden');
        mobileLogoutBtn?.classList.add('hidden');
        return;
    }

    const isSameUser = appVisible && currentUser?.id === session.user.id;
    currentUser = session.user;
    appVisible = true;

    loginScreen?.classList.add('hidden');
    loginScreen?.classList.remove('flex');
    appScreen?.classList.remove('hidden');
    appShell?.classList.remove('hidden');
    appShell?.classList.add('flex');
    appShell?.classList.add('flex-col');

    logoutBtn?.classList.remove('hidden');
    mobileLogoutBtn?.classList.remove('hidden');

    if (userEmailLabel) {
        userEmailLabel.textContent = currentUser.email;
    }
    adminConfigBtn?.classList.remove('hidden');

    if (isSameUser) return;

    // A sessão está pronta; o estado "Conectado" só será exibido após a
    // consulta de patrimônios retornar uma lista válida.
    setConnectionStatus('loading', 'Carregando dados autorizados...');
    await carregarAtivos();
    await carregarHistorico({ silent: true });
    navigate(currentView || 'dashboard');
}

function setLoginError(message = '') {
    const errorEl = getEl('loginError');
    if (!errorEl) return;

    errorEl.textContent = message;
    errorEl.classList.toggle('hidden', !message);
}

function setAdminConfigStatus(message = '', type = 'info') {
    const statusEl = getEl('adminConfigStatus');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = message
        ? `rounded-lg border px-3 py-2.5 text-sm ${type === 'error'
            ? 'border-rose-200 bg-rose-50 text-rose-700'
            : type === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-blue-200 bg-blue-50 text-blue-700'}`
        : 'hidden rounded-lg px-3 py-2.5 text-sm';
}

async function adminConfigRequest(method = 'GET', payload = null) {
    const { data, error } = await supabaseClient.auth.getSession();
    if (error || !data.session?.access_token) throw new Error('Sessão administrativa não disponível.');

    const requestOptions = {
        method,
        headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${data.session.access_token}`,
            'Content-Type': 'application/json',
        },
    };

    if (payload) requestOptions.body = JSON.stringify(payload);

    const result = await fetch(ADMIN_CONFIG_FUNCTION_URL, requestOptions);
    const body = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(body.error || 'Não foi possível acessar a configuração.');
    return body;
}

async function abrirAdminConfig() {
    const modal = getEl('adminConfigModal');
    if (!modal) return;

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setAdminConfigStatus('Carregando configuração...', 'info');

    try {
        const config = await adminConfigRequest();
        getEl('config_profile_name').value = config.profileName || '';
        getEl('config_project_url').value = config.projectUrl || SUPABASE_URL;
        getEl('config_schema').value = config.schema || SUPABASE_SCHEMA;
        getEl('config_service_role').value = '';
        setAdminConfigStatus(
            config.configured
                ? `Chave protegida configurada em ${new Date(config.updatedAt).toLocaleString('pt-BR')}.`
                : 'Nenhuma chave administrativa configurada ainda.',
            config.configured ? 'success' : 'info',
        );
    } catch (error) {
        console.error('Erro ao carregar perfil de configuração:', error);
        setAdminConfigStatus('Acesso negado ou função administrativa ainda não implantada.', 'error');
    }
}

function fecharAdminConfig() {
    getEl('config_service_role').value = '';
    getEl('adminConfigModal')?.classList.add('hidden');
    getEl('adminConfigModal')?.classList.remove('flex');
}

async function salvarAdminConfig(event) {
    event.preventDefault();

    const button = getEl('btnSaveAdminConfig');
    const payload = {
        profileName: getEl('config_profile_name')?.value.trim() || '',
        projectUrl: getEl('config_project_url')?.value.trim() || '',
        schema: getEl('config_schema')?.value.trim() || '',
        serviceRole: getEl('config_service_role')?.value || '',
    };

    try {
        setAdminConfigStatus('Validando conexão...', 'info');
        setButtonLoading(button, true, 'Validando...');
        await adminConfigRequest('POST', { ...payload, testOnly: true });

        setButtonLoading(button, false);
        setButtonLoading(button, true, 'Salvando...');
        await adminConfigRequest('POST', payload);
        getEl('config_service_role').value = '';
        await carregarAtivos();
        await carregarHistorico({ silent: true });
        navigate(currentView || 'dashboard');
        setAdminConfigStatus('Configuração salva com segurança no servidor.', 'success');
    } catch (error) {
        console.error('Erro ao salvar perfil de configuração:', error);
        setAdminConfigStatus(error.message || 'Não foi possível salvar a configuração.', 'error');
    } finally {
        setButtonLoading(button, false);
    }
}

async function loginUsuario(event) {
    event.preventDefault();

    const button = getEl('btnLogin');

    try {
        setLoginError('');
        setButtonLoading(button, true, 'Entrando...');

        const email = getEl('login_email')?.value.trim() || '';
        const password = getEl('login_password')?.value || '';

        if (!email || !password) throw new Error('Informe e-mail e senha.');

        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;

        await handleAuthState(data.session);
        showToast('Login realizado com sucesso!');
    } catch (error) {
        console.error('Erro no login:', error);
        setLoginError(error.message === 'Informe e-mail e senha.' ? error.message : 'E-mail ou senha inválidos.');
    } finally {
        setButtonLoading(button, false);
    }
}

async function criarUsuario() {
    const button = getEl('btnSignup');

    try {
        setButtonLoading(button, true, 'Criando...');

        const email = getEl('login_email')?.value.trim() || '';
        const password = getEl('login_password')?.value || '';

        if (!email || !password) {
            throw new Error('Informe e-mail e senha para criar o acesso.');
        }

        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;

        if (data.session) {
            await handleAuthState(data.session);
            showToast('Acesso criado e login realizado.');
        } else {
        showToast('Acesso criado. Verifique o e-mail de confirmação, se estiver habilitado.', 'warning');
        }
    } catch (error) {
        console.error('Erro ao criar usuÃƒÂ¡rio:', error);
        showToast(`Erro ao criar acesso: ${parseSupabaseError(error)}`, 'error');
    } finally {
        setButtonLoading(button, false);
    }
}

async function logoutUsuario() {
    closeModal();
    closeBaixaModal();

    const { error } = await supabaseClient.auth.signOut();
    if (error) {
        console.error('Erro ao sair:', error);
        showToast('Não foi possível encerrar a sessão.', 'error');
        return;
    }

    await handleAuthState(null);
}

// ================= DADOS =================

async function carregarAtivos({ silent = false } = {}) {
    if (!supabaseClient) return [];

    try {
        isLoadingAtivos = true;
        setConnectionStatus('loading', 'Carregando dados...');

        if (!silent && currentView === 'ativos') {
            renderAtivosList(getEl('searchInput')?.value || '');
        }

        let { data, error } = await supabaseClient
            .from(TABLE_PATRIMONIOS)
            .select('id, numero, item, classificacao, data, nf, preco, local, documento, foto, status')
            .order('numero', { ascending: true })
            .limit(10000);

        if (error) throw error;

        // A consulta REST deve devolver uma lista. Não converta objetos
        // inesperados em registros, pois isso ocultaria uma falha de API e
        // geraria KPIs zerados.
        if (!Array.isArray(data)) {
            const gatewayMessage = data && typeof data === 'object'
                ? (data.message || data.error || data.details || data.hint)
                : null;
            if (gatewayMessage) throw new Error(gatewayMessage);
            throw new Error('Resposta inválida do banco de dados.');
        }

        // Um patrimônio sem identificador não pode ser contabilizado com
        // segurança. Registros válidos continuam carregando normalmente.
        const registrosValidos = data.filter((registro) => (
            registro
            && typeof registro === 'object'
            && registro.id !== null
            && registro.id !== undefined
        ));
        if (registrosValidos.length !== data.length) {
            console.warn('Registros inválidos foram ignorados na leitura de patrimônios.', {
                recebidos: data.length,
                válidos: registrosValidos.length,
            });
        }

        let registrosComFotos = registrosValidos;
        try {
            registrosComFotos = await resolveStoragePhotos(registrosComFotos);
        } catch (photoError) {
            // Fotos são complementares: um erro no Storage não pode zerar o
            // dashboard nem impedir a leitura dos patrimônios.
            console.warn('Não foi possível resolver as fotos; dados carregados sem imagens:', photoError);
        }
        todosAtivosData = registrosComFotos
            .map(normalizeAtivo)
            .filter((ativo) => !isCadeiraEmDefeito(ativo));
        ativosData = todosAtivosData.filter((ativo) => ativo.ativo);

        setConnectionStatus('connected');
        initDashboard();
        popularFiltrosRelatorios();
        renderRelatorios();

        if (currentView === 'ativos') {
            renderAtivosList(getEl('searchInput')?.value || '');
        }

        return todosAtivosData;
    } catch (error) {
        console.error('Erro ao carregar ativos:', error);
        setConnectionStatus('error');
        initDashboard();

        if (currentView === 'ativos') {
            renderAtivosList(getEl('searchInput')?.value || '');
        }

        showToast(`Erro ao carregar dados: ${parseSupabaseError(error)}`, 'error');
        return [];
    } finally {
        isLoadingAtivos = false;
    }
}

async function carregarHistorico({ silent = false } = {}) {
    // Somente a tabela patrimonios foi informada; nenhuma tabela adicional e consultada.
    historicoData = [];
    isLoadingHistorico = false;
    if (!silent && currentView === 'historico') renderHistorico();
    return historicoData;
}async function verificarNumeroDisponivel(numero, ignorarId = null) {
    let query = supabaseClient
        .from(TABLE_PATRIMONIOS)
        .select('id')
        .eq('numero', numero);

    if (ignorarId) {
        query = query.neq('id', ignorarId);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    if (data) throw new Error('Já existe um patrimônio com essa plaqueta.');
}

async function uploadStorageFile(bucket, file, numero, tipo) {
    if (!file) return null;

    if (file.size > MAX_UPLOAD_BYTES) {
        throw new Error(`O arquivo "${file.name}" ultrapassa o limite de 5MB.`);
    }

    if (tipo === 'imagem' && !file.type.startsWith('image/')) {
        throw new Error('A foto precisa ser uma imagem válida.');
    }

    if (tipo === 'pdf' && file.type !== 'application/pdf') {
        throw new Error('A nota fiscal precisa ser um arquivo PDF.');
    }

    const extension = (file.name.split('.').pop() || (tipo === 'pdf' ? 'pdf' : 'jpg'))
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const filePath = `${numero}/${tipo}-${Date.now()}.${extension}`;

    const { data, error } = await supabaseClient.storage
        .from(bucket)
        .upload(filePath, file, {
            cacheControl: '3600',
            upsert: false,
            contentType: file.type
        });

    if (error) throw error;

    if (bucket === BUCKET_FOTOS) {
        const { data: publicData } = supabaseClient.storage
            .from(bucket)
            .getPublicUrl(data.path);

        return publicData.publicUrl;
    }

    return data.path;
}

async function abrirNotaFiscal(ativo) {
    try {
        if (!ativo?.pdf_url) {
            showToast('Nenhuma nota fiscal anexada para este ativo.', 'warning');
            return;
        }

        const documento = String(ativo.pdf_url).trim();
        if (/^https?:\/\//i.test(documento)) {
            window.open(documento, '_blank', 'noopener,noreferrer');
            return;
        }

        // Alguns registros antigos salvaram o nome do bucket junto com o
        // caminho. O Storage espera somente o caminho relativo do objeto.
        const caminho = documento
            .replace(/\\/g, '/')
            .replace(/^\/+/, '')
            .replace(new RegExp(`^${BUCKET_NFS}/`, 'i'), '');
        if (!caminho || /^[a-z]:\//i.test(caminho)) {
            showToast('O arquivo da nota fiscal não possui um caminho válido.', 'warning');
            return;
        }

        const { data, error } = await supabaseClient.storage
            .from(BUCKET_NFS)
            .createSignedUrl(caminho, 60 * 60);

        if (error) throw error;

        window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    } catch (error) {
        console.error('Erro ao abrir nota fiscal:', error);
        showToast('O arquivo da nota fiscal não foi encontrado no armazenamento.', 'warning');
    }
}

async function registrarHistorico({ patrimonioId, numero, item, acao, descricao, antes = null, depois = null }) {
    if (!supabaseClient) return;

    try {
        const payload = {
            patrimonio_id: patrimonioId || null,
            numero: numero || null,
            item: item || null,
            acao,
            descricao,
            dados_antes: antes,
            dados_depois: depois,
            usuario_email: currentUser.email || null
        };

        const { error } = await supabaseClient
            .from(TABLE_HISTORICO)
            .insert(payload);

        if (error) throw error;

        await carregarHistorico({ silent: true });
    } catch (error) {
        console.warn('NÃ£o foi possÃ­vel registrar histÃ³rico:', error);
    }
}

// ================= CADASTRO / EDIÃƒâ€¡ÃƒÆ’O =================

function getFormPayload() {
    const numero = normalizeNumero(getEl('cad_numero').value);
    const item = getEl('cad_item').value.trim();
    const classificacao = getEl('cad_classificacao').value.trim();
    const local = getEl('cad_local').value.trim();
    const dataCompra = getEl('cad_data').value;
    const preco = Number(getEl('cad_preco').value);
    const nf = getEl('cad_nf').value.trim() || 'S/NF';
    const pagamento = getEl('cad_pagamento').value.trim() || 'Não informado';

    if (!numero) throw new Error('Informe uma plaqueta válida.');
    if (!item) throw new Error('Informe a descrição do item.');
    if (!classificacao) throw new Error('Selecione uma classificação.');
    if (!local) throw new Error('Informe o local alocado.');
    if (!dataCompra) throw new Error('Informe a data da compra.');
    if (!Number.isFinite(preco) || preco < 0) throw new Error('Informe um preço válido.');

    return {
        numero,
        item,
        classificacao,
        data_compra: dataCompra,
        nf,
        preco,
        local,
        pagamento
    };
}

async function cadastrarOuEditarAtivo(event) {
    event.preventDefault();

    const submitButton = getEl('btnSalvarPatrimonio');

    try {
        setButtonLoading(submitButton, true, editingAtivoId ? 'Atualizando...' : 'Salvando...');

        const payload = getFormPayload();
        const imagemFile = getEl('cad_imagem').files[0] || null;
        const pdfFile = getEl('cad_pdf').files[0] || null;

        if (editingAtivoId) {
            await atualizarAtivo(payload, imagemFile, pdfFile);
            return;
        }

        await criarAtivo(payload, imagemFile, pdfFile);
    } catch (error) {
        console.error('Erro ao salvar ativo:', error);
        showToast(`Erro ao salvar: ${parseSupabaseError(error)}`, 'error');
    } finally {
        setButtonLoading(submitButton, false);
    }
}

async function criarAtivo(payload, imagemFile, pdfFile) {
    await verificarNumeroDisponivel(payload.numero);

    let imgUrl = null;
    let pdfUrl = null;

    try {
        imgUrl = await uploadStorageFile(BUCKET_FOTOS, imagemFile, payload.numero, 'imagem');
        pdfUrl = await uploadStorageFile(BUCKET_NFS, pdfFile, payload.numero, 'pdf');

        const insertPayload = {
            ...payload,
            img_url: imgUrl,
            documento: pdfUrl,
            ativo: true
        };

        const { data, error } = await supabaseClient
            .from(TABLE_PATRIMONIOS)
            .insert(insertPayload)
            .select('id, numero, item, classificacao, data, nf, preco, local, documento, foto, status')
            .single();

        if (error) throw error;

        const novoAtivo = normalizeAtivo(data);
        updateLocalData(novoAtivo);

        await registrarHistorico({
            patrimonioId: novoAtivo.id,
            numero: novoAtivo.numero,
            item: novoAtivo.item,
            acao: 'cadastro',
            descricao: `Ativo ${novoAtivo.numero} cadastrado.`,
            depois: novoAtivo
        });

        showToast('Ativo cadastrado com sucesso!');
        resetCadastroForm();
        initDashboard();
        popularFiltrosRelatorios();
        renderRelatorios();
        navigate('ativos');
    } catch (error) {
        throw error;
    }
}

async function atualizarAtivo(payload, imagemFile, pdfFile) {
    const ativoOriginal = todosAtivosData.find((ativo) => Number(ativo.id) === Number(editingAtivoId));
    if (!ativoOriginal) throw new Error('Ativo em edição não encontrado.');

    await verificarNumeroDisponivel(payload.numero, editingAtivoId);

    const updatePayload = { ...payload };

    if (imagemFile) {
        updatePayload.img_url = await uploadStorageFile(BUCKET_FOTOS, imagemFile, payload.numero, 'imagem');
    }

    if (pdfFile) {
        updatePayload.documento = await uploadStorageFile(BUCKET_NFS, pdfFile, payload.numero, 'pdf');
    }

    const { data, error } = await supabaseClient
        .from(TABLE_PATRIMONIOS)
        .update(updatePayload)
        .eq('id', editingAtivoId)
        .select('id, numero, item, classificacao, data, nf, preco, local, documento, foto, status')
        .single();

    if (error) throw error;

    const ativoAtualizado = normalizeAtivo(data);
    updateLocalData(ativoAtualizado);

    const diferencas = buildDiff(ativoOriginal, ativoAtualizado, [
        'numero',
        'item',
        'classificacao',
        'data',
        'nf',
        'preco',
        'local',
        'pagamento',
        'img_url',
        'pdf_url'
    ]);

    await registrarHistorico({
        patrimonioId: ativoAtualizado.id,
        numero: ativoAtualizado.numero,
        item: ativoAtualizado.item,
        acao: 'edicao',
        descricao: Object.keys(diferencas).length
            ? `Ativo ${ativoAtualizado.numero} editado.`
            : `Ativo ${ativoAtualizado.numero} salvo sem alterações visíveis.`,
        antes: ativoOriginal,
        depois: ativoAtualizado
    });

    showToast('Ativo atualizado com sucesso!');
    resetCadastroForm();
    initDashboard();
    popularFiltrosRelatorios();
    renderRelatorios();
    navigate('ativos');
}

function startEditAtivo(id) {
    const ativo = todosAtivosData.find((item) => Number(item.id) === Number(id));
    if (!ativo) {
        showToast('Ativo não encontrado para edição.', 'error');
        return;
    }

    editingAtivoId = Number(ativo.id);
    getEl('cad_editing_id').value = ativo.id;
    getEl('cad_numero').value = ativo.numero;
    getEl('cad_item').value = ativo.item;
    getEl('cad_classificacao').value = ativo.classificacao;
    getEl('cad_local').value = ativo.local;
    getEl('cad_data').value = ativo.data ? String(ativo.data).slice(0, 10) : '';
    getEl('cad_preco').value = ativo.preco;
    getEl('cad_nf').value = ativo.nf === 'S/NF' ? '' : ativo.nf;
    getEl('cad_pagamento').value = ativo.pagamento;

    getEl('cadastroTitle').textContent = `Editar Ativo Nº ${ativo.numero}`;
    getEl('cadastroSubtitle').textContent = 'Atualize os dados do patrimônio selecionado.';
    getEl('btnSalvarPatrimonio').innerHTML = '<i class="fa-solid fa-floppy-disk mr-2"></i> Atualizar Patrimônio';
    getEl('btnCancelarEdicao').classList.remove('hidden');

    getEl('cad_imagem_label').textContent = ativo.img_url ? 'Foto atual mantida. Selecione outra para substituir.' : 'PNG, JPG até 5MB';
    getEl('cad_pdf_label').textContent = ativo.pdf_url ? 'PDF atual mantido. Selecione outro para substituir.' : 'Apenas PDF até 5MB';

    closeModal();
    navigate('cadastro');
}

function resetCadastroForm() {
    editingAtivoId = null;

    const form = getEl('formCadastro');
    if (form) form.reset();

    getEl('cad_editing_id').value = '';
    getEl('cadastroTitle').textContent = 'Registrar Novo Ativo';
    getEl('cadastroSubtitle').textContent = 'Insira os dados do novo patrimônio para o banco de dados.';
    getEl('btnSalvarPatrimonio').innerHTML = '<i class="fa-solid fa-save mr-2"></i> Salvar Patrimônio';
    getEl('btnCancelarEdicao').classList.add('hidden');
    getEl('cad_imagem_label').textContent = 'PNG, JPG até 5MB';
    getEl('cad_pdf_label').textContent = 'Apenas PDF até 5MB';
}

// ================= BAIXA =================

function openBaixaModal(id) {
    const ativo = todosAtivosData.find((item) => Number(item.id) === Number(id));
    if (!ativo) {
        showToast('Ativo não encontrado para baixa.', 'error');
        return;
    }

    getEl('baixa_ativo_id').value = ativo.id;
    getEl('baixa_motivo').value = '';
    getEl('baixaModal').classList.remove('hidden');
}

function closeBaixaModal() {
    getEl('baixaModal')?.classList.add('hidden');
}

async function confirmarBaixa(event) {
    event.preventDefault();

    const button = getEl('btnConfirmarBaixa');

    try {
        setButtonLoading(button, true, 'Baixando...');

        const id = Number(getEl('baixa_ativo_id').value);
        const motivo = getEl('baixa_motivo').value.trim();
        const ativoOriginal = todosAtivosData.find((ativo) => Number(ativo.id) === id);

        if (!ativoOriginal) throw new Error('Ativo não encontrado.');
        if (!motivo) throw new Error('Informe o motivo da baixa.');

        const { data, error } = await supabaseClient
            .from(TABLE_PATRIMONIOS)
            .update({ ativo: false })
            .eq('id', id)
            .select('id, numero, item, classificacao, data, nf, preco, local, documento, foto, status')
            .single();

        if (error) throw error;

        const ativoBaixado = normalizeAtivo(data);
        updateLocalData(ativoBaixado);

        await registrarHistorico({
            patrimonioId: ativoBaixado.id,
            numero: ativoBaixado.numero,
            item: ativoBaixado.item,
            acao: 'baixa',
            descricao: `Ativo ${ativoBaixado.numero} baixado. Motivo: ${motivo}`,
            antes: ativoOriginal,
            depois: { ...ativoBaixado, motivo_baixa: motivo }
        });

        closeBaixaModal();
        closeModal();
        showToast('Ativo baixado com sucesso.');
        initDashboard();
        popularFiltrosRelatorios();
        renderRelatorios();

        if (currentView === 'ativos') {
            renderAtivosList(getEl('searchInput')?.value || '');
        }
    } catch (error) {
        console.error('Erro ao dar baixa:', error);
        showToast(`Erro ao dar baixa: ${parseSupabaseError(error)}`, 'error');
    } finally {
        setButtonLoading(button, false);
    }
}

// ================= NAVEGAÃƒâ€¡ÃƒÆ’O =================

function navigate(viewId) {
    currentView = viewId;

    document.querySelectorAll('.view-section').forEach((el) => {
        el.classList.add('hidden');
        el.classList.remove('block');
    });

    const targetView = getEl(`view-${viewId}`);
    if (targetView) {
        targetView.classList.remove('hidden');
        targetView.classList.add('block');
    }

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        if (btn.dataset.target === viewId) {
            btn.classList.add('bg-blue-50', 'text-secondary', 'border-blue-100');
            btn.classList.remove('text-slate-600', 'hover:bg-slate-100', 'hover:text-slate-900', 'hover:bg-white', 'border-transparent');
        } else {
            btn.classList.remove('bg-blue-50', 'text-secondary', 'border-blue-100');
            btn.classList.add('text-slate-600', 'hover:bg-slate-100', 'hover:text-slate-900');

            if (btn.parentElement?.id === 'mobileNav') {
                btn.classList.add('hover:bg-white', 'border-transparent');
                btn.classList.remove('hover:bg-slate-100');
            }
        }
    });

    const mobileNav = getEl('mobileNav');
    if (mobileNav && !mobileNav.classList.contains('hidden')) {
        mobileNav.classList.add('hidden');
    }

    if (viewId === 'dashboard') initDashboard({ compare: false });
    if (viewId === 'ativos') renderAtivosList(getEl('searchInput')?.value || '');
    if (viewId === 'historico') {
        if (!historicoData.length) carregarHistorico();
        else renderHistorico();
    }
    if (viewId === 'relatorios') {
        popularFiltrosRelatorios();
        renderRelatorios();
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ================= DASHBOARD =================

function renderDashboardVariations(metrics, previousMetrics) {
    const definitions = [
        { key: 'totalValor', id: 'valor-total', currency: true },
        { key: 'totalItens', id: 'total-itens', currency: false },
        { key: 'locais', id: 'locais', currency: false },
        { key: 'maiorValor', id: 'maior-valor', currency: true }
    ];

    definitions.forEach(({ key, id, currency }) => {
        const variation = getEl(`kpi-${id}-variation`);
        const sparkline = getEl(`kpi-${id}-sparkline`);
        const path = sparkline?.querySelector('path');

        if (!variation || !sparkline || !path) return;

        variation.className = 'summary-kpi-variation';
        sparkline.classList.add('hidden');

        if (!previousMetrics) {
            variation.textContent = 'Sem histórico';
            variation.classList.add('is-unavailable');
            path.setAttribute('d', '');
            return;
        }

        const current = Number(metrics[key] || 0);
        const previous = Number(previousMetrics[key] || 0);
        const difference = current - previous;
        const direction = difference > 0 ? 'up' : difference < 0 ? 'down' : 'same';
        const arrow = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '—';
        const sign = difference > 0 ? '+' : '';
        const formattedDifference = currency
            ? `${sign}${difference < 0 ? '-' : ''}${formatMoney(Math.abs(difference))}`
            : `${sign}${difference} ${Math.abs(difference) === 1 ? 'item' : 'itens'}`;

        variation.textContent = `${arrow} ${formattedDifference}`;
        variation.classList.add(`is-${direction}`);

        const values = [previous, current];
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min;
        const y = (value) => range ? 24 - ((value - min) / range) * 20 : 14;
        path.setAttribute('d', `M 2 ${y(previous).toFixed(2)} L 98 ${y(current).toFixed(2)}`);
        sparkline.classList.remove('hidden');
    });
}

function initDashboard({ compare = true } = {}) {
    const idsIncluidos = new Set();
    const itensResumo = todosAtivosData.filter((ativo) => {
        if (ativo?.id === null || ativo?.id === undefined || idsIncluidos.has(ativo.id)) return false;

        idsIncluidos.add(ativo.id);
        return true;
    });

    const totalValor = itensResumo.reduce((acc, curr) => acc + Number(curr.preco || 0), 0);
    const totalItens = itensResumo.length;
    const locaisUnicos = [...new Set(itensResumo.map((item) => getVisualLocationKey(item.local)))];

    let maiorItem = itensResumo[0] || { preco: 0, item: '-' };
    itensResumo.forEach((i) => {
        if (Number(i.preco || 0) > Number(maiorItem.preco || 0)) maiorItem = i;
    });

    if (getEl('kpi-valor-total')) getEl('kpi-valor-total').textContent = formatMoney(totalValor);
    if (getEl('kpi-total-itens')) getEl('kpi-total-itens').textContent = totalItens;
    if (getEl('kpi-locais')) getEl('kpi-locais').textContent = locaisUnicos.length;

    if (getEl('kpi-maior-valor')) {
        getEl('kpi-maior-valor').textContent = totalItens ? formatMoney(maiorItem.preco) : '-';
        getEl('kpi-maior-valor').title = totalItens ? maiorItem.item : '-';
    }

    const dashboardMetrics = {
        totalValor,
        totalItens,
        locais: locaisUnicos.length,
        maiorValor: totalItens ? Number(maiorItem.preco || 0) : 0
    };

    if (compare) {
        renderDashboardVariations(dashboardMetrics, dashboardMetricsAnterior);
        dashboardMetricsAnterior = dashboardMetrics;
    }

    const maiorValorCard = getEl('kpi-maior-valor-card');
    if (maiorValorCard) maiorValorCard.dataset.ativoId = totalItens ? maiorItem.id : '';

    const resumoLocal = {};
    const resumoClassificacao = {
        'Veículo': 0,
        'Máquina': 0,
        'Eletrônico': 0,
        'Eletrodoméstico': 0,
        'Móveis': 0,
        'Área Externa': 0,
        'Outros': 0
    };

    const classificacaoPorCategoria = {
        'Veículo': ['CARRO'],
        'Máquina': ['Maquina'],
        'Eletrônico': ['Computador', 'Celular', 'Eletroeletrônico', 'Tablet', 'Radio'],
        'Eletrodoméstico': ['Eletrodomestico'],
        'Móveis': ['Móvel', 'Cadeira', 'Banco'],
        'Área Externa': [],
        Outros: ['Ar Condicionado', 'Lousa', 'Extintor', 'Container']
    };

    itensResumo.forEach((ativo) => {
        const local = ativo.local || 'Sem local definido';
        const categoriaOriginal = Object.keys(classificacaoPorCategoria)
            .find((nome) => classificacaoPorCategoria[nome].includes(ativo.classificacao));
        const categoria = isVisualOutrosItem(ativo)
            ? Object.keys(classificacaoPorCategoria).find((nome) => normalizeLocationText(nome) === 'area externa') || Object.keys(classificacaoPorCategoria)[5]
            : categoriaOriginal || 'Outros';

        resumoLocal[local] = (resumoLocal[local] || 0) + 1;
        resumoClassificacao[categoria] += Number(ativo.preco || 0);
    });

    renderCharts(resumoClassificacao, resumoLocal);
}

function navigateToMaiorValor() {
    const targetId = getEl('kpi-maior-valor-card')?.dataset.ativoId;
    if (!targetId) return;

    const searchInput = getEl('searchInput');
    if (searchInput) searchInput.value = '';

    navigate('ativos');

    window.requestAnimationFrame(() => {
        const targetCard = getEl('ativosContainer')?.querySelector('[data-ativo-id="' + targetId + '"]');
        if (!targetCard) return;

        const accordionContents = [];
        let parent = targetCard.parentElement;

        while (parent) {
            if (parent.classList?.contains('accordion-content')) accordionContents.push(parent);
            parent = parent.parentElement;
        }

        accordionContents.reverse().forEach((content) => {
            if (!content.classList.contains('open')) toggleAccordion(content.id);
        });

        window.setTimeout(() => {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 320);
    });
}

function renderCharts(dadosClassificacao, dadosLocal) {
    if (!getEl('chartClassificacao') || !getEl('chartLocal') || !window.Chart) return;

    if (chartClassificacaoInstance) chartClassificacaoInstance.destroy();
    if (chartLocalInstance) chartLocalInstance.destroy();

    Chart.defaults.font.family = 'Inter';
    Chart.defaults.color = '#64748b';

    const ctxPie = getEl('chartClassificacao').getContext('2d');
    const totalClassificacao = Object.values(dadosClassificacao).reduce((total, valor) => total + Number(valor || 0), 0);
    const classificacoes = [
        { label: 'Veículo', value: totalClassificacao ? (dadosClassificacao['Veículo'] / totalClassificacao) * 100 : 0, color: '#3b82f6' },
        { label: 'Máquina', value: totalClassificacao ? (dadosClassificacao['Máquina'] / totalClassificacao) * 100 : 0, color: '#10b981' },
        { label: 'Eletrônico', value: totalClassificacao ? (dadosClassificacao['Eletrônico'] / totalClassificacao) * 100 : 0, color: '#f59e0b' },
        { label: 'Eletrodoméstico', value: totalClassificacao ? (dadosClassificacao['Eletrodoméstico'] / totalClassificacao) * 100 : 0, color: '#8b5cf6' },
        { label: 'Móveis', value: totalClassificacao ? (dadosClassificacao['Móveis'] / totalClassificacao) * 100 : 0, color: '#ef4444' },
        { label: 'Área Externa', value: totalClassificacao ? (dadosClassificacao['Área Externa'] / totalClassificacao) * 100 : 0, color: '#64748b' },
        { label: 'Outros', value: totalClassificacao ? (dadosClassificacao.Outros / totalClassificacao) * 100 : 0, color: '#14b8a6' }
    ];
    const labelsClassificacao = classificacoes.map((item) => item.label);
    const valuesClassificacao = classificacoes.map((item) => item.value);
    const colorsClassificacao = classificacoes.map((item) => item.color);
    const formatPercentual = (value) => `${Number(value).toFixed(1).replace('.', ',')}%`;
    const legendClassificacao = getEl('classificationLegend');
    const classificationIcons = [
        'fa-car',
        'fa-gears',
        'fa-desktop',
        'fa-plug',
        'fa-couch',
        'fa-building',
        'fa-ellipsis'
    ];

    if (legendClassificacao) {
        legendClassificacao.innerHTML = classificacoes.map((item, index) => `
            <div class="classification-tile">
                <div class="classification-tile-icon"><i class="fa-solid ${classificationIcons[index]}" aria-hidden="true"></i></div>
                <span class="classification-tile-name">${item.label}</span>
                <strong class="classification-tile-percent">${formatPercentual(item.value)}</strong>
                <span class="classification-tile-value">${formatMoney(Object.values(dadosClassificacao)[index] || 0)}</span>
                <i class="classification-tile-watermark fa-solid ${classificationIcons[index]}" aria-hidden="true"></i>
            </div>
        `).join('') + `
            <div class="classification-legend-total"><span>Total</span><strong>100%</strong></div>
        `;
    }

    chartClassificacaoInstance = new Chart(ctxPie, {
        type: 'doughnut',
        data: {
            labels: labelsClassificacao,
            datasets: [{
                data: valuesClassificacao,
                backgroundColor: colorsClassificacao,
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${formatPercentual(ctx.raw)}`
                    }
                }
            },
            cutout: '75%'
        }
    });

    ultimoResumoLocal = dadosLocal;
    renderChartLocal(dadosLocal);
}

const statusValueLabelsPlugin = {
    id: 'statusValueLabels',
    afterDatasetsDraw(chart) {
        if (!chart.options.plugins.statusValueLabels?.display) return;

        const { ctx } = chart;
        ctx.save();
        ctx.fillStyle = '#64748b';
        ctx.font = '500 14px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        chart.getDatasetMeta(0).data.forEach((bar, index) => {
            ctx.fillText(chart.data.datasets[0].data[index], bar.x, bar.y - 6);
        });

        ctx.restore();
    }
};

const localValueLabelsPlugin = {
    id: 'localValueLabels',
    afterDraw(chart) {
        if (!chart.options.plugins.localValueLabels?.display) return;

        const { ctx } = chart;
        ctx.save();
        ctx.fillStyle = '#64748b';
        ctx.font = '700 12px Inter';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        chart.getDatasetMeta(0).data.forEach((bar, index) => {
            const isSalaDiretoria = chart.data.labels[index] === 'Sala Diretoria';
            const labelY = Math.max(14, bar.y - (isSalaDiretoria ? 10 : 6));
            ctx.fillText(chart.data.datasets[0].data[index], bar.x, labelY);
        });

        ctx.restore();
    }
};

function renderChartLocal(dadosLocal) {
    if (!getEl('chartLocal') || !window.Chart) return;

    if (chartLocalInstance) chartLocalInstance.destroy();

    const isStatusView = chartLocalView === 'status';
    const resumoLocalVisual = getPrincipalLocationSummary(dadosLocal);
    const resumoStatus = todosAtivosData.reduce((totais, ativo) => {
        const categoria = getStatusCategoria(ativo);
        totais[categoria] = (totais[categoria] || 0) + 1;
        return totais;
    }, { ativo: 0, inativo: 0, defeito: 0, outro: 0 });
    const labels = isStatusView
        ? ['Ativos', 'Inativos', 'Defeitos', 'Outros']
        : resumoLocalVisual.map((i) => i[0]);
    const values = isStatusView
        ? [resumoStatus.ativo, resumoStatus.inativo, resumoStatus.defeito, resumoStatus.outro]
        : resumoLocalVisual.map((i) => i[1]);
    const title = getEl('chartLocalTitle');
    const localChartVisual = getEl('localChartVisual');
    const statusChartVisual = getEl('statusChartVisual');
    const chartLocalCanvas = getEl('chartLocal');

    if (title) title.textContent = isStatusView ? 'Quantidade de Itens por Status' : 'Quantidade de Itens por Local';

    if (localChartVisual && chartLocalCanvas) {
        if (isStatusView) {
            localChartVisual.classList.add('hidden');
            if (statusChartVisual) {
                statusChartVisual.classList.remove('hidden');
                const maxValue = Math.max(...values.map((value) => Number(value) || 0), 1);
                const statusIcons = ['fa-circle-check', 'fa-circle-minus', 'fa-triangle-exclamation', 'fa-ellipsis'];
                const statusClasses = ['status-active', 'status-inactive', 'status-defective', 'status-other'];
                statusChartVisual.innerHTML = labels.map((label, index) => {
                    const value = Number(values[index]) || 0;
                    const height = value ? Math.max((value / maxValue) * 100, 2) : 0;
                    return `
                        <div class="status-chart-column ${statusClasses[index]}">
                            <div class="status-chart-bar-area" style="--bar-height: ${height}%;">
                                <span class="status-chart-value">${value}</span>
                                <div class="status-chart-bar"></div>
                            </div>
                            <div class="status-chart-icon"><i class="fa-solid ${statusIcons[index]}" aria-hidden="true"></i></div>
                            <span class="status-chart-label">${escapeHTML(label)}</span>
                        </div>
                    `;
                }).join('');
            }
            chartLocalCanvas.classList.remove('hidden');
            chartLocalCanvas.style.display = 'none';
        } else {
            chartLocalCanvas.classList.add('hidden');
            chartLocalCanvas.style.display = 'none';
            localChartVisual.classList.remove('hidden');
            if (statusChartVisual) statusChartVisual.classList.add('hidden');
            const maxValue = Math.max(...values.map((value) => Number(value) || 0), 1);
            const locationIcon = (label) => {
                const normalized = normalizeLocationText(label);
                if (normalized.includes('diretoria')) return 'fa-building';
                if (normalized.includes('automacao')) return 'fa-gears';
                if (normalized.includes('administrativo')) return 'fa-briefcase';
                if (normalized.includes('cozinha')) return 'fa-utensils';
                if (normalized.includes('copa')) return 'fa-mug-hot';
                if (normalized.includes('almoxarifado')) return 'fa-boxes-stacked';
                return 'fa-location-dot';
            };

            localChartVisual.innerHTML = labels.map((label, index) => {
                const value = Number(values[index]) || 0;
                const height = value ? Math.max((value / maxValue) * 100, 2) : 0;
                return `
                    <div class="local-chart-column">
                        <div class="local-chart-bar-area" style="--bar-height: ${height}%;">
                            <span class="local-chart-value">${value}</span>
                            <div class="local-chart-bar"></div>
                        </div>
                        <div class="local-chart-icon"><i class="fa-solid ${locationIcon(label)}" aria-hidden="true"></i></div>
                        <span class="local-chart-label">${escapeHTML(label)}</span>
                    </div>
                `;
            }).join('');
        }
    }

    const ctxBar = getEl('chartLocal').getContext('2d');

    chartLocalInstance = new Chart(ctxBar, {
        type: 'bar',
        plugins: isStatusView ? [statusValueLabelsPlugin] : [localValueLabelsPlugin],
        data: {
            labels,
            datasets: [{
                label: 'Qtd de Itens',
                data: values,
                backgroundColor: isStatusView ? ['#10b981', '#64748b', '#ef4444', '#f59e0b'] : '#3b82f6',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ...(isStatusView ? {} : { suggestedMax: 35 }),
                    display: false,
                    ticks: { display: false },
                    grid: { display: false },
                    border: { display: false }
                },
                x: { grid: { display: false }, border: { display: false } }
            },
            plugins: isStatusView
                ? {
                    legend: { display: false },
                    statusValueLabels: { display: true }
                }
                : {
                    legend: { display: false },
                    localValueLabels: { display: true }
                }
        }
    });
}

function toggleChartLocalView() {
    chartLocalView = chartLocalView === 'local' ? 'status' : 'local';
    renderChartLocal(ultimoResumoLocal);
}

// ================= LISTAGEM =================

function renderAtivosList(filtro = '') {
    const container = getEl('ativosContainer');
    if (!container) return;

    container.innerHTML = '';

    if (isLoadingAtivos) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-500">
                <i class="fa-solid fa-spinner fa-spin text-4xl mb-3 text-slate-300 block"></i>
                Carregando ativos do Supabase...
            </div>
        `;
        return;
    }

    const termo = String(filtro || '').toLowerCase().trim();
    const dadosFiltrados = todosAtivosData.filter((item) =>
        item.item.toLowerCase().includes(termo) ||
        item.numero.includes(termo) ||
        item.local.toLowerCase().includes(termo) ||
        item.classificacao.toLowerCase().includes(termo)
    );

    if (dadosFiltrados.length === 0) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-500">
                <i class="fa-solid fa-folder-open text-4xl mb-3 text-slate-300 block"></i>
                Nenhum ativo encontrado.
            </div>
        `;
        return;
    }

    const agrupado = dadosFiltrados.reduce((acc, ativo) => {
        const local = ativo.local || 'Sem local definido';
        if (!acc[local]) acc[local] = [];
        acc[local].push(ativo);
        return acc;
    }, {});

    Object.keys(agrupado).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach((local, index) => {
        const itens = agrupado[local].sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));
        const valorArea = itens.reduce((acc, curr) => acc + Number(curr.preco || 0), 0);

        const cardsHTML = itens.map((ativo) => {
            const safeItem = escapeHTML(ativo.item);
            const safeClassificacao = escapeHTML(ativo.classificacao);
            const safeNumero = escapeHTML(ativo.numero);
            const cardPhotoUrl = getCardPhotoUrl(ativo);
            const imageHTML = cardPhotoUrl
                ? `<img src="${escapeHTML(cardPhotoUrl)}" alt="${safeItem}" onerror="handleImageError(this)" class="w-full h-full object-cover">`
                : `<i class="fa-solid fa-image text-lg"></i>`;

            return `
                <div data-ativo-id="${Number(ativo.id)}" onclick="openModal(${Number(ativo.id)})" class="bg-white p-3 rounded-lg border border-slate-200 shadow-sm cursor-pointer hover:border-secondary/50 hover:shadow-md transition-all group flex items-start">
                    <div class="w-14 h-14 rounded-md bg-slate-100 flex-shrink-0 flex items-center justify-center text-slate-400 mr-3 overflow-hidden border border-slate-200">
                        ${imageHTML}
                    </div>
                    <div class="flex-1 min-w-0 py-0.5">
                        <div class="flex justify-between items-start mb-1">
                            <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-100 px-1.5 py-0.5 rounded">Nº ${safeNumero}</p>
                            <span class="text-[10px] font-semibold text-secondary bg-blue-50 px-1.5 py-0.5 rounded truncate max-w-[80px]">${safeClassificacao}</span>
                        </div>
                        <p class="text-sm font-bold text-slate-800 truncate group-hover:text-secondary transition-colors" title="${safeItem}">${safeItem}</p>
                        <p class="text-xs font-semibold text-emerald-600 mt-1">${formatMoney(ativo.preco)}</p>
                    </div>
                </div>
            `;
        }).join('');

        const accordionHTML = `
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <button type="button" onclick="toggleAccordion('acc-${index}')" class="w-full px-5 py-4 flex justify-between items-center bg-white hover:bg-slate-50 transition-colors focus:outline-none">
                    <div class="flex items-center text-left min-w-0">
                        <div class="bg-blue-50 text-secondary border border-blue-100 w-10 h-10 rounded-lg flex items-center justify-center mr-4 flex-shrink-0">
                            <i class="fa-solid fa-map-pin"></i>
                        </div>
                        <div class="min-w-0">
                            <h4 class="font-bold text-slate-800 text-sm md:text-base truncate">${escapeHTML(local)}</h4>
                            <p class="text-xs text-slate-500 font-medium mt-0.5">${itens.length} ite${itens.length > 1 ? 'ns' : 'm'} • <span class="text-emerald-600">${formatMoney(valorArea)}</span></p>
                        </div>
                    </div>
                    <i id="icon-acc-${index}" class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-300 ml-4"></i>
                </button>

                <div id="acc-${index}" class="accordion-content bg-slate-50/50 border-t border-slate-100">
                    <div class="p-3 md:p-5">
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            ${cardsHTML}
                        </div>
                    </div>
                </div>
            </div>
        `;

        container.insertAdjacentHTML('beforeend', accordionHTML);
    });
}

// Agrupamento exclusivamente visual; nenhum campo local ÃƒÂ© alterado.
// Agrupamento exclusivamente visual, limitado aos nomes validados; sem fuzzy matching.
const VISUAL_LOCATION_GROUPS = Object.freeze([
    { key: 'dariane', label: 'Dariane', locations: ['Adm/Dariane', 'Adm/Suporte/Dariane'] },
    { key: 'barbara', label: 'Barbara', locations: ['Comercial/Barbara', 'Comercial/BÃ¡rbara', 'Sala Diretoria/Barbara'] },
    { key: 'mickaele', label: 'Mickaele', locations: ['Compras/Mickaele', 'Compras/ Mickaele'] },
    { key: 'francis', label: 'Francis', locations: ['AutomaÃ§Ã£o Francis', 'Sala AutomaÃ§Ã£o/Francis'] },
    { key: 'jefferson', label: 'Jefferson', locations: ['Comercial/Jefferson', 'IA/Jefferson'] },
    { key: 'luan', label: 'Luan', locations: ['Projetos/Luan', 'Sala Diretoria/Luan', 'Sala Copa/Projetos Luan'] },
    { key: 'orlean', label: 'Orlean', locations: ['ProduÃ§Ã£o/Orlean', 'ProduÃ§Ã£o/Orlean/Defeito', 'Sala Copa/Orlean'] },
    { key: 'sala-automacao', label: 'Sala Automação', locations: ['Sala AutomaÃ§Ã£o', 'Sala automaÃ§Ã£o'] },
    { key: 'almoxarifado', label: 'Almoxarifado', locations: ['Almoxarifado', 'Almoxarifado '] },
    { key: 'cofre-para-bens', label: 'Cofre para bens', locations: ['Cofre para bens', 'Cofre para Bens'] }
]);
const VISUAL_GROUP_FILTER_PREFIX = '__visual_group__:';
const normalizeLocationText = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[\/\\.,;:_-]+/g, ' ').replace(/\s+/g, ' ').trim();
// O nome do local identifica itens com defeito, mesmo que o registro legado
// ainda esteja marcado como inativo no banco.
const isDefeitoLocation = (local) => /\bdefeito\b/.test(normalizeLocationText(local));
const getStatusCategoria = (ativo) => {
    if (isDefeitoLocation(ativo?.local)) return 'defeito';

    const status = normalizeStatus(ativo?.status);
    if (['ativo', 'ativos'].includes(status)) return 'ativo';
    if (['defeito', 'defeitos'].includes(status)) return 'defeito';
    if (['inativo', 'inativos', 'baixado', 'baixados'].includes(status)) return 'inativo';
    return 'outro';
};
const getStatusExibicao = (ativo) => getStatusCategoria(ativo) === 'defeito'
    ? 'Defeito'
    : (ativo.ativo ? 'Ativo' : 'Baixado');
const isCadeiraEmDefeito = (ativo) => {
    const classificacao = normalizeLocationText(ativo?.classificacao);
    const item = normalizeLocationText(ativo?.item);
    const isCadeira = classificacao === 'cadeira' || item.includes('cadeira');
    return isCadeira && getStatusCategoria(ativo) === 'defeito';
};
const PRINCIPAL_LOCATION_LABELS = Object.freeze([
    'Sala Diretoria',
    'Sala Automação',
    'Sala Administrativo',
    'Sala Cozinha',
    'Sala Copa',
    'Almoxarifado'
]);
const getPrincipalLocationCategory = (local) => {
    if (isDefeitoLocation(local)) return null;

    const normalized = normalizeLocationText(local);
    if (normalized.includes('sala diretoria') || ['jefferson', 'barbara', 'breno', 'dariane'].some((name) => normalized.includes(name))) {
        return 'Sala Diretoria';
    }
    if (normalized.includes('sala automacao') || ['francis', 'orlean'].some((name) => normalized.includes(name))) {
        return 'Sala Automação';
    }
    if (normalized.includes('sala administrativo') || normalized.includes('administrativo financeiro') || normalized.includes('mickaele')) {
        return 'Sala Administrativo';
    }
    if (normalized.includes('sala cozinha')) return 'Sala Cozinha';
    if (normalized.includes('sala copa') || ['luan', 'sebastiao'].some((name) => normalized.includes(name))) {
        return 'Sala Copa';
    }
    if (normalized.includes('almoxarifado')) return 'Almoxarifado';

    return null;
};
const getPrincipalLocationSummary = (dadosLocal) => {
    const totals = Object.fromEntries(PRINCIPAL_LOCATION_LABELS.map((label) => [label, 0]));

    Object.entries(dadosLocal).forEach(([local, quantidade]) => {
        const category = getPrincipalLocationCategory(local);
        if (category) totals[category] += Number(quantidade || 0);
    });

    return PRINCIPAL_LOCATION_LABELS.map((label) => [label, totals[label]]);
};
const normalizeVisualLocalValue = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
const VISUAL_OUTROS_LOCATIONS = Object.freeze([
    'oficina',
    'oficina/externa',
    'externa/oficina',
    'externa'
]);
const isVisualOutrosItem = (ativo) => VISUAL_OUTROS_LOCATIONS.includes(normalizeVisualLocalValue(ativo?.local));
function getVisualLocationGroup(local) {
    const normalized = normalizeLocationText(local);
    return VISUAL_LOCATION_GROUPS.find((group) => group.locations
        .some((location) => normalizeLocationText(location) === normalized)) || null;
}
function getVisualLocationKey(local) {
    const group = getVisualLocationGroup(local);
    return group ? `group:${group.key}` : `local:${local || 'Sem local definido'}`;
}
function getVisualLocationSummary(dadosLocal) {
    const resumo = new Map();
    Object.entries(dadosLocal).forEach(([local, quantidade]) => {
        const group = getVisualLocationGroup(local);
        const key = group ? `group:${group.key}` : `local:${local}`;
        const atual = resumo.get(key) || { label: group?.label || local, quantidade: 0 };
        atual.quantidade += Number(quantidade || 0);
        resumo.set(key, atual);
    });
    return [...resumo.values()]
        .sort((a, b) => b.quantidade - a.quantidade)
        .map(({ label, quantidade }) => [label, quantidade]);
}
function getVisualGroups(ativos) {
    const result = new Map();
    ativos.forEach(({ local }) => {
        const original = local || 'Sem local definido';
        const group = getVisualLocationGroup(original);
        if (group) result.set(original, group);
    });
    return result;
}
const renderAtivosListOriginal = renderAtivosList;
renderAtivosList = function (filtro = '') {
    const container = getEl('ativosContainer');
    if (!container || isLoadingAtivos) {
        renderAtivosListOriginal(filtro);
        return;
    }

    const term = normalizeLocationText(filtro);
    const statusSections = [
        { key: 'ativos', label: 'Ativos', icon: 'fa-circle-check' },
        { key: 'inativos', label: 'Inativos', icon: 'fa-circle-minus' },
        { key: 'defeitos', label: 'Defeitos', icon: 'fa-triangle-exclamation' },
        { key: 'outros', label: 'Outros', icon: 'fa-circle-question' }
    ];

    const getStatusSection = (ativo) => {
        const status = getStatusCategoria(ativo);
        if (status === 'ativo') return 'ativos';
        if (status === 'inativo') return 'inativos';
        if (status === 'defeito') return 'defeitos';
        return 'outros';
    };

    const matchesSearch = (ativo) => !term || [
        ativo.item,
        ativo.numero,
        ativo.local,
        ativo.classificacao
    ].some((value) => normalizeLocationText(value).includes(term));

    const createCard = (ativo) => {
        const safeItem = escapeHTML(ativo.item);
        const safeClassificacao = escapeHTML(ativo.classificacao);
        const safeNumero = escapeHTML(ativo.numero);
        const cardPhotoUrl = getCardPhotoUrl(ativo);
        const imageHTML = cardPhotoUrl
            ? `<img src="${escapeHTML(cardPhotoUrl)}" alt="${safeItem}" onerror="handleImageError(this)" class="w-full h-full object-cover">`
            : '<i class="fa-solid fa-image text-lg"></i>';

        return `
            <div data-ativo-id="${Number(ativo.id)}" onclick="openModal(${Number(ativo.id)})" class="bg-white p-3 rounded-lg border border-slate-200 shadow-sm cursor-pointer hover:border-secondary/50 hover:shadow-md transition-all group flex items-start">
                <div class="w-14 h-14 rounded-md bg-slate-100 flex-shrink-0 flex items-center justify-center text-slate-400 mr-3 overflow-hidden border border-slate-200">
                    ${imageHTML}
                </div>
                <div class="flex-1 min-w-0 py-0.5">
                    <div class="flex justify-between items-start mb-1">
                        <p class="text-[10px] font-bold text-slate-400 uppercase tracking-wider bg-slate-100 px-1.5 py-0.5 rounded">Nº ${safeNumero}</p>
                        <span class="text-[10px] font-semibold text-secondary bg-blue-50 px-1.5 py-0.5 rounded truncate max-w-[80px]">${safeClassificacao}</span>
                    </div>
                    <p class="text-sm font-bold text-slate-800 truncate group-hover:text-secondary transition-colors" title="${safeItem}">${safeItem}</p>
                    <p class="text-xs font-semibold text-emerald-600 mt-1">${formatMoney(ativo.preco)}</p>
                </div>
            </div>
        `;
    };

    const createLocalAccordion = (local, itens, id) => {
        const valorLocal = itens.reduce((sum, ativo) => sum + Number(ativo.preco || 0), 0);
        const cards = itens
            .slice()
            .sort((a, b) => a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }))
            .map(createCard)
            .join('');

        return `
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <button type="button" onclick="toggleAccordion('${id}')" class="w-full px-5 py-4 flex justify-between items-center bg-white hover:bg-slate-50 transition-colors focus:outline-none">
                    <div class="flex items-center text-left min-w-0">
                        <div class="bg-blue-50 text-secondary border border-blue-100 w-10 h-10 rounded-lg flex items-center justify-center mr-4 flex-shrink-0">
                            <i class="fa-solid fa-map-pin"></i>
                        </div>
                        <div class="min-w-0">
                            <h4 class="font-bold text-slate-800 text-sm md:text-base truncate">${escapeHTML(local)}</h4>
                            <p class="text-xs text-slate-500 font-medium mt-0.5">${itens.length} ite${itens.length > 1 ? 'ns' : 'm'} • <span class="text-emerald-600">${formatMoney(valorLocal)}</span></p>
                        </div>
                    </div>
                    <i id="icon-${id}" class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-300 ml-4"></i>
                </button>
                <div id="${id}" class="accordion-content bg-slate-50/50 border-t border-slate-100">
                    <div class="p-3 md:p-5">
                        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">${cards}</div>
                    </div>
                </div>
            </div>
        `;
    };

    const createEntries = (itens, statusKey) => {
        const byLocal = itens.reduce((map, ativo) => {
            const local = ativo.local || 'Sem local definido';
            if (!map.has(local)) map.set(local, []);
            map.get(local).push(ativo);
            return map;
        }, new Map());
        const groups = getVisualGroups(itens);
        const entries = new Map();

        [...byLocal.entries()].forEach(([local, localItems]) => {
            const group = groups.get(local);
            const key = group ? `group:${group.key}` : `local:${local}`;
            if (!entries.has(key)) entries.set(key, group ? { group, locals: [] } : { local, items: localItems });
            if (group) entries.get(key).locals.push({ local, items: localItems });
        });

        return [...entries.values()]
            .sort((a, b) => (a.group?.label || a.local).localeCompare(b.group?.label || b.local, 'pt-BR'))
            .map((entry, entryIndex) => {
                if (!entry.group) return createLocalAccordion(entry.local, entry.items, `status-${statusKey}-local-${entryIndex}`);

                const groupItems = entry.locals.flatMap((local) => local.items);
                const groupValue = groupItems.reduce((sum, ativo) => sum + Number(ativo.preco || 0), 0);
                const groupId = `status-${statusKey}-group-${entryIndex}`;
                const locations = entry.locals
                    .sort((a, b) => a.local.localeCompare(b.local, 'pt-BR'))
                    .map((local, localIndex) => createLocalAccordion(local.local, local.items, `${groupId}-local-${localIndex}`))
                    .join('');

                return `
                    <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                        <button type="button" onclick="toggleAccordion('${groupId}')" class="w-full px-5 py-4 flex justify-between items-center bg-white hover:bg-slate-50 transition-colors focus:outline-none">
                            <div class="flex items-center text-left min-w-0">
                                <div class="bg-blue-50 text-secondary border border-blue-100 w-10 h-10 rounded-lg flex items-center justify-center mr-4 flex-shrink-0">
                                    <i class="fa-solid fa-users"></i>
                                </div>
                                <div class="min-w-0">
                                    <h4 class="font-bold text-slate-800 text-sm md:text-base truncate">${escapeHTML(entry.group.label)}</h4>
                                    <p class="text-xs text-slate-500 font-medium mt-0.5">${groupItems.length} ite${groupItems.length > 1 ? 'ns' : 'm'} • <span class="text-emerald-600">${formatMoney(groupValue)}</span></p>
                                </div>
                            </div>
                            <i id="icon-${groupId}" class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-300 ml-4"></i>
                        </button>
                        <div id="${groupId}" class="accordion-content bg-slate-50/50 border-t border-slate-100">
                            <div class="p-3 md:p-5 space-y-3">${locations}</div>
                        </div>
                    </div>
                `;
            })
            .join('');
    };

    const sections = statusSections.map((section) => {
        // Estes locais pertencem visualmente a "Outros" nesta tela.
        // O status persistido continua intacto e o item Ã© renderizado uma Ãºnica vez.
        const statusItems = todosAtivosData.filter((ativo) => {
            if (isVisualOutrosItem(ativo)) return section.key === 'outros';
            return getStatusSection(ativo) === section.key;
        });
        const visibleItems = statusItems.filter(matchesSearch);
        const totalValue = visibleItems.reduce((sum, ativo) => sum + Number(ativo.preco || 0), 0);
        const sectionId = `status-section-${section.key}`;
        const entries = createEntries(visibleItems, section.key) || '<p class="text-sm text-slate-500 px-2 py-1">Nenhum item encontrado.</p>';

        return `
            <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <button type="button" onclick="toggleAccordion('${sectionId}')" class="w-full px-5 py-4 flex justify-between items-center bg-white hover:bg-slate-50 transition-colors focus:outline-none">
                    <div class="flex items-center text-left min-w-0">
                        <div class="bg-blue-50 text-secondary border border-blue-100 w-10 h-10 rounded-lg flex items-center justify-center mr-4 flex-shrink-0">
                            <i class="fa-solid ${section.icon}"></i>
                        </div>
                        <div class="min-w-0">
                            <h4 class="font-bold text-slate-800 text-sm md:text-base truncate">${section.label}</h4>
                            <p class="text-xs text-slate-500 font-medium mt-0.5">${visibleItems.length} ite${visibleItems.length > 1 ? 'ns' : 'm'} • <span class="text-emerald-600">${formatMoney(totalValue)}</span></p>
                        </div>
                    </div>
                    <i id="icon-${sectionId}" class="fa-solid fa-chevron-down text-slate-400 transition-transform duration-300 ml-4"></i>
                </button>
                <div id="${sectionId}" class="accordion-content bg-slate-50/50 border-t border-slate-100">
                    <div class="p-3 md:p-5 space-y-3">${entries}</div>
                </div>
            </div>
        `;
    });

    container.innerHTML = sections.join('');
};
function toggleAccordion(id) {
    const content = getEl(id);
    const icon = getEl(`icon-${id}`);

    if (!content || !icon) return;

    if (content.classList.contains('open')) {
        content.classList.remove('open');
        icon.style.transform = 'rotate(0deg)';
    } else {
        content.classList.add('open');
        icon.style.transform = 'rotate(180deg)';
    }
}

// ================= MODAL DETALHES =================

function openModal(id) {
    const ativo = todosAtivosData.find((a) => Number(a.id) === Number(id));
    if (!ativo) return;

    activeModalAtivoId = Number(ativo.id);

    getEl('modal-numero').textContent = ativo.numero;
    getEl('modal-item').textContent = ativo.item;
    getEl('modal-classificacao').textContent = ativo.classificacao;
    getEl('modal-local').textContent = ativo.local;
    getEl('modal-preco').textContent = formatMoney(ativo.preco);
    getEl('modal-data').textContent = formatDate(ativo.data);
    getEl('modal-nf').textContent = ativo.nf;
    getEl('modal-pagamento').textContent = ativo.pagamento;

    const iconPgto = getEl('modal-icon-pagamento');
    const pagamentoLower = ativo.pagamento.toLowerCase();

    if (pagamentoLower.includes('pix')) {
        iconPgto.className = 'fa-brands fa-pix text-emerald-500 text-2xl opacity-20';
    } else if (pagamentoLower.includes('boleto')) {
        iconPgto.className = 'fa-solid fa-barcode text-slate-500 text-2xl opacity-20';
    } else if (pagamentoLower.includes('cart')) {
        iconPgto.className = 'fa-solid fa-credit-card text-blue-500 text-2xl opacity-20';
    } else {
        iconPgto.className = 'fa-solid fa-money-bill-wave text-green-500 text-2xl opacity-20';
    }

    const imgEl = getEl('modal-imagem');
    imgEl.onerror = () => handleImageError(imgEl);
    imgEl.src = ativo.img_url || IMAGE_PLACEHOLDER;
    imgEl.alt = ativo.item || 'Foto do Item';

    const btnNf = getEl('modal-btn-nf');

    if (ativo.pdf_url) {
        btnNf.classList.remove('opacity-50', 'cursor-not-allowed');
        btnNf.innerHTML = '<i class="fa-solid fa-file-pdf text-accent mr-2"></i> Visualizar Nota Fiscal';
        btnNf.onclick = () => abrirNotaFiscal(ativo);
    } else {
        btnNf.classList.add('opacity-50', 'cursor-not-allowed');
        btnNf.innerHTML = '<i class="fa-solid fa-file-pdf mr-2"></i> NF Não Anexada';
        btnNf.onclick = null;
    }

    const btnEditar = getEl('modal-btn-editar');
    const btnBaixa = getEl('modal-btn-baixa');

    btnEditar.onclick = () => startEditAtivo(ativo.id);
    btnBaixa.onclick = () => openBaixaModal(ativo.id);

    if (ativo.ativo && !READ_ONLY_MODE) {
        btnEditar.classList.remove('hidden');
        btnBaixa.classList.remove('hidden');
    } else {
        btnEditar.classList.add('hidden');
        btnBaixa.classList.add('hidden');
    }

    getEl('itemModal').classList.remove('hidden');
}

function closeModal() {
    activeModalAtivoId = null;
    getEl('itemModal')?.classList.add('hidden');
}

// ================= HISTÃƒâ€œRICO =================

function renderHistorico() {
    const container = getEl('historicoContainer');
    if (!container) return;

    if (isLoadingHistorico) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-500">
                <i class="fa-solid fa-spinner fa-spin text-4xl mb-3 text-slate-300 block"></i>
                Carregando histórico...
            </div>
        `;
        return;
    }

    const termo = String(getEl('historicoSearchInput')?.value || '').toLowerCase().trim();

    const registros = historicoData.filter((registro) => {
        const base = [
            registro.numero,
            registro.item,
            registro.acao,
            registro.descricao,
            registro.usuario_email
        ].join(' ').toLowerCase();

        return base.includes(termo);
    });

    if (!registros.length) {
        container.innerHTML = `
            <div class="text-center py-10 text-slate-500 bg-white rounded-xl border border-slate-200">
                <i class="fa-solid fa-clock-rotate-left text-4xl mb-3 text-slate-300 block"></i>
                Nenhum registro de histórico encontrado.
            </div>
        `;
        return;
    }

    container.innerHTML = registros.map((registro) => {
        const acao = String(registro.acao || '').toLowerCase();
        let iconClass = 'fa-solid fa-circle-info text-blue-500';
        let badgeClass = 'bg-blue-50 text-blue-700 border-blue-100';

        if (acao.includes('cadastro')) {
            iconClass = 'fa-solid fa-plus text-emerald-500';
            badgeClass = 'bg-emerald-50 text-emerald-700 border-emerald-100';
        } else if (acao.includes('edicao')) {
            iconClass = 'fa-solid fa-pen text-amber-500';
            badgeClass = 'bg-amber-50 text-amber-700 border-amber-100';
        } else if (acao.includes('baixa')) {
            iconClass = 'fa-solid fa-box-archive text-rose-500';
            badgeClass = 'bg-rose-50 text-rose-700 border-rose-100';
        }

        return `
            <div class="bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex gap-4">
                <div class="w-10 h-10 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center flex-shrink-0">
                    <i class="${iconClass}"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-1">
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-xs font-bold px-2 py-0.5 rounded-md border ${badgeClass}">${escapeHTML(registro.acao || 'ação')}</span>
                            <span class="text-xs font-mono bg-slate-100 text-slate-600 px-2 py-0.5 rounded">Nº ${escapeHTML(registro.numero || '-')}</span>
                        </div>
                        <span class="text-xs text-slate-400 font-medium">${escapeHTML(formatDateTime(registro.created_at))}</span>
                    </div>

                    <h4 class="font-bold text-slate-800 mt-2 truncate">${escapeHTML(registro.item || 'Ativo não informado')}</h4>
                    <p class="text-sm text-slate-600 mt-1">${escapeHTML(truncateText(registro.descricao || '-', 240))}</p>

                    <div class="mt-2 text-xs text-slate-400">
                        <i class="fa-solid fa-user mr-1"></i> ${escapeHTML(registro.usuario_email || 'Usuário não informado')}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function renderHistoricoError(message) {
    const container = getEl('historicoContainer');
    if (!container) return;

    container.innerHTML = `
        <div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-5">
            <div class="flex gap-3">
                <i class="fa-solid fa-triangle-exclamation text-xl mt-0.5"></i>
                <div>
                    <h3 class="font-bold">Histórico ainda não disponível</h3>
                    <p class="text-sm mt-1">A tela foi criada, mas a tabela <strong>${TABLE_HISTORICO}</strong> precisa existir no schema <strong>${SUPABASE_SCHEMA}</strong>.</p>
                    <p class="text-xs mt-2 opacity-80">Detalhe técnico: ${escapeHTML(message)}</p>
                </div>
            </div>
        </div>
    `;
}

// ================= RELATÃƒâ€œRIOS =================

function popularFiltrosRelatorios() {
    const classificacaoSelect = getEl('relatorioClassificacao');
    const localSelect = getEl('relatorioLocal');

    if (!classificacaoSelect || !localSelect) return;

    const classificacaoAtual = classificacaoSelect.value;
    const localAtual = localSelect.value;

    const classificacoes = [...new Set(todosAtivosData.map((ativo) => ativo.classificacao).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));

    const locais = [...new Set(todosAtivosData.map((ativo) => ativo.local).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const gruposVisuais = VISUAL_LOCATION_GROUPS
        .filter((group) => todosAtivosData.some((ativo) => getVisualLocationGroup(ativo.local)?.key === group.key))
        .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));

    classificacaoSelect.innerHTML = '<option value="">Todas</option>' + classificacoes
        .map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`)
        .join('');

    localSelect.innerHTML = '<option value="">Todos</option>' +
        (gruposVisuais.length ? `<optgroup label="Grupos visuais">${gruposVisuais
            .map((group) => `<option value="${VISUAL_GROUP_FILTER_PREFIX}${escapeHTML(group.key)}">${escapeHTML(group.label)}</option>`)
            .join('')}</optgroup>` : '') +
        `<optgroup label="Locais originais">${locais
            .map((item) => `<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`)
            .join('')}</optgroup>`;

    classificacaoSelect.value = classificacaoAtual;
    localSelect.value = localAtual;
}

function getRelatorioFiltrado() {
    const busca = normalizeLocationText(getEl('relatorioBusca')?.value || '');
    const classificacao = getEl('relatorioClassificacao')?.value || '';
    const local = getEl('relatorioLocal')?.value || '';
    const status = getEl('relatorioStatus')?.value || 'ativos';

    return todosAtivosData.filter((ativo) => {
        const categoriaStatus = getStatusCategoria(ativo);
        const statusOk =
            status === 'todos' ||
            (status === 'ativos' && categoriaStatus === 'ativo') ||
            (status === 'defeito' && categoriaStatus === 'defeito') ||
            (status === 'inativos' && categoriaStatus === 'inativo');

        const classificacaoOk = !classificacao || ativo.classificacao === classificacao;
        const groupKey = local.startsWith(VISUAL_GROUP_FILTER_PREFIX)
            ? local.slice(VISUAL_GROUP_FILTER_PREFIX.length)
            : '';
        const localOk = !local || (groupKey
            ? getVisualLocationGroup(ativo.local)?.key === groupKey
            : ativo.local === local);

        const texto = [
            ativo.numero,
            ativo.item,
            ativo.classificacao,
            ativo.local,
            ativo.nf,
            ativo.pagamento
        ].map(normalizeLocationText).join(' ');

        return statusOk && classificacaoOk && localOk && texto.includes(busca);
    });
}

function renderRelatorios() {
    const tabela = getEl('relatorioTabela');
    if (!tabela) return;

    const dados = getRelatorioFiltrado();
    const valorTotal = dados.reduce((acc, ativo) => acc + Number(ativo.preco || 0), 0);
    const locais = [...new Set(dados.map((ativo) => getVisualLocationKey(ativo.local)))];

    getEl('relatorioTotalItens').textContent = dados.length;
    getEl('relatorioValorTotal').textContent = formatMoney(valorTotal);
    getEl('relatorioLocais').textContent = locais.length;

    if (!dados.length) {
        tabela.innerHTML = `
            <tr>
                <td colspan="6" class="px-4 py-8 text-center text-slate-500">
                    Nenhum ativo encontrado com os filtros atuais.
                </td>
            </tr>
        `;
        return;
    }

    tabela.innerHTML = dados.map((ativo) => {
        const statusExibicao = getStatusExibicao(ativo);
        const possuiDefeito = statusExibicao === 'Defeito';
        const safeNumero = escapeHTML(ativo.numero);
        const safeItem = escapeHTML(ativo.item);
        const safeClassificacao = escapeHTML(ativo.classificacao);
        const safeLocal = escapeHTML(ativo.local);
        const safeImageUrl = ativo.img_url ? escapeHTML(ativo.img_url) : '';
        const imageHTML = safeImageUrl
            ? `<img src="${safeImageUrl}" alt="${safeItem}" onerror="handleImageError(this)" loading="lazy" class="report-mobile-item-image">`
            : '<i class="fa-solid fa-image" aria-hidden="true"></i>';

        return `
        <tr class="report-table-row report-interactive-row" data-ativo-id="${escapeHTML(String(ativo.id))}" tabindex="0" aria-label="Abrir detalhes de ${safeItem}, plaqueta ${safeNumero}">
            <td class="px-4 py-3 font-mono text-slate-600">${escapeHTML(ativo.numero)}</td>
            <td class="px-4 py-3 font-semibold text-slate-800">${escapeHTML(ativo.item)}</td>
            <td class="px-4 py-3 text-slate-600">${escapeHTML(ativo.classificacao)}</td>
            <td class="px-4 py-3 text-slate-600">${escapeHTML(ativo.local)}</td>
            <td class="px-4 py-3 font-semibold text-emerald-600">${formatMoney(ativo.preco)}</td>
            <td class="px-4 py-3">
                <span class="text-xs font-bold px-2 py-1 rounded-md ${possuiDefeito ? 'bg-amber-50 text-amber-700' : (ativo.ativo ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700')}">
                    ${statusExibicao}
                </span>
            </td>
        </tr>
        <tr class="report-mobile-row report-interactive-row">
            <td colspan="6" class="p-0">
                <article class="report-mobile-card" data-ativo-id="${escapeHTML(String(ativo.id))}" tabindex="0" role="button" aria-label="Abrir detalhes de ${safeItem}, plaqueta ${safeNumero}">
                    <div class="report-mobile-photo" aria-label="Foto de ${safeItem}">
                        ${imageHTML}
                    </div>
                    <div class="report-mobile-content">
                        <div class="report-mobile-heading">
                            <span class="report-mobile-number">Nº ${safeNumero}</span>
                            <span class="report-mobile-status ${possuiDefeito ? 'is-defective' : (ativo.ativo ? 'is-active' : 'is-inactive')}">${statusExibicao}</span>
                        </div>
                        <h3 class="report-mobile-item">${safeItem}</h3>
                        <p class="report-mobile-classification">${safeClassificacao}</p>
                        <div class="report-mobile-details">
                            <span><i class="fa-solid fa-location-dot" aria-hidden="true"></i>${safeLocal}</span>
                            <strong>${formatMoney(ativo.preco)}</strong>
                        </div>
                    </div>
                </article>
            </td>
        </tr>
    `;
    }).join('');
}

function exportarCSV() {
    const dados = getRelatorioFiltrado();

    if (!dados.length) {
        showToast('Não há dados para exportar.', 'warning');
        return;
    }

    const headers = [
        'Plaqueta',
        'Item',
        'Classificacao',
        'Local',
        'Data da Compra',
        'NF',
        'Pagamento',
        'Valor',
        'Status'
    ];

    const rows = dados.map((ativo) => [
        ativo.numero,
        ativo.item,
        ativo.classificacao,
        ativo.local,
        formatDate(ativo.data),
        ativo.nf,
        ativo.pagamento,
        Number(ativo.preco || 0).toFixed(2).replace('.', ','),
        getStatusExibicao(ativo)
    ]);

    const csv = [headers, ...rows]
        .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(';'))
        .join('\n');

    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `relatorio-patrimonios-${today}.csv`;
    link.click();

    URL.revokeObjectURL(url);
    showToast('Relatório CSV exportado.');
}

function imprimirRelatorio() {
    const dados = getRelatorioFiltrado();

    if (!dados.length) {
        showToast('Não há dados para imprimir.', 'warning');
        return;
    }

    const valorTotal = dados.reduce((acc, ativo) => acc + Number(ativo.preco || 0), 0);
    const hoje = new Date().toLocaleString('pt-BR');

    const rows = dados.map((ativo) => `
        <tr>
            <td>${escapeHTML(ativo.numero)}</td>
            <td>${escapeHTML(ativo.item)}</td>
            <td>${escapeHTML(ativo.classificacao)}</td>
            <td>${escapeHTML(ativo.local)}</td>
            <td>${escapeHTML(formatDate(ativo.data))}</td>
            <td>${escapeHTML(ativo.nf)}</td>
            <td>${escapeHTML(formatMoney(ativo.preco))}</td>
            <td>${escapeHTML(getStatusExibicao(ativo))}</td>
        </tr>
    `).join('');

    const reportWindow = window.open('', '_blank', 'noopener,noreferrer');

    if (!reportWindow) {
        showToast('O navegador bloqueou a janela de impressão.', 'warning');
        return;
    }

    reportWindow.document.write(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <title>Relatório Patrimonial MHS</title>
            <style>
                body { font-family: Arial, sans-serif; color: #0f172a; padding: 24px; }
                h1 { margin: 0 0 4px; font-size: 22px; }
                p { margin: 0; color: #475569; font-size: 12px; }
                .summary { margin: 18px 0; padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
                table { width: 100%; border-collapse: collapse; font-size: 11px; }
                th, td { border: 1px solid #cbd5e1; padding: 7px; text-align: left; }
                th { background: #f1f5f9; color: #334155; text-transform: uppercase; font-size: 10px; }
            </style>
        </head>
        <body>
            <h1>Relatório Patrimonial MHS</h1>
            <p>Gerado em ${escapeHTML(hoje)} por ${escapeHTML(currentUser?.email || '-')}</p>

            <div class="summary">
                <strong>Total de itens:</strong> ${dados.length}<br>
                <strong>Valor total:</strong> ${escapeHTML(formatMoney(valorTotal))}
            </div>

            <table>
                <thead>
                    <tr>
                        <th>Plaqueta</th>
                        <th>Item</th>
                        <th>Classificação</th>
                        <th>Local</th>
                        <th>Data</th>
                        <th>NF</th>
                        <th>Valor</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>

            <script>
                window.onload = () => {
                    window.print();
                };
            </script>
        </body>
        </html>
    `);

    reportWindow.document.close();
}

// ================= EVENTOS / BOOT =================

function bindUIEvents() {
    getEl('formLogin')?.addEventListener('submit', loginUsuario);
    getEl('btnSignup')?.addEventListener('click', criarUsuario);
    getEl('adminConfigBtn')?.addEventListener('click', abrirAdminConfig);
    getEl('adminConfigForm')?.addEventListener('submit', salvarAdminConfig);
    document.querySelectorAll('[data-close-admin-config]').forEach((element) => {
        element.addEventListener('click', fecharAdminConfig);
    });
    getEl('logoutBtn')?.addEventListener('click', logoutUsuario);
    getEl('mobileLogoutBtn')?.addEventListener('click', logoutUsuario);

    getEl('togglePasswordBtn')?.addEventListener('click', () => {
        const input = getEl('login_password');
        const icon = getEl('togglePasswordBtn').querySelector('i');

        if (input.type === 'password') {
            input.type = 'text';
            icon.className = 'fa-solid fa-eye-slash';
        } else {
            input.type = 'password';
            icon.className = 'fa-solid fa-eye';
        }
    });

    const mobileMenuBtn = getEl('mobileMenuBtn');
    const mobileNav = getEl('mobileNav');

    mobileMenuBtn?.addEventListener('click', () => {
        mobileNav.classList.toggle('hidden');
    });

    getEl('searchInput')?.addEventListener('input', (e) => {
        renderAtivosList(e.target.value);
    });

    getEl('historicoSearchInput')?.addEventListener('input', renderHistorico);
    getEl('btnRecarregarHistorico')?.addEventListener('click', () => carregarHistorico());

    getEl('formCadastro')?.addEventListener('submit', cadastrarOuEditarAtivo);
    getEl('btnCancelarEdicao')?.addEventListener('click', resetCadastroForm);
    getEl('btnLimparForm')?.addEventListener('click', resetCadastroForm);

    getEl('formBaixa')?.addEventListener('submit', confirmarBaixa);

    getEl('cad_imagem')?.addEventListener('change', (event) => {
        const file = event.target.files[0];
        getEl('cad_imagem_label').textContent = file ? file.name : 'PNG, JPG até 5MB';
    });

    getEl('cad_pdf')?.addEventListener('change', (event) => {
        const file = event.target.files[0];
        getEl('cad_pdf_label').textContent = file ? file.name : 'Apenas PDF até 5MB';
    });

    ['relatorioBusca', 'relatorioClassificacao', 'relatorioLocal', 'relatorioStatus'].forEach((id) => {
        getEl(id)?.addEventListener('input', renderRelatorios);
        getEl(id)?.addEventListener('change', renderRelatorios);
    });

    // As linhas de relatórios reutilizam o mesmo modal de detalhes da aba Itens.
    // A delegação preserva a interação após cada atualização dos filtros.
    const relatorioTabela = getEl('relatorioTabela');
    const abrirDetalhesDoRelatorio = (target) => {
        const item = target.closest('[data-ativo-id]');
        if (!item || !relatorioTabela?.contains(item)) return;

        openModal(item.dataset.ativoId);
    };

    relatorioTabela?.addEventListener('click', (event) => abrirDetalhesDoRelatorio(event.target));
    relatorioTabela?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;

        const item = event.target.closest('[data-ativo-id]');
        if (!item || !relatorioTabela.contains(item)) return;

        event.preventDefault();
        openModal(item.dataset.ativoId);
    });

    getEl('btnExportarCSV')?.addEventListener('click', exportarCSV);
    getEl('btnImprimirRelatorio')?.addEventListener('click', imprimirRelatorio);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closeBaixaModal();
            closeModal();
            fecharAdminConfig();
        }
    });
}

async function initApp() {
    try {
        initSupabaseClient();
        bindUIEvents();

        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;

        await handleAuthState(data.session);

        supabaseClient.auth.onAuthStateChange((event, session) => {
            if (event === 'SIGNED_OUT') {
                void handleAuthState(null);
            }

            if (event === 'SIGNED_IN' && currentUser?.id !== session?.user?.id) {
                void handleAuthState(session);
            }
        });
    } catch (error) {
        console.error('Erro ao inicializar aplicação:', error);
        await handleAuthState(null);
        setLoginError('Não foi possível iniciar o acesso. Tente novamente.');
    }
}

document.addEventListener('DOMContentLoaded', initApp);

// FunÃƒÂ§ÃƒÂµes expostas para handlers inline do HTML gerado dinamicamente.
window.navigate = navigate;
window.navigateToMaiorValor = navigateToMaiorValor;
window.toggleAccordion = toggleAccordion;
window.openModal = openModal;
window.closeModal = closeModal;
window.openBaixaModal = openBaixaModal;
window.closeBaixaModal = closeBaixaModal;
