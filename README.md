# Repositório pronto para GitHub Pages

Este modelo publica **somente o conteúdo da pasta `site/`** no GitHub Pages.

## Como usar

1. Coloque os arquivos finais do seu site dentro de `site/`.
2. Garanta que exista `site/index.html`.
3. Crie um repositório vazio no GitHub.
4. No terminal, dentro desta pasta:

```bash
git init
git add .
git commit -m "Primeira publicação"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/SEU-REPOSITORIO.git
git push -u origin main
```

5. No GitHub, abra:
**Settings → Pages → Build and deployment → Source → GitHub Actions**

O workflow em `.github/workflows/deploy-pages.yml` publicará a pasta `site/`.

## Se seu projeto é React/Vite/Vue

Gere o build:

```bash
npm install
npm run build
```

Depois copie **o conteúdo de `dist/`** para `site/`.

## Se usa Create React App

Depois de:

```bash
npm run build
```

copie **o conteúdo de `build/`** para `site/`.

## Segurança

Não publique:
- `.env`
- senhas
- tokens privados
- chave `service_role` do Supabase
- credenciais administrativas

O `.gitignore` deste modelo já ignora arquivos `.env`.

## Estrutura

```text
.
├── .github/
│   └── workflows/
│       └── deploy-pages.yml
├── site/
│   ├── .nojekyll
│   └── index.html
├── .gitignore
└── README.md
```

Este modelo não altera seu projeto atual. Ele serve como uma pasta de publicação.
