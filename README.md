# SplitReceipt

Divide recibos entre amigos sem fazer contas. Tiras uma foto (ou carregas uma imagem ou um PDF), a IA lê o recibo, traduz cada artigo para português e converte para euros. Depois escolhes quem leva o quê e a app diz quanto deve cada pessoa.

## Funcionalidades

- **Leitura por IA (Gemini)** de fotos e PDFs, com **vários recibos de uma vez** ou **um recibo longo em várias fotos**.
- **Qualquer moeda** (CZK, PLN, HUF, EUR, RON, GBP, CHF…), convertida para **euros com a taxa do BCE do dia do recibo**. Também podes indicar o **valor exato debitado em €** (por exemplo, o que o Revolut cobrou).
- **Tradução para português** de cada artigo, mantendo o nome original.
- **Descontos**:
  - descontos de artigo (por exemplo, Lidl "SLEVA 60%") ficam no próprio artigo, ou podem ser espalhados por todos;
  - descontos gerais **em percentagem** (por exemplo, Billa Klub −10 %) tiram essa percentagem a cada artigo;
  - cupões de **valor fixo** (por exemplo, Tesco −50 Kč) são repartidos em proporção ao preço;
  - em ambos os casos podes aplicar o desconto a todos os artigos ou só aos que escolheres.
- **Verificação do total**: compara a soma dos artigos com o total impresso e permite corrigir a diferença com um clique.
- **Atribuição rápida**: botões por pessoa, "Todos", **pincel** para atribuir muitos artigos seguidos, e **partes diferentes** por pessoa.
- **Por unidade**: em artigos com várias unidades (por exemplo, 3 croissants), escolhes quantas leva cada pessoa (1 para mim e 2 para a Inês), incluindo meias unidades.
- **Memória**: da próxima vez que comprares o mesmo artigo, a app sugere as mesmas pessoas.
- **Despesas sem recibo** (Uber, renda, jantar…): campo aberto com descrição, valor, moeda, quem pagou e por quem se divide.
- **Grupos** (por exemplo, "Casa" ou "Eu e a Filipa"): atalhos em cada artigo, no pincel e nas despesas, e servem também para criar uma divisão só com esse grupo.
- **Quem pagou** é definido por recibo, e os **acertos** compensam recibos pagos por pessoas diferentes com o mínimo de transferências. Os acertos ficam **bloqueados até todos os artigos estarem atribuídos**.
- **Revolut**: botão "Pedir" por pessoa, que copia o valor e partilha uma mensagem com o teu link revolut.me. Há também um ecrã com os valores por pessoa prontos a copiar para uma despesa de grupo (o Revolut não aceita importar ficheiros).
- **Partilha**: resumo para o WhatsApp, mensagem por pessoa (com a lista do que levou), **link só de leitura** (os dados vão dentro do link), CSV e backup em JSON.
- **Histórico** de divisões, opção de anular, tema claro e escuro em vidro.
- **App instalável (PWA)**: ícone no ecrã principal, ecrã inteiro, funciona offline para consultar e avisa quando há uma versão nova. Tem atalhos no ícone (Novo recibo, Despesa, Histórico). No Android podes **partilhar fotos de recibos da galeria diretamente para a app**.

### Instalar no telemóvel

- **Android (Chrome)**: botão 📱 no topo, ou menu ⋮ → "Instalar app".
- **iPhone (Safari)**: Partilhar → "Adicionar ao ecrã principal".

## Publicar no GitHub Pages

O site é publicado por um GitHub Action (`.github/workflows/pages.yml`) a cada push para o `main`. O Action corre os testes, injeta a chave Gemini guardada nos **Secrets** e publica.

1. **Chave Gemini**: cria uma chave gratuita em [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
2. **Guardar a chave no GitHub**: repositório → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Nome `GEMINI_API_KEY`, valor a chave. A chave nunca fica no código do repositório.
3. **Ativar o Pages**: **Settings** → **Pages** → **Build and deployment → Source**: **GitHub Actions**.
4. **Publicar**: separador **Actions** → **Publicar no GitHub Pages** → **Run workflow** (ou faz um push para o `main`). O site fica em `https://<utilizador>.github.io/SplitReceipt/`.
5. **Proteger a chave** (importante): num site sem servidor, a chave vai para o browser de quem abre o site. No [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), abre a chave e em **Application restrictions** escolhe **Websites** com `https://<utilizador>.github.io/*`. Assim, só funciona a partir do teu site.

Opcional: em **Secrets and variables → Actions → Variables**, `GEMINI_MODEL` escolhe outro modelo. Cada pessoa pode também pôr uma chave própria nas **Definições** da app, que tem prioridade sobre a do site.

### Netlify (opcional)

Também funciona no Netlify, com a chave guardada no servidor: define `GEMINI_API_KEY` (e, se quiseres, `GEMINI_MODEL`) nas variáveis de ambiente. A função está em `netlify/functions/parse-receipt.mjs`.

## Desenvolvimento

```bash
npm test            # testes da lógica de cálculo
npx netlify-cli dev # app + função de IA em http://localhost:8888
```

Estrutura:

- `index.html`, `css/styles.css`: interface
- `js/app.js`: UI e estado
- `js/calc.js`: cálculos puros (descontos, conversão, arredondamentos, acertos), com testes
- `js/ai.js`: prompt e schema da IA, partilhados entre o browser e o servidor
- `js/rates.js`: taxas de câmbio (Frankfurter/BCE, com fontes alternativas)
- `netlify/functions/parse-receipt.mjs`: endpoint `/api/parse-receipt`, que guarda a chave no servidor

Os dados (pessoas, divisões e memória) ficam no `localStorage` do browser, e as imagens dos recibos no IndexedDB.
