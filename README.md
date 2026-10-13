# SplitReceipt

Divide recibos entre amigos sem fazer contas. Tiras uma foto (ou carregas uma imagem ou um PDF), a IA lê o recibo, traduz cada artigo para português e converte para euros. Depois escolhes quem leva o quê e a app diz quanto deve cada pessoa.

## Funcionalidades

- **Leitura por IA (Gemini)** de fotos e PDFs, com **vários recibos de uma vez** ou **um recibo longo em várias fotos**.
- **Qualquer moeda** (CZK, PLN, HUF, EUR, RON, GBP, CHF…), convertida para **euros com a taxa do BCE do dia do recibo**. Também podes indicar o **valor exato debitado em €** (por exemplo, o que o Revolut cobrou).
- **Tradução para português** de cada artigo, mantendo o nome original.
- **Descontos**:
  - descontos de artigo (por exemplo, Lidl "SLEVA 60%") ficam no próprio artigo, ou podem ser espalhados por todos;
  - cupões gerais (por exemplo, Tesco Clubcard) são repartidos proporcionalmente, por todos os artigos ou só pelos que escolheres.
- **Verificação do total**: compara a soma dos artigos com o total impresso e permite corrigir a diferença com um clique.
- **Atribuição rápida**: botões por pessoa, "Todos", **pincel** para atribuir muitos artigos seguidos, e **partes diferentes** por pessoa (por exemplo, 2 croissants para um e 1 para outro), ou separar um artigo em unidades.
- **Memória**: da próxima vez que comprares o mesmo artigo, a app sugere as mesmas pessoas.
- **Despesas sem recibo** (Uber, renda, jantar…): campo aberto com descrição, valor, moeda, quem pagou e por quem se divide.
- **Grupos** (por exemplo, "Casa" ou "Eu e a Filipa"): atalhos em cada artigo, no pincel e nas despesas, e servem também para criar uma divisão só com esse grupo.
- **Quem pagou** é definido por recibo, e os **acertos** compensam recibos pagos por pessoas diferentes com o mínimo de transferências. Os acertos ficam **bloqueados até todos os artigos estarem atribuídos**.
- **Revolut**: botão "Pedir" por pessoa, que copia o valor e partilha uma mensagem com o teu link revolut.me. Há também um ecrã com os valores por pessoa prontos a copiar para uma despesa de grupo (o Revolut não aceita importar ficheiros).
- **Partilha**: resumo para o WhatsApp, mensagem por pessoa (com a lista do que levou), **link só de leitura** (os dados vão dentro do link), CSV e backup em JSON.
- **Histórico** de divisões, opção de anular, tema claro e escuro em vidro, instalável como app (PWA) e funciona offline para consultar.

## Deploy no Netlify

1. Liga este repositório ao Netlify ("Import from Git"). Não há passo de build: o `netlify.toml` já define tudo.
2. Em **Site configuration → Environment variables**, cria `GEMINI_API_KEY` com a tua chave da Google AI Studio.
3. (Opcional) Define `GEMINI_MODEL` para escolher o modelo. Por defeito é usado `gemini-3.1-flash-lite`, com outros modelos de reserva.
4. Faz um novo deploy.

Sem servidor (por exemplo, no GitHub Pages ou a abrir localmente), podes colocar uma chave Gemini pessoal em **Definições**. Essa chave fica guardada apenas no teu dispositivo.

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
