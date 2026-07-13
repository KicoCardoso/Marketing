# Dashboard de marketing (GitHub Pages)

Versão pública e somente-leitura do kanban de marketing, hospedada no GitHub Pages. Um GitHub Action busca os dados da lista "Demandas de Marketing" no ClickUp a cada 5 minutos e atualiza a página automaticamente. Não tem os botões de concluir/aprovar/reatribuir — para isso, use o dashboard interativo dentro do Cowork.

## Estrutura

```
.github/workflows/update-dashboard.yml   → roda a cada 5 min, busca dados do ClickUp
scripts/fetch_clickup.mjs                → script Node que chama a API do ClickUp
docs/index.html                          → página do dashboard
docs/data.json                           → dados (gerados automaticamente pelo Action)
```

## Passo a passo

1. **Criar o repositório**
   Crie um repositório novo no GitHub (pode ser público — o GitHub Pages gratuito para conta pessoal funciona melhor em repositórios públicos) e suba estes arquivos mantendo a estrutura de pastas.

2. **Gerar o token do ClickUp**
   No ClickUp: clique no seu avatar (canto inferior esquerdo) → **Settings** → **Apps** → **API Token** → **Generate**. Copie o token (começa com `pk_`).

3. **Adicionar o token como secret do repositório**
   No repositório do GitHub: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.
   - Name: `CLICKUP_API_TOKEN`
   - Value: cole o token gerado no passo 2

4. **Ativar o GitHub Pages**
   **Settings** → **Pages** → em "Build and deployment", Source: **Deploy from a branch** → Branch: `main`, pasta `/docs` → **Save**.

5. **Rodar o Action pela primeira vez**
   Vá em **Actions** → selecione "Atualizar dashboard de marketing" → **Run workflow**. Isso gera o primeiro `docs/data.json` sem precisar esperar os 5 minutos do agendamento.

6. **Acessar o dashboard**
   A URL aparece em **Settings** → **Pages**, algo como:
   `https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/`

## Observações

- O agendamento do GitHub Actions (`cron`) não é exato — em horários de pico o GitHub pode atrasar a execução em alguns minutos.
- Se o repositório ficar 60 dias sem nenhuma atividade, o GitHub desativa automaticamente os workflows agendados (basta rodar manualmente uma vez para reativar).
- O token do ClickUp fica guardado como secret criptografado do GitHub — nunca aparece nos logs nem no código.
- Esta página é somente leitura. Ações (concluir etapa, aprovar, marcar impedimento) continuam sendo feitas no dashboard ao vivo do Cowork ou direto no ClickUp.
